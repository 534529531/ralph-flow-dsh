/**
 * 多验证者投票（`check_voting`）验收 —— 行为与 opencode 版 `src/check-voting.ts` +
 * `src/voting-progress.ts` 对齐（权威：`docs/custom-workflows.md` 的「check_voting」一节）。
 *
 * 覆盖四层：
 *   A. 加载期校验（硬错误 / 告警 / 定义形态）
 *   B. 提示词（投票变体 vs 单 check 变体；fail-closed 拒绝无检查依据的步骤）
 *   C. 运行期语义：N 票并发、**全部终态才聚合**、`failed > infra > 全过`、
 *      infra 自动重试一次、重试仍 infra → `check_infra` 暂停（不计失败）、
 *      `/ralphflow-continue` 只重跑未通过的票（已通过的保留）、跨轮全部重投、
 *      每票实时进度播报、`/ralphflow-status` 每票进度、取消传播到 N 票。
 *   D. 回归：单 `check` 与无检查步骤的行为不受影响。
 *
 * 纪律（任务书 §4）：临时工作区/隔离 HOME 走 mkdtemp；绝不读写真实 `~/.dsh`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEngine, stepHasCheck, stepHasVerification, voterCountOf, expectedVerdicts, MAX_VOTERS,
} from "../lib/engine.js";
import { buildCheckPrompt } from "../lib/verify.js";
import {
  decideVotingOutcome, formatVotingFailureReason, formatVotingPassReason, voterProgressLine, voterStatusLabel,
} from "../lib/voting.js";
import { CREATE_GUIDE } from "../lib/create.js";

// HOME 隔离：全局工作流目录在 ~/.dsh 下，测试绝不读写真实 HOME。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rf-voting-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-voting-ws-"));
const deliveries = [];
/** 每次委派的请求（可控句柄：由用例决定每票何时、以什么判定返回） */
let calls = [];
let pending = [];
let verifyCalls = 0;

const engine = createEngine(dir, {
  deliver: (_sid, text, summary) => { deliveries.push({ text, summary }); return true; },
  verify: (req) => new Promise((resolve) => {
    verifyCalls++;
    calls.push(req);
    pending.push({ req, resolve, done: false });
  }),
  log: () => {},
});

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
let sessionN = 0;
const S = () => `voting-session-${++sessionN}`;
const newestId = () => engine.listInstances().sort((a, b) => (a.state.started_at > b.state.started_at ? 1 : -1)).at(-1)?.id;
function start(wf, task, sid) { const r = engine.start(wf, task, sid); return { r, id: newestId() }; }
const notesOf = (instId) => deliveries.filter((d) => d.text.includes("[ralphflow]"));
const summariesOf = (instId) => deliveries.map((d) => d.summary ?? "");

/** 取某票**最新**的未决句柄（按 check_index；同号可能有多轮，取最后一笔） */
const pendingOf = (index) => [...pending].reverse().find((p) => !p.done && p.req.checkIndex === index);
/** 让某票以给定判定返回 */
function answer(index, verdict) {
  const p = pendingOf(index);
  if (!p) throw new Error(`没有待返回的第 ${index} 票（calls=${calls.map((c) => c.checkIndex).join(",")}）`);
  p.done = true;
  p.resolve({ check_index: index, step_id: p.req.step.id, ts: new Date().toISOString(), ...verdict });
}
/** 清空本用例的观测面（新实例前调用） */
function reset() { calls = []; pending = []; deliveries.length = 0; verifyCalls = 0; }

engine.ensureLayout();
const wfFile = (name, lines) => {
  fs.writeFileSync(path.join(engine.workflowsDir, `${name}.yaml`), lines.join("\n"));
  return engine.loadWorkflow(name);
};

console.log("== A. 加载期校验 ==");
{
  const ok = wfFile("v-ok", [
    "adversarial_check:", "  model: openai/gpt-5", "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: X", "    check_voting:",
    "      - check: 需求逐条落实",
    "      - check: 行为真实可用", "        model: anthropic/claude-sonnet",
    "      - check: 无遗漏边界",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  check("合法 check_voting 可加载且零告警", !!ok.def && ok.problems.length === 0 && ok.warnings.length === 0, JSON.stringify(ok));
  const s = ok.def?.steps[0];
  check("条目被解析进定义（check + 可选 model）", s?.check_voting?.length === 3 && s.check_voting[1].model === "anthropic/claude-sonnet", JSON.stringify(s?.check_voting));
  check("投票步 = 有对抗性检查（stepHasVerification）", stepHasVerification(s) === true);
  check("投票步不是单 check 步（stepHasCheck 仍为假）", stepHasCheck(s) === false);
  check("voterCountOf/expectedVerdicts 一致（3 票）", voterCountOf(s) === 3 && expectedVerdicts(s) === 3, JSON.stringify({ v: voterCountOf(s), e: expectedVerdicts(s) }));
  check("MAX_VOTERS = 5（照抄 opencode）", MAX_VOTERS === 5);

  const both = wfFile("v-both", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check: c", "    check_voting:", "      - check: c1", "    on_pass: done", "    max_fail_count: 1"]);
  check("check 与 check_voting 同写 → 硬错误（互斥）", !both.def && both.problems.some((p) => p.includes("互斥")), JSON.stringify(both.problems));

  const bothBadType = wfFile("v-both-badtype", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check: true", "    check_voting:", "      - check: c1", "    on_pass: done", "    max_fail_count: 1"]);
  check("互斥优先于类型检查（check: true + check_voting 仍报互斥）", !bothBadType.def && bothBadType.problems.some((p) => p.includes("互斥")), JSON.stringify(bothBadType.problems));

  const empty = wfFile("v-empty", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting: []", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_voting 空数组 → 硬错误", !empty.def && empty.problems.some((p) => p.includes("1-5")), JSON.stringify(empty.problems));

  const six = wfFile("v-six", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", ...Array.from({ length: 6 }, (_, i) => `      - check: c${i}`), "    on_pass: done", "    max_fail_count: 1"]);
  check("check_voting 超过 5 票 → 硬错误（上限）", !six.def && six.problems.some((p) => p.includes("超过上限")), JSON.stringify(six.problems));

  const noCheck = wfFile("v-entry-nocheck", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", "      - check: c1", "      - model: a/b", "    on_pass: done", "    max_fail_count: 1"]);
  check("条目缺 check → 硬错误", !noCheck.def && noCheck.problems.some((p) => p.includes("check_voting[1]") && p.includes("check")), JSON.stringify(noCheck.problems));

  const notMap = wfFile("v-entry-notmap", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", "      - c1", "    on_pass: done", "    max_fail_count: 1"]);
  check("条目不是映射 → 硬错误", !notMap.def && notMap.problems.some((p) => p.includes("不是映射")), JSON.stringify(notMap.problems));

  const badModel = wfFile("v-entry-badmodel", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", "      - check: c1", "        model: 123", "    on_pass: done", "    max_fail_count: 1"]);
  check("条目 model 类型非法 → 硬错误", !badModel.def && badModel.problems.some((p) => p.includes("model")), JSON.stringify(badModel.problems));

  const bareModel = wfFile("v-entry-bare", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", "      - check: c1", "        model: sonnet", "    on_pass: done", "    max_fail_count: 1"]);
  check("条目 model 裸名 → 告警回退（不拒收、不静默）", !!bareModel.def && bareModel.warnings.some((w) => w.includes("check_voting[0]") && w.includes("回退")), JSON.stringify(bareModel.warnings));

  const removedFields = wfFile("v-entry-removed", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", "      - check: c1", "        timeout_ms: 600000", "        system_prompt: 你是一个…", "        whatever: 1", "    on_pass: done", "    max_fail_count: 1"]);
  check("条目 timeout_ms/system_prompt/未知键 → 告警忽略（与 adversarial_check 同口径）",
    !!removedFields.def
    && removedFields.warnings.some((w) => w.includes("timeout_ms"))
    && removedFields.warnings.some((w) => w.includes("system_prompt"))
    && removedFields.warnings.some((w) => w.includes("whatever")),
    JSON.stringify(removedFields.warnings));
  check("被忽略的字段不进定义（不生效）",
    removedFields.def && !("timeout_ms" in removedFields.def.steps[0].check_voting[0]) && !("system_prompt" in removedFields.def.steps[0].check_voting[0]),
    JSON.stringify(removedFields.def?.steps[0].check_voting));

  const withCheckModel = wfFile("v-checkmodel", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", "      - check: c1", "    check_model: a/b", "    on_pass: done", "    max_fail_count: 1"]);
  check("check_voting 与 check_model 同写 → 硬错误", !withCheckModel.def && withCheckModel.problems.some((p) => p.includes("check_model")), JSON.stringify(withCheckModel.problems));

  const singleVoter = wfFile("v-single", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: X", "    check_voting:", "      - check: c1", "    on_pass: done", "    max_fail_count: 1"]);
  check("单票且无 model → doctor 告警（等同单验证者）", !!singleVoter.def && singleVoter.warnings.some((w) => w.includes("等同单验证者")), JSON.stringify(singleVoter.warnings));
  check("投票步不再收到「不会被独立验证」告警", !!singleVoter.def && !singleVoter.warnings.some((w) => w.includes("不会被独立验证")), JSON.stringify(singleVoter.warnings));

  check("CREATE_GUIDE 教了 check_voting", CREATE_GUIDE.includes("check_voting"), CREATE_GUIDE.slice(0, 120));
  check("CREATE_GUIDE 不再说 check_voting 未支持", !CREATE_GUIDE.includes("check_voting`（多验证者投票，v0 按单验证者执行"));
  check("CREATE_GUIDE 写明互斥与 1-5 票硬规则", CREATE_GUIDE.includes("互斥") && CREATE_GUIDE.includes("1-5"));
  check("CREATE_GUIDE 仍不提 system_prompt/timeout_ms（引擎未兑现的键不进指引）",
    !CREATE_GUIDE.includes("system_prompt") && !CREATE_GUIDE.includes("timeout_ms"));
}

console.log("== B. 提示词：投票变体 vs 单 check 变体 ==");
{
  const step = { id: "a", do: "实现 X", desc: "描述", output: "产出.md", check_voting: [
    { check: "需求逐条落实" }, { check: "行为真实可用" }, { check: "无遗漏边界" },
  ] };
  const base = { instId: "i", step, workflow: { name: "w", steps: [step], warnings: [] }, userTask: "任务 T", checkIndex: 1, artifactsRelDir: ".dsh/ralph-flow/artifacts/x", signal: new AbortController().signal };
  const votingPrompt = buildCheckPrompt({ ...base, voter: { index: 2, count: 3, check: "行为真实可用" } }, true);
  check("投票提示词含「专属视角」段与该票依据", votingPrompt.includes("## 你的检查依据（专属视角）") && votingPrompt.includes("行为真实可用"));
  check("投票提示词含「你是 N 个之一」约束（照抄 opencode §8.4）", votingPrompt.includes("## 你是 3 个验证者之一"));
  check("投票提示词不泄露别的票的依据", !votingPrompt.includes("需求逐条落实") && !votingPrompt.includes("无遗漏边界"));
  check("投票提示词仍带完整本步上下文与产出目录", votingPrompt.includes("## 本步上下文") && votingPrompt.includes("**产出目录**") && votingPrompt.includes("产出.md"));
  check("投票提示词不含单 check 的段名", !votingPrompt.includes("## 检查依据\n"));
  check("投票提示词仍要求结构化提交（不退化）", votingPrompt.includes("structured_output"));

  const singleStep = { id: "b", do: "实现 Y", check: "单检查依据" };
  const singlePrompt = buildCheckPrompt({ ...base, step: singleStep, workflow: { name: "w", steps: [singleStep], warnings: [] }, voter: undefined }, true);
  check("单 check 提示词逐字保留「## 检查依据」段", singlePrompt.includes("## 检查依据\n单检查依据"));
  check("单 check 提示词不含投票段", !singlePrompt.includes("你是 3 个验证者之一"));

  let threw = false;
  try { buildCheckPrompt({ ...base, step: { id: "c", do: "Z" }, voter: undefined }, true); } catch { threw = true; }
  check("既无 check 也无 voter → 明确抛错（fail-closed，不生成兜底配方）", threw);
}

console.log("== C. 纯函数层（聚合优先级与文案） ==");
{
  const v = (index, status, reason = "r") => ({ index, status, reason });
  check("聚合：全 passed → passed", decideVotingOutcome([v(0, "passed"), v(1, "passed")]) === "passed");
  check("聚合：任一 failed → failed（优先于 infra）", decideVotingOutcome([v(0, "failed"), v(1, "infra"), v(2, "passed")]) === "failed");
  check("聚合：无 failed 但有 infra → infra", decideVotingOutcome([v(0, "passed"), v(1, "infra")]) === "infra");

  const entries = [{ check: "需求逐条落实" }, { check: "行为真实可用", model: "a/b" }, { check: "无遗漏边界" }];
  const failReason = formatVotingFailureReason([v(0, "passed", "覆盖度完整\n第二行"), v(1, "failed", "缺少导出"), v(2, "infra", "API 429")], entries, 3);
  check("失败聚合：标题写明 x/N 通过", failReason.includes("多验证者检查 1/3 通过，全过才放行"), failReason.slice(0, 80));
  check("失败聚合：失败票带**检查依据原文**（DO 没看过配置）", failReason.includes("检查依据：行为真实可用"));
  check("失败聚合：失败票带该票模型", failReason.includes("a/b"));
  check("失败聚合：通过票列在「不要破坏」节", failReason.includes("### ✓ 已通过的验证者（修复时不要破坏）") && failReason.includes("覆盖度完整"));
  check("失败聚合：故障票单列（本轮未出判定）", failReason.includes("### ⚠️ 基础设施故障票"));
  check("通过聚合：N/N 全过 + 每票一行", formatVotingPassReason([v(0, "passed", "ok")], entries, 3).includes("3/3 验证者全过"));
  check("实时进度行：通过/失败/故障三种标记与措辞", voterProgressLine(v(0, "passed"), entries[0], 3, false).text.includes("✅ 验证者 1/3 通过")
    && voterProgressLine(v(1, "failed"), entries[1], 3, false).text.includes("❌ 验证者 2/3 不通过")
    && voterProgressLine(v(2, "infra"), entries[2], 3, false).text.includes("⚠️ 验证者 3/3 基础设施故障，自动重试中"));
  check("实时进度行：重试轮措辞不同（重试通过/重试仍失败，工作流将暂停）",
    voterProgressLine(v(0, "passed"), entries[0], 3, true).text.includes("重试通过")
    && voterProgressLine(v(2, "infra"), entries[2], 3, true).text.includes("重试仍失败，工作流将暂停"));
  check("状态标签：✓/✗/⏳/⚠/·", ["passed", "failed", "running", "infra", "pending"].map(voterStatusLabel).join("") === "✓✗⏳⚠·");
}

console.log("== D. 运行期：N 票并发 + 全部终态才聚合 ==");
{
  wfFile("v3", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 需求逐条落实",
    "      - check: 行为真实可用",
    "      - check: 无遗漏边界",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v3", "投票任务", s);
  engine.onSubmit(s, "做完了");
  await tick();
  check("交卷后并发发出 3 笔委派", calls.length === 3 && engine.readState(id).delegations.length === 3, JSON.stringify(calls.map((c) => c.checkIndex)));
  check("每票携带专属检查依据与序号", calls.map((c) => c.voter?.check).join("|") === "需求逐条落实|行为真实可用|无遗漏边界"
    && calls.map((c) => `${c.voter.index}/${c.voter.count}`).join(",") === "1/3,2/3,3/3", JSON.stringify(calls.map((c) => c.voter)));
  check("check_index 与票号一致（0,1,2）", calls.map((c) => c.checkIndex).sort().join(",") === "0,1,2");
  check("三票各有独立取消句柄（signal 互不相同）", new Set(calls.map((c) => c.signal)).size === 3);
  check("无模型覆盖 → 不传 agentOptions（继承发起会话）", calls.every((c) => c.model === undefined), JSON.stringify(calls.map((c) => c.model)));
  check("启动播报写明 N 个验证者并行、全过才放行", notesOf(id).some((n) => n.text.includes("3 个独立验证者") && n.text.includes("全过才放行")), JSON.stringify(notesOf(id).map((n) => n.summary)));
  check("启动播报 summary 说明无需操作", notesOf(id).some((n) => /无需操作/.test(n.summary ?? "")), JSON.stringify(summariesOf()));
  check("启动播报列出本轮各票检查依据（照抄 opencode 的可见依据块）",
    notesOf(id).some((n) => n.text.includes("本轮检查依据") && n.text.includes("- 1/3 需求逐条落实") && n.text.includes("- 3/3 无遗漏边界")),
    JSON.stringify(notesOf(id).map((n) => n.text.slice(0, 80))));

  // 只回一票：**不得**聚合（多票并发下状态机不能被单票结论推动）
  answer(0, { status: "passed", reason: "需求都落实了" });
  await tick();
  const mid = engine.readState(id);
  check("单票返回后不聚合：仍有 2 笔在飞、未推进未暂停", mid.delegations.length === 2 && mid.active && !mid.paused && mid.verdicts.length === 1, JSON.stringify({ d: mid.delegations.length, paused: mid.paused, v: mid.verdicts.length }));
  check("单票返回即有实时进度播报（每票一行）", notesOf(id).some((n) => n.text.includes("验证者 1/3") && n.text.includes("通过")), JSON.stringify(notesOf(id).map((n) => n.text.slice(0, 40))));
  check("status 显示每票进度（1/3 票完成）", engine.statusOf(s).text.includes("验证进度（1/3 票）") && engine.statusOf(s).text.includes("验证者 1/3") && engine.statusOf(s).text.includes("验证者 2/3"), engine.statusOf(s).text.slice(0, 400));

  answer(1, { status: "passed", reason: "行为可用" });
  await tick();
  check("第二票返回仍不聚合（还差一票）", engine.readState(id).delegations.length === 1);
  answer(2, { status: "passed", reason: "边界已覆盖" });
  await tick(40);
  const done = engine.readState(id);
  check("全过 → 工作流完成、实例销毁（readState 为 null）", done === null, JSON.stringify(done));
  check("报告里逐票留下判定（3 条）+ 通过聚合文案", (() => {
    const report = fs.readFileSync(path.join(engine.reportsDir, `${id}.md`), "utf-8");
    const verdictLines = (report.split("## 判定")[1] ?? "").split("\n").filter((l) => l.startsWith("- [passed]"));
    return verdictLines.length === 3 && report.includes("3/3 验证者全过");
  })());
}

console.log("== D2. 五票同一拍返回（并发落账不丢票、只聚合一次）==");
{
  wfFile("v5", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一", "      - check: 票二", "      - check: 票三", "      - check: 票四", "      - check: 票五",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v5", "五票并发", s);
  engine.onSubmit(s, "done");
  await tick();
  check("5 票（MAX_VOTERS 上限）全部并发发出", calls.length === 5 && engine.readState(id).delegations.length === 5, String(calls.length));
  // **同一拍**全部返回：没有任何 await 间隔 —— 落账必须不丢票、只聚合一次
  for (let i = 0; i < 5; i++) answer(i, { status: "passed", reason: `票${i + 1}过` });
  await tick(60);
  check("同一拍返回的 5 票全部落账（无丢失/覆盖）", engine.listInstances().every((i) => i.id !== id), JSON.stringify(engine.readState(id)?.verdicts?.map((v) => v.check_index)));
  check("只完成一次（实例已销毁、报告唯一）", engine.readState(id) === null && fs.existsSync(path.join(engine.reportsDir, `${id}.md`)));
  check("每票各有一次进度播报（5 条 voter 进度）", notesOf(id).filter((n) => /验证者 [1-5]\/5/.test(n.text)).length === 5, String(notesOf(id).filter((n) => /验证者 [1-5]\/5/.test(n.text)).length));
}

console.log("== E. 模型优先级：条目 model > 全局 adversarial_check.model ==");
{
  wfFile("v-model", [
    "adversarial_check:", "  model: global/global-model", "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一", "        model: entry/entry-model",
    "      - check: 票二",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  start("v-model", "模型任务", s);
  engine.onSubmit(s, "done");
  await tick();
  const byIndex = new Map(calls.map((c) => [c.checkIndex, c.model]));
  check("配了 model 的票用自己的模型", byIndex.get(0)?.providerID === "entry" && byIndex.get(0)?.modelID === "entry-model", JSON.stringify(byIndex.get(0)));
  check("未配 model 的票继承全局模型", byIndex.get(1)?.providerID === "global" && byIndex.get(1)?.modelID === "global-model", JSON.stringify(byIndex.get(1)));
  answer(0, { status: "passed", reason: "ok" });
  answer(1, { status: "passed", reason: "ok" });
  await tick(40);
}

console.log("== F. 失败聚合与「failed 优先于 infra」==");
{
  wfFile("v-fail", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 需求逐条落实",
    "      - check: 行为真实可用",
    "      - check: 无遗漏边界",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-fail", "失败任务", s);
  engine.onSubmit(s, "done");
  await tick();
  answer(0, { status: "passed", reason: "需求都落实了" });
  answer(1, { status: "failed", reason: "缺少导出函数 foo" });
  answer(2, { status: "infra", reason: "API 429" });
  await tick(40);
  const st = engine.readState(id);
  check("有 failed → 整体失败返工（不被 infra 遮蔽）", st && !st.paused && st.fail_count === 1 && st.verdicts.length === 0 && !st.do_submitted, JSON.stringify({ paused: st?.paused, fc: st?.fail_count, v: st?.verdicts.length }));
  const rework = deliveries.filter((d) => d.text.includes("上一轮验证未通过")).at(-1)?.text ?? "";
  check("返工提示词带聚合失败理由（失败票检查依据 + 问题）", rework.includes("多验证者检查 1/3 通过，全过才放行") && rework.includes("检查依据：行为真实可用") && rework.includes("缺少导出函数 foo"), rework.slice(-400));
  check("返工提示词提醒「已通过的验证者（修复时不要破坏）」", rework.includes("### ✓ 已通过的验证者（修复时不要破坏）") && rework.includes("需求都落实了"));
  check("返工提示词含故障票节（本轮未出判定，下次重投）", rework.includes("### ⚠️ 基础设施故障票"));
  check("报告口径：失败轮数按**轮**记（不是按票）", (() => {
    const hist = engine.readState(id).history.filter((h) => h.event === "verdict_failed").length;
    const voterEvents = engine.readState(id).history.filter((h) => h.event === "voter_verdict").length;
    return hist === 1 && voterEvents === 3;
  })(), JSON.stringify(engine.readState(id).history.map((h) => h.event)));
  engine.cancelInstance(s);
}

console.log("== G. infra 自动重试一次（只重跑故障票）==");
{
  wfFile("v-infra", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一",
    "      - check: 票二",
    "      - check: 票三",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-infra", "故障任务", s);
  engine.onSubmit(s, "done");
  await tick();
  answer(0, { status: "passed", reason: "票一过" });
  answer(1, { status: "passed", reason: "票二过" });
  answer(2, { status: "infra", reason: "API 429" });
  await tick(40);
  const afterRound1 = engine.readState(id);
  check("首轮 infra → 未暂停、未推进（先自动重试）", afterRound1 && !afterRound1.paused && afterRound1.current_step === "a" && afterRound1.delegations.length === 1, JSON.stringify({ paused: afterRound1?.paused, d: afterRound1?.delegations.length }));
  check("只重跑故障票（新增 1 笔委派，票三）", calls.length === 4 && calls[3].checkIndex === 2, JSON.stringify(calls.map((c) => c.checkIndex)));
  check("重试委派带 attempt=2（原始事实）", afterRound1.delegations[0].attempt === 2, JSON.stringify(afterRound1.delegations));
  check("已通过的票不重跑（票一/票二各只委派一次）", calls.filter((c) => c.checkIndex === 0).length === 1 && calls.filter((c) => c.checkIndex === 1).length === 1);
  check("已通过的判定保留（重试轮不清账）", afterRound1.verdicts.length === 2 && afterRound1.verdicts.every((v) => v.status === "passed"), JSON.stringify(afterRound1.verdicts));
  check("播报说明「自动重试故障票、已通过的保留」", notesOf(id).some((n) => n.text.includes("自动重试") && n.text.includes("已通过的票不会重跑")), JSON.stringify(notesOf(id).map((n) => n.summary)));
  check("轨迹记了 voting_infra_retry", afterRound1.history.some((h) => h.event === "voting_infra_retry"));
  answer(2, { status: "passed", reason: "重试过了" });
  await tick(40);
  check("重试通过 → 3/3 全过、工作流完成", engine.readState(id) === null);
}

console.log("== H. 重试仍 infra → check_infra 暂停（不计失败）→ continue 只重跑未通过的票 ==");
{
  wfFile("v-infra2", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一",
    "      - check: 票二",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-infra2", "持续故障", s);
  engine.onSubmit(s, "done");
  await tick();
  answer(0, { status: "passed", reason: "票一过" });
  answer(1, { status: "infra", reason: "API 429" });
  await tick(40);
  check("首轮 infra → 自动重试（第 2 轮）", calls.length === 3 && calls[2].checkIndex === 1, JSON.stringify(calls.map((c) => c.checkIndex)));
  answer(1, { status: "infra", reason: "仍然 429" });
  await tick(40);
  const paused = engine.readState(id);
  check("重试仍 infra → 暂停 check_infra", paused?.paused === true && paused.pause_reason === "check_infra", JSON.stringify({ p: paused?.paused, r: paused?.pause_reason }));
  check("基础设施故障**不计失败次数**（fail_count=0）", paused.fail_count === 0, String(paused.fail_count));
  check("暂停时保留已通过的票（continue 只补跑未通过的）", paused.verdicts.length === 2 && paused.verdicts.find((v) => v.check_index === 0)?.status === "passed", JSON.stringify(paused.verdicts.map((v) => [v.check_index, v.status])));
  check("暂停播报带聚合故障理由（点名哪票、原因）", notesOf(id).some((n) => n.text.includes("验证者 2/2") && n.text.includes("仍然 429")), JSON.stringify(notesOf(id).map((n) => n.summary)));
  check("status 显示每票状态（✓ 与 ⚠）", engine.statusOf(s).text.includes("✓ 验证者 1/2") && engine.statusOf(s).text.includes("⚠ 验证者 2/2"), engine.statusOf(s).text.slice(0, 400));

  const before = calls.length;
  const cont = engine.continueInstance(s);
  await tick(40);
  check("continue 受理并说明保留已通过的票", cont.ok && cont.text.includes("保留已通过的 1 票") && cont.text.includes("重新验证其余 1 票"), cont.text);
  check("continue 只重跑未通过的票（1 笔新委派，票二）", calls.length === before + 1 && calls.at(-1).checkIndex === 1, JSON.stringify(calls.map((c) => c.checkIndex)));
  check("重试预算随 continue 重置（新委派 attempt=1）", engine.readState(id).delegations[0].attempt === 1, JSON.stringify(engine.readState(id).delegations));
  check("已通过的票不重跑（票一始终只有 1 次委派）", calls.filter((c) => c.checkIndex === 0).length === 1);
  answer(1, { status: "passed", reason: "这次过了" });
  await tick(40);
  check("补跑通过 → 2/2 全过、工作流完成", engine.readState(id) === null);
}

console.log("== I. 跨轮语义：DO 返工后重新交卷 → 全部重投（不复用上一轮的票）==");
{
  wfFile("v-round", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一",
    "      - check: 票二",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-round", "跨轮任务", s);
  engine.onSubmit(s, "第一版");
  await tick();
  answer(0, { status: "passed", reason: "票一过" });
  answer(1, { status: "failed", reason: "票二不过" });
  await tick(40);
  check("失败 → 返工（verdicts 清空）", engine.readState(id).verdicts.length === 0 && engine.readState(id).fail_count === 1);
  const before = calls.length;
  engine.onSubmit(s, "第二版");
  await tick();
  check("重新交卷 → 两票**全部**重投（不缓存上一轮通过票）", calls.length === before + 2 && [calls.at(-2).checkIndex, calls.at(-1).checkIndex].sort().join(",") === "0,1", JSON.stringify(calls.map((c) => c.checkIndex)));
  answer(0, { status: "passed", reason: "票一过" });
  answer(1, { status: "passed", reason: "票二过" });
  await tick(40);
  check("第二轮全过 → 完成", engine.readState(id) === null);
}

console.log("== J. 审查门 + 投票：全过后停门等放行 ==");
{
  wfFile("v-gate", [
    "manual_step:", "  - a", "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一", "      - check: 票二",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-gate", "门任务", s);
  engine.onSubmit(s, "done");
  await tick();
  answer(0, { status: "passed", reason: "过" });
  answer(1, { status: "passed", reason: "过" });
  await tick(40);
  const st = engine.readState(id);
  check("全过 + manual_step → 停在审查门（不推进）", st && st.active && !st.paused && st.current_step === "a" && st.verdicts.length === 2, JSON.stringify({ step: st?.current_step, v: st?.verdicts.length }));
  check("门播报：已通过独立验证、等你放行", notesOf(id).some((n) => n.text.includes("停在审查门等你放行")), JSON.stringify(notesOf(id).map((n) => n.summary)));
  const r = engine.continueInstance(s);
  await tick(40);
  check("放行 → 完成（不再重复验证）", r.ok && engine.readState(id) === null, r.text);
}

console.log("== K. 取消传播到全部在飞票 ==");
{
  wfFile("v-cancel", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一", "      - check: 票二", "      - check: 票三",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-cancel", "取消任务", s);
  engine.onSubmit(s, "done");
  await tick();
  check("3 票在飞", engine.readState(id).delegations.length === 3);
  engine.cancelInstance(s);
  await tick(20);
  check("取消中止**全部** 3 票（signal 全部 aborted）", calls.length === 3 && calls.every((c) => c.signal.aborted === true), JSON.stringify(calls.map((c) => c.signal.aborted)));
  check("取消后实例销毁并归档报告", engine.readState(id) === null && fs.existsSync(path.join(engine.reportsDir, `${id}.md`)));
}

console.log("== L. 回归：单 check 与无检查步骤不受影响 ==");
{
  wfFile("v-single-check", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check: 单检查依据",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-single-check", "单检查任务", s);
  engine.onSubmit(s, "done");
  await tick();
  check("单 check 步仍只委派 1 次、不带 voter 字段", calls.length === 1 && calls[0].voter === undefined && calls[0].checkIndex === 0, JSON.stringify(calls.map((c) => c.voter)));
  answer(0, { status: "passed", reason: "ok" });
  await tick(40);
  check("单 check 通过 → 完成（行为不变）", engine.readState(id) === null);

  const s2 = S();
  reset();
  wfFile("v-no-check", ["steps:", "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    on_fail: a", "    do: 做 A", "    on_pass: done", "    max_fail_count: 3"]);
  const r2 = engine.start("v-no-check", "免验证任务", s2);
  check("免验证步：DO 提示词如实标注跳过对抗性验证", r2.text.includes("跳过对抗性验证") && r2.text.includes("不配置对抗性检查"));
  engine.onSubmit(s2, "done");
  await tick(30);
  check("免验证步：验证端口零调用", verifyCalls === 0, String(verifyCalls));
  check("免验证步：直接完成", engine.readState(newestId()) === null || engine.listInstances().length === 0);
}

console.log("== M. fail-closed：票数不齐绝不能放行 + 投票步的孤儿恢复 ==");
{
  wfFile("v-guard", [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 票一", "      - check: 票二", "      - check: 票三",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ]);
  const s = S();
  reset();
  const { id } = start("v-guard", "守卫任务", s);
  engine.onSubmit(s, "done");
  await tick();
  answer(0, { status: "passed", reason: "票一过" });
  answer(1, { status: "passed", reason: "票二过" });
  answer(2, { status: "passed", reason: "票三过" });
  await tick(40);
  check("（前置）全过即完成", engine.readState(id) === null);

  // 手工构造「票数不齐」的持久化状态：3 票步只有 1 张 passed 判定、无在飞委派。
  // 老判据（只看「有判定且全 passed」）会把它当成通过 → 这里必须 fail-closed 拒绝推进。
  const s2 = S();
  reset();
  const { id: id2 } = start("v-guard", "守卫任务2", s2);
  const st2 = engine.readState(id2);
  st2.do_submitted = true;
  st2.verdicts = [{ check_index: 0, status: "passed", reason: "只有一票回来了", step_id: "a", ts: new Date().toISOString() }];
  st2.delegations = [];
  fs.writeFileSync(path.join(engine.instanceDir(id2), "state.json"), JSON.stringify(st2, null, 2));
  const cont = engine.continueInstance(s2);
  const after = engine.readState(id2);
  check("3 票步只有 1 张 passed 判定 → 拒绝推进（票数不齐，fail-closed）", cont.ok === false && after.current_step === "a" && after.active, cont.text);
  check("拒绝理由说清判定未全部通过", cont.text.includes("未全部通过"), cont.text.slice(0, 120));

  // 投票步的孤儿恢复：心跳全停 = 属主已失联 → 暂停 check_infra（不计失败）；
  // continue 只补跑**未通过**的票，已通过的保留。
  const s3 = S();
  reset();
  const { id: id3 } = start("v-guard", "孤儿任务", s3);
  engine.onSubmit(s3, "done");
  await tick();
  answer(0, { status: "passed", reason: "票一过" });
  await tick(20);
  const st3 = engine.readState(id3);
  check("（前置）1 票已过、2 票在飞", st3.verdicts.length === 1 && st3.delegations.length === 2);
  for (const d of st3.delegations) d.heartbeat_at = Date.now() - 120_000; // 心跳全停（> TTL 60s）
  fs.writeFileSync(path.join(engine.instanceDir(id3), "state.json"), JSON.stringify(st3, null, 2));
  engine.restore();
  const orphaned = engine.readState(id3);
  check("投票步孤儿恢复：暂停 check_infra、清空在飞委派", orphaned.paused && orphaned.pause_reason === "check_infra" && orphaned.delegations.length === 0, JSON.stringify({ p: orphaned.paused, r: orphaned.pause_reason, d: orphaned.delegations.length }));
  check("孤儿恢复不计失败次数", orphaned.fail_count === 0, String(orphaned.fail_count));
  const before3 = calls.length;
  const cont3 = engine.continueInstance(s3);
  await tick(30);
  check("孤儿恢复后 continue：只补跑未通过的 2 票", cont3.ok && calls.length === before3 + 2 && calls.slice(before3).map((c) => c.checkIndex).sort().join(",") === "1,2", cont3.text);
  check("已通过的票不重跑（票一仍只有 1 次委派）", calls.filter((c) => c.checkIndex === 0).length === 1);
  check("已通过的判定保留", engine.readState(id3).verdicts.some((v) => v.check_index === 0 && v.status === "passed"));
  answer(1, { status: "passed", reason: "过" });
  answer(2, { status: "passed", reason: "过" });
  await tick(40);
  check("补跑全过 → 完成", engine.readState(id3) === null);
}

console.log("== N. 插件级端到端：真实链路（工具 → 引擎 → verify.ts → N 个子代理）==");
{
  const { Context } = await import("@deepseek-ai/cordis");
  const { Session, SESSION_FORMAT_VERSION } = await import("@deepseek-ai/dsh-session");
  const { pathToFileURL } = await import("node:url");
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-voting-plugin-"));
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `voting-plugin-${Date.now().toString(36)}`;
  const starts = [];
  const sent = [];
  const ctx = new Context();
  const registered = { tools: [], commands: [] };
  const session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [{ name: "read" }, { name: "grep" }, { name: "glob" }, { name: "bash" }] });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: async (_name, req) => {
      starts.push(req);
      return { id: `child-${starts.length}`, result: Promise.resolve({ structured: { passed: true, reason: `第 ${starts.length} 票通过` }, output: [], stopReason: "completed" }) };
    },
  });
  ctx.provide("agents", { get: (id) => (id === sid ? { id: sid, session, steer: (m) => sent.push(m), followup: (m) => sent.push(m) } : undefined) });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });
  const wfDir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "vplugin.yaml"), [
    "steps:",
    "  - id: a", "    desc: 步骤 a", "    input: 上游产出", "    output: 本步产出", "    do: 做 A", "    check_voting:",
    "      - check: 需求逐条落实",
    "      - check: 行为真实可用",
    "    on_pass: done", "    on_fail: a", "    max_fail_count: 3",
  ].join("\n"));
  const plugin = await import(pathToFileURL(path.join(REPO, "lib", "index.js")).href + "?voting-e2e");
  plugin.apply(ctx);
  const startTool = registered.tools.find((t) => t.name === "ralphflow_start");
  const submitTool = registered.tools.find((t) => t.name === "ralphflow_submit");
  const call = (tool, args) => tool.execute(args, { agent: { session: { id: sid } }, signal: new AbortController().signal });
  const receipt = await call(startTool, { workflow: "vplugin", task: "插件级投票任务" });
  check("插件级：启动回执预告 N 个验证者并行、全过才放行", receipt.includes("2 个独立验证者") && receipt.includes("全过才放行"), receipt.slice(0, 300));
  await call(submitTool, { summary: "做完了" });
  await tick(150);
  check("插件级：真实链路委派了 2 个子代理（各一票）", starts.length === 2, String(starts.length));
  const prompts = starts.map((r) => (r.prompt ?? []).map((b) => b.text).join("\n"));
  check("插件级：每票提示词含「你是 2 个验证者之一」", prompts.every((t) => t.includes("## 你是 2 个验证者之一")), prompts.map((t) => t.slice(0, 40)).join(" | "));
  check("插件级：各票只看到自己的检查依据", prompts.some((t) => t.includes("需求逐条落实") && !t.includes("行为真实可用")) && prompts.some((t) => t.includes("行为真实可用") && !t.includes("需求逐条落实")));
  check("插件级：验证者身份走 persona 通道（单一来源）", starts.every((r) => typeof r.persona === "string" && r.persona.includes("对抗性的检查者")));
  check("插件级：结构化判定契约仍启用（outputSchema）", starts.every((r) => r.outputSchema?.properties?.passed?.type === "boolean"));
  const progressNotes = sent.filter((m) => /验证者 \d+\/2 (通过|不通过|重试)/.test(m.source?.summary ?? ""));
  check("插件级：每票各推一条可见进度（含 summary）", progressNotes.length === 2 && progressNotes.every((m) => m.source?.form === "notice"), JSON.stringify(progressNotes.map((m) => m.source?.summary)));
  check("插件级：全过 → 报告已归档、实例销毁", fs.existsSync(path.join(ws, ".dsh", "ralph-flow", "reports")) && fs.readdirSync(path.join(ws, ".dsh", "ralph-flow", "reports")).some((f) => f.endsWith(".md")), "no report");
  const instDir = path.join(ws, ".dsh", "ralph-flow", "instances");
  check("插件级：活跃实例目录已清空", !fs.existsSync(instDir) || fs.readdirSync(instDir).length === 0, JSON.stringify(fs.existsSync(instDir) ? fs.readdirSync(instDir) : []));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
