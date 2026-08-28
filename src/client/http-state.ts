/**
 * Ralph Flow for dsh — HTTP 状态轮询 store（UI 主数据源）
 *
 * 背景：宿主持久化不接受插件自定义 session 事件（会砖掉会话），对话内卡片
 * 折叠所依赖的帧通道已废弃。这里改为轮询 host 的 /ralphflow/instances 端点，
 * 用 useSyncExternalStore 把「全局实例富状态」暴露给 React 组件——页头抽屉、
 * mini pipeline、验证者活体面板全部以它为准。
 *
 * 设计：纯状态 + 无副作用订阅；轮询循环由 client.ts apply 启动（单例）。
 */
import { useSyncExternalStore } from "react";
import { registerWorkflowShortcutNames } from "./definition.js";

export interface HttpInstanceState {
  runId: string;
  workflow: string;
  task: string;
  current: { step: string; phase: string; failCount: number } | null;
  steps?: { id: string; desc: string }[];
  owner?: string | null;
  paused?: boolean;
  pauseReason?: string;
  lastFailureReason?: string;
  startedAt?: string;
  gate?: { step: string; title: string; reason: string; taskExcerpt?: string } | null;
  voters?: number;
  /** 本轮 CHECK 的超时上限（ms）——「剩余时间」进度条终点感 */
  timeoutMs?: number;
  /** 本轮 CHECK 的开始时刻（ms）——超时进度条起点 */
  checkStartedAt?: number;
  voterProgress?: { voter: number; status: string; model: string | null; check: string; startedAt?: number; reason?: string }[];
}

/**
 * CHECK 剩余时间（纯函数，可单测）：返回剩余 ms、已消耗比例与是否超时。
 * 字段缺失（进程重启后内存态丢失等）返回 null——UI 降级为不画进度条。
 */
export function checkTimeLeft(checkStartedAt?: number, timeoutMs?: number, now = Date.now()): { leftMs: number; ratio: number; over: boolean } | null {
  if (typeof checkStartedAt !== "number" || checkStartedAt <= 0 || typeof timeoutMs !== "number" || timeoutMs <= 0) return null;
  const elapsed = Math.max(0, now - checkStartedAt);
  const leftMs = Math.max(0, timeoutMs - elapsed);
  return { leftMs, ratio: Math.min(1, elapsed / timeoutMs), over: elapsed >= timeoutMs };
}

export interface HttpStatePayload {
  instances: HttpInstanceState[];
  /** 引擎可启动的工作流名清单（client 端命令卡折叠器据此识别 /loop /spec 等快捷命令） */
  workflows?: string[];
  /** history 尾部条目（completed/cancelled；完成通知与历史面板数据源） */
  recentEnded?: { instId: string; workflow: string; task?: string; status?: string; endedAt?: number; reportPath?: string }[];
  ts: number;
}

let snapshot: HttpStatePayload = { instances: [], workflows: [], ts: 0 };
const listeners = new Set<() => void>();
let started = false;

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch {}
  }
}

async function tick(): Promise<void> {
  try {
    const res = await fetch("/ralphflow/instances", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as HttpStatePayload;
      if (Array.isArray(data?.instances)) {
        const workflows = Array.isArray(data.workflows) ? data.workflows : snapshot.workflows;
        snapshot = { instances: data.instances, workflows, ts: Date.now() };
        // 工作流清单是命令卡折叠器识别 /loop /spec 等快捷命令的依据，随时喂入
        try { registerWorkflowShortcutNames(workflows ?? []); } catch {}
        emit();
      }
    }
  } catch {
    // host 未就绪/离站：保持上次快照，下轮再试
  }
}

/** 启动轮询（幂等；由 client.ts apply 调用一次） */
export function startHttpPolling(intervalMs = 2500): void {
  if (started) return;
  started = true;
  void tick();
  const h = window.setInterval(() => void tick(), intervalMs);
  try { window.addEventListener("unload", () => clearInterval(h), { once: true }); } catch {}
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): HttpStatePayload {
  return snapshot;
}

/** React 组件侧 hook：全局实例状态（stale-while-poll，首帧后 2.5s 刷新） */
export function useRalphHttpState(): HttpStatePayload {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function httpStateCache(): HttpStatePayload {
  return snapshot;
}