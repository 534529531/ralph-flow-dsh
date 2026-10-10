import type { Context } from "@deepseek-ai/cordis";
import type { ChatNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import { createElement } from "react";
import { noticeDefinition, RALPHFLOW_NOTICE_KIND } from "./definition.js";
import { registerWorkflowStatus, injectStatusCss } from "./status.js";

export const inject = ["uiConversation", "slots"];

/** Native disclosure keeps every summary readable and the full record keyboard accessible. */
export function NoticeRow({ node }: { node: ChatNode<typeof RALPHFLOW_NOTICE_KIND> }) {
  injectStatusCss();
  return createElement("details", { "data-ralphflow-notice": String(node.anchorSeq), className: "ralphflow-notice" },
  createElement("summary", null, node.data.summary),
  createElement("div", { className: "ralphflow-notice-text" }, node.data.text));
}

export function apply(ctx: Context): void {
  ctx.inject(["remote", "sessions"], (child) => registerWorkflowStatus(child));
  ctx.uiConversation.events.register(noticeDefinition);
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node", key: RALPHFLOW_NOTICE_KIND,
  }, NoticeRow));
}
