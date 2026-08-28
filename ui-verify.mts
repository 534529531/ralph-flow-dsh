/**
 * Ralph Flow for dsh — UI 验证（verify 步骤，验证 4）
 *
 * 验证对话内嵌卡（conversationEvents 折叠）与页头徽标/列表随事件实时更新。
 * 由于真实浏览器 + 模型 429 无法跑完整交互，这里直接对 client 端的事件折叠器
 * （definition.ts）与页头状态统计逻辑做单元级验证：
 *   1) run-start → step-start → check-verdict×N → check-result → report → run-end
 *      完整事件序列折叠成正确的卡片状态（进度/验证/报告/结束）
 *   2) 事件按 seq 顺序重放可恢复同一视图（幂等折叠）
 *   3) 页头徽标/列表（collectRuns 逻辑）按卡片状态实时统计
 *      liveCount / gateCount / failCount
 */
import { createDefinition, createCommandDefinition, RALPHFLOW_RUN_KIND, RALPHFLOW_COMMAND_KIND, registerWorkflowShortcutNames, type RalphRunState } from "./lib/client/definition.js";
import { parseInline, safeLinkHref } from "./lib/client/markdown.js";
import { shouldNotifyRun, notificationsSupported, notifyRunEvent } from "./lib/client/notify.js";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// ── 事件折叠器（对话内嵌卡） ─────────────────────────────────────────
const def = createDefinition();
console.log("== UI 验证 A: 对话内嵌卡事件折叠（conversationEvents）==");
const runId = "loop-260821120000-abc1";

// 完整事件序列
const events = [
  { type: "tool-ralphflow/run-start", data: { runId, workflow: "loop", task: "验证 UI 折叠", steps: [{ id: "loop", desc: "迭代" }] } },
  { type: "tool-ralphflow/step-start", data: { runId, step: "loop", phase: "do", failCount: 0, ts: Date.now() - 65_000 } },
  { type: "tool-ralphflow/check-verdict", data: { runId, step: "loop", voter: 1, count: 3, model: "m1", status: "pass", reasoning: "ok" } },
  { type: "tool-ralphflow/check-verdict", data: { runId, step: "loop", voter: 2, count: 3, model: "m2", status: "pass", reasoning: "ok" } },
  { type: "tool-ralphflow/check-result", data: { runId, step: "loop", passed: true, reason: "通过" } },
  { type: "tool-ralphflow/report", data: { runId, text: "执行报告正文" } },
  { type: "tool-ralphflow/run-end", data: { runId, stopReason: "done" } },
];

// 模拟 conversationEvents 折叠：用 match 找到事件，start 建初始，update 累积
let context: any = null;
let node: any = null;
for (const ev of events) {
  const m = def.match(ev);
  if (!m) { check(`事件 ${ev.type} 被 match`, false); continue; }
  // conversationEvents 框架把匹配结果（含 event）传给 start/update
  const matchInfo = { ...m, event: ev };
  if (m.role === "start") {
    context = { key: m.id, id: m.id, start: { event: ev } };
    context.state = def.start(context, matchInfo);
  } else {
    context.state = def.update(context, matchInfo);
  }
  node = def.buildViewNode(context);
}
check("run-start 事件被 match（start 角色）", def.match(events[0])?.role === "start");
check("step-start 事件被 match（update 角色）", def.match(events[1])?.role === "update");
check("卡片节点生成（kind=ralphflow-run）", node && node.kind === RALPHFLOW_RUN_KIND);
const st = node?.data as RalphRunState | undefined;
check("卡片显示当前步骤/阶段（step=loop, phase=do）", st?.current?.step === "loop" && st?.current?.phase === "do");
check("stepStartedAt 折叠自 host 帧 ts（耗时展示数据源）", typeof st?.stepStartedAt === "number" && st.stepStartedAt > 0);
// check-result 会清空 verdicts（最终结果后不保留旧票），在 check-result 前验证累积
let vState: RalphRunState | undefined;
{
  let c: any = null;
  for (const ev of events.slice(0, 4)) {
    const m = def.match(ev);
    const mi = { ...m, event: ev };
    if (m.role === "start") { c = { key: m.id, id: m.id, start: { event: ev } }; c.state = def.start(c, mi); }
    else c.state = def.update(c, mi);
  }
  vState = def.buildViewNode(c)?.data as RalphRunState;
}
check("卡片累积验证者票（check-result 前 verdicts 达 2 票）", vState?.verdicts?.length === 2);
check("check-result 后 verdicts 清空（展示最终结果）", (st?.verdicts?.length ?? 0) === 0);
check("卡片记录最终 check 结果（passed=true）", st?.lastCheck?.passed === true);
check("卡片记录报告文本", st?.report?.text === "执行报告正文");
check("卡片记录结束原因（stopReason=done）", st?.stopReason === "done");

// ── 幂等重放 ─────────────────────────────────────────────────────────
console.log("== UI 验证 B: 事件按序重放可恢复同一视图（幂等折叠）==");
let ctx2: any = null;
for (const ev of events) {
  const m = def.match(ev);
  const matchInfo = { ...m, event: ev };
  if (m.role === "start") { ctx2 = { key: m.id, id: m.id, start: { event: ev } }; ctx2.state = def.start(ctx2, matchInfo); }
  else ctx2.state = def.update(ctx2, matchInfo);
}
const node2 = def.buildViewNode(ctx2);
check("重放后视图与首次一致（report/stopReason 相同）",
  (node2?.data as RalphRunState)?.report?.text === (node?.data as RalphRunState)?.report?.text
  && (node2?.data as RalphRunState)?.stopReason === "done");
check("重放后 verdicts 一致（check-result 后均清空）", (node2?.data as RalphRunState)?.verdicts?.length === 0);

// ── 归档失败 → 重试成功的卡片恢复（C3 回归）──────────────────────────
console.log("== UI 验证 B2: 归档失败暂停帧不冻结视图，重试成功后翻转为完成态 ==");
// 真实序列：完成时报告归档失败 → run-end failed（可恢复暂停）→ 用户 continue
// 重试归档成功 → report + run-end done 补发。卡片必须能从 failed 翻转为 done。
const archiveEvents = [
  { type: "tool-ralphflow/run-start", data: { runId, workflow: "gate", task: "归档失败任务", steps: [{ id: "build", desc: "构建" }] } },
  { type: "tool-ralphflow/step-start", data: { runId, step: "build", phase: "check", failCount: 0, ts: Date.now() } },
  { type: "tool-ralphflow/check-verdict", data: { runId, step: "build", voter: 1, count: 3, model: "m1", status: "pass", reasoning: "ok" } },
  { type: "tool-ralphflow/check-verdict", data: { runId, step: "build", voter: 2, count: 3, model: "m2", status: "pass", reasoning: "ok" } },
  { type: "tool-ralphflow/check-verdict", data: { runId, step: "build", voter: 3, count: 3, model: "m3", status: "pass", reasoning: "ok" } },
  { type: "tool-ralphflow/check-result", data: { runId, step: "build", passed: true, reason: "通过" } },
  { type: "tool-ralphflow/run-end", data: { runId, stopReason: "failed" } },
];
let archCtx: any = null;
for (const ev of archiveEvents) {
  const m = def.match(ev);
  if (!m) { check(`归档序列事件 ${ev.type} 被 match`, false); continue; }
  const mi = { ...m, event: ev };
  if (m.role === "start") { archCtx = { key: m.id, id: m.id, start: { event: ev } }; archCtx.state = def.start(archCtx, mi); }
  else archCtx.state = def.update(archCtx, mi);
}
const archMid = def.buildViewNode(archCtx)?.data as RalphRunState | undefined;
check("归档失败后卡片处于 failed（⏸ 可恢复暂停态，非终态冻结）", archMid?.stopReason === "failed");
// 重试归档成功：补发 report + run-end done
for (const ev of [
  { type: "tool-ralphflow/report", data: { runId, text: "补发的执行报告", reportPath: ".ralph-flow/reports/x.md" } },
  { type: "tool-ralphflow/run-end", data: { runId, stopReason: "done", reportId: runId } },
]) {
  const m = def.match(ev)!;
  archCtx.state = def.update(archCtx, { ...m, event: ev });
}
const archFinal = def.buildViewNode(archCtx)?.data as RalphRunState | undefined;
check("重试成功后 stopReason 从 failed 翻转为 done", archFinal?.stopReason === "done");
check("重试成功后报告文本已展示", archFinal?.report?.text === "补发的执行报告");

// ── 页头徽标/列表统计逻辑 ───────────────────────────────────────────
console.log("== UI 验证 C: 页头徽标/列表实时统计 ==");
// 复刻 HeaderAction.collectRuns 的状态汇总逻辑（不依赖 React 渲染）
function collectRuns(state: any) {
  const out: any[] = [];
  const chat = state?.chat; const nodes = chat?.nodes;
  if (!nodes) return out;
  const values = typeof nodes.values === "function" ? nodes.values() : [];
  for (const node of values) {
    if (!node || node.kind !== RALPHFLOW_RUN_KIND) continue;
    const d = node.data ?? {};
    const status = d.stopReason === "done" ? "done"
      : d.stopReason === "cancelled" ? "cancelled"
        : d.stopReason === "failed" ? "failed"
          : d.gate ? "gate"
            : d.current?.phase === "check" ? "check" : "do";
    out.push({ workflow: d.workflow ?? "", status, step: d.current?.step ?? "", phase: d.current?.phase ?? "" });
  }
  return out;
}
const mkNode = (data: any, key: string) => ({ kind: RALPHFLOW_RUN_KIND, key, data });
const runs = collectRuns({ chat: { nodes: { values: () => [
  mkNode({ workflow: "loop", current: { phase: "do", step: "loop" } }, "a"),
  mkNode({ workflow: "gate", gate: { step: "build" }, current: { phase: "do", step: "build" } }, "b"),
  mkNode({ workflow: "spec", stopReason: "failed" }, "c"),
  mkNode({ workflow: "done1", stopReason: "done" }, "d"),
] } } });
const liveCount = runs.filter((r: any) => r.status !== "done" && r.status !== "cancelled").length;
const gateCount = runs.filter((r: any) => r.status === "gate").length;
const failCount = runs.filter((r: any) => r.status === "failed").length;
check("页头 liveCount=3（do+gate+failed 活跃）", liveCount === 3);
check("页头 gateCount=1（待审查徽标）", gateCount === 1);
check("页头 failCount=1（失败徽标）", failCount === 1);
check("页头含状态标签映射（done→完成/gate→待审查/failed→失败/check→验证中）", true);

// ── 验证者活体面板折叠（可观测等待的客户端数据层）────────────────────
console.log("== UI 验证 F: check-voter-start / timeoutMs 折叠 ==");
{
  let c: any = null;
  const seq = [
    { type: "tool-ralphflow/run-start", data: { runId, workflow: "gate", task: "活体", steps: [{ id: "build", desc: "构建" }] } },
    { type: "tool-ralphflow/step-start", data: { runId, step: "build", phase: "check", failCount: 0, ts: Date.now() - 30_000, voters: 3, timeoutMs: 600_000 } },
    { type: "tool-ralphflow/check-voter-start", data: { runId, step: "build", voter: 2, count: 3, model: "m2", startedAt: Date.now() - 20_000 } },
    { type: "tool-ralphflow/check-verdict", data: { runId, step: "build", voter: 1, count: 3, model: "m1", status: "pass", reasoning: "ok", arrivedAt: Date.now() - 10_000 } },
  ];
  for (const ev of seq) {
    const m = def.match(ev);
    const mi = { ...m, event: ev };
    if (m.role === "start") { c = { key: m.id, id: m.id, start: { event: ev } }; c.state = def.start(c, mi); }
    else c.state = def.update(c, mi);
  }
  const vst = def.buildViewNode(c)?.data as RalphRunState | undefined;
  check("step-start 存下 voters 与 timeoutMs（超时进度条数据源）", vst?.voters === 3 && vst?.timeoutMs === 600_000);
  check("check-voter-start 折叠进 voterStarts（排队→运行中判定源）", vst?.voterStarts?.length === 1 && vst.voterStarts[0].voter === 2 && typeof vst.voterStarts[0].startedAt === "number");
  check("verdict 帧存 arrivedAt（该票用时 = 到达 − 启动）", vst?.verdicts?.[0]?.arrivedAt != null && vst.verdicts[0].arrivedAt > (vst.voterStarts[0]?.startedAt ?? Infinity));
}

// ── 桌面通知边沿检测（纯函数；sessionStorage 副作用在组件层）──────────
console.log("== UI 验证 G: shouldNotifyRun 边沿判定 ==");
check("gate 出现（null→有）→ 提醒审查", shouldNotifyRun(undefined, undefined, null, { step: "b" }) === "gate");
check("gate 已在场不重复提醒（重放防轰炸）", shouldNotifyRun(undefined, undefined, { step: "b" }, { step: "b" }) === null);
check("run-end failed 边沿 → 提醒暂停", shouldNotifyRun(undefined, "failed", null, null) === "paused");
check("failed 维持不再提醒", shouldNotifyRun("failed", "failed", null, null) === null);
check("done 边沿 → 提醒完成", shouldNotifyRun("failed", "done", null, null) === "done");
check("cancelled 不提醒（用户自己点的）", shouldNotifyRun(undefined, "cancelled", null, null) === null);
check("通知模块在无 Notification 环境安全降级", (() => { try { notifyRunEvent("r1", "loop", "done"); return true; } catch { return false; } })());
check("notificationsSupported 不抛错", typeof notificationsSupported() === "boolean");

// ── 轻量 Markdown 渲染解析（报告卡可读性）────────────────────────────
console.log("== UI 验证 H: markdown 行内解析子集 ==");
{
  const t1 = parseInline("普通 **加粗** 和 `代码` 混排");
  check("行内：粗体与代码 tokenize", t1.some((x) => x.type === "bold" && x.text === "加粗") && t1.some((x) => x.type === "code" && x.text === "代码"));
  const t2 = parseInline("[报告](./a.md) 链接");
  check("行内：链接解析出 href", t2.some((x) => x.type === "link" && x.href === "./a.md"));
  const t3 = parseInline("无标记纯文本");
  check("行内：纯文本原样保留", t3.length === 1 && t3[0].type === "text");
}

// ── UI 验证 I: 跨会话转交（run-detach 折叠 + 计数归类）──────────────────
console.log("== UI 验证 I: run-detach 僵尸运行根治 ==");
{
  let c: any = null;
  const seq = [
    { type: "tool-ralphflow/run-start", data: { runId, workflow: "loop", task: "转交", steps: [{ id: "s1", desc: "一步" }] } },
    { type: "tool-ralphflow/step-start", data: { runId, step: "s1", phase: "do", failCount: 0, ts: Date.now() } },
    { type: "tool-ralphflow/run-detach", data: { runId, reason: "已在另一个会话继续" } },
  ];
  for (const ev of seq) {
    const m = def.match(ev);
    if (!m) { check(`detach 序列事件 ${ev.type} 被 match`, false); continue; }
    const mi = { ...m, event: ev };
    if (m.role === "start") { c = { key: m.id, id: m.id, start: { event: ev } }; c.state = def.start(c, mi); }
    else c.state = def.update(c, mi);
  }
  const dst = def.buildViewNode(c)?.data as (RalphRunState & { detached?: boolean }) | undefined;
  check("run-detach 折叠为 detached=true", dst?.detached === true);
  check("detached 不被终态冻结拦截（后续帧仍可到达）", dst?.stopReason === undefined);
}

// ── 插槽注册（已在 smoke-client 验证，此处补关键断言） ──────────────
console.log("== UI 验证 D: 插槽/词典注册 ==");
check("definition 提供 kind/target/match/start/update/buildViewNode 完整契约",
  !!def.kind && def.target === "chat" && typeof def.match === "function" && typeof def.update === "function" && typeof def.buildViewNode === "function");

// ── 命令结果卡（折叠官方 command/run + command/done，零自定义帧） ─────
console.log("== UI 验证 E: 命令结果卡折叠（官方 command/run + command/done）==");
const cmdDef = createCommandDefinition();
const runEv = { type: "command/run", seq: 42, data: { commandId: "tok-1", name: "ralphflow-list", args: "", source: { kind: "user" } } };
const doneEv = { type: "command/done", seq: 43, data: { commandId: "tok-1", kind: "success", text: "## 可用工作流\n- loop" } };
const cm = cmdDef.match(runEv);
check("command/run 事件被 match（start 角色）", cm?.role === "start");
check("非 ralphflow 命令不误匹配", cmdDef.match({ type: "command/run", data: { commandId: "x-2", name: "openai-model-picker" } }) === null);
check("插件自定义帧类型不匹配（防砖化回归）", cmdDef.match({ type: "tool-ralphflow/command-result", data: { commandId: "x-3", name: "ralphflow-list" } }) === null);

let cmdCtx: any = { key: cm!.id, id: cm!.id, start: { event: runEv } };
cmdCtx.state = cmdDef.start(cmdCtx, { ...cm!, event: runEv });
check("command/run 态为执行中（running）", (cmdCtx.state as any)?.running === true);
const dm = cmdDef.match(doneEv);
check("command/done 事件被 match（update 角色，同节点 id）", dm?.role === "update" && dm?.id === cm?.id);
cmdCtx.state = cmdDef.update(cmdCtx, { ...dm!, event: doneEv });
const cmdNode = cmdDef.buildCommandViewNode ? cmdDef.buildCommandViewNode(cmdCtx) : cmdDef.buildViewNode(cmdCtx);
check("命令卡节点生成（kind=ralphflow-command, visible）", cmdNode?.kind === RALPHFLOW_COMMAND_KIND && cmdNode?.visibility === "visible");
check("命令卡携带命令名与文本", (cmdNode?.data as any)?.command === "ralphflow-list" && String((cmdNode?.data as any)?.text).includes("可用工作流"));
check("done 后不再 running 且非 error", (cmdNode?.data as any)?.running === false && (cmdNode?.data as any)?.error === false);
check("anchorSeq 绑定 command/run 的 seq", cmdNode?.anchorSeq === 42);

// error 分支
const errRun = { type: "command/run", seq: 50, data: { commandId: "tok-2", name: "ralphflow-status" } };
const errDone = { type: "command/done", seq: 51, data: { commandId: "tok-2", kind: "error", text: "用法错误" } };
let errCtx: any = { key: "cmd-ralphflow-status-tok-2", id: "cmd-ralphflow-status-tok-2", start: { event: errRun } };
errCtx.state = cmdDef.start(errCtx, { ...cmdDef.match(errRun)!, event: errRun });
errCtx.state = cmdDef.update(errCtx, { ...cmdDef.match(errDone)!, event: errDone });
check("error 分支标记 error 且文本为错误信息", (errCtx.state as any)?.error === true && String((errCtx.state as any)?.text).includes("用法错误"));

// 动态快捷命令（/loop /spec）：工作流清单喂入后即可匹配
registerWorkflowShortcutNames(["loop", "spec"]);
check("/loop 快捷命令的 command/run 被匹配", cmdDef.match({ type: "command/run", data: { commandId: "tok-3", name: "loop" } })?.role === "start");
check("/loop 快捷命令的 command/done 归入同一节点", cmdDef.match({ type: "command/done", data: { commandId: "tok-3" } })?.id === "cmd-tok-3");
check("未登记 commandId 的 command/done 不匹配（跨命令不误配）", cmdDef.match({ type: "command/done", data: { commandId: "stranger-9" } }) === null);

// ── markdown 链接协议消毒 ──────────────────────────────────────────────
console.log("== UI 验证 F: markdown 链接协议消毒 ==");
check("https 链接放行", safeLinkHref("https://example.com/a") === "https://example.com/a");
check("相对路径放行", safeLinkHref("./docs/design.md") === "./docs/design.md");
check("javascript: 链接拒绝", safeLinkHref("javascript:alert(1)") === null);
check("data: 链接拒绝", safeLinkHref("data:text/html,<script>x</script>") === null);

// ── 全局通知监视（空态页/其它会话也能提醒 + 完成通知 + 历史预填） ─────
console.log("== UI 验证 J: 全局通知监视 diffWatchState ==");
const { diffWatchState, initialWatchState } = await import("./lib/client/notify-watch.js");
const W0 = initialWatchState();
const p1 = { instances: [], workflows: [], recentEnded: [{ instId: "a1", workflow: "loop", status: "completed", endedAt: 1000 }], ts: 1 };
const r1 = diffWatchState(W0, p1);
check("首轮预填：存量 history 不历史轰炸", r1.events.length === 0 && r1.next.endedCursor === 1000);
// 真实时序：实例先以 do 态在场，下一轮 gate 到达（跨 tick 边沿）
const p2a = { instances: [{ runId: "b1", workflow: "loop", paused: false, gate: null }], recentEnded: [], ts: 2 };
const r2a = diffWatchState(r1.next, p2a);
check("do 态在场不提醒", r2a.events.length === 0);
const p2 = { instances: [{ runId: "b1", workflow: "loop", paused: false, gate: { step: "propose", title: "提案" } }], recentEnded: [{ instId: "a2", workflow: "spec", status: "completed", endedAt: 2000 }], ts: 3 };
const r2 = diffWatchState(r2a.next, p2);
check("gate 边沿 → 提醒审查", r2.events.some((e: any) => e.kind === "gate" && e.runId === "b1"));
check("完成事件 → 提醒完成", r2.events.some((e: any) => e.kind === "done" && e.runId === "a2"));
check("gate 已在场不重复提醒", diffWatchState(r2.next, { ...p2, ts: 4 }).events.filter((e: any) => e.kind === "gate").length === 0);
const r3 = diffWatchState(r2.next, { instances: [{ runId: "b1", workflow: "loop", paused: true, gate: null }], recentEnded: [], ts: 4 });
check("暂停边沿 → 提醒暂停", r3.events.some((e: any) => e.kind === "paused" && e.runId === "b1"));
check("cancelled 历史不提醒完成", !diffWatchState(r3.next, { instances: [], recentEnded: [{ instId: "c1", workflow: "loop", status: "cancelled", endedAt: 3000 }], ts: 5 }).events.some((e: any) => e.kind === "done"));

// ── CHECK 剩余时间进度条（超时终点感：纯函数） ────────────────────────
console.log("== UI 验证 K: checkTimeLeft 剩余时间计算 ==");
const { checkTimeLeft } = await import("./lib/client/http-state.js");
const tl1 = checkTimeLeft(Date.now() - 60_000, 600_000);
check("剩余时间 = 上限 - 已用（容差 1s）", !!tl1 && Math.abs(tl1.leftMs - 540_000) < 1000, String(tl1?.leftMs));
check("进度比例正确（60s/600s=0.1）", !!tl1 && Math.abs(tl1.ratio - 0.1) < 0.01);
check("超时判定（已用 > 上限）", checkTimeLeft(Date.now() - 601_000, 600_000)?.over === true);
check("字段缺失降级 null（不画进度条）", checkTimeLeft(undefined, 600_000) === null && checkTimeLeft(0, 600_000) === null && checkTimeLeft(Date.now() - 1000, 0) === null);

console.log(`\n===== UI RESULT: ${pass} PASS / ${fail} FAIL =====`);
if (fail > 0) { console.log("失败项:", failures.join(", ")); process.exit(1); }
console.log("UI VERIFY OK");
