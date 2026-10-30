/**
 * 判据：**一轮 = 一个回合**（真实 dsh `AgentLoop` + 真实 `Session` + 真实插件装配）。
 *
 * 缺陷本体（RA2 loop 实例实测，2026-10-23）：单步跑了 8 小时，**84 轮共用 4 个回合**。
 * 原因是「交卷提醒」走 `agent.steer` —— 而 `agent/turn-stopping` 的文档拿 `steer` 当
 * 「让本可完成的回合保持打开」的手段（`dsh-agent`：*turn-stopping … 可通过 steer 使其保持打开*），
 * 回合循环的判据又恰好是 `turnEnds && inbox.nextStep.length === 0`。于是模型每一次想收尾，
 * 引擎都把同一个回合续上；到第 150 步它自己写出
 * *I've reached the limit of what this turn can carry out*，然后把剩下的判据写成
 * 「months-scale, remaining」不再推进。
 *
 * 修法：提醒改走 `agent.followup`（收件箱 **next-turn** 边界）—— 本回合正常 `turn/end`，
 * 提醒成为下一回合的第一条消息。opencode 版就是这个形状：每条催促是一次 `session.promptAsync`。
 *
 * 本用例判的就是这两件事：
 *   R1 提醒**之后**回合确实结束了（`turn/end` 在提醒之前落地）；
 *   R2 提醒是**新回合**的第一条消息（`turn/start` 从 1 变 2，且第一条 user/message 就是它）。
 * 两条合成唯一判据 `oneRoundOneTurn`。
 *
 * R3【负对照】把 `followup` 还原成修复前的 `steer` → 同一条判据必然为假（回合被续上）。
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
import { buildPluginCopy } from "./helpers/reverted-build.mjs";
import { cleanupTmp, mkTmp, textOf } from "./helpers/plugin-harness.mjs";

// HOME 隔离（工作协议）：测试绝不读写真实 ~/.dsh。必须在 apply 之前设置。
process.env.HOME = mkTmp("home");
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(20); }
  return (await pred()) === true;
};
const RUN = Math.random().toString(36).slice(2, 8);
const DO_MARK = "本步要做什么";
const REMIND_MARK = "还没结束";
const WORKFLOW_NAME = "loop";

/**
 * 脚本化模型：启动工作流 → **拿到 DO 只回一句话就结束回合，不交卷** → 拿到提醒才交卷。
 *
 * 中间那一步是全部要点：模型主动收尾（它认为自己这一轮做完了），引擎要不要另起一轮，
 * 取决于提醒落在哪个收件箱边界。
 */
function mkStubAdapter(log) {
  let callSeq = 0;
  let submitted = false;
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
      const lastUser = texts.at(-1) ?? "";
      const toolNames = (options.tools ?? []).map((t) => t.name);
      const canSubmit = toolNames.includes("ralphflow_submit");
      log?.({ lastUser: lastUser.slice(0, 40), canSubmit });
      // 引擎的提醒是**自包含步骤卡**（含 DO 摘要），所以必须先认提醒、再认 DO。
      if (canSubmit && lastUser.includes(REMIND_MARK) && !submitted) {
        submitted = true;
        for (const c of toolChunks("ralphflow_submit", { summary: "这一轮做完了", unfinished: [] })) yield c;
        return;
      }
      if (canSubmit && all.includes(DO_MARK)) {
        // 模型收尾：不交卷，只说一句结束回合 —— 这正是要验的那一刻。
        for (const c of sayChunks("这一轮先做到这里。")) yield c;
        return;
      }
      if (all.includes("完成任务") && toolNames.includes("ralphflow_start")) {
        for (const c of toolChunks("ralphflow_start", { workflow: WORKFLOW_NAME, task: "完成任务" })) yield c;
        return;
      }
      for (const c of sayChunks("收到。")) yield c;
    }
  })();
}

/** 真实宿主 + 真实插件装配；模型在 DO 之后主动结束回合，观察引擎是否另起一轮。 */
async function runScenario(entryUrl, label) {
  const ws = mkTmp(`round-${label}`);
  process.chdir(ws);

  const ctx = new Context();
  ctx.provide("logger", { info() {}, warn() {}, error() {}, debug() {} });
  ctx.plugin(LlmRuntime);
  ctx.plugin(SessionStore);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(SystemPrompt);
  ctx.plugin(ToolRuntime);
  ctx.plugin(AgentRegistry);
  ctx.plugin(AgentLoop);
  await sleep(120);

  ctx.llm.registerAdapter(["stub"], mkStubAdapter());
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, agentPreset: true }, inheritsParentContext: false }),
    startActivation: async () => ({
      childId: "verifier",
      result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }),
    }),
  });
  ctx.provide("commands", { register: () => () => {} });
  ctx.provide("skills", { register: () => () => {} });
  ctx.provide("agentPresets", { register: async () => async () => {} });
  const plugin = await import(entryUrl + (label === "fixed" ? "" : `?${label}-${RUN}`));
  plugin.apply(ctx);

  const sessionId = `session-round-${label}-${RUN}`;
  const { agent } = await ctx.agents.create({ sessionId, meta: { cwd: ws }, agentOptions: { provider: "stub", model: "stub-1" } });
  agent.followup(createUserMessage({ content: [{ type: "text", text: "完成任务" }], source: { kind: "user" } }));

  const evs = () => agent.session.snapshotEvents();
  const turnStarts = () => evs().filter((e) => e.type === "turn/start");
  const reminders = () => evs().filter((e) => e.type === "user/message" && e.data?.source?.kind === RALPHFLOW_SOURCE_KIND && textOf(e.data).includes(REMIND_MARK));

  // 等到「提醒已经投出」的那一刻（两枝都会出现提醒，差别只在它落在哪个回合）。
  const reminded = await waitFor(() => reminders().length > 0, 12000);
  // 再给「会另起一轮」的写法足够窗口把 turn/start 落盘。
  await waitFor(() => turnStarts().length >= 2, 4000);
  await sleep(400);

  const starts = turnStarts();
  const ends = evs().filter((e) => e.type === "turn/end");
  const remindSeq = reminders().at(-1)?.seq ?? null;
  // 「提醒之前回合就结束了」= 有一条 turn/end 落在提醒之前，且结束的是第 1 回合。
  const endBeforeRemind = remindSeq !== null
    ? ends.filter((e) => e.seq < remindSeq && (e.data?.turn ?? 1) === 1).at(-1) ?? null
    : null;
  // 第 2 回合的第一条用户消息（可见面顺序 = seq 顺序）。
  const secondStart = starts[1] ?? null;
  const firstUserOfTurn2 = secondStart
    ? evs().filter((e) => e.type === "user/message" && e.seq > secondStart.seq).at(0) ?? null
    : null;

  const obs = {
    reminded,
    turns: starts.length,
    turnEnds: ends.length,
    turn1EndedBeforeReminder: endBeforeRemind !== null,
    // 提醒是否就是新回合的第一条消息（同一 seq = 是）
    reminderOpensNewTurn: Boolean(firstUserOfTurn2 && reminders().some((r) => r.seq === firstUserOfTurn2.seq)),
    remindSeq,
    firstUserOfTurn2Seq: firstUserOfTurn2?.seq ?? null,
  };
  const trace = evs()
    .filter((e) => e.type === "turn/start" || e.type === "turn/end" || (e.type === "user/message" && e.data?.source?.kind === RALPHFLOW_SOURCE_KIND))
    .map((e) => ({
      seq: e.seq,
      type: e.type,
      turn: e.data?.turn ?? null,
      text: e.type === "user/message" ? textOf(e.data).replace(/\s+/g, " ").slice(0, 80) : null,
    }));
  return { obs, trace, cleanup: () => cleanupTmp(ws) };
}

/** 唯一判据：提醒之后回合结束过，且提醒是新回合的第一条消息。 */
const oneRoundOneTurn = (o) =>
  o.reminded && o.turns === 2 && o.turn1EndedBeforeReminder && o.reminderOpensNewTurn;

const evidence = { workflow: "loop（内置单步投票步）", runs: {} };

console.log("R1/R2 真实运行：模型在 DO 之后主动结束回合（不交卷），引擎的提醒落在哪个回合");
const fixed = await runScenario(new URL("../lib/index.js", import.meta.url).href, "fixed");
{
  const o = fixed.obs;
  check("R1a 提醒确实投出（模型收尾 → 引擎提醒「本步还没结束」）", o.reminded, JSON.stringify(o));
  check("R1b 提醒**之前**第 1 回合已经 turn/end（回合正常收尾，没有被续上）", o.turn1EndedBeforeReminder, JSON.stringify(o));
  check("R2a 提醒之后新开了一个回合（turn/start 从 1 变 2）", o.turns === 2, `turns=${o.turns}`);
  check("R2b 提醒就是新回合的第一条消息（同一节点）", o.reminderOpensNewTurn, JSON.stringify(o));
  check("R2c 唯一判据 oneRoundOneTurn 在修复构建上为真", oneRoundOneTurn(o) === true, JSON.stringify(o));
  evidence.runs.fixed = { obs: o, trace: fixed.trace };
  fixed.cleanup();
}

console.log("\nR3【负对照】把提醒还原成 `agent.steer` → 同一回合被续上，判据必然为假");
{
  const reverted = buildPluginCopy({ "index.ts": revertRoundToSteer }, "round-steer");
  try {
    const bad = await runScenario(reverted.entry, "reverted");
    const o = bad.obs;
    console.log(`     还原构建实测：turns=${o.turns} turn1EndedBeforeReminder=${o.turn1EndedBeforeReminder}（修复构建：turns=${fixed.obs.turns} turn1EndedBeforeReminder=${fixed.obs.turn1EndedBeforeReminder}）`);
    check("R3a 还原构建里回合没有被结束（提醒仍落在第 1 回合内）", o.turns === 1 && !o.turn1EndedBeforeReminder, JSON.stringify(o));
    check("R3b 因此唯一判据在还原构建上为假（新用例有鉴别力）",
      oneRoundOneTurn(fixed.obs) === true && oneRoundOneTurn(o) === false, JSON.stringify({ fixed: fixed.obs, reverted: o }));
    evidence.runs.reverted = { obs: o, trace: bad.trace };
    evidence.verdict = { criterion: "oneRoundOneTurn", fixed: oneRoundOneTurn(fixed.obs), reverted: oneRoundOneTurn(o) };
    bad.cleanup();
  } finally {
    reverted.cleanup();
  }
}

if (process.env.RALPHFLOW_EVIDENCE_OUT && evidence) {
  fs.writeFileSync(process.env.RALPHFLOW_EVIDENCE_OUT, JSON.stringify(evidence, null, 2));
  console.log(`\n证据已落盘：${process.env.RALPHFLOW_EVIDENCE_OUT}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

/**
 * 【负对照的还原】把「新一轮」载体还原成修复前的 `agent.steer`：
 * 提醒落 next-step，收尾中的回合被续上，一轮不再是「一个回合」。锚点找不到就大声失败。
 */
function revertRoundToSteer(src) {
  const cast = "      const agent = agentOf(sessionId) as { followup: (m: unknown) => unknown } | undefined;";
  const send = "      // @delivery directive —— 下一回合的载体（收件箱 next-turn 边界 + 唤醒）\n      agent.followup(buildMessage(text, summary));";
  for (const [i, anchor] of [cast, send].entries()) {
    if (!src.includes(anchor)) throw new Error(`负对照锚点 ${i + 1}（新一轮载体）不见了 —— 修复被改写，请同步更新负对照`);
  }
  const reverted = src
    .replace(cast, "      const agent = agentOf(sessionId) as { steer: (m: unknown) => unknown } | undefined;")
    .replace(send, "      // 负对照：还原为修复前「提醒也走 steer」—— 收尾中的回合被续上\n      agent.steer(buildMessage(text, summary));");
  if (reverted === src) throw new Error("负对照改写没生效");
  return reverted;
}
