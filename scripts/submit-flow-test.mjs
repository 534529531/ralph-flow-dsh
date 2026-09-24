/**
 * DO 交卷新机制（dsh 原生）：
 *   1. 交卷 = 调用 `ralphflow_submit` 工具（不再靠正则扫自由文本）
 *   2. 「忘了交卷」兜底 = 原生 `agent/turn-stopping` 在回合关闭前提醒
 *   3. 提醒有上限，达上限暂停等用户（绝不死循环催促）
 *
 * 用真实 apply() + 真实 Session，宿主服务用最小 stub。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import * as plugin from "../lib/index.js";

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function mkEnv(ws) {
  const ctx = new Context();
  const registered = { tools: [], commands: [] };
  const delivered = [];
  const agents = new Map();
  const listeners = new Map();
  const pid = "sess-submit-flow";
  const session = Session.create(pid, [], { version: 3, id: pid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  agents.set(pid, { id: pid, session, steer: (m) => delivered.push(m), followup: (m) => delivered.push(m) });

  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [] });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"], getProvider: () => ({ capabilities: { outputSchema: true } }),
    start: async () => ({ id: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) }),
  });
  ctx.provide("agents", { get: (id) => agents.get(id) });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === pid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });
  // 捕获插件注册的监听器（cordis 的 ctx.on）
  const origOn = ctx.on?.bind(ctx);
  ctx.on = (name, fn) => { listeners.set(name, fn); return origOn ? origOn(name, fn) : () => {}; };
  return { ctx, registered, delivered, session, pid, listeners, agents };
}
const cli = (msg) => JSON.stringify(msg?.content ?? "");

console.log("S1 工具面：ralphflow_submit 已注册，且带 concludeTurn 行为");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-flow-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const { ctx, registered } = mkEnv(ws);
  plugin.apply(ctx);
  const names = registered.tools.map((t) => t.name);
  check("ralphflow_submit 已注册", names.includes("ralphflow_submit"), names.join(","));
  const t = registered.tools.find((x) => x.name === "ralphflow_submit");
  check("有 description 说明用途", /交卷/.test(t.description), t.description);
  check("summary 为可选参数（非 required）", t.parameters?.properties?.summary && !(t.parameters.required ?? []).includes("summary"), JSON.stringify(t.parameters));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nS2 turn-stopping：未交卷时提醒（且提醒有上限）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-flow-remind-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const { ctx, registered, delivered, pid, listeners } = mkEnv(ws);
  plugin.apply(ctx);
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  await startTool.execute({ workflow: "loop", task: "提醒用例" }, { agent: { session: { id: pid } }, signal: new AbortController().signal });
  delivered.length = 0;

  const turnStopping = listeners.get("agent/turn-stopping");
  check("已注册 agent/turn-stopping 监听器", typeof turnStopping === "function");

  // 第 1、2 次：提醒
  await turnStopping({ agent: { id: pid } });
  check("第 1 次回合关闭前发出提醒", delivered.some((m) => cli(m).includes("ralphflow_submit")), cli(delivered.at(-1)).slice(0, 80));
  await turnStopping({ agent: { id: pid } });
  const reminds = delivered.filter((m) => cli(m).includes("提醒（第")).length;
  check("第 2 次仍提醒", reminds === 2, `reminds=${reminds}`);

  // 第 3 次：达到上限 → 不再催，改为暂停 + 告知用户
  const before = delivered.length;
  await turnStopping({ agent: { id: pid } });
  const last = cli(delivered.at(-1));
  check("达上限后不再重复催促", delivered.length === before + 1, `added=${delivered.length - before}`);
  check("改为暂停并告知用户", last.includes("已暂停等你处理"), last.slice(0, 120));

  const idx = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json"), "utf-8"));
  const iid = Object.keys(idx).find((k) => idx[k] === ws);
  const st = JSON.parse(fs.readFileSync(path.join(ws, "ralph-flow", "instances", iid, "state.json"), "utf-8"));
  check("暂停原因是 no_submit", st.paused && st.pause_reason === "no_submit", JSON.stringify({ p: st.paused, r: st.pause_reason }));
  check("提醒次数从 history 派生（未新增状态字段）", Array.isArray(st.history) && st.history.filter((h) => h.event === "submit_reminder").length === 2, JSON.stringify(st.history.map((h) => h.event)));
  const i2 = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json"), "utf-8"));
  for (const k of Object.keys(i2)) if (i2[k] === ws) delete i2[k];
  fs.writeFileSync(path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json"), JSON.stringify(i2, null, 2));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nS3 turn-stopping：已交卷 / 无实例 / 暂停中 都不提醒");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-flow-quiet-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const { ctx, registered, delivered, pid, listeners } = mkEnv(ws);
  plugin.apply(ctx);
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");

  // 无实例的会话：不提醒
  delivered.length = 0;
  await listeners.get("agent/turn-stopping")({ agent: { id: "unknown-session" } });
  check("无实例时不提醒", delivered.length === 0, cli(delivered.at(-1)));

  await startTool.execute({ workflow: "loop", task: "安静用例" }, { agent: { session: { id: pid } }, signal: new AbortController().signal });
  // 已交卷：不提醒
  await submitTool.execute({}, { agent: { session: { id: pid } }, concludeTurn: undefined });
  delivered.length = 0;
  await listeners.get("agent/turn-stopping")({ agent: { id: pid } });
  check("已交卷后不提醒", delivered.length === 0, cli(delivered.at(-1)));
  await sleep(120);

  const i2 = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json"), "utf-8"));
  for (const k of Object.keys(i2)) if (i2[k] === ws) delete i2[k];
  fs.writeFileSync(path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json"), JSON.stringify(i2, null, 2));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nS4 交卷工具调用 concludeTurn（宿主原生回合结束）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-flow-ct-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const { ctx, registered, pid } = mkEnv(ws);
  plugin.apply(ctx);
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  await startTool.execute({ workflow: "loop", task: "concludeTurn 用例" }, { agent: { session: { id: pid } }, signal: new AbortController().signal });

  let concluded = 0;
  await submitTool.execute({ summary: "做完了 A/B" }, { agent: { session: { id: pid } }, concludeTurn: () => { concluded++; } });
  check("交卷调用了 concludeTurn（结束本回合）", concluded === 1, `concluded=${concluded}`);

  // 非交卷工具不应结束回合
  const statusTool = registered.tools.find((t) => t.name === "ralphflow_status");
  let statusConcluded = 0;
  await statusTool.execute({}, { agent: { session: { id: pid } }, concludeTurn: () => { statusConcluded++; } });
  check("非交卷工具不结束回合", statusConcluded === 0, `concluded=${statusConcluded}`);
  await sleep(120);
  const i2 = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json"), "utf-8"));
  for (const k of Object.keys(i2)) if (i2[k] === ws) delete i2[k];
  fs.writeFileSync(path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json"), JSON.stringify(i2, null, 2));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
