/**
 * 引擎级裁判权测试（无宿主依赖）：直接驱动 lib/engine.js，脚本化验证者端口。
 * 引擎约束：每会话最多一个活跃实例（与 claude 版一致）——每个用例用独立会话隔离。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-test-"));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, 30));
const newestId = () => engine.listInstances().sort((a, b) => (a.state.started_at > b.state.started_at ? 1 : -1)).at(-1)?.id;
function start(wf, task, sid) { const r = engine.start(wf, task, sid); return { r, id: newestId() }; }
function submit(id, text, sid) { engine.onAssistantMessage(sid, text); }
const settle = () => sleep(30);

engine.ensureLayout();
let n = 0;
const S = () => `session-${++n}`;

// ── 1) 加载 + 启动 + 通过完成 ────────────────────────────────────────────────
{
  const s = S();
  const wfs = engine.listWorkflows();
  check("内置 loop/spec 可加载", wfs.length >= 2 && wfs.every((w) => !w.invalid), JSON.stringify(wfs.map((w) => w.name)));
  const { r, id } = start("loop", "写一个 hello.html", s);
  check("start 成功且 DO prompt 完整", r.ok && r.text.includes("写一个 hello.html") && r.text.includes("<promise>done</promise>"));
  scripted.push({ status: "passed", reason: "文件存在且内容正确" });
  submit(id, "已完成，创建了 hello.html。\n<promise>done</promise>", s);
  await settle();
  const st = engine.readState(id);
  check("通过后实例完成 + 报告归档", st && !st.active && fs.existsSync(path.join(engine.reportsDir, `${id}.md`)));
}

// ── 2) 失败 → 返工 ───────────────────────────────────────────────────────────
{
  const s = S();
  const { id } = start("loop", "会失败的脚本", s);
  deliveries.length = 0;
  scripted.push({ status: "failed", reason: "脚本语法错误" });
  submit(id, "写完了。\n<promise>done</promise>", s);
  await settle();
  const st = engine.readState(id);
  check("失败 → 回到 DO 可重交（fail_count=1）", st.active && !st.do_submitted && st.verdicts.length === 0 && st.fail_count === 1 && !st.paused);
  check("返工原因 + 交卷协议都交回主会话", deliveries.some((t) => t.includes("脚本语法错误")) && deliveries.some((t) => t.includes("<promise>done</promise>")));
}

// ── 3) infra 暂停（不烧账）→ continue 重验失败（烧一账回 DO）─────────────────
{
  const s = S();
  const { id } = start("loop", "infra 用例", s);
  scripted.push({ status: "infra", reason: "provider 不可用" });
  submit(id, "好了。\n<promise>done</promise>", s);
  await settle();
  let st = engine.readState(id);
  check("infra → 暂停 check_infra 且 fail_count=0", st.paused && st.pause_reason === "check_infra" && st.fail_count === 0, JSON.stringify({ p: st.pause_reason, f: st.fail_count }));
  scripted.push({ status: "failed", reason: "还是不行" }); // 先入队：continue 同步消费
  const c1 = engine.continueInstance(s); // 解除暂停 → 引擎同步启动重验（消费 scripted[0]）
  check("continue 解除暂停并自动重验", c1.ok);
  await settle();
  const st2 = engine.readState(id);
  check("重验失败 → fail_count=1 且回到 DO", !st2.paused && st2.fail_count === 1 && !st2.do_submitted, JSON.stringify({ p: st2.paused, f: st2.fail_count }));
}

// ── 4) 上限暂停（2 次上限专用工作流）──────────────────────────────────────────
{
  const s = S();
  fs.writeFileSync(path.join(engine.workflowsDir, "maxfail.yaml"), [
    "description: 上限暂停专用",
    "steps:",
    "  - id: a",
    "    desc: 单步",
    "    do: 干活",
    "    check: 检查",
    "    on_pass: done",
    "    on_fail: a",
    "    max_fail_count: 2",
  ].join("\n"));
  const { id } = start("maxfail", "一直被拒的任务", s);
  scripted.push({ status: "failed", reason: "第一次失败" });
  submit(id, "交卷一。\n<promise>done</promise>", s);
  await settle();
  scripted.push({ status: "failed", reason: "第二次失败" });
  submit(id, "交卷二。\n<promise>done</promise>", s);
  await settle();
  const st = engine.readState(id);
  check("达 2 次上限 → 暂停 max_failures", st.paused && st.pause_reason === "max_failures" && st.fail_count === 2, JSON.stringify({ p: st.pause_reason, f: st.fail_count }));
}

// ── 5) spec 审查门：pass 停在门，continue 才推进 ─────────────────────────────
{
  const s = S();
  const { r, id } = start("spec", "做一个用户登录模块", s);
  check("spec 启动且首步 propose", r.ok && engine.readState(id).current_step === "propose", r.text.slice(0, 100));
  deliveries.length = 0;
  scripted.push({ status: "passed", reason: "proposal.md 完备" });
  submit(id, "proposal 写好了。\n<promise>done</promise>", s);
  await settle();
  let st = engine.readState(id);
  check("pass 后停在审查门（不推进）", st.active && st.current_step === "propose" && st.verdicts.length === 1, `step=${st.current_step}`);
  check("门提示 continue", deliveries.some((t) => t.includes("审查门")), deliveries.at(-1)?.slice(0, 60));
  const c = engine.continueInstance(s);
  const after = engine.readState(id);
  check("continue 放行 → 推进到 specs", c.ok && after.current_step === "specs", `step=${after.current_step}`);
}

// ── 6) continue fail-closed ──────────────────────────────────────────────────
{
  const s = S();
  const { id } = start("loop", "fail-closed 用例", s);
  const c1 = engine.continueInstance(s);
  check("未交卷 → 拒绝推进", !c1.ok && c1.text.includes("还没交卷"), c1.text);
  scripted.push({ status: "failed", reason: "不过" });
  submit(id, "交卷。\n<promise>done</promise>", s);
  await settle();
  const c2 = engine.continueInstance(s);
  check("判定未通过后 continue 绝不推进（fail-closed）", !c2.ok && (c2.text.includes("不能推进") || c2.text.includes("还没交卷")), c2.text);
  scripted.push({ status: "passed", reason: "通过了" });
  submit(id, "修好了。\n<promise>done</promise>", s);
  await settle();
  const st = engine.readState(id);
  check("通过后推进完成", st && !st.active);
}

// ── 7) 孤儿委派恢复 ──────────────────────────────────────────────────────────
{
  const s = S();
  const { id } = start("loop", "孤儿用例", s);
  const st = engine.readState(id);
  st.delegations.push({ run_id: "orphan-x", check_index: 0, ts: new Date().toISOString() });
  fs.writeFileSync(path.join(engine.instanceDir(id), "state.json"), JSON.stringify(st, null, 2));
  engine.restore();
  const after = engine.readState(id);
  check("孤儿委派 → fail-safe 暂停 check_infra", after.paused && after.pause_reason === "check_infra" && after.delegations.length === 0);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);