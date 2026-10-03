/**
 * Ralph Flow for dsh v2 — 引擎（原生 Service，无移植状态机）
 *
 * 中心定理见 docs/v2/design.md §0：
 *   T1 裁判权在独立会话 —— 判定只由 verify.port 返回（独立子代理），主会话无写入路径。
 *   T2 推进权在机械程序 —— 本文件是唯一决策点，continue 一律 fail-closed 读 verdicts。
 *
 * 状态模型：无相位（ADR-0004）。所有"阶段"都由原始事实派生：
 *   交卷了吗（do_submitted）/ 判定落地了吗（verdicts）/ 有在飞委派吗（delegations）/ 暂停了吗（paused）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import {
  MAX_VOTERS,
  decideVotingOutcome,
  formatVotingFailureReason,
  formatVotingInfraReason,
  formatVotingPassReason,
  voterProgressLine,
  voterStatusLabel,
  type VoterVerdict,
  type VoterDisplayStatus,
} from "./voting.js";
// 纯函数层（聚合优先级与三份文案）的唯一实现在 voting.ts；这里只把常量与展示标签转出去，
// 让 `lib/engine.js` 仍是「引擎 + 方言」的单一入口（verify.ts / 测试都从它取类型）。
export { MAX_VOTERS };
export { formatVotingFailureReason, formatVotingPassReason, formatVotingInfraReason, voterProgressLine, voterStatusLabel };

/**
 * 工作区内的运行时根目录。**工作区 dot-dir**（§1.8）：与 opencode `.opencode/ralph-flow/`、
 * claude `.claude/ralph-flow/` 形状一致；全局命名空间 `~/.dsh/ralph-flow/` 由
 * {@link RALPH_FLOW_NAME} 拼出，两个作用域里的插件命名空间都叫 `ralph-flow`。
 *
 * 注意：这里是**工作区相对路径**（含 `/`），`path.join(workspace, RALPH_FLOW_DIR)` 仍成立。
 */
export const RALPH_FLOW_DIR = ".dsh/ralph-flow";
/** 插件命名空间名（全局 `~/.dsh/<name>/...`）——与工作区内 `.dsh/<name>/` 对称 */
export const RALPH_FLOW_NAME = "ralph-flow";
/** 每实例产出目录的目录名（§1.7，与 opencode 同名） */
const ARTIFACTS_DIRNAME = "artifacts";

/**
 * 执行日志（JSONL）轮转参数 —— 照 opencode：单文件上限 **10 MB**、保留 **3** 份
 * （`execution.log.1` / `.2` / `.3`，最旧的删除）。见 docs/v2/execution-log-brief.md §3.3。
 *
 * 上限可注入（`EnginePorts.logMaxBytes` 或环境变量 `RALPHFLOW_LOG_MAX_BYTES`）：
 * 轮转只有把阈值压到 1 KB 才可能在测试里跑出来，硬编码常量等于这条验收不可测。
 */
export const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_LOG_ROTATIONS = 3;

// ─── 方言类型（与 opencode/claude 版共享的 YAML 方言）────────────────────────

/**
 * 验证模型的引用形态（与 opencode/claude 完全一致）：
 * - 字符串 `"provider/model"`（如 `deepseek/deepseek-chat`）
 * - 对象 `{ providerID, modelID }`（两者都必须是非空字符串）
 * **裸模型名**（如 `"sonnet"`）无法解析到 provider → 回退到默认模型（doctor 告警）。
 */
export type ModelRef = string | { providerID?: string; modelID?: string };

/**
 * 归一化模型引用（照抄 opencode `resolveCheckModel` 的语义，保证三端同一份资产同解）：
 * - 对象：`providerID` 与 `modelID` 都是非空字符串才有效，否则 `undefined`（回退）
 * - 字符串：必须在第一个 `/` 处切开且 provider 非空；**裸名 → `undefined`**
 */
export function resolveCheckModel(model: ModelRef | undefined | null): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  if (typeof model === "object") {
    const pid = model.providerID;
    const mid = model.modelID;
    if (typeof pid === "string" && pid.trim() && typeof mid === "string" && mid.trim()) {
      return { providerID: pid.trim(), modelID: mid.trim() };
    }
    return undefined;
  }
  if (typeof model !== "string") return undefined;
  const idx = model.indexOf("/");
  if (idx > 0) {
    const pid = model.slice(0, idx).trim();
    const mid = model.slice(idx + 1).trim();
    if (pid && mid) return { providerID: pid, modelID: mid };
  }
  return undefined;
}

/** 保留原始形态（字符串或对象），供 `loadWorkflow` 解析；非法类型 → undefined */
function parseModelRef(v: unknown): ModelRef | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return v as { providerID?: string; modelID?: string };
  return undefined;
}

/** 模型引用的人类可读描述（用于告警文案） */
function describeModelRef(v: ModelRef): string {
  if (typeof v === "string") return `字符串 "${v}"`;
  return `对象 {providerID: ${JSON.stringify(v.providerID)}, modelID: ${JSON.stringify(v.modelID)}}`;
}

/** YAML 值的人类可读类型（用于「必须是对象」这类告警，把写错的东西原样说清） */
function describeValueKind(v: unknown): string {
  if (Array.isArray(v)) return `列表 [${v.length} 项]`;
  if (v === null) return "空值 null";
  if (typeof v === "string") return `字符串 ${JSON.stringify(v)}`;
  if (typeof v === "boolean") return `布尔值 ${v}`;
  if (typeof v === "number") return `数字 ${v}`;
  return typeof v;
}

/**
 * `check_voting` 条目的加载期校验（照抄 opencode §3.4 的硬错误规则；措辞按本仓库风格）。
 *
 * 返回**硬错误**清单（调用方据此整份拒收定义）；可容忍的写法写进 `warnings` 并忽略：
 *   · 条目的 `model` 形态合法但解析不出 provider（裸模型名 / 对象缺字段）→ 告警 + 回退
 *     （与 `check_model` / `adversarial_check.model` **同一条口径**：本仓库对「想覆盖却配错」
 *     一律告警并回退，绝不静默，也不因为一个可回退的字段拒收整份工作流）；
 *   · 条目的 `timeout_ms` / `system_prompt` → 与 `adversarial_check` 下同名键同口径：
 *     本版本从公开契约中删除/未支持，告警并忽略（dsh 不设验证超时；验证者职责是内部定义）；
 *   · 其它未知键 → 通用告警并忽略。
 */
function validateVotingEntries(stepId: string, raw: unknown, warnings: string[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`步骤 \`${stepId}\` 的 \`check_voting\` 必须是 1-${MAX_VOTERS} 个验证者的数组（当前是${describeValueKind(raw)}）：至少要有 1 条检查依据。`);
    return problems;
  }
  if (raw.length > MAX_VOTERS) {
    problems.push(`步骤 \`${stepId}\` 的 \`check_voting\` 有 ${raw.length} 个验证者，超过上限 ${MAX_VOTERS}。`);
    return problems;
  }
  raw.forEach((e: any, i: number) => {
    const at = `\`check_voting[${i}]\``;
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      problems.push(`步骤 \`${stepId}\` 的 ${at} 不是映射（应为 {check, model?}）。`);
      return;
    }
    if (typeof e.check !== "string" || e.check.trim() === "") {
      problems.push(`步骤 \`${stepId}\` 的 ${at} 缺少非空的 \`check\`（该票专属的检查依据，必填）。`);
    }
    for (const k of Object.keys(e)) {
      if (k === "check" || k === "model") continue;
      if (k === "timeout_ms") {
        warnings.push(`步骤 \`${stepId}\` 的 ${at}.timeout_ms 本版本未支持（验证超时交给宿主 dsh 的原生看门狗），已忽略。`);
      } else if (k === "system_prompt") {
        warnings.push(`步骤 \`${stepId}\` 的 ${at}.system_prompt 已从公开契约中删除（验证者职责是 Ralphflow 的内部定义），已忽略。`);
      } else {
        warnings.push(`步骤 \`${stepId}\` 的 ${at}.${k} 本版本未支持，已忽略。`);
      }
    }
    if (e.model !== undefined && e.model !== null) {
      const parsed = parseModelRef(e.model);
      if (!parsed) {
        problems.push(`步骤 \`${stepId}\` 的 ${at}.model 类型非法（应为 "provider/model" 字符串或 {providerID, modelID} 对象）。`);
      } else if (!resolveCheckModel(parsed)) {
        warnings.push(`步骤 \`${stepId}\` 的 ${at}.model 是${describeModelRef(parsed)}，解析不出 provider/model，该票的 \`model\` 被忽略并回退（优先全局 \`adversarial_check.model\`，未设则用发起会话当前模型）（需要 "provider/model" 或 {providerID, modelID} 两个非空字符串）。`);
      }
    }
  });
  return problems;
}

export interface StepDef {
  id: string;
  desc?: string;
  do?: string;
  /**
   * **子工作流调用点**：用 `workflow:` 代替 `do:`，整步委托给另一个工作流（对齐 opencode 的
   * 「子工作流步骤」）。本实现的落地方式是**加载期静态展开**（见 {@link MAX_EXPANDED_STEPS} 与
   * `loadWorkflow`）：调用点被就地替换成子工作流的步骤，每个子步骤 id 加 `调用点id/` 前缀，
   * 子工作流的出口接到调用点的 `on_pass`。
   *
   * 这是**加载期字段**：`loadWorkflow` 返回的 `steps` 里绝不会留下它（调用点已被展开掉）。
   * 调用点只认 `id` / `desc` / `workflow` / `on_pass`（外加工作流级 `manual_step` 列表里的
   * 调用点 id = 整段子工作流跑完后停门）；其余键（`do`/`check*`/`input`/`output`/`on_fail`/
   * `max_fail_count`/`inputs`/`reset`…）一律**加载期告警并指路**，绝不静默生效。
   */
  workflow?: string;
  check?: string;
  /**
   * 多验证者投票（对齐 opencode 2.8.0 的 `check_voting`）：1–5 个验证者**并行**检查，
   * 每票只查自己那一条检查依据，**全过才放行**。与 `check` **互斥**（同写 = 加载期硬错误）；
   * 两者都不写 = 本步免验证（跳过对抗性验证）。
   *
   * 条目只有两个字段被兑现：`check`（必填）与 `model`（可选，该票专用模型）。
   * `timeout_ms` / `system_prompt` 与 `adversarial_check` 下同名键同一口径：
   * 本版本从公开契约中删除/未支持，加载期告警并忽略（见 `loadWorkflow`）。
   */
  check_voting?: CheckVotingEntry[];
  input?: string;
  output?: string;
  on_pass?: string;
  on_fail?: string;
  max_fail_count?: number;
  /**
   * 步骤级验证模型覆盖（对齐 opencode/claude 2.8.0）。
   * **仅单 `check` 场景生效**；与 `check_voting` 同写、或没有 `check` → 加载期硬错误。
   */
  check_model?: ModelRef;
  /**
   * **重置门**（`reset: true`，对齐 opencode 方言）：进入本步前，把属主会话可见面的
   * `nodes[1]` 到末尾整段替换成一条 ralphflow 自己写的**交接稿**，使模型收到的
   * messages = 系统提示 + 交接稿 + 本步 DO。
   *
   * 载体与硬约束见 `src/reset.ts` 与 `docs/v2/reset-feasibility.md`。要点：
   *   · 替换只能发生在**步骤边界的空闲窗口**（`agent.runMaintenance`，phase ≠ idle 即放弃）；
   *   · **工作流首步无法重置**：首步 DO 是 `ralphflow_start` 工具的返回值，替换会落在工具
   *     调用内部 → 孤儿 tool/result → 静默损坏会话。首步标了 `reset: true` 时启动回执会
   *     **如实说明**，重置从第二步起生效（本字段仍是合法键，不是告警忽略）。
   *   · 这只是「换入干净上下文」的载体，**不是** `/ralphflow-reset` 命令（那个仍只声明不实现）。
   */
  reset?: boolean;
}

/** 投票条目（`check_voting[i]`）：一条检查依据 +（可选）该票专用模型 */
export interface CheckVotingEntry {
  /** 该验证者**专属**的检查依据（只查这一条；非空字符串，加载期硬校验） */
  check: string;
  /**
   * 该票专用模型；不填 → 继承全局 `adversarial_check.model`，再往后是「发起会话当前模型」。
   * 形态与 {@link ModelRef} 相同：`"provider/model"` 字符串或 `{providerID, modelID}` 对象。
   */
  model?: ModelRef;
}

/**
 * `adversarial_check` 是**可选**对象，**唯一允许的字段是 `model`**。
 *
 * 验证者身份与职责是 Ralphflow 的**内部定义**（`verify.ts` 的 `VERIFIER_PERSONA`），
 * 不是工作流资产的一项配置：同一个职责不该在「Agent 名称 / 工作流提示词 / 步骤检查依据」
 * 三处重复表达。因此 `agent` / `system_prompt` / `timeout_ms` 已从公开契约中删除——
 * 它们出现在 YAML 里时 **加载期与 doctor 都告警并忽略**（warn+ignore，与未知键同一条口径，
 * 见 design §8 Q13），绝不拒收、不静默、不改作别的含义。
 */
export interface AdversarialConfig {
  /**
   * 可选：验证模型。不写 → 验证者沿用**发起会话的当前模型**（宿主
   * `resolveChildAgentOptions` 继承父级 provider/model）；写了 → 用该模型。
   * 两形态：`"provider/model"` 字符串或 `{providerID, modelID}` 对象。
   */
  model?: ModelRef;
}

/**
 * 本步是否配置了**单** `check` —— **纯函数谓词，只读 `StepDef`**（design §12.1 精修）。
 *
 * 「本步是否需要独立验证」的判据是 {@link stepHasVerification}（`check` **或** `check_voting`）：
 * 判据来自**工作流定义**（作者所有），执行者在运行期无法影响它。因此
 * 「无对抗性检查的步骤跳过验证」是**作者声明的机械推进**，不是执行者绕过裁判。
 *
 * **零新状态字段**（宪法 §10.4）：某步有没有检查是工作流定义的属性、不是运行事实，
 * 需要时现算即可 —— 绝不往 `InstanceState` 里加 `skipped_steps[]` 之类的派生量。
 */
export function stepHasCheck(step: Pick<StepDef, "check">): boolean {
  return typeof step.check === "string" && step.check.trim() !== "";
}

/**
 * 本步是否配置了**任何**对抗性检查：单 `check` 或多验证者投票（`check_voting`）。
 *
 * 这是「本步是否需要独立验证」的**唯一判据**（取代原先只看 `check` 的写法）：
 * 两者都不写 → 跳过对抗性验证（manual 步骤 = 纯人工审查）。
 */
export function stepHasVerification(step: Pick<StepDef, "check" | "check_voting">): boolean {
  return stepHasCheck(step) || voterCountOf(step) > 0;
}

/** 校验通过的投票票数（0 = 不是投票步）；上限 {@link MAX_VOTERS} 照抄 opencode */
export function voterCountOf(step: Pick<StepDef, "check_voting">): number {
  return Array.isArray(step.check_voting) ? Math.min(step.check_voting.length, MAX_VOTERS) : 0;
}

/** 本步预期落地几张判定票：投票步 = 票数；单 `check` 步 = 1；免验证步 = 0 */
export function expectedVerdicts(step: Pick<StepDef, "check" | "check_voting">): number {
  const voters = voterCountOf(step);
  if (voters > 0) return voters;
  return stepHasCheck(step) ? 1 : 0;
}

/**
 * 子工作流展开后的步骤 id 分隔符（`<调用点 id>/<子步骤 id>`，多层继续叠加）。
 *
 * 之所以是硬约束：调用点 id 与子工作流里的步骤 id **都不允许含**这个字符 —— 否则
 * `a` + `b/c` 与 `a/b` + `c` 会展开出同一个 id，展开就不再是一一对应。两处都由
 * `loadWorkflow` 在**加载期硬错误**（绝不等到运行期才炸）。
 */
export const SUBWORKFLOW_ID_SEP = "/";

/**
 * 展开后步骤总数上限（**加载期**计数，超了立刻中止展开）。
 *
 * ralphflow 面向长程工作流：2000 是「够长程」与「一次误配不会把引擎拖死」之间的取舍。
 * 计数贯穿整条调用链（子工作流被多个调用点引用时**每个调用点各算一次**，因为它会被
 * 就地展开成多份步骤）。
 *
 * 它**只管步数、不管深度**：一条每层只有调用点（自身零步骤）的链，步数可以是 1 而层数上千
 * —— 那种情况由 {@link MAX_SUBWORKFLOW_DEPTH} 拦（展开器是递归的，步数上限兜不住调用深度）。
 */
export const MAX_EXPANDED_STEPS = 2000;

/**
 * 子工作流**嵌套深度**上限（调用链层数，含最外层工作流；**加载期硬错误**）。
 *
 * 为什么必须有它：展开器是**递归**的（每层 `loadWorkflow` 一帧），而 {@link MAX_EXPANDED_STEPS}
 * 只数步骤 —— 实测「1900 个互相串联的工作流文件、每个自身零步骤」时步数只有 1，步数上限
 * 完全不触发，递归却深到把宿主 JS 调用栈打爆（`RangeError: Maximum call stack size exceeded`
 * 冒泡出 `loadWorkflow`，调用方拿到的是崩溃而不是硬错误）。本上限在**展开任何一层之前**就
 * 拒绝过深的链，保证加载器只会返回「说人话的硬错误」。
 *
 * 取值 32：opencode 的运行时深度上限是 5 层，这里比它宽松得多；而真实复用链（2–3 层）
 * 离 32 极远，所以既不会误伤正常组合，又远低于任何宿主栈上限。
 */
export const MAX_SUBWORKFLOW_DEPTH = 32;

/** 上限报错的统一标签（跨层识别用：子层报过就不再重复报） */
const CAP_TAG = "展开后步骤总数超过上限";

/** 成环报错的统一标签（跨层识别用：直接透传检测到的那一条，不再套「无法加载」） */
const CYCLE_TAG = "子工作流成环";

/** 嵌套过深报错的统一标签（同上） */
const DEPTH_TAG = "子工作流嵌套过深";

/**
 * 把调用链渲染成人话（过长时首尾保留、中间折叠）：报错里给出**可辨认**的路径，
 * 而不是把 33 个名字一股脑铺开。
 */
function formatCallChain(chain: string[], max = 6): string {
  if (chain.length <= max) return chain.join(" → ");
  const head = chain.slice(0, 3);
  const tail = chain.slice(-2);
  return `${head.join(" → ")} → …（省略 ${chain.length - head.length - tail.length} 层）→ ${tail.join(" → ")}`;
}

/**
 * 子工作流**加载期静态展开**的递归上下文（相对 opencode 的运行时状态栈方案，本实现把
 * 嵌套彻底消化在 `loadWorkflow` 里：展开后的 `steps` 就是实例看到的全部步骤，
 * `current_step` 仍是单字符串 —— **零新增 InstanceState 字段**）。
 */
export interface SubWorkflowLoadCtx {
  /** 从最外层到**当前**工作流（含）的名字链：成环检测 + 报错里说清调用路径 */
  chain: string[];
  /** 调用链上生效的验证模型（`adversarial_check.model` 逐字段继承的父级值） */
  inheritedModel?: ModelRef;
  /** 展开计数器（整条链共享一个对象，任一层的超限都会被立刻读到） */
  counter: { count: number };
}

/** 子工作流「跑完回父级」的出口占位符：展开时先占位，兄弟步骤都展开完再回填调用点的有效 on_pass */
const SUBWORKFLOW_EXIT = "\u0000subworkflow-exit";

/** 调用点 desc 与子步骤 desc 的组合（调用点被展开掉后，它的 desc 只能这样留痕） */
function composeDesc(callDesc: string | undefined, subDesc: string | undefined): string | undefined {
  const a = callDesc?.trim();
  const b = subDesc?.trim();
  if (a && b) return `${a} · ${b}`;
  return a || b || undefined;
}

/**
 * 前缀化一个子工作流的步骤：id 加调用点前缀、`on_pass`/`on_fail` 重指到展开后的 id、
 * 子工作流出口（`on_pass: done` 或末步的顺序出口）先用 {@link SUBWORKFLOW_EXIT} 占位。
 *
 * 三条重指规则（与 opencode 的「子工作流跑完回父级继续」等价，只是时机从运行期挪到加载期）：
 *   1. `on_pass` 指向子工作流内的步骤 → 前缀化；
 *   2. `on_pass: done` → 占位（= 子工作流跑完，交回调用点的 on_pass）；
 *   3. 末步没有 `on_pass`（顺序出口）→ 占位；非末步没有 `on_pass` → 顺序下一步。
 */
function prefixSubWorkflowSteps(sub: WorkflowDef, callId: string, callDesc: string | undefined): StepDef[] {
  const pre = callId + SUBWORKFLOW_ID_SEP;
  return sub.steps.map((s, i) => {
    const next = i + 1 < sub.steps.length ? sub.steps[i + 1]!.id : undefined;
    const onPass = s.on_pass !== undefined
      ? (s.on_pass === "done" ? SUBWORKFLOW_EXIT : pre + s.on_pass)
      : (next !== undefined ? pre + next : SUBWORKFLOW_EXIT);
    return {
      ...s,
      id: pre + s.id,
      desc: composeDesc(callDesc, s.desc),
      on_pass: onPass,
      // 缺省 on_fail = 自身（展开后就是带前缀的那个 id，语义不变）
      on_fail: s.on_fail ? pre + s.on_fail : undefined,
    };
  });
}

/**
 * 把生效的验证模型下沉到各步（**只在子工作流里做**，见 `loadWorkflow` 的调用点）。
 *
 * 对齐 opencode 的「`adversarial_check` 沿子工作流调用链逐字段继承」：子工作流里填了且
 * 有效的 `model` 覆盖父工作流；没填（或填了但解析不出 provider/model）就回退到父级值。
 * 静态展开后父级的 `adversarial_check.model` 是**整份定义**的兜底，不会区分层次，所以
 * 子层必须在展开时把它固化到具体步骤上：单 `check` 步 → `check_model`（本步自己的有效
 * `check_model` 优先），投票步 → 缺 `model` 的票（票自己的 `model` 优先 —— `check_model`
 * 与 `check_voting` 同写是硬错误，所以投票步只能走票条目）。
 */
function sinkVerificationModel(steps: StepDef[], model: ModelRef | undefined): void {
  if (!resolveCheckModel(model)) return;
  for (const s of steps) {
    if (Array.isArray(s.check_voting) && s.check_voting.length > 0) {
      for (const entry of s.check_voting) {
        if (!resolveCheckModel(entry.model)) entry.model = model;
      }
      continue;
    }
    if (stepHasCheck(s) && !resolveCheckModel(s.check_model)) s.check_model = model;
  }
}

/**
 * 调用点上「除 `id` / `desc` / `workflow` / `on_pass` 外」的键：一律**加载期告警并指路**
 * （不生效、不静默、不硬错误 —— 作者的本意多半是把配置写到错误的层级，指路比拒收有用）。
 *
 * 照 opencode 的方言，子工作流步骤上还允许 `input`/`output`/`inputs`/`on_fail`/
 * `max_fail_count`/`reset`；本实现**刻意**一条都不在调用点上兑现（见 design/变更说明的四条差异），
 * 所以每一条都要说清「不生效 + 该写到哪儿」（`reset` 本身**已支持**，只是必须写到子步骤上）。
 */
function callPointKeyWarning(callId: string, key: string, subName: string): string {
  const head = (what: string) => `调用点 \`${callId}\` 的 \`${key}\` 不生效：${what}`;
  switch (key) {
    case "do":
      return head(`调用点不做 DO —— 整步委托给子工作流 \`${subName}\`，子工作流的每个步骤自带 \`do\`。把这段指令写进子工作流内对应步骤的 \`do\`。`);
    case "input":
    case "output":
      return head(`\`${key}\` 只属于子工作流里的普通步骤（调用点没有 DO/CHECK 阶段）。请在子工作流内需要它的步骤上写。`);
    case "on_fail":
      return head(`子工作流内的失败由各子步骤自己的 \`on_fail\` 处理；某个子步骤耗尽 \`max_fail_count\` 会**暂停等你定夺**，不会回到调用点的 \`on_fail\`。请把 \`on_fail\` 写到子工作流内的步骤上。`);
    case "max_fail_count":
      return head(`失败预算是**步骤级**属性，请写到子工作流内需要它的步骤上（缺省 3）。`);
    case "check":
    case "check_voting":
    case "check_model":
      return head(`调用点没有 DO 阶段、不跑独立验证；验证配置属于具体步骤，请写到子工作流内需要验证的步骤上（子工作流的 \`adversarial_check.model\` 会自动下沉到它各步）。`);
    case "inputs":
      return head(`本实现的子工作流不接收参数：任务描述原样传给子工作流的每个步骤（DO 提示词的「## 任务」就是它），要传信息请写进任务描述或子步骤的 \`do\`。`);
    case "reset":
      return head(`调用点没有 DO 阶段，\`reset\` 是**步骤级**属性：请写到子工作流内需要重置的步骤上（加载期静态展开后只有子步骤存在，调用点上的键不会落进定义）。`);
    default:
      return head(`调用点只认 \`id\` / \`desc\` / \`workflow\` / \`on_pass\`（外加工作流级 \`manual_step\` 列表里的调用点 id = 整段子工作流跑完后停门），其余键一律忽略。`);
  }
}

export interface WorkflowDef {
  name: string;
  description?: string;
  /**
   * 审查门步骤（方言形态：**顶层** id 列表，与 `steps` 同级）。
   *
   * 这是审查门的**唯一**写法：步骤级 `manual_step` 键已从方言中删除，
   * 出现即加载期硬错误（`loadWorkflow`；opencode 只认列表，步骤级写法在那边
   * 会被当作「不认识的步骤键」忽略 → 人工审查门静默消失）。
   */
  manual_step?: string[];
  adversarial_check?: AdversarialConfig;
  steps: StepDef[];
  warnings: string[];
}

export type VerdictStatus = "passed" | "failed" | "infra";

export interface Verdict {
  check_index: number;
  status: VerdictStatus;
  reason: string;
  agent_id?: string;
  step_id: string;
  ts: string;
}

export interface Delegation {
  run_id: string;
  agent_id?: string;
  check_index: number;
  /**
   * 本笔委派属于第几轮投票（`1` = 首轮；`2` = 某票 infra 后的**自动重试轮**）。
   *
   * 这是**原始事实**（这一笔委派到底是第几次跑），不是派生量：聚合时要靠它区分
   * 「首轮 infra → 自动重试一次」与「重试仍 infra → 暂停」（照抄 opencode 的重试预算，
   * 见 `check-voting.ts` §4.4）。单 `check` 步骤不写该字段（省略 = 首轮）。
   */
  attempt?: number;
  ts: string;
  /**
   * 属主运行时 id（`<pid>-<装载时刻>-<rand>`）：**只作诊断**，不参与判活。
   *
   * 为什么不用 pid 判活（第一版就是这么写的，被实测打回）：本部署里各 agent 进程跑在
   * 各自的 sandbox 里，有**独立的 PID namespace 与 /proc 视图** —— 实测宿主进程
   * `pid 919449` 明明活着，另一个进程（验证者的沙箱）`kill(919449, 0)` 拿到 `ESRCH`、
   * `/proc/uptime` 也对不上，于是把活着的属主判成死的，照样把在飞验证清掉。
   * 跨沙箱唯一可靠共享的是**文件系统**，所以判活改用心跳（见下）。
   */
  owner_runtime?: string;
  /**
   * 属主心跳时刻（epoch ms）—— **判孤儿的唯一依据**：属主在等判定期间每
   * {@link DELEGATION_HEARTBEAT_REFRESH_MS} 刷一次；超过 {@link DELEGATION_HEARTBEAT_TTL_MS}
   * 没刷 = 属主已经不在了（进程崩溃/被重启），判定永远回不来。
   *
   * 缺这个字段 = 来源不可考的老 `state.json`（或旧版插件落的账）→ 按孤儿兜底。
   */
  heartbeat_at?: number;
}

// ─── 孤儿委派的判据：属主运行时是否还活着 ────────────────────────────────────
//
// 「孤儿委派」= 发起这笔验证的**运行时已经不在了**（进程退出 / 宿主重启），判定永远
// 回不来，所以 `restore()` 必须兜住它（暂停 check_infra 等用户定夺，不隐式继续）。
//
// 反面同样重要：属主**还活着**的委派绝不是孤儿。这里曾经无条件清空所有 `delegations`
// —— 于是**别的会话**碰一下 ralphflow（哪怕是 `/ralphflow-list` 这种只读的：新建引擎
// → restore）就会把正在飞的验证连根拔掉并暂停实例，验证白烧、用户被迫手动 resume
// （实测两次，state.json 里 15:59:45 / 16:18:24 的 orphan_delegation_recovered）。
//
// 判活必须跨进程、跨 sandbox 都成立 —— 只有文件系统是共享的，所以用**心跳**：
// 属主在等在飞判定期间按周期刷新 `delegations[i].heartbeat_at`，别的运行时（别的会话、
// 别的 sandbox、插件重载后的新实例）看到心跳还新鲜就绝不碰它；心跳停了才是真孤儿。
//
// 判据与「谁在调用 restore」无关，所以同一进程里多少会话、跨多少沙箱、重载多少次，
// 都不会互相踩；而真正死掉的属主留下的委派照样兜得住（TTL 之后由下一个 restore 触发点，
// 或用户显式 /ralphflow-continue 兜住）。

/** 在飞委派的心跳周期：属主每隔这么久把 `heartbeat_at` 刷新一次 */
export const DELEGATION_HEARTBEAT_REFRESH_MS = 5_000;

/**
 * 心跳多久没刷就算属主失联（= 真孤儿）。
 *
 * 取 12 倍刷新周期：既容忍属主事件循环偶发卡顿（一次两次没刷上不算死），又让崩溃留下的
 * 孤儿在一个 TTL 之内被兜住 —— 崩溃恢复没有缩水，只是判据从「pid 还在吗」换成「心跳还在吗」。
 */
export const DELEGATION_HEARTBEAT_TTL_MS = 60_000;

/** 本进程的运行时 id（**只作诊断**，不参与判活；pid 在跨沙箱场景里没有可比性） */
let cachedRuntimeId: string | undefined;
export function runtimeId(): string {
  if (cachedRuntimeId === undefined) {
    cachedRuntimeId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return cachedRuntimeId;
}

/** 一笔委派是否仍有存活属主 —— `restore()` 的唯一判据（导出供测试直接取证）。 */
// ralphflow:orphan-liveness
export function delegationOwnerAlive(d: Delegation): boolean {
  return typeof d.heartbeat_at === "number" && Number.isFinite(d.heartbeat_at)
    && Date.now() - d.heartbeat_at <= DELEGATION_HEARTBEAT_TTL_MS;
}

export interface HistoryEntry {
  ts: string;
  step?: string;
  event: string;
  detail?: string;
}

/**
 * §1.4 每步耗时与重试次数：**全部从 `history` 的 `ts` 与 `fail_counts` 派生**
 * （不新增落盘字段）。纯函数，便于用合成 history 直接验证。
 *
 * 耗时区间 = 属于某步的**第一条**历史事件 → 下一条属于其它步骤的事件（或 `endTs`）；
 * 同一被反复进入的步骤（返工/回退）累计总时长。
 *
 * ⚠️ 这里曾经有一个只在「步骤切换」时才结算的实现：最后一步的耗时被算成
 * `endTs - 该步最后一条事件`，而最后一条事件（`complete`）与 `endTs` 只差几毫秒
 * —— 于是**每一步都显示 `耗时 0s`**（实测：6m22s 的一轮报告成 0s，历史上每一份
 * 归档报告都是 0s）。区间起点必须是该步的**首条**事件，不是末条。
 *
 * 重试次数 = `max(fail_counts[step], 该步 verdict_failed 条数)`：
 * 通过时 `clearFailCount` 会把该步计数清零、恢复暂停时也会清零，所以单看
 * `fail_counts` 会把「先失败几次再通过」记成 0 轮 —— 必须同时从 history 兜底。
 */
export function stepStats(
  history: HistoryEntry[],
  failCounts: Record<string, number> | undefined,
  endTs: number,
): Array<{ step: string; ms: number; retries: number }> {
  const acc = new Map<string, { ms: number; order: number; failed: number }>();
  let order = 0;
  let current: string | undefined;
  let firstTs: number | undefined;
  const ensure = (step: string) => {
    let v = acc.get(step);
    if (!v) { v = { ms: 0, order: order++, failed: 0 }; acc.set(step, v); }
    return v;
  };
  /** 结算当前步：区间起点是它的**首条**事件 */
  const close = (until: number) => {
    if (current !== undefined && firstTs !== undefined) ensure(current).ms += Math.max(0, until - firstTs);
  };
  for (const h of history) {
    const step = h.step;
    if (!step) continue;
    const t = new Date(h.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (step !== current) { close(t); current = step; firstTs = t; }
    if (h.event === "verdict_failed") ensure(step).failed += 1;
  }
  close(endTs);
  return [...acc.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([step, v]) => ({ step, ms: v.ms, retries: Math.max(failCounts?.[step] ?? 0, v.failed) }));
}

export interface InstanceState {
  active: boolean;
  workflow_name: string;
  current_step: string;
  user_task: string;
  /**
   * **每步**失败轮数（原始事实，落盘）。
   * 为什么必须按步记：`max_fail_count` 是**步骤级**属性，而 `on_fail` 可回退到更早步骤
   * （内置 spec.yaml 的 verify→implement 就是）。单一标量会让被回退到的步骤继承前一步的
   * 失败数 → 它自己第一次失败就触发上限（提前暂停）；反过来若回退时清零，成环的 on_fail
   * 又永远累积不到上限 → 无限 ping-pong。按步记同时解决两者。
   */
  fail_counts: Record<string, number>;
  /**
   * 当前步的失败轮数。**派生量，不落盘**（宪法 §10.4）：
   * 由 `readState` 从 `fail_counts[current_step]` 算出，仅作读取便利；`writeState` 会剔除它。
   */
  fail_count: number;
  paused: boolean;
  pause_reason?: "max_failures" | "check_infra" | "user_cancelled" | "no_submit";
  /** 本轮 DO 是否已交卷（引擎观测到的事实） */
  do_submitted: boolean;
  owner_session?: string;
  /** 交卷时的助手回复摘要（验证者 prompt 用） */
  last_submit_summary?: string;
  /**
   * 本实例产出目录的**目录名**（`artifacts/<artifacts_dir_name>/`）。
   *
   * **不是派生量**（宪法 §10.4 的例外有据）：将来子工作流会改写 `user_task`，
   * 名字一旦落盘就无法事后重算；且它必须与实例目录同生共死地隔离。
   * 启动时由 {@link makeArtifactsDirName} 固定。
   *
   * 缺该字段（老 `state.json`）→ 读取时回退 `instId`（向后兼容，老产出目录名不变）。
   */
  artifacts_dir_name?: string;
  delegations: Delegation[];
  verdicts: Verdict[];
  history: HistoryEntry[];
  started_at: string;
  updated_at: string;
}

export interface InstanceInfo {
  id: string;
  state: InstanceState;
}

/**
 * 一条**已归档运行**的历史条目（从 `reports/*.md` 的头部字段解析而来）。
 *
 * 解析失败的报告**也列出来**（`parsed: false`、`statusLabel: "无法解析"`），
 * 绝不静默丢弃——用户至少能看到「这里有个报告，我没读懂」。
 */
export interface HistoryInfo {
  id: string;
  parsed: boolean;
  statusLabel: string;
  task?: string;
  startedAt?: string;
  endedAt?: string;
  /** 工作区相对报告路径（正斜杠） */
  relPath: string;
  /** 报告里登记的产出目录名（用于「孤儿产出」诊断；老报告可能没有） */
  artifactsDirName?: string;
  /** 报告标题里的工作流名（可选，仅用于展示） */
  workflow?: string;
}

export interface WorkflowEntry {
  name: string;
  desc: string;
  invalid: boolean;
  problems: string[];
  warnings: string[];
}

export interface ToolResult {
  ok: boolean;
  text: string;
}

/** reset 门的投递物：交接稿（模型可见）+ 给用户看的可见告知（随后被遮蔽，只留给 Chat 视图）。 */
export interface ResetRequest {
  /** 交接稿正文：替换后**系统提示之外唯一**的模型可见内容。 */
  handoff: string;
  /** 可见告知：append 来源（Chat 显示），随后被同一次替换遮蔽（模型看不到）。 */
  notice: { summary: string; text: string };
  /**
   * 动手前的**最后一道复查**（在 maintenance job 内、紧邻 append 之前同步调用）：
   * 实例在「等空闲窗口」这段时间里可能已被取消/收摊，那就**不做替换**。
   *
   * 必须是「重新读盘」的实现，不能闭包一个内存快照 —— 取消/完成走的是另一条 `readState`
   * （每次 JSON.parse 新对象）并会销毁实例目录，快照永远看不到（实测踩过：护栏成了空操作）。
   */
  canProceed?: () => boolean;
}

/**
 * reset 门的执行结果。**失败绝不抛**：引擎据此如实播报并**照常投递 DO**——
 * 「没换成」不能演变成「本步无法执行」。
 */
export interface ResetOutcome {
  ok: boolean;
  /** 失败原因（ok=false 时给出；引擎翻成人话写进播报，绝不静默） */
  reason?: "no_session" | "no_maintenance" | "surface_too_short" | "unbalanced" | "balance_error" | "aborted" | "not_idle" | "instance_gone" | "maintenance_failed";
  /** 诊断补充（宿主异常原文） */
  detail?: string;
  /** 被遮蔽的节点数（ok=true 时给出） */
  shadowed?: number;
  /** 交接稿节点 seq（ok=true 时给出） */
  handoffSeq?: number;
  /** 可见告知节点 seq（ok=true 时给出） */
  noticeSeq?: number;
}

/** 引擎对外的两个端口：向属主会话投递指令 / 委派独立验证者（T1 的唯一入口） */
export interface EnginePorts {
  /**
   * 把指令投递给主会话（插件消息 + 唤醒）。
   * `summary` 是给**用户看**的一行摘要：dsh 客户端按 `source.form === "notice"` + `summary`
   * 渲染成不展开就能读的 notice 行；省略则退化为不显眼的 opaque 注入行（用户看不到）。
   * 凡是用户应当知道的播报都必须传 summary。
   */
  deliver: (sessionId: string, text: string, summary?: string) => boolean;
  /**
   * reset 门（步骤标了 `reset: true`）的载体：把属主会话可见面 `nodes[1]` 到末尾整段替换成
   * `req.handoff`。**必须**在步骤边界的空闲窗口内完成（宿主侧用 `agent.runMaintenance` 钉死），
   * 失败就如实返回 `ok:false`（引擎照常投递 DO）。
   *
   * 缺省（未装配）时带 `reset: true` 的步骤**不重置**，但启动/推进回执会如实标注——绝不假装做过。
   */
  resetSurface?: (sessionId: string, req: ResetRequest) => Promise<ResetOutcome>;
  /** 委派独立验证者，返回判定（绝不接受主会话提供的判定） */
  verify: (req: VerifyRequest) => Promise<Verdict>;
  log?: (level: "info" | "warn" | "error", event: string, data?: unknown) => void;
  /**
   * 执行日志（JSONL）单文件上限（字节）。**测试注入口**（轮转只有注入小阈值才可验证）；
   * 缺省 10 MB，也可用环境变量 `RALPHFLOW_LOG_MAX_BYTES`（正整数）覆盖。
   * 它不是状态、不落盘到 `state.json`——只影响 append 前的轮转判据。
   */
  logMaxBytes?: number;
}

export interface VerifyRequest {
  instId: string;
  step: StepDef;
  workflow: WorkflowDef;
  userTask: string;
  ownerSession?: string;
  checkIndex: number;
  /**
   * 多验证者投票（`check_voting`）：本票的**专属检查依据**与序号。
   *
   * 有它 ⇒ 验证者提示词走**投票变体**（共享上下文 + 该票依据 + 「你是 N 个之一，只查自己
   * 这一条」约束，照抄 opencode `buildVotingCheckPrompt`）；没有它 ⇒ 单 `check` 步骤，
   * 检查依据取 `step.check`。**执行的判定只由 ports.verify 的返回决定**（T1），这里只传事实。
   */
  voter?: { index: number; count: number; check: string };
  /**
   * 本实例产出目录的**工作区相对路径**（§1.7，正斜杠）。
   * 验证者继承父会话工作区，因此用它就能读到 DO 的产出；CHECK 提示词据此注入「产出目录」。
   */
  artifactsRelDir: string;
  /**
   * 已归一化的验证模型（优先级：步骤 `check_model` > 全局 `adversarial_check.model`）。
   * 归一化在**引擎**里做（`resolveCheckModel`），验证者只消费结果——与 opencode 的
   * `resolveVerifierModel` 同构，保证三端同一份资产解析出同一个模型。
   * `undefined` = **不传 `agentOptions`**，由宿主 `resolveChildAgentOptions` 让子代理
   * 继承**父级** provider/model——即发起会话的当前模型（不是 provider/部署默认）。
   */
  model?: { providerID: string; modelID: string };
  /**
   * 取消句柄（dsh 委派契约要求的 "caller's cancellation"；不是超时预算）
   *
   * 注意这里**没有** `submitSummary`：执行者的交卷自述**不进验证者视野**（T1）。
   * opencode 与 claude 版都从不把自述传给验证者，并在提示词里明令"不要依赖任何外部
   * 提供的实现总结"。验证者的职责是**只看结果是否满足检查依据，不管执行者怎么做的**。
   * 交卷自述仍留在 `state.last_submit_summary`，但只服务于审查门改稿重交去重
   * （见 `onSubmit`），不再流向验证者。
   */
  signal: AbortSignal;
  /**
   * 执行日志（JSONL）写入端口 —— **验证者取证证据的入口**（§3.2）：
   * `verify.ts` 用它记下**发给验证者的提示词原文**与**验证者返回的原始输出**，
   * 好让「验证者为什么判错」在事后复盘得动（截断的日志排查时等于没有）。
   *
   * 由引擎提供，实例 id 已绑定；**写失败绝不影响验证**（引擎侧只告警不抛，这里调用方也
   * 各自兜底）。它不携带任何判定语义 —— 判定仍只走 `ports.verify` 的返回值（T1）。
   */
  logEvent?: (level: "info" | "warn" | "error", event: string, extra?: Record<string, unknown>) => void;
}

// ─── 引擎 ────────────────────────────────────────────────────────────────────

/**
 * §1.2 doctor lint：对**已通过硬校验**的工作流做可达性 / 收尾 / 模板 / 无检查告警
 * （对齐 opencode 的 `lintWorkflow`，但按我们的推进规则计算：`on_pass` 缺省 = 顺序下一步）。
 *
 * 这些是「引擎只在运行时才暴露、甚至永远不暴露」的问题：
 *   · 不可达步骤静默不执行；
 *   · 没有可达步骤能到 `done` → 工作流永远不完成（旧版 doctor 还报 ✅，运行时无限循环）；
 *   · 未解析的 `{{...}}` 原样进入提示词；
 *   · 非 manual 步没写 check → 该步**跳过对抗性验证**、直接推进（必须让作者知道）。
 */
export function lintWorkflow(steps: StepDef[], manual: Set<string>): string[] {
  const warnings: string[] = [];
  if (steps.length === 0) return warnings;
  const byId = new Map(steps.map((s) => [s.id, s]));
  /** 与 nextStepId 同规则：on_pass 缺省 = 顺序下一步（末步 = done） */
  const passTarget = (s: StepDef): string => {
    if (s.on_pass) return s.on_pass;
    const i = steps.findIndex((x) => x.id === s.id);
    return i >= 0 && i + 1 < steps.length ? steps[i + 1]!.id : "done";
  };
  // 可达性：入口是 steps[0]，边 = on_pass/on_fail（on_fail 缺省指自身，不新增节点）。
  const reachable = new Set<string>();
  const queue = [steps[0]!.id];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const s = byId.get(id);
    if (!s) continue;
    const pass = passTarget(s);
    if (pass !== "done") queue.push(pass);
    queue.push(s.on_fail ?? s.id);
  }
  const unreachable = steps.filter((s) => !reachable.has(s.id)).map((s) => s.id);
  if (unreachable.length > 0) {
    warnings.push(`步骤 ${unreachable.map((s) => `\`${s}\``).join("、")} 从入口（steps 的第一项）沿 on_pass/on_fail 不可达，永远不会执行。`);
  }
  if (!steps.some((s) => reachable.has(s.id) && passTarget(s) === "done")) {
    warnings.push("没有任何可达步骤的 `on_pass` 为 `done`，工作流永远无法正常完成（会一直循环）。");
  }
  // 未解析的模板变量：本版本**不解析任何** `{{...}}` 记号（产出目录会自动注入提示词，不需要记号）。
  for (const s of steps) {
    for (const field of ["desc", "do", "check", "input", "output"] as const) {
      const text = s[field];
      if (typeof text !== "string") continue;
      for (const m of text.matchAll(/\{\{[^{}]*\}\}/g)) {
        warnings.push(`步骤 \`${s.id}\` 的 ${field} 含模板变量 ${m[0]}，引擎不会解析（本版本不提供模板记号；产出目录本就会自动注入 DO/CHECK 提示词）。`);
      }
    }
  }
  // 无对抗性检查的步骤（无 `check` 也无 `check_voting`）**跳过对抗性验证**（与 opencode 对齐）：
  //   · 非 manual 步 → DO 完成后直接进入下一步，不会被独立验证 —— 作者必须知道（告警）；
  //   · manual 步 → 纯人工审查是**刻意的默认**，不是问题（不告警）。
  // 通用兜底配方已随本语义退役（见 verify.ts buildCheckPrompt），文案不得再提它。
  for (const s of steps) {
    if (!stepHasVerification(s) && !manual.has(s.id)) {
      warnings.push(`步骤 \`${s.id}\` 未配置对抗性检查（无 \`check\`/\`check_voting\`），DO 完成后直接进入下一步，不会被独立验证。`);
    }
  }
  // 投票配置的 lint（硬错误已在加载期拦截，这里只报已通过校验但仍可优化的写法）——
  // 照抄 opencode §3.5：单票且没配模型 = 等同单验证者，建议直接用 check 或配多视角。
  for (const s of steps) {
    const entries = s.check_voting;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    if (entries.length === 1 && !entries[0]?.model) {
      warnings.push(`步骤 \`${s.id}\` 的 \`check_voting\` 只有 1 个验证者且未指定 \`model\`：等同单验证者，建议直接用 \`check\` 或配多视角/多模型。`);
    }
  }
  return warnings;
}

/** 人类可读时长（报告用）：`45s` / `3m12s` / `1h05m` */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "未知";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m${total % 60}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * 产出目录名 = 任务摘要 slug + 实例 id 尾段（照 opencode `makeArtifactsDirName` 语义）。
 *
 * 三条不可退让的细节：
 *   1. **按码点截断**（`Array.from`）：普通 `slice()` 会把代理对切成半个 UTF-16 单元，
 *      落成目录名时变成 U+FFFD —— 提示词里的名字与磁盘上的真实目录就指到两个地方。
 *      先截断再 trim `-`：截断本身可能暴露一个尾随 `-`。
 *   2. **剥掉路径分隔符与 `.`**：slug 可能来自任意用户任务，绝不能让 `..`、`/`、`\`
 *      把产出目录带出 `artifacts/`。
 *   3. 尾段只取 instId 最后一段：同一任务并发跑时 slug 相同、尾段不同 → 不互相覆盖。
 *
 * slug 为空（任务全是空白/被剥字符）→ 直接回退整个 `instId`（保证目录名非空且唯一）。
 */
export function makeArtifactsDirName(task: string, instId: string): string {
  const slug = Array.from(
    String(task || "").trim()
      .replace(/\s+/g, "-")
      .replace(/[\\/:*?"'`<>|.$&(){}[\];!#~^]/g, ""),
  ).slice(0, 30).join("").replace(/^-+|-+$/g, "");
  const suffix = String(instId).split("-").pop() || "0";
  return slug ? `${slug}-${suffix}` : String(instId);
}

/** 内置工作流文件（不落盘，只存在于插件目录；lib/engine.js → ../workflows/<name>.yaml） */
export function builtinWorkflowPath(name: string): string | undefined {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(here, "..", "workflows", `${name}.yaml`),
    path.resolve(here, "..", "..", "workflows", `${name}.yaml`),
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

/** 全局工作流目录：`<DSH_HOME|~/.dsh>/ralph-flow/workflows` */
export function globalWorkflowsDirOf(): string {
  const configured = process.env.DSH_HOME;
  const dshHome = configured && path.isAbsolute(configured) ? path.resolve(configured) : path.join(os.homedir(), ".dsh");
  return path.join(dshHome, RALPH_FLOW_NAME, "workflows");
}

/**
 * 只读某个工作区（+ 全局目录 + 内置）里**全部工作流的名字与描述** —— 不建引擎、不建任何目录。
 *
 * 动态快捷命令 `/ralphflow-<名字>` 在插件加载时登记，而引擎是按工作区**惰性**创建的
 * （首个工具调用才建）。只靠引擎的话，用户在新工作区里第一次打开会话时，自己建的工作流
 * 还没有快捷命令。这个函数让登记可以在 `session/created` 时廉价完成（纯读目录）。
 *
 * **必须包含内置工作流**（`loop`/`spec`）——它们不落盘，只存在于插件目录，漏掉就会让
 * `/ralphflow-loop`、`/ralphflow-spec` 消失。工作区里的同名文件遮蔽内置（有意行为）。
 */
export function listWorkflowsIn(workspace: string): Array<{ name: string; desc: string }> {
  const found = new Map<string, string>(); // name → 文件路径（工作区优先，其次全局，最后内置）
  for (const dir of [path.join(workspace, RALPH_FLOW_DIR, "workflows"), globalWorkflowsDirOf()]) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/\.ya?ml$/i.test(f)) continue;
      const name = f.replace(/\.ya?ml$/i, "");
      if (!found.has(name)) found.set(name, path.join(dir, f));
    }
  }
  for (const name of BUILTIN_WORKFLOWS) {
    if (found.has(name)) continue;
    const p = builtinWorkflowPath(name);
    if (p) found.set(name, p);
  }
  return [...found].map(([name, file]) => {
    let desc = "";
    try {
      const doc = yaml.load(fs.readFileSync(file, "utf-8")) as { description?: unknown } | null;
      if (doc && typeof doc === "object" && typeof doc.description === "string") desc = doc.description;
    } catch {}
    return { name, desc };
  });
}

export function createEngine(projectDir: string, ports: EnginePorts) {
  const root = path.join(projectDir, RALPH_FLOW_DIR);
  const instancesDir = path.join(root, "instances");
  const workflowsDir = path.join(root, "workflows");
  const reportsDir = path.join(root, "reports");
  const artifactsDir = path.join(root, ARTIFACTS_DIRNAME);
  // 全局工作流目录仍是 `~/.dsh/ralph-flow/workflows`（插件命名空间在全局与工作区同名）
  const globalWorkflowsDir = globalWorkflowsDirOf();
  /**
   * 实例 → 在飞取消信号集合（取消/重开/暂停时中止验证者，不白烧 token）。
   *
   * **一实例一个集合**而不是一个句柄：多验证者投票时同一实例会同时有 N 笔在飞委派，
   * 只存一个会把先发的那 N-1 笔漏掉（取消/重开时止不住，白烧 token 且留下孤儿）。
   */
  const aborts = new Map<string, Set<AbortController>>();
  function addAbort(instId: string, controller: AbortController): void {
    let set = aborts.get(instId);
    if (!set) { set = new Set(); aborts.set(instId, set); }
    set.add(controller);
  }
  function dropAbort(instId: string, controller: AbortController): void {
    const set = aborts.get(instId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) aborts.delete(instId);
  }
  /** 中止某实例下**所有**在飞验证者（一次只该由一个入口调用：取消 / 重开审查门） */
  function abortInstance(instId: string): number {
    const set = aborts.get(instId);
    if (!set) return 0;
    const n = set.size;
    for (const c of set) { try { c.abort(); } catch {} }
    aborts.delete(instId);
    return n;
  }

  // ─── 在飞委派的心跳（跨 sandbox 的判活机制，见 delegationOwnerAlive）──────────
  //
  // 属主在等判定期间每 DELEGATION_HEARTBEAT_REFRESH_MS 把 `state.json` 里的
  // `heartbeat_at` 刷一次。别处（别的会话 / 别的沙箱进程 / 重载后的新实例）据此判断
  // 「这笔委派还有人在等判定」还是「属主已经不在了」。跨进程唯一共享的是文件系统，
  // 所以心跳写在实例的 state.json 里，不引入第二个事实源。
  /** 定时器：key = `instId\0runId` */
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  const beatKey = (instId: string, runId: string) => `${instId}\u0000${runId}`;

  /**
   * 让一笔在飞委派保持「活着」。每次刷新前**重读 state**：委派没了（判定落地/作废/取消/
   * 推进）或实例没了（已销毁）就自行停表 —— 绝不在实例销毁后把目录写回来。
   */
  function startHeartbeat(instId: string, runId: string): void {
    const key = beatKey(instId, runId);
    if (heartbeats.has(key)) return;
    const timer = setInterval(() => {
      // 心跳与「判定落账」写的是**同一份 state.json**（读-改-写）。本进程内这两段都是
      // 同步块（readFileSync/writeFileSync），不会交错；共用实例锁是**按构造的护栏**：
      // 多验证者投票时 N 份心跳 + N 笔判定同时活跃，将来任何一处引入 await（异步落盘、
      // 重试）都不会退化成互相覆盖（判定被旧快照写回去 = 票凭空消失、卡在「验证中」）。
      void withStateLock(instId, () => {
        try {
          const fresh = readState(instId);
          const d = fresh?.delegations.find((x) => x.run_id === runId);
          if (!fresh || !fresh.active || !d) { stopHeartbeat(instId, runId); return; }
          d.heartbeat_at = Date.now();
          writeState(fresh, instId);
        } catch (e) {
          log("warn", "delegation_heartbeat_failed", { instId, runId, error: msg(e) });
        }
      });
    }, DELEGATION_HEARTBEAT_REFRESH_MS);
    // 心跳不该拖住进程退出
    (timer as unknown as { unref?: () => void }).unref?.();
    heartbeats.set(key, timer);
  }

  function stopHeartbeat(instId: string, runId: string): void {
    const key = beatKey(instId, runId);
    const t = heartbeats.get(key);
    if (t) { clearInterval(t); heartbeats.delete(key); }
  }

  /** 把某实例下所有在飞委派的心跳停掉（兜底清理：判定落地、孤儿恢复、取消…） */
  function stopHeartbeatsOf(instId: string, delegations: readonly Delegation[]): void {
    for (const d of delegations) stopHeartbeat(instId, d.run_id);
  }

  // ─── 单根：一个引擎只服务一个工作区 ────────────────────────────────────────
  //
  // 这里曾有一个「全局实例索引」（`~/.dsh/ralphflow-instances-index.json`）把 instId
  // 映射到工作区，好让**一个**引擎服务多个工作区。那是 dsh 版独有的复杂度，也正是
  // 「写入看会话工作区、读取看进程 cwd」这类缺陷的来源：引擎的 `projectDir` 是 dsh
  // 进程的 cwd，而实例资产落在会话工作区，真实 GUI 里两者必然不同（实测 `dsh web`
  // 的 cwd = `/home/yj`，会话工作区 = `/home/yj/ralph-flow-dsh`）—— 于是自定义工作流
  // 加载不到、历史列表永远是空的、doctor 看不见残留。
  //
  // 现在引擎**按工作区实例化**（见 `index.ts` 的 `engineFor`），这正是 opencode 版的
  // 形状（它的插件是「每个项目目录一个实例」，见其 `engine.ts:9`）。所有路径只有一根，
  // 索引、`workspaceOf()` 的回落、跨工作区联合扫描一并删除。

  /**
   * 每实例产出目录（§1.7）：`<workspace>/.dsh/ralph-flow/artifacts/<artifacts_dir_name>/`。
   *
   * 目录名来自 `state.artifacts_dir_name`（缺省回退 `instId`，兼容老 `state.json`）。
   * 注意：销毁流程必须**先**解析出这个路径，再删实例目录（不变量 3）。
   */
  function artifactsDirOf(instId: string): string {
    return path.join(artifactsDir, artifactsDirNameOf(instId));
  }

  /** 产出目录的目录名：`state.artifacts_dir_name`，缺省回退 `instId`（向后兼容） */
  function artifactsDirNameOf(instId: string): string {
    const s = readState(instId);
    const n = s?.artifacts_dir_name;
    return typeof n === "string" && n.trim() ? n : instId;
  }

  /**
   * 产出目录的**工作区相对路径**（正斜杠，可嵌进 DO/CHECK 提示词）。
   * 验证者继承父会话工作区，所以这个路径对它同样可读。
   */
  function artifactsRelDirOf(instId: string): string {
    return `${RALPH_FLOW_DIR}/${ARTIFACTS_DIRNAME}/${artifactsDirNameOf(instId)}`;
  }

  /** 报告的**工作区相对路径**（完成/取消消息、历史列表、状态查询共用同一份事实） */
  function reportRelPathOf(instId: string): string {
    return `${RALPH_FLOW_DIR}/reports/${instId}.md`;
  }

  // ─── 执行日志（JSONL，docs/v2/execution-log-brief.md）───────────────────────
  //
  // 与 `state.json` **同目录**的 append-only 文件事实：不是状态，不落任何 InstanceState
  // 字段（§3.5）。它是给机器（grep / jq）看的完整事件流，与人类可读的报告分工不重叠
  // （§1：报告不抄日志、日志不倒报告内容）。三条硬规则：
  //   · 轮转照 opencode（上限 10 MB / 保留 3 份），阈值可注入（测试压到 1 KB）；
  //   · 写日志的任何异常**只告警、绝不抛出**（§3.4）：不中断工作流、不改变推进判定；
  //   · 实例目录不存在（已销毁）时**直接返回**——绝不 mkdir 把实例目录复活成幽灵
  //     （与 `writeState` 的「销毁后不再写」同一纪律）。

  /** 单文件上限：显式端口 > 环境变量 > 缺省 10 MB（只有正数才算数） */
  function resolveLogMaxBytes(v: unknown): number {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
    const env = Number(process.env.RALPHFLOW_LOG_MAX_BYTES);
    if (Number.isFinite(env) && env > 0) return Math.floor(env);
    return MAX_LOG_SIZE_BYTES;
  }
  const logMaxBytes = resolveLogMaxBytes(ports.logMaxBytes);

  /** 运行期日志（随实例目录销毁） */
  const logFileOf = (instId: string): string => path.join(instanceDir(instId), "execution.log");
  /** 归档日志（随报告一起永久保留） */
  const archivedLogOf = (instId: string): string => path.join(reportsDir, `${instId}-execution.log`);

  /** 只写插件的 `log()` 端口（诊断），吞掉端口自身抛出的异常 */
  const logToPort = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    try { ports.log?.(level, event, data); } catch {}
  };

  /**
   * 轮转（照 opencode 在 append **之前**判）：当前文件达到上限 →
   * `.1`（`.1→.2`、`.2→.3`，`.3` 删除）。rename/rm 失败都在这里吞掉：
   * 真写不进去由 append 的 catch 统一兜（只告警），轮转本身绝不抛。
   */
  function rotateLogIfNeeded(file: string): void {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < logMaxBytes) return;
    try { fs.rmSync(`${file}.${MAX_LOG_ROTATIONS}`, { force: true }); } catch {}
    for (let i = MAX_LOG_ROTATIONS - 1; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
    }
    try { fs.renameSync(file, `${file}.1`); } catch {}
  }

  /**
   * 追加一行 `{ ts, level, event, instId, ...extra }` 到实例的执行日志。
   *
   * **绝不抛出**：目录只读 / 磁盘满 / 轮转失败一律只记一条 warning 到插件 `log()` 端口（§3.4），
   * 推进判定与验证判定完全不受影响。这里**有意不经过 `log()`**（那会再写一次执行日志，
   * 既无意义又可能自激）。
   */
  function logEvent(instId: string, level: "info" | "warn" | "error", event: string, extra?: unknown): void {
    try {
      if (!instId || !fs.existsSync(instanceDir(instId))) return;
      const file = logFileOf(instId);
      rotateLogIfNeeded(file);
      const payload: Record<string, unknown> = extra && typeof extra === "object" && !Array.isArray(extra)
        ? { ...(extra as Record<string, unknown>) }
        : extra === undefined ? {} : { data: extra };
      delete payload.instId; // 每行自带 instId，避免重复键
      const entry = { ts: new Date().toISOString(), level, event, instId, ...payload };
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (e) {
      logToPort("warn", "execution_log_write_failed", { instId, event, error: msg(e) });
    }
  }

  /**
   * 诊断端口 + 执行日志**双写**：既有的 `log(level, event, {instId, ...})` 调用因此
   * 自动进入实例日志（§3.2 最后一条：`state_unlink_failed` / `instance_dir_remove_failed`
   * / `instance_dir_not_removed` 之类的既有告警都能在日志里复盘）。
   *
   * 只有 payload 里带**真实例 id** 的调用才写文件；`instId` 位置被塞了别的 id（例如
   * `deliver_failed` 传的是会话 id）时由 logEvent 的「实例目录必须存在」守卫挡掉。
   */
  const log = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    logToPort(level, event, data);
    const instId = data && typeof data === "object" ? (data as { instId?: unknown }).instId : undefined;
    if (typeof instId === "string" && instId) logEvent(instId, level, event, data);
  };

  /** 暂停入日志：原因与步骤都是可复盘的原始事实（不改变任何状态，只记录） */
  function logPause(instId: string, state: InstanceState, reason: string, extra?: Record<string, unknown>): void {
    logEvent(instId, "warn", "pause", { step: state.current_step, reason, ...extra });
  }

  /**
   * 归档执行日志副本到 `<reports>/<id>-execution.log`（§3.1）。
   *
   * **失败只告警、不阻塞销毁**：报告才是主事实，日志是辅助证据，不能因为辅助证据写不出来
   * 就把实例卡住。「报告归档失败 → 不销毁」那条不变量一字不动，见 {@link destroyInstance}。
   */
  function archiveExecutionLog(instId: string): string | null {
    const src = logFileOf(instId);
    try {
      if (!fs.existsSync(src)) return null;
      fs.mkdirSync(reportsDir, { recursive: true });
      const dst = archivedLogOf(instId);
      fs.copyFileSync(src, dst);
      return dst;
    } catch (e) {
      logToPort("warn", "execution_log_archive_failed", { instId, error: msg(e) });
      return null;
    }
  }

  function ensureLayout(): void {
    for (const p of [root, instancesDir, workflowsDir, reportsDir, artifactsDir]) {
      try { fs.mkdirSync(p, { recursive: true }); } catch {}
    }
    // 内置工作流**有意不落盘**（对齐 opencode/claude 的 ensureProjectWorkflows）：
    // loadWorkflow 会回落到插件目录，所以内置始终解析到**随插件发布的最新版本**。
    // 播种副本会遮蔽插件目录、并在插件升级后变成陈旧副本——实测踩过：工作区里那份
    // 7 步 spec 副本把新版 4 步内置整个挡住了，改了内置却"没生效"。
    // 用户要定制，就在本目录放同名文件（遮蔽是有意的，也是唯一的定制入口）。
  }

  // ─── 工作流加载与校验（坏文件 fail-fast 说人话）────────────────────────────

  const KNOWN_STEP_KEYS = new Set(["id", "desc", "do", "check", "check_voting", "check_model", "input", "output", "on_pass", "on_fail", "max_fail_count", "reset"]);
  const KNOWN_WF_KEYS = new Set(["description", "manual_step", "adversarial_check", "steps"]);

  function knownWorkflowDirs(): string[] {
    // 单根：本工作区的工作流目录 + 全局目录（内置工作流不落盘，由 builtinWorkflowPath 回落）
    return [workflowsDir, globalWorkflowsDir];
  }

  function workflowPaths(name: string): string[] {
    const out: string[] = [];
    for (const dir of knownWorkflowDirs()) {
      out.push(path.join(dir, `${name}.yaml`), path.join(dir, `${name}.yml`));
    }
    return out;
  }

  function listWorkflows(): WorkflowEntry[] {
    const names = new Set<string>(BUILTIN_WORKFLOWS);
    for (const dir of knownWorkflowDirs()) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/\.ya?ml$/i.test(f)) names.add(f.replace(/\.ya?ml$/i, ""));
        }
      } catch {}
    }
    return [...names].sort().map((n) => {
      const { def, problems, warnings } = loadWorkflow(n);
      return { name: n, desc: def?.description ?? "", invalid: !def, problems, warnings };
    });
  }

  /**
   * 加载一份工作流定义：YAML → 硬校验 → **子工作流加载期静态展开** → lint。
   *
   * 子工作流调用点（`workflow:` 代替 `do:`）在这里就被**就地展开**：调用点换成一串子步骤，
   * 每个子步骤 id 是 `调用点id/子步骤id`，子工作流的出口接到调用点的 `on_pass`。于是
   * 「嵌套」对运行期完全不可见：`current_step`、`fail_counts`、`advance`、审查门、验证者
   * 全按普通步骤走 —— **零新增 InstanceState 字段**（opencode 用运行期状态栈，本实现刻意不用）。
   *
   * 加载期硬错误（说得清楚、指得明白，绝不静默、绝不拖到运行期）：子工作流文件加载不出来、
   * 子工作流成环、**嵌套深度超 {@link MAX_SUBWORKFLOW_DEPTH}**（递归展开器的栈保护：过深的链
   * 一律在这里拿到硬错误，绝不冒泡 RangeError）、id 含 {@link SUBWORKFLOW_ID_SEP} 撞展开、
   * 展开后步骤总数超 {@link MAX_EXPANDED_STEPS}、展开后 id 撞名、调用点 workflow 名非法。
   *
   * `ctx` 只在**作为子工作流被展开**时传入（携带调用链、继承的验证模型、共享的展开计数器）；
   * 用户/工具直接加载某个工作流时不传，行为与改造前逐字一致（无调用点的工作流零差异）。
   */
  function loadWorkflow(name: string, ctx?: SubWorkflowLoadCtx): { def: WorkflowDef | null; problems: string[]; warnings: string[] } {
    const problems: string[] = [];
    const warnings: string[] = [];
    /** 展开计数器：整条调用链共享，任一层的超限都立刻被读到（超了就地中止，绝不先展开完再说） */
    const counter = ctx?.counter ?? { count: 0 };
    /** 从最外层到**当前**工作流的名字链：成环检测 + 报错里说清调用路径 */
    const chain = [...(ctx?.chain ?? []), name];
    // 嵌套过深：**展开任何一层之前**就拒绝。展开器是递归的，没有这道闸，一条每层零步骤的
    // 长链（步数上限看不见）会把宿主 JS 调用栈打爆，抛 RangeError 给调用方 —— 那是崩溃，
    // 不是加载期硬错误（见 MAX_SUBWORKFLOW_DEPTH 的实测记录）。
    if (chain.length > MAX_SUBWORKFLOW_DEPTH) {
      problems.push(
        `${DEPTH_TAG}（加载期硬错误）：调用链已到第 ${chain.length} 层，超过上限 ${MAX_SUBWORKFLOW_DEPTH} 层。`
        + `调用链：${formatCallChain(chain)}。`
        + `请把链拆浅 —— 复用同一个子工作流（而不是逐层生成/复制工作流文件），或把深层流程直接内联到父工作流里。`
        + `展开器是递归的：宿主 JS 调用栈装不下无界递归，所以在**展开任何一层之前**就拒绝，绝不把 RangeError 抛给调用方。`,
      );
      return { def: null, problems, warnings };
    }
    const capProblem = (): string =>
      `${CAP_TAG} ${MAX_EXPANDED_STEPS}（加载期硬错误，展开已立刻中止）：工作流 \`${name}\` 展开到第 ${counter.count} 步时超限。`
      + `子工作流按调用点**就地展开**（同一个子工作流被多个调用点引用会重复展开），请缩减调用点数量或子工作流规模。`;
    let raw: string | undefined;
    let usedPath: string | undefined;
    for (const p of workflowPaths(name)) {
      try {
        if (fs.statSync(p).isFile()) { raw = fs.readFileSync(p, "utf-8"); usedPath = p; break; }
      } catch {}
    }
    if (raw === undefined) {
      const p = builtinWorkflowPath(name);
      if (p) { try { raw = fs.readFileSync(p, "utf-8"); usedPath = p; } catch {} }
    }
    if (raw === undefined) {
      problems.push(`未找到工作流 "${name}"。把 YAML 放到 ${workflowsDir}/<name>.yaml 即可被识别。`);
      return { def: null, problems, warnings };
    }
    raw = raw.replace(/^\uFEFF/, "");
    let doc: any;
    try {
      doc = yaml.load(raw);
    } catch (e) {
      problems.push(`${usedPath} YAML 解析失败：${e instanceof Error ? e.message : String(e)}`);
      return { def: null, problems, warnings };
    }
    if (!doc || typeof doc !== "object") {
      problems.push(`${usedPath} 内容不是一个 YAML 映射（应以 description/steps 开头）。`);
      return { def: null, problems, warnings };
    }
    for (const k of Object.keys(doc)) {
      if (!KNOWN_WF_KEYS.has(k)) warnings.push(`顶层键 \`${k}\` 本版本未支持，已忽略。`);
    }
    const stepsRaw = doc.steps;
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
      problems.push(`${usedPath} 缺少非空的 steps 列表。`);
      return { def: null, problems, warnings };
    }
    // ── adversarial_check 容错（design §8 Q13 口径：自己不兑现的键一律 warn+ignore）──
    // 公开契约只允许 `model` 一个字段。其余字段（含已删除的 agent / system_prompt /
    // timeout_ms）与「整个值不是对象」都在**加载期**告警并忽略：不拒收、不静默、
    // 不改作别的含义。告警必须在这里出现，不能拖到验证阶段。
    //
    // 解析提前到步骤之前：**展开子工作流时要拿它当「逐字段继承」的父级模型**
    // （opencode 的 `adversarial_check` 沿调用链继承，见 sinkVerificationModel）。
    const acRaw: unknown = doc.adversarial_check;
    // `undefined` / `null`（YAML 里只写了键名、没写值）= 没写，按缺省处理（与 manual_step 同口径）；
    // 其余非对象（true / "foo" / [...]）一律告警忽略。
    const acIsMap = acRaw !== undefined && acRaw !== null && typeof acRaw === "object" && !Array.isArray(acRaw);
    if (acRaw !== undefined && acRaw !== null && !acIsMap) {
      warnings.push(`\`adversarial_check\` 必须是对象（当前是${describeValueKind(acRaw)}），已忽略。本版本只支持 \`model\` 一个字段。`);
    }
    if (acIsMap) {
      for (const k of Object.keys(acRaw as Record<string, unknown>)) {
        if (k === "model") continue;
        if (k === "agent") {
          warnings.push("`adversarial_check.agent` 已从公开契约中删除（验证者子代理由 Ralphflow 按能力自动选择），已忽略。");
        } else if (k === "system_prompt") {
          warnings.push("`adversarial_check.system_prompt` 已从公开契约中删除（验证者职责是 Ralphflow 的内部定义），已忽略。");
        } else if (k === "timeout_ms") {
          warnings.push("`adversarial_check.timeout_ms` 本版本未支持（验证超时交给宿主 dsh 的原生看门狗），已忽略。");
        } else {
          warnings.push(`\`adversarial_check.${k}\` 本版本未支持，已忽略。`);
        }
      }
    }
    // 全局验证模型（adversarial_check.model）：字符串 "provider/model" 与对象 {providerID, modelID}
    // 两种形态都支持（对齐 opencode/claude）。解析不出的（裸名 / 对象缺字段 / 类型非法）→
    // 告警并回退到发起会话当前模型，绝不静默忽略——否则用户以为换了验证模型，实际没换。
    const acModelRaw = acIsMap ? (acRaw as { model?: unknown }).model : undefined;
    const globalModel = parseModelRef(acModelRaw);
    if (acModelRaw !== undefined && acModelRaw !== null && globalModel === undefined) {
      warnings.push(`\`adversarial_check.model\` 类型非法（当前是${describeValueKind(acModelRaw)}），已忽略并回退到发起会话当前模型（需要 "provider/model" 字符串或 {providerID, modelID} 对象）。`);
    } else if (globalModel !== undefined && !resolveCheckModel(globalModel)) {
      warnings.push(`\`adversarial_check.model\` 是${describeModelRef(globalModel)}，解析不出 provider/model，该配置被忽略并回退到发起会话当前模型（需要 "provider/model" 或 {providerID, modelID} 两个非空字符串）。`);
    }
    /** 本文件自己填了且**有效**的验证模型（无效 = 没填，逐字段继承时回退父级） */
    const fileModel = resolveCheckModel(globalModel) ? globalModel : undefined;
    /** 本层（含祖先链）生效的验证模型：子工作流填了有效 model 就覆盖父级，否则回退父级 */
    const effectiveModel = fileModel ?? ctx?.inheritedModel;

    // ── 步骤解析 ───────────────────────────────────────────────────────────────
    /** 每个步骤：`call = true` 表示它是子工作流调用点（`workflow:` 代替 `do:`），展开时才消费 */
    const entries: Array<{ step: StepDef; call: boolean }> = [];
    const ids = new Set<string>();
    stepsRaw.forEach((s: any, i: number) => {
      if (!s || typeof s !== "object") { problems.push(`第 ${i + 1} 个步骤不是映射。`); return; }
      if (!s.id || typeof s.id !== "string") { problems.push(`第 ${i + 1} 个步骤缺少 id。`); return; }
      if (ids.has(s.id)) { problems.push(`步骤 id 重复：\`${s.id}\`。`); return; }
      ids.add(s.id);
      // 子工作流调用点：出现 `workflow` 键即是（值非法另报硬错误）。
      const isCall = Object.prototype.hasOwnProperty.call(s, "workflow");
      // 被当作子工作流展开的文件里，步骤 id 不能含展开分隔符：`a` + `b/c` 与 `a/b` + `c`
      // 会展开出同一个 id（展开不再一一对应）。**加载期硬错误**，不留到撞名时才炸。
      if (ctx && s.id.includes(SUBWORKFLOW_ID_SEP)) {
        problems.push(`步骤 \`${s.id}\` 的 id 含 \`${SUBWORKFLOW_ID_SEP}\`：本工作流被当作子工作流展开时，这一步的 id 会变成 \`调用点id${SUBWORKFLOW_ID_SEP}${s.id}\`，含分隔符会与展开结果撞名。请改成不含 \`${SUBWORKFLOW_ID_SEP}\` 的 id。`);
      }
      for (const k of Object.keys(s)) {
        // 步骤级 `manual_step` 有专用硬错误（下面），不走「未知键 = 警告忽略」：
        // 这里的偏差会让人工审查门**静默消失**，必须 fail-fast。
        if (k === "manual_step") continue;
        // 调用点的键有专用告警（下面，逐键指路），不走通用「未知键」文案。
        if (isCall) continue;
        if (!KNOWN_STEP_KEYS.has(k)) warnings.push(`步骤 \`${s.id}\` 的键 \`${k}\` 本版本未支持，已忽略。`);
      }
      // ── 步骤级 `manual_step` 已删除（只保留工作流级列表）──────────────────
      // 两种写法在本引擎里曾语义相同、纯冗余；但 opencode/pi 只认**工作流级列表**，
      // 步骤级写法在那边只是「不认识的步骤键」→ 警告忽略 → **人工审查门静默消失**。
      // 静默跳过审查门比报错严重得多，故这里不论值是什么（true/false/null）都硬错误，
      // 并在文案里直接给出正确写法。键存在与否用 hasOwnProperty 判（`manual_step:` 空值也算写了）。
      if (Object.prototype.hasOwnProperty.call(s, "manual_step")) {
        problems.push(
          `步骤 \`${s.id}\` 写了步骤级 \`manual_step\`：该写法已删除，不论值是什么（true/false/空值）都不再有效。`
          + `正确写法是把该步 id 列进工作流级 \`manual_step:\` 列表（顶层，与 \`steps\` 同级），即 \`manual_step: [${s.id}]\`（或写成 \`manual_step:\` 下的列表项 \`- ${s.id}\`）。`
          + `步骤级写法在 opencode 那边只是「不认识的步骤键」，会被忽略——人工审查门静默消失，因此这里硬错误而不是告警忽略。`,
        );
      }
      // ── 子工作流调用点：只认 id / desc / workflow / on_pass ─────────────────
      if (isCall) {
        const subName = typeof s.workflow === "string" ? s.workflow.trim() : "";
        if (subName === "") {
          problems.push(`步骤 \`${s.id}\` 写了 \`workflow\` 但没有给出要调用的工作流名（必须是非空字符串，例如 \`workflow: analyze\`）。调用点用 \`workflow:\` 代替 \`do:\`。`);
        } else if (/[\\/]/.test(subName)) {
          problems.push(`步骤 \`${s.id}\` 的 \`workflow: ${subName}\` 含路径分隔符：\`workflow\` 只能是工作流**名**（对应 \`${workflowsDir}/<名字>.yaml\`、全局目录或内置同名文件），不能是路径。`);
        }
        if (s.id.includes(SUBWORKFLOW_ID_SEP)) {
          problems.push(`调用点 \`${s.id}\` 的 id 含 \`${SUBWORKFLOW_ID_SEP}\`：展开后步骤 id 是 \`调用点id${SUBWORKFLOW_ID_SEP}子步骤id\`，调用点 id 含分隔符会与展开结果撞名。请把 id 改成不含 \`${SUBWORKFLOW_ID_SEP}\` 的名字。`);
        }
        // 其余键一律**告警且指路**：不生效、不静默、也不硬错误（作者多半只是写错了层级）。
        for (const k of Object.keys(s)) {
          if (k === "manual_step" || k === "id" || k === "desc" || k === "workflow" || k === "on_pass") continue;
          warnings.push(callPointKeyWarning(s.id, k, subName || "(未命名)"));
        }
        entries.push({
          call: true,
          step: {
            id: s.id,
            desc: typeof s.desc === "string" ? s.desc : undefined,
            workflow: subName || undefined,
            on_pass: typeof s.on_pass === "string" ? s.on_pass : undefined,
          },
        });
        return;
      }
      // ── §1.1 加载期硬校验：写错了却没有任何信号 = 缺陷（要么硬错误，要么 doctor 告警）
      // do 缺失：没有可执行的指令，整步无意义 → 硬错误（不再静默接受空步）。
      if (typeof s.do !== "string" || s.do.trim() === "") {
        problems.push(`步骤 \`${s.id}\` 缺少 \`do\`（必填：主会话执行的指令；缺失、非字符串或空串都不接受）。要把这一步委托给另一个工作流，用 \`workflow: <工作流名>\` 代替 \`do:\`。`);
      }
      // ── 对抗性检查：`check`（单验证者）与 `check_voting`（多验证者投票）二选一，都不写 = 免验证 ──
      // 校验顺序照抄 opencode：**互斥优先于类型检查**——即使 check 类型写错，只要两字段都在就报
      // 互斥，不让配置错误被「check 非字符串」这类次要报错掩盖。
      const hasCheckKey = s.check !== undefined && s.check !== null;
      const hasVotingKey = s.check_voting !== undefined && s.check_voting !== null;
      if (hasCheckKey && hasVotingKey) {
        problems.push(`步骤 \`${s.id}\` 的 \`check\` 与 \`check_voting\` 互斥，不能同时写（二选一）：单验证者用 \`check\`，多验证者投票用 \`check_voting\`。`);
      } else if (hasVotingKey) {
        problems.push(...validateVotingEntries(s.id, s.check_voting, warnings));
      } else if (hasCheckKey && typeof s.check !== "string") {
        // check 存在但非字符串（如 `check: true`）：几乎一定是漏写正文。
        // 硬错误，不静默当成「本步不做检查」——避免把「想要 check」误读成「不想 check」
        // （照 opencode：非字符串会被视为未配置检查并跳过验证；本意是跳过请直接删掉该字段）。
        problems.push(`步骤 \`${s.id}\` 的 \`check\` 必须是字符串（当前是 ${typeof s.check}）：非字符串会被视为未配置检查并跳过验证；若你本意是跳过请直接删掉该字段。`);
      }
      // max_fail_count 给了就必须是 ≥1 的整数（0/负数以前被静默接受 → 首次失败即暂停，用户看不懂）。
      if (s.max_fail_count !== undefined
        && (typeof s.max_fail_count !== "number" || !Number.isInteger(s.max_fail_count) || s.max_fail_count < 1)) {
        problems.push(`步骤 \`${s.id}\` 的 \`max_fail_count\` 必须是 ≥1 的整数（当前 ${JSON.stringify(s.max_fail_count)}）。`);
      }
      // reset（重置门，对齐 opencode 方言）：给了就必须是布尔。`reset: "true"` 这类字符串几乎
      // 一定是笔误——静默当成「不重置」会让作者以为上下文被清了、实际没清（本仓库对「想开却配错」
      // 一律不静默：类型错误 = 硬错误，与 `check` 非字符串同一口径）。
      if (s.reset !== undefined && s.reset !== null && typeof s.reset !== "boolean") {
        problems.push(`步骤 \`${s.id}\` 的 \`reset\` 必须是布尔值（当前是 ${describeValueKind(s.reset)}）：\`reset: true\` 表示进入本步前重置上下文。写成字符串（如 "true"）不会被当成真值，请改成布尔。`);
      }
      // check_model（步骤级验证模型覆盖，对齐 opencode/claude 2.8.0）：仅单 check 场景有意义。
      // 两条硬错误照抄 opencode：与 check_voting 同写、或没有可用的 check —— 都几乎一定是配置笔误，
      // 静默忽略会让用户以为「这步换了便宜模型验」，实际没换。
      const checkModelRaw = s.check_model;
      if (checkModelRaw !== undefined && checkModelRaw !== null) {
        if (hasVotingKey) {
          problems.push(`步骤 \`${s.id}\` 同时写了 \`check_voting\` 与 \`check_model\`：\`check_model\` 仅单 \`check\` 场景生效，此处无意义（多验证者时各票用自己条目里的 \`model\`）。`);
        } else if (typeof s.check !== "string" || s.check.trim() === "") {
          problems.push(`步骤 \`${s.id}\` 写了 \`check_model\` 但没有可用的 \`check\`：\`check_model\` 仅当步骤提供 \`check\` 时才生效，请补上 \`check\` 或删掉 \`check_model\`。`);
        }
        const parsed = parseModelRef(checkModelRaw);
        if (!parsed) {
          problems.push(`步骤 \`${s.id}\` 的 \`check_model\` 类型非法（应为 "provider/model" 字符串或 {providerID, modelID} 对象）。`);
        } else if (!resolveCheckModel(parsed)) {
          // 形态合法但解析不出 provider（裸模型名 / 对象缺字段）→ 告警并回退，与 opencode 一致
          warnings.push(`步骤 \`${s.id}\` 的 \`check_model\` 是${describeModelRef(parsed)}，解析不出 provider/model，该配置被忽略并回退（优先全局 \`adversarial_check.model\`，未设则用发起会话当前模型）（需要 "provider/model" 或 {providerID, modelID} 两个非空字符串）。`);
        }
      }
      entries.push({
        call: false,
        step: {
          id: s.id,
          desc: typeof s.desc === "string" ? s.desc : undefined,
          do: typeof s.do === "string" ? s.do : undefined,
          check: typeof s.check === "string" ? s.check : undefined,
          input: typeof s.input === "string" ? s.input : undefined,
          output: typeof s.output === "string" ? s.output : undefined,
          on_pass: typeof s.on_pass === "string" ? s.on_pass : undefined,
          on_fail: typeof s.on_fail === "string" ? s.on_fail : undefined,
          max_fail_count: typeof s.max_fail_count === "number" ? s.max_fail_count : undefined,
          check_model: parseModelRef(checkModelRaw),
          // 重置门：只有布尔才带进定义（非布尔已在上面硬错误，走不到这里）
          reset: typeof s.reset === "boolean" ? s.reset : undefined,
          // 只有通过上面校验的投票步才会走到这里（有 problems 时整份定义已被拒收）；
          // 非法条目里的坏值不带进定义，避免运行期拿到半成品配置。
          check_voting: Array.isArray(s.check_voting) && !hasCheckKey
            ? (s.check_voting as any[])
              .filter((e) => e && typeof e === "object" && typeof e.check === "string" && e.check.trim() !== "")
              .slice(0, MAX_VOTERS)
              .map((e) => ({ check: String(e.check).trim(), model: parseModelRef(e.model) }))
            : undefined,
        },
      });
    });
    if (problems.length > 0) return { def: null, problems, warnings };

    // ─── 子工作流：加载期静态展开 ──────────────────────────────────────────────
    //
    // 「嵌套」在这里被彻底消化：调用点就地换成一串**普通步骤**（id 加调用点前缀），子工作流的
    // 出口接到调用点的 `on_pass`。运行期因此不需要任何栈 / 父子指针 —— `current_step` 仍是
    // 单字符串，`fail_counts` 仍按步记账，零新增 InstanceState 字段。
    //
    // 四条刻意差异里的两条落在这段：
    //   · opencode 把成环 / 子文件加载不出来留到运行期才炸（doctor 只告警）——这里**加载期硬错误**；
    //   · 它用「运行时嵌套深度 5」兜住失控递归 —— 这里用**展开步骤总数上限**兜住
    //     （{@link MAX_EXPANDED_STEPS}，展开过程中计数，超了立刻中止）。
    // 另两条：子步骤耗尽 max_fail_count → 暂停等人（applyRoundOutcome 的既有行为，这里不接线到父级
    // on_fail）；调用点只认 id/desc/workflow/on_pass，manual_step 标调用点 = 整段跑完停门（下面映射）。
    const steps: StepDef[] = [];
    /** 原始调用点 id → 展开后的入口步骤 id（指向调用点的 on_pass/on_fail 接到入口） */
    const callEntry = new Map<string, string>();
    /** 待回填出口的展开区间：出口 = 调用点的有效 on_pass，只有后面的兄弟都展开完才知道 */
    const pending: Array<{ call: StepDef; start: number; end: number }> = [];
    /** 子工作流自带的人工审查门（前缀化后并入父级的 manual_step） */
    const subGates: string[] = [];
    let capHit = false;
    for (const e of entries) {
      if (!e.call) {
        if (++counter.count > MAX_EXPANDED_STEPS) { capHit = true; break; }
        steps.push(e.step);
        continue;
      }
      const call = e.step;
      const subName = call.workflow!; // 上面已硬校验非空（有 problems 时走不到这里）
      // 成环（含自调用）：加载期硬错误，并给出环上的完整路径
      const at = chain.indexOf(subName);
      if (at >= 0) {
        problems.push(`${CYCLE_TAG}（加载期硬错误）：${[...chain.slice(at), subName].join(" → ")}。环上的调用点会被无限展开，请打破环。`);
        break;
      }
      const sub = loadWorkflow(subName, { chain, inheritedModel: effectiveModel, counter });
      if (sub.problems.some((p) => p.includes(CAP_TAG))) { capHit = true; break; }
      // 成环 / 嵌套过深的路径由检测到的那一层给出（已含完整调用链）——直接透传，
      // 不再套一层「无法加载」（否则每往上一层都套一遍，最终变成一坨嵌套报错）
      const fatal = sub.problems.filter((p) => p.includes(CYCLE_TAG) || p.includes(DEPTH_TAG));
      if (fatal.length > 0) {
        problems.push(...fatal);
        break;
      }
      if (!sub.def) {
        problems.push([
          `步骤 \`${call.id}\` 引用的子工作流 \`${subName}\` 无法加载（加载期硬错误，不再拖到运行到该步时才炸）：`,
          ...sub.problems.map((p) => `  - ${p}`),
          `调用链：${chain.join(" → ")} → ${subName}`,
        ].join("\n"));
        break;
      }
      // 子工作流自己的告警一并带上来（医生也会在子工作流名下报一遍；这里保证父级上下文里不静默）
      for (const w of sub.warnings) warnings.push(`子工作流 \`${subName}\`：${w}`);
      const expanded = prefixSubWorkflowSteps(sub.def, call.id, call.desc);
      callEntry.set(call.id, expanded[0]!.id); // sub.def.steps 非空（空 steps 在加载期已硬错误）
      const start = steps.length;
      steps.push(...expanded);
      pending.push({ call, start, end: steps.length });
      for (const g of sub.def.manual_step ?? []) subGates.push(`${call.id}${SUBWORKFLOW_ID_SEP}${g}`);
    }
    if (capHit) problems.push(capProblem());
    if (problems.length > 0) return { def: null, problems, warnings };

    // ── 回填出口：调用点的有效 on_pass（显式 on_pass 优先；缺省 = 紧随其后的展开步骤；末步 = done）──
    /** 调用点 id → 它的出口步骤 id（= 子工作流「跑完回父级」的那些步骤） */
    const callExits = new Map<string, string[]>();
    for (const p of pending) {
      const explicit = p.call.on_pass && p.call.on_pass.trim() !== "" ? p.call.on_pass : undefined;
      const rawExit = explicit ?? (p.end < steps.length ? steps[p.end]!.id : "done");
      // 出口本身可能指向另一个调用点 → 接到那个调用点的入口步骤
      const exit = callEntry.get(rawExit) ?? rawExit;
      const exits: string[] = [];
      for (let i = p.start; i < p.end; i++) {
        const st = steps[i]!;
        if (st.on_pass === SUBWORKFLOW_EXIT) { st.on_pass = exit; exits.push(st.id); }
      }
      callExits.set(p.call.id, exits);
    }
    // 指向调用点的引用（普通步骤的 on_pass/on_fail、调用点的出口）→ 接到展开后的入口步骤
    //（语义：写到调用点上的连线 = 进入该子工作流；on_fail 回退到调用点 = 从子工作流入口重跑）
    for (const st of steps) {
      if (st.on_pass && callEntry.has(st.on_pass)) st.on_pass = callEntry.get(st.on_pass)!;
      if (st.on_fail && callEntry.has(st.on_fail)) st.on_fail = callEntry.get(st.on_fail)!;
    }

    // 展开后 id 去重：调用点 id / 被展开的子步骤 id 含 `/` 已在上面硬错误；这里兜住
    // 「子工作流展开出来的 id 与另一个步骤撞名」——静默重复 id 会让 current_step 指到错的那一步。
    const finalIds = new Set<string>();
    const dupIds: string[] = [];
    for (const s of steps) {
      if (finalIds.has(s.id)) { if (!dupIds.includes(s.id)) dupIds.push(s.id); continue; }
      finalIds.add(s.id);
    }
    if (dupIds.length > 0) {
      problems.push(`子工作流展开后步骤 id 撞名：${dupIds.map((d) => `\`${d}\``).join("、")}。展开后的 id 形如 \`调用点id${SUBWORKFLOW_ID_SEP}子步骤id\`，请重命名撞名的步骤。`);
    }
    // 引用校验（在**展开后**的 id 集合上做）：on_pass 必须指向存在的步骤或 done；
    // on_fail 必须指向存在的步骤（`on_fail: done` 非法 —— 失败不能「结束工作流」，见 design §4）。
    for (const s of steps) {
      for (const [key, target] of [["on_pass", s.on_pass], ["on_fail", s.on_fail]] as const) {
        if (target === undefined) continue;
        if (target === "done") {
          if (key === "on_fail") problems.push(`步骤 \`${s.id}\` 的 on_fail 指向 \`done\`；失败重试目标必须是存在的步骤 id（不允许 done）。`);
          continue;
        }
        if (!finalIds.has(target)) problems.push(`步骤 \`${s.id}\` 的 ${key} 指向不存在的步骤 \`${target}\`。`);
      }
    }
    if (problems.length > 0) return { def: null, problems, warnings };
    // manual_step 方言：**只有工作流级（顶层）一种写法**，列表与逗号字符串都接受（对齐 opencode）。
    // 步骤级 `manual_step` 已删除 = 上面的加载期硬错误——绝不静默放过（审查门会静默消失）。
    const manual: string[] = [];
    if (Array.isArray(doc.manual_step)) {
      manual.push(...doc.manual_step
        .filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
        .map((x: string) => x.trim()));
    } else if (typeof doc.manual_step === "string") {
      manual.push(...(doc.manual_step as string).split(",").map((x: string) => x.trim()).filter(Boolean));
    } else if (doc.manual_step !== undefined && doc.manual_step !== null) {
      warnings.push("顶层 manual_step 既不是列表也不是字符串，已忽略。");
    }
    // 审查门映射（与 opencode 的**刻意差异**）：opencode 禁止把 manual_step 标在子工作流
    // 调用点上（硬错误）；这里允许，语义是**整段子工作流跑完后停门** —— 映射到子工作流的
    // 出口步骤（谁把控制权交回父级，谁就是门）。子工作流自己的 manual_step 前缀化后原样生效。
    const manualSet = new Set<string>(subGates);
    for (const m of manual) {
      if (!callEntry.has(m)) { manualSet.add(m); continue; }
      const exits = callExits.get(m) ?? [];
      if (exits.length === 0) {
        problems.push(`manual_step 里的调用点 \`${m}\` 展开后没有任何「跑完回父级」的出口步骤（子工作流内部不会回到调用点的 on_pass），审查门永远不会触发。请把 manual_step 标到子工作流内最后一个普通步骤上，或修好子工作流的出口。`);
        continue;
      }
      for (const x of exits) manualSet.add(x);
    }
    if (problems.length > 0) return { def: null, problems, warnings };
    // manual_step 引用不存在的步骤 → 硬错误：用户以为有审查门，实际会一路自动跑过去，
    // 这个偏差没有任何其它信号（create.ts 早已自称是硬规则，此前只是没实现）。
    const unknownManual = [...manualSet].filter((id) => !finalIds.has(id));
    if (unknownManual.length > 0) {
      problems.push(`manual_step 引用了不存在的步骤：${unknownManual.map((m) => `\`${m}\``).join("、")}（审查门会静默失效，必须修正拼写或删掉）。`);
      return { def: null, problems, warnings };
    }
    // 子工作流里的 `adversarial_check.model` 下沉到它各步的 `check_model`（对齐 opencode 的
    // 逐字段继承）：**只在子层加载时**做，且只填「自己没填或填了但无效」的步骤 ——
    // 父级的 `adversarial_check` 是整份定义的兜底、不区分层次，帮不了子层。
    if (ctx) sinkVerificationModel(steps, effectiveModel);
    // §1.2 doctor 覆盖的 lint：引擎只在运行时（或永远不）暴露的问题，加载成功后补告警。
    warnings.push(...lintWorkflow(steps, manualSet));
    const def: WorkflowDef = {
      name,
      description: typeof doc.description === "string" ? doc.description : "",
      manual_step: [...manualSet],
      // 只保留公开契约里的 `model`；其余字段已在上面告警忽略，绝不带进定义。
      adversarial_check: acIsMap ? { model: globalModel } : undefined,
      steps,
      warnings,
    };
    return { def, problems, warnings };
  }

  // ─── 状态 I/O（原子写）─────────────────────────────────────────────────────

  function instanceDir(instId: string): string { return path.join(instancesDir, instId); }
  function statePath(instId: string): string { return path.join(instanceDir(instId), "state.json"); }

  function readState(instId: string): InstanceState | null {
    try {
      const s = JSON.parse(fs.readFileSync(statePath(instId), "utf-8"));
      if (!s || typeof s !== "object") return null;
      s.delegations ??= [];
      s.verdicts ??= [];
      s.history ??= [];
      // 向后兼容读取：老 state.json 只有标量 fail_count（无 fail_counts）。
      // 归入当前步的计数，避免升级后「失败轮数」凭空归零。
      s.fail_counts ??= {};
      if (typeof s.fail_counts[s.current_step] !== "number" && typeof s.fail_count === "number" && s.fail_count > 0) {
        s.fail_counts[s.current_step] = s.fail_count;
      }
      // 派生当前步失败轮数（不落盘）
      s.fail_count = typeof s.fail_counts[s.current_step] === "number" ? s.fail_counts[s.current_step] : 0;
      return s as InstanceState;
    } catch { return null; }
  }

  function writeState(state: InstanceState, instId: string): void {
    state.updated_at = new Date().toISOString();
    // 落盘前剔除派生量 fail_count（宪法 §10.4：状态不存派生量）。
    // 每次读取都由 fail_counts[current_step] 重算，故不可能出现两个写入者不一致。
    const { fail_count: _derivedFailCount, ...persisted } = state;
    void _derivedFailCount;
    try {
      const dir = instanceDir(instId);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.state.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), "utf-8");
      fs.renameSync(tmp, statePath(instId));
    } catch (e) {
      log("error", "state_write_failed", { instId, error: msg(e) });
    }
  }

  /** 某步当前的失败轮数（按步计数；缺省 0） */
  function failCountOf(state: InstanceState, stepId?: string): number {
    const id = stepId ?? state.current_step;
    const n = state.fail_counts?.[id];
    return typeof n === "number" ? n : 0;
  }

  /** 记一次失败并返回该步累计次数 */
  function bumpFailCount(state: InstanceState, stepId: string): number {
    state.fail_counts ??= {};
    const n = failCountOf(state, stepId) + 1;
    state.fail_counts[stepId] = n;
    state.fail_count = failCountOf(state); // 保持读取便利字段同步
    return n;
  }

  /** 某步验证通过 → 该步失败史已了结，清零（下次再进来是干净的重试） */
  function clearFailCount(state: InstanceState, stepId: string): void {
    state.fail_counts ??= {};
    state.fail_counts[stepId] = 0;
    state.fail_count = failCountOf(state);
  }

  function pushHistory(state: InstanceState, event: string, detail?: string, step?: string): void {
    state.history.push({ ts: new Date().toISOString(), event, detail, step: step ?? state.current_step });
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
  }

  /**
   * **只返回活跃实例**（`state.active === true`）：实例是临时的，结束即销毁并从列表消失。
   * 已结束的运行从 `reports/` 读出来（{@link listHistory}），不再靠 `state.json` 当历史索引。
   */
  function listInstances(): InstanceInfo[] {
    // 单根：直接扫本工作区的 instances/，不再靠全局索引（索引会让「目录里明明有」的实例
    // 在列表与 doctor 里都消失——那正是自定义工作流与历史列表失效的同一个根因）。
    try {
      const ids = fs.readdirSync(instancesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      return ids
        .map((id) => ({ id, state: readState(id) }))
        .filter((x): x is InstanceInfo => !!x.state && x.state.active === true)
        .sort((a, b) => (a.state.started_at < b.state.started_at ? -1 : 1));
    } catch { return []; }
  }

  /**
   * 解析一份归档报告的头部字段（`- 实例：` / `- 状态：` / `- 任务：` / `- 开始：` / `- 结束：`）。
   *
   * **不新增派生索引文件**（宪法 §10.4）：报告本身就是唯一的历史事实源，列表每次现读现解析。
   * 头部字段缺失/格式不对 → `parsed:false`，条目仍会列出（标注「无法解析」），不静默丢弃。
   */
  function parseReportHeader(relPath: string, fileId: string, text: string): HistoryInfo {
    const field = (label: string): string | undefined => {
      const m = new RegExp(`^- ${label}：\\s*(.*)$`, "m").exec(text);
      return m ? m[1]!.trim() : undefined;
    };
    const strip = (v: string | undefined) => v?.replace(/^`+|`+$/g, "").trim();
    const rawId = strip(field("实例"));
    const statusRaw = field("状态") ?? "";
    const task = field("任务");
    const startedAt = field("开始");
    const endedAt = field("结束");
    const artifactsRel = strip(field("产出目录"));
    const artifactsDirName = artifactsRel ? artifactsRel.replace(/\/+$/, "").split("/").pop() : undefined;
    const workflow = /^#\s*ralphflow 报告 ·\s*(.+)$/m.exec(text)?.[1]?.trim();
    const statusLabel = statusRaw.includes("完成") ? "完成" : statusRaw.includes("取消") ? "取消" : undefined;
    return {
      id: rawId || fileId,
      parsed: !!(rawId && statusLabel && endedAt),
      statusLabel: statusLabel ?? "无法解析",
      task,
      startedAt,
      endedAt,
      relPath,
      artifactsDirName: artifactsDirName || undefined,
      workflow,
    };
  }

  /**
   * 已归档运行（扫 `reports/*.md`，按「结束」时间倒序）。
   *
   * 这是 instance 生命周期改造的**历史入口**：opencode 版没有任何列出已结束实例的入口，
   * 报告只写不读，消息一丢就再也找不回来；dsh 这里要比它好（边界 3）。
   */
  function listHistory(): HistoryInfo[] {
    let names: string[] = [];
    try { names = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")); } catch { return []; }
    const out = names.map((f) => {
      const id = f.replace(/\.md$/, "");
      let text = "";
      try { text = fs.readFileSync(path.join(reportsDir, f), "utf-8"); } catch {}
      return parseReportHeader(`${RALPH_FLOW_DIR}/reports/${f}`, id, text);
    });
    const key = (h: HistoryInfo) => {
      const t = h.endedAt ? new Date(h.endedAt).getTime() : NaN;
      return Number.isFinite(t) ? t : -Infinity;
    };
    return out.sort((a, b) => key(b) - key(a));
  }

  /** 按 id（支持唯一前缀）在历史报告里找一条 */
  function findHistory(ref: string): HistoryInfo | undefined {
    const all = listHistory();
    return all.find((h) => h.id === ref) ?? all.find((h) => h.id.startsWith(ref));
  }

  function newInstId(workflow: string): string {
    const slug = workflow.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "run";
    return `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ─── 派生事实与规则（T2 的中心）────────────────────────────────────────────

  function stepOf(wf: WorkflowDef, id: string): StepDef | undefined {
    return wf.steps.find((s) => s.id === id);
  }

  function isGate(wf: WorkflowDef, step: StepDef): boolean {
    // 审查门只有一个来源：工作流级（顶层）`manual_step` 列表。步骤级写法已在加载期硬错误。
    return (wf.manual_step ?? []).includes(step.id);
  }

  function nextStepId(wf: WorkflowDef, step: StepDef): string {
    if (step.on_pass) return step.on_pass;
    const i = wf.steps.findIndex((s) => s.id === step.id);
    return i >= 0 && i + 1 < wf.steps.length ? wf.steps[i + 1]!.id : "done";
  }

  function failStepId(wf: WorkflowDef, step: StepDef): string {
    return step.on_fail ?? step.id;
  }

  /**
   * 判定齐了且全 passed。
   *
   * **「齐」= 票数够**：单 `check` 要 1 张；`check_voting` 要 N 张（每票一个 `check_index`）。
   * 只数 passed 不看票数会让「3 票里 1 票通过、另外 2 票还没回来」被误判成通过 ——
   * 于是这里按步骤定义现算期望票数（零新状态字段），fail-closed。
   */
  function allPassed(state: InstanceState, step?: StepDef): boolean {
    const need = step ? expectedVerdicts(step) : 1;
    if (need <= 0 || state.verdicts.length < need) return false;
    return state.verdicts.every((v) => v.status === "passed");
  }

  /**
   * 判定是否属于「当前这一步」（design §5 第 3 条的归属校验）。
   * 判定可以携带空 step_id（外部/历史数据），此时按匹配处理，不误伤。
   */
  function verdictBelongsToStep(v: Verdict, stepId: string): boolean {
    return !v.step_id || v.step_id === stepId;
  }

  /**
   * 当前步是否已停下等放行的审查门。
   *
   * 无对抗性检查的步骤（`!stepHasVerification`：既无 `check` 也无 `check_voting`）
   * **不叠加机器验证**：交卷/放行后直接停在门，是**纯人工审查** —— 判据来自工作流定义
   * （design §12.1 精修后的机械判据）。
   */
  function atOpenGate(wf: WorkflowDef, state: InstanceState, step: StepDef): boolean {
    return isGate(wf, step) && (!stepHasVerification(step) || allPassedVerified(state, step));
  }

  /**
   * 判定齐（票数够）、全 passed，且**判定确实属于当前步**（design §5 第 3 条的归属校验）。
   * 归属用 step_id 判定；缺少 step_id 的判定按当前步处理，避免历史数据被误判为不通过。
   * 错位判定（step_id 指向别的步骤）一律不算通过 —— fail-closed。
   */
  function allPassedVerified(state: InstanceState, step: StepDef): boolean {
    if (!allPassed(state, step)) return false;
    return state.verdicts.every((v) => verdictBelongsToStep(v, step.id));
  }

  /** 判定里是否有「不属于当前步」的条目（用于给用户说清拒绝原因） */
  function foreignVerdicts(state: InstanceState, step: StepDef): Verdict[] {
    return state.verdicts.filter((v) => v.step_id && v.step_id !== step.id);
  }

  /**
   * 门上重开一轮 DO（轻量打回，无程序化 return）：
   * 用户说「改一下」→ 主会话修改、重新交卷、重新验证、再次回到门（design §5 末段）。
   * 只清本轮交卷事实与判定，不动 fail_count（打回不是失败，不烧账）。
   *
   * 注意：若还有在飞委派，必须**真正中止**它再清记账，否则委派变孤儿——
   * 它的判定回来时 `current_step` 守卫会丢弃（可诊断但白烧 token），
   * 而 `delegations` 被清空又会让 continue 误以为「没有验证在跑」。
   */
  function reopenGate(state: InstanceState, instId: string, step: StepDef, reason: string): void {
    if (state.delegations.length > 0) {
      // 只中止本实例的验证者（投票时是**全部** N 笔）；引擎随后重新委派，语义等价于「上一轮作废」
      abortInstance(instId);
      log("info", "gate_reopen_abort_inflight", { instId, count: state.delegations.length });
    }
    state.do_submitted = false;
    state.verdicts = [];
    stopHeartbeatsOf(instId, state.delegations);
    state.delegations = [];
    state.last_submit_summary = undefined;
    pushHistory(state, "gate_reopened", reason, step.id);
    logEvent(instId, "info", "gate_reopened", { step: step.id, reason });
    writeState(state, instId);
  }

  // ─── 交卷与验证（三时刻①②）────────────────────────────────────────────────

  /**
   * DO prompt：宣告本步任务（交卷 = 调用 ralphflow_submit 工具，dsh 原生方式）。
   *
   * §1.7：每个 DO 提示词**各注入一行**「产出目录」（工作区相对路径）。
   * 由此 `do`/`output` 里写裸文件名即落到该目录，跨任务不再串味；内置 loop/spec 不用改。
   */
  function doPrompt(instId: string, wf: WorkflowDef, state: InstanceState, step: StepDef, rework?: string): string {
    const idx = wf.steps.findIndex((s) => s.id === step.id) + 1;
    const rel = artifactsRelDirOf(instId);
    const hasCheck = stepHasVerification(step);
    const voters = voterCountOf(step);
    // 本步是不是审查门：无检查依据 + 门 = 纯人工审查，交卷后停在门等用户放行（不是「自动进入下一步」）。
    const gate = isGate(wf, step);
    const parts = [
      `[ralphflow] 工作流 \`${wf.name}\` · 步骤 ${idx}/${wf.steps.length}：**${step.id}**${step.desc ? ` — ${step.desc}` : ""}`,
      "",
      `## 任务`,
      state.user_task,
      "",
      `## 本步要做什么`,
      (step.do || step.desc || step.id).trim(),
      "",
      `## 产出目录`,
      `\`${rel}/\` —— 本步的文档产出（清单、方案、报告、摘要等）统一放这里：\`do\`/\`output\` 里只写文件名的（如 \`summary.md\`）落到这个目录，写了其它路径的按写的路径来。`,
    ];
    if (step.output) parts.push("", `## 交付物`, String(step.output).trim());
    if (rework) {
      parts.push("", `## 上一轮验证未通过，请针对性修复`, rework.trim());
    }
    parts.push(
      "",
      "## 交卷方式",
      "完成实际工作后，按顺序做两件事：",
      "",
      // 有无对抗性检查决定「交卷之后发生什么」：有（check 或 check_voting）→ 独立验证；
      // 无 → 跳过对抗性验证。绝不预告一个不会发生的验证（省 token 不能以伪造事实为代价）。
      // 单 check 的两条与改造前**逐字相同**（回归基线）；投票步只换「一个/N 个并行」这层事实。
      hasCheck
        ? (voters > 0
          ? `1. **先用一两句面向用户的话说明现在的状态与接下来会发生什么**，要让用户一眼看懂：本步已完成 → 接下来进入**独立验证**（${voters} 个独立验证者**并行**取证，各自只查一条检查依据，**全过才放行**；异步，**不需要用户做任何操作**；验证者是独立会话，正在读文件、跑命令取证，它在做什么用户在会话里看得到）→ 期间用户可以做什么（补充信息或纠正方向 / 用 \`/ralphflow-status\` 看进度 / 用 \`/ralphflow-cancel\` 中止）。**不要给任何时长预估**：委派没有超时上界，估计出来的时间只会是编的。用用户的语言写，不要把它埋进技术叙述里。`
          : "1. **先用一两句面向用户的话说明现在的状态与接下来会发生什么**，要让用户一眼看懂：本步已完成 → 接下来进入**独立验证**（异步，**不需要用户做任何操作**；验证者是独立会话，正在读文件、跑命令取证，它在做什么用户在会话里看得到）→ 期间用户可以做什么（补充信息或纠正方向 / 用 `/ralphflow-status` 看进度 / 用 `/ralphflow-cancel` 中止）。**不要给任何时长预估**：委派没有超时上界，估计出来的时间只会是编的。用用户的语言写，不要把它埋进技术叙述里。")
        : (gate
          ? "1. **先用一两句面向用户的话说明现在的状态与接下来会发生什么**，要让用户一眼看懂：本步已完成 → 本步**不配置对抗性检查**，会**跳过对抗性验证**（不会有独立验证进程来复核）→ 交卷后停在**审查门**，等用户运行 `/ralphflow-continue` 放行。用用户的语言写，不要把它埋进技术叙述里。"
          : "1. **先用一两句面向用户的话说明现在的状态与接下来会发生什么**，要让用户一眼看懂：本步已完成 → 本步**不配置对抗性检查**，会**跳过对抗性验证**（不会有独立验证进程来复核）→ 接下来自动进入下一步（**不需要用户做任何操作**）。用用户的语言写，不要把它埋进技术叙述里。"),
      hasCheck
        ? (voters > 0
          ? `2. **调用 \`ralphflow_submit\` 工具交卷**（可在参数 \`summary\` 里简述你做了什么）。${voters} 个独立验证者会立刻**并行**检查你的产出（全过才放行）。`
          : "2. **调用 `ralphflow_submit` 工具交卷**（可在参数 `summary` 里简述你做了什么）。独立验证者会立刻检查你的产出。")
        : "2. **调用 `ralphflow_submit` 工具交卷**（可在参数 `summary` 里简述你做了什么）。本步不委派独立验证者，交卷即生效。",
      "",
      hasCheck
        ? "不要只在回复里说「完成了」——那样不会触发验证。**必须调用工具**。"
        : "不要只在回复里说「完成了」——那样不会触发推进。**必须调用工具**。",
    );
    if (!hasCheck) {
      // 主干照 opencode 的措辞（`opencode/src/engine.ts:1565`）；manual_step 门这一支按本版本的
      // 纯人工审查语义分开说 —— opencode 原文不区分，与上面的「停在审查门等放行」会自相矛盾。
      parts.push(
        "",
        gate
          ? `ℹ️ 本步骤**不配置对抗性检查**：完成即可，不会有独立的验证进程来复核。请务必自查产出是否满足任务要求——交卷后停在**审查门**，等用户运行 \`/ralphflow-continue\` 放行。`
          : `ℹ️ 本步骤**不配置对抗性检查**：完成即可，不会有独立的验证进程来复核。请务必自查产出是否满足任务要求。`,
      );
    }
    return parts.join("\n");
  }

  /**
   * 记「本步跳过对抗性验证」到轨迹（**只记一次**：门上改稿重交 / 放行推进不重复记）。
   *
   * 用词是硬要求：只能写「跳过对抗性验证」，**绝不**写「检查通过」——
   * 没有验证者就没有判定，省 token 不能以伪造事实为代价。
   * 「是否已记过」从 `history` 现算（零新状态字段，宪法 §10.4）。
   */
  function noteCheckSkipped(instId: string, state: InstanceState, step: StepDef): void {
    if (state.history.some((h) => h.event === "check_skipped" && h.step === step.id)) return;
    pushHistory(state, "check_skipped", `步骤 \`${step.id}\` 未配置 \`check\` / \`check_voting\`，跳过对抗性验证`, step.id);
    log("info", "check_skipped", { instId, step: step.id, reason: "no_check" });
  }

  /**
   * 无检查依据（`check` / `check_voting` 都不写）的步骤：**不委派验证者**，按工作流定义声明直接推进或停在审查门。
   *
   * 判据是 `stepHasVerification(step)`（只读 `StepDef`，见 design §12.1 精修）：这不是
   * 「执行者跳过验证」，而是**作者已声明本步免验证**的机械推进。
   *
   * **两个分支都不写 `verdicts[]`** —— 没有验证者就没有判定（也不写 `delegations[]`）。
   * 诚实标注：轨迹与通知一律写「跳过对抗性验证」，**绝不**写「检查通过」。
   *
   * 返回是否停在了审查门（供调用方组织交卷回执文案）。
   */
  function skipVerification(instId: string, state: InstanceState, wf: WorkflowDef, step: StepDef): boolean {
    noteCheckSkipped(instId, state, step);
    writeState(state, instId);
    if (isGate(wf, step)) {
      // 停在审查门的两种打开方式都要留痕：这里是「无检查依据的纯人工审查」
      logEvent(instId, "info", "gate_opened", { step: step.id, kind: "manual_no_check" });
      notify(
        state,
        `🙋 步骤 \`${step.id}\` 未配置对抗性检查（无 \`check\`/\`check_voting\`），已**跳过对抗性验证**，停在审查门等你放行（纯人工审查，不叠加机器验证）。\n\n确认无误运行 \`/ralphflow-continue\` 进入下一步；需要修改就直接说明，改完重新交卷仍会停在这里。`,
        `🙋 步骤 ${step.id} 已跳过对抗性验证，停在审查门等你放行`,
      );
      return true;
    }
    notify(
      state,
      `⏭ 步骤 \`${step.id}\` 未配置对抗性检查（无 \`check\`/\`check_voting\`），已**跳过对抗性验证**，直接进入下一步。`,
      `⏭ 步骤 ${step.id} 已跳过对抗性验证（未配置 check / check_voting），直接推进`,
    );
    advance(instId, state, wf, step);
    return false;
  }

  /** 发起本步的验证：投票步走 {@link launchVotingRound}（N 票并发），单 check 步走原路径 */
  async function launchVerification(instId: string, state: InstanceState, wf: WorkflowDef, step: StepDef): Promise<void> {
    if (voterCountOf(step) > 0) {
      // 全新一轮（DO 重新交卷 / 孤儿恢复后重投）⇒ 上一轮的票一律作废、N 票**全部**重投
      //（跨轮语义：工作已经变了，上一轮通过的票也不再复用 —— 见 opencode §4.7）。
      state.verdicts = state.verdicts.filter((v) => !verdictBelongsToStep(v, step.id));
      await launchVotingRound(instId, state, wf, step, voterIndices(step), 1);
      return;
    }
    const checkIndex = state.verdicts.length;
    const runId = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    addAbort(instId, controller);
    /** 验证耗时（§3.2：判定事件必须带耗时）——起算点是委派发起，不是判定落账 */
    const startedAt = Date.now();
    state.delegations.push({
      run_id: runId, check_index: checkIndex, ts: new Date().toISOString(),
      // 属主运行时（诊断）+ 心跳起点（判活的唯一依据）：心跳只要还在刷新，别的会话 /
      // 别的沙箱进程 / 重载后的新实例就不得把这笔在飞委派当孤儿清掉。
      owner_runtime: runtimeId(), heartbeat_at: Date.now(),
    });
    pushHistory(state, "verify_start", `check_index=${checkIndex}`, step.id);
    writeState(state, instId);
    startHeartbeat(instId, runId);
    log("info", "verify_start", { instId, step: step.id, checkIndex });
    // 阶段播报：验证是**异步**的（委派独立子代理，不阻塞主会话回合）。
    // 这段静默窗口必须讲清三件事：正在发生什么 / 要不要你操作 / 去哪看进度。
    //
    // **绝不给时长预估**：实测 3m53s / 7m29s / 8m34s，而且委派**没有超时上界**
    // （见 verify.ts：生命周期跟随宿主原生能力）—— 猜一个「通常 1–5 分钟」就是编。
    // 能诚实说的只有「它在读文件、跑命令取证，你（用户）看得到」。
    notify(state, [
      `🔍 步骤 \`${step.id}\` 已交卷，独立验证者（独立会话，看不到本对话）正在取证判定。`,
      "",
      `**这一步你是异步等待的，不需要做任何操作** —— 验证者跑完会自动唤醒本会话并继续工作流。它现在正在读文件、跑命令取证，你在会话里看得到它在做什么。`,
      "",
      `期间你可以：`,
      `- 直接在此会话补充信息或纠正方向（会被模型看到）`,
      `- 用 \`/ralphflow-status\` 随时查看进度与最近轨迹`,
      `- 想中止就 \`/ralphflow-cancel\``,
    ].join("\n"), `🔍 步骤 ${step.id} 已交卷，独立验证者正在取证（无需操作）`);

    let verdict: Verdict;
    try {
      verdict = await ports.verify({
        instId, step, workflow: wf, userTask: state.user_task,
        ownerSession: state.owner_session, checkIndex, artifactsRelDir: artifactsRelDirOf(instId),
        // 验证模型优先级链（对齐 opencode resolveVerifierModel）：
        //   步骤 check_model  >  全局 adversarial_check.model  >  发起会话当前模型
        //（没有覆盖时不传 agentOptions，由宿主 resolveChildAgentOptions 继承父级）
        // 归一化在此一次性完成，verify.ts 只消费结果。
        model: resolveCheckModel(step.check_model ?? wf.adversarial_check?.model),
        signal: controller.signal,
        // 验证者提示词原文由 verify.ts 经这个端口写进执行日志（§3.2 可复盘证据；
        // 端口自身绝不抛，写不进去也不影响验证与推进）。
        logEvent: (level, event, extra) => logEvent(instId, level, event, extra),
      });
    } catch (e) {
      verdict = { check_index: checkIndex, status: "infra", reason: `验证未跑成：${msg(e)}`, step_id: step.id, ts: new Date().toISOString() };
    }
    // 归一化验证端口的返回：判定是外部输入，形状不可信。
    // fail-closed —— 形状不对一律当 infra，绝不当成「通过」；
    // 同时补齐字段，避免下游对 undefined 取属性把整条 async 链抛成未处理拒绝。
    verdict = normalizeVerdict(verdict, step.id, checkIndex);

    // 落判定：只信 ports.verify 的返回（T1）。
    //
    // 必须校验「这一笔判定是否仍属于当轮有效委派」。仅看 active/current_step 不够：
    //   · reopenGate 中止在飞委派后清了记账，但被中止那一笔在 dsh driver 里会以
    //     stopReason=aborted **正常 resolve**，经 verify.ts 变成 infra 照常返回；
    //   · restore() 的孤儿恢复同样清记账，而验证者进程其实还活着。
    // 这两种「迟到判定」若被接收，会写出假 check_infra 并吞掉当轮真正的通过判定。
    // 判据：delegations 里仍登记着本 runId（被清掉/被替换 = 本笔已作废）。
    const fresh = readState(instId);
    const ownsRun = !!fresh && fresh.delegations.some((d) => d.run_id === runId);
    if (!fresh || !fresh.active || fresh.paused || fresh.current_step !== step.id || !ownsRun) {
      const why = !fresh ? "instance_state_missing"
        : !fresh.active ? "instance_inactive"
        : fresh.paused ? "instance_paused"
        : fresh.current_step !== step.id ? "step_changed"
        : "run_superseded";
      log("warn", "verdict_discarded", { instId, reason: why, status: verdict.status, step: step.id, runId });
      stopHeartbeat(instId, runId); // 本笔已作废：心跳没有任何意义了
      dropAbort(instId, controller); // 取消句柄同样作废，避免集合里堆积死句柄
      return;
    }
    stopHeartbeat(instId, runId);
    fresh.delegations = fresh.delegations.filter((d) => d.run_id !== runId);
    fresh.verdicts.push(verdict);
    dropAbort(instId, controller);
    pushHistory(fresh, `verdict_${verdict.status}`, verdict.reason.slice(0, 300), step.id);
    // 判定入执行日志：`reason` **全文不截断**（§3.2），并带耗时；与报告里的判定字符串同源同值。
    log("info", "verdict", { instId, step: step.id, checkIndex, status: verdict.status, reason: verdict.reason, ms: Date.now() - startedAt });
    // 单 check 就是「一轮一票」：整体结论 = 这张票的判定，直接套用共享的结论应用段
    //（暂停 / 返工 / 审查门 / 推进的规则与多验证者投票同一条路径，行为逐字未变）。
    applyRoundOutcome(instId, fresh, wf, step, { kind: verdict.status, reason: verdict.reason }, startedAt);
  }

  // ─── 多验证者投票（check_voting）─────────────────────────────────────────────
  //
  // 语义照抄 opencode `src/check-voting.ts`，载体按 dsh 的无相位模型落地：
  //   · N 票**并发**：每票 = 一笔独立委派 + 一个独立取消句柄 + 一份心跳 + 一份专属提示词；
  //   · **全部终态才聚合**：任何单票完成都不碰状态机（多票同时落账会互相覆盖读-改-写）；
  //   · 聚合优先级 `failed > infra > 全过`（`decideVotingOutcome`）——工作问题绝不被故障遮蔽；
  //   · infra **自动重试一次**，只重跑故障票（已通过的保留）；重试仍 infra 且无 failed →
  //     `check_infra` 暂停（不计失败次数），`/ralphflow-continue` 只重跑未通过的票；
  //   · 跨轮（DO 返工后重新交卷）**全部重投**：上一轮的票一律不复用（工作已经变了）。
  //
  // 进度不另立文件：每票状态就是 `state.json` 的 `verdicts[]`（终态）+ `delegations[]`（在飞）
  // ——单根事实源，`/ralphflow-status` 由此现算（见 renderInstance）。

  /**
   * 每实例一把「判定落账」串行锁：让「读 state → 落票 → 判断本轮是否到齐 → 聚合」成为
   * **按构造的临界区**。当前实现里这几步都是同步块（单线程下本就原子），锁是防回归护栏：
   * 任何一处将来引入 await，多票并发就会互相覆盖（丢票 = 本轮永远等不齐）。
   */
  const settleChains = new Map<string, Promise<unknown>>();
  function withStateLock<T>(instId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = settleChains.get(instId) ?? Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    settleChains.set(instId, run.then(() => undefined, () => undefined));
    return run;
  }

  /** 投票步的票号列表（0 起，与 `Verdict.check_index` 同值） */
  function voterIndices(step: StepDef): number[] {
    return Array.from({ length: voterCountOf(step) }, (_, i) => i);
  }

  /** 一票：委派 → 归一化 → 落账（单票失败不影响别的票：每票独立 catch） */
  async function runVote(
    instId: string, state: InstanceState, wf: WorkflowDef, step: StepDef,
    runId: string, index: number, count: number, attempt: number,
    controller: AbortController, startedAt: number,
  ): Promise<void> {
    const entry = step.check_voting![index]!;
    let verdict: Verdict;
    try {
      verdict = await ports.verify({
        instId, step, workflow: wf, userTask: state.user_task,
        ownerSession: state.owner_session, checkIndex: index,
        // 该票的专属检查依据 + 序号：verify.ts 据此生成「你是 N 个之一」的投票提示词。
        voter: { index: index + 1, count, check: entry.check },
        artifactsRelDir: artifactsRelDirOf(instId),
        // 模型优先级链（对齐 opencode）：**该票 `model`** > 全局 `adversarial_check.model` >
        // 发起会话当前模型。（`check_voting` 与步骤 `check_model` 同写是加载期硬错误，
        // 所以这条链上没有 check_model 那一级。）
        model: resolveCheckModel(entry.model ?? wf.adversarial_check?.model),
        // 每票一个独立取消句柄：取消 / 重开审查门时 N 票一起中止（见 abortInstance）。
        signal: controller.signal,
        logEvent: (level, event, extra) => logEvent(instId, level, event, extra),
      });
    } catch (e) {
      verdict = { check_index: index, status: "infra", reason: `验证未跑成：${msg(e)}`, step_id: step.id, ts: new Date().toISOString() };
    }
    dropAbort(instId, controller); // 判定已回（无论成败）：这笔的取消句柄使命结束
    // 归一化（fail-closed）+ **强制票号**：这一票是哪一号由引擎说了算，端口返回的 check_index 不可信。
    verdict = { ...normalizeVerdict(verdict, step.id, index), check_index: index };
    const settled = await settleVote(instId, runId, verdict, step, index, count, attempt, startedAt);
    // 本票是**最后一张**到终态的票 → 由它触发一次聚合（实例锁 + 该判据保证只有一笔能进来）。
    if (settled.roundComplete) await aggregateVotingRound(instId, wf, step, attempt, count, startedAt);
  }

  /**
   * 单票判定落账（**锁内**读-改-写）+ 实时进度播报。
   *
   * 归属校验与单 check 路径同一判据：`delegations` 里仍登记着本 runId（被清掉/被替换 =
   * 本笔已作废，例如审查门重开 / 取消 / 孤儿恢复）。作废的判定一律丢弃，不写状态机。
   */
  async function settleVote(
    instId: string, runId: string, verdict: Verdict, step: StepDef,
    index: number, count: number, attempt: number, startedAt: number,
  ): Promise<{ roundComplete: boolean }> {
    return withStateLock(instId, () => {
      const fresh = readState(instId);
      const ownsRun = !!fresh && fresh.delegations.some((d) => d.run_id === runId);
      if (!fresh || !fresh.active || fresh.paused || fresh.current_step !== step.id || !ownsRun) {
        const why = !fresh ? "instance_state_missing"
          : !fresh.active ? "instance_inactive"
          : fresh.paused ? "instance_paused"
          : fresh.current_step !== step.id ? "step_changed"
          : "run_superseded";
        log("warn", "verdict_discarded", { instId, reason: why, status: verdict.status, step: step.id, runId, voter: index + 1 });
        stopHeartbeat(instId, runId); // 本笔已作废：心跳没有任何意义了
        return { roundComplete: false };
      }
      stopHeartbeat(instId, runId);
      fresh.delegations = fresh.delegations.filter((d) => d.run_id !== runId);
      fresh.verdicts.push(verdict);
      // 每票一条轨迹。**刻意不用 `verdict_*` 事件名**：报告里的「失败轮数」按 `verdict_failed`
      // 计数，逐票记会把「一轮里 2 票失败」错记成 2 轮 —— 轮级结论由聚合那一步写 `verdict_*`。
      pushHistory(fresh, "voter_verdict", `验证者 ${index + 1}/${count} [${verdict.status}] ${verdict.reason.slice(0, 200)}`, step.id);
      writeState(fresh, instId);
      // 每票实时进度（对齐 opencode 的 onVoteProgress）：长投票不再无声。
      const line = voterProgressLine({ index, status: verdict.status, reason: verdict.reason }, step.check_voting![index], count, attempt > 1);
      notify(fresh, `🔍 ${line.text}`, line.summary);
      // 判定入执行日志：`reason` **全文不截断**（§3.2），带票号、轮次与耗时。
      log("info", "voter_verdict", {
        instId, step: step.id, voter: index + 1, count, attempt,
        status: verdict.status, reason: verdict.reason, ms: Date.now() - startedAt,
      });
      // 全部票都到终态了 → 由**这一笔**（且只有这一笔：每笔只摘掉自己那笔委派，
      // 只有摘掉最后一笔的那一次会看到空集）触发一次聚合。
      return { roundComplete: fresh.delegations.length === 0 };
    });
  }

  /**
   * 一轮投票结束后的聚合（**锁内**，只跑一次）：
   * `failed > infra > 全过`；infra 首轮自动重试一次，重试仍 infra → 暂停（不计失败）。
   */
  async function aggregateVotingRound(
    instId: string, wf: WorkflowDef, step: StepDef, attempt: number, count: number, startedAt: number,
  ): Promise<void> {
    await withStateLock(instId, () => {
      const fresh = readState(instId);
      // 状态可能已被取消 / 暂停 / 推进（并发的人工动作）——最后一笔判定回来时再校验一次。
      if (!fresh || !fresh.active || fresh.paused || fresh.current_step !== step.id || fresh.delegations.length > 0) return;
      const verdicts = fresh.verdicts.filter((v) => verdictBelongsToStep(v, step.id));
      const asVotes: VoterVerdict[] = verdicts.map((v) => ({ index: v.check_index, status: v.status, reason: v.reason }));
      const entries = step.check_voting ?? [];
      const kind = decideVotingOutcome(asVotes);
      if (kind === "failed") {
        // 工作问题不被故障遮蔽：即使同时有 infra 票，也直接判失败反馈 DO
        //（infra 票在下一轮 DO 修复后自然重投）—— 见 opencode §4.3 决策表优先级 2。
        const reason = formatVotingFailureReason(asVotes, entries, count);
        pushHistory(fresh, "verdict_failed", reason.slice(0, 300), step.id);
        applyRoundOutcome(instId, fresh, wf, step, { kind: "failed", reason }, startedAt);
        return;
      }
      if (kind === "infra") {
        const infraVotes = asVotes.filter((v) => v.status === "infra");
        if (attempt < 2) {
          // ── 自动重试一次：只重跑故障票，已通过的保留（照抄 opencode §4.4）──
          const retry = infraVotes.map((v) => v.index).sort((a, b) => a - b);
          fresh.verdicts = fresh.verdicts.filter((v) => !(verdictBelongsToStep(v, step.id) && v.status === "infra"));
          pushHistory(fresh, "voting_infra_retry", `voters=${retry.map((i) => i + 1).join(",")}/${count}`, step.id);
          log("warn", "voting_infra_retry", { instId, step: step.id, voters: retry, attempt });
          writeState(fresh, instId);
          notify(fresh, `🔍 步骤 \`${step.id}\` 有 ${retry.length}/${count} 张票基础设施故障（不计失败），正在**自动重试**这些票；已通过的票不会重跑。`, `🔍 ${retry.length} 张验证票故障，自动重试中（已通过的保留）`);
          void launchVotingRound(instId, fresh, wf, step, retry, attempt + 1);
          return;
        }
        // 重试仍失败 → 基础设施故障暂停（不计失败次数）；continue 只重跑未通过的票。
        const reason = formatVotingInfraReason(asVotes, entries, count);
        pushHistory(fresh, "verdict_infra", reason.slice(0, 300), step.id);
        applyRoundOutcome(instId, fresh, wf, step, { kind: "infra", reason }, startedAt);
        return;
      }
      const reason = formatVotingPassReason(asVotes, entries, count);
      pushHistory(fresh, "verdict_passed", reason.slice(0, 300), step.id);
      applyRoundOutcome(instId, fresh, wf, step, { kind: "passed", reason }, startedAt);
    });
  }

  /**
   * 发起一轮投票（`indices` = 本轮要跑的票号；`attempt` 1 = 首轮 / 2 = infra 自动重试轮）。
   * 本函数只负责**发起**与等待；聚合与状态机由 {@link aggregateVotingRound} 负责。
   */
  async function launchVotingRound(
    instId: string, state: InstanceState, wf: WorkflowDef, step: StepDef,
    indices: number[], attempt: number,
  ): Promise<void> {
    const count = voterCountOf(step);
    const startedAt = Date.now();
    const stamp = new Date().toISOString();
    const runs = indices.map((index) => {
      const controller = new AbortController();
      addAbort(instId, controller);
      const runId = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${index}`;
      state.delegations.push({
        run_id: runId, check_index: index, attempt, ts: stamp,
        // 属主运行时（诊断）+ 心跳起点（判活的唯一依据）：N 票各有独立心跳，
        // 只要还有一笔在刷，别的会话 / 别的沙箱进程就不得把在飞委派当孤儿清掉。
        owner_runtime: runtimeId(), heartbeat_at: Date.now(),
      });
      return { runId, index, controller };
    });
    pushHistory(state, "verify_start", `voters=${indices.map((i) => i + 1).join(",")}/${count}${attempt > 1 ? "（infra 自动重试）" : ""}`, step.id);
    writeState(state, instId);
    for (const r of runs) startHeartbeat(instId, r.runId);
    log("info", "verify_start", { instId, step: step.id, voters: indices, count, attempt });
    // 阶段播报：与单 check 同一套「正在发生什么 / 要不要你操作 / 去哪看进度」，
    // 只把「一个验证者」换成「N 个验证者并行」这层事实。**依旧绝不给时长预估**。
    if (attempt > 1) {
      notify(state, [
        `🔍 步骤 \`${step.id}\` 的 ${indices.length} 张故障票正在**自动重试**（已通过的票不重跑）。`,
        "",
        `**不需要你做任何操作** —— 重试结果会自动汇总。`,
      ].join("\n"), `🔍 步骤 ${step.id} 的故障票自动重试中（无需操作）`);
    } else {
      const basisLines = indices.map((i) => `- ${i + 1}/${count} ${(step.check_voting![i]?.check ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 60) ?? ""}`);
      notify(state, [
        `🔍 步骤 \`${step.id}\` 已交卷，${indices.length} 个独立验证者（独立会话，看不到本对话）正在**并行**取证判定，各查一条检查依据，**全过才放行**。`,
        "",
        `**本轮检查依据**（供你了解，不用回复）：`,
        ...basisLines,
        "",
        `**这一步你是异步等待的，不需要做任何操作** —— 验证者跑完会自动唤醒本会话并继续工作流。它们现在正在读文件、跑命令取证，你在会话里看得到它们在做什么。`,
        "",
        `期间你可以：`,
        `- 直接在此会话补充信息或纠正方向（会被模型看到）`,
        `- 用 \`/ralphflow-status\` 随时查看每张票的进度与最近轨迹`,
        `- 想中止就 \`/ralphflow-cancel\``,
      ].join("\n"), `🔍 步骤 ${step.id} 已交卷，${indices.length} 个独立验证者并行取证（无需操作）`);
    }
    // N 票并发：每票独立等待、独立落账、独立 catch（一票失败不影响别的票）。
    await Promise.all(runs.map((r) => runVote(instId, state, wf, step, r.runId, r.index, count, attempt, r.controller, startedAt)));
  }

  /**
   * 把一个**已聚合的**验证结论应用到状态机（T2：推进只由这里按判定算出）。
   *
   * 单 `check` 与多验证者投票共用这一段：调用方只提供 `{kind, reason}`（单 check 就是那张票的
   * 判定；投票是聚合后的整体结论与聚合文案），暂停 / 返工 / 审查门 / 推进的规则逐字沿用，
   * 保证「有 check 的步骤」的行为不因投票支持而改变。
   */
  function applyRoundOutcome(
    instId: string,
    state: InstanceState,
    wf: WorkflowDef,
    step: StepDef,
    outcome: { kind: VerdictStatus; reason: string },
    startedAt: number,
  ): void {
    const reason = outcome.reason;
    if (outcome.kind === "infra") {
      state.paused = true;
      state.pause_reason = "check_infra";
      logPause(instId, state, "check_infra", { status: outcome.kind, ms: Date.now() - startedAt });
      writeState(state, instId);
      notify(state, `⏸ 验证未跑成（基础设施问题，不计失败）：${reason}\n\n修复后运行 \`/ralphflow-continue\` 重新验证。`, `⏸ 验证未跑成（基础设施问题），已暂停步骤 ${step.id}`);
      return;
    }
    if (outcome.kind === "failed") {
      const failedTimes = bumpFailCount(state, step.id);
      const max = step.max_fail_count ?? 3;
      if (failedTimes >= max) {
        state.paused = true;
        state.pause_reason = "max_failures";
        logPause(instId, state, "max_failures", { failedTimes, max });
        writeState(state, instId);
        notify(state, `⏸ 步骤 \`${step.id}\` 连续 ${failedTimes} 轮未通过（上限 ${max}），已暂停等你定夺。\n\n验证者的意见：\n${reason}\n\n处理后可运行 \`/ralphflow-continue\` 重新验证，或 \`/ralphflow-cancel\` 结束。`, `⏸ 步骤 ${step.id} 连续 ${failedTimes} 轮未通过，已暂停等你定夺`);
        return;
      }
      // 返工：按 **on_fail** 回退（design §4「按 on_fail 回退」）。on_fail 缺省指自身。
      const targetId = failStepId(wf, step);
      const target = stepOf(wf, targetId);
      if (!target) {
        // on_fail 指向 "done" 或不存在的步骤 —— 坏定义，绝不静默跳步
        state.paused = true;
        state.pause_reason = "check_infra";
        pushHistory(state, "rework_target_invalid", `on_fail=${targetId}`, step.id);
        logPause(instId, state, "check_infra", { detail: "rework_target_invalid", target: targetId });
        writeState(state, instId);
        notify(state, `⏸ 步骤 \`${step.id}\` 的 \`on_fail\` 指向 \`${targetId}\`，不是可回退的步骤，已暂停（引擎拒绝跳步）。`, `⏸ 步骤 ${step.id} 的 on_fail 定义无效，已暂停`);
        return;
      }
      state.do_submitted = false;
      state.verdicts = [];
      stopHeartbeatsOf(instId, state.delegations);
      state.delegations = [];
      if (target.id !== step.id) {
        state.current_step = target.id;
        pushHistory(state, "rework_rewind", `${step.id} → ${target.id}`, target.id);
        log("info", "rework_rewind", { instId, from: step.id, to: target.id });
      }
      writeState(state, instId);
      deliverStepDo(state, instId, wf, target, `🔄 步骤 ${target.id} 验证未通过，自动返工（${step.id} 第 ${failedTimes} 次）`, reason);
      return;
    }
    // 全 passed（且判定属于当前步）
    clearFailCount(state, step.id);
    if (isGate(wf, step) && allPassedVerified(state, step)) {
      // 审查门打开（有 check：验证通过后停门等放行）
      logEvent(instId, "info", "gate_opened", { step: step.id, kind: "verified", ms: Date.now() - startedAt });
      writeState(state, instId);
      notify(state, `🙋 步骤 \`${step.id}\` 已通过独立验证，停在审查门等你放行。\n\n确认无误运行 \`/ralphflow-continue\` 进入下一步；需要修改就直接说明，改完重新交卷会再次验证。`, `🙋 步骤 ${step.id} 已通过验证，停在审查门等你放行`);
      return;
    }
    writeState(state, instId);
    advance(instId, state, wf, step);
  }

  /** 推进（T2）：只有这里改 current_step */
  function advance(instId: string, state: InstanceState, wf: WorkflowDef, step: StepDef): void {
    // 暂停中绝不推进（防御性护栏）：暂停是「等用户」的状态，
    // 任何推进都会给模型投递 DO 提示，而暂停时 ralphflow_submit 会被拒绝 → 模型白干。
    // 正常路径下调用方已保证非暂停；这里只作兜底，不掩盖真实缺陷。
    if (state.paused) {
      log("warn", "advance_refused_paused", { instId, step: step.id, reason: state.pause_reason });
      return;
    }
    const target = nextStepId(wf, step);
    logEvent(instId, "info", "advance", { from: step.id, to: target });
    if (target === "done") { complete(instId, state, wf); return; }
    const next = stepOf(wf, target);
    if (!next) {
      // 加载期已校验，这里只作兜底（坏定义不得静默跳步）
      state.paused = true;
      state.pause_reason = "check_infra";
      pushHistory(state, "advance_target_missing", target);
      logPause(instId, state, "check_infra", { detail: "advance_target_missing", target });
      writeState(state, instId);
      notify(state, `⏸ 工作流定义里 on_pass 指向的步骤 \`${target}\` 不存在，已暂停（引擎拒绝跳步）。`, `⏸ 工作流定义错误（on_pass 指向 ${target} 不存在），已暂停`);
      return;
    }
    state.current_step = next.id;
    state.do_submitted = false;
    state.verdicts = [];
    stopHeartbeatsOf(instId, state.delegations);
    state.delegations = [];
    state.last_submit_summary = undefined;
    // 不在这里清 fail_counts：通过时已 `clearFailCount`（该步失败史了结）。
    // 若用 on_fail 回退到一个「失败过但尚未通过」的步骤，它自己的计数应保留 ——
    // 这既避免把前一步的失败算到它头上，也让成环的 on_fail 仍能触及 max_fail_count。
    pushHistory(state, "step_start", next.desc ?? "", next.id);
    logEvent(instId, "info", "step_start", { step: next.id });
    writeState(state, instId);
    // 播报必须诚实：下一步没有检查依据时不得宣称「会自动进入独立验证」（有检查依据的分支逐字不变）
    // reset 门（`reset: true`）在**这里**生效：先整段替换可见面，再投递本步 DO。
    deliverStepDo(state, instId, wf, next, stepHasVerification(next)
      ? (voterCountOf(next) > 0
        ? `▶️ 步骤 ${next.id} 开始执行${next.desc ? `：${next.desc}` : ""}（完成后会自动进入 ${voterCountOf(next)} 个验证者的并行验证）`
        : `▶️ 步骤 ${next.id} 开始执行${next.desc ? `：${next.desc}` : ""}（完成后会自动进入独立验证）`)
      : `▶️ 步骤 ${next.id} 开始执行${next.desc ? `：${next.desc}` : ""}（未配置 check / check_voting：完成后跳过对抗性验证）`);
  }

  function complete(instId: string, state: InstanceState, wf: WorkflowDef): void {
    pushHistory(state, "complete", `workflow=${wf.name}`);
    state.active = false;
    state.paused = false;
    state.pause_reason = undefined;
    state.do_submitted = false;
    // 执行日志：必须在销毁实例目录**之前**落（destroyInstance 会归档日志副本并发 destroy 事件）
    logEvent(instId, "info", "complete", { workflow: wf.name });
    // 报告用**内存里的 state** 渲染（含刚落账的 complete 事件），落盘再删纯属浪费；
    // 销毁顺序与失败分支都在 destroyInstance 里（不变量 2/3）。
    const destroyed = destroyInstance(instId, "done", state);
    if (destroyed) {
      const rel = reportRelPathOf(instId);
      // 诚实播报：只有**复查确认**实例目录真没了，才说「已销毁」；否则如实说残留并指向 doctor。
      if (destroyed.instanceDirRemoved) {
        notify(
          state,
          `✅ 工作流 \`${wf.name}\` 完成，报告已归档到 \`${rel}\`。\n\n实例目录已销毁、产出目录保留；历史运行可在 \`/ralphflow-list\` 的「历史运行」节里找到。`,
          `✅ 工作流 ${wf.name} 完成（报告 ${rel}）`,
        );
      } else {
        notify(
          state,
          `✅ 工作流 \`${wf.name}\` 完成，报告已归档到 \`${rel}\`。\n\n⚠️ 但**实例目录未能删除**（残留 \`${destroyed.instanceDir}\`），未销毁：请检查该目录是否被占用/权限是否可写；\`/ralphflow-doctor\` 会把它报出来，确认无需保留后可手动删除。产出目录保留。`,
          `⚠️ 工作流 ${wf.name} 完成，但实例目录未销毁（残留，见 doctor）`,
        );
      }
    }
  }

  function deliver(state: InstanceState, text: string, summary?: string): void {
    if (!state.owner_session) return;
    const ok = ports.deliver(state.owner_session, text, summary);
    if (!ok) log("warn", "deliver_failed", { instId: state.owner_session });
  }

  // ─── reset 门（步骤级 `reset: true`）────────────────────────────────────────

  /** 失败原因 → 用户能读懂的一行（播报用；绝不把宿主异常原文塞给用户） */
  function resetFailureText(outcome: ResetOutcome): string {
    switch (outcome.reason) {
      case "not_idle": return "不在步骤边界的空闲窗口（替换必须发生在工具调用之外）";
      case "instance_gone": return "实例已被取消/结束（等空闲窗口期间收摊了）";
      case "unbalanced": return "会话可见面在工具配对处不平衡（有未回答的工具调用）";
      case "balance_error": return "会话可见面已损坏（工具配对自检失败）";
      case "surface_too_short": return "可见面没有可替换的对话";
      case "no_session": return "拿不到属主会话";
      case "no_maintenance": return "宿主没有空闲互斥入口（agent.runMaintenance）";
      case "aborted": return "被中止";
      default: return "宿主拒绝了这次替换";
    }
  }

  /**
   * 组装 reset 门的投递物：**交接稿**（模型可见，写小——会被 dsh 自动压缩总结掉）+
   * **可见告知**（append 来源，Chat 显示；随后被同一次替换遮蔽，模型看不到）。
   *
   * 交接稿只写**能现算**的四项（决定①：不含「已完成勾选」，因此不新增任何状态字段）：
   * 工作流名 / 第几步 / 产出目录 / 交互契约。任务描述不必写 —— 紧随其后的 DO 提示词
   * 自带「## 任务」。
   */
  function resetRequestFor(instId: string, wf: WorkflowDef, step: StepDef): ResetRequest {
    const idx = wf.steps.findIndex((s) => s.id === step.id) + 1;
    const rel = artifactsRelDirOf(instId);
    const hasCheck = stepHasVerification(step);
    const voters = voterCountOf(step);
    const contract = hasCheck
      ? (voters > 0
        ? `本步完成后调用 \`ralphflow_submit\` 交卷；交卷后 ${voters} 个独立验证者并行取证判定，全过才放行。`
        : "本步完成后调用 `ralphflow_submit` 交卷；交卷后由独立验证者取证判定。")
      : (isGate(wf, step)
        ? "本步完成后调用 `ralphflow_submit` 交卷；本步不配置对抗性检查（跳过对抗性验证），交卷后停在审查门等用户放行。"
        : "本步完成后调用 `ralphflow_submit` 交卷；本步不配置对抗性检查（跳过对抗性验证）。");
    const handoff = [
      "[ralphflow 交接稿] 上下文已在步骤边界重置：此前对话已移出模型上下文。",
      "",
      `- 工作流：\`${wf.name}\`（第 ${idx}/${wf.steps.length} 步）`,
      `- 当前步骤：\`${step.id}\`${step.desc ? ` — ${step.desc}` : ""}`,
      `- 产出目录：\`${rel}/\``,
      `- 交互契约：${contract}`,
      "",
      "请只依据本稿与紧随其后的本步 DO 提示行事（原始记录仍留在会话日志里，可复盘）。",
    ].join("\n");
    return {
      handoff,
      notice: {
        summary: `♻️ 步骤 ${step.id} 开始前已重置上下文（换入交接稿）`,
        // 这条告知是给用户看的：替换消息本身在 Chat 里不显示，不告知就成了
        // 「用户看到的 ≠ 模型看到的」且是静默的（决定②）。
        text: `[ralphflow] 本步（\`${step.id}\`）开始前做了上下文重置：此前对话已移出模型上下文，整段替换为一条交接稿（工作流 / 步骤 / 产出目录 / 交互契约）。本行是给用户看的可见告知——替换节点在 Chat 里不显示，模型上下文里也没有这条告知。`,
      },
    };
  }

  /**
   * 「本步 DO 还没送达」的实例（**纯内存**，不落盘、不是 InstanceState 字段）。
   *
   * `reset: true` 的步骤：推进若发生在**工具调用内部**（审查门放行 / 无 check 步骤交卷），
   * 替换要等驱动器收工（`whenIdle`）才做得成，所以 DO 会**晚一拍**才进收件箱。
   * 这期间宿主的 `agent/turn-stopping` 会照常发问，而它看到的是「收件箱空 + 本步未交卷」——
   * 若不拦，插件会对一个**模型还不知道存在**的步骤连催两轮，然后把实例暂停
   * （实测：`pause_reason=no_submit`，DO 反而落在已暂停的实例上）。
   */
  const pendingDoDelivery = new Set<string>();

  /**
   * 投递某一步的 DO。**带 `reset: true` 的步骤先做整段替换、再投递 DO**（顺序不可颠倒：
   * DO 若先落地就会被自己这次替换一并遮蔽掉）。
   *
   * 替换是异步的（宿主的 `runMaintenance` 返回 Promise），所以这里用 promise 链保证顺序；
   * **失败绝不吞掉 DO** —— 照常投递，并把失败原因如实写进用户可见的播报行。
   */
  function deliverStepDo(state: InstanceState, instId: string, wf: WorkflowDef, step: StepDef, summary: string, rework?: string): void {
    const text = doPrompt(instId, wf, state, step, rework);
    const sid = state.owner_session;
    if (step.reset !== true || !sid) {
      deliver(state, text, summary);
      return;
    }
    if (typeof ports.resetSurface !== "function") {
      // 端口没装配：不假装做过（带 reset 的步骤也照常执行，只是没有重置）
      log("warn", "reset_surface_unavailable", { instId, step: step.id });
      deliver(state, text, `${summary}（⚠️ 本步标了 \`reset: true\`，但本进程未装配重置端口：上下文未重置）`);
      return;
    }
    const req = resetRequestFor(instId, wf, step);
    // 替换是异步的（跨一个 maintenance 窗口）。若这段时间里实例已结束/被取消，
    // 就**不再投递 DO**（别把一条指令塞进一个已经收摊的实例）。
    //
    // ⚠️ 必须**重新读盘**：取消/完成走的是另一条 `readState`（每次 JSON.parse 新对象）
    // 并会销毁实例目录，advance 时读出的那个内存对象永远看不到状态变化。
    // （第一轮验证者 3/4 实测：闭包快照版本的护栏是空操作 —— 取消后替换照样提交、
    //   还把已取消工作流的 DO 投进了属主会话。）
    const stillLive = (): boolean => {
      try {
        const cur = readState(instId);
        return !!cur && cur.active === true && cur.current_step === step.id && cur.do_submitted === false;
      } catch { return false; }
    };
    req.canProceed = stillLive; // 载体在 append 之前同步复查一次（关掉「等窗口期间被取消」的竞态）
    // 从这一刻起「本步 DO 还没送达」——期间 turn-stopping 的「忘了交卷」提醒必须闭嘴
    pendingDoDelivery.add(instId);
    const releasePending = () => { pendingDoDelivery.delete(instId); };
    void Promise.resolve()
      .then(() => ports.resetSurface!(sid, req))
      .then((outcome) => {
        releasePending();
        if (!stillLive()) {
          log("info", "reset_do_dropped", { instId, step: step.id, reason: outcome.reason ?? "instance_not_live" });
          return;
        }
        if (outcome.ok) {
          log("info", "reset_surface_applied", { instId, step: step.id, shadowed: outcome.shadowed });
          logEvent(instId, "info", "reset_surface", { step: step.id, shadowed: outcome.shadowed, handoffSeq: outcome.handoffSeq, noticeSeq: outcome.noticeSeq });
          deliver(state, text, summary);
          return;
        }
        log("warn", "reset_surface_skipped", { instId, step: step.id, reason: outcome.reason, detail: outcome.detail });
        logEvent(instId, "warn", "reset_surface_skipped", { step: step.id, reason: outcome.reason ?? "unknown", detail: outcome.detail });
        deliver(state, text, `${summary}（⚠️ 本步的上下文重置未生效：${resetFailureText(outcome)}）`);
      })
      .catch((e) => {
        releasePending();
        log("warn", "reset_surface_failed", { instId, step: step.id, error: e instanceof Error ? e.message : String(e) });
        if (stillLive()) deliver(state, text, `${summary}（⚠️ 本步的上下文重置未生效：宿主异常）`);
      });
  }

  /**
   * 用户可见播报。**必须**给 summary —— 它是用户在时间线上不展开就能读到的那一行；
   * 不传就等于用户看不到（client 会退化成 opaque 注入行）。
   */
  function notify(state: InstanceState, text: string, summary: string): void {
    deliver(state, `[ralphflow] ${text}`, summary);
  }

  // ─── 报告归档 ──────────────────────────────────────────────────────────────

  function stepStatsOf(state: InstanceState, endTs: number): Array<{ step: string; ms: number; retries: number }> {
    return stepStats(state.history, state.fail_counts, endTs);
  }

  /**
   * 归档最终报告到 `<workspace>/.dsh/ralph-flow/reports/<instId>.md`。
   *
   * 返回**绝对路径**；写失败返回 `null`（**绝不吞掉失败**）：调用方
   * {@link destroyInstance} 依赖这个 `null` 决定「不销毁实例」——宁可留一个
   * doctor 能报出来、可人工抢救的可见残留，也不能静默丢掉全部轨迹。
   */
  function archiveReport(instId: string, state: InstanceState, wf: WorkflowDef, status: "done" | "cancelled"): string | null {
    try {
      // 报告与实例同属一个工作区（单根：实例目录在哪，报告就归档到哪）
      const target = reportsDir;
      fs.mkdirSync(target, { recursive: true });
      const end = new Date().toISOString();
      const endTs = new Date(end).getTime();
      const stats = stepStatsOf(state, endTs);
      const totalMs = Math.max(0, endTs - new Date(state.started_at).getTime());
      const totalFails = stats.reduce((a, s) => a + s.retries, 0);
      const artifactsRel = artifactsRelDirOf(instId);
      const lines = [
        `# ralphflow 报告 · ${wf.name}`,
        "",
        `- 实例：\`${instId}\``,
        `- 状态：**${status === "done" ? "完成" : "取消"}**`,
        `- 任务：${state.user_task}`,
        `- 开始：${state.started_at}`,
        `- 结束：${end}`,
        `- 总耗时：${formatDuration(totalMs)}`,
        `- 失败轮数：${totalFails}`,
        `- 产出目录：\`${artifactsRel}/\``,
        // §3.1：报告只新增**这一行**指路，其余内容逐字节不变（验收 2 用 diff 证明）。
        // 只在运行期日志确实存在时才写：日志压根没写出来时不指一个不存在的文件（诚实优先，
        // 也让「日志写失败」这件事在报告里表现为**少一行**而不是**假指路**）。
        ...(fs.existsSync(logFileOf(instId)) ? [`- 执行日志：\`${RALPH_FLOW_DIR}/reports/${instId}-execution.log\``] : []),
        "",
        "## 步骤耗时与重试",
        "",
        ...(stats.length > 0
          ? stats.map((d) => `- \`${d.step}\`：耗时 ${formatDuration(d.ms)} · 失败 ${d.retries} 轮`)
          : ["- （无步骤记录）"]),
        "",
        "## 轨迹",
        "",
        ...state.history.map((h) => `- \`${h.ts}\` **${h.event}**${h.step ? ` [${h.step}]` : ""}${h.detail ? ` — ${h.detail}` : ""}`),
        "",
        "## 判定",
        "",
        ...(state.verdicts.length > 0
          ? state.verdicts.map((v) => `- [${v.status}] ${v.step_id}: ${v.reason}`)
          : ["- （无判定记录）"]),
      ];
      const file = path.join(target, `${instId}.md`);
      fs.writeFileSync(file, lines.join("\n"), "utf-8");
      return file;
    } catch (e) {
      log("warn", "report_write_failed", { instId, error: msg(e) });
      return null;
    }
  }

  /**
   * 销毁一个已终止的实例：归档报告 → 除名 → 删实例目录 → 删**空**产出目录。
   *
   * 顺序本身是正确性的一部分（不变量 2）：`unlink(state.json)` 必须**先于**递归删目录，
   * 否则部分删除失败（Windows EBUSY 等）会留下一个「列表里看不到、磁盘上还在」的幽灵；
   * 反过来先除名，实例在任何失败下都不会复活成幽灵。
   *
   * **路径必须在除名之前解析并固定**（曾经的缺陷）：早期 `instanceDir()` / `statePath()` 都经
   * `workspaceOf(instId) = registry[instId] ?? projectDir`，先除名会让它们回落到引擎的
   * `projectDir`，跨工作区时删除静默打空（报告有了、目录还在）。索引已随「引擎按工作区
   * 实例化」一并删除，路径现在由单根目录直接给出；「先解析、后动手」的顺序仍保留。
   *
   * 返回 `{ reportPath, instanceDirRemoved }`；归档失败返回 `null` 且**不销毁**
   * （见不变量 3 与边界 2）。`state` 缺省从磁盘读；调用方（complete/cancel）传内存里的 state，
   * 这样报告里带着刚落账的最终事件，且不必为了渲染报告再落一次盘。
   * `instanceDirRemoved` 让调用方能**诚实播报**：只有真删掉了才说「实例目录已销毁」。
   */
  function destroyInstance(instId: string, status: "done" | "cancelled", state?: InstanceState):
    { reportPath: string; instanceDirRemoved: boolean; instanceDir: string } | null {
    const s = state ?? readState(instId);
    // 工作流加载不出来时也要能出报告：用 state 里的名字兜底，绝不让坏 YAML 变成「永不销毁」。
    const wf: WorkflowDef = s ? (loadWorkflow(s.workflow_name).def ?? { name: s.workflow_name, steps: [], warnings: [] }) : { name: instId, steps: [], warnings: [] };

    // 1) 销毁前抢救：报告必须在销毁前写完。写不出来就中止销毁。
    const reportPath = s ? archiveReport(instId, s, wf, status) : null;
    if (!reportPath) {
      log("warn", "report_archive_failed", { instId, status });
      if (s) {
        // 保留一个**可见**残留：把「已结束」写回磁盘，doctor 才能按「已结束但未销毁」报出来。
        // （这一步写 state 是安全的：实例目录本就存在且不打算删。）
        s.active = false;
        writeState(s, instId);
        notify(
          s,
          `⚠️ 实例 \`${instId}\` 的报告归档失败，已**保留**实例目录与 \`state.json\`，未销毁。\n\n` +
          `请检查工作区 \`${RALPH_FLOW_DIR}/reports/\` 是否可写（例如被同名文件占位）。\n` +
          `报告不会自动补写；残留可用 \`/ralphflow-doctor\` 查看，确认无需保留后可手动删除该实例目录。`,
          `⚠️ 报告归档失败，实例 ${instId} 未销毁`,
        );
      }
      return null;
    }

    // 1b) 执行日志随报告一起归档（§3.1）：先落 `destroy` 事件、再拷副本，归档的日志因此以
    //     `destroy` 收尾（副本必须在删目录之前拷）。**日志归档失败只告警、不阻塞销毁** ——
    //     与第 1 步「报告归档失败即中止销毁」是有意的不对称：报告是主事实，日志是辅助证据。
    logEvent(instId, "info", "destroy", { status });
    archiveExecutionLog(instId);

    // 2) 先把所有路径解析出来并固定：产出目录名存在 state.json 里，销毁后就查不到了。
    const artDir = artifactsDirOf(instId);
    const instDir = instanceDir(instId);
    const stPath = path.join(instDir, "state.json");
    // 3) 物理除名：即使第 4 步部分失败，实例也已从列表消失，不会变成幽灵。
    //    失败**不静默**（ENOENT 例外：文件本来就不在，不是异常）。
    try { fs.unlinkSync(stPath); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log("warn", "state_unlink_failed", { instId, path: stPath, error: msg(e) });
    }
    // 4) 递归删实例目录（失败告警：实例已经除名，但要留下可诊断痕迹，且播报不得谎称已销毁）。
    try {
      fs.rmSync(instDir, { recursive: true, force: true });
    } catch (e) {
      log("warn", "instance_dir_remove_failed", { instId, dir: instDir, error: msg(e) });
    }
    // 5) **本实例的**产出目录非递归删除：rmdir 拒绝非空目录，真实交付物永远活得比实例久。
    //    （注意用 artDir —— 第 2 步固定下来的那个；`artifactsDir` 是整个 artifacts/ 根目录。）
    try { fs.rmdirSync(artDir); } catch {}
    // 6) 复查：销毁必须是**事实**，而不只是"调用过删除"（播报要诚实，doctor 也要能报出残留）。
    const instanceDirRemoved = !fs.existsSync(instDir);
    if (!instanceDirRemoved) log("warn", "instance_dir_not_removed", { instId, dir: instDir });
    return { reportPath, instanceDirRemoved, instanceDir: instDir };
  }

  // ─── 对外动作 ──────────────────────────────────────────────────────────────

  function activeInstanceOfSession(sessionId: string): InstanceInfo | undefined {
    return listInstances().find((i) => i.state.active && i.state.owner_session === sessionId);
  }

  function start(workflowName: string, task: string, sessionId: string): ToolResult {
    if (!workflowName?.trim()) return { ok: false, text: "缺少工作流名。用法：`ralphflow_start(workflow, task)` 或 `/ralphflow-start <工作流> <任务>`。" };
    if (!task?.trim()) return { ok: false, text: "缺少任务描述。示例：`/ralphflow-start loop 修复登录模块的空指针`。" };
    const mine = activeInstanceOfSession(sessionId);
    if (mine) {
      return { ok: false, text: `当前会话已有活跃实例 \`${mine.id}\`（${mine.state.workflow_name} · ${mine.state.current_step}）。用 \`/ralphflow-continue\` 继续，或 \`/ralphflow-cancel\` 取消。` };
    }
    try { ensureLayout(); } catch {}
    const { def: wf, problems, warnings } = loadWorkflow(workflowName.trim());
    if (!wf) return { ok: false, text: `工作流 \`${workflowName}\` 无法启动：\n${problems.map((p) => `- ${p}`).join("\n")}` };
    const first = wf.steps[0]!;
    const instId = newInstId(wf.name);
    const now = new Date().toISOString();
    // 产出目录名在启动时**固定并落盘**：它不是派生量（子工作流将来会改写 user_task，
    // 名字事后无法重算），且必须与实例目录隔离（实例销毁后产出仍在）。
    const artifactsDirName = makeArtifactsDirName(task.trim(), instId);
    const state: InstanceState = {
      active: true, workflow_name: wf.name, current_step: first.id, user_task: task.trim(),
      fail_counts: {}, fail_count: 0, paused: false, do_submitted: false, owner_session: sessionId,
      delegations: [], verdicts: [], history: [], started_at: now, updated_at: now,
      artifacts_dir_name: artifactsDirName,
    };
    pushHistory(state, "start", `workflow=${wf.name}`, first.id);
    writeState(state, instId);
    // 执行日志：启动 + 首步 step_start（首步也给 step_start，机器才能只靠该事件枚举步骤）
    logEvent(instId, "info", "start", { workflow: wf.name, step: first.id });
    logEvent(instId, "info", "step_start", { step: first.id, index: 1 });
    // §1.7 产出目录：实例启动时建好，完成后**保留**（不随实例结束删除）。
    // 用刚算出的名字直接建，避免依赖已落盘的状态。
    try { fs.mkdirSync(path.join(artifactsDir, artifactsDirName), { recursive: true }); } catch {}
    log("info", "instance_start", { instId, workflow: wf.name, workspace: projectDir });
    const warnText = warnings.length > 0 ? `\n\n⚠️ 工作流定义告警：\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
    // reset 门（`reset: true`）在首步的**初次进入**无法生效，且必须如实说清为什么：
    // 首步 DO 是 `ralphflow_start` 工具的返回值，替换会落在工具调用内部 → 携带该 tool-call 的
    // assistant/message 被遮蔽、其 tool/result 之后 append 到新面尾部 → 孤儿 tool/result →
    // 静默损坏会话（docs/v2/reset-feasibility.md §1.2，违反不报错）。所以初次进入**不做**替换；
    // 这里既不静默跳过，也不硬来。
    //
    // ⚠️ 但**重试会正常重置**：返工是引擎在验证回调里投递的（空闲窗口），走 deliverStepDo 的
    // 同一条接线。这个区分很重要 —— 内置 loop 只有一步、永远是首步，它标 reset 的**目的**正是
    // 重试卫生（opencode 同款注释：「单步轻量循环：失败重试频繁」）。说成「首步永远不行」会让
    // loop 白白用不了 reset，也会误导作者。
    const firstStepResetNote = first.reset === true
      ? "⚠️ 本步标了 `reset: true`，但**工作流首步的初次进入无法做上下文重置**：首步的 DO 是启动工具的返回值，在工具调用内部替换会留下孤儿 tool/result（静默损坏会话）。**重试时会正常重置**（返工走空闲窗口）。"
      : "";
    if (first.reset === true) {
      // 级别用 info：这是**设计如此的结构事实**，不是问题，用户已在启动回执里看到说明。
      // 用 warn 会让**每次 loop 运行**（最常用的内置工作流）都记一条假告警 ——
      // execution-log-test 的「除日志写失败外无新增告警」会红。记下来仍有用：事后排查
      // 「我的 reset 为什么没生效」时它是唯一线索。
      log("info", "reset_skipped_first_step", { instId, step: first.id });
      logEvent(instId, "info", "reset_skipped_first_step", { step: first.id, reason: "do_is_tool_return" });
    }
    const text = [
      `🚀 已启动工作流 **${wf.name}**（实例 \`${instId}\`，共 ${wf.steps.length} 步）。${warnText}`,
      "",
      // 诚实标注：首步没有检查依据时**不得预告一次不会发生的独立验证**（与 doPrompt / advance 播报同一口径）。
      // 有 check 的分支与改造前**逐字相同**（回归基线）。
      stepHasVerification(first)
        ? (voterCountOf(first) > 0
          ? `接下来：模型执行本步 → 交卷 → **${voterCountOf(first)} 个独立验证者**（独立会话，看不到本对话）并行取证判定，**全过才放行** → 通过则推进，不通过自动返工。`
          : "接下来：模型执行本步 → 交卷 → **独立验证者**（独立会话，看不到本对话）取证判定 → 通过则推进，不通过自动返工。")
        : isGate(wf, first)
          ? "接下来：模型执行本步 → 交卷 → 本步**不配置对抗性检查**，会**跳过对抗性验证**（纯人工审查），停在审查门等你 `/ralphflow-continue` 放行。"
          : "接下来：模型执行本步 → 交卷 → 本步**不配置对抗性检查**，会**跳过对抗性验证**，直接进入下一步。",
      // reset 说明插在**无条件存在**的那个空行之前：不写 reset 时数组元素与基线逐字相同
      // （那个 `""` 是回归基线的一部分，绝不能因为条件插入而被吞掉——实测踩过）。
      ...(firstStepResetNote ? [firstStepResetNote] : []),
      "",
      "请现在开始执行上面的任务。",
    ].join("\n");
    return { ok: true, text: `${text}\n\n---\n\n${doPrompt(instId, wf, state, first)}` };
  }

  /**
   * 主会话交卷（三时刻①）。
   *
   * 交卷 = 模型**调用 `ralphflow_submit` 工具**（dsh 原生的完成方式：工具调用是事实，
   * 不是对模型自由文本做正则猜测）。宿主自己的结构化输出就是这么做的
   * （dsh-subagent-in-process-driver 注册 structured_output 工具，模型调用即完成，
   * 工具结果带 concludesTurn 由机器结束回合）。
   *
   * 返回 ToolResult：把「已受理 / 不能重复交卷 / 没有活跃实例」直接回给模型，
   * 而不是像文本标记那样静默失败。
   */
  function onSubmit(sessionId: string, summary?: string): ToolResult {
    const info = activeInstanceOfSession(sessionId);
    if (!info) {
      const others = listInstances().filter((i) => i.state.active);
      return {
        ok: false,
        text: others.length === 0
          ? "当前会话没有活跃的 ralphflow 实例，这次交卷未被受理。用 `/ralphflow-start <工作流> <任务>` 启动一个。"
          : `当前会话没有活跃实例，但项目里还有其它活跃实例：\n${others.map((i) => `- \`${i.id}\` — ${i.state.workflow_name} · ${i.state.current_step}`).join("\n")}\n\n交卷只对**本会话**的实例生效；要接管请用 \`/ralphflow-continue <实例ID>\`。`,
      };
    }
    const { id: instId, state } = info;
    if (state.paused) {
      return { ok: false, text: `实例 \`${instId}\` 处于暂停状态（${state.pause_reason}），交卷未被受理。先按提示处理，再用 \`/ralphflow-continue\` 恢复。` };
    }
    const { def: wf } = loadWorkflow(state.workflow_name);
    if (!wf) {
      log("warn", "workflow_missing_at_submit", { instId });
      return { ok: false, text: `工作流 \`${state.workflow_name}\` 已无法加载，交卷未被受理。用 \`/ralphflow-doctor\` 诊断。` };
    }
    const step = stepOf(wf, state.current_step);
    if (!step) return { ok: false, text: `实例状态损坏：当前步骤 \`${state.current_step}\` 不在工作流里。用 \`/ralphflow-cancel\` 结束。` };

    const text = (summary ?? noteTextFor(sessionId) ?? "").slice(-4000).trim();
    if (state.do_submitted) {
      // 本步已交卷。区分「门上改稿重交」与「重复交卷」：
      //   a) 停在审查门（判定已落）→ 用户说「改一下」，改完重交：打回重验（design §5/§6）。
      //   b) 门开着但验证还在飞 → 抢先重交：同样打回（reopenGate 会中止在飞委派）。
      //   c) 判定已落地且非门 → 是不必要的重复调用，明确告知模型（不再静默丢弃）。
      const gateOpen = atOpenGate(wf, state, step);
      const gatePending = isGate(wf, step) && state.delegations.length > 0;
      if (!gateOpen && !gatePending) {
        return {
          ok: false,
          text: state.delegations.length > 0
            ? `步骤 \`${step.id}\` 已交卷，独立验证者正在取证判定 —— **不要重复交卷**，等验证结果即可。`
            : `步骤 \`${step.id}\` 已经交卷并在处理中，**不需要重复交卷**。用 \`/ralphflow-status\` 查看状态。`,
        };
      }
      // 同一份内容重复交卷 → 不重复烧验证（防止模型一次做完连调两次工具）
      if (text && text === (state.last_submit_summary ?? "")) {
        log("info", "gate_resubmit_identical", { instId });
        // 无对抗性检查的步骤本来就没有验证：「未重复验证」会读成"验证发生过" → 分文本书写
        return {
          ok: false,
          text: stepHasVerification(step)
            ? "交卷内容与上一次完全相同，未重复验证。若你确实改动了产出，请简述改动后再交卷。"
            : "交卷内容与上一次完全相同，未重复受理。若你确实改动了产出，请简述改动后再交卷。",
        };
      }
      reopenGate(state, instId, step, "审查门上重新交卷（改稿）");
      state.do_submitted = true;
      state.last_submit_summary = text;
      pushHistory(state, "do_submitted", undefined, step.id);
    logEvent(instId, "info", "do_submitted", { step: step.id });
      // 无对抗性检查的步骤：不委派验证者，按定义声明（停门 / 直接推进）；skipVerification 内落盘
      if (!stepHasVerification(step)) {
        const atGate = skipVerification(instId, state, wf, step);
        return {
          ok: true,
          text: atGate
            ? `⏭ 已受理重新交卷：步骤 \`${step.id}\` 未配置 \`check\`/\`check_voting\`，已跳过对抗性验证（纯人工审查），仍停在审查门等你放行。`
            : `⏭ 已受理重新交卷：步骤 \`${step.id}\` 未配置 \`check\`/\`check_voting\`，已跳过对抗性验证，直接推进。`,
        };
      }
      writeState(state, instId);
      void launchVerification(instId, state, wf, step);
      return { ok: true, text: voterCountOf(step) > 0
        ? `🔍 已受理重新交卷，正在重新委派 ${voterCountOf(step)} 个独立验证者并行检查步骤 \`${step.id}\`（全过才放行）。`
        : `🔍 已受理重新交卷，正在重新委派独立验证者检查步骤 \`${step.id}\`。` };
    }

    state.do_submitted = true;
    state.last_submit_summary = text;
    pushHistory(state, "do_submitted", undefined, step.id);
    logEvent(instId, "info", "do_submitted", { step: step.id });
    if (!stepHasVerification(step)) {
      const atGate = skipVerification(instId, state, wf, step);
      return {
        ok: true,
        text: atGate
          ? `⏭ 交卷已受理：步骤 \`${step.id}\` 未配置 \`check\`/\`check_voting\`，已跳过对抗性验证（纯人工审查），停在审查门等你放行。`
          : `⏭ 交卷已受理：步骤 \`${step.id}\` 未配置 \`check\`/\`check_voting\`，已跳过对抗性验证，直接进入下一步。`,
      };
    }
    writeState(state, instId);
    void launchVerification(instId, state, wf, step);
    return { ok: true, text: voterCountOf(step) > 0
      ? `🔍 交卷已受理，${voterCountOf(step)} 个独立验证者（独立会话）正在并行取证判定，全过才放行。等它们返回即可，不要重复交卷。`
      : `🔍 交卷已受理，独立验证者（独立会话）正在取证判定。等它返回即可，不要重复交卷。` };
  }

  // ─── 交卷上下文捕获（**只**服务审查门重交去重；不落盘、不触发任何状态迁移）──────
  /**
   * 记下会话最近一条助手文本，作为 `ralphflow_submit` 未带 summary 时的兜底文本。
   *
   * **唯一用途**：审查门「同一份内容重复交卷 → 不重复烧验证」的去重判据
   * （见 onSubmit 里的 `state.last_submit_summary` 比较）。
   *
   * **T1 硬规则**：这段文本**绝不进入验证者视野**。`VerifyRequest` 里没有
   * `submitSummary` 字段，验证者 prompt 也不注入任何执行者自述（opencode 与
   * claude 版同样从不传入，并明令「不要依赖任何外部提供的实现总结」）。
   * 将来若想给它找新用途，先确认不违反 T1。
   *
   * 这是**纯上下文捕获**，不承担「检测交卷」的职责（那由 `ralphflow_submit` 工具承担）。
   * 只在内存里保留每个会话最后一条，避免无界增长。
   */
  const lastText = new Map<string, string>();
  function noteAssistantText(sessionId: string, text: string): void {
    if (!text) return;
    lastText.set(sessionId, text);
  }
  function noteTextFor(sessionId: string): string | undefined {
    return lastText.get(sessionId);
  }

  // ─── DO 阶段「忘了交卷」兜底（原生 agent/turn-stopping 驱动）─────────────────
  /**
   * 回合即将关闭时的判定：该不该提醒模型交卷。
   *
   * 文本标记时代这件事是静默的（模型忘了写标记 → 什么都没发生）。
   * 这里由原生 `agent/turn-stopping`（serial、可 await）在回合关闭前发问：
   * 有活跃实例、本步未交卷、未暂停、无在飞委派 → 模型干完了却没交卷。
   *
   * 提醒次数从 history 派生（不新增状态字段，宪法 §10.4）；达到上限则暂停等用户，
   * 绝不死循环催促。
   */
  function submitReminderCount(state: InstanceState, stepId: string): number {
    return state.history.filter((h) => h.event === "submit_reminder" && h.step === stepId).length;
  }

  function remindToSubmit(sessionId: string): { remind: boolean; message?: string; summary?: string } {
    const info = activeInstanceOfSession(sessionId);
    if (!info) return { remind: false };
    const { id: instId, state } = info;
    // 本步的 DO 还没送达（`reset: true` 的步骤要等空闲窗口做完替换才投递）：此刻催交卷是**错的**
    // —— 模型还不知道这一步存在。不拦的话，两轮提醒后会把实例暂停（pause_reason=no_submit），
    // 而 DO 随后落在一个已暂停的实例上（第二轮验证者 2/4 实测）。
    if (pendingDoDelivery.has(instId)) return { remind: false };
    if (state.paused || state.do_submitted || state.delegations.length > 0) return { remind: false };
    const { def: wf } = loadWorkflow(state.workflow_name);
    const step = wf ? stepOf(wf, state.current_step) : undefined;
    if (!wf || !step) return { remind: false };

    const max = 2;
    const used = submitReminderCount(state, step.id);
    if (used >= max) {
      // 反复提醒仍不交卷 → 停下来让用户处理，不再自动催（避免死循环）
      state.paused = true;
      state.pause_reason = "no_submit";
      pushHistory(state, "reminder_exhausted", `${used} 次提醒后仍未交卷`, step.id);
      logPause(instId, state, "no_submit", { used, max });
      writeState(state, instId);
      log("warn", "submit_reminder_exhausted", { instId, step: step.id, used });
      return {
        remind: false,
        summary: `⏸ 步骤 ${step.id} 反复未交卷，已暂停等你处理`,
        message: `⏸ 步骤 \`${step.id}\` 已提醒 ${used} 次仍未收到交卷，已暂停等你处理。\n\n如果工作其实做完了：让模型调用 \`ralphflow_submit\` 交卷，再 \`/ralphflow-continue\`。\n如果它卡住了：说明情况或 \`/ralphflow-cancel\` 结束。`,
      };
    }
    pushHistory(state, "submit_reminder", `第 ${used + 1} 次`, step.id);
    writeState(state, instId);
    const n = used + 1;
    // 诚实标注：无检查依据的步骤本就不验证，不能说「独立验证不会自动开始」（那是另一回事）；
    // 门步还要说清「停在审查门等用户放行」，不能写成「直接继续」（与 doPrompt 同一口径）。
    const noSubmitReason = stepHasVerification(step)
      ? "独立验证不会自动开始"
      : isGate(wf, step)
        ? "本步是纯人工审查门（未配置 `check` / `check_voting`）：交卷后**跳过对抗性验证**，停在审查门等用户放行"
        : "工作流不会推进（本步未配置 `check` / `check_voting`，交卷后跳过对抗性验证直接继续）";
    return {
      remind: true,
      summary: `⚠️ 步骤 ${step.id} 尚未交卷（第 ${n}/${max} 次提醒）`,
      message: `[ralphflow] 提醒（第 ${n}/${max} 次）：本步（\`${step.id}\`）还没交卷，${noSubmitReason}。\n\n如果任务已完成，请调用 \`ralphflow_submit\` 工具交卷；如果还没做完，继续做。\n如果你正在等用户回答或需要用户介入，请直接说明，不必交卷。`,
    };
  }

  /** 三时刻③：推进的唯一人工入口（fail-closed） */
  function continueInstance(sessionId: string, instanceRef?: string): ToolResult {
    let info = activeInstanceOfSession(sessionId);
    if (!info && instanceRef) {
      const target = listInstances().find((i) => i.state.active && (i.id === instanceRef || i.id.startsWith(instanceRef)));
      if (!target) return { ok: false, text: `找不到活跃实例 \`${instanceRef}\`（用 \`/ralphflow-list\` 查看）。` };
      // 接管：属主会话已不在（或用户显式指定），把归属转到当前会话
      target.state.owner_session = sessionId;
      pushHistory(target.state, "adopted", `by ${sessionId}`);
      logEvent(target.id, "info", "adopted", { by: sessionId });
      writeState(target.state, target.id);
      info = target;
    }
    if (!info) {
      // 本会话无活跃实例：列出全部活跃实例供接管（opencode 同款体验，不再给裸错误）
      const others = listInstances().filter((i) => i.state.active);
      if (others.length === 0) {
        return { ok: false, text: "当前会话没有活跃实例，也没有其它活跃实例可接管。用 `/ralphflow-start <工作流> <任务>` 启动一个。" };
      }
      return {
        ok: false,
        text: `当前会话没有活跃实例，但存在以下活跃实例：\n${others.map((i) => `- \`${i.id}\` — ${i.state.workflow_name} · ${i.state.current_step} · ${i.state.owner_session ? "有属主" : "无属主"}`).join("\n")}\n\n要接管哪个？用 \`/ralphflow-continue <实例ID>\` 指定。`,
      };
    }
    const { id: instId, state } = info;
    const { def: wf, problems } = loadWorkflow(state.workflow_name);
    if (!wf) return { ok: false, text: `工作流 \`${state.workflow_name}\` 已无法加载：\n${problems.map((p) => `- ${p}`).join("\n")}` };
    const step = stepOf(wf, state.current_step);
    if (!step) return { ok: false, text: `实例状态损坏：当前步骤 \`${state.current_step}\` 不在工作流里。用 \`/ralphflow-cancel\` 结束。` };

    // ① 暂停中 → 解除暂停
    if (state.paused) {
      const reason = state.pause_reason;
      // 投票步的 `check_infra` 恢复：**已通过的票保留**，只重跑未出终态的票
      // （照抄 opencode §5.3「continue 把 infra_failed 重置为 pending，passed 不动」）。
      // 其它情形（max_failures / no_submit / 非投票步）保持原语义：清空判定重新验证。
      const resumeVoting = voterCountOf(step) > 0 && reason === "check_infra" && state.do_submitted;
      const keptVerdicts = resumeVoting
        ? state.verdicts.filter((v) => verdictBelongsToStep(v, step.id) && v.status === "passed")
        : [];
      state.paused = false;
      state.pause_reason = undefined;
      state.verdicts = keptVerdicts;
      stopHeartbeatsOf(instId, state.delegations);
      state.delegations = [];
      // 重置当前步失败计数：这是投递给模型的机制说明（tools.ts / SHARED_MECHANISM）明确承诺的
      // 「重置失败计数并重试」。不清零的话，max_failures 恢复后只要再失败一次就立刻二次暂停，
      // 用户永远拿不到「修好→重试」的机会。
      clearFailCount(state, state.current_step);
      pushHistory(state, "resume", `from=${reason}`);
      logEvent(instId, "info", "resume", { step: state.current_step, from: reason });
      writeState(state, instId);
      if (state.do_submitted) {
        // 无对抗性检查的步骤从不委派验证者（否则会为一步「作者已声明免验证」的步骤凭空造出判定）
        if (!stepHasVerification(step)) {
          const atGate = skipVerification(instId, state, wf, step);
          return {
            ok: true,
            text: atGate
              ? `▶️ 已解除暂停（原因：${reason}）。步骤 \`${step.id}\` 未配置 \`check\`/\`check_voting\`，已跳过对抗性验证，停在审查门等你放行。`
              : `▶️ 已解除暂停（原因：${reason}）。步骤 \`${step.id}\` 未配置 \`check\`/\`check_voting\`，已跳过对抗性验证，直接进入下一步。`,
          };
        }
        if (resumeVoting) {
          const done = new Set(keptVerdicts.map((v) => v.check_index));
          const pending = voterIndices(step).filter((i) => !done.has(i));
          if (pending.length === 0) {
            // 防御性：全部票都已在手却停在 check_infra（不该发生）→ 按已通过处理，绝不死循环。
            const votes: VoterVerdict[] = keptVerdicts.map((v) => ({ index: v.check_index, status: v.status, reason: v.reason }));
            applyRoundOutcome(instId, state, wf, step, { kind: "passed", reason: formatVotingPassReason(votes, step.check_voting ?? [], voterCountOf(step)) }, Date.now());
            return { ok: true, text: `▶️ 已解除暂停（原因：${reason}）：步骤 \`${step.id}\` 的判定已全部通过，已推进。` };
          }
          // 重试预算随用户 continue **重置**（新的一次赦免）：再故障仍会自动重试一次。
          void launchVotingRound(instId, state, wf, step, pending, 1);
          return { ok: true, text: `▶️ 已解除暂停（原因：${reason}）：保留已通过的 ${done.size} 票，正在重新验证其余 ${pending.length} 票（基础设施故障不计失败）。` };
        }
        void launchVerification(instId, state, wf, step);
        return { ok: true, text: `▶️ 已解除暂停（原因：${reason}），正在重新委派独立验证者检查步骤 \`${step.id}\`。` };
      }
      deliver(state, doPrompt(instId, wf, state, step), `▶️ 步骤 ${step.id} 继续执行`);
      return { ok: true, text: `▶️ 已解除暂停（原因：${reason}），已让模型继续步骤 \`${step.id}\`。` };
    }

    // ② 有在飞委派 → 不重复推进（防重复委派）
    if (state.delegations.length > 0) {
      if (state.delegations.some(delegationOwnerAlive)) {
        return { ok: false, text: `🔍 步骤 \`${step.id}\` 的独立验证者仍在取证判定中，现在不需要你操作——它跑完会自动唤醒本会话并继续。\n\n想了解进度用 \`/ralphflow-status\`；想中止用 \`/ralphflow-cancel\`。` };
      }
      // 心跳全停了 = 属主已失联（进程崩溃/被重启），判定永远回不来。绝不把用户卡在一个
      // 永远不会结束的「验证中」幽灵状态：按孤儿兜底，并**立刻重新委派**（用户显式动作，
      // 不必等下一个 restore 触发点）。投票步同样只重跑未通过的票。
      stopHeartbeatsOf(instId, state.delegations);
      state.delegations = [];
      pushHistory(state, "orphan_delegation_recovered", "via=continue");
      log("warn", "orphan_delegation_recovered", { instId, via: "continue" });
      writeState(state, instId);
      void launchVerification(instId, state, wf, step);
      return { ok: true, text: `🔍 步骤 \`${step.id}\` 的验证属主已失联（那个运行时已经不在了），判定不可能回来 —— 已按孤儿兜底并**重新委派**独立验证者。` };
    }

    // ③ 放行判据（design §12.1 精修后的两支，机械可判）：
    //    有检查依据 → 判定齐 ∧ 全 passed ∧ 归属本步；
    //    无检查依据 → **工作流定义已声明本步免验证**（`stepHasVerification` 只读 StepDef，执行者无法影响）。
    //    （审查门 / 普通步共用这一条：免验证的普通步在交卷时已直接推进，走到这里的是门。）
    if (allPassedVerified(state, step) || !stepHasVerification(step)) {
      const byDefinition = !stepHasVerification(step);
      if (byDefinition) noteCheckSkipped(instId, state, step);
      if (isGate(wf, step)) {
        pushHistory(state, "gate_released", undefined, step.id);
        logEvent(instId, "info", "gate_released", { step: step.id, verified: !byDefinition });
      }
      advance(instId, state, wf, step);
      // 审查门放行是**在工具调用内部**推进的：若下一步标了 `reset: true`，替换必须等本回合
      // 结束（空闲窗口）才做得成，所以它的 DO 会**稍后**才到。这里如实说明，免得模型以为
      // 「已推进 = 现在开始干下一步」而在没有 DO 的情况下盲干（那部分工作也会被随后的重置遮蔽）。
      const afterGate = nextStepId(wf, step);
      const afterStep = afterGate === "done" ? undefined : stepOf(wf, afterGate);
      const deferredNote = afterStep?.reset === true
        ? `\n\n⚠️ 下一步 \`${afterStep.id}\` 标了 \`reset: true\`（重置门）：它的 DO 提示会在**本回合结束后**送达（上下文重置只能在步骤边界的空闲窗口里做）。**本回合请勿开始该步的工作**，简短确认即可。`
        : "";
      return {
        ok: true,
        text: (byDefinition
          ? `⏭ 步骤 \`${step.id}\` 未配置 \`check\`/\`check_voting\`（定义已声明免验证），已跳过对抗性验证并推进。`
          : `✅ 步骤 \`${step.id}\` 判定通过，已推进。`) + deferredNote,
      };
    }

    // ③b 判定全 passed 但有条目不属于当前步 → 归属校验失败，fail-closed（绝不推进）
    const foreign = foreignVerdicts(state, step);
    if (foreign.length > 0) {
      return {
        ok: false,
        text: `步骤 \`${step.id}\` 的判定归属不符，不能推进（判定必须属于当前步）：\n${foreign.map((v) => `- [${v.status}] 判定属于步骤 \`${v.step_id}\`，不是 \`${step.id}\`：${v.reason}`).join("\n")}\n\n这是错位判定，已拒绝复用。重新交卷即可再次验证。`,
      };
    }

    // ④ 有判定但未通过 → 不烧 fail_count，说明原因
    if (state.verdicts.length > 0) {
      return { ok: false, text: `步骤 \`${step.id}\` 的判定未全部通过，不能推进：\n${state.verdicts.map((v) => `- [${v.status}] ${v.reason}`).join("\n")}\n\n模型修好后重新交卷即可再次验证。` };
    }

    // ⑤ 已交卷但无判定（崩溃/中断后）→ 重新验证
    if (state.do_submitted) {
      void launchVerification(instId, state, wf, step);
      return { ok: true, text: `🔍 步骤 \`${step.id}\` 已交卷但无判定记录，正在重新委派独立验证者。` };
    }

    // ⑥ 还没交卷 → fail-closed（只对**有检查依据**的步骤可达：无检查依据已被 ③ 按定义声明放行）
    return { ok: false, text: `步骤 \`${step.id}\` 还没交卷，无法推进（本步配置了 \`check\`，没有判定不能推进）。已完成工作就交卷，或让模型继续。` };
  }

  function cancelInstance(sessionId: string, instanceRef?: string, reason?: string): ToolResult {
    const info = activeInstanceOfSession(sessionId)
      ?? (instanceRef ? listInstances().find((i) => i.state.active && (i.id === instanceRef || i.id.startsWith(instanceRef))) : undefined);
    if (!info) return { ok: false, text: "当前会话没有活跃实例可取消。" };
    const { id: instId, state } = info;
    // 中止**所有**在飞验证者（投票步是 N 笔）：取消后不留下还在烧 token 的孤儿
    abortInstance(instId);
    state.active = false;
    state.paused = false;
    state.pause_reason = "user_cancelled";
    stopHeartbeatsOf(instId, state.delegations);
    state.delegations = [];
    pushHistory(state, "cancelled", reason);
    logEvent(instId, "info", "cancelled", { step: state.current_step, reason: reason ?? null });
    // 取消 = 与完成同一条销毁路径（归档报告 → 销毁实例目录 → 删空产出目录）。
    const destroyed = destroyInstance(instId, "cancelled", state);
    if (destroyed) {
      const rel = reportRelPathOf(instId);
      const head = `🛑 实例 \`${instId}\` 已取消${reason ? `：${reason}` : ""}。报告已归档到 \`${rel}\`。`;
      if (destroyed.instanceDirRemoved) {
        notify(state, head, `🛑 ralphflow 实例已取消（报告 ${rel}）`);
        return { ok: true, text: `已取消实例 \`${instId}\`。报告已归档：\`${rel}\`。` };
      }
      // 诚实播报：实例目录没删掉就说清楚（绝不谎称已销毁）
      notify(
        state,
        `${head}\n\n⚠️ 但**实例目录未能删除**（残留 \`${destroyed.instanceDir}\`），未销毁：\`/ralphflow-doctor\` 可查看，确认无需保留后可手动删除。`,
        `⚠️ ralphflow 实例已取消，但实例目录未销毁（残留，见 doctor）`,
      );
      return { ok: true, text: `已取消实例 \`${instId}\`。报告已归档：\`${rel}\`。⚠️ 但**实例目录未能删除**（残留 \`${destroyed.instanceDir}\`），\`/ralphflow-doctor\` 可查看。` };
    }
    // 归档失败时 destroyInstance 已保留实例目录并发出告警；这里只补交卷结果。
    return { ok: true, text: `已取消实例 \`${instId}\`，但**报告归档失败**，实例目录与 state.json 已保留未销毁。请按告警处理（\`/ralphflow-doctor\` 可查看残留）。` };
  }

  function statusOf(sessionId: string, instanceRef?: string): ToolResult {
    const info = instanceRef
      ? listInstances().find((i) => i.id === instanceRef || i.id.startsWith(instanceRef))
      : activeInstanceOfSession(sessionId) ?? listInstances().at(-1);
    if (info) return { ok: true, text: renderInstance(info) };
    // 实例可能是**已结束并销毁**的：必须去历史报告里找，绝不能因为查不到就说「没有实例」
    // ——那会让用户以为跑丢了（边界 4）。
    if (instanceRef) {
      const hit = findHistory(instanceRef);
      if (hit) {
        return {
          ok: true,
          text: [
            `**${hit.id}** — ✅ 实例已结束并销毁，历史在报告里`,
            "",
            hit.parsed ? `- 状态：${hit.statusLabel}` : "- 状态：无法解析报告头部",
            hit.task ? `- 任务：${hit.task}` : "",
            hit.endedAt ? `- 结束：${hit.endedAt}` : "",
            `- 报告：\`${hit.relPath}\``,
            "",
            `要再跑一次用 \`/ralphflow-start <工作流> <任务>\`；活跃实况看 \`/ralphflow-list\`。`,
          ].filter(Boolean).join("\n"),
        };
      }
      return { ok: true, text: `找不到活跃实例 \`${instanceRef}\`，也没有与它匹配的历史报告。用 \`/ralphflow-list\` 查看活跃实例与「历史运行」。` };
    }
    return { ok: true, text: "当前没有活跃实例。用 `/ralphflow-start <工作流> <任务>` 启动；已结束的运行见 `/ralphflow-list` 的「历史运行」节。" };
  }

  /**
   * 每票进度行（派生量，现算不落盘）：终态看 `verdicts[]`，在飞看 `delegations[]`，
   * 其余为待验证。行格式照抄 opencode 的 status 渲染：
   * `✓ 验证者 1/3 <检查依据摘要>:<结论摘要>`。
   */
  function votingProgressRows(state: InstanceState, step: StepDef): Array<{ status: VoterDisplayStatus; label: string }> {
    const entries = step.check_voting;
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const count = voterCountOf(step);
    const rows: Array<{ status: VoterDisplayStatus; label: string }> = [];
    for (let i = 0; i < count; i++) {
      const verdict = state.verdicts.find((v) => v.check_index === i && verdictBelongsToStep(v, step.id));
      const running = state.delegations.some((d) => d.check_index === i);
      const status: VoterDisplayStatus = verdict ? verdict.status : running ? "running" : "pending";
      const basis = (entries[i]?.check ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 30) ?? "";
      const detail = verdict && (verdict.status === "passed" || verdict.status === "failed")
        ? `：${(verdict.reason.split("\n").find((l) => l.trim())?.trim() ?? "").slice(0, 120)}`
        : verdict ? `：${verdict.reason.slice(0, 120)}` : "";
      rows.push({ status, label: `${voterStatusLabel(status)} 验证者 ${i + 1}/${count} ${basis}${detail}` });
    }
    return rows;
  }

  function renderInstance(info: InstanceInfo): string {
    const { id, state } = info;
    const facts = [
      state.active ? (state.paused ? `⏸ 暂停（${state.pause_reason}）` : state.delegations.length > 0 ? "🔍 验证中" : state.do_submitted ? "🙋 待放行" : "▶️ 执行中") : "✅ 已结束",
      `工作流 \`${state.workflow_name}\``,
      `步骤 \`${state.current_step}\``,
      `失败 ${state.fail_count} 轮`,
    ];
    const lines = [`**${id}** — ${facts.join(" · ")}`, "", `任务：${state.user_task}`];
    // 「现在该干什么」——异步验证期间用户最需要的就是这句。
    // 传入本步有无对抗性检查（从 StepDef 现算，零新状态字段）：免验证的步骤不得宣称「会再次验证」。
    const wf = loadWorkflow(state.workflow_name).def;
    const step = wf ? stepOf(wf, state.current_step) : undefined;
    const hint = nextActionHint(state, id, step);
    if (hint) lines.push("", hint);
    // 多验证者投票的**每票进度**（对齐 opencode `/ralphflow-status` 的「验证进度」节）：
    // 不读第二个文件 —— 票的终态在 `verdicts[]`、在飞票在 `delegations[]`，这里现算。
    const progress = step ? votingProgressRows(state, step) : [];
    if (progress.length > 0) {
      const done = progress.filter((r) => r.status === "passed" || r.status === "failed").length;
      lines.push("", `验证进度（${done}/${progress.length} 票）：`, ...progress.map((r) => `- ${r.label}`));
    }
    if (state.verdicts.length > 0) {
      lines.push("", "本轮判定：", ...state.verdicts.map((v) => `- [${v.status}] ${v.reason}`));
    }
    const tail = state.history.slice(-5);
    if (tail.length > 0) {
      lines.push("", "最近轨迹：", ...tail.map((h) => `- \`${h.ts}\` ${h.event}${h.detail ? ` — ${h.detail.slice(0, 120)}` : ""}`));
    }
    return lines.join("\n");
  }

  /**
   * 「现在该干什么」——由派生事实算出，不落盘（宪法 §10.4）。
   * 异步验证期间这是用户最需要的一句话：说明要不要操作、去哪看、怎么退出。
   */
  function nextActionHint(s: InstanceState, instId?: string, step?: StepDef): string | undefined {
    if (!s.active) {
      // 基本不可达：实例一旦结束就被销毁。保留但改为**指向精确报告路径**。
      const rel = instId ? `\`${reportRelPathOf(instId)}\`` : "`" + RALPH_FLOW_DIR + "/reports/`";
      return `工作流已结束，历史在报告里：${rel}；要再跑一次用 \`/ralphflow-start <工作流> <任务>\`。`;
    }
    if (s.paused) {
      if (s.pause_reason === "max_failures") return "**等你定夺**：修好问题后 `/ralphflow-continue` 重新验证，或 `/ralphflow-cancel` 结束。";
      if (s.pause_reason === "no_submit") return "**等你处理**：模型反复未交卷。让它调用 `ralphflow_submit`，再 `/ralphflow-continue`；或 `/ralphflow-cancel` 结束。";
      return "**暂停中**：处理后 `/ralphflow-continue` 恢复（基础设施问题不计失败）。";
    }
    if (s.delegations.length > 0) {
      // 心跳停了 = 属主没了：绝不显示成一个永远不会结束的「验证中」（读路径只如实说，不写状态）
      if (!s.delegations.some(delegationOwnerAlive)) {
        return "**验证已中断**：验证属主已失联（那个运行时已经不在了），判定回不来。`/ralphflow-continue` 会按孤儿兜底并重新委派验证；想结束就用 `/ralphflow-cancel`。";
      }
      return "**无需操作**：独立验证者正在取证判定，跑完会自动唤醒本会话继续。可用 `/ralphflow-status` 看进度，`/ralphflow-cancel` 中止。";
    }
    if (s.do_submitted) {
      // 无检查依据的步骤（纯人工审查/免验证）：不得写「会再次验证」——本步没有独立验证
      if (step && !stepHasVerification(step)) {
        return "**等你放行**：本步未配置 `check` / `check_voting`（已**跳过对抗性验证**，纯人工审查）。确认无误运行 `/ralphflow-continue` 进入下一步；要修改就直接说明，改完重新交卷仍会停在这里。";
      }
      return "**等你放行**：确认无误运行 `/ralphflow-continue` 进入下一步；要修改就直接说明，改完重新交卷会再次验证。";
    }
    return "**执行中**：模型正在做本步任务。不要调用 `ralphflow_continue`（推进是自动的）。";
  }

  /** 派生状态标签（无相位字段） */
  function phaseLabel(s: InstanceState): string {
    if (!s.active) return "已结束";
    if (s.paused) return `暂停(${s.pause_reason})`;
    if (s.delegations.length > 0) return "验证中";
    if (s.do_submitted) return "待放行";
    return "执行中";
  }

  function relativeTime(iso: string | undefined): string {
    if (!iso) return "未知";
    try {
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return "未知";
      const ms = Date.now() - t;
      if (ms < 60_000) return "刚刚";
      if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
      if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
      return `${Math.floor(ms / 86_400_000)} 天前`;
    } catch { return "未知"; }
  }

  function listAll(): ToolResult {
    const all = listInstances();
    const history = listHistory();
    const wfs = listWorkflows();
    const head: string[] = ["## 可用工作流", ""];
    if (wfs.length === 0) head.push("没有找到工作流。");
    else {
      for (const w of wfs) {
        head.push(`- **${w.name}**: ${w.desc || "(无描述)"}${w.invalid ? "（定义无效）" : ""}`);
      }
    }

    // 「活跃实例」节：实例是临时的，这里只列还在跑的（边界 3）。
    const body: string[] = ["", `## 活跃实例（${all.length} 个）`, ""];
    if (all.length === 0) {
      body.push("（暂无活跃实例）");
    } else {
      for (const i of all) {
        const s = i.state;
        const task = s.user_task.replace(/\s+/g, " ").slice(0, 60) + (s.user_task.length > 60 ? "…" : "");
        body.push(`### \`${i.id}\``);
        body.push(`- **工作流**: ${s.workflow_name}`);
        if (task) body.push(`- **任务**: ${task}`);
        body.push(`- **步骤**: ${s.current_step}（${phaseLabel(s)}）`);
        body.push(`- **状态**: ${phaseLabel(s)}`);
        body.push(`- **属主会话**: ${s.owner_session ? `\`${shortSessionId(s.owner_session)}\`` : "无"}`);
        body.push(`- **最后活动**: ${relativeTime(s.updated_at)}`);
        body.push("");
      }
    }
    body.push("接管无属主实例：`/ralphflow-continue <实例ID>`。");

    // 「历史运行」节：从 reports/ 现读现解析（不新增派生索引）。报告只写不读会让
    // 完成消息一丢就再也找不回来——这里就是找回来的入口。
    body.push("", `## 历史运行（已归档）（${history.length} 个）`, "");
    if (history.length === 0) {
      body.push("（暂无归档报告）");
    } else {
      for (const h of history) {
        body.push(`### \`${h.id}\``);
        body.push(`- **状态**: ${h.statusLabel}`);
        if (h.workflow) body.push(`- **工作流**: ${h.workflow}`);
        if (h.task) body.push(`- **任务**: ${h.task.replace(/\s+/g, " ").slice(0, 60)}${h.task.length > 60 ? "…" : ""}`);
        if (h.endedAt) body.push(`- **结束**: ${h.endedAt}`);
        body.push(`- **报告**: \`${h.relPath}\``);
        if (!h.parsed) body.push("- ⚠️ 无法解析报告头部字段");
        body.push("");
      }
    }
    body.push(`历史报告目录：\`${RALPH_FLOW_DIR}/reports/\`（报告与产出永久保留，只能由你显式删除）。`);
    return { ok: true, text: head.concat(body).join("\n") };
  }

  /**
   * `doctor`：扫每个已知工作区的 `instances/`，报出实例目录异常。**只报不删。**
   *
   * 注意别把正常状态当异常：改造后「报告存在 + 产出存在 + 实例目录不存在」正是
   * 终止后的**正常终态**，不是异常。只有"三者对不上"才算异常。
   */
  function diagnoseInstanceDirs(): string[] {
    const issues: string[] = [];
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try { entries = fs.readdirSync(instancesDir, { withFileTypes: true }); } catch { return issues; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      const label = `instances/${id}/`;
      const sp = path.join(instancesDir, id, "state.json");
      if (!fs.existsSync(sp)) {
        issues.push(`实例目录 \`${label}\` 缺少 state.json —— 所有工具都看不到它。若是残留目录可直接删除`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
        if (!parsed || typeof parsed !== "object") throw new Error("不是 JSON 对象");
      } catch (err) {
        issues.push(`实例 \`${id}\` 的 state.json 损坏（${msg(err)}）—— 该实例无法恢复，确认无需保留后可删除整个目录`);
        continue;
      }
      if ((parsed as { active?: unknown }).active === false) {
        issues.push(`实例 \`${id}\` 已结束但目录未被销毁（可能是报告归档失败）。先确认报告是否已生成，再决定是否删除该目录`);
      }
    }
    return issues;
  }

  /** 孤儿产出：`artifacts/<name>/` 既无对应报告、也无对应活跃实例（通常来自被手动清理的实例）。同样只报不删。 */
  function diagnoseOrphanArtifacts(): string[] {
    const issues: string[] = [];
    const claimed = new Set<string>();
    for (const { state } of listInstances()) if (state.artifacts_dir_name) claimed.add(state.artifacts_dir_name);
    for (const h of listHistory()) if (h.artifactsDirName) claimed.add(h.artifactsDirName);
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try { entries = fs.readdirSync(artifactsDir, { withFileTypes: true }); } catch { return issues; }
    for (const e of entries) {
      if (!e.isDirectory() || claimed.has(e.name)) continue;
      issues.push(`产出目录 \`artifacts/${e.name}/\` 既无对应报告、也无对应实例目录（通常来自被手动清理的实例）—— 只报告，不删除`);
    }
    return issues;
  }

  /** 诊断（ralphflow_doctor）：工作流定义 + 实例状态，坏文件 fail-fast 说人话 */
  function diagnose(): ToolResult {
    const wfs = listWorkflows();
    const lines = ["## 工作流诊断", ""];
    if (wfs.length === 0) lines.push("（没有工作流）");
    for (const w of wfs) {
      if (w.invalid) {
        lines.push(`- ❌ **${w.name}**：定义无效`);
        for (const p of w.problems) lines.push(`  - ${p}`);
      } else {
        lines.push(`- ✅ **${w.name}**: ${w.desc || "(无描述)"}`);
        for (const wn of w.warnings) lines.push(`  - ⚠️ ${wn}`);
      }
      lines.push("");
    }
    lines.push("## 实例诊断", "");
    const insts = listInstances();
    if (insts.length === 0) lines.push("（暂无实例）");
    for (const i of insts) {
      const s = i.state;
      const flags: string[] = [];
      if (!s.active) flags.push("已结束");
      else if (s.paused) flags.push(`暂停(${s.pause_reason})`);
      else if (s.delegations.length > 0) flags.push("验证中");
      else if (s.do_submitted) flags.push("待放行");
      else flags.push("执行中");
      if (!s.owner_session) flags.push("无属主");
      if (s.delegations.length > 0) flags.push(`${s.delegations.length} 笔在飞委派`);
      lines.push(`- \`${i.id}\` — ${s.workflow_name} · ${flags.join(" · ")}`);
    }
    // 实例目录异常（缺 state.json / 损坏 / 已结束但未销毁）：只报不删（边界 5）。
    const dirIssues = diagnoseInstanceDirs();
    if (dirIssues.length > 0) {
      lines.push("", "## 实例目录异常", "");
      for (const it of dirIssues) lines.push(`- ⚠️ ${it}`);
    }
    const orphanArtifacts = diagnoseOrphanArtifacts();
    if (orphanArtifacts.length > 0) {
      lines.push("", "## 孤儿产出目录", "");
      for (const it of orphanArtifacts) lines.push(`- ⚠️ ${it}`);
    }
    lines.push("", "结论：所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅。");
    return { ok: true, text: lines.join("\n") };
  }

  /**
   * 插件加载/进程重启：孤儿委派 fail-safe（不隐式继续、不隐式通过）。
   *
   * **只兜真正的孤儿**：委派的心跳已经停了（属主运行时崩溃/被重启 → 判定永远回不来）→
   * 暂停 check_infra 等用户定夺。心跳还新鲜的委派一律原样留着、一个字节都不动 ——
   * 别的会话、别的 sandbox 进程、重载后的新实例碰 ralphflow 都不得影响在飞的验证。
   *
   * 老 `state.json` 里的委派没有心跳字段（来源不可考）→ 按孤儿兜底，安全网不缩水。
   * 判据细节见 {@link delegationOwnerAlive}。
   */
  function restore(): void {
    for (const { id, state } of listInstances()) {
      if (!state.active) continue;
      if (state.delegations.length === 0) continue;
      if (state.delegations.some(delegationOwnerAlive)) {
        // 心跳还新鲜（属主还在等判定）→ 判定会回来，绝不打断。
        log("info", "orphan_recovery_skipped_live", { instId: id, delegations: state.delegations.length });
        continue;
      }
      stopHeartbeatsOf(id, state.delegations);
      state.delegations = [];
      state.paused = true;
      state.pause_reason = "check_infra";
      pushHistory(state, "orphan_delegation_recovered");
      logPause(id, state, "check_infra", { detail: "orphan_delegation_recovered" });
      writeState(state, id);
      log("warn", "orphan_delegation_recovered", { instId: id });
    }
  }

  return {
    root, instancesDir, workflowsDir, reportsDir, projectDir,
    ensureLayout, listWorkflows, loadWorkflow,
    readState, listInstances, listHistory, instanceDir,
    artifactsDirOf, artifactsRelDirOf, reportRelPathOf, destroyInstance,
    start, onSubmit, noteAssistantText, remindToSubmit, continueInstance, cancelInstance, statusOf, listAll, restore, diagnose,
    activeInstanceOfSession,
  };
}

export type Engine = ReturnType<typeof createEngine>;

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/**
 * 会话 id 的**可辨认**短形式。
 *
 * dsh 的会话 id 一律以 `session-` 开头，所以 `slice(0, 8)` 会把每一个实例都显示成
 * `session-`——列表里那一行等于没写。这里保留前缀、截 uuid 的首段。
 */
function shortSessionId(id: string): string {
  const head = "session-";
  const rest = id.startsWith(head) ? id.slice(head.length) : id;
  return rest.length > 8 ? `${id.startsWith(head) ? head : ""}${rest.slice(0, 8)}…` : id;
}

/**
 * 归一化 ports.verify 的返回（判定是不可信的外部输入）。
 * 缺字段/坏 status 一律按 infra（fail-closed，绝不默认通过）；补齐 step_id/ts/reason，
 * 避免下游 `verdict.reason.slice()` 之类的访问把 async 链抛成未处理拒绝。
 */
function normalizeVerdict(v: Verdict | undefined | null, stepId: string, checkIndex: number): Verdict {
  const raw = (v ?? {}) as Partial<Verdict>;
  const status = raw.status === "passed" || raw.status === "failed" || raw.status === "infra" ? raw.status : "infra";
  return {
    check_index: typeof raw.check_index === "number" ? raw.check_index : checkIndex,
    status,
    reason: typeof raw.reason === "string" ? raw.reason : `验证者未返回可解析的判定（原始 status=${String(raw.status)}）。`,
    step_id: typeof raw.step_id === "string" && raw.step_id ? raw.step_id : stepId,
    ts: typeof raw.ts === "string" && raw.ts ? raw.ts : new Date().toISOString(),
    ...(raw.agent_id !== undefined ? { agent_id: String(raw.agent_id) } : {}),
  };
}

export const BUILTIN_WORKFLOWS = ["loop", "spec"];
