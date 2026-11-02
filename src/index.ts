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
import type { WorkflowUiRef } from "./message-source.js";
import type { Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import { WorkflowStatusService } from "./status-service.js";
import { RALPHFLOW_SOURCE_KIND } from "./message-source.js";
import type { VerifyRequest } from "./engine.js";
import { createFacade, type Facade } from "./facade.js";
import { projectRootOf } from "./paths.js";
import { discoverAssetsIn } from "./assets.js";
import { createResetSurface } from "./reset.js";
import { runVerifier } from "./verify.js";
import { registerVerifierPreset } from "./verifier-preset.js";
import { registerTools, registerCommands, SUBMIT_TOOL_NAME } from "./tools.js";
import { registerSkills, type WorkflowSkillRegistrar } from "./skills.js";

export const name = "ralphflow";
export const inject = ["tools", "commands", "skills", "subagents", "agents", "sessions"];

/**
 * 本包版本 —— 从 `package.json` 读，**绝不硬编码**。
 *
 * 日志里报一个假版本比不报更糟：诊断「进程到底加载的是哪份 lib」时，版本号是唯一线索。
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
  // 0.2.1-rc.2+：验证者的 persona + 只读工具面只能经 Agent Preset 声明。
  // 注册是 best-effort；失败时验证委派会在 start() 处 fail-closed 成 infra。
  void registerVerifierPreset(ctx);
  /** 插件加载目录的项目根（没有会话可问时的唯一回落；不再有环境变量旁路）。 */
  const workspace = projectRootOf(process.cwd());
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
   * `source.form` 决定 context 内容的展开方式，不决定 Chat 是否收录这一行：
   * 非 user 来源的普通 context 会整行过滤。本包客户端把带 notice + summary 的 append
   * 日志另投影为会话级 `ralphflow-notice` 节点，才让人类看到记录。
   * summary 是默认可读的摘要；没有 summary 的内部指令不匹配该客户端 Definition。
   * {@link buildMessage} 就是这个 source 的唯一构造点。
   */
  const buildMessage = (text: string, summary?: string, uiRef?: WorkflowUiRef): ReturnType<typeof createUserMessage> => {
    const brief = typeof summary === "string" ? summary.trim() : "";
    const source = brief
      ? { kind: RALPHFLOW_SOURCE_KIND, form: "notice" as const, summary: boundContextSummary(brief) }
      : { kind: RALPHFLOW_SOURCE_KIND };
    return createUserMessage({ content: [{ type: "text", text }], source: { ...source, ...(uiRef ? { uiRef } : {}) } });
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

  /**
   * 指令（directive）载体：dsh 的 `steer` —— 空闲开新一轮，**收尾中的回合**在下一个 step
   * 边界取走（即把该回合续上）。「一轮」的边界用它不合适，那是 `deliverRound` 的事。
   */
  const deliverDirective = (sessionId: string, text: string, summary?: string, opts?: { dedupe?: boolean }): boolean => {
    try {
      const agent = agentOf(sessionId) as { steer: (m: unknown) => unknown } | undefined;
      if (!agent) return false;
      if (deduped(sessionId, text, opts)) return true;
      // 指令不插队：先把本会话挂起的播报落下去（顺序 = 事件真实发生的顺序）
      flushNotices(sessionId);
      // @delivery directive —— 本回合内的唤醒载体（dsh 的 steer）
      agent.steer(buildMessage(text, summary));
      return true;
    } catch (e) {
      log("warn", "deliver_directive_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  /**
   * 新一轮（round）载体：dsh 的 `agent.followup` —— 唤醒，且**在收件箱 next-turn 边界开一个新回合**。
   *
   * 为什么不能和指令共用 `steer`：两者在**空闲**会话上都是「开新回合」，在**收尾中的回合**上却
   * 分道扬镳。`dsh-agent` 对 `agent/turn-stopping` 的原话是「可通过 steer 使其保持打开」，而回合
   * 循环的判据是 `turnEnds && inbox.nextStep.length === 0` —— steer 落 next-step，收尾的回合就被
   * 续上，`turn/end` 永远不出现。实测（RA2 loop，单步跑了 8 小时）**84 轮共用 4 个回合**，模型
   * 在第 150 步自己写出 *I've reached the limit of what this turn can carry out*：它把「回合」
   * 当成了工作预算，而这个回合没有尽头。
   *
   * `followup` 反过来：本回合正常 `turn/end`，这条提醒成为**下一回合的第一条消息**（`turn()` 收尾时
   * `inbox.hasPending` 为真就直接开下一轮）。opencode 版就是这么驱动的 —— 它的每条催促是一次
   * `session.promptAsync`，一个 prompt 一个回合。**一轮 = 一个回合**，模型拿到的边界和引擎的
   * 「本轮」是同一个东西。
   */
  const deliverRound = (sessionId: string, text: string, summary?: string, opts?: { dedupe?: boolean }): boolean => {
    try {
      const agent = agentOf(sessionId) as { followup: (m: unknown) => unknown } | undefined;
      if (!agent) return false;
      if (deduped(sessionId, text, opts)) return true;
      // 新一轮不插队：先把本会话挂起的播报落下去（顺序 = 事件真实发生的顺序）
      flushNotices(sessionId);
      // @delivery directive —— 下一回合的载体（收件箱 next-turn 边界 + 唤醒）
      agent.followup(buildMessage(text, summary));
      return true;
    } catch (e) {
      log("warn", "deliver_round_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
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
   *   · 直接 append 则两件事同时成立：立刻成为模型可见面节点（本包客户端另外投影为
   *     用户可见的私有 Chat 节点），且**完全不碰驱动器**（不唤醒、不续回合）。它还天然满足「模型在下一回合
   *     能看到它」与「仍被 reset 整段遮蔽」（reset 的 `sourceEventSeqs` 取的是可见面全部节点）。
   */
  const deliverNotice = (sessionId: string, text: string, summary?: string, opts?: { dedupe?: boolean; uiRef?: WorkflowUiRef }): boolean => {
    try {
      const agent = agentOf(sessionId);
      if (!agent) return false;
      if (deduped(sessionId, text, opts)) return true;
      const session = sessionOf(sessionId, agent);
      const msg = buildMessage(text, summary, opts?.uiRef);
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
  const engines = new Map<string, Facade>();
  const statusListeners = new Set<() => void>();
  let statusQueued = false;
  const statusChanged = () => {
    if (statusQueued) return;
    statusQueued = true;
    queueMicrotask(() => {
      statusQueued = false;
      for (const listener of statusListeners) { try { listener(); } catch {} }
    });
  };
  const ports = {
    // 投递分两类（判据 1）：指令 = 唤醒（DO / 命令转达 / 交卷提醒），播报 = 只记录不唤醒。
    // 每个调用点都必须显式选一个 —— 端口名就是分类，代码里一眼看得出（见 docs/v2/delivery-classification.md
    // 与 scripts/delivery-classification-test.mjs 的静态审计）。
    deliverDirective,
    deliverNotice,
    statusChanged,
    /** 把挂起的播报在**安全边界**补齐（reset 门在整段替换前先调一次：让替换把它们一并遮蔽） */
    flushNotices,
    verify: (req: VerifyRequest) => runVerifier({ ctx, ensurePreset: () => registerVerifierPreset(ctx) }, req),
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

  /**
   * 会话目录：dsh 的**有效工作目录**（`workingDirectory` 服务在场时），否则 header 里的
   * 原始项目目录。原生 Skill 也这样取 cwd（`ctx.workingDirectory.ensure(agent)`），
   * 所以用户 `/cd` 到别的目录后，两边看的是同一个目录。
   */
  const cwdOf = (session: { header?: { cwd?: string } } | undefined): string | undefined => {
    if (!session) return undefined;
    try {
      const wd = (ctx as unknown as { get(name: string): { get?(s: unknown): string | null | undefined } | undefined }).get("workingDirectory");
      const current = wd?.get?.(session);
      if (current && current.trim()) return current.trim();
    } catch {}
    const cwd = session.header?.cwd;
    return cwd && cwd.trim() ? cwd.trim() : undefined;
  };

  /**
   * 发起会话的项目根：会话目录按原生规则归一；查不到会话就回落到插件加载目录。
   * 工具、状态面、技能登记都必须经过它 —— 这是「会话 → 引擎」的唯一解析点。
   */
  const workspaceOfSession = (sessionId: string): string => {
    try {
      const sessions = ctx.sessions as unknown as { get(id: string): { header?: { cwd?: string } } | undefined };
      const cwd = cwdOf(sessions.get(sessionId));
      if (cwd) return projectRootOf(cwd);
    } catch {}
    return workspace;
  };

  const engineFor = (ws?: string, sessionId?: string): Facade => {
    const key = ws && ws.trim() ? ws.trim() : workspace;
    let e = engines.get(key);
    if (!e) {
      e = createFacade(key, { ctx, ports });
      engines.set(key, e);
      // **不在这里建目录**：engineFor 是所有工具（含只读的 list/doctor/status）的入口，
      // 在这里 ensureLayout 会让只读命令在用户从没用过 ralphflow 的项目里创建整棵
      // .dsh/ralph-flow/ 树。目录由**写意图**的操作创建：start（引擎内已调）与
      // create（要往 workflows/ 放文件）。读操作对目录缺失是容错的（readdir 失败即空）。
      // 崩溃/重载恢复：孤儿委派 fail-safe（暂停等用户，不隐式继续）
      try { e.restore(); } catch (err) { log("warn", "restore_failed", { workspace: key, error: String(err) }); }
      // 工作流 → 快捷技能。带上会话 id：名字不合语法的工作流要**当场把原因说给用户听**
      // （引擎也可能由无会话的路径创建，那就只写日志 —— 见 src/skills.ts）。
      try { registerWorkflowSkills?.(discoverAssetsIn(key), sessionId ? { sessionId } : undefined); } catch {}
    } else if (sessionId) {
      // 引擎已存在：**纯内存**重放还没告知过的拒绝理由（不重读目录 —— 工具调用是高频路径）
      try { reportWorkflowSkillRejections?.(sessionId); } catch {}
    }
    return e;
  };

  // Optional outside web: headless/test compositions keep the same workflow behavior.
  ctx.inject(["typert"], (remoteCtx) => {
    const terminalRefs = new WeakMap<Session, { seq: number; ref: WorkflowUiRef | undefined }>();
    new WorkflowStatusService(remoteCtx, {
      subscribe(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
      pause(session) {
        const cwd = cwdOf(session);
        const key = cwd ? projectRootOf(cwd) : workspace;
        const engine = engines.get(key) ?? createFacade(key, { ctx, ports });
        return engine.pauseForUserStop(session.id);
      },
      async read(session) {
        // Viewing status never runs restore or registers skills / sends a notice.
        const cwd = cwdOf(session);
        const key = cwd ? projectRootOf(cwd) : workspace;
        const engine = engines.get(key) ?? createFacade(key, { ctx, ports });
        const active = engine.uiStatus(session.id);
        const catalog = engine.viewerCatalog();
        if (active.status && engine.readState(active.status.id)?.active) return { ...active, catalog };
        let cached = terminalRefs.get(session);
        if (!cached || cached.seq !== session.seq) {
          const query = ctx.get("sessionQuery");
          if (!query) return { ...active, catalog };
          const observedSeq = session.seq;
          const log = await query.readSession(session.id);
          let ref: WorkflowUiRef | undefined;
          for (const event of log.events) {
            if (event.seq < log.inheritedEventCount || event.type !== "user/message" || event.surfaceOp !== "append"
              || event.data.source.kind !== RALPHFLOW_SOURCE_KIND) continue;
            const candidate = event.data.source.uiRef;
            if (candidate?.v === 1 && (candidate.ended === "done" || candidate.ended === "cancelled")) ref = candidate;
          }
          cached = { seq: observedSeq, ref }; terminalRefs.set(session, cached);
        }
        // A new active run may have landed while the cold read awaited persistence.
        const current = engine.uiStatus(session.id);
        const terminal = cached.ref ? engine.uiReport(cached.ref) : null;
        // A residual from an older archive failure must not cover a newer completed run.
        if (current.status && (engine.readState(current.status.id)?.active || !terminal
          || Date.parse(current.status.updatedAt) >= Date.parse(terminal.updatedAt))) return { ...current, catalog };
        return {
          status: terminal,
          error: current.error ?? (cached.ref && !terminal ? "本次运行的报告暂不可读取，请检查报告文件。" : null),
          catalog,
        };
      },
    });
  });

  /**
   * 只查**已存在**的引擎：会话事件是高频路径，不能为了它给每个会话凭空建引擎
   * （没有引擎 = 该工作区没有活跃实例，也就没有需要提醒/捕获的东西）。
   */
  const existingEngineFor = (sid: string): Facade | undefined =>
    engines.get(workspaceOfSession(sid));

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
        if ((e as { type?: string }).type === "user/message" && (e as { data?: { source?: { uiRef?: unknown } } }).data?.source?.uiRef) statusChanged();
        if (deferredNotices.has(sid)) queueMicrotask(() => { try { flushNotices(sid); } catch {} });
        const ev = e as { type?: unknown; data?: unknown; time?: unknown };
        // 停止按钮 = 暂停：宿主把当前回合 cancel 成 `turn/end { kind:"aborted", reason:{kind:"user"} }`。
        // Flow 与 Graph 同一条路径；**不在观察者里 append/写会话**，交给微任务（同 flushNotices 的纪律）。
        if (ev.type === "turn/end") {
          const reason = (ev.data as { reason?: { kind?: string; reason?: { kind?: string } } } | undefined)?.reason;
          if (reason?.kind === "aborted" && reason.reason?.kind === "user") {
            queueMicrotask(() => {
              try { existingEngineFor(sid)?.pauseForUserStop(sid); } catch (err) {
                log("warn", "pause_on_stop_failed", { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
              }
            });
          }
          return;
        }
        // 回合收尾检查的「有没有在干活」信号：只记时间戳，不碰内容。
        // 没有引擎 = 该工作区没有活跃实例，不需要记。
        if (ev.type === "tool/call") {
          // 交卷本身不算「在干活」：否则连续空交卷会把空回合计数清零，催促机制失效。
          const toolName = (ev.data as { name?: unknown } | undefined)?.name;
          if (toolName !== SUBMIT_TOOL_NAME && typeof ev.time === "number") existingEngineFor(sid)?.noteAction(sid, ev.time);
          return;
        }
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

  // 回合收尾检查：用宿主原生的 agent/turn-stopping（serial、可 await）。
  // 它在回合关闭前问「做完了吗」；「还没结束」是**指令**，而且必须落**下一回合**（`deliverRound`
  // → `followup`）：本回合先正常收尾，提醒成为新回合的第一条消息 → 一轮 = 一个回合。
  // 用 `steer` 会把这个正在收尾的回合续上（缺陷本体，见 deliverRound 的注释）。
  // 「已暂停」是**播报** —— append 一条可见记录，不唤醒、不续回合。
  // 这正是 claude/opencode 版 Stop hook 的原生等价物（design §3 的「驱动器」角色），
  // 但不再依赖对自由文本做正则匹配。
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => unknown }).on;
    if (typeof on === "function") {
      on("agent/turn-stopping", (payload?: unknown) => {
        const p = payload as { agent?: { id?: string }; signal?: { aborted?: boolean } } | undefined;
        const sid = p?.agent?.id;
        if (!sid) return;
        // 用户按了停止：这一回合不是"忘了交卷"，不催。停止本身走 session/event 的 turn/end 暂停路径。
        if (p?.signal?.aborted) return;
        const eng = existingEngineFor(sid);
        if (!eng) return;
        let verdict: { remind: boolean; message?: string; summary?: string };
        try { verdict = eng.remindToSubmit(sid); } catch (e) {
          log("warn", "turn_stopping_failed", { sessionId: sid, error: e instanceof Error ? e.message : String(e) });
          return;
        }
        // 本包客户端以 notice + summary 匹配播报，再由私有节点绕过普通 context 的过滤
        if (!verdict.message) return;
        if (!verdict.remind) {
          // 「已暂停等你处理」是**给人看的结果**：模型不需要再干活（该用户动手），
          // 所以走播报 —— 不唤醒、不把这个正在收尾的回合续上，用户立刻看到。
          deliverNotice(sid, `[ralphflow] ${verdict.message}`, verdict.summary ?? "⏸ ralphflow 已暂停等你处理");
          return;
        }
        // 「你还没交卷」是**指令**，而且它是**下一轮**的开始：走 `followup` 让本回合正常收尾，
        // 提醒成为新回合的第一条消息。用 `steer` 会把这个正在收尾的回合续上 —— 那正是
        // 「一轮 ≠ 一个回合」的缺陷本体（见 deliverRound 的注释）。
        // `dedupe: false`：提醒是**唯一**能开下一轮的信号，被 5 秒去重窗口吞掉就是静默停滞
        // （「有动作」的提醒正文不带次数，两轮快照可能逐字相同）。而且 turn-stopping 每回合只触发一次。
        deliverRound(sid, verdict.message, verdict.summary ?? "⚠️ ralphflow：本步还没结束", { dedupe: false });
      });
    } else {
      log("warn", "turn_stopping_listener_unavailable", {});
    }
  } catch (e) {
    log("warn", "turn_stopping_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  const deps = { ctx, engineFor, deliverDirective, workspaceOfSession };
  const handlers = registerTools(deps);
  registerCommands({ ...deps, handlers });
  // 技能面：`ralphflow-start`（两面可见）+ `ralphflow-<工作流>`（只给人看）。
  // 拒绝理由走**播报**（不唤醒）：它是给人看的事实，不是要模型接着干活的指令。
  {
    const registrar = registerSkills({ ctx, deliverNotice });
    registerWorkflowSkills = registrar.register;
    reportWorkflowSkillRejections = registrar.reportRejections;
  }

  // 动态快捷技能：会话一出现就登记**它那个项目根**的工作流（纯读目录，不建引擎）。
  // 引擎是惰性创建的，只靠 engineFor 的话，用户在新项目第一次打开会话时还没有快捷技能。
  // 带上会话 id：名字不合语法的工作流要当场把原因说给这个会话听（绝不静默跳过）。
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => unknown }).on;
    if (typeof on === "function") {
      on("session/created", (session?: unknown) => {
        const s = session as { id?: string; header?: { cwd?: string } } | undefined;
        const cwd = cwdOf(s);
        if (!cwd) return;
        try { registerWorkflowSkills?.(discoverAssetsIn(projectRootOf(cwd)), s?.id ? { sessionId: s.id } : undefined); } catch {}
      });
    }
  } catch (e) {
    log("warn", "session_created_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // 默认项目根（插件加载目录）的引擎在插件加载时建好（ensureLayout + restore 都在 engineFor 里）
  engineFor(workspace);

  log("info", "plugin_loaded", { workspace, version: PLUGIN_VERSION });
}