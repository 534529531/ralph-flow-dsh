import type { InvocationDescriptor, RemoteStream, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

export type WorkflowStage = "executing" | "verifying" | "gate" | "paused" | "switching" | "done" | "cancelled" | "failed" | "unavailable";
export interface WorkflowStatus {
  id: string;
  /** 资产类别；缺省按 flow 读（滚动升级兼容）。 */
  kind: "flow" | "graph";
  workflow: string;
  task: string;
  step: string;
  stage: WorkflowStage;
  hint: string;
  failures: number;
  maxFailures: number;
  updatedAt: string;
  report: string | null;
  steps: Array<{ id: string; description: string; current: boolean; failures: number }>;
  votes: Array<{ index: number; status: "pending" | "running" | "passed" | "failed" | "infra"; reason: string; check?: string }>;
  recent: Array<{ step: string; event: string; detail: string }>;
  /** Graph 专属投影；Flow 状态下不存在。字段只承载派生结果，不是第二个事实源。 */
  graph?: GraphStatusView;
}

export interface GraphStatusNode {
  id: string;
  name: string;
  status: string;
  label: string;
  dependsOn: string[];
  attempts: number;
  current: boolean;
  execution: "background" | "main";
  artifact: { path: string; sha256: string } | null;
  check: { mode: string; status: string; reason: string; reworks: number };
  manual: string;
  integration: string;
  integrationCommit: string | null;
  todoId: string | null;
}

export interface GraphStatusView {
  phase: string;
  status: string;
  counts: { total: number; completed: number; running: number; waiting: number; pending: number; blocked: number };
  current: { nodeId: string; name: string; status: string } | null;
  nextAction: { kind: string; label: string; message: string; todoId?: string; nodeId?: string } | null;
  nodes: GraphStatusNode[];
  integration: { branch: string; currentCommit: string; accepted: number } | null;
  delivery: { success: boolean; outcome: string; delivered: number; unaccepted: number; unverified: number; unfinished: number; reason?: string };
}

export interface ViewerAssetStep {
  id: string;
  description: string;
  do: string;
  /** 全部验收判据：单 `check` 一条；`check_voting` 每票一条（顺序即验证者序号）。 */
  checks: string[];
  input: string;
  output: string;
  onPass: string;
  onFail: string;
  manual: boolean;
}
export interface ViewerAssetNode {
  id: string;
  name: string;
  do: string;
  artifact: string;
  dependsOn: string[];
  inputs: Array<{ fromNode: string; artifact: string }>;
  execution: "background" | "main";
  check: string;
  checkMode: "custom" | "disabled";
  manual: boolean;
}
export interface ViewerAsset {
  name: string;
  kind: "flow" | "graph";
  description: string;
  invalid: boolean;
  problems: string[];
  steps: ViewerAssetStep[];
  nodes: ViewerAssetNode[];
}
export interface StatusFrame {
  kind: "snapshot" | "update";
  sessionId: string;
  status: WorkflowStatus | null;
  error: string | null;
  /** 只读查看器的资产目录（DO/CHECK/依赖）；缺省 = 空。 */
  catalog: ViewerAsset[];
}

/** 用户主动暂停的返回值；失败时 text 直接给用户看。 */
export interface PauseResult {
  ok: boolean;
  text: string;
}

/** One explicit, strict public Typert contract shared by both faces. No SRC fallback. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected status object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected status string");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("expected status count");
  return value;
}
function array<T>(value: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 2000) throw new TypeError("expected bounded status list");
  return value.map(parse);
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("expected status boolean");
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new TypeError("unknown status variant");
  return value as T;
}
function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : string(value);
}

function parseGraphStatus(value: unknown): GraphStatusView {
  const view = record(value);
  const counts = record(view.counts);
  const currentRaw = view.current;
  const nextRaw = view.nextAction;
  const integrationRaw = view.integration;
  const delivery = record(view.delivery);
  return {
    phase: string(view.phase),
    status: string(view.status),
    counts: {
      total: count(counts.total), completed: count(counts.completed), running: count(counts.running),
      waiting: count(counts.waiting), pending: count(counts.pending), blocked: count(counts.blocked),
    },
    current: currentRaw === null || currentRaw === undefined ? null : (() => {
      const item = record(currentRaw);
      return { nodeId: string(item.nodeId), name: string(item.name), status: string(item.status) };
    })(),
    nextAction: nextRaw === null || nextRaw === undefined ? null : (() => {
      const item = record(nextRaw);
      return {
        kind: string(item.kind), label: string(item.label), message: string(item.message),
        ...(item.todoId === undefined ? {} : { todoId: string(item.todoId) }),
        ...(item.nodeId === undefined ? {} : { nodeId: string(item.nodeId) }),
      };
    })(),
    nodes: array(view.nodes, (node) => {
      const item = record(node);
      const artifact = item.artifact;
      const check = record(item.check);
      return {
        id: string(item.id), name: string(item.name), status: string(item.status), label: string(item.label),
        dependsOn: array(item.dependsOn, string), attempts: count(item.attempts), current: bool(item.current),
        execution: choice(item.execution, ["background", "main"] as const),
        artifact: artifact === null || artifact === undefined ? null : (() => {
          const a = record(artifact);
          return { path: string(a.path), sha256: string(a.sha256) };
        })(),
        check: { mode: string(check.mode), status: string(check.status), reason: string(check.reason), reworks: count(check.reworks) },
        manual: string(item.manual), integration: string(item.integration),
        integrationCommit: nullableString(item.integrationCommit), todoId: nullableString(item.todoId),
      };
    }),
    integration: integrationRaw === null || integrationRaw === undefined ? null : (() => {
      const item = record(integrationRaw);
      return { branch: string(item.branch), currentCommit: string(item.currentCommit), accepted: count(item.accepted) };
    })(),
    delivery: {
      success: bool(delivery.success), outcome: string(delivery.outcome),
      delivered: count(delivery.delivered), unaccepted: count(delivery.unaccepted),
      unverified: count(delivery.unverified), unfinished: count(delivery.unfinished),
      ...(delivery.reason === undefined ? {} : { reason: string(delivery.reason) }),
    },
  };
}

function parseViewerAsset(value: unknown): ViewerAsset {
  const asset = record(value);
  const kind = choice(asset.kind, ["flow", "graph"] as const);
  return {
    name: string(asset.name),
    kind,
    description: string(asset.description),
    invalid: bool(asset.invalid),
    problems: array(asset.problems, string),
    steps: array(asset.steps, (step) => {
      const item = record(step);
      return {
        id: string(item.id), description: string(item.description), do: string(item.do),
        checks: array(item.checks, string), input: string(item.input), output: string(item.output),
        onPass: string(item.onPass), onFail: string(item.onFail), manual: bool(item.manual),
      };
    }),
    nodes: array(asset.nodes, (node) => {
      const item = record(node);
      return {
        id: string(item.id), name: string(item.name), do: string(item.do), artifact: string(item.artifact),
        dependsOn: array(item.dependsOn, string),
        inputs: array(item.inputs, (input) => { const x = record(input); return { fromNode: string(x.fromNode), artifact: string(x.artifact) }; }),
        execution: choice(item.execution, ["background", "main"] as const),
        check: string(item.check),
        checkMode: item.checkMode === undefined ? "custom" : choice(item.checkMode, ["custom", "disabled"] as const),
        manual: bool(item.manual),
      };
    }),
  };
}

export function parseStatusFrame(value: unknown): StatusFrame {
  const frame = record(value);
  let status: WorkflowStatus | null = null;
  if (frame.status !== null) {
    const s = record(frame.status);
    const kind: "flow" | "graph" = s.kind === "graph" ? "graph" : "flow";
    status = {
      id: string(s.id), kind, workflow: string(s.workflow), task: string(s.task), step: string(s.step),
      stage: choice(s.stage, ["executing", "verifying", "gate", "paused", "switching", "done", "cancelled", "failed", "unavailable"]),
      hint: string(s.hint), failures: count(s.failures), maxFailures: count(s.maxFailures), updatedAt: string(s.updatedAt),
      report: s.report === null ? null : string(s.report),
      steps: array(s.steps, (v) => { const x = record(v); return { id: string(x.id), description: string(x.description), current: bool(x.current), failures: count(x.failures) }; }),
      votes: array(s.votes, (v) => { const x = record(v); return { index: count(x.index), status: choice(x.status, ["pending", "running", "passed", "failed", "infra"]), reason: string(x.reason), ...(x.check === undefined ? {} : { check: string(x.check) }) }; }),
      recent: array(s.recent, (v) => { const x = record(v); return { step: string(x.step), event: string(x.event), detail: string(x.detail) }; }),
      ...(kind === "graph" || s.graph !== undefined ? { graph: parseGraphStatus(s.graph) } : {}),
    };
  }
  return { kind: choice(frame.kind, ["snapshot", "update"]), sessionId: string(frame.sessionId), status,
    error: frame.error === null ? null : string(frame.error),
    catalog: frame.catalog === undefined ? [] : array(frame.catalog, parseViewerAsset) };
}
export function parsePauseResult(value: unknown): PauseResult {
  const result = record(value);
  return { ok: bool(result.ok), text: string(result.text) };
}
const sessionCodec = { mode: "strict" as const, typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", create: () => ({ parse: string }) };
const frameCodec = { mode: "strict" as const, typeSymbol: "ralphflow-dsh#StatusFrame", create: () => ({ parse: parseStatusFrame }) };
const pauseCodec = { mode: "strict" as const, typeSymbol: "ralphflow-dsh#PauseResult", create: () => ({ parse: parsePauseResult }) };
export const statusDescriptors: readonly InvocationDescriptor[] = [{
  id: "ralphflow-dsh#ralphflowStatus/watch", service: "ralphflowStatus", namespace: "ralphflowStatus", method: "watch",
  mode: "stream", invocation: { kind: "direct" },
  parameters: [{ name: "session", wire: "sessionId", source: "lookup", lookup: "session", codec: sessionCodec }],
  cancellation: { parameter: "signal" }, result: frameCodec,
}, {
  id: "ralphflow-dsh#ralphflowStatus/pause", service: "ralphflowStatus", namespace: "ralphflowStatus", method: "pause",
  invocation: { kind: "direct" },
  parameters: [{ name: "session", wire: "sessionId", source: "lookup", lookup: "session", codec: sessionCodec }],
  result: pauseCodec,
}];
export const statusRemote: TypertRemoteContribution = { package: "ralphflow-dsh", descriptors: statusDescriptors };
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    ralphflowStatus: {
      watch(sessionId: string, signal?: AbortSignal): RemoteStream<StatusFrame>;
      pause(sessionId: string): Promise<PauseResult>;
    };
  }
}
