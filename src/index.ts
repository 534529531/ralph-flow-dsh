/**
 * Ralph Flow for dsh v2 — 插件入口
 *
 * 装配：引擎（native Service） + ralph-check 验证者委派（T1） + 工具/命令 + 会话事件监听。
 * 无客户端、无 HTTP、无 jobs——v0 是对话内完整闭环。
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, boundContextSummary } from "@deepseek-ai/dsh-llm";
import { createEngine, listWorkflowsIn, type Engine, type VerifyRequest } from "./engine.js";
import { createResetSurface } from "./reset.js";
import { runVerifier } from "./verify.js";
import { registerTools, registerCommands } from "./tools.js";

export const name = "ralphflow";
export const inject = ["tools", "commands", "subagents", "agents", "sessions"];

/** 工作区根：RALPHFLOW_WORKSPACE 环境变量 > 进程 cwd（实例按会话工作区放置，见 workspaceOfSession） */
function resolveWorkspace(ctx: Context): string {
  const env = process.env.RALPHFLOW_WORKSPACE;
  if (env && env.trim()) return env.trim();
  return process.cwd();
}

/** 发起会话的工作区（实例资产沉淀的位置）；查不到回落到全局根 */
function workspaceOfSession(ctx: Context, sessionId: string, fallback: string): string {
  try {
    const sessions = ctx.sessions as unknown as { get(id: string): { header?: { cwd?: string } } | undefined };
    const cwd = sessions.get(sessionId)?.header?.cwd;
    if (cwd && cwd.trim()) return cwd;
  } catch {}
  return resolveWorkspace(ctx) || fallback;
}

function lastAssistantText(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const msg = (data as { message?: unknown }).message;
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as { text?: unknown; content?: unknown };
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

export function apply(ctx: Context): void {
  const workspace = resolveWorkspace(ctx);
  const log = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    try {
      const l = ctx.logger as unknown as { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void } | undefined;
      l?.[level]?.(`[ralphflow] ${event}`, data ?? "");
    } catch {}
  };

  const agentOf = (sessionId: string) => {
    try { return (ctx.agents as unknown as { get(id: string): unknown }).get(sessionId) as unknown; } catch { return undefined; }
  };

  /** 同一段文本的重复投递护栏：命令被连按/重试时只处理一次（窗口内去重） */
  const recentDeliveries = new Map<string, number>();
  const DEDUPE_WINDOW_MS = 5000;

  /**
   * 把一条消息投给会话（模型看得到），并让它**对用户可见**。
   *
   * 关键：dsh 客户端按 `source.form` 决定怎么渲染 plugin 注入的 user 消息
   * （`dsh-client-ui-chat` 的 `contextBody`/`contextForm`）：
   *   · 带 `form:"notice"` + `summary` → 渲染为 **notice 行**，summary 是「不用展开就能读」的一行摘要；
   *   · **没有 form** → `case null: return opaque` → 退化成 `OpaqueBody`（不显眼的上下文注入行）。
   * 这正是 dsh 自己的做法：`dsh-agent` 的 modelSwitchNotice 就用
   * `{kind:"plugin", plugin:"model-selection", form:"notice", summary: boundContextSummary(...)}`。
   *
   * 所以：**凡是要让用户看见的播报，都必须带 summary**；不带 summary 的只适合纯内部管道。
   *
   * `opts.dedupe === false`：**引擎自己驱动的投递**（DO / 推进 / 重置告知等）一律不去重。
   * 去重的初衷只是「用户连按同一条命令 / 命令重试时别堆叠指令」；而引擎的每一次投递都对应
   * 一次真实状态迁移，**去重会把真实迁移吞掉** —— 实测：手动 `/ralphflow-reset` 重投的 DO
   * 与几秒前那次同一步的 DO 逐字相同，被去重后模型拿不到任何指令（上下文已被替换成交接稿，
   * 工作流就停在那里）。所以去重只保留给命令指令路径。
   */
  const deliver = (sessionId: string, text: string, summary?: string, opts?: { dedupe?: boolean }): boolean => {
    try {
      const agent = agentOf(sessionId) as { steer?: (m: unknown) => unknown; followup?: (m: unknown) => unknown } | undefined;
      if (!agent) return false;
      // 去重：同会话 + 同文本，5 秒内只投一次（避免用户连按命令造成指令堆叠）。
      // 引擎驱动的投递传 `{dedupe:false}` 跳过（见函数注释：否则会吞掉真实迁移）。
      if (opts?.dedupe !== false) {
        const key = `${sessionId}:${text.length}:${text.slice(0, 120)}`;
        const now = Date.now();
        const last = recentDeliveries.get(key);
        if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true;
        recentDeliveries.set(key, now);
        if (recentDeliveries.size > 200) {
          for (const [k, ts] of recentDeliveries) {
            if (now - ts > DEDUPE_WINDOW_MS) recentDeliveries.delete(k);
          }
        }
      }
      const brief = typeof summary === "string" ? summary.trim() : "";
      const source = brief
        ? { kind: "plugin" as const, plugin: "ralphflow", form: "notice" as const, summary: boundContextSummary(brief) }
        : { kind: "plugin" as const, plugin: "ralphflow" };
      const msg = createUserMessage({ content: [{ type: "text", text }], source });
      // steer：提交给最近一步，空闲驱动器会开新一轮（0.1.x 官方机制）；
      // followup：旧版本兼容兜底。
      if (typeof agent.steer === "function") { agent.steer(msg); return true; }
      if (typeof agent.followup === "function") { agent.followup(msg); return true; }
      return false;
    } catch (e) {
      log("warn", "deliver_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  /**
   * 工作区 → 引擎。**一个工作区一个引擎**——这正是 opencode 版的形状（它的插件是
   * 「每个项目目录一个实例」，见其 `engine.ts:9`）。每个引擎都是**单根**的：根就是发起
   * 会话的工作区，所以列表、历史、doctor、自定义工作流查找天然落在对的地方。
   *
   * 以前是「一个引擎服务所有工作区 + 一个全局实例索引映射 instId→工作区」：引擎的根是
   * dsh 进程的 cwd，而实例资产落在会话工作区，真实 GUI 里两者必然不同（实测 `dsh web`
   * cwd = `/home/yj`，会话工作区 = `/home/yj/ralph-flow-dsh`）——那正是「自定义工作流加载
   * 不到 / 历史列表永远空 / doctor 看不见残留」的同一个根因。
   */
  const engines = new Map<string, Engine>();
  const ports = {
    deliver,
    verify: (req: VerifyRequest) => runVerifier({ ctx }, req),
    // 重置门（步骤级 `reset: true` / 工作流级 `auto_reset: true` / 手动 `/ralphflow-reset`）的载体：
    // 在步骤边界的空闲窗口里整段替换会话可见面。
    // 句柄就是这里已在用的 `ctx.agents`（Agent 的 `runMaintenance` + `session`）与 `ctx.sessions`。
    resetSurface: createResetSurface(ctx, log),
    log,
  };
  /** 由 registerCommands 返回，用于给某个工作区补登记 /ralphflow-<名字> 快捷命令 */
  let registerShortcuts: ((workflows: Array<{ name: string; desc: string }>) => void) | undefined;

  const engineFor = (ws?: string): Engine => {
    const key = ws && ws.trim() ? ws.trim() : workspace;
    let e = engines.get(key);
    if (!e) {
      e = createEngine(key, ports);
      engines.set(key, e);
      // **不在这里建目录**：engineFor 是所有工具（含只读的 list/doctor/status）的入口，
      // 在这里 ensureLayout 会让只读命令在用户从没用过 ralphflow 的项目里创建整棵
      // .dsh/ralph-flow/ 树。目录由**写意图**的操作创建：start（引擎内已调）与
      // create（要往 workflows/ 放文件）。读操作对目录缺失是容错的（readdir 失败即空）。
      // 崩溃/重载恢复：孤儿委派 fail-safe（暂停等用户，不隐式继续）
      try { e.restore(); } catch (err) { log("warn", "restore_failed", { workspace: key, error: String(err) }); }
      try { registerShortcuts?.(listWorkflowsIn(key)); } catch {}
    }
    return e;
  };

  /**
   * 只查**已存在**的引擎：会话事件是高频路径，不能为了它给每个会话凭空建引擎
   * （没有引擎 = 该工作区没有活跃实例，也就没有需要提醒/捕获的东西）。
   */
  const existingEngineFor = (sid: string): Engine | undefined =>
    engines.get(workspaceOfSession(ctx, sid, workspace));

  // 全局会话事件流 → 引擎：**只做上下文捕获**（最近一条助手文本，仅作审查门重交去重的
  // 兜底文本；**不进验证者视野**，T1 说明见 engine.ts 的 lastText 注释）。
  // 交卷检测已不在这里 —— 它由模型调用 ralphflow_submit 工具承担（dsh 原生方式）。
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => (() => void) | void }).on;
    if (typeof on === "function") {
      on("session/event", (s?: unknown, e?: unknown) => {
        const sid = (s as { id?: string } | undefined)?.id;
        if (!sid || !e || typeof e !== "object") return;
        const ev = e as { type?: unknown; data?: unknown };
        if (ev.type !== "assistant/message") return;
        const text = lastAssistantText(ev.data);
        const eng = existingEngineFor(sid);
        if (text && eng) eng.noteAssistantText(sid, text);
      });
    } else {
      log("warn", "session_event_listener_unavailable", {});
    }
  } catch (e) {
    log("warn", "session_event_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // DO 阶段「忘了交卷」兜底：用宿主原生的 agent/turn-stopping（serial、可 await）。
  // 它在回合关闭前发问；我们 steer 一条提醒 → 机器重读 inbox → 再跑一步。
  // 这正是 claude/opencode 版 Stop hook 的原生等价物（design §3 的「驱动器」角色），
  // 但不再依赖对自由文本做正则匹配。
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => unknown }).on;
    if (typeof on === "function") {
      on("agent/turn-stopping", (payload?: unknown) => {
        const sid = (payload as { agent?: { id?: string } } | undefined)?.agent?.id;
        if (!sid) return;
        const eng = existingEngineFor(sid);
        if (!eng) return;
        let verdict: { remind: boolean; message?: string; summary?: string };
        try { verdict = eng.remindToSubmit(sid); } catch (e) {
          log("warn", "turn_stopping_failed", { sessionId: sid, error: e instanceof Error ? e.message : String(e) });
          return;
        }
        // 带 summary 才会渲染成用户可见的 notice 行（否则是 opaque 注入行，用户看不到）
        if (!verdict.message) return;
        if (!verdict.remind) {
          deliver(sid, `[ralphflow] ${verdict.message}`, verdict.summary ?? "⏸ ralphflow 已暂停等你处理");
          return;
        }
        deliver(sid, verdict.message, verdict.summary ?? "⚠️ ralphflow：本步尚未交卷");
      });
    } else {
      log("warn", "turn_stopping_listener_unavailable", {});
    }
  } catch (e) {
    log("warn", "turn_stopping_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  const deps = { ctx, engineFor, deliver, workspaceOfSession: (sid: string) => workspaceOfSession(ctx, sid, workspace) };
  const handlers = registerTools(deps);
  registerShortcuts = registerCommands({ ...deps, handlers });

  // 动态快捷命令：会话一出现就登记**它那个工作区**的自定义工作流（纯读目录，不建引擎）。
  // 引擎是惰性创建的，只靠 engineFor 的话，用户在新工作区第一次打开会话时还没有快捷命令。
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => unknown }).on;
    if (typeof on === "function") {
      on("session/created", (session?: unknown) => {
        const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd;
        if (!cwd || !cwd.trim()) return;
        try { registerShortcuts?.(listWorkflowsIn(cwd.trim())); } catch {}
      });
    }
  } catch (e) {
    log("warn", "session_created_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // 默认工作区的引擎在插件加载时建好（ensureLayout + restore 都在 engineFor 里）
  engineFor(workspace);

  log("info", "plugin_loaded", { workspace, version: "0.1.0" });
}