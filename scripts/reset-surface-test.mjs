/**
 * reset 门（`reset: true`）的 dsh 载体验收 —— **真实 Session + 真实插件装配**。
 *
 * 与其他测试脚本的区别：这里不用引擎替身，而是
 *   · 真实 `Session`（真实 surface fold / `deriveMessages()` / 工具配对折叠）；
 *   · 真实插件装配 `apply(ctx)`（lib/index.js）——工具、端口、resetSurface 载体全是生产件；
 *   · 脚本化「模型回合」（工具调用 + tool/result 落地）与「验证者」（受控 deferred），
 *     精确复现「一步一回合、步与步之间有空闲窗口」的时序。
 *
 * 判据（对应任务书）：
 *   1. 真实跑一次带 `reset: true` 的工作流：交接后模型收到的 messages
 *      **只剩** 系统提示 + 交接稿 + 本步 DO；
 *   2. 负对照：同一条工作流**不写 reset** 时，旧上下文没有被清（仍在 messages 里）；
 *   3. 五条硬约束的负例：工具调用内部（非空闲）拒绝、面不平衡拒绝、node0 不被覆盖、
 *      sourceEventSeqs 覆盖每个被遮蔽节点、不冒用压缩检查点；
 *   4. 首步如实说明（首步 DO 是工具返回值，结构上无法重置）；
 *   5. 返工投递也走同一条接线（reset 再次生效）；
 *   6. 零新增状态字段。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import * as plugin from "../lib/index.js";
import { createResetSurface } from "../lib/reset.js";
import { cleanupTmp, mkTmp, textOf, toolOf } from "./helpers/plugin-harness.mjs";

// HOME 隔离（工作协议）：测试绝不读写真实 ~/.dsh。必须在 apply/createEngine 之前设置。
// 前缀用 `rf-`，这样收尾能用 helpers 的 cleanupTmp（它只肯删 mkdtemp 出来、名字带 rf- 的目录）。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rf-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const SYSTEM_TEXT = "你是 dsh 助手（原系统提示，必须原样保留）。";
const PRIOR_TEXT = "旧对话：帮我重构登录模块（这段必须被移出模型上下文）";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待（避免写死 sleep；超时返回 false，断言会如实失败） */
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

// ─── 工作流定义 ──────────────────────────────────────────────────────────────
const WF_RESET = `description: reset 门验收
steps:
  - id: first
    desc: 第一步
    do: 做第一步的工作
    check: 第一步是否真的完成
    on_pass: second
    on_fail: first
    max_fail_count: 3
  - id: second
    desc: 第二步
    reset: true
    do: 做第二步的工作（这一步之前应已重置上下文）
    check: 第二步是否真的完成
    on_pass: done
    on_fail: second
    max_fail_count: 3
`;
const WF_NORESET = WF_RESET.replace("    reset: true\n", "");
const WF_FIRST_RESET = `description: 首步 reset 验收
steps:
  - id: only
    desc: 首步
    reset: true
    do: 做首步的工作
    check: 首步是否真的完成
    on_pass: done
    on_fail: only
    max_fail_count: 3
`;
// 首步无 check（交卷即推进 —— 推进发生在**工具调用内部**）→ 第二步带 reset
const WF_NOCHECK_THEN_RESET = `description: 无 check 推进 + reset 验收
steps:
  - id: a
    desc: 第一步（无 check：交卷即推进）
    do: 做第一步的工作
    on_pass: b
    on_fail: a
    max_fail_count: 3
  - id: b
    desc: 第二步（带 reset）
    reset: true
    do: 做第二步的工作
    check: 第二步是否真的完成
    on_pass: done
    on_fail: b
    max_fail_count: 3
`;

// ─── 宿主替身（真实 Session + 真实插件装配）──────────────────────────────────
const tmpDirs = [];
let counter = 0;
/** 全局最后一次 setup 的 verifier deferred（各场景独立使用自己的 H） */
function setup(workflows, wfName) {
  const ws = mkTmp("reset-ws");
  tmpDirs.push(ws);
  const wfDir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(wfDir, `${name}.yaml`), yaml);
  process.env.RALPHFLOW_WORKSPACE = ws;

  const sid = `session-reset-${++counter}`;
  const ctx = new Context();
  const registered = { tools: [], commands: [] };
  const agents = new Map();
  const session = Session.create(sid, [], { version: 3, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);

  // 相位：'idle' | 'turn' | 'maintenance'。runMaintenance 在非 idle 时**同步抛错** ——
  // 这正是宿主 dsh-agent-loop 的契约（`agent "${id}" already has active work`），
  // 也是硬约束 1.2/1.3 的护栏。
  // `whenIdle()` 同样按宿主契约实现：驱动器**收工**（phase 回 idle）后兑现 ——
  // 它是「在工具调用内部推进」的路径（审查门放行 / 无 check 步骤交卷）能拿到空闲窗口的唯一办法。
  let phase = "idle";
  const inbox = [];
  const idleWaiters = [];
  let verifierDeferred = null;
  const settleIdle = () => {
    if (phase !== "idle") return;
    for (const r of idleWaiters.splice(0)) r();
  };
  const agent = {
    id: sid,
    session,
    steer: (m) => { inbox.push(m); },
    followup: (m) => { inbox.push(m); },
    whenIdle: () => (phase === "idle" ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
    runMaintenance(job) {
      if (phase !== "idle") throw new Error(`agent "${sid}" already has active work`);
      phase = "maintenance";
      return Promise.resolve()
        .then(() => job(new AbortController().signal))
        .finally(() => { phase = "idle"; settleIdle(); });
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
    start: async () => {
      const d = Promise.withResolvers();
      verifierDeferred = d;
      return { id: "child", result: d.promise };
    },
  });
  ctx.provide("agents", { get: (id) => agents.get(id) });
  ctx.provide("sessions", { list: () => [sid], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });

  // 捕获插件注册的事件监听器：宿主在「本步结束且 next-step 为空」时会 serial 派发
  // `agent/turn-stopping`（dsh-agent-loop/lib/index.js:964-971），payload 里带 agent。
  // 这里按同一契约手动派发，用来验证「DO 延迟投递期间不得误判忘了交卷」。
  const listeners = new Map();
  const origOn = typeof ctx.on === "function" ? ctx.on.bind(ctx) : undefined;
  if (origOn) {
    ctx.on = (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return origOn(name, fn);
    };
  }

  plugin.apply(ctx); // ← 真实装配（含 resetSurface 端口）

  const callAs = async (asSid, name, args) => {
    const tool = toolOf(registered, name);
    if (!tool) throw new Error(`未注册工具 ${name}`);
    return tool.execute(args ?? {}, { agent: { session: { id: asSid } }, signal: new AbortController().signal });
  };
  const call = (name, args) => callAs(sid, name, args);
  /** 一个「模型回合」：期间 phase = turn（工具调用内部，替换必须等回合结束） */
  const turn = async (fn) => {
    phase = "turn";
    try {
      const out = await fn();
      await sleep(10); // 让验证委派在回合内起飞（真实宿主也是在回合内发起委派的）
      return out;
    } finally { phase = "idle"; settleIdle(); }
  };
  /** 宿主把工具结果落成 tool/result 节点（先有携带 tool-call 的 assistant/message，配对才平衡） */
  const appendToolExchange = (callId, name, resultText) => {
    session.append("assistant/message", {
      turn: 9, step: 9,
      message: createAssistantMessage({
        content: [{ type: "tool-call", id: callId, name, arguments: "{}" }],
        source: { kind: "model", provider: "p", model: "m" },
      }),
      stream: [],
    }, { surfaceOp: "append" });
    session.append("tool/result", {
      turn: 9, step: 9,
      message: createToolResultMessage({ callId, content: [{ type: "text", text: resultText }], isError: false }),
    }, { surfaceOp: "append" });
  };
  /** 孤儿 tool-call：制造「空闲但不平衡」的面（硬约束 1.5 的负例） */
  const appendUnmatchedToolCall = (callId) => {
    session.append("assistant/message", {
      turn: 9, step: 9,
      message: createAssistantMessage({
        content: [{ type: "tool-call", id: callId, name: "bash", arguments: "{}" }],
        source: { kind: "model", provider: "p", model: "m" },
      }),
      stream: [],
    }, { surfaceOp: "append" });
  };
  /** 驱动器在回合开始时把收件箱里的消息 append 成 user/message（DO 就是这样进上下文的） */
  const drainInbox = () => {
    const out = [];
    while (inbox.length > 0) {
      const m = inbox.shift();
      session.append("user/message", m, { surfaceOp: "append" });
      out.push(m);
    }
    return out;
  };
  const releaseVerifier = (passed = true, reason = "取证通过") => {
    if (!verifierDeferred) throw new Error("验证者还没被委派");
    verifierDeferred.resolve({ structured: { passed, reason }, output: [], stopReason: "completed" });
    verifierDeferred = null;
  };
  /** 宿主的 turn-stopping 边界：本步结束且收件箱没有下一步工作时 serial 派发 */
  const turnStopping = async () => {
    const out = [];
    for (const fn of listeners.get("agent/turn-stopping") ?? []) {
      out.push(await fn({ agent, turn: 1, signal: new AbortController().signal }));
    }
    return out;
  };
  /** 读当前实例的 state.json（不存在返回 null） */
  const instanceState = () => {
    const root = path.join(ws, ".dsh", "ralph-flow", "instances");
    let names = [];
    try { names = fs.readdirSync(root); } catch { return null; }
    if (names.length === 0) return null;
    try { return JSON.parse(fs.readFileSync(path.join(root, names[0], "state.json"), "utf-8")); } catch { return null; }
  };

  return {
    ws, ctx, sid, session, agent, inbox, registered,
    wfName,
    phaseOf: () => phase,
    call, callAs, turn, appendToolExchange, appendUnmatchedToolCall, drainInbox,
    waitVerifier: () => waitFor(() => verifierDeferred !== null),
    releaseVerifier,
    waitInbox: (n = 1) => waitFor(() => inbox.length >= n),
    turnStopping, instanceState, hasListener: (n) => (listeners.get(n)?.length ?? 0) > 0,
  };
}

/** 种子：系统提示 + 一段真实旧对话（工具配对平衡） */
function seedPrior(session) {
  session.append("system/message", { turn: 0, step: 0, message: createSystemMessage(SYSTEM_TEXT, "dsh-system-prompt") }, { surfaceOp: "append" });
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: PRIOR_TEXT }], source: { kind: "user" } }), { surfaceOp: "append" });
  session.append("assistant/message", {
    turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: "text", text: "旧回复：我先看看现状。" }], source: { kind: "model", provider: "p", model: "m" } }),
    stream: [],
  }, { surfaceOp: "append" });
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "旧追问：先别动登录模块。" }], source: { kind: "user" } }), { surfaceOp: "append" });
}

/** 走完「首步 → 交卷 → 验证通过 → 推进到第二步（reset 门）」，返回各步回执 */
async function runToSecondStep(H, { breakBalance = false } = {}) {
  const startText = await H.turn(async () => {
    const out = await H.call("ralphflow_start", { workflow: H.wfName, task: "任务书 T" });
    H.appendToolExchange("call-start", "ralphflow_start", out);
    return out;
  });
  const submitText = await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "第一步完成" });
    H.appendToolExchange("call-submit", "ralphflow_submit", out);
    return out;
  });
  // 交卷受理播报走 steer → 空闲驱动器**开新一轮**（真实形状）：先把它落成 user/message，
  // 于是它也在随后那次整段替换的遮蔽范围里（这正是「一步一回合」的真实时序）。
  await H.waitInbox(1);
  H.drainInbox();
  // 替换前那一刻的可见面（断言 sourceEventSeqs / node0 用）
  const preResetNodes = [...H.session.surface.nodes];
  if (breakBalance) H.appendUnmatchedToolCall("call-orphan");
  await H.waitVerifier();
  H.releaseVerifier(true);
  await H.waitInbox(1);
  await sleep(20);
  const delivered = H.drainInbox();
  return { startText, submitText, preResetNodes, delivered };
}

const replacementEventsOf = (session) =>
  session.snapshotEvents().filter((e) => e.surfaceOp && typeof e.surfaceOp === "object" && e.surfaceOp.op === "replace");
const allEvents = (session) => session.snapshotEvents();

// ═══ 1) 真实跑一次：交接后 messages 只剩 系统提示 + 交接稿 + DO ═══════════════
console.log("\n1) 真实跑一次（reset: true 的第二步）");
{
  const H = setup({ rfreset: WF_RESET }, "rfreset");
  seedPrior(H.session);
  const seededCount = H.session.deriveMessages().length;
  const { startText, preResetNodes, delivered } = await runToSecondStep(H);

  const msgs = H.session.deriveMessages();
  const texts = msgs.map((m) => textOf(m));
  check("种子：旧对话在重置前确实在模型上下文里（4 条）", seededCount === 4, `count=${seededCount}`);
  check("交接后 messages 恰好 3 条 = 系统提示 + 交接稿 + 本步 DO", msgs.length === 3, JSON.stringify(texts.map((t) => t.slice(0, 40))));
  check("① 第 0 条仍是原系统提示（node0 未被覆盖，硬约束 1.1）",
    msgs[0]?.role === "system" && texts[0] === SYSTEM_TEXT, texts[0]);
  check("② 第 1 条是 ralphflow 的交接稿",
    msgs[1]?.role === "user" && texts[1].includes("[ralphflow 交接稿]"), texts[1]?.slice(0, 80));
  check("交接稿含「工作流名 / 第几步 / 产出目录 / 交互契约」四项（决定①：无已完成勾选）",
    texts[1].includes("`rfreset`（第 2/2 步）")
    && texts[1].includes("`second`")
    && texts[1].includes(".dsh/ralph-flow/artifacts/")
    && texts[1].includes("`ralphflow_submit`")
    // 不含「已完成/✓/👈」这类勾选事实（要它就得造事实源 = 新增状态字段）
    && !/已完成|✅|👈/.test(texts[1]), texts[1]);
  check("③ 第 2 条是本步 DO（任务书 + 本步要做什么 + 产出目录）",
    texts[2].includes("任务书 T") && texts[2].includes("做第二步的工作") && texts[2].includes("产出目录"), texts[2]?.slice(0, 120));
  check("旧对话 100% 不进模型上下文（被 shadow）",
    !texts.some((t) => t.includes("重构登录模块")) && !texts.some((t) => t.includes("旧回复")), JSON.stringify(texts.map((t) => t.slice(0, 30))));
  check("DO 确实被投递到收件箱（交接完成后才投递，顺序不可颠倒）",
    delivered.length === 1 && textOf(delivered[0]).includes("做第二步的工作"));

  // ── 替换事件本身的取证（1.4 / 1.6）──
  const reps = replacementEventsOf(H.session);
  check("日志里恰有 1 次整段替换", reps.length === 1, `count=${reps.length}`);
  const rep = reps[0];
  // 本次替换自带的可见告知 = 被它遮蔽的最后一个节点（endSeq 就是它）
  const noticeEvent = allEvents(H.session).find((e) => e.seq === rep.surfaceOp.endSeq);
  check("替换节点用自有 plugin source（{kind:'plugin', plugin:'ralphflow'}），不冒用 compact（硬约束 1.4）",
    rep?.data?.source?.kind === "plugin" && rep.data.source.plugin === "ralphflow" && rep.data.source.form === undefined,
    JSON.stringify(rep?.data?.source));
  check("日志里没有任何 compaction/* 事件（不伪造压缩事务，硬约束 1.4）",
    !allEvents(H.session).some((e) => String(e.type).startsWith("compaction/")));
  check("替换起点 = 重置前可见面的 nodes[1]（硬约束 1.1）",
    rep?.surfaceOp?.startSeq === preResetNodes[1], JSON.stringify({ got: rep?.surfaceOp, want: preResetNodes[1] }));
  check("替换终点 = 那条可见告知（告知被同一次替换一并遮蔽 → 不进模型上下文）",
    rep?.surfaceOp?.endSeq === noticeEvent?.seq && !H.session.surface.nodes.includes(noticeEvent?.seq),
    JSON.stringify({ end: rep?.surfaceOp?.endSeq, notice: noticeEvent?.seq }));
  check("sourceEventSeqs 覆盖**每一个**被遮蔽节点（硬约束 1.6）",
    JSON.stringify([...rep.sourceEventSeqs].sort((a, b) => a - b))
      === JSON.stringify([...preResetNodes.slice(1), noticeEvent.seq].sort((a, b) => a - b)),
    JSON.stringify({ got: rep.sourceEventSeqs, want: [...preResetNodes.slice(1), noticeEvent.seq] }));
  check("可见告知是 append 来源且带 notice + summary（Chat 视图看得到，决定②）",
    noticeEvent?.data?.source?.form === "notice" && typeof noticeEvent?.data?.source?.summary === "string"
    && noticeEvent.data.source.summary.includes("重置上下文"),
    JSON.stringify(noticeEvent?.data?.source));

  // ── 零新增状态字段 ──
  const instDir = path.join(H.ws, ".dsh", "ralph-flow", "instances");
  const instId = fs.readdirSync(instDir)[0];
  const st = JSON.parse(fs.readFileSync(path.join(instDir, instId, "state.json"), "utf-8"));
  check("实例状态零新增字段（state.json 里没有 reset / handoff 之类的键）",
    !Object.keys(st).some((k) => /reset|handoff|交接/i.test(k)), Object.keys(st).join(","));
  check("推进后 current_step = second（工作流真的走到了带 reset 的那一步）", st.current_step === "second", st.current_step);

  cleanupTmp(H.ws);
}

// ═══ 2) 负对照：不写 reset 时上下文没有被清 ═══════════════════════════════════
console.log("\n2) 负对照（同一条工作流，只是不写 reset）");
{
  const H = setup({ rfnoreset: WF_NORESET }, "rfnoreset");
  seedPrior(H.session);
  await runToSecondStep(H);
  const msgs = H.session.deriveMessages();
  const texts = msgs.map((m) => textOf(m));
  check("不做交接时旧上下文**没有被清**：系统提示 + 旧对话仍在 messages 里",
    msgs[0]?.role === "system" && texts[0] === SYSTEM_TEXT
    && texts.some((t) => t.includes("重构登录模块"))
    && texts.some((t) => t.includes("旧回复")), JSON.stringify(texts.map((t) => t.slice(0, 24))));
  check("负对照里没有发生任何替换（日志零 replace 事件）", replacementEventsOf(H.session).length === 0);
  check("负对照的 messages 明显多于 3 条（旧对话 + 首步工具往返 + DO）", msgs.length > 3, `count=${msgs.length}`);
  check("负对照的第二步 DO 照常投递（不写 reset 不影响推进）",
    texts.some((t) => t.includes("做第二步的工作")), JSON.stringify(texts.map((t) => t.slice(0, 20))));
  cleanupTmp(H.ws);
}

// ═══ 3) 硬约束 1.2：替换绝不发生在工具调用内部（等驱动器收工，落在空闲窗口）═══════
console.log("\n3) 硬约束 1.2：工具调用内部不动手，等驱动器收工后才替换");
{
  const H = setup({ rfreset: WF_RESET }, "rfreset");
  seedPrior(H.session);
  const resetSurface = createResetSurface(H.ctx, () => {});
  const before = allEvents(H.session).length;
  let pending;
  await H.turn(async () => {
    pending = resetSurface(H.sid, { handoff: "交接稿 X", notice: { summary: "x", text: "x" } });
    await sleep(20);
    // 回合仍在进行：此刻替换**绝不能**已经发生（否则会留下孤儿 tool/result）
  });
  check("回合进行中：日志一个事件都没多（替换绝不落在工具调用内部）",
    allEvents(H.session).length === before, `before=${before} now=${allEvents(H.session).length}`);
  const out = await pending;
  check("驱动器收工后：替换在真正的空闲窗口里完成（ok=true）", out.ok === true, JSON.stringify(out));
  check("替换后 messages = 系统提示 + 交接稿（2 条）", H.session.deriveMessages().length === 2, `count=${H.session.deriveMessages().length}`);
  cleanupTmp(H.ws);
}

// ═══ 3b) 老运行时没有 whenIdle：靠 runMaintenance 的护栏如实拒绝，绝不硬来 ════════
console.log("\n3b) 宿主没有 whenIdle 时的降级：非空闲 → 如实拒绝 not_idle");
{
  const H = setup({ rfreset: WF_RESET }, "rfreset");
  seedPrior(H.session);
  delete H.agent.whenIdle; // 模拟老运行时
  const resetSurface = createResetSurface(H.ctx, () => {});
  const before = allEvents(H.session).length;
  let pending;
  await H.turn(async () => {
    pending = resetSurface(H.sid, { handoff: "X", notice: { summary: "x", text: "x" } });
    await sleep(15);
  });
  const out = await pending;
  check("非空闲窗口：载体如实拒绝（reason=not_idle），不硬来", out.ok === false && out.reason === "not_idle", JSON.stringify(out));
  check("被拒时日志**一个事件都没多**（没有孤儿 tool/result 的可能）", allEvents(H.session).length === before);
  check("被拒后会话仍可正常推导 messages（面未损坏）", H.session.deriveMessages().length === 4);
  cleanupTmp(H.ws);
}

// ═══ 4) 硬约束负例 B：面不平衡 → 放弃本次替换，但 DO 照常投递 ═════════════════
console.log("\n4) 硬约束负例：空闲但不平衡（1.5）");
{
  const H = setup({ rfreset: WF_RESET }, "rfreset");
  seedPrior(H.session);
  const { delivered } = await runToSecondStep(H, { breakBalance: true });
  check("不平衡时**放弃**本次替换（日志零 replace 事件）", replacementEventsOf(H.session).length === 0);
  check("放弃后会话仍可正常推导 messages（没有制造孤儿 tool/result）", H.session.deriveMessages().length > 0);
  check("DO 照常投递（重置失败绝不演变成「本步无法执行」）",
    delivered.some((m) => textOf(m).includes("做第二步的工作")), JSON.stringify(delivered.map((m) => textOf(m).slice(0, 40))));
  check("失败原因如实写进用户可见的播报行（不静默）",
    delivered.some((m) => String(m?.source?.summary ?? "").includes("上下文重置未生效")),
    JSON.stringify(delivered.map((m) => String(m?.source?.summary ?? "").slice(0, 70))));
  check("旧上下文未被清（因为替换根本没做）",
    H.session.deriveMessages().some((m) => textOf(m).includes("重构登录模块")));
  cleanupTmp(H.ws);
}

// ═══ 5) 首步如实说明：首步 DO 是工具返回值，结构上无法重置 ═════════════════════
console.log("\n5) 首步标 reset: true → 如实说明，不做替换");
{
  const H = setup({ rffirst: WF_FIRST_RESET }, "rffirst");
  seedPrior(H.session);
  const startText = await H.turn(async () => {
    const out = await H.call("ralphflow_start", { workflow: "rffirst", task: "任务书 F" });
    H.appendToolExchange("call-start", "ralphflow_start", out);
    return out;
  });
  check("启动回执如实说明「首步的初次进入无法重置」及原因，并点明重试会重置",
    startText.includes("工作流首步的初次进入无法做上下文重置")
    && startText.includes("孤儿 tool/result") && startText.includes("重试时会正常重置"), startText.slice(0, 400));
  check("首步确实没有做替换（日志零 replace 事件）", replacementEventsOf(H.session).length === 0);
  check("旧上下文原样保留（没有假装清过）",
    H.session.deriveMessages().some((m) => textOf(m).includes("重构登录模块")));
  cleanupTmp(H.ws);
}

// ═══ 6) 返工投递也走同一条接线（reset 在返工时再次生效）════════════════════════
console.log("\n6) 返工投递（on_fail 回到带 reset 的步）");
{
  const H = setup({ rfreset: WF_RESET }, "rfreset");
  seedPrior(H.session);
  await runToSecondStep(H);
  const afterFirst = replacementEventsOf(H.session).length;
  check("首次进入第二步：1 次替换", afterFirst === 1, `count=${afterFirst}`);
  // 第二步交卷 → 验证判失败 → on_fail 回到 second → 应再次替换并再次投递 DO
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "第二步完成" });
    H.appendToolExchange("call-submit-2", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1);
  H.drainInbox(); // 交卷受理播报（steer → 新一轮）
  await H.waitVerifier();
  H.releaseVerifier(false, "第二步没做对");
  await H.waitInbox(1);
  await sleep(20);
  const delivered = H.drainInbox();
  check("返工：再次替换（共 2 次 replace）", replacementEventsOf(H.session).length === 2, `count=${replacementEventsOf(H.session).length}`);
  check("返工投递的 DO 含失败原因 + 交卷协议",
    delivered.some((m) => textOf(m).includes("第二步没做对")) && delivered.some((m) => textOf(m).includes("ralphflow_submit")),
    JSON.stringify(delivered.map((m) => textOf(m).slice(0, 60))));
  const msgs = H.session.deriveMessages();
  check("返工交接后 messages 仍是 系统提示 + 交接稿 + DO（3 条）", msgs.length === 3, `count=${msgs.length}`);
  check("返工交接稿仍以系统提示打头", textOf(msgs[0]) === SYSTEM_TEXT);
  cleanupTmp(H.ws);
}

// ═══ 7) 装配面：端口存在 + 命令面仍然只声明不实现 ═════════════════════════════
console.log("\n7) 装配面（不把 reset 门误当成 /ralphflow-reset 命令）");
{
  const H = setup({ rfreset: WF_RESET }, "rfreset");
  const names = H.registered.tools.map((t) => t.name);
  check("工具面固定：没有 ralphflow_reset 工具（reset 是步骤级方言，不是模型可调用的命令）",
    !names.includes("ralphflow_reset") && names.includes("ralphflow_start") && names.includes("ralphflow_submit"), names.join(","));
  const resetCmd = H.registered.commands.find((c) => c.name === "ralphflow-reset");
  check("/ralphflow-reset 命令仍在（命令面固定），且其指令仍说明暂缓实现",
    !!resetCmd, H.registered.commands.map((c) => c.name).join(","));
  cleanupTmp(H.ws);
}

// ═══ 8) 内置 spec.yaml 本身：那两行 reset 已启用并真实生效 ════════════════════
console.log("\n8) 内置 spec.yaml（propose / implement 的 reset 已启用）");
{
  // 文件层面：两行确实是**生效的键**（不是注释），且首步 explore 没标
  const specRaw = fs.readFileSync(new URL("../workflows/spec.yaml", import.meta.url), "utf-8");
  const specActive = specRaw.replace(/^\s*#.*$/gm, "");
  check("spec.yaml 里 propose / implement 的 reset 是生效的键（不再是注释）",
    (specActive.match(/^\s*reset:\s*true\b/gm) ?? []).length === 2, specActive.slice(0, 300));
  check("spec.yaml 首步 explore 没标 reset（首步结构上无法重置，不制造无用的告警）",
    !/id:\s*explore[\s\S]{0,120}?reset:/.test(specActive), specActive.slice(0, 400));

  // 行为层面：用**内置 spec** 真跑到第二步（propose = reset 门）
  const H = setup({}, "spec");
  seedPrior(H.session);
  const { delivered } = await runToSecondStep(H);
  const msgs = H.session.deriveMessages();
  const texts = msgs.map((m) => textOf(m));
  check("内置 spec：交接后 messages 恰好 3 条（系统提示 + 交接稿 + DO）", msgs.length === 3, `count=${msgs.length}`);
  check("内置 spec：交接稿写的是第 2/4 步 propose，且产出目录就位",
    texts[1].includes("`spec`（第 2/4 步）") && texts[1].includes("`propose`") && texts[1].includes("artifacts/"), texts[1]);
  check("内置 spec：第 2 条是 propose 的 DO（定稿 proposal + 拆 tasks.md）",
    texts[2].includes("把 proposal.md 定稿") && texts[2].includes("tasks.md"), texts[2]?.slice(0, 120));
  check("内置 spec：explore 阶段的旧对话已被移出上下文",
    !texts.some((t) => t.includes("重构登录模块")), JSON.stringify(texts.map((t) => t.slice(0, 24))));
  check("内置 spec：DO 照常投递", delivered.length === 1 && textOf(delivered[0]).includes("tasks.md"));
  cleanupTmp(H.ws);
}

// ═══ 9) 审查门放行（/ralphflow_continue）→ implement：第二行 reset 也必须生效 ═════
// 第一轮验证者 3/4 实测抓到的缺口：内置 spec 的 implement **只能**经 propose 的审查门进入，
// 而放行是在**工具调用内部**推进的 —— 不等空闲窗口的话第二行 `reset: true` 结构性失效。
console.log("\n9) 审查门放行进入 implement（spec 的第二行 reset）");
{
  const H = setup({}, "spec");
  seedPrior(H.session);
  await runToSecondStep(H); // explore → propose（第一次重置）
  check("进入 propose：第 1 次替换", replacementEventsOf(H.session).length === 1, `count=${replacementEventsOf(H.session).length}`);

  // propose 交卷 → 验证通过 → 停在审查门（不推进）
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "提案完成" });
    H.appendToolExchange("call-submit-2", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1);
  H.drainInbox();
  await H.waitVerifier();
  H.releaseVerifier(true);
  await H.waitInbox(1);
  await sleep(20);
  const gateMsgs = H.drainInbox();
  check("propose 通过后停在审查门（投递 🙋 放行提示，不是 implement 的 DO）",
    gateMsgs.some((m) => textOf(m).includes("审查门")) && !gateMsgs.some((m) => textOf(m).includes("按 tasks.md 逐任务实现")),
    JSON.stringify(gateMsgs.map((m) => textOf(m).slice(0, 50))));
  check("停在审查门时还没进 implement（replace 仍为 1）", replacementEventsOf(H.session).length === 1);

  // 用户放行：模型在**回合内**调用 ralphflow_continue
  let duringTurn = -1;
  const contText = await H.turn(async () => {
    const out = await H.call("ralphflow_continue", {});
    H.appendToolExchange("call-continue", "ralphflow_continue", out);
    await sleep(25);
    duringTurn = replacementEventsOf(H.session).length; // 回合内取证
    return out;
  });
  check("放行回执如实说明「下一步的 DO 会在本回合结束后送达」并叫停本回合的下一步工作",
    contText.includes("本回合结束后") && contText.includes("请勿开始该步的工作"), contText.slice(0, 300));
  check("放行回合进行中：第二次替换**尚未**发生（替换绝不落在工具调用内部）", duringTurn === 1, `count=${duringTurn}`);

  // 回合结束 → 空闲窗口 → 替换 → DO
  await H.waitInbox(1);
  await sleep(20);
  const delivered = H.drainInbox();
  check("放行后第二次替换生效（共 2 次 replace）", replacementEventsOf(H.session).length === 2, `count=${replacementEventsOf(H.session).length}`);
  const msgs = H.session.deriveMessages();
  const texts = msgs.map((m) => textOf(m));
  check("implement 交接后 messages 恰好 3 条 = 系统提示 + 交接稿 + DO", msgs.length === 3, `count=${msgs.length}`);
  check("第 0 条仍是系统提示", texts[0] === SYSTEM_TEXT);
  check("交接稿写的是第 3/4 步 implement", texts[1].includes("`spec`（第 3/4 步）") && texts[1].includes("`implement`"), texts[1]);
  check("第 2 条是 implement 的 DO", texts[2].includes("按 tasks.md 逐任务实现"), texts[2]?.slice(0, 100));
  check("propose 阶段的整段对话（含 propose 的交接稿与审查门往返）100% 移出上下文",
    !texts.some((t) => t.includes("把 proposal.md 定稿")) && !texts.some((t) => t.includes("审查门等你放行")),
    JSON.stringify(texts.map((t) => t.slice(0, 30))));
  check("DO 照常投递", delivered.some((m) => textOf(m).includes("按 tasks.md 逐任务实现")),
    JSON.stringify(delivered.map((m) => textOf(m).slice(0, 40))));
  cleanupTmp(H.ws);
}

// ═══ 10) 替换窗口内实例被取消 → 不替换、不投递 DO（异步窗口的边界）═══════════════
// 第一轮验证者 3/4 实测抓到的第二个缺口：`stillLive()` 曾闭包一个**内存快照**，
// 而取消走的是另一条 readState（新对象）+ 销毁实例目录 ⇒ 护栏成了空操作。
console.log("\n10) 等空闲窗口期间实例被取消：不替换、不投递 DO");
{
  const H = setup({ rf2: WF_NOCHECK_THEN_RESET }, "rf2");
  seedPrior(H.session);
  const instRoot = path.join(H.ws, ".dsh", "ralph-flow", "instances");
  let duringReps = -1;
  await H.turn(async () => {
    const startOut = await H.call("ralphflow_start", { workflow: "rf2", task: "取消窗口用例" });
    H.appendToolExchange("call-start", "ralphflow_start", startOut);
    // a 无 check → 交卷即推进到 b（b 带 reset）；推进在**工具调用内部**，替换在等 whenIdle
    const submitOut = await H.call("ralphflow_submit", { summary: "a 完成" });
    H.appendToolExchange("call-submit", "ralphflow_submit", submitOut);
    await sleep(20);
    duringReps = replacementEventsOf(H.session).length;
    check("取消之前：替换尚未发生（还在等空闲窗口）", duringReps === 0, `count=${duringReps}`);
    // 另一个会话取消这个实例（官方支持的路径：带实例 ID 前缀）
    const instId = fs.readdirSync(instRoot)[0];
    const cancelOut = await H.callAs("other-session", "ralphflow_cancel", { instance: instId });
    check("另一个会话能取消该实例（报告归档 + 实例目录销毁）",
      cancelOut.includes("已取消实例") && !fs.existsSync(path.join(instRoot, instId)), cancelOut.slice(0, 200));
  });
  // 回合结束 → whenIdle 兑现 → 载体应发现实例已收摊
  await sleep(60);
  check("取消窗口内：替换**从未发生**（日志零 replace 事件）", replacementEventsOf(H.session).length === 0, `count=${replacementEventsOf(H.session).length}`);
  check("取消后**不再**投递 b 的 DO（收件箱里既没有它的正文，也没有它的播报行）",
    !H.inbox.some((m) => textOf(m).includes("做第二步的工作") || String(m?.source?.summary ?? "").includes("步骤 b")),
    JSON.stringify(H.inbox.map((m) => `${String(m?.source?.summary ?? "")} | ${textOf(m).slice(0, 40)}`)));
  check("属主会话的旧上下文**没有被清**（没被一条已取消工作流的交接稿替换）",
    H.session.deriveMessages().some((m) => textOf(m).includes("重构登录模块")),
    JSON.stringify(H.session.deriveMessages().map((m) => textOf(m).slice(0, 24))));
  cleanupTmp(H.ws);
}

// ═══ 11) DO 延迟投递期间：宿主 turn-stopping 不得误判「忘了交卷」并把实例暂停 ═════
// 第二轮验证者 2/4 实测抓到：门放行后 DO 在等空闲窗口，收件箱空 → 宿主发 turn-stopping →
// 插件对模型**还不知道存在**的 implement 连催两轮 → 暂停实例（pause_reason=no_submit）。
console.log("\n11) DO 延迟投递期间：turn-stopping 不得误判「忘了交卷」");
{
  const H = setup({}, "spec");
  seedPrior(H.session);
  check("插件确实注册了 agent/turn-stopping 监听（本用例有意义）", H.hasListener("agent/turn-stopping"));
  await runToSecondStep(H); // explore → propose
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "提案完成" });
    H.appendToolExchange("call-submit-2", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1);
  H.drainInbox();
  await H.waitVerifier();
  H.releaseVerifier(true);
  await H.waitInbox(1);
  await sleep(20);
  H.drainInbox();

  // 放行：回合内调 ralphflow_continue；回合结束前宿主会连续派发 turn-stopping
  await H.turn(async () => {
    const out = await H.call("ralphflow_continue", {});
    H.appendToolExchange("call-continue", "ralphflow_continue", out);
    await H.turnStopping(); // 第 1 次
    await H.turnStopping(); // 第 2 次（旧行为会在这里把实例暂停）
    return out;
  });
  check("DO 尚未送达时：turn-stopping 不产生任何「忘了交卷」提醒",
    !H.inbox.some((m) => textOf(m).includes("还没交卷")),
    JSON.stringify(H.inbox.map((m) => textOf(m).slice(0, 60))));
  const stDuring = H.instanceState();
  check("实例没有被误暂停（paused=false，current_step=implement）",
    stDuring?.paused === false && stDuring?.current_step === "implement",
    JSON.stringify({ paused: stDuring?.paused, step: stDuring?.current_step, reason: stDuring?.pause_reason }));

  // 回合结束 → 替换 → DO 送达（此时才该谈交卷）
  await H.waitInbox(1);
  await sleep(20);
  H.drainInbox();
  check("DO 随后正常送达（替换 + DO 都完成）",
    replacementEventsOf(H.session).length === 2 && H.session.deriveMessages().length === 3,
    JSON.stringify({ reps: replacementEventsOf(H.session).length, msgs: H.session.deriveMessages().length }));

  // 反向：DO 已送达后，turn-stopping 必须**恢复**提醒（护栏不能把真「忘了交卷」也吞掉）
  H.inbox.length = 0;
  await H.turnStopping();
  check("DO 送达之后：真「忘了交卷」仍会被提醒（护栏没有把正常路径也吞掉）",
    H.inbox.some((m) => textOf(m).includes("还没交卷")),
    JSON.stringify(H.inbox.map((m) => textOf(m).slice(0, 60))));
  cleanupTmp(H.ws);
}

// ─── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of tmpDirs) { try { cleanupTmp(d); } catch {} }
try { cleanupTmp(process.env.HOME); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
