/**
 * 引擎级裁判权测试（无宿主依赖）：直接驱动 lib/engine.js，脚本化验证者端口。
 * 引擎约束：每会话最多一个活跃实例（与 claude 版一致）——每个用例用独立会话隔离。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, resolveCheckModel } from "../lib/engine.js";
import { buildCheckPrompt } from "../lib/verify.js";
import { CREATE_GUIDE } from "../lib/create.js";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

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
function submit(sid, summary) { return engine.onSubmit(sid, summary); }
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
  check("start 成功且 DO prompt 完整", r.ok && r.text.includes("写一个 hello.html") && r.text.includes("ralphflow_submit"));
  scripted.push({ status: "passed", reason: "文件存在且内容正确" });
  submit(s, "已完成，创建了 hello.html。");
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
  submit(s, "写完了。");
  await settle();
  const st = engine.readState(id);
  check("失败 → 回到 DO 可重交（fail_count=1）", st.active && !st.do_submitted && st.verdicts.length === 0 && st.fail_count === 1 && !st.paused);
  check("返工原因 + 交卷协议都交回主会话", deliveries.some((t) => t.includes("脚本语法错误")) && deliveries.some((t) => t.includes("ralphflow_submit")));
}

// ── 3) infra 暂停（不烧账）→ continue 重验失败（烧一账回 DO）─────────────────
{
  const s = S();
  const { id } = start("loop", "infra 用例", s);
  scripted.push({ status: "infra", reason: "provider 不可用" });
  submit(s, "好了。");
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
  submit(s, "交卷一。");
  await settle();
  scripted.push({ status: "failed", reason: "第二次失败" });
  submit(s, "交卷二。");
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
  submit(s, "proposal 写好了。");
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
  submit(s, "交卷。");
  await settle();
  const c2 = engine.continueInstance(s);
  check("判定未通过后 continue 绝不推进（fail-closed）", !c2.ok && (c2.text.includes("不能推进") || c2.text.includes("还没交卷")), c2.text);
  scripted.push({ status: "passed", reason: "通过了" });
  submit(s, "修好了。");
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

// ── 8) 显式工作区放置：实例与报告都落在发起会话的工作区 ──────────────────────
{
  const s = S();
  const ws = path.join(dir, "ws-b");
  fs.mkdirSync(ws, { recursive: true });
  const r = engine.start("loop", "工作区用例", s, ws);
  check("显式工作区 start 成功", r.ok);
  const id = newestId();
  check("实例目录落在指定工作区", engine.instanceDir(id).startsWith(path.join(ws, ".dsh", "ralph-flow", "instances")), engine.instanceDir(id));
  check("索引可发现（listInstances 可见）", engine.listInstances().some((i) => i.id === id));
  check("内置工作流已复制到该工作区", fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "workflows", "loop.yaml")));
  // 完整一轮 + 报告归档位置跟随工作区
  scripted.push({ status: "passed", reason: "报告位置验证" });
  submit(s, "完成。");
  await settle();
  const st = engine.readState(id);
  check("跨工作区实例通过并完成", st && !st.active);
  check("报告归档在相同工作区", fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "reports", `${id}.md`)), `${ws}/.dsh/ralph-flow/reports/${id}.md`);
}

// ── 9) 加固回归：委派超时交给 dsh 原生能力，ralphflow 不自设总时长上界 ─────────
// 设计取舍（作者定案）：用宿主原生委派能力就跟随宿主，不自造超时。
// 宿主对整次子代理运行本就不设上界（subagent / in-process-driver / agent-loop 均无
// timeout 逻辑），只提供请求级防护（dsh-llm-deepseek 的 streamIdleTimeoutMs 空闲看门狗）。
// 引擎只负责把 dsh 要求的取消句柄（signal）传下去。
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-native-"));
  let sawSignal = false;
  const e2 = createEngine(dir2, {
    deliver: () => true,
    verify: async (req) => {
      sawSignal = req.signal instanceof AbortSignal;
      return { check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "passed", reason: "ok" };
    },
    log: () => {},
  });
  e2.ensureLayout();
  e2.start("loop", "原生委派契约用例", "native-session");
  e2.onSubmit("native-session", "完成");
  await sleep(40);
  check("验证端口收到 dsh 要求的取消句柄（signal）", sawSignal);
  try {
    const idxPath2 = path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json");
    const idx2 = JSON.parse(fs.readFileSync(idxPath2, "utf-8"));
    for (const k of Object.keys(idx2)) if (idx2[k] === dir2) delete idx2[k];
    fs.writeFileSync(idxPath2, JSON.stringify(idx2, null, 2));
  } catch {}
  try { fs.rmSync(dir2, { recursive: true, force: true }); } catch {}
}

// ── 10) 补全 §1.8：布局迁移到工作区 dot-dir，旧 ralph-flow/ 不再创建 ────────────
{
  const ws = path.join(dir, "ws-layout");
  fs.mkdirSync(ws, { recursive: true });
  const s = S();
  const r = engine.start("loop", "布局用例", s, ws);
  const id = newestId();
  check("start 成功（布局用例）", r.ok && r.text.includes("布局用例"));
  for (const sub of ["workflows", "instances", "reports", "artifacts"]) {
    const p = path.join(ws, ".dsh", "ralph-flow", sub);
    check(`新布局 .dsh/ralph-flow/${sub} 齐全`, fs.existsSync(p), p);
  }
  check("旧 ralph-flow/ 不再被创建", !fs.existsSync(path.join(ws, "ralph-flow")));
  // §1.7 产出目录：实例启动时建好、完成后保留；DO 提示词注入工作区相对路径
  const artDir = path.join(ws, ".dsh", "ralph-flow", "artifacts", id);
  check("每实例产出目录已建好", fs.existsSync(artDir), artDir);
  check(
    "DO 提示词含产出目录（工作区相对路径）",
    r.text.includes("## 产出目录") && r.text.includes(`.dsh/ralph-flow/artifacts/${id}/`),
    r.text.slice(-260),
  );
  scripted.push({ status: "passed", reason: "布局 ok" });
  submit(s, "布局完成。");
  await settle();
  check("完成后产出目录保留（不随实例结束删除）", fs.existsSync(artDir));
}

// ── 11) §1.1 加载期硬校验：写错了必须硬错误（静默 = 缺陷）─────────────────────
{
  const wfFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  const r1 = wfFile("bad-check-type", ["steps:", "  - id: a", "    do: X", "    check: true", "    on_pass: done", "    max_fail_count: 1"]);
  check("check 非字符串 → 硬错误", !r1.def && r1.problems.some((p) => p.includes("check")), JSON.stringify(r1.problems));

  const r2 = wfFile("bad-no-do", ["steps:", "  - id: a", "    check: c", "    on_pass: done", "    max_fail_count: 1"]);
  check("do 缺失 → 硬错误", !r2.def && r2.problems.some((p) => p.includes("do")), JSON.stringify(r2.problems));

  const r3 = wfFile("bad-manual", ["manual_step:", "  - nope", "steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    max_fail_count: 1"]);
  check("manual_step 引用不存在步骤 → 硬错误", !r3.def && r3.problems.some((p) => p.includes("manual_step")), JSON.stringify(r3.problems));

  const r4 = wfFile("bad-maxfail0", ["steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    max_fail_count: 0"]);
  check("max_fail_count: 0 → 硬错误", !r4.def && r4.problems.some((p) => p.includes("max_fail_count")), JSON.stringify(r4.problems));

  const r5 = wfFile("bad-maxfail-neg", ["steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    max_fail_count: -2"]);
  check("max_fail_count 负数 → 硬错误", !r5.def && r5.problems.some((p) => p.includes("max_fail_count")), JSON.stringify(r5.problems));

  const ok = wfFile("ok-manual-csv", [
    "manual_step: a,b", "steps:",
    "  - id: a", "    do: X", "    check: c", "    on_pass: b", "    on_fail: a", "    max_fail_count: 1",
    "  - id: b", "    do: Y", "    check: d", "    on_pass: done", "    on_fail: b", "    max_fail_count: 1",
  ]);
  check("manual_step 逗号字符串写法被接受", !!ok.def && ok.def.manual_step.join(",") === "a,b", JSON.stringify(ok.def?.manual_step));
}

// ── 11b) A1 三端资产兼容：check_model / 模型引用两形态（对齐 opencode 2.8.0）─────
{
  const wfFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  // 归一化语义（照抄 opencode resolveCheckModel）
  const norm = [
    ["deepseek/deepseek-chat", "deepseek", "deepseek-chat"],
    ["a/b/c", "a", "b/c"],
  ];
  for (const [input, pid, mid] of norm) {
    const r = resolveCheckModel(input);
    check(`resolveCheckModel 字符串 "${input}" → ${pid}/${mid}`, r?.providerID === pid && r?.modelID === mid, JSON.stringify(r));
  }
  const objR = resolveCheckModel({ providerID: " anthropic ", modelID: " claude-haiku-4-5 " });
  check("resolveCheckModel 对象形态（并 trim）", objR?.providerID === "anthropic" && objR?.modelID === "claude-haiku-4-5", JSON.stringify(objR));
  for (const bad of ["sonnet", { modelID: "x" }, { providerID: "a", modelID: "  " }, "/x", ""]) {
    check(`resolveCheckModel 解析不出 → undefined（${JSON.stringify(bad)}）`, resolveCheckModel(bad) === undefined);
  }
  // 合法形态静默通过
  const okStr = wfFile("cm-ok-str", ["steps:", "  - id: a", "    do: X", "    check: c", "    check_model: deepseek/deepseek-chat", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_model 字符串形态可加载且无告警", !!okStr.def && okStr.problems.length === 0 && okStr.warnings.length === 0, JSON.stringify(okStr));
  const okObj = wfFile("cm-ok-obj", ["steps:", "  - id: a", "    do: X", "    check: c", "    check_model:", "      providerID: anthropic", "      modelID: claude-haiku-4-5", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_model 对象形态可加载且无告警", !!okObj.def && okObj.problems.length === 0 && okObj.warnings.length === 0, JSON.stringify(okObj));
  // 硬错误（照抄 opencode：同写 check_voting、无 check）
  const noCheck = wfFile("cm-no-check", ["steps:", "  - id: a", "    do: X", "    check_model: a/b", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_model 无 check → 硬错误", !noCheck.def && noCheck.problems.some((p) => p.includes("check_model")), JSON.stringify(noCheck.problems));
  const withVoting = wfFile("cm-with-voting", ["steps:", "  - id: a", "    do: X", "    check: c", "    check_model: a/b", "    check_voting:", "      - check: c1", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_model 与 check_voting 同写 → 硬错误", !withVoting.def && withVoting.problems.some((p) => p.includes("check_model")), JSON.stringify(withVoting.problems));
  // 告警（形态合法但解析不出 → 回退，不静默）
  const bare = wfFile("cm-bare", ["steps:", "  - id: a", "    do: X", "    check: c", "    check_model: sonnet", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_model 裸名 → 告警回退（不静默）", !!bare.def && bare.warnings.some((w) => w.includes("check_model")), JSON.stringify(bare.warnings));
  const halfObj = wfFile("cm-half", ["steps:", "  - id: a", "    do: X", "    check: c", "    check_model:", "      modelID: x", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_model 对象缺字段 → 告警回退", !!halfObj.def && halfObj.warnings.some((w) => w.includes("check_model")), JSON.stringify(halfObj.warnings));
  // 全局 adversarial_check.model 对象形态（以前被静默丢弃）
  const gObj = wfFile("g-obj", ["adversarial_check:", "  model:", "    providerID: openai", "    modelID: gpt-5", "steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    max_fail_count: 1"]);
  check("全局 model 对象形态被接受（不再静默丢弃）", !!gObj.def && gObj.warnings.length === 0 && resolveCheckModel(gObj.def.adversarial_check?.model)?.providerID === "openai", JSON.stringify(gObj));
  const gBare = wfFile("g-bare", ["adversarial_check:", "  model: sonnet", "steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    max_fail_count: 1"]);
  check("全局 model 裸名 → 告警回退", !!gBare.def && gBare.warnings.some((w) => w.includes("adversarial_check.model")), JSON.stringify(gBare.warnings));
}

// ── 11c) A1 优先级链：步骤 check_model > 全局 model（端到端）──────────────────
{
  const s = S();
  const wfYaml = (name, lines) => fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
  wfYaml("prio", [
    "adversarial_check:", "  model: openai/gpt-5", "steps:",
    "  - id: a", "    do: X", "    check: c", "    check_model: anthropic/claude-haiku-4-5",
    "    on_pass: b", "    on_fail: a", "    max_fail_count: 1",
    "  - id: b", "    do: Y", "    check: d", "    on_pass: done", "    on_fail: b", "    max_fail_count: 1",
  ]);
  const seen = [];
  const eng2 = createEngine(engine.projectDir, {
    verify: async (req) => { seen.push(req.model); return { status: "passed", reason: "s" }; },
    deliver: () => true,
  });
  const sid = "prio-session";
  eng2.start("prio", "t", sid);
  eng2.onSubmit(sid, "one");
  await settle();
  const first = seen[0];
  check("步骤 check_model 覆盖全局 model", first?.providerID === "anthropic" && first?.modelID === "claude-haiku-4-5", JSON.stringify(first));
  eng2.onSubmit(sid, "two");
  await settle();
  const second = seen[1];
  check("未写 check_model 的步骤继承全局 model", second?.providerID === "openai" && second?.modelID === "gpt-5", JSON.stringify(second));
}

// ── 12) §1.2 doctor lint：不可达 / 无 done / 模板记号 / 无 check ───────────────
{
  const wfFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  const r1 = wfFile("lint-unreach", [
    "steps:",
    "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1",
    "  - id: orphan", "    do: Y", "    check: d", "    on_pass: done", "    on_fail: orphan", "    max_fail_count: 1",
  ]);
  check("不可达步骤 → 告警", !!r1.def && r1.warnings.some((w) => w.includes("不可达")), JSON.stringify(r1.warnings));

  const r2 = wfFile("lint-nodone", ["steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: a", "    on_fail: a", "    max_fail_count: 1"]);
  check("无任何可达 on_pass done → 告警（永不完成）", !!r2.def && r2.warnings.some((w) => w.includes("done")), JSON.stringify(r2.warnings));

  const r3 = wfFile("lint-token", ["steps:", "  - id: a", "    do: '写到 {{output_dir}}/x.md'", "    check: c", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1"]);
  check("未解析模板变量 → 告警", !!r3.def && r3.warnings.some((w) => w.includes("{{output_dir}}")), JSON.stringify(r3.warnings));

  const r4 = wfFile("lint-nocheck", ["steps:", "  - id: a", "    do: X", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1"]);
  check("非 manual 且无 check → 告警", !!r4.def && r4.warnings.some((w) => w.includes("对抗检查")), JSON.stringify(r4.warnings));

  // 不误伤：既有 loop/spec 与现有夹具照常加载、无 lint 误报
  for (const n of ["loop", "spec"]) {
    const { def, warnings } = engine.loadWorkflow(n);
    check(`内置 ${n} 照常加载且无 lint 误报`, !!def && warnings.length === 0, JSON.stringify(warnings));
  }
}

// ── 13) §1.3 CHECK 提示词补 desc + 交付物 + 产出目录；T1 不注入执行者自述 ───────
{
  const wf = { name: "loop", steps: [], manual_step: [], warnings: [] };
  const step = { id: "s", desc: "写文档", do: "写文档", check: "检查 x.md", output: "x.md + summary.md" };
  const prompt = buildCheckPrompt({
    instId: "inst-1", step, workflow: wf, userTask: "任务",
    checkIndex: 0, artifactsRelDir: ".dsh/ralph-flow/artifacts/inst-1", signal: new AbortController().signal,
  }, true);
  check("CHECK 含步骤 desc", prompt.includes("## 本步上下文") && prompt.includes("写文档"));
  check("CHECK 含交付物（DO 的承诺）", prompt.includes("交付物") && prompt.includes("x.md + summary.md"));
  check("CHECK 含产出目录（工作区相对路径）", prompt.includes("`.dsh/ralph-flow/artifacts/inst-1/`"), prompt);
  check("CHECK 要求去产出目录取证", prompt.includes("产出目录也在这个工作区内"));
  // T1 硬规则：验证者只看结果，不看执行者怎么做的/自称做了什么
  // （opencode 与 claude 版同样从不传入自述，并明令"不要依赖任何外部提供的实现总结"）
  check("CHECK 不注入「执行者交卷摘要」段", !prompt.includes("执行者交卷摘要"), prompt);
  check("CHECK 不出现任何自述标记", !prompt.includes("（无摘要）"), prompt);
  check("CHECK 明示只看结果、不采信自述", prompt.includes("只看结果") && prompt.includes("不采信任何执行者自述"));
  // 类型层面：VerifyRequest 不得再有 submitSummary 字段（防止重新引入）
  check("VerifyRequest 类型已移除 submitSummary",
    !fs.readFileSync(new URL("../src/engine.ts", import.meta.url), "utf-8")
      .slice(0, 4000).includes("submitSummary: string;"));
}

// ── 14) §1.4 报告补每步耗时与重试次数（从 history/fail_counts 派生）────────────
{
  const s = S();
  const { id } = start("loop", "报告统计用例", s);
  scripted.push({ status: "failed", reason: "先失败一次" });
  submit(s, "第一版");
  await settle();
  scripted.push({ status: "passed", reason: "修好了" });
  submit(s, "第二版");
  await settle();
  const st = engine.readState(id);
  check("失败后重试再通过 → 完成", st && !st.active);
  const report = fs.readFileSync(path.join(engine.reportsDir, `${id}.md`), "utf-8");
  check("报告含总耗时", report.includes("总耗时："), report.slice(0, 400));
  check("报告含每步耗时表", report.includes("## 步骤耗时与重试") && /`loop`：耗时 \S+/.test(report), report.slice(0, 600));
  check("报告含重试次数（fail_counts 派生）", report.includes("失败 1 轮"), report.slice(0, 600));
  check("报告含产出目录（入库可查）", report.includes(`.dsh/ralph-flow/artifacts/${id}/`));
}

// ── 15) §1.5 restore() 清掉悬挂索引条目（state.json 已不存在）─────────────────
{
  const s = S();
  const { id } = start("loop", "GC 用例", s);
  const idxBefore = JSON.parse(fs.readFileSync(engine.indexPath, "utf-8"));
  check("GC 前索引含本实例", !!idxBefore[id], JSON.stringify(idxBefore));
  fs.rmSync(engine.instanceDir(id), { recursive: true, force: true });
  engine.restore();
  const idxAfter = JSON.parse(fs.readFileSync(engine.indexPath, "utf-8"));
  check("restore() 清掉悬挂条目", !idxAfter[id], JSON.stringify(idxAfter));
  check("restore() 不动正常条目", Object.values(idxAfter).length === Object.values(idxBefore).length - 1, JSON.stringify({ before: idxBefore, after: idxAfter }));
}

// ── 16) §1.6 CREATE_GUIDE 与引擎实际行为一致（文本 + 行为双向交叉验证）────────
{
  // 文本侧：不得再出现与实测相反的陈述
  check("指引不再声称 doctor 报告「可启动」", !CREATE_GUIDE.includes("报告「可启动」") && !CREATE_GUIDE.includes("直到「可启动」"));
  check("指引明确 input 只进 CHECK 提示词", CREATE_GUIDE.includes("只进 CHECK 提示词"));
  check("指引明确子工作流形状是硬错误（不再说「不报错」）", CREATE_GUIDE.includes("硬错误、工作流无法启动") && !CREATE_GUIDE.includes("见到会警告并忽略，不报错"));
  check("指引把 on_pass/on_fail/max_fail_count 标为可选", !CREATE_GUIDE.includes("必填：下个步骤") && CREATE_GUIDE.includes("可选，缺省"));

  const guideFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  // 行为侧 1：子工作流形状（无 do）确实无法启动
  const sub = guideFile("guide-sub", ["steps:", "  - id: delegate", "    workflow: child", "    on_pass: done", "    on_fail: delegate", "    max_fail_count: 3"]);
  check("子工作流形状（无 do）硬错误、无法启动", !sub.def && sub.problems.some((p) => p.includes("do")), JSON.stringify(sub.problems));
  // 行为侧 2：只写 id/do/check 即可加载 → 三者确为可选
  const min = guideFile("guide-min", ["steps:", "  - id: a", "    do: X", "    check: c"]);
  check("只写 id/do/check 可加载（on_pass/on_fail/max_fail_count 确为可选）", !!min.def, JSON.stringify(min.problems));
  // 行为侧 3：doctor 输出没有「可启动」，只有 ✅/❌ 与结论行
  const diag = engine.diagnose().text;
  check("doctor 输出不含「可启动」（指引措辞与输出一致）", !diag.includes("可启动") && diag.includes("全部 ✅"));
  // 行为侧 4：input 只出现在 CHECK，不出现在 DO
  const inp = guideFile("guide-input", ["steps:", "  - id: a", "    desc: 描述D", "    do: 干活D", "    check: 检查D", "    input: 输入标记I", "    output: 交付标记O", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1"]);
  const sInp = S();
  const started = engine.start("guide-input", "输入提示词用例", sInp);
  check("DO 提示词含 desc/交付物、但**不含** input", started.ok && started.text.includes("描述D") && started.text.includes("交付标记O") && !started.text.includes("输入标记I"), started.text.slice(0, 400));
  const checkPrompt = buildCheckPrompt({
    instId: "guide-input", step: inp.def.steps[0], workflow: inp.def, userTask: "任务",
    checkIndex: 0, artifactsRelDir: ".dsh/ralph-flow/artifacts/guide-input", signal: new AbortController().signal,
  }, true);
  check("CHECK 提示词含 input（指引所述一致）", checkPrompt.includes("输入标记I"));
  // 行为侧 5：A1 —— 指引声称支持 check_model 与两形态 model，行为必须一致
  check("指引提到 check_model", CREATE_GUIDE.includes("check_model"));
  check("指引写明验证模型优先级链", CREATE_GUIDE.includes("check_model` > 全局"), CREATE_GUIDE.slice(0, 200));
  const cmGuide = guideFile("guide-cm", ["steps:", "  - id: a", "    do: X", "    check: c", "    check_model: deepseek/deepseek-chat", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1"]);
  check("指引所述 check_model 写法确实可加载", !!cmGuide.def && cmGuide.problems.length === 0, JSON.stringify(cmGuide));
  const cmBadGuide = guideFile("guide-cm-bad", ["steps:", "  - id: a", "    do: X", "    check_model: a/b", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1"]);
  check("指引所述「无 check 即硬错误」确实成立", !cmBadGuide.def && cmBadGuide.problems.some((p) => p.includes("check_model")), JSON.stringify(cmBadGuide.problems));
}

// ── 清理（索引在隔离 HOME 里，只删本测试写入的条目）────────────────────────────
const indexPath = path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json");
try {
  const idx = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  let changed = false;
  for (const [id, ws] of Object.entries(idx)) {
    if (typeof ws === "string" && ws.startsWith(dir)) { delete idx[id]; changed = true; }
  }
  if (changed) fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf-8");
} catch {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);