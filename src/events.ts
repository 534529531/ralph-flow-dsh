/**
 * Ralph Flow for dsh — 事件帧发射器（审计侧）
 *
 * 每个状态机步骤：1) 写 JSONL 审计日志（execution.log，100% 可控）。
 * 曾经通过 session.append 把 tool-ralphflow/* 帧发射到会话 log 供 client 折叠
 * 成对话内嵌卡——该通道已废弃（见 createEmitter 内的架构说明：自定义事件在
 * 宿主持久化读路径上会砖掉整个会话）。
 * 事件集（审计用途，与 client/definition.ts 的 match 对应）：
 *   run-start / step-start / check-voter-start / check-verdict / check-result /
 *   gate / rewind / reset / report / run-end / run-detach
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Engine } from "./engine.js";

export interface EventEmitter {
  emit(instId: string, type: string, data: Record<string, unknown>): void;
  /**
   * 终态发射：实例已被销毁（完成/取消）后使用预先解析的属主会话发送。
   * 当前仅用于审计日志归属；不触碰会话 log。
   */
  emitFinal(instId: string, ownerSessionId: string | null | undefined, type: string, data: Record<string, unknown>): void;
}

export interface EmitterDeps {
  ctx: Context;
  engine: Engine;
}

export function createEmitter(deps: EmitterDeps): EventEmitter {
  const deliver = (owner: string | null | undefined, instId: string, type: string, data: Record<string, unknown>) => {
    // 重要：不再把自定义帧写进会话 log（session.append）。
    // 宿主的持久化读路径（assertEventsSupported）只认识 KNOWN_SESSION_EVENT_TYPES，
    // 插件自定义类型「按构造就在列表外」，且 append 无 ignorable 逃生门——一旦
    // 事件被 drain 落盘，加载时整个会话会被 SessionFormatUnsupportedError 拒绝
    // （会话变砖）。风险级别：数据丢失。官方注释明确注册面「deferred until such
    // a consumer exists」。
    // 因此这里只落我们自己的审计 JSONL（execution.log，100% 可控），不再触碰
    // 会话 log。实时/半实时 UI 走 HTTP 状态通道（/ralphflow/instances，见 index.ts）
    // + client 轮询；跨刷新补盲走 client localStorage 快照。
    const alive = deps.engine.instanceExists(instId);
    if (alive) {
      deps.engine.logEvent(instId, "info", `ui_event_${type}`, data as Record<string, unknown>);
    } else {
      // 实例已销毁（完成/取消）后帧落不到实例日志（目录已删，logEvent 会兜底
      // 写全局 logs——但审计上终态帧应归属该实例的归档记录）。直接追加到
      // 归档副本 reports/<instId>-execution.log，保证归档审计完整。
      deps.engine.appendArchivedUiEvent(instId, type, data);
    }
  };

  return {
    emit(instId: string, type: string, data: Record<string, unknown>) {
      const owner = deps.engine.readState(instId)?.session_id;
      deliver(owner, instId, type, data);
    },
    emitFinal(instId: string, ownerSessionId: string | null | undefined, type: string, data: Record<string, unknown>) {
      deliver(ownerSessionId ?? undefined, instId, type, data);
    },
  };
}

/** 由引擎生成工作流快照，供 run 卡渲染（client 端亦可自行从事件折叠） */
export function projectRunState(
  engine: Engine,
  instId: string,
): {
  workflow: string;
  currentStep: string;
  currentPhase: string;
  failCount: number;
  paused: boolean;
  status: "running" | "paused" | "failed" | "complete" | "cancelled";
} {
  const st = engine.readState(instId);
  if (!st) return { workflow: "", currentStep: "", currentPhase: "", failCount: 0, paused: false, status: "failed" };
  let status: "running" | "paused" | "failed" | "complete" | "cancelled" = "running";
  if (st.paused) status = "paused";
  else if (!st.active) {
    status = engine.reportExists(instId) ? "complete" : "cancelled";
  }
  return {
    workflow: st.workflow_name,
    currentStep: st.current_step,
    currentPhase: st.current_phase,
    failCount: st.fail_count ?? 0,
    paused: st.paused ?? false,
    status,
  };
}