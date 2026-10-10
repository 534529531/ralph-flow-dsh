import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import { RemoteSnapshotStream } from "@deepseek-ai/dsh-api-gateway/client";
import { parseStatusFrame, type StatusFrame, type WorkflowStatus } from "../status-contract.js";

export interface ClientStatus {
  status: WorkflowStatus | null;
  connection: "connecting" | "live" | "offline";
  error: string | null;
}

/** One lazy stream per Session, shared by the header and dock. Last unsubscribe releases it. */
export function createStatusSource(ctx: Context, sessionId: string) {
  let snapshot: ClientStatus = { status: null, connection: "connecting", error: null };
  const listeners = new Set<() => void>();
  let stream: RemoteSnapshotStream<StatusFrame, StatusFrame> | undefined;
  let token = 0;
  const publish = (next: ClientStatus) => {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const start = () => {
    const incarnation = ++token;
    publish({ ...snapshot, connection: "connecting" });
    const failed = (_error: unknown) => {
      if (incarnation === token) publish({ ...snapshot, connection: "offline", error: "连接中断，显示最后状态；正在重新同步。" });
    };
    const accept = (raw: StatusFrame) => {
      if (incarnation !== token) return;
      const frame = parseStatusFrame(raw);
      if (frame.sessionId !== sessionId) throw new Error("status stream crossed Session binding");
      publish({ status: frame.status, connection: "live", error: frame.error });
    };
    const carrier = ctx.remote.$stream<StatusFrame>({
      name: `ralphflow status ${sessionId}`,
      open: (signal) => ctx.remote.ralphflowStatus.watch(sessionId, signal),
      ended: () => new Error("workflow status stream ended"),
      carrierFailed: failed,
    });
    stream = new RemoteSnapshotStream(carrier, {
      name: "ralphflow status", isSnapshot: (frame): frame is StatusFrame => frame.kind === "snapshot",
      replace: accept, update: accept, failed,
    });
    stream.start();
  };
  const stop = () => {
    ++token;
    const current = stream; stream = undefined;
    void current?.dispose();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => { listeners.delete(listener); if (listeners.size === 0) stop(); };
    },
    dispose() { stop(); listeners.clear(); },
  };
}
