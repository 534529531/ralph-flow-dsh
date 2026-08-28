/**
 * Ralph Flow Engine for opencode.
 *
 * The WORKFLOW LOGIC (prompt building, the check-result state machine, workflow
 * loading, lint/doctor) mirrors the Claude Code plugin's mcp-server/server.mjs
 * so the two stay behavior-compatible; see SYNC.md.
 *
 * The RUNTIME PLUMBING is opencode-native, NOT a mirror. opencode runs one
 * plugin instance per project directory (shared memory, events carry the
 * sessionID), so the Claude version's multi-PROCESS coordination is unnecessary
 * and was actively harmful here:
 * - No shared mutable "bound instance": every instance-scoped function takes an
 *   explicit `instId` (like the original opencode plugin passed `directory`),
 *   so there is nothing to serialize and no in-memory state lock.
 * - No cross-process file lock: a single process needs none; operations on one
 *   instance are naturally serialized by opencode's per-session turn model.
 * - Ownership is just `session_id` stored in the instance's state.json — no
 *   owner-session file, no pid/ppid liveness inference.
 *
 * Multi-instance is kept for parity: state lives under
 * .opencode/ralph-flow/instances/<instance-id>/, so different sessions can run
 * their own workflow in the same project.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckVotingEntry {
  check: string;
  model?: string | { providerID?: string; modelID?: string };
  timeout_ms?: number;
  system_prompt?: string;
}

export interface NormalStepDef {
  id: string;
  desc: string;
  do: string;
  input: string;
  output: string;
  check?: string;
  /** 合法缺省 check 的步骤（无独立验证，DO 完成即直通 on_pass）；由解析器标注 */
  no_check?: boolean;
  check_voting?: CheckVotingEntry[];
  check_model?: string | { providerID?: string; modelID?: string };
  on_pass: string;
  on_fail: string;
  max_fail_count: number;
  reset?: boolean;
}

export interface SubWorkflowStepDef {
  id: string;
  desc: string;
  workflow: string;
  inputs?: Record<string, string>;
  input: string;
  output: string;
  on_pass: string;
  on_fail: string;
  max_fail_count: number;
  reset?: boolean;
}

export type StepDef = NormalStepDef | SubWorkflowStepDef;

export interface AdversarialCheckConfig {
  model?: string | { providerID?: string; modelID?: string };
  agent?: string;
  system_prompt?: string;
  timeout_ms?: number;
}

export interface WorkflowDef {
  name: string;
  description: string;
  manual_step: string[];
  steps: StepDef[];
  adversarial_check?: AdversarialCheckConfig;
  auto_reset?: boolean;
}

export interface RalphFlowState {
  active: boolean;
  workflow_name: string;
  current_step: string;
  current_phase: string;
  fail_count: number;
  user_task: string;
  paused: boolean;
  pause_reason?: string;
  last_failure_reason?: string;
  instance_id?: string;
  /** The session that owns/drives this instance. Set by the tool that touches it. */
  session_id?: string;
}

export interface StepExecutionRecord {
  stepId: string;
  phase: string;
  status: "passed" | "failed";
  failCount: number;
  startTime: string;
  endTime?: string;
  reason?: string;
  /**
   * 该记录产生时所在的工作流（嵌套子工作流时是内层工作流名）。2.7.1 起写入；
   * 旧实例的记录没有此字段——passedStepIds 对无字段记录回退到仅按 stepId 过滤。
   */
  workflowName?: string;
}

export interface CheckResult {
  passed: boolean;
  infra?: boolean;
  reason: string;
}

export interface InstanceInfo {
  id: string;
  state: RalphFlowState;
  owner: string | null;   // state.session_id, or null if unclaimed
  manualGate: boolean;
  doneTag: boolean;
  lastActivity: Date | null;
}

export interface TransitionResult {
  text: string;
  paused?: boolean;
  completed?: boolean;
  /**
   * opencode 原生增量（Claude 版可忽略）：本次转换进入了哪个 composite 步骤的
   * 子工作流。注入层的 reset 门需要它——进入子工作流后 state 已推进到子工作流
   * 内部第一步，(sourceStep → currentStep) 再也回指不到 composite 步骤上标记的
   * reset/auto_reset（同 id 重入时首尾状态甚至完全相同）。状态机行为不变，
   * 仅多返回这一元数据。
   */
  enteredCompositeStepId?: string;
}

/**
 * Platform seam — the little the engine needs from the host.
 */
export interface Platform {
  /** Abort a still-running adversarial check (in-process handle). */
  abortActiveCheck?(instId: string): void;
}

/**
 * Strip UTF-8 BOM (Byte Order Mark) from file content.
 * Windows Notepad and some editors add BOM to UTF-8 files.
 * js-yaml and JSON.parse don't handle BOM, causing parse failures.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const RALPH_FLOW_DIR = "ralph-flow";
const INSTANCES_DIRNAME = "instances";
const REPORTS_DIRNAME = "reports";
const STATE_FILENAME = "state.json";
const STACK_FILENAME = "state-stack.json";
// Mirrors the Claude version's .adversarial-pid: holds the CHECK session id
// instead of a child-process pid (the opencode check runs as an SDK session,
// not a subprocess).
const ADVERSARIAL_SESSION_FILENAME = ".adversarial-session";
/**
 * popState 的「栈文件损坏」哨兵：与 null（栈为空=真正顶层）严格区分。
 * 收到哨兵绝不能走「顶层完成→销毁实例」分支——父帧可能仍在，误判会连本带
 * 息丢掉父工作流的剩余步骤。
 */
const STACK_CORRUPTED = Symbol("ralphflow:stack-corrupted");
export const MANUAL_STEP_MARKER = ".manual-step-active";
export const MANUAL_GATE_MARKER = ".manual-gate";
export const DONE_TAG_MARKER = ".done-tag-detected";
export const REINJECT_WARNED_MARKER = ".reinject-warned";
// 同一 DO 阶段被 idle 催促（无工具调用）达到此上限后，driver 停止自动驱动并
// 把控制权交给用户（用户可 /ralphflow-continue 确认完成进入验证）。
export const MAX_DO_REINJECT = 5;
const MAX_STEP_RECORDS = 1000;
export const MAX_NESTING_DEPTH = 5;
export const MAX_VOTERS = 5;
export const VOTING_PROGRESS_FILENAME = ".check-voting-progress.json";
const MAX_WORKFLOW_FILE_SIZE = 1024 * 1024; // 1 MB

const isWin = process.platform === "win32";

export interface Engine extends ReturnType<typeof createEngine> {}

export function createEngine(projectDir: string, platform: Platform) {
  // No in-memory or cross-process lock: every op takes an explicit instId, so
  // there is no shared mutable state to guard, and one plugin process + the
  // per-session turn model serialize instance operations naturally.

  // ─── Atomic File I/O ────────────────────────────────────────────────────────

  function atomicWriteJson(filePath: string, data: unknown): void {
    atomicWriteText(filePath, JSON.stringify(data, null, 2));
  }

  function atomicWriteText(filePath: string, text: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, text);
    try {
      fs.renameSync(tmp, filePath);
    } catch (e: any) {
      // Windows can throw EPERM/EEXIST when renaming over an existing file that
      // is momentarily open (antivirus, indexer). Retry once after a short spin.
      if (isWin && (e.code === "EPERM" || e.code === "EEXIST" || e.code === "EACCES")) {
        try { fs.unlinkSync(filePath); } catch {}
        fs.renameSync(tmp, filePath);
      } else {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
    }
  }

  // ─── Instance Infrastructure ────────────────────────────────────────────────

  function getRalphFlowDir(): string {
    return path.join(projectDir, RALPH_FLOW_DIR);
  }

  // Diagnostic sink. The Claude version writes these to console.error, which is
  // harmless there (a separate MCP-server process — Claude Code captures its
  // stderr). In opencode the plugin runs IN the TUI process, so ANY console
  // output corrupts the display. Route everything to a file instead. (Every
  // user-facing problem is already surfaced through the `problems` array /
  // tool responses, so nothing important is hidden by this.)
  function diag(...args: unknown[]): void {
    try {
      const dir = path.join(getRalphFlowDir(), "logs");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "plugin-diag.log"),
        `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}\n`
      );
    } catch {}
  }

  function getInstancesRoot(): string {
    return path.join(getRalphFlowDir(), INSTANCES_DIRNAME);
  }

  function getReportsDir(): string {
    return path.join(getRalphFlowDir(), REPORTS_DIRNAME);
  }

  // Per-instance artifacts directory. Lives OUTSIDE instances/<id>/ because the
  // instance dir is deleted on completion/cancel (destroyInstance) — artifacts
  // are workflow deliverables that must survive the workflow and stay isolated
  // between parallel instances.
  const ARTIFACTS_DIRNAME = "artifacts";
  const ARTIFACTS_NAME_FILENAME = "artifacts-dir";

  /** Final report file path for an instance (may not exist). */
  function getReportPath(instId: string): string {
    return path.join(getReportsDir(), `${instId}-final-report.md`);
  }

  /** Whether a final report exists for the instance. */
  function reportExists(instId: string): boolean {
    try { return fs.statSync(getReportPath(instId)).isFile(); } catch { return false; }
  }

  // OpenSpec-style human-readable dir name: short task summary + instance-id
  // suffix so parallel instances of the same task never collide.
  function makeArtifactsDirName(task: string, instId: string): string {
    // Truncate by code point (Array.from), not UTF-16 unit: a plain slice() can
    // cut an emoji in half, leaving a lone surrogate that round-trips through
    // the utf-8 name file as U+FFFD — the prompt and the file would then name
    // two different directories. Dash-trim runs after the cut for the same
    // reason (the cut itself can expose a trailing dash).
    const slug = Array.from(
      String(task || "").trim()
        .replace(/\s+/g, "-")
        .replace(/[\\/:*?"'`<>|.$&(){}[\];!#~^]/g, "")
    ).slice(0, 30).join("").replace(/^-+|-+$/g, "");
    // Windows 保留设备名（CON/PRN/NUL/COM1…）作目录名会命中设备而非目录
    const safeSlug = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug) ? `${slug}-dir` : slug;
    const suffix = String(instId).split("-").pop() || "0";
    return safeSlug ? `${safeSlug}-${suffix}` : String(instId);
  }

  // The name is fixed at workflow start and read back from the instance dir —
  // sub-workflow pushes rewrite state.json (including user_task), so the name
  // cannot be re-derived from state later.
  function writeArtifactsDirName(instId: string, task: string): void {
    atomicWriteText(instPath(ARTIFACTS_NAME_FILENAME, instId), makeArtifactsDirName(task, instId));
  }

  function getArtifactsDirName(instId: string): string {
    try {
      const v = stripBom(fs.readFileSync(instPath(ARTIFACTS_NAME_FILENAME, instId), "utf-8")).trim();
      // A hand-edited name file must not be able to walk out of the artifacts
      // root (this path is joined and later mkdir'd/rmdir'd).
      if (v && !v.includes("/") && !v.includes("\\") && !v.includes("..")) return v;
    } catch {}
    return reqInst(instId);
  }

  function getArtifactsDir(instId: string): string {
    return path.join(getRalphFlowDir(), ARTIFACTS_DIRNAME, getArtifactsDirName(instId));
  }

  // Project-relative form with forward slashes, embeddable in DO/CHECK prompts
  // (both the session and the adversarial checker run with cwd = projectDir).
  function getArtifactsRelDir(instId: string): string {
    return `${RALPH_FLOW_DIR}/${ARTIFACTS_DIRNAME}/${getArtifactsDirName(instId)}`;
  }

  // Internal escape hatch only: {{artifacts_dir}} in step text still resolves,
  // but workflow authors never need it — every DO/CHECK prompt carries a 产出目录
  // section pointing at the same path.
  const ARTIFACTS_TOKEN = "{{artifacts_dir}}";

  function renderStepText(instId: string, text: string): string {
    if (typeof text !== "string" || !text.includes(ARTIFACTS_TOKEN)) return text;
    return text.split(ARTIFACTS_TOKEN).join(getArtifactsRelDir(instId));
  }

  /** 长文本截断（DO/CHECK prompt 的 token 成本控制）；截断处明确标注不藏拙 */
  function truncateText(text: string, max: number): string {
    if (!text || text.length <= max) return text;
    return `${text.slice(0, max)}\n\n…（内容过长已截断，完整内容见工作流定义/任务记录）`;
  }

  // Extra read-access dirs for the adversarial checker, declared explicitly at
  // ralphflow_start for tasks whose source material lives outside the project
  // dir. Stored as an instance file so sub-workflow state pushes can't drop them.
  const EXTRA_DIRS_FILENAME = "extra-dirs";

  function writeExtraDirs(instId: string, dirs: string[]): void {
    if (Array.isArray(dirs) && dirs.length > 0) {
      atomicWriteJson(instPath(EXTRA_DIRS_FILENAME, instId), dirs);
    }
  }

  function readExtraDirs(instId: string): string[] {
    try {
      const v = JSON.parse(stripBom(fs.readFileSync(instPath(EXTRA_DIRS_FILENAME, instId), "utf-8")));
      if (Array.isArray(v)) return v.filter((d) => typeof d === "string");
    } catch {}
    return [];
  }

  function getInstanceDir(instId: string): string {
    return path.join(getInstancesRoot(), instId);
  }

  /** Every instance-scoped helper requires an explicit instId. */
  function reqInst(instId: string): string {
    if (!instId) throw new Error("instId is required");
    return instId;
  }

  function instPath(name: string, instId: string): string {
    return path.join(getInstanceDir(reqInst(instId)), name);
  }

  function isValidInstanceId(id: unknown): id is string {
    return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
  }

  function generateInstanceId(workflowName: string): string {
    const base = String(workflowName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "wf";
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    // 同一秒内并发 start（脚本/双开）会撞 id——撞上就重试，随机段兜底加长
    for (let attempt = 0; attempt < 5; attempt++) {
      const rand = Math.random().toString(36).slice(2, attempt < 3 ? 6 : 10).padEnd(attempt < 3 ? 6 : 10, "0");
      const candidate = `${base}-${ts}-${rand}`;
      try {
        if (!fs.existsSync(getInstanceDir(candidate))) return candidate;
      } catch {
        return candidate;
      }
    }
    return `${base}-${ts}-${Date.now().toString(36)}`;
  }

  /** The owning session id is stored in the instance's state.json. */
  function readOwnerSession(instId: string): string | null {
    const s = readState(instId);
    return s?.session_id || null;
  }

  /** Claim ownership by writing session_id into the state (no-op if gone). */
  function claimOwnership(instId: string, sessionId: string | null): void {
    if (!sessionId) return;
    const s = readState(instId);
    if (!s || !s.active) return;
    if (s.session_id === sessionId) return;
    writeState({ ...s, session_id: sessionId }, instId);
    clearMarker(".orphan-notified", instId);
  }

  // ─── State Management (per instance) ────────────────────────────────────────

  function getStateFile(instId: string): string {
    return instPath(STATE_FILENAME, instId);
  }

  /**
   * A live instance is one whose state.json still exists. Writers below check
   * this before writing so no code path can resurrect a destroyed instance
   * directory (e.g. a cross-session cancel racing an in-flight check).
   */
  function instanceExists(instId: string): boolean {
    try {
      return fs.existsSync(getStateFile(instId));
    } catch {
      return false;
    }
  }

  function isValidState(s: any): s is RalphFlowState {
    return s && typeof s === "object"
      && typeof s.active === "boolean"
      && typeof s.workflow_name === "string" && s.workflow_name.length > 0
      && typeof s.current_step === "string" && s.current_step.length > 0
      && typeof s.current_phase === "string"
      && typeof s.fail_count === "number" && s.fail_count >= 0
      && typeof s.paused === "boolean"
      && (s.pause_reason === undefined || s.pause_reason === null || typeof s.pause_reason === "string");
  }

  function readState(instId: string): RalphFlowState | null {
    try {
      const stateFile = getStateFile(instId);
      if (fs.existsSync(stateFile)) {
        try {
          const parsed = JSON.parse(stripBom(fs.readFileSync(stateFile, "utf-8")));
          if (!isValidState(parsed)) {
            diag("[ralph-flow] State file has invalid schema, backing up");
            try { fs.renameSync(stateFile, stateFile + ".invalid." + Date.now()); } catch {}
            return null;
          }
          return parsed;
        } catch (parseErr: any) {
          // 仅真正的 JSON 语法损坏才改名隔离；瞬时 I/O 错误（权限抖动、NFS
          // stale handle）不该触发「读即改名」把活实例误杀。
          if (parseErr instanceof SyntaxError) {
            diag("[ralph-flow] State file corrupted, backing up:", parseErr.message);
            try { fs.renameSync(stateFile, stateFile + ".corrupted." + Date.now()); } catch {}
          } else {
            diag("[ralph-flow] Transient error reading state:", parseErr.message);
          }
          return null;
        }
      }
    } catch (e: any) {
      diag("[ralph-flow] Error reading state:", e.message);
    }
    return null;
  }

  function writeState(state: RalphFlowState, instId: string): void {
    try {
      const id = reqInst(instId);
      // Preserve the owning session_id when the caller's state object omits it.
      // Pure-logic transitions (sub-workflow entry, check routing) build fresh
      // state objects without session_id; without this they would orphan the
      // instance. An explicit session_id in `state` still wins (ownership claim).
      // Preserve existing session_id only when the caller's state does not
      // mention the key at all. An explicit session_id (even null, to clear
      // ownership) must win — otherwise the comment is lying to callers.
      const session_id = Object.prototype.hasOwnProperty.call(state, "session_id")
        ? state.session_id
        : readState(id)?.session_id;
      atomicWriteJson(getStateFile(id), { ...state, session_id, instance_id: id });
    } catch (e: any) {
      diag("[ralph-flow] Error writing state:", e.message);
    }
  }

  function writeMarker(name: string, content: string, instId: string): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return; // never resurrect a destroyed instance
      atomicWriteText(path.join(getInstanceDir(id), name), content);
    } catch {}
  }

  function clearMarker(name: string, instId: string): void {
    try {
      const marker = instPath(name, instId);
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch {}
  }

  function markerExists(name: string, instId: string): boolean {
    try {
      return fs.existsSync(instPath(name, instId));
    } catch {
      return false;
    }
  }

  function writeManualStepMarker(instId: string): void { writeMarker(MANUAL_STEP_MARKER, "active", instId); }
  function clearManualStepMarker(instId: string): void { clearMarker(MANUAL_STEP_MARKER, instId); }
  function clearManualGate(instId: string): void { clearMarker(MANUAL_GATE_MARKER, instId); }
  // 催促计数归零 = 新一轮 DO 的开始，顺带清掉"已警告过催促上限"的标记，
  // 这样新一轮再次超限时用户还能再看到一次警告（而不是永久静默）。
  function clearReinjectCounter(instId: string): void {
    clearMarker(".do-reinject-count", instId);
    clearMarker(REINJECT_WARNED_MARKER, instId);
  }
  function clearDoPromptCache(instId: string): void { clearMarker(".do-prompt-cache", instId); }
  function clearDoneTagDetected(instId: string): void { clearMarker(DONE_TAG_MARKER, instId); }

  /**
   * 读取当前 DO 阶段的催促计数（driver 写入 .do-reinject-count，格式
   * "stepId:phase count"）。传入 stepId/phase 时校验 key——旧步骤的计数在
   * 新步骤下视为 0（与 driver 的 getReinjectCount 语义一致）。
   */
  function readReinjectCount(instId: string, stepId?: string, phase?: string): number {
    try {
      const content = stripBom(fs.readFileSync(instPath(".do-reinject-count", reqInst(instId)), "utf-8")).trim();
      const [key, count] = content.split(" ");
      if (stepId && phase && key !== `${stepId}:${phase}`) return 0;
      return parseInt(count, 10) || 0;
    } catch {
      return 0;
    }
  }

  function writeDoPromptCache(prompt: string, instId: string): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return;
      atomicWriteText(instPath(".do-prompt-cache", id), prompt);
    } catch {}
  }

  function readDoPromptCache(instId: string): string {
    try {
      return stripBom(fs.readFileSync(instPath(".do-prompt-cache", reqInst(instId)), "utf-8")).trim();
    } catch {
      return "";
    }
  }

  /**
   * The canonical "you are still in DO, here is the task, here is how you finish"
   * nudge. The driver injects it on an idle keep-alive; ralphflow_continue returns
   * it when there is no gate/pause/attach to act on. Those are the same situation
   * — the step isn't done — so they must say the same thing, from one place.
   */
  function buildDoNudge(instId: string, stepId: string): string {
    const cached = readDoPromptCache(instId);
    return `继续执行步骤 \`${stepId}\` 的任务。${cached ? `\n\n${cached}` : ""}\n\n当所有要求满足后，在单独一行输出 \`<promise>done</promise>\`。`;
  }

  /**
   * Set the driver dedup markers after a tool response that already contains
   * the current DO prompt: .last-phase-report suppresses a duplicate full phase
   * report, .post-tool-active suppresses the immediate keep-alive for this turn.
   * Later idles still keep-alive normally.
   */
  function markPromptDelivered(stepId: string, instId: string): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return;
      atomicWriteText(instPath(".last-phase-report", id), `do:${stepId}`);
      atomicWriteText(instPath(".post-tool-active", id), Date.now().toString());
    } catch {}
  }

  // ─── Adversarial-check session file (cross-session cancel support) ──────────
  //
  // 每个验证者一个独立登记文件 `.verifier-<id>.live`（内容=登记时间戳 ms）。
  // 聚合文件（旧 `.adversarial-session`，JSON 数组）只读兼容、不再新写——多票
  // 并行时对同一文件的 read-modify-write 会互相覆盖丢登记，独立文件天然无竞态
  // （voters 在实例互斥锁内运行，登记处绝不能再拿锁）。

  const VERIFIER_LIVE_PREFIX = ".verifier-";
  const VERIFIER_LIVE_SUFFIX = ".live";

  function sanitizeVerifierFileId(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  function verifierLivePath(checkSessionId: string, instId: string): string {
    return path.join(getInstanceDir(instId), `${VERIFIER_LIVE_PREFIX}${sanitizeVerifierFileId(checkSessionId)}${VERIFIER_LIVE_SUFFIX}`);
  }

  function readAdversarialSessions(instId: string): string[] {
    try {
      const id = reqInst(instId);
      const dir = getInstanceDir(id);
      if (!fs.existsSync(dir)) return [];
      const out = new Set<string>();
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(VERIFIER_LIVE_PREFIX) && f.endsWith(VERIFIER_LIVE_SUFFIX)) {
            out.add(f.slice(VERIFIER_LIVE_PREFIX.length, f.length - VERIFIER_LIVE_SUFFIX.length));
          }
        }
      } catch {}
      // 旧聚合格式只读兼容（不再新写）
      try {
        const legacy = path.join(dir, ADVERSARIAL_SESSION_FILENAME);
        if (fs.existsSync(legacy)) {
          const v = stripBom(fs.readFileSync(legacy, "utf-8")).trim();
          if (v) {
            try {
              const parsed = JSON.parse(v);
              if (Array.isArray(parsed)) parsed.forEach((x) => typeof x === "string" && x && out.add(x));
              else if (typeof parsed === "string" && parsed) out.add(parsed);
            } catch {
              out.add(v); // legacy 单值裸 id
            }
          }
        }
      } catch {}
      return [...out];
    } catch {
      return [];
    }
  }

  function writeAdversarialSession(checkSessionId: string, instId: string): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return;
      atomicWriteText(verifierLivePath(checkSessionId, id), String(Date.now()));
    } catch {}
  }

  function removeAdversarialSession(checkSessionId: string, instId: string): void {
    try {
      const id = reqInst(instId);
      // 新格式：删独立 live 文件；旧聚合文件里的条目：尽力清一次（已无并发写入者）
      try { fs.unlinkSync(verifierLivePath(checkSessionId, id)); } catch {}
      try {
        const legacy = instPath(ADVERSARIAL_SESSION_FILENAME, id);
        if (fs.existsSync(legacy)) {
          const raw = stripBom(fs.readFileSync(legacy, "utf-8")).trim();
          if (raw) {
            let next: string[] | null = null;
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) next = parsed.filter((x) => x !== checkSessionId);
              else if (typeof parsed === "string" && parsed === checkSessionId) next = [];
            } catch {
              if (raw === checkSessionId) next = []; // legacy 单值裸 id
            }
            if (next !== null) atomicWriteText(legacy, JSON.stringify(next));
          }
        }
      } catch {}
    } catch {}
  }

  /**
   * 清理孤儿登记：进程在验证进行中被 kill -9 时 finally 不执行，live 文件残留，
   * continue/status 会永远认为「验证进行中」而死等。验证者 id/文件的年龄超过
   * timeout_ms + 宽限（默认 5 分钟）即视为孤儿移除。返回剩余（活）登记数。
   */
  function pruneStaleAdversarialSessions(instId: string, graceMs = 5 * 60_000): number {
    try {
      const id = reqInst(instId);
      const dir = getInstanceDir(id);
      if (!fs.existsSync(dir)) return 0;
      let timeoutMs = DEFAULT_ADVERSARIAL_TIMEOUT_MS;
      try {
        const st = readState(id);
        const wf = st ? loadWorkflow(st.workflow_name) : null;
        if (wf) timeoutMs = getEffectiveAdversarialCheck(id, wf)?.timeout_ms || DEFAULT_ADVERSARIAL_TIMEOUT_MS;
      } catch {}
      const deadline = Date.now() - timeoutMs - graceMs;
      let removed = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(VERIFIER_LIVE_PREFIX) || !f.endsWith(VERIFIER_LIVE_SUFFIX)) continue;
        const full = path.join(dir, f);
        try {
          if (fs.statSync(full).mtimeMs < deadline) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch {}
      }
      // 旧聚合文件：整体 mtime 判断
      try {
        const legacy = path.join(dir, ADVERSARIAL_SESSION_FILENAME);
        if (fs.existsSync(legacy) && fs.statSync(legacy).mtimeMs < deadline) {
          fs.unlinkSync(legacy);
          removed++;
        }
      } catch {}
      if (removed > 0) logEvent(id, "warn", "stale_verifier_pruned", { removed, timeout_ms: timeoutMs });
      return readAdversarialSessions(id).length;
    } catch {
      return 0;
    }
  }

  function clearAdversarialSession(instId: string): void {
    try {
      const id = reqInst(instId);
      const dir = getInstanceDir(id);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(VERIFIER_LIVE_PREFIX) && f.endsWith(VERIFIER_LIVE_SUFFIX)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch {}
          }
        }
      } catch {}
      clearMarker(ADVERSARIAL_SESSION_FILENAME, id);
    } catch {}
  }

  function readAdversarialSession(instId: string): string | null {
    const arr = readAdversarialSessions(instId);
    return arr.length > 0 ? arr[0] : null;
  }

  // ─── Instance listing / resolution ──────────────────────────────────────────

  function listInstances(): InstanceInfo[] {
    const result: InstanceInfo[] = [];
    const root = getInstancesRoot();
    if (!fs.existsSync(root)) return result;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!isValidInstanceId(id)) continue;
      const state = readState(id);
      if (!state || !state.active) continue;
      let lastActivity: Date | null = null;
      try { lastActivity = fs.statSync(getStateFile(id)).mtime; } catch {}
      result.push({
        id,
        state,
        owner: state.session_id || null,
        manualGate: markerExists(MANUAL_GATE_MARKER, id),
        doneTag: markerExists(DONE_TAG_MARKER, id),
        lastActivity,
      });
    }
    return result;
  }

  function instanceStatusLabel(info: InstanceInfo): string {
    const s = info.state;
    if (s.paused) {
      if (s.pause_reason === "max_failures") return "⏸ 已暂停（达到最大失败次数）";
      if (s.pause_reason === "config_error") return "⏸ 已暂停（工作流配置错误）";
      if (s.pause_reason === "check_error") return "⏸ 已暂停（验证未能运行，continue 重新验证）";
      return `⏸ 已暂停（${s.pause_reason || "未知原因"}）`;
    }
    if (s.current_phase === "check") return "🔍 验证中";
    if (info.manualGate) return "⏸ 等待手动审查";
    if (info.doneTag) return "✅ DO 完成，待验证";
    return "🔨 执行中";
  }

  function formatLastActivity(date: Date | null): string {
    if (!date) return "未知";
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  function formatInstanceList(instances: InstanceInfo[], actionHint?: string): string {
    const lines = [`## 工作流实例（${instances.length} 个）`, ""];
    for (const info of instances) {
      const task = (info.state.user_task || "").replace(/\s+/g, " ").slice(0, 60);
      lines.push(`### \`${info.id}\``);
      lines.push(`- **工作流**: ${info.state.workflow_name}`);
      if (task) lines.push(`- **任务**: ${task}${(info.state.user_task || "").length > 60 ? "…" : ""}`);
      lines.push(`- **步骤**: ${info.state.current_step}（${info.state.current_phase}）`);
      lines.push(`- **状态**: ${instanceStatusLabel(info)}`);
      lines.push(`- **属主会话**: ${info.owner ? `\`${info.owner.slice(0, 8)}\`` : "无"}`);
      lines.push(`- **最后活动**: ${formatLastActivity(info.lastActivity)}`);
      lines.push("");
    }
    if (actionHint) lines.push(actionHint);
    return lines.join("\n");
  }

  type Resolution = { ok: true; id: string; attached: boolean } | { ok: false; text: string };

  /**
   * Resolve which instance a tool call from `sessionId` targets.
   * `attached` is true when the call takes over an instance owned by a
   * different (or no) session — the caller uses it to pick attach semantics.
   * There is no liveness probe: opencode can't cheaply tell whether a session
   * is still open, so ownership is advisory and takeover is always allowed
   * (explicitly, or implicitly when a single instance exists).
   */
  function resolveInstance(explicitId: string | null | undefined, sessionId: string | null): Resolution {
    const instances = listInstances();

    // 1. Explicit id (unique prefix allowed).
    if (explicitId) {
      const wanted = String(explicitId).trim();
      const matches = instances.filter((i) => i.id === wanted);
      const prefixMatches = matches.length > 0 ? matches : instances.filter((i) => i.id.startsWith(wanted));
      if (prefixMatches.length === 1) {
        const inst = prefixMatches[0];
        return { ok: true, id: inst.id, attached: inst.owner !== sessionId };
      }
      if (prefixMatches.length === 0) {
        return {
          ok: false,
          text: instances.length === 0
            ? `没有找到实例 "${wanted}"。当前没有活跃的工作流实例。`
            : `没有找到匹配 "${wanted}" 的实例。\n\n${formatInstanceList(instances)}`,
        };
      }
      return { ok: false, text: `前缀 "${wanted}" 匹配到 ${prefixMatches.length} 个实例，请提供更长的前缀：\n\n${formatInstanceList(prefixMatches)}` };
    }

    // 2. An instance already owned by this session.
    if (sessionId) {
      const mine = instances.filter((i) => i.owner === sessionId);
      if (mine.length >= 1) {
        mine.sort((a, b) => (b.lastActivity?.getTime() || 0) - (a.lastActivity?.getTime() || 0));
        return { ok: true, id: mine[0].id, attached: false };
      }
    }

    // 3. No instance owned by this session.
    if (instances.length === 0) {
      return { ok: false, text: "没有活跃的工作流。使用 /ralphflow-start 启动一个。" };
    }
    // Exactly one instance in the project → attach to it.
    if (instances.length === 1) {
      return { ok: true, id: instances[0].id, attached: instances[0].owner !== sessionId };
    }
    return { ok: false, text: formatInstanceList(instances, "存在多个实例，请显式指定要操作的实例：调用工具时传入 `instance: \"<实例ID>\"`（支持唯一前缀）。") };
  }

  /** Claim an instance for a session (writes session_id into its state). */
  function bindInstance(instId: string, sessionId: string | null): void {
    claimOwnership(instId, sessionId);
  }

  // ─── Instance destruction (complete / cancel) ───────────────────────────────

  function archiveReport(instId: string, workflowName: string, status: string, records: StepExecutionRecord[]): string | null {
    try {
      const reportsDir = getReportsDir();
      if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, `${instId}-final-report.md`);
      let artifactsNote = "";
      try {
        const artifactsDir = getArtifactsDir(instId);
        if (fs.readdirSync(artifactsDir).length > 0) {
          artifactsNote = `\n\n产出目录：\`${getArtifactsRelDir(instId)}/\`\n`;
        }
      } catch {}
      // Archive the execution log alongside the report: destroyInstance removes
      // the instance dir right after this returns, and without a copy the whole
      // audit trail (model_source, check verdicts, infra errors) dies with it.
      let logNote = "";
      try {
        const logFile = path.join(getLogDir(instId), "execution.log");
        if (fs.existsSync(logFile)) {
          fs.copyFileSync(logFile, path.join(reportsDir, `${instId}-execution.log`));
          logNote = `\n\n执行日志：\`${RALPH_FLOW_DIR}/${REPORTS_DIRNAME}/${instId}-execution.log\`\n`;
        }
      } catch (e: any) {
        diag("[ralph-flow] Execution log archiving failed:", e.message);
      }
      atomicWriteText(reportPath, buildReportText(workflowName, status, records || []) + artifactsNote + logNote);
      return reportPath;
    } catch (e: any) {
      diag("[ralph-flow] Report generation failed:", e.message);
      return null;
    }
  }

  /**
   * Destroy an instance: abort any running adversarial check, archive the final
   * report, remove the instance directory. Returns the archived report path,
   * or null when archiving failed — in which case NOTHING is deleted and the
   * full scene (state.json, step-records.json, execution.log) survives for a
   * later retry. Callers must treat null as "not destroyed" and surface the
   * failure honestly instead of claiming success.
   */
  function destroyInstance(instId: string, status: string): string | null {
    let workflowName = instId;
    const state = readState(instId);
    if (state) workflowName = state.workflow_name;
    const records = loadStepRecords(instId);
    // Abort a check running in this process.
    try { platform.abortActiveCheck?.(instId); } catch {}
    const reportPath = archiveReport(instId, workflowName, status, records);
    if (!reportPath) {
      // 归档失败 → 拒绝销毁：报告没落地就删目录 = 报告+审计日志（step-records/
      // execution.log）全部丢失且用户零感知。保留完整现场，由调用方置暂停并
      // 如实告知，修复磁盘/权限后重试本操作即可。
      diag("[ralph-flow] destroyInstance aborted: report archiving failed; instance kept intact:", instId);
      return null;
    }
    // Resolve before the instance dir goes away — the artifacts-dir name file
    // lives inside it.
    const artifactsDir = getArtifactsDir(instId);
    // 归档索引：历史第一次成为系统可回答的问题（「以前跑过什么」）。报告正文
    // 留在 reports/ 的 md 里，这里只记一行指针——UI 历史 tab / 检索的数据源。
    // 必须在实例目录删除前解析 artifacts 名（它就住在实例目录里）。
    try {
      const historyFile = path.join(getRalphFlowDir(), "history.jsonl");
      const entry = {
        instId,
        workflow: workflowName,
        task: state?.user_task ?? "",
        status,
        endedAt: new Date().toISOString(),
        reportPath,
        artifactsRelDir: fs.existsSync(artifactsDir) ? getArtifactsRelDir(instId) : undefined,
      } as Record<string, unknown>;
      fs.appendFileSync(historyFile, JSON.stringify(entry) + "\n");
    } catch (e: any) {
      diag("[ralph-flow] History index append failed:", e.message);
    }
    // Delete state.json first: even if the recursive removal partially fails
    // (Windows EBUSY on files still held open), the instance is de-listed and
    // can't act as a ghost.
    try { fs.unlinkSync(getStateFile(instId)); } catch {}
    try {
      fs.rmSync(getInstanceDir(instId), { recursive: true, force: true });
    } catch (e: any) {
      diag("[ralph-flow] Error removing instance dir:", e.message);
    }
    // A workflow that produced nothing leaves no folder behind — rmdir refuses
    // non-empty dirs, so real deliverables always outlive the instance.
    try { fs.rmdirSync(artifactsDir); } catch {}
    return reportPath;
  }

  // ─── Workflow Loader ────────────────────────────────────────────────────────

  function getPluginWorkflowsDir(): string {
    const __filename = fileURLToPath(import.meta.url);
    return path.join(path.dirname(__filename), "..", "workflows");
  }

  function getProjectWorkflowsDir(): string {
    return path.join(getRalphFlowDir(), "workflows");
  }

  // Global user workflows, available across ALL projects and surviving plugin
  // updates (built-ins live inside the managed npm package, which is
  // overwritten on update and not user-editable when installed online). Lives
  // under dsh's own global home (honors $DSH_HOME, default ~/.dsh), so users
  // find it next to their other dsh config — same shape as the opencode
  // plugin's ~/.config/opencode/ralph-flow/workflows, just dsh-rooted.
  function getGlobalConfigHome(): string | null {
    const env = process.env.DSH_HOME;
    if (env && path.isAbsolute(env)) return env;
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (!home) return null;
    return path.join(home, ".dsh");
  }

  function getGlobalWorkflowsDir(): string | null {
    const cfg = getGlobalConfigHome();
    return cfg ? path.join(cfg, RALPH_FLOW_DIR, "workflows") : null;
  }

  function parseWorkflowFile(filePath: string, workflowName: string, problems?: string[]): WorkflowDef | null {
    // Validation failures are collected into `problems` (when provided) so tool
    // responses can tell the user WHY a workflow is unusable.
    const problem = (msg: string) => { if (Array.isArray(problems)) problems.push(msg); };
    const skipStep = (msg: string) => { diag(`[ralph-flow] ${msg}`); problem(msg); };
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_WORKFLOW_FILE_SIZE) {
        diag(`[ralph-flow] Workflow file ${filePath} exceeds ${MAX_WORKFLOW_FILE_SIZE} bytes, skipped`);
        problem(`工作流文件超过 ${MAX_WORKFLOW_FILE_SIZE} 字节上限`);
        return null;
      }
      const content = stripBom(fs.readFileSync(filePath, "utf-8"));
      const parsed: any = yaml.load(content);

      if (!parsed || typeof parsed !== "object") { problem("YAML 内容不是对象"); return null; }
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) { problem("缺少非空的 steps 数组"); return null; }

      const validSteps: StepDef[] = [];
      for (let i = 0; i < parsed.steps.length; i++) {
        const step = parsed.steps[i];
        if (!step || typeof step !== "object") { skipStep(`Step ${i} in ${workflowName}: not an object, skipped`); continue; }
        if (!step.id || typeof step.id !== "string") { skipStep(`Step ${i} in ${workflowName}: missing/invalid 'id', skipped`); continue; }
        if (!step.desc || typeof step.desc !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'desc', skipped`); continue; }
        if (!step.on_pass || typeof step.on_pass !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'on_pass', skipped`); continue; }
        if (!step.on_fail || typeof step.on_fail !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'on_fail', skipped`); continue; }
        if (typeof step.max_fail_count !== "number" || step.max_fail_count < 1) { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'max_fail_count', skipped`); continue; }
        if (step.reset !== undefined && typeof step.reset !== "boolean") { skipStep(`Step "${step.id}" in ${workflowName}: 'reset' must be a boolean, skipped`); continue; }

        // Validate input/output fields (they become the 输入说明/输出要求 sections of the DO/CHECK prompts)
        if (!step.input || typeof step.input !== "string") {
          skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'input' field, skipped`);
          continue;
        }
        if (!step.output || typeof step.output !== "string") {
          skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'output' field, skipped`);
          continue;
        }

        if (step.workflow) {
          if (typeof step.workflow !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: invalid 'workflow', skipped`); continue; }
          validSteps.push(step);
          continue;
        }

        // check 与 check_voting 互斥(§3.4 规则 1):互斥优先于类型检查——即使
        // check 类型错,只要两字段都在就按互斥硬错,不让配置错误被静默 skip 掩盖。
        const hasCheck = step.check !== undefined && step.check !== null;
        const hasVoting = step.check_voting !== undefined && step.check_voting !== null;
        if (hasCheck && hasVoting) {
          problem(`步骤 "${step.id}" 的 'check' 与 'check_voting' 互斥,不能同时写（二选一）`);
          return null;
        }

        // check_voting 校验(§3.4 规则 2):非法 → 硬错。长度 1-MAX_VOTERS(5),用户写几个就几个。
        if (hasVoting) {
          if (!Array.isArray(step.check_voting) || step.check_voting.length === 0) {
            problem(`步骤 "${step.id}" 的 'check_voting' 必须是 1-${MAX_VOTERS} 个验证者的数组`);
            return null;
          }
          if (step.check_voting.length > MAX_VOTERS) {
            problem(`步骤 "${step.id}" 的 'check_voting' 超过上限 ${MAX_VOTERS} 个验证者`);
            return null;
          }
          for (let vi = 0; vi < step.check_voting.length; vi++) {
            const entry = step.check_voting[vi];
            if (!entry || typeof entry !== "object" || typeof entry.check !== "string" || !entry.check.trim()) {
              problem(`步骤 "${step.id}" 的 check_voting[${vi}] 缺少非空的 'check' 字段`);
              return null;
            }
            const em = (entry as any).model;
            if (em !== undefined && em !== null && !resolveCheckModel(em)) {
              problem(`步骤 "${step.id}" 的 check_voting[${vi}] 'model' 格式非法（应为 provider/model 或 {providerID, modelID}）`);
              return null;
            }
            const et = (entry as any).timeout_ms;
            if (et !== undefined && (typeof et !== "number" || et <= 0)) {
              problem(`步骤 "${step.id}" 的 check_voting[${vi}] 'timeout_ms' 必须是正数`);
              return null;
            }
          }
          if (step.check_model !== undefined && step.check_model !== null) {
            problem(`步骤 "${step.id}" 同时写了 'check_voting' 与 'check_model'：check_model 仅单 check 场景生效,此处无意义`);
            return null;
          }
          validSteps.push(step);
          continue;
        }

        if (!step.do || typeof step.do !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'do', skipped`); continue; }
        // 单 check 路径：check 可缺（与 opencode 版一致）——缺则标 no_check 保留，
        // DO 完成后直通 on_pass（driver skipCheck），不静默丢弃步骤。
        if (!hasCheck) {
          validSteps.push({ ...step, no_check: true });
          continue;
        }
        if (typeof step.check !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'check', skipped`); continue; }
        validSteps.push(step);
      }

      if (validSteps.length === 0) { problem("没有任何有效步骤"); return null; }

      // Duplicate step ids make on_pass/on_fail ambiguous (getStep returns the
      // first match, and the id Set silently collapses the rest) — a hard
      // error, not a silent merge.
      const dupIds = [...new Set(validSteps.map((s) => s.id).filter((id, i, arr) => arr.indexOf(id) !== i))];
      if (dupIds.length > 0) {
        problem(`步骤 id 重复：${dupIds.map((id) => `"${id}"`).join("、")}（每个步骤的 id 必须唯一）`);
        return null;
      }

      // Validate on_pass/on_fail references
      const stepIds = new Set(validSteps.map((s) => s.id));
      for (const step of validSteps) {
        if (step.on_pass !== "done" && !stepIds.has(step.on_pass)) {
          diag(`[ralph-flow] Step "${step.id}" on_pass references unknown step "${step.on_pass}"`);
          problem(`步骤 "${step.id}" 的 on_pass 引用了不存在的步骤 "${step.on_pass}"`);
          return null;
        }
        if (!stepIds.has(step.on_fail)) {
          diag(`[ralph-flow] Step "${step.id}" on_fail references unknown step "${step.on_fail}"`);
          problem(`步骤 "${step.id}" 的 on_fail 引用了不存在的步骤 "${step.on_fail}"`);
          return null;
        }
      }

      const auto_reset: boolean = typeof parsed.auto_reset === "boolean" ? parsed.auto_reset : (
        parsed.auto_reset !== undefined ? (problem("'auto_reset' 必须为 boolean（true/false）"), false) : false
      );

      const manual_step: string[] = Array.isArray(parsed.manual_step)
        ? parsed.manual_step.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim())
        : typeof parsed.manual_step === "string"
          ? parsed.manual_step.split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];
      // A typo'd manual_step entry would silently drop a human review gate the
      // user is counting on — the workflow would run fully automated past the
      // point that was supposed to stop for review. Hard error, not a warning.
      const unknownManual = manual_step.filter((id) => !stepIds.has(id));
      if (unknownManual.length > 0) {
        diag(`[ralph-flow] manual_step in ${workflowName} references unknown step(s): ${unknownManual.join(", ")}`);
        problem(`manual_step 引用了不存在的步骤：${unknownManual.map((s) => `"${s}"`).join("、")}`);
        return null;
      }
      // The manual review gate is driven by a step's DO phase (the driver stops
      // when DO completes and waits for approval). Sub-workflow (composite) steps
      // have no DO phase — the idle driver skips them entirely — so marking one
      // manual is silently inert: the gate the user is counting on never fires.
      // Reject it so the mistake surfaces at load time instead of at runtime.
      const compositeStepIds = new Set(validSteps.filter((s) => isSubWorkflowStep(s)).map((s) => s.id));
      const compositeManual = manual_step.filter((id) => compositeStepIds.has(id));
      if (compositeManual.length > 0) {
        diag(`[ralph-flow] manual_step in ${workflowName} references composite/sub-workflow step(s): ${compositeManual.join(", ")}`);
        problem(`manual_step 不能用于子工作流（复合）步骤：${compositeManual.map((s) => `"${s}"`).join("、")}。手动审查门只作用于带 do/check 的最小步骤——若要在子工作流后停下审查，请把 manual_step 标在该子工作流内部最后一个普通步骤上。`);
        return null;
      }

      const adv = parsed.adversarial_check;
      let adversarial_check: AdversarialCheckConfig | undefined = undefined;
      if (adv && typeof adv === "object") {
        // Both formats are native here: string model (Claude Code style) is
        // passed through and resolved by the host; object {providerID, modelID}
        // is the opencode SDK's own shape. The object form requires BOTH ids as
        // non-empty strings — a half-specified object (e.g. modelID only, or a
        // numeric providerID) would otherwise reach the SDK as garbage and
        // surface as an opaque request failure; drop it here and let the
        // linter warn (mirrors how the bare-string form is handled).
        let model: AdversarialCheckConfig["model"] = undefined;
        if (typeof adv.model === "string" && adv.model.trim()) {
          model = adv.model.trim();
        } else if (adv.model && typeof adv.model === "object") {
          const pid = adv.model.providerID;
          const mid = adv.model.modelID;
          if (typeof pid === "string" && pid.trim() && typeof mid === "string" && mid.trim()) {
            model = { providerID: pid.trim(), modelID: mid.trim() };
          }
        }

        const system_prompt = typeof adv.system_prompt === "string" && adv.system_prompt.trim() ? adv.system_prompt.trim() : undefined;
        const agent = typeof adv.agent === "string" && adv.agent.trim() ? adv.agent.trim() : undefined;

        let timeout_ms: number | undefined = undefined;
        if (typeof adv.timeout_ms === "number" && adv.timeout_ms > 0) {
          timeout_ms = Math.min(adv.timeout_ms, 3600000); // Cap at 1 hour
        }
        adversarial_check = { model, agent, system_prompt, timeout_ms };
      }

      return {
        name: workflowName,
        description: parsed.description || validSteps[0].desc || workflowName,
        manual_step,
        steps: validSteps,
        adversarial_check,
        auto_reset,
      };
    } catch (e: any) {
      diag(`[ralph-flow] Error parsing workflow ${filePath}:`, e.message);
      problem(`解析失败：${e.message}`);
      return null;
    }
  }

  function isValidWorkflowName(name: unknown): name is string {
    // Reject names with path separators, traversal sequences, or special chars
    return typeof name === "string" && name.length > 0 && name.length < 100
      && !/[\/\\]/.test(name) && !name.includes("..") && !name.startsWith(".");
  }

  function loadWorkflow(workflowName: string, problems?: string[]): WorkflowDef | null {
    if (!isValidWorkflowName(workflowName)) return null;
    const globalDir = getGlobalWorkflowsDir();
    // Resolution order: project > global user > plugin built-in. A same-named
    // workflow at an earlier tier shadows the later ones.
    const searchPaths = [
      path.join(getProjectWorkflowsDir(), `${workflowName}.yaml`),
      path.join(getProjectWorkflowsDir(), `${workflowName}.yml`),
      ...(globalDir ? [
        path.join(globalDir, `${workflowName}.yaml`),
        path.join(globalDir, `${workflowName}.yml`),
      ] : []),
      path.join(getPluginWorkflowsDir(), `${workflowName}.yaml`),
      path.join(getPluginWorkflowsDir(), `${workflowName}.yml`),
    ];
    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        const result = parseWorkflowFile(p, workflowName, problems);
        if (result) return result;
      }
    }
    return null;
  }

  function listWorkflows(): Array<{ name: string; desc: string; invalid?: boolean }> {
    const workflows = new Map<string, { name: string; desc: string; invalid?: boolean }>();
    const scanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith(".yaml") || file.endsWith(".yml")) {
            try {
              const filePath = path.join(dir, file);
              const stats = fs.statSync(filePath);
              if (stats.size > MAX_WORKFLOW_FILE_SIZE) {
                diag(`[ralph-flow] Workflow file ${filePath} exceeds ${MAX_WORKFLOW_FILE_SIZE} bytes, skipped`);
                continue;
              }
              const content = stripBom(fs.readFileSync(filePath, "utf-8"));
              const parsed: any = yaml.load(content);
              // Not workflow-shaped at all (stray yaml) — skip silently, as before.
              if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.steps) || parsed.steps.length === 0) continue;
              const name = file.replace(/\.(yaml|yml)$/, "");
              // Run the FULL validation so the list agrees with what
              // ralphflow_start will accept — a file that fails loadWorkflow must
              // not be listed as launchable, it gets flagged instead.
              const problems: string[] = [];
              const wf = parseWorkflowFile(filePath, name, problems);
              const existing = workflows.get(name);
              if (wf) {
                // First valid candidate in resolution order wins; a valid later
                // candidate replaces an invalid earlier one — loadWorkflow falls
                // through invalid files the same way.
                if (!existing || existing.invalid) {
                  workflows.set(name, { name, desc: wf.description });
                }
              } else if (!existing) {
                workflows.set(name, {
                  name,
                  desc: `⚠️ 定义无效，无法启动：${problems[0] || "解析失败"}`,
                  invalid: true,
                });
              }
            } catch (e: any) {
              diag(`[ralph-flow] Error reading workflow ${file}:`, e.message);
            }
          }
        }
      } catch (e: any) {
        diag(`[ralph-flow] Error scanning dir ${dir}:`, e.message);
      }
    };
    // Scan project → global → plugin — the first VALID writer wins, so a valid
    // project workflow shadows a same-named global one which shadows a built-in,
    // while an invalid one falls through. Matches loadWorkflow's resolution
    // order exactly, so list and execution agree.
    scanDir(getProjectWorkflowsDir());
    const globalDir = getGlobalWorkflowsDir();
    if (globalDir) scanDir(globalDir);
    scanDir(getPluginWorkflowsDir());
    return Array.from(workflows.values());
  }

  // ─── Workflow Doctor ────────────────────────────────────────────────────────
  //
  // Deep diagnosis behind the ralphflow_doctor tool. Reuses parseWorkflowFile so
  // its verdicts always agree with what ralphflow_start actually accepts, then
  // layers lints for problems the engine only surfaces at runtime (or never).

  /**
   * Lint a workflow that already passed full validation. Returns human-readable
   * warning strings — things that won't stop ralphflow_start but will bite later.
   * `rawParsed` is the untouched yaml.load result (parseWorkflowFile drops fields
   * the lints need to see).
   */
  function lintWorkflow(wf: WorkflowDef, rawParsed: any, fromBuiltin = false): string[] {
    const warnings: string[] = [];

    // Unreachable steps: execution enters at steps[0] and only moves along
    // on_pass/on_fail edges, so anything outside that closure never runs.
    const byId = new Map(wf.steps.map((s) => [s.id, s]));
    const reachable = new Set<string>();
    const queue = [wf.steps[0].id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const s = byId.get(id);
      if (!s) continue;
      if (s.on_pass !== "done") queue.push(s.on_pass);
      queue.push(s.on_fail);
    }
    const unreachable = wf.steps.filter((s) => !reachable.has(s.id)).map((s) => s.id);
    if (unreachable.length > 0) {
      warnings.push(`步骤 ${unreachable.map((s) => `"${s}"`).join("、")} 从入口（steps 的第一项）沿 on_pass/on_fail 不可达，永远不会执行`);
    }

    // A workflow none of whose reachable steps can reach "done" never finishes.
    if (!wf.steps.some((s) => reachable.has(s.id) && s.on_pass === "done")) {
      warnings.push(`没有任何可达步骤的 on_pass 为 "done"，工作流永远无法正常完成`);
    }

    // Template tokens: the engine resolves exactly one token, {{artifacts_dir}}
    // (byte-exact — even extra spaces inside the braces break it). Anything else
    // reaches the DO/CHECK prompt unresolved.
    for (const s of wf.steps) {
      for (const field of ["desc", "do", "check", "input", "output"] as const) {
        const text = (s as any)[field];
        if (typeof text !== "string") continue;
        for (const m of text.matchAll(/\{\{[^{}]*\}\}/g)) {
          if (m[0] !== ARTIFACTS_TOKEN) {
            warnings.push(`步骤 "${s.id}" 的 ${field} 含模板变量 ${m[0]}，引擎不会解析（唯一支持的记号是 ${ARTIFACTS_TOKEN}，花括号内不能有空格；产出目录本就会自动注入到提示词，通常不需要任何记号）`);
          }
        }
      }
    }

    // Sub-workflow references resolve lazily at runtime — a broken one passes
    // validation and then fails the workflow mid-run.
    for (const s of wf.steps) {
      if (!isSubWorkflowStep(s)) continue;
      const subProblems: string[] = [];
      if (!loadWorkflow(s.workflow, subProblems)) {
        warnings.push(`步骤 "${s.id}" 引用的子工作流 "${s.workflow}" 无法加载（${subProblems[0] || "未找到定义文件"}）— 校验能通过，但运行到该步时工作流会失败`);
      }
    }
    const cycle = findSubWorkflowCycle(wf.name);
    if (cycle) {
      warnings.push(`子工作流引用成环：${cycle.join(" → ")}。运行时会在嵌套深度 ${MAX_NESTING_DEPTH} 处报错暂停`);
    }

    // adversarial_check fields the opencode engine clamps.
    const adv = rawParsed && typeof rawParsed === "object" ? rawParsed.adversarial_check : undefined;
    if (adv && typeof adv === "object") {
      if (typeof adv.timeout_ms === "number" && adv.timeout_ms > 3600000) {
        warnings.push(`adversarial_check.timeout_ms（${adv.timeout_ms}）超过 1 小时上限，会被截断为 3600000`);
      }
      if (typeof adv.model === "string" && adv.model.includes("/") === false && adv.model.trim()) {
        warnings.push(`adversarial_check.model 是字符串（"${adv.model}"）——opencode 需要能被解析的模型标识（如 "anthropic/claude-sonnet-4-5" 或对象 {providerID, modelID}），无法解析时将回退到 ralph-check agent 的默认模型`);
      }
      if (adv.model && typeof adv.model === "object") {
        const pidOk = typeof adv.model.providerID === "string" && adv.model.providerID.trim();
        const midOk = typeof adv.model.modelID === "string" && adv.model.modelID.trim();
        if (!pidOk || !midOk) {
          const missing = !pidOk && !midOk ? "providerID 和 modelID" : !pidOk ? "providerID" : "modelID";
          warnings.push(`adversarial_check.model 是对象但缺少有效的 ${missing}（需要 {providerID, modelID} 两个非空字符串）——该配置被忽略，回退到 ralph-check agent 的默认模型`);
        }
      }
    }

    // check_voting 条目的 lint(设计 §3.5;硬错误已在 parseWorkflowFile 拦截,
    // 这里只报已通过校验但仍可优化的配置)。
    if (rawParsed && typeof rawParsed === "object" && Array.isArray(rawParsed.steps)) {
      for (const s of rawParsed.steps) {
        if (!s || typeof s !== "object" || !Array.isArray(s.check_voting)) continue;
        const sid = typeof s.id === "string" ? s.id : "(?)";
        if (s.check_voting.length === 1 && !(s.check_voting[0] && s.check_voting[0].model)) {
          warnings.push(`步骤 "${sid}" 的 check_voting 只有 1 个验证者且未指定 model——等同单验证者，建议直接用 check 或配多视角/多模型`);
        }
        if (s.check_voting.length === 1 && s.check) {
          warnings.push(`步骤 "${sid}" 同时写了 check 与 check_voting`);
        }
        if (s.check_model !== undefined && s.check_voting) {
          warnings.push(`步骤 "${sid}" 同时写了 'check_voting' 与 'check_model'：check_model 仅单 check 场景生效`);
        }
        for (let vi = 0; vi < s.check_voting.length; vi++) {
          const entry = s.check_voting[vi];
          if (!entry || typeof entry !== "object") continue;
          if (entry.model && typeof entry.model === "string" && !entry.model.includes("/")) {
            warnings.push(`步骤 "${sid}" 的 check_voting[${vi}].model 是字符串（"${entry.model}"）——无法解析时将回退到 ralph-check agent 的默认模型`);
          }
          if (entry.model && typeof entry.model === "object") {
            const pidOk = typeof entry.model.providerID === "string" && entry.model.providerID.trim();
            const midOk = typeof entry.model.modelID === "string" && entry.model.modelID.trim();
            if (!pidOk || !midOk) {
              warnings.push(`步骤 "${sid}" 的 check_voting[${vi}].model 是对象但缺少有效的 providerID/modelID——该配置被忽略，回退到默认模型`);
            }
          }
        }
      }
    }

    // reset / auto_reset 提示。内置工作流跳过：标 reset 是插件设计决定，
    // 不该对用户显示"成本较高"的警告。
    if (!fromBuiltin && wf.steps.length > 0 && wf.steps[0].reset === true) {
      warnings.push(`首步 "${wf.steps[0].id}" 标了 reset：启动时已是新会话不触发；但进入该步的每次转换都触发——包括失败重试（on_fail 回本步）和后续步骤 on_fail 回首步。单步骤 loop 会频繁重置，token 成本较高`);
    }
    if (!fromBuiltin && wf.auto_reset === true) {
      const allOnFailSelf = wf.steps.every((s) => s.on_fail === s.id);
      if (allOnFailSelf) {
        warnings.push(`auto_reset: true 且所有步骤的 on_fail 都指向自身（纯线性流）——每次失败重试也会换新会话，token 成本较高`);
      }
    }

    return warnings;
  }

  /**
   * DFS through sub-workflow references looking for a cycle starting at `name`.
   * Returns the cycle path (["a", "b", "a"]) or null. `clean` memoizes names
   * proven cycle-free so shared sub-workflows aren't re-walked.
   */
  function findSubWorkflowCycle(name: string, stack: string[] = [], clean = new Set<string>()): string[] | null {
    if (clean.has(name)) return null;
    const idx = stack.indexOf(name);
    if (idx >= 0) return [...stack.slice(idx), name];
    const wf = loadWorkflow(name);
    if (wf) {
      for (const s of wf.steps) {
        if (!isSubWorkflowStep(s)) continue;
        const cycle = findSubWorkflowCycle(s.workflow, [...stack, name], clean);
        if (cycle) return cycle;
      }
    }
    clean.add(name);
    return null;
  }

  interface WorkflowCandidate {
    source: "project" | "global" | "plugin";
    sourceLabel: string;
    file: string;
    filePath: string;
    relPath: string;
    name: string;
    verdict?: "valid" | "invalid" | "stray";
    desc?: string;
    warnings?: string[];
    problems?: string[];
  }

  /**
   * Diagnose every workflow file in all search dirs. Returns per-name entries
   * in loadWorkflow's exact resolution order (project, global user, plugin
   * built-in) so "which file actually runs" is derivable, plus yaml files that
   * aren't workflow-shaped at all.
   */
  function diagnoseWorkflowFiles(): { byName: Map<string, WorkflowCandidate[]>; strays: WorkflowCandidate[] } {
    const globalDir = getGlobalWorkflowsDir();
    const sources = [
      { source: "project" as const, label: "项目自定义", dir: getProjectWorkflowsDir() },
      ...(globalDir ? [{ source: "global" as const, label: "全局用户", dir: globalDir }] : []),
      { source: "plugin" as const, label: "插件内置", dir: getPluginWorkflowsDir() },
    ];
    const byName = new Map<string, WorkflowCandidate[]>(); // name -> candidate[] in resolution order
    const strays: WorkflowCandidate[] = [];                // yaml files that aren't workflow definitions

    for (const { source, label, dir } of sources) {
      if (!fs.existsSync(dir)) continue;
      let files: string[];
      try { files = fs.readdirSync(dir); } catch { continue; }
      // .yaml before .yml within a dir, matching loadWorkflow's searchPaths.
      files = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .sort((a, b) => (a.endsWith(".yaml") ? 0 : 1) - (b.endsWith(".yaml") ? 0 : 1) || a.localeCompare(b));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const name = file.replace(/\.(yaml|yml)$/, "");
        const relPath = source === "project"
          ? `${RALPH_FLOW_DIR}/workflows/${file}`
          : source === "global"
            ? `~/.dsh/${RALPH_FLOW_DIR}/workflows/${file}`
            : `<插件目录>/workflows/${file}`;
        const candidate: WorkflowCandidate = { source, sourceLabel: label, file, filePath, relPath, name };

        try {
          if (fs.statSync(filePath).size > MAX_WORKFLOW_FILE_SIZE) {
            candidate.verdict = "invalid";
            candidate.problems = [`工作流文件超过 ${MAX_WORKFLOW_FILE_SIZE} 字节上限`];
            pushCandidate(byName, candidate);
            continue;
          }
          let rawParsed: any;
          try {
            rawParsed = yaml.load(stripBom(fs.readFileSync(filePath, "utf-8")));
          } catch (e: any) {
            candidate.verdict = "invalid";
            candidate.problems = [`YAML 解析失败：${e.message.split("\n")[0]}`];
            pushCandidate(byName, candidate);
            continue;
          }
          if (!rawParsed || typeof rawParsed !== "object" || !("steps" in rawParsed)) {
            // Not workflow-shaped: probably a stray yaml, but the user may have
            // MEANT it as a workflow — surface it instead of skipping silently.
            candidate.verdict = "stray";
            strays.push(candidate);
            continue;
          }
          const problems: string[] = [];
          const wf = parseWorkflowFile(filePath, name, problems);
          if (wf) {
            candidate.verdict = "valid";
            candidate.desc = wf.description;
            // Soft problems (skipped steps) that didn't invalidate the file are
            // exactly the silent-drop trap — merge them with the lints.
            candidate.warnings = [
              ...problems.map((p) => `${p}（该步骤已被静默丢弃，工作流其余部分照常运行）`),
              ...lintWorkflow(wf, rawParsed, source === "plugin"),
            ];
          } else {
            candidate.verdict = "invalid";
            candidate.problems = problems.length > 0 ? problems : ["解析失败"];
          }
          pushCandidate(byName, candidate);
        } catch (e: any) {
          candidate.verdict = "invalid";
          candidate.problems = [`读取失败：${e.message}`];
          pushCandidate(byName, candidate);
        }
      }
    }
    return { byName, strays };
  }

  function pushCandidate(byName: Map<string, WorkflowCandidate[]>, candidate: WorkflowCandidate): void {
    if (!byName.has(candidate.name)) byName.set(candidate.name, []);
    byName.get(candidate.name)!.push(candidate);
  }

  /** Instance-dir health: state.json missing or corrupt makes an instance invisible to every tool. */
  function diagnoseInstances(): string[] {
    const issues: string[] = [];
    const root = getInstancesRoot();
    if (!fs.existsSync(root)) return issues;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return issues; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateFile = path.join(root, entry.name, "state.json");
      if (!fs.existsSync(stateFile)) {
        // 有隔离备份（.invalid/.corrupted）说明 state 曾被读时改名保护过——
        // 提示用户备份可抢救，绝不能引导「直接删除整个目录」连备份一起销毁。
        let backups: string[] = [];
        try {
          backups = fs.readdirSync(path.join(root, entry.name))
            .filter((f) => f.startsWith("state.json.invalid.") || f.startsWith("state.json.corrupted."));
        } catch {}
        issues.push(backups.length > 0
          ? `实例 \`${entry.name}\` 的 state.json 已被隔离为 ${backups.join("、")} — 实例对所有工具不可见。目录内有最后状态备份可人工抢救；确认无需保留后再删除整个目录`
          : `实例目录 \`instances/${entry.name}/\` 缺少 state.json — 所有工具都看不到它。若是残留目录可直接删除`);
        continue;
      }
      try {
        const parsed = JSON.parse(stripBom(fs.readFileSync(stateFile, "utf-8")));
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      } catch (e: any) {
        issues.push(`实例 \`${entry.name}\` 的 state.json 损坏（${e.message.split("\n")[0]}）— 该实例无法恢复，确认无需保留后可删除整个目录`);
      }
    }
    return issues;
  }

  function buildDoctorReport(): string {
    const { byName, strays } = diagnoseWorkflowFiles();
    const instanceIssues = diagnoseInstances();

    const sections: string[] = [];
    let launchable = 0, withWarnings = 0, broken = 0;
    const detailLines: string[] = [];

    const names = Array.from(byName.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const candidates = byName.get(name)!;
      const effective = candidates.find((c) => c.verdict === "valid") || null;
      const lines = [`### ${name}`];

      if (effective) {
        launchable++;
        const shadowed = candidates.filter((c) => c !== effective);
        let sourceNote = `${effective.relPath}（${effective.sourceLabel}`;
        // A valid candidate LATER in resolution order is shadowed by this one.
        const shadowedValid = shadowed.find((c) => c.verdict === "valid" && candidates.indexOf(c) > candidates.indexOf(effective));
        if (shadowedValid) {
          sourceNote += `，遮蔽了同名${shadowedValid.sourceLabel} ${shadowedValid.relPath}`;
        }
        sourceNote += "）";
        lines.push(`- 生效文件：${sourceNote}`);
        // An invalid candidate EARLIER in resolution order means the user's file
        // is being silently skipped in favor of this one — worth shouting about.
        const brokenBefore = candidates.slice(0, candidates.indexOf(effective)).filter((c) => c.verdict === "invalid");
        for (const b of brokenBefore) {
          broken++;
          lines.push(`- ❌ ${b.relPath} 定义无效，已回退到上面的生效文件（启动的不是你这份！）`);
          for (const p of b.problems || []) lines.push(`  - ${p}`);
        }
        if ((effective.warnings || []).length > 0) {
          withWarnings++;
          lines.push(`- ✅ 可启动，但有 ${effective.warnings!.length} 条警告：`);
          for (const w of effective.warnings!) lines.push(`  - ⚠️ ${w}`);
        } else {
          lines.push(`- ✅ 可启动，无警告`);
        }
        // Invalid candidates AFTER the effective one are harmless (never reached)
        // — mention them only so the user knows the file exists and is dead.
        const deadAfter = candidates.slice(candidates.indexOf(effective) + 1).filter((c) => c.verdict === "invalid");
        for (const d of deadAfter) {
          lines.push(`- ℹ️ ${d.relPath} 定义无效，但已被上面的生效文件遮蔽，不影响使用（问题：${(d.problems || [])[0]}）`);
        }
      } else {
        broken += candidates.length;
        lines.push(`- ❌ 无法启动（没有任何有效定义）`);
        for (const c of candidates) {
          lines.push(`- 文件 ${c.relPath}：`);
          for (const p of c.problems || []) lines.push(`  - ${p}`);
        }
      }
      detailLines.push(lines.join("\n"));
    }

    sections.push(`# Ralph Flow 工作流诊断\n\n## 概览\n\n- 可启动工作流：**${launchable}** 个${withWarnings > 0 ? `（其中 ${withWarnings} 个有警告）` : ""}\n- 有问题的定义文件：**${broken}** 个\n- 非工作流 YAML：**${strays.length}** 个\n- 实例目录异常：**${instanceIssues.length}** 个`);

    if (detailLines.length > 0) {
      sections.push(`## 工作流详情\n\n${detailLines.join("\n\n")}`);
    } else {
      sections.push(`## 工作流详情\n\n三个目录（工作区 ${RALPH_FLOW_DIR}/workflows/、全局 ~/.dsh/${RALPH_FLOW_DIR}/workflows/、插件内置 workflows/）里都没有找到自定义工作流定义文件。内置的 \`loop\`、\`spec\` 开箱即用；要自定义，可复制插件内置 workflows/*.yaml 为模板，改好后放到上述任一目录。`);
    }

    if (strays.length > 0) {
      sections.push(`## 被忽略的 YAML 文件\n\n以下文件不是工作流定义（缺少 steps 数组），list/start 都会忽略它们。若本意是工作流，需要补上 steps：\n\n${strays.map((s) => `- ${s.relPath}`).join("\n")}`);
    }

    if (instanceIssues.length > 0) {
      sections.push(`## 实例目录异常\n\n${instanceIssues.map((i) => `- ⚠️ ${i}`).join("\n")}`);
    }

    const projectDirExists = fs.existsSync(getProjectWorkflowsDir());
    const hasProjectWorkflow = names.some((n) => byName.get(n)!.some((c) => c.source === "project"));
    const hasGlobalWorkflow = names.some((n) => byName.get(n)!.some((c) => c.source === "global"));
    if (!hasProjectWorkflow && !hasGlobalWorkflow) {
      const dirNote = projectDirExists ? "" : `（\`${RALPH_FLOW_DIR}/workflows/\` 目录尚未创建）`;
      sections.push(`## 提示\n\n还没有自定义工作流${dirNote}。内置工作流开箱即用；要定制自己的流程，可复制内置 workflows/*.yaml 为模板修改，放到工作区 \`${RALPH_FLOW_DIR}/workflows/\`（只对本工作区生效）或全局 \`~/.dsh/${RALPH_FLOW_DIR}/workflows/\`（所有项目可用，且插件更新不会覆盖）。用 /ralphflow-doctor 校验定义。`);
    }

    return sections.join("\n\n");
  }

  // ─── Step Helpers ───────────────────────────────────────────────────────────

  function getStep(workflow: WorkflowDef, stepId: string): StepDef | null {
    return workflow.steps.find((s) => s.id === stepId) || null;
  }

  function buildDoPrompt(instId: string, step: NormalStepDef, userTask?: string, retryContext?: string, retryCount?: number): string {
    const sections: string[] = [];
    const isRetry = retryContext || (retryCount && retryCount > 0);

    if (userTask) sections.push(`## 用户需求\n\n${truncateText(userTask, 4000)}`);
    if (retryContext) sections.push(`## 上次失败原因\n\n${truncateText(retryContext, 4000)}`);
    if (retryCount && retryCount > 0) {
      sections.push(`## 重试信息\n\n这是第 **${retryCount}** 次重试，最大重试次数为 **${step.max_fail_count}** 次。`);
    }
    if (sections.length > 0) sections.push("---");

    try { fs.mkdirSync(getArtifactsDir(instId), { recursive: true }); } catch {}

    sections.push(`## 当前任务

**步骤**：${step.id}
**描述**：${step.desc}

**任务**：${truncateText(renderStepText(instId, step.do), 8000)}

**输入说明**：${truncateText(renderStepText(instId, step.input), 2000)}

**输出要求**：${truncateText(renderStepText(instId, step.output), 2000)}

**产出目录**：\`${getArtifactsRelDir(instId)}/\` — 本工作流的文档产出（清单、方案、报告等）统一放在此目录。步骤中提到的文档文件名（如 summary.md）若未写路径，即指此目录下的文件；明确写了其他路径的除外。`);

    if (isRetry) {
      sections.push(`---

## 执行指令

上次执行未通过，原因见上方。请执行以下操作：

1. **针对上述失败原因进行修复**，不要重复之前未通过的做法
2. 完成实际工作（修改代码、创建文件、执行命令等）
3. 所有任务要求和输出要求都满足后，在回复的**最后一行**单独输出 \`<promise>done</promise>\`

不要只描述你打算怎么做，直接去做。不要在工作未完成时输出 done 标记。`);
    } else {
      sections.push(`---

## 执行指令

请执行上述任务。完成实际工作（修改代码、创建文件、执行命令等），不要只做分析或规划。
${step.no_check ? "\n本步骤没有配置独立验证（no-check），完成后直接进入下一步。\n" : ""}
所有任务要求和输出要求都满足后，在回复的**最后一行**单独输出 \`<promise>done</promise>\`。

如果遇到无法解决的问题，说明具体问题，不要输出 done 标记。`);
    }
    const prompt = sections.join("\n\n");
    // Cache the do prompt: the driver re-injects it in keep-alives and phase reports
    writeDoPromptCache(prompt, instId);
    return prompt;
  }

  function buildCheckPrompt(instId: string, step: NormalStepDef, userTask?: string): string {
    const sections: string[] = [];
    if (userTask) sections.push(`## 用户需求\n\n${truncateText(userTask, 4000)}`);
    sections.push(`## Do 阶段任务

**步骤**：${step.id}
**任务描述**：${truncateText(renderStepText(instId, step.do), 8000)}
**输入**：${truncateText(renderStepText(instId, step.input), 2000)}
**预期输出**：${truncateText(renderStepText(instId, step.output), 2000)}
**产出目录**：\`${getArtifactsRelDir(instId)}/\` — 检查依据中未写路径的文档文件名即指此目录下的文件`);
    if (sections.length > 0) sections.push("---");
    sections.push(`## 检查依据

${truncateText(renderStepText(instId, step.check || ""), 8000)}

---

请基于上述信息，自主探索项目验证任务完成情况。基于你自己的探索结果判断，不要依赖任何外部提供的"实现总结"。

检查完成后输出：
- 通过：先说明通过原因，最后一行输出 \`<promise-check>true</promise-check>\`
- 不通过：先说明失败原因，最后一行输出 \`<promise-check>false</promise-check>\`

标签必须独占最后一行。`);
    return sections.join("\n\n");
  }

  /**
   * 多验证者投票的单票 prompt:共享段(用户需求/DO 任务/产出目录)+ 该票专属
   * 检查依据 + "你是 N 个验证者之一,只查自己视角"约束(设计 §8.4)。
   */
  function buildVotingCheckPrompt(instId: string, step: NormalStepDef, userTask: string | undefined, entry: CheckVotingEntry, index: number, count: number): string {
    const sections: string[] = [];
    if (userTask) sections.push(`## 用户需求\n\n${truncateText(userTask, 4000)}`);
    sections.push(`## Do 阶段任务

**步骤**：${step.id}
**任务描述**：${truncateText(renderStepText(instId, step.do), 8000)}
**输入**：${truncateText(renderStepText(instId, step.input), 2000)}
**预期输出**：${truncateText(renderStepText(instId, step.output), 2000)}
**产出目录**：\`${getArtifactsRelDir(instId)}/\` — 检查依据中未写路径的文档文件名即指此目录下的文件`);
    sections.push(`## 你的检查依据(专属视角)

${truncateText(renderStepText(instId, entry.check), 8000)}`);
    sections.push(`## 你是 ${count} 个验证者之一

- 你**只负责你自己的检查依据**(上方"检查依据"段),不要试图覆盖其他验证者的视角
- 其他验证者正在并行检查其他方面,各有独立会话
- 你的结论不受任何其他验证者影响,也不要等待或引用它们`);
    sections.push(`请基于上述信息,自主探索项目验证任务完成情况。基于你自己的探索结果判断,不要依赖任何外部提供的"实现总结"。

检查完成后输出:
- 通过:先说明通过原因,最后一行输出 \`<promise-check>true</promise-check>\`
- 不通过:先说明失败原因,最后一行输出 \`<promise-check>false</promise-check>\`

标签必须独占最后一行。`);
    return sections.join("\n\n---\n\n");
  }

  function buildSubWorkflowUserTask(instId: string, step: SubWorkflowStepDef, parentUserTask: string): string {
    const parts: string[] = [];
    if (step.inputs && typeof step.inputs === "object" && !Array.isArray(step.inputs)) {
      for (const [key, value] of Object.entries(step.inputs)) {
        parts.push(`${key}: ${renderStepText(instId, String(value))}`);
      }
    }
    if (parentUserTask) {
      if (parts.length > 0) parts.push("");
      parts.push(`原始需求：${parentUserTask}`);
    }
    return parts.join("\n");
  }

  /**
   * Recursively resolve a sub-workflow entry point.
   * If the sub-workflow's first step is itself a sub-workflow, push intermediate states and recurse.
   * Returns { text, error? } where text is the do prompt for the deepest normal step.
   */
  function resolveSubWorkflowEntry(instId: string, subWorkflowName: string, parentUserTask: string, parentStep: SubWorkflowStepDef, maxDepth?: number, retryContext?: string, retryCount?: number): { text: string; error?: boolean } {
    const depth = getStackDepth(instId);
    if (depth >= (maxDepth || MAX_NESTING_DEPTH)) {
      return { text: `嵌套深度超过限制（${depth}/${maxDepth || MAX_NESTING_DEPTH}）。可能存在循环引用。`, error: true };
    }

    const subProblems: string[] = [];
    const subWorkflow = loadWorkflow(subWorkflowName, subProblems);
    if (!subWorkflow) {
      return {
        text: subProblems.length > 0
          ? `子工作流 "${subWorkflowName}" 定义无效：\n${subProblems.map((p) => `- ${p}`).join("\n")}`
          : `子工作流 "${subWorkflowName}" 未找到。`,
        error: true,
      };
    }

    const firstStep = subWorkflow.steps[0];
    if (!firstStep) {
      return { text: `子工作流 "${subWorkflowName}" 没有步骤。`, error: true };
    }

    const subUserTask = buildSubWorkflowUserTask(instId, parentStep, parentUserTask);

    if (isSubWorkflowStep(firstStep)) {
      // Push intermediate state and recurse
      const intermediateState: RalphFlowState = {
        active: true, workflow_name: subWorkflowName, current_step: firstStep.id,
        current_phase: "do", fail_count: 0, user_task: subUserTask, paused: false,
      };
      pushState(intermediateState, instId);
      const result = resolveSubWorkflowEntry(instId, firstStep.workflow, subUserTask, firstStep, maxDepth, retryContext, retryCount);
      if (result.error) {
        popState(instId); // undo the push on error
      }
      return result;
    }

    // Normal first step — write state and return do prompt
    writeState({
      active: true, workflow_name: subWorkflowName, current_step: firstStep.id,
      current_phase: "do", fail_count: 0, user_task: subUserTask, paused: false,
    }, instId);
    // If the sub-workflow's first step is manual, arm the marker for the driver
    if (subWorkflow.manual_step && subWorkflow.manual_step.includes(firstStep.id)) {
      writeManualStepMarker(instId);
    } else {
      clearManualStepMarker(instId);
    }
    recordStepStart(instId, firstStep.id, "do");
    logEvent(instId, "info", "step_start", { step: firstStep.id, phase: "do" });
    return { text: buildDoPrompt(instId, firstStep, subUserTask, retryContext, retryCount) };
  }

  // ─── State Stack (for sub-workflows, per instance) ──────────────────────────

  function getStackFile(instId: string): string {
    return instPath(STACK_FILENAME, instId);
  }

  function pushState(state: RalphFlowState, instId: string): void {
    try {
      const stackFile = getStackFile(instId);
      let stack: RalphFlowState[] = [];
      if (fs.existsSync(stackFile)) {
        try {
          const parsed = JSON.parse(stripBom(fs.readFileSync(stackFile, "utf-8")));
          if (Array.isArray(parsed)) stack = parsed;
          else diag("[ralph-flow] Stack file is not an array, starting fresh");
        } catch (parseErr: any) {
          diag("[ralph-flow] Stack file corrupted, backing up and starting fresh:", parseErr.message);
          try { fs.renameSync(stackFile, stackFile + ".corrupted." + Date.now()); } catch {}
        }
      }
      // 栈帧是父状态的快照，不含运行时所有权（session_id）。session_id 若入帧，
      // 子工作流完成/失败回父时会把「进入子工作流前」的旧 session 写回状态——
      // reset 门换会话（claimOwnership）后所有权被旧值覆盖，实例被已废弃的旧
      // 会话独占，新会话的空闲驱动对非属主实例静默，父工作流无人驱动（表现为
      // "子工作流完成了回不到父工作流"：状态回父了但卡死不动）。
      const frame: RalphFlowState = { ...state };
      delete frame.session_id;
      stack.push(frame);
      atomicWriteJson(stackFile, stack);
    } catch (e: any) {
      diag("[ralph-flow] Error pushing state:", e.message);
    }
  }

  /**
   * popState 的三值结果：null = 栈为空（真正的顶层工作流）；STACK_CORRUPTED =
   * 栈文件存在但已损坏（父帧可能还在，绝不能当作"没有父"处理——否则子工作流
   * 完成时会被误判为顶层完成而销毁实例）。调用方收到哨兵必须暂停并如实告知，
   * 不能走完成/顶层分支。
   */
  type PopStateResult = RalphFlowState | typeof STACK_CORRUPTED | null;

  function popState(instId: string): PopStateResult {
    try {
      const stackFile = getStackFile(instId);
      if (!fs.existsSync(stackFile)) return null;
      let stack: RalphFlowState[];
      try {
        stack = JSON.parse(stripBom(fs.readFileSync(stackFile, "utf-8")));
      } catch (parseErr: any) {
        diag("[ralph-flow] Stack file corrupted, backing up:", parseErr.message);
        try { fs.renameSync(stackFile, stackFile + ".corrupted." + Date.now()); } catch {}
        return STACK_CORRUPTED;
      }
      if (!Array.isArray(stack)) {
        diag("[ralph-flow] Stack file is not an array, backing up");
        try { fs.renameSync(stackFile, stackFile + ".corrupted." + Date.now()); } catch {}
        return STACK_CORRUPTED;
      }
      if (stack.length === 0) return null;
      const parentState = stack.pop()!;
      // 防御：旧版本（修复前）写入的栈文件可能带 session_id，弹出时一并剥离，
      // 保证任何回父路径 writeState({...parentState}) 都不会覆盖当前所有权。
      delete parentState.session_id;
      atomicWriteJson(stackFile, stack);
      return parentState;
    } catch (e: any) {
      diag("[ralph-flow] Error popping state:", e.message);
      return STACK_CORRUPTED;
    }
  }

  function getStackDepth(instId: string): number {
    try {
      const stackFile = getStackFile(instId);
      if (!fs.existsSync(stackFile)) return 0;
      let stack: unknown;
      try {
        stack = JSON.parse(stripBom(fs.readFileSync(stackFile, "utf-8")));
      } catch {
        // 损坏时按最大深度对待：阻止继续嵌套进入子工作流（再 push 会把唯一
        // 的现场证据改名清掉），而不是装作深度为 0 放行。
        return MAX_NESTING_DEPTH;
      }
      return Array.isArray(stack) ? stack.length : MAX_NESTING_DEPTH;
    } catch { return 0; }
  }

  /** 弹出损坏栈帧后的统一处置：暂停 + 如实告知（备份文件名带回提示） */
  function pauseForCorruptedStack(instId: string, state: RalphFlowState, context: string): TransitionResult {
    writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: `子工作流状态栈损坏（${context}）。` }, instId);
    logEvent(instId, "error", "state_stack_corrupted", { context });
    return {
      text: `## ⚠️ 无法安全完成：子工作流状态栈损坏\n\n本实例的子工作流状态栈文件损坏，无法确认是否存在父工作流——为避免误判「顶层完成」把实例连同剩余步骤一起销毁，已暂停并保留现场。\n\n- 备份保留在实例目录内（\`stack.json.corrupted.*\`），可人工抢救。\n- 若确认没有未完成的父工作流：运行 \`/ralphflow-cancel\` 结束；若可能有：修复后运行 \`/ralphflow-continue\`。`,
      paused: true,
    };
  }

  /** Read the whole ancestor-state stack without mutating it (index 0 = outermost parent). */
  function readStateStack(instId: string): RalphFlowState[] {
    try {
      const stackFile = getStackFile(instId);
      if (!fs.existsSync(stackFile)) return [];
      const parsed = JSON.parse(stripBom(fs.readFileSync(stackFile, "utf-8")));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((s): s is RalphFlowState =>
        !!s && typeof s === "object" && typeof (s as RalphFlowState).workflow_name === "string");
    } catch { return []; }
  }

  /**
   * Java-style field-level inheritance for the verifier config along the
   * sub-workflow chain: the current workflow's own adversarial_check wins for
   * every field that is present AND usable; each missing/unusable field falls
   * back to the nearest ancestor that defines it, then to the built-in
   * defaults in check.ts. A sub-workflow that only overrides `model` still
   * inherits its parent's `timeout_ms`, and an unresolvable `model` (bare
   * name, half-specified object) does NOT shadow the parent's valid one.
   */
  function getEffectiveAdversarialCheck(instId: string, workflow: WorkflowDef): AdversarialCheckConfig | undefined {
    // Chain ordered nearest-first: current workflow, then parents innermost → outermost.
    const chain: AdversarialCheckConfig[] = [];
    if (workflow.adversarial_check) chain.push(workflow.adversarial_check);
    const stack = readStateStack(instId);
    for (let i = stack.length - 1; i >= 0; i--) {
      const wf = loadWorkflow(stack[i].workflow_name);
      if (wf?.adversarial_check) chain.push(wf.adversarial_check);
    }
    if (chain.length === 0) return undefined;

    const pick = <T>(valid: (cfg: AdversarialCheckConfig) => T | undefined): T | undefined => {
      for (const cfg of chain) {
        const v = valid(cfg);
        if (v !== undefined) return v;
      }
      return undefined;
    };

    const model = pick((c) => (resolveCheckModel(c.model) ? c.model : undefined));
    const agent = pick((c) => (typeof c.agent === "string" && c.agent.trim() ? c.agent : undefined));
    const system_prompt = pick((c) => (typeof c.system_prompt === "string" && c.system_prompt.trim() ? c.system_prompt : undefined));
    const timeout_ms = pick((c) => (typeof c.timeout_ms === "number" && c.timeout_ms > 0 ? c.timeout_ms : undefined));

    if (model === undefined && agent === undefined && system_prompt === undefined && timeout_ms === undefined) return undefined;
    return { model, agent, system_prompt, timeout_ms };
  }

  // ─── Log Helpers ────────────────────────────────────────────────────────────

  function getLogDir(instId: string): string {
    // Fall back to the global logs dir after the instance dir was destroyed
    // (e.g. a cancel during a check) — never resurrect a deleted dir.
    if (!instId || !fs.existsSync(getInstanceDir(instId))) return path.join(getRalphFlowDir(), "logs");
    return path.join(getInstanceDir(instId), "logs");
  }

  function ensureLogDir(instId: string): void {
    const logDir = getLogDir(instId);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  }

  const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
  const MAX_LOG_ROTATIONS = 3;

  function rotateLogIfNeeded(instId: string): void {
    try {
      const logFile = path.join(getLogDir(instId), "execution.log");
      if (!fs.existsSync(logFile)) return;
      const stats = fs.statSync(logFile);
      if (stats.size < MAX_LOG_SIZE_BYTES) return;
      // Rotate: .3 → delete, .2 → .3, .1 → .2, current → .1
      for (let i = MAX_LOG_ROTATIONS; i >= 1; i--) {
        const older = `${logFile}.${i}`;
        if (i === MAX_LOG_ROTATIONS) { if (fs.existsSync(older)) fs.unlinkSync(older); }
        else { if (fs.existsSync(older)) fs.renameSync(older, `${logFile}.${i + 1}`); }
      }
      fs.renameSync(logFile, `${logFile}.1`);
    } catch (e: any) {
      diag("[ralph-flow] Log rotation failed:", e.message);
    }
  }

  function logEvent(instId: string, level: string, event: string, extra?: Record<string, unknown>): void {
    try {
      ensureLogDir(instId);
      rotateLogIfNeeded(instId);
      const entry = { ts: new Date().toISOString(), level, event, ...extra };
      fs.appendFileSync(path.join(getLogDir(instId), "execution.log"), JSON.stringify(entry) + "\n");
    } catch (e: any) {
      diag(`[ralph-flow] Log failed (${event}):`, e.message);
    }
  }

  /**
   * 从执行日志提取全部 UI 事件帧（按发生顺序）。用途：continue 接管中断实例时
   * 把历史帧重放进新会话——新会话的 chat 里没有任何本实例的卡片（帧都发到了
   * 旧会话），不重放的话用户面对的是文字墙而不是可导航的档案。
   * 保证首条 run-start 帧始终在列（client 折叠器只有它才能建节点）。
   */
  function readUiEventFrames(instId: string, max = 200): { type: string; data: Record<string, unknown> }[] {
    try {
      const logFile = path.join(getLogDir(instId), "execution.log");
      if (!fs.existsSync(logFile)) return [];
      const lines = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
      const frames: { type: string; data: Record<string, unknown> }[] = [];
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          if (typeof e.event !== "string" || !e.event.startsWith("ui_event_tool-ralphflow/")) continue;
          const data: Record<string, unknown> = { ...e };
          delete data.ts; delete data.level; delete data.event;
          frames.push({ type: String(e.event).slice("ui_event_".length), data });
        } catch {}
      }
      if (frames.length <= max) return frames;
      // 截断保底：run-start（建卡必需）+ 最近 max-1 条
      const tail = frames.slice(-(max - 1));
      if (tail.some((f) => f.type === "tool-ralphflow/run-start")) return tail;
      const firstStart = frames.find((f) => f.type === "tool-ralphflow/run-start");
      return firstStart ? [firstStart, ...tail] : tail;
    } catch {
      return [];
    }
  }

  // ─── HTTP 状态通道数据（/ralphflow/instances 的数据源）────────────────────

  /**
   * 全部活跃实例的富状态快照（供 HTTP 路由 / 轮询 UI 消费）。字段刻意对齐
   * client 端 RunSummary/折叠器所需：steps/current/voters/verdicts/gate/
   * lastCheck/stopReason/elapsed。不再走 session.append 后这是唯一实时面。
   */
  function snapshotAllInstances(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const instances = listInstances();
    for (const inst of instances) {
      const st = inst.state;
      const detail: Record<string, unknown> = {
        runId: inst.id,
        workflow: st.workflow_name,
        task: st.user_task,
        current: { step: st.current_step, phase: st.current_phase, failCount: st.fail_count ?? 0 },
        owner: st.session_id ?? null,
        paused: !!st.paused,
        pauseReason: st.pause_reason ?? undefined,
        lastFailureReason: st.last_failure_reason ?? undefined,
        startedAt: inst.lastActivity ? inst.lastActivity.toISOString() : undefined,
        gate: markerExists(MANUAL_GATE_MARKER, inst.id) ? {
          step: st.current_step,
          title: st.current_step,
          reason: st.paused ? (st.pause_reason ?? "") : "审查门",
          taskExcerpt: undefined,
        } : undefined,
      };
      // 工作流步骤全列表（MiniPipeline / 步骤条的数据源）
      try {
        const wf = loadWorkflow(st.workflow_name);
        if (wf) {
          detail.steps = wf.steps.map((s) => ({ id: s.id, desc: s.desc }));
          const gstep = getStep(wf, st.current_step);
          if (gstep && !isSubWorkflowStep(gstep)) {
            detail.gate = markerExists(MANUAL_GATE_MARKER, inst.id)
              ? { step: gstep.id, title: gstep.desc, reason: st.pause_reason ?? "", taskExcerpt: (gstep.do || "").trim().slice(0, 300) }
              : detail.gate;
          }
        }
      } catch {}
      // 验证者活体 + 票（check 相位）
      if (st.current_phase === "check" && !st.paused) {
        try {
          const progress = readVotingProgressFile(inst.id);
          if (progress) {
            detail.voters = progress.entries.length;
            detail.voterProgress = progress.entries.map((e) => ({
              voter: e.index + 1,
              status: e.status,
              model: e.model ?? null,
              check: (e.check || "").slice(0, 80),
              startedAt: e.startedAt,
              reason: e.reason ? e.reason.slice(0, 200) : undefined,
            }));
          } else {
            const wf2 = loadWorkflow(st.workflow_name);
            const step2 = wf2 ? getStep(wf2, st.current_step) : null;
            detail.voters = Array.isArray((step2 as NormalStepDef | undefined)?.check_voting)
              ? (step2 as NormalStepDef).check_voting!.length
              : 1;
          }
        } catch {}
      }
      // 超时终点感：本轮 CHECK 的超时上限与起点（UI 画剩余时间进度条）
      if (st.current_phase === "check" && !st.paused) {
        try {
          const wf = loadWorkflow(st.workflow_name);
          const step = wf ? getStep(wf, st.current_step) : null;
          if (wf && step && !isSubWorkflowStep(step)) {
            const s = step as NormalStepDef;
            let timeoutMs: number | undefined;
            if (Array.isArray(s.check_voting) && s.check_voting.length > 0) {
              timeoutMs = s.check_voting[0]?.timeout_ms ?? getEffectiveAdversarialCheck(inst.id, wf)?.timeout_ms ?? DEFAULT_ADVERSARIAL_TIMEOUT_MS;
            } else {
              timeoutMs = getEffectiveAdversarialCheck(inst.id, wf)?.timeout_ms ?? DEFAULT_ADVERSARIAL_TIMEOUT_MS;
            }
            if (typeof timeoutMs === "number" && timeoutMs > 0) detail.timeoutMs = timeoutMs;
            const checkStart = stepStartTime(inst.id, st.current_step, "check");
            if (checkStart) detail.checkStartedAt = Date.parse(checkStart);
            else if (inst.lastActivity) detail.checkStartedAt = inst.lastActivity.getTime();
          }
        } catch {}
      }
      out.push(detail);
    }
    return out;
  }

  function readVotingProgressFile(instId: string): {
    entries: { index: number; check: string; model: string | null; status: string; startedAt?: number; reason?: string }[];
  } | null {
    try {
      const file = path.join(getInstanceDir(instId), ".check-voting-progress.json");
      if (!fs.existsSync(file)) return null;
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!raw || !Array.isArray(raw.entries)) return null;
      return {
        entries: raw.entries
          .filter((e: any) => e && typeof e === "object")
          .map((e: any) => ({
            index: typeof e.index === "number" ? e.index : 0,
            check: typeof e.check === "string" ? e.check : "",
            model: typeof e.model === "string" ? e.model : null,
            status: typeof e.status === "string" ? e.status : "pending",
            // 票飞行起点（running 时写入）与判定理由——UI「该票已跑 Xs」与详情面板
            ...(typeof e.startedAt === "number" && e.startedAt > 0 ? { startedAt: e.startedAt } : {}),
            ...(typeof e.reason === "string" && e.reason ? { reason: e.reason } : {}),
          })),
      };
    } catch {
      return null;
    }
  }

  /** 归档历史索引（history.jsonl 全量读） */
  function readHistory(limit = 100): Record<string, unknown>[] {
    try {
      const file = path.join(getRalphFlowDir(), "history.jsonl");
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
      const out: Record<string, unknown>[] = [];
      for (const line of lines.slice(-limit)) {
        try { out.push(JSON.parse(line)); } catch {}
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 实例销毁后的终态帧审计落点：追加到归档副本 reports/<instId>-execution.log。
   * 实例目录被 destroyInstance 删除后 logEvent 会兜底写全局 logs——终态帧会
   * 从该实例的归档记录里消失。这里显式补写归档副本，保证报告+终态事件审计
   * 完整（与 destroyInstance 拷贝的日志副本同文件，实现拼接续写）。
   */
  function appendArchivedUiEvent(instId: string, type: string, data: Record<string, unknown>): void {
    try {
      const copy = path.join(getReportsDir(), `${instId}-execution.log`);
      if (!fs.existsSync(copy)) return;
      const entry = { ts: new Date().toISOString(), level: "info", event: `ui_event_${type}`, ...data };
      fs.appendFileSync(copy, JSON.stringify(entry) + "\n");
    } catch {}
  }

  // ─── Step Records Persistence (per instance) ────────────────────────────────

  const STEP_RECORDS_FILENAME = "step-records.json";

  function getStepRecordsFile(instId: string): string {
    return path.join(getLogDir(instId), STEP_RECORDS_FILENAME);
  }

  function loadStepRecords(instId: string): StepExecutionRecord[] {
    try {
      const file = getStepRecordsFile(instId);
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(stripBom(fs.readFileSync(file, "utf-8")));
          if (Array.isArray(parsed)) return parsed;
          diag("[ralph-flow] Step records file is not an array, resetting");
        } catch (parseErr: any) {
          diag("[ralph-flow] Step records file corrupted, backing up:", parseErr.message);
          try { fs.renameSync(file, file + ".corrupted." + Date.now()); } catch {}
        }
      }
    } catch (e: any) {
      diag("[ralph-flow] Error loading step records:", e.message);
    }
    return [];
  }

  function saveStepRecords(instId: string, records: StepExecutionRecord[]): void {
    try {
      ensureLogDir(instId);
      atomicWriteJson(getStepRecordsFile(instId), records);
    } catch (e: any) {
      diag("[ralph-flow] Error saving step records:", e.message);
    }
  }

  // ─── Report Generation ──────────────────────────────────────────────────────

  function formatDuration(startTime: string, endTime: string): string {
    const durationMs = Math.max(0, new Date(endTime).getTime() - new Date(startTime).getTime());
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
  }

  function buildReportText(workflowName: string, status: string, stepRecords: StepExecutionRecord[]): string {
    const totalFailures = stepRecords.reduce((sum, s) => sum + (s.failCount || 0), 0);
    const startTime = stepRecords.length > 0 ? stepRecords[0].startTime : new Date().toISOString();
    const endTime = stepRecords.length > 0 ? stepRecords[stepRecords.length - 1].endTime || new Date().toISOString() : new Date().toISOString();

    const statusCn: Record<string, string> = { completed: "已完成", cancelled: "已取消", paused: "已暂停" };

    const lines = [
      "# 工作流执行报告", "",
      "## 执行摘要", "",
      `- **工作流**: ${workflowName}`,
      `- **状态**: ${statusCn[status] || status}`,
      `- **总步骤数**: ${stepRecords.length}`,
      `- **失败次数**: ${totalFailures}`,
      `- **总耗时**: ${formatDuration(startTime, endTime)}`,
      "", "## 步骤执行情况", "",
    ];

    for (let i = 0; i < stepRecords.length; i++) {
      const step = stepRecords[i];
      const icon = step.status === "passed" ? "✓" : "✗";
      lines.push(`### ${i + 1}. ${step.stepId} (${step.phase}) ${icon}`);
      lines.push(`- 状态：${step.status === "passed" ? "通过" : "失败"}`);
      if (step.failCount > 0) lines.push(`- 失败次数：${step.failCount}`);
      if (step.reason) lines.push(`- ${step.status === "passed" ? "通过原因" : "失败原因"}：${step.reason}`);
      if (step.startTime && step.endTime) lines.push(`- 耗时：${formatDuration(step.startTime, step.endTime)}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  // ─── Check Result Parsing ───────────────────────────────────────────────────

  /**
   * Match the check verdict tag: last line first, then a small tail window.
   * 验证者偶尔在标签后补尾随文字/空行——只认物理最后一行会把实际通过的判定
   * 误读为失败（白烧一整轮 DO 返工）。与 done-detect 的尾部兜底策略对齐，
   * 窗口限制在末尾 4 行内避免正文中间的标签被误匹配。
   */
  function matchCheckTag(responseText: string): RegExpMatchArray | null {
    const lines = responseText.trim().split("\n");
    const tagRe = /<promise-check>\s*(true|false)\s*<\/promise-check>/i;
    const windowStart = Math.max(0, lines.length - 4);
    for (let i = lines.length - 1; i >= windowStart; i--) {
      const m = lines[i].trim().match(tagRe);
      if (m) return m;
    }
    return null;
  }

  function parseCheckResult(responseText: string): boolean {
    const match = matchCheckTag(responseText);
    if (!match) return false;
    return match[1].toLowerCase() === "true";
  }

  function getAdversarialCheckReason(responseText: string): string {
    const lines = responseText.trim().split("\n");
    const tagRe = /<promise-check>\s*(true|false)\s*<\/promise-check>/i;
    // 标签所在行（含）之后的内容不算理由；找不到标签时沿用旧语义去掉末行
    let cut = lines.length - 1;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
      if (tagRe.test(lines[i])) { cut = i; break; }
    }
    const reason = lines.slice(0, cut).join("\n").trim();
    return reason.length > 20000 ? reason.substring(0, 20000) + "..." : reason;
  }

  // ─── Workflow Advancement Logic (shared by done handler) ────────────────────

  function handleCheckPassed(instId: string, state: RalphFlowState, workflow: WorkflowDef, step: StepDef, checkResult: { reason?: string }, skipped = false): TransitionResult {
    // Note: manual steps no longer pause after the check — the manual review gate
    // now sits BEFORE the check (the driver stops the session when the DO phase of
    // a manual step completes; the user's ralphflow_continue call is the approval
    // that starts the check). Once the check passes, the workflow advances.
    // skipped=true 表示该步骤未配置独立验证（no-check 直通）——标题必须如实
    // 标注「跳过对抗性验证」，不能谎称跑过独立 CHECK。
    const passHeader = skipped ? "## 步骤已通过（跳过对抗性验证）" : "## 检查结果：通过 ✓";

    if (step.on_pass === "done") {
      const parentState = popState(instId);
      if (parentState === STACK_CORRUPTED) {
        return pauseForCorruptedStack(instId, { ...state, current_phase: "check" }, `${state.workflow_name}/${state.current_step} 完成时`);
      }
      if (parentState) {
        const parentWorkflow = loadWorkflow(parentState.workflow_name);
        if (parentWorkflow) {
          const parentStep = getStep(parentWorkflow, parentState.current_step);
          if (parentStep) {
            // Sub-workflow completed — advance to parent step's on_pass target
            const grandparentResult = handleCheckPassed(instId,
              { ...parentState, current_phase: "do", fail_count: 0, last_failure_reason: undefined, paused: false, pause_reason: undefined },
              parentWorkflow, parentStep, { reason: `子工作流 "${state.workflow_name}" 已完成。` }
            );
            // Only record parent step's check as passed if transition succeeded and
            // the instance still exists (a completed workflow already destroyed it)
            if (!grandparentResult.paused && !grandparentResult.completed) {
              addStepRecord(instId, parentState.current_step, "check", "passed", parentState.fail_count || 0, `子工作流 "${state.workflow_name}" 已完成。`, parentState.workflow_name);
            }
            logEvent(instId, "info", "sub_workflow_end", { workflow: state.workflow_name, parent_workflow: parentState.workflow_name, parent_step: parentState.current_step });
            return {
              text: `${passHeader}\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n## 子工作流 "${state.workflow_name}" 已完成！\n\n---\n\n${grandparentResult.text}`,
              paused: grandparentResult.paused,
              completed: grandparentResult.completed,
              // Propagate a sub-workflow entry from the recursive advance (e.g.
              // this sub-workflow's completion routed the parent into ANOTHER
              // composite step) so the driver's reset gate sees it.
              enteredCompositeStepId: grandparentResult.enteredCompositeStepId,
            };
          }
        }
        // Parent workflow not found — push parent state back and pause so user can fix and resume
        pushState({ ...parentState, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 加载失败。` }, instId);
        writeState({ ...parentState, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 加载失败。` }, instId);
        logEvent(instId, "warn", "parent_workflow_not_found", { workflow: state.workflow_name, parent_workflow: parentState.workflow_name });
        return {
          text: `${passHeader}\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n子工作流 "${state.workflow_name}" 已完成，但父工作流 "${parentState.workflow_name}" 加载失败。工作流已暂停 — 请修复工作流 YAML 后调用 \`/ralphflow-continue\` 恢复。`,
          paused: true,
        };
      }
      // No parent — this is the top-level workflow, complete it.
      // Archive the report and destroy the instance directory.
      const reportPath = destroyInstance(instId, "completed");
      if (!reportPath) {
        // 报告归档失败时 destroyInstance 已拒绝销毁：实例连同 step-records/
        // execution.log 完整保留。置为专用 archive_failed 暂停（不是 check_error
        // ——那会让 continue 重跑一整轮验证白烧 token），continue 只重试归档。
        writeState({ ...state, paused: true, pause_reason: "archive_failed", last_failure_reason: "最终报告归档失败（磁盘满/权限不足？）。" }, instId);
        logEvent(instId, "error", "complete_archive_failed", { workflow: state.workflow_name });
        return {
          text: `${passHeader}\n\n---\n\n## ⚠️ 工作流已完成，但报告归档失败\n\n所有步骤均已通过，但最终报告写入失败（磁盘满或权限不足）。实例与执行记录已完整保留，本次不视为完成。\n\n👉 排查磁盘/权限后运行 \`/ralphflow-continue\` 重试归档（不会重新验证）；或 \`/ralphflow-cancel\` 放弃归档直接结束。`,
          paused: true,
        };
      }
      logEvent(instId, "info", "workflow_end", { workflow: state.workflow_name });
      return {
        text: `${passHeader}\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n## 🎉 工作流完成！\n\n所有步骤已验证通过，无需再操作。${reportPath ? `\n\n执行报告：${path.relative(projectDir, reportPath)}` : ""}`,
        completed: true,
      };
    }

    const nextStep = getStep(workflow, step.on_pass);
    if (!nextStep) {
      logEvent(instId, "error", "next_step_not_found", { step: state.current_step, on_pass: step.on_pass });
      writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: `下一步 "${step.on_pass}" 在工作流定义中未找到。` }, instId);
      return { text: `${passHeader}\n\n下一步 "${step.on_pass}" 在工作流定义中未找到。\n\n## 工作流已暂停\n\n工作流配置错误。请修复工作流定义，然后调用 \`/ralphflow-continue\` 恢复。`, paused: true };
    }

    if (isSubWorkflowStep(nextStep)) {
      recordStepStart(instId, nextStep.id, "do");
      logEvent(instId, "info", "step_start", { step: nextStep.id, phase: "do" });
      // Write parent's next step state before entering sub-workflow.
      // This ensures the state file reflects the correct parent step after sub-workflow completes
      const nextState = { ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0, last_failure_reason: undefined, paused: false, pause_reason: undefined };
      writeState(nextState, instId);
      pushState({ ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0, paused: false, pause_reason: undefined }, instId);
      const subResult = resolveSubWorkflowEntry(instId, nextStep.workflow, state.user_task, nextStep);
      if (subResult.error) {
        popState(instId);
        writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
        return { text: subResult.text, paused: true };
      }
      return {
        text: `${passHeader}\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n## 进入子工作流：${nextStep.id}\n\n---\n\n${subResult.text}`,
        enteredCompositeStepId: nextStep.id,
      };
    }

    const nextState = { ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0, last_failure_reason: undefined, paused: false, pause_reason: undefined };
    writeState(nextState, instId);
    recordStepStart(instId, nextStep.id, "do");
    logEvent(instId, "info", "step_start", { step: nextStep.id, phase: "do" });
    return {
      text: `${passHeader}\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n下一步：**${nextStep.id}** - ${nextStep.desc}\n\n---\n\n${buildDoPrompt(instId, nextStep, state.user_task)}`,
    };
  }

  function handleCheckFailed(instId: string, state: RalphFlowState, workflow: WorkflowDef, step: StepDef, checkResult: { reason?: string }): TransitionResult {
    const newFailCount = state.fail_count + 1;
    logEvent(instId, "warn", "fail_count_increment", { step: state.current_step, fail_count: newFailCount });

    if (newFailCount >= step.max_fail_count) {
      const parentState = popState(instId);
      if (parentState === STACK_CORRUPTED) {
        return pauseForCorruptedStack(instId, { ...state, fail_count: newFailCount, current_phase: "check" }, `${state.workflow_name}/${state.current_step} 失败达上限时`);
      }
      if (parentState) {
        const parentFailCount = parentState.fail_count + 1;
        // Check if parent step's max_fail_count is exceeded
        const parentWorkflow = loadWorkflow(parentState.workflow_name);
        const parentStep = parentWorkflow ? getStep(parentWorkflow, parentState.current_step) : null;
        if (parentStep && parentFailCount >= parentStep.max_fail_count) {
          // Parent step also exceeded max failures — pause parent workflow
          // Push parent state back to stack so resume/cancel can restore nesting
          pushState({ ...parentState, current_phase: "do", fail_count: parentFailCount, paused: true, pause_reason: "max_failures", last_failure_reason: checkResult.reason }, instId);
          writeState({ ...parentState, current_phase: "do", fail_count: parentFailCount, paused: true, pause_reason: "max_failures", last_failure_reason: checkResult.reason }, instId);
          logEvent(instId, "warn", "workflow_paused", { workflow: parentState.workflow_name, step: parentState.current_step, fail_count: parentFailCount });
          return {
            text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n## 工作流已暂停\n\n子工作流失败且父步骤最大失败次数 (${parentFailCount}/${parentStep.max_fail_count}) 已达。请修复问题，然后调用 \`/ralphflow-continue\` 恢复。`,
            paused: true,
          };
        }
        // Parent step not at max — follow parent's on_fail
        if (!parentWorkflow || !parentStep) {
          // Push parent state back so resume can restore the stack
          pushState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 或步骤 "${parentState.current_step}" 未找到。` }, instId);
          writeState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 或步骤 "${parentState.current_step}" 未找到。` }, instId);
          logEvent(instId, "error", "parent_workflow_or_step_not_found", { workflow: parentState.workflow_name, step: parentState.current_step });
          return {
            text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n父工作流或步骤未找到。工作流已暂停。`,
            paused: true,
          };
        }
        const failStep = getStep(parentWorkflow, parentStep.on_fail);
        if (failStep) {
          if (isSubWorkflowStep(failStep)) {
            recordStepStart(instId, failStep.id, "do");
            logEvent(instId, "info", "step_start", { step: failStep.id, phase: "do" });
            pushState({ ...parentState, current_step: failStep.id, current_phase: "do", fail_count: parentFailCount, last_failure_reason: checkResult.reason }, instId);
            const subResult = resolveSubWorkflowEntry(instId, failStep.workflow, parentState.user_task, failStep, MAX_NESTING_DEPTH, checkResult.reason, parentFailCount);
            if (subResult.error) {
              popState(instId);
              writeState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
              return { text: subResult.text, paused: true };
            }
            return {
              text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n子工作流失败。使用父步骤重试：**${failStep.id}**\n\n---\n\n${subResult.text}`,
              enteredCompositeStepId: failStep.id,
            };
          }
          const retryState = { ...parentState, current_step: failStep.id, current_phase: "do", fail_count: parentFailCount, last_failure_reason: checkResult.reason };
          writeState(retryState, instId);
          recordStepStart(instId, failStep.id, "do");
          logEvent(instId, "info", "step_start", { step: failStep.id, phase: "do" });
          return {
            text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n子工作流失败。使用父步骤重试：**${failStep.id}** - ${failStep.desc}\n\n---\n\n${buildDoPrompt(instId, failStep, parentState.user_task, checkResult.reason, parentFailCount)}`,
          };
        }
        // on_fail step not found — pause, but push parent state back so resume can restore stack
        pushState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父步骤 on_fail "${parentStep.on_fail}" 未找到。` }, instId);
        writeState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父步骤 on_fail "${parentStep.on_fail}" 未找到。` }, instId);
        return {
          text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n父步骤 on_fail "${parentStep.on_fail}" 未找到。工作流已暂停。`,
          paused: true,
        };
      }
      clearManualStepMarker(instId);
      const pausedState = { ...state, fail_count: newFailCount, paused: true, pause_reason: "max_failures", last_failure_reason: checkResult.reason };
      writeState(pausedState, instId);
      logEvent(instId, "warn", "workflow_paused", { workflow: state.workflow_name, step: state.current_step, fail_count: newFailCount });
      return {
        text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n## ⏸ 工作流已暂停 · 🙋 轮到你了\n\n步骤 \`${state.current_step}\` 连续失败已达上限（${newFailCount}/${step.max_fail_count}），停下等你介入：\n\n- 🔧 看上面的失败原因，动手修一修，然后运行 \`/ralphflow-continue\` 重试（失败计数会清零）\n- 🗑️ 或运行 \`/ralphflow-cancel\` 放弃\n\n已完成的工作都保留，模型不会自动继续。`,
        paused: true,
      };
    }

    const failStep = getStep(workflow, step.on_fail);
    if (!failStep) {
      const pausedState = { ...state, fail_count: newFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `失败步骤 "${step.on_fail}" 在工作流定义中未找到。` };
      writeState(pausedState, instId);
      logEvent(instId, "error", "fail_step_not_found", { step: state.current_step, on_fail: step.on_fail });
      return {
        text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n失败步骤 "${step.on_fail}" 在工作流定义中未找到。\n\n---\n\n## 工作流已暂停\n\n工作流配置错误。请修复工作流定义，然后调用 \`/ralphflow-continue\` 恢复。`,
        paused: true,
      };
    }

    if (isSubWorkflowStep(failStep)) {
      recordStepStart(instId, failStep.id, "do");
      logEvent(instId, "info", "step_start", { step: failStep.id, phase: "do" });
      // Always use newFailCount (never reset on routing to different step)
      pushState({ ...state, current_step: failStep.id, current_phase: "do", fail_count: newFailCount, last_failure_reason: checkResult.reason }, instId);
      const subResult = resolveSubWorkflowEntry(instId, failStep.workflow, state.user_task, failStep, MAX_NESTING_DEPTH, checkResult.reason, newFailCount);
      if (subResult.error) {
        popState(instId);
        writeState({ ...state, fail_count: newFailCount, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
        return { text: subResult.text, paused: true };
      }
      return {
        text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n使用子工作流重试：**${failStep.id}**\n\n---\n\n${subResult.text}`,
        enteredCompositeStepId: failStep.id,
      };
    }

    // Always use newFailCount (never reset on routing to different step)
    const retryState = { ...state, current_step: failStep.id, current_phase: "do", fail_count: newFailCount, last_failure_reason: checkResult.reason };
    writeState(retryState, instId);
    recordStepStart(instId, failStep.id, "do");
    logEvent(instId, "info", "step_start", { step: failStep.id, phase: "do" });
    return {
      text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n重试：**${failStep.id}** - ${failStep.desc}\n\n---\n\n${buildDoPrompt(instId, failStep, state.user_task, checkResult.reason, newFailCount)}`,
    };
  }

  // ─── Step Records (per instance, file-backed) ───────────────────────────────

  // Ephemeral start times keyed by instId:stepId:phase (only used to compute a
  // record's duration when addStepRecord fires). Not shared state that any op
  // reads across an await, so no lock is needed.
  const stepStartTimes = new Map<string, string>();

  function recordStepStart(instId: string, stepId: string, phase: string): void {
    stepStartTimes.set(`${instId}:${stepId}:${phase}`, new Date().toISOString());
  }

  /** 读取某步骤某相位的开始时刻（ISO）。进程重启后内存态丢失返回 undefined，
   *  调用方（HTTP 快照）回退到实例 lastActivity。 */
  function stepStartTime(instId: string, stepId: string, phase: string): string | undefined {
    return stepStartTimes.get(`${instId}:${stepId}:${phase}`);
  }

  function addStepRecord(instId: string, stepId: string, phase: string, status: "passed" | "failed", failCount: number, reason?: string, workflowName?: string): void {
    const now = new Date().toISOString();
    const key = `${instId}:${stepId}:${phase}`;
    const startTime = stepStartTimes.get(key) || now;
    stepStartTimes.delete(key);
    const records = loadStepRecords(instId);
    records.push({ stepId, phase, status, failCount: failCount || 0, startTime, endTime: now, reason, workflowName });
    saveStepRecords(instId, records.length > MAX_STEP_RECORDS ? records.slice(-MAX_STEP_RECORDS) : records);
  }

  /**
   * 在 `workflowName` 指定的工作流里，返回历史执行记录中通过独立 CHECK 的
   * 步骤 id 列表（去重、保留插入顺序）。用于 `/ralphflow-rewind`：只能回退
   * 到这些已通过验证的步骤。仅统计 `phase==="check" && status==="passed"`，
   * 且该步骤必须在目标工作流的 steps 中存在。
   *
   * 跨子工作流栈帧同名步骤的隔离：记录带 `workflowName`（2.7.1 起写入）时
   * 要求与目标工作流同名——子工作流里 `build` 的 check-passed 不会让父工作流
   * 从未执行过的同名 `build` 变成可回退目标。无该字段的旧记录回退到仅按
   * stepId 过滤（升级前的历史不丢，代价是旧记录仍可能把同名子步骤算进来）。
   */
  function passedStepIds(instId: string, workflowName: string): string[] {
    const wf = loadWorkflow(workflowName);
    if (!wf) return [];
    const stepIds = new Set(wf.steps.map((s) => s.id));
    const records = loadStepRecords(instId);
    const passed = new Set<string>();
    for (const r of records) {
      if (r.phase !== "check" || r.status !== "passed" || !stepIds.has(r.stepId)) continue;
      if (r.workflowName && r.workflowName !== workflowName) continue;
      passed.add(r.stepId);
    }
    return [...passed];
  }

  // ─── Legacy single-workflow layout migration ────────────────────────────────

  const LEGACY_STATE_FILENAME = "ralph-flow.local.md";

  /** Parse the pre-2.0 markdown-frontmatter state file. */
  function parseLegacyState(content: string): (RalphFlowState & { session_id?: string }) | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const state: any = {
      active: false, workflow_name: "", current_step: "", current_phase: "do",
      fail_count: 0, user_task: "", paused: false,
    };
    let inFailureReason = false;
    let failureReasonLines: string[] = [];
    for (const line of match[1].split(/\r?\n/)) {
      if (inFailureReason) {
        if (line.startsWith("  ")) { failureReasonLines.push(line.substring(2)); continue; }
        state.last_failure_reason = failureReasonLines.join("\n").trim() || undefined;
        inFailureReason = false;
      }
      const [key, ...valueParts] = line.split(":");
      const value = valueParts.join(":").trim();
      switch (key.trim()) {
        case "active": state.active = value === "true"; break;
        case "workflow_name": state.workflow_name = value; break;
        case "current_step": state.current_step = value; break;
        case "current_phase": state.current_phase = value === "check" ? "check" : "do"; break;
        case "fail_count": state.fail_count = parseInt(value) || 0; break;
        case "user_task": state.user_task = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r"); break;
        case "paused": state.paused = value === "true"; break;
        case "session_id": if (value) state.session_id = value; break;
        case "last_failure_reason":
          if (value === "") { inFailureReason = true; failureReasonLines = []; }
          else state.last_failure_reason = value;
          break;
      }
    }
    if (inFailureReason && failureReasonLines.length > 0) {
      state.last_failure_reason = failureReasonLines.join("\n").trim() || undefined;
    }
    return state;
  }

  /**
   * Pre-2.0 plugin versions kept ONE workflow per project directly under
   * .opencode/ralph-flow/ (ralph-flow.local.md + state-stack.json). The current
   * code only scans instances/<id>/, so an interrupted legacy workflow would
   * silently become invisible after an upgrade. Move it into the instances
   * layout at startup. The state-file rename is the atomic claim, so concurrent
   * processes in the same project migrate it exactly once.
   */
  function migrateLegacyInstance(): void {
    try {
      const dir = getRalphFlowDir();
      const legacyState = path.join(dir, LEGACY_STATE_FILENAME);
      if (!fs.existsSync(legacyState)) return;

      let state: (RalphFlowState & { session_id?: string }) | null = null;
      try { state = parseLegacyState(stripBom(fs.readFileSync(legacyState, "utf-8"))); } catch {}
      if (!state || state.active !== true || !state.workflow_name || !state.current_step) {
        // Not a resumable workflow — park it so it is never re-parsed again
        try { fs.renameSync(legacyState, legacyState + ".pre-migration-backup"); } catch {}
        return;
      }

      const instId = generateInstanceId(state.workflow_name);
      const instDir = getInstanceDir(instId);
      fs.mkdirSync(instDir, { recursive: true });

      // Atomic claim: exactly one concurrent process wins this rename
      try {
        fs.renameSync(legacyState, path.join(instDir, LEGACY_STATE_FILENAME + ".migrated"));
      } catch {
        try { fs.rmSync(instDir, { recursive: true, force: true }); } catch {}
        return; // another process already migrated it
      }

      // Write the new-format state; the legacy session_id carries over as the
      // owning session (it may be closed — a new session takes over via continue).
      atomicWriteJson(path.join(instDir, STATE_FILENAME), { ...state, instance_id: instId });
      // Move the sub-workflow stack along (missing is fine).
      try { fs.renameSync(path.join(dir, STACK_FILENAME), path.join(instDir, STACK_FILENAME)); } catch {}

      logEvent(instId, "info", "legacy_instance_migrated", { instance: instId, workflow: state.workflow_name, step: state.current_step, phase: state.current_phase });
      diag(`[ralph-flow] Migrated legacy workflow state to instance ${instId}`);
    } catch (e: any) {
      diag("[ralph-flow] Legacy migration failed:", e.message);
    }
  }

  function ensureProjectWorkflows(): void {
    // Ensure the project AND global user workflow dirs exist as places for the
    // user to drop *custom* workflows. Built-in workflows are intentionally NOT
    // copied into either: loadWorkflow falls back to the plugin dir, so
    // built-ins always resolve to the latest shipped version. Seeding copies
    // would shadow the plugin dir and go stale on plugin updates. The global
    // dir matters most for online installs, where the plugin package itself is
    // a managed, non-editable location.
    for (const dir of [getProjectWorkflowsDir(), getGlobalWorkflowsDir()]) {
      if (!dir) continue;
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (e: any) {
        diag("[ralph-flow] Error initializing workflows dir:", dir, e.message);
      }
    }
  }

  return {
    projectDir,
    // paths
    getRalphFlowDir, getInstancesRoot, getReportsDir, getInstanceDir, instPath,
    getArtifactsDir, getArtifactsRelDir, getPluginWorkflowsDir, getProjectWorkflowsDir,
    getGlobalWorkflowsDir, getGlobalConfigHome,
    // instance infra
    generateInstanceId, isValidInstanceId, instanceExists,
    writeArtifactsDirName, writeExtraDirs, readExtraDirs,
    readOwnerSession, claimOwnership,
    listInstances, resolveInstance, bindInstance, destroyInstance,
    instanceStatusLabel, formatInstanceList, formatLastActivity,
    // state + markers
    readState, writeState, isValidState,
    writeMarker, clearMarker, markerExists,
    writeManualStepMarker, clearManualStepMarker, clearManualGate,
    clearReinjectCounter, readReinjectCount, clearDoPromptCache, clearDoneTagDetected,
    writeDoPromptCache, readDoPromptCache, buildDoNudge, markPromptDelivered,
    writeAdversarialSession, clearAdversarialSession, readAdversarialSession,
    readAdversarialSessions, removeAdversarialSession, pruneStaleAdversarialSessions,
    // workflows
    parseWorkflowFile, loadWorkflow, listWorkflows, lintWorkflow, buildDoctorReport,
    // steps + prompts
    getStep, buildDoPrompt, buildCheckPrompt, buildVotingCheckPrompt, buildSubWorkflowUserTask,
    resolveSubWorkflowEntry, renderStepText,
    // stack
    pushState, popState, getStackDepth, readStateStack,
    getEffectiveAdversarialCheck,
    // logs + records
    logEvent, recordStepStart, stepStartTime, addStepRecord, loadStepRecords, passedStepIds,
    readUiEventFrames, snapshotAllInstances, readHistory, appendArchivedUiEvent,
    // reports
    buildReportText, archiveReport, getReportPath, reportExists,
    // check parsing
    matchCheckTag, parseCheckResult, getAdversarialCheckReason,
    // transitions
    handleCheckPassed, handleCheckFailed,
    shouldResetOnTransition,
    // startup
    migrateLegacyInstance, ensureProjectWorkflows,
  };
}

export function isSubWorkflowStep(step: StepDef): step is SubWorkflowStepDef {
  return "workflow" in step && typeof (step as SubWorkflowStepDef).workflow === "string";
}

/**
 * 判断从 sourceStepId 转换到 targetStepId 时是否应触发上下文重置。
 * 标了 reset 的步骤任何方式进入都触发（含同步骤重试——失败原因经
 * retryContext 文本通道注入，不丢现场）；auto_reset = 全部步骤标 reset。
 */
export function shouldResetOnTransition(workflow: WorkflowDef, sourceStepId: string, targetStepId: string): boolean {
  if (workflow.auto_reset === true) return true;
  const step = workflow.steps.find((s) => s.id === targetStepId);
  return step?.reset === true;
}

/**
 * Resolve the yaml adversarial_check.model field into the SDK's
 * {providerID, modelID} shape. Shared by the engine's inheritance walk
 * (usability test) and check.ts (actual SDK call) so the two can never
 * drift: a model this cannot resolve is treated as absent.
 */
export function resolveCheckModel(model: AdversarialCheckConfig["model"]): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  if (typeof model === "object") {
    if (typeof model.providerID === "string" && model.providerID.trim()
        && typeof model.modelID === "string" && model.modelID.trim()) {
      return { providerID: model.providerID.trim(), modelID: model.modelID.trim() };
    }
    return undefined;
  }
  // String form "provider/model" (Claude Code yaml compatibility); a bare name
  // without provider cannot be resolved here — fall back to the agent default.
  const idx = model.indexOf("/");
  if (idx > 0) return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
  return undefined;
}

/**
 * 验证者模型优先级链(设计 §7):
 * 条目 model(最强) > 步骤 check_model(仅单 check 场景) > effective(workflow+祖先链)
 * 之后的 agent 配置 / owner session / 全局默认由 check.ts 的既有 fallback 链处理。
 */
export function resolveVerifierModel(
  entryModel: AdversarialCheckConfig["model"] | undefined,
  stepModel: AdversarialCheckConfig["model"] | undefined,
  effective: AdversarialCheckConfig | undefined,
): { providerID: string; modelID: string } | undefined {
  return resolveCheckModel(entryModel ?? stepModel ?? effective?.model);
}

// ─── Adversarial check defaults (shared with check.ts) ──────────────────────

export const DEFAULT_ADVERSARIAL_SYSTEM_PROMPT = `你是一个严格、独立的检查者。根据"检查依据"判断 DO 阶段声称完成的工作是否真的完成。

## 铁律

**你不能修改任何文件。无例外。** 你的 \`edit\` 权限已被硬性拒绝。bash 可以跑任意验证命令——命令产生的副作用（临时文件、缓存、构建产物）不算"你修改了文件"；但主动改源码/测试/配置都让本次验证作废。违规即失败，没有"仅此一次"。

## 不要相信 DO 阶段的报告

DO 的实现总结可能不完整、不准确、过于乐观。**你必须独立验证一切**：读真实代码、跑真实命令、看真实输出。无法独立验证的依据项 → 不通过。

## 理性化——这些念头冒出来时

| 脑里冒出的想法 | 现实 |
|---|---|
| "测试挂了，顺手修一下再跑" | 污染证据，本次验证作废 |
| "DO 报告说做完了" | 不信报告。看代码、跑测试，自己判断 |
| "改的是无关文件" | 任何主动改动都让验证不可信 |
| "看着对，应该通过" | 通过必须有执行证据，禁止"看着对" |
| "对结论不确定" | 任何疑问 → 不通过，没有例外 |

## 输出格式(精炼,结构化)

**判定**:最后一行输出标签:
- 通过 → \`<promise-check>true</promise-check>\`
- 不通过 → \`<promise-check>false</promise-check>\`

**证据与原因,每条一行,最多 10 行**,位置前缀按情况选用:
- 具体代码问题:\`[文件:行号] 问题一句话\`
- 模块级问题:\`[模块名] 问题一句话\`
- 架构级/跨文件问题:直接写问题一句话,不加前缀

示例:
- \`[auth.service.ts:47] JWT 密钥硬编码\`
- \`[payment] 与 auth 共享全局可变状态,耦合过高\`
- \`缺少统一错误处理层,各模块异常处理散落\`

不要复述检查依据原文,不要写结论性空话。证据为准。标签独占最后一行。`;

export const DEFAULT_ADVERSARIAL_TIMEOUT_MS = 900_000;

// ─── Verifier permissions: edit hard-deny + bash open + prompt discipline ────
//
// Design choice: we don't gate the verifier's bash with an allow-list. Three
// reasons grounded in how opencode's own built-in "don't touch code" agents are
// configured (see `opencode agent list`):
//
//   1. The `plan` agent — whose job is also "read/think, don't ship code" — uses
//      exactly `edit *: deny` (plus a narrow hole for its scratchpad) and leaves
//      bash fully open. That's opencode's own canonical answer to the same
//      dilemma.
//   2. The `explore` agent doesn't even deny edit — it leans entirely on its
//      system prompt. So "no mutation" doesn't require a bash allow-list to
//      hold; it can be enforced by prompt alone.
//   3. A bash allow-list can't actually prevent mutation anyway: `npm test`
//      (which any sane allow-list must permit) can run arbitrary scripts that
//      rewrite src/. The list gates what the model types directly, not what
//      those commands do. So the "safety" it appears to provide is largely
//      theatrical, while it very really blocks pnpm/bun/mvn/mix/... — the
//      coverage gap that bit ralph-check users in practice.
//
// The hard constraint that actually holds is `edit: deny` — it blocks the
// direct "open file and change it" path the model would take to "helpfully
// fix" failing work. Bash side-effects (test writes, build artifacts) aren't
// the verifier agreeing with itself, so they don't poison the verdict the way
// a direct edit would. Behavioral fidelity we enforce via the system prompt
// (see DEFAULT_ADVERSARIAL_SYSTEM_PROMPT), borrowing persuasion patterns
// (authority / anti-rationalization table / "don't trust the report") from
// superpowers' research — empirically a 33% → 72% compliance lift for
// discipline prompts.


