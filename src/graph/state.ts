/**
 * Graph 实例状态：只存**主事实**（attempt / submission / verdict / acceptance / todo /
 * integration / worktree），不存 `node.status` / `waitReason` / `currentStage` 这类派生投影
 * （design §3.2 / §10.4）。节点状态、当前节点、等待原因全部由本模块的纯函数现算。
 *
 * 一个实例一份 `state.json`，与 Flow 共用 `.dsh/ralph-flow/instances/<id>/`；原子写
 * （临时文件 + rename）与 Flow 同款。Graph 实例完成后**保留**状态（design §3.3）。
 */
import fs from "node:fs";
import path from "node:path";
import { RALPH_FLOW_DIR, type HistoryEntry } from "../engine.js";
import { pauseLabel } from "../pause.js";
import type { GraphAsset, GraphNode } from "./asset.js";
import { nodeBranchFor } from "./branches.js";

export type GraphRunStatus = "running" | "paused" | "waiting" | "interrupted" | "completed" | "failed" | "cancelled";
export type GraphNodeStatus =
  | "pending" | "blocked" | "running" | "verifying" | "reworking"
  | "waiting_review" | "waiting" | "integrating" | "accepting" | "completed" | "failed" | "cancelled" | "interrupted";

export const GRAPH_ACTIVE_STATUSES: readonly GraphRunStatus[] = ["running", "paused", "waiting", "interrupted"];

export function isGraphTerminal(status: GraphRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export interface GraphAttempt {
  id: string;
  node_id: string;
  seq: number;
  status: "running" | "submitted" | "rejected" | "failed" | "interrupted" | "cancelled";
  started_at: string;
  finished_at?: string;
  worker_id?: string;
  /** `main` 执行节点没有子会话；`session_id` 只在 background 节点出现。 */
  session_id?: string;
  artifact?: { path: string; rel?: string; sha256: string; size: number; accepted?: boolean };
  submission?: { summary?: string; at: string };
  failure?: { kind: string; message: string };
  rework_reason?: string;
  manual_rework_reason?: string;
  workspace?: { path: string; baseline?: string };
  workspace_changes?: { path: string; sha256: string; files: string[] };
  /** 崩溃恢复时标为 interrupted；重试会开新 attempt。 */
  interrupted_at?: string;
}

export interface GraphVerdict {
  node_id: string;
  attempt_id: string;
  status: "passed" | "failed" | "infra";
  reason: string;
  evidence?: Array<{ criterion: string; passed: boolean; evidence: string }>;
  agent_id?: string;
  ts: string;
  check_index: number;
  check_mode: "custom";
  check_version: string;
}

export interface GraphHumanTodo {
  id: string;
  kind: "manual_review";
  status: "waiting" | "approved" | "revise" | "cancelled" | "stale";
  node_id: string;
  attempt_id: string;
  question: string;
  artifact: { path: string; sha256: string; size: number };
  created_at: string;
  answered_at?: string;
  feedback?: string;
}

export interface GraphIntegrationAcceptance {
  node_id: string;
  attempt_id: string;
  accepted_at: string;
  artifact_sha256: string;
  check_mode: "custom" | "disabled";
  manual_approval: boolean;
  integration?: {
    branch: string;
    previous_commit: string;
    commit: string;
    base_commit: string;
  };
}

export interface GraphWorktreeRecord {
  node_id: string;
  path: string;
  branch: string;
  baseline: string;
  created_at: string;
}

export interface GraphInstanceState {
  kind: "graph";
  active: boolean;
  workflow_name: string;
  user_task: string;
  owner_session?: string;
  /** 属主运行时与心跳（见 `owner.ts`）：running 时刷新，暂停/结束不刷新。 */
  owner_runtime?: string;
  owner_heartbeat_at?: number;
  artifacts_dir_name: string;
  started_at: string;
  updated_at: string;
  graph: {
    asset: GraphAsset;
    asset_hash: string;
    asset_path?: string;
    status: GraphRunStatus;
    pause_reason?: string;
    project: { mode: "artifact" | "git"; root?: string; baseline?: string };
    /** 启动时解析的资料根（主事实；恢复后还要用它们注入路径/复制资源）。 */
    integration?: {
      branch: string;
      baseline: string;
      current_commit: string;
    };
    attempts: GraphAttempt[];
    verdicts: GraphVerdict[];
    acceptances: GraphIntegrationAcceptance[];
    human_todos: GraphHumanTodo[];
    worktrees: GraphWorktreeRecord[];
    rework_counts: Record<string, number>;
    /** 「没有把集成分支合进来」的重试计数：与 CHECK 返工分开，临近交卷的竞态很常见。 */
    integration_retries: Record<string, number>;
    fault_retries: Record<string, number>;
  };
  history: HistoryEntry[];
}

export function graphRootOf(workspace: string): string {
  return path.join(workspace, RALPH_FLOW_DIR);
}

export function graphInstancesDirOf(workspace: string): string {
  return path.join(graphRootOf(workspace), "instances");
}

export function graphReportsDirOf(workspace: string): string {
  return path.join(graphRootOf(workspace), "reports");
}

export function graphInstanceDirOf(workspace: string, instId: string): string {
  return path.join(graphInstancesDirOf(workspace), instId);
}

export function graphStatePathOf(workspace: string, instId: string): string {
  return path.join(graphInstanceDirOf(workspace, instId), "state.json");
}

export function graphArtifactsRootOf(workspace: string): string {
  return path.join(graphRootOf(workspace), "artifacts");
}

export function graphArtifactsDirOf(workspace: string, state: Pick<GraphInstanceState, "artifacts_dir_name">): string {
  return path.join(graphArtifactsRootOf(workspace), state.artifacts_dir_name);
}

export function graphNodeArtifactDirOf(workspace: string, state: Pick<GraphInstanceState, "artifacts_dir_name">, nodeId: string, attemptId: string): string {
  return path.join(graphArtifactsDirOf(workspace, state), "nodes", nodeId, attemptId);
}

export function readGraphState(workspace: string, instId: string): GraphInstanceState | null {
  try {
    const raw = fs.readFileSync(graphStatePathOf(workspace, instId), "utf-8");
    const parsed = JSON.parse(raw) as GraphInstanceState;
    if (!parsed || parsed.kind !== "graph" || !parsed.graph || !parsed.graph.asset) return null;
    // 宿主重开时宁可忽略一份损坏的保留实例，也不能让 restore/status 把 DSH 带崩。
    const graph = parsed.graph as unknown as Record<string, unknown>;
    if (!Array.isArray((graph.asset as { nodes?: unknown } | undefined)?.nodes)) return null;
    // 主事实的位置是固定的：attempt/verdict/acceptance/todo/worktree 在 graph 下，
    // history 在实例顶层。缺一个就拒绝，避免读到半份状态后让引擎在半路抛错。
    for (const key of ["attempts", "verdicts", "acceptances", "human_todos", "worktrees"] as const) {
      if (!Array.isArray(graph[key])) return null;
    }
    if (!Array.isArray(parsed.history)) return null;
    if (typeof graph.status !== "string") return null;
    // 读取时补齐旧状态缺的字段：集成分支名与节点 worktree 的 branch。
    // 两者都只补名字，历史提交仍在对象库里；恢复 attempt 时 ensureNodeWorktree 把工作树切到该分支。
    const integration = graph.integration as { branch?: string } | undefined;
    if (integration && typeof integration.branch !== "string") integration.branch = `ralphflow/${instId}`;
    const worktrees = graph.worktrees as Array<{ node_id?: unknown; branch?: unknown }>;
    for (const worktree of worktrees) {
      if (typeof worktree.node_id === "string" && typeof worktree.branch !== "string") {
        worktree.branch = nodeBranchFor(instId, worktree.node_id);
      }
    }
    const retries = graph.integration_retries;
    if (!retries || typeof retries !== "object") graph.integration_retries = {};
    if (typeof parsed.started_at !== "string" || typeof parsed.updated_at !== "string") return null;
    if (typeof (graph.asset as { id?: unknown }).id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeGraphState(workspace: string, state: GraphInstanceState, instId: string): void {
  state.updated_at = new Date().toISOString();
  const dir = graphInstanceDirOf(workspace, instId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "state.json");
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, target);
}

/** 扫描本工作区所有 Graph 实例状态（包含已结束但保留的实例）。 */
export function listGraphStates(workspace: string): Array<{ id: string; state: GraphInstanceState }> {
  const dir = graphInstancesDirOf(workspace);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: Array<{ id: string; state: GraphInstanceState }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = readGraphState(workspace, entry.name);
    if (state) out.push({ id: entry.name, state });
  }
  return out.sort((left, right) => left.state.started_at.localeCompare(right.state.started_at));
}

export function pushGraphHistory(state: GraphInstanceState, event: string, detail?: string, nodeId?: string): void {
  const entry: HistoryEntry = {
    ts: new Date().toISOString(),
    event,
    ...(detail ? { detail } : {}),
    ...(nodeId ? { step: nodeId } : {}),
  };
  state.history.push(entry);
  if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
}

export function attemptsOfNode(state: GraphInstanceState, nodeId: string): GraphAttempt[] {
  return state.graph.attempts.filter((attempt) => attempt.node_id === nodeId).sort((left, right) => left.seq - right.seq);
}

export function latestAttemptOfNode(state: GraphInstanceState, nodeId: string): GraphAttempt | undefined {
  return attemptsOfNode(state, nodeId).at(-1);
}

export function verdictOfAttempt(state: GraphInstanceState, attemptId: string): GraphVerdict | undefined {
  return state.graph.verdicts.filter((verdict) => verdict.attempt_id === attemptId).at(-1);
}

export function acceptanceOfNode(state: GraphInstanceState, nodeId: string): GraphIntegrationAcceptance | undefined {
  return state.graph.acceptances.filter((acceptance) => acceptance.node_id === nodeId).at(-1);
}

export function waitingTodoOfNode(state: GraphInstanceState, nodeId: string): GraphHumanTodo | undefined {
  return state.graph.human_todos.find((todo) => todo.node_id === nodeId && todo.status === "waiting");
}

/** 节点是否已经释放下游（Flow 的「完成」等价物；Git 还要完成合入接纳）。 */
export function nodeReleased(state: GraphInstanceState, node: GraphNode): boolean {
  const acceptance = acceptanceOfNode(state, node.id);
  if (!acceptance) return false;
  return !state.graph.project.root || node.execution === "main" || Boolean(acceptance.integration);
}

/**
 * 派生节点状态。**纯函数**：不读写状态、不推进，只把主事实翻译成投影。
 * 顺序即语义：已接纳 > 已取消 > 等待人工 > 在飞 > 已交卷待验证/合入 > 待重做/失败 > 依赖阻塞 > 待开始。
 */
export function nodeStatusOf(state: GraphInstanceState, node: GraphNode): GraphNodeStatus {
  if (acceptanceOfNode(state, node.id)) return "completed";
  if (state.graph.status === "cancelled") return "cancelled";
  const attempt = latestAttemptOfNode(state, node.id);
  const todo = waitingTodoOfNode(state, node.id);
  if (todo) return "waiting_review";
  if (attempt?.status === "running") return "running";
  if (attempt?.status === "interrupted") return "interrupted";
  if (attempt?.status === "failed") return "failed";
  if (attempt?.status === "submitted") {
    if (node.check && !verdictOfAttempt(state, attempt.id)) return "verifying";
    if (node.check && verdictOfAttempt(state, attempt.id)?.status === "failed") {
      const count = state.graph.rework_counts[node.id] ?? 0;
      return count >= 2 ? "waiting" : "reworking";
    }
    if (node.check && verdictOfAttempt(state, attempt.id)?.status === "infra") return "waiting";
    return "integrating";
    return "accepting";
  }
  if (attempt?.status === "rejected") return "reworking";
  const pending = state.graph.asset.nodes.filter((candidate) => candidate.id !== node.id);
  const blocked = node.dependsOn.some((dependency) => {
    const source = pending.find((candidate) => candidate.id === dependency);
    return source ? !nodeReleased(state, source) : true;
  });
  return blocked ? "blocked" : "pending";
}

export const NODE_STATUS_LABELS: Record<GraphNodeStatus, string> = {
  pending: "待开始",
  blocked: "等待依赖",
  running: "执行中",
  verifying: "验证中",
  reworking: "等待返工",
  waiting_review: "等待你放行",
  waiting: "等待处理",
  integrating: "合入中",
  accepting: "接纳中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export interface GraphNodeProjection {
  id: string;
  name: string;
  status: GraphNodeStatus;
  label: string;
  dependsOn: string[];
  attempts: number;
  artifact: { path: string; sha256: string; size: number } | null;
  check: { mode: "custom" | "disabled"; status: "passed" | "failed" | "infra" | "pending" | "skipped"; reason: string; reworks: number };
  manual: "pending" | "waiting" | "approved" | "revise" | "not_required" | "stale" | "cancelled";
  integration: "accepted" | "pending" | "not_required";
  integrationCommit: string | null;
  workspace: string | null;
  todoId: string | null;
  current: boolean;
  execution: "background" | "main";
}

export interface GraphRunProjection {
  kind: "graph";
  id: string;
  workflow: string;
  task: string;
  status: GraphRunStatus;
  phase: string;
  counts: { total: number; completed: number; running: number; waiting: number; pending: number; blocked: number };
  current: { nodeId: string; name: string; status: GraphNodeStatus } | null;
  nextAction: null | { kind: "answer" | "manual_review" | "resume" | "wait"; label: string; message: string; todoId?: string; nodeId?: string };
  nodes: GraphNodeProjection[];
  integration: { branch: string; currentCommit: string; accepted: number } | null;
  delivery: { success: boolean; outcome: string; delivered: number; unaccepted: number; unverified: number; unfinished: number; reason?: string };
  startedAt: string;
  updatedAt: string;
  report: string | null;
}

export function nodeNameOf(state: GraphInstanceState, node: GraphNode): string {
  return node.name ?? node.id;
}

function manualStatusOf(state: GraphInstanceState, node: GraphNode): GraphNodeProjection["manual"] {
  if (!state.graph.asset.manual_step.includes(node.id)) return "not_required";
  const todos = state.graph.human_todos.filter((todo) => todo.node_id === node.id);
  const latest = todos.at(-1);
  if (!latest) return "pending";
  if (latest.status === "approved") return "approved";
  if (latest.status === "revise") return "revise";
  if (latest.status === "stale") return "stale";
  if (latest.status === "cancelled") return "cancelled";
  return "waiting";
}

function checkProjection(state: GraphInstanceState, node: GraphNode): GraphNodeProjection["check"] {
  const attempt = latestAttemptOfNode(state, node.id);
  const verdict = attempt ? verdictOfAttempt(state, attempt.id) : undefined;
  const mode = node.check ? node.check.mode : "disabled";
  if (!node.check) return { mode, status: "skipped", reason: "本节点显式关闭独立 CHECK（check: null）。", reworks: state.graph.rework_counts[node.id] ?? 0 };
  if (!verdict) return { mode, status: "pending", reason: "", reworks: state.graph.rework_counts[node.id] ?? 0 };
  return { mode, status: verdict.status, reason: verdict.reason, reworks: state.graph.rework_counts[node.id] ?? 0 };
}

export function projectionOf(state: GraphInstanceState, id: string): GraphRunProjection {
  const nodes = state.graph.asset.nodes.map((node): GraphNodeProjection => {
    const status = nodeStatusOf(state, node);
    const attempt = latestAttemptOfNode(state, node.id);
    const todo = waitingTodoOfNode(state, node.id);
    const check = checkProjection(state, node);
    const acceptance = acceptanceOfNode(state, node.id);
    return {
      id: node.id,
      name: nodeNameOf(state, node),
      status,
      label: NODE_STATUS_LABELS[status],
      dependsOn: [...node.dependsOn],
      attempts: attemptsOfNode(state, node.id).length,
      artifact: attempt?.artifact
        ? { path: attempt.artifact.rel ?? attempt.artifact.path, sha256: attempt.artifact.sha256, size: attempt.artifact.size }
        : null,
      check,
      manual: manualStatusOf(state, node),
      integration: !state.graph.project.root ? "not_required" : acceptance?.integration ? "accepted" : "pending",
      integrationCommit: acceptance?.integration?.commit ?? null,
      workspace: attempt?.workspace?.path ?? null,
      todoId: todo?.id ?? null,
      current: false,
      execution: node.execution,
    };
  });
  const counts = {
    total: nodes.length,
    completed: nodes.filter((node) => node.status === "completed").length,
    running: nodes.filter((node) => node.status === "running" || node.status === "verifying" || node.status === "integrating" || node.status === "accepting").length,
    waiting: nodes.filter((node) => node.status === "waiting" || node.status === "waiting_review" || node.status === "reworking").length,
    pending: nodes.filter((node) => node.status === "pending").length,
    blocked: nodes.filter((node) => node.status === "blocked").length,
  };
  const currentNode = nodes.find((node) => node.status === "running" || node.status === "verifying" || node.status === "integrating" || node.status === "accepting")
    ?? nodes.find((node) => node.status === "waiting_review" || node.status === "waiting")
    ?? nodes.find((node) => node.status === "pending" || node.status === "blocked")
    ?? null;
  if (currentNode) currentNode.current = true;

  const waitingTodo = state.graph.human_todos.find((todo) => todo.status === "waiting");
  const nodeWithRework = nodes.find((node) => node.status === "waiting" && (state.graph.rework_counts[node.id] ?? 0) >= 2);
  const nextAction: GraphRunProjection["nextAction"] = waitingTodo
    ? {
      kind: "manual_review",
      label: "等待你放行",
      message: `节点「${nodeNameOf(state, state.graph.asset.nodes.find((node) => node.id === waitingTodo.node_id)!)}」已通过独立 CHECK，等待你审查产物后明确放行或要求改稿。`,
      todoId: waitingTodo.id,
      nodeId: waitingTodo.node_id,
    }
    : state.graph.status === "paused" || state.graph.status === "interrupted" || state.graph.status === "waiting"
      ? {
        kind: "resume",
        label: "等待你继续",
        message: nodeWithRework
          ? "独立 CHECK 的返工次数已达到上限；检查资产或产物后用 /ralphflow-continue 显式重试。"
          : state.graph.status === "interrupted"
            ? "运行已中断（属主运行时已失联），用 /ralphflow-continue 继续。"
            : state.graph.status === "waiting"
              ? "运行在等待人工处理，用 ralphflow_respond 或 /ralphflow-continue 继续。"
              : `运行已暂停（${pauseLabel(state.graph.pause_reason ?? "paused")}），用 /ralphflow-continue 继续。`,
        ...(currentNode ? { nodeId: currentNode.id } : {}),
      }
      : null;

  const delivered = nodes.filter((node) => node.status === "completed").length;
  const unaccepted = state.graph.attempts.filter((attempt) => attempt.artifact && !attempt.artifact.accepted).length;
  const unverified = state.graph.attempts.filter((attempt) => {
    const node = state.graph.asset.nodes.find((candidate) => candidate.id === attempt.node_id);
    if (!node?.check || attempt.status !== "submitted") return false;
    return !verdictOfAttempt(state, attempt.id);
  }).length;
  const unfinished = nodes.length - delivered;
  const success = state.graph.status === "completed" && unfinished === 0;
  const outcome = success ? "completed"
    : state.graph.status === "completed" ? "incomplete"
      : state.graph.status;
  const phase = success ? "已完成"
    : state.graph.status === "cancelled" ? "已取消"
      : state.graph.status === "interrupted" ? "已中断"
        : state.graph.status === "failed" ? "失败"
          : state.graph.status === "paused" ? "已暂停"
            : waitingTodo ? "等待你放行"
              : counts.running > 0 ? "执行中"
                : state.graph.status === "waiting" ? "等待处理" : "执行中";

  return {
    kind: "graph",
    id,
    workflow: state.workflow_name,
    task: state.user_task,
    status: state.graph.status,
    phase,
    counts,
    current: currentNode ? { nodeId: currentNode.id, name: currentNode.name, status: currentNode.status } : null,
    nextAction,
    nodes,
    integration: state.graph.integration
      ? {
        branch: state.graph.integration.branch,
        currentCommit: state.graph.integration.current_commit,
        accepted: state.graph.acceptances.filter((acceptance) => acceptance.integration).length,
      }
      : null,
    delivery: {
      success,
      outcome,
      delivered,
      unaccepted,
      unverified,
      unfinished,
      ...(success ? {} : { reason: nextAction?.message ?? `运行状态：${state.graph.status}` }),
    },
    startedAt: state.started_at,
    updatedAt: state.updated_at,
    report: isGraphTerminal(state.graph.status) ? `${RALPH_FLOW_DIR}/reports/${id}.md` : null,
  };
}

/** 运行输入与提示词共用的安全路径：只接受相对路径，拒绝逃出工作区。 */
export function resolveInside(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return resolved;
}
