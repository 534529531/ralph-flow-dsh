/**
 * **播报不唤醒**（缺陷修复的回归）—— 真实插件装配 + 真实 Session。
 *
 * 缺陷：引擎的播报与指令共用同一个出口（`agent.steer`）。dsh 的 `steer` 在**空闲**驱动器上会
 * 开一个新回合（`dsh-agent` 文档原话 *An idle driver starts a turn*），于是「给人看的进度播报」
 * 把模型叫醒了：验证期间模型在没有 DO 的情况下自己开工、正在收尾的回合被续上、返工的重置与
 * DO 投不出去（实测见任务书）。
 *
 * 修法：播报改为**直接 append 到会话可见面**（不碰收件箱、不碰驱动器），指令仍走 `steer`。
 * 本文件把两条判据钉死在**可观察的形状**上：
 *
 *   N1 **播报立刻可见且不唤醒**：空闲会话上投播报 → 同一次调用里就成为可见面节点
 *      （用户时间线上马上多一行），且 `steer` 零调用（不开新回合）、收件箱零条目。
 *   N2 **收尾中的回合不被续上**：投播报后收件箱仍为空 —— 宿主的回合循环判据是
 *      `turnEnds && inbox.nextStep.length === 0`（`dsh-agent-loop/lib/index.js`），
 *      收件箱为空 ⇒ 回合按原样结束（`steer`/`inject` 都会往收件箱塞，都会续回合）。
 *   N3 **指令仍唤醒**：DO / 命令转达 / 交卷提醒仍走 `steer`（它们是「要模型干活」）。
 *   N4 **工具调用在飞时不劈开配对**：可见面尾部工具配对不平衡时，播报**挂起**而不是插进
 *      「assistant(tool-calls) → tool/result」中间（那会让下一次请求在多数 provider 上报错）；
 *      tool/result 一落地就自动补齐，顺序是 assistant(tool-call) → tool/result → notice。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage, createToolResultMessage, createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { RALPHFLOW_SOURCE_KIND } from "../lib/message-source.js";
import * as plugin from "../lib/index.js";
import { cleanupTmp, mkTmp, cmdOf, textOf, toolOf } from "./helpers/plugin-harness.mjs";

// HOME 隔离（工作协议）：测试绝不读写真实 ~/.dsh。必须在 apply 之前设置。
process.env.HOME = mkTmp("home");
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);

/**
 * 宿主替身：真实 `Session`（真实 surface fold / 工具配对折叠）+ 真实插件装配。
 *
 * `steered` 就是「驱动器被唤醒」的唯一入口 —— 真宿主里 `steer` 在空闲期**等于开一个新回合**，
 * 在运行期等于在下一个 step 边界取走。所以本文件把 `steered.length` 当「唤醒次数」用。
 * `inbox` 是它的收件箱：宿主的回合循环只看 `inbox.nextStep.length` 决定要不要续跑一步。
 */
function mkEnv(ws, sid) {
  const ctx = new Context();
  const registered = { tools: [], commands: [], skills: [] };
  const steered = [];
  const agents = new Map();
  const session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  agents.set(sid, {
    id: sid,
    session,
    steer: (m) => { steered.push(m); },
    followup: (m) => { steered.push(m); },
  });

  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [{ name: "read" }, { name: "grep" }, { name: "glob" }, { name: "bash" }] });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("skills", { register: (d) => { registered.skills.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    // 验证委派永远悬挂：本文件只关心「投播报的那一瞬」，不关心判定
    start: () => ({ id: "child", result: new Promise(() => {}) }),
  });
  ctx.provide("agents", { get: (id) => agents.get(id) });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });

  /** 可见面上的播报（notice）节点：用户时间线上「立刻多出来的那些行」 */
  const surfaceNotices = () => {
    const onSurface = new Set(session.surface.nodes);
    return session.snapshotEvents()
      .filter((e) => e.type === "user/message" && onSurface.has(e.seq) && e.data?.source?.kind === RALPHFLOW_SOURCE_KIND && e.data?.source?.form === "notice")
      .map((e) => e.data);
  };
  return { ctx, registered, steered, session, sid, surfaceNotices };
}

/** 取本步 DO 的正文特征：DO 提示词里一定有这一段 */
const DO_MARK = "本步要做什么";

console.log("N1 空闲会话：播报**立刻**落成可见行，且**不唤醒**（不开新回合）");
{
  const ws = mkTmp("notice1");
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `notice1-${RUN}`;
  const H = mkEnv(ws, sid);
  plugin.apply(H.ctx);

  const startTool = toolOf(H.registered, "ralphflow_start");
  const submitTool = toolOf(H.registered, "ralphflow_submit");
  const call = (t, a) => t.execute(a ?? {}, { agent: { session: { id: sid } }, signal: new AbortController().signal });

  const startReceipt = String(await call(startTool, { workflow: "loop", task: "播报不唤醒用例" }));
  check("前提：首步 DO 随工具结果返回（这一步本来就不经投递端口）",
    startReceipt.includes(DO_MARK) && H.steered.length === 0, `steered=${H.steered.length}`);
  const steeredBefore = H.steered.length;

  // 交卷 → 引擎发出「独立验证者正在取证」这条**播报**
  await call(submitTool, { summary: "做完了" });

  // ① 立刻可见：**没有**等任何回合、任何 drain
  const notices = H.surfaceNotices();
  const verifyNotice = notices.find((m) => textOf(m).includes("独立验证者"));
  check("N1a 播报在同一次调用里就出现在可见面上（用户时间线上马上多一行）",
    !!verifyNotice, JSON.stringify(notices.map((m) => textOf(m).slice(0, 40))));
  check("N1b 播报做成 notice 行（source.form=notice + 非空 summary）",
    verifyNotice?.source?.kind === RALPHFLOW_SOURCE_KIND && verifyNotice?.source?.form === "notice" && String(verifyNotice?.source?.summary ?? "").trim() !== "",
    JSON.stringify(verifyNotice?.source ?? null));

  // ② 不唤醒：空闲驱动器一动不动（真宿主里 steer 在空闲期 = 开新回合）
  check("N1c 播报没有走 steer：零唤醒（空闲会话保持空闲）",
    H.steered.length === steeredBefore, `steeredBefore=${steeredBefore} now=${H.steered.length}`);
  check("N1d 播报不会被重复投递：来一条指令之后，可见面上仍是那一条",
    H.surfaceNotices().filter((m) => textOf(m).includes("独立验证者")).length === 1
      && (await (async () => {
        const cmd = cmdOf(H.registered, "ralphflow-status");
        await cmd.handler({ commandId: "c-dedupe", agent: { session: { id: sid } }, rawInput: "", attachments: [], signal: new AbortController().signal });
        return H.surfaceNotices().filter((m) => textOf(m).includes("独立验证者")).length === 1;
      })()),
    JSON.stringify(H.surfaceNotices().map((m) => textOf(m).slice(0, 30))));
  check("N1e 播报确实属于会话（模型下一回合看得到它）",
    H.session.deriveMessages().some((m) => textOf(m).includes("独立验证者")), "不在 deriveMessages() 里");
  cleanupTmp(ws);
}

console.log("\nN2 回合正在收尾：投播报**不把回合续上**（收件箱保持为空）");
{
  const ws = mkTmp("notice2");
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `notice2-${RUN}`;
  const H = mkEnv(ws, sid);
  plugin.apply(H.ctx);
  const startTool = toolOf(H.registered, "ralphflow_start");
  const submitTool = toolOf(H.registered, "ralphflow_submit");
  const call = (t, a) => t.execute(a ?? {}, { agent: { session: { id: sid } }, signal: new AbortController().signal });

  await call(startTool, { workflow: "loop", task: "收尾不被续上" });
  await call(submitTool, { summary: "做完了" });

  // 宿主回合循环的续跑判据（dsh-agent-loop）：`turnEnds && inbox.nextStep.length === 0` → break。
  // 播报不进收件箱 ⇒ 判据仍成立 ⇒ 这个正在收尾的回合照原样结束。
  check("N2 交卷收尾期间：收件箱零条目（回合按原样结束，不被播报续上）",
    H.steered.length === 0, `steered=${H.steered.length}`);
  check("N2 同时播报已经可见（不拿「续回合」换「看得见」）",
    H.surfaceNotices().some((m) => textOf(m).includes("独立验证者")));
  cleanupTmp(ws);
}

console.log("\nN3 指令仍唤醒：命令转达 / DO 仍走 steer");
{
  const ws = mkTmp("notice3");
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `notice3-${RUN}`;
  const H = mkEnv(ws, sid);
  plugin.apply(H.ctx);
  const cmd = cmdOf(H.registered, "ralphflow-status");
  await cmd.handler({ commandId: "c1", agent: { session: { id: sid } }, rawInput: "", attachments: [], signal: new AbortController().signal });
  check("N3a 命令转达是**指令**：走 steer（唤醒），且不进可见面",
    H.steered.length === 1 && H.surfaceNotices().length === 0,
    `steered=${H.steered.length} notices=${H.surfaceNotices().length}`);
  const steeredText = textOf(H.steered[0]);
  check("N3b 指令带来源前缀（模型知道这是谁的话）", steeredText.includes("[ralphflow]"), steeredText.slice(0, 60));

  // 推进到下一步的 DO 也是指令（step 无 check 时交卷即推进）
  const wfDir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "nochk.yaml"), [
    "steps:",
    "  - id: a", "    desc: 第一步", "    do: 做 A", "    input: 任务", "    output: A 产出",
    "    on_pass: b", "    on_fail: a", "    max_fail_count: 3",
    "  - id: b", "    desc: 第二步", "    do: 做 B", "    input: A 产出", "    output: B 产出",
    "    on_pass: done", "    on_fail: b", "    max_fail_count: 3",
  ].join("\n"));
  await plugin.apply(H.ctx); // 让新工作区的工作流被登记（快捷命令登记是幂等的）
  const startTool = toolOf(H.registered, "ralphflow_start");
  const submitTool = toolOf(H.registered, "ralphflow_submit");
  const call = (t, a) => t.execute(a ?? {}, { agent: { session: { id: sid } }, signal: new AbortController().signal });
  await call(startTool, { workflow: "nochk", task: "两步无检查" });
  const beforeSteer = H.steered.length;
  await call(submitTool, { summary: "第一步完成" });
  const newSteers = H.steered.slice(beforeSteer);
  check("N3c 下一步 DO 仍是**指令**（唤醒模型继续干）",
    newSteers.some((m) => textOf(m).includes(DO_MARK)), JSON.stringify(newSteers.map((m) => textOf(m).slice(0, 40))));
  check("N3d 无检查步骤的推进播报仍是**播报**（不唤醒）",
    H.surfaceNotices().some((m) => textOf(m).includes("跳过对抗性验证")),
    JSON.stringify(H.surfaceNotices().map((m) => textOf(m).slice(0, 40))));
  cleanupTmp(ws);
}

console.log("\nN4 工具调用在飞：播报**挂起**，绝不插进 tool 配对中间");
{
  const ws = mkTmp("notice4");
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `notice4-${RUN}`;
  const H = mkEnv(ws, sid);
  plugin.apply(H.ctx);
  const session = H.session;

  // 可见面：一条携带 tool-call 的 assistant/message，**还没有** tool/result（工具在飞）
  session.append("assistant/message", {
    turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: "tool-call", id: "call-busy", name: "bash", arguments: "{}" }],
      source: { kind: "model", provider: "p", model: "m" },
    }),
    stream: [],
  }, { surfaceOp: "append" });

  const startTool = toolOf(H.registered, "ralphflow_start");
  const submitTool = toolOf(H.registered, "ralphflow_submit");
  const call = (t, a) => t.execute(a ?? {}, { agent: { session: { id: sid } }, signal: new AbortController().signal });
  await call(startTool, { workflow: "loop", task: "工具在飞时投播报" });
  await call(submitTool, { summary: "做完了" });

  check("N4a 配对不平衡时**不插队**：播报没有立刻落到可见面上",
    !H.surfaceNotices().some((m) => textOf(m).includes("独立验证者")),
    JSON.stringify(H.surfaceNotices().map((m) => textOf(m).slice(0, 40))));
  check("N4b 也没有退回收件箱（那会把收尾中的回合续上）",
    H.steered.filter((m) => textOf(m).includes("独立验证者")).length === 0);

  // 工具结果落地 → 尾部落回步骤边界 → 播报自动补齐
  session.append("tool/result", {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: "call-busy", content: [{ type: "text", text: "工具完成" }], isError: false }),
  }, { surfaceOp: "append" });
  await sleep(400); // 兜底定时器（250ms，unref）会来补

  const notices = H.surfaceNotices();
  check("N4c tool/result 落地后播报自动补齐（不漏投）",
    notices.some((m) => textOf(m).includes("独立验证者")), JSON.stringify(notices.map((m) => textOf(m).slice(0, 40))));

  // 顺序断言：assistant(tool-call) → tool/result → notice，中间不夹任何 user/message
  const seqs = [...session.surface.nodes];
  const evAt = (seq) => session.snapshotEvents().find((e) => e.seq === seq);
  const ttSeq = seqs.find((s) => evAt(s)?.type === "assistant/message");
  const trSeq = seqs.find((s) => evAt(s)?.type === "tool/result");
  const noSeq = seqs.find((s) => evAt(s)?.type === "user/message" && evAt(s)?.data?.source?.kind === RALPHFLOW_SOURCE_KIND);
  check("N4d 顺序正确：tool/result 紧跟它的 tool-call，播报在**其后**",
    ttSeq !== undefined && trSeq !== undefined && noSeq !== undefined && trSeq > ttSeq && noSeq > trSeq
      && seqs.indexOf(trSeq) === seqs.indexOf(ttSeq) + 1,
    JSON.stringify(seqs.map((s) => evAt(s)?.type)));
  cleanupTmp(ws);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
