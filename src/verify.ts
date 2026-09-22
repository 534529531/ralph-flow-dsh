/**
 * Ralph Flow for dsh v2 — 验证者委派（裁判权定理 T1 的唯一通道）
 *
 * 规则：
 *  - 委派只从引擎发出（主会话没有任何路径影响这里的 prompt 构造或判定解析）。
 *  - 验证者是全新独立会话：只见任务 + 检查依据 + 交卷摘要 +（可读的工作区），
 *    永远看不到主会话对话历史。
 *  - 判定 fail-closed：结构化输出优先，文本标签兜底，两者都解析不出 → infra（不计失败）。
 *  - 只有读工具（含 bash 供取证跑测试）；bash 内的间接写是与其它版本对齐的有意接受的弱点。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { AdversarialConfig, StepDef, WorkflowDef, Verdict, VerifyRequest } from "./engine.js";

const DEFAULT_ADVERSARIAL_SYSTEM_PROMPT = `你是一个严格、独立、对抗性的检查者。你的职责是**取证后判定**：根据给定的检查依据，判断执行者声称完成的工作是否真的完成。

纪律：
- 你与执行者完全隔离：你只看到任务、检查依据和执行者交卷时的摘要。不要相信摘要里的自我评价，一切以你亲自取证为准。
- 用工具取证：读文件、跑命令、搜索代码。没有证据的结论无效。
- 你是只读检查者：不要修改任何文件，不要写任何东西。
- 判定格式：最后一行单独输出 <promise-check>true</promise-check>（通过）或 <promise-check>false</promise-check>（不通过），前面写出你的取证过程与结论。`;

const VERIFIER_TOOL_ALLOW = ["read", "grep", "glob", "bash", "read_image"] as const;

export interface VerifyDeps {
  ctx: Context;
}

interface SubagentsFace {
  list(): string[];
  getProvider(n: string): { capabilities?: { outputSchema?: boolean } } | undefined;
  start(n: string, r: unknown): Promise<unknown>;
}

function subagents(ctx: Context): SubagentsFace {
  return (ctx as unknown as { subagents: SubagentsFace }).subagents;
}

/** 从部署实际工具集求交集（硬编码名单在工具命名不同的部署上会全灭） */
function resolveToolAllow(ctx: Context): string[] {
  try {
    const schemas = (ctx.tools as { schemas(scope?: unknown): { name: string }[] }).schemas();
    const names = new Set(schemas.map((s) => s.name));
    return VERIFIER_TOOL_ALLOW.filter((n) => names.has(n));
  } catch {
    return [...VERIFIER_TOOL_ALLOW];
  }
}

function providerName(ctx: Context, config?: AdversarialConfig): string {
  if (config?.agent?.trim()) return config.agent.trim();
  try {
    const list = subagents(ctx).list();
    if (list.includes("spawn")) return "spawn";
    const preferred = list.filter((n) => n && n !== "ralphcheck");
    return preferred[0] ?? list[0] ?? "";
  } catch {
    return "spawn";
  }
}

function supportsOutputSchema(ctx: Context, name: string): boolean {
  try {
    return subagents(ctx).getProvider(name)?.capabilities?.outputSchema === true;
  } catch {
    return false;
  }
}

function splitModel(ref: string): { provider?: string; model?: string } {
  const idx = ref.indexOf("/");
  if (idx > 0) return { provider: ref.slice(0, idx).trim(), model: ref.slice(idx + 1).trim() };
  return { model: ref.trim() };
}

function buildCheckPrompt(req: VerifyRequest): string {
  const parts = [
    "## 任务",
    req.userTask,
    "",
    "## 检查依据",
    req.step.check?.trim() || "（本步未声明检查依据，请按任务的每一条要求严格核对：是否落实、是否真实可用、有无遗漏。）",
    "",
    "## 执行者交卷摘要",
    req.submitSummary?.trim() || "（无摘要）",
    "",
    "## 取证要求",
    "在**当前工作区**里取证（读文件、跑命令、搜索），逐条核对检查依据。",
    "最后一行单独输出 `<promise-check>true</promise-check>` 或 `<promise-check>false</promise-check>`，前面写出取证过程与结论。",
  ];
  return parts.join("\n");
}

/** 验证者判定解析：结构化优先，文本标签兜底，解析不出 → infra（fail-closed） */
export function parseVerdict(raw: { structured?: unknown; output?: unknown; stopReason?: string }, stepId: string, checkIndex: number): Verdict {
  const ts = new Date().toISOString();
  const base = { check_index: checkIndex, step_id: stepId, ts };

  if (raw.structured && typeof raw.structured === "object") {
    const s = raw.structured as { passed?: unknown; reason?: unknown };
    if (typeof s.passed === "boolean") {
      return { ...base, status: s.passed ? "passed" : "failed", reason: typeof s.reason === "string" ? s.reason.slice(0, 2000) : (s.passed ? "通过" : "不通过") };
    }
  }
  const text = extractText(raw.output);
  if (!text) {
    return { ...base, status: "infra", reason: `验证者没有返回可解析的判定（stopReason=${String(raw.stopReason)}）。` };
  }
  const m = text.match(/<promise-check>\s*(true|false)\s*<\/promise-check>/i);
  if (m) {
    const passed = m[1]!.toLowerCase() === "true";
    return { ...base, status: passed ? "passed" : "failed", reason: text.replace(/<promise-check>.*<\/promise-check>/is, "").trim().slice(0, 2000) || (passed ? "通过" : "不通过") };
  }
  // JSON 兜底（部分模型更愿意给 JSON）
  const jsonm = text.match(/\{\s*"passed"\s*:\s*(true|false)\s*[^}]*\}/i);
  if (jsonm) {
    try {
      const j = JSON.parse(jsonm[0]) as { passed: boolean; reason?: string };
      if (typeof j.passed === "boolean") {
        return { ...base, status: j.passed ? "passed" : "failed", reason: (j.reason ?? (j.passed ? "通过" : "不通过")).slice(0, 2000) };
      }
    } catch {}
  }
  return { ...base, status: "infra", reason: "验证者返回了文本但无法解析出判定标签（fail-closed，不计失败）。" };
}

function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => (b && typeof b === "object" && "type" in b && b.type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (output && typeof output === "object" && "text" in output && typeof (output as { text: unknown }).text === "string") {
    return (output as { text: string }).text;
  }
  return "";
}

/** 委派一个独立验证者并返回判定（T1 的唯一入口，由引擎调用） */
export async function runVerifier(deps: VerifyDeps, req: VerifyRequest): Promise<Verdict> {
  const ctx = deps.ctx;
  const name = providerName(ctx, req.workflow.adversarial_check);
  if (!name) {
    return { check_index: req.checkIndex, status: "infra", reason: "部署里没有任何可用的 subagent provider，无法委派验证者。", step_id: req.step.id, ts: new Date().toISOString() };
  }
  const config = req.workflow.adversarial_check;
  const systemPrompt = config?.system_prompt?.trim() || DEFAULT_ADVERSARIAL_SYSTEM_PROMPT;
  const timeout = config?.timeout_ms && config.timeout_ms > 0 ? config.timeout_ms : 900_000;
  const model = config?.model ? splitModel(config.model) : undefined;
  const toolAllow = resolveToolAllow(ctx);
  const wantStructured = supportsOutputSchema(ctx, name);

  const agentOptions: Record<string, string> = {};
  if (model?.provider) agentOptions.provider = model.provider;
  if (model?.model) agentOptions.model = model.model;

  const timeoutHandle = setTimeout(() => { try { (req.signal as unknown as { abort(): void }).abort(); } catch {} }, timeout);
  void timeoutHandle.unref?.();

  let run: any;
  try {
    const startReq: Record<string, unknown> = {
      label: `Ralph Check: ${req.step.id} ${req.userTask.slice(0, 50)}`,
      prompt: [
        { type: "text", text: `${systemPrompt}\n\n---\n\n${buildCheckPrompt(req)}` },
      ],
      signal: req.signal,
      persona: "你是一个严格、独立、对抗性的检查者。你只读取证并给出判定，绝不修改任何文件。",
      toolFilter: toolAllow.length > 0 ? { allow: toolAllow } : undefined,
    };
    if (req.ownerSession) {
      try {
        const parent = (ctx.agents as { get(id: string): unknown }).get(req.ownerSession);
        if (parent) startReq.parent = parent;
      } catch {}
    }
    if (wantStructured) {
      startReq.outputSchema = {
        type: "object",
        properties: { passed: { type: "boolean" }, reason: { type: "string" } },
        required: ["passed", "reason"],
        additionalProperties: false,
      };
    }
    if (Object.keys(agentOptions).length > 0) startReq.agentOptions = agentOptions;

    const started = await subagents(ctx).start(name, startReq);
    run = started as { result?: Promise<{ structured?: unknown; output?: unknown; stopReason?: string }> };
    const settled = await run.result;
    clearTimeout(timeoutHandle);
    return parseVerdict(settled, req.step.id, req.checkIndex);
  } catch (e) {
    clearTimeout(timeoutHandle);
    const aborted = req.signal.aborted;
    return {
      check_index: req.checkIndex,
      status: "infra",
      reason: aborted
        ? `验证超时（${Math.round(timeout / 60000)} 分钟）或已中止。`
        : `验证委派失败：${e instanceof Error ? e.message : String(e)}`,
      step_id: req.step.id,
      ts: new Date().toISOString(),
      ...(run && typeof run === "object" && "id" in run ? { agent_id: String((run as { id: unknown }).id) } : {}),
    };
  }
}