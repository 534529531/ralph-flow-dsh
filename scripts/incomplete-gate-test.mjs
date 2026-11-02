#!/usr/bin/env node
/**
 * 未完成项闸门：没做完的交卷不启动独立验证。
 *
 * 现场（ra2-engine-rebuild 的 loop 实例）：模型做完七条判据里的一条，就在 summary 里写明
 * 「其余六项保持 open」，仍然交卷 —— 三个验证者跑了 40 分钟后给出「5/7 未完成」，整轮白烧。
 * 模型自己知道还剩什么，缺的是一条**机械**通道把这件事变成引擎可执行的动作。
 *
 * 判据：
 *  1. `unfinished` 非空 → 记 `submit_incomplete`、不设 do_submitted、不委派验证者、不占返工预算；
 *  2. 回合仍然结束（模型要的边界），回执把未完成项逐条还给模型；
 *  3. `unfinished` 留空 → 照常进入独立验证；
 *  4. 交卷本身不算「在干活」：只交卷不干活的回合按空回合计（催促机制不被绕过）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import * as plugin from "../lib/index.js";
import { captureAppends } from "./helpers/plugin-harness.mjs";

// HOME 隔离：测试绝不读写真实 ~/.dsh。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const cli = (msg) => JSON.stringify(msg?.content ?? "");

function mkEnv(ws) {

  // 插件按加载目录解析默认项目根（真实 dsh 就从工作区目录启动）；测试也必须同形。
  process.chdir(ws);
  const ctx = new Context();
  const registered = { tools: [], commands: [], skills: [] };
  const delivered = [];
  const agents = new Map();
  const listeners = new Map();
  const activations = [];
  const pid = "sess-incomplete-gate";
  const session = Session.create(pid, [], { version: SESSION_FORMAT_VERSION, id: pid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  agents.set(pid, { id: pid, session, steer: (m) => delivered.push(m), followup: (m) => delivered.push(m) });
  captureAppends(session, delivered);

  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [] });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("skills", { register: (d) => { registered.skills.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, agentPreset: true }, inheritsParentContext: false }),
    startActivation: async (spec) => {
      activations.push(spec);
      // 判定延后一点：实例在「验证中」停留得够久，测试才读得到那一刻的 state.json。
      const result = new Promise((resolve) => setTimeout(() => resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }), 250));
      return { childId: "c", result };
    },
  });
  ctx.provide("agentPresets", { register: async () => async () => {} });
  ctx.provide("agents", { get: (id) => agents.get(id) });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === pid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });
  const origOn = ctx.on?.bind(ctx);
  ctx.on = (name, fn) => { listeners.set(name, fn); return origOn ? origOn(name, fn) : () => {}; };
  return { ctx, registered, delivered, session, pid, listeners, activations };
}

const readState = (ws) => {
  const dir = path.join(ws, ".dsh", "ralph-flow", "instances");
  const id = fs.readdirSync(dir).find((name) => fs.existsSync(path.join(dir, name, "state.json")));
  return JSON.parse(fs.readFileSync(path.join(dir, id, "state.json"), "utf8"));
};

console.log("G1 未完成项非空：只记进度，不启动验证");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-gate-"));
  const { ctx, registered, pid, activations, listeners, delivered } = mkEnv(ws);
  plugin.apply(ctx);
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  await startTool.execute({ workflow: "loop", task: "未完成闸门用例" }, { agent: { session: { id: pid } }, signal: new AbortController().signal });

  check("unfinished 是必填参数（模型必须回答做完没有）", submitTool.parameters?.required?.includes("unfinished") === true, JSON.stringify(submitTool.parameters?.required));
  check("未完成项是字符串数组", JSON.stringify(submitTool.parameters?.properties?.unfinished?.items) === JSON.stringify({ type: "string" }));

  let concluded = 0;
  const out = await submitTool.execute(
    { summary: "第 82 轮：闭掉 Bink 项", unfinished: ["parity 还差 13/19", "SAV 零对象图未做", "联机抓包未取证"] },
    { agent: { session: { id: pid } }, signal: new AbortController().signal, concludeTurn: () => { concluded++; } },
  );
  await sleep(120);
  check("回执只记进度，不预告验证/推进", out.includes("已记下这轮进度") && !out.includes("验证") && !out.includes("CHECK"), out.slice(0, 160));
  check("回执逐条带回未完成项", out.includes("parity 还差 13/19") && out.includes("SAV 零对象图未做"), out.slice(0, 200));
  check("回执不泄露「留空 → 验证」这条触发条件", !out.includes("独立验证") && !out.includes("引擎会启动"), out.slice(0, 240));
  check("回合结束（模型按它要的边界收尾，不是被拒在原地）", concluded === 1, `concluded=${concluded}`);
  check("没有委派任何验证者", activations.length === 0, JSON.stringify(activations.map((a) => a.checkIndex)));

  const st = readState(ws);
  check("未设置 do_submitted（仍是 DO 阶段）", st.do_submitted === false, JSON.stringify(st.do_submitted));
  check("没有 verify_start（验证根本没开始）", !st.history.some((h) => h.event === "verify_start"), JSON.stringify(st.history.map((h) => h.event)));
  check("历史记了 submit_incomplete 与条目数", st.history.some((h) => h.event === "submit_incomplete" && h.detail.includes("3 项")), JSON.stringify(st.history.filter((h) => h.event === "submit_incomplete")));
  check("没有消耗返工预算（fail_counts 不变）", JSON.stringify(st.fail_counts ?? {}) === "{}", JSON.stringify(st.fail_counts));

  // 交卷本身不算「在干活」：这一轮只有交卷 → 下一次回合收尾按空回合计。
  delivered.length = 0;
  await listeners.get("agent/turn-stopping")({ agent: { id: pid } });
  const reminder = cli(delivered.at(-1));
  check("只交卷不干活 → 按连续无工具回合计（第 1/2 次）", reminder.includes("1/2 次连续无工具回合"), reminder.slice(0, 200));
  check("提醒接着做那份清单（不再问「做完了吗」）",
    reminder.includes("本轮清单（上一轮记下的 3 项未完成）") && !reminder.includes("做完了："), reminder.slice(0, 300));
  check("提醒里点名 unfinished 这条通道", reminder.includes("unfinished"), reminder.slice(0, 300));

  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nG1b 记录进度之后干过活：提醒仍是接着做，但不算空回合");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-gate-work-"));
  const { ctx, registered, pid, listeners, delivered } = mkEnv(ws);
  plugin.apply(ctx);
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  await startTool.execute({ workflow: "loop", task: "记录后继续干活" }, { agent: { session: { id: pid } }, signal: new AbortController().signal });
  await submitTool.execute({ unfinished: ["还差 A", "还差 B"] }, { agent: { session: { id: pid } }, concludeTurn: () => {} });

  // 交卷本身不算干活：先证明这一点，再模拟一次真实工具调用。
  const sessionEvent = listeners.get("session/event");
  const emit = (name) => sessionEvent?.({ id: pid }, { type: "tool/call", data: { name, callId: `c-${name}`, arguments: "{}" }, time: Date.now() });
  emit("ralphflow_submit");
  delivered.length = 0;
  await listeners.get("agent/turn-stopping")({ agent: { id: pid } });
  check("交卷工具调用不被算成干活（仍是连续无工具回合）", cli(delivered.at(-1)).includes("连续无工具回合"), cli(delivered.at(-1)).slice(0, 160));

  await sleep(5);
  emit("bash");
  delivered.length = 0;
  await listeners.get("agent/turn-stopping")({ agent: { id: pid } });
  const after = cli(delivered.at(-1));
  check("干过活之后的记录 → 提醒不算连续无工具回合", !after.includes("连续无工具回合"), after.slice(0, 160));
  check("仍然是接着做（不是重新问做完了吗）", after.includes("上一轮记下的 2 项") && !after.includes("做完了："), after.slice(0, 200));

  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nG2 unfinished 留空：照常进入独立验证");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-gate-done-"));
  const { ctx, registered, pid, activations } = mkEnv(ws);
  plugin.apply(ctx);
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  await startTool.execute({ workflow: "loop", task: "完成声明用例" }, { agent: { session: { id: pid } }, signal: new AbortController().signal });

  await submitTool.execute({ summary: "先报进度", unfinished: ["还有一项"] }, { agent: { session: { id: pid } }, concludeTurn: () => {} });
  check("进度记录之后仍未进入验证", activations.length === 0);
  await submitTool.execute({ summary: "这次做完了", unfinished: [] }, { agent: { session: { id: pid } }, concludeTurn: () => {} });
  await sleep(100);
  check("完成声明后启动了 3 个验证者", activations.length === 3, `activations=${activations.length}`);
  const st = readState(ws);
  check("do_submitted 置位", st.do_submitted === true);
  check("历史有 verify_start", st.history.some((h) => h.event === "verify_start"), JSON.stringify(st.history.map((h) => h.event)));
  await sleep(400);

  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nG3 空白条目不算未完成项（防止用空串绕过闸门）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-gate-blank-"));
  const { ctx, registered, pid, activations } = mkEnv(ws);
  plugin.apply(ctx);
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  await startTool.execute({ workflow: "loop", task: "空白条目用例" }, { agent: { session: { id: pid } }, signal: new AbortController().signal });
  const out = await submitTool.execute({ unfinished: ["   ", ""] }, { agent: { session: { id: pid } }, concludeTurn: () => {} });
  await sleep(200);
  check("空白条目视同完成声明（进入验证）", activations.length === 3, `activations=${activations.length}`);
  check("回执不是进度记录", !out.includes("验证没有启动"), out.slice(0, 120));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
