import type { InvocationDescriptor, RemoteStream, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

export type WorkflowStage = "executing" | "verifying" | "gate" | "paused" | "switching" | "done" | "cancelled" | "unavailable";
export interface WorkflowStatus {
  id: string;
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
  votes: Array<{ index: number; status: "pending" | "running" | "passed" | "failed" | "infra"; reason: string }>;
  recent: Array<{ step: string; event: string; detail: string }>;
}
export interface StatusFrame {
  kind: "snapshot" | "update";
  sessionId: string;
  status: WorkflowStatus | null;
  error: string | null;
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
export function parseStatusFrame(value: unknown): StatusFrame {
  const frame = record(value);
  let status: WorkflowStatus | null = null;
  if (frame.status !== null) {
    const s = record(frame.status);
    status = {
      id: string(s.id), workflow: string(s.workflow), task: string(s.task), step: string(s.step),
      stage: choice(s.stage, ["executing", "verifying", "gate", "paused", "switching", "done", "cancelled", "unavailable"]),
      hint: string(s.hint), failures: count(s.failures), maxFailures: count(s.maxFailures), updatedAt: string(s.updatedAt),
      report: s.report === null ? null : string(s.report),
      steps: array(s.steps, (v) => { const x = record(v); return { id: string(x.id), description: string(x.description), current: bool(x.current), failures: count(x.failures) }; }),
      votes: array(s.votes, (v) => { const x = record(v); return { index: count(x.index), status: choice(x.status, ["pending", "running", "passed", "failed", "infra"]), reason: string(x.reason) }; }),
      recent: array(s.recent, (v) => { const x = record(v); return { step: string(x.step), event: string(x.event), detail: string(x.detail) }; }),
    };
  }
  return { kind: choice(frame.kind, ["snapshot", "update"]), sessionId: string(frame.sessionId), status,
    error: frame.error === null ? null : string(frame.error) };
}
const sessionCodec = { mode: "strict" as const, typeSymbol: "@deepseek-ai/dsh-session/types#SessionId", create: () => ({ parse: string }) };
const frameCodec = { mode: "strict" as const, typeSymbol: "ralphflow-dsh#StatusFrame", create: () => ({ parse: parseStatusFrame }) };
export const statusDescriptors: readonly InvocationDescriptor[] = [{
  id: "ralphflow-dsh#ralphflowStatus/watch", service: "ralphflowStatus", namespace: "ralphflowStatus", method: "watch",
  mode: "stream", invocation: { kind: "direct" },
  parameters: [{ name: "session", wire: "sessionId", source: "lookup", lookup: "session", codec: sessionCodec }],
  cancellation: { parameter: "signal" }, result: frameCodec,
}];
export const statusRemote: TypertRemoteContribution = { package: "ralphflow-dsh", descriptors: statusDescriptors };
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    ralphflowStatus: { watch(sessionId: string, signal?: AbortSignal): RemoteStream<StatusFrame> };
  }
}
