/**
 * ⚠️ **历史脚本（v1，0.1.0）**：v2 原生重做后它引用的 `lib/jobs.js` / `lib/check.js` /
 * `lib/mutex.js` 都不存在了，`npm run verify` 也**不跑**它。留在这里只为考古，**不要**把它
 * 的断言当现行契约（例如「/ralphflow-start 是命令」在 v2 已不成立：启动类入口现在是**技能**，
 * 见 `docs/v2/skills-vs-commands.md`）。现行验收面 = `scripts/*-test.mjs`。
 */
/**
 * Ralph Flow for dsh — 端到端验证脚本（verify 步骤）
 *
 * 模型配额 429 时无法跑真实验证者。本脚本用可控的 stub 验证者（ctx.subagents.start
 * 返回预设 verdict）驱动**真实插件链路**（tools → jobs.onSessionEvent → driver →
 * check/check-voting → engine），覆盖：
 *   1) 插件装配：8 工具 + 8 命令注册齐全
 *   2) 人工门全链路：manual 步 DO 完成 → 真实停门（.manual-gate 写入 + gate 帧 +
 *      不自动进验证）→ continue 批准 → stub 验证通过 → 完成归档 + 验证者会话登记清理
 *   3) no_check 步骤：缺 check 的合法步骤保留并在 DO 完成后直通 on_pass
 *   4) 失败路径：CHECK FAIL → 失败计数递增 → on_fail 回环 → 重试 DO
 *   5) 跨"进程重启"接管：新 engine 读同一 state.json → continue 接管
 *   6) status 升级字段（属主/最后活动/失败原因/友好暂停文案）
 *   7) 输入防御：start 缺任务描述拒绝；实例互斥锁串行化
 *   8) 权限：验证者 edit 硬拒 + 只读 toolFilter
 *
 * 产出：打印 PASS/FAIL 断言 + 退出码。
 */
import { Context } from "@deepseek-ai/cordis";
import { createEngine, type RalphFlowState } from "./lib/engine.js";
import { registerTools, type ToolHandlers } from "./lib/tools.js";
import { createJobManager, onSessionEvent } from "./lib/jobs.js";
import { withInstanceLock } from "./lib/mutex.js";
import { VERIFIER_TOOL_ALLOW } from "./lib/check.js";
import type { Engine } from "./lib/engine.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let passCount = 0;
let failCount = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; failures.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rf-e2e-"));

// ── 测试工作流 ────────────────────────────────────────────────────────────
const WF_DIR = path.join(ROOT, "ralph-flow", "workflows");
fs.mkdirSync(WF_DIR, { recursive: true });
// 多步：stepA（带 check）→ nocheck（无 check，直通）→ stepC（带 check）
fs.writeFileSync(path.join(WF_DIR, "e2e.yaml"), `description: e2e 验证工作流
steps:
  - id: stepA
    desc: 第一步
    do: 完成步骤 A
    input: 用户任务
    output: 步骤 A 产出
    check: 验证步骤 A 产出正确
    on_pass: nocheck
    on_fail: stepA
    max_fail_count: 3
  - id: nocheck
    desc: 无独立验证步骤
    do: 完成无验证任务
    input: 步骤 A 产出
    output: 无验证产出
    on_pass: done
    on_fail: nocheck
    max_fail_count: 3
`);
// 单步人工门工作流
fs.writeFileSync(path.join(WF_DIR, "gate.yaml"), `description: 单步人工门
manual_step:
  - build
steps:
  - id: build
    desc: 构建步骤
    do: 完成构建
    input: 用户任务
    output: 构建产出
    check_voting:
      - check: 验证构建产出正确
      - check: 验证构建产出完整
      - check: 验证构建无回归
    on_pass: done
    on_fail: build
    max_fail_count: 3
`);

console.log("== 验证 1: 插件 host 端装配 ==");
const ctx = new Context();
const registeredTools: string[] = [];
/** stub 验证者的判定队列："pass" | "fail" | "infra:<reason>"；逐次消费 */
const verdictQueue: string[] = [];
const registeredVerifierSessions: string[] = [];

ctx.tools = { register(d: any) { if (d?.name) registeredTools.push(d.name); }, get() { return undefined; } };
const commandDefs = new Map<string, any>();
ctx.commands = { register(d: any) { registeredTools.push("cmd:" + d.name); if (d?.name && d.handler) commandDefs.set(d.name, d); } };
ctx.jobs = {
  attachController() {},
  start() { return "job-x"; },
  kill(id?: string) { killedJobCalls.push(String(id)); },
};
// jobs.kill 调用记录（归档失败防御用例断言守护 job 被终止、不悬挂）
const killedJobCalls: string[] = [];
ctx.sessions = { get: () => undefined, list: () => [] };
ctx.agents = { get() { return undefined; } };
// stub 验证者：按 verdictQueue 出队返回 <promise-check>true/false</promise-check>
(ctx as any).subagents = {
  start(_name: string, opts: any) {
    const v = verdictQueue.shift() ?? "pass";
    const text = v === "fail"
      ? "实现不完整，缺少导出。\n<promise-check>false</promise-check>"
      : v.startsWith("infra:")
        ? `${v.slice(6)}`
        : "检查通过，实现完整。\n<promise-check>true</promise-check>";
    void opts;
    return Promise.resolve({
      result: Promise.resolve({ output: [{ type: "text", text }], stopReason: "stop" }),
    });
  },
};
ctx.logger = { warn() {}, info() {}, error() {} };

const engine: Engine = createEngine(ROOT, {});
// 会话收集器：真实 emitter 经 session.append 发帧；这里挂一个 mock session
// 承接全部 tool-ralphflow/* 帧（模拟 client 折叠器的数据源）
const emittedFrames: { instId: string; type: string; data: any }[] = [];
// UI 帧发射证据：emit 现在只写实例审计日志（execution.log）——帧断言从日志读
const uiFrames = (instId: string) => engine.readUiEventFrames(instId);
// 实例归档销毁后 execution.log 被拷贝到 reports/<id>-execution.log——从副本读
const archivedFrames = (instId: string) => {
  try {
    const file = path.join(engine.getReportsDir(), `${instId}-execution.log`);
    if (!fs.existsSync(file)) return [] as { type: string; data: any }[];
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => {
      try {
        const e = JSON.parse(l);
        if (typeof e.event !== "string" || !e.event.startsWith("ui_event_tool-ralphflow/")) return null;
        const data = { ...e };
        delete data.ts; delete data.level; delete data.event;
        return { type: String(e.event).slice("ui_event_".length), data };
      } catch { return null; }
    }).filter(Boolean) as { type: string; data: any }[];
  } catch { return []; }
};
const mockSession = {
  id: "s1",
  append(t: string, d: unknown) { emittedFrames.push({ instId: "", type: t, data: d as any }); },
  events: [],
};
(ctx as any).sessions.get = (id: string) => (id === mockSession.id ? mockSession : undefined);
// 带会话的 agent：start/continue 以此定位属主并承接事件帧；
// followup 记录注入消息（验证命令路径 → 模型上下文的链路）
const followupMessages: string[] = [];
const mockAgent = {
  session: mockSession,
  followup(m: any) { followupMessages.push(m?.content?.[0]?.text ?? ""); },
} as any;

const getAgent = () => undefined;
const jobs = createJobManager({ ctx, engine, getAgent });
const handlers: ToolHandlers = registerTools({ ctx, engine, jobs, getAgent });

// 命令路径注册（真实 registerCommands：handler 型命令 + followup 注入桥）
await import("./lib/commands.js").then((m) => m.registerCommands({
  ctx, engine, jobs,
  getAgent,
  runTool: (n, a, ag) => handlers.get(n)?.(a, ag) ?? `missing ${n}`,
}));

const wfE2E = engine.loadWorkflow("e2e");
const wfGate = engine.loadWorkflow("gate");
check("工作流 e2e/gate 可加载", !!wfE2E && !!wfGate);
check("no_check 步骤被保留并标注", !!(wfE2E!.steps.find((s) => s.id === "nocheck") as any)?.no_check);
check("no_check 步骤不破坏工作流校验（2 步全在）", wfE2E!.steps.length === 2);

// create 双端落地
check("ralphflow_create 工具已注册（模型侧设计指引入口）", handlers.has("ralphflow_create"));
check("create 工具返回完整设计指引", (await handlers.get("ralphflow_create")!({}, undefined)).includes("ralphflow_doctor"));

// ── 验证 2: 人工门全链路（stub 验证者）─────────────────────────────────────
console.log("== 验证 2: 人工门全链路（DO 完成→停门→批准→投票→完成）==");
verdictQueue.push("pass", "pass", "pass"); // gate 步 3 票全过
const start = handlers.get("ralphflow_start")!;
const startText = await start({ workflow: "gate", task: "e2e 人工门任务" }, mockAgent);
check("gate 工作流启动成功", startText.includes("已启动"), startText.slice(0, 60));
check("启动文本包含接下来会发生什么的引导", startText.includes("接下来会发生什么"));
const gateId = engine.listInstances().find((i) => i.state.workflow_name === "gate")!.id;

// 模型输出 done → job 同一事件链路（直接调 onSessionEvent）
await onSessionEvent({ ctx, engine, getAgent }, gateId, {
  type: "assistant/message",
  data: { message: { role: "assistant", content: [{ type: "text", text: "构建完成。\n\n<promise>done</promise>" }] } },
});
const afterDone = engine.readState(gateId)!;
check("manual 步 DO 完成后停在 DO 阶段（未自动进验证）", afterDone.current_phase === "do" && !afterDone.paused, `phase=${afterDone.current_phase}`);
check(".manual-gate 标记已写入", engine.markerExists(".manual-gate", gateId));
check("发射了 gate 事件帧", uiFrames(gateId).some((f) => f.type === "tool-ralphflow/gate"));
{
  const g = uiFrames(gateId).find((f) => f.type === "tool-ralphflow/gate");
  check("gate 帧带任务要求摘要（审批材料）", !!g && typeof g.data?.taskExcerpt === "string" && g.data.taskExcerpt.includes("构建"), String(g?.data?.taskExcerpt ?? "").slice(0, 40));
}
check("done 去重标记已写入（防重复驱动）", fs.existsSync(path.join(engine.getInstanceDir(gateId), ".done-tag-detected")));
// 重复 done 消息不应重复驱动
const gateFramesBefore = uiFrames(gateId).filter((f) => f.type === "tool-ralphflow/gate").length;
await onSessionEvent({ ctx, engine, getAgent }, gateId, {
  type: "assistant/message",
  data: { message: { role: "assistant", content: [{ type: "text", text: "<promise>done</promise>" }] } },
});
check("重复 done 消息不再触发 gate 帧", uiFrames(gateId).filter((f) => f.type === "tool-ralphflow/gate").length === gateFramesBefore);
check("验证者会话登记已全部清理", engine.readAdversarialSessions(gateId).length === 0, String(engine.readAdversarialSessions(gateId).length));

// continue 批准 → 进入验证（stub 3 票全过）→ on_pass done → 完成归档
const cont = handlers.get("ralphflow_continue")!;
const approveText = await cont({}, mockAgent);
check("continue 批准后工作流完成", approveText.includes("完成"), approveText.slice(0, 80));
check("实例已归档销毁（active=false 或目录删除）", (() => { const st = engine.readState(gateId); return st === null || st.active === false; })());
check("发射了 run-end done 帧", archivedFrames(gateId).some((f) => f.type === "tool-ralphflow/run-end" && f.data?.stopReason === "done"));
check("报告文件已生成", fs.existsSync(engine.getReportPath(gateId)));
check("验证票 verdict 帧逐票推送（≥3）", archivedFrames(gateId).filter((f) => f.type === "tool-ralphflow/check-verdict").length >= 3);
// 可观测等待：voter 启动帧逐个点亮 + verdict 帧带到达时刻
check("check-voter-start 帧逐票发射（≥3，黑盒期可观测）", archivedFrames(gateId).filter((f) => f.type === "tool-ralphflow/check-voter-start").length >= 3);
const voterStartFrame = archivedFrames(gateId).find((f) => f.type === "tool-ralphflow/check-voter-start");
check("voter-start 帧带 voter/count/startedAt", !!voterStartFrame && typeof voterStartFrame.data?.voter === "number" && typeof voterStartFrame.data?.count === "number" && typeof voterStartFrame.data?.startedAt === "number");
const verdictFrame = archivedFrames(gateId).find((f) => f.type === "tool-ralphflow/check-verdict");
check("verdict 帧带 arrivedAt（该票用时数据源）", !!verdictFrame && typeof verdictFrame.data?.arrivedAt === "number");
const checkStepStartFrame = archivedFrames(gateId).find((f) => f.type === "tool-ralphflow/step-start" && f.data?.phase === "check");
check("step-start check 帧带 timeoutMs（超时进度条终点感）", !!checkStepStartFrame && typeof checkStepStartFrame.data?.timeoutMs === "number" && checkStepStartFrame.data.timeoutMs > 0);
// 归档索引：销毁即记账（历史成为系统可回答的问题）
const historyFile = path.join(engine.getRalphFlowDir(), "history.jsonl");
check("history.jsonl 归档索引已记账", fs.existsSync(historyFile) && fs.readFileSync(historyFile, "utf-8").includes(gateId));
// step-start 帧携带时间戳（client 卡「已运行 Xm」的数据源）
const checkStepStart = archivedFrames(gateId).find((f) => f.type === "tool-ralphflow/step-start");
check("step-start 帧存在（ts 为日志元数据，归档读取已剥离）", !!checkStepStart);

// ── 验证 3: no_check 直通 ──────────────────────────────────────────────────
console.log("== 验证 3: no_check 步骤直通（无验证者消耗）==");
verdictQueue.push("pass"); // 仅 stepA 需要 1 票；nocheck 不应消费
const startText2 = await start({ workflow: "e2e", task: "e2e 无验证链路" }, mockAgent);
check("e2e 工作流启动成功", startText2.includes("已启动"));
const e2eId = engine.listInstances().find((i) => i.state.workflow_name === "e2e")!.id;
await onSessionEvent({ ctx, engine, getAgent }, e2eId, {
  type: "assistant/message",
  data: { message: { content: [{ type: "text", text: "A 完成。<promise>done</promise>" }] } },
});
let st2 = engine.readState(e2eId)!;
check("stepA 验证通过后推进到 nocheck", st2.current_step === "nocheck" && st2.current_phase === "do", `${st2.current_step}/${st2.current_phase}`);
await onSessionEvent({ ctx, engine, getAgent }, e2eId, {
  type: "assistant/message",
  data: { message: { content: [{ type: "text", text: "无验证步完成。<promise>done</promise>" }] } },
});
st2 = engine.readState(e2eId)!;
check("no_check 步骤 DO 完成即直通完成（不调用验证者）", st2 === null || st2.active === false, st2 ? `${st2.current_step}/${st2.current_phase}` : "destroyed");
check("no_check 全程只消耗了 stepA 的 1 票（队列剩余 0）", verdictQueue.length === 0, `left=${verdictQueue.length}`);
check("e2e 实例报告归档", fs.existsSync(engine.getReportPath(e2eId)));

// ── 验证 4: 失败路径 ───────────────────────────────────────────────────────
console.log("== 验证 4: CHECK FAIL → 计数递增 + on_fail 回环 ==");
verdictQueue.push("fail");
const startText3 = await start({ workflow: "gate", task: "失败路径任务" }, mockAgent);
check("第二个 gate 实例启动", startText3.includes("已启动"));
const failId = engine.listInstances().find((i) => i.state.user_task === "失败路径任务")!.id;
await onSessionEvent({ ctx, engine, getAgent }, failId, {
  type: "assistant/message",
  data: { message: { content: [{ type: "text", text: "<promise>done</promise>" }] } },
});
// manual 门先停
check("失败场景同样先停人工门", engine.markerExists(".manual-gate", failId));
const contText = await handlers.get("ralphflow_continue")!({}, mockAgent);
const afterFail = engine.readState(failId)!;
check("FAIL 后失败计数递增到 1", afterFail.fail_count === 1, String(afterFail.fail_count));
check("FAIL 后 on_fail 回环重做本步", afterFail.current_step === "build" && afterFail.current_phase === "do");
check("过渡文本含失败原因与重试提示", /不通过|失败/.test(contText));
// 清场：failId 回环到 DO 后仍占着本会话的"每会话一实例"名额
await handlers.get("ralphflow_cancel")!({ instance: failId }, mockAgent);

// ── 验证 5: 跨"进程重启"接管 + 投票进度恢复 ────────────────────────────────
console.log("== 验证 5: 重启接管 + 中断验证续跑（保留已投票数）==");
// 直接构造一个卡在 check、有部分投票进度的实例（模拟进程在验证期间重启）
const rId = engine.generateInstanceId(wfGate!);
fs.mkdirSync(engine.getInstanceDir(rId), { recursive: true });
engine.writeState({ active: true, workflow_name: "gate", current_step: "build", current_phase: "check", fail_count: 0, user_task: "重启恢复任务", paused: false }, rId);
// 写入一份进度：第 1 票已通过
fs.writeFileSync(path.join(engine.getInstanceDir(rId), ".check-voting-progress.json"), JSON.stringify({
  stepId: "build", workflowName: "gate", updatedAt: new Date().toISOString(),
  entries: [
    { index: 0, check: "验证构建产出正确", model: null, status: "passed", reason: "ok" },
    { index: 1, check: "验证构建产出完整", model: null, status: "pending", reason: "" },
    { index: 2, check: "验证构建无回归", model: null, status: "pending", reason: "" },
  ],
}));
verdictQueue.push("pass", "pass");
const resumeText = await handlers.get("ralphflow_continue")!({ instance: rId }, mockAgent);
check("重启后 continue 恢复而非回退 DO", !resumeText.includes("崩溃恢复"), resumeText.slice(0, 60));
check("恢复后完成（补跑 2 票全过）", (() => { const s = engine.readState(rId); return s === null || s.active === false; })());
check("恢复路径只补跑了 2 票", verdictQueue.length === 0, `left=${verdictQueue.length}`);

// ── 验证 6: status 升级字段 ────────────────────────────────────────────────
console.log("== 验证 6: status 输出升级（属主/最后活动/失败原因/暂停文案）==");
const pId = engine.generateInstanceId(wfGate!);
fs.mkdirSync(engine.getInstanceDir(pId), { recursive: true });
engine.writeState({ active: true, workflow_name: "gate", current_step: "build", current_phase: "do", fail_count: 1, user_task: "status 任务", paused: true, pause_reason: "max_failures", last_failure_reason: "缺少导出函数 foo" }, pId);
engine.writeMarker(".manual-step-active", "active", pId);
engine.recordStepStart(pId, "build", "do");
const statusOf = await import("./lib/driver.js").then((m) => m.statusText);
const stText = statusOf(engine, pId, "sess-abc123");
check("status 含属主会话短 id", stText.includes("sess-ab") || stText.includes("属主"));
check("status 含最后活动时间", stText.includes("最后活动"));
check("status 含上次失败原因全文", stText.includes("缺少导出函数 foo"));
check("status 用友好暂停文案（非内部枚举）", stText.includes("最大失败次数") && !stText.includes("max_failures）"));

// ── 验证 7: 输入防御与互斥 ────────────────────────────────────────────────
console.log("== 验证 7: 输入防御 + 实例互斥锁 ==");
const emptyTask = await handlers.get("ralphflow_start")!({ workflow: "gate", task: "   " }, mockAgent);
check("空任务描述被拒绝并给出用法", emptyTask.includes("缺少任务描述"), emptyTask.slice(0, 50));
const badWf = await handlers.get("ralphflow_start")!({ workflow: "gate" }, mockAgent);
check("缺任务时即使工作流存在也拒绝", badWf.includes("缺少任务描述"));
let order: number[] = [];
await Promise.all([
  withInstanceLock("lock-test", async () => { order.push(1); await new Promise((r) => setTimeout(r, 50)); order.push(2); }),
  withInstanceLock("lock-test", async () => { order.push(3); }),
]);
check("互斥锁串行化同实例操作（1,2 先于 3）", JSON.stringify(order) === "[1,2,3]", JSON.stringify(order));

// ── 验证 8: doctor 与权限 ─────────────────────────────────────────────────
console.log("== 验证 8: doctor 文案 + 权限 ==");
const doc = engine.buildDoctorReport();
check("doctor 不再引用幽灵命令 /ralphflow-create", !doc.includes("/ralphflow-create"));
check("doctor 不再泄漏 ${RALPH_FLOW_DIR} 字面占位符", !doc.includes("${RALPH_FLOW_DIR}"));
check("验证者 toolFilter 只读白名单", !VERIFIER_TOOL_ALLOW.includes("edit") && VERIFIER_TOOL_ALLOW.includes("read"));

// ── 验证 9: 报告归档失败防御（C3 回归：拒绝销毁 + 可恢复）────────────────
console.log("== 验证 9: 归档失败 → destroyInstance 拒绝销毁、现场保留、可重试 ==");
// 注入方式：把真 reports 目录改名藏起，用**同名普通文件**占位——mkdir/write
// 全部 ENOTDIR 失败，archiveReport 稳定返回 null（不依赖 chmod，跨环境可靠）。
const reportsDir = engine.getReportsDir();
const occupyReports = () => {
  fs.renameSync(reportsDir, reportsDir + ".e2e-bak");
  fs.writeFileSync(reportsDir, "occupied by e2e archive-failure probe");
};
const freeReports = () => {
  fs.unlinkSync(reportsDir);
  fs.renameSync(reportsDir + ".e2e-bak", reportsDir);
};

// 场景 A：完成路径归档失败 → 实例完整保留 + archive_failed 暂停
occupyReports();
verdictQueue.push("pass", "pass", "pass");
const startA = await start({ workflow: "gate", task: "归档失败完成任务" }, mockAgent);
check("场景A 实例启动", startA.includes("已启动"));
const archId = engine.listInstances().find((i) => i.state.user_task === "归档失败完成任务")!.id;
await onSessionEvent({ ctx, engine, getAgent }, archId, {
  type: "assistant/message",
  data: { message: { content: [{ type: "text", text: "构建完成。<promise>done</promise>" }] } },
});
emittedFrames.length = 0;
killedJobCalls.length = 0;
const contA = await handlers.get("ralphflow_continue")!({}, mockAgent); // 批准门 → 3票过 → 完成时归档失败
const stA = engine.readState(archId)!;
check("完成路径归档失败：实例未被销毁（active=true）", !!stA && stA.active === true);
check("置专用 archive_failed 暂停（非 check_error，避免重跑验证）", stA.paused === true && stA.pause_reason === "archive_failed", `reason=${stA.pause_reason}`);
check("step-records.json 保留在实例目录", fs.existsSync(path.join(engine.getInstanceDir(archId), "logs", "step-records.json")));
check("execution.log 保留在实例目录", fs.existsSync(path.join(engine.getInstanceDir(archId), "logs", "execution.log")));
check("未生成任何报告文件", !engine.reportExists(archId));
check("返回文本如实报「归档失败」且不谎称完成", contA.includes("归档失败") && !contA.includes("工作流完成！"), contA.slice(0, 80));
check("发射了 run-end failed 帧（UI 进入可恢复暂停态）", uiFrames(archId).some((f) => f.type === "tool-ralphflow/run-end" && f.data?.stopReason === "failed"));

// 场景 A 续：解除障碍 → continue 只重试归档（绝不重跑验证）
freeReports();
emittedFrames.length = 0;
const retryText = await handlers.get("ralphflow_continue")!({ instance: archId }, mockAgent);
check("重试归档后如实完成", retryText.includes("完成"), retryText.slice(0, 60));
check("实例已销毁", engine.readState(archId) === null);
check("报告已补归档", fs.existsSync(engine.getReportPath(archId)));
check("补发 report 帧", archivedFrames(archId).some((f) => f.type === "tool-ralphflow/report"));
check("补发 run-end done 帧", archivedFrames(archId).some((f) => f.type === "tool-ralphflow/run-end" && f.data?.stopReason === "done"));
check("重试归档零新验证票（未白烧 token）", verdictQueue.length === 0, `left=${verdictQueue.length}`);

// 场景 B：cancel 路径归档失败 → 拒绝删除 + 暂停 + kill job + failed 帧
occupyReports();
const startB = await start({ workflow: "gate", task: "取消归档失败任务" }, mockAgent);
check("场景B 实例启动", startB.includes("已启动"));
const cancelId = engine.listInstances().find((i) => i.state.user_task === "取消归档失败任务")!.id;
emittedFrames.length = 0;
killedJobCalls.length = 0;
const cancelText1 = await handlers.get("ralphflow_cancel")!({ instance: cancelId }, mockAgent);
const stB = engine.readState(cancelId)!;
check("cancel 归档失败：返回「取消未完成」而非谎称成功", cancelText1.includes("取消未完成"));
check("cancel 路径实例未被销毁", !!stB && stB.active === true);
check("cancel 路径置 cancel_archive_failed 暂停", stB.paused === true && stB.pause_reason === "cancel_archive_failed", `reason=${stB.pause_reason}`);
check("cancel 路径实例目录完整保留（state/logs/execution.log）", !!stB && fs.existsSync(path.join(engine.getInstanceDir(cancelId), "logs", "execution.log")));
check("cancel 路径执行记录可解析（未被销毁）", Array.isArray(engine.loadStepRecords(cancelId)));
check("cancel 归档失败发射 run-end failed 帧（UI 不滞留运行态）", uiFrames(cancelId).some((f) => f.type === "tool-ralphflow/run-end" && f.data?.stopReason === "failed"));
check("cancel 归档失败杀掉守护 job（不悬挂）", killedJobCalls.length > 0, JSON.stringify(killedJobCalls));

// 场景 B 续-a：continue 放弃取消 → 走通用暂停恢复（重建 job、回 DO），不误入归档分支
freeReports();
const resumeCancelText = await handlers.get("ralphflow_continue")!({ instance: cancelId }, mockAgent);
const stB2 = engine.readState(cancelId)!;
check("放弃取消后恢复 DO（走通用暂停分支）", !!stB2 && !stB2.paused && stB2.current_phase === "do" && resumeCancelText.includes("恢复"), `${stB2?.paused}/${stB2?.current_phase}`);
// 清场：此时 reports 已可用，直接取消成功
const cancelText2 = await handlers.get("ralphflow_cancel")!({ instance: cancelId }, mockAgent);

// 场景 B 续-b：解除障碍后重试 cancel 成功
occupyReports();
const startC = await start({ workflow: "gate", task: "取消重试任务" }, mockAgent);
const retryId = engine.listInstances().find((i) => i.state.user_task === "取消重试任务")!.id;
await handlers.get("ralphflow_cancel")!({ instance: retryId }, mockAgent); // 第一次取消失败
freeReports();
emittedFrames.length = 0;
const cancelText3 = await handlers.get("ralphflow_cancel")!({ instance: retryId }, mockAgent);
check("障碍解除后重试 cancel 成功", cancelText3.includes("已取消"), cancelText3.slice(0, 50));
check("重试 cancel 后实例销毁", engine.readState(retryId) === null);
check("重试 cancel 后报告已归档", fs.existsSync(engine.getReportPath(retryId)));
check("重试 cancel 发射 run-end cancelled 帧", archivedFrames(retryId).some((f) => f.type === "tool-ralphflow/run-end" && f.data?.stopReason === "cancelled"));

// ── 验证 10: slash 命令 → 模型注入桥（dsh handler 型命令的开工链路）────────
console.log("== 验证 10: 命令路径 followup 注入（start 后当前会话立即开工）==");
const dispatchCmd = async (line: string) => {
  const trimmed = line.trim().replace(/^\//, "");
  const sp = trimmed.indexOf(" ");
  const name = sp < 0 ? trimmed : trimmed.slice(0, sp);
  const raw = sp < 0 ? "" : trimmed.slice(sp + 1);
  const def = commandDefs.get(name);
  if (!def) throw new Error(`command not registered: ${name}`);
  return def.handler({ rawInput: raw, agent: mockAgent, signal: new AbortController().signal });
};
check("静态管理命令已注册（9 个）", ["ralphflow-start", "ralphflow-continue", "ralphflow-status", "ralphflow-list", "ralphflow-cancel", "ralphflow-rewind", "ralphflow-reset", "ralphflow-doctor", "ralphflow-unbrick"].every((n) => commandDefs.has(n)));
check("动态快捷命令已注册（/loop /spec /gate /e2e）", ["loop", "spec", "gate", "e2e"].every((n) => commandDefs.has(n)));

followupMessages.length = 0;
await dispatchCmd("/ralphflow-start e2e 命令注入任务");
check("/ralphflow-start 触发 followup 注入（模型收到开工指令）", followupMessages.length === 1, String(followupMessages.length));
check("注入文本带来源说明且含 DO 指令特征", !!followupMessages[0]?.includes("[ralphflow]") && /done|步骤|任务/.test(followupMessages[0] ?? ""));
const cmdStartId = engine.listInstances().find((i) => i.state.user_task === "命令注入任务")!.id;

followupMessages.length = 0;
await dispatchCmd("/ralphflow-status");
check("/ralphflow-status 查询不注入模型上下文", followupMessages.length === 0, String(followupMessages.length));

followupMessages.length = 0;
const cmdCancel1 = await dispatchCmd(`/ralphflow-cancel ${cmdStartId}`);
check("cancel 结果只进结果卡、不注入模型", followupMessages.length === 0, String(followupMessages.length));
check("命令路径实例已取消", engine.readState(cmdStartId) === null);

followupMessages.length = 0;
await dispatchCmd("/gate 动态快捷启动任务");
check("动态快捷命令 /gate 同样注入", followupMessages.length === 1, String(followupMessages.length));
const cmdGateId = engine.listInstances().find((i) => i.state.user_task === "动态快捷启动任务")!.id;
await dispatchCmd(`/ralphflow-cancel ${cmdGateId}`);
check("第二个命令路径实例已取消清场", engine.readState(cmdGateId) === null);

// ── P0 回归：命令路径绝不向会话 log 写插件自定义帧（自定义事件类型会砖掉
//    会话的持久化读路径；命令结果卡一律走官方 command/run + command/done）───
check("命令路径不调用 session.append 写自定义帧（防砖化回归）", emittedFrames.every((f) => !String(f.type).startsWith("tool-ralphflow/")), JSON.stringify(emittedFrames.map((f) => f.type)));
check("unbrick 工具已注册（会话解砖入口）", handlers.has("ralphflow_unbrick"));
const doctorText = await handlers.get("ralphflow_doctor")!({}, undefined);
check("doctor 输出含会话卫生检查节", doctorText.includes("会话卫生"), doctorText.slice(0, 60));
const hygiene = await import("./lib/session-hygiene.js");
check("会话卫生扫描模块可调用（只读不修改）", Array.isArray(hygiene.scanSessionLogs()));

// ── 验证 11: 接管即历史重放（新会话翻开的是有目录的档案，不是文字墙）──────
console.log("== 验证 11: continue 接管 → execution.log UI 帧重放到新会话 ==");
// 构造一个属主为旧会话的实例 + 一份含 UI 帧的执行日志
const rpId = engine.generateInstanceId(wfE2E!);
fs.mkdirSync(engine.getInstanceDir(rpId), { recursive: true });
engine.writeState({ active: true, workflow_name: "e2e", current_step: "stepA", current_phase: "do", fail_count: 0, user_task: "接管重放任务", paused: false, session_id: "s-old" }, rpId);
engine.logEvent(rpId, "info", "workflow_start", {});
engine.logEvent(rpId, "info", "ui_event_tool-ralphflow/run-start", { runId: rpId, workflow: "e2e", task: "接管重放任务", steps: [{ id: "stepA", desc: "第一步" }] });
engine.logEvent(rpId, "info", "ui_event_tool-ralphflow/step-start", { runId: rpId, step: "stepA", phase: "do", failCount: 0, ts: Date.now() - 60_000 });
engine.logEvent(rpId, "info", "非ui事件不应被重放", { noise: true });
const framesProbe = engine.readUiEventFrames(rpId);
check("readUiEventFrames 只提取 UI 帧（过滤普通日志）", framesProbe.length === 2 && framesProbe[0].type === "tool-ralphflow/run-start", JSON.stringify(framesProbe.map((f) => f.type)));
emittedFrames.length = 0;
const takeoverText = await handlers.get("ralphflow_continue")!({ instance: rpId }, mockAgent);
check("接管成功（attached 分支返回继续执行文本）", takeoverText.includes("接管") || takeoverText.includes("继续"), takeoverText.slice(0, 50));
check("接管后实例属主已切换到当前会话", engine.readState(rpId)?.session_id === mockSession.id);
check("历史重放素材完整（run-start+step-start 在日志中，UI 可重建）", (() => {
  const f = engine.readUiEventFrames(rpId);
  return f.some((x) => x.type === "tool-ralphflow/run-start") && f.some((x) => x.type === "tool-ralphflow/step-start");
})());
check("重放不含普通日志噪音", !engine.readUiEventFrames(rpId).some((f) => String((f.data as any)?.noise ?? "") === "true" || f.type.includes("非ui")));
check("旧属主收到 run-detach 帧（僵尸「运行中」根治）", (() => {
  // detach 帧发往 previousOwner（s-old）；审计日志记录其发射
  const frames = engine.readUiEventFrames(rpId);
  return frames.some((f) => f.type === "tool-ralphflow/run-detach" && f.data?.reason);
})());
// 清场 + 跨会话取消通知：实例属主被接管为当前会话（s1），再改回旧会话后取消——
// 属主与取消者两侧的终态帧都必须发射（现在只写审计日志，去重维度不再误杀）
engine.claimOwnership(rpId, "s-old");
await handlers.get("ralphflow_cancel")!({ instance: rpId }, mockAgent);
{
  const logged = archivedFrames(rpId).filter((f) => f.type === "tool-ralphflow/run-end" && f.data?.stopReason === "cancelled");
  check("跨会话取消：属主与取消者两侧终态帧都已发射", logged.length >= 2, `归档日志中 run-end cancelled=${logged.length}`);
}
check("重放验证实例已清场", engine.readState(rpId) === null);

// ── 验证 12: HTTP 快照富字段 / 抽屉动作分发 / DO prompt 截断 / doctor 资源 ──
console.log("== 验证 12: 快照富字段 / 动作分发（actions.ts）/ DO 截断 / doctor 资源 ==");
// 12a: check 相位快照带超时上限与起点（抽屉「剩余时间」进度条的数据源）
const snapId = engine.generateInstanceId(wfGate!);
fs.mkdirSync(engine.getInstanceDir(snapId), { recursive: true });
engine.writeState({ active: true, workflow_name: "gate", current_step: "build", current_phase: "check", fail_count: 0, user_task: "快照富字段", paused: false, session_id: "s1" }, snapId);
engine.recordStepStart(snapId, "build", "check");
{
  const snap = engine.snapshotAllInstances().find((s) => s.runId === snapId);
  check("check 相位快照带 timeoutMs（默认 15 分钟）", (snap as any)?.timeoutMs === 900000, String((snap as any)?.timeoutMs));
  check("check 相位快照带 checkStartedAt", typeof (snap as any)?.checkStartedAt === "number" && (snap as any).checkStartedAt > 0);
}
// 12b: 抽屉动作分发（POST 端点的心智，白名单 + 超时 + 注入）
const { dispatchAction } = await import("./lib/actions.js");
{
  const actionFollowups: string[] = [];
  const actionDeps = {
    engine,
    handlers: new Map<string, any>([
      ["ralphflow_continue", () => "继续了"],
      ["ralphflow_cancel", () => "## 已取消\n\n实例 x 已取消"],
      ["ralphflow_reset", (args: any) => `重置:${String(args?.reason ?? "")}`],
    ]),
    getAgent: (id: string) => (id === "s1" ? mockAgent : undefined),
    deliverToModel: (_a: any, _c: string, text: string) => { actionFollowups.push(text); },
  };
  const app = await dispatchAction(actionDeps, { action: "approve", sessionId: "s1", runId: "x" });
  check("approve 白名单动作 ok 且后台推进可等待", app.ok === true && !!app.fire && (await app.fire!) === "继续了");
  const res = await dispatchAction(actionDeps, { action: "resume", sessionId: "s1", runId: "x" });
  check("resume 动作 await 并注入模型", res.ok === true && actionFollowups.some((m) => m.includes("继续了")));
  check("return 无意见拒绝（绝不代发空打回）", (await dispatchAction(actionDeps, { action: "return", sessionId: "s1", runId: "x" })).ok === false);
  check("return 带意见传给 reset 并注入模型", (await dispatchAction(actionDeps, { action: "return", sessionId: "s1", runId: "x", reason: "补测试" })).ok === true && actionFollowups.some((m) => m.includes("重置:补测试")));
  check("cancel 动作快路径返回结果", (await dispatchAction(actionDeps, { action: "cancel", sessionId: "s1", runId: "x" })).text.includes("已取消"));
  check("未知动作拒绝", (await dispatchAction(actionDeps, { action: "explode", sessionId: "s1" })).ok === false);
  check("无效 sessionId 拒绝", (await dispatchAction(actionDeps, { action: "cancel", sessionId: "ghost" })).ok === false);
}
// 12c: DO/CHECK prompt 长文本截断（token 成本控制，截断处明确标注）
{
  const bigStep: any = { id: "big", desc: "大内容", do: "x".repeat(9000), input: "i".repeat(3000), output: "o", check: "c", max_fail_count: 3, on_pass: "done", on_fail: "big" };
  const prompt = engine.buildDoPrompt(snapId, bigStep, "u".repeat(5000), undefined, 1);
  check("超长 do 内容截断并标注", prompt.includes("已截断") && !prompt.includes("x".repeat(9000)));
  check("超长用户任务截断", prompt.includes("u".repeat(4000)) && !prompt.includes("u".repeat(5000)));
}
// 12d: doctor 资源占用报告
{
  const doc2 = await handlers.get("ralphflow_doctor")!({}, undefined);
  check("doctor 含资源占用节", doc2.includes("资源占用"), doc2.slice(0, 80));
}
engine.destroyInstance(snapId, "cancelled");
check("快照/截断验证实例已清场", engine.readState(snapId) === null);

console.log(`\n===== E2E RESULT: ${passCount} PASS / ${failCount} FAIL =====`);
if (failCount > 0) {
  console.log("失败项:", failures.join(", "));
  process.exit(1);
}
fs.rmSync(ROOT, { recursive: true, force: true });
console.log("E2E VERIFY OK");
