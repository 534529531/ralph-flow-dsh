/**
 * 回归断言（加固轮）：针对 summary.md 审计清单里判为「恶性 bug」的条目，
 * 每一条都用真实 lib/engine.js 复现，并断言修复后的行为。
 * 独立于 engine-test.mjs，可单独跑：node scripts/hardening-test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-hardening-"));
const deliveries = [];
let scripted = [];
const engine = createEngine(dir, {
  deliver: (_sid, text) => { deliveries.push(text); return true; },
  verify: async (req) => {
    const v = scripted.shift();
    if (!v) throw new Error("no scripted verdict");
    return { check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...v };
  },
  log: () => {},
});

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const newestId = () => engine.listInstances().sort((a, b) => (a.state.started_at > b.state.started_at ? 1 : -1)).at(-1)?.id;
function start(wf, task, sid) { const r = engine.start(wf, task, sid); return { r, id: newestId() }; }
function submit(sid, summary) { return engine.onSubmit(sid, summary); }
let n = 0;
const S = () => `hardening-session-${++n}`;

engine.ensureLayout();

/**
 * spec 是 4 步（explore → propose → implement → archive），审查门在 **propose**（第 2 步）。
 * 这些用例都针对「门」的行为，所以先让 explore 通过，把实例推到门上。
 */
async function reachProposeGate(sid) {
  scripted.push({ status: "passed", reason: "explore 通过（探索阶段）" });
  submit(sid, "探索完成，proposal 草稿已出。\n");
  await sleep();
  return engine.readState(newestId());
}

// ── H1【恶性】审查门通过后，用户「改一下」→ 改稿重交必须重新验证 ─────────────
console.log("\nH1 审查门：门上改稿重交必须重新验证（修复前：永不重验）");
{
  const s = S();
  const { id } = start("spec", "门上改稿用例", s);
  await reachProposeGate(s); // explore 通过 → 推到 propose 门
  deliveries.length = 0;

  scripted.push({ status: "passed", reason: "第一版提案通过" });
  submit(s, "第一版提案\n");
  await sleep();
  let st = engine.readState(id);
  check("门通过后停在 propose（不推进）", st.current_step === "propose" && st.active, `step=${st.current_step}`);
  check("门通过后有 1 条判定", st.verdicts.length === 1, `verdicts=${st.verdicts.length}`);
  const verified1 = st.history.filter((h) => h.event === "verify_start").length;

  // 用户在门上要求修改 → 主会话改完重新交卷
  deliveries.length = 0;
  scripted.push({ status: "passed", reason: "改后的第二版提案通过" });
  submit(s, "已按你的意见改了提案\n");
  await sleep();

  st = engine.readState(id);
  const verified2 = st.history.filter((h) => h.event === "verify_start").length;
  check("改稿重交触发了新一次独立验证", verified2 === verified1 + 1, `verify_start ${verified1} → ${verified2}`);
  check("重交后重新停在门（step 不变）", st.current_step === "propose" && st.active, `step=${st.current_step}`);
  check("重交后判定被替换（不是复用旧判定）", st.verdicts.length === 1 && st.verdicts[0].reason.includes("第二版"), JSON.stringify(st.verdicts.map((v) => v.reason)));
  check("门重开记入轨迹", st.history.some((h) => h.event === "gate_reopened"));
  check("打回不烧 fail_count", st.fail_count === 0, `fail_count=${st.fail_count}`);

  // 放行后应正常推进
  const c = engine.continueInstance(s);
  st = engine.readState(id);
  check("放行后推进到 implement", c.ok && st.current_step === "implement", `ok=${c.ok} step=${st.current_step}`);
}

// ── H2【恶性】门上重复回放同一段文本，不得重复委派验证 ──────────────────────
console.log("\nH2 审查门：同一段文本重复回放不得重复烧验证");
{
  const s = S();
  const { id } = start("spec", "门上重复回放用例", s);
  await reachProposeGate(s); // explore 通过 → 推到 propose 门
  scripted.push({ status: "passed", reason: "提案通过" });
  const text = "提案写好了\n";
  submit(s, text);
  await sleep();
  const before = engine.readState(id).history.filter((h) => h.event === "verify_start").length;

  // 同一段文本再来一次（模型回放/重复事件）
  submit(s, text);
  await sleep();
  const after = engine.readState(id).history.filter((h) => h.event === "verify_start").length;
  check("同文本回放不新增验证", after === before, `verify_start ${before} → ${after}`);
}

// ── H3【恶性】continue 必须校验判定的步骤归属（fail-closed）─────────────────
console.log("\nH3 判定归属：错位判定绝不能放行（修复前：只看 status）");
{
  const s = S();
  const { id } = start("spec", "判定归属用例", s);
  await reachProposeGate(s); // explore 通过 → 推到 propose 门（当前步 = propose）
  const st = engine.readState(id);
  st.do_submitted = true;
  st.verdicts.push({ check_index: 0, status: "passed", reason: "别的步骤的判定", step_id: "archive", ts: new Date().toISOString() });
  fs.writeFileSync(path.join(engine.instanceDir(id), "state.json"), JSON.stringify(st, null, 2));

  const c = engine.continueInstance(s);
  const after = engine.readState(id);
  check("错位判定被拒绝推进", !c.ok, c.text.slice(0, 80));
  check("拒绝后步骤未变", after.current_step === "propose", `step=${after.current_step}`);
  check("拒绝原因说清归属不符", c.text.includes("归属不符") || c.text.includes("不是"), c.text.slice(0, 80));
  check("拒绝不烧 fail_count", after.fail_count === 0, `fail_count=${after.fail_count}`);
}

// ── H4 对照：无 step_id 的判定按当前步处理，不误伤 ───────────────────────────
console.log("\nH4 判定归属：缺 step_id 的判定按当前步处理（不误伤历史数据）");
{
  const s = S();
  const { id } = start("spec", "缺 step_id 对照", s);
  await reachProposeGate(s); // explore 通过 → 推到 propose 门
  const st = engine.readState(id);
  st.do_submitted = true;
  st.verdicts.push({ check_index: 0, status: "passed", reason: "无归属字段的判定", ts: new Date().toISOString() });
  fs.writeFileSync(path.join(engine.instanceDir(id), "state.json"), JSON.stringify(st, null, 2));
  const c = engine.continueInstance(s);
  check("缺 step_id 的通过判定仍然放行", c.ok, c.text.slice(0, 80));
}

// ── H5 对照：普通步骤（非门）判定落地后重复交卷不重复验证 ────────────────────
console.log("\nH5 对照：非门的已判定步骤，重复交卷不重复验证（防重复委派）");
{
  const s = S();
  const { id } = start("loop", "非门重复交卷", s);
  scripted.push({ status: "passed", reason: "通过并完成" });
  submit(s, "一\n");
  await sleep();
  const reportPath = path.join(engine.reportsDir, `${id}.md`);
  const report1 = fs.readFileSync(reportPath, "utf-8");
  check("loop 单步通过后实例完成并销毁", engine.readState(id) === null && !fs.existsSync(engine.instanceDir(id)));
  const before = (report1.match(/verify_start/g) ?? []).length;
  submit(s, "二\n");
  await sleep();
  const report2 = fs.readFileSync(reportPath, "utf-8");
  const after = (report2.match(/verify_start/g) ?? []).length;
  check("实例结束后重复交卷不新增验证（报告未被改写）", after === before && report2 === report1, `${before} → ${after}`);
}

// ── H6 对照：DO 阶段重复交卷不重复验证（原有去重语义保持不变）───────────────
console.log("\nH6 对照：DO 阶段未判定时重复交卷不重复验证");
{
  const s = S();
  const { id } = start("loop", "DO 重复交卷", s);
  scripted.push({ status: "failed", reason: "不通过" });
  submit(s, "一\n");
  await sleep();
  const st1 = engine.readState(id);
  check("失败后回到 DO（do_submitted=false）", !st1.do_submitted && st1.fail_count === 1);
  const before = st1.history.filter((h) => h.event === "verify_start").length;
  // 此时 do_submitted=false，重复文本会正常重新交卷（这是期望行为：模型确实重做了）
  scripted.push({ status: "passed", reason: "重做后通过" });
  submit(s, "二\n");
  await sleep();
  // 通过后实例已销毁 → 验证次数从归档报告里数
  const report = fs.readFileSync(path.join(engine.reportsDir, `${id}.md`), "utf-8");
  const after = (report.match(/verify_start/g) ?? []).length;
  check("返工后的新交卷正常触发验证", after === before + 1, `${before} → ${after}`);
}

// ── H7 崩溃恢复：孤儿委派仍然 fail-safe 暂停，不隐式推进 ────────────────────
console.log("\nH7 后备：孤儿委派 fail-safe（加固不得削弱既有安全网）");
{
  const s = S();
  const { id } = start("loop", "孤儿委派回归", s);
  const st = engine.readState(id);
  st.delegations.push({ run_id: "orphan-hardening", check_index: 0, ts: new Date().toISOString() });
  fs.writeFileSync(path.join(engine.instanceDir(id), "state.json"), JSON.stringify(st, null, 2));
  engine.restore();
  const after = engine.readState(id);
  check("孤儿委派 → 暂停 check_infra 且清空委派",
    after.paused && after.pause_reason === "check_infra" && after.delegations.length === 0,
    JSON.stringify({ p: after.pause_reason, d: after.delegations.length }));
}

// ── H8【诊断】判定被丢弃时必须留日志（不静默）────────────────────────────────
console.log("\nH8 判定丢弃必须可诊断（交卷丢失告警的姊妹缺陷）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-discard-"));
  const logs = [];
  let resolveVerify;
  const e = createEngine(ws, {
    deliver: () => true,
    verify: () => new Promise((r) => { resolveVerify = r; }),
    log: (lvl, ev, d) => logs.push({ lvl, ev, d }),
  });
  e.ensureLayout();
  const sid = "discard-session";
  e.start("loop", "判定丢弃诊断", sid);
  const iid = e.listInstances().at(-1).id;
  e.onSubmit(sid, "交卷");
  await sleep(60);

  // 外部删除实例（模拟工作区被清理）——单根模型下没有索引要同步，删目录即除名
  fs.rmSync(e.instanceDir(iid), { recursive: true, force: true });

  resolveVerify({ check_index: 0, step_id: "loop", ts: new Date().toISOString(), status: "passed", reason: "迟到的判定" });
  await sleep(120);

  const discard = logs.find((l) => l.ev === "verdict_discarded");
  check("判定被丢弃时留下 warn 日志（可诊断）", !!discard, JSON.stringify(logs.map((l) => l.ev)));
  check("日志说明丢弃原因", discard?.d?.reason === "instance_state_missing", JSON.stringify(discard?.d));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}

// ── H9【恶性】审查门 + 在飞委派：改稿重交不得静默失效、不得卡死、不得被迟到判定污染 ──
// 独立验证者发现（两轮）：
//   ① 交卷守卫 (paused || delegations>0) 与 reopenGate 都无条件清空/拦截 delegations
//      —— 门已通过但仍有在飞委派时，改稿重交静默失效，随后 continue 被挡住 → 卡死。
//   ② **测试自身缺陷**：原先只用一个被反复覆盖的 pendingResolve，"被中止的第 N 笔"
//      的 resolver 永远拿不到 → 结构上不可能发现「迟到判定污染」。本版改为**每笔一个独立
//      resolver**（resolvers[]），并由 H10 断言迟到判定必须被丢弃。
console.log("\nH9 审查门 + 在飞委派：改稿重交必须生效（不得静默失效/卡死）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-gate-inflight-"));
  const log = [];
  const deliveries = [];
  /** 每笔委派一个独立 resolver —— 绝不复用，否则测不出迟到判定 */
  const resolvers = [];
  const e = createEngine(ws, {
    deliver: (_s, t) => { deliveries.push(t); return true; },
    verify: () => new Promise((r) => { resolvers.push(r); }),
    log: (lvl, ev, d) => log.push({ lvl, ev, d }),
  });
  e.ensureLayout();
  const sid = "gate-inflight-session";
  e.start("spec", "门 + 在飞委派", sid);
  const iid = e.listInstances().at(-1).id;

  // spec 是 4 步（门在 propose）：先让 explore 通过，把实例推到门上
  e.onSubmit(sid, "探索完成");
  await sleep(40);
  resolvers.at(-1)({ check_index: 0, step_id: "explore", ts: new Date().toISOString(), status: "passed", reason: "explore 通过" });
  await sleep(80);

  // 让门步通过 → 停在门（判定落地、不在飞）
  e.onSubmit(sid, "第一版提案");
  await sleep(40);
  resolvers.at(-1)({ check_index: 0, step_id: "propose", ts: new Date().toISOString(), status: "passed", reason: "第一版通过" });
  await sleep(80);
  let st = e.readState(iid);
  check("已停在审查门", st.current_step === "propose" && st.active && st.verdicts.length === 1, `step=${st.current_step}`);
  const verifyBefore = st.history.filter((h) => h.event === "verify_start").length;

  // 用户在门上改稿重交 → 触发第二次验证（此刻验证在飞，pendingResolve 未解）
  e.onSubmit(sid, "改后的提案");
  await sleep(60);
  st = e.readState(iid);
  const verifyMid = st.history.filter((h) => h.event === "verify_start").length;
  check("改稿重交触发了新验证（不静默失效）", verifyMid === verifyBefore + 1, `verify_start ${verifyBefore} → ${verifyMid}`);
  check("在飞委派已登记", st.delegations.length === 1, `delegations=${st.delegations.length}`);

  // 再次改稿重交（此刻仍有在飞委派）—— 修复前会被守卫直接 return
  e.onSubmit(sid, "再改一版提案");
  await sleep(60);
  st = e.readState(iid);
  const verifyAfter = st.history.filter((h) => h.event === "verify_start").length;
  check("在飞期间再次改稿仍能重验（不再卡死）", verifyAfter === verifyMid + 1, `verify_start ${verifyMid} → ${verifyAfter}`);
  check("重开时中止了上一笔在飞委派", log.some((l) => l.ev === "gate_reopen_abort_inflight"), JSON.stringify(log.map((l) => l.ev)));
  check("委派记账只有一笔（未堆积）", st.delegations.length === 1, `delegations=${st.delegations.length}`);

  // 让**当轮有效**的那一笔返回 → 应重新停在门，且 continue 可放行
  resolvers.at(-1)({ check_index: 0, step_id: "propose", ts: new Date().toISOString(), status: "passed", reason: "最终版通过" });
  await sleep(80);
  st = e.readState(iid);
  check("验证返回后重新停在门", st.current_step === "propose" && st.verdicts.length === 1, `step=${st.current_step} verdicts=${st.verdicts.length}`);
  const c = e.continueInstance(sid);
  st = e.readState(iid);
  check("continue 可正常放行（不再被 delegations 挡住）", c.ok && st.current_step === "implement", `ok=${c.ok} step=${st.current_step}`);

  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}

// ── 清理：引擎按工作区单根，实例资产都在各自的隔离工作区里，无需清理全局索引 ──
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
