/**
 * Ralph Flow for dsh v2 — 插件入口
 *
 * 装配：引擎（native Service） + ralph-check 验证者委派（T1） + 工具/命令 + 会话事件监听。
 * 无客户端、无 HTTP、无 jobs——v0 是对话内完整闭环。
 */
import fs from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import type { SessionSeq } from "@deepseek-ai/dsh-session";
import { createUserMessage, boundContextSummary } from "@deepseek-ai/dsh-llm";
import { RALPHFLOW_SOURCE_KIND } from "./message-source.js";
import { createEngine, listWorkflowsIn, type Engine, type VerifyRequest } from "./engine.js";
import { createResetSurface } from "./reset.js";
import { runVerifier } from "./verify.js";
import { registerTools, registerCommands } from "./tools.js";
import { registerSkills, type WorkflowSkillRegistrar } from "./skills.js";

export const name = "ralphflow";
export const inject = ["tools", "commands", "skills", "subagents", "agents", "sessions"];

/**
 * 本包版本 —— 从 `package.json` 读，**绝不硬编码**。
 *
 * 日志里报一个假版本比不报更糟：诊断「进程到底加载的是哪份 lib」时，它是唯一线索
 * （作者实测踩过：改完构建了，但跑着的进程还持旧 `lib/`，而日志写着旧版本号会把人带偏）。
 */
const PLUGIN_VERSION = ((): string => {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v.trim() ? v.trim() : "unknown";
  } catch {
    return "unknown";
  }
})();

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

  /** 宿主会话句柄：notice 载体只需要「可见面 + append」。 */
  interface NoticeSession {
    surface?: { nodes: readonly SessionSeq[] };
    append?: (type: string, data: unknown, opts: unknown) => { seq: number };
  }

  const sessionOf = (sessionId: string, agent: unknown): NoticeSession | undefined => {
    const own = (agent as { session?: unknown } | undefined)?.session;
    if (own && typeof own === "object") return own as NoticeSession;
    try {
      const s = (ctx.sessions as unknown as { get(id: string): unknown }).get(sessionId);
      return s && typeof s === "object" ? (s as NoticeSession) : undefined;
    } catch { return undefined; }
  };

  /**
   * 现在把播报 append 到可见面是否**安全**。
   *
   * 判据 = 可见面尾部工具配对平衡（与 reset 门同一把尺子：`toolPairingBalancedAfter`）。
   * 不平衡 = 有 tool call 还没等到它的 tool result，此刻往尾部插一条 user/message 会把
   * 「assistant(tool_calls) → tool(result)」劈开 —— 下一次请求在多数 provider 上会直接报错。
   * 平衡 = 尾部落在步骤边界上，插一条 user/message 与驱动器自己在边界上 append 收件箱消息
   * 完全同形（`dsh-agent-loop` 的 `step()` 就是 `session.append("user/message", msg, {surfaceOp:"append"})`）。
   */
  const canAppendNoticeNow = (session: NoticeSession | undefined): boolean => {
    if (!session || typeof session.append !== "function") return false;
    const nodes = session.surface?.nodes;
    if (!nodes || nodes.length === 0) return true; // 空可见面：没有可劈开的配对
    try { return toolPairingBalancedAfter(session as never, nodes[nodes.length - 1]!) === true; }
    catch { return false; }
  };

  /**
   * ─── 投递：两个类别的两个载体 ──────────────────────────────────────────────
   *
   * 全仓所有「把消息投进会话」的调用点都必须显式选一类（台账见
   * `docs/v2/delivery-classification.md`，静态审计见 `scripts/delivery-classification-test.mjs`）：
   *   · {@link deliverDirective} **指令** = 要模型干活（DO / 命令转达 / 交卷提醒）→ `agent.steer`；
   *   · {@link deliverNotice} **播报** = 给人看的记录（验证进度、判定、暂停/完成）→ 直接 append。
   *
   * 两类都必须注意 dsh 客户端的渲染契约：客户端按 `source.form` 决定怎么渲染 plugin 注入的
   * user 消息（`dsh-client-ui-chat` 的 `contextBody`/`contextForm`）：
   *   · 带 `form:"notice"` + `summary` → 渲染为 **notice 行**（summary 不展开就能读，用户看得见）；
   *   · **没有 form** → `case null: return opaque` → 退化成 `OpaqueBody`（不显眼的上下文注入行）。
   * 这正是 dsh 自己的做法：`dsh-agent` 的 modelSwitchNotice 就用
   * `{kind:"plugin", plugin:"model-selection", form:"notice", summary: boundContextSummary(...)}`。
   *
   * 所以：**凡是要让用户看见的播报，都必须带 summary**；不带 summary 的只适合纯内部管道。
   * {@link buildMessage} 就是这个 source 的唯一构造点。
   */
  const buildMessage = (text: string, summary?: string): ReturnType<typeof createUserMessage> => {
    const brief = typeof summary === "string" ? summary.trim() : "";
    const source = brief
      ? { kind: RALPHFLOW_SOURCE_KIND, form: "notice" as const, summary: boundContextSummary(brief) }
      : { kind: RALPHFLOW_SOURCE_KIND };
    return createUserMessage({ content: [{ type: "text", text }], source });
  };

  /**
   * 去重护栏（只给**命令指令**路径用；引擎自驱投递传 `dedupe:false` 跳过）。命中返回 true。
   *
   * 为什么引擎必须跳过：去重的初衷只是「用户连按同一条命令 / 命令重试时别堆叠指令」，而引擎的
   * 每一次投递都对应一次真实状态迁移，**去重会把真实迁移吞掉** —— 实测：手动 `/ralphflow-reset`
   * 重投的 DO 与几秒前那次同一步的 DO 逐字相同，被去重后模型拿不到任何指令（上下文已被替换成
   * 交接稿，工作流就停在那里）。
   */
  const deduped = (sessionId: string, text: string, opts?: { dedupe?: boolean }): boolean => {
    if (opts?.dedupe === false) return false;
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
    return false;
  };

  // ─── 播报（notice）的挂起队列 ────────────────────────────────────────────────
  //
  // 唯一可能 append 不了的时刻：可见面尾部工具配对不平衡（有 tool call 在飞）。这时**不能**
  // 退回收件箱 —— 收件箱里躺一条 next-step 消息，正在收尾的回合就会被续上（这正是本次要修的
  // 缺陷）。所以挂起，等尾部落回步骤边界再 append：本会话任何会话事件、任何下一次投递、
  // 以及一个 unref 的兜底定时器都会来试。
  const deferredNotices = new Map<string, unknown[]>();
  let deferredTimer: ReturnType<typeof setTimeout> | undefined;

  const armDeferredTimer = (): void => {
    if (deferredTimer !== undefined) return;
    deferredTimer = setInterval(() => {
      if (deferredNotices.size === 0) {
        if (deferredTimer !== undefined) clearInterval(deferredTimer);
        deferredTimer = undefined;
        return;
      }
      for (const sid of [...deferredNotices.keys()]) flushNotices(sid);
    }, 250);
    // 绝不因为这个兜底定时器拖住进程退出
    (deferredTimer as unknown as { unref?: () => void }).unref?.();
  };

  /**
   * 把本会话挂起的播报按序落成可见面节点（安全时才落）。**绝不进收件箱**。
   */
  const flushNotices = (sessionId: string): void => {
    const queue = deferredNotices.get(sessionId);
    if (!queue || queue.length === 0) return;
    const agent = agentOf(sessionId);
    const session = sessionOf(sessionId, agent);
    if (!agent || !session) {
      deferredNotices.delete(sessionId);
      log("warn", "notice_dropped", { sessionId, reason: "session_gone", count: queue.length });
      return;
    }
    while (queue.length > 0) {
      if (!canAppendNoticeNow(session)) return; // 还在工具调用中间：继续挂起
      try {
        // @delivery notice —— 挂起播报的补齐（与 deliverNotice 同一个载体：直接 append，不唤醒）
        session.append!("user/message", queue[0], { surfaceOp: "append" });
      } catch (e) {
        log("warn", "notice_append_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
        deferredNotices.delete(sessionId);
        return;
      }
      queue.shift();
    }
    deferredNotices.delete(sessionId);
  };

  /** 指令（directive）载体：dsh 的 `steer` —— 空闲开新一轮，运行中在下一个 step 边界取走。 */
  const deliverDirective = (sessionId: string, text: string, summary?: string, opts?: { dedupe?: boolean }): boolean => {
    try {
      const agent = agentOf(sessionId) as { steer: (m: unknown) => unknown } | undefined;
      if (!agent) return false;
      if (deduped(sessionId, text, opts)) return true;
      // 指令不插队：先把本会话挂起的播报落下去（顺序 = 事件真实发生的顺序）
      flushNotices(sessionId);
      // @delivery directive —— 唯一的唤醒载体（dsh 的 steer）
      agent.steer(buildMessage(text, summary));
      return true;
    } catch (e) {
      log("warn", "deliver_directive_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  /**
   * 播报（notice）载体：**直接 append 到会话可见面**，不进收件箱。
   *
   * 为什么不是 `agent.steer` / `agent.inject`：
   *   · `steer` 在空闲驱动器上会**开一个新回合**（`dsh-agent` 文档原话 *An idle driver starts
   *     a turn*），于是「给人看的进度播报」把模型叫醒，模型在没有 DO 的情况下自己开工；
   *   · `inject`（= `send(msg,'next-step',false)`）不唤醒空闲驱动器，但它是**收件箱**投递：
   *     `dsh-agent-loop` 的回合循环在 `turnEnds && inbox.nextStep.length > 0` 时**继续跑下一步**，
   *     所以它照样把正在收尾的回合续上 —— 而且收件箱里的东西在**被 claim 之前不进可见面**
   *     （客户端 `inbox-definition` 的 `publication: () => "none"`），用户时间线上不会立刻多一行。
   *   · 直接 append 则两件事同时成立：立刻成为可见面节点（客户端按 `form:"notice"` 渲染成
   *     notice 行），且**完全不碰驱动器**（不唤醒、不续回合）。它还天然满足「模型在下一回合
   *     能看到它」与「仍被 reset 整段遮蔽」（reset 的 `sourceEventSeqs` 取的是可见面全部节点）。
   */
  const deliverNotice = (sessionId: string, text: string, summary?: string, opts?: { dedupe?: boolean }): boolean => {
    try {
      const agent = agentOf(sessionId);
      if (!agent) return false;
      if (deduped(sessionId, text, opts)) return true;
      const session = sessionOf(sessionId, agent);
      const msg = buildMessage(text, summary);
      if (canAppendNoticeNow(session)) {
        // 先落挂起的历史播报，再落这一条 —— 保持时间线顺序
        flushNotices(sessionId);
        if (canAppendNoticeNow(session)) {
          try {
            // @delivery notice —— 唯一的播报载体（直接 append 到可见面，不进收件箱）
            session!.append!("user/message", msg, { surfaceOp: "append" });
            return true;
          } catch (e) {
            log("warn", "notice_append_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
          }
        }
        // 竞态兜底：落进挂起队列（不是收件箱），由上面那三条触发路径补齐
      }
      const queue = deferredNotices.get(sessionId);
      if (queue) queue.push(msg);
      else deferredNotices.set(sessionId, [msg]);
      armDeferredTimer();
      return true;
    } catch (e) {
      log("warn", "deliver_notice_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
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
    // 投递分两类（判据 1）：指令 = 唤醒（DO / 命令转达 / 交卷提醒），播报 = 只记录不唤醒。
    // 每个调用点都必须显式选一个 —— 端口名就是分类，代码里一眼看得出（见 docs/v2/delivery-classification.md
    // 与 scripts/delivery-classification-test.mjs 的静态审计）。
    deliverDirective,
    deliverNotice,
    /** 把挂起的播报在**安全边界**补齐（reset 门在整段替换前先调一次：让替换把它们一并遮蔽） */
    flushNotices,
    verify: (req: VerifyRequest) => runVerifier({ ctx }, req),
    // 重置门（步骤级 `reset: true` / 工作流级 `auto_reset: true` / 手动 `/ralphflow-reset`）的载体：
    // 在步骤边界的空闲窗口里整段替换会话可见面。
    // 句柄就是这里已在用的 `ctx.agents`（Agent 的 `runMaintenance` + `session`）与 `ctx.sessions`。
    resetSurface: createResetSurface(ctx, log),
    log,
  };
  /**
   * 由 registerSkills 返回，用于给某个工作区补登记 `/ralphflow-<名字>` 快捷**技能**。
   * 引擎按工作区惰性创建，所以是个登记器而不是一次性注册。
   *
   * 两个入口分开：`registerWorkflowSkills` 会**读目录 + 解析 YAML**（只在引擎创建与新会话
   * 创建时跑）；`reportWorkflowSkillRejections` 是**纯内存**重放（工具调用路径可以随便调，
   * 不把目录扫描挂到每次工具调用上）。
   */
  let registerWorkflowSkills: WorkflowSkillRegistrar | undefined;
  let reportWorkflowSkillRejections: ((sessionId: string) => void) | undefined;

  const engineFor = (ws?: string, sessionId?: string): Engine => {
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
      // 工作流 → 快捷技能。带上会话 id：名字不合语法的工作流要**当场把原因说给用户听**
      // （引擎也可能由无会话的路径创建，那就只写日志 —— 见 src/skills.ts）。
      try { registerWorkflowSkills?.(listWorkflowsIn(key), sessionId ? { sessionId } : undefined); } catch {}
    } else if (sessionId) {
      // 引擎已存在：**纯内存**重放还没告知过的拒绝理由（不重读目录 —— 工具调用是高频路径）
      try { reportWorkflowSkillRejections?.(sessionId); } catch {}
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
  //
  // 顺带承担「挂起播报」的补齐触发：任何会话事件都可能在把可见面推回步骤边界（tool/result、
  // step/end、turn/end…），那就试落一次。**用 queueMicrotask 推迟到观察者之外**——不在
  // session/event 观察者里 append（reset.ts 硬约束 1.7：观察者内 append 会与派发重入）。
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => (() => void) | void }).on;
    if (typeof on === "function") {
      on("session/event", (s?: unknown, e?: unknown) => {
        const sid = (s as { id?: string } | undefined)?.id;
        if (!sid || !e || typeof e !== "object") return;
        if (deferredNotices.has(sid)) queueMicrotask(() => { try { flushNotices(sid); } catch {} });
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
  // 它在回合关闭前发问；「你还没交卷」是**指令** —— steer 一条提醒 → 机器重读 inbox → 再跑一步；
  // 「已暂停」是**播报** —— append 一条可见记录，不唤醒、不续回合。
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
          // 「已暂停等你处理」是**给人看的结果**：模型不需要再干活（该用户动手），
          // 所以走播报 —— 不唤醒、不把这个正在收尾的回合续上，用户立刻看到。
          deliverNotice(sid, `[ralphflow] ${verdict.message}`, verdict.summary ?? "⏸ ralphflow 已暂停等你处理");
          return;
        }
        // 「你还没交卷」是**指令**：必须唤醒驱动器再跑一步，模型才有机会交卷。
        deliverDirective(sid, verdict.message, verdict.summary ?? "⚠️ ralphflow：本步尚未交卷");
      });
    } else {
      log("warn", "turn_stopping_listener_unavailable", {});
    }
  } catch (e) {
    log("warn", "turn_stopping_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  const deps = { ctx, engineFor, deliverDirective, workspaceOfSession: (sid: string) => workspaceOfSession(ctx, sid, workspace) };
  const handlers = registerTools(deps);
  registerCommands({ ...deps, handlers });
  // 技能面：`ralphflow-start`（两面可见）+ `ralphflow-<工作流>`（只给人看）。
  // 拒绝理由走**播报**（不唤醒）：它是给人看的事实，不是要模型接着干活的指令。
  {
    const registrar = registerSkills({ ctx, deliverNotice });
    registerWorkflowSkills = registrar.register;
    reportWorkflowSkillRejections = registrar.reportRejections;
  }

  // 动态快捷技能：会话一出现就登记**它那个工作区**的工作流（纯读目录，不建引擎）。
  // 引擎是惰性创建的，只靠 engineFor 的话，用户在新工作区第一次打开会话时还没有快捷技能。
  // 带上会话 id：名字不合语法的工作流要当场把原因说给这个会话听（绝不静默跳过）。
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => unknown }).on;
    if (typeof on === "function") {
      on("session/created", (session?: unknown) => {
        const s = session as { id?: string; header?: { cwd?: string } } | undefined;
        const cwd = s?.header?.cwd;
        if (!cwd || !cwd.trim()) return;
        try { registerWorkflowSkills?.(listWorkflowsIn(cwd.trim()), s?.id ? { sessionId: s.id } : undefined); } catch {}
      });
    }
  } catch (e) {
    log("warn", "session_created_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // 默认工作区的引擎在插件加载时建好（ensureLayout + restore 都在 engineFor 里）
  engineFor(workspace);

  log("info", "plugin_loaded", { workspace, version: PLUGIN_VERSION });
}