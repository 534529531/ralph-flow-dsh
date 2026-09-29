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

export interface StepDef {
  id: string;
  desc?: string;
  do?: string;
  check?: string;
  input?: string;
  output?: string;
  manual_step?: boolean;
  on_pass?: string;
  on_fail?: string;
  max_fail_count?: number;
  /**
   * 步骤级验证模型覆盖（对齐 opencode/claude 2.8.0）。
   * **仅单 `check` 场景生效**；与 `check_voting` 同写、或没有 `check` → 加载期硬错误。
   */
  check_model?: ModelRef;
}

/**
 * `adversarial_check` 是**可选**对象，**唯一允许的字段是 `model`**。
 *
 * 验证者身份与职责是 Ralphflow 的**内部定义**（`verify.ts` 的 `VERIFIER_PERSONA`），
 * 不是工作流资产的一项配置：同一个职责不该在「Agent 名称 / 工作流提示词 / 步骤检查依据」
 * 三处重复表达。因此 `agent` / `system_prompt` / `timeout_ms` 已从公开契约中删除——
 * 它们出现在 YAML 里时 **加载期与 doctor 都告警并忽略**（warn+ignore，与未知键、
 * `check_voting` 同一条口径，见 design §8 Q13），绝不拒收、不静默、不改作别的含义。
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
 * 本步是否配置了对抗性检查 —— **纯函数谓词，只读 `StepDef`**（design §12.1 精修）。
 *
 * 这是「本步是否需要独立验证」的**唯一判据**，与 state、与模型输出无关：
 * 判据来自**工作流定义**（作者所有），执行者在运行期无法影响它。因此
 * 「无 `check` 的步骤跳过对抗性验证」是**作者声明的机械推进**，不是执行者绕过裁判。
 *
 * **零新状态字段**（宪法 §10.4）：某步有没有 `check` 是工作流定义的属性、不是运行事实，
 * 需要时现算即可 —— 绝不往 `InstanceState` 里加 `skipped_steps[]` 之类的派生量。
 *
 * `check_voting` 本版本未支持（warn+ignore），不参与此判据。
 */
export function stepHasCheck(step: Pick<StepDef, "check">): boolean {
  return typeof step.check === "string" && step.check.trim() !== "";
}

export interface WorkflowDef {
  name: string;
  description?: string;
  /** 审查门步骤（方言形态：顶层 id 列表） */
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
  ts: string;
}

export interface HistoryEntry {
  ts: string;
  step?: string;
  event: string;
  detail?: string;
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

/** 引擎对外的两个端口：向属主会话投递指令 / 委派独立验证者（T1 的唯一入口） */
export interface EnginePorts {
  /**
   * 把指令投递给主会话（插件消息 + 唤醒）。
   * `summary` 是给**用户看**的一行摘要：dsh 客户端按 `source.form === "notice"` + `summary`
   * 渲染成不展开就能读的 notice 行；省略则退化为不显眼的 opaque 注入行（用户看不到）。
   * 凡是用户应当知道的播报都必须传 summary。
   */
  deliver: (sessionId: string, text: string, summary?: string) => boolean;
  /** 委派独立验证者，返回判定（绝不接受主会话提供的判定） */
  verify: (req: VerifyRequest) => Promise<Verdict>;
  log?: (level: "info" | "warn" | "error", event: string, data?: unknown) => void;
}

export interface VerifyRequest {
  instId: string;
  step: StepDef;
  workflow: WorkflowDef;
  userTask: string;
  ownerSession?: string;
  checkIndex: number;
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
  // 无 check 的步骤**跳过对抗性验证**（与 opencode 对齐）：
  //   · 非 manual 步 → DO 完成后直接进入下一步，不会被独立验证 —— 作者必须知道（告警）；
  //   · manual 步 → 纯人工审查是**刻意的默认**，不是问题（不告警）。
  // 通用兜底配方已随本语义退役（见 verify.ts buildCheckPrompt），文案不得再提它。
  for (const s of steps) {
    if (!stepHasCheck(s) && !manual.has(s.id) && s.manual_step !== true) {
      warnings.push(`步骤 \`${s.id}\` 未配置对抗性检查（无 \`check\`），DO 完成后直接进入下一步，不会被独立验证。`);
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

export function createEngine(projectDir: string, ports: EnginePorts) {
  const root = path.join(projectDir, RALPH_FLOW_DIR);
  const instancesDir = path.join(root, "instances");
  const workflowsDir = path.join(root, "workflows");
  const reportsDir = path.join(root, "reports");
  const artifactsDir = path.join(root, ARTIFACTS_DIRNAME);
  // 全局工作流目录仍是 `~/.dsh/ralph-flow/workflows`（插件命名空间在全局与工作区同名）
  const configuredDshHome = process.env.DSH_HOME;
  const dshHome = configuredDshHome && path.isAbsolute(configuredDshHome) ? path.resolve(configuredDshHome) : path.join(os.homedir(), ".dsh");
  const globalWorkflowsDir = path.join(dshHome, RALPH_FLOW_NAME, "workflows");
  /** 实例 → 在飞取消信号（取消/暂停时中止验证者，不白烧 token） */
  const aborts = new Map<string, AbortController>();

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

  const log = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    try { ports.log?.(level, event, data); } catch {}
  };

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

  function builtinWorkflowPath(name: string): string | undefined {
    // lib/engine.js → ../workflows/<name>.yaml（构建产物与源码同布局）
    const here = path.dirname(new URL(import.meta.url).pathname);
    const candidates = [
      path.resolve(here, "..", "workflows", `${name}.yaml`),
      path.resolve(here, "..", "..", "workflows", `${name}.yaml`),
    ];
    return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  }

  // ─── 工作流加载与校验（坏文件 fail-fast 说人话）────────────────────────────

  const KNOWN_STEP_KEYS = new Set(["id", "desc", "do", "check", "check_voting", "check_model", "input", "output", "manual_step", "on_pass", "on_fail", "max_fail_count"]);
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

  function loadWorkflow(name: string): { def: WorkflowDef | null; problems: string[]; warnings: string[] } {
    const problems: string[] = [];
    const warnings: string[] = [];
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
    const steps: StepDef[] = [];
    const ids = new Set<string>();
    stepsRaw.forEach((s: any, i: number) => {
      if (!s || typeof s !== "object") { problems.push(`第 ${i + 1} 个步骤不是映射。`); return; }
      if (!s.id || typeof s.id !== "string") { problems.push(`第 ${i + 1} 个步骤缺少 id。`); return; }
      if (ids.has(s.id)) { problems.push(`步骤 id 重复：\`${s.id}\`。`); return; }
      ids.add(s.id);
      for (const k of Object.keys(s)) {
        if (!KNOWN_STEP_KEYS.has(k)) warnings.push(`步骤 \`${s.id}\` 的键 \`${k}\` 本版本未支持，已忽略。`);
      }
      if (s.check_voting !== undefined) {
        warnings.push(`步骤 \`${s.id}\` 用了 \`check_voting\`（多验证者投票）：本版本未支持，已忽略；本步有 \`check\` 时按单验证者执行，没有 \`check\` 时跳过对抗性验证。`);
      }
      // ── §1.1 加载期硬校验：写错了却没有任何信号 = 缺陷（要么硬错误，要么 doctor 告警）
      // do 缺失：没有可执行的指令，整步无意义 → 硬错误（不再静默接受空步）。
      if (typeof s.do !== "string" || s.do.trim() === "") {
        problems.push(`步骤 \`${s.id}\` 缺少 \`do\`（必填：主会话执行的指令；缺失、非字符串或空串都不接受）。`);
      }
      // check 存在但非字符串（如 `check: true`）：几乎一定是漏写正文。
      // 硬错误，不静默当成「本步不做检查」——避免把「想要 check」误读成「不想 check」
      // （照 opencode：非字符串会被视为未配置检查并跳过验证；本意是跳过请直接删掉该字段）。
      if (s.check !== undefined && s.check !== null && typeof s.check !== "string") {
        problems.push(`步骤 \`${s.id}\` 的 \`check\` 必须是字符串（当前是 ${typeof s.check}）：非字符串会被视为未配置检查并跳过验证；若你本意是跳过请直接删掉该字段。`);
      }
      // max_fail_count 给了就必须是 ≥1 的整数（0/负数以前被静默接受 → 首次失败即暂停，用户看不懂）。
      if (s.max_fail_count !== undefined
        && (typeof s.max_fail_count !== "number" || !Number.isInteger(s.max_fail_count) || s.max_fail_count < 1)) {
        problems.push(`步骤 \`${s.id}\` 的 \`max_fail_count\` 必须是 ≥1 的整数（当前 ${JSON.stringify(s.max_fail_count)}）。`);
      }
      // check_model（步骤级验证模型覆盖，对齐 opencode/claude 2.8.0）：仅单 check 场景有意义。
      // 两条硬错误照抄 opencode：与 check_voting 同写、或没有可用的 check —— 都几乎一定是配置笔误，
      // 静默忽略会让用户以为「这步换了便宜模型验」，实际没换。
      const checkModelRaw = s.check_model;
      if (checkModelRaw !== undefined && checkModelRaw !== null) {
        if (s.check_voting !== undefined && s.check_voting !== null) {
          problems.push(`步骤 \`${s.id}\` 同时写了 \`check_voting\` 与 \`check_model\`：\`check_model\` 仅单 \`check\` 场景生效，此处无意义（多验证者时各票用自己条目里的 \`model\`）。`);
        }
        if (typeof s.check !== "string" || s.check.trim() === "") {
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
      steps.push({
        id: s.id,
        desc: typeof s.desc === "string" ? s.desc : undefined,
        do: typeof s.do === "string" ? s.do : undefined,
        check: typeof s.check === "string" ? s.check : undefined,
        input: typeof s.input === "string" ? s.input : undefined,
        output: typeof s.output === "string" ? s.output : undefined,
        manual_step: s.manual_step === true,
        on_pass: typeof s.on_pass === "string" ? s.on_pass : undefined,
        on_fail: typeof s.on_fail === "string" ? s.on_fail : undefined,
        max_fail_count: typeof s.max_fail_count === "number" ? s.max_fail_count : undefined,
        check_model: parseModelRef(checkModelRaw),
      });
    });
    // 引用校验：on_pass 必须指向存在的步骤或 done；on_fail 必须指向存在的步骤
    // （`on_fail: done` 非法 —— 失败不能「结束工作流」，见 design §4 / CREATE_GUIDE 方言说明）
    for (const s of steps) {
      for (const [key, target] of [["on_pass", s.on_pass], ["on_fail", s.on_fail]] as const) {
        if (target === undefined) continue;
        if (target === "done") {
          if (key === "on_fail") problems.push(`步骤 \`${s.id}\` 的 on_fail 指向 \`done\`；失败重试目标必须是存在的步骤 id（不允许 done）。`);
          continue;
        }
        if (!ids.has(target)) problems.push(`步骤 \`${s.id}\` 的 ${key} 指向不存在的步骤 \`${target}\`。`);
      }
    }
    if (problems.length > 0) return { def: null, problems, warnings };
    // manual_step 方言：列表与**逗号字符串**两种写法都支持（对齐 opencode）。
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
    // manual_step 引用不存在的步骤 → 硬错误：用户以为有审查门，实际会一路自动跑过去，
    // 这个偏差没有任何其它信号（create.ts 早已自称是硬规则，此前只是没实现）。
    const unknownManual = manual.filter((id) => !ids.has(id));
    if (unknownManual.length > 0) {
      problems.push(`manual_step 引用了不存在的步骤：${unknownManual.map((m) => `\`${m}\``).join("、")}（审查门会静默失效，必须修正拼写或删掉）。`);
      return { def: null, problems, warnings };
    }
    // §1.2 doctor 覆盖的 lint：引擎只在运行时（或永远不）暴露的问题，加载成功后补告警。
    warnings.push(...lintWorkflow(steps, new Set(manual)));
    // ── adversarial_check 容错（design §8 Q13 口径：自己不兑现的键一律 warn+ignore）──
    // 公开契约只允许 `model` 一个字段。其余字段（含已删除的 agent / system_prompt /
    // timeout_ms）与「整个值不是对象」都在**加载期**告警并忽略：不拒收、不静默、
    // 不改作别的含义。告警必须在这里出现，不能拖到验证阶段。
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
    const def: WorkflowDef = {
      name,
      description: typeof doc.description === "string" ? doc.description : "",
      manual_step: manual,
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
    return (wf.manual_step ?? []).includes(step.id) || step.manual_step === true;
  }

  function nextStepId(wf: WorkflowDef, step: StepDef): string {
    if (step.on_pass) return step.on_pass;
    const i = wf.steps.findIndex((s) => s.id === step.id);
    return i >= 0 && i + 1 < wf.steps.length ? wf.steps[i + 1]!.id : "done";
  }

  function failStepId(wf: WorkflowDef, step: StepDef): string {
    return step.on_fail ?? step.id;
  }

  /** 判定齐了且全 passed（v0 单验证者，仍按数组建模） */
  function allPassed(state: InstanceState): boolean {
    return state.verdicts.length > 0 && state.verdicts.every((v) => v.status === "passed");
  }
  function anyFailed(state: InstanceState): boolean {
    return state.verdicts.some((v) => v.status === "failed");
  }
  function anyInfra(state: InstanceState): boolean {
    return state.verdicts.some((v) => v.status === "infra");
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
   * 无 `check` 的步骤（`!stepHasCheck`）**不叠加机器验证**：交卷/放行后直接停在门，
   * 是**纯人工审查** —— 判据来自工作流定义（design §12.1 精修后的机械判据）。
   */
  function atOpenGate(wf: WorkflowDef, state: InstanceState, step: StepDef): boolean {
    return isGate(wf, step) && (!stepHasCheck(step) || allPassedVerified(state, step));
  }

  /**
   * 判定齐、全 passed，且**判定确实属于当前步**（design §5 第 3 条的归属校验）。
   * 归属用 step_id 判定；缺少 step_id 的判定按当前步处理，避免历史数据被误判为不通过。
   * 错位判定（step_id 指向别的步骤）一律不算通过 —— fail-closed。
   */
  function allPassedVerified(state: InstanceState, step: StepDef): boolean {
    if (!allPassed(state)) return false;
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
      // 只中止本实例的验证者；引擎随后重新委派，语义等价于「上一轮作废」
      try { aborts.get(instId)?.abort(); } catch {}
      aborts.delete(instId);
      log("info", "gate_reopen_abort_inflight", { instId, count: state.delegations.length });
    }
    state.do_submitted = false;
    state.verdicts = [];
    state.delegations = [];
    state.last_submit_summary = undefined;
    pushHistory(state, "gate_reopened", reason, step.id);
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
    const hasCheck = stepHasCheck(step);
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
      `\`${rel}/\` —— 本步的文档产出（清单、方案、报告、摘要等）统一放在此目录。`,
      `步骤里提到的文件若没写路径（例如 \`summary.md\`），即指该目录下的文件；明确写了其它路径的除外。`,
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
      // 有无 check 决定「交卷之后发生什么」：有 → 独立验证；无 → 跳过对抗性验证。
      // 绝不预告一个不会发生的验证（省 token 不能以伪造事实为代价）。
      // 有 check 的两条与改造前**逐字相同**（回归基线）。
      hasCheck
        ? "1. **先用一两句面向用户的话说明现在的状态与接下来会发生什么**，要让用户一眼看懂：本步已完成 → 接下来进入**独立验证**（异步，通常 1–5 分钟，**不需要用户做任何操作**）→ 期间用户可以做什么（补充信息或纠正方向 / 用 `/ralphflow-status` 看进度 / 用 `/ralphflow-cancel` 中止）。用用户的语言写，不要把它埋进技术叙述里。"
        : "1. **先用一两句面向用户的话说明现在的状态与接下来会发生什么**，要让用户一眼看懂：本步已完成 → 本步**不配置对抗性检查**，会**跳过对抗性验证**（不会有独立验证进程来复核）→ 接下来自动进入下一步（`manual_step` 步骤则停在审查门等你放行，**不需要用户做任何操作**）。用用户的语言写，不要把它埋进技术叙述里。",
      hasCheck
        ? "2. **调用 `ralphflow_submit` 工具交卷**（可在参数 `summary` 里简述你做了什么）。独立验证者会立刻检查你的产出。"
        : "2. **调用 `ralphflow_submit` 工具交卷**（可在参数 `summary` 里简述你做了什么）。本步不委派独立验证者，交卷即生效。",
      "",
      hasCheck
        ? "不要只在回复里说「完成了」——那样不会触发验证。**必须调用工具**。"
        : "不要只在回复里说「完成了」——那样不会触发推进。**必须调用工具**。",
    );
    if (!hasCheck) {
      // 照 opencode 的措辞（`opencode/src/engine.ts:1565`）
      parts.push(
        "",
        `ℹ️ 本步骤**不配置对抗性检查**：完成即可，不会有独立的验证进程来复核。请务必自查产出是否满足任务要求（manual_step 步骤则由你审查后运行 \`/ralphflow-continue\` 放行）。`,
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
    pushHistory(state, "check_skipped", `步骤 \`${step.id}\` 未配置 \`check\`，跳过对抗性验证`, step.id);
    log("info", "check_skipped", { instId, step: step.id, reason: "no_check" });
  }

  /**
   * 无 `check` 的步骤：**不委派验证者**，按工作流定义声明直接推进或停在审查门。
   *
   * 判据是 `stepHasCheck(step)`（只读 `StepDef`，见 design §12.1 精修）：这不是
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
      notify(
        state,
        `🙋 步骤 \`${step.id}\` 未配置对抗性检查（无 \`check\`），已**跳过对抗性验证**，停在审查门等你放行（纯人工审查，不叠加机器验证）。\n\n确认无误运行 \`/ralphflow-continue\` 进入下一步；需要修改就直接说明，改完重新交卷仍会停在这里。`,
        `🙋 步骤 ${step.id} 已跳过对抗性验证，停在审查门等你放行`,
      );
      return true;
    }
    notify(
      state,
      `⏭ 步骤 \`${step.id}\` 未配置对抗性检查（无 \`check\`），已**跳过对抗性验证**，直接进入下一步。`,
      `⏭ 步骤 ${step.id} 已跳过对抗性验证（未配置 check），直接推进`,
    );
    advance(instId, state, wf, step);
    return false;
  }

  async function launchVerification(instId: string, state: InstanceState, wf: WorkflowDef, step: StepDef): Promise<void> {
    const checkIndex = state.verdicts.length;
    const runId = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    aborts.set(instId, controller);
    state.delegations.push({ run_id: runId, check_index: checkIndex, ts: new Date().toISOString() });
    pushHistory(state, "verify_start", `check_index=${checkIndex}`, step.id);
    writeState(state, instId);
    log("info", "verify_start", { instId, step: step.id, checkIndex });
    // 阶段播报：验证是**异步**的（委派独立子代理，分钟级；不阻塞主会话回合）。
    // 这段静默窗口必须讲清三件事：正在发生什么 / 要不要你操作 / 去哪看进度。
    notify(state, [
      `🔍 步骤 \`${step.id}\` 已交卷，独立验证者（独立会话，看不到本对话）正在取证判定。`,
      "",
      `**这一步你是异步等待的，不需要做任何操作** —— 验证者跑完会自动唤醒本会话并继续工作流。验证通常需要 1–5 分钟（它要真的去读文件、跑命令取证）。`,
      "",
      `期间你可以：`,
      `- 直接在此会话补充信息或纠正方向（会被模型看到）`,
      `- 用 \`/ralphflow-status\` 随时查看进度与最近轨迹`,
      `- 想中止就 \`/ralphflow-cancel\``,
    ].join("\n"), `🔍 步骤 ${step.id} 已交卷，独立验证中（1–5 分钟，无需操作）`);

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
      return;
    }
    fresh.delegations = fresh.delegations.filter((d) => d.run_id !== runId);
    fresh.verdicts.push(verdict);
    if (verdict.status === "passed") clearFailCount(fresh, step.id);
    aborts.delete(instId);
    pushHistory(fresh, `verdict_${verdict.status}`, verdict.reason.slice(0, 300), step.id);
    log("info", "verdict", { instId, status: verdict.status });

    if (anyInfra(fresh)) {
      fresh.paused = true;
      fresh.pause_reason = "check_infra";
      writeState(fresh, instId);
      notify(fresh, `⏸ 验证未跑成（基础设施问题，不计失败）：${verdict.reason}\n\n修复后运行 \`/ralphflow-continue\` 重新验证。`, `⏸ 验证未跑成（基础设施问题），已暂停步骤 ${step.id}`);
      return;
    }
    if (anyFailed(fresh)) {
      const failedTimes = bumpFailCount(fresh, step.id);
      const max = step.max_fail_count ?? 3;
      if (failedTimes >= max) {
        fresh.paused = true;
        fresh.pause_reason = "max_failures";
        writeState(fresh, instId);
        notify(fresh, `⏸ 步骤 \`${step.id}\` 连续 ${failedTimes} 轮未通过（上限 ${max}），已暂停等你定夺。\n\n验证者的意见：\n${verdict.reason}\n\n处理后可运行 \`/ralphflow-continue\` 重新验证，或 \`/ralphflow-cancel\` 结束。`, `⏸ 步骤 ${step.id} 连续 ${failedTimes} 轮未通过，已暂停等你定夺`);
        return;
      }
      // 返工：按 **on_fail** 回退（design §4「按 on_fail 回退」）。on_fail 缺省指自身。
      const targetId = failStepId(wf, step);
      const target = stepOf(wf, targetId);
      if (!target) {
        // on_fail 指向 "done" 或不存在的步骤 —— 坏定义，绝不静默跳步
        fresh.paused = true;
        fresh.pause_reason = "check_infra";
        pushHistory(fresh, "rework_target_invalid", `on_fail=${targetId}`, step.id);
        writeState(fresh, instId);
        notify(fresh, `⏸ 步骤 \`${step.id}\` 的 \`on_fail\` 指向 \`${targetId}\`，不是可回退的步骤，已暂停（引擎拒绝跳步）。`, `⏸ 步骤 ${step.id} 的 on_fail 定义无效，已暂停`);
        return;
      }
      fresh.do_submitted = false;
      fresh.verdicts = [];
      fresh.delegations = [];
      if (target.id !== step.id) {
        fresh.current_step = target.id;
        pushHistory(fresh, "rework_rewind", `${step.id} → ${target.id}`, target.id);
        log("info", "rework_rewind", { instId, from: step.id, to: target.id });
      }
      writeState(fresh, instId);
      deliver(fresh, doPrompt(instId, wf, fresh, target, verdict.reason), `🔄 步骤 ${target.id} 验证未通过，自动返工（${step.id} 第 ${failedTimes} 次）`);
      return;
    }
    // 全 passed（且判定属于当前步）
    if (isGate(wf, step) && allPassedVerified(fresh, step)) {
      writeState(fresh, instId);
      notify(fresh, `🙋 步骤 \`${step.id}\` 已通过独立验证，停在审查门等你放行。\n\n确认无误运行 \`/ralphflow-continue\` 进入下一步；需要修改就直接说明，改完重新交卷会再次验证。`, `🙋 步骤 ${step.id} 已通过验证，停在审查门等你放行`);
      return;
    }
    writeState(fresh, instId);
    advance(instId, fresh, wf, step);
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
    if (target === "done") { complete(instId, state, wf); return; }
    const next = stepOf(wf, target);
    if (!next) {
      // 加载期已校验，这里只作兜底（坏定义不得静默跳步）
      state.paused = true;
      state.pause_reason = "check_infra";
      pushHistory(state, "advance_target_missing", target);
      writeState(state, instId);
      notify(state, `⏸ 工作流定义里 on_pass 指向的步骤 \`${target}\` 不存在，已暂停（引擎拒绝跳步）。`, `⏸ 工作流定义错误（on_pass 指向 ${target} 不存在），已暂停`);
      return;
    }
    state.current_step = next.id;
    state.do_submitted = false;
    state.verdicts = [];
    state.delegations = [];
    state.last_submit_summary = undefined;
    // 不在这里清 fail_counts：通过时已 `clearFailCount`（该步失败史了结）。
    // 若用 on_fail 回退到一个「失败过但尚未通过」的步骤，它自己的计数应保留 ——
    // 这既避免把前一步的失败算到它头上，也让成环的 on_fail 仍能触及 max_fail_count。
    pushHistory(state, "step_start", next.desc ?? "", next.id);
    writeState(state, instId);
    // 播报必须诚实：下一步没有 check 时不得宣称「会自动进入独立验证」（有 check 的分支逐字不变）
    deliver(state, doPrompt(instId, wf, state, next), stepHasCheck(next)
      ? `▶️ 步骤 ${next.id} 开始执行${next.desc ? `：${next.desc}` : ""}（完成后会自动进入独立验证）`
      : `▶️ 步骤 ${next.id} 开始执行${next.desc ? `：${next.desc}` : ""}（未配置 check：完成后跳过对抗性验证）`);
  }

  function complete(instId: string, state: InstanceState, wf: WorkflowDef): void {
    pushHistory(state, "complete", `workflow=${wf.name}`);
    state.active = false;
    state.paused = false;
    state.pause_reason = undefined;
    state.do_submitted = false;
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

  /**
   * 用户可见播报。**必须**给 summary —— 它是用户在时间线上不展开就能读到的那一行；
   * 不传就等于用户看不到（client 会退化成 opaque 注入行）。
   */
  function notify(state: InstanceState, text: string, summary: string): void {
    deliver(state, `[ralphflow] ${text}`, summary);
  }

  // ─── 报告归档 ──────────────────────────────────────────────────────────────

  /**
   * §1.4 每步耗时与重试次数：**全部从 `history` 的 `ts` 与 `fail_counts` 派生**
   * （不新增落盘字段）。
   *
   * 耗时区间 = 属于某步的第一条历史事件 → 下一条属于其它步骤的事件（或 `endTs`）；
   * 同一被反复进入的步骤（返工/回退）累计总时长。
   *
   * 重试次数 = `max(fail_counts[step], 该步 verdict_failed 条数)`：
   * 通过时 `clearFailCount` 会把该步计数清零、恢复暂停时也会清零，所以单看
   * `fail_counts` 会把「先失败几次再通过」记成 0 轮 —— 必须同时从 history 兜底。
   */
  function stepStats(state: InstanceState, endTs: number): Array<{ step: string; ms: number; retries: number }> {
    const acc = new Map<string, { ms: number; order: number; failed: number }>();
    let order = 0;
    let lastStep: string | undefined;
    let lastTs: number | undefined;
    const ensure = (step: string) => {
      let v = acc.get(step);
      if (!v) { v = { ms: 0, order: order++, failed: 0 }; acc.set(step, v); }
      return v;
    };
    for (const h of state.history) {
      const step = h.step;
      if (!step) continue;
      const t = new Date(h.ts).getTime();
      if (!Number.isFinite(t)) continue;
      if (step !== lastStep) {
        if (lastStep !== undefined && lastTs !== undefined) ensure(lastStep).ms += Math.max(0, t - lastTs);
        lastStep = step;
      }
      lastTs = t;
      const rec = ensure(step);
      if (h.event === "verdict_failed") rec.failed += 1;
    }
    if (lastStep !== undefined && lastTs !== undefined) ensure(lastStep).ms += Math.max(0, endTs - lastTs);
    return [...acc.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([step, v]) => ({ step, ms: v.ms, retries: Math.max(state.fail_counts?.[step] ?? 0, v.failed) }));
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
      const stats = stepStats(state, endTs);
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
    // §1.7 产出目录：实例启动时建好，完成后**保留**（不随实例结束删除）。
    // 用刚算出的名字直接建，避免依赖已落盘的状态。
    try { fs.mkdirSync(path.join(artifactsDir, artifactsDirName), { recursive: true }); } catch {}
    log("info", "instance_start", { instId, workflow: wf.name, workspace: projectDir });
    const warnText = warnings.length > 0 ? `\n\n⚠️ 工作流定义告警：\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
    const text = [
      `🚀 已启动工作流 **${wf.name}**（实例 \`${instId}\`，共 ${wf.steps.length} 步）。${warnText}`,
      "",
      // 诚实标注：首步没有 check 时**不得预告一次不会发生的独立验证**（与 doPrompt / advance 播报同一口径）。
      // 有 check 的分支与改造前**逐字相同**（回归基线）。
      stepHasCheck(first)
        ? "接下来：模型执行本步 → 交卷 → **独立验证者**（独立会话，看不到本对话）取证判定 → 通过则推进，不通过自动返工。"
        : isGate(wf, first)
          ? "接下来：模型执行本步 → 交卷 → 本步**不配置对抗性检查**，会**跳过对抗性验证**（纯人工审查），停在审查门等你 `/ralphflow-continue` 放行。"
          : "接下来：模型执行本步 → 交卷 → 本步**不配置对抗性检查**，会**跳过对抗性验证**，直接进入下一步。",
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
        // 无 check 的步骤本来就没有验证：「未重复验证」会读成"验证发生过" → 分文本书写
        return {
          ok: false,
          text: stepHasCheck(step)
            ? "交卷内容与上一次完全相同，未重复验证。若你确实改动了产出，请简述改动后再交卷。"
            : "交卷内容与上一次完全相同，未重复受理。若你确实改动了产出，请简述改动后再交卷。",
        };
      }
      reopenGate(state, instId, step, "审查门上重新交卷（改稿）");
      state.do_submitted = true;
      state.last_submit_summary = text;
      pushHistory(state, "do_submitted", undefined, step.id);
      // 无 check 的步骤：不委派验证者，按定义声明（停门 / 直接推进）；skipVerification 内落盘
      if (!stepHasCheck(step)) {
        const atGate = skipVerification(instId, state, wf, step);
        return {
          ok: true,
          text: atGate
            ? `⏭ 已受理重新交卷：步骤 \`${step.id}\` 未配置 \`check\`，已跳过对抗性验证（纯人工审查），仍停在审查门等你放行。`
            : `⏭ 已受理重新交卷：步骤 \`${step.id}\` 未配置 \`check\`，已跳过对抗性验证，直接推进。`,
        };
      }
      writeState(state, instId);
      void launchVerification(instId, state, wf, step);
      return { ok: true, text: `🔍 已受理重新交卷，正在重新委派独立验证者检查步骤 \`${step.id}\`。` };
    }

    state.do_submitted = true;
    state.last_submit_summary = text;
    pushHistory(state, "do_submitted", undefined, step.id);
    if (!stepHasCheck(step)) {
      const atGate = skipVerification(instId, state, wf, step);
      return {
        ok: true,
        text: atGate
          ? `⏭ 交卷已受理：步骤 \`${step.id}\` 未配置 \`check\`，已跳过对抗性验证（纯人工审查），停在审查门等你放行。`
          : `⏭ 交卷已受理：步骤 \`${step.id}\` 未配置 \`check\`，已跳过对抗性验证，直接进入下一步。`,
      };
    }
    writeState(state, instId);
    void launchVerification(instId, state, wf, step);
    return { ok: true, text: `🔍 交卷已受理，独立验证者（独立会话）正在取证判定。等它返回即可，不要重复交卷。` };
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
    return {
      remind: true,
      summary: `⚠️ 步骤 ${step.id} 尚未交卷（第 ${n}/${max} 次提醒）`,
      // 诚实标注：无 check 的步骤本就不验证，不能说「独立验证不会自动开始」（那是另一回事）。
      message: `[ralphflow] 提醒（第 ${n}/${max} 次）：本步（\`${step.id}\`）还没交卷，${stepHasCheck(step) ? "独立验证不会自动开始" : "工作流不会推进（本步未配置 `check`，交卷后跳过对抗性验证直接继续）"}。\n\n如果任务已完成，请调用 \`ralphflow_submit\` 工具交卷；如果还没做完，继续做。\n如果你正在等用户回答或需要用户介入，请直接说明，不必交卷。`,
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
      state.paused = false;
      state.pause_reason = undefined;
      state.verdicts = [];
      state.delegations = [];
      // 重置当前步失败计数：这是投递给模型的机制说明（tools.ts / SHARED_MECHANISM）明确承诺的
      // 「重置失败计数并重试」。不清零的话，max_failures 恢复后只要再失败一次就立刻二次暂停，
      // 用户永远拿不到「修好→重试」的机会。
      clearFailCount(state, state.current_step);
      pushHistory(state, "resume", `from=${reason}`);
      writeState(state, instId);
      if (state.do_submitted) {
        // 无 check 的步骤从不委派验证者（否则会为一步「作者已声明免验证」的步骤凭空造出判定）
        if (!stepHasCheck(step)) {
          const atGate = skipVerification(instId, state, wf, step);
          return {
            ok: true,
            text: atGate
              ? `▶️ 已解除暂停（原因：${reason}）。步骤 \`${step.id}\` 未配置 \`check\`，已跳过对抗性验证，停在审查门等你放行。`
              : `▶️ 已解除暂停（原因：${reason}）。步骤 \`${step.id}\` 未配置 \`check\`，已跳过对抗性验证，直接进入下一步。`,
          };
        }
        void launchVerification(instId, state, wf, step);
        return { ok: true, text: `▶️ 已解除暂停（原因：${reason}），正在重新委派独立验证者检查步骤 \`${step.id}\`。` };
      }
      deliver(state, doPrompt(instId, wf, state, step), `▶️ 步骤 ${step.id} 继续执行`);
      return { ok: true, text: `▶️ 已解除暂停（原因：${reason}），已让模型继续步骤 \`${step.id}\`。` };
    }

    // ② 有在飞委派 → 不重复推进（防重复委派）
    if (state.delegations.length > 0) {
      return { ok: false, text: `🔍 步骤 \`${step.id}\` 的独立验证者仍在取证判定中，现在不需要你操作——它跑完会自动唤醒本会话并继续。\n\n想了解进度用 \`/ralphflow-status\`；想中止用 \`/ralphflow-cancel\`。` };
    }

    // ③ 放行判据（design §12.1 精修后的两支，机械可判）：
    //    有 check → 判定齐 ∧ 全 passed ∧ 归属本步；
    //    无 check → **工作流定义已声明本步免验证**（`stepHasCheck` 只读 StepDef，执行者无法影响）。
    //    （审查门 / 普通步共用这一条：无 check 的普通步在交卷时已直接推进，走到这里的是门。）
    if (allPassedVerified(state, step) || !stepHasCheck(step)) {
      const byDefinition = !stepHasCheck(step);
      if (byDefinition) noteCheckSkipped(instId, state, step);
      if (isGate(wf, step)) pushHistory(state, "gate_released", undefined, step.id);
      advance(instId, state, wf, step);
      return {
        ok: true,
        text: byDefinition
          ? `⏭ 步骤 \`${step.id}\` 未配置 \`check\`（定义已声明免验证），已跳过对抗性验证并推进。`
          : `✅ 步骤 \`${step.id}\` 判定通过，已推进。`,
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

    // ⑥ 还没交卷 → fail-closed（只对**有 check** 的步骤可达：无 check 已被 ③ 按定义声明放行）
    return { ok: false, text: `步骤 \`${step.id}\` 还没交卷，无法推进（本步配置了 \`check\`，没有判定不能推进）。已完成工作就交卷，或让模型继续。` };
  }

  function cancelInstance(sessionId: string, instanceRef?: string, reason?: string): ToolResult {
    const info = activeInstanceOfSession(sessionId)
      ?? (instanceRef ? listInstances().find((i) => i.state.active && (i.id === instanceRef || i.id.startsWith(instanceRef))) : undefined);
    if (!info) return { ok: false, text: "当前会话没有活跃实例可取消。" };
    const { id: instId, state } = info;
    try { aborts.get(instId)?.abort(); } catch {}
    aborts.delete(instId);
    state.active = false;
    state.paused = false;
    state.pause_reason = "user_cancelled";
    state.delegations = [];
    pushHistory(state, "cancelled", reason);
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
    // 传入本步有无 check（从 StepDef 现算，零新状态字段）：无 check 的步骤不得宣称「会再次验证」。
    const wf = loadWorkflow(state.workflow_name).def;
    const hint = nextActionHint(state, id, wf ? stepOf(wf, state.current_step) : undefined);
    if (hint) lines.push("", hint);
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
      return "**无需操作**：独立验证者正在取证判定，跑完会自动唤醒本会话继续。可用 `/ralphflow-status` 看进度，`/ralphflow-cancel` 中止。";
    }
    if (s.do_submitted) {
      // 无 check 的步骤（纯人工审查/免验证）：不得写「会再次验证」——本步没有独立验证
      if (step && !stepHasCheck(step)) {
        return "**等你放行**：本步未配置 `check`（已**跳过对抗性验证**，纯人工审查）。确认无误运行 `/ralphflow-continue` 进入下一步；要修改就直接说明，改完重新交卷仍会停在这里。";
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
        body.push(`- **属主会话**: ${s.owner_session ? `\`${s.owner_session.slice(0, 8)}\`` : "无"}`);
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

  /** 插件加载/进程重启：孤儿委派 fail-safe（不隐式继续、不隐式通过） */
  function restore(): void {
    for (const { id, state } of listInstances()) {
      if (!state.active) continue;
      if (state.delegations.length > 0) {
        state.delegations = [];
        state.paused = true;
        state.pause_reason = "check_infra";
        pushHistory(state, "orphan_delegation_recovered");
        writeState(state, id);
        log("warn", "orphan_delegation_recovered", { instId: id });
      }
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
