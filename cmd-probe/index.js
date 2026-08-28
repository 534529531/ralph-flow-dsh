/**
 * cmd-probe —— 验证「slash 命令 → followup 注入 → 模型开工 → 工作流推进」全链路
 *
 * 与 e2e-harness 的差异：本探针从**真实宿主命令入口**（ctx.commands.execute，
 * 与 web UI / headless 输入同一路径）派发 /loop，而不是直调工具——
 * 精确复现用户「敲命令后当前会话不开工」的场景。
 * 结果写 $RALPHFLOW_WORKSPACE/cmd-probe/result.json
 */
import { LlmAdapter, createUserMessage } from "/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm/lib/index.js";
import { installModelSelection } from "/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-agent/lib/index.js";
import { createEngine } from "../lib/engine.js";
import * as fs from "node:fs";
import * as path from "node:path";

export const name = "cmd-probe";
export const inject = ["tools", "jobs", "commands", "sessions", "subagents", "llm", "agents", "agentDefaultModel", "loader"];

class StubAdapter extends LlmAdapter {
  providerInfo(p) { return { id: p, name: "Stub" }; }
  resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m }); }
  listModels() { return Promise.resolve([{ id: "stub-1", name: "stub-1" }]); }
  async *stream(options) {
    const ctxText = [
      options.system || "",
      ...(options.messages || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
    ].join("\n");
    let reply;
    if (ctxText.includes("<promise-check>")) reply = "验证通过。\n\n<promise-check>true</promise-check>";
    else if (ctxText.includes("[ralphflow]")) reply = "收到工作流开工指令，开始执行任务。\n\n<promise>done</promise>";
    else reply = "完成。\n\n<promise>done</promise>";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: reply };
    yield { type: "block-end", index: 0, block: { type: "text", text: reply } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errInfo = (e) => (e && e.stack ? String(e.stack).split("\n").slice(0, 4).join(" ⏎ ") : String(e));

export async function apply(ctx) {
  const results = [];
  const check = (n, c, d = "") => { results.push({ name: n, pass: !!c, detail: String(d).slice(0, 500) }); console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };
  const workspace = process.env.RALPHFLOW_WORKSPACE || "/home/yj/ralph-flow-dsh";

  // 记录每次 stub 调用的全部 user 消息拼接文本（判断注入是否到达模型）
  const stubLastUserTexts = [];
  try {
    ctx.llm.registerAdapter(["stub"], new (class extends StubAdapter {
      async *stream(options) {
        const msgs = options?.messages || [];
        const allUser = msgs.map((m) => (m.role === "user" ? (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) : "")).join("\n");
        stubLastUserTexts.push(allUser.slice(0, 2000));
        console.log(`[probe] stub.stream msgs=${msgs.length} hasInject=${allUser.includes("[ralphflow]")}`);
        yield* super.stream(options);
      }
    })());
    check("stub provider 已注册", true);
  } catch (e) { check("stub provider 已注册", false, errInfo(e)); }

  await sleep(2500); // 等 ralphflow apply 完成

  // 创建真实 agent（与 dsh-headless 同构）
  let agent;
  try {
    const selection = { provider: "stub", model: "stub-1" };
    const handle = await ctx.agents.create({
      sessionId: `session-cmdprobe-${Date.now()}`,
      meta: { cwd: workspace },
      agentOptions: { provider: "stub", model: "stub-1" },
      setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: void 0 }); },
    });
    agent = handle.agent;
    await agent.whenIdle();
    check("真实 Agent 创建成功", !!agent?.session?.id, `session=${agent?.session?.id}`);
  } catch (e) { check("真实 Agent 创建成功", false, errInfo(e)); }

  if (!agent) { writeResult(); return; }

  const engine = createEngine(workspace, {});

  // ── 核心实验：真实宿主命令入口派发 /loop（web UI 同路径）──
  try {
    stubLastUserTexts.length = 0;
    const exec = await ctx.commands.execute(agent, "/loop 命令开工链路实测", new AbortController().signal);
    check("/loop 命令被宿主 execute 接受", exec?.result?.kind === "success", JSON.stringify(exec?.result || {}).slice(0, 120));

    const mine = engine.listInstances().find((i) => i.owner === agent.session.id && i.state.user_task === "命令开工链路实测");
    check("命令路径创建了实例且属主为当前会话", !!mine, `id=${mine?.id}`);
    if (!mine) { writeResult(); return; }

    // followup 是异步排队：等驱动醒来跑完这一轮
    await sleep(1500);
    await agent.whenIdle();

    const injected = stubLastUserTexts.some((t) => t.includes("[ralphflow]"));
    check("模型收到了 [ralphflow] 开工指令注入（followup 到达）", injected, `stub调用=${stubLastUserTexts.length} 首条="${(stubLastUserTexts[0] || "").slice(0, 60).replace(/\n/g, "|")}"`);

    // stub 对注入回复 done → job 应已推进到验证/完成
    const st1 = engine.readState(mine.id);
    const advanced = !st1 || st1.current_step !== "loop" || st1.current_phase !== "do" || st1.paused;
    check("done 后状态机已推进（不再停在首轮 DO）", advanced, JSON.stringify(st1 && { step: st1.current_step, phase: st1.current_phase, paused: st1.paused }));
    const reportExists = engine.reportExists(mine.id);
    check("工作流最终归档完成（报告落地）", reportExists, `report=${reportExists}`);
  } catch (e) { check("命令开工链路实测", false, errInfo(e)); }

  function writeResult() {
    try {
      const outDir = path.join(workspace, "cmd-probe");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({
        pass: results.filter((r) => r.pass).length,
        fail: results.filter((r) => !r.pass).length,
        results,
      }, null, 2));
    } catch {}
    const fails = results.filter((r) => !r.pass);
    console.log(`\n===== CMD-PROBE: ${results.filter((r) => r.pass).length} PASS / ${fails.length} FAIL =====`);
    if (fails.length > 0) console.log("失败项:", fails.map((f) => f.name).join(", "));
  }
  writeResult();
}
