/**
 * 子工作流（`workflow:` 代替 `do:`）验收 —— **加载期静态展开**，行为对齐 opencode 的
 * 「子工作流步骤 / 工作流嵌套」两节，落地方式与它刻意不同（见 README / change-note 的四条差异）。
 *
 * 覆盖：
 *   1) 展开面：调用点就地换成子步骤（id = `调用点id/子步骤id`）、出口接调用点的 on_pass、
 *      on_fail 重指、子工作流自己的审查门前缀化、多层嵌套、同一子工作流被多处调用；
 *   2) 运行期：展开后的 id 就是 current_step（端到端跑完）、调用点上的审查门 = 整段跑完停门、
 *      子工作流内部的审查门照常生效、DO 提示词里的任务来自父级（不传参）；
 *   3) 模型下沉：子文件 `adversarial_check.model` → 它各步 `check_model`（投票步 → 缺 model 的票），
 *      没填就逐层回退父级 —— 用验证端口收到的 model 取证，不只看加载出来的定义；
 *   4) 四条刻意差异：加载期硬错误（子文件加载不出来 / 成环 / id 含 `/` / workflow 名含路径分隔符 /
 *      展开后 id 撞名 / 展开前没有出口的调用点被标成审查门）、2000 步上限（展开中计数、立刻中止）、
 *      子步骤耗尽 max_fail_count → 暂停等人（不自动走父级 on_fail）、调用点除 id/desc/do/workflow/on_pass
 *      外逐键告警 + 指路（manual_step 标调用点 = 整段跑完停门）；
 *   5) 回归：内置 loop/spec 零告警、平铺工作流行为不变；零新增 InstanceState 字段（落盘键集合）。
 *   6) **极深调用链**（本次缺陷）：1900 个互相串联、每层零步骤的工作流文件 → 步数上限看不见它，
 *      递归展开器必须给出**说人话的加载期硬错误**（嵌套过深 + 调用链 + 改法），绝不冒泡
 *      `RangeError: Maximum call stack size exceeded`；边界（恰好上限可加载 / 超一层即拒）逐条钉住。
 *   7) 负对照：`buildPluginCopy` 按锚点把「调用点识别」还原成「没有子工作流」、把「嵌套深度闸」
 *      摘掉 → **同一批判据必须为假**（摘掉深度闸后 1900 链重新变成 RangeError 崩溃）；
 *      也支持 `RF_LIB=<基线 lib 目录>` 跑同一支测试（正判据应当失败）。
 *   8) **调用点的 `do` 生效**（本次任务）：下沉到子步骤的 `task` ——「## 任务」=「这段子工作流要
 *      做什么」；同一个子工作流被两个调用点以不同 `do` 调用 → 两次展开各拿各自的 `do`；
 *      调用点不写 `do` → 回落父级任务（向后兼容）；嵌套**最内层优先、外层继承**；
 *      DO 与 CHECK 的「## 任务」同源；`inputs` 仍告警但文案指路到调用点的 `do`；
 *      附负对照（按锚点还原「不下沉」→ 同一批判据为假）。
 *
 * 纪律：一律 `mkdtempSync` 造工作区 + 隔离 `process.env.HOME`；绝不读写真实 ~/.dsh 或真实工作区。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPluginCopy } from "./helpers/reverted-build.mjs";

import { deliveryPorts } from "./helpers/ports.mjs";
// HOME 隔离：全局工作流目录在 ~/.dsh 下，测试绝不读写真实 HOME（必须在建引擎前设置）。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 被测库：缺省本仓库 lib/；负对照时指向「还原实现」的基线 lib（RF_LIB） */
const LIB = process.env.RF_LIB ? path.resolve(process.env.RF_LIB) : path.join(HERE, "..", "lib");
const { createEngine, MAX_EXPANDED_STEPS, MAX_SUBWORKFLOW_DEPTH, SUBWORKFLOW_ID_SEP } = await import(pathToFileURL(path.join(LIB, "engine.js")).href);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** 取加载结果的步骤列表；`def` 为 null（拒收）时给空数组 —— 负对照跑基线库时断言失败而不是抛异常 */
const stepsOf = (r) => r?.def?.steps ?? [];

/**
 * 调用点「某键不生效」告警的**精确**判据：文案头是 `调用点 \`id\` 的 \`key\` 不生效：…`。
 *
 * 为什么不用 `includes(key) && includes("不生效")` 的宽松写法：告警正文会**指路**提到别的键
 * （实测 `inputs` 的文案指向 `do`），宽松判据会让「`do` 已不再告警」这条负判据被别的告警蒙混过关。
 */
const callKeyNotEffective = (w, callId, key) => w.startsWith(`调用点 \`${callId}\` 的 \`${key}\` 不生效：`);

/** 改造前就有的落盘字段白名单（零新增 InstanceState 字段的判据） */
const PRE_CHANGE_PERSISTED_FIELDS = [
  "active", "artifacts_dir_name", "current_step", "delegations", "do_submitted", "fail_counts", "history",
  "last_submit_summary", "owner_session", "paused", "pause_reason", "started_at", "updated_at", "user_task",
  "verdicts", "workflow_name",
];

/** 造一个隔离工作区 + 引擎（脚本化验证端口；记录每笔委派的 step/model 供取证） */
function mkEngine(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rf-subwf-${tag}-`));
  const state = { dir, deliveries: [], scripted: [], verifyReqs: [], calls: 0 };
  const engine = createEngine(dir, {
    ...deliveryPorts(state.deliveries),
    verify: async (req) => {
      state.calls++;
      state.verifyReqs.push({ step: req.step.id, model: req.model, checkIndex: req.checkIndex, task: req.userTask });
      const v = state.scripted.shift();
      if (!v) throw new Error("no scripted verdict");
      return { check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...v };
    },
    log: () => {},
  });
  engine.ensureLayout();
  state.engine = engine;
  state.wf = (name, lines) => {
    fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
    return engine.loadWorkflow(name);
  };
  state.newestId = () => engine.listInstances().sort((a, b) => (a.state.started_at > b.state.started_at ? 1 : -1)).at(-1)?.id;
  state.start = (wf, task, sid) => { const r = engine.start(wf, task, sid); return { r, id: state.newestId() }; };
  state.gone = (id) => !!id && engine.readState(id) === null && !fs.existsSync(engine.instanceDir(id));
  return state;
}

let n = 0;
const S = () => `subwf-session-${++n}`;

// ═══ 1) 加载期静态展开：调用点 → 一串前缀化的普通步骤 ═══════════════════════════
console.log("\n1) 加载期静态展开（id 前缀、出口接线、审查门映射、模型下沉）");
const A = mkEngine("expand");
{
  A.wf("child", [
    "steps:",
    "  - id: c1", "    input: 上游产出", "    output: 本步产出", "    desc: 子一步", "    do: 做 C1", "    check: 查 C1",
    "    on_pass: c2", "    on_fail: c1", "    max_fail_count: 2",
    "  - id: c2", "    input: 上游产出", "    output: 本步产出", "    desc: 子二步", "    do: 做 C2", "    check: 查 C2",
    "    on_pass: done", "    on_fail: c1", "    max_fail_count: 2",
  ]);
  const parent = A.wf("parent", [
    "description: 父级", "adversarial_check:", "  model: anthropic/claude-haiku",
    "manual_step: [delegate]", "steps:",
    "  - id: pre", "    input: 上游产出", "    output: 本步产出", "    desc: 前置", "    do: 做 P", "    check: 查 P",
    "    on_pass: delegate", "    on_fail: pre", "    max_fail_count: 3",
    "  - id: delegate", "    on_pass: post", "    desc: 委托段", "    workflow: child",
    "    input: 不该生效的输入标记", "    output: 不该生效的产物标记", "    check: 不该生效的检查标记",
    "    on_fail: pre", "    max_fail_count: 9",
    "  - id: post", "    input: 上游产出", "    output: 本步产出", "    desc: 收尾", "    do: 做 Q", "    check: 查 Q",
    "    on_pass: done", "    on_fail: post", "    max_fail_count: 3",
  ]);
  check("父级可加载（调用点不再因缺 do 被拒）", !!parent.def && parent.problems.length === 0, JSON.stringify(parent.problems));
  const ids = stepsOf(parent).map((s) => s.id);
  check("调用点被就地展开成子步骤（id 前缀 `调用点id/子步骤id`）",
    ids.join(",") === `pre,delegate${SUBWORKFLOW_ID_SEP}c1,delegate${SUBWORKFLOW_ID_SEP}c2,post`, ids.join(","));
  check("加载出来的定义里不再有任何 `workflow` 字段（调用点已被消化）",
    stepsOf(parent).every((s) => !Object.prototype.hasOwnProperty.call(s, "workflow")));
  check("指向调用点的 on_pass 接到展开后的入口步骤", stepsOf(parent)[0]?.on_pass === "delegate/c1", stepsOf(parent)[0]?.on_pass);
  check("子工作流的出口接到调用点的有效 on_pass（缺省 = 紧随其后的兄弟步骤）",
    stepsOf(parent).find((s) => s.id === "delegate/c2")?.on_pass === "post");
  check("子步骤的 on_fail 在子工作流内部重指（不越出子工作流）",
    stepsOf(parent).find((s) => s.id === "delegate/c2")?.on_fail === "delegate/c1");
  check("调用点的 desc 保留：与子步骤 desc 组合显示",
    stepsOf(parent).find((s) => s.id === "delegate/c1")?.desc === "委托段 · 子一步");
  check("manual_step 标调用点 → 映射到子工作流出口（整段跑完后停门）",
    (parent.def?.manual_step ?? []).join(",") === "delegate/c2", (parent.def?.manual_step ?? []).join(","));
  const callWarns = parent.warnings.filter((w) => w.includes("调用点 `delegate`"));
  check("调用点上**不生效**的键只剩 `check`（其余键都是调用点接受并校验的）",
    callWarns.length === 1 && callKeyNotEffective(callWarns[0], "delegate", "check")
    && callWarns[0].includes("子工作流内"),
    JSON.stringify(parent.warnings));
  check("调用点**接受**的键不再告警（desc/input/output/on_pass/on_fail/max_fail_count）",
    ["desc", "input", "output", "on_pass", "on_fail", "max_fail_count"].every((k) => !callWarns.some((w) => callKeyNotEffective(w, "delegate", k))),
    JSON.stringify(callWarns));
  check("调用点上的 max_fail_count / check 确实不生效（没被带进任何展开后的步骤）",
    !stepsOf(parent).some((s) => s.max_fail_count === 9 || (s.check ?? "").includes("不该生效"))
    && stepsOf(parent).every((s) => !(s.check ?? "").includes("不该生效")),
    JSON.stringify(stepsOf(parent).map((s) => [s.id, s.max_fail_count, s.check])));
  check("子工作流各步自己的 do/check/max_fail_count 原样进定义",
    stepsOf(parent).find((s) => s.id === "delegate/c1")?.max_fail_count === 2
    && stepsOf(parent).find((s) => s.id === "delegate/c1")?.check === "查 C1");
  check("父级自己的全局验证模型不变（子层靠下沉，不靠改父级）",
    parent.def?.adversarial_check?.model === "anthropic/claude-haiku");

  // 出口 = done（调用点是末步、且没写 on_pass）
  const tailCall = A.wf("tail-call", ["steps:",
    "  - id: a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    max_fail_count: 3", "    desc: 前", "    do: 做 A", "    check: 查 A", "    on_pass: call",
    "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: child"]);
  check("调用点是末步且无 on_pass → 子工作流出口 = done",
    stepsOf(tailCall).at(-1)?.on_pass === "done", JSON.stringify(stepsOf(tailCall).map((s) => [s.id, s.on_pass])));

  // 子工作流中途 `on_pass: done`：提前出口也接到调用点的 on_pass；子工作流的 lint 告警带前缀上浮
  A.wf("early", ["steps:",
    "  - id: e1", "    desc: 步骤 e1", "    input: 上游产出", "    output: 本步产出", "    on_fail: e1", "    max_fail_count: 3", "    do: 做 E1", "    check: 查 E1", "    on_pass: done",
    "  - id: e2", "    desc: 步骤 e2", "    input: 上游产出", "    output: 本步产出", "    on_fail: e2", "    max_fail_count: 3", "    do: 做 E2", "    check: 查 E2", "    on_pass: done"]);
  const early = A.wf("uses-early", ["steps:",
    "  - id: call", "    input: 上游产出", "    output: 本步产出", "    on_pass: after", "    on_fail: call", "    max_fail_count: 3", "    desc: 早退子流程", "    workflow: early",
    "  - id: after", "    desc: 步骤 after", "    input: 上游产出", "    output: 本步产出", "    on_fail: after", "    max_fail_count: 3", "    do: 做 After", "    check: 查 After", "    on_pass: done"]);
  check("子工作流中途 `on_pass: done` → 该步就是出口，接到调用点的 on_pass",
    stepsOf(early).find((s) => s.id === "call/e1")?.on_pass === "after");
  check("子工作流自己的 lint 告警带子工作流名前缀上浮（不静默）",
    early.warnings.some((w) => w.includes("子工作流 `early`：") && w.includes("不可达")),
    JSON.stringify(early.warnings));

  // 同一子工作流被两个调用点引用 → 各展开一份，id 不撞
  const twice = A.wf("twice", ["steps:",
    "  - id: first", "    desc: 步骤 first", "    input: 上游产出", "    output: 本步产出", "    on_pass: second", "    on_fail: first", "    max_fail_count: 3", "    workflow: child",
    "  - id: second", "    desc: 步骤 second", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: second", "    max_fail_count: 3", "    workflow: child"]);
  check("同一子工作流被两个调用点引用 → 各展开一份（id 前缀区分）",
    stepsOf(twice).map((s) => s.id).join(",") === "first/c1,first/c2,second/c1,second/c2"
    && stepsOf(twice).find((s) => s.id === "first/c2")?.on_pass === "second/c1"
    && stepsOf(twice).at(-1)?.on_pass === "done",
    JSON.stringify(stepsOf(twice).map((s) => [s.id, s.on_pass])));
}

// ═══ 2) 多层嵌套 + 验证模型逐字段继承（下沉到 check_model / 票 model）═══════════
console.log("\n2) 多层嵌套 + `adversarial_check.model` 下沉与继承");
{
  A.wf("deep", ["steps:", "  - id: d1", "    input: 上游产出", "    output: 本步产出", "    on_fail: d1", "    max_fail_count: 3", "    desc: 深一步", "    do: 做 D", "    check: 查 D", "    on_pass: done"]);
  A.wf("mid", [
    "adversarial_check:", "  model: openai/gpt-5", "manual_step: [m2]", "steps:",
    "  - id: m1", "    input: 上游产出", "    output: 本步产出", "    on_fail: m1", "    max_fail_count: 3", "    desc: 中部一步", "    do: 做 M", "    check: 查 M", "    on_pass: m2",
    "  - id: m2", "    input: 上游产出", "    output: 本步产出", "    on_fail: m2", "    max_fail_count: 3", "    desc: 中部二步", "    do: 做 M2", "    check: 查 M2", "    on_pass: mdelegate",
    "  - id: mdelegate", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: mdelegate", "    max_fail_count: 3", "    desc: 深调用", "    workflow: deep",
  ]);
  A.wf("deeper", ["steps:", "  - id: e1", "    desc: 步骤 e1", "    input: 上游产出", "    output: 本步产出", "    on_fail: e1", "    max_fail_count: 3", "    do: 做 E", "    check: 查 E", "    on_pass: done"]);
  const top = A.wf("top", [
    "adversarial_check:", "  model: anthropic/claude-haiku", "steps:",
    "  - id: pre", "    input: 上游产出", "    output: 本步产出", "    on_fail: pre", "    max_fail_count: 3", "    desc: 前置", "    do: 做 P", "    check: 查 P", "    on_pass: midcall",
    "  - id: midcall", "    input: 上游产出", "    output: 本步产出", "    on_pass: direct", "    on_fail: midcall", "    max_fail_count: 3", "    desc: 中段", "    workflow: mid",
    "  - id: direct", "    input: 上游产出", "    output: 本步产出", "    on_pass: tail", "    on_fail: direct", "    max_fail_count: 3", "    desc: 直调无模型子流程", "    workflow: deeper",
    "  - id: tail", "    input: 上游产出", "    output: 本步产出", "    on_fail: tail", "    max_fail_count: 3", "    desc: 尾", "    do: 做 T", "    check: 查 T", "    on_pass: done",
  ]);
  const ids = stepsOf(top).map((s) => s.id);
  check("多层嵌套 id 逐层叠加（调用链在 id 里可读）",
    ids.join(",") === "pre,midcall/m1,midcall/m2,midcall/mdelegate/d1,direct/e1,tail", ids.join(","));
  const byId = (id) => stepsOf(top).find((s) => s.id === id);
  check("子工作流中途的调用点：出口接到父级调用点的出口（跨层接线）",
    byId("midcall/m2")?.on_pass === "midcall/mdelegate/d1" && byId("midcall/mdelegate/d1")?.on_pass === "direct/e1",
    JSON.stringify([byId("midcall/m2")?.on_pass, byId("midcall/mdelegate/d1")?.on_pass]));
  check("子文件里的 adversarial_check.model 下沉到它各步的 check_model",
    byId("midcall/m1")?.check_model === "openai/gpt-5" && byId("midcall/m2")?.check_model === "openai/gpt-5");
  check("深层子工作流没填 model → 逐层回退到最近一层填了的（mid 的 gpt-5）",
    byId("midcall/mdelegate/d1")?.check_model === "openai/gpt-5");
  check("直接调用的无模型子工作流 → 回退到最外层父级的 model（下沉保证子层不丢）",
    byId("direct/e1")?.check_model === "anthropic/claude-haiku");
  check("父级自己的步骤不被下沉改动（仍走工作流级兜底）", byId("pre")?.check_model === undefined);
  check("子工作流自己的 manual_step 前缀化后原样生效（子流程内部的审查门）",
    (top.def?.manual_step ?? []).join(",") === "midcall/m2", (top.def?.manual_step ?? []).join(","));

  // 投票步：下沉进缺 model 的票，票自己的 model 优先
  A.wf("vote-sub", [
    "adversarial_check:", "  model: openai/gpt-5", "steps:",
    "  - id: v1", "    desc: 步骤 v1", "    input: 上游产出", "    output: 本步产出", "    on_fail: v1", "    max_fail_count: 3", "    do: 做 V", "    on_pass: done",
    "    check_voting:",
    "      - check: 视角一",
    "      - check: 视角二",
    "        model: vendor/special",
  ]);
  const voteHost = A.wf("vote-host", ["steps:",
    "  - id: vcall", "    desc: 步骤 vcall", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: vcall", "    max_fail_count: 3", "    workflow: vote-sub"]);
  const voting = stepsOf(voteHost)[0];
  check("投票步：子文件的 model 下沉进缺 model 的票，票自己的 model 优先",
    voting?.check_voting?.length === 2
    && voting.check_voting[0]?.model === "openai/gpt-5"
    && voting.check_voting[1]?.model === "vendor/special",
    JSON.stringify(voting?.check_voting));
  check("投票步不会被误塞 check_model（与 check_voting 互斥的硬规则不被下沉破坏）",
    voting?.check_model === undefined);
}

// ═══ 3) 运行期：展开后的 id 就是 current_step（端到端 + 两种审查门）═══════════════
console.log("\n3) 运行期：current_step 就是展开后的 id（端到端 / 审查门 / 暂停）");
{
  const B = mkEngine("runtime");
  B.wf("child", [
    "adversarial_check:", "  model: openai/gpt-5", "steps:",
    "  - id: c1", "    input: 上游产出", "    output: 本步产出", "    desc: 子一步", "    do: 做 C1", "    check: 查 C1", "    on_pass: c2", "    on_fail: c1", "    max_fail_count: 2",
    "  - id: c2", "    input: 上游产出", "    output: 本步产出", "    desc: 子二步", "    do: 做 C2", "    check: 查 C2", "    on_pass: done", "    on_fail: c1", "    max_fail_count: 2",
  ]);
  B.wf("host-plain", [
    "adversarial_check:", "  model: anthropic/claude-haiku", "steps:",
    "  - id: pre", "    input: 上游产出", "    output: 本步产出", "    desc: 前置", "    do: 做 P", "    check: 查 P", "    on_pass: delegate", "    on_fail: pre", "    max_fail_count: 3",
    "  - id: delegate", "    input: 上游产出", "    output: 本步产出", "    on_pass: post", "    on_fail: delegate", "    max_fail_count: 3", "    desc: 委托段", "    workflow: child",
    "  - id: post", "    input: 上游产出", "    output: 本步产出", "    desc: 收尾", "    do: 做 Q", "    check: 查 Q", "    on_pass: done", "    on_fail: post", "    max_fail_count: 3",
  ]);
  const sid = S();
  const { r, id } = B.start("host-plain", "父子工作流端到端任务", sid);
  check("启动即落在展开后的第一步（调用点不是一步）",
    r.ok && B.engine.readState(id)?.current_step === "pre" && r.text.includes("共 4 步"), r.text.slice(0, 200));
  check("DO 提示词里的任务来自父级（子工作流不接收参数，inputs 也不生效）",
    r.text.includes("父子工作流端到端任务"));
  const seq = [B.engine.readState(id)?.current_step];
  for (const [i, v] of [
    { status: "passed", reason: "pre 通过" },
    { status: "passed", reason: "子一步通过" },
    { status: "passed", reason: "子二步通过" },
    { status: "passed", reason: "post 通过" },
  ].entries()) {
    B.scripted.push(v);
    B.engine.onSubmit(sid, `第 ${i + 1} 步交卷`);
    await sleep();
    const st = B.engine.readState(id);
    if (st) seq.push(st.current_step);
  }
  check("current_step 依次走过展开后的 id（调用点消失、子步骤就位）",
    seq.join(" → ") === "pre → delegate/c1 → delegate/c2 → post", seq.join(" → "));
  check("验证端口收到的就是展开后的步 id（委派不经过任何「子实例」）",
    B.verifyReqs.map((q) => q.step).join(",") === "pre,delegate/c1,delegate/c2,post",
    JSON.stringify(B.verifyReqs));
  check("进入子工作流时 DO 提示词带上组合后的 desc（调用点的 desc 没丢）",
    B.deliveries.some((t) => t.includes("delegate/c1") && t.includes("委托段 · 子一步")),
    B.deliveries.find((t) => t.includes("delegate/c1"))?.slice(0, 200));
  check("端到端跑完后实例销毁、报告归档",
    B.gone(id) && fs.existsSync(path.join(B.engine.reportsDir, `${id}.md`)));
  const reportFile = path.join(B.engine.reportsDir, `${id}.md`);
  const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf-8") : "";
  check("归档报告里的步骤 id 是展开后的 id（报告可复盘）",
    report.includes("delegate/c1") && report.includes("delegate/c2"), report.slice(0, 400) || "(无报告)");

  // 调用点上的审查门 = 整段子工作流跑完后停门；放行后进 post
  const C = mkEngine("gate");
  C.wf("gchild", ["steps:",
    "  - id: g1", "    desc: 步骤 g1", "    input: 上游产出", "    output: 本步产出", "    do: 做 G1", "    check: 查 G1", "    on_pass: g2", "    on_fail: g1", "    max_fail_count: 3",
    "  - id: g2", "    desc: 步骤 g2", "    input: 上游产出", "    output: 本步产出", "    do: 做 G2", "    check: 查 G2", "    on_pass: done", "    on_fail: g2", "    max_fail_count: 3"]);
  C.wf("ghost", ["manual_step: [call]", "steps:",
    "  - id: pre", "    desc: 步骤 pre", "    input: 上游产出", "    output: 本步产出", "    do: 做 P", "    check: 查 P", "    on_pass: call", "    on_fail: pre", "    max_fail_count: 3",
    "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: post", "    on_fail: call", "    max_fail_count: 3", "    workflow: gchild",
    "  - id: post", "    desc: 步骤 post", "    input: 上游产出", "    output: 本步产出", "    do: 做 Q", "    check: 查 Q", "    on_pass: done", "    on_fail: post", "    max_fail_count: 3"]);
  const gsid = S();
  const gs = C.start("ghost", "调用点审查门用例", gsid);
  for (const v of [{ status: "passed", reason: "pre 通过" }, { status: "passed", reason: "g1 通过" }, { status: "passed", reason: "g2 通过" }]) {
    C.scripted.push(v);
    C.engine.onSubmit(gsid, `交卷 ${C.engine.readState(gs.id)?.current_step}`);
    await sleep();
  }
  const gst = C.engine.readState(gs.id);
  check("调用点上的审查门在**子工作流出口**打开（不是进子流程前）",
    gst?.current_step === "call/g2" && gst.do_submitted === true && gst.delegations.length === 0,
    JSON.stringify({ step: gst?.current_step, sub: gst?.do_submitted }));
  check("停门通知写明是 call/g2 这个出口步骤停在审查门",
    C.deliveries.some((t) => t.includes("call/g2") && t.includes("审查门")),
    C.deliveries.filter((t) => t.includes("审查门")).at(-1)?.slice(0, 200));
  check("门口的 status 提示是「等你放行」而不是「会再次验证」",
    C.engine.statusOf(gsid).text.includes("等你放行"), C.engine.statusOf(gsid).text.slice(0, 200));
  C.scripted.push({ status: "passed", reason: "post 通过" });
  const rel = C.engine.continueInstance(gsid);
  C.engine.onSubmit(gsid, "post 交卷");
  await sleep();
  check("放行后从子工作流出口继续到父级下一步（post）", rel.ok, rel.text);
  check("调用点审查门用例最终完成", C.gone(gs.id));

  // 子工作流内部的审查门（子文件自己的 manual_step）
  const D = mkEngine("subgate");
  D.wf("gated", ["manual_step: [in1]", "steps:",
    "  - id: in1", "    desc: 步骤 in1", "    input: 上游产出", "    output: 本步产出", "    do: 做 I1", "    check: 查 I1", "    on_pass: in2", "    on_fail: in1", "    max_fail_count: 3",
    "  - id: in2", "    desc: 步骤 in2", "    input: 上游产出", "    output: 本步产出", "    do: 做 I2", "    check: 查 I2", "    on_pass: done", "    on_fail: in2", "    max_fail_count: 3"]);
  D.wf("shost", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: gated"]);
  const dsid = S();
  const ds = D.start("shost", "子流程内部审查门", dsid);
  D.scripted.push({ status: "passed", reason: "in1 通过" });
  D.engine.onSubmit(dsid, "in1 交卷");
  await sleep();
  const dst = D.engine.readState(ds.id);
  check("子工作流自己的 manual_step 前缀化后照常生效（停在 call/in1）",
    dst?.current_step === "call/in1" && dst.do_submitted === true, JSON.stringify({ step: dst?.current_step }));
  check("子流程内部的门提示里的步骤 id 是前缀化后的 id（用户不困惑）",
    D.deliveries.some((t) => t.includes("call/in1")), D.deliveries.at(-1)?.slice(0, 200));
  D.scripted.push({ status: "passed", reason: "in2 通过" });
  D.engine.continueInstance(dsid);
  D.engine.onSubmit(dsid, "in2 交卷");
  await sleep();
  check("子流程内部的门放行后跑完（实例销毁）", D.gone(ds.id));

  // 子步骤耗尽 max_fail_count → 暂停等人（刻意差异 3：不自动走父级 on_fail）
  const E = mkEngine("budget");
  E.wf("budget-sub", ["steps:",
    "  - id: f1", "    input: 上游产出", "    output: 本步产出", "    desc: 会失败的子步", "    do: 做 F", "    check: 查 F", "    on_pass: done", "    on_fail: f1", "    max_fail_count: 2"]);
  E.wf("budget-host", ["steps:",
    "  - id: setup", "    input: 上游产出", "    output: 本步产出", "    desc: 父级前置", "    do: 做 S", "    check: 查 S", "    on_pass: call", "    on_fail: setup", "    max_fail_count: 3",
    "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    workflow: budget-sub", "    on_fail: setup", "    max_fail_count: 1"]);
  const esid = S();
  const es = E.start("budget-host", "子步预算耗尽用例", esid);
  E.scripted.push({ status: "passed", reason: "setup 通过" });
  E.engine.onSubmit(esid, "setup 交卷");
  await sleep();
  for (let i = 0; i < 2; i++) {
    E.scripted.push({ status: "failed", reason: `第 ${i + 1} 轮不通过` });
    E.engine.onSubmit(esid, `f1 第 ${i + 1} 轮`);
    await sleep();
  }
  const est = E.engine.readState(es.id);
  check("子步骤耗尽 max_fail_count → 暂停等人（pause_reason=max_failures）",
    est?.paused === true && est.pause_reason === "max_failures" && est.current_step === "call/f1",
    JSON.stringify({ paused: est?.paused, reason: est?.pause_reason, step: est?.current_step }));
  check("失败计数记在**子步骤**头上（不是调用点，也不是父步骤）",
    JSON.stringify(est?.fail_counts) === JSON.stringify({ setup: 0, "call/f1": 2 }), JSON.stringify(est?.fail_counts));
  check("刻意差异 3：绝不自动走父级 on_fail（没有回退到 setup 的轨迹）",
    !(est?.history ?? []).some((h) => h.event === "rework_rewind" && h.detail?.includes("setup")),
    JSON.stringify((est?.history ?? []).map((h) => `${h.event}:${h.detail ?? ""}`)));
  check("调用点的 on_fail/max_fail_count 是必填项、只做引用校验（不再告警「不生效」，也不参与运行）",
    E.engine.loadWorkflow("budget-host").warnings.filter((w) => w.includes("调用点 `call`")).length === 0
    && est?.current_step === "call/f1" && est?.paused === true);

  // 子步骤的 on_fail 在子工作流内部回退
  const F = mkEngine("subfail");
  F.wf("loop-sub", ["steps:",
    "  - id: s1", "    desc: 步骤 s1", "    input: 上游产出", "    output: 本步产出", "    do: 做 S1", "    check: 查 S1", "    on_pass: s2", "    on_fail: s1", "    max_fail_count: 3",
    "  - id: s2", "    desc: 步骤 s2", "    input: 上游产出", "    output: 本步产出", "    do: 做 S2", "    check: 查 S2", "    on_pass: done", "    on_fail: s1", "    max_fail_count: 3"]);
  F.wf("loop-host", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: loop-sub"]);
  const fsid = S();
  const fst0 = F.start("loop-host", "子内回退用例", fsid);
  F.scripted.push({ status: "passed", reason: "s1 通过" });
  F.engine.onSubmit(fsid, "s1 交卷");
  await sleep();
  F.scripted.push({ status: "failed", reason: "s2 挂了，回 s1 重做" });
  F.engine.onSubmit(fsid, "s2 交卷");
  await sleep();
  const fst = F.engine.readState(fst0.id);
  check("子步骤的 on_fail 在子工作流内部回退（call/s2 → call/s1）",
    fst?.current_step === "call/s1"
    && (fst?.history ?? []).some((h) => h.event === "rework_rewind" && h.detail === "call/s2 → call/s1"),
    JSON.stringify({ step: fst?.current_step, hist: (fst?.history ?? []).map((h) => `${h.event}:${h.detail ?? ""}`) }));

  // 零新增 InstanceState 字段
  const rawKeys = fs.existsSync(path.join(F.engine.instanceDir(fst0.id ?? "none"), "state.json"))
    ? Object.keys(JSON.parse(fs.readFileSync(path.join(F.engine.instanceDir(fst0.id), "state.json"), "utf-8")))
    : ["(无 state.json：实例未创建)"];
  check("零新增 InstanceState 字段：落盘键全属改造前集合",
    rawKeys.every((k) => PRE_CHANGE_PERSISTED_FIELDS.includes(k)), rawKeys.join(","));
  check("零新增 InstanceState 字段：没有 sub_workflow / state_stack / parent_state / nesting 之类的新键",
    !rawKeys.some((k) => /sub_?workflow|state_stack|parent_state|nesting|call_stack/i.test(k)), rawKeys.join(","));
}

// ═══ 4) 验证模型真的到了验证者手里（用端口取证，不只看定义）═══════════════════════
console.log("\n4) 验证模型链路：子层下沉的 model 真的发给验证者");
{
  const G = mkEngine("model");
  G.wf("mchild", ["adversarial_check:", "  model: openai/gpt-5", "steps:",
    "  - id: c1", "    desc: 步骤 c1", "    input: 上游产出", "    output: 本步产出", "    on_fail: c1", "    max_fail_count: 3", "    do: 做 C", "    check: 查 C", "    on_pass: done"]);
  G.wf("mhost", ["adversarial_check:", "  model: anthropic/claude-haiku", "steps:",
    "  - id: pre", "    desc: 步骤 pre", "    input: 上游产出", "    output: 本步产出", "    do: 做 P", "    check: 查 P", "    on_pass: call", "    on_fail: pre", "    max_fail_count: 3",
    "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: mchild"]);
  const sid = S();
  const { id } = G.start("mhost", "模型链路用例", sid);
  G.scripted.push({ status: "passed", reason: "pre 通过" }, { status: "passed", reason: "子步通过" });
  G.engine.onSubmit(sid, "pre 交卷");
  await sleep();
  G.engine.onSubmit(sid, "子步交卷");
  await sleep();
  check("父级步骤用父级模型、子工作流步骤用子文件下沉的模型（逐层继承可见）",
    JSON.stringify(G.verifyReqs) === JSON.stringify([
      { step: "pre", model: { providerID: "anthropic", modelID: "claude-haiku" }, checkIndex: 0, task: "模型链路用例" },
      { step: "call/c1", model: { providerID: "openai", modelID: "gpt-5" }, checkIndex: 0, task: "模型链路用例" },
    ]), JSON.stringify(G.verifyReqs));
  check("验证次数 = 展开后的有 check 步骤数（调用点不额外烧一次验证）", G.calls === 2, String(G.calls));
  check("实例跑完销毁", G.gone(id));
}

// ═══ 5) 加载期硬错误（负对照：这些配置必须**拒绝加载**，绝不静默/拖到运行期）════════
console.log("\n5) 加载期硬错误（成环 / 子文件加载不出来 / id 撞展开 / 上限 / 名非法）");
{
  const N = mkEngine("hard");
  const hard = (name, lines, needles) => {
    const r = N.wf(name, lines);
    const ok = !r.def && needles.every((needle) => r.problems.some((p) => p.includes(needle)));
    check(`硬错误：${needles.join(" / ")}`, ok, JSON.stringify({ def: !!r.def, problems: r.problems }));
    return r;
  };
  N.wf("ok-child", ["steps:", "  - id: c1", "    desc: 步骤 c1", "    input: 上游产出", "    output: 本步产出", "    on_fail: c1", "    max_fail_count: 3", "    do: 做 C", "    check: 查 C", "    on_pass: done"]);

  hard("h-missing", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: no-such-workflow"], ["无法加载", "no-such-workflow", "调用链"]);
  N.wf("broken-child", ["steps:", "  - id: b1", "    desc: 步骤 b1", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: b1", "    max_fail_count: 3", "    check: 查 B"]);
  hard("h-broken", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: broken-child"], ["无法加载", "broken-child", "do"]);

  N.wf("cyc-b", ["steps:", "  - id: b1", "    desc: 步骤 b1", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: b1", "    max_fail_count: 3", "    workflow: cyc-a"]);
  hard("cyc-a", ["steps:", "  - id: a1", "    desc: 步骤 a1", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: a1", "    max_fail_count: 3", "    workflow: cyc-b"], ["成环", "cyc-a → cyc-b → cyc-a"]);
  hard("cyc-self", ["steps:", "  - id: s1", "    desc: 步骤 s1", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: s1", "    max_fail_count: 3", "    workflow: cyc-self"], ["成环", "cyc-self → cyc-self"]);

  hard("h-slash-call", ["steps:", "  - id: a/b", "    desc: 步骤 a/b", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: a/b", "    max_fail_count: 3", "    workflow: ok-child"], ["含", SUBWORKFLOW_ID_SEP, "撞名"]);
  const slashChild = N.wf("slash-child", ["steps:", "  - id: c/d", "    desc: 步骤 c/d", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: c/d", "    max_fail_count: 3", "    do: 做 C", "    check: 查 C"]);
  check("子步骤 id 含 `/` 的工作流**单独**加载是允许的（只在被展开时才撞）", !!slashChild.def, JSON.stringify(slashChild.problems));
  hard("h-slash-sub", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: slash-child"], ["含", SUBWORKFLOW_ID_SEP, "撞名"]);

  hard("h-noname", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow:"], ["没有给出要调用的工作流名"]);
  hard("h-nonstring", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: [a, b]"], ["没有给出要调用的工作流名"]);
  hard("h-path", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: ../evil"], ["路径分隔符"]);

  // 展开后 id 撞名：普通步骤 `a/b` + 调用点 `a` 的子步骤 `b`（调用点 id 本身合法，撞的是展开结果）
  N.wf("collide-child", ["steps:", "  - id: b", "    desc: 步骤 b", "    input: 上游产出", "    output: 本步产出", "    on_fail: b", "    max_fail_count: 3", "    do: 做 B", "    check: 查 B", "    on_pass: done"]);
  hard("h-collide", ["steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_pass: a/b", "    on_fail: a", "    max_fail_count: 3", "    workflow: collide-child",
    "  - id: a/b", "    desc: 步骤 a/b", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: a/b", "    max_fail_count: 3", "    do: 做 X", "    check: 查 X"], ["撞名", "a/b"]);

  // 上限：平铺 5000 步 → 必须在第 2001 步立刻中止（报错里的数字就是证据）
  const many = ["steps:"];
  for (let i = 0; i < MAX_EXPANDED_STEPS + 3000; i++) {
    many.push(`  - id: s${i}`, "    desc: 步骤", "    input: 上游产出", "    output: 本步产出", "    do: X", "    check: Y", "    on_pass: done", `    on_fail: s${i}`, "    max_fail_count: 3");
  }
  const capFlat = N.wf("h-cap-flat", many);
  check(`上限：平铺超过 ${MAX_EXPANDED_STEPS} 步 → 加载期硬错误，且在第 ${MAX_EXPANDED_STEPS + 1} 步立刻中止`,
    !capFlat.def
    && capFlat.problems.some((p) => p.includes("超过上限") && p.includes(`第 ${MAX_EXPANDED_STEPS + 1} 步`))
    && !capFlat.problems.some((p) => p.includes(`第 ${MAX_EXPANDED_STEPS + 3000} 步`)),
    JSON.stringify(capFlat.problems));

  // 上限：单个子工作流不超限，但被两个调用点引用后超限 → 展开中计数（复制也算）
  const fat = ["steps:"];
  for (let i = 0; i < 1200; i++) {
    fat.push(`  - id: f${i}`, "    desc: 步骤", "    input: 上游产出", "    output: 本步产出", "    do: X", "    check: Y", "    on_pass: done", `    on_fail: f${i}`, "    max_fail_count: 3");
  }
  const fatChild = N.wf("fat-child", fat);
  check("1200 步的子工作流单独加载不超限", !!fatChild.def, JSON.stringify(fatChild.problems));
  const capExpand = N.wf("h-cap-expand", ["steps:", "  - id: one", "    desc: 步骤 one", "    input: 上游产出", "    output: 本步产出", "    on_pass: two", "    on_fail: one", "    max_fail_count: 3", "    workflow: fat-child", "  - id: two", "    desc: 步骤 two", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: two", "    max_fail_count: 3", "    workflow: fat-child"]);
  check("上限按**展开后**计数：同一子工作流被两处引用（1200×2）→ 立刻中止",
    !capExpand.def && capExpand.problems.some((p) => p.includes("超过上限")), JSON.stringify(capExpand.problems));

  // 调用点被标成审查门，但子工作流永远不回父级 → 门永远不触发 = 硬错误（绝不静默消失）
  N.wf("noexit-child", ["steps:",
    "  - id: n1", "    desc: 步骤 n1", "    input: 上游产出", "    output: 本步产出", "    max_fail_count: 3", "    do: 做 N", "    check: 查 N", "    on_pass: n1", "    on_fail: n1"]);
  hard("h-noexit", ["manual_step: [call]", "steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: noexit-child"], ["审查门永远不会触发"]);

  // doctor / list 把坏定义报出来（不静默）
  const listed = N.engine.listWorkflows().find((w) => w.name === "h-missing");
  check("listWorkflows 把引用坏子工作流的定义标为 invalid（说人话、带到 doctor）",
    listed?.invalid === true && listed.problems.some((p) => p.includes("无法加载")), JSON.stringify(listed));
  check("doctor 输出里有 ❌ 阻塞项", N.engine.diagnose().text.includes("❌"));
}

// ═══ 6) 调用点告警（不是硬错误：告警 + 指路）+ 平铺工作流回归 ═══════════════════════
console.log("\n6) 调用点逐键告警 + 平铺工作流零差异");
{
  const W = mkEngine("warn");
  W.wf("wc", ["steps:", "  - id: c1", "    desc: 步骤 c1", "    input: 上游产出", "    output: 本步产出", "    on_fail: c1", "    max_fail_count: 3", "    do: 做 C", "    check: 查 C", "    on_pass: done"]);
  const warny = W.wf("warny", ["manual_step: [call, tail]", "steps:",
    "  - id: call", "    on_pass: tail", "    desc: 保留的描述", "    workflow: wc",
    "    do: 这段子工作流的任务", "    input: 输入", "    output: 产物", "    on_fail: tail",
    "    max_fail_count: 99", "    check: 不该生效的 check", "    check_model: vendor/x",
    "    inputs:", "      task: 不该生效的参数", "    reset: true", "    weird_key: 1",
    "  - id: tail", "    desc: 步骤 tail", "    input: 上游产出", "    output: 本步产出", "    on_fail: tail", "    max_fail_count: 3", "    do: 做 T", "    check: 查 T", "    on_pass: done"]);
  check("调用点带一堆键仍可加载（告警而非硬错误——作者多半只是写错了层级）", !!warny.def, JSON.stringify(warny.problems));
  const warns = warny.warnings.filter((w) => w.includes("调用点 `call`"));
  // 调用点上**不生效**的键：逐个告警 + 指路（`check` 不是必填项，写在这里仍是配置错误）
  for (const key of ["check", "check_model", "inputs", "weird_key"]) {
    check(`调用点上不生效的 \`${key}\` 逐个告警且指路`,
      warns.some((w) => callKeyNotEffective(w, "call", key)), JSON.stringify(warns));
  }
  // 调用点**接受并校验**的键（六个必填 + `reset` + `do`）：不再告警 —— 必填项若还告警「不生效」就是自相矛盾。
  // `do` 自本次起**生效**（下沉到子步骤的 `task`），它必须有别于上面的「不生效」清单。
  for (const key of ["desc", "input", "output", "on_fail", "max_fail_count", "reset", "do"]) {
    check(`调用点接受 \`${key}\`（不再告警）`, !warns.some((w) => callKeyNotEffective(w, "call", key)), JSON.stringify(warns));
  }
  // `inputs` 仍然不被支持（告警忽略），但文案必须**指路到调用点的 `do`** —— 那才是「这段子工作流
  // 要做什么」的载体，而不是含糊地说「写进任务描述或子步骤的 do」。
  const inputsWarn = warns.find((w) => callKeyNotEffective(w, "call", "inputs"));
  check("`inputs` 仍告警，且文案指路到调用点的 `do`（不再是「写进任务描述」）",
    !!inputsWarn && inputsWarn.includes("`do`") && inputsWarn.includes("## 任务"),
    inputsWarn);
  check("调用点的 `do` 真的生效：下沉成子步骤的任务（不再是「不生效」告警）",
    stepsOf(warny)[0]?.task === "这段子工作流的任务",
    JSON.stringify(stepsOf(warny).map((s) => [s.id, s.task])));
  check("调用点的 desc 真的保留下来（与子步骤 desc 组合成 `调用点desc · 子步骤desc`）",
    stepsOf(warny)[0]?.desc === "保留的描述 · 步骤 c1" && !warns.some((w) => w.startsWith("调用点 `call` 的 `desc`")),
    stepsOf(warny)[0]?.desc);
  check("调用点的 reset: true 生效：下沉到**首个展开后子步骤**并带来源标记（第二个子步骤不动）",
    stepsOf(warny)[0]?.reset === true && stepsOf(warny)[0]?.reset_from_call === "call"
    && stepsOf(warny).slice(1).every((s) => s.reset !== true),
    JSON.stringify(stepsOf(warny).map((s) => ({ id: s.id, reset: s.reset, from: s.reset_from_call }))));
  check("调用点的 on_fail / max_fail_count 不参与运行（展开后由子步骤自己的连线与预算说了算）",
    stepsOf(warny).every((s) => s.max_fail_count !== 99) && stepsOf(warny)[0]?.on_fail === "call/c1",
    JSON.stringify(stepsOf(warny).map((s) => ({ id: s.id, on_fail: s.on_fail, mfc: s.max_fail_count }))));
  check("调用点的 check 没有变成「有 check 的步骤」（展开后仍是子步骤自己的 check）",
    stepsOf(warny).every((s) => !(s.check ?? "").includes("不该生效")));
  check("`check_voting` 写在调用点上不会凭空造出投票步",
    stepsOf(warny).every((s) => s.check_voting === undefined));
  check("manual_step 里的第二个调用点（tail 不是调用点 → 普通门）不误报",
    (warny.def?.manual_step ?? []).includes("call/c1") && (warny.def?.manual_step ?? []).includes("tail"),
    (warny.def?.manual_step ?? []).join(","));

  // 平铺工作流：加载结果与改造前一致（内置 loop/spec 零告警、步数与 id 不变）
  const loop = W.engine.loadWorkflow("loop");
  const spec = W.engine.loadWorkflow("spec");
  check("回归：内置 loop 仍 1 步、零告警、零问题",
    !!loop.def && stepsOf(loop).length === 1 && stepsOf(loop)[0]?.id === "loop"
    && loop.warnings.length === 0 && loop.problems.length === 0, JSON.stringify(loop));
  check("回归：内置 spec 仍 4 步、审查门仍是 propose、零告警",
    !!spec.def && stepsOf(spec).map((s) => s.id).join(",") === "explore,propose,implement,archive"
    && (spec.def?.manual_step ?? []).join(",") === "propose" && spec.warnings.length === 0,
    JSON.stringify({ steps: stepsOf(spec).map((s) => s.id), manual: spec.def?.manual_step, w: spec.warnings }));
  check("回归：平铺工作流的定义里没有凭空多出 check_model（不下沉父级自己的步骤）",
    stepsOf(spec).every((s) => s.check_model === undefined));
}

// ═══ 7) 负对照：还原成「没有子工作流」的构建里，同一批判据必须为假 ═════════════════
console.log("\n7) 负对照（还原实现 → 判据必须为假；锚点找不到就大声失败）");
{
  /** 主判据：展开面是否成立（真 = 当前实现；假 = 还原构建） */
  const expansionCriteria = (engine, wfOf) => {
    wfOf("nc-child", ["steps:", "  - id: c1", "    desc: 步骤 c1", "    input: 上游产出", "    output: 本步产出", "    on_fail: c1", "    max_fail_count: 3", "    do: 做 C", "    check: 查 C", "    on_pass: done"]);
    const r = wfOf("nc-parent", ["steps:", "  - id: call", "    desc: 步骤 call", "    input: 上游产出", "    output: 本步产出", "    on_pass: tail", "    on_fail: call", "    max_fail_count: 3", "    workflow: nc-child", "  - id: tail", "    desc: 步骤 tail", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: tail", "    max_fail_count: 3", "    do: 做 T", "    check: 查 T"]);
    return {
      loads: !!r.def,
      expandedId: r.def?.steps?.[0]?.id === "call/c1",
      exitWired: r.def?.steps?.[0]?.on_pass === "tail",
      noWorkflowField: !!r.def && stepsOf(r).every((s) => !("workflow" in s)),
    };
  };
  const critTrue = expansionCriteria(A.engine, A.wf);
  check("正对照：当前实现里展开判据全部为真",
    critTrue.loads && critTrue.expandedId && critTrue.exitWired && critTrue.noWorkflowField, JSON.stringify(critTrue));

  // 子进程不重复造还原构建（避免套娃）：它只负责「同一批用例跑还原库必须失败」
  if (!process.env.RF_SUBWF_CHILD) {
    const rev = buildPluginCopy({
      "engine.ts": (src) => {
        const anchor = 'const isCall = Object.prototype.hasOwnProperty.call(s, "workflow");';
        if (!src.includes(anchor)) throw new Error("负对照锚点（调用点识别）不见了 —— 实现被改写，请同步更新本负对照");
        return src.replace(anchor, "const isCall = false; // 负对照：还原为「本版本没有子工作流」");
      },
    }, "subworkflow-off");
    const revLib = await import(pathToFileURL(path.join(rev.dir, "lib", "engine.js")).href);
    const revEngine = revLib.createEngine(rev.dir + "-ws", {
      ...deliveryPorts(),
      verify: async () => { throw new Error("负对照不该走到验证"); },
      log: () => {},
    });
    revEngine.ensureLayout();
    const wfOf = (name, lines) => {
      fs.writeFileSync(path.join(revEngine.workflowsDir, `${name}.yaml`), lines.join("\n"));
      return revEngine.loadWorkflow(name);
    };
    const critFalse = expansionCriteria(revEngine, wfOf);
    check("负对照：还原构建里同一批判据为假（调用点不再展开、按缺 do 拒收）",
      !critFalse.loads && !critFalse.expandedId && !critFalse.exitWired && !critFalse.noWorkflowField,
      JSON.stringify(critFalse));
    check("负对照：还原构建的拒收理由就是「缺少 do」（证明差异来自本次实现）",
      !critFalse.loads, JSON.stringify(critFalse));

    // 负对照（整支用例）：`RF_LIB=<还原 lib>` 跑同一支测试 → 必须非零退出且确有失败判据
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, RF_LIB: path.join(rev.dir, "lib"), RF_SUBWF_CHILD: "1" },
      encoding: "utf-8",
    });
    const childOut = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    check("负对照（RF_LIB）：同一支测试跑还原库 → 非零退出且确有失败判据",
      child.status !== 0 && childOut.includes("✗") && /(\d+) failed/.test(childOut),
      `status=${child.status} tail=${childOut.slice(-400)}`);
    rev.cleanup();
  }
}

// ═══ 8) 极深调用链：递归展开器的栈保护（说人话的硬错误，绝不 RangeError 崩溃）════════
// 缺陷原文：1900 个互相串联、**每层零步骤**的工作流文件 → 展开后步数只有 1，2000 步上限完全
// 看不见它，递归展开器却深到把宿主 JS 调用栈打爆（RangeError 冒泡出 loadWorkflow = 崩溃）。
console.log("\n8) 极深调用链 → 加载期硬错误（不爆栈崩溃）");
{
  /** 造一条 n 个文件互相串联的链：w0 → w1 → … → w(n-1)（最后一层带 1 个普通步骤） */
  const chainWriter = (engine, n) => {
    for (let i = 0; i < n; i++) {
      const lines = i + 1 < n
        ? ["steps:", "  - id: n", "    desc: 步骤 n", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: n", "    max_fail_count: 3", `    workflow: w${i + 1}`]
        : ["steps:", "  - id: leaf", "    desc: 步骤 leaf", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: leaf", "    max_fail_count: 3", "    do: 做", "    check: 查"];
      fs.writeFileSync(path.join(engine.workflowsDir, `w${i}.yaml`), lines.join("\n"));
    }
  };
  /** 判据（负对照复用同一条）：过深链必须拿到硬错误，且**不抛异常**、错误里不是栈溢出原文 */
  const deepCriteria = (engine, n) => {
    chainWriter(engine, n);
    try {
      const r = engine.loadWorkflow("w0");
      return {
        threw: false,
        hardError: !r.def,
        depthMessage: r.problems.some((p) => p.includes("嵌套过深") && p.includes(`上限 ${MAX_SUBWORKFLOW_DEPTH}`)),
        noStackOverflowText: r.problems.every((p) => !/Maximum call stack/i.test(p)),
      };
    } catch (e) {
      return { threw: true, crash: e?.constructor?.name ?? String(e), crashText: String(e?.message ?? e).slice(0, 60), hardError: false, depthMessage: false, noStackOverflowText: false };
    }
  };

  const D = mkEngine("deep1900");
  const t0 = Date.now();
  const repro = deepCriteria(D.engine, 1900);
  const ms = Date.now() - t0;
  check("复现用例（1900 链）→ 不抛异常、返回加载期硬错误（本次缺陷的验收）",
    !repro.threw && repro.hardError, JSON.stringify(repro));
  check("硬错误说人话：写明「嵌套过深」+ 深度上限，而不是栈溢出原文",
    repro.depthMessage && repro.noStackOverflowText, JSON.stringify(repro));
  const deepProblem = D.engine.loadWorkflow("w0").problems.join("\n");
  check("报错带调用链（过长时首尾保留、中间折叠）+ 改法指引",
    deepProblem.includes("调用链：w0 → w1 → w2 → …") && deepProblem.includes("请把链拆浅")
    && deepProblem.includes(`第 ${MAX_SUBWORKFLOW_DEPTH + 1} 层`), deepProblem.slice(0, 260));
  check("过深链在 list/doctor 里是显式 ❌（不静默、不崩溃）",
    D.engine.listWorkflows().find((w) => w.name === "w0")?.invalid === true
    && D.engine.diagnose().text.includes("❌"));
  check("拒绝发生在展开之前（1900 个文件在场也只读前若干层，毫秒级返回）",
    ms < 2000, `${ms}ms`);

  // 边界：恰好等于上限的链照常可用（上限不误伤正常组合）
  const okEngine = mkEngine("deep-ok");
  chainWriter(okEngine.engine, MAX_SUBWORKFLOW_DEPTH);
  const okRes = okEngine.engine.loadWorkflow("w0");
  check(`边界：恰好 ${MAX_SUBWORKFLOW_DEPTH} 层的链照常加载（展开成 1 步、id 逐层叠加）`,
    !!okRes.def && okRes.def.steps.length === 1
    && okRes.def.steps[0].id.split(SUBWORKFLOW_ID_SEP).length === MAX_SUBWORKFLOW_DEPTH,
    JSON.stringify({ def: !!okRes.def, steps: okRes.def?.steps.length, id: okRes.def?.steps[0]?.id, problems: okRes.problems }));
  const overEngine = mkEngine("deep-over");
  chainWriter(overEngine.engine, MAX_SUBWORKFLOW_DEPTH + 1);
  const overRes = overEngine.engine.loadWorkflow("w0");
  check(`边界：${MAX_SUBWORKFLOW_DEPTH + 1} 层的链立刻硬错误（第 ${MAX_SUBWORKFLOW_DEPTH + 1} 层被拦）`,
    !overRes.def && overRes.problems.some((p) => p.includes(`第 ${MAX_SUBWORKFLOW_DEPTH + 1} 层`)),
    JSON.stringify(overRes.problems).slice(0, 200));

  // 负对照：按锚点摘掉深度闸 → 同一判据必须为假（回到修复前的 RangeError 崩溃）
  if (!process.env.RF_SUBWF_CHILD) {
    const revDepth = buildPluginCopy({
      "engine.ts": (src) => {
        const anchor = "if (chain.length > MAX_SUBWORKFLOW_DEPTH) {";
        if (!src.includes(anchor)) throw new Error("负对照锚点（嵌套深度闸）不见了 —— 实现被改写，请同步更新本负对照");
        return src.replace(anchor, "if (false) { // 负对照：还原为「不设嵌套深度上限」");
      },
    }, "subworkflow-depth-off");
    const revDepthLib = await import(pathToFileURL(path.join(revDepth.dir, "lib", "engine.js")).href);
    const revDepthEngine = revDepthLib.createEngine(revDepth.dir + "-ws", {
      ...deliveryPorts(),
      verify: async () => { throw new Error("负对照不该走到验证"); },
      log: () => {},
    });
    revDepthEngine.ensureLayout();
    // 用更深的链跑负对照：确保在任何机器上都真的把栈打爆（而不是撞上各机器不同的栈上限）
    const reverted = deepCriteria(revDepthEngine, 4000);
    check("负对照：摘掉深度闸的构建里同一判据为假（RangeError 冒泡 = 修复前的崩溃）",
      reverted.threw === true && reverted.crash === "RangeError", JSON.stringify(reverted));
    check("负对照：崩溃原文就是 Maximum call stack size exceeded（缺陷真实存在）",
      reverted.threw === true && /Maximum call stack size exceeded/.test(reverted.crashText ?? ""), JSON.stringify(reverted));
    revDepth.cleanup();
  }
}

// ═══ 9) 调用点的 `do` 生效：下沉到子步骤的 `task`（DO/CHECK 的「## 任务」）════════════
// 语义：调用点的 `do` = 「这段子工作流要做什么」= 子工作流的任务；不写就继承父级任务（向后兼容）。
// 嵌套按**最内层优先、外层继承**组合（与 `adversarial_check.model` 的继承形态一致）。
console.log("\n9) 调用点 `do` 下沉：任务来自调用点；不写继承父级；嵌套最内层优先");
{
  /** 从 DO/CHECK 提示词里取「## 任务」段的内容（标题的下一行） */
  const taskSection = (text) => {
    const lines = String(text ?? "").split("\n");
    const at = lines.indexOf("## 任务");
    return at >= 0 ? (lines[at + 1] ?? "").trim() : undefined;
  };
  /**
   * 判据（正/负对照复用同一条）：调用点 `do` 是否真的下沉成子步骤的 `task`、并进提示词。
   * 只收「下沉」这一件事的事实 —— 「不写 do 时回落父级任务」是改造前就有的行为，放进这里
   * 会让负对照失去鉴别力（还原构建里它照样为真）。
   */
  const taskCriteria = (engine, sid) => {
    const wfFile = (name, lines) => {
      fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
      return engine.loadWorkflow(name);
    };
    const req = (id, extra = []) => [
      `  - id: ${id}`, "    desc: 步骤 " + id, "    input: 上游产出", "    output: 本步产出",
      `    on_fail: ${id}`, "    max_fail_count: 3", ...extra,
    ];
    // 一份子工作流 + 两个调用点各写不同的 `do`
    wfFile("t-shared", ["steps:",
      ...req("s1", ["    do: 做 S1", "    check: 查 S1", "    on_pass: s2"]),
      ...req("s2", ["    do: 做 S2", "    check: 查 S2", "    on_pass: done"])]);
    const twocallers = wfFile("t-twocallers", ["steps:",
      ...req("alpha", ["    do: 任务甲", "    on_pass: beta", "    workflow: t-shared"]),
      ...req("beta", ["    do: 任务乙", "    on_pass: done", "    workflow: t-shared"])]);
    const byId = (id) => stepsOf(twocallers).find((s) => s.id === id);
    // 嵌套：外层写了 `do`，内层调用点①不写（继承外层）、②写了自己的（覆盖外层）
    wfFile("t-leaf", ["steps:", ...req("leaf", ["    do: 做 L", "    check: 查 L", "    on_pass: done"])]);
    wfFile("t-mid", ["steps:", ...req("midcall", ["    on_pass: done", "    workflow: t-leaf"])]);
    wfFile("t-mid2", ["steps:", ...req("midcall2", ["    do: 内层任务", "    on_pass: done", "    workflow: t-leaf"])]);
    const outer = wfFile("t-outer", ["steps:", ...req("outcall", ["    do: 外层任务", "    on_pass: done", "    workflow: t-mid"])]);
    const outer2 = wfFile("t-outer2", ["steps:", ...req("outcall2", ["    do: 外层任务", "    on_pass: done", "    workflow: t-mid2"])]);
    const taskIn = (wf, id) => stepsOf(wf).find((s) => s.id === id)?.task;
    // 提示词面：start 的返回文本就是首步 DO，「## 任务」必须取自调用点的 `do`
    const first = engine.start("t-twocallers", "父级任务描述", sid);
    return {
      sunkAlpha: byId("alpha/s1")?.task === "任务甲" && byId("alpha/s2")?.task === "任务甲",
      sunkBeta: byId("beta/s1")?.task === "任务乙" && byId("beta/s2")?.task === "任务乙",
      noBleed: byId("alpha/s1")?.task === "任务甲" && byId("beta/s1")?.task === "任务乙",
      nestedInherit: taskIn(outer, "outcall/midcall/leaf") === "外层任务",
      nestedOverride: taskIn(outer2, "outcall2/midcall2/leaf") === "内层任务",
      promptAlpha: taskSection(first.text) === "任务甲",
    };
  };

  const D = mkEngine("call-do");
  const crit = taskCriteria(D.engine, S());
  check("两个调用点以不同 `do` 调用同一子工作流 → 各自展开的子步骤各拿自己的 `do`",
    crit.sunkAlpha && crit.sunkBeta && crit.noBleed, JSON.stringify(crit));
  check("首步 DO 提示词的「## 任务」= 调用点的 `do`（不是父级任务描述）",
    crit.promptAlpha, JSON.stringify(crit));
  check("嵌套：内层调用点没写 `do` → 继承外层（最外层下沉下来的任务）",
    crit.nestedInherit, JSON.stringify(crit));
  check("嵌套：内层调用点写了 `do` → **最内层优先**，覆盖外层",
    crit.nestedOverride, JSON.stringify(crit));

  // 调用点不写 `do`：子步骤的 `task` 不填，提示词回落父级任务（向后兼容，与改造前逐字一致）
  const noDo = D.wf("t-nodo", ["steps:",
    "  - id: only", "    desc: 步骤 only", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: only", "    max_fail_count: 3", "    workflow: t-shared"]);
  check("调用点不写 `do` → 子步骤不带 `task`（定义里看不出差别）",
    stepsOf(noDo).every((s) => s.task === undefined), JSON.stringify(stepsOf(noDo).map((s) => [s.id, s.task])));
  const nd = D.start("t-nodo", "父级任务描述", S());
  check("调用点不写 `do` → 子步骤 DO 的「## 任务」仍是父级任务（向后兼容）",
    taskSection(nd.r.text) === "父级任务描述", taskSection(nd.r.text));

  // DO 与 CHECK 的「## 任务」同源：执行者与验证者对着**同一个**任务干活
  const E = mkEngine("call-do-e2e");
  E.wf("e-shared", ["steps:",
    ...["s1", "s2"].map((id) => [`  - id: ${id}`, `    desc: 子步 ${id}`, "    input: 上游产出", "    output: 本步产出",
      `    do: 做 ${id}`, `    check: 查 ${id}`, id === "s1" ? "    on_pass: s2" : "    on_pass: done", "    on_fail: s1", "    max_fail_count: 3"]).flat()]);
  E.wf("e-outer", ["steps:",
    "  - id: alpha", "    desc: 甲", "    do: 任务甲", "    input: 上游产出", "    output: 本步产出", "    on_pass: beta", "    on_fail: alpha", "    max_fail_count: 3", "    workflow: e-shared",
    "  - id: beta", "    desc: 乙", "    do: 任务乙", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: beta", "    max_fail_count: 3", "    workflow: e-shared"]);
  const esid = S();
  const est = E.start("e-outer", "父级任务描述", esid);
  for (const v of [{ status: "passed", reason: "1" }, { status: "passed", reason: "2" }, { status: "passed", reason: "3" }, { status: "passed", reason: "4" }]) {
    E.scripted.push(v);
    E.engine.onSubmit(esid, `交卷 ${E.engine.readState(E.newestId())?.current_step}`);
    await sleep();
  }
  // 首步 DO 是 start 的返回值（不经 deliver 端口），后续步骤才进 deliveries —— 两边都要找
  const promptOf = (stepId) => [est.r.text, ...E.deliveries].find((t) => t.includes(`**${stepId}**`));
  check("DO 提示词：alpha 段「## 任务」= 任务甲、beta 段「## 任务」= 任务乙",
    taskSection(promptOf("alpha/s1")) === "任务甲" && taskSection(promptOf("beta/s1")) === "任务乙",
    JSON.stringify({ a: taskSection(promptOf("alpha/s1")), b: taskSection(promptOf("beta/s1")) }));
  check("CHECK 提示词与 DO 同源：验证者收到的任务也是调用点的 `do`",
    E.verifyReqs.find((q) => q.step === "alpha/s1")?.task === "任务甲"
    && E.verifyReqs.find((q) => q.step === "beta/s1")?.task === "任务乙",
    JSON.stringify(E.verifyReqs.map((q) => [q.step, q.task])));

  // 类型口径：调用点 `do` 给了但不是字符串 = 硬错误（静默当成「继承父级」会让作者以为传下去了）
  const badDo = D.wf("t-baddo", ["steps:",
    "  - id: call", "    desc: 步骤 call", "    do: 123", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: t-shared"]);
  check("调用点 `do` 非字符串 → 加载期硬错误（不是静默忽略）",
    !badDo.def && badDo.problems.some((p) => p.includes("`do`") && p.includes("必须是字符串")), JSON.stringify(badDo.problems));
  // `do:` 只写键名（null）= 没写 → 继承父级任务（与 `reset` 的「只写键名 = 没写」同一口径）
  const nullDo = D.wf("t-nulldo", ["steps:",
    "  - id: call", "    desc: 步骤 call", "    do:", "    input: 上游产出", "    output: 本步产出", "    on_pass: done", "    on_fail: call", "    max_fail_count: 3", "    workflow: t-shared"]);
  check("调用点 `do:` 只写键名（空值）= 没写 → 可加载且子步骤不带 `task`",
    !!nullDo.def && stepsOf(nullDo).every((s) => s.task === undefined), JSON.stringify({ p: nullDo.problems, t: stepsOf(nullDo).map((s) => s.task) }));

  // 负对照：按锚点还原「不下沉」→ 同一批判据必须为假
  if (!process.env.RF_SUBWF_CHILD) {
    const revDo = buildPluginCopy({
      "engine.ts": (src) => {
        const anchor = "    if (callTask !== undefined && s.task === undefined) step.task = callTask;";
        if (!src.includes(anchor)) throw new Error("负对照锚点（调用点 `do` 下沉到子步骤 `task`）不见了 —— 实现被改写，请同步更新本负对照");
        return src.replace(anchor, "    if (false) step.task = callTask; // 负对照：还原为「调用点 do 不下沉」");
      },
    }, "subworkflow-call-do-off");
    const revDoLib = await import(pathToFileURL(path.join(revDo.dir, "lib", "engine.js")).href);
    const revDoEngine = revDoLib.createEngine(revDo.dir + "-ws", {
      ...deliveryPorts(),
      verify: async () => { throw new Error("负对照不该走到验证"); },
      log: () => {},
    });
    revDoEngine.ensureLayout();
    const revCrit = taskCriteria(revDoEngine, `rev-do-${Date.now()}`);
    check("负对照：还原「不下沉」的构建里同一批判据全部为假（do 不再进「## 任务」）",
      !revCrit.sunkAlpha && !revCrit.sunkBeta && !revCrit.noBleed && !revCrit.nestedInherit
      && !revCrit.nestedOverride && !revCrit.promptAlpha, JSON.stringify(revCrit));
    revDo.cleanup();
  }
}

try { fs.rmSync(A.dir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
