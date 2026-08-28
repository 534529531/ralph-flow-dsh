/**
 * Ralph Flow for dsh — jobs 生产者 + 影子 registry
 *
 * 每个 ralphflow 实例 = 一个 dsh job（kind 'ralphflow'）。job 不是执行 DO 的主体，
 * 而是状态机守护者：监听实例所属会话的 assistant/message 事件检测 done tag，
 * 触发 runCheckAndAdvance 推进状态机（do→check→验证→下一步/暂停/完成），并发射
 * 事件帧供 UI 折叠。实例终态（报告归档或取消）即 job 的 done。
 *
 * 影子 registry：dsh jobs 是进程内的，进程重启后 job 记录丢失。本插件 apply 时
 * 扫描工作区实例目录，为 active 实例重建 job（job 视图恢复；状态机本身由
 * state.json 持久化，不依赖 job 记录）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JobHooks, JobKindMap, JobStart } from "@deepseek-ai/dsh-jobs";
import type { Engine, NormalStepDef, RalphFlowState } from "./engine.js";
import { isSubWorkflowStep, MANUAL_STEP_MARKER, MANUAL_GATE_MARKER, DONE_TAG_MARKER } from "./engine.js";
import { runCheckAndAdvance, type DriveContext } from "./driver.js";
import { createEmitter, type EventEmitter } from "./events.js";
import { detectDoneTag } from "./done-detect.js";
import { withInstanceLock } from "./mutex.js";
import { abortInstanceChecks, liveVerifierCount } from "./check.js";
import fs from "fs";
import path from "path";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    ralphflow: "ralphflow";
  }
}

export interface RalphJobManager {
  /** 为实例注册守护 job（幂等：已存在则复用） */
  ensure(instId: string): string | undefined;
  /** 让 job 重新观察会话（continue 接管后调用） */
  reobserve(instId: string): void;
  /** 扫描实例目录，为 active 实例重建 job（插件加载/进程重启后） */
  restore(): void;
  /** 当前活跃的 ralphflow job 列表 */
  active(): { instId: string; jobId: string }[];
  /** 终止实例的守护 job（实例已取消/销毁时调用；不存在则静默） */
  kill(instId: string): void;
}

export interface ManagerDeps {
  ctx: Context;
  engine: Engine;
  getAgent: (sessionId: string) => Agent | undefined;
}

/** 会话事件→驱动触发：检测 done tag 并推进状态机（导出供 e2e 直接驱动同一链路） */
export async function onSessionEvent(
  deps: ManagerDeps,
  instId: string,
  event: { type: string; data?: any },
): Promise<void> {
  const engine = deps.engine;
  const state = engine.readState(instId);
  if (!state || !state.active || state.paused) return;

  // 只处理 assistant/message 事件（job 订阅层已按会话 id 过滤）
  if (event.type !== "assistant/message") return;
  const text = extractAssistantText(event.data);
  if (!text) return;

  const hasDone = detectDoneTag(text);
  const statePhase = state.current_phase || "";
  const stateStep = state.current_step || "";
  const workflow = engine.loadWorkflow(state.workflow_name);
  if (!workflow) {
    // 工作流定义被删/改坏：如实告知而不是静默卡死在"执行中"
    engine.logEvent(instId, "warn", "drive_workflow_missing", { workflow: state.workflow_name });
    return;
  }
  const currentStep = engine.getStep(workflow, stateStep);
  if (!currentStep || isSubWorkflowStep(currentStep)) return;

  // 已标记 done 的步骤：不重复驱动
  const markerPath = path.join(engine.getInstanceDir(instId), DONE_TAG_MARKER);
  const marked = fs.existsSync(markerPath);

  if (hasDone && statePhase === "do") {
    if (marked) return;
    // 人工门：manual 步骤的 DO 完成 → 停下等用户审查批准，不自动进验证。
    // 真正的 gate 卡在此刻发射（此前的"推进预告"不含审批动作）。
    if (engine.markerExists(MANUAL_STEP_MARKER, instId) || (workflow.manual_step?.includes(stateStep) ?? false)) {
      // 门已布防（gate marker 在）就不再重复写卡：停等期间模型再产出任何带
      // done 标签的消息都不应再发一张相同的审查卡。
      if (marked || engine.markerExists(MANUAL_GATE_MARKER, instId)) return;
      fs.writeFileSync(markerPath, String(Date.now()));
      engine.writeMarker(MANUAL_GATE_MARKER, String(Date.now()), instId);
      engine.logEvent(instId, "info", "manual_gate_waiting", { step: stateStep });
      const gstep = engine.getStep(workflow, stateStep);
      createEmitter({ ctx: deps.ctx, engine }).emit(instId, "tool-ralphflow/gate", {
        runId: instId,
        step: stateStep,
        title: gstep && !isSubWorkflowStep(gstep) ? gstep.desc : stateStep,
        reason: `步骤 ${stateStep} 的 DO 已完成，等待人工审查。确认无误点「通过」；需返工点「打回」（附修改意见）。`,
        // 审批材料：这一步本来要求做什么（DO 任务原文截断）——让用户扫一眼
        // 就能对照产出做判断，而不是对着一句 desc 机械点确认。
        taskExcerpt: gstep && !isSubWorkflowStep(gstep) ? (gstep.do || "").trim().slice(0, 300) : undefined,
      });
      return;
    }
    await withInstanceLock(instId, async () => {
      // 锁内重读状态：排队期间可能已被 continue/取消/rewind 改变——步骤或
      // 工作流已变时必须放弃本次驱动（用旧 currentStep 推进会跳步/错配）
      const fresh = engine.readState(instId);
      if (!fresh || !fresh.active || fresh.paused || fresh.current_phase !== "do") return;
      if (fresh.current_step !== stateStep || fresh.workflow_name !== workflow.name) return;
      if (fs.existsSync(markerPath)) return;
      fs.writeFileSync(markerPath, String(Date.now()));
      const drive: DriveContext = {
        engine, deps: makeCheckDeps(deps, instId), emit: createEmitter({ ctx: deps.ctx, engine }),
        parent: fresh.session_id ? deps.getAgent(fresh.session_id) : undefined,
      };
      await runCheckAndAdvance(drive, instId, workflow, currentStep as NormalStepDef, fresh);
    });
    return;
  }

  // check 阶段补跑：仅对带 done 标签的消息触发（进程重启后无人在跑的验证），
  // 有登记中的验证者会话时不重入（防止与进行中的投票双重推进）。先清理孤儿
  // 登记（进程 kill -9 残留的 live 文件），否则这里会永远认为「验证进行中」。
  if (hasDone && statePhase === "check" && liveVerifierCount(engine, instId) === 0) {
    await withInstanceLock(instId, async () => {
      const fresh = engine.readState(instId);
      if (!fresh || !fresh.active || fresh.paused || fresh.current_phase !== "check") return;
      if (fresh.current_step !== stateStep || fresh.workflow_name !== workflow.name) return;
      if (liveVerifierCount(engine, instId) > 0) return;
      const drive: DriveContext = {
        engine, deps: makeCheckDeps(deps, instId), emit: createEmitter({ ctx: deps.ctx, engine }),
        parent: fresh.session_id ? deps.getAgent(fresh.session_id) : undefined,
      };
      await runCheckAndAdvance(drive, instId, workflow, currentStep as NormalStepDef, fresh);
    });
  }
}

function extractAssistantText(data: any): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const msg = data.message;
  if (!msg) return undefined;
  // AssistantMessage 的文本块拼接
  if (typeof msg.text === "string") return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content.map((c: any) => (c && c.type === "text" ? c.text : "")).join("\n");
  }
  return undefined;
}

import { runSingleVoter, registerInstanceSignal, type CheckDeps } from "./check.js";

function makeCheckDeps(deps: ManagerDeps, instId?: string): CheckDeps {
  if (instId) {
    const reg = registerInstanceSignal(instId);
    return {
      ctx: deps.ctx,
      engine: deps.engine,
      emit: (id, type, data) => createEmitter({ ctx: deps.ctx, engine: deps.engine }).emit(id, type, data),
      signal: reg.signal,
      dispose: reg.dispose,
    };
  }
  return {
    ctx: deps.ctx,
    engine: deps.engine,
    emit: (id, type, data) => createEmitter({ ctx: deps.ctx, engine: deps.engine }).emit(id, type, data),
    signal: new AbortController().signal,
  };
}

/** 从 dsh session 事件流提取最新助手消息文本（job 初始化时恢复状态视图用） */
export function lastAssistantText(session: { events: readonly { type: string; data?: any }[] }): string | undefined {
  const msgs = [...session.events].reverse().find((e) => e.type === "assistant/message");
  return msgs ? extractAssistantText(msgs.data) : undefined;
}

/** 创建 ralphflow job 生产者，返回 job 管理器 */
export function createJobManager(deps: ManagerDeps): RalphJobManager {
  const ctx = deps.ctx;
  const engine = deps.engine;
  const emit = createEmitter({ ctx, engine });
  const jobs = deps.ctx.jobs as unknown as {
    attachController(name: string): void;
    start(spec: JobStart): string;
    kill(id: string, caller?: unknown, reason?: string): void;
  };
  const byInst = new Map<string, { jobId: string; hooks: JobHooks; resolveDone: (o: { status: "completed" | "killed" | "failed" }) => void; cancel?: () => void }>();
  const entryCancel = new Map<string, () => void>();

  function makeRun(instId: string, owner: Agent | undefined, hooks: { resolveDone: (o: { status: "completed" | "killed" | "failed" }) => void }) {
    const state = engine.readState(instId);
    const sessionId = state?.session_id;
    // 影子恢复等不经 finishTransition 的终态也要让用户看到完成卡：实例销毁后
    // readState 已读不到属主，这里预先解析供 poll 兜底用 emitFinal 发送。
    const ownerSessionId = sessionId ?? null;
    const self = {
      cancelled: false,
    };
    const controller = new AbortController();
    let pollHandle: NodeJS.Timeout | undefined;
    const cancel = () => {
      self.cancelled = true;
      if (unsubscribe) { try { unsubscribe(); } catch {} }
      if (pollHandle) clearInterval(pollHandle);
      controller.abort();
      // 本 job 驱动的在飞验证者一并中止：reobserve/kill 重建 job 时，旧 job
      // 的验证者不能继续烧 token 跑满超时（与新 job 的验证者并行双倍消耗）。
      try { abortInstanceChecks(instId); } catch {}
    };
    const listener = (event: { type: string; data?: any }) => {
      if (self.cancelled) return;
      void onSessionEvent(deps, instId, event).catch((err) => {
        engine.logEvent(instId, "error", "job_drive_error", { error: err instanceof Error ? err.message : String(err) });
      });
    };
    // 订阅实例所属会话的事件流。
    // 注意：dsh 的 Session 类没有 .on —— 会话事件通过 ctx.on("session/event", (session, event)) 全局分发，
    // 这里按 session id 过滤出本实例所属会话的事件（官方同构写法，见 dsh-agent-instructions）。
    let unsubscribe: (() => void) | undefined;
    if (sessionId) {
      try {
        const ctxOn = (ctx as any).on as ((name: string, listener: (...args: any[]) => any) => () => void) | undefined;
        if (ctxOn) {
          unsubscribe = ctxOn("session/event", (_s: unknown, e: { type: string; data?: any }) => {
            const s = _s as { id?: string } | undefined;
            if (s && s.id !== sessionId) return;
            listener(e);
          });
        } else {
          engine.logEvent(instId, "warn", "job_subscribe_unavailable", {});
        }
      } catch (err) {
        engine.logEvent(instId, "warn", "job_subscribe_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // 完成监视：轮询实例状态（事件驱动的兜底，覆盖事件订阅缺失场景）
    const poll = setInterval(() => {
      if (self.cancelled) return;
      const st = engine.readState(instId);
      if (!st || !st.active) {
        clearInterval(poll);
        if (unsubscribe) { try { unsubscribe(); } catch {} }
        hooks.resolveDone({ status: "completed" });
        // cancel 路径由 cancelHandler 发 run-end cancelled；这里只对有归档报告
        // （正常完成）的实例补发 done——用销毁前锁定的属主会话。
        if (engine.reportExists(instId)) {
          emit.emitFinal(instId, ownerSessionId, "tool-ralphflow/run-end", { runId: instId, stopReason: "done" });
        }
        byInst.delete(instId);
        entryCancel.delete(instId);
        return;
      }
      // 暂停实例的守护 job 自杀：暂停期间 job 无事可做（onSessionEvent 对
      // paused 直接 return），挂着只会让宿主的「N 个后台任务运行中」持续
      // 误导用户——工作流明明停了，页头却说在运行。continue 恢复路径全部
      // 走 jobs.reobserve 重建守护（check_error/manual gate/通用暂停/crash/
      // attach 五处均已接线），这里退场是安全的。
      if (st.paused) {
        clearInterval(poll);
        if (unsubscribe) { try { unsubscribe(); } catch {} }
        engine.logEvent(instId, "info", "job_paused_retire", {});
        hooks.resolveDone({ status: "completed" });
        byInst.delete(instId);
        entryCancel.delete(instId);
        return;
      }
    }, 30_000);
    void poll.unref?.();
    pollHandle = poll;

    const hooksImpl: JobHooks = {
      cancel,
      done: new Promise<{ status: "completed" | "killed" | "failed" }>((resolve) => {
        hooks.resolveDone = resolve;
      }),
      readOutput: () => {
        const st = engine.readState(instId);
        return st ? statusLine(st) : `(no state)`;
      },
    };
    entryCancel.set(instId, cancel);
    return hooksImpl;
  }

  function statusLine(st: RalphFlowState): string {
    const phase = st.current_phase === "check" ? "CHECK" : "DO";
    return `ralphflow <${st.workflow_name}> ${st.current_step} ${phase} fail=${st.fail_count ?? 0}${st.paused ? " paused" : ""}`;
  }

  jobs.attachController("ralphflow");

  return {
    ensure(instId: string): string | undefined {
      const existing = byInst.get(instId);
      if (existing) return existing.jobId;
      const state = engine.readState(instId);
      if (!state || !state.active) return undefined;
      const owner = state.session_id ? deps.getAgent(state.session_id) : undefined;
      let resolveDone: (o: { status: "completed" | "killed" | "failed" }) => void = () => {};
      const entry = { jobId: "", hooks: {} as JobHooks, resolveDone };
      const spec: JobStart = {
        kind: "ralphflow",
        label: `ralphflow ${state.workflow_name} ${instId}`,
        outputLimitBytes: 2048,
        ...(owner ? { owner } : {}),
        run: () => makeRun(instId, owner, entry),
      };
      try {
        const started = jobs.start(spec);
        entry.jobId = String(started);
        byInst.set(instId, entry);
        return entry.jobId;
      } catch (err) {
        engine.logEvent(instId, "error", "job_start_failed", { error: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    },
    reobserve(instId: string) {
      const entry = byInst.get(instId);
      if (entry) {
        // 取消旧 job 并重建（会话归属可能变化）；本地 cancel 立即生效（解订阅+
        // 停 poll），不依赖宿主 kill 的同步语义（避免新旧 job 并存双订阅）
        try { entryCancel.get(instId)?.(); } catch {}
        try { jobs.kill(entry.jobId, undefined, "reobserve"); } catch {}
        byInst.delete(instId);
        entryCancel.delete(instId);
      }
      this.ensure(instId);
    },
    restore() {
      try {
        const instances = engine.listInstances();
        for (const inst of instances) {
          if (!inst.state.active) continue;
          // 暂停实例不建守护 job：poll 的 paused 自杀分支反正会在 30s 内退场，
          // 直接跳过省一次启停（恢复路径的 continue→reobserve 会按需重建）
          if (inst.state.paused) continue;
          this.ensure(inst.id);
        }
      } catch (err) {
        engine.logEvent("", "error", "shadow_restore_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    },
    active() {
      return [...byInst.entries()].map(([instId, e]) => ({ instId, jobId: e.jobId }));
    },
    kill(instId: string) {
      const entry = byInst.get(instId);
      if (!entry) {
        entryCancel.get(instId)?.();
        entryCancel.delete(instId);
        return;
      }
      try { entry.cancel?.(); } catch {}
      try { jobs.kill(entry.jobId, undefined, "instance cancelled"); } catch {}
      byInst.delete(instId);
      entryCancel.delete(instId);
    },
  };
}

export { runSingleVoter };
