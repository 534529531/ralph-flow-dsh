/**
 * Ralph Flow for dsh v2 — reset 门的 **dsh 载体**（会话可见面整段替换）
 *
 * 方言仍是 `reset: true`（与 opencode 同形），语义仍是「本步开始前换入干净上下文」；
 * 只是载体不同：opencode 换一个新顶级会话 + 一条会话交接说明，我们**原地替换**。
 * 依据与五条硬约束见 `docs/v2/reset-feasibility.md`（实现前必读）。
 *
 * 这个文件只做**载体**（与宿主面打交道的全部脏活）；「哪一步要重置 / 交接稿写什么」是
 * 引擎的策略，通过 `EnginePorts.resetSurface` 传进来 —— 因此本文件不认识工作流。
 *
 * 五条硬约束在这里的落点：
 *   1.1 起点固定 `nodes[1]`（node0 是 system/message，覆盖它必须自身是 system 且只覆盖一个节点，
 *       用 user/message 交接稿去覆盖必被拒；即使绕过，SystemPromptProjection 也会把系统提示
 *       append 到尾部）。
 *   1.2 绝不在工具调用内部替换：整段替换必须落在「tool 结果已落地、下一回合尚未开始」的空闲
 *       窗口，否则最后一个节点正是携带 tool-call 的 assistant/message，其 tool/result 之后会
 *       append 到**新**面尾部 → 孤儿 tool/result → 之后任何平衡查询都抛 "corrupt surface"。
 *       **这条违反不会报错**，所以这里靠 `agent.runMaintenance` 的「phase ≠ idle 同步抛错」
 *       把窗口钉死（见 1.3）。
 *   1.3 用 `agent.runMaintenance` 做互斥（宿主没有可参与的压缩锁；runMaintenance 与 turn、
 *       其它 maintenance、/compact 天然互斥）。
 *   1.4 用自有 plugin source（`{kind:'plugin', plugin:'ralphflow'}`），**不冒用压缩检查点**、
 *       不发任何 `compaction/*` 事件；`form` 缺省（要写就只写 notice + summary）。
 *   1.5 替换前自检工具配对平衡，不平衡就放弃本次（下一步再说）——`toolPairingBalancedAfter`
 *       自己可能抛，必须 try/catch。
 *   1.6 `sourceEventSeqs` 必须逐条列出**每一个**被遮蔽节点（缺一个即抛）。
 *   1.7 不在 `session/event` 观察者里 append（这里不在观察者里，且在 runMaintenance 窗口内）。
 *   1.8 交接稿写小（会被 dsh 自动压缩总结掉）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionSeq } from "@deepseek-ai/dsh-session";
import type { ResetOutcome, ResetRequest } from "./engine.js";

/** 自有 plugin id：消费者按它给轨迹行打标签；绝不冒用 `compact`。 */
export const RESET_PLUGIN_ID = "ralphflow";

/** 诊断日志端口（与引擎的 ports.log 同形；缺省静默，绝不因为日志失败影响替换）。 */
export type ResetLog = (level: "info" | "warn" | "error", event: string, data?: unknown) => void;

/** 宿主侧最小句柄：只要 Agent 的这三个能力（`whenIdle` + `runMaintenance` + `session`）。 */
interface ResetAgent {
  session?: ResetSession;
  /**
   * 驱动器收工（phase 回 idle）后兑现。**必须**在 `runMaintenance` 之前等它：
   * 见 `resetSurface` 里「为什么必须等」的说明。
   */
  whenIdle?: () => Promise<void>;
  runMaintenance?: <T>(job: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

interface ResetSession {
  surface: { nodes: readonly SessionSeq[] };
  append: (type: string, data: unknown, opts: unknown) => { seq: SessionSeq };
}

interface ResetSessionStore {
  get?: (id: string) => unknown;
}

interface ResetAgentStore {
  get?: (id: string) => unknown;
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 造一个 `EnginePorts.resetSurface`。
 *
 * 返回值**永不抛**：把「没换成」如实回给引擎（引擎据此如实播报并照常投递 DO），
 * 因为「重置失败」绝不能演变成「本步无法执行」。
 */
export function createResetSurface(ctx: Context, log?: ResetLog) {
  const note = (level: "info" | "warn" | "error", event: string, data?: unknown): void => {
    try { log?.(level, event, data); } catch {}
  };

  const agentOf = (sessionId: string): ResetAgent | undefined => {
    try {
      const agents = ctx.agents as unknown as ResetAgentStore | undefined;
      const a = agents?.get?.(sessionId);
      return a && typeof a === "object" ? (a as ResetAgent) : undefined;
    } catch { return undefined; }
  };

  const sessionOf = (sessionId: string, agent: ResetAgent | undefined): ResetSession | undefined => {
    if (agent?.session) return agent.session;
    try {
      const sessions = ctx.sessions as unknown as ResetSessionStore | undefined;
      const s = sessions?.get?.(sessionId);
      return s && typeof s === "object" ? (s as ResetSession) : undefined;
    } catch { return undefined; }
  };

  return async function resetSurface(sessionId: string, req: ResetRequest): Promise<ResetOutcome> {
    const agent = agentOf(sessionId);
    const session = sessionOf(sessionId, agent);
    if (!session) return { ok: false, reason: "no_session" };
    if (typeof agent?.runMaintenance !== "function") {
      // 没有宿主互斥入口就**不做**：直接 append 会与 agent 回合并发写同一份日志（1.3）
      return { ok: false, reason: "no_maintenance" };
    }

    try {
      // ── 先等属主会话的驱动器**收工**（phase 回 idle），再做替换 ──────────────
      //
      // 为什么必须等：`reset: true` 的步骤有两种进入方式——
      //   · 验证回调推进 / 返工：调用发生在引擎的异步回调里，agent 本就空闲，
      //     `whenIdle()` 立刻兑现（与改造前等价）；
      //   · **在工具调用内部推进**：审查门放行（模型调 `ralphflow_continue`）、
      //     无 check 步骤交卷即推进。这时驱动器正忙（phase = running），
      //     `runMaintenance` 会同步抛错 ⇒ 替换**永远不生效**。
      //     ⚠️ 内置 `spec.yaml` 的 `implement` 恰恰**只能**经 `propose` 的审查门进入，
      //     所以这不是边缘情况：不等的话第二行 `reset: true` 结构性失效
      //     （第一轮验证者 3/4 实测抓到过）。
      //
      // 这个等待不会死锁：调用方（引擎的 `deliverStepDo`）是**脱手**调用本函数的
      // （`void ...then(...)`，绝不 await），所以工具调用照常返回 → 驱动器收工 →
      // 这里兑现 → 替换落在**真正的空闲窗口**里 → 引擎随后才投递 DO。
      // 硬约束 1.2 因此仍然成立：替换绝不发生在工具调用内部。
      try { await agent.whenIdle?.(); } catch { /* 宿主没有 whenIdle（老运行时）：退回直接尝试，靠 runMaintenance 的护栏兜底 */ }

      return await agent.runMaintenance(async (signal) => {
        // ── 1.1 合法范围 = nodes[1] … nodes[N]（端点 inclusive；node0 是系统提示，永不覆盖）
        const nodes = [...session.surface.nodes];
        if (nodes.length < 2) return { ok: false, reason: "surface_too_short" };
        const startSeq = nodes[1]!;
        const tailSeq = nodes[nodes.length - 1]!;

        // ── 1.5 替换前自检平衡（`toolPairingBalancedAfter` 自己可能抛：seq 不在面上 /
        //        tool/result 没有对应 call → "corrupt surface"）。不平衡就放弃本次。
        let balanced = false;
        try {
          balanced = toolPairingBalancedAfter(session as never, tailSeq);
        } catch (e) {
          note("warn", "reset_balance_check_failed", { sessionId, error: msgOf(e) });
          return { ok: false, reason: "balance_error" };
        }
        if (!balanced) return { ok: false, reason: "unbalanced" };
        if (signal?.aborted) return { ok: false, reason: "aborted" };
        // ── 最后一道复查：等空闲窗口这段时间里实例可能已被取消/结束。
        //    它必须在 append **之前同步**做（同一次 maintenance job 内），否则取消后
        //    照样会提交一次替换 —— 属主会话的旧对话被换成一条**已取消工作流**的交接稿。
        if (typeof req.canProceed === "function") {
          let ok = false;
          try { ok = req.canProceed() === true; } catch { ok = false; }
          if (!ok) return { ok: false, reason: "instance_gone" };
        }

        // ── 决定②：另发一条**可见告知**（append 来源 → Chat 显示）。
        //    它随后被本次替换一并遮蔽：用户看得到（append 来源的旧消息照常显示），
        //    模型看不到（替换把 shadowed 节点整段移出可见面）—— 于是
        //    模型上下文精确等于「系统提示 + 交接稿 + 本步 DO」。
        //
        //    为什么是**直接 append** 而不是走引擎的 `deliver`（`agent.steer`）：
        //    steer 只是把消息塞进收件箱，驱动器要到**下一回合开始**才把它落成
        //    `user/message` —— 那时本次替换早已完成，告知会落在交接稿之后、
        //    变成模型可见的第 3 条（违反完成判据）。要「可见但不进模型上下文」，
        //    只能先让它成为 append 来源的节点、再让同一次替换把它遮蔽掉。
        const notice = createUserMessage({
          content: [{ type: "text", text: req.notice.text }],
          source: { kind: "plugin", plugin: RESET_PLUGIN_ID, form: "notice", summary: boundContextSummary(req.notice.summary) },
        });
        const noticeSeq = session.append("user/message", notice, { surfaceOp: "append" }).seq;

        // ── 整段替换：交接稿成为系统提示之外**唯一**的节点。
        //    1.6 sourceEventSeqs 必须逐条列出每个被遮蔽节点（= nodes[1..N] + 告知），
        //    缺一个即抛；1.4 用自有 plugin source，不发任何 compaction 事件。
        const shadowed = [...nodes.slice(1), noticeSeq];
        const handoff = createUserMessage({
          content: [{ type: "text", text: req.handoff }],
          source: { kind: "plugin", plugin: RESET_PLUGIN_ID },
        });
        const handoffSeq = session.append("user/message", handoff, {
          surfaceOp: { op: "replace", startSeq, endSeq: noticeSeq },
          sourceEventSeqs: shadowed,
        }).seq;

        note("info", "reset_surface_replaced", {
          sessionId, shadowed: shadowed.length, handoffSeq, noticeSeq, startSeq, tailSeq,
        });
        return { ok: true, shadowed: shadowed.length, handoffSeq, noticeSeq };
      });
    } catch (e) {
      // phase ≠ idle 时 runMaintenance **同步抛错** —— 这正是 1.2/1.3 的护栏：
      // 在工具调用内部（例如工作流首步的 `ralphflow_start`）拿不到窗口，如实放弃。
      const text = msgOf(e);
      const notIdle = /already has active work/.test(text);
      note("warn", notIdle ? "reset_surface_not_idle" : "reset_surface_failed", { sessionId, error: text });
      return { ok: false, reason: notIdle ? "not_idle" : "maintenance_failed", detail: text };
    }
  };
}
