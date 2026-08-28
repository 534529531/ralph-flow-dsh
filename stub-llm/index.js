/**
 * stub-llm —— 本地桩 LLM provider（verify 端到端验证用）
 *
 * 实现 dsh 的 LlmAdapter，注册 provider "stub"。它不调用任何远程 API，
 * 根据请求上下文返回预设文本，让 dsh 的真实 agent loop / subagent / jobs /
 * 事件 / UI 全链路真实运行（"模型"是本地桩）：
 *   - 主 agent 的 DO 阶段：返回 "完成\n\n<promise>done</promise>"
 *     → ralphflow 真实检测 done tag → 推进到 CHECK
 *   - 验证者 subagent 的 CHECK：返回 "验证通过\n\n<promise-check>true</promise-check>"
 *     → ralphflow 真实解析为 PASS → 推进 / 归档
 * 判别依据：验证者 subagent 的 system prompt 含 `promise-check`（见
 * ralph-flow engine.ts 的 adversarial prompt）；主 agent 不含。
 */
import { LlmAdapter } from "@deepseek-ai/dsh-llm";

export const name = "stub-llm";
export const inject = ["llm"];

const PROVIDER = "stub";

class StubAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: "Stub (local)" };
  }
  resolveModel(provider, model, _signal) {
    return Promise.resolve({ provider, id: model, name: model });
  }
  listModels(_provider) {
    return Promise.resolve([{ id: "stub-1", name: "stub-1" }]);
  }
  async *stream(options) {
    const ctxText = [
      options.system || "",
      ...(options.messages || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
    ].join("\n");

    let reply;
    if (ctxText.includes("<promise-check>") || ctxText.includes("DEFAULT_ADVERSARIAL") || ctxText.includes("edit 硬拒")) {
      // 验证者 subagent → 判定通过
      reply = "验证通过，实现符合要求。\n\n<promise-check>true</promise-check>";
    } else {
      // 主 agent DO → 完成 + done tag
      reply = "完成。\n\n<promise>done</promise>";
    }

    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: reply };
    yield { type: "block-end", index: 0, block: { type: "text", text: reply } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: reply.length, totalTokens: 1 + reply.length } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export function apply(ctx) {
  const adapter = new StubAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.logger?.info?.("[stub-llm] registered stub provider");
}
