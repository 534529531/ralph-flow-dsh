/**
 * 判据 7：**真实运行复核**（真实 dsh `AgentLoop` + 真实 `Session` + 真实插件装配）。
 *
 * 任务书要的是「在一个真实 `loop` 实例里观察到：验证期间该会话**没有**新回合；四票齐后会话里
 * 出现 replace 事件（上下文确实被替换）且 DO 送达」。本文件就是这么做的，而且**可重复**：
 *
 *   真实的部分：dsh 的 `AgentLoop`（就是 `steer` 在空闲驱动器上开新回合的那个组件）、
 *   真实 `Session`（真实 surface fold / 工具配对 / 事件日志）、真实 `ToolRuntime`（真的执行
 *   工具调用）、真实 ralphflow 装配（`lib/index.js` 的 `apply`：引擎 + 端口 + 监听器）。
 *   替身的部分：模型（脚本化 stub）与验证者（脚本化判定）—— 它们只决定「说什么」，
 *   不决定「投递怎么落到会话上」，而后者正是本判据要验的东西。
 *
 * 三个观察点：
 *   R1 四张票全部在飞、回合已收尾的那段窗口里：`turn/start` **仍是 1**（没有新回合）、
 *      收件箱**空**（没有待办把它续上），而**验证进度播报已经在可见面上**（立刻可见、没唤醒）。
 *   R2 四票齐（全判失败）→ 会话日志里出现 `surfaceOp.op === "replace"` 事件；替换后可见面 =
 *      系统提示 + 交接稿 + DO，返工 DO（带失败理由）在 replace **之后**落地，pre-reset 的
 *      节点在 replace **之前**（被遮蔽）。
 *   R3【负对照】把「播报走 append」还原成修复前的「播报走 steer」→ **同一条判据必然失败**
 *      （窗口里凭空多出回合）。用仓库自己的 tsc 编一份还原构建，跑同一段用例。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { RALPHFLOW_SOURCE_KIND } from "../lib/message-source.js";
import { buildPluginCopy, REPO } from "./helpers/reverted-build.mjs";
import { cleanupTmp, mkTmp, textOf } from "./helpers/plugin-harness.mjs";

// HOME 隔离（工作协议）：测试绝不读写真实 ~/.dsh。必须在 apply 之前设置。
process.env.HOME = mkTmp("home");
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(20); }
  return (await pred()) === true;
};
const RUN = Math.random().toString(36).slice(2, 8);
const DO_MARK = "本步要做什么";
const VOTE_COUNT = 4;

/**
 * 用**内置 `loop` 工作流**（真·真实 loop 实例）：单步、`reset: true`、四票 `check_voting`、
 * `on_fail: loop`（返工重来）。第一轮四票全判失败 → 走返工路径（替换上下文 + 带理由重投 DO）。
 */
const WORKFLOW_NAME = "loop";
/**
 * 脚本化模型：只做两件事 —— 没启动就调 `ralphflow_start`，拿到 DO 就调 `ralphflow_submit`。
 * 同一个 DO 只交一次卷（否则被 steer 唤醒的那个回合会反复交卷，把负对照跑成死循环）。
 */
function mkStubAdapter(log) {
  let callSeq = 0;
  let lastSubmittedDo = null;
  const toolChunks = (name, args) => {
    const id = `call-${++callSeq}`;
    const json = JSON.stringify(args);
    return [
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id, name, argumentsDelta: json },
      { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: json } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ];
  };
  const sayChunks = (s) => [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: s },
    { type: "block-end", index: 0, block: { type: "text", text: s } },
    { type: "finish", reason: { kind: "stop" } },
  ];
  return new (class extends LlmAdapter {
    providerInfo(p) { return { id: p, name: "Stub" }; }
    resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m }); }
    listModels() { return Promise.resolve([{ id: "stub-1", name: "stub-1" }]); }
    async *stream(options) {
      const texts = (options.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      const all = [options.system ?? "", ...texts].join("\n");
      const doText = texts.filter((t) => t.includes(DO_MARK)).at(-1) ?? null;
      const toolNames = (options.tools ?? []).map((t) => t.name);
      log?.({ kind: "request", hasDo: doText !== null, tools: toolNames.length });
      if (doText && doText !== lastSubmittedDo && toolNames.includes("ralphflow_submit")) {
        lastSubmittedDo = doText;
        for (const c of toolChunks("ralphflow_submit", { summary: "这一步做完了" })) yield c;
        return;
      }
      if (doText === null && toolNames.includes("ralphflow_start") && all.includes("完成任务")) {
        for (const c of toolChunks("ralphflow_start", { workflow: WORKFLOW_NAME, task: "完成任务" })) yield c;
        return;
      }
      for (const c of sayChunks("收到。")) yield c;
    }
  })();
}

/** 真实宿主 + 真实插件装配 + 一段脚本化回合。返回本轮的观察结果。 */
async function runScenario(entryUrl, label) {
  const ws = mkTmp(`real-${label}`);
  process.env.RALPHFLOW_WORKSPACE = ws;

  const ctx = new Context();
  ctx.provide("logger", { info() {}, warn() {}, error() {}, debug() {} });
  // 真实 dsh 组件：steer/inject 的语义、回合循环、可见面折叠、工具执行都是宿主原件
  ctx.plugin(LlmRuntime);
  ctx.plugin(SessionStore);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(SystemPrompt);
  ctx.plugin(ToolRuntime);
  ctx.plugin(AgentRegistry);
  ctx.plugin(AgentLoop);
  await sleep(120);

  ctx.llm.registerAdapter(["stub"], mkStubAdapter());

  /** 四张票的悬挂 resolver（判据要的是「四票都在飞」的那段窗口） */
  const votes = [];
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: async () => {
      const d = Promise.withResolvers();
      votes.push(d);
      return { id: `verifier-${votes.length}`, result: d.promise };
    },
  });
  ctx.provide("commands", { register: () => () => {} });
  ctx.provide("skills", { register: () => () => {} });

  const plugin = await import(entryUrl + (label === "fixed" ? "" : `?${label}-${RUN}`));
  plugin.apply(ctx);

  const sessionId = `session-real-${label}-${RUN}`;
  const { agent } = await ctx.agents.create({ sessionId, meta: { cwd: ws }, agentOptions: { provider: "stub", model: "stub-1" } });
  agent.followup(createUserMessage({ content: [{ type: "text", text: "完成任务" }], source: { kind: "user" } }));

  const evs = () => agent.session.snapshotEvents();
  const turns = () => evs().filter((e) => e.type === "turn/start").length;
  const steps = () => evs().filter((e) => e.type === "step/start").length;
  const replaces = () => evs().filter((e) => e.surfaceOp && typeof e.surfaceOp === "object" && e.surfaceOp.op === "replace");
  const surfaceSeqs = () => [...agent.session.surface.nodes];
  const notices = () => {
    const onSurface = new Set(surfaceSeqs());
    return evs().filter((e) => e.type === "user/message" && onSurface.has(e.seq) && e.data?.source?.kind === RALPHFLOW_SOURCE_KIND);
  };

  // ① 等四票全部飞起来、且那个回合已经收尾
  const delegated = await waitFor(() => votes.length === VOTE_COUNT, 8000);
  await waitFor(() => agent.status === "idle", 4000);
  await sleep(500); // 给「会唤醒的写法」足够机会去唤醒（负对照要靠这段窗口鉴别）

  const window = {
    delegated,
    votes: votes.length,
    turns: turns(),
    steps: steps(),
    inboxPending: agent.inbox.hasPending,
    noticeCount: notices().length,
    hasVerifyNotice: notices().some((e) => textOf(e.data).includes("独立验证者")),
  };

  // ② 四票齐 → 全判失败 → 返工（replace + 带理由的 DO）
  for (const d of votes.splice(0)) {
    d.resolve({ structured: { passed: false, reason: "第一轮没做到位" }, output: [], stopReason: "completed" });
    await sleep(30);
  }
  const replaced = await waitFor(() => replaces().length >= 1, 8000);
  await waitFor(() => evs().some((e) => e.type === "user/message" && textOf(e.data).includes("上一轮验证未通过")), 8000);

  const rep = replaces().at(-1) ?? null;
  const seqOf = (pred) => evs().find(pred)?.seq ?? null;
  const handoffSeq = seqOf((e) => e.type === "user/message" && textOf(e.data).includes("[ralphflow 交接稿]"));
  const preResetNoticeSeq = evs().filter((e) => e.type === "user/message" && textOf(e.data).includes("独立验证者")).map((e) => e.seq).filter((s) => rep && s < rep.seq).at(-1) ?? null;
  const reworkDoSeq = seqOf((e) => e.type === "user/message" && textOf(e.data).includes("上一轮验证未通过"));
  const msgs = agent.session.deriveMessages();

  const after = {
    replaced,
    reworkDelivered: reworkDoSeq !== null,
    replaceSeq: rep?.seq ?? null,
    // 交接稿就是那次 replace 的落点：`session.append("user/message", handoff, {surfaceOp:{op:"replace"}})`
    // 产生的是**同一个事件**（既有 user/message 类型，又带 replace 的 surfaceOp），所以 seq 相等。
    handoffIsReplaceNode: rep && handoffSeq !== null ? handoffSeq === rep.seq : false,
    preResetShadowed: rep && preResetNoticeSeq !== null ? preResetNoticeSeq < rep.seq : false,
    reworkAfterReplace: rep && reworkDoSeq !== null ? reworkDoSeq > rep.seq : false,
    systemFirst: String(textOf(msgs[0])).includes("DeepSeek Harness"),
    handoffSecond: String(textOf(msgs[1])).includes("[ralphflow 交接稿]"),
    turns: turns(),
    steps: steps(),
  };

  /**
   * 证据轨迹：把会话日志里「谁在什么时候变成了可见面节点」原样摘出来 —— 让复核者不必信
   * 本文件的断言，直接看日志形状（surface 顺序 + surfaceOp + 文本前缀）。
   */
  const onSurface = new Set(surfaceSeqs());
  const trace = evs()
    .filter((e) => onSurface.has(e.seq) || e.type === "turn/start" || e.type === "step/start")
    .map((e) => ({
      seq: e.seq,
      type: e.type,
      surfaceOp: typeof e.surfaceOp === "string" ? e.surfaceOp : e.surfaceOp?.op ?? null,
      turn: e.data?.turn ?? null,
      step: e.data?.step ?? null,
      source: e.data?.source?.kind ?? null,
      text: e.type === "user/message" || e.type === "assistant/message" ? textOf(e.data).replace(/\s+/g, " ").slice(0, 120) : null,
    }));

  return { ws, ctx, agent, window, after, trace, cleanup: () => cleanupTmp(ws) };
}

/**
 * 唯一判据（对整轮观察）：
 *   · 验证期间那段窗口：没有新回合（turns=1）、收尾的回合没被续上（steps=2：start + submit 两步）、
 *     收件箱空、播报已经看得见；
 *   · 验证者落地（空闲窗口）：整个运行只多出**一次**唤醒 —— 返工 DO 的那一次（turns=2）。
 * 修复前（播报也走 steer）三条都会破：running 期多一个 step、idle 期每票各开一个新回合。
 */
const noWakeDuringVerification = (o) =>
  o.window.delegated && o.window.votes === VOTE_COUNT &&
  o.window.turns === 1 && o.window.steps === 2 && o.window.inboxPending === false && o.window.hasVerifyNotice &&
  o.after.turns === 2;

/** 供 `RALPHFLOW_EVIDENCE_OUT` 落盘的证据包 */
const evidence = { workflow: "loop（内置单步四票投票步，reset: true）", runs: {} };

console.log("R1/R2 真实运行：真实 AgentLoop + 真实 Session + 真实插件装配");
const fixed = await runScenario(new URL("../lib/index.js", import.meta.url).href, "fixed");
{
  const w = fixed.window;
  check(`R1a 四票都在飞（委派 ${w.votes}/${VOTE_COUNT} 笔）`, w.delegated && w.votes === VOTE_COUNT, JSON.stringify(w));
  check("R1b 验证期间该会话**没有新回合**（turn/start 仍是 1）", w.turns === 1, `turns=${w.turns}`);
  check("R1c 收尾的回合没有被续上（step 仍是 start + submit 两步）", w.steps === 2, `steps=${w.steps}`);
  check("R1d 收件箱空：没有 next-step 待办在把它续上", w.inboxPending === false, `hasPending=${w.inboxPending}`);
  check("R1e 同一段窗口里播报**已经**在可见面上（立刻可见，不靠唤醒才出现）", w.hasVerifyNotice && w.noticeCount > 0, JSON.stringify(w));

  const a = fixed.after;
  check("R2a 四票齐后会话里出现 replace 事件（上下文确实被替换）", a.replaced, JSON.stringify(a));
  check("R2b 替换后第 0 条仍是系统提示", a.systemFirst);
  check("R2c 替换后第 1 条是交接稿", a.handoffSecond);
  check("R2b/c 交接稿就是那次 replace 的落点节点（同一个事件）", a.handoffIsReplaceNode, JSON.stringify(a));
  check("R2d 返工 DO（带失败理由）在 replace **之后**送达", a.reworkDelivered && a.reworkAfterReplace, JSON.stringify(a));
  check("R2e pre-reset 的播报节点在 replace **之前**（被整段遮蔽）", a.preResetShadowed, JSON.stringify(a));
  check("R2f 验证者落地后整轮只多出一次唤醒 = 返工 DO 那一次（turns 恰好 2）", a.turns === 2, `turns=${a.turns}`);
  evidence.runs.fixed = { window: fixed.window, after: fixed.after, trace: fixed.trace };
  fixed.cleanup();
}

console.log("\nR3【负对照】把播报还原成修复前的 `agent.steer` → 同一条判据必然失败");
{
  const reverted = buildPluginCopy({ "index.ts": revertNoticeToSteer }, "notice-steer");
  try {
    const bad = await runScenario(reverted.entry, "reverted");
    console.log(`     还原构建实测：窗口 turns=${bad.window.turns} steps=${bad.window.steps} inboxPending=${bad.window.inboxPending}；整轮 turns=${bad.after.turns}（修复构建：窗口 turns=${fixed.window.turns} steps=${fixed.window.steps} inboxPending=${fixed.window.inboxPending}；整轮 turns=${fixed.after.turns}）`);
    check("R3a 还原构建里，正在收尾的回合被续上（step 数 > 2）或空闲期被唤醒（turns > 2）",
      bad.window.steps > 2 || bad.window.turns > 1 || bad.after.turns > 2,
      JSON.stringify({ window: bad.window, after: { turns: bad.after.turns, steps: bad.after.steps } }));
    check("R3b 因此唯一判据 noWakeDuringVerification 在还原构建上为假（新用例有鉴别力）",
      noWakeDuringVerification(fixed) === true && noWakeDuringVerification(bad) === false,
      JSON.stringify({ fixed: { w: fixed.window, a: fixed.after.turns }, reverted: { w: bad.window, a: bad.after.turns } }));
    evidence.runs.reverted = { window: bad.window, after: bad.after, trace: bad.trace };
    evidence.verdict = {
      criterion: "noWakeDuringVerification",
      fixed: noWakeDuringVerification(fixed),
      reverted: noWakeDuringVerification(bad),
    };
    bad.cleanup();
  } finally {
    reverted.cleanup();
  }
}

// 可选证据落盘（`RALPHFLOW_EVIDENCE_OUT=<path>`）：复核者要的是**原始日志形状**，不是断言转述。
if (process.env.RALPHFLOW_EVIDENCE_OUT && evidence) {
  fs.writeFileSync(process.env.RALPHFLOW_EVIDENCE_OUT, JSON.stringify(evidence, null, 2));
  console.log(`\n证据已落盘：${process.env.RALPHFLOW_EVIDENCE_OUT}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

/**
 * 【负对照的还原】把 `src/index.ts` 里播报的唯一载体还原成修复前的写法：也走 `agent.steer`
 * （= 与指令共用出口，空闲驱动器会被开一个新回合）。锚点找不到就大声失败。
 */
function revertNoticeToSteer(src) {
  const anchor = '// @delivery notice —— 唯一的播报载体（直接 append 到可见面，不进收件箱）';
  if (!src.includes(anchor)) throw new Error("负对照锚点（播报载体标记）不见了 —— 修复被改写，请同步更新负对照");
  // 还原成修复前的写法：播报与指令共用出口，**无条件** steer（含「工具调用在飞」的那一刻）——
  // 这正是缺陷本体：空闲会话被开新回合、收尾中的回合被续上。
  const body = `      if (canAppendNoticeNow(session)) {
        // 先落挂起的历史播报，再落这一条 —— 保持时间线顺序
        flushNotices(sessionId);
        if (canAppendNoticeNow(session)) {
          try {
            ${anchor}
            session!.append!("user/message", msg, { surfaceOp: "append" });
            return true;
          } catch (e) {
            log("warn", "notice_append_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
          }
        }
        // 竞态兜底：落进挂起队列（不是收件箱），由上面那三条触发路径补齐
      }
      const queue = deferredNotices.get(sessionId);
      if (queue) queue.push(msg);
      else deferredNotices.set(sessionId, [msg]);
      armDeferredTimer();
      return true;`;
  if (!src.includes(body)) throw new Error("负对照锚点的上下文变了（deliverNotice 的载体写法被改写）—— 请同步更新负对照");
  const reverted = src.replace(body, `      // 负对照：还原为修复前「播报也走 steer」（与指令共用出口）
      (agent as { steer: (m: unknown) => unknown }).steer(msg);
      return true;`);
  if (reverted === src) throw new Error("负对照改写没生效");
  return reverted;
}
