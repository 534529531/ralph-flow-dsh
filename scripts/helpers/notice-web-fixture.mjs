/** Test-only model adapter. Real web, native AgentLoop and native spawn voters remain in charge. */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";

export const inject = ["llm", "webServer", "sessionController", "agents", "cordisInspect", "tools", "approval", "goals", "jobs"];
export function apply(ctx) {
  let serial = 0;
  const pending = [], holds = [];
  const submitted = new Set();
  const graphWrote = new Set();
  let graphStarted = false;
  let approvalAbort, nativeJob;
  ctx.jobs.attachController("ui-native-comparison");
  ctx.tools.register(defineTool({ name: "status_approval_probe", description: "状态 UI 的原生审批验收", parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(_args, exec) {
      approvalAbort = new AbortController();
      const outcome = await ctx.approval.request({ agent: exec.agent, toolName: "status_approval_probe", callId: exec.callId,
        reason: "UI_STATUS_APPROVAL：验证审批接管时页头工作流状态入口", signal: approvalAbort.signal });
      exec.concludeTurn?.(); return `approval-probe-finished: ${outcome}`;
    },
  }));
  let blocked = false, instrumented;
  const statusCallbacks = new Set();
  const tool = (name, args) => {
    const id = `notice-call-${++serial}`, argumentsText = JSON.stringify(args);
    return [
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id, name, argumentsDelta: argumentsText },
      { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: argumentsText } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ];
  };
  const say = (text) => [
    { type: "block-start", index: 0, blockType: "text" }, { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } }, { type: "finish", reason: { kind: "stop" } },
  ];
  ctx.llm.registerAdapter(["notice-fixture"], new (class extends LlmAdapter {
    providerInfo(id) { return { id, name: "Notice acceptance fixture" }; }
    async resolveModel(provider, id) { return { provider, id, name: id }; }
    async listModels(provider) { return [{ provider, id: "notice", name: "notice" }]; }
    async *stream(options) {
      const texts = (options.messages ?? []).map((m) => typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n")
          : JSON.stringify(m.content));
      const all = [options.system ?? "", ...texts].join("\n");
      const names = (options.tools ?? []).map((t) => t.name);
      if (process.env.RALPHFLOW_GRAPH_UI_DEBUG) console.error("[fixture]", JSON.stringify(names), texts.at(-1)?.slice(0, 160).replace(/\n/g, " | "));
      if (texts.at(-1)?.includes("UI_STATUS_APPROVAL") && names.includes("status_approval_probe")) {
        for (const c of tool("status_approval_probe", {})) yield c;
        return;
      }
      if (all.includes("无法启动")) throw new Error("notice fixture workflow start was rejected");
      const mode = all.includes("UI_DESIGN_GRAPH") ? "design" : all.includes("UI_GRAPH_VIEWER") ? "graph" : all.includes("UI_NOTICE_PAUSE") ? "pause" : all.includes("UI_NOTICE_GATE") ? "gate" : "loop";
      if (all.includes("## 完整 CHECK") && names.includes("structured_output")) {
        // Graph CHECK：从提示词抄出判据，返回逐条证据（真实结构化形状）。
        const section = /## 完整 CHECK[^\n]*\n([\s\S]*?)\n\n/.exec(all)?.[1] ?? "";
        const criteria = section.split("\n").map((line) => line.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
        if (process.env.RALPHFLOW_GRAPH_UI_DEBUG) console.error("[graph-verifier] criteria=", criteria.length, JSON.stringify(criteria.slice(0, 2)), "section=", JSON.stringify(section.slice(0, 120)));
        // 受控挂起：让「CHECK 验证中」这一阶段在页面上真实存在，供查看器阶段断言取证。
        if (process.env.RALPHFLOW_GRAPH_UI_HOLD) { const d = Promise.withResolvers(); holds.push(d.resolve); await d.promise; }
        for (const c of tool("structured_output", { passed: true, reason: "真机 Graph CHECK：通过", evidence: criteria.map((criterion) => ({ criterion, passed: true, evidence: "真机受控证据" })) })) yield c;
        return;
      }
      if (names.includes("structured_output")) {
        const d = Promise.withResolvers();
        pending.push({ mode, resolve: d.resolve });
        const passed = await d.promise;
        for (const c of tool("structured_output", { passed, reason: passed ? "真机受控票：通过" : "真机受控票：未通过，需要返工" })) yield c;
        return;
      }
      const graphDo = texts.filter((t) => t.includes("Graph 节点执行")).at(-1);
      if (graphDo) console.error("[graph-fixture] tools=", JSON.stringify(names), "wrote=", graphWrote.has(graphDo));
      if (graphDo && names.includes("ralphflow_artifact_write")) {
        if (!graphWrote.has(graphDo)) {
          graphWrote.add(graphDo);
          for (const c of tool("ralphflow_artifact_write", { content: "真机 Graph 节点产物" })) yield c;
          return;
        }
        if (names.includes("ralphflow_submit")) {
          // 受控挂起：让「DO 执行中」这一阶段在页面上真实存在，供查看器阶段断言取证。
          if (process.env.RALPHFLOW_GRAPH_UI_HOLD) { const d = Promise.withResolvers(); holds.push(d.resolve); await d.promise; }
          for (const c of tool("ralphflow_submit", { unfinished: [] })) yield c;
          return;
        }
      }
      const doText = texts.filter((t) => t.includes("本步要做什么")).at(-1);
      if (doText && !submitted.has(doText) && names.includes("ralphflow_submit")) {
        submitted.add(doText);
        if (doText.includes("上一轮验证未通过")) {
          const d = Promise.withResolvers(); holds.push(d.resolve); await d.promise;
        }
        for (const c of tool("ralphflow_submit", { summary: "真机交卷", unfinished: [] })) yield c;
        return;
      }
      if (!doText && names.includes("ralphflow_start") && (all.includes("UI_NOTICE_") || (mode === "graph" && !graphStarted))) {
        const workflow = mode === "graph" ? "status-graph" : mode === "loop" ? "loop" : `ui-${mode}`;
        const task = mode === "graph" ? "UI_GRAPH_VIEWER" : `UI_NOTICE_${mode.toUpperCase()}`;
        if (mode === "graph") graphStarted = true;
        for (const c of tool("ralphflow_start", { workflow, task })) yield c;
        return;
      }
      for (const c of say("本轮已交卷，等待独立验证。" + (process.env.RALPHFLOW_STATUS_LONG_CHAT ? "\n" + Array.from({ length: 70 }, (_, i) => `验收上下文 ${i + 1}：工作流仍由引擎推进。`).join("\n") : ""))) yield c;
    }
  })());
  ctx.webServer.register({ kind: "prefix", path: "/__notice", handler: async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let result;
      if (url.pathname === "/__notice/native-goal") {
        const agent = ctx.agents.get(url.searchParams.get("sid"));
        const goal = ctx.goals.create(agent, { objective: "原生 goal 条视觉对照", maxGoalRounds: 1 });
        result = ctx.goals.pause(agent, { id: goal.id, revision: goal.revision });
        const completion = Promise.withResolvers();
        const id = ctx.jobs.start({ kind: "bash", label: "原生后台任务视觉对照", run: (job) => {
          job.append("本地验收 fixture，未运行外部命令。", { channel: "log" });
          return { cancel: () => completion.resolve({ status: "killed" }), done: completion.promise };
        } });
        nativeJob = { id, finish: completion.resolve };
      } else if (url.pathname === "/__notice/native-goal-clear") {
        const agent = ctx.agents.get(url.searchParams.get("sid"));
        const goal = ctx.goals.get(agent);
        result = ctx.goals.clear(agent, { id: goal.id, revision: goal.revision });
        const settled = ctx.jobs.wait(nativeJob.id, 1000);
        nativeJob.finish({ status: "completed" });
        await settled; ctx.jobs.remove(nativeJob.id); nativeJob = undefined;
      } else if (url.pathname === "/__notice/approval") {
        await ctx.sessionController.prompt({ sessionId: url.searchParams.get("sid"), requestId: `approval-${++serial}`, mode: "queue", content: [{ type: "text", text: "UI_STATUS_APPROVAL" }] }, new AbortController().signal);
        result = { requested: true };
      } else if (url.pathname === "/__notice/approval-cancel") {
        approvalAbort?.abort(); result = { cancelled: true };
      } else if (url.pathname === "/__notice/status-stream") {
        const service = ctx.get("ralphflowStatus");
        if (!service?.reader) throw new Error("real status service not mounted");
        if (!instrumented) {
          instrumented = service;
          const subscribe = service.reader.subscribe.bind(service.reader);
          service.reader.subscribe = (callback) => {
            statusCallbacks.add(callback);
            const off = subscribe(() => { if (!blocked) callback(); });
            return () => { statusCallbacks.delete(callback); off(); };
          };
        }
        blocked = url.searchParams.get("blocked") === "true";
        if (!blocked) for (const callback of statusCallbacks) callback();
        result = { blocked, subscriptions: statusCallbacks.size };
      } else if (url.pathname === "/__notice/empty") {
        result = await ctx.sessionController.create({ cwd: process.cwd() });
        await ctx.sessionController.prompt({ sessionId: result.sessionId, requestId: `empty-${++serial}`, mode: "queue", content: [{ type: "text", text: "UI_STATUS_EMPTY" }] }, new AbortController().signal);
        await ctx.sessionController.rename({ sessionId: result.sessionId, title: "UI_STATUS_EMPTY" });
      } else if (url.pathname === "/__notice/fork") {
        result = await ctx.sessionController.fork({ sessionId: url.searchParams.get("sid") });
        await ctx.sessionController.rename({ sessionId: result.sessionId, title: "UI_STATUS_FORK" });
      } else if (url.pathname === "/__notice/action") {
        const agent = ctx.agents.get(url.searchParams.get("sid"));
        const name = url.searchParams.get("name");
        if (!["ralphflow_continue", "ralphflow_cancel"].includes(name)) throw new Error("unsupported acceptance action");
        result = await ctx.get("tools").get(name).execute((url.searchParams.has("instance") ? { instance: url.searchParams.get("instance") } : {}), { agent, signal: new AbortController().signal });
      } else if (url.pathname === "/__notice/ui") {
        const agent = ctx.agents.get(url.searchParams.get("sid"));
        result = await ctx.get("ralphflowStatus").reader.read(agent.session);
      } else if (url.pathname === "/__notice/graph") {
        const { sessionId } = await ctx.sessionController.create({ cwd: process.cwd() });
        await ctx.sessionController.selectModel({ sessionId, provider: "notice-fixture", model: "notice" });
        await ctx.sessionController.prompt({ sessionId, requestId: `graph-${++serial}`, mode: "queue", content: [{ type: "text", text: "UI_GRAPH_VIEWER" }] }, new AbortController().signal);
        await ctx.sessionController.rename({ sessionId, title: "UI_GRAPH_VIEWER" });
        result = { sessionId };
      } else if (url.pathname === "/__notice/start") {
        const mode = url.searchParams.get("mode") ?? "loop";
        const { sessionId } = await ctx.sessionController.create({ cwd: process.cwd() });
        await ctx.sessionController.selectModel({ sessionId, provider: "notice-fixture", model: "notice" });
        await ctx.sessionController.prompt({ sessionId, requestId: `notice-${++serial}`, mode: "queue", content: [{ type: "text", text: `完成 UI_NOTICE_${mode.toUpperCase()}` + (process.env.RALPHFLOW_STATUS_LONG_CHAT ? "\n" + Array.from({ length: 70 }, (_, i) => `验收上下文 ${i + 1}：检查长 Chat 中的固定状态入口。`).join("\n") : "") }] }, new AbortController().signal);
        result = { sessionId };
      } else if (url.pathname === "/__notice/release") {
        const p = pending.shift(); if (!p) throw new Error("no pending vote");
        p.resolve(url.searchParams.get("pass") === "true"); result = { mode: p.mode };
      } else if (url.pathname === "/__notice/rework") {
        for (const resolve of holds.splice(0)) resolve(); result = { released: true };
      } else if (url.pathname === "/__notice/inspect") {
        const agent = ctx.agents.get(url.searchParams.get("sid"));
        const providers = ctx.cordisInspect.list();
        if (!url.searchParams.has("query")) result = { providers };
        else result = await ctx.cordisInspect.query("client", "Slots", "listSubTree", JSON.parse(url.searchParams.get("query")), agent, new AbortController().signal);
      } else {
        const agent = ctx.agents.get(url.searchParams.get("sid"));
        result = { pending: pending.map((p) => p.mode), holds: holds.length, status: agent?.status,
          events: agent?.session.snapshotEvents(), messages: agent?.session.deriveMessages(), inboxPending: agent?.inbox.hasPending };
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e), stack: e.stack })); }
  } });
}
