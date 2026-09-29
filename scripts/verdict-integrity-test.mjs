/**
 * 判定完整性 / 失败计数 / on_fail 回归（独立验证者判定 V1–V6 的修复断言）。
 *
 * 背景：上一轮我交卷声称「门+在飞委派」已修，但 H9 用单个被覆盖的 resolver，
 * **结构上不可能**发现「被中止委派的迟到判定污染当轮判定」。本文件用**每笔独立 resolver**
 * 复现该场景并断言修复。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });


let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);
const sidOf = (n) => `${n}-${RUN}`;
const clean = (ws) => {
  // 引擎已按工作区单根：实例资产都在各自的隔离工作区里，没有全局索引要清理
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
};
/** 每笔委派一个独立 resolver */
const mkPending = (ws, logRef) => {
  const resolvers = [];
  const notes = [];
  const e = createEngine(ws, {
    deliver: (_s, t) => { notes.push(t); return true; },
    verify: () => new Promise((r) => { resolvers.push(r); }),
    log: (lvl, ev, d) => { if (logRef) logRef.push({ lvl, ev, d }); },
  });
  e.ensureLayout();
  return { e, resolvers, notes };
};

// ── V1【恶性】被中止委派的迟到 infra 不得污染当轮判定 ────────────────────────
console.log("V1 迟到判定（run 已被取代）：必须丢弃，不得产生假 check_infra、不得吞掉有效判定");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v1-"));
  const log = [];
  const { e, resolvers, notes } = mkPending(ws, log);
  const sid = sidOf("v1");
  e.start("spec", "V1 迟到判定", sid);
  const iid = e.listInstances().at(-1).id;

  // spec 是 4 步（explore → propose → implement → archive），审查门在 propose（第 2 步）。
  // 先让 explore 通过，把实例推到门上——本用例针对的是门上的判定归属。
  e.onSubmit(sid, "探索完成");
  await sleep();
  resolvers[0]({ check_index: 0, step_id: "explore", ts: new Date().toISOString(), status: "passed", reason: "explore 通过" });
  await sleep();

  e.onSubmit(sid, "v1 提案");
  await sleep();
  resolvers[1]({ check_index: 0, step_id: "propose", ts: new Date().toISOString(), status: "passed", reason: "第一版通过" });
  await sleep();
  check("① 停在门", e.readState(iid).verdicts.length === 1 && !e.readState(iid).paused);

  // 第二次交卷 → 第二笔委派在飞
  e.onSubmit(sid, "v2 提案");
  await sleep();
  // 第二笔在飞时再次交卷 → reopenGate 中止第二笔 → 第三笔
  e.onSubmit(sid, "v3 提案");
  await sleep();
  check("② 三次交卷三笔委派（+1 笔 explore）", resolvers.length === 4, `n=${resolvers.length}`);

  // 被中止的第二笔「正常 resolve」成 infra（真实 dsh driver 的 aborted 路径）
  resolvers[2]({ check_index: 0, step_id: "propose", ts: new Date().toISOString(), status: "infra", reason: "验证已中止" });
  await sleep();
  let st = e.readState(iid);
  check("③ 迟到 infra 被丢弃（未暂停、未落判定）", !st.paused && st.verdicts.length === 0, JSON.stringify({ p: st.paused, v: st.verdicts.map((x) => x.status) }));
  check("③ 丢弃留下可诊断日志（reason=run_superseded）",
    log.some((l) => l.ev === "verdict_discarded" && l.d?.reason === "run_superseded"), JSON.stringify(log.filter((l) => l.ev === "verdict_discarded")));
  check("③ 未发出假 check_infra 告警", !notes.some((t) => t.includes("验证未跑成")), notes.at(-1)?.slice(0, 40));

  // 第三笔（当轮有效）返回 passed
  resolvers[3]({ check_index: 0, step_id: "propose", ts: new Date().toISOString(), status: "passed", reason: "最终版通过" });
  await sleep();
  st = e.readState(iid);
  check("④ 有效判定正常落地且门打开", !st.paused && st.verdicts.length === 1 && st.verdicts[0].status === "passed",
    JSON.stringify({ p: st.paused, v: st.verdicts.map((x) => x.status) }));
  const c = e.continueInstance(sid);
  st = e.readState(iid);
  check("⑤ continue 正常放行（不再退化为「恢复暂停」）", c.ok && st.current_step === "implement", `ok=${c.ok} step=${st.current_step}`);
  clean(ws);
}

// ── V2【恶性】暂停中的迟到判定不得推进（模型否则白干）────────────────────────
console.log("\nV2 暂停中的迟到判定：必须丢弃，不得推进/投递 DO 提示");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v2-"));
  const log = [];
  const { e, resolvers, notes } = mkPending(ws, log);
  const sid = sidOf("v2");
  e.start("loop", "V2 暂停中迟到判定", sid);
  const iid = e.listInstances().at(-1).id;
  e.onSubmit(sid, "交卷");
  await sleep();

  // 模拟 restore() 孤儿恢复：暂停并清记账（但验证者其实还在飞）
  const st0 = e.readState(iid);
  st0.paused = true; st0.pause_reason = "check_infra"; st0.delegations = [];
  fs.writeFileSync(path.join(e.instanceDir(iid), "state.json"), JSON.stringify(st0, null, 2));
  notes.length = 0;

  resolvers[0]({ check_index: 0, step_id: "loop", ts: new Date().toISOString(), status: "passed", reason: "迟到的通过" });
  await sleep();
  const st = e.readState(iid);
  check("① 仍处于暂停（未被迟到判定推进）", st.paused && st.active, JSON.stringify({ p: st.paused, a: st.active }));
  check("② 未投递 DO 提示（模型不会白干）", !notes.some((t) => t.includes("本步要做什么")), notes.at(-1)?.slice(0, 50));
  check("② 丢弃原因标注 instance_paused",
    log.some((l) => l.ev === "verdict_discarded" && l.d?.reason === "instance_paused"), JSON.stringify(log.filter((l) => l.ev === "verdict_discarded")));
  clean(ws);
}

// ── V3 fail_count 为每步失败轮数（换步清零）─────────────────────────────────
console.log("\nV3 fail_count：换步必须清零（每步 max_fail_count 语义）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v3-"));
  const sc = [];
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...sc.shift() }),
    log: () => {},
  });
  e.ensureLayout();
  fs.writeFileSync(path.join(e.workflowsDir, "twostep.yaml"), [
    "description: 两步", "steps:",
    "  - id: a", "    do: A", "    check: ca", "    on_pass: b", "    on_fail: a", "    max_fail_count: 3",
    "  - id: b", "    do: B", "    check: cb", "    on_pass: done", "    on_fail: b", "    max_fail_count: 3",
  ].join("\n"));
  const sid = sidOf("v3");
  e.start("twostep", "V3 失败计数", sid);
  const iid = e.listInstances().at(-1).id;

  sc.push({ status: "failed", reason: "a 失败 1 次" });
  e.onSubmit(sid, "a1"); await sleep();
  check("① a 失败 1 次 → fail_count=1", e.readState(iid).fail_count === 1);
  sc.push({ status: "passed", reason: "a 通过" });
  e.onSubmit(sid, "a2"); await sleep();
  let st = e.readState(iid);
  check("② a 通过换到 b → fail_count 清零", st.current_step === "b" && st.fail_count === 0, `step=${st.current_step} fc=${st.fail_count}`);

  sc.push({ status: "failed", reason: "b 失败 1 次" });
  e.onSubmit(sid, "b1"); await sleep();
  sc.push({ status: "failed", reason: "b 失败 2 次" });
  e.onSubmit(sid, "b2"); await sleep();
  st = e.readState(iid);
  check("③ b 失败 2 次 → fail_count=2 且**未**暂停（上限 3）", st.fail_count === 2 && !st.paused, `fc=${st.fail_count} paused=${st.paused}`);

  sc.push({ status: "failed", reason: "b 失败 3 次" });
  e.onSubmit(sid, "b3"); await sleep();
  st = e.readState(iid);
  check("④ b 失败 3 次 → 达上限暂停 max_failures", st.paused && st.pause_reason === "max_failures" && st.fail_count === 3,
    JSON.stringify({ p: st.paused, r: st.pause_reason, fc: st.fail_count }));
  clean(ws);
}

// ── V4 continue 解除暂停必须重置失败计数（tools.ts 对模型的承诺）─────────────
console.log("\nV4 continue 恢复：必须重置失败计数（否则修好后一失败就又暂停）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v4-"));
  const sc = [];
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...sc.shift() }),
    log: () => {},
  });
  e.ensureLayout();
  fs.writeFileSync(path.join(e.workflowsDir, "one.yaml"), [
    "description: 单步上限 2", "steps:",
    "  - id: s", "    do: S", "    check: cs", "    on_pass: done", "    on_fail: s", "    max_fail_count: 2",
  ].join("\n"));
  const sid = sidOf("v4");
  e.start("one", "V4 恢复重置", sid);
  const iid = e.listInstances().at(-1).id;
  sc.push({ status: "failed", reason: "f1" }); e.onSubmit(sid, "1"); await sleep();
  sc.push({ status: "failed", reason: "f2" }); e.onSubmit(sid, "2"); await sleep();
  let st = e.readState(iid);
  check("① 达上限暂停", st.paused && st.pause_reason === "max_failures" && st.fail_count === 2, JSON.stringify({ p: st.paused, fc: st.fail_count }));

  // 注意：max_failures 暂停时 do_submitted 仍为 true，故 continue 会**重新委派**验证者
  // —— 先备好这一笔的判定，否则验证端口会拿到空队列。
  sc.push({ status: "failed", reason: "f3（恢复后的验证失败）" });
  const c = e.continueInstance(sid);
  await sleep();
  st = e.readState(iid);
  check("② continue 后已解除暂停", !st.paused && c.ok, JSON.stringify({ p: st.paused }));
  check("③ 恢复后失败一次 → 计数从 0 起算（拿到完整重试机会）", st.fail_count === 1 && !st.paused,
    JSON.stringify({ p: st.paused, fc: st.fail_count }));
  check("③ history 记录 resume", st.history.some((h) => h.event === "resume"), st.history.map((h) => h.event).join("→"));
  clean(ws);
}

// ── V5 on_fail 必须真的被使用（design §4「按 on_fail 回退」）─────────────────
console.log("\nV5 on_fail：失败必须回退到 on_fail 指定的步骤");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v5-"));
  const sc = [];
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...sc.shift() }),
    log: () => {},
  });
  e.ensureLayout();
  fs.writeFileSync(path.join(e.workflowsDir, "gap.yaml"), [
    "description: on_fail 回退", "steps:",
    "  - id: a", "    do: A", "    check: ca", "    on_pass: b", "    on_fail: a", "    max_fail_count: 5",
    "  - id: b", "    do: B", "    check: cb", "    on_pass: c", "    on_fail: a", "    max_fail_count: 5",
    "  - id: c", "    do: C", "    check: cc", "    on_pass: done", "    on_fail: c", "    max_fail_count: 5",
  ].join("\n"));
  const sid = sidOf("v5");
  e.start("gap", "V5 on_fail", sid);
  const iid = e.listInstances().at(-1).id;
  sc.push({ status: "passed", reason: "a 通过" }); e.onSubmit(sid, "a"); await sleep();
  check("① 推进到 b", e.readState(iid).current_step === "b");

  sc.push({ status: "failed", reason: "b 失败；on_fail=a 应回退" }); e.onSubmit(sid, "b"); await sleep();
  const st = e.readState(iid);
  check("② 失败后回退到 on_fail 指定的 a", st.current_step === "a", `step=${st.current_step}`);
  check("② 回退记入轨迹", st.history.some((h) => h.event === "rework_rewind"), st.history.map((h) => h.event).join("→"));

  // on_fail 指自身时不得换步
  sc.push({ status: "failed", reason: "a 失败；on_fail=a 自身" }); e.onSubmit(sid, "a2"); await sleep();
  check("③ on_fail 指自身时停留在原步骤", e.readState(iid).current_step === "a", `step=${e.readState(iid).current_step}`);
  clean(ws);
}

// ── V6 on_fail: done 是坏定义（fail-fast 说人话）─────────────────────────────
console.log("\nV6 on_fail: done 非法 → 加载期 fail-fast");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v6-"));
  const e = createEngine(ws, { deliver: () => true, verify: async () => ({ status: "infra", reason: "x", check_index: 0, step_id: "s", ts: "" }), log: () => {} });
  e.ensureLayout();
  fs.writeFileSync(path.join(e.workflowsDir, "bad.yaml"), [
    "description: on_fail done 非法", "steps:",
    "  - id: s", "    do: S", "    check: cs", "    on_pass: done", "    on_fail: done", "    max_fail_count: 3",
  ].join("\n"));
  const r = e.loadWorkflow("bad");
  check("① 定义被判为无效", r.def === null, JSON.stringify(r.def));
  check("② 报错说清 on_fail 不允许 done", (r.problems.join(" ") || "").includes("不允许 done"), JSON.stringify(r.problems));
  const st = e.start("bad", "V6", "v6");
  check("③ 启动被拒绝（不会跑坏定义）", !st.ok, st.text.slice(0, 60));
  clean(ws);
}

// ── V7【残留 1】on_fail 跨步回退：不得把前一步的失败算到被回退的步骤头上 ──────
// 独立验证者发现：advance 清了 fail_count、回退路径没清 → b 失败回退到 a 后，
// a 自己第一次失败即 fail_count=2 → 提前 max_failures。内置 spec.yaml 正是跨步回退。
// 修复：改为**按步计数**（fail_counts）。本用例同时验证两个方向：
//   ① 不串味：b 的失败不抬高 a 的计数；
//   ② 仍有界：b 的计数跨回退累积，成环的 on_fail 仍能触及 max_fail_count。
console.log("\nV7 on_fail 跨步回退：按步计数（不串味 + 成环仍有界）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v7-"));
  const sc = [];
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...sc.shift() }),
    log: () => {},
  });
  e.ensureLayout();
  fs.writeFileSync(path.join(e.workflowsDir, "spec-ish.yaml"), [
    "description: 跨步回退（仿 spec）", "steps:",
    "  - id: a", "    do: A", "    check: ca", "    on_pass: b", "    on_fail: a", "    max_fail_count: 3",
    "  - id: b", "    do: B", "    check: cb", "    on_pass: c", "    on_fail: a", "    max_fail_count: 2",
    "  - id: c", "    do: C", "    check: cc", "    on_pass: done", "    on_fail: c", "    max_fail_count: 3",
  ].join("\n"));
  const sid = sidOf("v7");
  e.start("spec-ish", "V7 跨步回退", sid);
  const iid = e.listInstances().at(-1).id;
  const counts = () => e.readState(iid).fail_counts;

  sc.push({ status: "passed", reason: "a 通过" }); e.onSubmit(sid, "a1"); await sleep();
  check("① a 通过 → 推进到 b", e.readState(iid).current_step === "b", `step=${e.readState(iid).current_step}`);

  sc.push({ status: "failed", reason: "b 失败 → on_fail=a 回退" }); e.onSubmit(sid, "b1"); await sleep();
  let st = e.readState(iid);
  check("② b 失败 1 次 → 回退到 a", st.current_step === "a", `step=${st.current_step}`);
  check("② b 的计数记为 1", counts().b === 1, JSON.stringify(counts()));

  sc.push({ status: "failed", reason: "a 自己第一次失败" }); e.onSubmit(sid, "a2"); await sleep();
  st = e.readState(iid);
  check("③ a 自己第一次失败 → a 计数为 1（**未**继承 b 的 1）", counts().a === 1, JSON.stringify(counts()));
  check("③ 未提前暂停（a 上限 3）", !st.paused, `paused=${st.paused} fc=${st.fail_count}`);
  check("③ 展示用 fail_count 等于当前步计数", st.fail_count === 1, `fc=${st.fail_count}`);

  sc.push({ status: "passed", reason: "a 通过 → 回 b" }); e.onSubmit(sid, "a3"); await sleep();
  st = e.readState(iid);
  check("④ a 通过后清零 a 的计数", counts().a === 0, JSON.stringify(counts()));
  check("④ b 的计数跨回退保留（仍有界）", counts().b === 1, JSON.stringify(counts()));
  check("④ 回到 b", st.current_step === "b", `step=${st.current_step}`);

  sc.push({ status: "failed", reason: "b 第 2 次失败（达上限 2）" }); e.onSubmit(sid, "b2"); await sleep();
  st = e.readState(iid);
  check("⑤ b 累计到 2 → 达上限暂停 max_failures（成环仍有界）",
    st.paused && st.pause_reason === "max_failures" && counts().b === 2, JSON.stringify({ p: st.paused, r: st.pause_reason, c: counts() }));
  clean(ws);
}

// ── V8 state.json 兼容与「派生量不落盘」────────────────────────────────────────
console.log("\nV8 state.json：老格式可读（迁移）+ 派生量不落盘（宪法 §10.4）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v8-"));
  const sc = [];
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...sc.shift() }),
    log: () => {},
  });
  e.ensureLayout();
  const sid = sidOf("v8");
  e.start("loop", "V8 迁移", sid);
  const iid = e.listInstances().at(-1).id;

  // ① 老格式：只有标量 fail_count，无 fail_counts
  const raw = JSON.parse(fs.readFileSync(path.join(e.instanceDir(iid), "state.json"), "utf-8"));
  delete raw.fail_counts;
  raw.fail_count = 2;
  raw.current_step = "loop";
  fs.writeFileSync(path.join(e.instanceDir(iid), "state.json"), JSON.stringify(raw, null, 2));
  const migrated = e.readState(iid);
  check("① 老格式可读：fail_count 迁移进 fail_counts", migrated.fail_count === 2 && migrated.fail_counts.loop === 2,
    JSON.stringify({ fc: migrated.fail_count, counts: migrated.fail_counts }));

  // ② 触发一次写盘，确认落盘的 JSON 里没有派生量 fail_count
  sc.push({ status: "failed", reason: "写盘一次" });
  e.onSubmit(sid, "v8 交卷");
  await sleep();
  const persisted = JSON.parse(fs.readFileSync(path.join(e.instanceDir(iid), "state.json"), "utf-8"));
  check("② 落盘不含派生量 fail_count", !("fail_count" in persisted), Object.keys(persisted).join(","));
  check("② 落盘含原始事实 fail_counts", persisted.fail_counts && persisted.fail_counts.loop === 3, JSON.stringify(persisted.fail_counts));
  check("② 读取时按 fail_counts 重算 fail_count", e.readState(iid).fail_count === 3, `fc=${e.readState(iid).fail_count}`);
  clean(ws);
}

// ── V9【§12.1 精修】推进判据的两支：定义未声明免验证 → 无判定一律拒；已声明 → 免判定推进 ──
// 攻击向量「无判定且定义未声明免验证时的推进」必须仍被拒（**不放宽**）；
// 正向：`stepHasCheck(step) === false`（工作流定义声明本步免验证）时推进不需要判定，
//       且**不产生 verdicts[] 条目**——判据只读 StepDef，执行者在运行期无法影响。
console.log("\nV9 推进判据（§12.1 精修）：有 check 无判定绝不推进；无 check = 定义声明免验证");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-v9-"));
  const log = [];
  const { e, resolvers, notes } = mkPending(ws, log);
  fs.writeFileSync(path.join(e.workflowsDir, "mixed.yaml"), [
    "description: 有 check 步 + 无 check 步", "steps:",
    "  - id: a", "    do: A", "    check: ca", "    on_pass: b", "    on_fail: a", "    max_fail_count: 3",
    "  - id: b", "    do: B", "    on_pass: done", "    on_fail: b", "    max_fail_count: 3",
  ].join("\n"));
  const sid = sidOf("v9");
  e.start("mixed", "V9 推进判据", sid);
  const iid = e.listInstances().at(-1).id;
  const stateFile = path.join(e.instanceDir(iid), "state.json");
  const stepNow = () => e.readState(iid)?.current_step;

  // ① 定义未声明免验证（a 有 check）+ 未交卷 → 推进被拒（fail-closed，一字不放宽）
  const c1 = e.continueInstance(sid);
  check("① 有 check 且未交卷 → 推进被拒", !c1.ok && c1.text.includes("还没交卷") && !c1.text.includes("跳过"), c1.text);
  check("① 步骤未动", stepNow() === "a", `step=${stepNow()}`);

  // ② 有 check + 验证在飞（无判定）→ 不推进
  e.onSubmit(sid, "a 交卷");
  await sleep();
  const c2 = e.continueInstance(sid);
  check("② 验证在飞（无判定）→ 不推进", !c2.ok && stepNow() === "a", `ok=${c2.ok} step=${stepNow()}`);

  // ③ 模拟「判定丢失」（崩溃恢复清了记账）：无判定 + 定义未声明免验证 → 重新取证，绝不放行
  const lost = e.readState(iid);
  lost.delegations = [];
  fs.writeFileSync(stateFile, JSON.stringify(lost, null, 2));
  const c3 = e.continueInstance(sid);
  await sleep();
  check("③ 无判定且定义未声明免验证 → 不推进（改为重新委派取证）",
    c3.ok && stepNow() === "a" && resolvers.length === 2, `ok=${c3.ok} step=${stepNow()} n=${resolvers.length}`);

  // ④ a 的判定（第二笔）通过 → 才推进到 b；advance 清空 verdicts[]
  resolvers[1]({ check_index: 0, step_id: "a", ts: new Date().toISOString(), status: "passed", reason: "a 通过" });
  await sleep();
  check("④ 判定齐且全 passed → 推进到 b", stepNow() === "b", `step=${stepNow()}`);
  check("④ 换步后 verdicts[] 已清空（b 不继承 a 的判定）", e.readState(iid).verdicts.length === 0);

  // ⑤ 正向：b 无 check（定义已声明免验证）→ **不需要判定**即可推进，且不产生 verdicts[]
  const callsBefore = resolvers.length;
  notes.length = 0;
  const c4 = e.continueInstance(sid);
  await sleep();
  check("⑤ 定义声明免验证 → 无判定即可推进（实例完成销毁）", c4.ok && e.readState(iid) === null, `ok=${c4.ok}`);
  check("⑤ 该步验证端口零调用（定义声明免验证 ⇒ 不委派验证者）", resolvers.length === callsBefore, `n=${resolvers.length - callsBefore}`);
  check("⑤ 放行回执写明「跳过对抗性验证」", c4.text.includes("跳过对抗性验证"), c4.text);
  const report = fs.readFileSync(path.join(e.reportsDir, `${iid}.md`), "utf-8");
  check("⑤ 报告有 check_skipped（b）且**无**任何 b 的判定条目",
    report.includes("check_skipped") && report.includes("（无判定记录）"), report.slice(0, 700));
  check("⑤ 报告不出现「检查通过」", !report.includes("检查通过"), report.slice(0, 700));
  clean(ws);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
