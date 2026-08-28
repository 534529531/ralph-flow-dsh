/**
 * Ralph Flow for dsh — 无头加载冒烟测试
 *
 * 在最小 cordis Context + mock 服务上加载 host 端 apply()，验证插件可被加载、
 * 工具/命令完成注册、引擎能创建实例并跑通状态机核心流程（不依赖真实模型）。
 */
import { Context } from "@deepseek-ai/cordis";
import { createEngine } from "./lib/engine.js";
import { registerTools } from "./lib/tools.js";
import { registerCommands } from "./lib/commands.js";
import { createJobManager } from "./lib/jobs.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rf-host-"));
const registeredTools: string[] = [];
const registeredCommands: string[] = [];

const ctx = new Context();
const sessions = new Map<string, any>();
const mockSession = {
  id: "s1",
  header: { cwd: tmp },
  events: [],
  on() { return () => {}; },
  append() {},
};
sessions.set("s1", mockSession);

ctx.tools = {
  register(def: any) {
    if (def && def.name) registeredTools.push(def.name);
  },
  get() { return undefined; },
};
const runningJobs = new Map<string, { run: () => unknown }>();
ctx.jobs = {
  attachController() {},
  start(spec: any) {
    const id = "ralphflow-job-" + (runningJobs.size + 1);
    runningJobs.set(id, spec);
    spec.run();
    return id;
  },
  kill(id: string) { runningJobs.delete(id); },
};
ctx.commands = {
  register(def: any) { registeredCommands.push(def.name); },
};
ctx.sessions = {
  get(id: string) { return sessions.get(id); },
  list() { return [...sessions.values()]; },
};
ctx.agents = { get() { return undefined; } };
ctx.subagents = { start() { throw new Error("not used in smoke"); } };
ctx.logger = { warn() {}, info() {}, error() {} };
// session/event 订阅由 ctx.on 承载（真实 dsh 无 session.on）
ctx.sessions.get = (id: string) => sessions.get(id) as any;

const engine = createEngine(tmp, {});
const getAgent = () => undefined;
const jobs = createJobManager({ ctx, engine, getAgent } as any);
const handlers: ToolHandlers = registerTools({ ctx, engine, jobs, getAgent } as any);
registerCommands({ ctx, engine, jobs, getAgent, runTool: (n, a, ag) => handlers.get(n)?.(a, ag) ?? `missing ${n}` } as any);

// 断言：8 工具 + 8 命令
const expected = ["ralphflow_start","ralphflow_continue","ralphflow_status","ralphflow_list","ralphflow_cancel","ralphflow_rewind","ralphflow_reset","ralphflow_doctor"];
const expectedCmds = ["ralphflow-start","ralphflow-continue","ralphflow-status","ralphflow-list","ralphflow-cancel","ralphflow-rewind","ralphflow-reset","ralphflow-doctor"];
const missingTools = expected.filter((n) => !registeredTools.includes(n));
const missingCmds = expectedCmds.filter((n) => !registeredCommands.includes(n));
if (missingTools.length || missingCmds.length) {
  console.error("MISSING tools:", missingTools.join(","), "cmds:", missingCmds.join(","));
  process.exit(1);
}

// 动态工作流快捷命令（/loop、/spec……）
const missingShortcuts = ["loop", "spec"].filter((n) => !registeredCommands.includes(n));
if (missingShortcuts.length) {
  console.error("MISSING shortcut commands:", missingShortcuts.join(","));
  process.exit(1);
}

// 工作流加载
const wf = engine.loadWorkflow("loop");
if (!wf) { console.error("loop workflow not found"); process.exit(1); }

// 模拟一次完整 start → 状态写入 → 报告 流程
const start = handlers.get("ralphflow_start")!;
const mockAgent = { session: mockSession } as any;
const startText = await start({ workflow: "loop", task: "冒烟测试任务" }, mockAgent);
if (!startText.includes("已启动")) { console.error("start text unexpected:", startText.slice(0,80)); process.exit(1); }

const insts = engine.listInstances();
if (insts.length !== 1) { console.error("expected 1 instance, got", insts.length); process.exit(1); }
const instId = insts[0].id;

// 模拟模型输出 done 标签后 job 自动驱动验证（此处验证 runCheckAndAdvance 的 do→check 转换与状态推进，
// 用投票/单验证都会尝试起 subagent——mock 不支持，跳过；改为直接验证状态机推进逻辑）
const state = engine.readState(instId);
console.log("instance:", instId, "step:", state.current_step, "phase:", state.current_phase);

// ─── 验证核心修复：ctx.on("session/event") 订阅能收到全局分发的会话事件并驱动状态机 ───
// 真实 dsh 无 session.on；订阅走 ctx.on("session/event", (session, event))，由 dsh-session
// 通过 SessionStore 的 ctx.events.dispatch("emit", [carrier, "session/event", session, event])
// 分发（carrier 的 filter 对无 scope 的 ctx 放行）。这里模拟该真实分发路径，发送一个
// assistant/message 事件（带 <promise>done</promise> 标签），应触发 onSessionEvent →
// runCheckAndAdvance → do→check 转换。
const eventSink: string[] = [];
ctx.on("session/event", (_s: any, e: any) => { eventSink.push(`${_s?.id}:${e.type}`); });
const carrier = { [Context.filter](c: any) { return true; } };
const dispatch = (session: any, event: any) => {
  const cbs = (ctx as any).events.dispatch("emit", [carrier, "session/event", session, event]);
  for (const cb of cbs) cb(session, event);
};
// mock subagents.start 抛错 → runCheckAndAdvance 捕获为 check_error → paused（可接受路径）
try {
  dispatch(mockSession, {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "完成。\n\n<promise>done</promise>" }] } },
  });
  console.log("dispatch ok");
} catch (e) { console.log("dispatch threw:", (e as Error).message); }
// 给事件驱动的异步链路一个机会跑完
await new Promise((r) => setTimeout(r, 300));
if (!eventSink.some((e) => e === "s1:assistant/message")) {
  console.error("session/event subscription not delivered via ctx.on:", eventSink);
  process.exit(1);
}
const after = engine.readState(instId);
const phaseAdvanced = after.current_phase === "check" || after.paused;
if (!phaseAdvanced) {
  console.error("session/event did not drive do→check:", after.current_phase, "paused:", after.paused, "reason:", after.pause_reason);
  process.exit(1);
}
console.log("ctx.on session/event → drive OK: phase=", after.current_phase, "paused=", after.paused, "reason=", after.pause_reason);

// doctor
const doc = engine.buildDoctorReport();
if (!doc.includes("工作流详情")) { console.error("doctor malformed"); process.exit(1); }

// status / list / cancel
const status = handlers.get("ralphflow_status")!;
const stText = await status({}, undefined);
if (!stText.includes(instId)) { console.error("status missing instance"); process.exit(1); }
const cancel = handlers.get("ralphflow_cancel")!;
const cancelText = await cancel({}, undefined);
if (!cancelText.includes("已取消")) { console.error("cancel text unexpected:", cancelText.slice(0,60)); process.exit(1); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log("HOST SMOKE OK — tools:", registeredTools.length, "commands:", registeredCommands.length, "flow: start→status→cancel OK");