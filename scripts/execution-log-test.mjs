/**
 * 执行日志（JSONL）验收测试 —— docs/v2/execution-log-brief.md §4「验收标准」1–7。
 *
 * 覆盖：
 *   1) 运行期 `instances/<id>/execution.log` 存在且每行都是合法 JSON；
 *   2) 完成后 `reports/<id>-execution.log` 存在、报告里有一行指路；
 *   3) 可复盘：验证者提示词原文 + 判定原文（与报告里的判定字符串一致、不截断）+ 耗时；
 *   4) 轮转：注入 1 KB 阈值 → 出现 `.log.1` 且当前文件不超阈值（端口注入 + 环境变量两个通道）；
 *   5) 日志写失败不致命：日志不可写时工作流照常跑完并推进，只多一条 warning；
 *   6) 零状态变化：state.json 键集合 ⊆ 基线白名单（无任何日志字段）；
 *   7) 负对照：`RF_LIB=<基线 lib 目录>` 跑同一支测试，验收 1/2/3/4 至少一条必须失败。
 *
 * 另外（可选，验收 2 的逐字节证明）：`RF_BASELINE_LIB=<基线 lib 目录>` 时，
 * 同一场景在基线与当前两库各跑一次，比对「去掉新增那一行后逐字节相同」。
 *
 * 纪律：一律 `mkdtempSync` 造工作区 + 隔离 `process.env.HOME`；
 * **绝不** `rmSync` 真实工作区或真实 `.dsh/` 路径（只删自己 mkdtemp 出来的目录）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HOME 隔离：全局工作流目录在 ~/.dsh 下；必须在 import 引擎之前设置。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 被测库：缺省本仓库 lib/；负对照时指向「还原实现」的基线 lib（验收 7） */
const LIB = process.env.RF_LIB ? path.resolve(process.env.RF_LIB) : path.join(HERE, "..", "lib");
const { createEngine, voterCountOf } = await import(path.join(LIB, "engine.js"));
const { runVerifier } = await import(path.join(LIB, "verify.js"));
const { Context } = await import("@deepseek-ai/cordis");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);

const RF = ".dsh/ralph-flow";
const wsOf = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rf-log-${tag}-`));
function forget(ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} }
const logPathOf = (ws, id) => path.join(ws, RF, "instances", id, "execution.log");
const reportOf = (ws, id) => path.join(ws, RF, "reports", `${id}.md`);
const archivedLogOf = (ws, id) => path.join(ws, RF, "reports", `${id}-execution.log`);

/** 解析 JSONL：`bad` 非空即存在坏行（验收 1 的判据） */
function parseJsonl(file) {
  const out = { exists: false, lines: [], bad: null, text: "" };
  if (!fs.existsSync(file)) return out;
  out.exists = true;
  out.text = fs.readFileSync(file, "utf-8");
  for (const l of out.text.split("\n")) {
    if (!l.trim()) continue;
    try { out.lines.push(JSON.parse(l)); } catch (e) { out.bad = `${l.slice(0, 100)} :: ${e.message}`; }
  }
  return out;
}
const eventsOf = (j) => j.lines.map((l) => l.event);
const hasEvent = (j, ev) => eventsOf(j).includes(ev);
const eventOf = (j, ev) => j.lines.find((l) => l.event === ev);
const eventsOfAll = (j, ev) => j.lines.filter((l) => l.event === ev);

/**
 * 内置 `loop` 现在是**多验证者投票**步（每票一条检查依据，全过才放行）：一次交卷会并发 N 笔
 * 委派 —— 执行日志里因此是 N 条 `verifier_prompt` / `verifier_result` / `voter_verdict`
 * （只有单 check 步骤才有聚合后的那一条 `verdict`）。票数现算，不硬编码。
 */
const loopVotersOf = (engine) => voterCountOf(engine.loadWorkflow("loop").def.steps[0]);

/**
 * 引擎 + 全量捕获的端口。`scripted` 是预置判定队列；`ports` 可覆盖端口
 * （例如把 verify 换成真实验证者 `runVerifier`，或注入 `logMaxBytes`）。
 */
function mkEngine(ws, { scripted = [], ports = {} } = {}) {
  const logs = [], notes = [], requests = [];
  /**
   * `scripted` 的**一条 = 一轮验证**：投票步（内置 `loop` 现在是 N 票）一轮会并发 N 笔委派，
   * 每笔都拿同一条脚本判定（票数按**当前步**现算 —— 单 check 步骤仍是 1 张，语义与改造前一致）。
   * 队列空 = 本轮没有预置判定 → 照旧抛错（上层端口把它转成 infra，与改造前同一行为）。
   */
  let round = null;
  const engine = createEngine(ws, {
    deliver: (_sid, text, summary) => { notes.push({ text, summary }); return true; },
    verify: async (req) => {
      requests.push(req);
      const voters = Math.max(1, voterCountOf(req.step));
      if (!round || round.left <= 0) {
        const v = scripted.shift();
        if (!v) throw new Error("no scripted verdict");
        round = { left: voters, v };
      }
      round.left -= 1;
      return { check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...round.v };
    },
    log: (lvl, ev, d) => logs.push({ lvl, ev, d }),
    ...ports,
  });
  engine.ensureLayout();
  return { engine, logs, notes, requests, scripted };
}
function start(engine, wf, task, sid) {
  const r = engine.start(wf, task, sid);
  return { r, id: engine.listInstances().at(-1)?.id };
}
/** 造一个自带的自定义工作流（落在隔离工作区里，绝不碰仓库 workflows/） */
function writeWorkflow(ws, name, yaml) {
  const dir = path.join(ws, RF, "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml, "utf-8");
}
/** 归一化：实例 id / 时间戳 / 耗时 —— 供跨库逐字节比对 */
const norm = (s) => String(s)
  .replace(/[a-z]+-[a-z0-9]{5,}-[a-z0-9]{4}/gi, "<ID>")
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>")
  .replace(/总耗时：[^\s]+/g, "总耗时：<D>")
  .replace(/耗时 [^\s·]+/g, "耗时 <D>")
  .replace(/artifacts\/[^\s`/"']+/g, "artifacts/<A>");
const LOG_LINE_RE = /^- 执行日志：.*$/m;

// ── L1 运行期 JSONL + 归档 + 报告指路 + 可复盘（验收 1/2/3）──────────────────
console.log("L1 运行期 JSONL → 归档 → 报告指路 → 可复盘（验收 1/2/3）");
{
  const ws = wsOf("l1");
  const sid = `l1-${RUN}`;
  // 真实验证者链路（verify.ts）：提示词原文由 verify.ts 经引擎端口写进实例日志。
  const ctx = new Context();
  const sentPrompts = [];
  const REASON = `验收判定原文：逐条核对通过 ✓\n第二行必须原样保留-${"长".repeat(400)}-END`;
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: async (_n, req) => {
      sentPrompts.push(req.prompt?.[0]?.text ?? null);
      return { id: "child", result: Promise.resolve({ structured: { passed: true, reason: REASON }, output: [], stopReason: "completed" }) };
    },
  });
  ctx.provide("tools", { schemas: () => [] });
  ctx.provide("agents", { get: () => undefined });

  const { engine, logs } = mkEngine(ws, { ports: { verify: (req) => runVerifier({ ctx }, req) } });
  const { id } = start(engine, "loop", `执行日志验收 ${RUN}`, sid);

  const rt = parseJsonl(logPathOf(ws, id));
  check("验收1：运行期 instances/<id>/execution.log 存在", rt.exists, logPathOf(ws, id));
  check("验收1：每行都能 JSON.parse（无坏行）", rt.exists && rt.bad === null, rt.bad ?? "(缺文件)");
  check("验收1：每行都有 ts/level/event",
    rt.lines.length > 0 && rt.lines.every((l) => typeof l.ts === "string" && ["info", "warn", "error"].includes(l.level) && typeof l.event === "string"),
    JSON.stringify(rt.lines[0] ?? null));
  check("验收1：运行期已含 start / step_start", hasEvent(rt, "start") && hasEvent(rt, "step_start"), JSON.stringify(eventsOf(rt)));
  check("验收1：缺省 10 MB 阈值下正常一轮不会轮转", !fs.existsSync(`${logPathOf(ws, id)}.1`));

  engine.onSubmit(sid, "完成");
  await sleep(200);
  const gone = engine.readState(id) === null;
  const arch = parseJsonl(archivedLogOf(ws, id));
  const report = fs.existsSync(reportOf(ws, id)) ? fs.readFileSync(reportOf(ws, id), "utf-8") : "";
  check("验收2：完成后 reports/<id>-execution.log 存在", arch.exists, archivedLogOf(ws, id));
  check("验收1+2：归档日志同样每行合法 JSON", arch.exists && arch.bad === null, arch.bad ?? "(缺文件)");
  check("验收2：报告里有一行指向归档日志",
    report.includes(`- 执行日志：\`.dsh/ralph-flow/reports/${id}-execution.log\``));
  check("验收2：报告里这样的行**恰好一行**", (report.match(/^- 执行日志：/gm) ?? []).length === 1);

  const VOTERS = loopVotersOf(engine);
  const promptEvs = eventsOfAll(arch, "verifier_prompt");
  check("验收3①：每个验证者的提示词原文都入日志，且与真正发出去的一一对应",
    promptEvs.length === VOTERS && promptEvs.every((e) => typeof e.prompt === "string" && e.prompt.includes("## 你的检查依据（专属视角）"))
    && promptEvs.every((e) => sentPrompts.includes(e.prompt)),
    JSON.stringify({ logged: promptEvs.length, sent: sentPrompts.length }));
  check("验收3①：每票的检查依据不同（逐票专属提示词，不是同一份发 N 次）",
    new Set(promptEvs.map((e) => e.prompt)).size === VOTERS, JSON.stringify(promptEvs.map((e) => e.checkIndex)));
  const verdictEv = eventOf(arch, "voter_verdict");
  check("验收3②：判定原文全文入日志（长 reason 不截断）", !!verdictEv && verdictEv.reason === REASON,
    `log=${String(verdictEv?.reason).length} expect=${REASON.length}`);
  check("验收3②：每票一条判定事件（投票步没有聚合后的单条 verdict）",
    eventsOfAll(arch, "voter_verdict").length === VOTERS && !hasEvent(arch, "verdict"),
    JSON.stringify({ votes: eventsOfAll(arch, "voter_verdict").length, aggregated: hasEvent(arch, "verdict") }));
  check("验收3②：日志里的判定字符串与报告里的判定字符串一致",
    !!verdictEv && report.includes(verdictEv.reason) && report.includes(`[${verdictEv.status}] ${verdictEv.step}`));
  check("验收3③：判定事件带耗时（ms）",
    eventsOfAll(arch, "voter_verdict").every((e) => typeof e.ms === "number" && e.ms >= 0));
  check("验收3④：验证者原始输出（解析前）也留证（每票一条）",
    eventsOfAll(arch, "verifier_result").length === VOTERS, String(eventsOfAll(arch, "verifier_result").length));

  for (const ev of ["start", "step_start", "do_submitted", "verify_start", "voter_verdict", "advance", "complete", "destroy"]) {
    check(`生命周期事件 ${ev} 已入日志`, hasEvent(arch, ev), JSON.stringify(eventsOf(arch)));
  }
  check("日志不改变推进：实例已销毁 + 报告状态「完成」+ 判定 passed",
    gone && report.includes("- 状态：**完成**") && report.includes("[passed] loop:"));

  // 验收 2 的逐字节证明（需要基线库；md5 版留档见产出目录的 regression-probe.mjs）
  if (process.env.RF_BASELINE_LIB) {
    const { createEngine: createBase } = await import(path.join(path.resolve(process.env.RF_BASELINE_LIB), "engine.js"));
    const bws = wsOf("l1base");
    const bsid = `l1base-${RUN}`;
    const base = createBase(bws, {
      deliver: () => true,
      verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: "2026-01-01T00:00:00.000Z", status: "passed", reason: REASON }),
      log: () => {},
    });
    base.ensureLayout();
    base.start("loop", `执行日志验收 ${RUN}`, bsid);
    const bid = base.listInstances().at(-1).id;
    base.onSubmit(bsid, "完成");
    await sleep(200);
    const baseReport = fs.readFileSync(path.join(bws, RF, "reports", `${bid}.md`), "utf-8");
    const cur = norm(report);
    const stripped = cur.replace(LOG_LINE_RE, "").replace(/\n{2,}/g, "\n\n");
    const baseNorm = norm(baseReport);
    check("验收2：报告去掉新增那一行后与基线库（RF_BASELINE_LIB）逐字节相同",
      stripped === baseNorm, `\n--- 当前(归一化,去新增行) ---\n${stripped}\n--- 基线(归一化) ---\n${baseNorm}`);
    check("验收2：基线报告里没有执行日志行（新增确为我方引入）", !LOG_LINE_RE.test(baseNorm));
    forget(bws);
  } else {
    console.log("  ⚠️  未设 RF_BASELINE_LIB，跳过「报告逐字节相同」的跨库比对（md5 留档见 regression-probe.mjs）");
  }
  check("日志写入不污染诊断端口（事件名与载荷形状不变）",
    logs.some((l) => l.ev === "instance_start") && logs.some((l) => l.ev === "verify_start") && logs.some((l) => l.ev === "voter_verdict"),
    JSON.stringify(logs.map((l) => l.ev)));
  forget(ws);
}

// ── L2 全生命周期事件：pause/resume/adopted/gate_opened/gate_released/check_skipped/cancelled
console.log("L2 生命周期事件面（§3.2 的事件流清单）");
{
  const ws = wsOf("l2");
  writeWorkflow(ws, "log-probe", `description: 验收用：失败暂停 + 无 check 的人工审查门
manual_step:
  - gate
steps:
  - id: work
    desc: 有 check 的工作步
    do: 做事
    check: 检查
    on_pass: gate
    on_fail: work
    max_fail_count: 1
  - id: gate
    desc: 纯人工审查门（无 check）
    do: 做事
    on_pass: done
`);
  const { engine } = mkEngine(ws, { scripted: [{ status: "failed", reason: "第一轮不通过" }, { status: "passed", reason: "第二轮通过" }] });
  const sid = `owner-${RUN}`;
  const { id } = start(engine, "log-probe", "生命周期事件验收", sid);
  const lp = logPathOf(ws, id);

  engine.onSubmit(sid, "第一轮");
  await sleep(150);
  const j1 = parseJsonl(lp);
  check("失败达上限 → pause 事件入日志", hasEvent(j1, "pause") && eventOf(j1, "pause").reason === "max_failures",
    JSON.stringify(eventOf(j1, "pause") ?? null));
  check("pause 事件带步骤与失败轮数", eventOf(j1, "pause")?.step === "work" && eventOf(j1, "pause")?.failedTimes === 1);

  // 接管（adopted）+ 解除暂停（resume）
  const cont = engine.continueInstance(`other-session-${RUN}`, id);
  await sleep(150);
  const j2 = parseJsonl(lp);
  check("接管他人实例 → adopted 事件入日志", cont.ok && hasEvent(j2, "adopted"), cont.text);
  check("解除暂停 → resume 事件入日志（带来源原因）",
    hasEvent(j2, "resume") && eventOf(j2, "resume").from === "max_failures", JSON.stringify(eventOf(j2, "resume") ?? null));

  // 第二轮通过 → 推进到无 check 的人工审查门
  const j3 = parseJsonl(lp);
  check("推进 → advance 事件带 from/to", hasEvent(j3, "advance") && eventOf(j3, "advance").to === "gate", JSON.stringify(eventOf(j3, "advance") ?? null));
  check("推进到下一步 → step_start 事件", j3.lines.filter((l) => l.event === "step_start").length >= 2);

  engine.onSubmit(`other-session-${RUN}`, "门上的产出");
  await sleep(150);
  const j4 = parseJsonl(lp);
  check("无 check 的步骤 → check_skipped 事件入日志",
    hasEvent(j4, "check_skipped") && eventOf(j4, "check_skipped").reason === "no_check", JSON.stringify(eventOf(j4, "check_skipped") ?? null));
  check("审查门打开 → gate_opened 事件（kind=manual_no_check）",
    hasEvent(j4, "gate_opened") && eventOf(j4, "gate_opened").kind === "manual_no_check", JSON.stringify(eventOf(j4, "gate_opened") ?? null));

  const rel = engine.continueInstance(`other-session-${RUN}`);
  await sleep(150);
  // 放行 = 最后一步 → advance → complete → 销毁实例目录，运行期日志已被归档（副本在 reports/）
  const j5 = parseJsonl(archivedLogOf(ws, id));
  check("放行 → gate_released 事件", rel.ok && hasEvent(j5, "gate_released"), rel.text);
  check("无 check 的步骤绝不写「验证通过」类判定事件（诚实标注）",
    !j5.lines.some((l) => l.event === "verdict" && l.step === "gate"), JSON.stringify(j5.lines.filter((l) => l.step === "gate")));
  const arch2 = parseJsonl(archivedLogOf(ws, id));
  check("跑完 → 归档日志以 complete + destroy 收尾",
    hasEvent(arch2, "complete") && eventsOf(arch2).at(-1) === "destroy", JSON.stringify(eventsOf(arch2)));

  // 取消：cancelled + destroy
  const { engine: e2 } = mkEngine(ws, { scripted: [{ status: "passed", reason: "本用例不会走到验证" }] });
  const sid2 = `cancel-${RUN}`;
  const { id: id2 } = start(e2, "log-probe", "取消事件验收", sid2);
  const res = e2.cancelInstance(sid2, undefined, "验收取消");
  await sleep(100);
  const arch3 = parseJsonl(archivedLogOf(ws, id2));
  check("取消 → cancelled 事件入日志", res.ok && hasEvent(arch3, "cancelled"), res.text);
  check("取消 → destroy 事件收尾", eventsOf(arch3).at(-1) === "destroy", JSON.stringify(eventsOf(arch3)));
  forget(ws);
}

// ── L3 轮转（验收 4）：端口注入 + 环境变量两条通道 ───────────────────────────
console.log("L3 轮转：注入 1 KB 阈值（验收 4）");
{
  const ws = wsOf("l3");
  writeWorkflow(ws, "log-probe", `description: 轮转验收用
steps:
  - id: work
    desc: 有 check 且会长 reason 的步骤
    do: 做事
    check: 检查
    on_pass: done
    on_fail: work
    max_fail_count: 5
`);
  const BIG = `轮转填充-${"长".repeat(2000)}-END`;
  const { engine } = mkEngine(ws, {
    scripted: [{ status: "failed", reason: BIG }, { status: "failed", reason: "第二次小判定" }],
    ports: { logMaxBytes: 1024 },
  });
  const sid = `rot-${RUN}`;
  const { id } = start(engine, "log-probe", "轮转验收", sid);
  engine.onSubmit(sid, "第一轮");
  await sleep(150);
  const lp = logPathOf(ws, id);
  check("验收4：单条超阈值的写入之后、下一次写入之前仍未轮转（照 opencode 在 append 前判）",
    fs.existsSync(lp) && fs.statSync(lp).size > 1024 && !fs.existsSync(`${lp}.1`),
    `size=${fs.existsSync(lp) ? fs.statSync(lp).size : -1}`);
  engine.onSubmit(sid, "第二轮");
  await sleep(150);
  const rotated = fs.existsSync(`${lp}.1`);
  const curSize = fs.existsSync(lp) ? fs.statSync(lp).size : -1;
  check("验收4：注入阈值后出现 .log.1", rotated);
  check("验收4：当前文件不超阈值（< 1024 B）", curSize >= 0 && curSize < 1024, `size=${curSize}`);
  const j1 = parseJsonl(`${lp}.1`);
  check("验收4：轮转文件同样是合法 JSONL，且留有被挤出去的完整事件",
    j1.exists && j1.bad === null && j1.lines.length > 0, j1.bad ?? "");
  check("验收4：轮转文件里能看到超限的那条大事件（完整，未截断）",
    j1.lines.some((l) => l.event === "verdict" && l.reason === BIG));
  engine.cancelInstance(sid, undefined, "轮转用例收尾");
  await sleep(80);
  forget(ws);
}
{
  const ws = wsOf("l3env");
  writeWorkflow(ws, "log-probe", `description: 环境变量阈值轮转验收
steps:
  - id: work
    desc: 有 check 且会长 reason 的步骤
    do: 做事
    check: 检查
    on_pass: done
    on_fail: work
    max_fail_count: 5
`);
  const BIG = `环境变量阈值-${"长".repeat(2000)}-END`;
  process.env.RALPHFLOW_LOG_MAX_BYTES = "1024";
  const { engine } = mkEngine(ws, { scripted: [{ status: "failed", reason: BIG }, { status: "failed", reason: "第二次小判定" }] });
  const sid = `rotenv-${RUN}`;
  const { id } = start(engine, "log-probe", "环境变量轮转验收", sid);
  engine.onSubmit(sid, "第一轮");
  await sleep(150);
  engine.onSubmit(sid, "第二轮");
  await sleep(150);
  const lp = logPathOf(ws, id);
  check("验收4：环境变量 RALPHFLOW_LOG_MAX_BYTES 同样可注入阈值（出现 .log.1）", fs.existsSync(`${lp}.1`));
  check("验收4：环境变量通道下当前文件不超阈值",
    fs.existsSync(lp) && fs.statSync(lp).size < 1024, `size=${fs.existsSync(lp) ? fs.statSync(lp).size : -1}`);
  engine.cancelInstance(sid, undefined, "环境变量用例收尾");
  await sleep(80);
  delete process.env.RALPHFLOW_LOG_MAX_BYTES;
  forget(ws);
}
// 验收 4 的另一半：§3.3 是「保留 **3** 份轮转（.log.1/.log.2/.log.3，**最旧的删除**）」——
// 只验到「出现 .log.1」不足以证明代数上限与最旧被删（写错了会无限膨胀）。
{
  const ws = wsOf("l3gen");
  writeWorkflow(ws, "log-probe", `description: 多代轮转验收用
steps:
  - id: work
    desc: 反复返工的步骤
    do: 做事
    check: 检查
    on_pass: done
    on_fail: work
    max_fail_count: 5
`);
  const { engine } = mkEngine(ws, {
    scripted: Array.from({ length: 5 }, (_, i) => ({ status: "failed", reason: `第${i + 1}轮不通过` })),
    ports: { logMaxBytes: 150 }, // 单行 JSON 远超 150 B → 几乎每次 append 前都轮转
  });
  const sid = `gen-${RUN}`;
  const { id } = start(engine, "log-probe", "多代轮转验收", sid);
  const lp = logPathOf(ws, id);
  for (let i = 0; i < 5; i++) { engine.onSubmit(sid, `第${i + 1}轮`); await sleep(120); }
  const gens = [1, 2, 3].map((i) => `${lp}.${i}`);
  const dirNow = () => JSON.stringify(fs.readdirSync(path.dirname(lp)));
  check("验收4：轮转到 .log.1 / .log.2 / .log.3 三代", gens.every((f) => fs.existsSync(f)), dirNow());
  check("验收4：第 4 代被删除（上限恰为 3，不无限膨胀）", !fs.existsSync(`${lp}.4`), dirNow());
  check("验收4：三代轮转文件都是合法 JSONL 且非空",
    gens.every((f) => { const j = parseJsonl(f); return j.exists && j.bad === null && j.lines.length > 0; }));
  engine.cancelInstance(sid, undefined, "多代轮转用例收尾");
  await sleep(80);
  forget(ws);
}

// ── L4 日志失败不致命（验收 5）───────────────────────────────────────────────
console.log("L4 日志写失败不致命（验收 5）");
if (typeof process.getuid === "function" && process.getuid() === 0) {
  console.log("  ⚠️  以 root 运行：chmod 挡不住写入，本环境无法注入「日志不可写」，跳过");
} else {
  const ws = wsOf("l4");
  const { engine, logs } = mkEngine(ws, { scripted: [{ status: "passed", reason: "日志只读也要通过" }] });
  const sid = `ro-${RUN}`;
  const { id } = start(engine, "loop", "只读日志验收", sid);
  const lp = logPathOf(ws, id);
  // 日志文件不可写（保留可读）：等价于「日志这一层写不进去」，而 state.json 仍可写
  // （任务书 §3.1 把日志放在实例目录内、与 state.json 同目录；目录级 chmod 500 会先打断
  //   state.json 的写入 —— 那是既有行为，与本任务的日志层无关，见 change-note.md）。
  if (fs.existsSync(lp)) fs.chmodSync(lp, 0o500);
  else check("验收5：运行期日志文件存在（否则无从注入「写失败」）", false, lp);
  let threw = null;
  try {
    engine.onSubmit(sid, "完成");
    await sleep(200);
  } catch (e) { threw = e; }
  const report = fs.existsSync(reportOf(ws, id)) ? fs.readFileSync(reportOf(ws, id), "utf-8") : "";
  check("验收5：日志不可写时不抛异常", threw === null, String(threw));
  check("验收5：工作流照常跑完并推进（实例销毁 + 报告归档「完成」）",
    engine.readState(id) === null && report.includes("- 状态：**完成**"), report.slice(0, 200));
  check("验收5：推进判定未被改变（判定仍是 passed，且 N 票都在报告里）",
    (report.match(/\[passed\] loop:/g) ?? []).length === loopVotersOf(engine));
  check("验收5：只多一条 warning（execution_log_write_failed）",
    logs.some((l) => l.lvl === "warn" && l.ev === "execution_log_write_failed"), JSON.stringify(logs.map((l) => `${l.lvl}:${l.ev}`)));
  check("验收5：除日志写失败外没有任何新增告警",
    logs.filter((l) => l.lvl === "warn" || l.lvl === "error").every((l) => l.ev === "execution_log_write_failed"),
    JSON.stringify(logs.filter((l) => l.lvl !== "info")));
  check("验收5：报告指路的归档日志真实存在（不假指路）", fs.existsSync(archivedLogOf(ws, id)));
  check("验收5：归档日志里能看到失败发生前的完整事件（不可写之前的部分照常留证）",
    hasEvent(parseJsonl(archivedLogOf(ws, id)), "start"));
  if (fs.existsSync(lp)) fs.chmodSync(lp, 0o600); // 恢复权限（若已随实例销毁则无需恢复）
  forget(ws);

  // 任务书验收 5 的字面做法是「把日志目录设成不可写（chmod 500）」。本实现按 §3.1 把
  // execution.log 放在**实例目录内、与 state.json 同目录**，所以对目录 chmod 500 会先打断
  // state.json 的写入（tmp+rename 需要目录写权限）——这是**既有**的 state I/O 行为，与日志层无关。
  // 这里如实跑一遍并留证：日志层照样不抛、照样继续写（文件本身仍可写），失败的是 state 落盘。
  const ws2 = wsOf("l4dir");
  const { engine: e2, logs: logs2 } = mkEngine(ws2, { scripted: [{ status: "passed", reason: "通过" }] });
  const sid2 = `rodir-${RUN}`;
  const { id: id2 } = start(e2, "loop", "目录只读实验", sid2);
  const instDir2 = e2.instanceDir(id2);
  fs.chmodSync(instDir2, 0o500);
  try {
    let threw2 = null;
    try { e2.onSubmit(sid2, "完成"); await sleep(200); } catch (e) { threw2 = e; }
    const logAfter = parseJsonl(logPathOf(ws2, id2));
    check("验收5（目录级 chmod 500）：日志层同样不抛异常", threw2 === null, String(threw2));
    check("验收5（目录级 chmod 500）：日志文件已存在时仍可继续追加（目录写权限只影响增删条目）",
      logAfter.exists && logAfter.lines.length >= 3, `lines=${logAfter.lines.length}`);
    check("验收5（目录级 chmod 500）：推进被打断的原因是既有的 state 落盘失败，不是日志失败",
      logs2.some((l) => l.ev === "state_write_failed") && !logs2.some((l) => l.ev === "execution_log_write_failed"),
      JSON.stringify(logs2.map((l) => `${l.lvl}:${l.ev}`)));
  } finally {
    fs.chmodSync(instDir2, 0o700); // 无论如何恢复权限（测试失败也不留只读目录）
  }
  e2.cancelInstance(sid2, undefined, "目录只读实验收尾");
  await sleep(80);
  forget(ws2);
}

// ── L5 零状态变化（验收 6）──────────────────────────────────────────────────
console.log("L5 零新状态字段（验收 6）");
{
  const ws = wsOf("l5");
  writeWorkflow(ws, "log-probe", `description: 零状态验收用
manual_step:
  - gate
steps:
  - id: work
    desc: 有 check 的工作步
    do: 做事
    check: 检查
    on_pass: gate
    on_fail: work
  - id: gate
    desc: 门
    do: 做事
    on_pass: done
`);
  const { engine } = mkEngine(ws, { scripted: [{ status: "passed", reason: "通过" }] });
  const sid = `zero-${RUN}`;
  const { id } = start(engine, "log-probe", "零状态验收", sid);
  engine.onSubmit(sid, "完成");
  await sleep(150);
  const stPath = path.join(ws, RF, "instances", id, "state.json");
  const persisted = JSON.parse(fs.readFileSync(stPath, "utf-8"));
  const keys = Object.keys(persisted).sort();
  // 039f2f6 基线的 InstanceState 落盘键全集（新增任何键都会在这里报出来）
  const BASELINE_KEYS = ["active", "artifacts_dir_name", "current_step", "delegations", "do_submitted", "fail_counts",
    "history", "last_submit_summary", "owner_session", "pause_reason", "paused", "started_at", "updated_at",
    "user_task", "verdicts", "workflow_name"].sort();
  const extra = keys.filter((k) => !BASELINE_KEYS.includes(k));
  check("验收6：state.json 没有任何基线之外的键", extra.length === 0, `extra=${JSON.stringify(extra)}`);
  check("验收6：state.json 里没有日志字段（execution.log / log*）",
    !keys.some((k) => /log/i.test(k)) && !JSON.stringify(persisted).includes("execution.log"));

  if (process.env.RF_BASELINE_LIB) {
    const { createEngine: createBase } = await import(path.join(path.resolve(process.env.RF_BASELINE_LIB), "engine.js"));
    const bws = wsOf("l5base");
    writeWorkflow(bws, "log-probe", `description: 零状态验收用
manual_step:
  - gate
steps:
  - id: work
    desc: 有 check 的工作步
    do: 做事
    check: 检查
    on_pass: gate
    on_fail: work
  - id: gate
    desc: 门
    do: 做事
    on_pass: done
`);
    const base = createBase(bws, {
      deliver: () => true,
      verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: "2026-01-01T00:00:00.000Z", status: "passed", reason: "通过" }),
      log: () => {},
    });
    base.ensureLayout();
    const bsid = `zerobase-${RUN}`;
    base.start("log-probe", "零状态验收", bsid);
    const bid = base.listInstances().at(-1).id;
    base.onSubmit(bsid, "完成");
    await sleep(150);
    const bkeys = Object.keys(JSON.parse(fs.readFileSync(path.join(bws, RF, "instances", bid, "state.json"), "utf-8"))).sort();
    check("验收6：与基线跑同一工作流的 state.json 键集合完全一致",
      JSON.stringify(keys) === JSON.stringify(bkeys), `cur=${JSON.stringify(keys)}\nbase=${JSON.stringify(bkeys)}`);
    forget(bws);
  }
  forget(ws);
}

// ── L6 销毁期归档：两条**有意不对称**的不变量（§3.1 / §3.6）──────────────────
// 任务书 §3.1：「报告归档失败 → 不销毁」（现状不变）；「日志归档失败只告警、不阻塞销毁」。
// 日志归档被插在报告归档**之后**（步骤 ①b），所以还多一条必须成立的性质：
// 报告归档失败时 ① 早退，①b **不得**执行（绝不出现「报告没归档、日志倒先归档了」）。
console.log("L6 销毁期归档的两条不对称不变量（§3.1）");
{
  // 6a) 日志归档失败 → 只告警、不阻塞销毁；报告照常归档、推进判定不变
  const ws = wsOf("l6a");
  const { engine, logs } = mkEngine(ws, { scripted: [{ status: "passed", reason: "日志归档失败也要通过" }] });
  const sid = `archfail-${RUN}`;
  const { id } = start(engine, "loop", "日志归档失败验收", sid);
  // 注入：在**归档目标**位置放一个目录 → copyFileSync 报 EISDIR；
  // 报告目标是 `<id>.md`（另一个路径），因此「报告成功 + 日志失败」可稳定构造。
  fs.mkdirSync(archivedLogOf(ws, id), { recursive: true });
  let threw = null;
  try { engine.onSubmit(sid, "完成"); await sleep(200); } catch (e) { threw = e; }
  const report = fs.existsSync(reportOf(ws, id)) ? fs.readFileSync(reportOf(ws, id), "utf-8") : "";
  check("§3.1：日志归档失败时不抛异常", threw === null, String(threw));
  check("§3.1：日志归档失败仍照常销毁实例（不阻塞销毁）", engine.readState(id) === null);
  check("§3.1：日志归档失败时报告照常归档且状态「完成」", report.includes("- 状态：**完成**"), report.slice(0, 160));
  check("§3.1：推进判定未被改变（判定仍 passed）", report.includes("[passed] loop:"));
  check("§3.1：日志归档失败只多一条 warning（execution_log_archive_failed）",
    logs.some((l) => l.lvl === "warn" && l.ev === "execution_log_archive_failed"),
    JSON.stringify(logs.map((l) => `${l.lvl}:${l.ev}`)));
  check("§3.1：两条不变量确实不对称 —— 日志失败不触发 report_archive_failed",
    !logs.some((l) => l.ev === "report_archive_failed"));
  // 已知边界（如实标注，见 change-note.md「如实披露」一节）：报告先于 ①b 写出，此时运行期日志确实存在，
  // 所以那一行**仍会**写出；归档随后失败 → 该行悬空（指向的不是文件）。
  check("§3.1 已知边界：归档失败时报告指路行仍会写出，且它悬空（目标不是文件）",
    (report.match(/^- 执行日志：/gm) ?? []).length === 1 && !fs.statSync(archivedLogOf(ws, id)).isFile());
  forget(ws);

  // 6b) 报告归档失败 → 不销毁（现状不变），且 ①b 必须被早退短路
  const ws2 = wsOf("l6b");
  const { engine: e2, logs: logs2 } = mkEngine(ws2, { scripted: [{ status: "passed", reason: "报告归档失败用例" }] });
  const sid2 = `repfail-${RUN}`;
  const { id: id2 } = start(e2, "loop", "报告归档失败验收", sid2);
  const reportsDir2 = path.join(ws2, RF, "reports");
  fs.rmSync(reportsDir2, { recursive: true, force: true });
  fs.writeFileSync(reportsDir2, "occupied"); // 同名普通文件占位 → mkdir/write 全部 ENOTDIR
  let threw2 = null;
  try { e2.onSubmit(sid2, "完成"); await sleep(200); } catch (e) { threw2 = e; }
  const rt2 = parseJsonl(logPathOf(ws2, id2));
  check("§3.6：报告归档失败 → 不销毁（实例目录仍在、state.json 仍在）",
    fs.existsSync(e2.instanceDir(id2)) && e2.readState(id2) !== null);
  check("§3.6：报告归档失败 → 记 report_archive_failed 并告警",
    logs2.some((l) => l.ev === "report_archive_failed"));
  check("§3.6：报告归档失败时 ①b 被早退短路（没有 execution_log_archive_failed）",
    !logs2.some((l) => l.ev === "execution_log_archive_failed"), JSON.stringify(logs2.map((l) => l.ev)));
  check("§3.6：报告归档失败时不落 destroy 事件（①b 未执行，销毁序列未启动）",
    rt2.exists && !hasEvent(rt2, "destroy"), JSON.stringify(eventsOf(rt2)));
  check("§3.6：不抛出（失败只走告警通道）", threw2 === null, String(threw2));
  fs.rmSync(reportsDir2, { recursive: true, force: true });
  fs.mkdirSync(reportsDir2, { recursive: true });
  forget(ws2);
}

console.log(`\n${pass} passed, ${fail} failed  (lib=${LIB})`);
process.exit(fail > 0 ? 1 : 0);
