/**
 * 停止按钮 = 暂停（Flow / Graph 同一套）。
 *
 * 宿主把发送键旁的方块按下去时会 `agent.cancel({kind:"user"})`，回合以
 * `turn/end { reason: { kind: "aborted", reason: { kind: "user" } } }` 收尾。插件监听这条
 * 事件，把本会话的活跃实例转成 `paused(user_stop)` —— Flow 与 Graph 都不再需要
 * `/ralphflow-pause`。
 *
 * 本文件断言：
 *   T1 Flow DO 阶段点停止 → 暂停 user_stop，播报可见，turn-stopping 不再催交卷；
 *   T2 continue 恢复并重投 DO；
 *   T3 已交卷（验证中）点停止 → 不暂停，验证不被停止键打断；
 *   T4 别人的会话 / parent / disposed / interrupted 的回合结束不触发暂停；
 *   T5 Graph 主节点在飞时点停止 → 暂停 user_stop，main attempt 标 interrupted；
 *   T5b Graph 后台节点在飞时点停止 → 暂停并 dispose 后台 agent，continue 能开新 attempt；
 *   T6 Graph continue 后按 interrupted 路径重试，交卷后完成；
 *   T7 `/ralphflow-pause` 命令已移除（统一用停止按钮；状态面另有独立暂停按钮）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import * as plugin from "../lib/index.js";
import { captureAppends, toolOf, execTool, textOf, sleep, rfDir, instanceDirs, readStateFile } from "./helpers/plugin-harness.mjs";

// HOME 隔离：全局工作流目录在 ~/.dsh 下，测试绝不读写真实 HOME。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });
process.env.RALPHFLOW_GRAPH_ARTIFACT = "1";

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sid = "session-stop-pause";

function mkEnv(ws, opts = {}) {
  process.chdir(ws);
  const ctx = new Context();
  const registered = { tools: [], commands: [], skills: [] };
  const sent = [];
  const agents = new Map();
  const background = { created: 0, disposed: 0 };
  const listeners = new Map();
  const session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  const scopedTools = [];
  const agent = {
    id: sid,
    session,
    steer: (m) => sent.push(m),
    followup: (m) => sent.push(m),
    ctx: { get: (name) => name === "tools" ? { register: (definition) => { scopedTools.push(definition); return () => {}; } } : undefined },
  };
  agents.set(sid, agent);
  captureAppends(session, sent);

  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [], get: () => undefined });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("skills", { register: (d) => { registered.skills.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, agentPreset: true }, inheritsParentContext: false }),
    startActivation: opts.startActivation ?? (async () => {
      const result = new Promise(() => {});
      return { childId: "child", result };
    }),
  });
  ctx.provide("agentPresets", { register: async () => async () => {} });
  ctx.provide("agents", {
    get: (id) => agents.get(id),
    async create(opts) {
      background.created += 1;
      let idleResolve;
      const idle = new Promise((resolve) => { idleResolve = resolve; });
      const child = {
        id: opts.sessionId,
        session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} },
        followup() {},
        whenIdle: () => idle,
      };
      agents.set(opts.sessionId, child);
      opts.setup?.({ tools: { register() { return () => {}; }, restrict() {} } });
      return { agent: child, dispose: async () => { background.disposed += 1; idleResolve?.(); agents.delete(opts.sessionId); } };
    },
  });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });
  const originalOn = ctx.on.bind(ctx);
  ctx.on = (name, fn) => { listeners.set(name, fn); return originalOn(name, fn); };
  return { ctx, registered, sent, session, agent, listeners, scopedTools, background };
}

/** 模拟宿主生命周期：用户点停止按钮，回合以 aborted/user 收尾。 */
function emitTurnEnd(env, sessionId, reason = { kind: "aborted", reason: { kind: "user" } }) {
  env.ctx.emit("session/event", { id: sessionId }, { type: "turn/end", data: { turn: 1, reason }, time: Date.now() });
}

async function waitFor(fn, label, timeout = 3_000) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`等待超时：${label}`);
    await sleep(20);
  }
}

const flowState = (ws) => {
  const id = instanceDirs(ws)[0];
  return id ? { id, state: readStateFile(ws, id) } : undefined;
};
const graphState = (ws) => {
  const id = instanceDirs(ws)[0];
  const state = id ? readStateFile(ws, id) : undefined;
  return state?.kind === "graph" ? { id, state } : undefined;
};

console.log("T1 Flow：DO 阶段点停止 → paused(user_stop)");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-stop-flow-"));
  const env = mkEnv(ws);
  plugin.apply(env.ctx);
  await execTool(toolOf(env.registered, "ralphflow_start"), { workflow: "loop", task: "停止流程用例" }, sid);
  const before = flowState(ws);
  check("启动后实例在飞且未暂停", before?.state.active === true && before.state.paused === false, JSON.stringify(before?.state));

  emitTurnEnd(env, sid);
  await sleep(30);
  const paused = flowState(ws);
  check("停止回合 → 实例暂停", paused?.state.paused === true, JSON.stringify({ p: paused?.state.paused }));
  check("暂停原因统一为 user_stop", paused?.state.pause_reason === "user_stop", JSON.stringify(paused?.state.pause_reason));
  check("用户看到停止播报", env.sent.some((m) => textOf(m).includes("你停止了运行")), JSON.stringify(env.sent.map(textOf).filter(Boolean).slice(-3)));

  // 停止后的回合不应该再收到「你还没交卷」的催促。
  const beforeStopCount = env.sent.length;
  await env.listeners.get("agent/turn-stopping")({ agent: { id: sid }, signal: { aborted: true } });
  check("已停止的回合不催交卷", env.sent.length === beforeStopCount, `added=${env.sent.length - beforeStopCount}`);

  console.log("T2 Flow：continue 恢复并重投 DO");
  env.sent.length = 0;
  await execTool(toolOf(env.registered, "ralphflow_continue"), {}, sid);
  const resumed = flowState(ws);
  check("continue 解除暂停", resumed?.state.paused === false, JSON.stringify(resumed?.state.paused));
  check("恢复后重投当前步 DO", env.sent.some((m) => textOf(m).includes("停止流程用例") && textOf(m).includes("## 交卷方式")), JSON.stringify(env.sent.map(textOf).slice(-2)));

  await execTool(toolOf(env.registered, "ralphflow_cancel"), { reason: "test cleanup" }, sid);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("T3 Flow：已交卷（验证中）点停止 → 不暂停");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-stop-verify-"));
  const env = mkEnv(ws);
  plugin.apply(env.ctx);
  await execTool(toolOf(env.registered, "ralphflow_start"), { workflow: "loop", task: "验证中停止用例" }, sid);
  await execTool(toolOf(env.registered, "ralphflow_submit"), { unfinished: [] }, sid);
  await waitFor(() => flowState(ws)?.state.do_submitted, "交卷落地");
  emitTurnEnd(env, sid);
  await sleep(30);
  const st = flowState(ws)?.state;
  check("验证中不因停止回合而暂停", st?.paused === false, JSON.stringify({ p: st?.paused, r: st?.pause_reason }));
  await execTool(toolOf(env.registered, "ralphflow_cancel"), { reason: "test cleanup" }, sid);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("T4 其它会话 / 其它取消原因不触发暂停");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-stop-why-"));
  const env = mkEnv(ws);
  plugin.apply(env.ctx);
  await execTool(toolOf(env.registered, "ralphflow_start"), { workflow: "loop", task: "取消原因用例" }, sid);
  for (const reason of [
    { kind: "aborted", reason: { kind: "parent" } },
    { kind: "aborted", reason: { kind: "disposed" } },
    { kind: "interrupted" },
  ]) {
    emitTurnEnd(env, sid, reason);
    await sleep(10);
    check(`${JSON.stringify(reason)} 不触发暂停`, flowState(ws)?.state.paused === false, JSON.stringify(reason));
  }
  emitTurnEnd(env, "session-someone-else");
  await sleep(10);
  check("别的会话停止不触发本实例暂停", flowState(ws)?.state.paused === false);
  await execTool(toolOf(env.registered, "ralphflow_cancel"), { reason: "test cleanup" }, sid);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("T5/T6 Graph：主节点在飞时停止 → 暂停；continue 重试后完成");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-stop-graph-"));
  fs.mkdirSync(path.join(rfDir(ws), "graphs"), { recursive: true });
  fs.writeFileSync(path.join(rfDir(ws), "graphs", "stop.yaml"), `kind: graph
steps:
  - id: a
    desc: A
    do: do a
    output: a.md
    execution: main
`);
  const env = mkEnv(ws);
  plugin.apply(env.ctx);
  await execTool(toolOf(env.registered, "ralphflow_start"), { workflow: "stop", task: "停止 Graph 用例" }, sid);
  await waitFor(() => graphState(ws)?.state.graph.attempts.some((attempt) => attempt.status === "running"), "主节点 attempt 在飞");

  emitTurnEnd(env, sid);
  await sleep(30);
  const paused = graphState(ws)?.state;
  check("Graph 停止回合 → 暂停", paused?.graph.status === "paused", JSON.stringify(paused?.graph.status));
  check("Graph 暂停原因统一为 user_stop", paused?.graph.pause_reason === "user_stop", JSON.stringify(paused?.graph.pause_reason));
  check("被停止的主节点 attempt 标 interrupted", paused?.graph.attempts.every((attempt) => attempt.status !== "running"), JSON.stringify(paused?.graph.attempts.map((a) => a.status)));
  check("用户看到停止播报", env.sent.some((m) => textOf(m).includes("你停止了运行")), JSON.stringify(env.sent.map(textOf).filter(Boolean).slice(-3)));

  console.log("T6 Graph：continue 按 interrupted 路径重试并完成");
  const sentBefore = env.sent.length;
  await execTool(toolOf(env.registered, "ralphflow_continue"), {}, sid);
  await waitFor(() => graphState(ws)?.state.graph.status === "running", "Graph 恢复运行");
  await waitFor(() => {
    const attempts = graphState(ws)?.state.graph.attempts ?? [];
    return attempts.length >= 2 && attempts.at(-1)?.status === "running";
  }, "重试 attempt 在飞");
  // DO 投递在 waitForSubmit 注册之后，等到它才交卷，避免撞上「attempt 已 running、等待者还没挂上」的窗口。
  await waitFor(() => env.sent.slice(sentBefore).some((m) => textOf(m).includes("Graph 节点执行")), "重投主节点 DO");
  const write = [...env.scopedTools].reverse().find((tool) => tool.name === "ralphflow_artifact_write");
  check("主节点拿到了产物写入工具", !!write, JSON.stringify(env.scopedTools.map((tool) => tool.name)));
  if (write) await write.execute({ content: "artifact" }, { agent: env.agent, signal: new AbortController().signal });
  await execTool(toolOf(env.registered, "ralphflow_submit"), { unfinished: [] }, sid);
  const done = await waitFor(() => graphState(ws)?.state.graph.status === "completed", "Graph 完成", 5_000).catch(() => undefined);
  check("重试后交卷完成", done !== undefined, JSON.stringify(graphState(ws)?.state.graph.status));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("T5b Graph：后台节点在飞时停止 → 暂停并中断 agent");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-stop-graph-bg-"));
  fs.mkdirSync(path.join(rfDir(ws), "graphs"), { recursive: true });
  fs.writeFileSync(path.join(rfDir(ws), "graphs", "stop-bg.yaml"), `kind: graph
steps:
  - id: a
    desc: A
    do: do a
    output: a.md
`);
  const env = mkEnv(ws);
  plugin.apply(env.ctx);
  await execTool(toolOf(env.registered, "ralphflow_start"), { workflow: "stop-bg", task: "后台节点暂停用例" }, sid);
  await waitFor(() => graphState(ws)?.state.graph.attempts.some((attempt) => attempt.status === "running"), "后台 attempt 在飞");

  emitTurnEnd(env, sid);
  await sleep(50);
  const paused = graphState(ws)?.state;
  check("后台节点在飞时停止 → Graph 暂停", paused?.graph.status === "paused", JSON.stringify(paused?.graph.status));
  check("后台暂停原因统一为 user_stop", paused?.graph.pause_reason === "user_stop", JSON.stringify(paused?.graph.pause_reason));
  check("后台 attempt 标 interrupted", paused?.graph.attempts.every((attempt) => attempt.status !== "running"), JSON.stringify(paused?.graph.attempts.map((a) => a.status)));
  check("后台 agent 被 dispose", env.background.disposed >= 1, JSON.stringify(env.background));
  check("后台暂停也播报", env.sent.some((m) => textOf(m).includes("你停止了运行")), JSON.stringify(env.sent.map(textOf).filter(Boolean).slice(-3)));

  await execTool(toolOf(env.registered, "ralphflow_continue"), {}, sid);
  await waitFor(() => graphState(ws)?.state.graph.status === "running", "后台 Graph 恢复运行");
  await waitFor(() => graphState(ws)?.state.graph.attempts.length >= 2, "后台节点开新 attempt");
  check("后台暂停后可 continue", graphState(ws)?.state.graph.attempts.length >= 2, JSON.stringify(graphState(ws)?.state.graph.attempts.map((a) => a.status)));
  check("continue 保留用户暂停原因", graphState(ws)?.state.graph.attempts[0]?.failure?.message === "你停止了运行。", JSON.stringify(graphState(ws)?.state.graph.attempts[0]?.failure));

  await execTool(toolOf(env.registered, "ralphflow_cancel"), { reason: "test cleanup" }, sid);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("T7 命令面：/ralphflow-pause 已移除");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-stop-cmd-"));
  const env = mkEnv(ws);
  plugin.apply(env.ctx);
  check("不再注册 ralphflow-pause 命令", !env.registered.commands.some((command) => command.name === "ralphflow-pause"), env.registered.commands.map((c) => c.name).join(","));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
