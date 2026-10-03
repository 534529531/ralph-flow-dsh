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
import { createEngine, resetCauseOf, stepWantsReset } from "../lib/engine.js";
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
    input: 上游产出
    output: 本步产出
    desc: 第一步
    do: 做第一步的工作
    check: 第一步是否真的完成
    on_pass: second
    on_fail: first
    max_fail_count: 3
  - id: second
    input: 上游产出
    output: 本步产出
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
    input: 上游产出
    output: 本步产出
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
    input: 上游产出
    output: 本步产出
    desc: 第一步（无 check：交卷即推进）
    do: 做第一步的工作
    on_pass: b
    on_fail: a
    max_fail_count: 3
  - id: b
    input: 上游产出
    output: 本步产出
    desc: 第二步（带 reset）
    reset: true
    do: 做第二步的工作
    check: 第二步是否真的完成
    on_pass: done
    on_fail: b
    max_fail_count: 3
`;
// 工作流级 auto_reset：三步，每步推进都该恰一次替换（首步结构上除外）
const WF_AUTO = `description: auto_reset 验收
auto_reset: true
steps:
  - id: a
    input: 上游产出
    output: 本步产出
    desc: 第一步（首步：结构上无法重置）
    do: 做 A 的工作
    check: A 是否真的完成
    on_pass: b
    on_fail: a
    max_fail_count: 3
  - id: b
    input: 上游产出
    output: 本步产出
    desc: 第二步
    do: 做 B 的工作
    check: B 是否真的完成
    on_pass: c
    on_fail: b
    max_fail_count: 3
  - id: c
    input: 上游产出
    output: 本步产出
    desc: 第三步
    do: 做 C 的工作
    check: C 是否真的完成
    on_pass: done
    on_fail: c
    max_fail_count: 3
`;
// 手动 /ralphflow-reset 验收：第二步**没有**标 reset（证明手动路径强制重置），max_fail_count=2
// （第一次失败 → fail_count=1 返工不暂停；第二次失败 → 2>=2 暂停，用来验证暂停中拒绝）
const WF_MANUAL = `description: 手动 reset 验收
steps:
  - id: first
    input: 上游产出
    output: 本步产出
    desc: 第一步
    do: 做第一步的工作
    check: 第一步是否真的完成
    on_pass: second
    on_fail: first
    max_fail_count: 3
  - id: second
    input: 上游产出
    output: 本步产出
    desc: 第二步（未标 reset：手动重置也要生效）
    do: 做第二步的工作
    check: 第二步是否真的完成
    on_pass: done
    on_fail: second
    max_fail_count: 2
`;
// 嵌套 auto_reset：子工作流自带 auto_reset，父工作流首步就是调用点（展开后首步 = call/s1）。
// 用来钉死「合成 reset 绝不能冒充作者标了这一步」这条措辞要求。
const WF_SUB_AUTO = `description: 子工作流带 auto_reset
auto_reset: true
steps:
  - id: s1
    input: 上游产出
    output: 本步产出
    desc: 子第一步
    do: 做子工作流 s1 的工作
    check: s1 是否真的完成
    on_pass: done
    on_fail: s1
    max_fail_count: 3
`;
const WF_PARENT_CALLS_AUTO = `description: 父工作流首步即调用带 auto_reset 的子工作流（父级没写 auto_reset）
steps:
  - id: call
    desc: 步骤 call
    input: 上游产出
    output: 本步产出
    on_fail: call
    max_fail_count: 3
    workflow: subauto
    on_pass: done
`;
const WF_PARENT_AUTO_CALLS_AUTO = `description: 父子都 auto_reset，首步是调用点
auto_reset: true
steps:
  - id: call
    desc: 步骤 call
    input: 上游产出
    output: 本步产出
    on_fail: call
    max_fail_count: 3
    workflow: subauto
    on_pass: done
`;
// 父级有普通首步，第二步才是调用点 —— 让「子工作流 auto_reset 下沉」的步骤在**运行期**
// 真正走一次替换（首步结构上无法替换，单步流只能靠返工触发）。
const WF_PARENT_NORMAL_THEN_CALLS_AUTO = `description: 父首步普通，第二步调用带 auto_reset 的子工作流
steps:
  - id: p1
    input: 上游产出
    output: 本步产出
    desc: 父第一步
    do: 做父 p1 的工作
    check: p1 是否真的完成
    on_pass: call
    on_fail: p1
    max_fail_count: 3
  - id: call
    desc: 步骤 call
    input: 上游产出
    output: 本步产出
    on_fail: call
    max_fail_count: 3
    workflow: subauto
    on_pass: done
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
/** 当前工作区里所有实例的 execution.log 拼起来（执行日志可复盘性断言用） */
const execLogTextOf = (ws) => {
  const root = path.join(ws, ".dsh", "ralph-flow", "instances");
  let names = [];
  try { names = fs.readdirSync(root); } catch { return ""; }
  return names.map((n) => {
    try { return fs.readFileSync(path.join(root, n, "execution.log"), "utf-8"); } catch { return ""; }
  }).join("\n");
};

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
  check("/ralphflow-reset 命令仍在（命令面固定），且**仍然不注册** ralphflow_reset 工具（机械动作在命令处理器里做，不给模型可调用的修复入口）",
    !!resetCmd && !names.includes("ralphflow_reset"), H.registered.commands.map((c) => c.name).join(","));
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

// ═══ 12) 工作流级 auto_reset: true：每步推进恰一次替换 + 回执措辞按来源分 ═══════
console.log("\n12) 工作流级 auto_reset: true（每步推进恰一次替换）");
{
  const H = setup({ rfauto: WF_AUTO }, "rfauto");
  seedPrior(H.session);
  const startText = await H.turn(async () => {
    const out = await H.call("ralphflow_start", { workflow: "rfauto", task: "任务书 AUTO" });
    H.appendToolExchange("auto-start", "ralphflow_start", out);
    return out;
  });
  // 措辞按来源分两支（任务书硬要求）：auto_reset 带出的重置**不得**被说成「本步标了 reset: true」
  check("auto_reset 启动回执说的是工作流级 auto_reset，绝不出现「本步标了 `reset: true`」（作者没标）",
    startText.includes("本工作流标了 `auto_reset: true`") && !startText.includes("本步标了 `reset: true`"),
    startText.slice(0, 500));
  check("auto_reset 首步回执同样如实说明「首步初次进入无法重置」与「重试会重置」",
    startText.includes("工作流首步的初次进入无法做上下文重置") && startText.includes("重试时会正常重置"),
    startText.slice(0, 500));
  check("首步初次进入确实没有替换（结构边界：首步 DO 是工具返回值）",
    replacementEventsOf(H.session).length === 0, `count=${replacementEventsOf(H.session).length}`);

  // a → b：推进恰一次替换
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "a 完成" });
    H.appendToolExchange("auto-sub-a", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1); H.drainInbox();
  await H.waitVerifier(); H.releaseVerifier(true);
  await H.waitInbox(1); await sleep(20);
  const doB = H.drainInbox();
  check("auto_reset：推进到第二步**恰发生 1 次**替换",
    replacementEventsOf(H.session).length === 1, `count=${replacementEventsOf(H.session).length}`);
  {
    const msgs = H.session.deriveMessages();
    const texts = msgs.map((m) => textOf(m));
    check("auto_reset：第二步交接后 messages = 系统提示 + 交接稿 + DO（3 条）", msgs.length === 3, `count=${msgs.length}`);
    check("auto_reset：交接稿写的是第 2/3 步 b",
      texts[1]?.includes("`rfauto`（第 2/3 步）") && texts[1]?.includes("`b`"), texts[1]);
    check("auto_reset：第二步 DO 已投递（做 B 的工作）", doB.some((m) => textOf(m).includes("做 B 的工作")));
  }

  // b → c：再恰一次替换（累计 2）
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "b 完成" });
    H.appendToolExchange("auto-sub-b", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1); H.drainInbox();
  await H.waitVerifier(); H.releaseVerifier(true);
  await H.waitInbox(1); await sleep(20);
  const doC = H.drainInbox();
  check("auto_reset：推进到第三步再**恰一次**替换（累计 2 次，不多不少）",
    replacementEventsOf(H.session).length === 2, `count=${replacementEventsOf(H.session).length}`);
  {
    const msgs = H.session.deriveMessages();
    const texts = msgs.map((m) => textOf(m));
    check("auto_reset：第三步交接后 messages 仍是 3 条，且写的是第 3/3 步 c",
      msgs.length === 3 && texts[1]?.includes("第 3/3 步") && texts[1]?.includes("`c`"),
      JSON.stringify(texts.map((t) => t.slice(0, 30))));
    check("auto_reset：第三步 DO 已投递（做 C 的工作）", doC.some((m) => textOf(m).includes("做 C 的工作")));
    check("auto_reset：每步的旧对话都被移出模型上下文",
      !texts.some((t) => t.includes("重构登录模块")), JSON.stringify(texts.map((t) => t.slice(0, 24))));
  }
  cleanupTmp(H.ws);
}

// ═══ 13) 手动 /ralphflow-reset：只换干净上下文（DO 重投、失败计数保留、暂停拒绝）═══
console.log("\n13) 手动 /ralphflow-reset（重做当前步）");
{
  const H = setup({ rfmanual: WF_MANUAL }, "rfmanual");
  seedPrior(H.session);
  await runToSecondStep(H);
  check("手动重置前：第二步没有标 reset，零替换（证明后面的替换来自手动路径）",
    replacementEventsOf(H.session).length === 0, `count=${replacementEventsOf(H.session).length}`);

  const resetCmd = H.registered.commands.find((c) => c.name === "ralphflow-reset");
  const invokeReset = () => resetCmd.handler({ rawInput: "", agent: { session: { id: H.sid } }, signal: new AbortController().signal });

  // 先制造一次真实失败：第二步交卷 → 验证不过 → 返工回本步（fail_count=1，未到 max=2 不暂停）
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "第二步完成" });
    H.appendToolExchange("manual-sub-1", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1); H.drainInbox();
  await H.waitVerifier(); H.releaseVerifier(false, "第二步没做对");
  await H.waitInbox(1); await sleep(20); H.drainInbox();
  const stBefore = H.instanceState();
  check("失败返工后：fail_counts.second = 1（本用例的前提）",
    stBefore?.fail_counts?.second === 1, JSON.stringify(stBefore?.fail_counts));

  // 手动重置：强制换上下文（该步并没有标 reset），fail_count 原样
  const resetOut = await invokeReset();
  check("手动 /ralphflow-reset 命令受理（{kind:'success'} 且零程序化卡片文本）",
    resetOut.kind === "success" && resetOut.text === undefined, JSON.stringify(resetOut));
  await H.waitInbox(1); await sleep(20);
  const delivered = H.drainInbox();
  check("手动重置在**空闲窗口**完成了替换（恰 1 次 replace）",
    replacementEventsOf(H.session).length === 1, `count=${replacementEventsOf(H.session).length}`);
  check("手动重置把当前步 DO 重投了（做第二步的工作）",
    delivered.some((m) => textOf(m).includes("做第二步的工作")),
    JSON.stringify(delivered.map((m) => textOf(m).slice(0, 40))));
  {
    const msgs = H.session.deriveMessages();
    const texts = msgs.map((m) => textOf(m));
    check("手动重置后 messages = 系统提示 + 交接稿 + DO（3 条）", msgs.length === 3, `count=${msgs.length}`);
    check("手动重置交接稿写的是第 2/2 步 second，旧对话 100% 移出上下文",
      texts[1]?.includes("`rfmanual`（第 2/2 步）") && texts[1]?.includes("`second`")
      && !texts.some((t) => t.includes("重构登录模块")),
      JSON.stringify(texts.map((t) => t.slice(0, 30))));
  }
  const reps = replacementEventsOf(H.session);
  const noticeEvent = allEvents(H.session).find((e) => e.seq === reps[0]?.surfaceOp?.endSeq);
  check("手动重置的可见告知按来源措辞（点明 /ralphflow-reset，不是「步骤开始前」）",
    String(noticeEvent?.data?.source?.summary ?? "").includes("/ralphflow-reset"),
    JSON.stringify(noticeEvent?.data?.source));
  const stAfter = H.instanceState();
  check("手动重置**不赦免失败**：fail_counts.second 原样为 1",
    stAfter?.fail_counts?.second === 1, JSON.stringify(stAfter?.fail_counts));
  check("手动重置不推进状态机：current_step 仍是 second、do_submitted 仍为 false",
    stAfter?.current_step === "second" && stAfter?.do_submitted === false,
    JSON.stringify({ step: stAfter?.current_step, submitted: stAfter?.do_submitted }));

  // 再失败一次到 max_fail_count=2 → 暂停；此时 reset 必须拒绝并指向 /ralphflow-continue
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "第二步再交卷" });
    H.appendToolExchange("manual-sub-2", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1); H.drainInbox();
  await H.waitVerifier(); H.releaseVerifier(false, "还是没做对");
  await H.waitInbox(1); await sleep(20); H.drainInbox();
  const stPaused = H.instanceState();
  check("max_fail_count=2：第二次失败即暂停（pause_reason=max_failures，走到暂停态）",
    stPaused?.paused === true && stPaused?.pause_reason === "max_failures",
    JSON.stringify({ paused: stPaused?.paused, reason: stPaused?.pause_reason }));

  H.inbox.length = 0;
  const rej = await invokeReset();
  check("暂停中执行 /ralphflow-reset：命令受理但引擎**拒绝**，且不产生任何替换",
    rej.kind === "success" && replacementEventsOf(H.session).length === 1,
    `reps=${replacementEventsOf(H.session).length}`);
  check("拒绝原因交给模型自然语言转达，并指向 /ralphflow-continue",
    H.inbox.some((m) => textOf(m).includes("拒绝") && textOf(m).includes("/ralphflow-continue")),
    JSON.stringify(H.inbox.map((m) => textOf(m).slice(0, 80))));
  const stRej = H.instanceState();
  check("暂停被拒后：失败计数（2）与暂停态原样（reset 只换上下文、不赦免失败）",
    stRej?.fail_counts?.second === 2 && stRej?.paused === true,
    JSON.stringify({ fail: stRej?.fail_counts, paused: stRej?.paused }));
  cleanupTmp(H.ws);
}

// ═══ 14) auto_reset 的加载期校验 / 纯函数语义 / 子工作流下沉 ═════════════════════
console.log("\n14) auto_reset：校验、语义、子工作流下沉");
{
  const ws = mkTmp("reset-parse");
  tmpDirs.push(ws);
  const wfDir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "ok.yaml"),
    "description: ok\nauto_reset: true\nsteps:\n  - id: s\n    desc: 单步\n    input: 上游产出\n    output: 本步产出\n    do: x\n    check: y\n    on_pass: done\n    on_fail: s\n    max_fail_count: 3\n");
  fs.writeFileSync(path.join(wfDir, "bad.yaml"),
    "description: bad\nauto_reset: \"yes\"\nsteps:\n  - id: s\n    desc: 单步\n    input: 上游产出\n    output: 本步产出\n    do: x\n    on_pass: done\n    on_fail: s\n    max_fail_count: 3\n");
  fs.writeFileSync(path.join(wfDir, "sub.yaml"),
    "description: sub\nauto_reset: true\nsteps:\n  - id: s1\n    desc: 子一步\n    input: 上游产出\n    output: 本步产出\n    do: s1\n    check: c1\n    on_pass: done\n    on_fail: s1\n    max_fail_count: 3\n");
  fs.writeFileSync(path.join(wfDir, "parent.yaml"),
    "description: parent\nsteps:\n  - id: p1\n    desc: 父一步\n    input: 上游产出\n    output: 本步产出\n    do: p1\n    check: c1\n    on_pass: call\n    on_fail: p1\n    max_fail_count: 3\n"
    + "  - id: call\n    desc: 调用点\n    input: 上游产出\n    output: 本步产出\n    workflow: sub\n    on_pass: done\n    on_fail: call\n    max_fail_count: 3\n");
  const eng = createEngine(ws, { deliver: () => true, verify: async () => ({ status: "passed", reason: "stub" }) });

  const ok = eng.loadWorkflow("ok");
  check("auto_reset: true 透传进定义，且无 problems",
    ok.def?.auto_reset === true && ok.problems.length === 0, JSON.stringify(ok.problems));
  const bad = eng.loadWorkflow("bad");
  check("auto_reset 非布尔 = 加载期硬错误（不静默当成 false）",
    !bad.def && bad.problems.some((p) => p.includes("auto_reset") && p.includes("布尔")),
    JSON.stringify(bad.problems));

  check("纯函数：步骤级 reset 优先记作 step（作者确实标了这一步）",
    resetCauseOf({ auto_reset: true }, { reset: true }) === "step");
  check("纯函数：工作流级 auto_reset 记作 auto",
    resetCauseOf({ auto_reset: true }, {}) === "auto");
  check("纯函数：都不标 = undefined / false",
    resetCauseOf({}, {}) === undefined && stepWantsReset({}, {}) === false);
  check("纯函数：auto_reset 覆盖所有步骤（任何方式进入都触发）",
    stepWantsReset({ auto_reset: true }, {}) === true);
  check("纯函数：子工作流 auto_reset 下沉出的合成 reset 仍记作 auto（不是作者标的 step）",
    resetCauseOf({}, { reset: true, reset_from_auto: true }) === "auto");
  check("纯函数：下沉标记纯措辞用途，不改变行为（仍要重置）",
    stepWantsReset({}, { reset: true, reset_from_auto: true }) === true);

  const parent = eng.loadWorkflow("parent");
  const expanded = parent.def?.steps.find((s) => s.id === "call/s1");
  check("子工作流的 auto_reset 在加载期静态展开时下沉为子步骤 reset: true（不静默失效）",
    expanded?.reset === true && parent.problems.length === 0,
    JSON.stringify({ reset: expanded?.reset, problems: parent.problems }));
  check("下沉同时保留来源标记 reset_from_auto（否则措辞会说错话）",
    expanded?.reset_from_auto === true && resetCauseOf(parent.def, expanded) === "auto",
    JSON.stringify({ marker: expanded?.reset_from_auto, cause: parent.def ? resetCauseOf(parent.def, expanded) : null }));

  check("doctor：纯线性流配 auto_reset 会提示 token 成本（作者应知情）",
    (ok.warnings ?? []).some((w) => w.includes("auto_reset") && w.includes("token")),
    JSON.stringify(ok.warnings));
  cleanupTmp(ws);
}

// ═══ 15) auto_reset 的失败重试（同步骤重进）也触发重置 ═════════════════════════
console.log("\n15) auto_reset：失败重试（同步骤重进）也触发重置");
{
  const H = setup({ rfauto2: WF_AUTO }, "rfauto2");
  seedPrior(H.session);
  await runToSecondStep(H);
  check("auto_reset：进入第二步发生 1 次替换", replacementEventsOf(H.session).length === 1,
    `count=${replacementEventsOf(H.session).length}`);
  // 第二步交卷 → 验证不过 → on_fail 回本步（**同步骤重进**）→ 必须再次替换
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "b 完成" });
    H.appendToolExchange("auto2-sub-b", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1); H.drainInbox();
  await H.waitVerifier(); H.releaseVerifier(false, "B 没做对");
  await H.waitInbox(1); await sleep(20);
  const delivered = H.drainInbox();
  check("auto_reset：同步骤失败重试也触发重置（累计 2 次替换）",
    replacementEventsOf(H.session).length === 2, `count=${replacementEventsOf(H.session).length}`);
  const msgs = H.session.deriveMessages();
  const texts = msgs.map((m) => textOf(m));
  check("auto_reset：重试交接后 messages 仍是 3 条，且 DO 带上失败原因（现场不丢）",
    msgs.length === 3 && texts[2]?.includes("B 没做对"),
    JSON.stringify(texts.map((t) => t.slice(0, 40))));
  check("auto_reset：重试 DO 照常投递", delivered.some((m) => textOf(m).includes("做 B 的工作")),
    JSON.stringify(delivered.map((m) => textOf(m).slice(0, 40))));
  cleanupTmp(H.ws);
}

// ═══ 16) 嵌套 auto_reset：首步是「调用带 auto_reset 的子工作流」→ 措辞仍走 auto 支 ═══
console.log("\n16) 嵌套 auto_reset：启动回执按来源措辞（绝不说「本步标了 reset: true」）");
{
  // 16a) 父级没写 auto_reset，只有子工作流写了：展开后首步是 call/s1，来源是子层 auto_reset。
  const H = setup({ subauto: WF_SUB_AUTO, psub: WF_PARENT_CALLS_AUTO }, "psub");
  seedPrior(H.session);
  const startOut = await H.turn(async () => H.call("ralphflow_start", { workflow: "psub", task: "嵌套 auto 任务" }));
  const text = typeof startOut === "string" ? startOut : "";
  check("首步来源是子工作流 auto_reset 时，启动回执按 auto 支措辞（含「本工作流标了 auto_reset」）",
    text.includes("本工作流标了 `auto_reset: true`"), JSON.stringify(text.slice(0, 240)));
  check("绝不出现「本步标了 `reset: true`」（作者只写过 auto_reset）",
    !text.includes("本步标了 `reset: true`"), JSON.stringify(text.slice(0, 240)));
  cleanupTmp(H.ws);

  // 16b) 父级也写 auto_reset：同样不能因合成 reset 而冒充作者标记。
  const H2 = setup({ subauto: WF_SUB_AUTO, psubauto: WF_PARENT_AUTO_CALLS_AUTO }, "psubauto");
  seedPrior(H2.session);
  const startOut2 = await H2.turn(async () => H2.call("ralphflow_start", { workflow: "psubauto", task: "父子 auto 任务" }));
  const text2 = typeof startOut2 === "string" ? startOut2 : "";
  check("父子都 auto_reset、首步是调用点：仍按 auto 支措辞（含「本工作流标了 auto_reset」）",
    text2.includes("本工作流标了 `auto_reset: true`"), JSON.stringify(text2.slice(0, 240)));
  check("父子都 auto_reset 时也绝不出现「本步标了 `reset: true`」",
    !text2.includes("本步标了 `reset: true`"), JSON.stringify(text2.slice(0, 240)));
  cleanupTmp(H2.ws);

  // 16c) 运行期：父级普通首步 → 调用带 auto_reset 的子工作流，推进时的替换必须走 auto 来源
  //      （不能因为合成键就把 reset_surface 事件的 trigger 记成 step，也不能把可见告知说错）。
  const H3 = setup({ subauto: WF_SUB_AUTO, pnested: WF_PARENT_NORMAL_THEN_CALLS_AUTO }, "pnested");
  seedPrior(H3.session);
  await H3.turn(async () => {
    const out = await H3.call("ralphflow_start", { workflow: "pnested", task: "嵌套运行期任务" });
    H3.appendToolExchange("nested-start", "ralphflow_start", out);
    return out;
  });
  await H3.turn(async () => {
    const out = await H3.call("ralphflow_submit", { summary: "父第一步完成" });
    H3.appendToolExchange("nested-sub-1", "ralphflow_submit", out);
    return out;
  });
  await H3.waitInbox(1); H3.drainInbox();
  await H3.waitVerifier(); H3.releaseVerifier(true, "p1 通过");
  await H3.waitInbox(1); await sleep(20);
  H3.drainInbox();
  check("嵌套 auto_reset 的步骤在运行期确实替换（恰 1 次）",
    replacementEventsOf(H3.session).length === 1, `count=${replacementEventsOf(H3.session).length}`);
  const logs3 = execLogTextOf(H3.ws);
  check("嵌套 auto_reset 的 reset_surface 事件 trigger = auto（不冒充作者标的 step）",
    /"event":"reset_surface"[^\n]*"trigger":"auto"/.test(logs3), logs3.slice(-500));
  // auto 门的可见告知由载体**直接 append**（随后被同一次替换遮蔽），不进引擎收件箱：
  // 按 test 13 的同一口径，从 replace 事件的 endSeq（= noticeSeq）取那条节点。
  const rep3 = replacementEventsOf(H3.session)[0];
  const noticeEvent3 = allEvents(H3.session).find((e) => e.seq === rep3?.surfaceOp?.endSeq);
  const noticeSummary3 = String(noticeEvent3?.data?.source?.summary ?? "");
  check("嵌套 auto_reset 的可见告知走 auto 支（「步骤 call/s1 开始前已重置」，不点手动命令）",
    noticeSummary3.includes("call/s1") && noticeSummary3.includes("已重置上下文") && !noticeSummary3.includes("/ralphflow-reset"),
    JSON.stringify(noticeSummary3));
  cleanupTmp(H3.ws);
}

// ═══ 17) 手动 /ralphflow-reset 在回合中按下、回合以交卷收尾 → 绝不静默作废 ═══════
console.log("\n17) 手动 /ralphflow-reset：空闲窗口复查发现已交卷 → 必须可见告知（不静默）");
{
  const H = setup({ rfdrop: WF_MANUAL }, "rfdrop");
  seedPrior(H.session);
  await runToSecondStep(H); // 到第二步 DO（该步未标 reset，未交卷）
  const resetCmd = H.registered.commands.find((c) => c.name === "ralphflow-reset");
  const invokeReset = () => resetCmd.handler({ rawInput: "", agent: { session: { id: H.sid } }, signal: new AbortController().signal });

  const repsBefore = replacementEventsOf(H.session).length;
  const stBefore = H.instanceState();
  check("前提：第二步未标 reset、DO 阶段、零替换",
    repsBefore === 0 && stBefore?.current_step === "second" && stBefore?.do_submitted === false,
    JSON.stringify({ reps: repsBefore, step: stBefore?.current_step, submitted: stBefore?.do_submitted }));

  // 关键时序（验证者 2/4 复现的反例）：命令在**回合进行中**按下（phase='turn'），
  // 随后同一回合以 ralphflow_submit 收尾。替换要等空闲窗口才做得成，届时 do_submitted
  // 已是 true → 只能放弃；但命令处理器当场已回 success，用户必须收到可见告知。
  let resetOut = null;
  await H.turn(async () => {
    resetOut = await invokeReset();
    const out = await H.call("ralphflow_submit", { summary: "第二步完成（在 reset 排队期间）" });
    H.appendToolExchange("drop-sub", "ralphflow_submit", out);
    return out;
  });
  check("命令当场受理（零程序化卡片）——所以可见告知是唯一结果通道",
    resetOut?.kind === "success" && resetOut?.text === undefined, JSON.stringify(resetOut));
  await H.waitInbox(1); await sleep(30);
  const delivered = H.drainInbox();
  check("回合以交卷收尾：手动重置**不发生替换**（0 次，绝不在验证在飞时打断）",
    replacementEventsOf(H.session).length === repsBefore,
    `count=${replacementEventsOf(H.session).length}`);
  check("被丢弃的手动重置发**可见告知**（点明 /ralphflow-reset 且说明没有生效）",
    delivered.some((m) => textOf(m).includes("/ralphflow-reset") && textOf(m).includes("没有生效")),
    JSON.stringify(delivered.map((m) => textOf(m).slice(0, 80))));
  check("告知带 summary（时间线上不展开也能读到「未生效」）",
    delivered.some((m) => String(m?.source?.summary ?? "").includes("/ralphflow-reset") && String(m?.source?.summary ?? "").includes("未生效")),
    JSON.stringify(delivered.map((m) => m?.source?.summary)));
  check("告知说清原因（已交卷 / 验证中）",
    delivered.some((m) => textOf(m).includes("已经交卷") || textOf(m).includes("已交卷")),
    JSON.stringify(delivered.map((m) => textOf(m).slice(0, 120))));
  check("执行日志记录 manual_reset_dropped（可事后复盘，不只在内存里）",
    execLogTextOf(H.ws).includes("manual_reset_dropped"), execLogTextOf(H.ws).slice(-400));
  const stAfter = H.instanceState();
  check("被丢弃的手动重置不赦免失败、不动状态机（fail_counts 原样、do_submitted 仍 true）",
    stAfter?.fail_counts?.second === stBefore?.fail_counts?.second
    && stAfter?.current_step === "second" && stAfter?.do_submitted === true,
    JSON.stringify({ before: stBefore?.fail_counts, after: stAfter?.fail_counts, step: stAfter?.current_step, submitted: stAfter?.do_submitted }));
  cleanupTmp(H.ws);
}

// ═══ 18) 调用点上的 reset: true：进入子工作流 = 首个展开后子步骤的重置 ═══════════
// 语义按本实现的**静态展开模型**定（展开后「子工作流」这个对象不存在了）：
// 调用点的 reset 下沉到首个展开后子步骤，并打来源标记 `reset_from_call`（记着调用点 id）——
// 措辞才说得出「是调用点标的」，而不是含糊地说「本步标了 reset: true」（作者没在这一步上标）。
console.log("\n18) 调用点 reset: true（进入子工作流 = 首个子步骤的重置）");
{
  // ── 18a) 加载期：下沉 + 来源标记 + 与 auto_reset 的优先级 ──
  const ws = mkTmp("reset-call-parse");
  tmpDirs.push(ws);
  const wfDir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  const subPlain = "description: 普通子工作流\nsteps:\n"
    + "  - id: t1\n    desc: 子一步\n    input: 上游产出\n    output: 本步产出\n    do: 做 T1\n    check: 查 T1\n    on_pass: t2\n    on_fail: t1\n    max_fail_count: 3\n"
    + "  - id: t2\n    desc: 子二步\n    input: 上游产出\n    output: 本步产出\n    do: 做 T2\n    check: 查 T2\n    on_pass: done\n    on_fail: t2\n    max_fail_count: 3\n";
  fs.writeFileSync(path.join(wfDir, "plain-sub.yaml"), subPlain);
  fs.writeFileSync(path.join(wfDir, "callreset.yaml"),
    "description: 调用点带 reset\nsteps:\n"
    + "  - id: call\n    desc: 委托段\n    input: 上游产出\n    output: 本步产出\n    workflow: plain-sub\n    reset: true\n    on_pass: done\n    on_fail: call\n    max_fail_count: 3\n");
  // 子工作流自己也有 auto_reset：整段子工作流的声明更强，来源应保持 auto（不抢来源）
  fs.writeFileSync(path.join(wfDir, "callreset-auto.yaml"),
    "description: 调用点 reset + 子工作流 auto_reset\nsteps:\n"
    + "  - id: call\n    desc: 委托段\n    input: 上游产出\n    output: 本步产出\n    workflow: autosub\n    reset: true\n    on_pass: done\n    on_fail: call\n    max_fail_count: 3\n");
  fs.writeFileSync(path.join(wfDir, "autosub.yaml"),
    "description: 带 auto_reset 的子工作流\nauto_reset: true\nsteps:\n"
    + "  - id: u1\n    desc: 子一步\n    input: 上游产出\n    output: 本步产出\n    do: 做 U1\n    check: 查 U1\n    on_pass: done\n    on_fail: u1\n    max_fail_count: 3\n");
  // 非布尔 = 与步骤级 reset 同一口径的硬错误
  fs.writeFileSync(path.join(wfDir, "callreset-bad.yaml"),
    "description: 调用点 reset 类型错\nsteps:\n"
    + "  - id: call\n    desc: 委托段\n    input: 上游产出\n    output: 本步产出\n    workflow: plain-sub\n    reset: \"true\"\n    on_pass: done\n    on_fail: call\n    max_fail_count: 3\n");
  const eng = createEngine(ws, { deliver: () => true, verify: async () => ({ status: "passed", reason: "stub" }) });

  const cr = eng.loadWorkflow("callreset");
  const first = cr.def?.steps[0];
  check("调用点 reset: true 生效：下沉到**首个展开后子步骤**（id 前缀化、reset 为真）",
    cr.problems.length === 0 && first?.id === "call/t1" && first?.reset === true,
    JSON.stringify({ problems: cr.problems, id: first?.id, reset: first?.reset }));
  check("下沉同时打来源标记 reset_from_call（值是调用点 id）——措辞才说得出是谁标的",
    first?.reset_from_call === "call" && first?.reset_from_auto === undefined, JSON.stringify(first));
  check("纯函数：调用点带出的重置记作 `call`（不是作者标的 `step`）",
    resetCauseOf(cr.def, first) === "call", String(resetCauseOf(cr.def, first)));
  check("调用点 reset 只作用于**首个**子步骤（第二个子步骤不受影响）",
    cr.def?.steps[1]?.reset !== true && cr.def?.steps[1]?.reset_from_call === undefined,
    JSON.stringify({ id: cr.def?.steps[1]?.id, reset: cr.def?.steps[1]?.reset }));
  const crAuto = eng.loadWorkflow("callreset-auto");
  check("子工作流自身 auto_reset 优先记作 `auto`（调用点的 reset 不抢来源）",
    crAuto.problems.length === 0 && resetCauseOf(crAuto.def, crAuto.def?.steps[0]) === "auto"
    && crAuto.def?.steps[0]?.reset_from_auto === true,
    JSON.stringify({ problems: crAuto.problems, cause: crAuto.def ? resetCauseOf(crAuto.def, crAuto.def.steps[0]) : null }));
  const crBad = eng.loadWorkflow("callreset-bad");
  check("调用点的 reset 非布尔 = 加载期硬错误（与步骤级同一口径，不静默当 false）",
    !crBad.def && crBad.problems.some((p) => p.includes("调用点") && p.includes("reset") && p.includes("布尔")),
    JSON.stringify(crBad.problems));
  cleanupTmp(ws);
}

// ═══ 18b) 运行期：进入子工作流时真的替换，且回执措辞点明「调用点」 ═══════════════
{
  const WF_CALLSUB = `description: 子工作流（两步）
steps:
  - id: t1
    desc: 子一步
    input: 上游产出
    output: 本步产出
    do: 做 T1 的工作
    check: T1 是否真的完成
    on_pass: t2
    on_fail: t1
    max_fail_count: 3
  - id: t2
    desc: 子二步
    input: 上游产出
    output: 本步产出
    do: 做 T2 的工作
    check: T2 是否真的完成
    on_pass: done
    on_fail: t2
    max_fail_count: 3
`;
  const WF_CALL_PARENT_RESET = `description: 父级第二步是带 reset 的调用点
steps:
  - id: a
    desc: 父第一步
    input: 上游产出
    output: 本步产出
    do: 做 A 的工作
    check: A 是否真的完成
    on_pass: call
    on_fail: a
    max_fail_count: 3
  - id: call
    desc: 委托段
    input: 上游产出
    output: 本步产出
    workflow: callsub
    reset: true
    on_pass: done
    on_fail: call
    max_fail_count: 3
`;
  const H = setup({ callsub: WF_CALLSUB, callparent: WF_CALL_PARENT_RESET }, "callparent");
  seedPrior(H.session);
  await H.turn(async () => {
    const out = await H.call("ralphflow_start", { workflow: "callparent", task: "调用点重置任务" });
    H.appendToolExchange("call-reset-start", "ralphflow_start", out);
    return out;
  });
  check("首步（父级普通步 a）不触发替换", replacementEventsOf(H.session).length === 0,
    `count=${replacementEventsOf(H.session).length}`);
  await H.turn(async () => {
    const out = await H.call("ralphflow_submit", { summary: "a 完成" });
    H.appendToolExchange("call-reset-sub-a", "ralphflow_submit", out);
    return out;
  });
  await H.waitInbox(1); H.drainInbox();
  await H.waitVerifier(); H.releaseVerifier(true, "a 通过");
  await H.waitInbox(1); await sleep(20);
  const delivered = H.drainInbox();
  check("进入子工作流（call/t1）**恰发生 1 次**整段替换",
    replacementEventsOf(H.session).length === 1, `count=${replacementEventsOf(H.session).length}`);
  {
    const msgs = H.session.deriveMessages();
    const texts = msgs.map((m) => textOf(m));
    check("替换后 messages = 系统提示 + 交接稿 + DO（3 条），交接稿指向展开后的步骤 call/t1",
      msgs.length === 3 && texts[1]?.includes("`call/t1`"), JSON.stringify(texts.map((t) => t.slice(0, 40))));
    check("投递的是子工作流首步的 DO（做 T1 的工作）",
      delivered.some((m) => textOf(m).includes("做 T1 的工作")), JSON.stringify(delivered.map((m) => textOf(m).slice(0, 60))));
  }
  // 措辞按来源分：可见告知（被同一次替换遮蔽的那条节点）必须点明「调用点」
  const rep = replacementEventsOf(H.session)[0];
  const noticeEvent = allEvents(H.session).find((e) => e.seq === rep?.surfaceOp?.endSeq);
  const noticeText = textOf(noticeEvent?.data);
  const noticeSummary = String(noticeEvent?.data?.source?.summary ?? "");
  check("可见告知点明来源是**调用点**（不说成「本步标了 reset: true」）",
    noticeText.includes("调用点") && noticeText.includes("reset: true") && !noticeText.includes("本步标了"),
    noticeText.slice(0, 240));
  check("告知带 summary 且同样点明调用点",
    noticeSummary.includes("调用点") && noticeSummary.includes("call"), JSON.stringify(noticeSummary));
  check("执行日志的 reset_surface 事件 trigger = call（可事后复盘来源）",
    /"event":"reset_surface"[^\n]*"trigger":"call"/.test(execLogTextOf(H.ws)), execLogTextOf(H.ws).slice(-400));
  cleanupTmp(H.ws);
}

// ─── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of tmpDirs) { try { cleanupTmp(d); } catch {} }
try { cleanupTmp(process.env.HOME); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
