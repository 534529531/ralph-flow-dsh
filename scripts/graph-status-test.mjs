#!/usr/bin/env node
/**
 * Graph 状态投影 + 只读查看器数据（§8 阶段 5 的内核半边）。
 * 判据：同一份 status 流能表达 Flow 与 Graph；Graph 有独立投影（节点/当前/等待原因/交付分类），
 * 不伪造 step；查看器目录含 DO/CHECK 且远端严格解析；查看器源码没有控制面调用。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFacade } from "../lib/facade.js";
import { parseStatusFrame } from "../lib/status-contract.js";
import { deliveryPorts } from "./helpers/ports.mjs";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const sleep = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-home-"));
process.env.HOME = home;
process.env.DSH_HOME = path.join(home, ".dsh");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-status-"));
process.env.RALPHFLOW_GRAPH_ARTIFACT = "1";
const rf = path.join(workspace, ".dsh", "ralph-flow");
fs.mkdirSync(path.join(rf, "graphs"), { recursive: true });
fs.writeFileSync(path.join(rf, "graphs", "status-demo.yaml"), `kind: graph
manual_step: [build]
steps:
  - id: plan
    desc: plan it
    do: plan it
    output: plan.md
    check: "1. plan exists"
  - id: build
    desc: build it
    do: build it
    output: build.md
    depends_on: [plan]
    check: "1. build exists"
`);

const mainSession = "session-status";
const main = { id: mainSession, session: { id: mainSession, header: { cwd: workspace }, append() {} }, steer() {}, followup() {}, ctx: { get: (name) => name === "tools" ? { register: () => () => {} } : undefined } };
let facade;
const ctx = {
  tools: { register() {}, get() { return undefined; }, schemas() { return []; }, view() { return { visible: new Map() }; } },
  agents: { get: (id) => id === mainSession ? main : undefined, async create(opts) { const tools = []; opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } }); const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup() { const write = tools.find((tool) => tool.name === "ralphflow_artifact_write"); void (async () => { if (write) await write.execute({ content: "artifact" }, { agent }); await facade.submitFromAny(agent); })(); }, async whenIdle() { await sleep(40); } }; return { agent, dispose: async () => {} }; } },
  sessions: { get() { return undefined; } },
};
const verify = async (req) => ({ status: "passed", reason: "ok", evidence: req.graph.criteria.map((criterion) => ({ criterion, passed: true, evidence: "seen" })), step_id: req.step.id, node_id: req.graph.nodeId, attempt_id: req.graph.attemptId, check_index: 0, ts: new Date().toISOString() });
facade = createFacade(workspace, { ctx, ports: { ...deliveryPorts(() => {}), verify, log() {} } });
facade.ensureLayout();

console.log("V1 查看器目录");
{
  const catalog = facade.viewerCatalog();
  const graph = catalog.find((asset) => asset.name === "status-demo");
  const flow = catalog.find((asset) => asset.name === "loop");
  const createGraph = catalog.find((asset) => asset.name === "create-graph");
  check("目录同时含 Flow 与 Graph 资产", !!graph && !!flow && !!createGraph, catalog.map((asset) => `${asset.kind}:${asset.name}`).join(","));
  check("Graph 节点带 DO / CHECK / dependsOn / inputs", graph.nodes[1].do === "build it" && /plan exists/.test(graph.nodes[0].check) && graph.nodes[1].dependsOn[0] === "plan" && graph.nodes[1].inputs[0].fromNode === "plan", JSON.stringify(graph.nodes[1]));
  check("Flow 步骤带 DO / CHECK / on_pass", flow.steps.length > 0 && typeof flow.steps[0].do === "string" && typeof flow.steps[0].onPass === "string", JSON.stringify(flow.steps[0]));
  check("manual_step 在目录里标成人工门", graph.nodes[1].manual === true && graph.nodes[0].manual === false);
  check("create-graph 是设计 Graph 的 Flow 工作流", createGraph.kind === "flow" && /Graph/.test(createGraph.description), `${createGraph.kind} ${createGraph.description}`);
}

console.log("V2 Graph 状态投影");
{
  await facade.start("status-demo", "status task", mainSession);
  await sleep(250);
  const ui = facade.uiStatus(mainSession);
  check("uiStatus 返回 Graph 状态", ui.status?.kind === "graph" && ui.status.graph, JSON.stringify(ui.status?.stage));
  check("Graph 不伪造 step/steps/votes", ui.status.step === "" && ui.status.steps.length === 0 && ui.status.votes.length === 0, JSON.stringify(ui.status.steps));
  check("Graph 投影含节点、当前节点、计数", ui.status.graph.nodes.length === 2 && !!ui.status.graph.current && ui.status.graph.counts.total === 2, JSON.stringify(ui.status.graph));
  check("Graph 投影含交付分类", typeof ui.status.graph.delivery.delivered === "number" && typeof ui.status.graph.delivery.unfinished === "number", JSON.stringify(ui.status.graph.delivery));
  const frame = { kind: "snapshot", sessionId: mainSession, catalog: facade.viewerCatalog(), status: ui.status, error: null };
  const parsed = parseStatusFrame(frame);
  check("严格解析器接受 Graph 帧并保留 kind/graph", parsed.status.kind === "graph" && parsed.status.graph.nodes.length === 2, JSON.stringify(parsed.status.graph?.counts));
  check("严格解析器保留 catalog", parsed.catalog.length >= 3 && parsed.catalog.some((asset) => asset.name === "create-graph"));
  check("拒绝伪造的 Graph 交付计数", (() => {
    try {
      const bad = JSON.parse(JSON.stringify(frame));
      bad.status.graph.delivery.delivered = -1;
      parseStatusFrame(bad);
      return false;
    } catch { return true; }
  })());
}

console.log("V3 人工门与终态");
{
  for (let index = 0; index < 120; index++) {
    const ui = facade.uiStatus(mainSession);
    if (ui.status?.kind === "graph" && ui.status.stage === "gate") break;
    await sleep(60);
  }
  let ui = facade.uiStatus(mainSession);
  check("人工门阶段投影为 gate 且带 todo 线索", ui.status?.stage === "gate" && ui.status.graph.nextAction?.kind === "manual_review" && !!ui.status.graph.nextAction.todoId, JSON.stringify(ui.status?.graph.nextAction));
  const respondTool = main.ctx.get("tools") ?? null;
  void respondTool;
  facade.respond(main, "批准此版本");
  for (let index = 0; index < 120; index++) {
    ui = facade.uiStatus(mainSession);
    if (ui.status?.stage === "done") break;
    await sleep(60);
  }
  check("完成后 Graph 状态收为 done 并指向报告", ui.status?.kind === "graph" && ui.status.stage === "done" && !!ui.status.report, JSON.stringify({ stage: ui.status?.stage, report: ui.status?.report }));
  check("完成状态仍保留节点投影", ui.status.graph.nodes.every((node) => node.status === "completed"), JSON.stringify(ui.status.graph.nodes.map((node) => node.status)));
}

console.log("V4 查看器只读边界");
{
  const source = fs.readFileSync(new URL("../src/client/viewer.tsx", import.meta.url), "utf-8");
  check("查看器没有启动/暂停/取消/审批/写产物调用", !/ralphflow_start\s*\(|ralphflow_cancel\s*\(|ralphflow_continue\s*\(|ralphflow_respond\s*\(|ralphflow_artifact_write\s*\(/.test(source));
  check("查看器只依赖 status source（没有第二套轮询/HTTP）", /createStatusSource|useSyncExternalStore/.test(source) && !/fetch\(|EventSource|setInterval/.test(source));
  const client = fs.readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf-8");
  const statusSource = fs.readFileSync(new URL("../src/client/status.tsx", import.meta.url), "utf-8");
  check("客户端装配了只读查看器 tab", /registerWorkflowStatus/.test(client) && /registerViewerTab/.test(statusSource));
  const status = fs.readFileSync(new URL("../src/client/status.tsx", import.meta.url), "utf-8");
  check("查看器与状态面共用同一个 source", /registerViewerTab\(ctx, sourceFor\)/.test(status));
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
