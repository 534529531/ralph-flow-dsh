/**
 * Graph 执行引擎：DAG 调度器 + 节点 attempt + CHECK（经 Flow 的独立验证者）+ 人工审查门 +
 * Git worktree / integration。门面按 `kind` 路由到这里；Flow 引擎一个字节都不经过本文件。
 *
 * 宪法对齐：
 *   - 唯一写入者：本模块是 Graph 实例 `state.json` 的唯一写入者；门面只路由。
 *   - 不存派生量：state 只有 attempts/submissions/verdicts/acceptances/todos/integration/
 *     worktrees；节点状态、当前节点、等待原因由 `graph/state.ts` 现算。
 *   - T1：CHECK 只走 `ports.verify`（`src/verify.ts`）；节点 agent 看不到验证者会话，验证者
 *     看不到执行者自述。
 *   - T2：节点释放、返工、快进顺序由本调度器决定；节点在自己的分支上合并集成分支，
 *     引擎按节点分支验收，只前进集成分支引用。
 */
import fs from "node:fs";
import { normalizeUnfinished } from "../unfinished.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { pauseLabel } from "../pause.js";
import { OWNER_HEARTBEAT_REFRESH_MS, ownerAlive, ownerRecheckMs, runtimeId, stampOwner } from "../owner.js";
import {
  RALPH_FLOW_DIR,
  SUBMIT_REMINDER_TOTAL_LIMIT,
  SUBMIT_REMINDER_STALL_LIMIT,
  makeArtifactsDirName,
  type EnginePorts,
  type HistoryEntry,
  type StepDef,
  type ToolResult,
  type Verdict,
  type VerifyRequest,
  type WorkflowDef,
} from "../engine.js";
import {
  graphAssetHash,
  type GraphAsset,
  type GraphNode,
} from "./asset.js";
import { checkDefinition, checkVersion, type CheckDefinition } from "./check.js";
import { assetReferenceSection, assetRootOf } from "../asset-path.js";
import {
  graphGlobalDir,
  graphWorkspaceDir,
  listGraphWorkflows,
  loadGraphWorkflow,
  type GraphWorkflowEntry,
} from "./assets.js";
import {
  GRAPH_ACTIVE_STATUSES,
  acceptanceOfNode,
  attemptsOfNode,
  graphArtifactsDirOf,
  graphArtifactsRootOf,
  graphInstanceDirOf,
  graphInstancesDirOf,
  graphNodeArtifactDirOf,
  graphReportsDirOf,
  graphRootOf,
  graphStatePathOf,
  isGraphTerminal,
  latestAttemptOfNode,
  listGraphStates,
  nodeNameOf,
  nodeReleased,
  nodeStatusOf,
  projectionOf,
  pushGraphHistory,
  readGraphState,
  verdictOfAttempt,
  waitingTodoOfNode,
  writeGraphState,
  type GraphAttempt,
  type GraphHumanTodo,
  type GraphInstanceState,
  type GraphIntegrationAcceptance,
  type GraphRunProjection,
  type GraphRunStatus,
  type GraphVerdict,
} from "./state.js";
import { buildGraphReport } from "./report.js";
import { registerGraphAgent, unregisterGraphAgent } from "./agent-registry.js";
import {
  advanceIntegration,
  branchTip,
  captureWorkspaceChanges,
  ensureIntegrationBranch,
  ensureNodeWorktree,
  git,
  gitSafe,
  integrationBranchFor,
  nodeBranchFor,
  nodeReadyForIntegration,
  nodeWorktreePathOf,
  removeCleanWorktree,
  resolveProject,
  workspaceRelative,
  worktreeRootOf,
} from "./workspace.js";

const MAX_CHECK_REWORKS = 2;
/** 「合入集成分支」失败的重试上限：并行节点临近交卷时的竞态，重做一次很便宜。 */
const MAX_INTEGRATION_RETRIES = 5;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_LOG_ROTATIONS = 3;

export interface GraphEngineOptions {
  ctx: Context;
  ports: EnginePorts;
  workspace: string;
}

interface SubmitWaiter {
  resolve: (value: { summary?: string }) => void;
  reject: (error: Error) => void;
}

interface ReviewWaiter {
  resolve: (value: { decision: "approve" | "revise"; feedback: string }) => void;
  reject: (error: Error) => void;
}

interface RunContext {
  instId: string;
  state: GraphInstanceState;
  artifactRoot: string;
  projectRoot?: string;
  submitWaiters: Map<string, SubmitWaiter>;
  reviewWaiters: Map<string, ReviewWaiter>;
  active: Map<string, Promise<void>>;
  agents: Map<string, unknown>;
  abort: AbortController;
  wake: (() => void) | null;
  scheduler?: Promise<void>;
  respondTools: Map<string, () => void>;
  mainBusy: boolean;
  schedulerActive: boolean;
  /** 调度器在收尾期间又被要求启动（暂停 → 立刻 continue 的竞态）：退出时自动重启一次。 */
  schedulerRestart?: boolean;
  /** 接纳的串行队列：集成分支的引用前进按 run 串行。 */
  acceptTail: Promise<void>;
}

const logLabel = (level: "info" | "warn" | "error"): string => level;

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

function sha256File(file: string): { sha256: string; size: number } {
  const content = fs.readFileSync(file);
  return { sha256: createHash("sha256").update(content).digest("hex"), size: content.byteLength };
}

function uniqueId(asset: GraphAsset): string {
  const slug = asset.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "graph";
  return `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function relOrAbsolute(workspace: string, absolute: string): string {
  return workspaceRelative(workspace, absolute) ?? absolute;
}

function syntheticStep(node: GraphNode, criteria: string): StepDef {
  return { id: node.id, do: node.do, check: criteria, desc: node.name ?? node.id };
}

function syntheticWorkflow(asset: GraphAsset): WorkflowDef {
  return { name: asset.id, description: asset.description, steps: [], warnings: [] };
}

/** 简易审批语义：人话里的“批准/放行”与“改稿要求”。与参考实现同一套词表。 */
const APPROVAL_TEXT = /(?:^|[^a-z])(?:approve|approved|approval)(?:$|[^a-z])|批准|放行|同意(?:放行|交付|通过)|通过(?:这个|这|该|此)?(?:版本|产物|交付)/i;
const NEGATED_APPROVAL_TEXT = /(?:not|never|don['’]?t|do not|no)\s+(?:approve|approved|approval)|(?:不|未|没有|暂不)\s*(?:批准|放行|通过)/i;
const REVISION_TEXT = /改|修改|调整|补充|增加|加上|加入|加一个|添加|重写|返工|更新|修正|删掉|删除|移除|revise|rework|modify|change|rewrite|update|edit|add|remove|adjust/i;

function classifyManualResponse(text: string): { kind: "approve" } | { kind: "revise" } | { kind: "clarify"; reason: string } {
  const approval = APPROVAL_TEXT.test(text) && !NEGATED_APPROVAL_TEXT.test(text);
  const revisionText = text.replace(/(?:no|without)\s+(?:further\s+)?changes?(?:\s+(?:needed|required))?|无需(?:修改|改动)|没有(?:修改|改动)|不用改/gi, " ");
  const revision = REVISION_TEXT.test(revisionText);
  if (approval && revision) return { kind: "clarify", reason: "conflicting_intent" };
  if (approval) return { kind: "approve" };
  if (revision) return { kind: "revise" };
  return { kind: "clarify", reason: "not_explicit" };
}

export function createGraphEngine(options: GraphEngineOptions) {
  const { ctx, ports, workspace } = options;
  const root = graphRootOf(workspace);
  const graphsDir = graphWorkspaceDir(workspace);
  const instancesDir = graphInstancesDirOf(workspace);
  const reportsDir = graphReportsDirOf(workspace);
  const artifactsRoot = graphArtifactsRootOf(workspace);
  const runs = new Map<string, RunContext>();
  const agentBindings = new Map<string, { instId: string; nodeId: string; attemptId: string; workerId: string }>();
  const log = (level: "info" | "warn" | "error", event: string, data?: unknown): void => {
    try { ports.log?.(level, event, data); } catch {}
  };

  function ensureLayout(): void {
    for (const dir of [root, graphsDir, instancesDir, reportsDir, artifactsRoot]) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  function instanceDir(instId: string): string {
    return graphInstanceDirOf(workspace, instId);
  }

  function logFileOf(instId: string): string {
    return path.join(instanceDir(instId), "execution.log");
  }

  function archivedLogOf(instId: string): string {
    return path.join(reportsDir, `${instId}-execution.log`);
  }

  function rotateLog(file: string): void {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < MAX_LOG_SIZE_BYTES) return;
    try { fs.rmSync(`${file}.${MAX_LOG_ROTATIONS}`, { force: true }); } catch {}
    for (let index = MAX_LOG_ROTATIONS - 1; index >= 1; index--) {
      try { fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`); } catch {}
    }
    try { fs.renameSync(file, `${file}.1`); } catch {}
  }

  function logEvent(instId: string, level: "info" | "warn" | "error", event: string, extra?: Record<string, unknown>): void {
    try {
      if (!fs.existsSync(instanceDir(instId))) return;
      const file = logFileOf(instId);
      rotateLog(file);
      const payload = extra ? { ...extra } : {};
      delete (payload as { instId?: unknown }).instId;
      fs.appendFileSync(file, `${JSON.stringify({ ts: now(), level, event, instId, ...payload })}\n`, "utf-8");
    } catch (error) {
      log("warn", "execution_log_write_failed", { instId, event, error: msg(error) });
    }
  }

  function archiveExecutionLog(instId: string): string | null {
    const source = logFileOf(instId);
    try {
      if (!fs.existsSync(source)) return null;
      fs.mkdirSync(reportsDir, { recursive: true });
      const target = archivedLogOf(instId);
      fs.copyFileSync(source, target);
      return target;
    } catch (error) {
      log("warn", "execution_log_archive_failed", { instId, error: msg(error) });
      return null;
    }
  }

  function writeReport(run: RunContext): string | null {
    const reportPath = path.join(reportsDir, `${run.instId}.md`);
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
      const artifactsRelDir = `${RALPH_FLOW_DIR}/artifacts/${run.state.artifacts_dir_name}/nodes`;
      const content = buildGraphReport(run.state, {
        instanceId: run.instId,
        workspace,
        statePath: graphStatePathOf(workspace, run.instId),
        reportPath,
        artifactsRelDir,
      });
      const tmp = path.join(reportsDir, `.${run.instId}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, reportPath);
      return reportPath;
    } catch (error) {
      log("warn", "report_write_failed", { instId: run.instId, error: msg(error) });
      return null;
    }
  }

  function persist(run: RunContext): void {
    try {
      writeGraphState(workspace, run.state, run.instId);
      ports.statusChanged?.();
    } catch (error) {
      log("error", "graph_state_write_failed", { instId: run.instId, error: msg(error) });
    }
  }

  /**
   * 属主心跳：只刷新本运行时拥有的 `running` run。暂停/等待/结束后不再刷 ——
   * 那几个状态本来就该由任何 host 接管，也不该因为属主没了被判成中断。
   */
  let ownerBeat: ReturnType<typeof setInterval> | undefined;
  function ensureOwnerBeat(): void {
    if (ownerBeat) return;
    ownerBeat = setInterval(() => {
      for (const run of runs.values()) {
        if (run.state.active !== true || run.state.graph.status !== "running") continue;
        if (run.state.owner_runtime !== runtimeId()) continue;
        run.state.owner_heartbeat_at = Date.now();
        persist(run);
      }
    }, OWNER_HEARTBEAT_REFRESH_MS);
    (ownerBeat as unknown as { unref?: () => void }).unref?.();
  }
  ensureOwnerBeat();

  function history(run: RunContext, event: string, detail?: string, nodeId?: string, level: "info" | "warn" | "error" = "info"): void {
    pushGraphHistory(run.state, event, detail, nodeId);
    logEvent(run.instId, level, event, { ...(detail ? { detail } : {}), ...(nodeId ? { node: nodeId } : {}) });
  }

  function setStatus(run: RunContext, status: GraphRunStatus, pauseReason?: string): void {
    run.state.graph.status = status;
    if (pauseReason) run.state.graph.pause_reason = pauseReason;
    else delete run.state.graph.pause_reason;
    run.state.active = !isGraphTerminal(status);
    persist(run);
  }

  function notify(run: RunContext, text: string, summary: string, directive = false): void {
    const session = run.state.owner_session;
    if (!session) return;
    if (directive) ports.deliverDirective(session, text, summary, { dedupe: false });
    else ports.deliverNotice(session, text, summary, { dedupe: false });
  }

  // ── 资产发现 ────────────────────────────────────────────────────────────────

  function listWorkflows(): GraphWorkflowEntry[] {
    return listGraphWorkflows(workspace);
  }

  function loadWorkflow(name: string) {
    return loadGraphWorkflow(workspace, name);
  }

  function readState(instId: string): GraphInstanceState | null {
    return readGraphState(workspace, instId);
  }

  function listStates(): Array<{ id: string; state: GraphInstanceState }> {
    return listGraphStates(workspace);
  }

  function activeInstanceOfSession(sessionId: string): { id: string; state: GraphInstanceState } | undefined {
    return listStates().filter((entry) => entry.state.active && entry.state.owner_session === sessionId).at(-1);
  }

  function activeMainAttemptOfSession(sessionId: string): { run: RunContext; attempt: GraphAttempt; node: GraphNode } | undefined {
    for (const run of runs.values()) {
      if (run.state.owner_session !== sessionId || run.state.graph.status !== "running") continue;
      for (const node of run.state.graph.asset.nodes) {
        if (node.execution !== "main") continue;
        const attempt = latestAttemptOfNode(run.state, node.id);
        if (attempt?.status === "running") return { run, attempt, node };
      }
    }
    return undefined;
  }

  type TodoRunRef = { instId: string; state: GraphInstanceState };
  function waitingTodosOfSession(sessionId: string): Array<{ run: RunContext | TodoRunRef; todo: GraphHumanTodo }> {
    const out: Array<{ run: RunContext | TodoRunRef; todo: GraphHumanTodo }> = [];
    for (const run of runs.values()) {
      if (run.state.owner_session !== sessionId) continue;
      for (const todo of run.state.graph.human_todos) if (todo.status === "waiting") out.push({ run, todo });
    }
    if (out.length === 0) {
      for (const entry of listStates()) {
        if (entry.state.owner_session !== sessionId) continue;
        for (const todo of entry.state.graph.human_todos) if (todo.status === "waiting") out.push({ run: { instId: entry.id, state: entry.state }, todo });
      }
    }
    return out;
  }

  // ── 启动 ────────────────────────────────────────────────────────────────────

  async function start(workflowName: string, task: string, sessionId: string): Promise<ToolResult> {
    if (!workflowName?.trim()) return { ok: false, text: "缺少工作流名。用法：`ralphflow_start(workflow, task, inputs)` 或 `/ralphflow-start <工作流> <任务>`。" };
    const mine = activeInstanceOfSession(sessionId);
    if (mine) return { ok: false, text: `当前会话已有活跃 Graph 实例 \`${mine.id}\`（${mine.state.workflow_name}）。用 \`/ralphflow-continue\` 继续，或 \`/ralphflow-cancel\` 取消。` };
    const loaded = loadWorkflow(workflowName.trim());
    if (!loaded.def) {
      return { ok: false, text: `Graph 工作流 \`${workflowName}\` 无法启动：\n${loaded.problems.map((problem) => `- ${problem}`).join("\n")}` };
    }
    const asset = loaded.def;
    const taskText = task.trim() || asset.name;
    const instId = uniqueId(asset);
    const artifactsDirName = makeArtifactsDirName(taskText, instId);
    const startedAt = now();
    // 测试夹具：Graph 的产品路径始终走 Git；只有测试脚本会把这个环境变量设为 1。
    const artifactFixture = process.env.RALPHFLOW_GRAPH_ARTIFACT === "1";
    let project: GraphInstanceState["graph"]["project"] = { mode: "artifact" };
    let integration: GraphInstanceState["graph"]["integration"];
    if (!artifactFixture) {
      try {
        const snapshot = await resolveProject(workspace);
        if (!snapshot.clean) {
          return { ok: false, text: "Graph 从 HEAD 建隔离 worktree，当前工作区有未提交改动。先让用户选择 commit 或 stash；工作区干净后重新调用 ralphflow_start；启动成功即完成。" };
        }
        project = { mode: "git", root: snapshot.root, baseline: snapshot.baseline };
        const integrationBranch = integrationBranchFor(instId);
        const current = await ensureIntegrationBranch(snapshot.root, integrationBranch, snapshot.baseline);
        integration = { branch: integrationBranch, baseline: snapshot.baseline, current_commit: current };
      } catch (error) {
        return { ok: false, text: `Graph 实例无法启动：${msg(error)}` };
      }
    }

    const state: GraphInstanceState = {
      kind: "graph",
      active: true,
      workflow_name: workflowName.trim(),
      user_task: taskText,
      owner_session: sessionId,
      artifacts_dir_name: artifactsDirName,
      started_at: startedAt,
      updated_at: startedAt,
      graph: {
        asset,
        asset_hash: graphAssetHash(asset),
        ...(loaded.path ? { asset_path: loaded.path } : {}),
        status: "running",
        project,
        ...(integration ? { integration } : {}),
        attempts: [],
        verdicts: [],
        acceptances: [],
        human_todos: [],
        worktrees: [],
        rework_counts: {},
        integration_retries: {},
        fault_retries: {},
      },
      history: [],
    };
    const run: RunContext = {
      instId,
      state,
      artifactRoot: path.join(artifactsRoot, artifactsDirName),
      ...(project.root ? { projectRoot: project.root } : {}),
      submitWaiters: new Map(),
      reviewWaiters: new Map(),
      active: new Map(),
      agents: new Map(),
      abort: new AbortController(),
      wake: null,
      respondTools: new Map(),
      mainBusy: false,
      schedulerActive: false,
      schedulerRestart: false,
      acceptTail: Promise.resolve(),
    };
    runs.set(instId, run);
    ensureLayout();
    fs.mkdirSync(run.artifactRoot, { recursive: true });
    // running 期间由本运行时持有属主心跳（暂停/结束自动停止刷新，见 owner.ts）。
    stampOwner(state);
    pushGraphHistory(state, "start", `workflow=${workflowName} asset=${asset.id}`);
    logEvent(instId, "info", "start", { workflow: workflowName, nodes: asset.nodes.length, mode: project.mode });
    persist(run);
    const receipt = [
      `🚀 已启动 Graph 工作流 **${asset.name}**（实例 \`${instId}\`，${asset.nodes.length} 个节点）。`,
      "",
      `节点：${asset.nodes.map((node) => `\`${node.id}\``).join("、")}`,
      project.mode === "git"
        ? `Git 工作区：集成分支 \`${integration?.branch}\`，基线 \`${integration?.baseline.slice(0, 12)}…\`；每个节点在自己的 worktree 与分支上运行，主会话的 HEAD 不动。`
        : "Artifact 测试工作区：节点直接在当前工作区运行（仅测试夹具）。",
      "",
      "引擎会自动调度就绪节点；节点完成后经独立 CHECK（若配置）与人工门（若在 manual_step）。用 `/ralphflow-status` 看进度。",
      ...(loaded.warnings.length > 0 ? ["", "⚠️ 资产告警：", ...loaded.warnings.map((warning) => `- ${warning}`)] : []),
    ].join("\n");
    notify(run, receipt, `🚀 Graph 已启动：${asset.name}（${instId}）`);
    startScheduler(run, (error) => {
      log("error", "graph_scheduler_failed", { instId, error: msg(error) });
      if (run.state.graph.status === "running") {
        setStatus(run, "failed", "scheduler_failure");
        finalize(run);
      }
    });
    return { ok: true, text: receipt };
  }

  // ── 调度 ────────────────────────────────────────────────────────────────────

  function wake(run: RunContext): void {
    const resolve = run.wake;
    run.wake = null;
    resolve?.();
  }

  function waitForWake(run: RunContext): Promise<void> {
    return new Promise((resolve) => { run.wake = resolve; });
  }

  function startScheduler(run: RunContext, onError: (error: unknown) => void): void {
    if (run.schedulerActive) {
      // 旧调度器可能正因 paused 退出（或还在等在飞节点收尾）。记一笔：它退出时若实例已经
      // 回到 running，就自动重启 —— 否则「暂停 → 立刻 continue」会落在一个没人再驱动的
      // 实例上（schedulerActive 还是 true，新的 startScheduler 被吞掉）。
      run.schedulerRestart = true;
      return;
    }
    run.schedulerActive = true;
    run.scheduler = runScheduler(run).catch(onError).finally(() => {
      run.schedulerActive = false;
      if (run.schedulerRestart && run.state.graph.status === "running") {
        run.schedulerRestart = false;
        startScheduler(run, onError);
      }
    });
  }

  function allReleased(run: RunContext): boolean {
    return run.state.graph.asset.nodes.every((node) => nodeReleased(run.state, node));
  }

  function canLaunch(run: RunContext, node: GraphNode): boolean {
    if (run.state.graph.status !== "running") return false;
    if (acceptanceOfNode(run.state, node.id)) return false;
    if (waitingTodoOfNode(run.state, node.id)) return false;
    if (run.active.has(node.id)) return false;
    const latest = latestAttemptOfNode(run.state, node.id);
    if (latest && (latest.status === "submitted" || latest.status === "running")) return false;
    if (run.state.graph.project.mode === "git" && latest?.status === "submitted" && verdictOfAttempt(run.state, latest.id)?.status === "passed") {
      return false; // 等合入，不重做 DO
    }
    return node.dependsOn.every((dependency) => {
      const source = run.state.graph.asset.nodes.find((candidate) => candidate.id === dependency);
      return source ? nodeReleased(run.state, source) : false;
    });
  }

  async function runScheduler(run: RunContext): Promise<void> {
    const limit = Number.MAX_SAFE_INTEGER;
    while (run.state.graph.status === "running") {
      let launched = false;
      for (const node of run.state.graph.asset.nodes) {
        if (run.active.size >= limit) break;
        if (node.execution === "main" && run.mainBusy) continue;
        if (!canLaunch(run, node)) continue;
        launched = true;
        const task = runNode(run, node)
          .catch((error) => onNodeError(run, node, error))
          .finally(() => {
            run.active.delete(node.id);
            wake(run);
          });
        run.active.set(node.id, task);
      }
      if (run.active.size > 0) {
        await Promise.race([...run.active.values(), waitForWake(run)]);
        continue;
      }
      if (allReleased(run)) {
        completeRun(run);
        return;
      }
      // 没有在飞、也没有可启动的节点：要么在等人（人工门/暂停），要么失败。
      const waiting = run.state.graph.human_todos.some((todo) => todo.status === "waiting");
      if (waiting) {
        setStatus(run, "waiting", "human_todo");
        notify(run, "Graph 实例在等待你处理人工门。回答后用 /ralphflow-continue 或 ralphflow_respond。", "⏸ Graph 等待人工处理");
        return;
      }
      const failedNodes = run.state.graph.asset.nodes.filter((node) => nodeStatusOf(run.state, node) === "failed");
      if (failedNodes.length > 0) {
        setStatus(run, "failed", "node_failed");
        finalize(run);
        return;
      }
      setStatus(run, "paused", "no_schedulable_node");
      notify(run, "Graph 实例没有可调度节点了（依赖未满足或有节点等待重试）。检查状态后用 /ralphflow-continue 继续。", "⏸ Graph 无法继续");
      return;
    }
    wake(run);
  }

  function completeRun(run: RunContext): void {
    if (run.state.graph.status !== "running") return;
    setStatus(run, "completed");
    history(run, "complete", `${run.state.graph.asset.nodes.length} 个节点已释放`);
    finalize(run);
  }

  function finalize(run: RunContext): void {
    archiveExecutionLog(run.instId);
    const report = writeReport(run);
    persist(run);
    const status = run.state.graph.status;
    const label = status === "completed" ? "完成" : status === "cancelled" ? "取消" : status === "failed" ? "失败" : status;
    const reportLine = report ? `报告：\`${relOrAbsolute(workspace, report)}\`` : "报告写入失败，状态记录仍在 `instances/` 里。";
    notify(run, `Graph 实例 \`${run.instId}\` ${label}。${reportLine}`, `${status === "completed" ? "✅" : status === "cancelled" ? "⏹" : "❌"} Graph ${label}：${run.state.graph.asset.name}`);
    log(status === "failed" ? "warn" : "info", status === "completed" ? "graph_complete" : status === "cancelled" ? "graph_cancelled" : "graph_failed", { instId: run.instId });
    run.agents.clear();
  }

  async function onNodeError(run: RunContext, node: GraphNode, error: unknown): Promise<void> {
    if (run.state.graph.status === "cancelled") return;
    const message = msg(error);
    const attempt = latestAttemptOfNode(run.state, node.id);
    if (attempt && attempt.status === "running") {
      attempt.status = "failed";
      attempt.finished_at = now();
      attempt.failure = { kind: "runtime_failure", message };
    }
    history(run, "node_failed", message, node.id, "warn");
    if (run.state.graph.status === "running") {
      setStatus(run, "paused", "node_failure");
      notify(run, `节点 \`${node.id}\` 执行失败：${message}\n用 /ralphflow-continue 重试（会开新 attempt），或 /ralphflow-cancel 结束。`, `⏸ Graph 节点失败：${nodeNameOf(run.state, node)}`);
    }
  }

  // ── 单个节点 ────────────────────────────────────────────────────────────────

  async function runNode(run: RunContext, node: GraphNode): Promise<void> {
    if (node.execution === "main") {
      await withMainLock(run, () => runNodeLoop(run, node));
    } else {
      await runNodeLoop(run, node);
    }
  }

  async function withMainLock(run: RunContext, task: () => Promise<void>): Promise<void> {
    while (run.mainBusy && run.state.graph.status === "running") await new Promise((resolve) => setTimeout(resolve, 100));
    run.mainBusy = true;
    try { await task(); } finally { run.mainBusy = false; }
  }

  async function runNodeLoop(run: RunContext, node: GraphNode): Promise<void> {
    const check = node.check ? checkDefinition(node.check.criteria) : checkDefinition(null);
    let reworkReason = "";
    let manualReason = "";
    for (;;) {
      if (run.state.graph.status !== "running") return;
      const attempt = newAttempt(run, node, { reworkReason, manualReason });
      if (run.state.graph.project.mode === "git" && node.execution === "background") {
        await prepareAttemptWorkspace(run, node, attempt);
      }
      history(run, "node_start", `attempt=${attempt.id}`, node.id);
      try {
        await executeAttempt(run, node, attempt);
      } catch (error) {
        if (run.abort.signal.aborted || run.state.graph.status !== "running") {
          // 暂停（用户停止回合）时 attempt 已被标为 interrupted —— 不要改写成 cancelled，
          // 否则 continue 看不到"被打断、要重试"这件事。
          if (attempt.status === "running") {
            attempt.status = "cancelled";
            attempt.finished_at = now();
          }
          persist(run);
          return;
        }
        throw error;
      }
      if (run.abort.signal.aborted || run.state.graph.status !== "running") return;
      if (attempt.status !== "submitted") {
        throw new Error(`节点 \`${node.id}\` 的 agent 在没有提交产物的情况下结束了回合（缺 ralphflow_submit）。`);
      }
      // CHECK
      let verdict: GraphVerdict | null = null;
      if (node.check) {
        verdict = await runCheck(run, node, attempt, check);
        if (run.abort.signal.aborted || run.state.graph.status !== "running") return;
        if (!verdict) return;
        if (verdict.status === "infra") {
          setStatus(run, "paused", "check_infra");
          history(run, "pause", `check_infra node=${node.id}`, node.id, "warn");
          notify(run, `节点 \`${node.id}\` 的独立 CHECK 基础设施故障：${verdict.reason}\n用 /ralphflow-continue 重试验证。`, "⏸ 独立 CHECK 基础设施故障");
          return;
        }
        if (verdict.status === "failed") {
          const used = run.state.graph.rework_counts[node.id] ?? 0;
          if (used >= MAX_CHECK_REWORKS) {
            setStatus(run, "paused", "rework_limit");
            history(run, "pause", `rework_limit node=${node.id} used=${used}`, node.id, "warn");
            notify(run, `节点 \`${node.id}\` 的独立 CHECK 连续 ${used} 次未通过：${verdict.reason}\n修正资产或产物后用 /ralphflow-continue 再试。`, "⏸ CHECK 返工达到上限");
            return;
          }
          run.state.graph.rework_counts[node.id] = used + 1;
          reworkReason = verdict.reason;
          attempt.status = "rejected";
          attempt.finished_at = now();
          persist(run);
          history(run, "node_rework", verdict.reason, node.id, "warn");
          continue;
        }
      }

      // 人工门
      if (run.abort.signal.aborted || run.state.graph.status !== "running") return;
      if (run.state.graph.asset.manual_step.includes(node.id)) {
        const review = await reviewNode(run, node, attempt);
        if (run.abort.signal.aborted || run.state.graph.status !== "running") return;
        if (!review) return;
        if (review.decision === "revise") {
          manualReason = review.feedback;
          attempt.status = "rejected";
          attempt.finished_at = now();
          persist(run);
          history(run, "manual_revise", review.feedback, node.id, "warn");
          continue;
        }
      }

      // 接纳：只做快进；节点没把集成分支合进来就退回它自己
      if (run.abort.signal.aborted || run.state.graph.status !== "running") return;
      const accepted = await acceptAttempt(run, node, attempt, check.mode);
      if (accepted.ok) return;
      const mergeTries = run.state.graph.integration_retries[node.id] ?? 0;
      if (mergeTries >= MAX_INTEGRATION_RETRIES) {
        setStatus(run, "paused", "rework_limit");
        history(run, "pause", `rework_limit node=${node.id} used=${mergeTries}`, node.id, "warn");
        notify(run, `节点 \`${node.id}\` 连续 ${mergeTries} 次没有把集成分支合进自己的分支：${accepted.reason}\n修正后用 /ralphflow-continue 再试。`, "⏸ 合入重试达到上限");
        return;
      }
      run.state.graph.integration_retries[node.id] = mergeTries + 1;
      reworkReason = accepted.reason;
      attempt.status = "rejected";
      attempt.finished_at = now();
      persist(run);
      history(run, "node_rework", accepted.reason, node.id, "warn");
      continue;
    }
  }

  async function prepareAttemptWorkspace(run: RunContext, node: GraphNode, attempt: GraphAttempt): Promise<void> {
    if (run.state.graph.project.mode === "artifact") return;
    const projectRoot = run.state.graph.project.root;
    const integration = run.state.graph.integration;
    if (!projectRoot || !integration) throw new Error("Git 模式缺少 project root 或集成分支记录。");
    const recorded = run.state.graph.worktrees.find((item) => item.node_id === node.id);
    // 已有 worktree 沿用**它创建时的集成分支头**：并行/返工期间集成线可能已前进，
    // 节点要在交卷前把新头合进来（它的分支会包含两者）。
    const baseline = recorded?.baseline ?? integration.current_commit;
    const branch = recorded?.branch ?? nodeBranchFor(run.instId, node.id);
    const worktreePath = nodeWorktreePathOf(workspace, run.instId, node.id);
    const existing = await ensureNodeWorktree(projectRoot, worktreePath, branch, baseline);
    attempt.workspace = { path: existing.path, baseline };
    if (!recorded) {
      run.state.graph.worktrees.push({ node_id: node.id, path: existing.path, branch, baseline, created_at: now() });
    }
    persist(run);
  }

  function newAttempt(run: RunContext, node: GraphNode, reasons: { reworkReason: string; manualReason: string }): GraphAttempt {
    const seq = attemptsOfNode(run.state, node.id).length + 1;
    const attempt: GraphAttempt = {
      id: randomUUID(),
      node_id: node.id,
      seq,
      status: "running",
      started_at: now(),
      ...(reasons.reworkReason ? { rework_reason: reasons.reworkReason } : {}),
      ...(reasons.manualReason ? { manual_rework_reason: reasons.manualReason } : {}),
    };
    run.state.graph.attempts.push(attempt);
    persist(run);
    return attempt;
  }

  // ── DO：背景节点 / 主会话节点 ──────────────────────────────────────────────

  async function executeAttempt(run: RunContext, node: GraphNode, attempt: GraphAttempt): Promise<void> {
    if (node.execution === "main") {
      await executeMainAttempt(run, node, attempt);
    } else {
      await executeBackgroundAttempt(run, node, attempt);
    }
  }




  function inputRefs(run: RunContext, node: GraphNode): Array<{ label: string; path: string }> {
    const refs: Array<{ label: string; path: string }> = [];
    for (const reference of node.inputs) {
      const source = run.state.graph.asset.nodes.find((candidate) => candidate.id === reference.fromNode);
      if (!source) continue;
      const sourceAttempts = attemptsOfNode(run.state, reference.fromNode);
      const accepted = sourceAttempts.find((candidate) => candidate.artifact?.accepted)
        ?? sourceAttempts.filter((candidate) => verdictOfAttempt(run.state, candidate.id)?.status === "passed").at(-1)
        ?? sourceAttempts.at(-1);
      if (!accepted?.artifact) continue;
      // 子 agent 的 cwd 是 worktree；产物在运行根下，必须给绝对路径。
      refs.push({ label: `node:${reference.fromNode}/${reference.artifact}`, path: accepted.artifact.path });
    }
    return refs;
  }



  function doPrompt(run: RunContext, node: GraphNode, attempt: GraphAttempt, rework: string, manual = ""): string {
    const artifactPath = path.join(graphNodeArtifactDirOf(workspace, run.state, node.id, attempt.id), node.artifact);
    const lines = [
      `# Graph 节点执行 · ${node.id}`,
      "",
      `实例：\`${run.instId}\`　节点：\`${node.id}\`${node.name ? `（${node.name}）` : ""}　尝试：\`${attempt.id}\``,
      "",
      "## 任务",
      node.do,
      "",
    ];
    const refs = inputRefs(run, node);
    if (refs.length > 0) {
      lines.push("## 只读材料（用原生 read 读取；路径已由引擎解析）", ...refs.map((ref) => `- ${ref.label}：${ref.path}`), "");
    }
    lines.push(
      "## 交付",
      `用 \`ralphflow_artifact_write\` 写入节点产物 \`${node.artifact}\`（内容作为 content 参数；不要猜文件路径）。`,
      `产物逻辑路径：\`${workspaceRelative(workspace, artifactPath) ?? artifactPath}\``,
      "",
    );
    if (run.state.graph.project.mode === "git" && attempt.workspace?.path) {
      const baseline = attempt.workspace.baseline;
      const integration = run.state.graph.integration;
      lines.push(
        "## 工作区",
        `工作区：\`${attempt.workspace.path}\`（独立 worktree，分支 \`${nodeBranchFor(run.instId, node.id)}\`）。直接用 read/write/edit/bash 改代码，用 git 提交。`,
        `基线：\`${baseline}\``,
        integration
          ? `交卷前：有代码改动的节点先提交，再把集成分支 \`${integration.branch}\` 合进你的分支（冲突在你这轮解决），跑与改动相关的测试，工作树不要留未提交的跟踪改动；没合集成线会被退回。没有代码改动的节点（HEAD 仍在基线）只交产物即可：空分支由引擎快进到集成 tip，没有内容要合。`
          : "",
        "只改本节点需要的文件；不要动其它节点的 worktree 和主工作树。",
        "",
      );
    } else {
      lines.push("## 工作区", `项目工作区：\`${workspace}\`（主会话节点；直接读写）。`, "");
    }
    const assetRef = assetReferenceSection(assetRootOf(run.state.graph.asset_path));
    if (assetRef) lines.push(assetRef, "");
    if (rework) {
      lines.push("## 上一轮 CHECK 未通过（只修本节点）", rework, "");
    }
    if (manual) {
      lines.push("## 人工审查要求修改（只修本节点）", manual, "");
    }
    if (attempt.manual_rework_reason) {
      lines.push("## 人工审查要求改稿", attempt.manual_rework_reason, "");
    }
    lines.push(
      "## 完成条件",
      "产物内容与工作区改动都完成后，调用一次 `ralphflow_submit`。没有 submit 的回合不算完成；CHECK 与人工门由引擎机械执行。",
    );
    return lines.join("\n");
  }

  /**
   * 催促消息里的**自包含节点卡**。
   *
   * 长程节点 / 上下文压缩后，模型可能已经看不到原始节点 DO；只说「节点还没结束」等于让它猜。
   * 这里带恢复方向必需的事实（任务 / 只读材料 / 交付 / 工作区 / 返工原因），
   * 不重复「完成条件」那类长文 —— 催促是低频的（≤2 次空回合 / 20 次总上限）。
   */
  function nodeRecap(run: RunContext, node: GraphNode, attempt: GraphAttempt): string {
    const artifactPath = path.join(graphNodeArtifactDirOf(workspace, run.state, node.id, attempt.id), node.artifact);
    const refs = inputRefs(run, node);
    const assetRoot = assetRootOf(run.state.graph.asset_path);

    const lines = [
      "## 本节点回顾（上下文可能已被压缩，以这里为准）",
      `- 实例：\`${run.instId}\`　节点：\`${node.id}\`${node.name ? `（${node.name}）` : ""}　尝试：\`${attempt.id}\``,
      `- 任务：${node.do}`,
      ...(refs.length > 0 ? ["- 只读材料（用原生 read 读取）：", ...refs.map((ref) => `  - ${ref.label}：${ref.path}`)] : []),
      `- 交付：用 \`ralphflow_artifact_write\` 写入节点产物 \`${node.artifact}\`（内容作为 content 参数；不要猜文件路径）。`,
      `- 产物逻辑路径：\`${workspaceRelative(workspace, artifactPath) ?? artifactPath}\``,
      ...(run.state.graph.project.mode === "git" && attempt.workspace?.path
        ? [`- 工作区：\`${attempt.workspace.path}\`（独立 worktree；直接 read/write/edit/bash）`, `- 基线：\`${attempt.workspace.baseline}\``]
        : [`- 工作区：\`${workspace}\`（主会话节点；直接读写）`]),
      ...(assetRoot ? [`- 资产目录：\`${assetRoot}\``] : []),
      ...(attempt.rework_reason ? [`- 上一轮 CHECK 未通过（只修本节点）：${attempt.rework_reason}`] : []),
      ...(attempt.manual_rework_reason ? [`- 人工审查要求改稿：${attempt.manual_rework_reason}`] : []),
    ];
    return lines.join("\n");
  }

  function agentOptionsFor(parent: Agent, node: GraphNode): Record<string, unknown> {
    const base = { ...((parent as unknown as { options?: Record<string, unknown> }).options ?? {}) };
    delete (base as { reasoningEffort?: unknown }).reasoningEffort;
    return base;
  }

  /**
   * 把节点 agent 登记进宿主的「子智能体」发现事实。
   *
   * 节点 agent 走 `ctx.agents.create`（不经 subagent 服务），宿主不会自己写
   * `subagent/descriptor` 或父会话的 `subagent/catalog`；但它确实是 owner 会话的
   * 直接子会话（origin=subagent + parentSession）。补上这两条事实后，顶部的子智能体
   * 监控能看到它，打开会话时也能通过宿主对 subagent 地址的校验
   * （one-shot：跑完即止，不可续）。
   */
  function announceChildAgent(parent: Agent, child: Agent, label: string): void {
    try {
      const parentSession = (parent as unknown as { session?: { append?: (type: string, data: unknown) => unknown } }).session;
      const childSession = (child as unknown as { session?: { append?: (type: string, data: unknown) => unknown } }).session;
      const header = (child as unknown as { session?: { header?: { createdAt?: unknown } } }).session?.header;
      const childId = (child as unknown as { id?: unknown }).id;
      if (typeof childId !== "string") return;
      // 宿主的 subagent 地址校验从**子会话自己的日志**折出 descriptor；只写父会话的
      // catalog 会让 UI 看得到条目、却打不开历史（subagent descriptor is corrupt）。
      // version 与 DSH 的 SUBAGENT_DESCRIPTOR_VERSION 对齐（当前 3）；升级 DSH 时同步。
      childSession?.append?.("subagent/descriptor", {
        version: 3,
        mode: "one-shot",
        provider: "ralphflow-graph",
        label,
      });
      parentSession?.append?.("subagent/catalog", {
        version: 0,
        childId,
        childCreatedAt: typeof header?.createdAt === "number" ? header.createdAt : Date.now(),
        mode: "one-shot",
        label,
      });
    } catch (error) {
      log("warn", "graph_catalog_announce_failed", { error: msg(error) });
    }
  }

  async function executeBackgroundAttempt(run: RunContext, node: GraphNode, attempt: GraphAttempt): Promise<void> {
    const parent = run.state.owner_session ? (ctx.agents as unknown as { get(id: string): Agent | undefined }).get(run.state.owner_session) : undefined;
    if (!parent) throw new Error("发起会话不可用（owner_session 找不到 Agent），无法创建节点 agent。");
    const cwd = node.execution === "background"
      ? (run.state.graph.project.mode === "git" ? assertWorktree(run, node, attempt) : workspace)
      : workspace;
    const workerId = `ralphflow-graph-${randomUUID()}`;
    attempt.worker_id = workerId;
    persist(run);
    const handle = await (ctx.agents as unknown as { create(options: unknown): Promise<{ agent: Agent; dispose(): Promise<void> }> }).create({
      sessionId: workerId,
      parentAgent: parent,
      meta: { cwd, parentSession: parent.id, origin: "subagent", delegationDepth: 1 },
      agentOptions: agentOptionsFor(parent, node),
      setup: (scope: unknown) => {
        installNativeTools(scope, parent);
        registerScopedTool(scope, artifactWriteTool(run, node, attempt));
        restrictToSubmit(scope);
      },
    });
    run.agents.set(attempt.id, handle);
    // create 与注册之间可能刚好被暂停：此时 attempt 已被标 interrupted，别再启动回合。
    if (run.state.graph.status !== "running") {
      run.agents.delete(attempt.id);
      try { await handle.dispose(); } catch {}
      return;
    }
    announceChildAgent(parent, handle.agent, `Graph 节点 ${node.id}`);
    agentBindings.set(workerId, { instId: run.instId, nodeId: node.id, attemptId: attempt.id, workerId });
    registerGraphAgent(workerId, workspace);
    attempt.session_id = workerId;
    persist(run);
    // 节点要在自己的 worktree 里 commit、把集成分支合进来。worktree 的 Git 元数据在主仓库
    // `.git` 下，`workspace-write` 的边界是会话 cwd、够不到它 —— 所以这里给的是与 Claude Code
    // 子 agent 同级的权限，隔离交给 worktree 目录与提示词，而不是靠截断 git。
    setSandbox(handle.agent, "danger-full-access");
    let thrown: unknown;
    try {
      handle.agent.followup({ // @delivery directive — 唤醒节点 agent 执行本 attempt 的 DO
        id: randomUUID() as never,
        role: "user",
        content: [{ type: "text", text: doPrompt(run, node, attempt, attempt.rework_reason ?? "", attempt.manual_rework_reason ?? "") }],
        source: { kind: "ralphflow" },
      });
      await handle.agent.whenIdle();
    } catch (error) {
      thrown = error;
    } finally {
      agentBindings.delete(workerId);
      unregisterGraphAgent(workerId);
      run.agents.delete(attempt.id);
      try { await handle.dispose(); } catch {}
      const current = run.state.graph.attempts.find((item) => item.id === attempt.id);
      if (current && current.status === "running") {
        current.status = "failed";
        current.failure = thrown
          ? { kind: "runtime_failure", message: msg(thrown) }
          : { kind: "missing_submission", message: "节点 agent 结束了回合但没有调用 ralphflow_submit。" };
        persist(run);
      }
    }
    if (thrown) throw thrown;
  }

  async function executeMainAttempt(run: RunContext, node: GraphNode, attempt: GraphAttempt): Promise<void> {
    const sessionId = run.state.owner_session;
    if (!sessionId) throw new Error("Graph 主执行节点没有 owner_session。");
    const agent = (ctx.agents as unknown as { get(id: string): Agent | undefined }).get(sessionId);
    if (!agent) throw new Error("发起会话不在线，无法执行 execution: main 节点。");
    attempt.worker_id = sessionId;
    attempt.session_id = sessionId;
    agentBindings.set(sessionId, { instId: run.instId, nodeId: node.id, attemptId: attempt.id, workerId: sessionId });
    persist(run);
    const disposers: Array<() => void> = [];
    const agentCtx = (agent as unknown as { ctx?: { get(name: string): unknown } }).ctx;
    const scopedTools = agentCtx?.get("tools") as { register(definition: unknown): () => void } | undefined;
    if (!scopedTools) throw new Error("宿主没有给主会话提供 agent-scoped tools，无法挂节点产物/应答工具。");
    disposers.push(scopedTools.register(artifactWriteTool(run, node, attempt)));
    syncRespondTool(run, sessionId);
    const waited = waitForSubmit(run, attempt);
    try {
      const delivered = ports.deliverDirective(sessionId, doPrompt(run, node, attempt, attempt.rework_reason ?? "", attempt.manual_rework_reason ?? ""), `🧩 Graph 主执行节点：${nodeNameOf(run.state, node)}`, { dedupe: false });
      if (!delivered) throw new Error("无法把节点 DO 投递给主会话（会话可能离线）。");
      await waited;
    } finally {
      for (const dispose of disposers) { try { dispose(); } catch {} }
      if (agentBindings.get(sessionId)?.attemptId === attempt.id) agentBindings.delete(sessionId);
      run.submitWaiters.delete(attempt.id);
    }
  }

  function assertWorktree(run: RunContext, node: GraphNode, attempt: GraphAttempt): string {
    if (!attempt.workspace?.path) throw new Error(`节点 \`${node.id}\` 没有准备 Git worktree。`);
    return attempt.workspace.path;
  }

  function waitForSubmit(run: RunContext, attempt: GraphAttempt): Promise<{ summary?: string }> {
    return new Promise((resolve, reject) => {
      run.submitWaiters.set(attempt.id, { resolve, reject });
      run.abort.signal.addEventListener("abort", () => reject(new Error("run aborted")), { once: true });
    });
  }

  function installNativeTools(scope: unknown, parent: Agent): void {
    const names = ["read", "write", "edit", "grep", "glob", "bash", "read_image", "skill"];
    const parentTools = (parent as unknown as { ctx?: { get(name: string): unknown } }).ctx?.get("tools") as
      | { get(name: string, scope?: unknown): unknown }
      | undefined;
    const pluginTools = (ctx.tools as unknown as { get(name: string, scope?: unknown): unknown });
    const register = (scope as { tools: { register(definition: unknown): unknown } }).tools.register.bind((scope as { tools: unknown }).tools);
    for (const name of names) {
      let definition: unknown;
      try { definition = parentTools?.get(name, parent); } catch {}
      if (!definition) {
        try { definition = pluginTools.get(name); } catch {}
      }
      if (definition) {
        try { register(definition); } catch {}
      }
    }
  }

  function registerScopedTool(scope: unknown, definition: unknown): void {
    try { (scope as { tools: { register(definition: unknown): unknown } }).tools.register(definition); } catch (error) {
      log("warn", "graph_scoped_tool_register_failed", { error: msg(error) });
    }
  }

  function restrictToSubmit(scope: unknown): void {
    try { (scope as { tools: { restrict(filter: unknown): unknown } }).tools.restrict({ allow: ["ralphflow_submit"] }); } catch (error) {
      log("warn", "graph_tool_restrict_failed", { error: msg(error) });
    }
  }

  function setSandbox(agent: Agent, mode: "read-only" | "workspace-write" | "danger-full-access"): void {
    const session = agent.session as unknown as { append?: (type: string, data: unknown) => unknown };
    if (typeof session.append !== "function") {
      throw new Error("宿主会话不支持 sandbox/mode 事件，节点无法获得写 Git 的权限。");
    }
    session.append("sandbox/mode", { mode });
  }

  function artifactWriteTool(run: RunContext, node: GraphNode, attempt: GraphAttempt): unknown {
    return defineTool({
      name: "ralphflow_artifact_write",
      description: "写入本节点的声明产物。内容作为 content 传入；文件路径由引擎决定，不要自己猜。",
      parameters: { content: { type: "string", required: true, description: "节点产物的完整内容（Markdown/JSON 均可）。" } },
      output: { schema: { type: "string" }, render: (_args: unknown, value: string) => [{ type: "text", text: value }] },
      async execute(args: unknown, exec: { agent?: Agent }) {
        if (!exec?.agent) return "找不到当前节点 agent，产物未写入。";
        const binding = agentBindings.get((exec.agent as { id?: string }).id ?? "");
        if (!binding || binding.attemptId !== attempt.id || binding.nodeId !== node.id) {
          return "当前 agent 没有绑定到这个节点 attempt，产物未写入。";
        }
        const content = (args as { content?: unknown })?.content;
        if (typeof content !== "string" || content.length === 0) return "content 必须是非空字符串，产物未写入。";
        const dir = graphNodeArtifactDirOf(workspace, run.state, node.id, attempt.id);
        const file = path.join(dir, node.artifact);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf-8");
        const digest = createHash("sha256").update(content).digest("hex");
        attempt.artifact = { path: file, rel: workspaceRelative(workspace, file) ?? file, sha256: digest, size: Buffer.byteLength(content), accepted: false };
        persist(run);
        logEvent(run.instId, "info", "artifact_written", { node: node.id, attempt: attempt.id, path: file, bytes: Buffer.byteLength(content) });
        return `已写入节点产物 \`${node.artifact}\`（${Buffer.byteLength(content)} bytes，sha256 ${digest.slice(0, 12)}…）。`;
      },
    });
  }

  /** 主会话的 ralphflow_submit 分派：先看有没有绑定到 Graph 节点 attempt。 */
  async function submitFromAgent(agent: Agent | undefined, summary?: string, unfinished?: string[]): Promise<ToolResult | null> {
    const agentId = (agent as { id?: string } | undefined)?.id;
    if (agentId) {
      const binding = agentBindings.get(agentId);
      if (binding) return submitAttempt(binding.instId, binding.nodeId, binding.attemptId, summary, unfinished);
    }
    const sessionId = (agent as { session?: { id?: string } } | undefined)?.session?.id;
    if (!sessionId) return null;
    const main = activeMainAttemptOfSession(sessionId);
    if (main) return submitAttempt(main.run.instId, main.node.id, main.attempt.id, summary, unfinished);
    return null;
  }

  async function submitAttempt(instId: string, nodeId: string, attemptId: string, summary?: string, unfinished?: string[]): Promise<ToolResult> {
    const run = runs.get(instId) ?? restoreRun(instId);
    if (!run) return { ok: false, text: `Graph 实例 \`${instId}\` 不在内存中（宿主可能已重启）；用 /ralphflow-continue 恢复后再交卷。` };
    const attempt = run.state.graph.attempts.find((item) => item.id === attemptId);
    if (!attempt || attempt.node_id !== nodeId) return { ok: false, text: "找不到这个节点 attempt，交卷未受理。" };
    if (run.state.graph.status !== "running") return { ok: false, text: `实例 \`${instId}\` 当前是 ${run.state.graph.status}，交卷未受理。` };
    if (attempt.status !== "running") return { ok: false, text: `attempt 当前是 ${attempt.status}，不能重复交卷。` };
    // 未完成项非空 = 交卷是进度，不是完成声明：CHECK 不启动，attempt 留在 running 让节点 agent 接着做。
    const remaining = normalizeUnfinished(unfinished);
    if (remaining.length > 0) {
      logEvent(instId, "info", "submit_incomplete", { node: nodeId, attempt: attemptId, count: remaining.length });
      const node = run.state.graph.asset.nodes.find((item) => item.id === nodeId);
      return {
        ok: false,
        text: `交卷未受理：你列出了 ${remaining.length} 项未完成。\n\n${remaining.map((item) => `- ${item}`).join("\n")}\n\n继续做完这些再交卷；没有剩余事项时 \`unfinished\` 留空。`,
      };
    }
    if (!attempt.artifact) return { ok: false, text: "还没有写节点产物：先调用 `ralphflow_artifact_write` 写入声明的 artifact，再交卷。" };
    try {
      const stat = sha256File(attempt.artifact.path);
      if (stat.sha256 !== attempt.artifact.sha256) {
        return { ok: false, text: "产物文件在写入后发生了变化，交卷未受理；请重新调用 ralphflow_artifact_write。" };
      }
    } catch {
      return { ok: false, text: "声明的产物文件不存在，交卷未受理；请先写产物。" };
    }
    attempt.status = "submitted";
    attempt.submission = { at: now(), ...(summary?.trim() ? { summary: summary.trim().slice(-4000) } : {}) };
    attempt.finished_at = now();
    // Git 模式：捕获工作区变更，供独立验证者取证。
    if (run.state.graph.project.mode === "git" && attempt.workspace?.path) {
      try {
        const changes = await captureWorkspaceChanges(
          attempt.workspace.path,
          attempt.workspace.baseline ?? run.state.graph.integration?.baseline ?? "",
          graphNodeArtifactDirOf(workspace, run.state, nodeId, attemptId),
        );
        attemptsOfNode(run.state, nodeId).find((item) => item.id === attemptId)!.workspace_changes = {
          path: changes.path, sha256: changes.sha256, files: changes.files,
        };
      } catch (error) {
        // 同步捕获失败不阻塞交卷：CHECK 仍可读 worktree；把原因写进日志。
        logEvent(instId, "warn", "workspace_changes_failed", { node: nodeId, attempt: attemptId, error: msg(error) });
      }
    }
    persist(run);
    history(run, "do_submitted", `attempt=${attemptId}`, nodeId);
    run.submitWaiters.get(attempt.id)?.resolve({ summary });
    const submittedNode = run.state.graph.asset.nodes.find((node) => node.id === nodeId);
    notify(run, `节点 \`${nodeId}\` 已交卷，引擎开始 CHECK/人工门。`, `📥 Graph 节点交卷：${submittedNode ? nodeNameOf(run.state, submittedNode) : nodeId}`);
    return { ok: true, text: `交卷已受理：节点 \`${nodeId}\`。接下来由引擎执行独立 CHECK（若有）与人工门（若配置）；不需要再调用 submit。` };
  }

  // ── CHECK ──────────────────────────────────────────────────────────────────

  async function runCheck(run: RunContext, node: GraphNode, attempt: GraphAttempt, check: CheckDefinition): Promise<GraphVerdict | null> {
    if (!attempt.artifact) return null;
    const artifactPath = attempt.artifact.path;
    const relArtifact = attempt.artifact.rel ?? workspaceRelative(workspace, artifactPath) ?? artifactPath;
    const graphScope = {
      nodeId: node.id,
      attemptId: attempt.id,
      doInstruction: node.do,
      artifact: { path: relArtifact, sha256: attempt.artifact.sha256, size: attempt.artifact.size },
      inputs: inputRefs(run, node),
      ...(attempt.workspace?.path ? { workspacePath: attempt.workspace.path } : {}),
      ...(attempt.workspace_changes?.path ? { workspaceChangesPath: workspaceRelative(workspace, attempt.workspace_changes.path) ?? attempt.workspace_changes.path } : {}),
      criteriaText: check.criteriaText,
      criteria: check.criteria,
      checkMode: "custom" as const,
      checkVersion: checkVersion(check) ?? "custom",
    };
    const request: VerifyRequest = {
      instId: run.instId,
      step: syntheticStep(node, check.criteriaText),
      workflow: syntheticWorkflow(run.state.graph.asset),
      userTask: run.state.user_task,
      assetPath: run.state.graph.asset_path,
      ...(run.state.owner_session ? { ownerSession: run.state.owner_session } : {}),
      checkIndex: 0,
      artifactsRelDir: `${RALPH_FLOW_DIR}/artifacts/${run.state.artifacts_dir_name}/nodes/${node.id}/${attempt.id}`,
      signal: run.abort.signal,
      logEvent: (level, event, extra) => logEvent(run.instId, level, event, { ...(extra ?? {}), node: node.id, attempt: attempt.id }),
      graph: graphScope,
    };
    history(run, "verify_start", `attempt=${attempt.id}`, node.id);
    let verdict: Verdict;
    try {
      verdict = await ports.verify(request);
    } catch (error) {
      verdict = { check_index: 0, step_id: node.id, node_id: node.id, attempt_id: attempt.id, ts: now(), status: "infra", reason: `验证委派失败：${msg(error)}` };
    }
    if (!verdict || (verdict.status !== "passed" && verdict.status !== "failed" && verdict.status !== "infra")) {
      verdict = { check_index: 0, step_id: node.id, node_id: node.id, attempt_id: attempt.id, ts: now(), status: "infra", reason: "验证者返回了无法识别的判定（fail-closed）。" };
    }
    // infra 自动重试一次（与 Flow 的既有语义一致；不消耗返工预算）。
    if (verdict.status === "infra" && !run.abort.signal.aborted) {
      history(run, "verify_infra_retry", verdict.reason, node.id, "warn");
      try {
        const retry = await ports.verify(request);
        if (retry && (retry.status === "passed" || retry.status === "failed" || retry.status === "infra")) verdict = retry;
      } catch {}
    }
    const record: GraphVerdict = {
      node_id: node.id,
      attempt_id: attempt.id,
      status: verdict.status,
      reason: verdict.reason,
      ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
      ...(verdict.agent_id ? { agent_id: verdict.agent_id } : {}),
      ts: verdict.ts,
      check_index: 0,
      check_mode: graphScope.checkMode,
      check_version: graphScope.checkVersion,
    };
    run.state.graph.verdicts.push(record);
    persist(run);
    history(run, `verdict_${record.status}`, record.reason, node.id, record.status === "failed" ? "warn" : "info");
    return record;
  }

  // ── 人工门 ──────────────────────────────────────────────────────────────────

  async function reviewNode(run: RunContext, node: GraphNode, attempt: GraphAttempt): Promise<{ decision: "approve" | "revise"; feedback: string } | null> {
    if (!attempt.artifact) throw new Error("人工门需要节点产物，但 attempt 没有 artifact。");
    const artifact = { path: workspaceRelative(workspace, attempt.artifact.path) ?? attempt.artifact.path, sha256: attempt.artifact.sha256, size: attempt.artifact.size };
    const todo: GraphHumanTodo = {
      id: `graph-review-${randomUUID()}`,
      kind: "manual_review",
      status: "waiting",
      node_id: node.id,
      attempt_id: attempt.id,
      question: `节点「${nodeNameOf(run.state, node)}」已通过独立 CHECK（或未配置 CHECK），等待你审查产物后明确放行或要求改稿。`,
      artifact,
      created_at: now(),
    };
    run.state.graph.human_todos.push(todo);
    persist(run);
    syncRespondTool(run, run.state.owner_session);
    history(run, "gate_opened", `todo=${todo.id}`, node.id);
    notify(
      run,
      `节点 \`${node.id}\` 等待你审查：\n产物：\`${artifact.path}\`（sha256 ${artifact.sha256.slice(0, 12)}…）\n明确回复“批准此版本”放行，或说明要改什么。用 \`ralphflow_respond\` 把决定交给引擎。`,
      `🛑 Graph 人工门：${nodeNameOf(run.state, node)}`,
    );
    const decision = await waitForReview(run, todo);
    if (!decision) return null;
    // 复核产物版本：等待期间被改写 → 门失效。
    try {
      const stat = sha256File(attempt.artifact.path);
      if (stat.sha256 !== todo.artifact.sha256) {
        todo.status = "stale";
        todo.answered_at = now();
        persist(run);
        history(run, "gate_stale", "artifact changed while waiting", node.id, "warn");
        notify(run, `节点 \`${node.id}\` 的产物在人工门等待期间被改写，本次放行作废；引擎会重新验证。`, "⚠️ Graph 人工门失效");
        return null;
      }
    } catch {
      todo.status = "stale";
      todo.answered_at = now();
      persist(run);
      return null;
    }
    if (decision.decision === "approve") {
      todo.status = "approved";
      todo.answered_at = now();
      attempt.artifact!.accepted = false;
      if (run.state.graph.status === "waiting") setStatus(run, "running");
      persist(run);
      history(run, "gate_released", `todo=${todo.id}`, node.id);
      return decision;
    }
    todo.status = "revise";
    todo.feedback = decision.feedback;
    todo.answered_at = now();
    setStatus(run, "running");
    persist(run);
    history(run, "gate_revise", decision.feedback, node.id, "warn");
    return decision;
  }

  function waitForReview(run: RunContext, todo: GraphHumanTodo): Promise<{ decision: "approve" | "revise"; feedback: string } | null> {
    return new Promise((resolve) => {
      run.reviewWaiters.set(todo.id, {
        resolve: (value) => {
          run.reviewWaiters.delete(todo.id);
          resolve(value);
        },
        reject: () => {
          run.reviewWaiters.delete(todo.id);
          resolve(null);
        },
      });
      run.abort.signal.addEventListener("abort", () => {
        const waiter = run.reviewWaiters.get(todo.id);
        if (waiter) { run.reviewWaiters.delete(todo.id); resolve(null); }
      }, { once: true });
    });
  }

  function syncRespondTool(run: RunContext, sessionId: string | undefined): void {
    if (!sessionId) return;
    const waiting = waitingTodosOfSession(sessionId);
    const existing = run.respondTools.get(sessionId);
    if (waiting.length === 0) {
      if (existing) { try { existing(); } catch {} run.respondTools.delete(sessionId); }
      return;
    }
    if (existing) return;
    const agent = (ctx.agents as unknown as { get(id: string): Agent | undefined }).get(sessionId);
    const tools = (agent as unknown as { ctx?: { get(name: string): unknown } } | undefined)?.ctx?.get("tools") as
      | { register(definition: unknown): () => void }
      | undefined;
    if (!tools || !agent) return;
    const dispose = tools.register(defineTool({
      name: "ralphflow_respond",
      description: "回答当前 Graph 人工待办：用户明确批准产物时提交批准，要求改稿时提交用户的修改要求。只在有 Graph 人工待办时可见。",
      parameters: {
        text: { type: "string", required: true, description: "用户的原话：批准此版本，或要改什么。" },
        todoId: { type: "string", description: "可选：明确点名待办 ID（多个待办时用）。" },
      },
      output: { schema: { type: "string" }, render: (_args: unknown, value: string) => [{ type: "text", text: value }] },
      async execute(args: unknown, exec: { agent?: Agent }) {
        const text = String((args as { text?: unknown })?.text ?? "");
        const todoId = (args as { todoId?: unknown })?.todoId;
        return respondToTodo(exec?.agent, text, typeof todoId === "string" ? todoId : undefined);
      },
    }));
    run.respondTools.set(sessionId, dispose);
  }

  function respondToTodo(agent: Agent | undefined, text: string, todoId?: string): string {
    const sessionId = (agent as { session?: { id?: string } } | undefined)?.session?.id;
    if (!sessionId) return "找不到当前会话，无法提交回答。";
    const candidates = waitingTodosOfSession(sessionId);
    if (candidates.length === 0) return "当前会话没有等待中的 Graph 人工待办。";
    let selected: { run: RunContext | TodoRunRef; todo: GraphHumanTodo } | undefined;
    if (todoId) selected = candidates.find((candidate) => candidate.todo.id === todoId);
    else if (candidates.length === 1) selected = candidates[0];
    else {
      return `当前有 ${candidates.length} 个等待中的 Graph 待办，请点名 todoId：\n${candidates.map((candidate) => `- \`${candidate.todo.id}\` · 节点 \`${candidate.todo.node_id}\``).join("\n")}`;
    }
    if (!selected) return `没有找到待办 \`${todoId}\`；当前等待中：${candidates.map((candidate) => `\`${candidate.todo.id}\``).join("、")}。`;
    const { todo } = selected;
    const classified = classifyManualResponse(text);
    if (classified.kind === "clarify") {
      return classified.reason === "conflicting_intent"
        ? "你的回复同时包含“批准”和“改稿要求”，引擎不猜。请明确回复“批准此版本”，或只写要改什么。"
        : "请明确回复“批准此版本”放行，或说明要改什么（引擎不会把含糊回复当成批准）。";
    }
    const run = runs.get(selected.run.instId) ?? restoreRun(selected.run.instId);
    if (!run) return `实例 \`${selected.run.instId}\` 已不在内存中；用 /ralphflow-continue 恢复后再回答。`;
    const waiter = run.reviewWaiters.get(todo.id);
    if (!waiter) return "这个待办已经失效（可能已被取消或过期）。";
    if (run.state.graph.status === "paused") {
      // 暂停中允许先记录，恢复时再送达；简化：直接送达（人工门本身就是恢复点）。
      setStatus(run, "running");
    }
    waiter.resolve({ decision: classified.kind === "approve" ? "approve" : "revise", feedback: text.trim() });
    return classified.kind === "approve"
      ? `已把“批准”交给引擎：节点 \`${todo.node_id}\` 的产物将进入接纳流程。`
      : `已把改稿要求交给引擎：节点 \`${todo.node_id}\` 会开新 attempt。`;
  }

  // ── 接纳 / 快进 ──────────────────────────────────────────────────────────────

  type AcceptanceResult = { ok: true } | { ok: false; reason: string };

  /**
   * 接纳必须**串行**：集成分支每个 run 只有一条，并行节点依次快进。
   * 但验收本身是机械的：节点分支已经包含集成分支头，就前进引用；否则退回节点。
   */
  /** 显式 continue 后的接纳失败：把 attempt 标成 rejected，调度器会开新 attempt 重做这一步。 */
  function rejectIfNotFastForward(run: RunContext, node: GraphNode, attempt: GraphAttempt, result: AcceptanceResult | null): void {
    if (!result || result.ok) return;
    attempt.status = "rejected";
    attempt.finished_at = now();
    run.state.graph.integration_retries[node.id] = 0;
    persist(run);
    history(run, "node_rework", result.reason, node.id, "warn");
  }

  async function acceptAttempt(run: RunContext, node: GraphNode, attempt: GraphAttempt, checkMode: "disabled" | "custom"): Promise<AcceptanceResult> {
    const previous = run.acceptTail;
    let release!: () => void;
    run.acceptTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      // 排队期间 run 可能已被暂停：别往暂停的 run 里写接纳记录。
      if (run.state.graph.status !== "running") return { ok: true };
      return await acceptAttemptLocked(run, node, attempt, checkMode);
    } finally {
      release();
    }
  }

  async function acceptAttemptLocked(run: RunContext, node: GraphNode, attempt: GraphAttempt, checkMode: "disabled" | "custom"): Promise<AcceptanceResult> {
    if (!attempt.artifact) throw new Error("接纳需要节点产物。");
    const artifact = attempt.artifact;
    let integration: GraphIntegrationAcceptance["integration"];
    if (run.state.graph.project.mode === "git" && attempt.workspace?.path) {
      const accepted = await fastForwardIntegration(run, node, attempt);
      if (!accepted.ok) return accepted;
      integration = accepted.integration;
    }
    artifact.accepted = true;
    const acceptance: GraphIntegrationAcceptance = {
      node_id: node.id,
      attempt_id: attempt.id,
      accepted_at: now(),
      artifact_sha256: artifact.sha256,
      check_mode: checkMode,
      manual_approval: run.state.graph.asset.manual_step.includes(node.id),
      ...(integration ? { integration } : {}),
    };
    run.state.graph.acceptances.push(acceptance);
    attempt.artifact = { ...artifact, accepted: true };
    run.state.graph.rework_counts[node.id] = 0;
    run.state.graph.integration_retries[node.id] = 0;
    persist(run);
    history(run, "node_accepted", `attempt=${attempt.id}${integration ? ` commit=${integration.commit}` : ""}`, node.id);
    notify(run, `节点 \`${node.id}\` 已${integration ? `合入 \`${integration.branch}\`（${integration.commit.slice(0, 12)}…）` : "完成"}。`, `✅ Graph 节点完成：${nodeNameOf(run.state, node)}`);
    wake(run);
    return { ok: true };
  }

  /**
   * 快进集成分支。节点分支必须已经包含集成分支头 —— 那是节点自己「合入集成分支」的结果；
   * 不包含就退回节点，不在这里替它合并。
   */
  async function fastForwardIntegration(run: RunContext, node: GraphNode, attempt: GraphAttempt): Promise<({ ok: true } & { integration: NonNullable<GraphIntegrationAcceptance["integration"]> }) | { ok: false; reason: string }> {
    const projectRoot = run.state.graph.project.root;
    const integration = run.state.graph.integration;
    if (!projectRoot || !integration) throw new Error("Git 模式缺少 project root 或集成分支记录。");
    if (!attempt.workspace?.path) throw new Error("节点缺少 worktree。");
    const previous = (await branchTip(projectRoot, integration.branch)) ?? integration.current_commit;
    if (previous !== integration.current_commit) integration.current_commit = previous;
    const base = attempt.workspace.baseline ?? integration.baseline;
    // 验收看状态里记录的节点分支：worktree 的游离 HEAD 不是合入对象。
    const worktree = run.state.graph.worktrees.find((item) => item.node_id === node.id);
    if (!worktree?.branch) {
      throw new Error(`节点 \`${node.id}\` 缺少 worktree 分支记录，无法验收；检查 state.json 的 worktrees。`);
    }
    const nodeBranch = worktree.branch;
    const readiness = await nodeReadyForIntegration({
      worktreePath: attempt.workspace.path,
      nodeBranch,
      baseline: base,
      integrationBranch: integration.branch,
      integrationTip: previous,
    });
    if (!readiness.ok) return { ok: false, reason: readiness.reason };
    if (readiness.aligned) history(run, "node_branch_aligned", `${nodeBranch} -> ${readiness.head}`, node.id);
    const commit = readiness.head;
    if (commit !== previous) {
      await advanceIntegration(projectRoot, integration.branch, previous, commit);
      history(run, "integration_advanced", `${previous} -> ${commit}`, node.id);
    }
    integration.current_commit = commit;
    return {
      ok: true,
      integration: { branch: integration.branch, previous_commit: previous, commit, base_commit: base },
    };
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /** 恢复实例时确保集成分支存在（新实例在 start 里建；缺分支的保留实例在这里补齐）。 */
  async function ensureIntegrationBranchFor(run: RunContext): Promise<void> {
    const projectRoot = run.state.graph.project.root;
    const integration = run.state.graph.integration;
    if (!projectRoot || !integration) return;
    const tip = await ensureIntegrationBranch(projectRoot, integration.branch, integration.current_commit);
    integration.current_commit = tip;
  }

  function restoreRun(instId: string): RunContext | null {
    if (runs.has(instId)) return runs.get(instId)!;
    const state = readGraphState(workspace, instId);
    if (!state) return null;
    const run: RunContext = {
      instId,
      state,
      artifactRoot: path.join(artifactsRoot, state.artifacts_dir_name),
      ...(state.graph.project.root ? { projectRoot: state.graph.project.root } : {}),
      submitWaiters: new Map(),
      reviewWaiters: new Map(),
      active: new Map(),
      agents: new Map(),
      abort: new AbortController(),
      wake: null,
      respondTools: new Map(),
      mainBusy: false,
      schedulerActive: false,
      schedulerRestart: false,
      acceptTail: Promise.resolve(),
    };
    runs.set(instId, run);
    return run;
  }

  /**
   * 宿主重开：只处理「running 但没有属主」的实例，**不自动推进**。
   *
   * 判据是实例心跳（`owner.ts`）：过 TTL/缺失 → 立刻标中断；还新鲜 → 可能是另一个活着的
   * host，也可能是快速重启，等一个刷新窗口看心跳是否继续往前走来判定。审查门/暂停不动。
   * 心跳仍是「另一个 dsh 还活着」的唯一凭据；只看引擎启动会误伤它。
   */
  function restore(): void {
    for (const { id, state } of listStates()) {
      if (!state.active || state.graph.status !== "running") continue;
      if (!ownerAlive(state)) {
        const run = runs.get(id) ?? restoreRun(id);
        if (run) markInterrupted(run);
        continue;
      }
      // 心跳的属主就是本进程：我们知道自己活着，不必再复查。
      if (state.owner_runtime === runtimeId()) continue;
      scheduleOwnerRecheck(id, state.owner_heartbeat_at ?? 0);
    }
  }

  /** 把「属主已失联」落盘为 interrupted（不自动继续）。 */
  function markInterrupted(run: RunContext): void {
    if (run.state.graph.status !== "running") return;
    run.state.graph.status = "interrupted";
    run.state.active = true;
    run.state.graph.pause_reason = "host_restarted";
    for (const attempt of run.state.graph.attempts) {
      if (attempt.status === "running") {
        attempt.status = "interrupted";
        attempt.interrupted_at = now();
        attempt.finished_at = now();
        attempt.failure = { kind: "interrupted", message: "驱动这个实例的运行时不在了。" };
      }
    }
    history(run, "interrupted", "owner runtime lost; resume with /ralphflow-continue");
    persist(run);
    notify(run, `⏸ Graph 已中断：驱动这个实例的运行时不在了（宿主重启或进程退出）。状态、判定与产物都保留；用 /ralphflow-continue 继续。`, "⏸ Graph 已中断：属主运行时失联");
    log("info", "graph_interrupted_restored", { instId: run.instId });
  }

  /**
   * 快速复查：等一个刷新窗口，心跳还没有往前走，才判属主已死。
   * 定时器 unref；实例被继续/暂停/结束时条件自然不成立，复查是空操作。
   */
  function scheduleOwnerRecheck(instId: string, beatAt: number): void {
    const delay = ownerRecheckMs();
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      try {
        const state = readGraphState(workspace, instId);
        if (!state || !state.active || state.graph.status !== "running") return;
        if ((state.owner_heartbeat_at ?? 0) > beatAt) return; // 另一个活着的属主刚刷过
        const run = runs.get(instId) ?? restoreRun(instId);
        if (run) markInterrupted(run);
      } catch (error) {
        log("warn", "graph_owner_recheck_failed", { instId, error: msg(error) });
      }
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  async function continueInstance(sessionId: string, instanceRef?: string): Promise<ToolResult> {
    const target = findInstance(sessionId, instanceRef);
    if (!target) return { ok: false, text: "找不到可继续的 Graph 实例。" };
    const run = runs.get(target.id) ?? restoreRun(target.id);
    if (!run) return { ok: false, text: `Graph 实例 \`${target.id}\` 的状态不可读，无法继续。` };
    if (run.state.owner_session && run.state.owner_session !== sessionId && !instanceRef) {
      return { ok: false, text: `实例 \`${target.id}\` 属于会话 \`${run.state.owner_session}\`；要接管请显式给实例 ID。` };
    }
    if (run.state.graph.status === "completed" || run.state.graph.status === "cancelled") {
      return { ok: false, text: `实例 \`${target.id}\` 已${run.state.graph.status === "completed" ? "完成" : "取消"}，不能继续。` };
    }
    if (run.state.graph.human_todos.some((todo) => todo.status === "waiting")) {
      return { ok: false, text: `实例 \`${target.id}\` 正在等待人工审查；请先明确批准或要求改稿（ralphflow_respond），不能代答。` };
    }
    // 属主已失联、但复查还没落盘：显式 continue 就是最快的恢复入口，别用"正在运行"挡住用户。
    if (run.state.graph.status === "running" && !ownerAlive(run.state)) markInterrupted(run);
    if (run.state.graph.status === "running") {
      return { ok: true, text: `实例 \`${target.id}\` 正在运行，无需继续。` };
    }
    const prev = run.state.graph.status;
    const prevReason = run.state.graph.pause_reason;
    // 显式给实例 ID 的 continue 是接管：属主随当前会话，否则后续节点 agent 会被投递到
    // 已关闭的旧会话。
    if (instanceRef || !run.state.owner_session) run.state.owner_session = sessionId;
    // 恢复 = 本运行时重新持有属主；先写心跳再由 setStatus 一并落盘。
    stampOwner(run.state);
    try { await ensureIntegrationBranchFor(run); } catch (error) { return { ok: false, text: `实例 \`${target.id}\` 的集成分支无法就绪：${msg(error)}` }; }
    setStatus(run, "running");
    history(run, "resume", `from=${prev}${prevReason ? ` reason=${prevReason}` : ""}`);
    // 主节点还在跑：DO 只投递过一次，暂停期间回合已经结束，恢复时必须补一条继续指令，
    // 否则模型会一直停在那里（no_submit 暂停就是这种形态）。
    const mainNode = run.state.graph.asset.nodes.find((item) => item.execution === "main");
    const mainAttempt = mainNode ? latestAttemptOfNode(run.state, mainNode.id) : undefined;
    if (mainNode && mainAttempt?.status === "running") {
      notify(run, `[ralphflow] Graph 实例已恢复：节点 \`${mainNode.id}\` 的 attempt 还在进行。产物写好后，调用 \`ralphflow_submit\` 结束本轮；还有没完成的事项就写进 \`unfinished\`，没有就留空。`, `▶️ Graph 已恢复：节点 ${nodeNameOf(run.state, mainNode)} 继续执行`, true);
    }
    // 已经通过 CHECK/人工门但还没合入的节点：只重试合入，不重做 DO。
    for (const node of run.state.graph.asset.nodes) {
      if (acceptanceOfNode(run.state, node.id)) continue;
      const attempt = latestAttemptOfNode(run.state, node.id);
      if (!attempt) continue;
      if (attempt.status === "interrupted") {
        attempt.status = "failed";
        // 保留中断的真实原因：用户暂停写的是「你停止了运行」，宿主重启写的是「运行时不在了」。
        if (attempt.failure?.kind !== "interrupted") {
          attempt.failure = { kind: "interrupted", message: "宿主重启中断了这次 attempt。" };
        }
        persist(run);
        continue;
      }
      if (attempt.status !== "submitted") continue;
      const check = node.check ? checkDefinition(node.check.criteria) : checkDefinition(null);
      const verdict = node.check ? verdictOfAttempt(run.state, attempt.id) : undefined;
      if (node.check && (!verdict || verdict.status === "infra" || verdict.status === "failed")) {
        // 暂停时没有完成判定（infra/中断）或判定未通过：显式 continue 是用户对重试的授权，
        // 给这一节点一次新的返工预算，然后让调度器开新 attempt（不偷偷把失败算成通过）。
        attempt.status = "rejected";
        attempt.finished_at = now();
        run.state.graph.rework_counts[node.id] = 0;
        persist(run);
        history(run, "node_retry_requested", verdict ? `previous=${verdict.status}` : "no verdict", node.id);
        continue;
      }
      if (run.state.graph.asset.manual_step.includes(node.id)) {
        const approved = run.state.graph.human_todos.some((todo) => todo.node_id === node.id && todo.status === "approved");
        if (approved) {
          await rejectIfNotFastForward(run, node, attempt, await acceptAttempt(run, node, attempt, check.mode));
          continue;
        }
        if (!waitingTodoOfNode(run.state, node.id)) {
          void reviewNode(run, node, attempt).then(async (decision) => {
            if (!decision) return;
            if (decision.decision === "approve") {
              const accepted = await acceptAttempt(run, node, attempt, check.mode).catch((error) => { onNodeError(run, node, error); return null; });
              if (accepted) rejectIfNotFastForward(run, node, attempt, accepted);
            }
          });
        }
        continue;
      }
      if (!node.check || verdict?.status === "passed") {
        await rejectIfNotFastForward(run, node, attempt, await acceptAttempt(run, node, attempt, check.mode));
      }
    }
    if (allReleased(run)) {
      completeRun(run);
      return { ok: true, text: `实例 \`${target.id}\` 的节点已全部释放，本次继续后完成。` };
    }
    startScheduler(run, (error) => onNodeError(run, run.state.graph.asset.nodes[0]!, error));
    return { ok: true, text: `已恢复 Graph 实例 \`${target.id}\`（${prev} → running），调度器会继续就绪节点。` };
  }

  /**
   * 用户要求暂停（停止按钮，或输入区的暂停按钮）。
   *
   * 只要有**任一节点 attempt 在飞**就暂停：Graph 的常态是后台节点，主会话只是调度入口，
   * 不能因为主回合空闲就拒绝暂停。在飞 attempt 标 `interrupted`（continue 按既有
   * interrupted 路径重试），后台 agent 直接 dispose，主回合的 submit 等待解开。
   *
   * 已交卷/验证中/没有在飞节点时不暂停：验证不该被停止键打断（与 Flow 同一条纪律）。
   * 先落盘暂停、再中断 agent，避免另一个 host 看到"在飞 + 无主"。
   */
  function pauseForUserStop(sessionId: string): ToolResult {
    const target = activeInstanceOfSession(sessionId);
    if (!target) return { ok: false, text: "当前会话没有活跃的 Graph 实例，不需要暂停。" };
    const run = runs.get(target.id) ?? restoreRun(target.id);
    if (!run) return { ok: false, text: `Graph 实例 \`${target.id}\` 的状态不可读，无法暂停。` };
    if (run.state.graph.status !== "running") {
      return { ok: false, text: `Graph 实例 \`${target.id}\` 当前是 ${run.state.graph.status}，不在执行中。` };
    }
    const running = run.state.graph.attempts.filter((attempt) => attempt.status === "running");
    if (running.length === 0) {
      return { ok: false, text: "当前没有正在执行的节点（可能在验证或等待），停止回合不按暂停处理。" };
    }
    const disposers: Array<() => Promise<void>> = [];
    for (const attempt of running) {
      attempt.status = "interrupted";
      attempt.interrupted_at = now();
      attempt.finished_at = now();
      attempt.failure = { kind: "interrupted", message: "你停止了运行。" };
      const handle = run.agents.get(attempt.id) as { dispose?: () => Promise<void> } | undefined;
      if (handle) {
        run.agents.delete(attempt.id);
        if (typeof handle.dispose === "function") disposers.push(() => handle.dispose!());
      }
      run.submitWaiters.get(attempt.id)?.reject(new Error("paused by user"));
      run.submitWaiters.delete(attempt.id);
    }
    const nodes = [...new Set(running.map((attempt) => attempt.node_id))];
    history(run, "pause", `user_stop ${nodes.map((id) => `node=${id}`).join(" ")}`, running[0]!.node_id);
    setStatus(run, "paused", "user_stop");
    for (const dispose of disposers) { void dispose().catch(() => undefined); }
    notify(run, `⏸ Graph 已暂停（你停止了运行）；${running.length} 个在飞节点已中断，不再启动新节点。用 /ralphflow-continue 继续。`, "⏸ Graph 已暂停：你停止了运行");
    return { ok: true, text: `Graph 实例 \`${target.id}\` 已暂停（你停止了运行）。` };
  }

  async function cancelInstance(sessionId: string, instanceRef?: string, reason?: string): Promise<ToolResult> {
    const target = findInstance(sessionId, instanceRef);
    if (!target) return { ok: false, text: "找不到要取消的 Graph 实例。" };
    const run = runs.get(target.id) ?? restoreRun(target.id);
    if (!run) return { ok: false, text: "状态不可读，无法取消。" };
    if (run.state.graph.status === "completed" || run.state.graph.status === "cancelled") {
      return { ok: false, text: `实例 \`${target.id}\` 已${run.state.graph.status === "completed" ? "完成" : "取消"}。` };
    }
    run.abort.abort();
    for (const waiter of run.submitWaiters.values()) waiter.reject(new Error("run cancelled"));
    run.submitWaiters.clear();
    for (const waiter of run.reviewWaiters.values()) waiter.reject(new Error("run cancelled"));
    run.reviewWaiters.clear();
    for (const todo of run.state.graph.human_todos) {
      if (todo.status === "waiting") { todo.status = "cancelled"; todo.answered_at = now(); }
    }
    for (const attempt of run.state.graph.attempts) {
      if (attempt.status === "running") { attempt.status = "cancelled"; attempt.finished_at = now(); }
    }
    setStatus(run, "cancelled", reason ? `user: ${reason}` : "user_cancelled");
    history(run, "cancelled", reason ?? "user_cancelled");
    for (const dispose of run.respondTools.values()) { try { dispose(); } catch {} }
    run.respondTools.clear();
    for (const handle of run.agents.values()) {
      try { await (handle as { dispose(): Promise<void> }).dispose(); } catch {}
    }
    run.agents.clear();
    finalize(run);
    return { ok: true, text: `已取消 Graph 实例 \`${target.id}\`；报告已归档，状态、日志、产物与 worktree 保留供复核。worktree 要在复核后删除时，执行 /ralphflow-cleanup 只清理其中干净的那部分。` };
  }

  function findInstance(sessionId: string, instanceRef?: string): { id: string; state: GraphInstanceState } | undefined {
    const all = listStates();
    if (instanceRef) {
      const exact = all.find((entry) => entry.id === instanceRef);
      if (exact) return exact;
      const prefixed = all.filter((entry) => entry.id.startsWith(instanceRef));
      return prefixed.length === 1 ? prefixed[0] : undefined;
    }
    return all.filter((entry) => entry.state.owner_session === sessionId).at(-1);
  }

  async function cleanupInstance(instanceRef?: string): Promise<ToolResult> {
    const all = listStates();
    const target = instanceRef
      ? all.find((entry) => entry.id === instanceRef) ?? all.find((entry) => entry.id.startsWith(instanceRef))
      : all.filter((entry) => isGraphTerminal(entry.state.graph.status)).at(-1);
    if (!target) return { ok: false, text: "找不到可清理的 Graph 实例。" };
    const { id, state } = target;
    if (state.active && !isGraphTerminal(state.graph.status)) {
      return { ok: false, text: `实例 \`${id}\` 还在 ${state.graph.status}；只清理已结束实例的干净 worktree。` };
    }
    if (state.graph.project.mode !== "git") return { ok: true, text: `Graph 实例 \`${id}\` 使用 artifact 测试工作区，没有 worktree 需要清理。` };
    const projectRoot = state.graph.project.root;
    if (!projectRoot) return { ok: false, text: `实例 \`${id}\` 没有 project root 记录，无法清理。` };
    const removed: string[] = [];
    const kept: string[] = [];
    const keepReason = (reason?: string): string => {
      switch (reason) {
        case "worktree_has_changes": return "有未提交或未跟踪的改动";
        case "not_registered": return "不在 git worktree 注册表里";
        case "unreadable": return "无法读取工作树状态";
        default: return reason ?? "未删除";
      }
    };
    for (const worktree of state.graph.worktrees) {
      const result = await removeCleanWorktree(projectRoot, worktree.path);
      if (result.removed) removed.push(worktree.node_id);
      else kept.push(`${worktree.node_id}（${keepReason(result.reason)}）`);
    }
    // 保留的 worktree 连同它的 git 注册与目录原样留下；只在目录确实为空时收掉 worktrees 根。
    // 不递归删除：否则会把刚判定“保留”的目录一起抹掉，注册表还会留下 prunable。
    const worktreesRoot = worktreeRootOf(workspace, id);
    try {
      if (fs.existsSync(worktreesRoot) && fs.readdirSync(worktreesRoot).length === 0) fs.rmdirSync(worktreesRoot);
    } catch {}
    logEvent(id, "info", "cleanup", { removed, kept });
    return {
      ok: true,
      text: `已清理 Graph 实例 \`${id}\` 的干净 worktree：${removed.length > 0 ? removed.join("、") : "（无）"}。${kept.length > 0 ? `保留（路径与 git worktree 注册均未动）：${kept.join("；")}。` : ""}state、artifacts、reports 一律未动。`,
    };
  }

  // ── 状态 / 诊断 ──────────────────────────────────────────────────────────────

  function formatProjection(projection: GraphRunProjection): string {
    const lines = [
      `## Graph 实例 \`${projection.id}\` — ${projection.workflow}`,
      "",
      `- 状态：**${projection.phase}**（${projection.status}）`,
      `- 节点：${projection.counts.completed}/${projection.counts.total} 完成 · ${projection.counts.running} 在飞 · ${projection.counts.waiting} 等待 · ${projection.counts.blocked} 阻塞`,
      ...(projection.current ? [`- 当前节点：\`${projection.current.nodeId}\`（${projection.current.name}）· ${projection.current.status}`] : []),
      ...(projection.nextAction ? [`- 下一步：${projection.nextAction.message}`] : []),
      ...(projection.integration ? [`- 集成分支：\`${projection.integration.branch}\` @ \`${projection.integration.currentCommit.slice(0, 12)}…\`（已接纳 ${projection.integration.accepted}）`] : []),
      `- 交付：已交付 ${projection.delivery.delivered} · 未接纳 ${projection.delivery.unaccepted} · 未验证 ${projection.delivery.unverified} · 未完成 ${projection.delivery.unfinished}`,
      `- 报告：${projection.report ? `\`${projection.report}\`` : "（运行中，结束后归档）"}`,
      "",
      "### 节点",
      "",
      ...projection.nodes.map((node) => `- ${node.current ? "▶" : " "} \`${node.id}\` ${node.name} — **${node.label}**；尝试 ${node.attempts}；CHECK ${node.check.mode}/${node.check.status}${node.check.reworks > 0 ? ` · 返工 ${node.check.reworks}` : ""}${node.artifact ? `；产物 \`${node.artifact.path}\`` : ""}`),
      "",
      "### 最近轨迹",
      "",
      ...(listStates().find((entry) => entry.id === projection.id)?.state.history.slice(-6).map((entry) => `- \`${entry.ts}\` **${entry.event}**${entry.step ? ` [${entry.step}]` : ""}${entry.detail ? ` — ${entry.detail}` : ""}`) ?? []),
    ];
    return lines.join("\n");
  }

  /** 让当前会话的 Graph 人工待办在（重开的）会话作用域里重新可见。 */
  function syncSession(sessionId: string): void {
    const active = activeInstanceOfSession(sessionId);
    if (active) {
      const run = runs.get(active.id) ?? restoreRun(active.id);
      if (run) syncRespondTool(run, sessionId);
      return;
    }
    const retained = listStates().filter((entry) => entry.state.owner_session === sessionId).at(-1);
    if (!retained) return;
    const run = runs.get(retained.id) ?? restoreRun(retained.id);
    if (run) syncRespondTool(run, sessionId);
  }

  function statusOf(sessionId: string, instanceRef?: string): ToolResult {
    syncSession(sessionId);
    if (instanceRef) {
      const target = findInstance(sessionId, instanceRef);
      if (!target) return { ok: false, text: `没有找到 Graph 实例 \`${instanceRef}\`。` };
      return { ok: true, text: formatProjection(projectionOf(target.state, target.id)) };
    }
    const active = activeInstanceOfSession(sessionId);
    const retained = listStates().filter((entry) => entry.state.owner_session === sessionId).at(-1);
    const chosen = active ?? retained;
    if (!chosen) return { ok: false, text: "当前会话没有 Graph 实例。" };
    return { ok: true, text: formatProjection(projectionOf(chosen.state, chosen.id)) };
  }

  function listAll(): ToolResult {
    const workflows = listWorkflows();
    const states = listStates();
    const lines = ["## Graph 工作流", ""];
    if (workflows.length === 0) lines.push("（没有 Graph 工作流）");
    for (const workflow of workflows) {
      lines.push(`${workflow.invalid ? "❌" : "✅"} **${workflow.name}**（${workflow.nodes} 节点）${workflow.desc ? `：${workflow.desc}` : ""}`);
      for (const problem of workflow.problems) lines.push(`  - ${problem}`);
      for (const warning of workflow.warnings) lines.push(`  - ⚠️ ${warning}`);
    }
    lines.push("", "## Graph 实例", "");
    if (states.length === 0) lines.push("（暂无 Graph 实例）");
    for (const { id, state } of states) {
      const projection = projectionOf(state, id);
      lines.push(`- \`${id}\` — ${state.workflow_name} · ${projection.phase} · ${projection.counts.completed}/${projection.counts.total}`);
    }
    return { ok: true, text: lines.join("\n") };
  }

  function diagnose(): ToolResult {
    const lines = ["## Graph 工作流诊断", ""];
    const workflows = listWorkflows();
    if (workflows.length === 0) lines.push("（没有 Graph 工作流）");
    for (const workflow of workflows) {
      if (workflow.invalid) {
        lines.push(`- ❌ **${workflow.name}**：定义无效`);
        for (const problem of workflow.problems) lines.push(`  - ${problem}`);
      } else {
        lines.push(`- ✅ **${workflow.name}**：${workflow.desc || "（无描述）"}`);
        for (const warning of workflow.warnings) lines.push(`  - ⚠️ ${warning}`);
      }
      lines.push("");
    }
    lines.push("## Graph 实例诊断", "");
    const states = listStates();
    if (states.length === 0) lines.push("（暂无 Graph 实例）");
    for (const { id, state } of states) {
      const projection = projectionOf(state, id);
      if (state.active) {
        lines.push(`- \`${id}\` — ${state.workflow_name} · ${projection.phase}${state.graph.pause_reason ? `（${pauseLabel(state.graph.pause_reason)}）` : ""}`);
      } else {
        lines.push(`- \`${id}\` — ${state.workflow_name} · 已结束（${state.graph.status}，状态保留供复核）`);
      }
    }
    lines.push("", "结论：所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅。");
    return { ok: true, text: lines.join("\n") };
  }

  /**
   * 主执行节点的回合收尾检查（宿主 `agent/turn-stopping` 调用）。
   *
   * 判定与 Flow 同一条：有动作的提醒只记总次数，空回合连续到上限（或总次数到顶）就暂停整个 run。
   * 暂停后主节点的 attempt 仍在等交卷 —— 恢复时由 {@link continueInstance} 重新投递继续指令，
   * 否则模型会停在原地（DO 只投递过一次）。
   */
  function reminderStateOf(
    run: RunContext,
    nodeId: string,
    lastActionAt: number | undefined,
  ): { stalls: number; total: number; worked: boolean } {
    // 边界：这个节点的 attempt 起点；用户 `/ralphflow-continue` 之后重新计数。
    let from = -1;
    for (let i = 0; i < run.state.history.length; i++) {
      const h = run.state.history[i]!;
      if (h.step === nodeId && h.event === "node_start") from = i;
      else if (h.event === "resume" && from >= 0) from = i;
    }
    let total = 0;
    let stalls = 0;
    let last = -1;
    for (let i = from + 1; i < run.state.history.length; i++) {
      const h = run.state.history[i]!;
      if (h.step !== nodeId) continue;
      if (h.event === "submit_activity") { stalls = 0; total++; last = i; }
      else if (h.event === "submit_reminder") { stalls++; total++; last = i; }
    }
    const anchor = last >= 0 ? run.state.history[last]!.ts : from >= 0 ? run.state.history[from]!.ts : undefined;
    const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
    const worked = lastActionAt !== undefined && Number.isFinite(anchorMs) && lastActionAt > anchorMs;
    return { stalls, total, worked };
  }

  function remindToSubmit(sessionId: string): { remind: boolean; message?: string; summary?: string } {
    const main = activeMainAttemptOfSession(sessionId);
    if (!main) return { remind: false };
    const { run, node, attempt } = main;
    if (run.state.graph.status !== "running") return { remind: false };
    const { stalls, total, worked } = reminderStateOf(run, node.id, ports.lastActionAt?.(sessionId));

    // 与 Flow 同一条：两个上限都只在**这一轮也是空回合**时生效（干着活不被次数掐停）。
    const stalledOut = !worked && stalls >= SUBMIT_REMINDER_STALL_LIMIT;
    const budgetOut = !worked && total >= SUBMIT_REMINDER_TOTAL_LIMIT;
    if (stalledOut || budgetOut) {
      const why = stalledOut
        ? `连续 ${stalls} 次回合结束都没有任何动作`
        : `已提醒 ${total} 次仍未交卷`;
      // 先记轨迹再改状态：setStatus 会 persist，顺序反了磁盘上就少了这条暂停原因。
      history(run, "reminder_exhausted", why, node.id, "warn");
      setStatus(run, "paused", "no_submit");
      logEvent(run.instId, "warn", "submit_reminder_exhausted", { node: node.id, stalls, total });
      return {
        remind: false,
        summary: `⏸ Graph 节点 ${node.id} ${why}，已暂停等你处理`,
        message: `⏸ Graph 主执行节点 \`${node.id}\` ${why}，已暂停等你处理。\n\n- 它其实做完了：先 \`/ralphflow-continue\` 恢复（会重新投递继续指令），再让它写产物并交卷。\n- 它在等你：直接回复它要的信息，再 \`/ralphflow-continue\` 恢复。\n- 它卡住了：\`/ralphflow-cancel\` 结束。`,
      };
    }

    history(run, worked ? "submit_activity" : "submit_reminder", worked ? `第 ${total + 1} 次` : `第 ${stalls + 1}/${SUBMIT_REMINDER_STALL_LIMIT} 次空回合`, node.id);
    persist(run);
    const head = worked
      ? `[ralphflow] 提醒：Graph 节点 \`${node.id}\` 还没结束。`
      : `[ralphflow] 提醒（第 ${stalls + 1}/${SUBMIT_REMINDER_STALL_LIMIT} 次空回合）：Graph 节点 \`${node.id}\` 还没结束，上次提醒之后没有任何工具调用。`;
    return {
      remind: true,
      summary: worked
        ? `⚠️ Graph 节点 ${node.id} 还没结束（第 ${total + 1} 次提醒）`
        : `⚠️ Graph 节点 ${node.id} 还没结束（连续 ${stalls + 1} 次空回合）`,
      message: `${head}\n\n${nodeRecap(run, node, attempt)}\n\n本轮结束前：产物写好后，还有没完成的事项就写进 \`unfinished\`（交卷会被退回）；没有就留空，调用 \`ralphflow_submit\` 结束本轮。\n在等我回答或需要我介入：直接说明，不必交卷。`,
    };
  }

  function uiStatus(sessionId: string): { projection: GraphRunProjection | null; error: string | null } {
    const active = activeInstanceOfSession(sessionId);
    const retained = listStates().filter((entry) => entry.state.owner_session === sessionId).at(-1);
    const chosen = active ?? retained;
    if (!chosen) return { projection: null, error: null };
    return { projection: projectionOf(chosen.state, chosen.id), error: null };
  }

  const graphEngineFace = {
    kind: "graph" as const,
    root,
    graphsDir,
    instancesDir,
    reportsDir,
    projectDir: workspace,
    ensureLayout,
    listWorkflows,
    loadWorkflow,
    readState,
    listStates,
    instanceDir,
    artifactsDirOf: (state: GraphInstanceState) => graphArtifactsDirOf(workspace, state),
    start,
    submitFromAgent,
    continueInstance,
    pauseForUserStop,
    cancelInstance,
    cleanupInstance,
    statusOf,
    listAll,
    diagnose,
    restore,
    respond: respondToTodo,
    remindToSubmit,
    uiStatus,
    activeInstanceOfSession,
    syncSession,
    projectionOf: (state: GraphInstanceState, id: string) => projectionOf(state, id),
  };

  return graphEngineFace;
}

export type GraphEngine = ReturnType<typeof createGraphEngine>;
