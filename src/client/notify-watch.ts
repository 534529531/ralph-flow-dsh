/**
 * Ralph Flow for dsh — 全局通知/快照监视（模块级，不依赖任何组件挂载）
 *
 * 组件（HeaderAction）只挂在会话页头槽位；用户停在空状态页或别的会话时，
 * 「待审查 / 已暂停 / 已完成」到达不能没人提醒。本模块在 client apply 启动时
 * 挂到 HTTP 状态通道（单例轮询，与 http-state 同频）：
 *  - gate 出现 → 待你审查；stopReason 翻转为 failed → 已暂停；
 *  - host 的 recentEnded（history 尾部 completed 条目）→ 已完成（带 cursor
 *    预填，切换页面/刷新不重复轰炸历史完成记录）；
 *  - 边沿变化同时写 localStorage 快照（刷新后抽屉「已结束/待处理」补盲）。
 * 通知走 notify.ts 既有去重与疲劳控制；HTTP 不可用（headless 等无 webServer
 * 形态）时平滑降级为零存在感。
 */
import { httpStateCache, type HttpStatePayload, type HttpInstanceState } from "./http-state.js";
import { notifyRunEvent, shouldNotifyRun } from "./notify.js";
import { saveRunSnapshot } from "./snapshots.js";

export type WatchEventKind = "gate" | "paused" | "done";
export interface WatchEvent {
  kind: WatchEventKind;
  runId: string;
  workflow: string;
}

export interface WatchState {
  /** runId → 上一次已通知的状态（gate/stopReason 边沿检测源） */
  runs: Map<string, { gate: unknown; stopReason?: string }>;
  /** recentEnded 消费游标：与 host history 尾部对齐，防首帧误报历史完成 */
  endedCursor: number;
}

/** 初始态：cursor=0 表示「尚未预填」，首轮以最新 endedAt 预填、不发事件 */
export function initialWatchState(): WatchState {
  return { runs: new Map(), endedCursor: 0 };
}

/** 纯差分：对比上一轮快照与当前 payload，产出需要提醒的事件与下一态（可单测） */
export function diffWatchState(prev: WatchState, payload: HttpStatePayload): { events: WatchEvent[]; next: WatchState } {
  const events: WatchEvent[] = [];
  const runs = new Map<string, { gate: unknown; stopReason?: string }>();
  for (const inst of Array.isArray(payload.instances) ? payload.instances : []) {
    const runId = String(inst?.runId ?? "");
    if (!runId) continue;
    const gate = inst.gate ?? null;
    const stopReason = inst.paused ? "failed" : undefined;
    runs.set(runId, { gate, stopReason });
    const before = prev.runs.get(runId);
    if (before) {
      const kind = shouldNotifyRun(before.stopReason, stopReason, before.gate, gate);
      if (kind) events.push({ kind, runId, workflow: String(inst.workflow ?? "") });
    }
  }

  const endedList = Array.isArray(payload.recentEnded) ? payload.recentEnded : [];
  let maxEnded = prev.endedCursor;
  for (const e of endedList) {
    const endedAt = Number(e?.endedAt ?? 0);
    if (endedAt > maxEnded) maxEnded = endedAt;
  }
  const next: WatchState = { runs, endedCursor: maxEnded };
  if (prev.endedCursor === 0) {
    // 首轮预填：把存量 history 整体当作已读，不历史轰炸
    return { events: [], next };
  }
  for (const e of endedList) {
    const endedAt = Number(e?.endedAt ?? 0);
    if (e?.status !== "completed" || !endedAt || endedAt <= prev.endedCursor) continue;
    const runId = String(e?.instId ?? "");
    if (!runId) continue;
    events.push({ kind: "done", runId, workflow: String(e?.workflow ?? "") });
  }
  return { events, next };
}

let prev: WatchState = initialWatchState();
let started = false;

function tick(): void {
  try {
    const payload = httpStateCache();
    const { events, next } = diffWatchState(prev, payload);
    prev = next;
    for (const ev of events) {
      try { notifyRunEvent(ev.runId, ev.workflow, ev.kind); } catch {}
      // 边沿落快照：结束/暂停/待审查的 run 在刷新后仍在抽屉可见（HTTP 主源缺席时）
      try {
        saveRunSnapshot({
          runId: ev.runId,
          workflow: ev.workflow,
          stopReason: ev.kind === "done" ? "done" : ev.kind === "paused" ? "failed" : undefined,
        });
      } catch {}
    }
  } catch {}
}

/** 启动全局监视（幂等；由 client.ts apply 调用一次） */
export function startNotifyWatch(intervalMs = 2500): void {
  if (started) return;
  started = true;
  tick();
  const h = window.setInterval(() => void tick(), intervalMs);
  try { window.addEventListener("unload", () => clearInterval(h), { once: true }); } catch {}
}