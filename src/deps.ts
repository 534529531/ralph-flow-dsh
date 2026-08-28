/**
 * Ralph Flow for dsh — 共享依赖装配（check 调度依赖 + 事件发射）
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Engine } from "./engine.js";
import type { CheckDeps } from "./check.js";
import { registerInstanceSignal } from "./check.js";
import type { EventEmitter } from "./events.js";

export interface CheckDepsOptions {
  ctx: Context;
  engine: Engine;
  emit: EventEmitter;
  getAgent: (sessionId: string) => Agent | undefined;
  /** 互斥段所属实例 id——提供后注册可 abort 的实例级信号（cancel 可中断在飞验证者） */
  instId?: string;
}

export function createCheckDeps(opts: CheckDepsOptions): CheckDeps {
  if (opts.instId) {
    const reg = registerInstanceSignal(opts.instId);
    return {
      ctx: opts.ctx,
      engine: opts.engine,
      emit: (instId, type, data) => opts.emit.emit(instId, type, data),
      signal: reg.signal,
      dispose: reg.dispose,
    };
  }
  return {
    ctx: opts.ctx,
    engine: opts.engine,
    emit: (instId, type, data) => opts.emit.emit(instId, type, data),
    signal: new AbortController().signal,
  };
}
