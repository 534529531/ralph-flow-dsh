/**
 * 用户可见性回归（作者指正的核心缺陷）。
 *
 * 缺陷：插件播报用 `source: {kind:"plugin", plugin:"ralphflow"}`（**不带 form**）投递。
 * dsh 客户端按 `source.form` 渲染（`dsh-client-ui-chat` 的 `contextBody`/`contextForm`）：
 *   · `form:"notice"` + `summary` → notice 行（summary 不展开就能读，用户看得见）
 *   · 无 form → `case null: return opaque` → OpaqueBody 上下文注入行（用户基本看不到）
 * 即：过去所有 ralphflow 播报对用户等于不可见 —— 与作者诉求「告知用户 + 提示该干啥」相反。
 *
 * 本文件断言：**凡用户应当知道的播报，投递出的消息 source 必须带 form:"notice" + 非空 summary**。
 * 并校验 summary 走 `boundContextSummary` 的 120 字符约定。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { RALPHFLOW_SOURCE_KIND } from "../lib/message-source.js";
import * as plugin from "../lib/index.js";
// 时长承诺的唯一判据来源（问题二用例共用）：summary 里不许再出现任何时间承诺
import { findDurationPromises } from "./helpers/time-promise-scan.mjs";
import { captureAppends } from "./helpers/plugin-harness.mjs";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });


let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);
const SUMMARY_MAX = 120;

function mkEnv(ws, sid) {
  const ctx = new Context();
  const registered = { tools: [], commands: [], skills: [] };
  /** 捕获插件实际投递的消息对象（不只看文本，要看 source） */
  const sent = [];
  const agents = new Map();
  const session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  agents.set(sid, { id: sid, session, steer: (m) => { sent.push(m); }, followup: (m) => { sent.push(m); } });
  captureAppends(session, sent);
  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [] });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("skills", { register: (d) => { registered.skills.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: async () => ({ id: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) }),
  });
  ctx.provide("agents", { get: (id) => agents.get(id) });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });
  return { ctx, registered, sent, sid };
}
const textOf = (m) => (m?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
const visible = (m) => m?.source?.kind === RALPHFLOW_SOURCE_KIND && m.source.form === "notice" && typeof m.source.summary === "string" && m.source.summary.trim() !== "";
const cleanup = (ws) => {
  // 引擎已按工作区单根：实例资产都在各自的隔离工作区里，没有全局索引要清理
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
};
/** 断言「所有投递都是用户可见的 notice」 */
function assertAllVisible(label, sent, allowOpaque = 0) {
  const opaque = sent.filter((m) => !visible(m));
  check(`${label}：投递全部为可见 notice（opaque ${opaque.length} ≤ ${allowOpaque}）`, opaque.length <= allowOpaque,
    opaque.map((m) => textOf(m).slice(0, 40)).join(" | "));
  const badSummary = sent.filter((m) => visible(m) && m.source.summary.length > SUMMARY_MAX);
  check(`${label}：summary 均 ≤ ${SUMMARY_MAX} 字符`, badSummary.length === 0, badSummary.map((m) => m.source.summary.length).join(","));
  return sent.filter(visible);
}

console.log("U1 启动：DO 提示词随 tool result 返回（本身即用户可见），且无不可见投递");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-vis1-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `vis1-${RUN}`;
  const { ctx, registered, sent } = mkEnv(ws, sid);
  plugin.apply(ctx);
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  const out = await startTool.execute({ workflow: "loop", task: "可见性用例" }, { agent: { session: { id: sid } }, signal: new AbortController().signal });
  await sleep();

  // 启动时 DO 提示词是工具返回值 —— 工具结果在对话里本身就是用户可见的
  check("启动返回里含 DO 提示词（作为 tool result 可见）", typeof out === "string" && out.includes("本步要做什么"), String(out).slice(0, 60));
  check("启动返回指向 ralphflow_submit（非文本标记）", typeof out === "string" && out.includes("ralphflow_submit") && !out.includes("<promise>done</promise>"));
  const vis = assertAllVisible("U1", sent);
  check("若有 steer 投递，必须是可见 notice", sent.length === 0 || vis.length === sent.length, `sent=${sent.length} vis=${vis.length}`);
  cleanup(ws);
}

console.log("\nU2 交卷 → 验证播报 → 完成：每一步都对用户可见");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-vis2-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `vis2-${RUN}`;
  const { ctx, registered, sent } = mkEnv(ws, sid);
  plugin.apply(ctx);
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  await startTool.execute({ workflow: "loop", task: "可见性用例2" }, { agent: { session: { id: sid } }, signal: new AbortController().signal });
  await sleep();
  sent.length = 0;

  await submitTool.execute({ summary: "做完了" }, { agent: { session: { id: sid } } });
  await sleep(200);
  assertAllVisible("U2 交卷后", sent);
  const verifyNote = sent.find((m) => textOf(m).includes("独立验证者"));
  check("验证开始播报可见", !!verifyNote && visible(verifyNote));
  check("验证播报摘要说明是异步等待", /独立验证| 验证/.test(verifyNote?.source?.summary ?? ""), verifyNote?.source?.summary);
  const doneNote = sent.find((m) => textOf(m).includes("完成"));
  check("完成播报可见", !!doneNote && visible(doneNote), JSON.stringify(doneNote?.source));
  cleanup(ws);
}

console.log("\nU3 暂停 / 审查门 / 返工：都必须对用户可见");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-vis3-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `vis3-${RUN}`;
  // 验证者返回 infra → 触发 infra 暂停
  const ctx = new Context();
  const registered = { tools: [], commands: [], skills: [] };
  const sent = [];
  const session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  const agent = { id: sid, session, steer: (m) => sent.push(m), followup: (m) => sent.push(m) };
  captureAppends(session, sent);
  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [] });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("skills", { register: (d) => { registered.skills.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: async () => ({ id: "c", result: Promise.resolve({ output: [], stopReason: "aborted" }) }),
  });
  ctx.provide("agents", { get: (id) => (id === sid ? agent : undefined) });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });
  plugin.apply(ctx);

  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  await startTool.execute({ workflow: "loop", task: "暂停可见性" }, { agent: { session: { id: sid } }, signal: new AbortController().signal });
  await sleep();
  sent.length = 0;
  await submitTool.execute({ summary: "x" }, { agent: { session: { id: sid } } });
  await sleep(250);

  assertAllVisible("U3 暂停", sent);
  const pauseNote = sent.find((m) => textOf(m).includes("暂停") || textOf(m).includes("验证未跑成"));
  check("暂停播报可见且摘要说明原因", !!pauseNote && visible(pauseNote), JSON.stringify(pauseNote?.source));
  cleanup(ws);
}

console.log("\nU4 命令触发词：投递的指令不应伪装成用户可见通知（保持管道语义）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-vis4-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `vis4-${RUN}`;
  const { ctx, registered, sent } = mkEnv(ws, sid);
  plugin.apply(ctx);
  const statusCmd = registered.commands.find((c) => c.name === "ralphflow-status");
  const r = await statusCmd.handler({ commandId: "c1", agent: { session: { id: sid } }, rawInput: "", attachments: [], signal: new AbortController().signal });
  await sleep();
  check("命令 handler 仍返回 {kind:'success'} 且无程序化文本（触发词语义）", r.kind === "success" && r.text === undefined, JSON.stringify(r));
  check("指令已投递给模型", sent.length === 1, `n=${sent.length}`);
  // 命令指令是模型管道，不强制 notice；但也不能因此让用户以为「命令没生效」——
  // 这里只记录现状：它仍是 opaque（模型会回复，用户从回复看到结果）。
  console.log(`     （命令指令 source.form = ${JSON.stringify(sent[0]?.source?.form ?? null)} —— 设计上属模型管道）`);
  cleanup(ws);
}

console.log("\nU5 默认可见的只有 summary（notice 行默认折叠）→ summary 必须自带「该干啥」");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-vis5-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `vis5-${RUN}`;
  const { ctx, registered, sent } = mkEnv(ws, sid);
  plugin.apply(ctx);
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  const doOut = await startTool.execute({ workflow: "loop", task: "指引用例" }, { agent: { session: { id: sid } }, signal: new AbortController().signal });
  await sleep();
  sent.length = 0;

  // DO prompt 必须要求模型**面向用户**说明状态（模型消息是唯一显眼通道）
  check("DO prompt 要求先向用户说明状态", /面向用户的话说明|面向用户/.test(doOut), doOut.slice(-300));
  check("DO prompt 说明「不需要用户做任何操作」", /不需要用户做任何操作/.test(doOut));
  check("DO prompt 给出期间可做什么（status/cancel）", /ralphflow-status/.test(doOut) && /ralphflow-cancel/.test(doOut));

  await submitTool.execute({ summary: "做完了" }, { agent: { session: { id: sid } } });
  await sleep(200);
  const verifyNote = sent.find((m) => textOf(m).includes("独立验证者"));
  check("验证中 notice 可见", !!verifyNote && visible(verifyNote));
  const sum = verifyNote?.source?.summary ?? "";
  check("验证中 summary 自带「无需操作」（默认唯一可见行必须可行动）", /无需操作/.test(sum), sum);
  // 这条断言**换掉了**原来那条 `/1–5 分钟|1-5 分钟/`：旧断言是在断言一句假话
  // （实测 3m53s / 7m29s / 8m34s，且委派没有超时上界，那个区间是编的）。
  // 换成的判据 = 「summary 里不许有任何时长承诺」+「必须说清验证者在干什么」，
  // 判据来源是唯一的扫描器（scripts/helpers/time-promise-scan.mjs，问题二的用例也在用）。
  check("验证中 summary 不含任何时长承诺（不猜时间）", findDurationPromises(sum).length === 0, sum);
  check("验证中 summary 说清验证者正在取证（把「在干什么」讲给用户，而不是猜时间）", /取证/.test(sum), sum);
  cleanup(ws);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
