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
}

export interface AdversarialConfig {
  model?: string;
  system_prompt?: string;
  /**
   * 本版本未支持（方言容错：警告忽略）。
   * 验证超时交给宿主 dsh 的原生看门狗，ralphflow 不自设总时长上界。
   * 字段保留仅为兼容旧 YAML 的读取与告警。
   */
  timeout_ms?: number;
  /** 验证者 provider 名；缺省用部署里可用的第一个 */
  agent?: string;
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
  submitSummary: string;
  ownerSession?: string;
  checkIndex: number;
  /**
   * 本实例产出目录的**工作区相对路径**（§1.7，正斜杠）。
   * 验证者继承父会话工作区，因此用它就能读到 DO 的产出；CHECK 提示词据此注入「产出目录」。
   */
  artifactsRelDir: string;
  /** 取消句柄（dsh 委派契约要求的 "caller's cancellation"；不是超时预算） */
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
 *   · 非 manual 步没写 check → 只有通用兜底配方，验收形同虚设。
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
  // 非 manual 且无 check：DO 完成后只会按通用兜底配方验证（**不会跳过验证**），
  // 但没有针对本步的验收配方 → 验证形同虚设，必须醒目告警。
  for (const s of steps) {
    const hasCheck = typeof s.check === "string" && s.check.trim() !== "";
    if (!hasCheck && !manual.has(s.id) && s.manual_step !== true) {
      warnings.push(`步骤 \`${s.id}\` 未配置对抗检查（无 \`check\`）：DO 完成后只会按通用兜底配方验证，建议补上针对本步的验收配方；确为人工审查步请加进 \`manual_step\`。`);
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

export function createEngine(projectDir: string, ports: EnginePorts) {
  const root = path.join(projectDir, RALPH_FLOW_DIR);
  const instancesDir = path.join(root, "instances");
  const workflowsDir = path.join(root, "workflows");
  const reportsDir = path.join(root, "reports");
  const artifactsDir = path.join(root, ARTIFACTS_DIRNAME);
  // 全局工作流目录仍是 `~/.dsh/ralph-flow/workflows`（插件命名空间在全局与工作区同名）
  const globalWorkflowsDir = path.join(os.homedir(), ".dsh", RALPH_FLOW_NAME, "workflows");
  /** 实例 → 在飞取消信号（取消/暂停时中止验证者，不白烧 token） */
  const aborts = new Map<string, AbortController>();

  // ─── 多工作区：实例落在「发起会话的工作区」，索引文件负责任意发现 ─────────
  const indexPath = path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json");
  const registry: Record<string, string> = (() => {
    try { return JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Record<string, string>; } catch { return {}; }
  })();
  function saveRegistry(): void {
    try {
      const tmp = `${indexPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
      fs.renameSync(tmp, indexPath);
    } catch (e) { log("warn", "registry_write_failed", { error: msg(e) }); }
  }
  function registerInstance(instId: string, workspace: string): void { registry[instId] = workspace; saveRegistry(); }
  function workspaceOf(instId: string): string { return registry[instId] ?? projectDir; }
  function rootOf(workspace: string): string { return path.join(workspace, RALPH_FLOW_DIR); }
  function dirsOf(workspace: string) {
    const r = rootOf(workspace);
    return {
      root: r,
      instancesDir: path.join(r, "instances"),
      workflowsDir: path.join(r, "workflows"),
      reportsDir: path.join(r, "reports"),
      artifactsDir: path.join(r, ARTIFACTS_DIRNAME),
    };
  }

  /** 每实例产出目录（§1.7）：`<workspace>/.dsh/ralph-flow/artifacts/<instId>/` */
  function artifactsDirOf(workspace: string, instId: string): string {
    return path.join(dirsOf(workspace).artifactsDir, instId);
  }

  /**
   * 产出目录的**工作区相对路径**（正斜杠，可嵌进 DO/CHECK 提示词）。
   * 验证者继承父会话工作区，所以这个路径对它同样可读。
   */
  function artifactsRelDirOf(instId: string): string {
    return `${RALPH_FLOW_DIR}/${ARTIFACTS_DIRNAME}/${instId}`;
  }

  const log = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    try { ports.log?.(level, event, data); } catch {}
  };

  function ensureLayout(workspace = projectDir): void {
    const d = dirsOf(workspace);
    for (const p of [d.root, d.instancesDir, d.workflowsDir, d.reportsDir, d.artifactsDir]) {
      try { fs.mkdirSync(p, { recursive: true }); } catch {}
    }
    // 内置工作流落盘为可编辑资产（已存在则不覆盖——用户改动优先）
    for (const name of BUILTIN_WORKFLOWS) {
      const dest = path.join(d.workflowsDir, `${name}.yaml`);
      if (fs.existsSync(dest)) continue;
      const src = builtinWorkflowPath(name);
      if (!src) continue;
      try { fs.copyFileSync(src, dest); } catch {}
    }
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

  const KNOWN_STEP_KEYS = new Set(["id", "desc", "do", "check", "check_voting", "input", "output", "manual_step", "on_pass", "on_fail", "max_fail_count"]);
  const KNOWN_WF_KEYS = new Set(["description", "manual_step", "adversarial_check", "steps"]);

  function knownWorkflowDirs(): string[] {
    const dirs = new Set<string>([workflowsDir, globalWorkflowsDir]);
    for (const w of Object.values(registry)) dirs.add(dirsOf(w).workflowsDir);
    return [...dirs];
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
        warnings.push(`步骤 \`${s.id}\` 用了 \`check_voting\`（多验证者投票）：本版本未支持，已忽略并按通用对抗检查执行。`);
      }
      // ── §1.1 加载期硬校验：写错了却没有任何信号 = 缺陷（要么硬错误，要么 doctor 告警）
      // do 缺失：没有可执行的指令，整步无意义 → 硬错误（不再静默接受空步）。
      if (typeof s.do !== "string" || s.do.trim() === "") {
        problems.push(`步骤 \`${s.id}\` 缺少 \`do\`（必填：主会话执行的指令；缺失、非字符串或空串都不接受）。`);
      }
      // check 存在但非字符串（如 `check: true`）：几乎一定是漏写正文。
      // 硬错误，不静默当成「本步不做检查」——避免把「想要 check」误读成「不想 check」。
      if (s.check !== undefined && s.check !== null && typeof s.check !== "string") {
        problems.push(`步骤 \`${s.id}\` 的 \`check\` 必须是字符串（当前是 ${typeof s.check}）。本意是不做对抗检查就删掉该键。`);
      }
      // max_fail_count 给了就必须是 ≥1 的整数（0/负数以前被静默接受 → 首次失败即暂停，用户看不懂）。
      if (s.max_fail_count !== undefined
        && (typeof s.max_fail_count !== "number" || !Number.isInteger(s.max_fail_count) || s.max_fail_count < 1)) {
        problems.push(`步骤 \`${s.id}\` 的 \`max_fail_count\` 必须是 ≥1 的整数（当前 ${JSON.stringify(s.max_fail_count)}）。`);
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
    // 方言容错（design §8 Q13 定案）：timeout_ms 本版本未支持 → 警告忽略，不静默吞掉。
    // ralphflow 不再自设验证超时，委派生命周期完全交给 dsh 原生能力（见 verify.ts 注释）。
    if (doc.adversarial_check && typeof doc.adversarial_check === "object"
      && (doc.adversarial_check as { timeout_ms?: unknown }).timeout_ms !== undefined) {
      warnings.push("`adversarial_check.timeout_ms` 本版本未支持（验证超时交给宿主 dsh 的原生看门狗），已忽略。");
    }
    const def: WorkflowDef = {
      name,
      description: typeof doc.description === "string" ? doc.description : "",
      manual_step: manual,
      adversarial_check: doc.adversarial_check && typeof doc.adversarial_check === "object"
        ? {
            model: typeof doc.adversarial_check.model === "string" ? doc.adversarial_check.model : undefined,
            system_prompt: typeof doc.adversarial_check.system_prompt === "string" ? doc.adversarial_check.system_prompt : undefined,
            agent: typeof doc.adversarial_check.agent === "string" ? doc.adversarial_check.agent : undefined,
          }
        : undefined,
      steps,
      warnings,
    };
    return { def, problems, warnings };
  }

  // ─── 状态 I/O（原子写）─────────────────────────────────────────────────────

  function instanceDir(instId: string): string { return path.join(dirsOf(workspaceOf(instId)).instancesDir, instId); }
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

  function listInstances(): InstanceInfo[] {
    try {
      return Object.keys(registry)
        .map((id) => ({ id, state: readState(id) }))
        .filter((x): x is InstanceInfo => !!x.state)
        .sort((a, b) => (a.state.started_at < b.state.started_at ? -1 : 1));
    } catch { return []; }
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

  /** 当前步是否已停下等放行的审查门（判定齐且全 passed，且判定属于本步） */
  function atOpenGate(wf: WorkflowDef, state: InstanceState, step: StepDef): boolean {
    return isGate(wf, step) && allPassedVerified(state, step);
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
      "1. **先用一两句面向用户的话说明现在的状态与接下来会发生什么**，要让用户一眼看懂：本步已完成 → 接下来进入**独立验证**（异步，通常 1–5 分钟，**不需要用户做任何操作**）→ 期间用户可以做什么（补充信息或纠正方向 / 用 `/ralphflow-status` 看进度 / 用 `/ralphflow-cancel` 中止）。用用户的语言写，不要把它埋进技术叙述里。",
      "2. **调用 `ralphflow_submit` 工具交卷**（可在参数 `summary` 里简述你做了什么）。独立验证者会立刻检查你的产出。",
      "",
      "不要只在回复里说「完成了」——那样不会触发验证。**必须调用工具**。",
    );
    return parts.join("\n");
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
        submitSummary: state.last_submit_summary ?? "",
        ownerSession: state.owner_session, checkIndex, artifactsRelDir: artifactsRelDirOf(instId),
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
    deliver(state, doPrompt(instId, wf, state, next), `▶️ 步骤 ${next.id} 开始执行${next.desc ? `：${next.desc}` : ""}（完成后会自动进入独立验证）`);
  }

  function complete(instId: string, state: InstanceState, wf: WorkflowDef): void {
    pushHistory(state, "complete", `workflow=${wf.name}`);
    state.active = false;
    state.paused = false;
    state.pause_reason = undefined;
    state.do_submitted = false;
    writeState(state, instId);
    archiveReport(instId, state, wf, "done");
    notify(state, `✅ 工作流 \`${wf.name}\` 完成，报告已归档到工作区的 \`${RALPH_FLOW_DIR}/reports/\`。`, `✅ 工作流 ${wf.name} 完成（报告已归档 ${RALPH_FLOW_DIR}/reports/）`);
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

  function archiveReport(instId: string, state: InstanceState, wf: WorkflowDef, status: "done" | "cancelled"): void {
    try {
      // 报告与实例同属一个工作区（实例目录在哪，报告就归档到哪）
      const target = dirsOf(workspaceOf(instId)).reportsDir;
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
      fs.writeFileSync(path.join(target, `${instId}.md`), lines.join("\n"), "utf-8");
    } catch (e) {
      log("warn", "report_write_failed", { instId, error: msg(e) });
    }
  }

  // ─── 对外动作 ──────────────────────────────────────────────────────────────

  function activeInstanceOfSession(sessionId: string): InstanceInfo | undefined {
    return listInstances().find((i) => i.state.active && i.state.owner_session === sessionId);
  }

  /** workspace：发起会话的工作区（缺省回落 projectDir 单根模式） */
  function start(workflowName: string, task: string, sessionId: string, workspace = projectDir): ToolResult {
    if (!workflowName?.trim()) return { ok: false, text: "缺少工作流名。用法：`ralphflow_start(workflow, task)` 或 `/ralphflow-start <工作流> <任务>`。" };
    if (!task?.trim()) return { ok: false, text: "缺少任务描述。示例：`/ralphflow-start loop 修复登录模块的空指针`。" };
    const mine = activeInstanceOfSession(sessionId);
    if (mine) {
      return { ok: false, text: `当前会话已有活跃实例 \`${mine.id}\`（${mine.state.workflow_name} · ${mine.state.current_step}）。用 \`/ralphflow-continue\` 继续，或 \`/ralphflow-cancel\` 取消。` };
    }
    try { ensureLayout(workspace); } catch {}
    const { def: wf, problems, warnings } = loadWorkflow(workflowName.trim());
    if (!wf) return { ok: false, text: `工作流 \`${workflowName}\` 无法启动：\n${problems.map((p) => `- ${p}`).join("\n")}` };
    const first = wf.steps[0]!;
    const instId = newInstId(wf.name);
    const now = new Date().toISOString();
    const state: InstanceState = {
      active: true, workflow_name: wf.name, current_step: first.id, user_task: task.trim(),
      fail_counts: {}, fail_count: 0, paused: false, do_submitted: false, owner_session: sessionId,
      delegations: [], verdicts: [], history: [], started_at: now, updated_at: now,
    };
    registerInstance(instId, workspace);
    pushHistory(state, "start", `workflow=${wf.name}`, first.id);
    writeState(state, instId);
    // §1.7 产出目录：实例启动时建好，完成后**保留**（不随实例结束删除）。
    try { fs.mkdirSync(artifactsDirOf(workspace, instId), { recursive: true }); } catch {}
    log("info", "instance_start", { instId, workflow: wf.name, workspace });
    const warnText = warnings.length > 0 ? `\n\n⚠️ 工作流定义告警：\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
    const text = [
      `🚀 已启动工作流 **${wf.name}**（实例 \`${instId}\`，共 ${wf.steps.length} 步）。${warnText}`,
      "",
      "接下来：模型执行本步 → 交卷 → **独立验证者**（独立会话，看不到本对话）取证判定 → 通过则推进，不通过自动返工。",
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
        return { ok: false, text: "交卷内容与上一次完全相同，未重复验证。若你确实改动了产出，请简述改动后再交卷。" };
      }
      reopenGate(state, instId, step, "审查门上重新交卷（改稿）");
      state.do_submitted = true;
      state.last_submit_summary = text;
      pushHistory(state, "do_submitted", undefined, step.id);
      writeState(state, instId);
      void launchVerification(instId, state, wf, step);
      return { ok: true, text: `🔍 已受理重新交卷，正在重新委派独立验证者检查步骤 \`${step.id}\`。` };
    }

    state.do_submitted = true;
    state.last_submit_summary = text;
    pushHistory(state, "do_submitted", undefined, step.id);
    writeState(state, instId);
    void launchVerification(instId, state, wf, step);
    return { ok: true, text: `🔍 交卷已受理，独立验证者（独立会话）正在取证判定。等它返回即可，不要重复交卷。` };
  }

  // ─── 交卷上下文捕获（供验证者 prompt 使用；不落盘、不触发任何状态迁移）──────
  /**
   * 记下会话最近一条助手文本，供验证者 prompt 的「交卷摘要」用。
   * 这是**纯上下文捕获**，不再承担「检测交卷」的职责（那已由工具调用承担）。
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
      message: `[ralphflow] 提醒（第 ${n}/${max} 次）：本步（\`${step.id}\`）还没交卷，独立验证不会自动开始。\n\n如果任务已完成，请调用 \`ralphflow_submit\` 工具交卷；如果还没做完，继续做。\n如果你正在等用户回答或需要用户介入，请直接说明，不必交卷。`,
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

    // ③ 判定落地且全 passed，且判定属于当前步（审查门 / 兜底推进）
    if (allPassedVerified(state, step)) {
      if (isGate(wf, step)) pushHistory(state, "gate_released", undefined, step.id);
      advance(instId, state, wf, step);
      return { ok: true, text: `✅ 步骤 \`${step.id}\` 判定通过，已推进。` };
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

    // ⑥ 还没交卷 → fail-closed
    return { ok: false, text: `步骤 \`${step.id}\` 还没交卷，无法推进（本版本没有跳过验证的路径）。已完成工作就交卷，或让模型继续。` };
  }

  function cancelInstance(sessionId: string, instanceRef?: string, reason?: string): ToolResult {
    const info = activeInstanceOfSession(sessionId)
      ?? (instanceRef ? listInstances().find((i) => i.state.active && (i.id === instanceRef || i.id.startsWith(instanceRef))) : undefined);
    if (!info) return { ok: false, text: "当前会话没有活跃实例可取消。" };
    const { id: instId, state } = info;
    try { aborts.get(instId)?.abort(); } catch {}
    aborts.delete(instId);
    const { def: wf } = loadWorkflow(state.workflow_name);
    state.active = false;
    state.paused = false;
    state.pause_reason = "user_cancelled";
    state.delegations = [];
    pushHistory(state, "cancelled", reason);
    writeState(state, instId);
    if (wf) archiveReport(instId, state, wf, "cancelled");
    notify(state, `🛑 实例 \`${instId}\` 已取消${reason ? `：${reason}` : ""}。报告已归档。`, `🛑 ralphflow 实例已取消${reason ? `：${reason}` : ""}`);
    return { ok: true, text: `已取消实例 \`${instId}\`。` };
  }

  function statusOf(sessionId: string, instanceRef?: string): ToolResult {
    const info = instanceRef
      ? listInstances().find((i) => i.id === instanceRef || i.id.startsWith(instanceRef))
      : activeInstanceOfSession(sessionId) ?? listInstances().filter((i) => i.state.active).at(-1);
    if (!info) return { ok: true, text: "没有实例。用 `/ralphflow-start <工作流> <任务>` 启动。" };
    return { ok: true, text: renderInstance(info) };
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
    const hint = nextActionHint(state);
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
  function nextActionHint(s: InstanceState): string | undefined {
    if (!s.active) return `工作流已结束。报告在 \`${RALPH_FLOW_DIR}/reports/\`；要再跑一次用 \`/ralphflow-start <工作流> <任务>\`。`;
    if (s.paused) {
      if (s.pause_reason === "max_failures") return "**等你定夺**：修好问题后 `/ralphflow-continue` 重新验证，或 `/ralphflow-cancel` 结束。";
      if (s.pause_reason === "no_submit") return "**等你处理**：模型反复未交卷。让它调用 `ralphflow_submit`，再 `/ralphflow-continue`；或 `/ralphflow-cancel` 结束。";
      return "**暂停中**：处理后 `/ralphflow-continue` 恢复（基础设施问题不计失败）。";
    }
    if (s.delegations.length > 0) {
      return "**无需操作**：独立验证者正在取证判定，跑完会自动唤醒本会话继续。可用 `/ralphflow-status` 看进度，`/ralphflow-cancel` 中止。";
    }
    if (s.do_submitted) {
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
    const wfs = listWorkflows();
    const head: string[] = ["## 可用工作流", ""];
    if (wfs.length === 0) head.push("没有找到工作流。");
    else {
      for (const w of wfs) {
        head.push(`- **${w.name}**: ${w.desc || "(无描述)"}${w.invalid ? "（定义无效）" : ""}`);
      }
    }
    const body: string[] = ["", `## 工作流实例（${all.length} 个）`, ""];
    if (all.length === 0) {
      body.push("（暂无实例）");
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
    return { ok: true, text: head.concat(body).join("\n") };
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
    lines.push("", "结论：所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅。");
    return { ok: true, text: lines.join("\n") };
  }

  /** 插件加载/进程重启：孤儿委派 fail-safe（不隐式继续、不隐式通过） */
  function restore(): void {
    // §1.5 索引 GC：`state.json` 已不存在的悬挂条目（实例目录被手动清理、或布局迁移过）
    // 必须清出索引，否则 listInstances / 接管列表永远看到读不到的幽灵实例。
    // 只清索引条目，**绝不删任何目录**（血泪规则：复现脚本不得动真实工作区）。
    let gcChanged = false;
    for (const id of Object.keys(registry)) {
      let exists = false;
      try { exists = fs.statSync(statePath(id)).isFile(); } catch { exists = false; }
      if (!exists) {
        delete registry[id];
        gcChanged = true;
        log("warn", "registry_gc_dangling", { instId: id });
      }
    }
    if (gcChanged) saveRegistry();

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
    readState, listInstances, instanceDir, workspaceOf, indexPath,
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