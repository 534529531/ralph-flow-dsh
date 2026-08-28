/**
 * Ralph Flow for dsh — 对话内嵌 run 卡片（进度/验证/审批/报告）
 *
 * 注册进 conversation.chat.node（keyed kind 'ralphflow-run'）。按数据分支渲染：
 * 步骤条 / 验证者活体面板 / 审查门（含审批材料与内联打回意见）/ 报告（Markdown
 * 渲染）/ 回退历史。全部消费 dsh 官方主题 token。
 *
 * 设计要点：
 *  - 可观测等待：验证者逐个「排队→运行中(计时)→已判定」点亮，超时进度条给
 *    等待一个终点——「在跑」和「死了」从此长得不一样。
 *  - 判断支持：审查门内嵌该步任务要求摘要；打回意见在卡内写好后随命令提交
 *   （非空意见才代提交，空意见仍只填不代发）。
 *  - 诚实状态语言：failed = ⏸ 已暂停（可恢复），不是死亡。
 */
import * as React from "react";
import { Markdown } from "./markdown.js";
import { hideRun } from "./hidden-runs.js";

export interface RalphRunCardProps {
  /** chat.node 槽组件签名：数据在 node.data（与官方 ChatNodeView 一致） */
  node?: { data?: any };
  /** 打开会话中的文件（来自 slot owner 注入） */
  openFile?: (path: string) => void;
  /** locale 翻译函数（slot locale 注入；可能缺省，缺省用内置中文兜底） */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

const NUM = { fontVariantNumeric: "tabular-nums" } as React.CSSProperties;

const STYLE = {
  root: {
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: "10px",
    background: "var(--dsw-alias-bg-layer-1)",
    padding: "12px 14px",
    margin: "6px 0",
    fontSize: "13.5px",
    lineHeight: 1.6,
  } as React.CSSProperties,
  head: {
    display: "flex" as const,
    alignItems: "center" as const,
    gap: "8px",
    marginBottom: "8px",
  },
  shrinkName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  badge: (bg: string, fg?: string) => ({
    fontSize: "11px",
    padding: "2px 8px",
    borderRadius: "999px",
    background: bg,
    color: fg || "var(--dsw-alias-label-primary-inverted)",
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
    transition: "background-color .25s ease, color .25s ease",
  }),
  steps: { display: "flex", flexWrap: "wrap" as const, gap: "6px" } as React.CSSProperties,
  step: (state: "done" | "active" | "todo" | "fail") => ({
    fontSize: "12px",
    padding: "3px 8px",
    borderRadius: "6px",
    border: "1px solid var(--dsw-alias-border-l2)",
    maxWidth: "220px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    background: state === "done"
      ? "var(--dsw-alias-state-success-tertiary)"
      : state === "active"
        ? "var(--dsw-alias-state-business-tertiary)"
        : state === "fail"
          ? "var(--dsw-alias-state-error-secondary)"
          : "transparent",
    color: state === "done"
      ? "var(--dsw-alias-state-success-primary)"
      : state === "active"
        ? "var(--dsw-alias-state-business-primary)"
        : state === "fail"
          ? "var(--dsw-alias-state-error-primary)"
          : "var(--dsw-alias-label-secondary)",
    transition: "background-color .25s ease, color .25s ease",
  }),
  verdictRow: {
    display: "flex" as const,
    alignItems: "center" as const,
    gap: "8px",
    padding: "4px 0",
    borderBottom: "1px solid var(--dsw-alias-border-l1)",
    flexWrap: "wrap" as const,
    animation: "ralphflow-row-in .3s ease",
  } as React.CSSProperties,
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", ...NUM },
  reason: {
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    maxHeight: "180px",
    overflowY: "auto" as const,
    fontSize: "12.5px",
    color: "var(--dsw-alias-label-secondary)",
  },
  task: {
    marginBottom: "6px",
    color: "var(--dsw-alias-label-secondary)",
    wordBreak: "break-word" as const,
    overflowWrap: "anywhere" as const,
    display: "-webkit-box" as const,
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden" as const,
  },
  excerpt: {
    margin: "6px 0",
    padding: "6px 8px",
    borderRadius: "6px",
    background: "var(--dsw-alias-bg-layer-2)",
    fontSize: "12.5px",
    color: "var(--dsw-alias-label-secondary)",
    maxHeight: "120px",
    overflowY: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },
  rewindRow: {
    marginTop: "6px",
    fontSize: "12px",
    padding: "4px 8px",
    borderRadius: "6px",
    background: "var(--dsw-alias-bg-layer-2)",
    color: "var(--dsw-alias-label-secondary)",
  },
  actions: {
    display: "flex" as const,
    gap: "8px",
    marginTop: "10px",
    flexWrap: "wrap" as const,
    alignItems: "center" as const,
  } as React.CSSProperties,
  btn: (kind: "primary" | "ghost") => ({
    fontSize: "12.5px",
    padding: "5px 12px",
    borderRadius: "6px",
    cursor: "pointer",
    border: "1px solid var(--dsw-alias-border-l2)",
    background: kind === "primary" ? "var(--dsw-alias-button-primary-fill)" : "transparent",
    color: kind === "primary" ? "var(--dsw-alias-label-primary-foreground)" : "var(--dsw-alias-label-primary)",
  }),
  textarea: {
    width: "100%",
    boxSizing: "border-box" as const,
    minHeight: "56px",
    resize: "vertical" as const,
    fontSize: "12.5px",
    lineHeight: 1.5,
    padding: "6px 8px",
    borderRadius: "6px",
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-2)",
    color: "var(--dsw-alias-label-primary)",
    marginTop: "6px",
  },
  chip: {
    fontSize: "11.5px",
    padding: "2px 8px",
    borderRadius: "999px",
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "transparent",
    color: "var(--dsw-alias-label-secondary)",
    cursor: "pointer",
  },
  progressTrack: {
    height: "3px",
    borderRadius: "999px",
    background: "var(--dsw-alias-bg-layer-2)",
    marginTop: "6px",
    overflow: "hidden",
  },
};

// 卡片局部动画：注入一次全局 keyframes（幂等）
const KEYFRAMES_ID = "ralphflow-keyframes";
function ensureKeyframes(): void {
  try {
    if (document.getElementById(KEYFRAMES_ID)) return;
    const el = document.createElement("style");
    el.id = KEYFRAMES_ID;
    el.textContent = `
@keyframes ralphflow-row-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes ralphflow-breath { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
`;
    document.head.appendChild(el);
  } catch {}
}

/** locale 兜底：t 缺省或键缺失时回落中文 */
function tr(t: RalphRunCardProps["t"], key: string, fallback: string): string {
  try {
    const v = t?.(key);
    return typeof v === "string" && v ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 带 {param} 插值的翻译兜底 */
function trf(t: RalphRunCardProps["t"], key: string, fallback: string, params: Record<string, unknown>): string {
  const raw = tr(t, key, fallback);
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

/** 相对时长：90s 内显示秒，之后分钟，1h 后小时 */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 实例短身份：runId 尾部 4 位——同名多实例并行时唯一可区分的视觉锚点 */
function shortRunId(runId: unknown): string | null {
  if (typeof runId !== "string" || !runId) return null;
  return runId.slice(-4);
}

function StepBar({ steps, current }: { steps: any[]; current: any }) {
  return (
    <div style={STYLE.steps}>
      {steps.map((s, i) => {
        const active = !!(current && s.id === current.step);
        const curIdx = steps.findIndex((x) => current && x.id === current.step);
        const done = !active && curIdx >= 0 && i < curIdx;
        const fail = active && (current?.failCount ?? 0) > 0;
        // 人话步骤条：desc 截断为主（hover 看 id+全文），id 才是给机器对齐的
        const label = String(s.desc ?? "").trim() || s.id || `#${i + 1}`;
        return (
          <span
            key={s.id ?? i}
            style={STYLE.step(fail ? "fail" : active ? "active" : done ? "done" : "todo")}
            title={`${s.id ?? ""}${s.desc ? ` — ${s.desc}` : ""}`}
          >
            {done ? "✓ " : ""}{label.length > 24 ? `${label.slice(0, 24)}…` : label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * 验证者活体面板：每个验证者一行，「排队 → 运行中(实时计时) → ✓/✗/⚠」。
 * 数据源：voter-start 帧（开跑时刻）+ verdict 帧（判定）。超时进度条给出
 * 等待的终点感。相邻同文的失败意见合并为一条 ×N——读一份就懂为什么被打回。
 */
function VoterPanel({
  voterStarts,
  verdicts,
  votersTotal,
  timeoutMs,
  checkStartedAt,
  now,
  t,
}: {
  voterStarts: any[];
  verdicts: any[];
  votersTotal?: number;
  timeoutMs?: number;
  checkStartedAt?: number;
  now: number;
  t: RalphRunCardProps["t"];
}) {
  const total = votersTotal && votersTotal > 0
    ? votersTotal
    : Math.max(1, ...verdicts.map((v) => v.count || 1), ...voterStarts.map((s) => s.count || 1));
  const allDone = verdicts.length >= total;
  const rows: React.ReactNode[] = [];
  for (let i = 1; i <= total; i++) {
    const verdict = verdicts.find((v) => v.voter === i);
    const start = voterStarts.find((s) => s.voter === i);
    let icon = "·";
    let iconColor = "var(--dsw-alias-label-tertiary)";
    let stateLabel = tr(t, "run.voter.queued", "排队中");
    let elapsedText = "";
    if (verdict) {
      const ok = verdict.status === "pass";
      const infra = verdict.status === "infra";
      icon = ok ? "✓" : infra ? "⚠" : "✗";
      iconColor = ok ? "var(--dsw-alias-state-success-primary)" : infra ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-error-primary)";
      stateLabel = ok ? tr(t, "run.pass", "通过") : infra ? tr(t, "run.infra", "环境故障") : tr(t, "run.fail", "未通过");
      if (start?.startedAt && verdict.arrivedAt) elapsedText = formatElapsed(verdict.arrivedAt - start.startedAt);
    } else if (start) {
      icon = "⟳";
      iconColor = "var(--dsw-alias-state-business-primary)";
      stateLabel = start.retry ? tr(t, "run.voter.retrying", "重试中") : tr(t, "run.voter.running", "运行中");
      elapsedText = formatElapsed(now - (start.startedAt || now));
    }
    rows.push(
      <div key={`v${i}`} style={STYLE.verdictRow}>
        <span aria-hidden="true" style={{ color: iconColor, ...(icon === "⟳" ? { animation: "ralphflow-breath 1.6s ease-in-out infinite", display: "inline-block" } : {}) }}>{icon}</span>
        <span style={{ color: "var(--dsw-alias-label-secondary)", ...NUM }}>{trf(t, "run.verifier", "验证者 {v}/{count}", { v: i, count: total })}</span>
        {start?.model ? <span style={STYLE.mono}>{start.model}</span> : verdict?.model ? <span style={STYLE.mono}>{verdict.model}</span> : null}
        <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-secondary)", flexShrink: 0, ...NUM }}>
          {stateLabel}{elapsedText ? ` · ${elapsedText}` : ""}
        </span>
        {verdict?.reason ? <div style={{ ...STYLE.reason, width: "100%" }}>{verdict.reason}</div> : null}
      </div>,
    );
  }
  // 超时进度条：仅验证进行中且已知上限时显示——等待有了终点
  const showProgress = !!timeoutMs && !!checkStartedAt && !allDone;
  const ratio = showProgress ? Math.min(1, Math.max(0.02, (now - (checkStartedAt || now)) / timeoutMs!)) : 0;
  const nearTimeout = showProgress && ratio > 0.8;
  return (
    <div style={{ marginTop: "8px" }}>
      {total > 1 ? (
        <div style={{ fontSize: "12px", color: "var(--dsw-alias-label-secondary)", marginBottom: "2px", ...NUM }}>
          🤖 {trf(t, "run.votes", "独立验证 · 已收 {done}/{total} 票", { done: verdicts.length, total })}
        </div>
      ) : null}
      {rows}
      {showProgress ? (
        <div>
          <div style={STYLE.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
            <div style={{
              width: `${ratio * 100}%`,
              height: "100%",
              borderRadius: "999px",
              background: nearTimeout ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-business-tertiary)",
              transition: "width 1s linear, background-color .3s ease",
            }} />
          </div>
          <div style={{ fontSize: "11px", marginTop: "2px", color: nearTimeout ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-tertiary)", ...NUM }}>
            {nearTimeout
              ? tr(t, "run.timeout.near", "接近超时上限——超时后自动暂停，已投出的票保留")
              : trf(t, "run.timeout.left", "超时上限 {min} 分钟", { min: Math.round((timeoutMs || 0) / 60000) })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 审查门卡：审批材料（该步任务要求）+ 通过/打回。打回意见直接在卡内写——
 * 非空意见随命令代提交（用户意图明确）；空意见仍只填不代发，防止盲目返工。
 */
function GateCard({ gate, t }: { gate: any; t: RalphRunCardProps["t"] }) {
  const [hint, setHint] = React.useState("");
  const [returning, setReturning] = React.useState(false);
  const [opinion, setOpinion] = React.useState("");
  const sendReturn = (): void => {
    const text = opinion.trim();
    if (!text) {
      // 空意见：只填入命令，绝不代提交——用户必须先说清为什么返工
      window.dispatchEvent(new CustomEvent("ralphflow:command", { detail: { command: "/ralphflow-reset ", autoSubmit: false } }));
      setHint(tr(t, "run.hint.return", "已在输入框填入 /ralphflow-reset——在后面补上你的修改意见再回车，模型会据此返工（不会自动发送）。"));
      return;
    }
    window.dispatchEvent(new CustomEvent("ralphflow:command", { detail: { command: `/ralphflow-reset ${text}`, autoSubmit: true } }));
    setHint(tr(t, "run.hint.returned", "打回意见已发送，模型会按你的意见返工本步骤。"));
  };
  return (
    <div>
      <div style={{ fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginTop: "8px" }}>📋 {tr(t, "run.gate", "待审查")} · {gate.title}</div>
      <div style={{ ...STYLE.reason, margin: "6px 0" }}>{gate.reason}</div>
      {gate.taskExcerpt ? (
        <div>
          <div style={{ fontSize: "11.5px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "2px" }}>{tr(t, "run.gate.requirement", "本步要求（审批材料）")}</div>
          <div style={STYLE.excerpt}>{gate.taskExcerpt}</div>
        </div>
      ) : null}
      {!returning ? (
        <div style={STYLE.actions}>
          <button
            style={STYLE.btn("primary")}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("ralphflow:command", { detail: { command: "/ralphflow-continue", autoSubmit: true } }));
              setHint(tr(t, "run.hint.approve", "已把 /ralphflow-continue 填入输入框并尝试发送——若未发出，按回车即批准进入验证。"));
            }}
          >
            ✓ {tr(t, "run.approve", "通过")}
          </button>
          <button style={STYLE.btn("ghost")} onClick={() => setReturning(true)}>
            ✗ {tr(t, "run.return", "打回")}
          </button>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: "12px", color: "var(--dsw-alias-label-secondary)", marginTop: "8px" }}>{tr(t, "run.return.opinion", "打回意见（会随命令发给模型）")}</div>
          <textarea style={STYLE.textarea} value={opinion} onChange={(e) => setOpinion(e.target.value)} placeholder={tr(t, "run.return.placeholder", "例如：边界情况没覆盖，测试全挂了，请先修 CI 再交付…")} />
          <div style={STYLE.actions}>
            {[tr(t, "run.chip.tests", "测试没过，请先修复"), tr(t, "run.chip.scope", "偏离需求范围，请对照原始任务"), tr(t, "run.chip.quality", "质量不达标，请自查后重新提交")].map((c) => (
              <button key={c} type="button" style={STYLE.chip} onClick={() => setOpinion((v) => (v ? `${v}；${c}` : c))}>{c}</button>
            ))}
          </div>
          <div style={STYLE.actions}>
            <button style={STYLE.btn("primary")} onClick={sendReturn}>{tr(t, "run.return.send", "发送打回")}</button>
            <button style={STYLE.btn("ghost")} onClick={() => { setReturning(false); setOpinion(""); }}>{tr(t, "run.cancel.action", "取消")}</button>
          </div>
        </div>
      )}
      {hint ? <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--dsw-alias-state-warn-primary)" }}>↩ {hint}</div> : null}
    </div>
  );
}

function ReportCard({ report, t }: { report: any; t: RalphRunCardProps["t"] }) {
  if (!report.text && !report.reportPath) return null;
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: "6px", color: "var(--dsw-alias-label-primary)" }}>📄 {tr(t, "run.report", "最终报告")}</div>
      {report.text ? (
        <div style={{ maxHeight: "340px", overflowY: "auto", fontSize: "13px", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "8px", padding: "10px 12px" }}>
          <Markdown text={report.text} />
        </div>
      ) : null}
      {report.reportPath ? (
        <div style={{ ...STYLE.mono, marginTop: report.text ? "6px" : 0, wordBreak: "break-all" }}>
          📁 {report.reportPath}
        </div>
      ) : null}
    </div>
  );
}

export function RalphRunCard({ node, t }: RalphRunCardProps) {
  const data = node?.data;
  // ⏱ 时长刷新时钟：事件静默期也要让计时走表；hooks 必须在 early return 之前
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  const live = !!data && !data.stopReason && typeof data.stepStartedAt === "number" && data.stepStartedAt > 0;
  const checking = !!data && !data.stopReason && !data.gate && data.current?.phase === "check";
  React.useEffect(() => {
    if (!live && !checking) return;
    const h = setInterval(tick, 5_000);
    return () => clearInterval(h);
  }, [live, checking]);

  // 注：本卡只负责渲染遗留 run 节点（历史折叠产物）。实时通知/快照/审批早已
  // 迁到页头任务列表（HeaderAction，数据源为 HTTP 状态通道）——新会话不再
  // 折叠 run 卡（宿主持久化不接受插件自定义事件帧，见 events.ts 架构说明）。
  try { ensureKeyframes(); } catch {}

  if (!data) return null;

  // 状态语言诚实性：stopReason "failed" 是可恢复暂停（continue 即可续），不是
  // 死亡——用 warn 黄而非 error 红，文案用「已暂停」，并在卡上给恢复入口。
  const isPaused = data.stopReason === "failed";
  const statusBg = data.stopReason === "done"
    ? "var(--dsw-alias-state-success-primary)"
    : isPaused
      ? "var(--dsw-alias-state-warn-tertiary)"
      : data.stopReason === "cancelled"
        ? "transparent"
        : data.gate
          ? "var(--dsw-alias-state-warn-primary)"
          : data.current?.phase === "check"
            ? "var(--dsw-alias-state-business-primary)"
            : "var(--dsw-alias-state-business-tertiary)";
  const statusFg = isPaused
    ? "var(--dsw-alias-state-warn-primary)"
    : data.stopReason === "cancelled" || (!data.stopReason && !data.gate && data.current?.phase !== "check")
      ? "var(--dsw-alias-state-business-primary)"
      : undefined;
  const statusLabel = data.stopReason === "done" ? tr(t, "run.done", "已完成")
    : data.stopReason === "cancelled" ? tr(t, "run.cancelled", "已取消")
    : isPaused ? tr(t, "run.paused", "⏸ 已暂停")
    : data.gate ? tr(t, "run.gate", "待审查")
    : data.current?.phase === "check" ? tr(t, "run.check", "验证中")
    : tr(t, "run.running", "进行中");
  // 当前步骤已运行时长：host 帧带 ts（准确历史）；定时器驱动持续刷新
  const elapsed = live ? formatElapsed(Date.now() - data.stepStartedAt) : null;
  const shortId = shortRunId(data.runId);

  return (
    <section data-ralphflow-run data-runid={String(data.runId ?? "")} style={{ ...STYLE.root, ...(data.detached ? { opacity: 0.75 } : {}) }}>
      {data.detached ? (
        <div style={{ marginBottom: "8px", padding: "5px 8px", borderRadius: "6px", background: "var(--dsw-alias-bg-layer-2)", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" }}>
          ↪ {tr(t, "run.detached", "此工作流已在另一个会话继续——本卡仅保留历史，不再更新。")}
        </div>
      ) : null}
      <div style={STYLE.head}>
        <span aria-hidden="true" style={{ fontWeight: 600, color: "var(--dsw-alias-label-primary)", flexShrink: 0 }}>🌀 Ralph Flow</span>
        <span aria-hidden="true" style={{ ...STYLE.mono, ...STYLE.shrinkName }}>{data.workflow}{shortId ? `·${shortId}` : ""}</span>
        {(data.current?.failCount ?? 0) > 0 && !data.stopReason ? (
          <span style={{ ...STYLE.mono, color: "var(--dsw-alias-state-error-primary)", flexShrink: 0 }}>×{data.current.failCount}</span>
        ) : null}
        {elapsed ? <span style={{ ...STYLE.mono, fontSize: "11px", flexShrink: 0 }} title={tr(t, "run.elapsed.title", "当前步骤已运行时长")}>⏱ {elapsed}</span> : null}
        <span style={{ marginLeft: "auto", ...STYLE.badge(statusBg, statusFg) }} role="status">{statusLabel}</span>
        {/* 终态/转交卡可手动关闭：存量僵尸卡（收不到任何终态帧的旧遗留）的
            最终出口——隐藏后该 run 的帧在折叠器层被过滤，页头同步消失 */}
        {(data.stopReason === "done" || data.stopReason === "cancelled" || data.detached) && data.runId ? (
          <button
            type="button"
            aria-label={tr(t, "run.hide", "关闭这张卡片")}
            title={tr(t, "run.hide", "关闭这张卡片")}
            style={{ border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary)", cursor: "pointer", fontSize: "13px", flexShrink: 0, padding: "0 2px" }}
            onClick={() => {
              try { hideRun(String(data.runId)); } catch {}
              try {
                // 从 DOM 移除本节点（折叠器已不再匹配该 run 的任何后续帧）
                const section = document.querySelector(`[data-ralphflow-run][data-runid="${String(data.runId).replace(/"/g, '\\"')}"]`);
                (section as HTMLElement | null)?.parentElement?.removeChild(section as Node);
              } catch {}
            }}
          >×</button>
        ) : null}
      </div>
      {data.task ? <div style={STYLE.task}>{data.task}</div> : null}
      {/* 空态活语：实例刚建还没动静时不说死话 */}
      {!Array.isArray(data.steps) || data.steps.length === 0 ? (
        <div style={{ fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary)", animation: live ? "ralphflow-breath 2.4s ease-in-out infinite" : undefined }}>
          {trf(t, "run.waiting.start", "正在等待模型开始执行…{step}", { step: data.current?.step ? `（${data.current.step}）` : "" })}
        </div>
      ) : null}
      {Array.isArray(data.steps) && data.steps.length > 0 ? <StepBar steps={data.steps} current={data.current} /> : null}
      {!isPaused && !data.stopReason ? (
        <VoterPanel
          voterStarts={Array.isArray(data.voterStarts) ? data.voterStarts : []}
          verdicts={Array.isArray(data.verdicts) ? data.verdicts : []}
          votersTotal={data.voters}
          timeoutMs={data.timeoutMs}
          checkStartedAt={data.current?.phase === "check" ? data.stepStartedAt : undefined}
          now={Date.now()}
          t={t}
        />
      ) : null}
      {Array.isArray(data.rewinds) && data.rewinds.length > 0 ? (
        <div>
          {data.rewinds.slice(-3).map((r: any, i: number) => (
            <div key={`${r.fromStep}>${r.toStep}-${i}`} style={STYLE.rewindRow}>{trf(t, "run.rewind", "↩ 回退 {from} → {to}", { from: r.fromStep, to: r.toStep })}{r.reason ? `：${String(r.reason).slice(0, 80)}` : ""}</div>
          ))}
        </div>
      ) : null}
      {data.lastCheck ? (
        <div style={{ marginTop: "6px" }}>
          <div style={{ color: data.lastCheck.passed ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)", fontWeight: 600 }}>
            {data.lastCheck.passed ? `✅ ${tr(t, "run.check.passed", "验证通过")}` : `❌ ${tr(t, "run.check.failed", "验证未通过")}`}
          </div>
          {/* 失败原因可达 2 万字符——限高滚动，不撑爆整张卡 */}
          {data.lastCheck.reason ? <div style={{ ...STYLE.reason, marginTop: "2px" }}>{data.lastCheck.reason}</div> : null}
        </div>
      ) : null}
      {isPaused ? (
        <div style={{ marginTop: "8px", padding: "6px 8px", borderRadius: "6px", background: "var(--dsw-alias-state-warn-tertiary)", fontSize: "12.5px", color: "var(--dsw-alias-label-primary)" }}>
          ⏸ {data.lastCheck && data.lastCheck.passed === false
            ? tr(t, "run.paused.hint.checkfailed", "这一步的验证没有通过，工作流停在这里等你。已完成的工作全部保留：点「继续」让模型带着失败原因重做，或用 /ralphflow-rewind 回退到更早的步骤。")
            : tr(t, "run.paused.hint", "工作流已暂停（验证未通过或达到失败上限）——这不是终点：修复问题后即可继续，已完成的工作全部保留。")}
          <div style={STYLE.actions}>
            <button
              style={STYLE.btn("primary")}
              onClick={() => {
                window.dispatchEvent(new CustomEvent("ralphflow:command", { detail: { command: "/ralphflow-continue", autoSubmit: true } }));
              }}
            >
              ▶ {tr(t, "run.resume", "继续")}
            </button>
          </div>
        </div>
      ) : null}
      {data.gate ? <GateCard gate={data.gate} t={t} /> : null}
      {data.report ? <ReportCard report={data.report} t={t} /> : null}
    </section>
  );
}

export default RalphRunCard;
