/**
 * Ralph Flow for dsh — 页头入口 + 控制中心抽屉
 *
 * 注册进 conversation.session.header.actions（list 槽）。三层结构：
 *  1) trigger：状态点 + 活跃计数 + 当前活跃 run 的「步骤 · 阶段」微缩——
 *     不点开也能瞄到跑到哪了（mini pipeline 的页头形态）；
 *  2) 抽屉「进行中」区：每个 run 一行（pipeline 步骤条 desc 版 + 状态），
 *     点击滚动定位到对话里的卡，旁有 status 按钮；
 *  3) 抽屉「已结束」区：本会话 done/cancelled 的历史（可回看定位）。
 * 无任务时保留冷启动上手卡。样式全部消费 dsh 官方主题 token。
 */
import * as React from "react";
import { RALPHFLOW_RUN_KIND } from "./definition.js";
import { loadRunSnapshots, isRunHiddenSnap } from "./snapshots.js";
import { useRalphHttpState, checkTimeLeft, type HttpInstanceState, type HttpStatePayload } from "./http-state.js";

export interface HeaderActionProps {
  sessionId?: string;
  /** 当前会话 chat store 的 hook（conversation 槽框架注入；官方 StatsLine 同款） */
  useSession?: (selector: (state: any) => any, eq?: (a: any, b: any) => boolean) => any;
  /** 旧参数名保留兼容（早期误用会话列表 store——其 state 无 chat 字段，collectRuns 恒空） */
  useSessions?: (selector: (state: any) => any, eq?: (a: any, b: any) => boolean) => any;
  /** locale 翻译函数（slot locale 注入；可能缺省，缺省用内置中文兜底） */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

/** locale 兜底：t 缺省或键缺失时回落中文 */
function tr(t: HeaderActionProps["t"], key: string, fallback: string): string {
  try {
    const v = t?.(key);
    return typeof v === "string" && v ? v : fallback;
  } catch {
    return fallback;
  }
}

interface RunSummary {
  key: string;
  runId: string;
  workflow: string;
  task: string;
  steps: { id: string; desc: string }[];
  current: { step: string; phase: "do" | "check"; failCount: number } | null;
  gate: unknown;
  stopReason?: string;
  stepStartedAt?: number;
  status: string;
  /** 已结束实例的最终报告路径（recentEnded 带来，「报告」按钮的数据源） */
  reportPath?: string;
}

const NUM = { fontVariantNumeric: "tabular-nums" } as React.CSSProperties;

/** 从守护 job（label/output）解析 run 摘要——官方 JobListAction 同源的 jobs store */
function runFromJob(job: any): RunSummary | null {
  try {
    const label = String(job?.label ?? "");
    if (!label.startsWith("ralphflow")) return null;
    const parts = label.split(/\s+/);
    const instId = parts[2] ?? "";
    if (!instId) return null;
    // readOutput: "ralphflow <workflow> <step> <DO|CHECK> fail=<n>[ paused]"
    const m = /^ralphflow\s+\S+\s+(\S+)\s+(\S+)\s+fail=(\d+)( paused)?/.exec(String(job?.output ?? ""));
    const step = m?.[1] ?? "";
    const phase = m?.[2] === "CHECK" ? "check" : "do";
    const paused = !!m?.[4];
    const live = job.status === "running" || job.status === "stopping";
    const status = !live ? "done" : paused ? "failed" : phase === "check" ? "check" : "do";
    return {
      key: `job-${instId}`,
      runId: instId,
      workflow: parts[1] ?? "",
      task: "",
      steps: [],
      current: step ? { step, phase, failCount: Number(m?.[3] ?? 0) } : null,
      gate: null,
      stopReason: undefined,
      stepStartedAt: typeof job.startedAt === "number" ? job.startedAt : undefined,
      status,
    };
  } catch {
    return null;
  }
}

/** HTTP 状态通道（全局、最新）→ RunSummary */
function runFromHttp(r: HttpInstanceState): RunSummary {
  const phase = r.current?.phase ?? "do";
  const status = r.paused ? "failed"
    : r.gate ? "gate"
      : phase === "check" ? "check"
        : "do";
  return {
    key: `http-${r.runId}`,
    runId: r.runId,
    workflow: r.workflow ?? "",
    task: r.task ?? "",
    steps: Array.isArray(r.steps) ? r.steps : [],
    current: r.current ? { step: r.current.step, phase: (phase === "check" ? "check" : "do"), failCount: r.current.failCount ?? 0 } : null,
    gate: r.gate ?? null,
    stopReason: r.paused ? "failed" : undefined,
    stepStartedAt: r.startedAt ? Date.parse(String(r.startedAt)) : undefined,
    status,
  };
}

/** 三源合并：HTTP 全局状态（最新）→ 已结束历史（recentEnded）→ chat.nodes（实时补充）→ 快照（离线兜底） */
function collectRuns(nodes: any, jobs: any[], http: HttpInstanceState[], ended: HttpStatePayload["recentEnded"]): RunSummary[] {
  const out: RunSummary[] = [];
  const seen = new Set<string>();
  try {
    for (const r of Array.isArray(http) ? http : []) {
      if (!r?.runId) continue;
      seen.add(r.runId);
      out.push(runFromHttp(r));
    }
  } catch {}
  try {
    // 已结束实例（host history 尾部）：报告按钮 + 结束后仍可定位
    for (const e of Array.isArray(ended) ? ended : []) {
      const runId = String(e?.instId ?? "");
      if (!runId || seen.has(runId)) continue;
      const completed = e?.status === "completed";
      if (e?.status !== "completed" && e?.status !== "cancelled") continue;
      seen.add(runId);
      out.push({
        key: `end-${runId}`,
        runId,
        workflow: String(e?.workflow ?? ""),
        task: String(e?.task ?? ""),
        steps: [],
        current: null,
        gate: null,
        stopReason: completed ? "done" : "cancelled",
        status: completed ? "done" : "cancelled",
        reportPath: typeof e?.reportPath === "string" && e.reportPath ? e.reportPath : undefined,
      });
    }
  } catch {}
  try {
    if (nodes) {
      const values = typeof nodes.values === "function" ? nodes.values() : [];
      for (const node of values) {
        if (!node || node.kind !== RALPHFLOW_RUN_KIND) continue;
        const d = node.data ?? {};
        const runId = String(d.runId ?? node.id ?? "");
        if (!runId || seen.has(runId)) continue;
        seen.add(runId);
        const status = d.detached ? "detached"
          : d.stopReason === "done" ? "done"
            : d.stopReason === "cancelled" ? "cancelled"
              : d.stopReason === "failed" ? "failed"
                : d.gate ? "gate"
                  : d.current?.phase === "check" ? "check" : "do";
        out.push({
          key: String(node.key ?? node.id ?? ""),
          runId,
          workflow: d.workflow ?? "",
          task: d.task ?? "",
          steps: Array.isArray(d.steps) ? d.steps : [],
          current: d.current ?? null,
          gate: d.gate,
          stopReason: d.stopReason,
          stepStartedAt: typeof d.stepStartedAt === "number" ? d.stepStartedAt : undefined,
          status,
        });
      }
    }
  } catch {}
  try {
    for (const job of Array.isArray(jobs) ? jobs : []) {
      const r = runFromJob(job);
      if (!r || seen.has(r.runId)) continue;
      seen.add(r.runId);
      out.push(r);
    }
  } catch {}
  // 快照兜底：无 HTTP 通道/离线时仍有可导航的历史
  try {
    const snaps = loadRunSnapshots();
    for (const [runId, s] of Object.entries(snaps)) {
      if (seen.has(runId) || isRunHiddenSnap(runId)) continue;
      const status = s.detached ? "detached"
        : s.stopReason === "done" ? "done"
          : s.stopReason === "cancelled" ? "cancelled"
            : s.stopReason === "failed" ? "failed"
              : s.gate ? "gate"
                : (s as { current?: { phase?: string } }).current?.phase === "check" ? "check" : "do";
      out.push({
        key: `snap-${runId}`,
        runId,
        workflow: String(s.workflow ?? ""),
        task: String(s.task ?? ""),
        steps: Array.isArray(s.steps) ? (s.steps as { id: string; desc: string }[]) : [],
        current: (s.current as RunSummary["current"]) ?? null,
        gate: s.gate,
        stopReason: s.stopReason as string | undefined,
        stepStartedAt: typeof s.stepStartedAt === "number" ? s.stepStartedAt : undefined,
        status,
      });
    }
  } catch {}
  return out;
}

/** 状态 → 语义色 token（全插件统一：卡片徽标/页头/步骤条同一套） */
export function statusColorOf(s: string): string {
  return s === "done" ? "var(--dsw-alias-state-success-primary)"
    : s === "failed" ? "var(--dsw-alias-state-warn-primary)"
      : s === "gate" ? "var(--dsw-alias-state-warn-primary)"
        : s === "check" ? "var(--dsw-alias-state-business-primary)"
          : s === "cancelled" || s === "detached" ? "var(--dsw-alias-label-tertiary)"
            : "var(--dsw-alias-state-business-tertiary)";
}

const STATUS_KEY: Record<string, string> = {
  done: "status.done", cancelled: "status.cancelled", failed: "status.failed",
  gate: "status.gate", check: "status.check", do: "status.do", detached: "status.detached",
};
const STATUS_FALLBACK: Record<string, string> = {
  done: "已完成", cancelled: "已取消", failed: "已暂停",
  gate: "待审查", check: "验证中", do: "进行中", detached: "已转交",
};
const statusLabelOf = (t: HeaderActionProps["t"], s: string): string =>
  tr(t, STATUS_KEY[s] ?? "status.do", STATUS_FALLBACK[s] ?? STATUS_FALLBACK.do);

/** 带参数的翻译兜底（{n} 插值） */
function trf2(t: HeaderActionProps["t"], key: string, fallback: string, params: Record<string, unknown>): string {
  return tr(t, key, fallback).replace(/\{(\w+)\}/g, (_, k: string) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

/**
 * 动作直连通道：POST → host 的 /ralphflow/instances 动作端点（webServer 路由，
 * 与状态轮询同源同通道）。不再依赖「往输入框填命令 + 合成 Enter」的脆弱链路：
 * 通过/打回/恢复都可从抽屉一键直达，host 侧按白名单动作 + sessionId 解析 agent
 * 执行工具并（需要时）followup 注入模型。POST 失败时调用方回退到命令注入。
 */
export async function postAction(
  sessionId: string | undefined,
  payload: { action: string; runId?: string; reason?: string },
): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await fetch("/ralphflow/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sessionId: sessionId ?? "" }),
    });
    let data: { ok?: boolean; text?: string; error?: string } = {};
    try { data = (await res.json()) as typeof data; } catch {}
    if (res.ok && data?.ok) return { ok: true, text: String(data.text ?? "已提交。") };
    return { ok: false, text: String(data?.text ?? data?.error ?? (res.ok ? "请求未确认。" : `HTTP ${res.status}`)) };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 步骤节点的人话标签：desc 截断优先，id 兜底 */
function stepLabel(s: { id?: string; desc?: string }): string {
  const d = String(s?.desc ?? "").trim();
  return d.length > 0 ? (d.length > 10 ? `${d.slice(0, 10)}…` : d) : String(s?.id ?? "?");
}

/** mini pipeline：一行步骤节点（✓ 已过 / ● 当前 / ○ 待做），当前节点带呼吸 */
function MiniPipeline({ steps, current, status }: { steps: RunSummary["steps"]; current: RunSummary["current"]; status: string }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const curIdx = steps.findIndex((s) => current && s.id === current.step);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", minWidth: 0, overflow: "hidden" }}>
      {steps.slice(0, 6).map((s, i) => {
        const active = !!(current && s.id === current.step);
        const done = !active && curIdx >= 0 && i < curIdx;
        const color = done ? "var(--dsw-alias-state-success-primary)" : active ? statusColorOf(status) : "var(--dsw-alias-label-tertiary)";
        return (
          <span
            key={s.id ?? i}
            title={`${s.id ?? ""}${s.desc ? ` — ${s.desc}` : ""}`}
            style={{ display: "inline-flex", alignItems: "center", gap: "3px", flexShrink: i > 2 ? 1 : 0, minWidth: 0 }}
          >
            <span aria-hidden="true" style={{ fontSize: "10.5px", color }}>{done ? "✓" : active ? "●" : "○"}</span>
            {active ? (
              <span style={{ fontSize: "11px", color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stepLabel(s)}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

const style = {
  root: { position: "relative" as const, display: "inline-block" },
  trigger: {
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: "6px",
    padding: "4px 10px",
    borderRadius: "8px",
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "transparent",
    color: "var(--dsw-alias-label-primary)",
    fontSize: "12.5px",
    cursor: "pointer" as const,
    maxWidth: "420px",
  },
  menu: {
    position: "absolute" as const,
    right: 0,
    top: "calc(100% + 6px)",
    width: "340px",
    maxHeight: "70vh",
    overflowY: "auto" as const,
    background: "var(--dsw-alias-bg-layer-3)",
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: "10px",
    padding: "8px",
    zIndex: 50,
    boxShadow: "var(--dsw-shadow-lv2)",
  },
  row: {
    display: "flex" as const,
    alignItems: "center" as const,
    gap: "8px",
    padding: "7px 8px",
    borderRadius: "6px",
    fontSize: "12.5px",
    cursor: "pointer" as const,
    border: "none",
    width: "100%",
    textAlign: "left" as const,
    background: "transparent",
  },
};

const badgeWarn: React.CSSProperties = {
  fontSize: "11px", lineHeight: 1, padding: "2px 8px", borderRadius: "999px",
  background: "var(--dsw-alias-state-warn-tertiary)", color: "var(--dsw-alias-state-warn-primary)",
  fontWeight: 600,
};
const badgeFail: React.CSSProperties = {
  fontSize: "11px", lineHeight: 1, padding: "2px 8px", borderRadius: "999px",
  background: "var(--dsw-alias-state-error-secondary)", color: "var(--dsw-alias-state-error-primary)",
  fontWeight: 600,
};

/** 滚动定位到对话里对应 run 卡（导航的落点；找不到时降级为 status 命令） */
function scrollToRun(runId: string): boolean {
  try {
    const el = document.querySelector<HTMLElement>(`[data-ralphflow-run][data-runid="${CSS.escape(runId)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "box-shadow .3s ease";
      el.style.boxShadow = "0 0 0 2px var(--dsw-alias-state-business-primary)";
      setTimeout(() => { try { el.style.boxShadow = ""; } catch {} }, 1600);
      return true;
    }
  } catch {}
  return false;
}

export function HeaderAction({ sessionId, useSession, useSessions, t }: HeaderActionProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  // hooks 必须在组件顶层无条件调用（不得包进条件分支——违反 hooks 规则会
  // 导致 React 状态错乱崩溃）。prop 缺省时传恒空实现保持 hooks 数量稳定。
  // 数据源（官方 JobListAction 同款契约）：
  //  - useSessions = sessions store（含 jobsBySession）——本会话守护 job 列表
  //  - useSession  = 当前会话 chat store（实时卡数据；框架 scope=session 时注入）
  const useSessionsSafe = useSessions ?? ((_sel: any) => undefined);
  const useSessionSafe = useSession ?? ((_sel: any) => undefined);
  const jobs = useSessionsSafe((s: any) => (sessionId && s?.jobsBySession ? s.jobsBySession[sessionId] : undefined));
  const nodes = useSessionSafe((s: any) => s?.chat?.nodes);
  const http = useRalphHttpState();
  const runs: RunSummary[] = React.useMemo(() => collectRuns(nodes, jobs, http.instances, http.recentEnded), [nodes, jobs, http.instances, http.recentEnded]);

  // ── 动作状态：抽屉内审批/打回/恢复/取消的进行中与反馈 ───────────────────
  const [busyRun, setBusyRun] = React.useState<string | null>(null);
  const [actionMsg, setActionMsg] = React.useState<{ runId: string; ok: boolean; text: string } | null>(null);
  const [returnFor, setReturnFor] = React.useState<string | null>(null);
  const [returnText, setReturnText] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState<string | null>(null);
  const returnRef = React.useRef<HTMLTextAreaElement>(null);
  // 动作反馈自动消隐（成功/失败可见 8 秒，不占位）
  const msgTimer = React.useRef<number | null>(null);

  // 注：通知/快照由全局监视器（notify-watch.ts）负责——组件只挂会话页头，
  // 空态页/其它会话时审查门到达也得提醒。组件这里只做展示与动作。

  // 抽屉内计时刷新（运行中的 run 显示已用时）
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!open) return;
    const h = setInterval(tick, 5000);
    return () => clearInterval(h);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        setReturnFor(null);
        setExpanded(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 返回（打回）意见输入框打开时聚焦
  React.useEffect(() => {
    if (returnFor) {
      try { returnRef.current?.focus(); } catch {}
    }
  }, [returnFor]);

  // 动作执行（POST 直连；失败退回命令注入）
  const runAction = async (runId: string, action: "approve" | "resume" | "return" | "cancel", reason?: string): Promise<void> => {
    if (busyRun) return;
    setBusyRun(runId);
    setActionMsg(null);
    const res = await postAction(sessionId, { action, runId, reason });
    setBusyRun(null);
    setActionMsg({ runId, ok: res.ok, text: res.text });
    if (msgTimer.current) window.clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setActionMsg(null), 8000);
    if (res.ok) {
      setReturnFor(null);
      setReturnText("");
      setExpanded(null);
      setConfirmCancel(null);
    } else if (action === "approve" || action === "resume") {
      // 直连失败（如 headless 形态无 webServer）：退回旧链路——填命令进输入框
      window.dispatchEvent(new CustomEvent("ralphflow:command", {
        detail: { command: action === "approve" ? "/ralphflow-continue" : "/ralphflow-continue", autoSubmit: true },
      }));
    }
  };

  const toggleDetail = (r: RunSummary): void => {
    setExpanded((cur) => (cur === r.runId ? null : r.runId));
    setReturnFor(null);
  };

  // 计数语义收紧：live 只指真正在跑的（do/check）。「已暂停」是等你处理，
  // 走自己的徽标；「已转交」既不在跑也无需处理，两者都不该叫「运行中」。
  const live = runs.filter((r: RunSummary) => r.status === "do" || r.status === "check");
  const waiting = runs.filter((r: RunSummary) => r.status === "gate" || r.status === "failed");
  const ended = runs.filter((r: RunSummary) => r.status === "done" || r.status === "cancelled" || r.status === "detached");
  const liveCount = live.length;
  const gateCount = waiting.filter((r: RunSummary) => r.status === "gate").length;
  const failCount = waiting.filter((r: RunSummary) => r.status === "failed").length;
  // trigger 微缩：第一个活跃 run 的当前步（多数场景只有一个活跃实例）
  const primary = live[0] ?? waiting[0];

  const locateRun = (r: RunSummary): void => {
    if (!scrollToRun(r.runId)) {
      // 卡不在 DOM（已被折叠回收等）：退化为 status 文本查询，信息不丢
      window.dispatchEvent(new CustomEvent("ralphflow:command", { detail: { command: `/ralphflow-status ${r.runId || r.workflow}` } }));
    }
  };

  /** 验证票状态 → 本地化标签（引擎枚举是中英词典的键） */
const VOTER_STATUS_KEYS: Record<string, string> = {
  pending: "voter.status.pending", running: "voter.status.running", passed: "voter.status.passed",
  failed: "voter.status.failed", infra_pending: "voter.status.infra_pending", infra_failed: "voter.status.infra_failed",
  cancelled: "voter.status.cancelled",
};
const VOTER_STATUS_FALLBACK: Record<string, string> = {
  pending: "排队中", running: "运行中", passed: "通过", failed: "未通过",
  infra_pending: "环境重试", infra_failed: "环境故障", cancelled: "已取消",
};
const voterLabel = (t: HeaderActionProps["t"], status: string): string =>
  tr(t, VOTER_STATUS_KEYS[status] ?? "voter.status.pending", VOTER_STATUS_FALLBACK[status] ?? status);

/** 验证票状态 → 语义色（通过绿/失败红/运行蓝/等） */
function voterColor(status: string): string {
  return status === "passed" ? "var(--dsw-alias-state-success-primary)"
    : status === "failed" || status === "infra_failed" ? "var(--dsw-alias-state-error-primary)"
      : status === "running" || status === "infra_pending" ? "var(--dsw-alias-state-business-primary)"
        : "var(--dsw-alias-label-tertiary)";
}

const renderRow = (r: RunSummary): React.ReactNode => {
    // 详情面板数据源：HTTP 快照为该 run 的富字段（失败原因全文/暂停原因/票）
    const detail = Array.isArray(http.instances) ? http.instances.find((i) => String(i.runId) === r.runId) : undefined;
    const isExpanded = expanded === r.runId;
    const isBusy = busyRun === r.runId;
    const showMsg = actionMsg && actionMsg.runId === r.runId ? actionMsg : null;
    return (
      <div key={r.key || r.runId} style={{ borderBottom: "1px solid var(--dsw-alias-border-l1)", paddingBottom: "4px", marginBottom: "4px" }}>
        <div style={{ ...style.row, cursor: "default", flexWrap: "wrap" as const }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: statusColorOf(r.status), flexShrink: 0 }} />
          <span style={{ color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {r.workflow}{r.runId ? `·${r.runId.slice(-4)}` : ""}
          </span>
          <span style={{ marginLeft: "auto", fontSize: "11px", color: statusColorOf(r.status), flexShrink: 0 }}>{statusLabelOf(t, r.status)}</span>
          {r.current && !r.stopReason ? (
            <span style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", width: "100%", ...NUM }} title={String(r.task ?? "")}>
              {tr(t, "drawer.step.prefix", "▸")}{stepLabel(r.steps.find((s) => s.id === r.current!.step) ?? { id: r.current.step })}
              {typeof r.stepStartedAt === "number" ? ` · ${formatElapsed(Date.now() - r.stepStartedAt)}` : ""}
            </span>
          ) : null}
          <MiniPipeline steps={r.steps} current={r.current} status={r.status} />
        </div>
        <div style={{ display: "flex", gap: "6px", paddingLeft: "16px", paddingBottom: "2px", flexWrap: "wrap" as const }}>
          <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" }}
            onClick={() => { setOpen(false); locateRun(r); }}>
            {tr(t, "drawer.locate", "定位到对话")}
          </button>
          <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" }}
            onClick={() => toggleDetail(r)}>
            {isExpanded ? tr(t, "drawer.collapse", "收起详情") : tr(t, "drawer.detail", "状态详情")}
          </button>
          {/* 暂停恢复：POST 直连（DO 提示会 followup 注入模型；失败回退命令） */}
          {r.status === "failed" && r.runId ? (
            <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)", cursor: isBusy ? "wait" : "pointer", opacity: isBusy ? 0.6 : 1 }}
              onClick={() => void runAction(r.runId!, "resume")}>
              ▶ {tr(t, "run.resume", "继续")}
            </button>
          ) : null}
          {/* 审查门审批：POST 直连（验证后台跑；失败回退命令注入） */}
          {r.status === "gate" && r.runId ? (
            <>
              <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)", cursor: isBusy ? "wait" : "pointer", opacity: isBusy ? 0.6 : 1 }}
                onClick={() => void runAction(r.runId!, "approve")}>
                ✓ {tr(t, "run.approve", "通过")}
              </button>
              <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" }}
                onClick={() => { setReturnFor((cur) => (cur === r.runId ? null : r.runId)); setExpanded(null); setConfirmCancel(null); }}>
                ✗ {tr(t, "run.return", "打回")}
              </button>
            </>
          ) : null}
          {/* 取消（先归档报告）：两步确认防误触；快路径 await 返回结果 */}
          {r.status !== "done" && r.status !== "cancelled" && r.status !== "detached" && r.runId ? (
            confirmCancel === r.runId ? (
              <>
                <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-state-error-secondary)", background: "var(--dsw-alias-state-error-secondary)", color: "var(--dsw-alias-state-error-primary)", cursor: isBusy ? "wait" : "pointer", fontWeight: 600, opacity: isBusy ? 0.6 : 1 }}
                  onClick={() => void runAction(r.runId!, "cancel")}>
                  {tr(t, "drawer.cancel.confirm", "确认取消？")}
                </button>
                <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" }}
                  onClick={() => setConfirmCancel(null)}>
                  {tr(t, "drawer.cancel.back", "返回")}
                </button>
              </>
            ) : (
              <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" }}
                onClick={() => { setConfirmCancel(r.runId!); setReturnFor(null); }}>
                ✕ {tr(t, "run.cancel.action", "取消")}
              </button>
            )
          ) : null}
        </div>
        {/* 打回意见内联输入：意见必填才发送（绝不代发空意见） */}
        {returnFor === r.runId ? (
          <div style={{ padding: "0 6px 6px 16px" }}>
            <textarea
              ref={returnRef}
              rows={2}
              value={returnText}
              onChange={(e) => setReturnText(e.target.value)}
              aria-label={tr(t, "run.return.opinion", "打回意见（会随命令发给模型）")}
              placeholder={tr(t, "run.return.placeholder", "例如：边界情况没覆盖，测试全挂了，请先修 CI 再交付…")}
              style={{ width: "100%", boxSizing: "border-box", fontSize: "12px", padding: "6px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "6px" }}>
              <button type="button" style={{ fontSize: "11px", padding: "2px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-state-error-secondary)", color: "var(--dsw-alias-state-error-primary)", cursor: isBusy ? "wait" : "pointer", opacity: isBusy ? 0.6 : 1 }}
                disabled={isBusy || !returnText.trim()}
                onClick={() => void runAction(r.runId!, "return", returnText.trim())}>
                {tr(t, "run.return.send", "发送打回")}
              </button>
              <button type="button" style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" }}
                onClick={() => { setReturnFor(null); setReturnText(""); }}>
                {tr(t, "run.cancel.action", "取消")}
              </button>
            </div>
          </div>
        ) : null}
        {/* 动作反馈（成功/失败都可见，绝不静默） */}
        {showMsg ? (
          <div style={{ padding: "2px 6px 4px 16px", fontSize: "11.5px", color: showMsg.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" }}>
            {showMsg.ok ? `✓ ${tr(t, "run.hint.approved", "已提交，进度将实时更新。")}` : `⚠ ${showMsg.text}`}
          </div>
        ) : null}
        {/* 详情展开：任务/属主/审查材料/失败原因全文/验证票——抽屉内消化，不再只靠命令文本 */}
        {isExpanded ? (
          <div style={{ padding: "4px 8px 6px 16px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", lineHeight: 1.6 }}>
            {detail?.owner ? (
              <div style={{ marginBottom: "4px" }}>
                <strong style={{ color: "var(--dsw-alias-label-primary)" }}>{tr(t, "drawer.owner", "属主")}：</strong>
                {detail.owner === sessionId ? tr(t, "drawer.owner.me", "本会话") : String(detail.owner).slice(0, 8)}
              </div>
            ) : null}
            {r.task ? <div style={{ marginBottom: "4px" }}><strong style={{ color: "var(--dsw-alias-label-primary)" }}>{tr(t, "drawer.task", "任务")}：</strong> {String(r.task)}</div> : null}
            {r.status === "gate" && detail?.gate ? (
              <div style={{ marginBottom: "4px", padding: "4px 8px", borderRadius: "6px", background: "var(--dsw-alias-state-warn-tertiary)" }}>
                <strong style={{ color: "var(--dsw-alias-label-primary)" }}>{tr(t, "drawer.gate.todo", "审查要求")}：</strong> {String(detail.gate.title ?? r.current?.step ?? "")}
                {detail.gate.reason ? <div style={{ marginTop: "2px" }}>{String(detail.gate.reason)}</div> : null}
                {detail.gate.taskExcerpt ? (
                  <div style={{ marginTop: "4px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "120px", overflowY: "auto", background: "var(--dsw-alias-bg-layer-2)", padding: "4px 6px", borderRadius: "4px" }}>{String(detail.gate.taskExcerpt)}</div>
                ) : null}
              </div>
            ) : null}
            {detail?.pauseReason ? (
              <div style={{ marginBottom: "4px" }}><strong style={{ color: "var(--dsw-alias-label-primary)" }}>{tr(t, "drawer.pausereason", "暂停原因")}：</strong> {String(detail.pauseReason)}</div>
            ) : null}
            {detail?.lastFailureReason ? (
              <div style={{ marginBottom: "4px", maxHeight: "150px", overflowY: "auto" }}>
                <strong style={{ color: "var(--dsw-alias-label-primary)" }}>{tr(t, "drawer.failreason", "失败原因")}：</strong>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{String(detail.lastFailureReason)}</div>
              </div>
            ) : null}
            {/* CHECK 剩余时间进度条：超时上限给了等待一个终点（「在跑」和「死了」一眼可分） */}
            {detail?.current?.phase === "check" && !detail?.paused
              ? (() => {
                  const tl = checkTimeLeft(detail.checkStartedAt, detail.timeoutMs);
                  if (!tl) return null;
                  const minutes = Math.max(1, Math.round((detail.timeoutMs ?? 0) / 60000));
                  return (
                    <div style={{ marginBottom: "6px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "11px", marginBottom: "2px" }}>
                        <span style={{ color: tl.over ? "var(--dsw-alias-state-error-primary)" : tl.ratio > 0.85 ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-tertiary)" }}>
                          {tl.over
                            ? tr(t, "drawer.timeout", "已超时，等待自动暂停")
                            : trf2(t, "drawer.timeleft", "剩余 {t}", { t: formatElapsed(tl.leftMs) })}
                        </span>
                        <span style={{ color: "var(--dsw-alias-label-tertiary)" }}>
                          {trf2(t, "run.timeout.left", "超时上限 {min} 分钟", { min: minutes })}
                        </span>
                      </div>
                      <div style={{ height: 4, borderRadius: 2, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: `${Math.round(tl.ratio * 100)}%`,
                          background: tl.over || tl.ratio > 0.85
                            ? "var(--dsw-alias-state-error-primary)"
                            : tl.ratio > 0.6
                              ? "var(--dsw-alias-state-warn-primary)"
                              : "var(--dsw-alias-state-business-primary)",
                          transition: "width .6s ease",
                        }} />
                      </div>
                    </div>
                  );
                })()
              : null}
            {Array.isArray(detail?.voterProgress) && detail!.voterProgress!.length > 0 ? (
              <div style={{ marginBottom: "4px" }}>
                <strong style={{ color: "var(--dsw-alias-label-primary)" }}>{tr(t, "drawer.voters", "验证者")}：</strong>
                <ul style={{ margin: "2px 0 0", paddingLeft: "16px" }}>
                  {(detail!.voterProgress as { voter: number; status: string; model: string | null; check: string; startedAt?: number }[]).map((v, i) => (
                    <li key={i} style={{ margin: "1px 0" }}>
                      {trf2(t, "run.verifier", "验证者 {v}/{count}", { v: v.voter, count: detail!.voterProgress!.length })}{" "}
                      <span style={{ color: voterColor(v.status), fontWeight: 600 }}>{voterLabel(t, v.status)}</span>
                      {typeof v.startedAt === "number" && (v.status === "running" || v.status === "infra_pending")
                        ? ` · ${formatElapsed(Date.now() - v.startedAt)}`
                        : ""}
                      {v.model ? ` · ${v.model}` : ""}
                      {v.check ? ` — ${v.check}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  // 冷启动：无任务时灰态入口 + 迷你上手卡（发现路径）
  if (runs.length === 0) {
    return (
      <div ref={rootRef} style={style.root}>
        <button
          type="button"
          style={{ ...style.trigger, color: "var(--dsw-alias-label-tertiary)", borderColor: "var(--dsw-alias-border-l1)", maxWidth: "220px" }}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={tr(t, "coldstart.aria", "Ralph Flow：工作流引擎（点击查看上手引导）")}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true" style={{ width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0, background: "var(--dsw-alias-border-l2)" }} />
          <span>Ralph Flow</span>
        </button>
        {open ? (
          <div id="ralphflow-header-menu" role="dialog" aria-label={tr(t, "coldstart.title", "开始使用 Ralph Flow")} style={{ ...style.menu, width: "300px" }}>
            <div style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--dsw-alias-label-primary)", padding: "4px 6px" }}>
              🌀 {tr(t, "coldstart.title", "开始使用 Ralph Flow")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--dsw-alias-label-secondary)", padding: "0 6px 8px", lineHeight: 1.55 }}>
              {tr(t, "coldstart.desc", "DO→CHECK 状态机工作流：模型执行任务，独立验证者对抗检查，失败自动返工，关键步骤停下等你审查。")}
            </div>
            {[
              { cmd: "/loop ", label: tr(t, "coldstart.try.loop", "/loop <任务描述> — 迭代执行直到验证通过"), autosubmit: false },
              { cmd: "/ralphflow-list", label: tr(t, "coldstart.try.list", "/ralphflow-list — 查看可用工作流"), autosubmit: true },
            ].map((item) => (
              <button
                key={item.cmd}
                type="button"
                style={style.row}
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new CustomEvent("ralphflow:command", { detail: { command: item.cmd, autoSubmit: item.autosubmit } }));
                }}
              >
                <span aria-hidden="true" style={{ color: "var(--dsw-alias-state-business-primary)", flexShrink: 0 }}>▶</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, color: "var(--dsw-alias-label-primary)" }}>{item.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} style={style.root}>
      <button
        type="button"
        style={{ ...style.trigger, maxWidth: "300px" }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="ralphflow-header-menu"
        aria-label={tr(t, "header.aria", `Ralph Flow：{live} 运行中，{gate} 待审查，{fail} 已暂停`)
          .replace("{live}", String(liveCount)).replace("{gate}", String(gateCount)).replace("{fail}", String(failCount))}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" style={{ width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0, background: statusColorOf(primary ? primary.status : "do") }} />
        <span style={{ flexShrink: 0 }}>Ralph Flow</span>
        {/* mini pipeline 页头形态：只在真有东西在跑时显示（暂停/转交不占位） */}
        {primary && (primary.status === "do" || primary.status === "check") ? (
          <>
            <MiniPipeline steps={primary.steps} current={primary.current} status={primary.status} />
            {typeof primary.stepStartedAt === "number" ? (
              <span style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", ...NUM }}>{formatElapsed(Date.now() - primary.stepStartedAt)}</span>
            ) : null}
          </>
        ) : null}
        {liveCount > 1 ? <span style={NUM}>{liveCount}</span> : null}
        {gateCount > 0 ? <span style={badgeWarn}>{gateCount}</span> : null}
        {failCount > 0 ? <span style={badgeFail}>{failCount}</span> : null}
      </button>
      {open ? (
        <div id="ralphflow-header-menu" role="dialog" aria-label={tr(t, "header.list", "Ralph Flow 任务列表")} style={style.menu}>
          {waiting.length + live.length > 0 ? (
            <div>
              {waiting.length > 0 ? (
                <>
                  <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-state-warn-primary)", textTransform: "uppercase", letterSpacing: ".04em", padding: "2px 6px 6px" }}>
                    {tr(t, "drawer.todo", "待处理")}{waiting.length > 1 ? ` · ${waiting.length}` : ""}
                  </div>
                  {waiting.map(renderRow)}
                </>
              ) : null}
              {live.length > 0 ? (
                <>
                  <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", textTransform: "uppercase", letterSpacing: ".04em", padding: waiting.length > 0 ? "10px 6px 6px" : "2px 6px 6px" }}>
                    {tr(t, "drawer.live", "运行中")}{live.length > 1 ? ` · ${live.length}` : ""}
                  </div>
                  {live.map(renderRow)}
                </>
              ) : null}
            </div>
          ) : null}
          {ended.length > 0 ? (
            <div style={{ marginTop: live.length > 0 || waiting.length > 0 ? "10px" : 0 }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", textTransform: "uppercase", letterSpacing: ".04em", padding: "2px 6px 6px" }}>
                {tr(t, "drawer.ended", "已结束（本会话）")}
              </div>
              {ended.slice(-6).map((r: RunSummary) => (
                <div key={r.key || r.runId}>
                  <button
                    type="button"
                    style={style.row}
                    title={r.status === "detached" ? tr(t, "status.detached", "已转交") : r.task}
                    onClick={() => { setOpen(false); locateRun(r); }}
                  >
                    <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: statusColorOf(r.status), flexShrink: 0 }} />
                    <span style={{ color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      {r.workflow}{r.runId ? `·${r.runId.slice(-4)}` : ""}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", flexShrink: 0 }}>{statusLabelOf(t, r.status)}</span>
                  </button>
                  {r.reportPath ? (
                    <div style={{ paddingLeft: "16px", paddingBottom: "4px" }}>
                      <button
                        type="button"
                        style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-state-business-primary)", cursor: "pointer" }}
                        onClick={() => { try { window.open(r.reportPath!, "_blank"); } catch {} }}
                      >
                        📄 {tr(t, "drawer.report", "报告")}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
              {ended.length > 6 ? (
                <div style={{ fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", padding: "0 8px 4px" }}>
                  {trf2(t, "drawer.ended.more", "…以及更早的 {n} 条", { n: ended.length - 6 })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default HeaderAction;
