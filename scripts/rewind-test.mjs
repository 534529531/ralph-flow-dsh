/**
 * `/ralphflow-rewind` 验收 —— 「回退」从只声明变成真命令。
 *
 * 两段：
 *   A. **引擎级**（脚本化端口）：机械动作与判据矩阵 —— `current_step` 拨到目标步、暂停与
 *      失败计数已清、判定/在飞委派已作废、`rewind`+`step_start` 入轨迹；回退到当前步 /
 *      未来步 / 不存在的步骤 / 调用点 / 已交卷的步骤各自被拒且**理由准确**；暂停实例回退后
 *      能继续跑；**无检查依据的工作流也能回退**；`submit_reminder` 按本次进入该步起算。
 *   B. **真实宿主**（真实 Session + 真实插件装配 + 真实命令处理器）：属主会话上下文**整段
 *      替换成交接稿**、目标步 DO 带着原因落地、可见告知说的是 `/ralphflow-rewind`；
 *      参数不全与拒绝都交回模型自然语言转达；不注册 `ralphflow_rewind` 工具。
 *
 * HOME 隔离（工作协议）：测试绝不读写真实 ~/.dsh。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { RALPHFLOW_SOURCE_KIND } from "../lib/message-source.js";
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import * as plugin from "../lib/index.js";
import { createEngine, isSubWorkflowCallId } from "../lib/engine.js";
import { cleanupTmp, mkTmp, textOf, toolOf } from "./helpers/plugin-harness.mjs";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rf-rewind-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

const tmpDirs = [];
const mkWs = () => { const d = mkTmp("rewind-ws"); tmpDirs.push(d); return d; };
const writeWf = (ws, name, yaml) => {
  const dir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml);
};

// ─── 工作流定义 ──────────────────────────────────────────────────────────────
const step = (id, onPass, extra = "") => `  - id: ${id}
    input: 上游产出
    output: 本步产出 ${id}
    desc: 步骤 ${id}
    do: 做 ${id} 的工作
    check: ${id} 是否真的完成
    on_pass: ${onPass}
    on_fail: ${id}
${extra}    max_fail_count: 3
`;
const WF_RW = `description: 三步回退验收
steps:
${step("s1", "s2")}${step("s2", "s3")}${step("s3", "done")}`;
// 无检查依据的工作流（每步都不写 check / check_voting）
const WF_NOCHECK = `description: 无检查依据也能回退
steps:
  - id: a
    input: 上游产出
    output: 本步产出 a
    desc: 步骤 a
    do: 做 a 的工作
    on_pass: b
    on_fail: a
    max_fail_count: 3
  - id: b
    input: 上游产出
    output: 本步产出 b
    desc: 步骤 b
    do: 做 b 的工作
    on_pass: done
    on_fail: b
    max_fail_count: 3
`;
// 暂停验收：s2 一失败就到上限（max_fail_count: 1）
const WF_PAUSE = `description: 暂停后回退
steps:
${step("s1", "s2")}  - id: s2
    input: 上游产出
    output: 本步产出 s2
    desc: 步骤 s2
    do: 做 s2 的工作
    check: s2 是否真的完成
    on_pass: done
    on_fail: s2
    max_fail_count: 1
`;
// 子工作流调用点：父级 p1 → 调用点 call（展开成 call/t1）
const WF_SUB = `description: 子工作流
steps:
${step("t1", "done")}`;
const WF_PARENT_CALL = `description: 父级含调用点
steps:
${step("p1", "call")}  - id: call
    desc: 调用点
    input: 上游产出
    output: 本步产出
    on_fail: call
    max_fail_count: 3
    workflow: rwsub
    on_pass: done
`;

// ═══ A) 引擎级 ═══════════════════════════════════════════════════════════════
/** 脚本化引擎：deliver 记账、验证判定排队、resetSurface 记账 */
function mkEngine(workflows, opts = {}) {
  const ws = mkWs();
  for (const [n, y] of Object.entries(workflows)) writeWf(ws, n, y);
  const delivered = [];      // { text, summary }
  const resets = [];         // ResetRequest
  let scripted = [];
  const engine = createEngine(ws, {
    deliver: (_sid, text, summary) => { delivered.push({ text, summary }); return true; },
    verify: async (req) => {
      const v = scripted.shift();
      if (!v) throw new Error("no scripted verdict");
      return { check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...v };
    },
    resetSurface: async (_sid, req) => { resets.push(req); return opts.resetOutcome ?? { ok: true, shadowed: 7, handoffSeq: 99, noticeSeq: 98 }; },
    log: () => {},
  });
  engine.ensureLayout();
  const st = (id) => engine.readState(id);
  const newestId = () => engine.listInstances().sort((a, b) => (a.state.started_at > b.state.started_at ? 1 : -1)).at(-1)?.id;
  const execLog = (id) => {
    try { return fs.readFileSync(path.join(engine.instancesDir, id, "execution.log"), "utf-8"); } catch { return ""; }
  };
  return {
    ws, engine, delivered, resets, st, newestId, execLog,
    queue: (v) => scripted.push(v),
    start: (wf, task, sid) => { engine.start(wf, task, sid); return newestId(); },
    last: () => delivered.at(-1),
  };
}
const settle = () => sleep(30);

// ─── A1) 完整回退：机械动作 + 同一根接线（整段替换 + 带原因的 DO）───────────
console.log("\nA1) 完整回退：状态机倒退 + 清暂停/失败计数 + 交接稿 + DO 带原因");
{
  const E = mkEngine({ wfrw: WF_RW });
  const sid = "session-rw-1";
  const id = E.start("wfrw", "回退任务书", sid);
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s1 完成"); await settle();
  check("先推进到第二步（前置条件）", E.st(id).current_step === "s2", E.st(id).current_step);

  const before = E.delivered.length;
  const res = E.engine.rewindTo(sid, "s1", "改用方案 B：原方向与需求不符");
  check("回退被受理", res.ok === true, res.text);
  await settle();
  const s = E.st(id);

  check("① current_step 拨到目标步", s.current_step === "s1", s.current_step);
  check("② 暂停已清（paused=false、pause_reason 无）", s.paused === false && s.pause_reason === undefined, JSON.stringify({ paused: s.paused, why: s.pause_reason }));
  check("③ 失败计数已清（fail_counts={}、fail_count=0）",
    JSON.stringify(s.fail_counts) === "{}" && s.fail_count === 0, JSON.stringify({ fc: s.fail_counts, f: s.fail_count }));
  check("④ do_submitted=false、verdicts=[]、delegations=[]",
    s.do_submitted === false && s.verdicts.length === 0 && s.delegations.length === 0,
    JSON.stringify({ sub: s.do_submitted, v: s.verdicts.length, d: s.delegations.length }));
  check("⑤ 轨迹记了 rewind（带 from→to 与原因原文）",
    s.history.some((h) => h.event === "rewind" && h.step === "s1" && h.detail.includes("s2 → s1") && h.detail.includes("改用方案 B")),
    JSON.stringify(s.history.slice(-4)));
  check("⑤ 轨迹记了 step_start（本次进入该步的边界）",
    s.history.some((h) => h.event === "step_start" && h.step === "s1"),
    JSON.stringify(s.history.slice(-4)));

  // 同一根接线：整段替换（交接稿 + 可见告知）+ DO 重投
  check("⑥ 走了重置接线：resetSurface 恰被调用一次（强制，该步没标 reset:true）", E.resets.length === 1, `count=${E.resets.length}`);
  const req = E.resets[0];
  check("⑥ 交接稿是 ralphflow 交接稿，且指向目标步（第 1/3 步 s1）",
    req.handoff.includes("[ralphflow 交接稿]") && req.handoff.includes("（第 1/3 步）") && req.handoff.includes("`s1`"), req.handoff.slice(0, 160));
  check("⑥ 可见告知写明来源 = 用户执行了 /ralphflow-rewind",
    req.notice.text.includes("用户执行了 `/ralphflow-rewind`") && req.notice.summary.includes("ralphflow-rewind"),
    JSON.stringify(req.notice));
  check("⑥ 可见告知点明「暂停与失败计数已清」「下游旧产出仍在盘上」",
    req.notice.text.includes("暂停与失败计数已清") && req.notice.text.includes("下游旧产出仍在盘上"), req.notice.text);
  check("⑥ canProceed 在投递前复查实例仍可推进", req.canProceed?.() === true);

  const doText = E.last()?.text ?? "";
  check("⑦ 重投的 DO 是真的 DO（## 任务 / ## 本步要做什么）",
    doText.includes("## 任务") && doText.includes("做 s1 的工作"), doText.slice(0, 120));
  check("⑦ DO 里原因**自成一段**（标题 + 用户原因原文）",
    doText.includes("## 用户回退了这一步（`/ralphflow-rewind`：从 `s2` 回到 `s1`）")
    && doText.includes("改用方案 B：原方向与需求不符"), doText.slice(0, 400));
  check("⑦ 那一段同时点明下游旧产出仍在盘上、基于旧方向，并列出了下游步骤",
    doText.includes("下游旧产出仍在盘上、且基于旧方向") && doText.includes("`s2`") && doText.includes("`s3`"), doText);
  check("⑦ 播报摘要说得出是哪条命令", (E.last()?.summary ?? "").includes("ralphflow-rewind"), E.last()?.summary);
  check("⑦ 回退是一次真实投递（deliver 被再次调用）", E.delivered.length > before);

  check("⑧ 执行日志记了 rewind（机器可复盘）", E.execLog(id).includes('"event":"rewind"'), E.execLog(id).split("\n").slice(-3).join("\n"));
  check("⑧ 执行日志记了本步 step_start（本次进入该步的边界）", E.execLog(id).includes('"event":"step_start"'));
}

// ─── A2) 判据矩阵：当前步 / 未来步 / 不存在 / 已交卷，各自被拒且理由准确 ─────
console.log("\nA2) 判据矩阵：每条拒绝理由都得说准");
{
  const E = mkEngine({ wfrw: WF_RW });
  const sid = "session-rw-2";
  const id = E.start("wfrw", "判据任务书", sid);
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s1 完成"); await settle();
  check("前置：当前步 = s2", E.st(id).current_step === "s2");

  const rCur = E.engine.rewindTo(sid, "s2", "回到自己");
  check("回退到当前步 → 拒绝，且理由说「就是当前步」并指向 /ralphflow-reset",
    rCur.ok === false && rCur.text.includes("就是当前步") && rCur.text.includes("/ralphflow-reset"), rCur.text);
  const rFuture = E.engine.rewindTo(sid, "s3", "往前跳");
  check("回退到未来步 → 拒绝，且理由说「之后」并给出两个步号",
    rFuture.ok === false && rFuture.text.includes("之后") && rFuture.text.includes("第 3/3 步"), rFuture.text);
  const rNone = E.engine.rewindTo(sid, "nope", "不存在");
  check("回退到不存在的步骤 → 拒绝，且列出之前可回退的步骤",
    rNone.ok === false && rNone.text.includes("没有步骤 `nope`") && rNone.text.includes("`s1`"), rNone.text);
  const rNoReason = E.engine.rewindTo(sid, "s1", "   ");
  check("缺原因（引擎侧防御）→ 拒绝", rNoReason.ok === false && rNoReason.text.includes("缺少回退原因"), rNoReason.text);
  check("三条拒绝都**没有**动状态机（仍停在 s2、未触发替换）",
    E.st(id).current_step === "s2" && E.resets.length === 0 && !E.st(id).history.some((h) => h.event === "rewind"));

  // 已交卷 → 拒绝：交卷与回退必须在同一 tick（判定是异步落地的）
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s2 完成");
  const rSubmitted = E.engine.rewindTo(sid, "s1", "验证在飞时回退");
  check("回退到已交卷的步骤 → 拒绝，且理由点明「已交卷」与验证/审查门",
    rSubmitted.ok === false && rSubmitted.text.includes("已交卷") && rSubmitted.text.includes("拒绝回退"), rSubmitted.text);
  await settle();
  check("被拒后实例照常推进（拒绝没有副作用）", E.st(id).current_step === "s3", E.st(id).current_step);
}

// ─── A3) 调用点不是步骤 ──────────────────────────────────────────────────────
console.log("\nA3) 调用点不是可回退的步骤");
{
  const E = mkEngine({ rwparent: WF_PARENT_CALL, rwsub: WF_SUB });
  const sid = "session-rw-3";
  const id = E.start("rwparent", "调用点任务书", sid);
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "p1 完成"); await settle();
  const s = E.st(id);
  check("前置：调用点已静态展开（当前步 = call/t1）", s.current_step === "call/t1", s.current_step);
  check("isSubWorkflowCallId 认得调用点", isSubWorkflowCallId(E.engine.loadWorkflow("rwparent").def, "call") === true);
  const r = E.engine.rewindTo(sid, "call", "回到调用点");
  check("回退到调用点 → 拒绝，且说清它被展开成了哪些步骤",
    r.ok === false && r.text.includes("子工作流调用点") && r.text.includes("`call/t1`"), r.text);
  const rSelf = E.engine.rewindTo(sid, "call/t1", "回到当前展开步");
  check("回退到展开后的当前步 → 仍按「就是当前步」拒绝（调用点与展开步不是同一判据）",
    rSelf.ok === false && rSelf.text.includes("就是当前步"), rSelf.text);
}

// ─── A4) 暂停态回退：顺带解除暂停，之后能继续跑 ──────────────────────────────
console.log("\nA4) 暂停实例：回退顺带解除暂停，之后能继续跑");
{
  const E = mkEngine({ wfpause: WF_PAUSE });
  const sid = "session-rw-4";
  const id = E.start("wfpause", "暂停回退任务书", sid);
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s1 完成"); await settle();
  check("前置：当前步 = s2", E.st(id).current_step === "s2");
  E.queue({ status: "failed", reason: "不合要求" });
  E.engine.onSubmit(sid, "s2 完成"); await settle();
  const paused = E.st(id);
  check("前置：s2 失败到上限 → 暂停（max_failures）且失败计数 = 1",
    paused.paused === true && paused.pause_reason === "max_failures" && paused.fail_counts.s2 === 1,
    JSON.stringify({ p: paused.paused, why: paused.pause_reason, fc: paused.fail_counts }));
  check("暂停中 reset 仍被拒（回退与重置的判据不同：判据是 do_submitted，不是 paused）",
    E.engine.resetCurrent(sid).ok === false && E.engine.resetCurrent(sid).text.includes("拒绝重置"));

  const r = E.engine.rewindTo(sid, "s1", "停下来后换方向");
  check("暂停态回退被受理", r.ok === true, r.text);
  await settle();
  const after = E.st(id);
  check("回退后不再暂停、失败计数清空", after.paused === false && after.pause_reason === undefined && after.fail_count === 0);

  // 能继续跑：交卷 → 验证通过 → 再次推进到 s2
  E.queue({ status: "passed", reason: "ok" });
  const sub = E.engine.onSubmit(sid, "s1 换方向后重做完成");
  await settle();
  const running = E.st(id);
  check("回退后的实例能继续跑（交卷被受理并推进）", sub.ok === true && running.current_step === "s2" && running.paused === false && running.do_submitted === false,
    JSON.stringify({ sub: sub.ok, cur: running.current_step, paused: running.paused }));
}

// ─── A5) 无检查依据的工作流也能回退，并继续跑 ────────────────────────────────
console.log("\nA5) 无 check / check_voting 的工作流：同样能回退");
{
  const E = mkEngine({ wfnocheck: WF_NOCHECK });
  const sid = "session-rw-5";
  const id = E.start("wfnocheck", "无检查回退任务书", sid);
  check("前置：首步 = a", E.st(id).current_step === "a");
  E.engine.onSubmit(sid, "a 完成"); await settle();
  check("无检查步交卷即推进（跳过对抗性验证）", E.st(id).current_step === "b", E.st(id).current_step);

  const r = E.engine.rewindTo(sid, "a", "无检查流程也要能换方向");
  check("无检查依据的工作流回退被受理", r.ok === true, r.text);
  await settle();
  check("回退后停在 a，且强制走了整段替换（该步没标 reset）", E.st(id).current_step === "a" && E.resets.length === 1,
    JSON.stringify({ cur: E.st(id).current_step, resets: E.resets.length }));
  const doText = E.last()?.text ?? "";
  check("目标步 DO 带着原因，且如实说明本步跳过对抗性验证",
    doText.includes("无检查流程也要能换方向") && doText.includes("跳过对抗性验证"), doText.slice(-400));

  E.engine.onSubmit(sid, "a 换方向后重做完成"); await settle();
  check("回退后继续跑（再次推进到 b）", E.st(id).current_step === "b", E.st(id).current_step);
}

// ─── A6) submit_reminder 次数按「本次进入该步」起算 ──────────────────────────
console.log("\nA6) submit_reminder：按本次进入该步起算（step_start 是边界）");
{
  const E = mkEngine({ wfrw: WF_RW });
  const sid = "session-rw-6";
  const id = E.start("wfrw", "提醒预算任务书", sid);
  const r1 = E.engine.remindToSubmit(sid);
  const r2 = E.engine.remindToSubmit(sid);
  check("前置：s1 上先耗尽提醒预算（两次提醒）",
    r1.remind === true && r1.message.includes("第 1/2 次") && r2.remind === true && r2.message.includes("第 2/2 次"),
    JSON.stringify({ r1: r1.message?.slice(0, 40), r2: r2.message?.slice(0, 40) }));
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s1 完成"); await settle();
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s2 完成"); await settle();
  check("前置：已推进到 s3", E.st(id).current_step === "s3", E.st(id).current_step);

  E.engine.rewindTo(sid, "s1", "回到用光提醒预算的步骤");
  await settle();
  const s = E.st(id);
  const rawCount = s.history.filter((h) => h.event === "submit_reminder" && h.step === "s1").length;
  check("负对照：整段 history 口径下 s1 的提醒确实已用光（旧口径会立刻 no_submit 暂停）", rawCount >= 2, `raw=${rawCount}`);
  const boundaryIdx = s.history.reduce((acc, h, i) => (h.step === "s1" && (h.event === "step_start" || h.event === "rework_rewind" || h.event === "do_submitted" || h.event === "resume") ? i : acc), -1);
  const lastReminderIdx = s.history.reduce((acc, h, i) => (h.event === "submit_reminder" && h.step === "s1" ? i : acc), -1);
  check("回退写下的 step_start 在旧提醒之后（它就是本次进入该步的边界）", boundaryIdx > lastReminderIdx,
    JSON.stringify({ boundaryIdx, lastReminderIdx }));
  const r = E.engine.remindToSubmit(sid);
  const now = E.st(id);
  check("回退后用光过预算的步骤不会立刻 no_submit 暂停（提醒从第 1/2 次重新起算）",
    r.remind === true && String(r.message).includes("第 1/2 次") && now.paused === false,
    JSON.stringify({ remind: r.remind, msg: r.message?.slice(0, 60), paused: now.paused }));
}

// ─── A7) 无活跃实例：列候选并指向 /ralphflow-continue ───────────────────────
console.log("\nA7) 无活跃实例：照 resetCurrent 的形态列候选");
{
  const E = mkEngine({ wfrw: WF_RW });
  const none = E.engine.rewindTo("session-other", "s1", "没有实例");
  check("没有任何活跃实例 → 拒绝并指路 start", none.ok === false && none.text.includes("没有活跃实例") && none.text.includes("/ralphflow-start"), none.text);
  const id = E.start("wfrw", "别人的实例", "session-owner");
  const other = E.engine.rewindTo("session-other", "s1", "别人的实例");
  check("有别人的活跃实例 → 列候选（含实例 id 与当前步）并指向 /ralphflow-continue",
    other.ok === false && other.text.includes(id) && other.text.includes("/ralphflow-continue"), other.text);
}

// ─── A8) 暂停的两种形态都能回退（no_submit 的 do_submitted=false）+ 连续回退 ──
console.log("\nA8) 暂停态回退（no_submit）与连续回退");
{
  const E = mkEngine({ wfrw: WF_RW });
  const sid = "session-rw-8";
  const id = E.start("wfrw", "no_submit 任务书", sid);
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s1 完成"); await settle();
  E.engine.remindToSubmit(sid);
  E.engine.remindToSubmit(sid);
  const third = E.engine.remindToSubmit(sid);
  const p = E.st(id);
  check("前置：反复未交卷 → no_submit 暂停（do_submitted=false，与 max_failures 形态不同）",
    third.remind === false && p.paused === true && p.pause_reason === "no_submit" && p.do_submitted === false,
    JSON.stringify({ paused: p.paused, why: p.pause_reason, sub: p.do_submitted }));
  const r = E.engine.rewindTo(sid, "s1", "没交卷也要能换方向");
  await settle();
  check("no_submit 暂停同样允许回退（判据 do_submitted=false，不是 paused）",
    r.ok === true && E.st(id).paused === false && E.st(id).pause_reason === undefined && E.st(id).current_step === "s1", r.text);
}
{
  const E = mkEngine({ wfrw: WF_RW });
  const sid = "session-rw-8b";
  const id = E.start("wfrw", "连续回退任务书", sid);
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s1 完成"); await settle();
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s2 完成"); await settle();
  check("前置：已推进到 s3", E.st(id).current_step === "s3");
  const first = E.engine.rewindTo(sid, "s2", "先退一步");
  await waitFor(() => E.resets.length >= 1);
  check("第一次回退到 s2 被受理", first.ok === true && E.st(id).current_step === "s2");
  const second = E.engine.rewindTo(sid, "s1", "再退一步");
  await settle();
  check("连续第二次回退到 s1 被受理（DO 投递完成后空闲窗口重新可用）",
    second.ok === true && E.st(id).current_step === "s1", second.text);
  check("两次回退 = 两次整段替换（同一根接线复用）", E.resets.length === 2, `count=${E.resets.length}`);
}

// ─── A9) 换上下文失败时，DO 照样带着原因落地 ─────────────────────────────────
console.log("\nA9) 替换失败也绝不吞掉 DO（原因照旧落地）");
{
  const E = mkEngine({ wfrw: WF_RW }, { resetOutcome: { ok: false, reason: "not_idle", detail: "agent already has active work" } });
  const sid = "session-rw-9";
  const id = E.start("wfrw", "替换失败任务书", sid);
  E.queue({ status: "passed", reason: "ok" });
  E.engine.onSubmit(sid, "s1 完成"); await settle();
  const r = E.engine.rewindTo(sid, "s1", "即使换不了上下文也必须落地");
  await settle();
  const doText = E.last()?.text ?? "";
  check("回退仍被受理（替换失败不是回退失败）", r.ok === true && E.st(id).current_step === "s1", r.text);
  check("DO 照常投递，且**仍然带着原因**（没有 keep_session 这类逃生口）",
    doText.includes("## 用户回退了这一步") && doText.includes("即使换不了上下文也必须落地"), doText.slice(0, 300));
  check("播报如实说明本次替换未生效（原因是「不在空闲窗口」）",
    (E.last()?.summary ?? "").includes("未生效") && (E.last()?.summary ?? "").includes("空闲窗口"), E.last()?.summary);
}

// ═══ B) 真实宿主：真实 Session + 真实插件装配 + 真实命令处理器 ═══════════════
// 与 reset-surface-test.mjs 同一套「一步一回合、步与步之间有空闲窗口」的时序替身，
// 这里只保留回退验收需要的那部分。
console.log("\nB) 真实宿主：命令处理器 → 状态机倒退 → 整段替换 → DO 带原因落地");

const SYSTEM_TEXT = "你是 dsh 助手（原系统提示，必须原样保留）。";
const PRIOR_TEXT = "旧对话：帮我按旧方向重构（这段必须被移出模型上下文）";

function mkRealEnv(workflows, wfName) {
  const ws = mkWs();
  for (const [n, y] of Object.entries(workflows)) writeWf(ws, n, y);
  process.env.RALPHFLOW_WORKSPACE = ws;

  const sid = "session-rewind-real";
  const ctx = new Context();
  const registered = { tools: [], commands: [] };
  const agents = new Map();
  const session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  let phase = "idle";
  const inbox = [];
  const idleWaiters = [];
  const settleIdle = () => { if (phase !== "idle") return; for (const r of idleWaiters.splice(0)) r(); };
  const agent = {
    id: sid,
    session,
    steer: (m) => { inbox.push(m); },
    followup: (m) => { inbox.push(m); },
    whenIdle: () => (phase === "idle" ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
    runMaintenance(job) {
      if (phase !== "idle") throw new Error(`agent "${sid}" already has active work`);
      phase = "maintenance";
      return Promise.resolve().then(() => job(new AbortController().signal)).finally(() => { phase = "idle"; settleIdle(); });
    },
  };
  agents.set(sid, agent);

  ctx.provide("tools", {
    register: (d) => registered.tools.push(d),
    schemas: () => [{ name: "read" }, { name: "grep" }, { name: "glob" }, { name: "bash" }],
  });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: async () => ({ id: "child", result: Promise.resolve({ structured: { passed: true, reason: "取证通过" }, output: [], stopReason: "completed" }) }),
  });
  ctx.provide("agents", { get: (id) => agents.get(id) });
  ctx.provide("sessions", { list: () => [sid], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });

  plugin.apply(ctx);

  const cmdAs = async (asSid, name, rawInput) => {
    const cmd = registered.commands.find((c) => c.name === name);
    if (!cmd) throw new Error(`未注册命令 ${name}`);
    return cmd.handler({ commandId: `c-${name}`, agent: { session: { id: asSid } }, rawInput, attachments: [], signal: new AbortController().signal });
  };
  const callAs = async (asSid, name, args) => {
    const tool = toolOf(registered, name);
    if (!tool) throw new Error(`未注册工具 ${name}`);
    return tool.execute(args ?? {}, { agent: { session: { id: asSid } }, signal: new AbortController().signal });
  };
  const turn = async (fn) => {
    phase = "turn";
    try { const out = await fn(); await sleep(10); return out; }
    finally { phase = "idle"; settleIdle(); }
  };
  const appendToolExchange = (callId, name, resultText) => {
    session.append("assistant/message", {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: "tool-call", id: callId, name, arguments: "{}" }],
        source: { kind: "model", provider: "p", model: "m" },
      }),
      stream: [],
    }, { surfaceOp: "append" });
    session.append("tool/result", {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: "text", text: resultText }], isError: false }),
    }, { surfaceOp: "append" });
  };
  const drainInbox = () => {
    const out = [];
    while (inbox.length > 0) {
      const m = inbox.shift();
      session.append("user/message", m, { surfaceOp: "append" });
      out.push(m);
    }
    return out;
  };
  const instanceState = () => {
    const root = path.join(ws, ".dsh", "ralph-flow", "instances");
    let names = [];
    try { names = fs.readdirSync(root); } catch { return null; }
    if (names.length === 0) return null;
    try { return JSON.parse(fs.readFileSync(path.join(root, names[0], "state.json"), "utf-8")); } catch { return null; }
  };
  const execLogText = () => {
    const root = path.join(ws, ".dsh", "ralph-flow", "instances");
    let names = [];
    try { names = fs.readdirSync(root); } catch { return ""; }
    return names.map((n) => { try { return fs.readFileSync(path.join(root, n, "execution.log"), "utf-8"); } catch { return ""; } }).join("\n");
  };
  return { ws, sid, session, inbox, registered, agents, turn, cmdAs, callAs, appendToolExchange, drainInbox, instanceState, execLogText, wfName };
}

function seedPrior(session) {
  session.append("system/message", { turn: 0, step: 0, message: createSystemMessage(SYSTEM_TEXT, "dsh-system-prompt") }, { surfaceOp: "append" });
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: PRIOR_TEXT }], source: { kind: "user" } }), { surfaceOp: "append" });
  session.append("assistant/message", {
    turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: "text", text: "旧回复：按旧方向来吧。" }], source: { kind: "model", provider: "p", model: "m" } }),
    stream: [],
  }, { surfaceOp: "append" });
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "旧追问：先别动。" }], source: { kind: "user" } }), { surfaceOp: "append" });
}

{
  const H = mkRealEnv({ wfrw: WF_RW }, "wfrw");
  seedPrior(H.session);
  const stNow = () => H.instanceState();

  // 命令面（注册表层面）：命令在、工具不在（§10.10）
  const rewindCmd = H.registered.commands.find((c) => c.name === "ralphflow-rewind");
  check("B1 命令 /ralphflow-rewind 已注册", !!rewindCmd);
  check("B1 description 已同步（说清回退语义与示例）",
    rewindCmd.description.includes("回退到更早的步骤") && rewindCmd.description.includes("示例"), rewindCmd.description);
  check("B1 input.hint = `<步骤> <原因>`（两个都必填）", rewindCmd.input?.hint === "<步骤> <原因>", JSON.stringify(rewindCmd.input));
  check("B1 **不注册** ralphflow_rewind 工具（§10.10：不给模型可调用的修复入口）",
    H.registered.tools.every((t) => t.name !== "ralphflow_rewind"));
  check("B1 也不注册 ralphflow_reset 工具（两条机械命令同一边界）",
    H.registered.tools.every((t) => t.name !== "ralphflow_reset"));

  // 走两步：s1 通过 → s2 通过 → s3
  const startText = await H.turn(async () => {
    const out = await H.callAs(H.sid, "ralphflow_start", { workflow: "wfrw", task: "回退任务书 T" });
    H.appendToolExchange("c-start", "ralphflow_start", out);
    return out;
  });
  check("B2 启动成功（前置）", startText.includes("已启动"), startText.slice(0, 60));
  const instId = fs.readdirSync(path.join(H.ws, ".dsh", "ralph-flow", "instances"))[0];
  await H.turn(async () => {
    const out = await H.callAs(H.sid, "ralphflow_submit", { summary: "s1 完成" });
    H.appendToolExchange("c-sub1", "ralphflow_submit", out);
    return out;
  });
  await waitFor(() => stNow()?.current_step === "s2");
  H.drainInbox();
  await H.turn(async () => {
    const out = await H.callAs(H.sid, "ralphflow_submit", { summary: "s2 完成" });
    H.appendToolExchange("c-sub2", "ralphflow_submit", out);
    return out;
  });
  await waitFor(() => stNow()?.current_step === "s3");
  H.drainInbox();
  check("B2 前置：真实跑到第三步（s3）", stNow()?.current_step === "s3", stNow()?.current_step);
  const msgsBefore = H.session.deriveMessages().length;
  check("B2 前置：旧上下文确实在模型上下文里（含种子与各步 DO）", msgsBefore > 5, `count=${msgsBefore}`);

  // ── 参数不全 → 交回模型自然语言追问（与 /ralphflow-start 同款）──
  const missing = await H.cmdAs(H.sid, "ralphflow-rewind", "s1");
  check("B3 缺原因：命令当场受理（零程序化卡片：无 text）", missing.kind === "success" && !missing.text, JSON.stringify(missing));
  await sleep(20);
  const ask = textOf(H.inbox.at(-1));
  check("B3 交给模型的是一条「自然语言追问」指令（说明用法 + 不要调用工具）",
    ask.includes("<步骤> <原因>") && ask.includes("不要调用任何工具") && ask.includes("缺的是**回退原因**"), ask.slice(0, 200));
  check("B3 参数不全**没有**改动状态机", stNow()?.current_step === "s3" && !stNow()?.history.some((h) => h.event === "rewind"));
  H.drainInbox();

  // ── 真跑一次回退 ──
  const rew = await H.cmdAs(H.sid, "ralphflow-rewind", "s1 改用方案 B：原方向与需求不符");
  check("B4 命令受理（零程序化卡片：无 text）", rew.kind === "success" && !rew.text, JSON.stringify(rew));
  await waitFor(() => (stNow()?.current_step === "s1" && H.session.surface.nodes.length >= 2 && (H.inbox.length > 0)), 4000);
  const st = stNow();
  check("B4 current_step 拨到目标步 s1", st?.current_step === "s1", st?.current_step);
  check("B4 暂停与失败计数已清", st?.paused === false && st?.pause_reason === undefined && JSON.stringify(st?.fail_counts) === "{}" && Number(st?.fail_count ?? 0) === 0,
    JSON.stringify({ paused: st?.paused, fc: st?.fail_counts, why: st?.pause_reason, f: st?.fail_count }));
  check("B4 交卷标记与判定已作废", st?.do_submitted === false && st?.verdicts.length === 0 && st?.delegations.length === 0);

  const drained = H.drainInbox();
  const msgs = H.session.deriveMessages();
  const texts = msgs.map((m) => textOf(m));
  check("B5 属主会话上下文**整段替换**：messages = 系统提示 + 交接稿 + DO（3 条）", msgs.length === 3, JSON.stringify(texts.map((t) => t.slice(0, 30))));
  check("B5 第 0 条仍是原系统提示", msgs[0]?.role === "system" && texts[0] === SYSTEM_TEXT, texts[0]);
  check("B5 第 1 条是 ralphflow 交接稿，且指向目标步（第 1/3 步 s1）",
    texts[1].includes("[ralphflow 交接稿]") && texts[1].includes("（第 1/3 步）") && texts[1].includes("`s1`"), texts[1]?.slice(0, 160));
  check("B5 旧对话 100% 移出模型上下文（种子与旧步的原文都不在了）",
    !texts.some((t) => t.includes(PRIOR_TEXT) || t.includes("旧回复") || t.includes("旧追问") || t.includes("s2 完成")),
    JSON.stringify(texts.map((t) => t.slice(0, 24))));
  check("B5 第 2 条是目标步 DO，**带着原因**且那一段自成一段",
    texts[2].includes("## 用户回退了这一步") && texts[2].includes("改用方案 B：原方向与需求不符")
    && texts[2].includes("下游旧产出仍在盘上、且基于旧方向"), texts[2]?.slice(0, 500));
  check("B5 DO 在替换**之后**才进收件箱（顺序不可颠倒）", drained.length >= 1 && textOf(drained.at(-1)).includes("## 用户回退了这一步"));

  // 替换事件取证（复用 reset 载体的硬约束）
  const events = H.session.snapshotEvents();
  const reps = events.filter((e) => e.surfaceOp && typeof e.surfaceOp === "object" && e.surfaceOp.op === "replace");
  check("B6 日志里恰有 1 次整段替换", reps.length === 1, `count=${reps.length}`);
  const rep = reps[0];
  const notice = events.find((e) => e.seq === rep.surfaceOp.endSeq);
  check("B6 替换节点用自有 source kind（不冒用 compact；不带 form = 不进用户可见面）",
    rep?.data?.source?.kind === RALPHFLOW_SOURCE_KIND && rep.data.source.form === undefined,
    JSON.stringify(rep?.data?.source));
  check("B6 可见告知（被同一次替换遮蔽）说的是「用户执行了 /ralphflow-rewind」且已被移出可见面",
    notice?.data?.source?.form === "notice"
    && textOf(notice.data).includes("用户执行了 `/ralphflow-rewind`")
    && !H.session.surface.nodes.includes(notice?.seq),
    JSON.stringify({ form: notice?.data?.source?.form, seq: notice?.seq, text: textOf(notice?.data).slice(0, 80) }));
  check("B6 没有伪造 compaction/* 事件", !events.some((e) => String(e.type).startsWith("compaction/")));

  check("B7 执行日志记了 rewind + 来源标注 reset_surface(trigger=rewind)",
    H.execLogText().includes('"event":"rewind"') && H.execLogText().includes('"trigger":"rewind"'), H.execLogText().split("\n").filter((l) => l.includes("rewind")).join("\n"));
  check("B7 轨迹记了 rewind（带原因）与 step_start",
    st?.history.some((h) => h.event === "rewind" && h.detail.includes("改用方案 B"))
    && st?.history.some((h) => h.event === "step_start" && h.step === "s1"),
    JSON.stringify(st?.history.slice(-3)));

  // ── 拒绝理由交回模型转达（以「回退到当前步」为例）──
  const rejected = await H.cmdAs(H.sid, "ralphflow-rewind", "s1 再来一次");
  check("B8 拒绝也当场受理（无 text），原因交回模型", rejected.kind === "success" && !rejected.text);
  await sleep(20);
  const relay = textOf(H.inbox.at(-1));
  check("B8 转达指令含**准确**拒绝理由，并给出下一步（/ralphflow-reset 等）",
    relay.includes("被拒绝") && relay.includes("就是当前步") && relay.includes("/ralphflow-reset"),
    relay.slice(0, 260));
  check("B8 可用命令清单（AVAILABLE_COMMANDS 单一事实源）已含 /ralphflow-rewind",
    relay.includes("当前可用命令") && relay.includes("`/ralphflow-rewind`"), relay.slice(-260));
  check("B8 拒绝未改动状态机", stNow()?.current_step === "s1");
  H.drainInbox();

  // ── 回退后的实例能继续跑（真实验证链路）──
  await H.turn(async () => {
    const out = await H.callAs(H.sid, "ralphflow_submit", { summary: "s1 换方向后重做完成" });
    H.appendToolExchange("c-sub3", "ralphflow_submit", out);
    return out;
  });
  await waitFor(() => stNow()?.current_step === "s2");
  check("B9 回退后能继续跑：交卷 → 独立验证通过 → 再次推进到 s2", stNow()?.current_step === "s2", stNow()?.current_step);
}

// ─── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of tmpDirs) {
  try { cleanupTmp(d); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
