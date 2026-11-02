#!/usr/bin/env node
/**
 * 资产目录（skill 式文件夹）回归：
 *
 *   1. **目录形态** `workflows/<name>/workflow.yaml`、`graphs/<name>/graph.yaml` 可被发现、可加载；
 *   2. DO 提示词与 CHECK 提示词带**同一个**参考根（入口文件所在目录）；
 *   3. 参考根来自引擎投递的提示词与验证请求，下游按这个根真的读得到同目录资源；
 *   4. **单文件形态** `<name>.yaml` 仍可加载（Flow 与 Graph），参考根退化为它所在的目录；
 *   5. `ralphflow_doctor` 的路径参数接受入口文件**与资产目录**，内置资产按入口路径识别；
 *   6. 内置 loop / spec / create-graph / codewiki 从新布局可发现、可启动；
 *   7. **子工作流**展开后的步骤带子资产自己的参考根（不是调用点的）；
 *   8. **符号链接**到目录或 YAML 的资产同样被 list / doctor 发现；
 *   9. 资产目录只解析**资产资源**；要写出的交付物按 `output` / 产出目录的落点。
 *      提示词里提到的资源名（`notes.md` / `spec.md` / `format.md`）必须能用注入根真实读到 ——
 *      验证「短指针可解析」，而不是测试自己另拼一条路径。
 *
 * 判据只看引擎实际投递的文本与 verify 端口实际收到的请求 —— 不读实现内部状态。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { createFacade } from "../lib/facade.js";
import { buildCheckPrompt } from "../lib/verify.js";
import { discoverAssetsIn as discoverSkillAssets } from "../lib/assets.js";
import { deliveryPorts } from "./helpers/ports.mjs";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).slice(0, 400)}` : ""}`); }
};
const sleep = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 从提示词里取「资产目录」一节给的根；取不到返回 undefined。 */
function injectedRoot(text) {
  return /## 资产目录\n`([^`]+)`/.exec(text)?.[1];
}
/** 下游视角：只拿到提示词里的根，按相对路径读文件。 */
function readRelative(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf-8");
}
/**
 * 提示词里提到的、能在注入根下真实读到的资产资源（反引号里的相对名）。
 *
 * 这是「短指针闭环」的机械判据：提示词说 `notes.md`，验证者只拿注入根就能打开它；
 * 不是测试另外记住项目路径再读一遍。
 */
function promptResources(text, root) {
  const found = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const rel = match[1].trim();
    if (!rel || path.isAbsolute(rel) || rel.startsWith("..") || rel.includes("<")) continue;
    try {
      if (fs.statSync(path.join(root, rel)).isFile()) found.push(rel);
    } catch {}
  }
  return [...new Set(found)];
}
/** 取提示词里某个 `## ` 节（标题 → 正文；正文不含下一个标题行）。 */
function sectionOf(text, title) {
  const heads = [...text.matchAll(/^## (.+)$/gm)].map((m) => ({ title: m[1].trim(), start: m.index, end: m.index + m[0].length }));
  const at = heads.findIndex((h) => h.title === title);
  if (at < 0) return undefined;
  const stop = at + 1 < heads.length ? heads[at + 1].start : text.length;
  return text.slice(heads[at].end, stop);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rf-assetdir-home-"));
process.env.HOME = home;
process.env.DSH_HOME = path.join(home, ".dsh");
// Graph 用 artifact 模式：这条用例只关心提示词与参考根，不需要 Git 隔离。
process.env.RALPHFLOW_GRAPH_ARTIFACT = "1";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-assetdir-ws-"));
const rf = path.join(ws, ".dsh", "ralph-flow");
const workflowsDir = path.join(rf, "workflows");
const graphsDir = path.join(rf, "graphs");
const sid = "session-assetdir";

const FLOW_STEPS = [
  "steps:",
  "  - id: only",
  "    desc: 唯一一步",
  "    input: 任务",
  "    output: 结果",
  "    check: 产物与 `notes.md` 的约定一致",
  "    on_pass: done",
  "    on_fail: only",
  "    max_fail_count: 2",
  "    do: 读同目录的 `notes.md`，按它写出结果。",
].join("\n");

// 目录形态的 Flow：入口 + 同目录资源
const flowDir = path.join(workflowsDir, "folder-flow");
fs.mkdirSync(flowDir, { recursive: true });
fs.writeFileSync(path.join(flowDir, "workflow.yaml"), `description: 目录形态的 Flow\n${FLOW_STEPS}\n`);
fs.writeFileSync(path.join(flowDir, "notes.md"), "# 约定\n\n产物只写一行。\n");

// 单文件形态的 Flow（兼容形态）
fs.writeFileSync(path.join(workflowsDir, "single-file.yaml"), `description: 单文件形态的 Flow\n${FLOW_STEPS}\n`);
fs.writeFileSync(path.join(workflowsDir, "single-resource.md"), "# 单文件 Flow 的共享资源\n");
// 名字恰好撞上固定入口名的单文件资产：`workflows/workflow.yaml` 是名字为 `workflow`
// 的单文件 Flow，不是名为 `workflows` 的目录；`graphs/graph.yaml` 同理。doctor 按路径诊断时
// 必须和 `start("workflow")` 解析出同一个名字。
fs.writeFileSync(path.join(workflowsDir, "workflow.yaml"), `description: 名字恰为 workflow 的单文件 Flow\n${FLOW_STEPS}\n`);
fs.mkdirSync(graphsDir, { recursive: true });
fs.writeFileSync(path.join(graphsDir, "graph.yaml"), [
  "kind: graph",
  "steps:",
  "  - id: named",
  "    desc: 一步",
  "    do: 写出产物。",
  "    output: named.md",
  '    check: "1. 产物存在"',
  "",
].join("\n"));

// 目录形态的 Graph：入口 + 同目录资源
const graphDir = path.join(graphsDir, "folder-graph");
fs.mkdirSync(graphDir, { recursive: true });
fs.writeFileSync(path.join(graphDir, "graph.yaml"), [
  "kind: graph",
  "steps:",
  "  - id: one",
  "    desc: 一步",
  "    do: 读同目录的 `spec.md`，按它写出产物。",
  "    output: one.md",
  '    check: "1. 产物与 spec.md 的约定一致"',
  "",
].join("\n"));
fs.writeFileSync(path.join(graphDir, "spec.md"), "# 规格\n\n产物只写一行。\n");

// 单文件形态的 Graph（兼容形态）：参考根退化为 graphs/ 目录。
const singleGraphFile = path.join(graphsDir, "single-graph.yaml");
fs.writeFileSync(singleGraphFile, [
  "kind: graph",
  "steps:",
  "  - id: single",
  "    desc: 一步",
  "    do: 写出产物。",
  "    output: single.md",
  '    check: "1. 产物存在"',
  "",
].join("\n"));
fs.writeFileSync(path.join(graphsDir, "single-resource.md"), "# 单文件 Graph 的共享资源\n");
const emptyAssetDir = path.join(workflowsDir, "empty-asset");
fs.mkdirSync(emptyAssetDir, { recursive: true });

// 用户级（全局）目录形态：参考根与来源无关，仍取入口文件所在目录。
const globalRf = path.join(home, ".dsh", "ralph-flow");
const globalFlowDir = path.join(globalRf, "workflows", "global-flow");
fs.mkdirSync(globalFlowDir, { recursive: true });
fs.writeFileSync(path.join(globalFlowDir, "workflow.yaml"), `description: 用户级目录形态的 Flow\n${FLOW_STEPS}\n`);
fs.writeFileSync(path.join(globalFlowDir, "notes.md"), "# 全局约定\n\n产物只写一行。\n");
const globalGraphDir = path.join(globalRf, "graphs", "global-graph");
fs.mkdirSync(globalGraphDir, { recursive: true });
fs.writeFileSync(path.join(globalGraphDir, "graph.yaml"), [
  "kind: graph",
  "steps:",
  "  - id: global",
  "    desc: 一步",
  "    do: 读同目录的 `spec.md`，按它写出产物。",
  "    output: global.md",
  '    check: "1. 产物与 spec.md 的约定一致"',
  "",
].join("\n"));
fs.writeFileSync(path.join(globalGraphDir, "spec.md"), "# 全局规格\n\n产物只写一行。\n");

// 子工作流：父级唯一一步委托给 child-flow；子目录有自己的 notes.md。
const childFlowDir = path.join(workflowsDir, "child-flow");
fs.mkdirSync(childFlowDir, { recursive: true });
fs.writeFileSync(path.join(childFlowDir, "workflow.yaml"), [
  "description: 子工作流（目录形态）",
  "steps:",
  "  - id: only",
  "    desc: 子工作流的唯一一步",
  "    input: 任务",
  "    output: 结果",
  "    do: 读同目录的 `notes.md`，按它写出结果。",
  "    check: 产物与同目录 `notes.md` 的约定一致",
  "    on_pass: done",
  "    on_fail: only",
  "    max_fail_count: 2",
  "",
].join("\n"));
fs.writeFileSync(path.join(childFlowDir, "notes.md"), "# 子工作流约定\n\n产物只写一行。\n");
const parentFlowDir = path.join(workflowsDir, "parent-flow");
fs.mkdirSync(parentFlowDir, { recursive: true });
fs.writeFileSync(path.join(parentFlowDir, "workflow.yaml"), [
  "description: 父工作流（调用子工作流）",
  "steps:",
  "  - id: call",
  "    desc: 委托子工作流",
  "    input: 任务",
  "    output: 结果",
  "    workflow: child-flow",
  "    on_pass: done",
  "    on_fail: call",
  "    max_fail_count: 2",
  "",
].join("\n"));
fs.writeFileSync(path.join(parentFlowDir, "notes.md"), "# 父工作流约定\n\n只给父级自己的步骤用。\n");

// 符号链接资产：目录与单文件两种形态都必须在发现面（list / doctor）可见。
const linkedFlowSource = path.join(ws, "linked-source-flow");
fs.mkdirSync(linkedFlowSource, { recursive: true });
fs.writeFileSync(path.join(linkedFlowSource, "workflow.yaml"), `description: 软链目录形态的 Flow\n${FLOW_STEPS}\n`);
fs.writeFileSync(path.join(linkedFlowSource, "notes.md"), "# 软链约定\n\n产物只写一行。\n");
fs.symlinkSync(linkedFlowSource, path.join(workflowsDir, "linked-flow"), "dir");
const linkedSingleSource = path.join(ws, "linked-single-source.yaml");
fs.writeFileSync(linkedSingleSource, `description: 软链单文件形态的 Flow\n${FLOW_STEPS}\n`);
fs.symlinkSync(linkedSingleSource, path.join(workflowsDir, "linked-single.yaml"), "file");
const linkedGraphSource = path.join(ws, "linked-source-graph");
fs.mkdirSync(linkedGraphSource, { recursive: true });
fs.writeFileSync(path.join(linkedGraphSource, "graph.yaml"), [
  "kind: graph",
  "steps:",
  "  - id: linked",
  "    desc: 一步",
  "    do: 读同目录的 `spec.md`，按它写出产物。",
  "    output: linked.md",
  '    check: "1. 产物与 spec.md 的约定一致"',
  "",
].join("\n"));
fs.writeFileSync(path.join(linkedGraphSource, "spec.md"), "# 软链 Graph 规格\n\n产物只写一行。\n");
fs.symlinkSync(linkedGraphSource, path.join(graphsDir, "linked-graph"), "dir");

/** 假宿主：主会话 + 节点子会话。节点 agent 只做两件事：写产物、交卷。 */
function makeHost() {
  const main = {
    id: sid,
    session: { id: sid, header: { cwd: ws }, append() {} },
    steer() {},
    followup() {},
  };
  const agents = new Map([[sid, main]]);
  const nodeMessages = [];
  let facade;
  const nodeBehavior = async (agent, tools) => {
    const write = tools.find((tool) => tool.name === "ralphflow_artifact_write");
    if (write) await write.execute({ content: "产物一行" }, { agent, signal: new AbortController().signal });
    await facade.submitFromAny(agent);
  };
  const ctx = {
    tools: { register() {}, get() { return undefined; }, schemas() { return []; }, view() { return { visible: new Map() }; } },
    sessions: { get(id) { return agents.get(id)?.session; } },
    agents: {
      get(id) { return agents.get(id); },
      async create(opts) {
        const tools = [];
        const scope = { tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } };
        opts.setup?.(scope);
        const agent = {
          id: opts.sessionId,
          session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} },
          followup(message) {
            // 节点 DO 以 dsh 消息形状投递：只取 text 块。
            nodeMessages.push(Array.isArray(message?.content)
              ? message.content.filter((block) => block?.type === "text").map((block) => block.text).join("")
              : String(message));
            void nodeBehavior(agent, tools);
          },
          async whenIdle() { await sleep(30); },
        };
        agents.set(opts.sessionId, agent);
        return { agent, dispose: async () => { agents.delete(opts.sessionId); } };
      },
    },
  };
  return { ctx, main, nodeMessages, setFacade: (value) => { facade = value; } };
}

async function waitFor(predicate, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

async function main() {
  const host = makeHost();
  const verifyRequests = [];
  const facade = createFacade(ws, {
    ctx: host.ctx,
    ports: {
      ...deliveryPorts(() => {}),
      verify: async (req) => {
        verifyRequests.push(req);
        return {
          status: "passed",
          reason: "ok",
          check_index: req.checkIndex,
          step_id: req.step.id,
          ts: new Date().toISOString(),
          ...(req.graph
            ? { node_id: req.graph.nodeId, attempt_id: req.graph.attemptId, evidence: req.graph.criteria.map((criterion) => ({ criterion, passed: true, evidence: "ok" })) }
            : {}),
        };
      },
      log() {},
    },
  });
  host.setFacade(facade);
  facade.ensureLayout();

  /** 等实例落定；仍在跑就取消，避免下一段被「本会话已有活跃实例」挡住。 */
  async function settle() {
    if (await waitFor(() => facade.activeInstanceOfSession(sid) === undefined, 3000)) return;
    await facade.cancelInstance(sid);
    await waitFor(() => facade.activeInstanceOfSession(sid) === undefined, 4000);
  }

  console.log("A) 目录形态的 Flow");
  let flowDo = "";
  {
    const listed = facade.listAll().text;
    check("list 能发现目录形态的 Flow（名字取目录名）", listed.includes("folder-flow"), listed.slice(0, 300));
    const started = await facade.start("folder-flow", "写一行", sid);
    flowDo = String(started.text);
    check("目录形态的 Flow 可启动", started.ok === true, flowDo);
    check("DO 提示词带「资产目录」一节", flowDo.includes("## 资产目录"), flowDo.slice(0, 400));
    const doRoot = injectedRoot(flowDo);
    check("DO 注入的参考根是资产目录", doRoot === flowDir, doRoot);
    check("执行者按 DO 的参考根读得到同目录资源",
      readRelative(doRoot, "notes.md").includes("产物只写一行"), doRoot);
    check("DO 里提到的资产资源（notes.md）能用注入根直接解析",
      promptResources(flowDo, doRoot).includes("notes.md"), JSON.stringify(promptResources(flowDo, doRoot)));
    const assetSec = sectionOf(flowDo, "资产目录") ?? "";
    const outSec = sectionOf(flowDo, "产出目录") ?? "";
    check("资产目录一节把参考根限定为资产自己的资源（相对路径解析 + 按需读取）",
      assetSec.includes("本资产自己的资源") && assetSec.includes("资源才读取"), assetSec);
    check("资产目录一节按用途划界：资源按基准目录解析，要写出的交付物按各自落点",
      assetSec.includes("要写出的交付物") && assetSec.includes("不在这个目录"), assetSec);
    check("资产目录一节不把「裸文件名」当成过程文档的判据（短指针 format.md 也是资源）",
      assetSec.length > 0 && !assetSec.includes("裸文件名"), assetSec);
    check("资产目录与产出目录两节同时存在，各管一类落点",
      assetSec.length > 0 && outSec.includes("过程文档") && outSec.includes("裸文件名"), outSec);

    await facade.submitFromAny(host.main, "写好了");
    const got = await waitFor(() => verifyRequests.some((item) => item.workflow?.name === "folder-flow"));
    const req = verifyRequests.find((item) => item.workflow?.name === "folder-flow");
    check("CHECK 走到独立验证者", got && Boolean(req));
    if (req) {
      check("验证请求带资产的入口文件路径（由引擎给出）", req.assetPath === path.join(flowDir, "workflow.yaml"), req.assetPath);
      const checkText = buildCheckPrompt(req, true);
      const checkRoot = injectedRoot(checkText);
      check("CHECK 注入同一个参考根", checkRoot === flowDir, checkRoot);
      check("验证者按 CHECK 的参考根读得到同一份资源",
        readRelative(checkRoot, "notes.md").includes("产物只写一行"), checkRoot);
      check("CHECK 里提到的资产资源（notes.md）能用同一参考根直接解析",
        promptResources(checkText, checkRoot).includes("notes.md"), JSON.stringify(promptResources(checkText, checkRoot)));
    }
    await settle();
  }

  console.log("B) 单文件形态的 Flow（兼容）");
  {
    const started = await facade.start("single-file", "写一行", sid);
    const doText = String(started.text);
    check("单文件形态仍可启动", started.ok === true, doText.slice(0, 300));
    const doRoot = injectedRoot(doText);
    check("单文件的参考根是它所在的目录", doRoot === workflowsDir, doRoot);
    check("单文件形态下按参考根也读得到共享资源",
      readRelative(doRoot, "single-resource.md").includes("共享资源"), doRoot);
    // 收尾：交卷并等它落定，否则下一个实例会被「本会话已有活跃实例」挡住。
    await facade.submitFromAny(host.main, "写好了");
    await waitFor(() => verifyRequests.some((item) => item.workflow?.name === "single-file"));
    await settle();
  }

  console.log("C) 目录形态的 Graph");
  {
    const listed = facade.listAll().text;
    check("list 能发现目录形态的 Graph（名字取目录名）", listed.includes("folder-graph"), listed.slice(0, 400));
    const before = host.nodeMessages.length;
    const started = await facade.start("folder-graph", "写一行", sid);
    check("目录形态的 Graph 可启动", started.ok === true, started.text);
    await waitFor(() => host.nodeMessages.length > before);
    const nodeDo = host.nodeMessages[before] ?? "";
    const nodeRoot = injectedRoot(nodeDo);
    check("节点 DO 提示词带「资产目录」一节", nodeDo.includes("## 资产目录"), nodeDo.slice(0, 400));
    check("节点 DO 的参考根是资产目录", nodeRoot === graphDir, nodeRoot);
    check("节点执行者按参考根读得到同目录资源",
      readRelative(nodeRoot, "spec.md").includes("产物只写一行"), nodeRoot);
    check("节点 DO 里提到的资产资源（spec.md）能用参考根直接解析",
      promptResources(nodeDo, nodeRoot).includes("spec.md"), JSON.stringify(promptResources(nodeDo, nodeRoot)));

    const gotGraph = await waitFor(() => verifyRequests.some((item) => item.graph?.nodeId === "one"));
    const graphReq = verifyRequests.find((item) => item.graph?.nodeId === "one");
    check("Graph CHECK 走到独立验证者", gotGraph && Boolean(graphReq));
    if (graphReq) {
      check("Graph 验证请求带同一个参考根", graphReq.assetPath === path.join(graphDir, "graph.yaml"), graphReq.assetPath);
      const graphCheck = buildCheckPrompt(graphReq, true);
      const graphRoot = injectedRoot(graphCheck);
      check("Graph CHECK 提示词带资产目录", graphRoot === graphDir, graphRoot);
      check("Graph 验证者按参考根读得到同一份资源",
        readRelative(graphRoot, "spec.md").includes("产物只写一行"), graphRoot);
      check("Graph CHECK 里提到的资产资源（spec.md）能用同一参考根直接解析",
        promptResources(graphCheck, graphRoot).includes("spec.md"), JSON.stringify(promptResources(graphCheck, graphRoot)));
      const graphAssetSec = sectionOf(graphCheck, "资产目录") ?? "";
      check("Graph CHECK 没有产出目录一节时，资产目录一节也不引用它（按用途划界）",
        graphAssetSec.includes("任务指定的落点") && !graphAssetSec.includes("产出目录"), graphAssetSec);
    }
    await settle();
  }

  console.log("D) 单文件形态的 Graph（兼容）");
  {
    const before = host.nodeMessages.length;
    const started = await facade.start("single-graph", "写一行", sid);
    check("单文件形态的 Graph 仍可启动", started.ok === true, started.text);
    await waitFor(() => host.nodeMessages.length > before);
    const nodeDo = host.nodeMessages[before] ?? "";
    const nodeRoot = injectedRoot(nodeDo);
    check("单文件 Graph 的参考根是 graphs/ 目录", nodeRoot === graphsDir, nodeRoot);
    check("单文件 Graph 按参考根读得到共享资源",
      readRelative(nodeRoot, "single-resource.md").includes("共享资源"), nodeRoot);
    const got = await waitFor(() => verifyRequests.some((item) => item.workflow?.name === "single-graph"));
    const req = verifyRequests.find((item) => item.workflow?.name === "single-graph");
    check("单文件 Graph 的 CHECK 也拿到同一个参考根",
      got && injectedRoot(buildCheckPrompt(req, true)) === graphsDir, req?.assetPath);
    await settle();
  }

  console.log("E) doctor 的路径参数：入口文件与资产目录");
  {
    const cases = [
      { label: "Flow 入口文件", target: path.relative(ws, path.join(flowDir, "workflow.yaml")), kind: "Flow", name: "folder-flow" },
      { label: "Flow 资产目录", target: path.relative(ws, flowDir), kind: "Flow", name: "folder-flow" },
      { label: "单文件 Flow", target: path.join(workflowsDir, "single-file.yaml"), kind: "Flow", name: "single-file" },
      { label: "名字恰为 workflow 的单文件 Flow", target: path.join(workflowsDir, "workflow.yaml"), kind: "Flow", name: "workflow" },
      { label: "Graph 入口文件", target: path.join(graphDir, "graph.yaml"), kind: "Graph", name: "folder-graph" },
      { label: "Graph 资产目录", target: graphDir, kind: "Graph", name: "folder-graph" },
      { label: "单文件 Graph", target: singleGraphFile, kind: "Graph", name: "single-graph" },
      { label: "名字恰为 graph 的单文件 Graph", target: path.join(graphsDir, "graph.yaml"), kind: "Graph", name: "graph" },
      { label: "内置 Flow 入口（新布局）", target: path.join(REPO, "workflows", "loop", "workflow.yaml"), kind: "Flow", name: "loop" },
      { label: "内置 Flow 目录", target: path.join(REPO, "workflows", "loop"), kind: "Flow", name: "loop" },
      { label: "内置 Graph 入口（新布局）", target: path.join(REPO, "graphs", "codewiki", "graph.yaml"), kind: "Graph", name: "codewiki" },
      { label: "内置 Graph 目录", target: path.join(REPO, "graphs", "codewiki"), kind: "Graph", name: "codewiki" },
      { label: "用户级 Flow 入口", target: path.join(globalFlowDir, "workflow.yaml"), kind: "Flow", name: "global-flow" },
      { label: "用户级 Graph 目录", target: globalGraphDir, kind: "Graph", name: "global-graph" },
    ];
    for (const item of cases) {
      const result = facade.diagnose(item.target);
      check(`${item.label}：按新布局识别为 ${item.kind} 资产 ${item.name}`,
        result.ok === true && result.text.includes(`${item.kind} 资产诊断`) && result.text.includes(`\`${item.name}\``) && !result.text.includes("不在 graphs/ 目录"),
        result.text.slice(0, 500));
    }
    const empty = facade.diagnose(emptyAssetDir);
    check("目录缺少固定入口：报错并说清两个合法入口名",
      empty.ok === false && empty.text.includes("workflow.yaml") && empty.text.includes("graph.yaml"), empty.text);
    const byFlowName = facade.diagnose("folder-flow");
    check("工作流名参数仍可诊断 Flow", byFlowName.ok === true && byFlowName.text.includes("`folder-flow`"), byFlowName.text.slice(0, 300));
    const byGraphName = facade.diagnose("folder-graph");
    check("工作流名参数仍可诊断 Graph", byGraphName.ok === true && byGraphName.text.includes("`folder-graph`"), byGraphName.text.slice(0, 300));
    // doctor 的路径参数与 start 的名字必须解析出同一个资产：固定入口名恰好是资产名的前缀时
    // 也不例外（`workflows/workflow.yaml` 是名字 `workflow` 的单文件资产）。
    for (const [name, target] of [["workflow", path.join(workflowsDir, "workflow.yaml")], ["graph", path.join(graphsDir, "graph.yaml")]]) {
      const diagnosed = facade.diagnose(target);
      const started = await facade.start(name, "写一行", sid);
      check(`名字恰为 ${name} 的单文件资产：doctor 路径与 start 名字一致`,
        diagnosed.ok === true && diagnosed.text.includes(`\`${name}\``) && started.ok === true,
        `${diagnosed.text.slice(0, 300)} || ${String(started.text).slice(0, 200)}`);
      await settle();
    }
  }

  console.log("F) 内置资产从新布局可发现、可启动");
  {
    const names = ["loop", "spec", "create-graph", "codewiki"];
    const codewikiDir = path.join(REPO, "graphs", "codewiki");
    const codewikiDoc = yaml.load(fs.readFileSync(path.join(codewikiDir, "graph.yaml"), "utf8"));
    const listed = facade.listAll().text;
    for (const name of names) check(`list 发现内置 ${name}`, listed.includes(`\`${name}\``), listed.slice(0, 400));
    for (const name of names) {
      const before = host.nodeMessages.length;
      const started = await facade.start(name, "启动检查", sid);
      check(`内置 ${name} 从新布局可启动`, started.ok === true, started.text);
      if (name !== "codewiki") {
        const expectedRoot = path.join(REPO, "workflows", name);
        check(`内置 ${name} 的参考根取目录形态（兼容单文件不遮蔽目录）`,
          injectedRoot(String(started.text)) === expectedRoot, injectedRoot(String(started.text)));
      } else {
        await waitFor(() => host.nodeMessages.length > before);
        const nodeDo = host.nodeMessages[before] ?? "";
        check("codewiki 节点 DO 注入的参考根是资产目录（不是 graphs/）",
          injectedRoot(nodeDo) === codewikiDir, injectedRoot(nodeDo));
        check("codewiki 节点 DO 的短指针 format.md 能用参考根真实读到",
          promptResources(nodeDo, codewikiDir).includes("format.md"), JSON.stringify(promptResources(nodeDo, codewikiDir)));
        check("codewiki 的全部 DO 与 CHECK 都指向同目录契约 format.md（CHECK 用短指针）",
          codewikiDoc.steps.every((step) => String(step.do).includes("format.md") && String(step.check).includes("format.md")),
          JSON.stringify(codewikiDoc.steps.map((step) => step.id)));
        check("契约文件 format.md 就在资产目录里（不是复制进提示词）",
          fs.statSync(path.join(codewikiDir, "format.md")).isFile());
      }
      await settle();
    }
  }

  console.log("G) 用户级资产也用同一条参考根规则");
  {
    const started = await facade.start("global-flow", "写一行", sid);
    const doText = String(started.text);
    check("用户级目录形态的 Flow 可启动", started.ok === true, doText.slice(0, 300));
    const doRoot = injectedRoot(doText);
    check("用户级 Flow 的参考根是它自己的资产目录", doRoot === globalFlowDir, doRoot);
    check("用户级 Flow 按参考根读得到同目录资源",
      readRelative(doRoot, "notes.md").includes("产物只写一行"), doRoot);
    await facade.submitFromAny(host.main, "写好了");
    await waitFor(() => verifyRequests.some((item) => item.workflow?.name === "global-flow"));
    const req = verifyRequests.find((item) => item.workflow?.name === "global-flow");
    check("用户级 Flow 的 CHECK 也拿到同一个参考根",
      Boolean(req) && injectedRoot(buildCheckPrompt(req, true)) === globalFlowDir, req?.assetPath);
    await settle();

    const before = host.nodeMessages.length;
    const graphStarted = await facade.start("global-graph", "写一行", sid);
    check("用户级目录形态的 Graph 可启动", graphStarted.ok === true, graphStarted.text);
    await waitFor(() => host.nodeMessages.length > before);
    const nodeRoot = injectedRoot(host.nodeMessages[before] ?? "");
    check("用户级 Graph 的参考根是它自己的资产目录", nodeRoot === globalGraphDir, nodeRoot);
    check("用户级 Graph 按参考根读得到同目录资源",
      readRelative(nodeRoot, "spec.md").includes("产物只写一行"), nodeRoot);
    const got = await waitFor(() => verifyRequests.some((item) => item.workflow?.name === "global-graph"));
    const graphReq = verifyRequests.find((item) => item.workflow?.name === "global-graph");
    check("用户级 Graph 的 CHECK 也拿到同一个参考根",
      got && injectedRoot(buildCheckPrompt(graphReq, true)) === globalGraphDir, graphReq?.assetPath);
    await settle();
  }

  console.log("H) create-graph 的生成目标是目录形态");
  {
    const doc = yaml.load(fs.readFileSync(path.join(REPO, "workflows", "create-graph", "workflow.yaml"), "utf8"));
    const step = doc.steps.find((item) => item.id === "graph");
    check("create-graph 的 output 是 graphs/<slug>/graph.yaml",
      String(step?.output ?? "").includes(".dsh/ralph-flow/graphs/<slug>/graph.yaml"), step?.output);
    check("create-graph 不再要求生成单文件 graphs/<slug>.yaml",
      !/graphs\/<slug>\.yaml/.test(String(step?.output)) && !/graphs\/<slug>\.yaml/.test(String(step?.do)), step?.do);
    check("create-graph 的 DO 要求在同一个资产目录放资源并用相对路径指向",
      String(step?.do ?? "").includes("同一个资产目录") && String(step?.do ?? "").includes("相对路径"), step?.do);
    check("create-graph 的 CHECK 覆盖入口路径与同目录资源",
      String(step?.check ?? "").includes("graphs/<slug>/graph.yaml") && String(step?.check ?? "").includes("同目录"), step?.check);
    const checkSteps = doc.steps.filter((item) => String(item.check ?? "").includes("matt/"));
    check("create-graph 的 CHECK 引用 matt 参考时写明 ralphflow-create skill 资源目录（不按资产根解析）",
      checkSteps.length > 0 && checkSteps.every((item) => String(item.check).includes("`ralphflow-create` skill 资源目录中的 `matt/")),
      checkSteps.map((item) => `${item.id}: ${item.check}`).join(" || "));
    check("create-graph 引用的 matt 参考在 skill 资源目录里真实存在",
      fs.statSync(path.join(REPO, "skills", "ralphflow-create", "matt", "writing-for-agents.md")).isFile());
  }

  console.log("I) 子工作流展开后的步骤带子资产参考根");
  {
    const before = verifyRequests.length;
    const started = await facade.start("parent-flow", "写一行", sid);
    const doText = String(started.text);
    check("父工作流可启动并展开子工作流", started.ok === true && doText.includes("call/only"), doText.slice(0, 500));
    const doRoot = injectedRoot(doText);
    check("子步骤 DO 的参考根是子资产目录（不是调用点）", doRoot === childFlowDir, doRoot);
    check("子步骤执行者按参考根读得到子目录的 notes.md",
      readRelative(doRoot, "notes.md").includes("子工作流约定"), doRoot);

    await facade.submitFromAny(host.main, "写好了");
    const got = await waitFor(() => verifyRequests.slice(before).some((item) => item.workflow?.name === "parent-flow"));
    const req = verifyRequests.slice(before).find((item) => item.workflow?.name === "parent-flow");
    check("子步骤 CHECK 请求带子资产的入口文件",
      got && req.assetPath === path.join(childFlowDir, "workflow.yaml"), req?.assetPath);
    if (req) {
      const checkText = buildCheckPrompt(req, true);
      check("子步骤 CHECK 与 DO 拿到同一个子资产参考根", injectedRoot(checkText) === childFlowDir, injectedRoot(checkText));
      check("子步骤验证者按参考根读得到同一份 notes.md",
        readRelative(childFlowDir, "notes.md").includes("子工作流约定"), childFlowDir);
    }
    await settle();
  }

  console.log("J) 符号链接资产：发现面与加载面同一条口径");
  {
    const listed = facade.listAll().text;
    for (const name of ["linked-flow", "linked-single", "linked-graph"]) {
      check(`list 发现软链资产 ${name}`, listed.includes(`\`${name}\``), listed.slice(0, 600));
    }
    const skillAssets = discoverSkillAssets(ws);
    check("动态技能发现同样列出软链的 Flow 与 Graph",
      ["linked-flow", "linked-single", "linked-graph"].every((name) => skillAssets.some((asset) => asset.name === name)),
      JSON.stringify(skillAssets.map((asset) => `${asset.kind}:${asset.name}`)));
    for (const target of [
      path.join(workflowsDir, "linked-flow"),
      path.join(workflowsDir, "linked-single.yaml"),
      path.join(graphsDir, "linked-graph"),
    ]) {
      const result = facade.diagnose(target);
      check(`doctor 按软链路径诊断 ${path.basename(target)}`, result.ok === true, result.text.slice(0, 400));
    }

    const started = await facade.start("linked-flow", "写一行", sid);
    check("软链目录形态的 Flow 可启动", started.ok === true, started.text.slice(0, 300));
    check("软链目录形态的参考根是链接所在目录", injectedRoot(String(started.text)) === path.join(workflowsDir, "linked-flow"),
      injectedRoot(String(started.text)));
    await facade.submitFromAny(host.main, "写好了");
    await waitFor(() => verifyRequests.some((item) => item.workflow?.name === "linked-flow"));
    await settle();

    const before = host.nodeMessages.length;
    const graphStarted = await facade.start("linked-graph", "写一行", sid);
    check("软链目录形态的 Graph 可启动", graphStarted.ok === true, graphStarted.text.slice(0, 300));
    await waitFor(() => host.nodeMessages.length > before);
    check("软链 Graph 的参考根是链接所在目录", injectedRoot(host.nodeMessages[before] ?? "") === path.join(graphsDir, "linked-graph"),
      injectedRoot(host.nodeMessages[before] ?? ""));
    await settle();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
