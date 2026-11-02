/**
 * 门面：**按资产的 `kind` 路由**到 Flow 顺序引擎或 Graph DAG 引擎。
 *
 * 门面不是第三个引擎（design §4.1）：它只做资产路由、生命周期编排、状态投影和工具转发；
 * 每个实例只有一个写入者——Flow 实例由 `createEngine` 写，Graph 实例由 `createGraphEngine` 写。
 * Flow 分支的每一步都委托给原引擎，保证既有行为逐字不变。
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  RALPH_FLOW_DIR,
  builtinWorkflowPath,
  createEngine,
  globalWorkflowsDirOf,
  type EnginePorts,
  type HistoryInfo,
  type InstanceInfo,
  type InstanceState,
  type ToolResult,
  type WorkflowEntry,
} from "./engine.js";
import { createGraphEngine, type GraphEngine } from "./graph/engine.js";
import {
  builtinGraphPath,
  classifyYamlDocument,
  graphGlobalDir,
  graphWorkspaceDir,
  loadGraphWorkflow,
  type GraphWorkflowEntry,
} from "./graph/assets.js";
import { validateGraphAsset } from "./graph/asset.js";
import { checkDefinition, checkVersion } from "./graph/check.js";
import {
  isGraphTerminal,
  listGraphStates,
  projectionOf,
  readGraphState,
  type GraphInstanceState,
  type GraphRunProjection,
} from "./graph/state.js";
import { findAssetByName, mergeAssets, type UnifiedAssetEntry } from "./assets.js";
import { FLOW_ENTRY_FILE, GRAPH_ENTRY_FILE, assetEntryAt, assetFileIn } from "./asset-path.js";
import type { ViewerAsset, WorkflowStatus } from "./status-contract.js";

export interface FacadeOptions {
  ctx: Context;
  ports: EnginePorts;
}

function flowFileExists(workspace: string, name: string): boolean {
  const dirs = [path.join(workspace, RALPH_FLOW_DIR, "workflows"), globalWorkflowsDirOf()];
  return dirs.some((dir) => assetFileIn(dir, name, FLOW_ENTRY_FILE)) || Boolean(builtinWorkflowPath(name));
}

function graphFileExists(workspace: string, name: string): boolean {
  const dirs = [graphWorkspaceDir(workspace), graphGlobalDir()];
  return dirs.some((dir) => assetFileIn(dir, name, GRAPH_ENTRY_FILE)) || Boolean(builtinGraphPath(name));
}

export type AssetKind = "flow" | "graph";

export function createFacade(workspace: string, options: FacadeOptions) {
  // 回合收尾检查的观察值：本会话最近一次工具调用的时间。两个引擎共用同一份，
  // 因为同一个主会话同一时刻只可能跑一种实例；值只在进程内，不落盘。
  const actionTimes = new Map<string, number>();
  const ports: EnginePorts = {
    ...options.ports,
    lastActionAt: (sessionId: string) => actionTimes.get(sessionId),
    // 引擎侧的补记（带未完成项的进度记录 = 一次实质交卷）：与宿主的 `tool/call` 观察值
    // 共用同一个格子，判定口径只有一份。
    noteAction,
  };
  const flow = createEngine(workspace, ports);
  const graph: GraphEngine = createGraphEngine({ ctx: options.ctx, ports, workspace });

  /** 宿主每发生一次 `tool/call` 就报一次（引擎自己也补记进度记录）；只记时间戳，不判断是谁的工具。 */
  function noteAction(sessionId: string, time: number): void {
    actionTimes.set(sessionId, time);
  }

  function ensureLayout(): void {
    flow.ensureLayout();
    graph.ensureLayout();
  }

  function assetKindOf(name: string): { kind: AssetKind } | { error: string } {
    const flowExists = flowFileExists(workspace, name);
    const graphExists = graphFileExists(workspace, name);
    if (flowExists && graphExists) {
      return {
        error: `名字 \`${name}\` 同时出现在 workflows/ 与 graphs/：跨类别同名是冲突。请重命名其中一个资产，再用唯一名字启动。`,
      };
    }
    if (graphExists) return { kind: "graph" };
    if (flowExists) return { kind: "flow" };
    const assets = listAssets().filter((asset) => asset.name === name);
    if (assets.length === 1) return { kind: assets[0]!.kind };
    return {
      error: `未找到工作流 \`${name}\`。Flow 资产放 \`${path.join(workspace, RALPH_FLOW_DIR, "workflows")}/<name>/workflow.yaml\`，Graph 资产放 \`${path.join(workspace, RALPH_FLOW_DIR, "graphs")}/<name>/graph.yaml\`。`,
    };
  }

  function listAssets(): UnifiedAssetEntry[] {
    return mergeAssets(flow.listWorkflows(), graph.listWorkflows());
  }

  function kindOfInstance(instanceRef: string): AssetKind | undefined {
    const graphState = findGraphState(instanceRef);
    if (graphState) return "graph";
    const flowState = findFlowInstance(instanceRef);
    if (flowState) return "flow";
    return undefined;
  }

  function findGraphState(instanceRef: string): { id: string; state: GraphInstanceState } | undefined {
    const all = listGraphStates(workspace);
    const exact = all.find((entry) => entry.id === instanceRef);
    if (exact) return exact;
    const prefixed = all.filter((entry) => entry.id.startsWith(instanceRef));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  function findFlowInstance(instanceRef: string): InstanceInfo | undefined {
    const active = flow.listInstances();
    const exact = active.find((entry) => entry.id === instanceRef);
    if (exact) return exact;
    const prefixed = active.filter((entry) => entry.id.startsWith(instanceRef));
    if (prefixed.length === 1) return prefixed[0];
    const history = flow.listHistory().filter((entry) => entry.id === instanceRef || entry.id.startsWith(instanceRef));
    if (history.length === 1) return { id: history[0]!.id, state: { active: false } as InstanceState };
    return undefined;
  }

  function activeKindsOfSession(sessionId: string): { flow?: string; graph?: string } {
    return {
      flow: flow.listInstances().find((entry) => entry.state.owner_session === sessionId && entry.state.active)?.id,
      graph: graph.activeInstanceOfSession(sessionId)?.id,
    };
  }

  async function start(
    workflowName: string,
    task: string,
    sessionId: string,
  ): Promise<ToolResult> {
    const active = activeKindsOfSession(sessionId);
    if (active.flow || active.graph) {
      const id = active.graph ?? active.flow!;
      return { ok: false, text: `当前会话已有活跃实例 \`${id}\`（${active.graph ? "Graph" : "Flow"}）。用 \`/ralphflow-continue\` 继续，或 \`/ralphflow-cancel\` 取消。` };
    }
    const kind = assetKindOf(workflowName.trim());
    if ("error" in kind) return { ok: false, text: kind.error };
    if (kind.kind === "graph") {
      ensureLayout();
      return graph.start(workflowName, task, sessionId);
    }
    return flow.start(workflowName, task, sessionId);
  }

  async function onSubmit(agent: Agent | undefined, summary?: string, unfinished?: string[]): Promise<ToolResult> {
    const sessionId = (agent as { session?: { id?: string } } | undefined)?.session?.id;
    if (!sessionId) return { ok: false, text: "找不到当前会话，无法交卷。" };
    const graphSubmission = await graph.submitFromAgent(agent, summary, unfinished);
    if (graphSubmission) return graphSubmission;
    return flow.onSubmit(sessionId, summary, unfinished);
  }

  async function continueInstance(sessionId: string, instanceRef?: string): Promise<ToolResult> {
    graph.syncSession(sessionId);
    if (instanceRef) {
      const graphState = findGraphState(instanceRef);
      if (graphState) return graph.continueInstance(sessionId, graphState.id);
      return flow.continueInstance(sessionId, instanceRef);
    }
    const active = activeKindsOfSession(sessionId);
    if (active.flow && active.graph) {
      return { ok: false, text: `当前会话同时有 Flow 与 Graph 实例（\`${active.flow}\` / \`${active.graph}\`）。请显式给实例 ID。` };
    }
    if (active.graph) return graph.continueInstance(sessionId, active.graph);
    return flow.continueInstance(sessionId);
  }

  async function cancelInstance(sessionId: string, instanceRef?: string, reason?: string): Promise<ToolResult> {
    if (instanceRef) {
      const graphState = findGraphState(instanceRef);
      if (graphState) return graph.cancelInstance(sessionId, graphState.id, reason);
      return flow.cancelInstance(sessionId, instanceRef, reason);
    }
    const active = activeKindsOfSession(sessionId);
    if (active.flow && active.graph) {
      return { ok: false, text: `当前会话同时有 Flow 与 Graph 实例（\`${active.flow}\` / \`${active.graph}\`）。请显式给实例 ID。` };
    }
    if (active.graph) return graph.cancelInstance(sessionId, active.graph, reason);
    return flow.cancelInstance(sessionId, instanceRef, reason);
  }

  /**
   * 停止按钮 = 暂停：宿主把当前回合 cancel 成 `aborted/user` 后调用。
   * Flow 与 Graph 走同一个入口；不在 DO 阶段的实例原样不动（停止回合不打断验证/审查门）。
   */
  function pauseForUserStop(sessionId: string): ToolResult {
    const active = activeKindsOfSession(sessionId);
    const results: ToolResult[] = [];
    if (active.graph) results.push(graph.pauseForUserStop(sessionId));
    if (active.flow) results.push(flow.pauseForUserStop(sessionId));
    return results.find((result) => result.ok) ?? results[0] ?? { ok: false, text: "当前会话没有可暂停的活跃实例。" };
  }

  async function cleanupInstance(instanceRef?: string): Promise<ToolResult> {
    return graph.cleanupInstance(instanceRef);
  }

  function respond(agent: Agent | undefined, text: string, todoId?: string): string {
    return graph.respond(agent, text, todoId);
  }

  function statusOf(sessionId: string, instanceRef?: string): ToolResult {
    graph.syncSession(sessionId);
    if (instanceRef) {
      const graphState = findGraphState(instanceRef);
      if (graphState) return graph.statusOf(sessionId, graphState.id);
      return flow.statusOf(sessionId, instanceRef);
    }
    const active = activeKindsOfSession(sessionId);
    if (active.graph) return graph.statusOf(sessionId, active.graph);
    if (active.flow) return flow.statusOf(sessionId, active.flow);
    const graphResult = graph.statusOf(sessionId);
    if (graphResult.ok) return graphResult;
    return flow.statusOf(sessionId);
  }

  function listAll(): ToolResult {
    const assets = listAssets();
    const table = [
      "## 可用工作流",
      "",
      "| 名字 | 类别 | 步骤/节点 | 说明 |",
      "|---|---|---|---|",
      ...assets.map((asset) => `| ${asset.invalid ? "❌ " : ""}\`${asset.name}\` | ${asset.kind === "graph" ? "Graph" : "Flow"} | ${asset.count} | ${(asset.desc || "（无描述）").replaceAll("|", "\\|")} |`),
      ...(assets.some((asset) => asset.conflict) ? ["", "⚠️ 跨类别同名冲突：同名资产不能启动，请先改名。"] : []),
      "",
    ].join("\n");
    const flowText = flow.listAll().text;
    const activeIndex = flowText.indexOf("## 活跃实例");
    const flowTail = activeIndex >= 0 ? flowText.slice(activeIndex) : "";
    const graphText = graph.listAll().text;
    const graphInstancesIndex = graphText.indexOf("## Graph 实例");
    const graphTail = graphInstancesIndex >= 0 ? graphText.slice(graphInstancesIndex) : "";
    return { ok: true, text: [flowTail, "", table, "", graphTail].join("\n") };
  }

  function diagnose(target?: string): ToolResult {
    if (target && target.trim()) return diagnoseTarget(target.trim());
    const assets = listAssets();
    const conflicts = assets.filter((asset) => asset.conflict);
    const conflictLines = conflicts.length > 0
      ? ["## 跨类别同名冲突", "", ...conflicts.map((asset) => `- ❌ \`${asset.name}\`：同时出现在 workflows/ 与 graphs/；必须改名。`), ""]
      : [];
    const flowText = flow.diagnose().text;
    const graphText = graph.diagnose().text;
    return { ok: true, text: [...conflictLines, flowText, "", graphText].join("\n") };
  }

  function checksOfAsset(asset: { nodes: Array<{ id: string; check: unknown }> }): string[] {
    const lines: string[] = [];
    for (const node of asset.nodes) {
      const criteria = node.check && typeof node.check === "object" && "criteria" in node.check
        ? String((node.check as { criteria?: unknown }).criteria ?? "")
        : null;
      const definition = checkDefinition(criteria);
      lines.push(`  - \`${node.id}\`：CHECK ${definition.mode}${definition.mode === "disabled" ? "" : `（${checkVersion(definition)}）`}`);
      if (definition.mode !== "disabled") {
        for (const criterion of definition.criteria) lines.push(`    - ${criterion}`);
      }
    }
    return lines;
  }

  function diagnoseTarget(target: string): ToolResult {
    // 1) 路径：工作区相对/绝对均可；入口文件或资产目录。
    const absolute = path.isAbsolute(target) ? target : path.resolve(workspace, target);
    const entry = assetEntryAt(absolute);
    if (!entry) {
      let isDirectory = false;
      try { isDirectory = fs.statSync(absolute).isDirectory(); } catch {}
      if (isDirectory) {
        return { ok: false, text: `❌ \`${target}\` 里没有 \`workflow.yaml\` 或 \`graph.yaml\`：资产是目录加固定入口（\`workflows/<名字>/workflow.yaml\`、\`graphs/<名字>/graph.yaml\`）。` };
      }
    }
    if (entry) {
      const { file, name } = entry;
      let doc: unknown;
      try { doc = yaml.load(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "")); } catch (error) {
        return { ok: false, text: `❌ \`${target}\` 读取失败：${error instanceof Error ? error.message : String(error)}` };
      }
      const classified = classifyYamlDocument(doc);
      if (classified.kind === "graph") {
        const identity = doc && typeof doc === "object" && !Array.isArray(doc)
          ? { ...(doc as Record<string, unknown>), id: (doc as Record<string, unknown>).id ?? name, name: (doc as Record<string, unknown>).name ?? name }
          : doc;
        const validation = validateGraphAsset(identity);
        const inGraphs = path.resolve(file).startsWith(path.resolve(graphWorkspaceDir(workspace)) + path.sep)
          || path.resolve(file) === path.resolve(builtinGraphPath(name) ?? "")
          || path.resolve(file).startsWith(path.resolve(graphGlobalDir()) + path.sep);
        const valid = validation.asset !== null && inGraphs;
        const lines = [
          `## Graph 资产诊断：\`${target}\``,
          "",
          `- 类别：Graph`,
          `- 路径：\`${file}\``,
          `- 名字：\`${name}\``,
          ...(inGraphs ? [] : ["- ❌ 文件不在 graphs/ 目录：Graph 资产只放 `.dsh/ralph-flow/graphs/`。"]),
          "",
          ...(validation.asset
            ? [inGraphs ? "- ✅ 定义有效" : "- ❌ 定义有效但位置错误"]
            : ["- ❌ 定义无效", ...validation.errors.map((error) => `  - ${error.path || "/"}：${error.message}`)]),
          ...(validation.warnings.length ? ["", "### 告警", ...validation.warnings.map((warning) => `- ⚠️ ${warning}`)] : []),
          ...(validation.asset ? ["", "### 有效 CHECK", ...checksOfAsset(validation.asset)] : []),
          "",
          "结论：所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅。",
        ];
        return { ok: valid, text: lines.join("\n") };
      }
      if (classified.kind === "flow") {
        const loaded = flow.loadWorkflow(name);
        const valid = !!loaded.def && !loaded.problems.length;
        const lines = [
          `## Flow 资产诊断：\`${target}\``,
          "",
          `- 类别：Flow`,
          `- 路径：\`${file}\``,
          `- 名字：\`${name}\``,
          "",
          ...(valid ? ["- ✅ 定义有效"] : ["- ❌ 定义无效", ...loaded.problems.map((problem) => `  - ${problem}`)]),
          ...(loaded.warnings.length ? ["", "### 告警", ...loaded.warnings.map((warning) => `- ⚠️ ${warning}`)] : []),
          "",
          "结论：所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅。",
        ];
        return { ok: valid, text: lines.join("\n") };
      }
      return { ok: false, text: `❌ \`${target}\` 无法判断资产类别：\n${classified.problems.map((problem) => `- ${problem}`).join("\n")}` };
    }

    // 2) 工作流名：先查 Graph 目录，再查 Flow。
    const graphLoaded = loadGraphWorkflow(workspace, target);
    if (graphLoaded.def || graphLoaded.path) {
      const valid = !!graphLoaded.def && graphLoaded.problems.length === 0;
      const lines = [
        `## Graph 资产诊断：\`${target}\``,
        "",
        `- 类别：Graph`,
        ...(graphLoaded.path ? [`- 路径：\`${graphLoaded.path}\``] : []),
        "",
        ...(valid ? ["- ✅ 定义有效"] : ["- ❌ 定义无效", ...graphLoaded.problems.map((problem) => `  - ${problem}`)]),
        ...(graphLoaded.warnings.length ? ["", "### 告警", ...graphLoaded.warnings.map((warning) => `- ⚠️ ${warning}`)] : []),
        ...(graphLoaded.def ? ["", "### 有效 CHECK", ...checksOfAsset(graphLoaded.def)] : []),
        "",
        "结论：所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅。",
      ];
      return { ok: valid, text: lines.join("\n") };
    }
    const loaded = flow.loadWorkflow(target);
    const valid = !!loaded.def && loaded.problems.length === 0;
    const lines = [
      `## Flow 资产诊断：\`${target}\``,
      "",
      `- 类别：Flow`,
      "",
      ...(valid ? ["- ✅ 定义有效"] : ["- ❌ 定义无效", ...loaded.problems.map((problem) => `  - ${problem}`)]),
      ...(loaded.warnings.length ? ["", "### 告警", ...loaded.warnings.map((warning) => `- ⚠️ ${warning}`)] : []),
      "",
      "结论：所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅。",
    ];
    return { ok: valid, text: lines.join("\n") };
  }

  function restore(): void {
    flow.restore();
    graph.restore();
  }

  function remindToSubmit(sessionId: string): { remind: boolean; message?: string; summary?: string } {
    const flowVerdict = flow.remindToSubmit(sessionId);
    if (flowVerdict.remind || flowVerdict.message) return flowVerdict;
    return graph.remindToSubmit(sessionId);
  }

  function activeInstanceOfSession(sessionId: string): { id: string; kind: AssetKind } | undefined {
    const active = activeKindsOfSession(sessionId);
    if (active.graph) return { id: active.graph, kind: "graph" };
    if (active.flow) return { id: active.flow, kind: "flow" };
    return undefined;
  }

  let catalogCache: { at: number; value: ViewerAsset[] } | null = null;

  /** 只读查看器目录：Flow 步骤链 + Graph DAG（含 DO/CHECK/依赖）。 */
  function viewerCatalog(): ViewerAsset[] {
    if (catalogCache && Date.now() - catalogCache.at < 5000) return catalogCache.value;
    try {
      const assets = buildViewerCatalog();
      catalogCache = { at: Date.now(), value: assets };
      return assets;
    } catch {
      // 只读面绝不能因为某个坏资产/权限错误把宿主状态流打断：空目录比崩溃好。
      return [];
    }
  }

  function buildViewerCatalog(): ViewerAsset[] {
    const assets: ViewerAsset[] = [];
    for (const entry of flow.listWorkflows()) {
      const loaded = flow.loadWorkflow(entry.name);
      const manual = new Set(loaded.def?.manual_step ?? []);
      assets.push({
        name: entry.name,
        kind: "flow",
        description: entry.desc,
        invalid: entry.invalid,
        problems: entry.problems,
        steps: (loaded.def?.steps ?? []).map((step) => ({
          id: step.id,
          description: step.desc ?? "",
          do: step.do ?? "",
          checks: step.check ? [step.check] : (step.check_voting ?? []).map((voter) => voter.check),
          input: step.input ?? "",
          output: step.output ?? "",
          onPass: step.on_pass ?? "",
          onFail: step.on_fail ?? "",
          manual: manual.has(step.id),
        })),
        nodes: [],
      });
    }
    for (const entry of graph.listWorkflows()) {
      const loaded = loadGraphWorkflow(workspace, entry.name);
      const manual = new Set(loaded.def?.manual_step ?? []);
      assets.push({
        name: entry.name,
        kind: "graph",
        description: entry.desc,
        invalid: entry.invalid,
        problems: entry.problems,
        steps: [],
        nodes: (loaded.def?.nodes ?? []).map((node) => ({
          id: node.id,
          name: node.name ?? node.id,
          do: node.do,
          artifact: node.artifact,
          dependsOn: [...node.dependsOn],
          inputs: node.inputs.map((input) => ({ fromNode: input.fromNode, artifact: input.artifact })),
          execution: node.execution,
          check: node.check ? node.check.criteria : "（已关闭 CHECK）",
          checkMode: node.check ? "custom" : "disabled",
          manual: manual.has(node.id),
        })),
      });
    }
    return assets;
  }

  function graphProjectionToStatus(projection: GraphRunProjection, history: GraphInstanceState["history"]): WorkflowStatus {
    const stage: WorkflowStatus["stage"] = projection.status === "completed" ? "done"
      : projection.status === "cancelled" ? "cancelled"
        : projection.status === "failed" ? "failed"
          : projection.status === "paused" || projection.status === "interrupted" ? "paused"
            : projection.nextAction?.kind === "manual_review" ? "gate"
              : projection.counts.running > 0 ? "executing" : "switching";
    return {
      id: projection.id,
      kind: "graph",
      workflow: projection.workflow,
      task: projection.task.slice(0, 2000),
      step: "",
      stage,
      hint: projection.nextAction?.message ?? projection.phase,
      failures: 0,
      maxFailures: 0,
      updatedAt: projection.updatedAt,
      report: projection.report,
      steps: [],
      votes: [],
      recent: history.slice(-5).map((entry) => ({ step: entry.step ?? "", event: entry.event, detail: entry.detail ?? "" })),
      graph: {
        phase: projection.phase,
        status: projection.status,
        counts: projection.counts,
        current: projection.current,
        nextAction: projection.nextAction,
        nodes: projection.nodes.map((node) => ({
          id: node.id,
          name: node.name,
          status: node.status,
          label: node.label,
          dependsOn: node.dependsOn,
          attempts: node.attempts,
          current: node.current,
          execution: node.execution,
          artifact: node.artifact ? { path: node.artifact.path, sha256: node.artifact.sha256 } : null,
          check: node.check,
          manual: node.manual,
          integration: node.integration,
          integrationCommit: node.integrationCommit,
          todoId: node.todoId,
        })),
        integration: projection.integration,
        delivery: projection.delivery,
      },
    };
  }

  function uiStatus(sessionId: string): { status: WorkflowStatus | null; error: string | null } {
    const flowStatus = flow.uiStatus(sessionId);
    const graphStatus = graph.uiStatus(sessionId);
    const graphChosen = graphStatus.projection;
    if (!graphChosen) return flowStatus;
    const graphState = readGraphState(workspace, graphChosen.id);
    const graphView = graphProjectionToStatus(graphChosen, graphState?.history ?? []);
    if (!flowStatus.status) return { status: graphView, error: graphStatus.error ?? flowStatus.error };
    const flowIsActive = flowStatus.status.stage !== "done" && flowStatus.status.stage !== "cancelled" && flowStatus.status.stage !== "failed";
    const graphIsActive = !isGraphTerminal(graphChosen.status);
    if (flowIsActive !== graphIsActive) return flowIsActive ? flowStatus : { status: graphView, error: graphStatus.error };
    const flowTime = Date.parse(flowStatus.status.updatedAt) || 0;
    const graphTime = Date.parse(graphChosen.updatedAt) || 0;
    return graphTime > flowTime ? { status: graphView, error: graphStatus.error } : flowStatus;
  }

  function uiReport(ref: Parameters<typeof flow.uiReport>[0]): WorkflowStatus | null {
    return flow.uiReport(ref);
  }

  async function submitFromAny(agent: Agent | undefined, summary?: string, unfinished?: string[]): Promise<ToolResult> {
    return onSubmit(agent, summary, unfinished);
  }

  return {
    kind: "facade" as const,
    projectDir: workspace,
    root: flow.root,
    instancesDir: flow.instancesDir,
    workflowsDir: flow.workflowsDir,
    reportsDir: flow.reportsDir,
    graphsDir: graph.graphsDir,
    // Flow-compatible surface
    ensureLayout,
    listWorkflows: (): WorkflowEntry[] => flow.listWorkflows(),
    loadWorkflow: flow.loadWorkflow,
    readState: flow.readState,
    listInstances: (): InstanceInfo[] => flow.listInstances(),
    listHistory: (): HistoryInfo[] => flow.listHistory(),
    instanceDir: flow.instanceDir,
    artifactsDirOf: flow.artifactsDirOf,
    artifactsRelDirOf: flow.artifactsRelDirOf,
    reportRelPathOf: flow.reportRelPathOf,
    destroyInstance: flow.destroyInstance,
    // facade lifecycle
    start,
    onSubmit,
    submitFromAny,
    noteAssistantText: flow.noteAssistantText,
    noteAction,
    remindToSubmit,
    continueInstance,
    resetCurrent: flow.resetCurrent,
    rewindTo: flow.rewindTo,
    cancelInstance,
    pauseForUserStop,
    cleanupInstance,
    respond,
    statusOf,
    listAll,
    restore,
    diagnose,
    activeInstanceOfSession,
    activeKindsOfSession,
    kindOfInstance,
    listAssets,
    viewerCatalog,
    uiStatus,
    uiReport,
    // Graph-only surfaces used by the status service / tests
    graph,
    flow,
    findGraphState,
  };
}

export type Facade = ReturnType<typeof createFacade>;
