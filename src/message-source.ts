/**
 * ralphflow 自己的消息来源 kind（插件播报与 reset 交接稿都用它）。
 *
 * dsh 0.2 起 `MessageSourceMap` 是 merge-extensible 的 sum type：每个生产者**在自己的
 * 模块里**声明自己的 kind，内置的 `plugin` 这个 catch-all 被删除。类型文档原话：
 * *each producer declares its own `kind` in its own module; there is no shared catch-all
 * `plugin` kind.* 这里照 `dsh-user-approval` 的模板声明我们自己的。
 *
 * 只按**当前** dsh 的这套写法写，不为任何更老的 dsh 留分支 —— dsh 的破坏性改动是常态，
 * 我们的立场是跟着最新版走（作者定案）。
 *
 * Chat 可见性受 kind 过滤控制：非 user 来源先成为 context，普通 context 整行丢弃。
 * `form: "notice"` + summary 只控制已可见 context 的展开，不能绕过过滤。
 * 本包客户端另注册 `ralphflow-notice` 私有节点与渲染器，读取 append 日志并显式定位
 * 会话级；它决定播报在 Chat 可见，reset 的模型面替换不会抹掉这条人类记录。
 */
import type { ContextFormed } from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    ralphflow: { kind: "ralphflow"; uiRef?: WorkflowUiRef } & ContextFormed;
  }
}

/** 本插件消息的来源 kind。用户可见的播报另带 `form: "notice"` + `summary`。 */
export const RALPHFLOW_SOURCE_KIND = "ralphflow" as const;

/** Index on existing terminal notices; never changes model content or sends another event. */
export interface WorkflowUiRef { v: 1; runId: string; reportRef: string; ended: "done" | "cancelled" }
