/**
 * 「交卷不能静默消失」契约（缺陷 A 的意图在新机制下的落点）。
 *
 * 背景：文本标记时代，交卷是「模型写一行字 + 引擎正则猜」。实例消失时这次交卷会静默蒸发，
 * 用户什么都看不到 → 作者加了 lost-submission 告警。
 *
 * 现在交卷 = 模型调用 `ralphflow_submit` 工具。工具**必须返回**一个结果，模型与用户都能看到，
 * 因此「静默消失」在结构上不再可能。本文件断言这个契约：
 *   A1 正常交卷：受理并开始验证
 *   A2 实例不存在：明确拒绝 + 指路（不是静默）
 *   A3 暂停中交卷：明确拒绝 + 说明原因
 *   A4 已交卷后重复调用：明确拒绝（不重复烧验证）
 *   A5 没有实例的会话交卷：明确拒绝 + 不产生任何副作用
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, voterCountOf } from "../lib/engine.js";

import { deliveryPorts } from "./helpers/ports.mjs";
// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });


let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function mkEngine(ws, scripted = []) {
  return createEngine(ws, {
    ...deliveryPorts(),
    verify: async (req) => {
      const v = scripted.shift();
      if (!v) throw new Error("no scripted verdict");
      return { check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...v };
    },
    log: () => {},
  });
}
/**
 * 内置 `loop` 现在是**多验证者投票**步（每票一条检查依据，全过才放行）：
 * 一轮交卷要投满这么多张判定才会聚合 —— 本文件的脚本化端口按票数入队。
 */
let LOOP_VOTERS = 1;
const votes = (v) => Array.from({ length: LOOP_VOTERS }, () => ({ ...v }));

const cleanup = (ws) => {
  // 引擎已按工作区单根：实例资产都在各自的隔离工作区里，没有全局索引要清理
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
};

console.log("A1 正常交卷：受理并开始验证");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-submit-ok-"));
  const sc = [];
  const e = mkEngine(ws, sc);
  e.ensureLayout();
  LOOP_VOTERS = voterCountOf(e.loadWorkflow("loop").def.steps[0]);
  sc.push(...votes({ status: "passed", reason: "ok" }));
  e.start("loop", "正常交卷", "s1");
  const iid = e.listInstances().at(-1).id;
  const r = e.onSubmit("s1", "我完成了 X 和 Y");
  check("交卷被受理", r.ok, r.text);
  await sleep(80);
  const reportPath = path.join(ws, ".dsh", "ralph-flow", "reports", `${iid}.md`);
  const report = fs.readFileSync(reportPath, "utf-8");
  check("已启动验证、通过并归档（实例目录已销毁）", e.readState(iid) === null && /verify_start/.test(report), report.slice(0, 300));
  check("报告含判定记录", /## 判定/.test(report) && /\[passed\]/.test(report), report.slice(-300));
  cleanup(ws);
}

console.log("\nA2 实例不存在：明确拒绝 + 指路（绝不静默消失）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-submit-none-"));
  const e = mkEngine(ws, []);
  e.ensureLayout();
  const before = e.listInstances().length; // 环境里可能已有真实实例，用增量判定
  const r = e.onSubmit("s-no-instance", "我完成了");
  check("返回失败而不是静默", !r.ok, JSON.stringify(r));
  check("说清「没有活跃实例」", r.text.includes("没有活跃"), r.text);
  check("给出出路（start 或 continue 接管）", r.text.includes("ralphflow-start") || r.text.includes("ralphflow-continue"), r.text);
  check("未产生任何实例", e.listInstances().length === before, `before=${before} after=${e.listInstances().length}`);
  cleanup(ws);
}

console.log("\nA3 暂停中交卷：明确拒绝 + 说明原因");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-submit-paused-"));
  const sc = [];
  const e = mkEngine(ws, sc);
  e.ensureLayout();
  LOOP_VOTERS = voterCountOf(e.loadWorkflow("loop").def.steps[0]);
  sc.push(...votes({ status: "infra", reason: "provider 挂了" })); // 整轮 infra → 自动重试一次 → 仍 infra → 暂停
  e.start("loop", "暂停交卷", "s3");
  const iid = e.listInstances().at(-1).id;
  e.onSubmit("s3", "第一次");
  await sleep(80);
  check("已因 infra 暂停", e.readState(iid).paused, JSON.stringify(e.readState(iid).pause_reason));
  const r = e.onSubmit("s3", "第二次（暂停时）");
  check("暂停中交卷被拒绝", !r.ok, JSON.stringify(r));
  check("说明是暂停状态", r.text.includes("暂停"), r.text);
  cleanup(ws);
}

console.log("\nA4 已交卷后重复调用：明确拒绝，不重复烧验证");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-submit-dup-"));
  /** 每笔委派一个悬挂的 promise（投票步 = N 笔并发），逐笔记账便于分别 resolve */
  const pending = [];
  const e = createEngine(ws, { ...deliveryPorts(), verify: (req) => new Promise((r) => pending.push({ resolve: r, index: req.checkIndex })), log: () => {} });
  e.ensureLayout();
  LOOP_VOTERS = voterCountOf(e.loadWorkflow("loop").def.steps[0]);
  e.start("loop", "重复交卷", "s4");
  const iid = e.listInstances().at(-1).id;
  const r1 = e.onSubmit("s4", "第一次");
  check("首次交卷受理", r1.ok, r1.text);
  await sleep(60);
  const inFlight = e.readState(iid).delegations.length;
  check("每票一笔在飞委派（投票步 = N 笔并发）", inFlight === LOOP_VOTERS, `delegations=${inFlight}`);
  const r2 = e.onSubmit("s4", "第二次");
  check("验证在飞时重复交卷被拒绝", !r2.ok, JSON.stringify(r2));
  check("提示不要重复交卷", r2.text.includes("不要重复交卷") || r2.text.includes("已在处理"), r2.text);
  const st = e.readState(iid);
  check("重复交卷没有多派出任何验证（委派数不变）", st.delegations.length === inFlight, `delegations=${st.delegations.length}`);
  for (const p of pending) p.resolve({ check_index: p.index, step_id: "loop", ts: new Date().toISOString(), status: "passed", reason: "ok" });
  await sleep(80);
  cleanup(ws);
}

console.log("\nA5 无实例会话交卷：不产生任何副作用");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-submit-clean-"));
  const e = mkEngine(ws, []);
  e.ensureLayout();
  const before = e.listInstances().length;
  e.onSubmit("ghost-session", "交卷");
  e.onSubmit("ghost-session", "再交卷");
  check("没有凭空创建实例", e.listInstances().length === before, `before=${before} after=${e.listInstances().length}`);
  check("没有产生报告", !fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "reports")) || fs.readdirSync(path.join(ws, ".dsh", "ralph-flow", "reports")).length === 0);
  cleanup(ws);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
