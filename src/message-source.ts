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
 * 可见性不受影响：客户端按 `source.form === "notice"` + 非空 `summary` 渲染成折叠的
 * notice 行，**不看 `kind`**；未知 kind 回落为 opaque 内容（见 `scripts/visibility-test.mjs`
 * 头部记的那次缺陷）。改名换掉的是日志里的来源标记，不是渲染。
 */
import type { ContextFormed } from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    ralphflow: { kind: "ralphflow" } & ContextFormed;
  }
}

/** 本插件消息的来源 kind。用户可见的播报另带 `form: "notice"` + `summary`。 */
export const RALPHFLOW_SOURCE_KIND = "ralphflow" as const;
