/**
 * Multi-voter CHECK (check_voting) — parallel voting + aggregation + infra retry.
 *
 * Semantics (design §4.3/§4.4/§5.3):
 *   - Aggregation priority: cancelled > failed > infra > all-pass.
 *   - All must pass. failed beats infra (a known work problem is never masked
 *     by infra votes; the infra vote re-runs on the next cross-round anyway).
 *   - infra auto-retry: at most 1 retry per pause-session; a vote that is still
 *     infra after retry → check_error pause (progress file kept, vote marked
 *     infra_failed). User continue resets infra_failed → pending (new pardon).
 *   - Progress is persisted per-instance via voting-progress.ts; any single
 *     vote completion updates the file. The state machine is only touched by
 *     the driver after this function returns.
 */

import { runSingleVoter, type CheckDeps } from "./check.js";
import type { Engine, CheckVotingEntry, NormalStepDef, AdversarialCheckConfig } from "./engine.js";
import { MAX_VOTERS } from "./engine.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  writeVotingProgress, deleteVotingProgress,
  initVotingProgress, type VotingProgress, type VoterStatus,
} from "./voting-progress.js";

type Client = any;

export interface VoterVerdict {
  index: number;
  status: "passed" | "failed" | "infra" | "cancelled";
  reason: string;
}

export interface VotingOutcome {
  kind: "passed" | "failed" | "infra_pause" | "cancelled";
  reason: string;
  verdicts: VoterVerdict[];
  /** true when the progress file must be kept (infra_pause). */
  keepProgress: boolean;
}

export interface RunVotingCheckOptions {
  /** Entry phase: "do" = fresh round (delete progress), "check" = resume. */
  phase: string;
  workflowName: string;
  /** Current persisted progress (null when none). */
  progress: VotingProgress | null;
  /** Per-vote completion callback — the driver uses it to push live progress
   *  to the user (design: 投票进度推送). Fired in completion order. */
  onVoteProgress?: (message: string) => void;
}

/**
 * Run the full voting flow for a step: decide which votes to run (fresh vs
 * resume), run them concurrently, auto-retry infra once, aggregate.
 * Never touches the state machine; returns an outcome for the driver.
 */
export async function runVotingCheck(
  deps: CheckDeps,
  engine: Engine,
  instId: string,
  ownerSessionId: string | null,
  parent: Agent | undefined,
  step: NormalStepDef,
  userTask: string | undefined,
  entries: CheckVotingEntry[],
  effective: AdversarialCheckConfig | undefined,
  opts: RunVotingCheckOptions,
): Promise<VotingOutcome> {
  const count = Math.min(entries.length, MAX_VOTERS);

  // ── Decide which votes to run ──────────────────────────────────────────────
  let progress: VotingProgress;
  let runIndices: number[];
  if (opts.phase === "do") {
    // Cross-round (DO just finished): fresh round, all votes.
    progress = initVotingProgress(step.id, opts.workflowName, entries);
    runIndices = entries.map((_, i) => i);
  } else if (opts.progress && opts.progress.stepId === step.id) {
    // Same-round resume (check_error → continue): keep passed/failed, reset
    // infra_failed → pending, run every non-terminal vote.
    progress = opts.progress;
    runIndices = [];
    for (const e of progress.entries) {
      // 防御：损坏/伪造的进度文件可能带越界 index——放进去会在 prompt 构建/
      // 聚合时 TypeError → 被 allSettled 兜成 infra → 重试仍炸 → 暂停循环。
      if (!(e.index >= 0 && e.index < entries.length)) continue;
      if (e.status === "infra_failed") {
        e.status = "pending";
        runIndices.push(e.index);
      } else if (e.status === "pending" || e.status === "running") {
        runIndices.push(e.index);
      }
    }
  } else {
    // Restart (plugin load hook cleaned the file) or stale file for another
    // step: fresh round.
    progress = initVotingProgress(step.id, opts.workflowName, entries);
    runIndices = entries.map((_, i) => i);
  }

  // ── Round 1: run the selected votes concurrently ───────────────────────────
  const onProgress = opts.onVoteProgress;
  const firstRound = await runVotes(deps, engine, instId, ownerSessionId, parent, step, userTask, entries, effective, progress, runIndices, count, false, onProgress);
  const firstPassed = firstRound.filter((v) => v.status === "passed");
  const firstFailed = firstRound.filter((v) => v.status === "failed");
  const firstInfra = firstRound.filter((v) => v.status === "infra");

  if (!engine.instanceExists(instId)) {
    return { kind: "cancelled", reason: "工作流实例已被取消。", verdicts: firstRound, keepProgress: false };
  }

  // failed beats infra: a known work problem is never masked.
  if (firstFailed.length > 0) {
    deleteVotingProgress(engine, instId);
    return { kind: "failed", reason: formatVotingFailureReason(firstRound, entries), verdicts: firstRound, keepProgress: false };
  }
  if (firstInfra.length === 0) {
    deleteVotingProgress(engine, instId);
    return { kind: "passed", reason: formatVotingPassReason(firstRound, entries), verdicts: firstRound, keepProgress: false };
  }

  // ── Round 2: auto-retry the infra votes (budget: one per pause-session) ────
  const retryIndices = firstInfra.map((v) => v.index);
  const secondRound = await runVotes(deps, engine, instId, ownerSessionId, parent, step, userTask, entries, effective, progress, retryIndices, count, true, onProgress);
  const merged = mergeVerdicts(firstRound, secondRound);
  const secondFailed = merged.filter((v) => v.status === "failed");
  const secondInfra = merged.filter((v) => v.status === "infra");

  if (!engine.instanceExists(instId)) {
    return { kind: "cancelled", reason: "工作流实例已被取消。", verdicts: merged, keepProgress: false };
  }
  if (secondFailed.length > 0) {
    deleteVotingProgress(engine, instId);
    return { kind: "failed", reason: formatVotingFailureReason(merged, entries), verdicts: merged, keepProgress: false };
  }
  if (secondInfra.length > 0) {
    // Budget exhausted → mark infra_failed (kept in file), pause the workflow.
    for (const v of secondInfra) {
      const e = progress.entries.find((p) => p.index === v.index);
      if (e) { e.status = "infra_failed"; e.reason = v.reason; }
    }
    writeVotingProgress(engine, instId, progress);
    return { kind: "infra_pause", reason: formatVotingInfraReason(secondInfra, entries), verdicts: merged, keepProgress: true };
  }
  deleteVotingProgress(engine, instId);
  return { kind: "passed", reason: formatVotingPassReason(merged, entries), verdicts: merged, keepProgress: false };
}

/**
 * Run the given vote indices concurrently, updating persisted progress as each
 * vote completes. `isRetry` marks this round as the infra auto-retry (infra
 * results become infra_pending in round 1, stay infra here → infra_failed).
 */
async function runVotes(
  deps: CheckDeps,
  engine: Engine,
  instId: string,
  ownerSessionId: string | null,
  parent: Agent | undefined,
  step: NormalStepDef,
  userTask: string | undefined,
  entries: CheckVotingEntry[],
  effective: AdversarialCheckConfig | undefined,
  progress: VotingProgress,
  indices: number[],
  count: number,
  isRetry = false,
  onProgress?: (message: string) => void,
): Promise<VoterVerdict[]> {
  const push = (verdict: VoterVerdict): void => {
    if (!onProgress) return;
    const summary = (entries[verdict.index]?.check ?? "").split("\n")[0].trim().substring(0, 24);
    const tag = `${verdict.index + 1}/${count}`;
    let mark: string;
    let suffix: string;
    if (verdict.status === "passed") {
      mark = isRetry ? "✅" : "✅";
      suffix = isRetry ? "重试通过" : "通过";
    } else if (verdict.status === "failed") {
      mark = "❌";
      suffix = isRetry ? "重试仍不通过" : "不通过";
    } else {
      mark = "⚠️";
      suffix = isRetry ? "重试仍失败，工作流将暂停" : "基础设施故障，自动重试中";
    }
    onProgress(`${mark} 验证者 ${tag}${suffix}：${summary}`);
  };

  const results = await Promise.allSettled(
    indices.map(async (idx) => {
      const entry = entries[idx];
      const pEntry = progress.entries.find((p) => p.index === idx);
      if (pEntry) {
        pEntry.status = "running";
        pEntry.reason = "";
        // 本次运行起点（UI「该票已跑 Xs」）；重试轮刷新为新一轮起点
        pEntry.startedAt = Date.now();
      }
      writeVotingProgress(engine, instId, progress);

      // 验证者启动帧：UI 把这一票从「排队」点亮为「运行中」并开始计时——
      // 黑盒期可观测（「在跑」和「死了」从此长得不一样）。
      // 注意：dsh 的 session.append 做无损 JSON 快照校验，任何 undefined 属值
      // 都会拒收整帧——可选字段必须用条件展开而不是 undefined 值。
      try {
        deps.emit(instId, "tool-ralphflow/check-voter-start", {
          runId: instId, step: step.id, voter: idx + 1, count,
          ...(typeof entry?.model === "string" && entry.model ? { model: entry.model } : {}),
          retry: isRetry, startedAt: Date.now(),
        });
      } catch {}

      const checkPrompt = engine.buildVotingCheckPrompt(instId, step, userTask, entry, idx + 1, count);
      const entryConfig: AdversarialCheckConfig = {
        ...effective,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}),
        ...(entry.system_prompt !== undefined ? { system_prompt: entry.system_prompt } : {}),
      };
      // runSingleVoter enforces its own per-vote timeout (entry.timeout_ms →
      // effective → global default) and returns infra on timeout; no outer race
      // needed (a second race would leak a dangling prompt promise + timer).
      try {
        const result = await runSingleVoter(deps, ownerSessionId, parent, instId, step, checkPrompt, userTask, entryConfig, { index: idx + 1, count });
        if (result.infra) {
          if (pEntry) { pEntry.status = isRetry ? "infra_failed" : "infra_pending"; pEntry.reason = result.reason; }
          writeVotingProgress(engine, instId, progress);
          const verdict = { index: idx, status: "infra" as const, reason: result.reason };
          push(verdict);
          return verdict;
        }
        if (result.passed) {
          if (pEntry) { pEntry.status = "passed"; pEntry.reason = result.reason; }
          writeVotingProgress(engine, instId, progress);
          const verdict = { index: idx, status: "passed" as const, reason: result.reason };
          push(verdict);
          return verdict;
        }
        if (pEntry) { pEntry.status = "failed"; pEntry.reason = result.reason; }
        writeVotingProgress(engine, instId, progress);
        const verdict = { index: idx, status: "failed" as const, reason: result.reason };
        push(verdict);
        return verdict;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (pEntry) { pEntry.status = isRetry ? "infra_failed" : "infra_pending"; pEntry.reason = msg; }
        writeVotingProgress(engine, instId, progress);
        const verdict = { index: idx, status: "infra" as const, reason: msg };
        push(verdict);
        return verdict;
      }
    }),
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { index: indices[i], status: "infra" as const, reason: String(r.reason ?? "vote runner failed") },
  );
}

function mergeVerdicts(base: VoterVerdict[], retry: VoterVerdict[]): VoterVerdict[] {
  const map = new Map<number, VoterVerdict>();
  for (const v of base) map.set(v.index, v);
  for (const v of retry) map.set(v.index, v);
  return [...map.values()].sort((a, b) => a.index - b.index);
}

const MAX_TOTAL_REASON = 24000;
const PER_FAILED_REASON = 4000;

/** Aggregate failure feedback for DO (design §4.5). */
export function formatVotingFailureReason(verdicts: VoterVerdict[], entries: CheckVotingEntry[]): string {
  const failed = verdicts.filter((v) => v.status === "failed");
  const passed = verdicts.filter((v) => v.status === "passed");
  const lines: string[] = [];
  lines.push(`多验证者检查 ${passed.length}/${entries.length} 通过,全过才放行:`);
  if (failed.length > 0) {
    lines.push("", "### ✗ 未通过的验证者(必须修复)");
    for (const v of failed) {
      const entry = entries[v.index];
      if (!entry) continue;
      const model = entry.model ? ` · ${typeof entry.model === "string" ? entry.model : entry.model.providerID + "/" + entry.model.modelID}` : "";
      lines.push("", `**验证者 ${v.index + 1}/${entries.length}${model}**`, `检查依据:${entry.check}`, `问题:`, truncate(v.reason, PER_FAILED_REASON));
    }
  }
  if (passed.length > 0) {
    lines.push("", "### ✓ 已通过的验证者(修复时不要破坏)");
    for (const v of passed) {
      const entry = entries[v.index];
      if (!entry) continue;
      const summary = v.reason.split("\n").find((l) => l.trim())?.trim() ?? "";
      lines.push(`验证者 ${v.index + 1}/${entries.length} ${entry.check.substring(0, 40)}:${truncate(summary, 400)}`);
    }
  }
  const infra = verdicts.filter((v) => v.status === "infra");
  if (infra.length > 0) {
    lines.push("", "### ⚠️ 基础设施故障票(本轮未出判定,下次重投)");
    for (const v of infra) {
      lines.push(`验证者 ${v.index + 1}/${verdicts.length}:${truncate(v.reason, 400)}`);
    }
  }
  return truncate(lines.join("\n"), MAX_TOTAL_REASON);
}

/** Aggregate pass feedback (design §4.6). */
export function formatVotingPassReason(verdicts: VoterVerdict[], entries: CheckVotingEntry[]): string {
  const lines = [`${verdicts.length}/${verdicts.length} 验证者全过:`];
  for (const v of verdicts) {
    const entry = entries[v.index];
    if (!entry) continue;
    const summary = v.reason.split("\n").find((l) => l.trim())?.trim() ?? "";
    lines.push(`[✓] ${v.index + 1}/${entries.length} ${entry.check.substring(0, 30)}:${truncate(summary, 160)}`);
  }
  return truncate(lines.join("\n"), MAX_TOTAL_REASON);
}

/** Infra pause reason for the user (design §9 scenario 3). */
export function formatVotingInfraReason(infraVotes: VoterVerdict[], entries: CheckVotingEntry[]): string {
  const lines: string[] = [];
  for (const v of infraVotes) {
    lines.push(`验证者 ${v.index + 1}/${entries.length}${entries[v.index] ? `(${entries[v.index].check.substring(0, 30)})` : ""} 重试后仍无法运行:${truncate(v.reason, 800)}`);
  }
  return truncate(lines.join("\n"), MAX_TOTAL_REASON);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.substring(0, max) + "…" : text;
}

/** Status letter for TUI/status summaries. */
export function voterStatusLabel(status: VoterStatus): string {
  switch (status) {
    case "passed": return "✓";
    case "failed": return "✗";
    case "running": return "⏳";
    case "infra_pending": return "♻";
    case "infra_failed": return "⚠";
    case "cancelled": return "⊘";
    default: return "·";
  }
}
