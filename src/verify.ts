/**
 * Ralph Flow for dsh v2 — 验证者委派（裁判权定理 T1 的唯一通道）
 *
 * 规则：
 *  - 委派只从引擎发出（主会话没有任何路径影响这里的 prompt 构造或判定解析）。
 *  - 验证者是全新独立会话：只见任务 + 检查依据 +（可读的工作区），
 *    永远看不到主会话对话历史，也**看不到执行者的交卷摘要**（T1 硬规则）。
 *  - 验证者身份是 Ralphflow 的**内部定义**（`VERIFIER_PERSONA`，单一来源），经 DSH 原生
 *    子代理 `persona` 通道传入；后端**按能力**选择（全新上下文 + persona/toolFilter），
 *    工作流不再有任何入口影响它。
 *  - 判定 fail-closed：结构化输出优先，文本标签兜底，两者都解析不出 → infra（不计失败）。
 *  - 只有读工具（含 bash 供取证跑测试）；bash 内的间接写是与其它版本对齐的有意接受的弱点。
 */
import type { Context } from "@deepseek-ai/cordis";
import { stepHasCheck } from "./engine.js";
import type { StepDef, WorkflowDef, Verdict, VerifyRequest } from "./engine.js";

/**
 * 验证者角色说明 —— Ralphflow 的**内部定义，单一来源**。
 *
 * 它不再是被拼进任务消息正文的「system prompt」，而是通过 DSH 原生的子代理 `persona`
 * 传入（在子代理 scope 注册 `deployment:persona-prefix` 系统提示段，是角色说明的正确通道）。
 *
 * **切分线**：persona 只承载「你是谁、你的纪律」（独立性、只读取证、不采信自述、只读不改
 * 文件）；本次任务的事实与**按 `wantStructured` 分支的判定提交方式**（`structured_output`
 * 工具 / `<promise-check>` 文本标记）由 `buildCheckPrompt` 承载 —— 后者是逐请求状态，
 * 搬进 persona 会让降级路径失效。
 */
export const VERIFIER_PERSONA = `你是一个严格、独立、对抗性的检查者。你的职责是按给定的检查依据**取证后判定**：执行者声称完成的工作是否真的完成。

纪律：
- 你与执行者完全隔离：你看不到它的对话历史，也看不到它的自我辩护；你只有任务与检查依据。
- 用工具取证：读文件、跑命令、搜索代码。没有证据的结论无效。
- 你是只读检查者：不要修改任何文件，不要写任何东西。
- 只看结果：不采信任何执行者自述或实现总结。
- 按「检查依据」末尾说明的方式提交判定结果。`;

const VERIFIER_TOOL_ALLOW = ["read", "grep", "glob", "bash", "read_image"] as const;

export interface VerifyDeps {
  ctx: Context;
}

interface ProviderCapabilities {
  outputSchema?: boolean;
  toolFilter?: boolean;
  persona?: boolean;
}

interface ProviderInfo {
  capabilities?: ProviderCapabilities;
  /** provider 原生字段：子代理是否继承父会话的已完成上下文（spawn=false、fork=true） */
  inheritsParentContext?: boolean;
}

interface SubagentsFace {
  list(): string[];
  getProvider(n: string): ProviderInfo | undefined;
  start(n: string, r: unknown): Promise<unknown>;
}

function subagents(ctx: Context): SubagentsFace {
  return (ctx as unknown as { subagents: SubagentsFace }).subagents;
}

export interface BackendSelection {
  name?: string;
  reason?: string;
}

/**
 * 选择独立验证者后端 —— **按能力判定，不按名字判定**。
 *
 * - 只考虑 `inheritsParentContext === false` 的 provider（全新上下文）。**绝不**回退到
 *   `true` 的 provider：`fork` 会继承主会话历史，T1 会静默失效。未声明该字段的 provider
 *   同样不选（无法证明是全新上下文 → fail-closed）。
 * - 候选里优先 `capabilities.persona && capabilities.toolFilter` 都支持的：这两项是
 *   「独立 + 有纪律的只读裁判」的前置条件，缺失时 `start()` 本就会抛
 *   `UNSUPPORTED_CAPABILITY`，所以直接选支持的那个，不等到抛错。
 * - provider 名可配置（`providerName`），**名字不参与判定**。
 * - 没有可用后端时返回 `reason`，由调用方转成 infra 判定 —— 绝不生成通过判定。
 */
export function selectBackend(ctx: Context): BackendSelection {
  let list: string[];
  let providerOf: (n: string) => ProviderInfo | undefined;
  try {
    const svc = subagents(ctx);
    list = svc.list() ?? [];
    providerOf = (n) => { try { return svc.getProvider(n); } catch { return undefined; } };
  } catch {
    return { reason: "本部署没有全新上下文的委派后端（读取 subagents 服务失败），无法委派独立验证者。" };
  }
  const fresh = (list ?? []).filter((n) => !!n && providerOf(n)?.inheritsParentContext === false);
  if (fresh.length === 0) {
    return { reason: "本部署没有全新上下文的委派后端（没有任何 provider 声明 inheritsParentContext === false），无法保证验证者与执行者会话隔离（T1）。" };
  }
  const ready = fresh.find((n) => {
    const c = providerOf(n)?.capabilities;
    return c?.persona === true && c?.toolFilter === true;
  });
  if (ready) return { name: ready };
  const missing: string[] = [];
  if (!fresh.some((n) => providerOf(n)?.capabilities?.persona === true)) missing.push("`persona`");
  if (!fresh.some((n) => providerOf(n)?.capabilities?.toolFilter === true)) missing.push("`toolFilter`");
  return {
    reason: `本部署有全新上下文委派后端（${fresh.map((n) => `\`${n}\``).join("、")}），但缺少 ${missing.join("、")} 能力，无法委派「独立 + 有纪律的只读裁判」验证者。`,
  };
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

function supportsOutputSchema(ctx: Context, name: string): boolean {
  try {
    return subagents(ctx).getProvider(name)?.capabilities?.outputSchema === true;
  } catch {
    return false;
  }
}

/** CHECK 提示词构造（导出供测试直接断言 §1.3 的 desc/交付物/产出目录） */
export function buildCheckPrompt(req: VerifyRequest, wantStructured: boolean): string {
  // 通用兜底配方已随「无 check = 跳过对抗性验证」退役（no-check-semantics-brief §7）。
  // 本函数**只在有检查依据时被调用**：单 `check` 用 `step.check`，多验证者投票用 `req.voter.check`。
  // 传入两者都没有的步骤是引擎缺陷，必须明确失败，绝不静默产出兜底配方 ——
  // 那等于把已删除的行为留成暗门（校验形同虚设且不可见）。
  if (!req.voter && !stepHasCheck(req.step)) {
    throw new Error(
      `buildCheckPrompt 拒绝无 \`check\`/\`check_voting\` 的步骤 \`${req.step.id}\`：这类步骤跳过对抗性验证，` +
      `不应委派验证者（兜底配方已退役，不再静默生成）。`,
    );
  }
  const voter = req.voter;
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
  // 投票变体（对齐 opencode `buildVotingCheckPrompt`）：共享上下文 + **该票专属**检查依据 +
  // 「你是 N 个之一，只查自己这一条」约束。目的：防止各票趋同成同一份泛泛检查。
  const basis = voter
    ? [
      "## 你的检查依据（专属视角）",
      voter.check.trim(),
      "",
      `## 你是 ${voter.count} 个验证者之一`,
      "",
      "- 你**只负责你自己的检查依据**（上方「你的检查依据」段），不要试图覆盖其他验证者的视角。",
      "- 其他验证者正在并行检查其他方面，各有独立会话。",
      "- 你的结论不受任何其他验证者影响，也不要等待或引用它们。",
      "- 本步**全过才放行**，但汇总由程序完成：你只需给出你自己这一票的判定。",
    ]
    : ["## 检查依据", req.step.check!.trim()];
  // T1：**不注入执行者的交卷自述**。验证者只看"结果是否满足检查依据"，不看执行者
  // 怎么做的、自称做了什么。opencode 与 claude 版同样从不传入自述，并明令
  // "不要依赖任何外部提供的实现总结"——自述是锚点，会软化独立判定。
  const parts = [
    "## 任务",
    req.userTask,
    "",
    "## 本步上下文",
    stepFacts.join("\n"),
    "",
    ...basis,
    "",
    "## 取证要求",
    "在**当前工作区**里取证（读文件、跑命令、搜索），逐条核对检查依据。",
    "产出目录也在这个工作区内，用上面的相对路径即可读到。",
    ...(voter ? ["**只查你自己那条检查依据**：其他视角由别的验证者负责，不要替它们下结论。"] : []),
    "**只看结果**：以你亲自取证到的事实为准，不采信任何执行者自述或实现总结。",
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

/**
 * 把一条复盘证据写进执行日志（§3.2）。
 *
 * **日志写入绝不参与判定**：端口抛错也只吞掉（引擎侧同样只告警不抛，§3.4）——
 * 日志是辅助证据，写不出来绝不能把一次验证搞成 infra。
 */
function logSafe(req: VerifyRequest, level: "info" | "warn" | "error", event: string, extra: Record<string, unknown>): void {
  try { req.logEvent?.(level, event, extra); } catch {}
}

/** 委派一个独立验证者并返回判定（T1 的唯一入口，由引擎调用） */
export async function runVerifier(deps: VerifyDeps, req: VerifyRequest): Promise<Verdict> {
  const ctx = deps.ctx;
  // 后端选择属于 Ralphflow 内部：按能力判定，工作流没有任何入口影响它（公开契约已无 agent）。
  // 选不出来 → infra，理由说明缺什么；**绝不**生成通过判定。
  const backend = selectBackend(ctx);
  if (!backend.name) {
    return {
      check_index: req.checkIndex,
      status: "infra",
      reason: backend.reason ?? "本部署没有全新上下文的委派后端，无法委派独立验证者。",
      step_id: req.step.id,
      ts: new Date().toISOString(),
    };
  }
  const name = backend.name;
  // 验证模型由**引擎**归一化后传入（优先级：步骤 check_model > 全局 adversarial_check.model）。
  // 这里不再自己解析 YAML 里的 model 形态——归一化只有一处，三端语义才一致。
  // 没有覆盖时不传 agentOptions：宿主 resolveChildAgentOptions 继承父级 provider/model。
  const model = req.model;
  const toolAllow = resolveToolAllow(ctx);
  const wantStructured = supportsOutputSchema(ctx, name);

  const agentOptions: Record<string, string> = {};
  if (model?.providerID) agentOptions.provider = model.providerID;
  if (model?.modelID) agentOptions.model = model.modelID;

  // 委派生命周期完全交给 dsh 原生能力：不设 ralphflow 自己的超时。
  // dsh 的委派契约里 `signal` 是**取消句柄**（SubagentStartRequest.signal = "the caller's
  // cancellation"，驱动器用它在取消时 child.cancel），不是超时预算；宿主对整次子代理运行
  // 本就不设上界（subagent / in-process-driver / agent-loop 均无 timeout 逻辑），
  // 上层只提供**请求级**防护（dsh-llm-deepseek 的 streamIdleTimeoutMs 空闲看门狗）。
  // 跟随宿主不设总时长上界的取舍：宿主迭代时（更完善的取消/看门狗）ralphflow 自动受益；
  // 自造超时反而会与宿主契约脱节（见 docs/v2/hardening-brief.md 要求 1）。

  let run: any;
  try {
    // §3.2 可复盘证据之一：**发给验证者的提示词原文**（不截断）。
    // 这正是排查「验证者为什么判错」唯一有效的东西——提示词被截断，日志就等于没有。
    //
    // ⚠️ 这一句**必须留在 try 内**：`buildCheckPrompt` 对无 `check` 的步骤**明确抛错**
    // （兜底配方已退役，见 no-check-semantics-brief §7），该抛错要由下面的 catch 统一转成
    // infra 判定 —— 挪到 try 外会让「无 check 被误委派」从 fail-closed 退化成未捕获异常。
    const promptText = buildCheckPrompt(req, wantStructured);
    logSafe(req, "info", "verifier_prompt", {
      step: req.step.id,
      checkIndex: req.checkIndex,
      backend: name,
      structured: wantStructured,
      model: model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : null,
      prompt: promptText,
    });
    const startReq: Record<string, unknown> = {
      // 投票时把票号写进会话标题（opencode 同款做法）：用户能一眼看出「这是第几票、共几票」。
      label: req.voter
        ? `Ralph Check: ${req.step.id} [${req.voter.index}/${req.voter.count}] ${req.userTask.slice(0, 50)}`
        : `Ralph Check: ${req.step.id} ${req.userTask.slice(0, 50)}`,
      // 任务消息正文只保留本次任务、检查依据、产出位置等**事实**；
      // 通用验证者角色说明走 persona 通道（唯一一份，见 VERIFIER_PERSONA）。
      prompt: [
        { type: "text", text: promptText },
      ],
      signal: req.signal,
      // persona 在子代理 scope 注册 `deployment:persona-prefix` 系统提示段 —— 角色说明的正确通道。
      persona: VERIFIER_PERSONA,
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
    // §3.2 可复盘证据之二：**验证者返回的原始输出**（解析前的原文 + stopReason + 结构化结果）。
    // 判定原文（reason）由引擎在落账时写进日志；这里额外留下解析的输入，
    // 解析逻辑本身出问题时才复盘得动（解析失败只写日志、不改判定）。
    const raw = (settled ?? {}) as { structured?: unknown; output?: unknown; stopReason?: string };
    logSafe(req, "info", "verifier_result", {
      step: req.step.id,
      checkIndex: req.checkIndex,
      stopReason: raw.stopReason ?? null,
      structured: raw.structured ?? null,
      output: typeof raw.output === "string" ? raw.output : extractText(raw.output),
    });
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