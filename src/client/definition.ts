import type { ConversationNodeDefinition } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ChatNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import { RALPHFLOW_SOURCE_KIND } from "../message-source.js";

/** Private renderer key; never replace a shipped Chat renderer. */
export const RALPHFLOW_NOTICE_KIND = "ralphflow-notice" as const;
export interface RalphflowNotice {
  summary: string;
  text: string;
}
declare module "@deepseek-ai/dsh-client-ui-chat/client" {
  interface ChatNodeDataMap {
    "ralphflow-notice": RalphflowNotice;
  }
}

/** The human transcript follows append origins, independently of model-surface replacements. */
export const noticeDefinition: ConversationNodeDefinition<RalphflowNotice> = {
  kind: RALPHFLOW_NOTICE_KIND,
  target: "chat",
  match(event) {
    if (event.type !== "user/message" || event.surfaceOp !== "append") return null;
    const source = event.data.source;
    if (source.kind !== RALPHFLOW_SOURCE_KIND || source.form !== "notice"
      || typeof source.summary !== "string" || !source.summary.trim()) return null;
    return { id: String(event.seq), role: "start" };
  },
  start(_context, { event }) {
    if (event.type !== "user/message" || event.data.source.kind !== RALPHFLOW_SOURCE_KIND
      || event.data.source.form !== "notice" || typeof event.data.source.summary !== "string") throw new Error("ralphflow notice requires user/message notice");
    return {
      summary: event.data.source.summary,
      text: event.data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
    };
  },
  update: (context) => context.state,
  buildViewNode(context): ChatNode<typeof RALPHFLOW_NOTICE_KIND> | null {
    if (!context.start || !context.state) return null;
    return {
      key: context.key,
      kind: RALPHFLOW_NOTICE_KIND,
      id: context.id,
      target: "chat",
      anchorSeq: context.start.event.seq,
      // Notices can land before turn/end. Never let the turn-process disclosure swallow them.
      location: { kind: "session" },
      visibility: "visible",
      data: context.state,
    };
  },
};
