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

export const RALPH_FLOW_DIR = "ralph-flow";

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
  fail_count: number;
  paused: boolean;
  pause_reason?: "max_failures" | "check_infra" | "user_cancelled";
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
  /** 把指令投递给主会话（插件消息 + 唤醒） */
  deliver: (sessionId: string, text: string) => boolean;
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
  signal: AbortSignal;
}

// ─── 引擎 ────────────────────────────────────────────────────────────────────

export function createEngine(projectDir: string, ports: EnginePorts) {
  const root = path.join(projectDir, RALPH_FLOW_DIR);
  const instancesDir = path.join(root, "instances");
  const workflowsDir = path.join(root, "workflows");
  const reportsDir = path.join(root, "reports");
  const globalWorkflowsDir = path.join(os.homedir(), ".dsh", RALPH_FLOW_DIR, "workflows");
  /** 实例 → 在飞取消信号（取消/暂停时中止验证者，不白烧 token） */
  const aborts = new Map<string, AbortController>();

  const log = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    try { ports.log?.(level, event, data); } catch {}
  };

  function ensureLayout(): void {
    for (const d of [root, instancesDir, workflowsDir, reportsDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch {}
    }
    // 内置工作流落盘为可编辑资产（已存在则不覆盖——用户改动优先）
    for (const name of BUILTIN_WORKFLOWS) {
      const dest = path.join(workflowsDir, `${name}.yaml`);
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

  function workflowPaths(name: string): string[] {
    return [
      path.join(workflowsDir, `${name}.yaml`),
      path.join(workflowsDir, `${name}.yml`),
      path.join(globalWorkflowsDir, `${name}.yaml`),
      path.join(globalWorkflowsDir, `${name}.yml`),
    ];
  }

  function listWorkflows(): WorkflowEntry[] {
    const names = new Set<string>(BUILTIN_WORKFLOWS);
    for (const dir of [workflowsDir, globalWorkflowsDir]) {
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
    // 引用校验：on_pass / on_fail 必须指向存在的步骤或 done
    for (const s of steps) {
      for (const [key, target] of [["on_pass", s.on_pass], ["on_fail", s.on_fail]] as const) {
        if (target === undefined) continue;
        if (target === "done") continue;
        if (!ids.has(target)) problems.push(`步骤 \`${s.id}\` 的 ${key} 指向不存在的步骤 \`${target}\`。`);
      }
    }
    if (problems.length > 0) return { def: null, problems, warnings };
    const manual = Array.isArray(doc.manual_step)
      ? doc.manual_step.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (doc.manual_step !== undefined && !Array.isArray(doc.manual_step)) {
      warnings.push("顶层 manual_step 不是列表，已忽略。");
    }
    const def: WorkflowDef = {
      name,
      description: typeof doc.description === "string" ? doc.description : "",
      manual_step: manual,
      adversarial_check: doc.adversarial_check && typeof doc.adversarial_check === "object"
        ? {
            model: typeof doc.adversarial_check.model === "string" ? doc.adversarial_check.model : undefined,
            system_prompt: typeof doc.adversarial_check.system_prompt === "string" ? doc.adversarial_check.system_prompt : undefined,
            timeout_ms: typeof doc.adversarial_check.timeout_ms === "number" ? doc.adversarial_check.timeout_ms : undefined,
            agent: typeof doc.adversarial_check.agent === "string" ? doc.adversarial_check.agent : undefined,
          }
        : undefined,
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
      return s as InstanceState;
    } catch { return null; }
  }

  function writeState(state: InstanceState, instId: string): void {
    state.updated_at = new Date().toISOString();
    try {
      const dir = instanceDir(instId);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.state.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(tmp, statePath(instId));
    } catch (e) {
      log("error", "state_write_failed", { instId, error: msg(e) });
    }
  }

  function pushHistory(state: InstanceState, event: string, detail?: string, step?: string): void {
    state.history.push({ ts: new Date().toISOString(), event, detail, step: step ?? state.current_step });
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
  }

  function listInstances(): InstanceInfo[] {
    try {
      return fs.readdirSync(instancesDir)
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

  // ─── 交卷与验证（三时刻①②）────────────────────────────────────────────────

  /** DO prompt：宣告本步任务（顺势力措辞，最后一行交卷标记） */
  function doPrompt(wf: WorkflowDef, state: InstanceState, step: StepDef, rework?: string): string {
    const idx = wf.steps.findIndex((s) => s.id === step.id) + 1;
    const parts = [
      `[ralphflow] 工作流 \`${wf.name}\` · 步骤 ${idx}/${wf.steps.length}：**${step.id}**${step.desc ? ` — ${step.desc}` : ""}`,
      "",
      `## 任务`,
      state.user_task,
      "",
      `## 本步要做什么`,
      (step.do || step.desc || step.id).trim(),
    ];
    if (step.output) parts.push("", `## 交付物`, String(step.output).trim());
    if (rework) {
      parts.push("", `## 上一轮验证未通过，请针对性修复`, rework.trim());
    }
    parts.push(
      "",
      "## 交卷方式",
      "完成实际工作后，在回复的**最后一行**单独输出 `<promise>done</promise>`。独立验证者会立刻检查你的产出。",
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

    let verdict: Verdict;
    try {
      verdict = await ports.verify({
        instId, step, workflow: wf, userTask: state.user_task,
        submitSummary: state.last_submit_summary ?? "",
        ownerSession: state.owner_session, checkIndex, signal: controller.signal,
      });
    } catch (e) {
      verdict = { check_index: checkIndex, status: "infra", reason: `验证未跑成：${msg(e)}`, step_id: step.id, ts: new Date().toISOString() };
    }

    // 落判定：只信 ports.verify 的返回（T1）。实例可能在验证期间被取消。
    const fresh = readState(instId);
    if (!fresh || !fresh.active || fresh.current_step !== step.id) return;
    fresh.delegations = fresh.delegations.filter((d) => d.run_id !== runId);
    fresh.verdicts.push(verdict);
    aborts.delete(instId);
    pushHistory(fresh, `verdict_${verdict.status}`, verdict.reason.slice(0, 300), step.id);
    log("info", "verdict", { instId, status: verdict.status });

    if (anyInfra(fresh)) {
      fresh.paused = true;
      fresh.pause_reason = "check_infra";
      writeState(fresh, instId);
      notify(fresh, `⏸ 验证未跑成（基础设施问题，不计失败）：${verdict.reason}\n\n修复后运行 \`/ralphflow-continue\` 重新验证。`);
      return;
    }
    if (anyFailed(fresh)) {
      fresh.fail_count += 1;
      const max = step.max_fail_count ?? 3;
      if (fresh.fail_count >= max) {
        fresh.paused = true;
        fresh.pause_reason = "max_failures";
        writeState(fresh, instId);
        notify(fresh, `⏸ 步骤 \`${step.id}\` 连续 ${fresh.fail_count} 轮未通过（上限 ${max}），已暂停等你定夺。\n\n验证者的意见：\n${verdict.reason}\n\n处理后可运行 \`/ralphflow-continue\` 重新验证，或 \`/ralphflow-cancel\` 结束。`);
        return;
      }
      // 返工：同一回合直接把原因交回主会话
      fresh.do_submitted = false;
      fresh.verdicts = [];
      writeState(fresh, instId);
      deliver(fresh, doPrompt(wf, fresh, step, verdict.reason));
      notify(fresh, `🔁 验证未通过（第 ${fresh.fail_count}/${max} 轮），已把问题交回模型返工。\n\n${verdict.reason}`);
      return;
    }
    // 全 passed
    if (isGate(wf, step)) {
      writeState(fresh, instId);
      notify(fresh, `🙋 步骤 \`${step.id}\` 已通过独立验证，停在审查门等你放行。\n\n确认无误运行 \`/ralphflow-continue\` 进入下一步；需要修改就直接说明，改完重新交卷会再次验证。`);
      return;
    }
    writeState(fresh, instId);
    advance(instId, fresh, wf, step);
  }

  /** 推进（T2）：只有这里改 current_step */
  function advance(instId: string, state: InstanceState, wf: WorkflowDef, step: StepDef): void {
    const target = nextStepId(wf, step);
    if (target === "done") { complete(instId, state, wf); return; }
    const next = stepOf(wf, target);
    if (!next) {
      // 加载期已校验，这里只作兜底（坏定义不得静默跳步）
      state.paused = true;
      state.pause_reason = "check_infra";
      pushHistory(state, "advance_target_missing", target);
      writeState(state, instId);
      notify(state, `⏸ 工作流定义里 on_pass 指向的步骤 \`${target}\` 不存在，已暂停（引擎拒绝跳步）。`);
      return;
    }
    state.current_step = next.id;
    state.do_submitted = false;
    state.verdicts = [];
    state.delegations = [];
    state.last_submit_summary = undefined;
    pushHistory(state, "step_start", next.desc ?? "", next.id);
    writeState(state, instId);
    deliver(state, doPrompt(wf, state, next));
  }

  function complete(instId: string, state: InstanceState, wf: WorkflowDef): void {
    pushHistory(state, "complete", `workflow=${wf.name}`);
    state.active = false;
    state.paused = false;
    state.pause_reason = undefined;
    state.do_submitted = false;
    writeState(state, instId);
    archiveReport(instId, state, wf, "done");
    notify(state, `✅ 工作流 \`${wf.name}\` 完成，报告已归档到 \`${path.relative(projectDir, reportsDir)}/\`。`);
  }

  function deliver(state: InstanceState, text: string): void {
    if (!state.owner_session) return;
    const ok = ports.deliver(state.owner_session, text);
    if (!ok) log("warn", "deliver_failed", { instId: state.owner_session });
  }

  function notify(state: InstanceState, text: string): void {
    deliver(state, `[ralphflow] ${text}`);
  }

  // ─── 报告归档 ──────────────────────────────────────────────────────────────

  function archiveReport(instId: string, state: InstanceState, wf: WorkflowDef, status: "done" | "cancelled"): void {
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
      const lines = [
        `# ralphflow 报告 · ${wf.name}`,
        "",
        `- 实例：\`${instId}\``,
        `- 状态：**${status === "done" ? "完成" : "取消"}**`,
        `- 任务：${state.user_task}`,
        `- 开始：${state.started_at}`,
        `- 结束：${new Date().toISOString()}`,
        `- 失败轮数：${state.fail_count}`,
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
      fs.writeFileSync(path.join(reportsDir, `${instId}.md`), lines.join("\n"), "utf-8");
    } catch (e) {
      log("warn", "report_write_failed", { instId, error: msg(e) });
    }
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
    const { def: wf, problems, warnings } = loadWorkflow(workflowName.trim());
    if (!wf) return { ok: false, text: `工作流 \`${workflowName}\` 无法启动：\n${problems.map((p) => `- ${p}`).join("\n")}` };
    const first = wf.steps[0]!;
    const instId = newInstId(wf.name);
    const now = new Date().toISOString();
    const state: InstanceState = {
      active: true, workflow_name: wf.name, current_step: first.id, user_task: task.trim(),
      fail_count: 0, paused: false, do_submitted: false, owner_session: sessionId,
      delegations: [], verdicts: [], history: [], started_at: now, updated_at: now,
    };
    pushHistory(state, "start", `workflow=${wf.name}`, first.id);
    writeState(state, instId);
    log("info", "instance_start", { instId, workflow: wf.name });
    const warnText = warnings.length > 0 ? `\n\n⚠️ 定义里有本版本未支持的键（已忽略）：\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
    const text = [
      `🚀 已启动工作流 **${wf.name}**（实例 \`${instId}\`，共 ${wf.steps.length} 步）。${warnText}`,
      "",
      "接下来：模型执行本步 → 交卷 → **独立验证者**（独立会话，看不到本对话）取证判定 → 通过则推进，不通过自动返工。",
      "",
      "请现在开始执行上面的任务。",
    ].join("\n");
    return { ok: true, text: `${text}\n\n---\n\n${doPrompt(wf, state, first)}` };
  }

  /** 主会话交卷（三时刻①）：只观测事实，不产生判定 */
  function onAssistantMessage(sessionId: string, text: string): void {
    if (!/<promise>\s*done\s*<\/promise>/i.test(text)) return;
    const info = activeInstanceOfSession(sessionId);
    if (!info) return;
    const { id: instId, state } = info;
    if (state.paused || state.do_submitted || state.delegations.length > 0) return;
    const { def: wf } = loadWorkflow(state.workflow_name);
    if (!wf) { log("warn", "workflow_missing_at_submit", { instId }); return; }
    const step = stepOf(wf, state.current_step);
    if (!step) return;
    state.do_submitted = true;
    state.last_submit_summary = stripDoneTag(text).slice(-4000).trim();
    pushHistory(state, "do_submitted", undefined, step.id);
    writeState(state, instId);
    void launchVerification(instId, state, wf, step);
  }

  function stripDoneTag(text: string): string {
    return text.replace(/<promise>\s*done\s*<\/promise>\s*$/i, "").trim();
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
    if (!info) return { ok: false, text: "当前会话没有活跃实例。用 `/ralphflow-list` 查看全部实例；要接管其它实例：`/ralphflow-continue <实例ID>`。" };
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
      pushHistory(state, "resume", `from=${reason}`);
      writeState(state, instId);
      if (state.do_submitted) {
        void launchVerification(instId, state, wf, step);
        return { ok: true, text: `▶️ 已解除暂停（原因：${reason}），正在重新委派独立验证者检查步骤 \`${step.id}\`。` };
      }
      deliver(state, doPrompt(wf, state, step));
      return { ok: true, text: `▶️ 已解除暂停（原因：${reason}），已让模型继续步骤 \`${step.id}\`。` };
    }

    // ② 有在飞委派 → 不重复推进（防重复委派）
    if (state.delegations.length > 0) {
      return { ok: false, text: `验证正在进行中（步骤 \`${step.id}\`），等它交卷后再 continue。` };
    }

    // ③ 判定落地且全 passed（审查门 / 兜底推进）
    if (allPassed(state)) {
      if (isGate(wf, step)) pushHistory(state, "gate_released", undefined, step.id);
      advance(instId, state, wf, step);
      return { ok: true, text: `✅ 步骤 \`${step.id}\` 判定通过，已推进。` };
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
    notify(state, `🛑 实例 \`${instId}\` 已取消${reason ? `：${reason}` : ""}。报告已归档。`);
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
    if (state.verdicts.length > 0) {
      lines.push("", "本轮判定：", ...state.verdicts.map((v) => `- [${v.status}] ${v.reason}`));
    }
    const tail = state.history.slice(-5);
    if (tail.length > 0) {
      lines.push("", "最近轨迹：", ...tail.map((h) => `- \`${h.ts}\` ${h.event}${h.detail ? ` — ${h.detail.slice(0, 120)}` : ""}`));
    }
    return lines.join("\n");
  }

  function listAll(): ToolResult {
    const all = listInstances();
    if (all.length === 0) return { ok: true, text: "还没有任何实例。" };
    const active = all.filter((i) => i.state.active);
    const lines = [
      `活跃实例 ${active.length} 个 / 共 ${all.length} 个：`,
      "",
      ...all.map((i) => {
        const s = i.state;
        const flag = !s.active ? "已结束" : s.paused ? `暂停(${s.pause_reason})` : s.delegations.length > 0 ? "验证中" : s.do_submitted ? "待放行" : "执行中";
        return `- \`${i.id}\` — ${s.workflow_name} · ${s.current_step} · ${flag} · 失败${s.fail_count} · ${s.owner_session ? "有属主" : "无属主"}`;
      }),
      "",
      "接管无属主实例：`/ralphflow-continue <实例ID>`。",
      "",
      "可用工作流：" + listWorkflows().map((w) => `${w.name}${w.invalid ? "(定义无效)" : ""}`).join("、"),
    ];
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
    readState, listInstances, instanceDir,
    start, onAssistantMessage, continueInstance, cancelInstance, statusOf, listAll, restore,
    activeInstanceOfSession,
  };
}

export type Engine = ReturnType<typeof createEngine>;

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const BUILTIN_WORKFLOWS = ["loop", "spec"];