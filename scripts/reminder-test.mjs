/**
 * 回合收尾检查（agent/turn-stopping）的判定验收 —— 「还有没有剩余事项」，不是「你怎么还没交卷」。
 *
 * 判据：
 *   1. **空回合**才累计：上次提醒之后有工具调用（`lastActionAt` 前进），这一轮只记
 *      `submit_activity` 并清零空回合累计；连续空回合到上限（2）才暂停。
 *   2. **只按连续空回合暂停**：干活的轮不设次数上限，单次停顿不会因为“历史提醒多”
 *      被立刻暂停；连续空回合到上限才停。
 *   3. 计数仍从 history 派生（不新增落盘字段）；`resume` 是新一轮的边界。
 *   4. 提示词问的是「还有没有剩余事项」：有就写进 unfinished / 没有就留空交卷 / 在等用户用 `ask_user_question`。
 *
 * HOME 隔离：测试绝不读写真实 ~/.dsh。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, SUBMIT_REMINDER_STALL_LIMIT } from "../lib/engine.js";
import { deliveryPorts } from "./helpers/ports.mjs";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rf-reminder-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}

const WF = `description: 单步回合收尾检查
steps:
  - id: do
    input: 上游产出
    output: 本步产出
    desc: 单步
    do: 做这一步的工作
    check: 这一步是否真的完成
    on_pass: done
    on_fail: do
    max_fail_count: 3
`;

/** 脚本化引擎：lastActionAt 由用例控制（undefined = 空回合）。 */
function mkEngine() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-reminder-ws-"));
  const dir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "one.yaml"), WF);
  let actionAt;
  const delivered = [];
  const engine = createEngine(ws, {
    ...deliveryPorts((text, summary, cls) => delivered.push({ text, summary, cls })),
    lastActionAt: () => actionAt,
    verify: async () => { throw new Error("本套件不交卷，不应调用验证端口"); },
    log: () => {},
  });
  engine.ensureLayout();
  const newestId = () => engine.listInstances().sort((a, b) => (a.state.started_at > b.state.started_at ? 1 : -1)).at(-1)?.id;
  return {
    ws, engine, delivered,
    start: (sid) => { engine.start("one", "回合收尾任务书", sid); return newestId(); },
    st: (id) => engine.readState(id),
    /** 模拟「上次提醒之后调用过工具」：时间戳必须晚于上一条 history。 */
    acted: () => { actionAt = Date.now() + 5; },
    idle: () => { actionAt = undefined; },
  };
}

const events = (state) => state.history.filter((h) => h.event === "submit_reminder" || h.event === "submit_activity");

console.log("\nR1 空回合：连续 2 次后暂停（不新增落盘字段）");
{
  const E = mkEngine();
  const sid = "session-r1";
  const id = E.start(sid);
  E.idle();
  const r1 = E.engine.remindToSubmit(sid);
  const r2 = E.engine.remindToSubmit(sid);
  check("第 1、2 次连续无工具回合：提醒并标明次数", r1.remind === true && r1.message.includes("第 1/2 次连续无工具回合") && r2.message.includes("第 2/2 次连续无工具回合"), JSON.stringify([r1.message?.slice(0, 40), r2.message?.slice(0, 40)]));
  const r3 = E.engine.remindToSubmit(sid);
  const s = E.st(id);
  check("第 3 次：暂停且原因是 no_submit", r3.remind === false && s.paused === true && s.pause_reason === "no_submit", JSON.stringify({ remind: r3.remind, paused: s.paused, why: s.pause_reason }));
  check("暂停文案说明触发点、交卷无次数上限，并给出三条出路",
    r3.message.includes("没有调用任何工具") && r3.message.includes("没有次数上限") && r3.message.includes("/ralphflow-continue") && r3.message.includes("/ralphflow-cancel"), r3.message);
  check("计数从 history 派生（2 条 submit_reminder + 1 条 reminder_exhausted）",
    s.history.filter((h) => h.event === "submit_reminder").length === 2 && s.history.filter((h) => h.event === "reminder_exhausted").length === 1,
    JSON.stringify(s.history.map((h) => h.event)));
  check("上限是 2（SUBMIT_REMINDER_STALL_LIMIT）", SUBMIT_REMINDER_STALL_LIMIT === 2, String(SUBMIT_REMINDER_STALL_LIMIT));
}

console.log("\nR2 有动作：只记 submit_activity，不累计空回合");
{
  const E = mkEngine();
  const sid = "session-r2";
  const id = E.start(sid);
  E.idle();
  E.engine.remindToSubmit(sid); // 空回合 1
  E.acted();
  const a1 = E.engine.remindToSubmit(sid);
  E.acted();
  const a2 = E.engine.remindToSubmit(sid);
  E.acted();
  const a3 = E.engine.remindToSubmit(sid);
  const s = E.st(id);
  check("有动作的提醒不再说「连续无工具回合」", a1.remind === true && !a1.message.includes("连续无工具回合") && a1.message.includes("本步（`do`）还没结束"), a1.message?.slice(0, 80));
  check("连续 3 次有动作的提醒不会暂停", s.paused === false && a3.remind === true, JSON.stringify({ paused: s.paused, remind: a3.remind }));
  check("轨迹：1 条空回合 + 3 条有动作", (() => {
    const list = events(s).map((h) => h.event);
    return list.filter((e) => e === "submit_reminder").length === 1 && list.filter((e) => e === "submit_activity").length === 3;
  })(), JSON.stringify(events(s).map((h) => h.event)));
  check("有动作的提醒摘要不报累计次数", a2.summary.includes("本轮任务书") && !a2.summary.includes("第 3 次提醒"), a2.summary);
  E.idle();
  const s1 = E.engine.remindToSubmit(sid);
  check("工作停下后重新从连续无工具回合 1 起算", s1.remind === true && s1.message.includes("第 1/2 次连续无工具回合"), s1.message?.slice(0, 60));
}

console.log("\nR3 有动作 + 空回合交替：暂停只看连续空回合");
{
  const E = mkEngine();
  const sid = "session-r3";
  const id = E.start(sid);
  E.idle();
  E.engine.remindToSubmit(sid);            // 空 1
  E.engine.remindToSubmit(sid);            // 空 2
  E.acted();
  const back = E.engine.remindToSubmit(sid); // 有动作 → 清零
  E.idle();
  E.engine.remindToSubmit(sid);            // 空 1
  const s = E.st(id);
  check("空回合累计到 2 之前有动作 → 清零，不暂停", back.remind === true && s.paused === false, JSON.stringify({ paused: s.paused, remind: back.remind }));
  const r = E.engine.remindToSubmit(sid);  // 空 2
  check("再空一次仍在提醒（2/2 边界，尚未暂停）", r.remind === true && r.message.includes("第 2/2 次"), r.message?.slice(0, 60));
}

console.log("\nR4 只按连续空回合暂停：干活的轮不设次数上限，单次停顿只提醒");
{
  const E = mkEngine();
  const sid = "session-r4";
  const id = E.start(sid);
  let pausedAt = 0;
  // 每轮都有动作：没有累计总预算，干多少轮都继续提醒。
  for (let i = 1; i <= 8; i++) {
    E.acted();
    const r = E.engine.remindToSubmit(sid);
    if (!r.remind) { pausedAt = i; break; }
  }
  const s = E.st(id);
  check("连续 8 次有动作：一直提醒、不暂停", pausedAt === 0 && s.paused === false, JSON.stringify({ pausedAt, paused: s.paused }));

  // 干了很多轮之后第一次空回合：只提醒 1/2，不暂停（这正是旧「总预算」误伤的场景）。
  E.idle();
  const first = E.engine.remindToSubmit(sid);
  const afterFirst = E.st(id);
  check("干了很多轮后的第一次空回合：只提醒 1/2，不暂停",
    first.remind === true && first.message.includes("第 1/2 次连续无工具回合") && afterFirst.paused === false,
    JSON.stringify({ remind: first.remind, paused: afterFirst.paused, msg: first.message?.slice(0, 80) }));

  E.idle();
  E.engine.remindToSubmit(sid); // 2/2
  E.idle();
  const third = E.engine.remindToSubmit(sid);
  const paused = E.st(id);
  check("连续第 3 个空回合才暂停", third.remind === false && paused.paused === true && paused.pause_reason === "no_submit",
    JSON.stringify({ remind: third.remind, paused: paused.paused, why: paused.pause_reason }));
  check("暂停文案不再出现「累计 N 次 / 预算」，只说连续没有动作",
    third.message.includes("连续 3 个回合没有调用任何工具") && !third.message.includes("累计") && !third.message.includes("预算"),
    third.message);
}

console.log("\nR5 resume 是新一轮的边界：恢复后重新从 1/2 起算");
{
  const E = mkEngine();
  const sid = "session-r5";
  const id = E.start(sid);
  E.idle();
  E.engine.remindToSubmit(sid);
  E.engine.remindToSubmit(sid);
  E.engine.remindToSubmit(sid);
  check("前置：已 no_submit 暂停", E.st(id).paused === true);
  E.engine.continueInstance(sid);
  E.idle();
  const after = E.engine.remindToSubmit(sid);
  const s = E.st(id);
  check("恢复后第一次提醒是 1/2，不是立刻再暂停", after.remind === true && after.message.includes("第 1/2 次") && s.paused === false, after.message?.slice(0, 60));
  check("轨迹里 resume 在旧的 reminder_exhausted 之后", (() => {
    const idx = s.history.reduce((acc, h, i) => (h.event === "resume" ? i : acc), -1);
    const ex = s.history.reduce((acc, h, i) => (h.event === "reminder_exhausted" ? i : acc), -1);
    return idx > ex;
  })(), JSON.stringify(s.history.map((h) => h.event)));
}

console.log("\nR6 提示词问的是「还有没有剩余事项」");
{
  const E = mkEngine();
  const sid = "session-r6";
  E.start(sid);
  E.idle();
  const r = E.engine.remindToSubmit(sid);
  check("没有剩余事项：留空并结束本轮（不预告验证）",
    r.message.includes("留空") && r.message.includes("ralphflow_submit") && !r.message.includes("引擎会启动") && !r.message.includes("交卷后引擎才会开始独立验证"), r.message);
  check("还有剩余事项：逐条写进 unfinished", r.message.includes("还没完成的事项") && r.message.includes("逐条写进 `unfinished`"), r.message);
  check("在等用户：调用 ask_user_question", r.message.includes("需要用户决定：调用 `ask_user_question`"), r.message);
  check("不再出现「你怎么还没交卷」式的标题", !r.summary.includes("尚未交卷") && r.summary.includes("还没结束"), r.summary);
}

console.log("\nR7 长上下文：催促消息必须自包含（不依赖已经看不见的 DO）");
{
  const E = mkEngine();
  const sid = "session-r7";
  E.start(sid);
  E.idle();
  const r = E.engine.remindToSubmit(sid);
  check("带任务书标题（## 任务，不是短回顾）", r.message.includes("## 任务"), r.message.slice(0, 200));
  check("带任务原文", r.message.includes("回合收尾任务书"), r.message);
  check("带输入", r.message.includes("## 输入") && r.message.includes("上游产出"), r.message);
  check("带本步要做什么", r.message.includes("## 本步要做什么") && r.message.includes("做这一步的工作"), r.message);
  check("带产出目录", /## 产出目录/.test(r.message) && /\.dsh\/ralph-flow\/artifacts\//.test(r.message), r.message);
  check("带交付物", r.message.includes("## 交付物") && r.message.includes("本步产出"), r.message);
  check("带自查依据", r.message.includes("## 本步验收依据（供自查）") && r.message.includes("这一步是否真的完成"), r.message);
}

console.log("\nR8 进度记录：催促必须重复**条目原文**，不能只说「还有 N 项」");
{
  const E = mkEngine();
  const sid = "session-r8";
  E.start(sid);
  const submitted = E.engine.onSubmit(sid, "先做一半", ["接口 A 没接", "回归没跑"]);
  check("前置：进度记录被受理（不启动验证、不推进）", submitted.ok === true && E.st(E.engine.listInstances().at(-1).id).do_submitted === false, submitted.text);
  E.idle();
  const r = E.engine.remindToSubmit(sid);
  check("保留「上一轮记下的 2 项未完成」口径", r.message.includes("上一轮记下的 2 项未完成"), r.message);
  check("逐条列出未完成项（接口 A）", r.message.includes("接口 A 没接"), r.message);
  check("逐条列出未完成项（回归）", r.message.includes("回归没跑"), r.message);
  check("仍然带任务书（## 任务 / ## 本步要做什么）", r.message.includes("## 任务") && r.message.includes("## 本步要做什么"), r.message.slice(0, 400));
}

console.log("\nR8b 长条目：提醒保留有效信息，不截成半句");
{
  const E = mkEngine();
  const sid = "session-r8b";
  E.start(sid);
  const long = "parity 2677 的 E2 团队门：" + "需要逐个核对团队创建、工厂类型和部署时点。".repeat(12) + " END";
  check("前置：条目本身超过旧上限 200", long.length > 200, String(long.length));
  const submitted = E.engine.onSubmit(sid, "长条目", [long]);
  check("前置：长条目进度记录被受理", submitted.ok === true, submitted.text);
  E.idle();
  const r = E.engine.remindToSubmit(sid);
  check("长条目原文完整出现在提醒里", r.message.includes(long), `len=${long.length} reminder=${r.message.length}`);
}

console.log("\nR9 返工：提醒带上一轮检查未通过的原因（长上下文也能定位修什么）");
{
  const E = mkEngine();
  const sid = "session-r9";
  const id = E.start(sid);
  const st = E.st(id);
  st.verdicts.push({ check_index: 0, step_id: "do", status: "failed", reason: "没有覆盖空输入边界", ts: new Date().toISOString() });
  fs.writeFileSync(path.join(E.engine.instanceDir(id), "state.json"), JSON.stringify(st, null, 2));
  E.idle();
  const r = E.engine.remindToSubmit(sid);
  check("带上一轮失败原因原文", r.message.includes("上一轮验证未通过") && r.message.includes("没有覆盖空输入边界"), r.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
