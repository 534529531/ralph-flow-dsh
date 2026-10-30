#!/usr/bin/env node
/** Graph 资产契约：Flow 风格 steps、Git 默认、无运行输入/共享资料/并发字段。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFacade } from "../lib/facade.js";
import { loadGraphWorkflow } from "../lib/graph/assets.js";
import { validateGraphAsset } from "../lib/graph/asset.js";
import { deliveryPorts } from "./helpers/ports.mjs";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-home-"));
process.env.HOME = home;
process.env.DSH_HOME = path.join(home, ".dsh");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-assets-"));
const rf = path.join(ws, ".dsh", "ralph-flow");
const wfDir = path.join(rf, "workflows");
const gDir = path.join(rf, "graphs");
fs.mkdirSync(wfDir, { recursive: true });
fs.mkdirSync(gDir, { recursive: true });

const ports = { ...deliveryPorts(() => {}), verify: async () => ({ status: "infra", reason: "not used", step_id: "x", check_index: 0, ts: new Date().toISOString() }), log: () => {} };
const ctx = {
  tools: { register() {}, get() {}, schemas() { return []; }, view() { return { visible: new Map() }; } },
  agents: { get() { return undefined; } },
  sessions: { get() { return undefined; } },
};
const facade = createFacade(ws, { ctx, ports });
facade.ensureLayout();

const writeGraph = (name, text) => fs.writeFileSync(path.join(gDir, `${name}.yaml`), text);
const writeFlow = (name, text) => fs.writeFileSync(path.join(wfDir, `${name}.yaml`), text);
const load = (name) => loadGraphWorkflow(ws, name);
const valid = (id = "a", extra = "") => `kind: graph
steps:
  - id: ${id}
    desc: 步骤 ${id}
    do: 做 ${id}
    output: ${id}.md
${extra}`;

console.log("G1 内置 Graph 资产");
{
  const codewiki = load("codewiki");
  check("codewiki 从内置 graphs/ 通过", !!codewiki.def && codewiki.problems.length === 0, JSON.stringify(codewiki.problems));
  check("codewiki 有 5 个步骤且 kind=graph", codewiki.def?.nodes.length === 5 && codewiki.def?.kind === "graph", JSON.stringify(codewiki.def?.nodes.map((n) => n.id)));
  check("内置 Graph 不再声明运行输入/共享资料", !("runInputs" in (codewiki.def ?? {})) && !("sharedResources" in (codewiki.def ?? {})));
  const listed = facade.listAssets();
  check("统一清单同时有 Flow 与 Graph", listed.some((a) => a.kind === "flow" && a.name === "loop") && listed.some((a) => a.kind === "graph" && a.name === "codewiki"), JSON.stringify(listed.map((a) => `${a.kind}:${a.name}`)));
  check("Graph 清单带步骤数", listed.find((a) => a.name === "codewiki")?.count === 5, JSON.stringify(listed.find((a) => a.name === "codewiki")));
}

console.log("G2 kind / 结构 / 目录");
{
  writeGraph("no-kind", "nodes:\n  - id: a\n    do: d\n");
  check("无 kind 的 nodes 资产被拒", load("no-kind").def === null && /kind: graph/.test(load("no-kind").problems.join("\n")), load("no-kind").problems.join(" | "));

  writeGraph("old-nodes", "kind: graph\nid: x\nname: X\nnodes:\n  - id: a\n    do: d\n");
  check("旧 nodes 格式被拒", load("old-nodes").def === null && /只使用 `steps`/.test(load("old-nodes").problems.join("\n")), load("old-nodes").problems.join(" | "));

  writeGraph("graph-steps", valid("a"));
  const flowStyle = load("graph-steps");
  check("Flow 风格 steps 正常加载", !!flowStyle.def && flowStyle.def.nodes.length === 1 && flowStyle.def.nodes[0].artifact === "a.md", flowStyle.problems.join(" | "));

  writeGraph("deps", "kind: graph\nsteps:\n  - id: a\n    desc: A\n    do: d\n    output: a.txt\n  - id: b\n    desc: B\n    do: d\n    depends_on: [a]\n    output: b.txt\n");
  const deps = load("deps").def;
  check("depends_on 自动派生上游产物引用", deps?.nodes[1].dependsOn[0] === "a" && deps.nodes[1].inputs[0]?.artifact === "a.txt", JSON.stringify(deps?.nodes[1].inputs));

  writeFlow("graph-in-workflows", "kind: graph\nsteps:\n  - id: a\n    desc: a\n    do: d\n");
  const flowEntry = facade.listWorkflows().find((w) => w.name === "graph-in-workflows");
  check("Graph YAML 放 workflows/ 被 Flow 校验器拒绝", !!flowEntry?.invalid, JSON.stringify(flowEntry));

  writeGraph("flow-in-graphs", "kind: flow\nsteps:\n  - id: a\n    desc: a\n    input: in\n    output: out\n    on_pass: done\n    on_fail: a\n    max_fail_count: 1\n    do: D\n    check: C\n");
  const graphEntry = facade.graph.listWorkflows().find((w) => w.name === "flow-in-graphs");
  check("Flow YAML 放 graphs/ 被 Graph 校验器拒绝", !!graphEntry?.invalid && /Flow/.test(graphEntry.problems.join("\n")), JSON.stringify(graphEntry));
}

console.log("G3 跨类别同名");
{
  writeFlow("same-name", "description: flow same\nsteps:\n  - id: a\n    desc: a\n    input: in\n    output: out\n    on_pass: done\n    on_fail: a\n    max_fail_count: 1\n    do: D\n    check: C\n");
  writeGraph("same-name", valid());
  const entry = facade.listAssets().find((a) => a.name === "same-name" && a.kind === "flow");
  check("跨类别同名在统一清单里标为 conflict", !!entry?.conflict, JSON.stringify(entry));
  const doctor = facade.diagnose().text;
  check("doctor 报出跨类别同名", /跨类别同名/.test(doctor) && /same-name/.test(doctor), doctor.slice(0, 300));
  fs.rmSync(path.join(wfDir, "same-name.yaml"));
  fs.rmSync(path.join(gDir, "same-name.yaml"));
}

console.log("G4 字段与 CHECK");
{
  for (const [name, snippet] of [
    ["inputs", "inputs:\n  - id: v\n    name: V\n"],
    ["resources", "resources:\n  - id: r\n    path: x.md\n"],
    ["parallel", "parallel: 2\n"],
    ["workspace", "workspace: {kind: git}\n"],
    ["version", "version: 1\n"],
  ]) {
    writeGraph(`removed-${name}`, `kind: graph\n${snippet}steps:\n  - id: a\n    desc: A\n    do: d\n    output: a.md\n`);
    check(`顶层 ${name} 字段被拒`, load(`removed-${name}`).def === null && /不再支持|不支持/.test(load(`removed-${name}`).problems.join("\n")), load(`removed-${name}`).problems.join(" | "));
  }
  writeGraph("step-inputs", valid("a", "    inputs: [v]\n"));
  check("步骤 inputs 被拒", load("step-inputs").def === null && /不支持/.test(load("step-inputs").problems.join("\n")), load("step-inputs").problems.join(" | "));

  writeGraph("null-check", valid("a", "    check: null\n"));
  check("check: null 显式关闭", load("null-check").def?.nodes[0].check === null);
  writeGraph("str-check", valid("a", "    check: |\n      1. a.md 非空\n"));
  check("check 字符串被保留", load("str-check").def?.nodes[0].check?.criteria.includes("a.md 非空"));
  writeGraph("obj-check", valid("a", "    check: {mode: custom, criteria: x}\n"));
  check("CHECK 对象写法被拒", load("obj-check").def === null, load("obj-check").problems.join(" | "));
  writeGraph("default-check", valid("a", "    check: {mode: default}\n"));
  check("固定默认 CHECK 被拒", load("default-check").def === null, load("default-check").problems.join(" | "));

  writeGraph("bad-cycle", "kind: graph\nsteps:\n  - id: a\n    desc: A\n    do: d\n    depends_on: [b]\n  - id: b\n    desc: B\n    do: d\n    depends_on: [a]\n");
  check("依赖环被拒", load("bad-cycle").def === null && /环/.test(load("bad-cycle").problems.join("\n")), load("bad-cycle").problems.join(" | "));
  writeGraph("dup-output", "kind: graph\nsteps:\n  - id: a\n    desc: A\n    do: d\n    output: same.md\n  - id: b\n    desc: B\n    do: d\n    output: same.md\n");
  check("重复 output 被拒", load("dup-output").def === null && /重复/.test(load("dup-output").problems.join("\n")), load("dup-output").problems.join(" | "));
}

console.log("G5 manual_step / execution / 直接校验");
{
  writeGraph("manual", valid("a") + "manual_step: [a]\n");
  const def = load("manual").def;
  check("manual_step 标出人工门", def?.manual_step[0] === "a", JSON.stringify(def?.manual_step));
  check("main execution 合法", validateGraphAsset({ kind: "graph", id: "x", name: "X", steps: [{ id: "a", desc: "A", do: "d", execution: "main" }] }).errors.length === 0);
  check("未知步骤字段被拒", validateGraphAsset({ kind: "graph", id: "x", name: "X", steps: [{ id: "a", desc: "A", do: "d", model: "p/m" }] }).errors.some((error) => error.code === "UNSUPPORTED_STEP_FIELD"));
}

console.log("G6 Flow 回归");
{
  check("loop 仍可加载", !!facade.loadWorkflow("loop").def);
  check("spec 仍可加载", !!facade.loadWorkflow("spec").def);
  check("listAssets 中 loop/spec 是 Flow", facade.listAssets().filter((a) => a.name === "loop" || a.name === "spec").every((a) => a.kind === "flow"));
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
