/**
 * Ralph Flow for dsh v2 — 多验证者投票（`check_voting`）的纯函数层。
 *
 * 对应 opencode 版 `src/check-voting.ts` + `src/voting-progress.ts`：**行为逐条对齐，载体按
 * dsh 的无相位模型落地**。两处刻意的载体差异（见 `docs/v2/design.md` §4 与变更说明）：
 *
 *   1. **聚合与文案**（本文件）：`failed > infra > 全过` 的优先级、失败/通过/故障三份聚合
 *      文案、每票实时进度行 —— 与 opencode 的 `formatVoting*Reason` / `push()` 同构，
 *      抽成不碰状态机的纯函数（T2：推进只能由引擎按判定算出，文案层不做任何决策）。
 *   2. **进度不另立文件**：opencode 把每票状态写进 `.check-voting-progress.json`，是因为它的
 *      driver 是**每个事件一个新进程**、内存结果不可靠。dsh 的判定与在飞委派本来就原子落盘在
 *      `state.json`（`verdicts[]` + `delegations[]`），同一进程内直接由此现算每票状态即可；
 *      再写一份进度文件就是**第二个事实源**（宪法 §10.4：派生量不落盘），会让「票没了但文件
 *      说还在」这类分歧成为可能。
 */

/** 一个步骤最多几个验证者（照抄 opencode `MAX_VOTERS`） */
export const MAX_VOTERS = 5;

/** 投票条目在纯函数层的最小形态（与 `engine.CheckVotingEntry` 结构兼容，避免循环依赖） */
export interface VotingBasis {
  check: string;
  model?: string | { providerID?: string; modelID?: string };
}

/** 单票的终态（`cancelled` 在 dsh 里不存在：取消 = 实例销毁，迟到判定在引擎侧被丢弃） */
export type VoterVerdictStatus = "passed" | "failed" | "infra";

export interface VoterVerdict {
  /** 0 起的票号（与 `Verdict.check_index` 同值） */
  index: number;
  status: VoterVerdictStatus;
  reason: string;
}

export type VotingOutcome = "passed" | "failed" | "infra";

/**
 * 聚合优先级（照抄 opencode 决策表，去掉 dsh 不存在的 cancelled 支）：
 * **failed > infra > 全过** —— 已知的工作问题绝不被基础设施故障遮蔽；只有一票都没判失败、
 * 但有票故障时才走 infra（自动重试 / 暂停）。
 */
export function decideVotingOutcome(verdicts: readonly VoterVerdict[]): VotingOutcome {
  if (verdicts.some((v) => v.status === "failed")) return "failed";
  if (verdicts.some((v) => v.status === "infra")) return "infra";
  return "passed";
}

const MAX_TOTAL_REASON = 24000;
const PER_FAILED_REASON = 4000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.substring(0, max)}…` : text;
}

/** 条目检查依据的单行摘要（换行折平 + 截断），用于进度行与聚合文案的标题 */
function basisSummary(entry: VotingBasis | undefined, max: number): string {
  const first = (entry?.check ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  return truncate(first, max);
}

/** 条目模型的展示形态：` · provider/model`（没配则空串） */
function modelLabel(entry: VotingBasis | undefined): string {
  const m = entry?.model;
  if (!m) return "";
  if (typeof m === "string") return ` · ${m}`;
  const pid = m.providerID ?? "";
  const mid = m.modelID ?? "";
  return pid || mid ? ` · ${pid}/${mid}` : "";
}

/** 判定理由的首行摘要（opencode 的 `v.reason.split("\n").find(...)`） */
function reasonSummary(reason: string): string {
  return reason.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/**
 * 失败反馈聚合（给 DO 的 reason）—— 照抄 opencode §4.5 的结构：
 * 失败者在前（完整 reason + **该票的检查依据原文**，DO 没看过 check_voting 配置），
 * 通过者在后（一行摘要，提醒修复时不要破坏已确认的部分）。
 */
export function formatVotingFailureReason(
  verdicts: readonly VoterVerdict[],
  entries: readonly VotingBasis[],
  count: number,
): string {
  const failed = verdicts.filter((v) => v.status === "failed");
  const passed = verdicts.filter((v) => v.status === "passed");
  const infra = verdicts.filter((v) => v.status === "infra");
  const lines: string[] = [];
  lines.push(`多验证者检查 ${passed.length}/${count} 通过，全过才放行：`);
  if (failed.length > 0) {
    lines.push("", "### ✗ 未通过的验证者（必须修复）");
    for (const v of failed) {
      const entry = entries[v.index];
      lines.push(
        "",
        `**验证者 ${v.index + 1}/${count}${modelLabel(entry)}**`,
        `检查依据：${entry?.check ?? "（缺失）"}`,
        "问题：",
        truncate(v.reason, PER_FAILED_REASON),
      );
    }
  }
  if (passed.length > 0) {
    lines.push("", "### ✓ 已通过的验证者（修复时不要破坏）");
    for (const v of passed) {
      lines.push(`验证者 ${v.index + 1}/${count} ${basisSummary(entries[v.index], 40)}：${truncate(reasonSummary(v.reason), 400)}`);
    }
  }
  if (infra.length > 0) {
    lines.push("", "### ⚠️ 基础设施故障票（本轮未出判定，下次重投）");
    for (const v of infra) {
      lines.push(`验证者 ${v.index + 1}/${count}：${truncate(v.reason, 400)}`);
    }
  }
  return truncate(lines.join("\n"), MAX_TOTAL_REASON);
}

/** 通过反馈聚合（照抄 opencode §4.6）：每票一行确认 */
export function formatVotingPassReason(
  verdicts: readonly VoterVerdict[],
  entries: readonly VotingBasis[],
  count: number,
): string {
  const lines = [`${count}/${count} 验证者全过：`];
  for (const v of [...verdicts].sort((a, b) => a.index - b.index)) {
    lines.push(`[✓] ${v.index + 1}/${count} ${basisSummary(entries[v.index], 30)}：${truncate(reasonSummary(v.reason), 160)}`);
  }
  return truncate(lines.join("\n"), MAX_TOTAL_REASON);
}

/** 基础设施故障暂停时给用户的 reason（照抄 opencode §9 场景 3 的口径） */
export function formatVotingInfraReason(
  verdicts: readonly VoterVerdict[],
  entries: readonly VotingBasis[],
  count: number,
): string {
  const lines: string[] = [];
  for (const v of verdicts.filter((x) => x.status === "infra").sort((a, b) => a.index - b.index)) {
    lines.push(`验证者 ${v.index + 1}/${count}（${basisSummary(entries[v.index], 30)}）重试后仍无法运行：${truncate(v.reason, 800)}`);
  }
  return truncate(lines.join("\n"), MAX_TOTAL_REASON);
}

/**
 * 每票完成时的实时进度行（照抄 opencode `push()` 的标记与措辞）。
 *
 * 返回 `{ text, summary }`：`summary` 是用户时间线上不展开就可见的那一行（dsh 的可见性契约，
 * ≤120 字符，见 `scripts/visibility-test.mjs`），`text` 是完整行。
 */
export function voterProgressLine(
  verdict: VoterVerdict,
  entry: VotingBasis | undefined,
  count: number,
  isRetry: boolean,
): { text: string; summary: string } {
  const tag = `${verdict.index + 1}/${count}`;
  const basis = basisSummary(entry, 24);
  const mark = verdict.status === "passed" ? "✅" : verdict.status === "failed" ? "❌" : "⚠️";
  const suffix = verdict.status === "passed"
    ? (isRetry ? "重试通过" : "通过")
    : verdict.status === "failed"
      ? (isRetry ? "重试仍不通过" : "不通过")
      : (isRetry ? "重试仍失败，工作流将暂停" : "基础设施故障，自动重试中");
  return {
    text: `${mark} 验证者 ${tag} ${suffix}：${basis}`,
    summary: `${mark} 验证者 ${tag} ${suffix}${basis ? `：${basis}` : ""}`,
  };
}

/** 状态展示用的票状态标签（照抄 opencode `voterStatusLabel`，去掉 dsh 不存在的 cancelled） */
export type VoterDisplayStatus = "pending" | "running" | "passed" | "failed" | "infra";

export function voterStatusLabel(status: VoterDisplayStatus): string {
  switch (status) {
    case "passed": return "✓";
    case "failed": return "✗";
    case "running": return "⏳";
    case "infra": return "⚠";
    default: return "·";
  }
}
