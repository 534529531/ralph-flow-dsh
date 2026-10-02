/**
 * 引擎级裁判权测试（无宿主依赖）：直接驱动 lib/engine.js，脚本化验证者端口。
 * 引擎约束：每会话最多一个活跃实例（与 claude 版一致）——每个用例用独立会话隔离。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, resolveCheckModel, makeArtifactsDirName, stepHasCheck, listWorkflowsIn, stepStats, voterCountOf, expectedVerdicts } from "../lib/engine.js";
import { buildCheckPrompt } from "../lib/verify.js";
import { CREATE_GUIDE } from "../lib/create.js";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-test-"));
const deliveries = [];

let scripted = [];
/** 验证端口调用计数：无 check 的步骤必须**一次都不调用**（验收 2 要求用计数器断言，不能只看返回值） */
let verifyCalls = 0;
const engine = createEngine(dir, {
  deliver: (_sid, text) => { deliveries.push(text); return true; },
  verify: async (req) => {
    verifyCalls++;
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

/**
 * 内置 `loop` 现在是**多验证者投票**步（每票一条检查依据，**全过才放行**）：
 * 一轮交卷要投满这么多张判定才会聚合，所以脚本化端口一次性入队同样数量的判定。
 * 票数**现算**（不硬编码）：工作流改了票数，测试跟着走，不会静默漂移。
 */
const LOOP_VOTERS = voterCountOf(engine.loadWorkflow("loop").def.steps[0]);
/** 入队 n 张同样的判定（缺省 = 内置 loop 的票数） */
const votes = (v, count = LOOP_VOTERS) => Array.from({ length: count }, () => ({ ...v }));

// ── 1) 加载 + 启动 + 通过完成 ────────────────────────────────────────────────
{
  const s = S();
  const wfs = engine.listWorkflows();
  check("内置 loop/spec 可加载", wfs.length >= 2 && wfs.every((w) => !w.invalid), JSON.stringify(wfs.map((w) => w.name)));
  // 内置 loop 的**形状**（不是只看告警）：opencode 那三票逐字照抄 + 本仓库第 4 票，投票而非单 check
  const loopDef = engine.loadWorkflow("loop").def;
  const loopStep = loopDef.steps[0];
  check("内置 loop 是多验证者投票步（4 票 · 每票一条检查依据 · 不再写单 check）",
    expectedVerdicts(loopStep) === 4 && loopStep.check === undefined
    && loopStep.check_voting?.length === 4 && loopStep.check_voting.every((e) => !e.model),
    JSON.stringify({ check: loopStep.check, voters: loopStep.check_voting?.map((e) => e.check) }));
  check("内置 loop 前三条检查依据逐字照抄 opencode 版 loop.yaml",
    loopStep.check_voting[0].check === "用户任务的每一条要求都已落实"
    && loopStep.check_voting[1].check === "实现的行为符合预期，真实可用"
    && loopStep.check_voting[2].check === "没有遗漏的需求，边界情况已覆盖",
    JSON.stringify(loopStep.check_voting.map((e) => e.check)));
  check("内置 loop 第 4 票是本仓库自己的「既有行为没有被破坏」口径",
    loopStep.check_voting[3].check.startsWith("既有行为没有被破坏：仓库自带测试仍全绿")
    && loopStep.check_voting[3].check.includes("测试往往只覆盖一半"), loopStep.check_voting[3].check);
  {
    // 与 opencode 的差异只写在注释里：reset / timeout_ms 都不抄进来（都是加载期告警忽略的键）
    const raw = fs.readFileSync(new URL("../workflows/loop.yaml", import.meta.url), "utf-8");
    const active = raw.replace(/^\s*#.*$/gm, "");
    check("内置 loop 不抄 opencode 的 reset / timeout_ms（只在原处注释说明差异）",
      !/^\s*reset:/m.test(active) && !/timeout_ms\s*:/m.test(active)
      && raw.includes("reset: true") && raw.includes("timeout_ms"),
      raw);
    const loaded = engine.loadWorkflow("loop");
    check("内置 loop 仍然零告警零问题（差异注释不产生任何键）",
      loaded.warnings.length === 0 && loaded.problems.length === 0, JSON.stringify(loaded.warnings));
  }
  const { r, id } = start("loop", "写一个 hello.html", s);
  check("start 成功且 DO prompt 完整", r.ok && r.text.includes("写一个 hello.html") && r.text.includes("ralphflow_submit"));
  // 投票首步：start 回执写明 N 个独立验证者**并行**取证、全过才放行（单 check 的文案不再适用）
  check("投票首步：start 回执写明 N 个独立验证者并行取证（全过才放行）",
    r.text.includes(`接下来：模型执行本步 → 交卷 → **${LOOP_VOTERS} 个独立验证者**（独立会话，看不到本对话）并行取证判定，**全过才放行** → 通过则推进，不通过自动返工。`),
    r.text.slice(0, 320));
  check("投票首步：DO prompt 写明每票只查一条检查依据、全过才放行",
    r.text.includes(`${LOOP_VOTERS} 个独立验证者**并行**取证，各自只查一条检查依据，**全过才放行**`)
    && r.text.includes(`${LOOP_VOTERS} 个独立验证者会立刻**并行**检查你的产出（全过才放行）`),
    r.text.slice(-420));
  scripted.push(...votes({ status: "passed", reason: "文件存在且内容正确" }));
  submit(s, "已完成，创建了 hello.html。");
  await settle();
  const st = engine.readState(id);
  check("通过后实例目录已销毁（readState 为 null）", st === null, JSON.stringify(st));
  check("通过后报告归档", fs.existsSync(path.join(engine.reportsDir, `${id}.md`)));
  check("实例目录物理消失", !fs.existsSync(engine.instanceDir(id)));
  check("listInstances 不再含已结束实例", !engine.listInstances().some((i) => i.id === id));
  check("「历史运行」能列出它（从报告解析）", engine.listHistory().some((h) => h.id === id && h.parsed));
}

// ── 2) 失败 → 返工 ───────────────────────────────────────────────────────────
{
  const s = S();
  const { id } = start("loop", "会失败的脚本", s);
  deliveries.length = 0;
  scripted.push({ status: "failed", reason: "脚本语法错误" }, ...votes({ status: "passed", reason: "其余视角通过" }, Math.max(0, LOOP_VOTERS - 1)));
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
  scripted.push(...votes({ status: "infra", reason: "provider 不可用" }));
  submit(s, "好了。");
  await settle();
  let st = engine.readState(id);
  check("infra → 暂停 check_infra 且 fail_count=0", st.paused && st.pause_reason === "check_infra" && st.fail_count === 0, JSON.stringify({ p: st.pause_reason, f: st.fail_count }));
  scripted.push(...votes({ status: "failed", reason: "还是不行" })); // 先入队：continue 同步消费（整轮 4 票）
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

// ── 5) spec 审查门：pass 停在门，continue 才推进（4 步版：门在 propose）──────
{
  const s = S();
  const { r, id } = start("spec", "做一个用户登录模块", s);
  check("spec 启动且首步 explore", r.ok && engine.readState(id).current_step === "explore", r.text.slice(0, 100));
  check("spec 是 4 步（explore→propose→implement→archive）", r.text.includes("共 4 步"), r.text.slice(0, 120));
  deliveries.length = 0;
  // explore 不是门 → 通过后应自动推进到 propose
  scripted.push({ status: "passed", reason: "proposal.md 完备" });
  submit(s, "proposal 草稿写好了。");
  await settle();
  let st = engine.readState(id);
  check("explore 通过 → 自动推进到 propose", st.active && st.current_step === "propose", `step=${st.current_step}`);
  // propose 是门 → 通过后停在门，不推进
  deliveries.length = 0;
  scripted.push({ status: "passed", reason: "tasks.md 可执行" });
  submit(s, "提案定稿 + 任务拆解完成。");
  await settle();
  st = engine.readState(id);
  check("propose 通过后停在审查门（不推进）", st.active && st.current_step === "propose" && st.verdicts.length === 1, `step=${st.current_step}`);
  check("门提示 continue", deliveries.some((t) => t.includes("审查门")), deliveries.at(-1)?.slice(0, 60));
  const c = engine.continueInstance(s);
  const after = engine.readState(id);
  check("continue 放行 → 推进到 implement", c.ok && after.current_step === "implement", `step=${after.current_step}`);
}

// ── 6) continue fail-closed ──────────────────────────────────────────────────
{
  const s = S();
  const { id } = start("loop", "fail-closed 用例", s);
  const c1 = engine.continueInstance(s);
  check("未交卷 → 拒绝推进", !c1.ok && c1.text.includes("还没交卷"), c1.text);
  scripted.push(...votes({ status: "failed", reason: "不过" }));
  submit(s, "交卷。");
  await settle();
  const c2 = engine.continueInstance(s);
  check("判定未通过后 continue 绝不推进（fail-closed）", !c2.ok && (c2.text.includes("不能推进") || c2.text.includes("还没交卷")), c2.text);
  scripted.push(...votes({ status: "passed", reason: "通过了" }));
  submit(s, "修好了。");
  await settle();
  const st = engine.readState(id);
  check("通过后终止并销毁实例目录", st === null && !fs.existsSync(engine.instanceDir(id)));
  check("通过后报告存在", fs.existsSync(path.join(engine.reportsDir, `${id}.md`)));
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

// ── 8) 引擎按工作区单根：列表 / 历史 / 自定义工作流都在会话工作区里找到 ────────
// 这是「发现面锚定」缺陷的回归用例。引擎的根**就是**发起会话的工作区；真实 GUI 里
// dsh 进程 cwd ≠ 会话工作区（实测 cwd=/home/yj、会话工作区=仓库），而旧实现是
// 「一个引擎服务多个工作区 + 全局实例索引」，于是自定义工作流加载不到、历史列表
// 永远 0 条、doctor 报「暂无实例」——三条都是同一个根因。
{
  const s = S();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-ws-"));
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "passed", reason: "ok" }),
    log: () => {},
  });
  e.ensureLayout();

  // CREATE_GUIDE 教模型写的位置就是这里：写进去必须能被加载、能被列出
  fs.writeFileSync(
    path.join(ws, ".dsh", "ralph-flow", "workflows", "mywf.yaml"),
    ["description: 探针工作流", "steps:", "  - id: only", "    do: 做事。", "    check: 核对。"].join("\n"),
  );
  const lw = e.loadWorkflow("mywf");
  check("自定义工作流（写在本工作区）能被加载", !!lw.def, JSON.stringify(lw.problems));
  // 动态快捷命令 /ralphflow-<名字> 的登记源：必须**不建引擎**就能读出该工作区的自定义工作流
  // （引擎是惰性创建的，会话刚出现时还没有引擎）
  const custom = listWorkflowsIn(ws);
  check("listWorkflowsIn 不建引擎就读得到该工作区的自定义工作流",
    custom.some((w) => w.name === "mywf" && w.desc === "探针工作流"), JSON.stringify(custom));
  // 内置必须在内：它们不落盘，漏掉就会让 /ralphflow-loop、/ralphflow-spec 消失（曾被我改漏）
  check("listWorkflowsIn **包含内置工作流**（否则 /ralphflow-loop 会消失）",
    custom.some((w) => w.name === "loop" && !!w.desc) && custom.some((w) => w.name === "spec" && !!w.desc),
    JSON.stringify(custom));
  check("listWorkflowsIn 不建出任何引擎目录",
    !fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "instances")) || fs.readdirSync(path.join(ws, ".dsh", "ralph-flow", "instances")).length === 0);
  check("listWorkflows 列出该自定义工作流", e.listWorkflows().some((w) => w.name === "mywf"),
    JSON.stringify(e.listWorkflows().map((w) => w.name)));

  const r = e.start("mywf", "工作区用例", s);
  check("start 成功", r.ok, r.text);
  const id = e.listInstances().at(-1)?.id;
  const wsInstDir = path.join(ws, ".dsh", "ralph-flow", "instances", id);
  check("实例目录落在本工作区", fs.existsSync(path.join(wsInstDir, "state.json")), wsInstDir);
  check("内置工作流**不**播种到工作区（对齐 opencode/claude，避免陈旧副本遮蔽内置）",
    !fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "workflows", "loop.yaml")));
  check("但内置仍可加载（回落插件目录，始终取最新发布版）", !!e.loadWorkflow("loop").def);

  e.onSubmit(s, "完成。");
  await settle();
  check("完成后实例目录已销毁", !fs.existsSync(wsInstDir), wsInstDir);
  check("报告归档在本工作区", fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "reports", `${id}.md`)));
  check("**listHistory 看得见刚跑完的运行**（曾经的缺陷：永远 0 条）",
    e.listHistory().some((h) => h.id === id), JSON.stringify(e.listHistory().map((h) => h.id)));
  // doctor 必须能看见**本工作区**的残留。旧实现扫 knownWorkspaces()=projectDir∪索引，
  // 实例一除名该工作区就从扫描范围消失 → 残留永远报不出来。
  const ghostDir = path.join(ws, ".dsh", "ralph-flow", "instances", "ghost-residue");
  fs.mkdirSync(ghostDir, { recursive: true });
  check("**diagnose 报出本工作区的残留实例目录**（曾经的缺陷：报「暂无实例」）",
    e.diagnose().text.includes("ghost-residue"), e.diagnose().text.slice(-220));
  fs.rmSync(ghostDir, { recursive: true, force: true });
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
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
  try { fs.rmSync(dir2, { recursive: true, force: true }); } catch {}
}

// ── 10) 布局：新 dot-dir 布局齐全，旧 ralph-flow/ 不再创建 ────────────────────
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-layout-"));
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "passed", reason: "布局 ok" }),
    log: () => {},
  });
  e.ensureLayout();
  const s = S();
  const r = e.start("loop", "布局用例", s);
  const id = e.listInstances().at(-1)?.id;
  check("start 成功（布局用例）", r.ok && r.text.includes("布局用例"));
  for (const sub of ["workflows", "instances", "reports", "artifacts"]) {
    check(`新布局 .dsh/ralph-flow/${sub} 齐全`, fs.existsSync(path.join(ws, ".dsh", "ralph-flow", sub)));
  }
  check("旧 ralph-flow/ 不再被创建", !fs.existsSync(path.join(ws, "ralph-flow")));
  // §1.7 产出目录：实例启动时建好；完成后**非空即保留**；DO 提示词注入工作区相对路径
  const artName = makeArtifactsDirName("布局用例", id);
  const artDir = path.join(ws, ".dsh", "ralph-flow", "artifacts", artName);
  check("每实例产出目录已建好（任务摘要 slug + id 尾段）", fs.existsSync(artDir), artDir);
  check(
    "DO 提示词含产出目录（工作区相对路径）",
    r.text.includes("## 产出目录") && r.text.includes(`.dsh/ralph-flow/artifacts/${artName}/`),
    r.text.slice(-260),
  );
  fs.writeFileSync(path.join(artDir, "summary.md"), "keep-me\n", "utf-8");
  e.onSubmit(s, "布局完成。");
  await settle();
  check("完成后非空产出目录保留（逐字节）",
    fs.existsSync(artDir) && fs.readFileSync(path.join(artDir, "summary.md"), "utf-8") === "keep-me\n");
  check("完成后实例目录已销毁", !fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "instances", id)));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
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

// ── 11c) manual_step 只有「工作流级列表」一种写法（步骤级 = 加载期硬错误）───────
// 背景：步骤级 `manual_step: true` 与本引擎的工作流级列表曾语义等价、纯冗余；但 opencode/pi
// **只认顶层列表**，步骤级写法在那边只是「不认识的步骤键」→ 警告忽略 → **人工审查门静默消失**。
// 故步骤级键（不论值）必须 fail-fast（说清正确写法），而列表行为逐字不变。
{
  const wfFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  const stepLines = (manualLine) => [
    "steps:", "  - id: a", "    do: X", "    check: c",
    ...(manualLine === undefined ? [] : [manualLine]),
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 1",
  ];
  for (const [label, line] of [["true", "    manual_step: true"], ["false", "    manual_step: false"], ["空值", "    manual_step:"]]) {
    const r = wfFile(`bad-step-manual-${label}`, stepLines(line));
    check(`步骤级 manual_step（${label}）→ 硬错误`, !r.def && r.problems.some((p) => p.includes("manual_step")), JSON.stringify(r.problems));
    check(`步骤级 manual_step（${label}）报错给出正确写法（工作流级列表 + 该步 id）`,
      r.problems.some((p) => p.includes("工作流级") && p.includes("manual_step: [a]")), JSON.stringify(r.problems));
    check(`步骤级 manual_step（${label}）不降级成「未知键警告忽略」`,
      !r.warnings.some((w) => w.includes("manual_step")), JSON.stringify(r.warnings));
    check(`步骤级 manual_step（${label}）定义被拒收`, r.def === null);
  }
  // 用户可见入口（start）也必须 fail-fast，而不是加载成功后一路跑过去
  wfFile("bad-step-manual-start", stepLines("    manual_step: true"));
  {
    const rs = engine.start("bad-step-manual-start", "步骤级写法必须被拒", S());
    check("start 直接拒绝步骤级 manual_step（回执说人话、给出正确写法）",
      !rs.ok && rs.text.includes("manual_step") && rs.text.includes("工作流级") && rs.text.includes("manual_step: [a]"), rs.text);
  }
  // doctor 同样报成 ❌ 阻塞项（硬错误口径），不是「⚠️ 未知键已忽略」
  {
    const diag = engine.diagnose();
    check("doctor 把步骤级 manual_step 报成 ❌（不是告警忽略）",
      diag.text.includes("❌") && diag.text.includes("bad-step-manual-true") && diag.text.includes("步骤级"),
      diag.text.slice(0, 700));
  }

  // 列表写法照常生效：通过后停在审查门，continue 才放行（行为与改造前逐字一致）
  const good = wfFile("ok-step-manual-list", [
    "description: 工作流级列表是审查门的唯一写法", "manual_step: [g]", "steps:",
    "  - id: g", "    desc: 门步", "    do: 做 G", "    check: 检查 G",
    "    on_pass: h", "    on_fail: g", "    max_fail_count: 3",
    "  - id: h", "    desc: 收尾步", "    do: 做 H", "    check: 检查 H",
    "    on_pass: done", "    on_fail: h", "    max_fail_count: 3",
  ]);
  check("工作流级列表照常加载（零问题、零告警）",
    !!good.def && good.problems.length === 0 && good.warnings.length === 0,
    JSON.stringify({ p: good.problems, w: good.warnings }));
  check("工作流级列表解析为 [g]", JSON.stringify(good.def?.manual_step) === '["g"]', JSON.stringify(good.def?.manual_step));
  {
    const s = S();
    scripted.push({ status: "passed", reason: "G 独立取证通过" });
    const { id } = start("ok-step-manual-list", "列表写法的审查门用例", s);
    submit(s, "G 做完了。");
    await settle();
    const st = engine.readState(id);
    check("列表里的门步：验证通过后停在审查门（不推进、未暂停、无在飞委派）",
      !!st && st.active && !st.paused && st.current_step === "g" && st.verdicts.length === 1 && st.delegations.length === 0,
      JSON.stringify({ step: st?.current_step, active: st?.active, paused: st?.paused, v: st?.verdicts.length }));
    const c = engine.continueInstance(s);
    await settle();
    const st2 = engine.readState(id);
    check("列表里的门步：continue 放行推进到下一步", c.ok && !!st2 && st2.current_step === "h", `ok=${c.ok} step=${st2?.current_step}`);
  }
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

// ── 11d) 验证者配置收敛：`adversarial_check` 只留 model；其余字段/非对象一律告警忽略 ──
// 口径与未知键、check_voting 统一：warn+ignore（不拒收、不静默、不改作别的含义）。
// 告警必须在**加载期**出现——doctor 直接读 loadWorkflow 的 warnings。
{
  const wfFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  const steps = ["steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    max_fail_count: 1"];
  // 三个已删除字段：各自告警指出该字段，且不进定义（不生效）
  for (const field of ["agent", "system_prompt", "timeout_ms"]) {
    const value = field === "timeout_ms" ? "5000" : "whatever";
    const r = wfFile(`ac-${field}`, ["adversarial_check:", `  ${field}: ${value}`, ...steps]);
    check(`adversarial_check.${field} 可加载（不拒收）`, !!r.def, JSON.stringify(r.problems));
    check(`adversarial_check.${field} 加载期告警并指出该字段`, r.warnings.some((w) => w.includes(field)), JSON.stringify(r.warnings));
    check(`adversarial_check.${field} 不进入定义（不生效）`, !(field in (r.def?.adversarial_check ?? {})), JSON.stringify(r.def?.adversarial_check));
    check(`adversarial_check.${field} 进入 doctor 告警（同一份 warnings）`, engine.diagnose().text.includes(field));
  }
  // 与合法字段同写：model 照常生效，只对已删字段告警
  const mix = wfFile("ac-mix", ["adversarial_check:", "  model: openai/gpt-5", "  agent: fork", ...steps]);
  check("model 与已删字段同写：model 照常保留", !!mix.def && resolveCheckModel(mix.def.adversarial_check?.model)?.providerID === "openai", JSON.stringify(mix));
  check("同写时只对已删字段告警（model 无告警）", mix.warnings.some((w) => w.includes("agent")) && !mix.warnings.some((w) => w.includes("adversarial_check.model")), JSON.stringify(mix.warnings));
  // adversarial_check 非对象（布尔/字符串/列表）→ 告警「必须是对象」并忽略
  const nonObj = [
    ["布尔 true", ["adversarial_check: true", ...steps]],
    ["字符串", ["adversarial_check: foo", ...steps]],
    ["列表", ["adversarial_check:", "  - a", ...steps]],
  ];
  for (const [label, lines] of nonObj) {
    const r = wfFile(`ac-nonobj-${label.replace(/\s+/g, "-")}`, lines);
    check(`adversarial_check 为${label} → 可加载（不拒收）`, !!r.def, JSON.stringify(r.problems));
    check(`adversarial_check 为${label} → 告警「必须是对象」并忽略`, r.warnings.some((w) => w.includes("adversarial_check") && w.includes("必须是对象")), JSON.stringify(r.warnings));
    check(`adversarial_check 为${label} → 定义里为 undefined`, r.def?.adversarial_check === undefined, JSON.stringify(r.def?.adversarial_check));
  }
  // model 类型非法（数字）→ 告警回退，不静默
  const badModel = wfFile("ac-model-number", ["adversarial_check:", "  model: 123", ...steps]);
  check("adversarial_check.model 类型非法 → 告警回退（不静默）", !!badModel.def && badModel.warnings.some((w) => w.includes("adversarial_check.model")), JSON.stringify(badModel.warnings));
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
  check("非 manual 且无 check → 告警「不会被独立验证」",
    !!r4.def && r4.warnings.some((w) => w.includes("对抗性检查") && w.includes("不会被独立验证")), JSON.stringify(r4.warnings));
  check("无 check 告警不再提「兜底配方」（已退役）", !!r4.def && !r4.warnings.some((w) => w.includes("兜底")), JSON.stringify(r4.warnings));

  // 新增：manual 且无 check → **不告警**（纯人工审查是刻意默认，不是问题，照 opencode lint）
  const r5 = wfFile("lint-nocheck-manual", ["manual_step: [a]", "steps:", "  - id: a", "    do: X", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1"]);
  check("manual 且无 check → 不告警", !!r5.def && r5.warnings.length === 0, JSON.stringify(r5.warnings));

  // doctor（工具）与 loadWorkflow 共用同一份 warnings：告警必须在 doctor 的数据源里可见，
  // 且 manual 的无 check 步骤不得出现（验收 8 的端到端断言）。
  const wfEntries = engine.listWorkflows();
  const entryOf = (n) => wfEntries.find((w) => w.name === n) ?? { warnings: [] };
  check("doctor 数据源里非 manual 无 check → 告警「不会被独立验证」",
    entryOf("lint-nocheck").warnings.some((w) => w.includes("不会被独立验证")), JSON.stringify(entryOf("lint-nocheck").warnings));
  check("doctor 数据源里 manual 无 check → 零告警", entryOf("lint-nocheck-manual").warnings.length === 0, JSON.stringify(entryOf("lint-nocheck-manual").warnings));
  check("doctor 文本里可见该告警", engine.diagnose().text.includes("不会被独立验证"));

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
  scripted.push(...votes({ status: "failed", reason: "先失败一次" }));
  submit(s, "第一版");
  await settle();
  scripted.push(...votes({ status: "passed", reason: "修好了" }));
  submit(s, "第二版");
  await settle();
  const st = engine.readState(id);
  check("失败后重试再通过 → 完成并销毁", st === null && !fs.existsSync(engine.instanceDir(id)));
  const report = fs.readFileSync(path.join(engine.reportsDir, `${id}.md`), "utf-8");
  check("报告含总耗时", report.includes("总耗时："), report.slice(0, 400));
  check("报告含每步耗时表", report.includes("## 步骤耗时与重试") && /`loop`：耗时 \S+/.test(report), report.slice(0, 600));
  // 上一条断言**太弱**：`/耗时 \S+/` 连 "0s" 都算通过 —— 于是「每步耗时恒为 0s」
  // 这个缺陷活过了全部既有断言，直到作者真跑一轮 6m22s 的工作流才在归档报告里看见。
  // 单测用**合成 history**（毫秒级真跑永远算不出非 0 秒，必须直接喂时间戳）。
  {
    const H = (ts, step, event) => ({ ts, step, event });
    const st = stepStats(
      [
        H("2026-01-01T00:00:00.000Z", "a", "start"),
        H("2026-01-01T00:01:00.000Z", "a", "do_submitted"),
        H("2026-01-01T00:02:00.000Z", "b", "step_start"),
        H("2026-01-01T00:03:00.000Z", "b", "do_submitted"),
      ],
      {},
      new Date("2026-01-01T00:05:00.000Z").getTime(),
    );
    const by = Object.fromEntries(st.map((x) => [x.step, x.ms]));
    check("单测：首步耗时 = 首条事件 → 下一步首条事件（2 分钟）", by.a === 120_000, JSON.stringify(st));
    check("单测：**末步耗时 = 首条事件 → endTs**（3 分钟，不是 0）", by.b === 180_000, JSON.stringify(st));
    check("单测：单步工作流的耗时 = 整轮跨度（不是 0）",
      stepStats([H("2026-01-01T00:00:00.000Z", "only", "start"), H("2026-01-01T00:06:22.000Z", "only", "complete")], {}, new Date("2026-01-01T00:06:22.380Z").getTime())[0].ms === 382_380,
      JSON.stringify(stepStats([H("2026-01-01T00:00:00.000Z", "only", "start")], {}, 0)));
    check("单测：返工重新进入同一步 → 累计总时长",
      stepStats([
        H("2026-01-01T00:00:00.000Z", "a", "start"),
        H("2026-01-01T00:00:10.000Z", "b", "step_start"),
        H("2026-01-01T00:00:20.000Z", "a", "step_start"),
      ], {}, new Date("2026-01-01T00:00:30.000Z").getTime()).find((x) => x.step === "a").ms === 20_000,
      JSON.stringify(stepStats([], {}, 0)));
  }
  check("报告含重试次数（fail_counts 派生）", report.includes("失败 1 轮"), report.slice(0, 600));
  check("报告含产出目录（入库可查）", report.includes(`.dsh/ralph-flow/artifacts/${makeArtifactsDirName("报告统计用例", id)}/`), report.slice(0, 600));
}

// ── 15) 单根扫描：悬挂实例目录（无 state.json）不进活跃列表，但 doctor 报出来 ────
// 索引已随「引擎按工作区实例化」删除：listInstances 直接扫本工作区的 instances/，
// 所以「磁盘上有、列表里没有」这种幽灵不再可能，也不再需要索引 GC。
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-scan-"));
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async () => ({ status: "infra", reason: "x", check_index: 0, step_id: "s", ts: "" }),
    log: () => {},
  });
  e.ensureLayout();
  const ghost = path.join(ws, ".dsh", "ralph-flow", "instances", "ghost-x");
  fs.mkdirSync(ghost, { recursive: true });
  check("无 state.json 的悬挂目录不进活跃列表", e.listInstances().length === 0);
  let threw = false;
  try { e.restore(); } catch { threw = true; }
  check("restore() 不因悬挂目录抛错", !threw);
  check("doctor 报出悬挂目录", e.diagnose().text.includes("ghost-x"));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}
// ── 15a) 只读操作不得有写副作用（不建任何目录）────────────────────────────────
// engineFor 是所有工具的入口，若在那里 ensureLayout，/ralphflow-list、/ralphflow-doctor
// 这类只读命令会在用户从没用过 ralphflow 的项目里创建整棵 .dsh/ralph-flow/ 树。
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-ro-"));
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async () => ({ status: "infra", reason: "x", check_index: 0, step_id: "s", ts: "" }),
    log: () => {},
  });
  e.listAll();
  e.diagnose();
  e.listInstances();
  e.listHistory();
  e.listWorkflows();
  e.loadWorkflow("loop");
  check("只读操作不创建 .dsh/ralph-flow/（list/doctor/status 无写副作用）",
    !fs.existsSync(path.join(ws, ".dsh")), fs.existsSync(path.join(ws, ".dsh")) ? fs.readdirSync(path.join(ws, ".dsh")).join(",") : "");
  e.ensureLayout();
  check("显式 ensureLayout 才建目录（写意图的操作走这条）", fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "workflows")));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}

// ── 15b) 列表里的「属主会话」必须可辨认 ───────────────────────────────────────
// dsh 的会话 id 一律以 `session-` 开头，所以 slice(0, 8) 会让**每一个**实例都显示成
// `session-` —— 列表里那一行等于没写。
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-sid-"));
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async () => ({ status: "infra", reason: "x", check_index: 0, step_id: "s", ts: "" }),
    log: () => {},
  });
  e.ensureLayout();
  e.start("loop", "属主会话显示用例", "session-437df8a0-d996-4d27-89ea-a90094060c87");
  const text = e.listAll().text;
  check("属主会话显示可辨认（含 uuid 首段）", text.includes("session-437df8a0"), text.slice(0, 420));
  check("不再出现无信息的 `session-`", !/`session-`/.test(text), text.slice(0, 420));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}

// ── 16) §1.6 CREATE_GUIDE 与引擎实际行为一致（文本 + 行为双向交叉验证）────────
{
  // 文本侧：不得再出现与实测相反的陈述
  check("指引不再声称 doctor 报告「可启动」", !CREATE_GUIDE.includes("报告「可启动」") && !CREATE_GUIDE.includes("直到「可启动」"));
  check("指引明确 input 只进 CHECK 提示词", CREATE_GUIDE.includes("只进 CHECK 提示词"));
  check("指引教了子工作流调用点的写法（workflow: 代替 do:）", CREATE_GUIDE.includes("代替 `do:`") && CREATE_GUIDE.includes("workflow: analyze"));
  check("指引写明子工作流的加载期硬错误清单与 2000 步上限", CREATE_GUIDE.includes("子工作流的加载期硬错误") && CREATE_GUIDE.includes("2000"));
  check("指引不再声称本版本没有子工作流 / 不再说它是无法启动的形状",
    !CREATE_GUIDE.includes("本版本没有子工作流") && !CREATE_GUIDE.includes("硬错误、工作流无法启动"));
  check("指引把 on_pass/on_fail/max_fail_count 标为可选", !CREATE_GUIDE.includes("必填：下个步骤") && CREATE_GUIDE.includes("可选，缺省"));

  const guideFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  // 行为侧 1：子工作流调用点 —— 子文件加载不出来 = 加载期硬错误；子文件在 → 静态展开可加载
  //（此处原为「子工作流形状（无 do）硬错误、无法启动」；语义按任务书升级，断言随之改写：
  //  负对照从「形状不支持」换成「引用不存在／成环／上限」这些真正该硬错误的情形）
  const sub = guideFile("guide-sub", ["steps:", "  - id: delegate", "    workflow: child", "    on_pass: done", "    on_fail: delegate", "    max_fail_count: 3"]);
  check("调用点引用不存在的子文件 → 加载期硬错误（报错含调用链，不再拖到运行期）",
    !sub.def && sub.problems.some((p) => p.includes("child") && p.includes("无法加载")), JSON.stringify(sub.problems));
  guideFile("guide-child", ["steps:", "  - id: inner", "    do: X", "    check: Y", "    on_pass: done"]);
  const subOk = guideFile("guide-sub2", ["steps:", "  - id: delegate", "    workflow: guide-child"]);
  check("子文件在 → 静态展开可加载、id 前缀化（指引所述「加载期静态展开」成立）",
    !!subOk.def && subOk.def.steps.length === 1 && subOk.def.steps[0].id === "delegate/inner", JSON.stringify(subOk.problems));
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

  // 行为侧 6：验证者配置收敛 —— 指引只介绍 model，不再出现已删除字段
  check("指引不再出现 adversarial_check.agent", !CREATE_GUIDE.includes("adversarial_check.agent") && !/\bagent:\s*spawn/.test(CREATE_GUIDE));
  check("指引不再出现 system_prompt", !CREATE_GUIDE.includes("system_prompt"));
  check("指引不再出现 timeout_ms", !CREATE_GUIDE.includes("timeout_ms"));
  check("指引写明 adversarial_check 只允许 model 一个字段", CREATE_GUIDE.includes("只允许 model"), CREATE_GUIDE.slice(0, 500));
  check("指引写明验证者身份是 Ralphflow 内部定义", CREATE_GUIDE.includes("内部定义"));
  check("指引写明未覆盖时回退发起会话当前模型", CREATE_GUIDE.includes("发起会话当前模型"));
  // 行为侧 7：指引示例里的 adversarial_check 确实只写 model 也能加载启动
  const acGuide = guideFile("guide-ac", ["adversarial_check:", "  model: deepseek/deepseek-chat", "steps:", "  - id: a", "    do: X", "    check: c", "    on_pass: done", "    on_fail: a", "    max_fail_count: 1"]);
  check("指引所述 adversarial_check 写法可加载且无告警", !!acGuide.def && acGuide.problems.length === 0 && acGuide.warnings.length === 0, JSON.stringify(acGuide));
}

// ── 17) 无 check 的步骤：跳过对抗性验证（与 opencode 对齐；design §12.1 精修）──────
// 四格真值表的**后两格**：无 check + 非 manual → 直接 on_pass；
//                    无 check + manual   → 停在审查门（纯人工审查）。
// 前两格（有 check）是回归基线，本文件其它小节已覆盖（#5/#6 的 spec 门、#1/#2 的 loop）。
{
  const wfFile = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };

  // ── 判据谓词本身（纯函数，只读 StepDef）──
  check("stepHasCheck: 非空字符串 → true", stepHasCheck({ check: "核对 X" }) === true);
  check("stepHasCheck: 缺省/空串/空白 → false",
    stepHasCheck({}) === false && stepHasCheck({ check: "" }) === false && stepHasCheck({ check: "   \n " }) === false);
  check("stepHasCheck: 非字符串（YAML 写错）→ false（加载期另有硬错误）", stepHasCheck({ check: true }) === false);

  // ── 17a) 无 check + 非 manual → 跳过验证，直接 on_pass 推进 ──
  const plain = wfFile("skip-plain", [
    "description: 无 check 直接推进", "steps:",
    "  - id: a", "    desc: 免验证步", "    do: 做 A", "    output: a.md",
    "    on_pass: b", "    on_fail: a", "    max_fail_count: 3",
    "  - id: b", "    desc: 有验证步", "    do: 做 B", "    check: 检查 B",
    "    on_pass: done", "    on_fail: b", "    max_fail_count: 3",
  ]);
  check("17a 无 check 工作流可加载（不拒收；lint 提醒该步不被独立验证）",
    !!plain.def && plain.warnings.some((w) => w.includes("`a`") && w.includes("不会被独立验证")), JSON.stringify(plain.warnings));
  {
    const s = S();
    deliveries.length = 0;
    const { r, id } = start("skip-plain", "跳过验证用例", s);
    check("17a 无 check 的 DO 提示词含「不配置对抗性检查」说明",
      r.ok && r.text.includes("不配置对抗性检查") && r.text.includes("跳过对抗性验证"), r.text.slice(-400));
    check("17a 无 check 的 DO 提示词不预告「独立验证者会立刻检查你的产出」",
      !r.text.includes("独立验证者会立刻检查你的产出"), r.text.slice(-300));
    // 首步无 check 时，start 回执的前导句也不得预告一次不会发生的独立验证（诚实标注）
    check("17a start 回执不预告独立验证（不出现「取证判定」）",
      !r.text.includes("取证判定") && r.text.includes("跳过对抗性验证"), r.text.slice(0, 320));
    check("17a start 回执写明「直接进入下一步」",
      r.text.includes("会**跳过对抗性验证**，直接进入下一步"), r.text.slice(0, 320));
    const callsBefore = verifyCalls;
    const sub = submit(s, "A 做完了。");
    await settle();
    const st = engine.readState(id);
    check("17a 验证端口零调用（计数器断言，不是看返回值）", verifyCalls === callsBefore, `calls=${verifyCalls - callsBefore}`);
    check("17a 不写 verdicts[] / 不写 delegations[]", st.verdicts.length === 0 && st.delegations.length === 0, JSON.stringify({ v: st.verdicts.length, d: st.delegations.length }));
    check("17a 直接推进到 on_pass 目标 b", st.current_step === "b" && st.do_submitted === false, `step=${st.current_step}`);
    check("17a 轨迹里有 check_skipped（含步骤 id 与该步未配置 check）",
      st.history.some((h) => h.event === "check_skipped" && h.step === "a" && (h.detail ?? "").includes("未配置")), JSON.stringify(st.history.map((h) => h.event)));
    check("17a 轨迹写明「跳过对抗性验证」且不出现「检查通过」",
      st.history.some((h) => (h.detail ?? "").includes("跳过对抗性验证")) && !JSON.stringify(st.history).includes("检查通过"),
      JSON.stringify(st.history.filter((h) => h.step === "a").map((h) => h.detail)));
    check("17a 交卷回执写明「跳过对抗性验证」", sub.ok && sub.text.includes("跳过对抗性验证"), sub.text);
    check("17a 通知写明「跳过对抗性验证」", deliveries.some((t) => t.includes("跳过对抗性验证")), deliveries.at(-1)?.slice(-200));
    // 推进到 b 的 DO 提示词是**有 check** 的：不得含无 check 的说明（验收 7 的反向断言）
    check("17a 有 check 的步骤 DO 提示词不含「不配置对抗性检查」",
      deliveries.some((t) => t.includes("有验证步")) && !deliveries.filter((t) => t.includes("有验证步")).some((t) => t.includes("不配置对抗性检查")),
      deliveries.filter((t) => t.includes("有验证步")).at(-1)?.slice(-200));
    // 未交卷提醒（模型可见）在有 check 的步骤上**逐字不变**（回归基线）
    const remCheck = engine.remindToSubmit(s);
    check("17a 有 check 的未交卷提醒仍是原文（回归）",
      remCheck.remind === true && remCheck.message.includes("独立验证不会自动开始"), remCheck.message);
    // 诚实标注：任何通知都不得出现「检查通过」
    check("17a 通知里不出现「检查通过」", !deliveries.some((t) => t.includes("检查通过")), deliveries.find((t) => t.includes("检查通过"))?.slice(0, 120));
    // b 步照常验证通过 → 完成并归档
    scripted.push({ status: "passed", reason: "b 独立取证通过" });
    submit(s, "B 做完了。");
    await settle();
    check("17a 后续有 check 的步骤照常验证并完成（实例销毁）", engine.readState(id) === null && !fs.existsSync(engine.instanceDir(id)));
    const report = fs.readFileSync(path.join(engine.reportsDir, `${id}.md`), "utf-8");
    check("17a 归档报告含 check_skipped 与「跳过对抗性验证」", report.includes("check_skipped") && report.includes("跳过对抗性验证"), report.slice(0, 800));
    check("17a 归档报告不出现「检查通过」", !report.includes("检查通过"), report.slice(0, 800));
  }

  // ── 17b) 无 check + manual → 纯人工审查门（停在门，continue 放行）──
  const gate = wfFile("skip-gate", [
    "description: 无 check 的纯人工审查门", "manual_step: [g]", "steps:",
    "  - id: g", "    desc: 纯人工审查步", "    do: 做 G",
    "    on_pass: h", "    on_fail: g", "    max_fail_count: 3",
    "  - id: h", "    desc: 收尾步", "    do: 做 H", "    check: 检查 H",
    "    on_pass: done", "    on_fail: h", "    max_fail_count: 3",
  ]);
  check("17b manual + 无 check → 加载不告警（纯人工审查是刻意默认）",
    !!gate.def && !gate.warnings.some((w) => w.includes("`g`")), JSON.stringify(gate.warnings));
  {
    const s = S();
    deliveries.length = 0;
    const { r, id } = start("skip-gate", "纯人工审查用例", s);
    check("17b 门的 DO 提示词含「不配置对抗性检查」与 continue 放行说明",
      r.ok && r.text.includes("不配置对抗性检查") && r.text.includes("/ralphflow-continue"), r.text.slice(-400));
    // 首步是"无 check 的门"时，start 回执必须说「停在审查门等放行」，不得预告独立验证
    check("17b start 回执不预告独立验证、写明停在审查门",
      !r.text.includes("取证判定") && r.text.includes("停在审查门等你 `/ralphflow-continue` 放行"), r.text.slice(0, 360));
    // 未交卷提醒（模型可见）不得谎称「独立验证不会自动开始」——本步本来就不验证
    const remGate = engine.remindToSubmit(s);
    check("17b 无 check 的未交卷提醒写明跳过对抗性验证",
      remGate.remind === true && remGate.message.includes("跳过对抗性验证") && !remGate.message.includes("独立验证不会自动开始"), remGate.message);
    const callsBefore = verifyCalls;
    submit(s, "G 做完了。");
    await settle();
    let st = engine.readState(id);
    check("17b 验证端口零调用", verifyCalls === callsBefore, `calls=${verifyCalls - callsBefore}`);
    check("17b 不写 verdicts[]（没有验证者就没有判定）", st.verdicts.length === 0, JSON.stringify(st.verdicts));
    check("17b 停在审查门（步骤不变、已交卷、待在飞委派也没有）",
      st.current_step === "g" && st.do_submitted === true && st.delegations.length === 0,
      JSON.stringify({ step: st.current_step, sub: st.do_submitted, d: st.delegations.length }));
    check("17b 轨迹写明「跳过对抗性验证」且不出现「检查通过」",
      st.history.some((h) => h.event === "check_skipped" && (h.detail ?? "").includes("跳过对抗性验证")) && !JSON.stringify(st.history).includes("检查通过"),
      JSON.stringify(st.history.filter((h) => h.step === "g").map((h) => h.detail)));
    check("17b 门提示写明「跳过对抗性验证」+ 纯人工审查",
      deliveries.some((t) => t.includes("跳过对抗性验证") && t.includes("审查门") && t.includes("纯人工审查")), deliveries.at(-1)?.slice(-260));
    check("17b 通知里不出现「检查通过」", !deliveries.some((t) => t.includes("检查通过")));

    // 同一份内容重复交卷（无 check）：回执必须说「未重复受理」，不能说「未重复验证」（本步没有验证）
    const callsBeforeIdentical = verifyCalls;
    const dup = submit(s, "G 做完了。");
    check("17b 重复交卷回执不谎称「未重复验证」（无 check 用「未重复受理」）",
      !dup.ok && dup.text.includes("未重复受理") && !dup.text.includes("未重复验证"), dup.text);
    check("17b 重复交卷未改状态、未验证",
      verifyCalls === callsBeforeIdentical && engine.readState(id).current_step === "g" && engine.readState(id).verdicts.length === 0,
      JSON.stringify({ calls: verifyCalls - callsBeforeIdentical }));

    // 零新状态字段：InstanceState 的落盘字段集合与改造前完全相同（宪法 §10.4）
    const PRE_CHANGE_PERSISTED_FIELDS = [
      "active", "artifacts_dir_name", "current_step", "delegations", "do_submitted", "fail_counts", "history",
      "last_submit_summary", "owner_session", "paused", "pause_reason", "started_at", "updated_at", "user_task",
      "verdicts", "workflow_name",
    ];
    const rawKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(engine.instanceDir(id), "state.json"), "utf-8")));
    check("17b 零新状态字段：落盘键全属改造前集合", rawKeys.every((k) => PRE_CHANGE_PERSISTED_FIELDS.includes(k)), rawKeys.join(","));
    check("17b 零新状态字段：没有 skipped_steps / 任何 skip 派生字段", !rawKeys.some((k) => /skip/i.test(k)), rawKeys.join(","));
    check("17b 零新状态字段：改造前的字段一个不少（除未触发的可选 pause_reason）",
      PRE_CHANGE_PERSISTED_FIELDS.filter((k) => k !== "pause_reason").every((k) => rawKeys.includes(k)), rawKeys.join(","));

    // 用户可见的状态提示也必须诚实（不得宣称「会再次验证」）
    const stText = engine.statusOf(s).text;
    check("17b status 提示写明跳过对抗性验证且不谎称会再次验证",
      stText.includes("跳过对抗性验证") && !stText.includes("再次验证") && !stText.includes("检查通过"), stText.slice(-300));

    // 门上改稿重交（无 check）：仍停在门、仍不验证、仍不产生判定
    const callsBeforeResubmit = verifyCalls;
    const sub2 = submit(s, "G 改了一版。");
    await settle();
    const st2 = engine.readState(id);
    check("17b 门上重交仍停在门、仍不验证、仍不产生判定",
      sub2.ok && verifyCalls === callsBeforeResubmit && st2.current_step === "g" && st2.do_submitted === true && st2.verdicts.length === 0,
      JSON.stringify({ ok: sub2.ok, calls: verifyCalls - callsBeforeResubmit, step: st2.current_step, v: st2.verdicts.length }));
    check("17b 重交回执写明「跳过对抗性验证」", sub2.text.includes("跳过对抗性验证"), sub2.text);

    const c = engine.continueInstance(s);
    st = engine.readState(id);
    check("17b /ralphflow-continue 放行推进到 h（不需要判定）", c.ok && st.current_step === "h", `ok=${c.ok} step=${st.current_step}`);
    check("17b 放行回执写明「跳过对抗性验证」", c.text.includes("跳过对抗性验证"), c.text);
    check("17b 放行后仍未产生任何判定", st.verdicts.length === 0, JSON.stringify(st.verdicts));
    check("17b 放行记入轨迹（gate_released + check_skipped）",
      st.history.some((h) => h.event === "gate_released" && h.step === "g") && st.history.some((h) => h.event === "check_skipped" && h.step === "g"),
      st.history.map((h) => h.event).join("→"));
    scripted.push({ status: "passed", reason: "h 独立取证通过" });
    submit(s, "H 做完了。");
    await settle();
    check("17b 后续有 check 的步骤照常验证并完成（实例销毁）", engine.readState(id) === null && !fs.existsSync(engine.instanceDir(id)));
    const report = fs.readFileSync(path.join(engine.reportsDir, `${id}.md`), "utf-8");
    check("17b 归档报告含「跳过对抗性验证」", report.includes("跳过对抗性验证"), report.slice(0, 800));
    check("17b 归档报告不出现「检查通过」", !report.includes("检查通过"), report.slice(0, 800));
  }

  // ── 17c) 兜底配方退役：buildCheckPrompt 收到无 check 的步骤必须明确失败 ──
  const wfStub = { name: "w", steps: [], manual_step: [], warnings: [] };
  const reqOf = (step) => ({
    instId: "x", step, workflow: wfStub, userTask: "任务",
    checkIndex: 0, artifactsRelDir: ".dsh/ralph-flow/artifacts/x", signal: new AbortController().signal,
  });
  let threw = null;
  try { buildCheckPrompt(reqOf({ id: "a", do: "X" }), true); } catch (e) { threw = e; }
  check("17c 无 check 的步骤 → buildCheckPrompt 明确抛错（不静默产出兜底配方）",
    !!threw && String(threw.message).includes("check"), String(threw));
  const okPrompt = buildCheckPrompt(reqOf({ id: "a", do: "X", check: "检查 x.md" }), true);
  check("17c 有 check 的步骤照常构造 CHECK 提示词（回归）",
    okPrompt.includes("## 检查依据") && okPrompt.includes("检查 x.md"));
  const verifySrc = fs.readFileSync(new URL("../src/verify.ts", import.meta.url), "utf-8");
  check("17c 兜底配方文案已从 verify.ts 退役（不可达即删除）", !verifySrc.includes("未声明检查依据"), verifySrc.length);

  // ── 17d) 全无 check 的单步工作流：整个生命周期（start→交卷→完成→报告）零独立验证承诺 ──
  // 这是「诚实标注」的**类级断言**：不只查某个字符串，而是查这条路径上每一处用户/模型可见输出都
  // 不得出现「取证判定」（独立验证的承诺）或「检查通过」（伪造的事实）。
  wfFile("skip-only", [
    "description: 单步无 check（全程免验证）", "steps:",
    "  - id: only", "    desc: 唯一一步", "    do: 做唯一的事",
    "    on_pass: done", "    on_fail: only", "    max_fail_count: 3",
  ]);
  {
    const s = S();
    deliveries.length = 0;
    const { r, id } = start("skip-only", "全程免验证用例", s);
    const startText = r.text;
    const callsBefore = verifyCalls;
    const sub = submit(s, "唯一的事做完了。");
    await settle();
    const allTexts = [startText, sub.text, ...deliveries];
    check("17d start 回执不出现「取证判定」（不预告不会发生的独立验证）", !startText.includes("取证判定"), startText.slice(0, 300));
    check("17d 交卷回执与全部通知都不出现「取证判定」", !allTexts.slice(1).some((t) => t.includes("取证判定")), allTexts.slice(1).find((t) => t.includes("取证判定"))?.slice(0, 200));
    check("17d 全生命周期零「检查通过」", !allTexts.some((t) => t.includes("检查通过")));
    check("17d 全生命周期至少一处写明「跳过对抗性验证」", allTexts.some((t) => t.includes("跳过对抗性验证")));
    check("17d 验证端口零调用", verifyCalls === callsBefore, `calls=${verifyCalls - callsBefore}`);
    check("17d 单步免验证 → 直接完成并销毁实例", engine.readState(id) === null && !fs.existsSync(engine.instanceDir(id)));
    const report = fs.readFileSync(path.join(engine.reportsDir, `${id}.md`), "utf-8");
    check("17d 归档报告：有 check_skipped、无判定、无独立验证承诺、无「检查通过」",
      report.includes("check_skipped") && report.includes("（无判定记录）") && !report.includes("取证判定") && !report.includes("检查通过"),
      report.slice(0, 800));
  }
}

// ── 清理：引擎已按工作区单根，实例资产都在隔离工作区里，没有全局索引要清理 ──────
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);