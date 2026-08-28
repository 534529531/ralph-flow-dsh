/**
 * Voting progress persistence (.check-voting-progress.json).
 *
 * Multi-voter CHECK progress must survive across: concurrent voters, infra
 * auto-retry, check_error pause, user continue. These events may happen in
 * different processes/sessions, so progress is persisted per-instance.
 *
 * Lifecycle (design §5.3):
 *   - entry with phase="do"            → delete (new round, all re-vote)
 *   - entry with phase="check" + file  → keep; infra_failed reset to pending
 *   - entry with phase="check" no file → all re-vote (restart, plugin hook)
 *   - aggregate done (pass/fail)       → delete
 *   - check_error pause                → keep
 *   - crash recovery / reset/rewind/cancel → delete
 */

import fs from "fs";
import path from "path";
import type { Engine, CheckVotingEntry } from "./engine.js";
import { VOTING_PROGRESS_FILENAME } from "./engine.js";

export type VoterStatus =
  | "pending"        // not started
  | "running"        // in flight
  | "passed"         // terminal
  | "failed"         // terminal (work problem)
  | "infra_pending"  // needs auto-retry (this round's budget not yet spent)
  | "infra_failed"   // auto-retry exhausted → check_error pause; continue resets to pending
  | "cancelled";     // user cancelled / instance deleted

export interface VoterProgressEntry {
  index: number;
  check: string;
  model: string | null;
  status: VoterStatus;
  reason: string;
  /** 本次运行开始时刻（ms）——UI 用它显示「该票已跑 Xs」；retry 轮会刷新 */
  startedAt?: number;
}

export interface VotingProgress {
  stepId: string;
  workflowName: string;
  entries: VoterProgressEntry[];
  updatedAt: string;
}

export function progressFilePath(engine: Engine, instId: string): string {
  return path.join(engine.getInstanceDir(instId), VOTING_PROGRESS_FILENAME);
}

export function initVotingProgress(stepId: string, workflowName: string, entries: CheckVotingEntry[]): VotingProgress {
  return {
    stepId,
    workflowName,
    entries: entries.map((e, i) => ({
      index: i,
      check: e.check,
      model: typeof e.model === "string" ? e.model : e.model ? `${e.model.providerID ?? ""}/${e.model.modelID ?? ""}` : null,
      status: "pending",
      reason: "",
    })),
    updatedAt: new Date().toISOString(),
  };
}

export function readVotingProgress(engine: Engine, instId: string): VotingProgress | null {
  try {
    const file = progressFilePath(engine, instId);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) return null;
    const entries: VoterProgressEntry[] = raw.entries
      .filter((e: any) => e && typeof e === "object" && typeof e.index === "number")
      .map((e: any) => ({
        index: e.index,
        check: typeof e.check === "string" ? e.check : "",
        model: typeof e.model === "string" ? e.model : null,
        status: (["pending", "running", "passed", "failed", "infra_pending", "infra_failed", "cancelled"] as const).includes(e.status)
          ? e.status
          : "pending",
        reason: typeof e.reason === "string" ? e.reason : "",
        // startedAt 透传：check-voting 在 running 时写入，回读时必须保留，
        // 否则「读取→改状态→写回」会把运行时长丢掉
        ...(typeof e.startedAt === "number" && e.startedAt > 0 ? { startedAt: e.startedAt } : {}),
      }));
    return {
      stepId: typeof raw.stepId === "string" ? raw.stepId : "",
      workflowName: typeof raw.workflowName === "string" ? raw.workflowName : "",
      entries,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeVotingProgress(engine: Engine, instId: string, progress: VotingProgress): void {
  try {
    // 防复活：cancel 可插在任一在飞 vote 回调之前——实例目录已删时绝不重建，
    // 否则 destroyInstance 后会留下幽灵目录（doctor 持续报缺 state.json）。
    if (!engine.instanceExists(instId)) return;
    const file = progressFilePath(engine, instId);
    if (!fs.existsSync(path.dirname(file))) return;
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

export function deleteVotingProgress(engine: Engine, instId: string): void {
  try { fs.unlinkSync(progressFilePath(engine, instId)); } catch {}
}
