#!/usr/bin/env node
/**
 * Graph 的插件面（§8 阶段 3）：8 个主工具不变、start 回执、submit 按绑定分派、
 * respond 作用域注册、reset/rewind 拒绝 Graph、cleanup 命令、ralphflow-create skill。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkEnv, execTool, toolOf, cmdOf, textOf, sleep, rfDir, instanceDirs, readStateFile } from "./helpers/plugin-harness.mjs";
import * as plugin from "../lib/index.js";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-home-"));
process.env.HOME = home;
process.env.DSH_HOME = path.join(home, ".dsh");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-surface-"));
process.chdir(ws);
process.env.RALPHFLOW_GRAPH_ARTIFACT = "1";
const sid = "session-graph-surface";
const env = mkEnv(ws, sid);
env.ctx.on = () => () => {};
const main = env.agents.get(sid);
const mainTools = [];
main.ctx = { get: (name) => name === "tools" ? { register: (definition) => { mainTools.push(definition); return () => {}; } } : undefined };
main.steer = (message) => { env.sent.push(message); };
env.ctx.tools.get = () => undefined;
env.ctx.tools.view = () => ({ visible: new Map() });
env.ctx.sessions.get = (id) => id === sid ? main.session : (main.sessionMap?.[id] ?? undefined);
const nodeBehaviors = [];
env.ctx.agents.create = async (opts) => {
  const tools = [];
  const scope = { tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } };
  opts.setup?.(scope);
  const agent = {
    id: opts.sessionId,
    session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} },
    followup(message) { nodeBehaviors.push({ agent, tools, message, opts }); },
    async whenIdle() { await sleep(80); },
  };
  env.agents.set(opts.sessionId, agent);
  return { agent, dispose: async () => { env.agents.delete(opts.sessionId); } };
};
let submitTool;
async function submitNode(agent, tools) {
  const write = tools.find((tool) => tool.name === "ralphflow_artifact_write");
  if (write) await write.execute({ content: "node artifact" }, { agent, signal: new AbortController().signal });
  return submitTool.execute({ unfinished: [] }, { agent, signal: new AbortController().signal, concludeTurn() {} });
}
async function processNodeBehaviors() {
  while (nodeBehaviors.length > 0) {
    const item = nodeBehaviors.shift();
    await submitNode(item.agent, item.tools);
  }
}
// 验证者：从 Graph CHECK 提示词里抄出判据，返回逐条证据（真实结构，不是默认 stub）。
env.ctx.subagents.startActivation = async (spec) => {
  const prompt = (spec.request.prompt ?? []).map((block) => block.text ?? "").join("\n");
  const section = /## 完整 CHECK[^\n]*\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
  const criteria = section.split("\n").map((line) => line.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
  return {
    childId: "child",
    result: Promise.resolve({
      structured: { passed: true, reason: "ok", evidence: criteria.map((criterion) => ({ criterion, passed: true, evidence: "observed" })) },
      output: [], stopReason: "completed",
    }),
  };
};

fs.mkdirSync(path.join(rfDir(ws), "graphs"), { recursive: true });
fs.writeFileSync(path.join(rfDir(ws), "graphs", "demo.yaml"), `kind: graph
manual_step: [make]
steps:
  - id: make
    desc: make it
    do: make it
    output: out.md
    check: "1. out.md exists"
`);
plugin.apply(env.ctx);
submitTool = toolOf(env.registered, "ralphflow_submit");
await processNodeBehaviors();

const graphStates = () => instanceDirs(ws).map((id) => ({ id, state: readStateFile(ws, id) })).filter((entry) => entry.state?.kind === "graph");
async function waitState(predicate, label) {
  for (let index = 0; index < 160; index++) {
    const states = graphStates();
    const entry = states.at(-1);
    if (entry && predicate(entry)) return entry;
    await processNodeBehaviors();
    await sleep(60);
  }
  const entry = graphStates().at(-1);
  console.log(`      timeout ${label}: ${JSON.stringify(entry?.state?.graph?.status)}`);
  return entry;
}

console.log("P1 主工具面与清单");
{
  const names = env.registered.tools.map((tool) => tool.name);
  const mainSeven = ["ralphflow_start", "ralphflow_submit", "ralphflow_continue", "ralphflow_status", "ralphflow_list", "ralphflow_cancel", "ralphflow_doctor"];
  check("主工具收为 7 个（create 已迁成 skill）", mainSeven.every((name) => names.includes(name)) && !names.includes("ralphflow_create"), names.join(","));
  check("没有第二个命名空间（rg_*）", names.every((name) => !name.startsWith("rg_")), names.join(","));
  check("没有全局 ralphflow_respond / artifact_write", !names.includes("ralphflow_respond") && !names.includes("ralphflow_artifact_write"), names.join(","));
  const list = await execTool(toolOf(env.registered, "ralphflow_list"), {}, sid);
  check("list 同时列出 Flow 与 Graph 内置", /loop/.test(list) && /codewiki/.test(list) && /create-graph/.test(list), list.slice(0, 300));
  const doctor = await execTool(toolOf(env.registered, "ralphflow_doctor"), { workflow: "demo" }, sid);
  check("doctor 可只诊断一个 Graph 资产", /Graph 资产诊断/.test(doctor) && /✅/.test(doctor), doctor.slice(0, 200));
  check("doctor 展示有效 CHECK", /有效 CHECK/.test(doctor) && /out\.md exists/.test(doctor), doctor.slice(0, 400));
}

console.log("P2 start 输入校验与节点执行");
{
  const start = toolOf(env.registered, "ralphflow_start");
  const started = await execTool(start, { workflow: "demo", task: "t" }, sid);
  check("Graph start 返回回执而不是 DO", /已启动 Graph/.test(started) && !/## 本步任务/.test(started), started.slice(0, 200));
  const entry = await waitState((item) => item.state.graph.status === "running" || item.state.graph.status === "waiting", "graph started");
  check("实例落在 .dsh/ralph-flow/instances/", !!entry && fs.existsSync(path.join(rfDir(ws), "instances", entry.id, "state.json")));
  await processNodeBehaviors();
  const gated = await waitState((item) => item.state.graph.human_todos.some((todo) => todo.status === "waiting"), "manual gate");
  check("人工门等待并注册作用域 respond", !!gated && mainTools.some((tool) => tool.name === "ralphflow_respond"), mainTools.map((tool) => tool.name).join(","));
  const status = await execTool(toolOf(env.registered, "ralphflow_status"), {}, sid);
  check("status 显示 Graph 节点与等待原因", /Graph 实例/.test(status) && /等待你放行/.test(status), status.slice(0, 400));
  const respond = mainTools.find((tool) => tool.name === "ralphflow_respond");
  const answer = await respond.execute({ text: "批准此版本" }, { agent: main, signal: new AbortController().signal });
  check("respond 批准被受理", /批准/.test(answer), answer);
  const done = await waitState((item) => item.state.graph.status === "completed", "graph completed");
  check("Graph 实例完成并保留状态", done?.state.graph.status === "completed" && fs.existsSync(path.join(rfDir(ws), "instances", done.id, "state.json")), done?.state.graph.status);
  check("报告归档到 reports/<id>.md", fs.existsSync(path.join(rfDir(ws), "reports", `${done.id}.md`)));
}

console.log("P3 reset / rewind 对 Graph 明确拒绝");
{
  // 新起一个 Graph 实例（上一实例已完成），在人工门处调用 reset/rewind。
  await execTool(toolOf(env.registered, "ralphflow_start"), { workflow: "demo", task: "t2" }, sid);
  const gate = await waitState((item) => item.state.graph.status !== "completed" && item.state.graph.human_todos.some((todo) => todo.status === "waiting"), "second gate");
  await processNodeBehaviors();
  const reset = cmdOf(env.registered, "ralphflow-reset");
  const resetOut = await reset.handler({ rawInput: "", agent: main, signal: new AbortController().signal });
  const resetText = env.sent.map((message) => textOf(message)).join("\n");
  check("reset 命令对 Graph 返回 success + 说明不适用", resetOut.kind === "success" && /Graph 实例/.test(resetText), resetText.slice(-300));
  const rewind = cmdOf(env.registered, "ralphflow-rewind");
  const rewindOut = await rewind.handler({ rawInput: "make 换方向", agent: main, signal: new AbortController().signal });
  const rewindText = env.sent.map((message) => textOf(message)).join("\n");
  check("rewind 命令对 Graph 返回 success + DAG 说明", rewindOut.kind === "success" && /DAG/.test(rewindText), rewindText.slice(-300));
  check("ralphflow-pause 命令已移除（统一用停止按钮）", !cmdOf(env.registered, "ralphflow-pause"));
  const cleanup = cmdOf(env.registered, "ralphflow-cleanup");
  const cleanupOut = await cleanup.handler({ rawInput: gate.id, agent: main, signal: new AbortController().signal });
  check("cleanup 已注册且不会删除状态", cleanupOut.kind === "success" && fs.existsSync(path.join(rfDir(ws), "instances", gate.id, "state.json")), JSON.stringify(cleanupOut));
  // 收尾：取消这个等待中的门。
  await execTool(toolOf(env.registered, "ralphflow_cancel"), { instance: gate.id, reason: "test cleanup" }, sid);
}

console.log("P4 create 已迁成 skill");
{
  const createSkill = env.registered.skills.find((skill) => skill.name === "ralphflow-create");
  check("注册了 ralphflow-create skill", !!createSkill && /工作流或 DAG/.test(createSkill.description), JSON.stringify(createSkill?.description));
  check("skill 自带随包参考目录", createSkill?.resourceBase?.kind === "directory" && /references$/.test(createSkill.resourceBase.path), JSON.stringify(createSkill?.resourceBase));
  check("skill 的 Graph 分支启动 create-graph", /create-graph/.test(createSkill?.content ?? ""), createSkill?.content?.slice(0, 200));
  check("不再注册 create 命令", !env.registered.commands.some((command) => command.name === "ralphflow-create"));
}

console.log("P5 Flow 面不回归");
{
  const cancel = await execTool(toolOf(env.registered, "ralphflow_cancel"), {}, sid);
  check("没有活跃实例时 cancel 如实说明", /没有活跃/.test(cancel), cancel);
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
