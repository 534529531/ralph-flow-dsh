/**
 * Ralph Flow for dsh — client 端事件折叠器（仿官方 workflowRunDefinition）
 *
 * 把 host 端发射的 tool-ralphflow/* 事件帧折叠成持久的对话内嵌节点
 * （kind: 'ralphflow-run'），注册进 conversation.chat.node keyed 槽。
 * 折叠幂等：update 只累加/替换字段，按事件 seq 顺序重放可恢复同一视图。
 */

import { isHiddenEvent } from "./hidden-runs.js";

export interface RalphVerdict {
  voter: number;
  count: number;
  model: string;
  status: "pass" | "fail" | "infra";
  reasoning: string;
  /** 判定到达时刻（ms，来自 verdict 帧 ts）——与 voter-start 相减得该票用时 */
  arrivedAt?: number;
}

/** 验证者活体：check-voter-start 帧（某票开跑）——黑盒期可观测的数据源 */
export interface RalphVoterStart {
  voter: number;
  count: number;
  model?: string;
  startedAt: number;
  retry?: boolean;
}

export interface RalphRunState {
  workflow: string;
  task: string;
  /** 实例 id（host 的 runId）——页头任务行用它精确定位 /ralphflow-status */
  runId?: string;
  steps: { id: string; desc: string }[];
  current: { step: string; phase: "do" | "check"; failCount: number } | null;
  /** 当前步骤的开始时间戳（ms，来自 host 帧的 ts；用于「已运行 Xm」展示） */
  stepStartedAt?: number;
  /** 当前步骤验证者总数（step-start check 帧携带；首票落地前即可显示 M/N 进度） */
  voters?: number;
  /** 当前验证轮的超时上限（ms）——超时进度条的终点感 */
  timeoutMs?: number;
  /** 已启动的验证者（排队/运行中二态的判定源；verdict 到达即视为完成） */
  voterStarts: RalphVoterStart[];
  verdicts: RalphVerdict[];
  lastCheck: { passed: boolean; reason?: string } | null;
  gate: { step: string; title: string; reason: string; taskExcerpt?: string } | null;
  rewinds: { fromStep: string; toStep: string; reason: string }[];
  report: { text: string; reportPath?: string } | null;
  stopReason: "done" | "cancelled" | "failed" | undefined;
  /** 已转交其他会话（接管时旧会话收到 run-detach）——不再计入运行中 */
  detached?: boolean;
}

export const RALPHFLOW_RUN_KIND = "ralphflow-run";

const EVENT_TYPES = [
  "tool-ralphflow/run-start",
  "tool-ralphflow/run-detach",
  "tool-ralphflow/step-start",
  "tool-ralphflow/check-voter-start",
  "tool-ralphflow/check-verdict",
  "tool-ralphflow/check-result",
  "tool-ralphflow/gate",
  "tool-ralphflow/rewind",
  "tool-ralphflow/reset",
  "tool-ralphflow/report",
  "tool-ralphflow/run-end",
] as const;

export type RalphflowEventType = (typeof EVENT_TYPES)[number];

export function match(event: { type: string; data?: any }): { id: string; role: "start" | "update" } | null {
  // 缺 runId 的帧无法归属到任何 run——丢弃，避免不同 run 的帧折叠进
  // 字面量 "undefined" 的同一节点互相污染。
  if (!event.data?.runId) return null;
  // 用户手动关闭的卡：整条 run 的帧都不再匹配（存量僵尸卡的最终出口）
  if (isHiddenEvent(event.data)) return null;
  if (event.type === "tool-ralphflow/run-start") {
    return { id: String(event.data?.runId), role: "start" };
  }
  if (EVENT_TYPES.includes(event.type as RalphflowEventType) && event.type !== "tool-ralphflow/run-start") {
    return { id: String(event.data?.runId), role: "update" };
  }
  return null;
}

export function startState(data: any): RalphRunState {
  return {
    workflow: data?.workflow ?? "",
    task: data?.task ?? "",
    runId: data?.runId ? String(data.runId) : undefined,
    steps: Array.isArray(data?.steps) ? data.steps : [],
    current: null,
    stepStartedAt: undefined,
    voterStarts: [],
    verdicts: [],
    lastCheck: null,
    gate: null,
    rewinds: [],
    report: null,
    stopReason: undefined,
  };
}

export function updateState(state: RalphRunState, event: { type: string; data?: any }): RalphRunState {
  // 终态冻结：仅真正的终态（完成/取消）冻结视图。stopReason:"failed" 是暂停
  // （max_failures/check_error 后仍可 continue 恢复），不能冻结——否则恢复后
  // 的 step-start/verdict 帧全被丢弃，卡片永远停在「已失败」。
  if (state.stopReason === "done" || state.stopReason === "cancelled") return state;
  const d = event.data ?? {};
  switch (event.type) {
    // 转交：实例已被另一个会话接管，本会话这张卡停止计数（僵尸运行消除）
    case "tool-ralphflow/run-detach":
      return { ...state, detached: true };
    case "tool-ralphflow/step-start":
      return {
        ...state,
        current: { step: d.step, phase: d.phase, failCount: d.failCount ?? 0 },
        stepStartedAt: typeof d.ts === "number" && d.ts > 0 ? d.ts : Date.now(),
        voters: typeof d.voters === "number" && d.voters > 0 ? d.voters : state.voters,
        timeoutMs: typeof d.timeoutMs === "number" && d.timeoutMs > 0 ? d.timeoutMs : state.timeoutMs,
        // 新验证轮开始：上一轮的启动记录清空（verdicts 由 check-result 清）
        voterStarts: [],
        // step-start 到达即说明审查门已批准/跳过（门只在 DO 完成点停住），
        // check 相位的第一帧也要摘掉门卡，不能等下一步 DO 才清。
        gate: null,
      };
    case "tool-ralphflow/check-voter-start": {
      const incoming = {
        voter: typeof d.voter === "number" ? d.voter : 1,
        count: typeof d.count === "number" ? d.count : 1,
        model: typeof d.model === "string" && d.model ? d.model : undefined,
        startedAt: typeof d.startedAt === "number" && d.startedAt > 0 ? d.startedAt : Date.now(),
        retry: !!d.retry,
      };
      const idx = state.voterStarts.findIndex((s) => s.voter === incoming.voter);
      const voterStarts = idx >= 0
        ? state.voterStarts.map((s, i) => (i === idx ? incoming : s))
        : [...state.voterStarts, incoming];
      return { ...state, voterStarts };
    }
    case "tool-ralphflow/check-verdict": {
      const status = d.status === "pass" || d.status === "fail" || d.status === "infra" ? d.status : "infra";
      // 按 voter 序号 upsert（同一轮内 voter 唯一）：帧重放/乱序重复不会多计票，
      // 迟到的旧票也不会覆盖新一轮的同号票之外的数据。
      const incoming = {
        voter: d.voter ?? 1,
        count: d.count ?? 1,
        model: d.model ?? "",
        status,
        reasoning: d.reasoning ?? "",
        ...(typeof d.arrivedAt === "number" && d.arrivedAt > 0 ? { arrivedAt: d.arrivedAt } : {}),
      };
      const idx = state.verdicts.findIndex((v) => v.voter === incoming.voter);
      const verdicts = idx >= 0
        ? state.verdicts.map((v, i) => (i === idx ? incoming : v))
        : [...state.verdicts, incoming];
      return { ...state, verdicts };
    }
    case "tool-ralphflow/check-result":
      return { ...state, lastCheck: { passed: !!d.passed, reason: d.reason }, verdicts: [] };
    case "tool-ralphflow/gate":
      return {
        ...state,
        gate: {
          step: d.step, title: d.title, reason: d.reason,
          ...(typeof d.taskExcerpt === "string" && d.taskExcerpt ? { taskExcerpt: d.taskExcerpt } : {}),
        },
      };
    case "tool-ralphflow/rewind":
      return {
        ...state,
        rewinds: [...state.rewinds, { fromStep: d.fromStep, toStep: d.toStep, reason: d.reason }],
        gate: null,
        verdicts: [],
        lastCheck: null,
      };
    case "tool-ralphflow/reset":
      return { ...state, gate: null };
    case "tool-ralphflow/report":
      return { ...state, report: { text: d.text ?? "", ...(typeof d.reportPath === "string" && d.reportPath ? { reportPath: d.reportPath } : {}) } };
    case "tool-ralphflow/run-end":
      return { ...state, stopReason: d.stopReason };
    default:
      return state;
  }
}

export function buildViewNode(context: any): any {
  if (!context.start) return null;
  const state: RalphRunState = context.state ?? startState({});
  return {
    key: context.key,
    kind: RALPHFLOW_RUN_KIND,
    id: context.id,
    target: "chat",
    anchorSeq: context.start.event.seq,
    location: context.start.location,
    visibility: "visible",
    data: state,
  };
}

/** 注册 conversationEvents 定义（供 client.ts apply 调用） */
export function createDefinition() {
  return {
    kind: RALPHFLOW_RUN_KIND,
    target: "chat",
    match,
    start: (_context: any, match: any) => startState(match.event.data),
    update: (context: any, match: any) => updateState(context.state, match.event),
    buildViewNode,
  };
}

// ─── 命令结果卡（折叠官方 command/run + command/done 事件）───────────────────
// 宿主对每条命令自动追加官方已知类型 command/run + command/done（dsh-commands
// 的 execute 生命周期，见 dsh-commands/lib/index.js appendLifecycle）；本折叠器
// 只匹配 ralphflow 相关命令名渲染成对话内嵌卡。绝不向会话写入任何自定义帧——
// 第三方插件自定义事件类型在宿主持久化读路径上会砖掉整个会话（无 ignorable
// 逃生门），而 command/run + command/done 是官方词汇表成员，落盘重放安全。

export const RALPHFLOW_COMMAND_KIND = "ralphflow-command";

export interface RalphCommandState {
  /** 命令名（不含前导斜杠），如 ralphflow-list、loop */
  command: string;
  /** 宿主返回的 handler 输出文本（command/done.text） */
  text: string;
  /** command/run 已到、command/done 未到：执行中 */
  running: boolean;
  /** command/done.kind === "error" */
  error: boolean;
}

/** 静态管理命令 + create（宿主注册的 ralphflow 命令全集） */
const STATIC_COMMAND_NAMES = new Set([
  "ralphflow-start", "ralphflow-continue", "ralphflow-status", "ralphflow-list",
  "ralphflow-cancel", "ralphflow-rewind", "ralphflow-reset", "ralphflow-doctor",
  "ralphflow-create",
]);

/** 动态工作流快捷命令（/loop、/spec……）——由 HTTP 通道的工作流清单喂入 */
const workflowShortcuts = new Set<string>();
export function registerWorkflowShortcutNames(names: string[]): void {
  workflowShortcuts.clear();
  for (const n of Array.isArray(names) ? names : []) {
    try { workflowShortcuts.add(String(n).toLowerCase()); } catch {}
  }
}

function isRalphflowCommand(name: string): boolean {
  const n = String(name ?? "");
  return STATIC_COMMAND_NAMES.has(n) || n.startsWith("ralphflow-") || workflowShortcuts.has(n.toLowerCase());
}

/**
 * 已确认为 ralphflow 命令的 commandId 集合：command/run 带 name（可过滤），
 * command/done 只有 commandId——用 run 建立白名单、done 按白名单配对，且在
 * 同一会话的事件重放中 run 先于 done 到达，刷新后重放同样成立。
 */
const knownCommandIds = new Set<string>();

export function matchCommand(event: { type: string; data?: any }): { id: string; role: "start" | "update" } | null {
  const d = event.data ?? {};
  const commandId = String(d?.commandId ?? "");
  if (!commandId) return null;
  if (event.type === "command/run") {
    const name = String(d?.name ?? "");
    if (!name || !isRalphflowCommand(name)) return null;
    knownCommandIds.add(commandId);
    return { id: `cmd-${commandId}`, role: "start" };
  }
  if (event.type === "command/done") {
    // name 不随 done 携带：只认 run 阶段登记过的 commandId（跨命令不误配）
    if (!knownCommandIds.has(commandId)) return null;
    knownCommandIds.delete(commandId);
    return { id: `cmd-${commandId}`, role: "update" };
  }
  return null;
}

export function startCommandState(data: any): RalphCommandState {
  return { command: String(data?.name ?? ""), text: "", running: true, error: false };
}

export function updateCommandState(state: RalphCommandState, data: any): RalphCommandState {
  try {
    const kind = String(data?.kind ?? "");
    const text = String(data?.text ?? "");
    // error 分支宿主会把 handler 抛错的 message 放 text；成功分支 text 即结果
    return { command: state.command || String(data?.name ?? ""), text, running: false, error: kind === "error" };
  } catch {
    return state;
  }
}

export function buildCommandViewNode(context: any): any {
  if (!context.start) return null;
  const state: RalphCommandState = context.state ?? startCommandState({});
  return {
    key: context.key,
    kind: RALPHFLOW_COMMAND_KIND,
    id: context.id,
    target: "chat",
    anchorSeq: context.start.event.seq,
    location: context.start.location,
    visibility: "visible",
    data: state,
  };
}

export function createCommandDefinition() {
  return {
    kind: RALPHFLOW_COMMAND_KIND,
    target: "chat",
    match: matchCommand,
    start: (_context: any, m: any) => startCommandState(m.event.data),
    update: (context: any, m: any) => updateCommandState(context.state, m.event.data),
    buildViewNode: buildCommandViewNode,
  };
}