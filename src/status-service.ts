import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { StatusFrame, WorkflowStatus } from "./status-contract.js";

export interface StatusReader {
  read(session: Session): Promise<{ status: WorkflowStatus | null; error: string | null }>;
  subscribe(listener: () => void): () => void;
}

/** The existing session lookup owns admission/resume. This face only observes that Session. */
export class WorkflowStatusService extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  constructor(ctx: Context, private readonly reader: StatusReader) {
    super(ctx, "ralphflowStatus");
    ctx.effect(() => () => this.lifetime.abort(), "ralphflow status stream lifetime");
  }

  @Remote({ mode: "stream" })
  async *watch(session: Session, signal: AbortSignal): AsyncGenerator<StatusFrame> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    let pending = true;
    let wake: (() => void) | undefined;
    const changed = () => { pending = true; wake?.(); };
    const unsubscribe = this.reader.subscribe(changed);
    signal.addEventListener("abort", changed);
    let first = true;
    try {
      while (!signal.aborted) {
        if (!pending) await new Promise<void>((resolve) => { wake = resolve; if (pending || signal.aborted) resolve(); });
        wake = undefined;
        if (signal.aborted) return;
        pending = false;
        const next = await this.reader.read(session);
        if (signal.aborted) return;
        yield { kind: first ? "snapshot" : "update", sessionId: session.id, ...next };
        first = false;
      }
    } finally {
      unsubscribe(); signal.removeEventListener("abort", changed);
    }
  }
}
