/**
 * ralphflow e2e-harness v3 —— 在真实 dsh 进程内做端到端验证（真实 Agent 驱动）
 *
 * 与 v2 的差异：不再用 fakeAgent 直调引擎方法，而是像真实生产链路一样：
 *   1) ctx.agents.create 创建真实 Agent（stub 模型）
 *   2) 通过 ctx.tools.get("ralphflow_start") 真实启动工作流（job 守护者就位）
 *   3) agent.followup 注入任务 → stub 模型回复 <promise>done</promise>
 *   4) job 监听 assistant/message → 检测 done tag → runCheckAndAdvance
 *      （真实 subagents.start 验证者投票，stub 回复 <promise-check>true</promise-check>）
 *   5) 全票 PASS → on_pass: done → 实例归档
 * 另含：slash 命令注册/execute 链路、权限白名单、跨重启接管。
 *
 * 结果写入 $RALPHFLOW_WORKSPACE/e2e-harness/result.json
 */
import { createEngine } from "../lib/engine.js";
import { RALPH_CHECK_AGENT_PERMISSION } from "../lib/engine.js";
import { VERIFIER_TOOL_ALLOW } from "../lib/check.js";
import { LlmAdapter, createUserMessage } from "/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm/lib/index.js";
import { installModelSelection } from "/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-agent/lib/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
export const name = "e2e-harness";
export const inject = ["tools", "jobs", "commands", "sessions", "subagents", "llm", "agents", "agentDefaultModel", "loader"];

class StubAdapter extends LlmAdapter {
  providerInfo(p) { return { id: p, name: "Stub" }; }
  resolveModel(p, m, _s) { return Promise.resolve({ provider: p, id: m, name: m }); }
  listModels(_p) { return Promise.resolve([{ id: "stub-1", name: "stub-1" }]); }
  async *stream(options) {
    const ctxText = [
      options.system || "",
      ...(options.messages || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
    ].join("\n");
    let reply;
    if (ctxText.includes("<promise-check>") || ctxText.includes("DEFAULT_ADVERSARIAL") || ctxText.includes("edit 硬拒")) {
      reply = "验证通过，实现符合要求。\n\n<promise-check>true</promise-check>";
    } else if (ctxText.includes("summary.md")) {
      reply = "执行摘要已写入 summary.md。\n\n<promise>done</promise>";
    } else {
      reply = "完成。\n\n<promise>done</promise>";
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: reply };
    yield { type: "block-end", index: 0, block: { type: "text", text: reply } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: reply.length, totalTokens: 1 + reply.length } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errInfo = (e) => (e && e.stack ? String(e.stack).split("\n").slice(0, 5).join(" ⏎ ") : String(e));

export async function apply(ctx) {
  const results = [];
  const check = (n, c, d = "") => { results.push({ name: n, pass: !!c, detail: String(d).slice(0, 400) }); console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };
  const workspace = process.env.RALPHFLOW_WORKSPACE || "/home/yj/ralph-flow-dsh";

  // ── 0. 环境准备：归档历史实例，保证确定性 ──
  try {
    const instRoot = path.join(workspace, "ralph-flow", "instances");
    if (fs.existsSync(instRoot)) {
      const trash = path.join(workspace, "ralph-flow", "archived-e2e", String(Date.now()));
      fs.mkdirSync(trash, { recursive: true });
      for (const d of fs.readdirSync(instRoot)) {
        fs.renameSync(path.join(instRoot, d), path.join(trash, d));
      }
    }
    console.log("[harness] 历史实例已归档");
  } catch (e) { console.log("[harness] 归档失败(忽略):", e.message); }

  // stub provider 注册（真实 ctx.llm）——真实 agent/subagent 走 stub 模型
  const stubCalls = [];
  try {
    ctx.llm.registerAdapter(["stub"], new (class extends StubAdapter {
      async *stream(options) {
        stubCalls.push(String(options?.model || "?"));
        console.log(`[harness] stub.stream 被调用 model=${options?.model} msgs=${(options?.messages || []).length}`);
        yield* super.stream(options);
      }
    })());
    check("stub provider 已注册到真实 ctx.llm", true);
  } catch (e) { check("stub provider 已注册到真实 ctx.llm", false, errInfo(e)); }

  // 会话事件流诊断：观察 job 是否收得到事件
  const seenEvents = [];
  const ourSessionEvents = [];
  let ourSid = null;
  const KEY_EVENTS = ["tool-ralphflow/", "assistant/message", "llm/retry", "error/"];
  try {
    ctx.on?.("session/event", (_s, e) => {
      const sid = _s && _s.id;
      seenEvents.push(`${sid === "OUR" ? "" : ""}${e?.type}`);
      if (ourSid && sid === ourSid) {
        ourSessionEvents.push(e?.type);
        const type = e?.type || "";
        if (KEY_EVENTS.some((k) => type.includes(k))) console.log(`[harness] ★ OUR session/event type=${type}`);
      }
      if (seenEvents.length <= 40) console.log(`[harness] session/event sid=${sid} type=${e?.type}`);
    });
  } catch (e) { console.log("[harness] 诊断订阅失败:", e.message); }

  // 等 ralphflow 插件 apply 完成
  await sleep(2500);

  // ── 1. 服务存在性 ──
  check("真实 ctx.tools 服务存在", !!ctx.tools);
  check("真实 ctx.jobs 服务存在", !!ctx.jobs);
  check("真实 ctx.sessions 服务存在", !!ctx.sessions);
  check("真实 ctx.subagents 服务存在", !!ctx.subagents);
  check("真实 ctx.agents 服务存在", !!ctx.agents);

  // ── 2. 创建真实 Agent（生产同构：dsh-headless 同款创建方式）──
  let agent;
  try {
    // 显式固定 stub 选择：headless-e2e 的 agent-default-model config 可能被
    // 运行时环境（如本机 opencode provider）覆盖，currentSelection() 会返回
    // 全局默认模型而非 stub——不能依赖它。直接构造 stub 选择并安装。
    const selection = { provider: "stub", model: "stub-1" };
    console.log(`[harness] 模型选择: ${JSON.stringify(selection)}`);
    const handle = await ctx.agents.create({
      sessionId: `session-e2e-${Date.now()}`,
      meta: { cwd: workspace },
      agentOptions: { provider: selection.provider || "stub", model: selection.model || "stub-1" },
      setup: (agentCtx) => {
        // 与 dsh-headless 一致：把模型选择安装进 agent 的 scoped ctx，
        // 否则 agent/subagent 的 LLM 请求不会路由到 stub provider（默认模型）。
        installModelSelection(agentCtx, { current: selection, assembled: void 0 });
      },
    });
    agent = handle.agent;
    ourSid = agent.session?.id ?? null;
    await agent.whenIdle();
    check("真实 Agent 创建成功（stub 模型）", !!agent && !!agent.session?.id, `session=${agent?.session?.id}`);
    try {
      const allSessions = ctx.sessions.list?.() ?? [];
      console.log(`[harness] 会话诊断: agent.session.id=${agent.session?.id} seq=${agent.session?.seq}`);
      console.log(`[harness] 会话诊断: sessions.list 共 ${allSessions.length} 个: ${allSessions.map((s) => s.id).join(", ")}`);
      const agentById = ctx.agents?.get?.(agent.session?.id);
      const sessById = ctx.sessions?.get?.(agent.session?.id);
      console.log(`[harness] 会话诊断: agents.get(sid)=${agentById ? `agent(id=${agentById.id})` : "undefined"} sessions.get(sid)=${sessById ? `session(id=${sessById.id})` : "undefined"}`);
    } catch (e) { console.log("[harness] 会话诊断失败:", e.message); }
  } catch (e) { check("真实 Agent 创建成功（stub 模型）", false, errInfo(e)); }

  // ── 3. subagent 直连诊断（真实 parent + signal）──
  try {
    const run = await ctx.subagents.start("spawn", {
      label: "stub-diag",
      prompt: [{ type: "text", text: "测试 stub 子代理" }],
      parent: agent,
      signal: new AbortController().signal,
    });
    const res = await run.result;
    const out = Array.isArray(res?.output) ? res.output.map((b) => b?.text || "").join("") : JSON.stringify(res?.output);
    check("真实 subagent.start（真实 parent+signal+stub）返回输出", out.includes("done"), `stop=${res?.stopReason} out="${String(out).slice(0, 40)}"`);
  } catch (e) { check("真实 subagent.start（真实 parent+signal+stub）返回输出", false, errInfo(e)); }

  // ── 4. slash 命令链路（web UI 输入的 host 侧真实路径）──
  try {
    check("真实 ctx.commands 服务存在", !!ctx.commands && typeof ctx.commands.register === "function");
    const cmdAgent = { session: { id: "e2e-cmd", append: () => {}, events: [] }, id: "e2e-cmd" };
    const descs = ctx.commands.list(cmdAgent).map((d) => d.name);
    for (const c of ["ralphflow-start", "ralphflow-list", "ralphflow-status", "ralphflow-cancel"]) {
      check(`slash /${c} 已注册`, descs.includes(c), `共${descs.length}条`);
    }
    check("动态快捷命令 /loop 已注册", descs.includes("loop"));
    const exec = await ctx.commands.execute(cmdAgent, "/ralphflow-list", new AbortController().signal);
    check("/ralphflow-list execute 返回 success 文本", exec?.result?.kind === "success" && (exec.result.text || "").includes("可用工作流"), (exec?.result?.text || "").slice(0, 60).replace(/\n/g, "|"));
    const execBad = await ctx.commands.execute(cmdAgent, "/ralphflow-status no-such-inst", new AbortController().signal);
    check("/ralphflow-status 未知实例返回可读文本", execBad?.result != null, (execBad?.result?.text || "").slice(0, 60).replace(/\n/g, "|"));
  } catch (e) { check("slash 命令链路", false, errInfo(e)); }

  // ── 5. 工具注册检查 ──
  const toolNames = ["ralphflow_start", "ralphflow_continue", "ralphflow_status", "ralphflow_list", "ralphflow_cancel", "ralphflow_rewind", "ralphflow_reset", "ralphflow_doctor"];
  for (const t of toolNames) {
    check(`工具 ${t} 已真实注册`, !!ctx.tools?.get?.(t) && typeof ctx.tools.get(t).execute === "function");
  }

  // ── 6. 全真实端到端：start → DO(done tag) → CHECK 投票 → 归档 ──
  let instId = null;
  const engine = createEngine(workspace, {});
  try {
    const startDef = ctx.tools.get("ralphflow_start");
    const startResult = await startDef.execute({ workflow: "loop", task: "e2e 全真实链路验证" }, { agent, signal: new AbortController().signal });
    const startText = Array.isArray(startResult)
      ? startResult.map((b) => (b && b.text) || "").join("\n")
      : typeof startResult === "string" ? startResult : JSON.stringify(startResult);
    check("ralphflow_start 执行成功", startText.includes("已启动"), startText.slice(0, 80).replace(/\n/g, "|"));

    const mine = engine.listInstances().find((i) => i.owner === agent.session.id);
    instId = mine?.id ?? null;
    check("实例已创建且 owner=真实会话", !!instId, `id=${instId}`);
    const st0 = instId && engine.readState(instId);
    check("初始处于 DO 阶段且会话绑定", st0?.current_phase === "do" && st0?.session_id === agent.session.id, JSON.stringify(st0 && { phase: st0.current_phase, sid: st0.session_id }));

    // 真实驱动：给 agent 发用户消息 → stub 回复 done tag → job 触发验证
    agent.followup(createUserMessage({
      content: [{ type: "text", text: "请完成 e2e 全真实链路验证 任务并把摘要写入 summary.md" }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    console.log(`[harness] DO 轮结束 stub调用=${JSON.stringify(stubCalls)} 事件数=${seenEvents.length} our事件数=${ourSessionEvents.length} our事件=${ourSessionEvents.join(",")}`);
    try {
      const events = agent.session?.events ?? [];
      const tailTypes = events.slice(-25).map((e) => e.type);
      console.log(`[harness] agent.session.events=${events.length} tail=${tailTypes.join(",")}`);
      const lastMsg = [...events].reverse().find((e) => e.type === "assistant/message");
      if (lastMsg) {
        const blocks = lastMsg.data?.message?.content ?? [];
        const text = blocks.map((b) => b?.text || "").join(" ");
        console.log(`[harness] 最后 assistant/message text="${String(text).slice(0, 80)}"`);
      }
    } catch (e) { console.log("[harness] session.events 诊断失败:", e.message); }
    const evPath = path.join(engine.getInstanceDir(instId), "logs", "execution.log");
    const tail = (p) => { try { return fs.readFileSync(p, "utf8").trim().split("\n").slice(-6).join(" ⏎ "); } catch { return "(无)"; } };
    console.log(`[harness] 实例事件尾: ${tail(evPath).slice(0, 500)}`);

    // 轮询等待状态机走完 do→check→(vote)→done/归档 或暂停
    let finalState = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      finalState = engine.readState(instId);
      if (!finalState || !finalState.active || finalState.paused) break;
    }
    check("DO→CHECK→全票通过→on_pass done 自动归档", finalState === null || finalState.active === false, finalState ? JSON.stringify({ phase: finalState.current_phase, paused: finalState.paused, fail: finalState.fail_count }) : "(state removed)");
    const stubModels = [...new Set(stubCalls)];
    check(`stub 模型驱动了 DO + 验证（stub 调用 ${stubCalls.length} 次）`, stubCalls.length >= 2, `调用=${stubCalls.length} 模型=${stubModels.join(",")}`);
  } catch (e) { check("全真实端到端主链路", false, errInfo(e)); }

  // ── 7. 权限常量 ──
  check("验证者 edit 硬拒 (edit==='deny')", RALPH_CHECK_AGENT_PERMISSION.edit === "deny");
  check("验证者只读白名单（无 edit/write）", !VERIFIER_TOOL_ALLOW.includes("edit") && !VERIFIER_TOOL_ALLOW.includes("write"));
  check("验证者白名单含 read/bash", VERIFIER_TOOL_ALLOW.includes("read") && VERIFIER_TOOL_ALLOW.includes("bash"));

  // ── 8. 跨重启接管（新 engine 读同一 state.json）──
  try {
    const resumedEngine = createEngine(workspace, {});
    const list = resumedEngine.listInstances();
    check("重启语义：listInstances 可枚举", Array.isArray(list), `count=${list.length}`);
  } catch (e) { check("重启语义：listInstances 可枚举", false, errInfo(e)); }

  const outDir = path.join(workspace, "e2e-harness");
  fs.mkdirSync(outDir, { recursive: true });
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ pass, fail, results }, null, 2));
  console.log(`\n===== E2E-HARNESS v3 (真实 dsh 进程 + 真实 Agent): ${pass} PASS / ${fail} FAIL =====`);
  // 请求进程退出：headless-runner 已禁用，无人调用 appExit 时进程挂起（测试由 timeout 强杀）
  const exit = ctx.get?.("appExit");
  if (typeof exit === "function") {
    await sleep(500);
    exit(fail > 0 ? 1 : 0);
  }
}
