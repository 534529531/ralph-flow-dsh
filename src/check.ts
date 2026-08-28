/**
 * Ralph Flow for dsh — CHECK 验证者调度（dsh 子代理实现）
 *
 * 移植自 opencode 版 check.ts：验证者从 opencode SDK 会话改为 dsh 子代理
 * （ctx.subagents.start，in-process spawn provider）。验证者硬约束三保险：
 *   1. toolFilter 只放行只读/验证工具（read/bash/grep/glob），写入类工具不可见；
 *   2. 验证者 system prompt 沿用 DEFAULT_ADVERSARIAL_SYSTEM_PROMPT（edit 硬拒铁律）；
 *   3. 子代理会话 sandbox 目标 read-only（依赖 provider 继承配置，见 README 说明）。
 * 语义与 opencode 版字节级对齐：超时/基础设施故障/extra_dirs 校验/结果解析/事件记录。
 */
import fs from "fs";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { NormalStepDef, Engine, CheckResult, AdversarialCheckConfig } from "./engine.js";
import { DEFAULT_ADVERSARIAL_SYSTEM_PROMPT, DEFAULT_ADVERSARIAL_TIMEOUT_MS, resolveCheckModel } from "./engine.js";

export interface VoterOpts {
  /** 1-based voter index in the voting round. */
  index?: number;
  /** Total voter count. */
  count?: number;
}

export interface CheckDeps {
  ctx: Context;
  engine: Engine;
  /** 事件帧发射（tool-ralphflow/check-verdict 等） */
  emit: (instId: string, type: string, data: Record<string, unknown>) => void;
  /** 取消信号（job 生命周期 / 实例取消） */
  signal: AbortSignal;
  /** 互斥段结束时释放本组信号（可选，由 driver finally 调用） */
  dispose?: () => void;
}

// ─── 实例级取消信号注册表 ─────────────────────────────────────────────────────
//
// 每个 runCheckAndAdvance 互斥段通过 registerInstanceSignal 取得一个可 abort 的
// signal；cancel/destroyInstance 调 abortInstanceChecks 统一中止该实例所有在飞
// 验证者子代理（不再白烧 token 到超时）。

const activeControllers = new Map<string, Set<AbortController>>();

export function registerInstanceSignal(instId: string): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  let set = activeControllers.get(instId);
  if (!set) {
    set = new Set();
    activeControllers.set(instId, set);
  }
  set.add(controller);
  return {
    signal: controller.signal,
    dispose: () => {
      const cur = activeControllers.get(instId);
      if (!cur) return;
      cur.delete(controller);
      if (cur.size === 0) activeControllers.delete(instId);
    },
  };
}

/** 中止某实例的全部在飞验证（cancel / destroyInstance 时调用）。 */
export function abortInstanceChecks(instId: string): void {
  const set = activeControllers.get(instId);
  if (!set) return;
  for (const c of set) {
    try { c.abort(); } catch {}
  }
  activeControllers.delete(instId);
}

/**
 * 「还有验证者在飞吗」的统一入口：先清理孤儿登记（进程 kill -9 后 finally 不
 * 执行留下的 live 文件，否则 continue/status 会永远死等），再返回剩余数量。
 */
export function liveVerifierCount(engine: Engine, instId: string): number {
  try { engine.pruneStaleAdversarialSessions(instId); } catch {}
  return engine.readAdversarialSessions(instId).length;
}

export function abortActiveCheck(deps: CheckDeps, instId: string): void {
  // dsh 子代理取消走 AbortSignal；实例级取消由 job 层统一处理
  deps.engine.logEvent(instId, "warn", "adversarial_check_abort_requested", {});
}

export function isCheckSession(_sessionId: string): boolean {
  return false; // dsh 子代理会话由 subagent 运行时管理，无需本插件跟踪
}

/** 验证者工具白名单：只读 + 验证命令，无任何写工具 */
/**
 * 验证者工具白名单的期望集合（opencode 同名语义：只读 + 验证命令）。
 * 注意：dsh 的 tools.restrict 对未知工具名直接抛错——不同部署的全局工具集
 * 不同（本仓库验证环境只有 bash/str_replace_editor/ralphflow_*），硬编码
 * 会让验证者在启动瞬间全灭（restrict 抛错 → 全部 infra → 工作流假性暂停）。
 * 因此运行时与宿主实际工具集求交集，交集为空时退化为「排除写类工具」启发式。
 */
export const VERIFIER_TOOL_ALLOW = ["read", "bash", "grep", "glob", "read_image"] as const;

/** 与宿主实际全局工具集求交集后的验证者白名单（每次调用实时解析） */
export function resolveVerifierToolAllow(ctx: unknown): string[] {
  const preferred = [...VERIFIER_TOOL_ALLOW];
  try {
    const tools = (ctx as { tools?: { get?: (name: string, scope?: unknown) => unknown } }).tools;
    const get = tools?.get?.bind(tools);
    if (typeof get !== "function") return preferred;
    // 用 get() 逐个试探（文档确认的存在性语义），而不是 schemas()——后者在
    // 插件上下文的无参调用不保证枚举全局工具。
    const intersect = preferred.filter((n) => {
      try { return !!get(n); } catch { return false; }
    });
    if (intersect.length > 0) return intersect;
    // 工具命名体系不同（如 dsh 用 str_replace_editor 而非 read/edit）：
    // 退化为排除明显写类工具——验证者的独立性主要靠独立会话 + 对抗 prompt，
    // 工具限制是纵深防御而非唯一防线。
    const common = ["bash", "read", "view", "grep", "glob", "search", "web"];
    const fallback = common.filter((n) => {
      try { return !!get(n); } catch { return false; }
    });
    return fallback.length > 0 ? fallback : ["bash"];
  } catch {
    return preferred;
  }
}

/**
 * 模型解析：workflow 显式 → agent 配置 → 工作会话当前模型 → 全局默认。
 * dsh 版简化为：workflow 显式 → 工作会话当前模型（从 parent agent options 读取）→ 全局默认。
 */
function resolveModelForVerify(
  ctx: Context,
  parent: Agent | undefined,
  adversarialConfig?: AdversarialCheckConfig,
): { model?: string; source: "workflow" | "owner-session" | "global-default" } {
  const fromWorkflow = resolveCheckModel(adversarialConfig?.model);
  if (fromWorkflow) return { model: `${fromWorkflow.providerID}/${fromWorkflow.modelID}`, source: "workflow" };
  // 优先组合 provider/model（splitModel 依赖 "provider/model" 形态才能完整拆分，
  // 单独给 model 会丢失 provider，subagent 请求可能路由到错误 provider）。
  const opts = parent?.options;
  const p = opts?.provider;
  const m = opts?.model;
  if (p && m) return { model: `${p}/${m}`, source: "owner-session" };
  if (m) return { model: m, source: "owner-session" };
  if (p) return { model: p, source: "owner-session" };
  return { model: undefined, source: "global-default" };
}

/** 解析验证者最终文本中的通过标记与失败理由 */
export function parseVerdict(engine: Engine, text: string): { passed: boolean; reason: string } {
  const passed = engine.parseCheckResult(text);
  const reason = engine.getAdversarialCheckReason(text);
  return { passed, reason };
}

/** 把 "provider/model" 拆成 dsh 的 AgentOptions（provider + model 分字段） */
function splitModel(ref: string): { provider?: string; model?: string } {
  const idx = ref.indexOf("/");
  if (idx > 0) {
    return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
  }
  return { model: ref };
}

/**
 * 运行一个独立验证者子代理。被单验证者路径（adversarialCheck）与投票路径
 * （check-voting.ts）共用。
 *
 * 会话登记：启动时把验证者 id 写入 .adversarial-session（多票共存），结束/
 * 失败/取消时移除——jobs 与 continue/rewind 以此判定「有验证正在进行」，
 * 防止并发双重推进与误判崩溃恢复。
 */
export async function runSingleVoter(
  deps: CheckDeps,
  ownerSessionId: string | null,
  parent: Agent | undefined,
  instId: string,
  step: NormalStepDef,
  checkPrompt: string,
  userTask: string | undefined,
  adversarialConfig?: AdversarialCheckConfig,
  voter?: VoterOpts,
): Promise<CheckResult> {
  const systemPrompt = adversarialConfig?.system_prompt || DEFAULT_ADVERSARIAL_SYSTEM_PROMPT;
  const timeout = adversarialConfig?.timeout_ms || DEFAULT_ADVERSARIAL_TIMEOUT_MS;
  const { model, source } = resolveModelForVerify(deps.ctx, parent, adversarialConfig);
  const voterTag = voter && voter.count && voter.count > 1 ? ` [${voter.index}/${voter.count}]` : "";

  if (!deps.engine.instanceExists(instId)) {
    return { passed: false, reason: "工作流实例已被取消。" };
  }
  // 复用 extra_dirs 运行时校验：目录被删 → infra 错误，不计失败。
  const extraDirs = deps.engine.readExtraDirs(instId);
  const missingDirs = extraDirs.filter((d) => {
    try { return !fs.statSync(d).isDirectory(); } catch { return true; }
  });
  if (missingDirs.length > 0) {
    return { passed: false, infra: true, reason: `启动时通过 extra_dirs 声明的目录已不存在：${missingDirs.map((d) => `\`${d}\``).join("、")}。恢复该目录后运行 /ralphflow-continue 重新验证。` };
  }

  deps.engine.logEvent(instId, "info", "adversarial_check_start", {
    stepId: step.id, model: model ?? "agent-default", model_source: source, timeout_ms: timeout, extra_dirs: extraDirs, voter_index: voter?.index,
  });

  const truncate = (t: string) => (t.length > 3000 ? t.substring(0, 3000) + "…(截断)" : t);
  deps.engine.logEvent(instId, "info", "adversarial_check_prompt", { stepId: step.id, systemPrompt: truncate(systemPrompt), checkPrompt: truncate(checkPrompt), voter_index: voter?.index });

  const startTime = Date.now();
  const keepalive = setInterval(() => {
    deps.engine.logEvent(instId, "info", "adversarial_check_keepalive", { stepId: step.id, elapsed_ms: Date.now() - startTime, voter_index: voter?.index });
  }, 60_000);

  // 登记验证者会话（防并发推进的「验证进行中」标记）
  const verifierId = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${voter?.index != null ? `-i${voter.index}` : ""}`;
  deps.engine.writeAdversarialSession(verifierId, instId);

  try {
    const subagentName = adversarialConfig?.agent || "spawn";
    let resultText = "";
    let responseError: string | null = null;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    // voter 级取消：超时/异常时中止本验证者子代理（不拖到自然结束白烧 token）
    const localAbort = new AbortController();
    const onOuterAbort = () => { try { localAbort.abort(); } catch {} };
    if (deps.signal.aborted) onOuterAbort();
    else deps.signal.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const runPromise = deps.ctx.subagents.start(subagentName, {
        label: `Ralph Check: ${step.id}${voterTag} ${(userTask || "").substring(0, 50)}`,
        prompt: [
          { type: "text", text: `${systemPrompt}\n\n---\n\n${checkPrompt}` },
        ],
        ...(parent ? { parent } : {}),
        signal: localAbort.signal,
        ...(model ? { agentOptions: splitModel(model) } : {}),
        // 验证者工具白名单：只有读与验证命令，写入类工具不可见（edit 硬拒）。
        // 与宿主实际工具集求交集——restrict 对未知名直接抛错，硬编码名单会让
        // 验证者在工具命名不同的部署上全灭。
        toolFilter: { allow: resolveVerifierToolAllow(deps.ctx) },
      });
      // 败者链兜底：timer 先胜出后，runPromise 衍生链若随后 reject 无人处理
      // 会成为 unhandled rejection 拖垮宿主进程——挂一个空 catch 吞掉。
      runPromise.catch(() => {});
      // 超时竞争（与 opencode 版一致）；timer 用完即清，不悬挂到 timeout_ms
      const outcome = await Promise.race([
        runPromise.then(async (run: any) => {
          const result = await run.result;
          return { run, result };
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error("Adversarial check timeout")), timeout);
          void timeoutHandle.unref?.();
        }),
      ]);
      clearTimeout(timeoutHandle);
      const settled = outcome.result as { output?: unknown; stopReason?: string };
      if (settled.output && Array.isArray(settled.output)) {
        // SubagentResult.output 是 ContentBlock[]（{type:'text', text}），拼接文本块
        const blocks = settled.output as unknown[];
        const texts = blocks
          .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string")
          .map((b) => b.text);
        if (texts.length > 0) {
          resultText = texts.join("\n");
        } else if (blocks.length > 0) {
          const last = blocks[blocks.length - 1];
          resultText = typeof last === "string" ? last : JSON.stringify(last);
        }
      } else if (settled.output && typeof settled.output === "object") {
        resultText = JSON.stringify(settled.output);
      }
      if (settled.stopReason === "refused" || settled.stopReason === "aborted") {
        responseError = `子代理验证未完成（${settled.stopReason}）。`;
      }
    } catch (err: any) {
      clearTimeout(timeoutHandle);
      // 超时/请求异常：中止本验证者子代理，不让它在后台跑到自然结束
      try { localAbort.abort(); } catch {}
      if (deps.signal.aborted || !deps.engine.instanceExists(instId)) {
        return { passed: false, infra: true, reason: "工作流实例已被取消。" };
      }
      if (String(err.message).includes("timeout")) {
        timedOut = true;
      } else {
        responseError = err.message || String(err);
      }
    } finally {
      deps.signal.removeEventListener("abort", onOuterAbort);
    }

    if (timedOut) {
      deps.engine.logEvent(instId, "warn", "adversarial_check_timeout", { stepId: step.id, voter_index: voter?.index });
      const sourceLabel = source === "workflow" ? "工作流配置" : source === "owner-session" ? "当前会话模型" : "全局默认模型";
      const reason = `检查阶段超时（${Math.round(timeout / 60000)} 分钟）。验证耗时过长。\n\n验证者模型：\`${model ?? "agent-default"}\`（来源：${sourceLabel}）。\n\n可能原因：\n1. 验证任务本身需要更长时间——在工作流配置中增加 \`timeout_ms\`；\n2. 模型服务限流/排队——稍后重试即可；\n3. 模型指向了不可用或过慢的服务。\n\n建议：1. \`/ralphflow-status\` 查看状态；2. \`/ralphflow-continue\` 重试（不计失败）；3. \`/ralphflow-cancel\` 取消。`;
      emitVerdictSafe(deps, instId, step, voter, model, "infra", reason);
      return { passed: false, infra: true, reason };
    }
    if (responseError) {
      deps.engine.logEvent(instId, "error", "adversarial_check_request_failed", { stepId: step.id, error: responseError, voter_index: voter?.index });
      const sourceLabel = source === "workflow" ? "工作流配置" : source === "owner-session" ? "当前会话模型" : "全局默认模型";
      const reason = `验证请求失败：${responseError}\n\n验证者模型：\`${model ?? "agent-default"}\`（来源：${sourceLabel}）。\n\n这是验证基础设施的问题（额度/API/网络/配置），不是你工作成果的问题——本次不计入失败次数，已完成的工作保持原样。\n\n建议：\n- 确认模型服务可用后运行 \`/ralphflow-continue\` 直接重新验证（无需重做任务）；\n- 若反复失败，检查工作流 \`adversarial_check.model\` 或会话模型配置；\n- 或 \`/ralphflow-cancel\` 放弃。`;
      emitVerdictSafe(deps, instId, step, voter, model, "infra", reason);
      return { passed: false, infra: true, reason };
    }

    const responseText = (resultText ?? "").trim();
    if (!responseText) {
      const reason = "验证返回空响应。";
      emitVerdictSafe(deps, instId, step, voter, model, "infra", reason);
      return { passed: false, infra: true, reason };
    }

    const { passed, reason } = parseVerdict(deps.engine, responseText);
    deps.engine.logEvent(instId, "info", "adversarial_check_result", { stepId: step.id, passed, len: responseText.length, reason: reason.substring(0, 160), voter_index: voter?.index });
    emitVerdictSafe(deps, instId, step, voter, model, passed ? "pass" : "fail", reason);
    return { passed, reason };
  } finally {
    clearInterval(keepalive);
    deps.engine.removeAdversarialSession(verifierId, instId);
  }
}

/** 发射逐票 verdict 帧（三值 status）；实例已销毁时静默跳过 */
function emitVerdictSafe(
  deps: CheckDeps,
  instId: string,
  step: NormalStepDef,
  voter: VoterOpts | undefined,
  model: string | undefined,
  status: "pass" | "fail" | "infra",
  reasoning: string,
): void {
  if (!deps.engine.instanceExists(instId)) return;
  deps.emit(instId, "tool-ralphflow/check-verdict", {
    runId: instId, step: step.id, voter: voter?.index ?? 1, count: voter?.count ?? 1,
    model: model ?? "agent-default", status, reasoning,
    // 到达时刻：UI 用它减 voter-start 的 startedAt 得出该票用时
    arrivedAt: Date.now(),
  });
}

/** 单验证者路径（与 opencode 版 adversarialCheck 同签名语义） */
export async function adversarialCheck(
  deps: CheckDeps,
  ownerSessionId: string | null,
  parent: Agent | undefined,
  instId: string,
  step: NormalStepDef,
  checkPrompt: string,
  userTask: string | undefined,
  adversarialConfig?: AdversarialCheckConfig,
): Promise<CheckResult> {
  return runSingleVoter(deps, ownerSessionId, parent, instId, step, checkPrompt, userTask, adversarialConfig);
}

/** 从 dsh 上下文解析验证者 agent 的模型（默认链兜底） */
export async function readOwnerSessionModel(ctx: Context, _ownerSessionId: string | null): Promise<{ providerID: string; modelID: string } | undefined> {
  // dsh 中模型解析链由 resolveModelForVerify 处理；此处保留签名兼容
  return undefined;
}
