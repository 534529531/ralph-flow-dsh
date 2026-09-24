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

/**
 * 验证者 system prompt。
 *
 * 判定通道**首选 dsh 原生结构化输出**（`outputSchema` → 子代理调用 structured_output 工具，
 * 引擎读 `result.structured`）。文本标签只是 provider 不支持 `outputSchema` 时的降级兜底，
 * 因此这里**不写死**标签格式 —— 由 buildCheckPrompt 按 wantStructured 决定是否要求标签。
 */
const DEFAULT_ADVERSARIAL_SYSTEM_PROMPT = `你是一个严格、独立、对抗性的检查者。你的职责是**取证后判定**：根据给定的检查依据，判断执行者声称完成的工作是否真的完成。

纪律：
- 你与执行者完全隔离：你只看到任务、检查依据和执行者交卷时的摘要。不要相信摘要里的自我评价，一切以你亲自取证为准。
- 用工具取证：读文件、跑命令、搜索代码。没有证据的结论无效。
- 你是只读检查者：不要修改任何文件，不要写任何东西。
- 判定：给出你的取证过程与结论，并按「检查依据」末尾说明的方式提交判定结果。`;

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

/** CHECK 提示词构造（导出供测试直接断言 §1.3 的 desc/交付物/产出目录） */
export function buildCheckPrompt(req: VerifyRequest, wantStructured: boolean): string {
  const rel = req.artifactsRelDir;
  // §1.3：CHECK 必须拿到与 DO 同等的承诺上下文（desc + 交付物 + 产出目录），
  // 否则验证者不知道本步承诺交付什么，只能泛泛核对。
  const stepFacts = [
    `**步骤**：\`${req.step.id}\``,
    ...(req.step.desc ? [`**描述**：${req.step.desc}`] : []),
    `**本步任务**：${(req.step.do ?? "").trim() || "（未声明）"}`,
    ...(req.step.input ? [`**输入**：${String(req.step.input).trim()}`] : []),
    ...(req.step.output ? [`**交付物（本步承诺的产出）**：${String(req.step.output).trim()}`] : []),
    `**产出目录**：\`${rel}/\` —— 检查依据里没写路径的文件名（如 \`summary.md\`）即指此目录下的文件。`,
  ];
  const parts = [
    "## 任务",
    req.userTask,
    "",
    "## 本步上下文",
    stepFacts.join("\n"),
    "",
    "## 检查依据",
    req.step.check?.trim() || "（本步未声明检查依据，请按任务的每一条要求严格核对：是否落实、是否真实可用、有无遗漏。）",
    "",
    "## 执行者交卷摘要",
    req.submitSummary?.trim() || "（无摘要）",
    "",
    "## 取证要求",
    "在**当前工作区**里取证（读文件、跑命令、搜索），逐条核对检查依据。",
    "产出目录也在这个工作区内，用上面的相对路径即可读到；**不要只凭交卷摘要下结论**。",
    wantStructured
      // 原生结构化输出可用：判定由 structured_output 工具承载，不需要文本标签。
      ? "先写出取证过程与结论，最后**调用 `structured_output` 工具**提交判定（passed / reason）。只调用一次。"
      // 降级路径：provider 不支持 outputSchema 时才要求文本标签。
      : "先写出取证过程与结论，并在最后一行单独输出 `<promise-check>true</promise-check>`（通过）或 `<promise-check>false</promise-check>`（不通过）。",
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
  const model = config?.model ? splitModel(config.model) : undefined;
  const toolAllow = resolveToolAllow(ctx);
  const wantStructured = supportsOutputSchema(ctx, name);

  const agentOptions: Record<string, string> = {};
  if (model?.provider) agentOptions.provider = model.provider;
  if (model?.model) agentOptions.model = model.model;

  // 委派生命周期完全交给 dsh 原生能力：不设 ralphflow 自己的超时。
  // dsh 的委派契约里 `signal` 是**取消句柄**（SubagentStartRequest.signal = "the caller's
  // cancellation"，驱动器用它在取消时 child.cancel），不是超时预算；宿主对整次子代理运行
  // 本就不设上界（subagent / in-process-driver / agent-loop 均无 timeout 逻辑），
  // 上层只提供**请求级**防护（dsh-llm-deepseek 的 streamIdleTimeoutMs 空闲看门狗）。
  // 跟随宿主不设总时长上界的取舍：宿主迭代时（更完善的取消/看门狗）ralphflow 自动受益；
  // 自造超时反而会与宿主契约脱节（见 docs/v2/hardening-brief.md 要求 1）。

  let run: any;
  try {
    const startReq: Record<string, unknown> = {
      label: `Ralph Check: ${req.step.id} ${req.userTask.slice(0, 50)}`,
      prompt: [
        { type: "text", text: `${systemPrompt}\n\n---\n\n${buildCheckPrompt(req, wantStructured)}` },
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
    // 原生等待：与 dsh-tool-subagent（宿主自己的委派工具）同款 —— 直接 await run.result，
    // 由宿主决定子代理何时结束。取消仍经 req.signal 传下去（dsh 的取消契约）。
    const settled = await run.result;
    return parseVerdict(settled, req.step.id, req.checkIndex);
  } catch (e) {
    const aborted = req.signal.aborted;
    return {
      check_index: req.checkIndex,
      status: "infra",
      reason: aborted
        ? "验证已中止（用户取消或实例结束），验证者未返回判定。"
        : `验证委派失败：${e instanceof Error ? e.message : String(e)}`,
      step_id: req.step.id,
      ts: new Date().toISOString(),
      ...(run && typeof run === "object" && "id" in run ? { agent_id: String((run as { id: unknown }).id) } : {}),
    };
  }
}