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
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import * as plugin from "../lib/index.js";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });


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
  const session = Session.create(pid, [], { version: SESSION_FORMAT_VERSION, id: pid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  agents.set(pid, { id: pid, session, steer: (m) => delivered.push(m), followup: (m) => delivered.push(m) });

  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [] });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
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

  const iid = fs.readdirSync(path.join(ws, ".dsh", "ralph-flow", "instances"))[0];
  const st = JSON.parse(fs.readFileSync(path.join(ws, ".dsh", "ralph-flow", "instances", iid, "state.json"), "utf-8"));
  check("暂停原因是 no_submit", st.paused && st.pause_reason === "no_submit", JSON.stringify({ p: st.paused, r: st.pause_reason }));
  check("提醒次数从 history 派生（未新增状态字段）", Array.isArray(st.history) && st.history.filter((h) => h.event === "submit_reminder").length === 2, JSON.stringify(st.history.map((h) => h.event)));
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
  // 内置 loop 现在是多验证者投票步：交卷后会异步收到**投票进度播报**（每票一行），
  // 但「还没交卷」的催促绝不能再出现 —— 判据收窄到「有没有提醒」，不是「有没有任何消息」。
  check("已交卷后不提醒（投票进度播报不算提醒）",
    delivered.every((m) => !cli(m).includes("提醒（第") && !cli(m).includes("还没交卷")),
    cli(delivered.at(-1)));
  await sleep(120);

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
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nS5 工具/命令描述：无 check 的步骤不得被描述成会走独立验证（诚实标注的类级断言）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-flow-desc-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const { ctx, registered, delivered, pid } = mkEnv(ws);
  plugin.apply(ctx);
  const byName = (n) => registered.tools.find((t) => t.name === n);
  const startDesc = byName("ralphflow_start")?.description ?? "";
  const submitDesc = byName("ralphflow_submit")?.description ?? "";
  const cmdStart = registered.commands.find((c) => c.name === "ralphflow-start")?.description ?? "";
  // continue 指令是**投递给模型**的文本：走真实 handler，再从投递队列里取回
  delivered.length = 0;
  await registered.commands.find((c) => c.name === "ralphflow-continue")
    .handler({ rawInput: "", agent: { session: { id: pid } }, signal: new AbortController().signal });
  const continueText = delivered.map((m) => JSON.stringify(m?.content ?? m)).join("\n");
  check("ralphflow_start 描述限定「有 check 的步骤」才独立验证、无 check 则跳过",
    startDesc.includes("有 `check`") && startDesc.includes("没有 `check`") && startDesc.includes("跳过对抗性验证"), startDesc);
  check("ralphflow_submit 描述同样限定（不再无条件「独立验证者随后取证判定」）",
    submitDesc.includes("有 `check`") && submitDesc.includes("没有 `check`"), submitDesc);
  check("命令描述同步限定（有 check → 独立验证；无 check → 跳过）",
    cmdStart.includes("有 `check`") && cmdStart.includes("没有 `check`"), cmdStart);
  check("continue 指令说明手动审查的两种情形（有 check 通过 / 无 check 跳过）",
    continueText.includes("有 `check`") && continueText.includes("没有 `check`") && continueText.includes("跳过对抗性验证"), continueText.slice(0, 220));
  check("有 check 的语义仍如实保留（描述里仍有「取证判定」）", /取证判定/.test(startDesc) && /取证判定/.test(submitDesc));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
