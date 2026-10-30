/**
 * Graph 并行 DAG 的 Git 验收：**DO/CHECK 并行，快进串行**。
 *
 * 判据：
 *   1. 4 个无依赖节点同时执行（4 个独立 worktree + 4 个 agent，`maxActive = 4`）。
 *   2. 每个节点在自己的分支上提交，交卷前把集成分支合进来；节点文件互不相交时合入是快进。
 *   3. 接纳按顺序快进集成分支，每次 `previous_commit` 等于上一版的 `commit`。
 *   4. 4 个节点全部接纳、run 完成，集成分支里四个节点的文件都在。
 *
 * 也回归了另一个竞态：先交卷的节点没把后落的集成分支头合进来 —— 引擎退回节点重做，
 * 不是另起一个 agent 解冲突，也不会暂停整个 run。
 *
 * HOME / workspace / Git 全部隔离；测试绝不读写真实 ~/.dsh。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rf-fan-home-"));
process.env.HOME = home;
process.env.DSH_HOME = path.join(home, ".dsh");
delete process.env.RALPHFLOW_GRAPH_ARTIFACT;

const { createFacade } = await import("../lib/facade.js");
const { deliveryPorts } = await import("./helpers/ports.mjs");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rf-fan-ws-"));
const rf = path.join(workspace, ".dsh/ralph-flow");
fs.mkdirSync(path.join(rf, "graphs"), { recursive: true });
const sleep = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", env: gitEnv });

git("init", "-q");
fs.writeFileSync(path.join(workspace, "README.md"), "base\n");
git("add", "-A");
git("commit", "-qm", "base");

const NODES = ["a", "b", "c", "d"];
fs.writeFileSync(path.join(rf, "graphs", "fan.yaml"), `kind: graph
description: 四路无依赖
steps:
${NODES.map((id) => `  - id: ${id}
    desc: node ${id}
    do: do ${id}
    output: ${id}.md
    check: "1. ${id} exists"
`).join("")}`);

const mainSession = "session-main";
const agents = new Map();
const catalog = [];
const descriptors = [];
const main = {
  id: mainSession,
  session: {
    id: mainSession,
    header: { cwd: workspace },
    append(type, data) { if (type === "subagent/catalog") catalog.push(data); },
  },
  steer() {}, followup() {}, ctx: { get: () => undefined },
};
agents.set(mainSession, main);
const stats = { maxActive: 0, active: 0, started: [] };
let facade;

const ctx = {
  tools: { register() {}, get() { return undefined; }, schemas() { return []; }, view() { return { visible: new Map() }; } },
  sessions: { get(id) { return agents.get(id)?.session; } },
  agents: {
    get(id) { return agents.get(id); },
    async create(opts) {
      const tools = [];
      opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
      const agent = {
        id: opts.sessionId,
        session: {
          id: opts.sessionId,
          header: { cwd: opts.meta?.cwd },
          append(type, data) { if (type === "subagent/descriptor") descriptors.push({ id: opts.sessionId, ...data }); },
        },
        followup(message) {
          const text = message.content.map((block) => block.text ?? "").join("");
          const nodeId = text.match(/# Graph 节点执行 · ([\w-]+)/)?.[1] ?? "?";
          const branch = text.match(/集成分支 `([^`]+)`/)?.[1];
          stats.active += 1;
          stats.maxActive = Math.max(stats.maxActive, stats.active);
          if (!stats.started.includes(nodeId)) stats.started.push(nodeId);
          void (async () => {
            await sleep(30);
            const run = (...args) => execFileSync("git", ["-C", opts.meta.cwd, ...args], { encoding: "utf8", env: gitEnv });
            fs.writeFileSync(path.join(opts.meta.cwd, `${nodeId}.txt`), `${nodeId}\n`);
            run("add", "-A");
            run("commit", "-qm", `node ${nodeId}`, "--allow-empty");
            if (branch) { try { run("merge", "--no-edit", branch); } catch { /* 快进或已包含 */ } }
            const write = tools.find((tool) => tool.name === "ralphflow_artifact_write");
            await write.execute({ content: `# ${nodeId}` }, { agent, signal: new AbortController().signal });
            await facade.submitFromAny(agent);
            stats.active -= 1;
          })().catch(() => { stats.active -= 1; });
        },
        async whenIdle() { await sleep(80); },
      };
      agents.set(opts.sessionId, agent);
      return { agent, dispose: async () => {} };
    },
  },
};

facade = createFacade(workspace, {
  ctx,
  ports: {
    ...deliveryPorts(() => {}),
    verify: async (req) => ({ status: "passed", reason: "ok", evidence: [], check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString() }),
    log() {},
  },
});
facade.ensureLayout();

console.log("\nF1 四个无依赖节点：并发执行、串行合入");
{
  const started = await facade.start("fan", "fan task", mainSession);
  check("启动成功", started.ok, started.text);
  let entry;
  for (let i = 0; i < 150; i++) {
    entry = facade.graph.listStates().at(-1);
    if (entry && ["completed", "paused", "failed"].includes(entry.state.graph.status)) break;
    await sleep(100);
  }
  const graph = entry?.state.graph;
  const acceptances = graph?.acceptances ?? [];
  check("run 完成（没有因合入竞态暂停）", graph?.status === "completed", `${graph?.status} ${graph?.pause_reason ?? ""}`);
  check("四个节点全部接纳", acceptances.length === 4, `acceptances=${acceptances.length}`);
  check("四个节点并发执行（maxActive >= 4）", stats.maxActive >= 4, `maxActive=${stats.maxActive}`);
  check("四个节点都真的启动了", new Set(stats.started).size === 4, JSON.stringify(stats.started));
  check("没有 node_failed / integration_failed", !(entry?.state.history ?? []).some((h) => h.event === "node_failed" || h.event === "integration_failed"),
    JSON.stringify((entry?.state.history ?? []).filter((h) => String(h.event).includes("fail")).map((h) => h.event)));
  check("合入链严格串行：每次 previous_commit = 上一版 commit", (() => {
    if (acceptances.length !== 4) return false;
    const baseline = graph.integration?.baseline;
    let previous = baseline;
    for (const acceptance of acceptances) {
      if (acceptance.integration?.previous_commit !== previous) return false;
      previous = acceptance.integration?.commit;
    }
    return previous === graph.integration?.current_commit;
  })(), JSON.stringify(acceptances.map((a) => ({ p: a.integration?.previous_commit?.slice(0, 8), c: a.integration?.commit?.slice(0, 8) }))));
  const nodeCatalog = catalog.filter((item) => String(item.label).startsWith("Graph 节点 "));
  const catalogNodes = new Set(nodeCatalog.map((item) => item.label));
  check("节点 agent 登记进宿主 catalog（顶部子智能体监控可见）", catalogNodes.size === 4
    && nodeCatalog.every((item) => item.mode === "one-shot"), JSON.stringify([...catalogNodes]));
  check("所有子 agent 都是节点 attempt（没有额外的合入会话）", catalog.length > 0 && catalog.every((item) => String(item.label).startsWith("Graph 节点 ") && !String(item.label).includes("合入")), JSON.stringify(catalog.map((item) => item.label)));
  const descriptorNodes = new Set(descriptors.filter((item) => String(item.label).startsWith("Graph 节点 ")).map((item) => item.label));
  check("节点子会话自带 subagent descriptor（打开历史不再报 corrupt）", descriptorNodes.size === 4
    && descriptors.every((item) => item.version === 3 && item.mode === "one-shot" && item.provider === "ralphflow-graph"),
    JSON.stringify([...descriptorNodes]));
  const branch = `ralphflow/${entry.id}`;
  const files = git("ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean);
  check("最终集成分支树包含四个节点的文件", NODES.every((id) => files.includes(`${id}.txt`)), JSON.stringify(files));
  check("合入全是快进：每个节点分支都包含在集成分支里",
    NODES.every((id) => {
      try { git("merge-base", "--is-ancestor", `ralphflow-node/${entry.id}/${id}`, branch); return true; } catch { return false; }
    }),
    JSON.stringify(git("branch", "--list", "ralphflow*")));
  check("集成分支头等于最后一次接纳的 commit", git("rev-parse", branch).trim() === graph.integration?.current_commit,
    `${git("rev-parse", branch).trim()} vs ${graph.integration?.current_commit}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
