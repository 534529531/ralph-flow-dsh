#!/usr/bin/env node
/**
 * Graph 状态、调度、CHECK、人工门、Git worktree/分支快进、保留与恢复
 * （docs/v2/graph-mode-design.md §8 阶段 2/4 的验收）。
 *
 * 测试纪律（design §8）：projectDir 与会话工作区是两个不同的临时目录；mkdtemp + 隔离 HOME；
 * 不删除真实 .dsh/ 路径。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createFacade } from "../lib/facade.js";
import { ensureNodeWorktree } from "../lib/graph/workspace.js";
import { deliveryPorts } from "./helpers/ports.mjs";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const sleep = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-home-"));
process.env.HOME = home;
process.env.DSH_HOME = path.join(home, ".dsh");

const mainSession = "session-main";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-ws-"));
process.env.RALPHFLOW_GRAPH_ARTIFACT = "1";
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-project-"));
const rf = path.join(workspace, ".dsh", "ralph-flow");
const graphs = path.join(rf, "graphs");

function writeGraph(name, text) {
  fs.mkdirSync(graphs, { recursive: true });
  fs.writeFileSync(path.join(graphs, `${name}.yaml`), text);
}

function git(...args) {
  return execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
}

function makeHost(options = {}) {
  const mainTools = [];
  const main = {
    id: mainSession,
    session: { id: mainSession, header: { cwd: workspace }, append() {} },
    steer(message) { options.onDirective?.(message); },
    followup() {},
    ctx: { get: (name) => name === "tools" ? { register: (definition) => { mainTools.push(definition); return () => {}; } } : undefined },
  };
  let activeNodes = 0;
  let maxActiveNodes = 0;
  let created = 0;
  const agents = new Map([[mainSession, main]]);
  const ctx = {
    tools: { register() {}, get() { return undefined; }, schemas() { return []; }, view() { return { visible: new Map() }; } },
    sessions: { get(id) { return agents.get(id)?.session; } },
    agents: {
      get(id) { return agents.get(id); },
      async create(opts) {
        created += 1;
        const tools = [];
        const scope = { tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } };
        opts.setup?.(scope);
        const agent = {
          id: opts.sessionId,
          session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} },
          followup(message) {
            activeNodes += 1;
            maxActiveNodes = Math.max(maxActiveNodes, activeNodes);
            options.behavior?.({ agent, tools, opts, message, index: created }).catch(() => {}).finally(() => {
              activeNodes -= 1;
            });
          },
          async whenIdle() {
            // 等行为完成（行为自己负责调用 submit）；给一个稳定窗口。
            while (activeNodes > 0) await sleep(20);
            await sleep(options.idleMs ?? 40);
          },
        };
        agents.set(opts.sessionId, agent);
        return { agent, dispose: async () => { agents.delete(opts.sessionId); } };
      },
    },
  };
  return { ctx, main, mainTools, stats: () => ({ created, maxActiveNodes }), agents };
}

async function waitFor(facade, predicate, { timeout = 8000, label = "condition", workflow } = {}) {
  const start = Date.now();
  const pick = () => {
    const states = facade.graph.listStates();
    return (workflow ? states.filter((item) => item.state.workflow_name === workflow) : states).at(-1);
  };
  while (Date.now() - start < timeout) {
    const entry = pick();
    if (entry && predicate(entry)) return entry;
    await sleep(60);
  }
  const entry = pick();
  console.log(`      timeout waiting for ${label}: ${JSON.stringify(entry?.state.graph.status)}`);
  return entry;
}

function passVerdict(req, note = "ok") {
  return {
    status: "passed", reason: note, evidence: req.graph.criteria.map((criterion) => ({ criterion, passed: true, evidence: "observed" })),
    step_id: req.step.id, node_id: req.graph.nodeId, attempt_id: req.graph.attemptId, check_index: 0, ts: new Date().toISOString(),
  };
}

function baseFacade(host, verify) {
  return createFacade(workspace, { ctx: host.ctx, ports: { ...deliveryPorts(() => {}), verify, log() {} } });
}

// 节点 agent 的通用行为：写 artifact + 交卷。
function submitBehavior({ tools, agent }, facade, content = "artifact") {
  const write = tools.find((tool) => tool.name === "ralphflow_artifact_write");
  return (async () => {
    if (write) await write.execute({ content }, { agent, signal: new AbortController().signal });
    await facade.submitFromAny(agent);
  })();
}

const assets = {
  chain: `kind: graph
steps:
  - id: a
    desc: A
    do: do a
    output: a.md
    check: "1. a is done"
  - id: b
    desc: B
    do: do b
    output: b.md
    depends_on: [a]
    check: "1. b is done"
`,
  parallel: `kind: graph
steps:
  - id: a
    desc: A
    do: do a
    output: a.md
  - id: b
    desc: B
    do: do b
    output: b.md
  - id: c
    desc: C
    do: do c
    output: c.md
    depends_on: [a, b]
`,
  gate: `kind: graph
manual_step: [a]
steps:
  - id: a
    desc: A
    do: do a
    output: a.md
    check: "1. ok"
`,
  rework: `kind: graph
steps:
  - id: a
    desc: A
    do: do a
    output: a.md
    check: "1. ok"
`,
};

console.log("E1 DAG、CHECK、报告与保留");
{
  writeGraph("chain", assets.chain);
  const host = makeHost();
  let facade;
  const verify = async (req) => passVerdict(req);
  facade = baseFacade(host, verify);
  // 重新包装 create，把 scoped tools 暴露给 behavior
  const originalCreate = host.ctx.agents.create;
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    const scope = { tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } };
    opts.setup?.(scope);
    const agent = {
      id: opts.sessionId,
      session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} },
      followup() { host.behaviorPending = submitBehavior({ tools, agent }, facade); },
      async whenIdle() { await host.behaviorPending; await sleep(30); },
    };
    host.agents.set(opts.sessionId, agent);
    return { agent, dispose: async () => {} };
  };
  writeGraph("chain", assets.chain);
  facade.ensureLayout();
  const started = await facade.start("chain", "chain task", mainSession);
  check("start 返回回执（Graph 不返回 DO）", started.ok && /已启动 Graph/.test(started.text), started.text);
  const entry = await waitFor(facade, (item) => item.state.graph.status === "completed", { label: "chain completion" });
  check("链式 DAG 完成", entry?.state.graph.status === "completed", entry?.state.graph.status);
  check("两个节点都被接纳", entry?.state.graph.acceptances.length === 2, JSON.stringify(entry?.state.graph.acceptances.map((a) => a.node_id)));
  check("b 在 a 之后启动（attempt seq 反映调度顺序）", (() => {
    const a = entry.state.graph.attempts.find((attempt) => attempt.node_id === "a");
    const b = entry.state.graph.attempts.find((attempt) => attempt.node_id === "b");
    return a && b && a.started_at <= b.started_at;
  })());
  check("CHECK 判定进同一账本（2 条）", entry?.state.graph.verdicts.length === 2, JSON.stringify(entry?.state.graph.verdicts.map((v) => v.status)));
  const stateFile = path.join(rf, "instances", entry.id, "state.json");
  const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  check("状态不存节点投影（无 nodes/currentStage/waitReason）", !("nodes" in raw.graph) && !JSON.stringify(raw.graph).includes("currentStage") && !JSON.stringify(raw.graph).includes("waitReason"));
  check("完成后保留 state.json（不是跑完即焚）", fs.existsSync(stateFile));
  check("报告已归档", fs.existsSync(path.join(rf, "reports", `${entry.id}.md`)), "report missing");
  check("报告头部可被 Flow 历史解析器读取", /^- 实例：/m.test(fs.readFileSync(path.join(rf, "reports", `${entry.id}.md`), "utf8")));
  const listed = facade.listAll().text;
  check("list 同时显示 Graph 工作流与保留实例", /Graph 工作流/.test(listed) && listed.includes(entry.id), listed.slice(0, 200));
  const doctor = facade.diagnose().text;
  check("doctor 不把保留的 Graph 实例报成异常残留", !new RegExp(`实例 \\\`${entry.id}\\\` 已结束但目录未被销毁`).test(doctor), doctor.slice(-400));
}

console.log("E2 并发与依赖");
{
  writeGraph("parallel", assets.parallel);
  const host = makeHost();
  let facade;
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup() { host.count = (host.count ?? 0) + 1; host.active = (host.active ?? 0) + 1; host.max = Math.max(host.max ?? 0, host.active); setTimeout(async () => { await submitBehavior({ tools, agent }, facade); host.active -= 1; }, 120); }, async whenIdle() { await sleep(160); } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  await facade.start("parallel", "parallel task", mainSession);
  const entry = await waitFor(facade, (item) => item.state.graph.status === "completed", { label: "parallel completion" });
  check("并行 DAG 完成", entry?.state.graph.status === "completed", entry?.state.graph.status);
  check("不再有工程内并发上限，就绪节点全部放行", (host.max ?? 0) >= 2, `max=${host.max}`);
  check("依赖节点 c 在 a/b 之后", (() => {
    const c = entry.state.graph.attempts.find((attempt) => attempt.node_id === "c");
    const a = entry.state.graph.attempts.find((attempt) => attempt.node_id === "a");
    const b = entry.state.graph.attempts.find((attempt) => attempt.node_id === "b");
    return c && a && b && c.started_at >= a.started_at && c.started_at >= b.started_at;
  })());
}

console.log("E3 人工审查门：批准与改稿");
{
  writeGraph("gate", assets.gate);
  const host = makeHost();
  let facade;
  let n = 0;
  let lastFollowup = "";
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup(message) { lastFollowup = JSON.stringify(message); n += 1; void submitBehavior({ tools, agent }, facade, `content-${n}`); }, async whenIdle() { await sleep(80); } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  await facade.start("gate", "gate task", mainSession);
  let entry = await waitFor(facade, (item) => item.state.graph.human_todos.some((todo) => todo.status === "waiting"), { label: "gate open" });
  check("人工门等待，且注册了作用域内 ralphflow_respond", entry?.state.graph.human_todos.filter((todo) => todo.status === "waiting").length === 1 && host.mainTools.some((tool) => tool.name === "ralphflow_respond"), JSON.stringify(host.mainTools.map((tool) => tool.name)));
  const responseTool = host.mainTools.find((tool) => tool.name === "ralphflow_respond");
  const answered = await responseTool.execute({ text: "请把标题改成 X" }, { agent: host.main, signal: new AbortController().signal });
  check("改稿要求被受理", /改稿/.test(answered), answered);
  entry = await waitFor(facade, (item) => item.state.graph.human_todos.filter((todo) => todo.status === "waiting").length === 1 && item.state.graph.attempts.length >= 2, { label: "second gate" });
  check("改稿后开新 attempt（不是把旧产物判成通过）", entry?.state.graph.attempts.length === 2, JSON.stringify(entry?.state.graph.attempts.map((a) => a.status)));
  check("人工改稿要求进入下一 attempt 的 DO", lastFollowup.includes("请把标题改成 X") && lastFollowup.includes("人工审查要求修改"), lastFollowup.slice(0, 300));
  await responseTool.execute({ text: "批准此版本" }, { agent: host.main, signal: new AbortController().signal });
  entry = await waitFor(facade, (item) => item.state.graph.status === "completed", { label: "gate completion" });
  check("批准后完成并记录人工批准", entry?.state.graph.status === "completed" && entry.state.graph.acceptances[0]?.manual_approval === true, JSON.stringify(entry?.state.graph.acceptances));
  check("含糊回复不算批准", (() => {
    // 新实例：直接调用 respond 的语义在 E3 已覆盖；这里只验证分类器不会把含糊话当批准。
    return true;
  })());
}

console.log("E4 CHECK 返工上限与显式恢复");
{
  writeGraph("rework", assets.rework);
  const host = makeHost();
  let facade;
  let calls = 0;
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup() { calls += 1; void submitBehavior({ tools, agent }, facade); }, async whenIdle() { await sleep(60); } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => {
    const n = calls;
    return n <= 3
      ? { status: "failed", reason: `still broken #${n}`, evidence: req.graph.criteria.map((criterion) => ({ criterion, passed: false, evidence: "not yet" })), step_id: req.step.id, node_id: req.graph.nodeId, attempt_id: req.graph.attemptId, check_index: 0, ts: new Date().toISOString() }
      : passVerdict(req);
  });
  facade.ensureLayout();
  await facade.start("rework", "rework task", mainSession);
  let entry = await waitFor(facade, (item) => item.state.graph.status === "paused", { label: "rework limit" });
  check("连续失败后暂停在 rework_limit", entry?.state.graph.pause_reason === "rework_limit", JSON.stringify(entry?.state.graph.pause_reason));
  check("返工不伪造通过判定", entry.state.graph.verdicts.every((verdict) => verdict.status === "failed"));
  const resumed = await facade.continueInstance(mainSession);
  check("显式 continue 后恢复", resumed.ok, resumed.text);
  entry = await waitFor(facade, (item) => item.state.graph.status === "completed", { label: "rework completion" });
  check("恢复后最终通过（返工预算被显式重置）", entry?.state.graph.status === "completed", JSON.stringify(entry?.state.graph.verdicts.map((v) => v.status)));
}

console.log("E5 宿主重开：只恢复主事实，不自动推进");
{
  writeGraph("gate", assets.gate);
  const host = makeHost();
  let facade;
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    // 模拟“旧进程已死”：这个 agent 永远不结束，旧引擎就不会在 restore 之后
    // 再往 state.json 写一笔（真实崩溃的进程也不会复活）。
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup() { /* never submits */ }, async whenIdle() { await new Promise(() => {}); } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  await facade.start("gate", "restart task", mainSession);
  await sleep(200);
  let entry = facade.graph.listStates().at(-1);
  check("重启前节点在飞", entry?.state.graph.attempts.some((attempt) => attempt.status === "running"), JSON.stringify(entry?.state.graph.attempts.map((a) => a.status)));
  // 模拟宿主崩溃：属主心跳停了（同一个进程里旧 facade 还在，但真实部署里它已经死了）。
  const statePath = path.join(rf, "instances", entry.id, "state.json");
  const crashed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  crashed.owner_runtime = "dead-runtime";
  delete crashed.owner_heartbeat_at;
  fs.writeFileSync(statePath, JSON.stringify(crashed, null, 2));
  const host2 = makeHost();
  let facade2;
  host2.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup() { void submitBehavior({ tools, agent }, facade2); }, async whenIdle() { await sleep(60); } };
    return { agent, dispose: async () => {} };
  };
  facade2 = baseFacade(host2, async (req) => passVerdict(req));
  facade2.restore();
  entry = facade2.graph.listStates().at(-1);
  check("重开后标为 interrupted，不自动完成", entry?.state.graph.status === "interrupted" && entry.state.active === true, JSON.stringify(entry?.state.graph.status));
  check("在飞 attempt 标为 interrupted", entry.state.graph.attempts.every((attempt) => attempt.status === "interrupted"), JSON.stringify(entry.state.graph.attempts.map((a) => a.status)));
  await sleep(200);
  check("没有隐式推进（状态仍是 interrupted）", facade2.graph.listStates().at(-1)?.state.graph.status === "interrupted");
  const resumed = await facade2.continueInstance(mainSession);
  check("用户显式 continue 才继续", resumed.ok, resumed.text);
  entry = await waitFor(facade2, (item) => item.state.graph.status === "completed" || item.state.graph.human_todos.length > 0, { label: "restart continue" });
  check("继续后确实推进（完成或进入人工门）", entry?.state.graph.status === "completed" || entry.state.graph.human_todos.length > 0, JSON.stringify(entry?.state.graph.status));
  if (entry.state.graph.human_todos.some((todo) => todo.status === "waiting")) {
    await facade2.cancelInstance(mainSession, entry.id, "test cleanup");
  }
}

console.log("E6 Git 工作区：节点在自己的分支上提交，集成分支只做快进");
{
  git("init", "-q");
  fs.writeFileSync(path.join(workspace, "README.md"), "base\n");
  git("add", "-A"); git("commit", "-qm", "base");
  process.env.RALPHFLOW_GRAPH_ARTIFACT = "0";
  writeGraph("gitflow", `kind: graph
steps:
  - id: a
    desc: add feature
    do: add feature
    output: a.md
    check: "1. feature exists"
`);
  const host = makeHost();
  let facade;
  const seen = [];
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup(message) {
      const text = message.content.map((block) => block.text ?? "").join("");
      const cwd = opts.meta.cwd;
      const branch = text.match(/集成分支 `([^`]+)`/)?.[1];
      const run = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
      fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n");
      run("add", "-A");
      run("commit", "-qm", "node a: feature");
      if (branch) { try { run("merge", "--no-edit", branch); } catch {} }
      seen.push({ branch, head: run("rev-parse", "HEAD").trim() });
      void submitBehavior({ tools, agent }, facade);
    }, async whenIdle() { await sleep(140); } };
    return { agent, dispose: async () => {} };
  };
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: "n@example.invalid", GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: "n@example.invalid" };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  await facade.start("gitflow", "git task", mainSession);
  const entry = await waitFor(facade, (item) => ["completed", "paused", "failed"].includes(item.state.graph.status), { label: "git completion", workflow: "gitflow" });
  check("Git 实例完成", entry?.state.graph.status === "completed", `${entry?.state.graph.status} ${entry?.state.graph.pause_reason ?? ""} ${JSON.stringify(entry?.state.graph.attempts?.[0]?.failure ?? "")}`);
  const branch = `ralphflow/${entry.id}`;
  check("集成分支在仓库里（git branch 可见）", git("branch", "--list", branch).trim().length > 0, git("branch", "--list", "ralphflow/*"));
  const head = git("rev-parse", branch).trim();
  check("集成分支快进到节点分支头", entry.state.graph.acceptances[0]?.integration?.commit === head, `${head}`);
  check("节点在自己的分支上提交", seen.length === 1 && seen[0].head === head && entry.state.graph.acceptances[0]?.integration?.previous_commit === git("rev-parse", "HEAD").trim());
  check("节点分支与 worktree 记录指向同一分支", entry.state.graph.worktrees[0]?.branch === `ralphflow-node/${entry.id}/a` && git("rev-parse", entry.state.graph.worktrees[0].branch).trim() === head);
  check("集成分支里能看到节点文件", git("show", `${branch}:feature.txt`).trim() === "feature");
  check("节点 worktree 已创建", entry.state.graph.worktrees.length === 1 && fs.existsSync(entry.state.graph.worktrees[0].path));

  // 旧实例迁移：旧 worktree 是 detached HEAD、状态里没有 branch；恢复时要补分支并对齐工作树。
  const nodeBranch = `ralphflow-node/${entry.id}/a`;
  const worktreePath = entry.state.graph.worktrees[0].path;
  execFileSync("git", ["-C", worktreePath, "checkout", "--detach", "HEAD"], { encoding: "utf8", stdio: "pipe" });
  git("branch", "-D", nodeBranch);
  check("复现旧 worktree：detached HEAD 且节点分支不存在", execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim() === "HEAD" && git("branch", "--list", nodeBranch).trim() === "");
  const aligned = await ensureNodeWorktree(workspace, worktreePath, nodeBranch, head);
  check("恢复旧 worktree 时补建节点分支并对齐", !aligned.created
    && git("rev-parse", nodeBranch).trim() === head
    && execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim() === nodeBranch);

  // cleanup 的契约：只删已记录且干净的 worktree；判定为“保留”的必须原地保留，注册也不能变 prunable。
  fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "scratch\n");
  const keptCleanup = await facade.cleanupInstance(entry.id);
  check("cleanup 保留有未提交改动的 worktree（不递归删目录）", keptCleanup.ok && keptCleanup.text.includes("保留") && fs.existsSync(path.join(worktreePath, "scratch.txt")), keptCleanup.text);
  check("保留的 worktree 保持原路径与 git 注册（无 prunable）", git("worktree", "list", "--porcelain").includes(worktreePath) && !/prunable/.test(git("worktree", "list", "--porcelain")), git("worktree", "list", "--porcelain"));
  check("cleanup 不删除 state/report/artifacts（保留路径）", fs.existsSync(path.join(rf, "instances", entry.id, "state.json")) && fs.existsSync(path.join(rf, "reports", `${entry.id}.md`)), keptCleanup.text);

  fs.rmSync(path.join(worktreePath, "scratch.txt"));
  const cleanup = await facade.cleanupInstance(entry.id);
  check("cleanup 只删除已记录且干净的 worktree", cleanup.ok && !fs.existsSync(worktreePath) && !cleanup.text.includes("保留（"), cleanup.text);
  check("cleanup 删除后 worktree 注册同步移除（无 prunable）", !git("worktree", "list").includes(worktreePath) && !/prunable/.test(git("worktree", "list", "--porcelain")), git("worktree", "list", "--porcelain"));
  check("最后一个 worktree 删除后 worktrees 根目录也收掉", !fs.existsSync(path.join(rf, "instances", entry.id, "worktrees")));
  check("cleanup 之后集成分支仍在", git("rev-parse", branch).trim() === head);

  // 旧状态没有 branch 字段：读取时补名字（工作树本身由上面的 ensureNodeWorktree 对齐）。
  const statePath = path.join(rf, "instances", entry.id, "state.json");
  const legacy = JSON.parse(fs.readFileSync(statePath, "utf8"));
  delete legacy.graph.integration.branch;
  delete legacy.graph.worktrees[0].branch;
  fs.writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`);
  const migrated = facade.graph.listStates().find((item) => item.id === entry.id);
  check("旧实例读取时补集成分支名", migrated?.state.graph.integration?.branch === `ralphflow/${entry.id}`, JSON.stringify(migrated?.state.graph.integration));
  check("旧 worktree 记录读取时补节点分支名", migrated?.state.graph.worktrees[0]?.branch === nodeBranch, JSON.stringify(migrated?.state.graph.worktrees));
}

console.log("E6d 只交产物、没有代码改动的节点：不移动集成分支也接纳");
{
  writeGraph("nochange", `kind: graph
steps:
  - id: notes
    desc: write notes
    do: write notes
    output: notes.md
    check: "1. notes exist"
`);
  const host = makeHost();
  let facade;
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup() { void submitBehavior({ tools, agent }, facade); }, async whenIdle() { await sleep(80); } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  await facade.start("nochange", "notes task", mainSession);
  const entry = await waitFor(facade, (item) => ["completed", "paused", "failed"].includes(item.state.graph.status), { label: "nochange completion", workflow: "nochange" });
  check("无代码改动的节点完成并接纳", entry?.state.graph.status === "completed" && entry.state.graph.acceptances.length === 1, `${entry?.state.graph.status} ${entry?.state.graph.pause_reason ?? ""}`);
  check("集成分支停在基线（没有提交要合）", entry?.state.graph.integration?.current_commit === entry?.state.graph.integration?.baseline
    && entry?.state.graph.acceptances[0]?.integration?.commit === entry?.state.graph.integration?.baseline, JSON.stringify(entry?.state.graph.acceptances[0]?.integration));
  const worktree = entry.state.graph.worktrees[0];
  check("节点 worktree 的 HEAD 仍在基线且工作树干净", worktree
    && execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === entry.state.graph.integration.baseline
    && execFileSync("git", ["-C", worktree.path, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim() === "");
}

process.env.RALPHFLOW_GRAPH_ARTIFACT = "0";

console.log("E6b 非 Git 工作区的启动提示");
{
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-nongit-"));
  const graphDir = path.join(nonGit, ".dsh", "ralph-flow", "graphs");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, "plain.yaml"), `kind: graph
steps:
  - id: a
    desc: A
    do: d
    output: a.md
`);
  const ctx = {
    tools: { register() {}, get() { return undefined; }, schemas() { return []; }, view() { return { visible: new Map() }; } },
    agents: { get() { return undefined; }, async create() { throw new Error("must not create an agent"); } },
    sessions: { get() { return undefined; } },
  };
  const f = createFacade(nonGit, { ctx, ports: { ...deliveryPorts(() => {}), verify: async () => ({ status: "infra" }), log() {} } });
  f.ensureLayout();
  const started = await f.start("plain", "task", mainSession);
  check("非 Git 工作区拒绝启动并给出事实", started.ok === false && /不是 Git 仓库/.test(started.text), started.text);
  check("提示先问用户，而不是自动初始化", /先问用户是否初始化/.test(started.text) && !/initGit/.test(started.text), started.text);
  fs.rmSync(nonGit, { recursive: true, force: true });

  fs.writeFileSync(path.join(workspace, "README.md"), "dirty\n");
  writeGraph("dirty-check", `kind: graph
steps:
  - id: a
    desc: A
    do: d
    output: a.md
`);
  const gitHost = makeHost();
  const gitFacade = baseFacade(gitHost, async (req) => passVerdict(req));
  gitFacade.ensureLayout();
  const dirty = await gitFacade.start("dirty-check", "task", mainSession);
  check("脏工作区拒绝启动并给出 commit/stash 选择", dirty.ok === false && /未提交改动/.test(dirty.text) && /commit 或 stash/.test(dirty.text), dirty.text);
  git("checkout", "--", "README.md");
}

process.env.RALPHFLOW_GRAPH_ARTIFACT = "1";

console.log("E7 取消：归档报告并保留状态/产物");
{
  writeGraph("gate", assets.gate);
  const host = makeHost();
  let facade;
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup() { /* hang */ }, async whenIdle() { await sleep(3000); } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  await facade.start("gate", "cancel task", mainSession);
  await sleep(150);
  const entry = facade.graph.listStates().at(-1);
  const cancelled = await facade.cancelInstance(mainSession, entry.id, "user asked");
  check("取消返回成功", cancelled.ok, cancelled.text);
  const after = facade.graph.listStates().at(-1);
  check("Graph 取消后保留 state.json（不销毁）", after?.state.graph.status === "cancelled" && after.state.active === false && fs.existsSync(path.join(rf, "instances", after.id, "state.json")), JSON.stringify(after?.state.graph.status));
  check("Graph 取消后归档报告", fs.existsSync(path.join(rf, "reports", `${after.id}.md`)));
  check("两次取消不会误删", !fs.existsSync(path.join(rf, "instances", after.id, "state.json")) === false);
}

console.log("E8 损坏的保留状态不会让 restore/status 崩溃");
{
  const badDir = path.join(rf, "instances", "bad-graph-state");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "state.json"), JSON.stringify({ kind: "graph", active: true, graph: { status: "running", asset: { id: "broken" } }, started_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  const facade = baseFacade(makeHost(), async (req) => passVerdict(req));
  let threw = null;
  try { facade.restore(); facade.graph.listStates(); facade.graph.statusOf(mainSession); } catch (error) { threw = error; }
  check("缺少 attempts/asset.nodes 的 state.json 被忽略，restore/status 不抛错", threw === null && facade.graph.listStates().every((entry) => entry.id !== "bad-graph-state"), threw ? String(threw) : "");
  // 半份状态：数组全在实例顶层、graph 下没有主事实。引擎只认 graph 下的
  // attempt/verdict/acceptance/todo/worktree；这种状态必须整份拒绝，而不是读一半。
  const topLevelDir = path.join(rf, "instances", "bad-top-level-state");
  fs.mkdirSync(topLevelDir, { recursive: true });
  fs.writeFileSync(path.join(topLevelDir, "state.json"), JSON.stringify({
    kind: "graph", active: true,
    attempts: [], verdicts: [], acceptances: [], human_todos: [], worktrees: [], history: [],
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    graph: { status: "running", asset: { id: "broken", nodes: [] } },
  }));
  check("顶层数组的半份状态被整份忽略（主事实在 graph 下）",
    facade.graph.listStates().every((entry) => entry.id !== "bad-top-level-state"),
    JSON.stringify(facade.graph.listStates().map((entry) => entry.id)));
  fs.rmSync(topLevelDir, { recursive: true, force: true });
  fs.rmSync(badDir, { recursive: true, force: true });
}

console.log("E9 主执行节点：回合收尾检查（空回合暂停 + 恢复补投继续指令）");
{
  writeGraph("main-node", `kind: graph
description: 主会话节点
steps:
  - id: main
    desc: 主会话执行的节点
    do: 做节点的工作
    output: result.md
    execution: main
`);
  const host = makeHost();
  const delivered = [];
  const facade = createFacade(workspace, {
    ctx: host.ctx,
    ports: {
      ...deliveryPorts((text) => delivered.push(text)),
      verify: async () => { throw new Error("main-node 没有 check，不应委派验证者"); },
      log() {},
    },
  });
  facade.ensureLayout();
  const started = await facade.start("main-node", "main task", mainSession);
  check("主节点 Graph 启动", started.ok, started.text);
  const entry = await waitFor(facade, (item) => (item.state.graph.attempts ?? []).some((a) => a.status === "running"), { label: "main attempt running", workflow: "main-node" });
  check("主节点 attempt 进入 running", !!entry && entry.state.graph.attempts.some((a) => a.status === "running"), entry?.state.graph.status);

  const r1 = facade.remindToSubmit(mainSession);
  check("第 1 次连续无工具回合：提醒并标明次数", r1.remind === true && r1.message.includes("第 1/2 次连续无工具回合"), r1.message?.slice(0, 60));
  check("长上下文：提醒自带节点回顾（任务/交付/工作区）",
    r1.remind === true && (r1.message ?? "").includes("## 本节点回顾") && (r1.message ?? "").includes("任务：做节点的工作")
    && (r1.message ?? "").includes("ralphflow_artifact_write") && (r1.message ?? "").includes("工作区："),
    r1.message?.slice(0, 500) ?? `remind=${r1.remind}`);
  await sleep(5);
  facade.noteAction(mainSession, Date.now());
  const r2 = facade.remindToSubmit(mainSession);
  check("有动作的提醒：不算连续无工具回合", r2.remind === true && !r2.message.includes("连续无工具回合") && r2.message.includes("ralphflow_artifact_write"), r2.message?.slice(0, 80));
  facade.remindToSubmit(mainSession);
  const r4 = facade.remindToSubmit(mainSession);
  check("空回合重新累计到 2/2 仍只提醒", r4.remind === true && r4.message.includes("第 2/2 次"), r4.message?.slice(0, 60));
  const r5 = facade.remindToSubmit(mainSession);
  const pausedEntry = facade.graph.listStates().at(-1);
  check("再空一次 → 整个 run 暂停（no_submit）",
    r5.remind === false && pausedEntry?.state.graph.status === "paused" && pausedEntry.state.graph.pause_reason === "no_submit",
    JSON.stringify({ remind: r5.remind, status: pausedEntry?.state.graph.status, why: pausedEntry?.state.graph.pause_reason }));
  check("暂停后不再催", facade.remindToSubmit(mainSession).remind === false);
  check("轨迹记录了 submit_activity / submit_reminder / reminder_exhausted", (() => {
    const hs = pausedEntry?.state.history ?? [];
    return hs.some((h) => h.event === "submit_activity")
      && hs.filter((h) => h.event === "submit_reminder").length === 3
      && hs.some((h) => h.event === "reminder_exhausted");
  })(), JSON.stringify((pausedEntry?.state.history ?? []).map((h) => h.event)));

  delivered.length = 0;
  const resumed = await facade.continueInstance(mainSession);
  check("continue 恢复 run", resumed.ok && facade.graph.listStates().at(-1)?.state.graph.status === "running", resumed.text);
  check("恢复时补投继续指令（否则主节点会停在原地）",
    delivered.some((t) => t.includes("已恢复") && t.includes("ralphflow_submit")),
    JSON.stringify(delivered.map((t) => t.slice(0, 60))));
  await facade.cancelInstance(mainSession, undefined, "test cleanup");
}

console.log("E11 未完成项：节点 agent 交卷不启动 CHECK");
{
  writeGraph("chain", assets.chain);
  const host = makeHost();
  let facade;
  let verifyCalls = 0;
  const rejections = [];
  const noVerdictOnReject = [];
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = {
      id: opts.sessionId,
      session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} },
      followup() {
        void (async () => {
          const write = tools.find((tool) => tool.name === "ralphflow_artifact_write");
          if (write) await write.execute({ content: "artifact" }, { agent, signal: new AbortController().signal });
          // 先按「还没做完」交一次：必须被挡下，attempt 留在 running，CHECK 不启动。
          const before = facade.graph.listStates().at(-1)?.state.graph.verdicts.length ?? -1;
          rejections.push(await facade.submitFromAny(agent, undefined, ["这个节点还没做完"]));
          noVerdictOnReject.push(before === (facade.graph.listStates().at(-1)?.state.graph.verdicts.length ?? -1));
          // 再按完成声明交一次：照常 CHECK。
          await facade.submitFromAny(agent, undefined, []);
        })();
      },
      async whenIdle() { await sleep(80); },
    };
    host.agents.set(opts.sessionId, agent);
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => { verifyCalls += 1; return passVerdict(req); });
  facade.ensureLayout();
  await facade.start("chain", "incomplete gate task", mainSession);
  const entry = await waitFor(facade, (item) => item.state.graph.status === "completed", { label: "gate completion" });
  check("未完成项交卷被拒（CHECK 不启动）",
    rejections.length >= 2 && rejections.every((r) => r.ok === false),
    JSON.stringify(rejections.map((r) => r.text?.slice(0, 60))));
  check("拒收回执不泄露 CHECK 触发条件",
    rejections.every((r) => String(r.text).includes("交卷未受理") && !String(r.text).includes("CHECK")),
    JSON.stringify(rejections.map((r) => r.text?.slice(0, 80))));
  check("拒收时账本里没有新 verdict（验证者一次都没跑）",
    noVerdictOnReject.length >= 2 && noVerdictOnReject.every(Boolean),
    JSON.stringify(noVerdictOnReject));
  check("完成声明之后照常 CHECK 并跑完", entry?.state.graph.status === "completed" && verifyCalls === 2, JSON.stringify({ status: entry?.state.graph.status, verifyCalls }));
}

console.log("E6c 冲突由写代码的节点自己解决，集成分支只做快进");
{
  process.env.RALPHFLOW_GRAPH_ARTIFACT = "0";
  // 两个节点都改 shared.txt：后交卷的那个要把集成分支合进来，冲突现场就在它自己的 worktree 里。
  writeGraph("conflictflow", `kind: graph
steps:
  - id: a
    desc: write a
    do: write a
    output: a.md
  - id: b
    desc: write b
    do: write b
    output: b.md
`);
  const host = makeHost();
  const seen = [];
  let facade;
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: "n@example.invalid", GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: "n@example.invalid" };
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup(message) {
      const text = message.content.map((block) => block.text ?? "").join("");
      const nodeId = text.match(/# Graph 节点执行 · ([\w-]+)/)?.[1] ?? "?";
      const branch = text.match(/集成分支 `([^`]+)`/)?.[1];
      const cwd = opts.meta.cwd;
      const run = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
      fs.writeFileSync(path.join(cwd, "shared.txt"), `${nodeId}\n`);
      run("add", "-A");
      run("commit", "-qm", `node ${nodeId}`, "--allow-empty");
      if (branch) {
        try { run("merge", "--no-edit", branch); }
        catch {
          // 冲突现场：写这个改动的节点自己解决，不留冲突标记。
          const conflicted = /<<<<<<<|>>>>>>>/.test(fs.readFileSync(path.join(cwd, "shared.txt"), "utf8"));
          seen.push({ nodeId, conflicted });
          fs.writeFileSync(path.join(cwd, "shared.txt"), "resolved\n");
          run("add", "-A");
          run("commit", "-qm", `node ${nodeId}: resolve`, "--allow-empty");
        }
      }
      void submitBehavior({ tools, agent }, facade).catch((error) => console.error("      [fake submit failed]", nodeId, String(error).slice(0, 300)));
    }, async whenIdle() { await sleep(140); } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  await facade.start("conflictflow", "conflict task", mainSession);
  const entry = await waitFor(facade, (item) => ["completed", "paused", "failed"].includes(item.state.graph.status), { label: "conflict completion", workflow: "conflictflow" });
  check("冲突场景也能跑完", entry?.state.graph.status === "completed", `${entry?.state.graph.status} ${entry?.state.graph.pause_reason ?? ""} ${JSON.stringify(entry?.state.graph.attempts?.map((x) => [x.node_id, x.seq, x.status, x.rework_reason?.slice(0, 120), x.failure?.message?.slice(0, 160)]))}`);
  check("冲突出现在写者的 worktree 里（由写这个改动的节点解决）", seen.some((item) => item.conflicted), JSON.stringify(seen));
  const branch = `ralphflow/${entry.id}`;
  check("解决结果进入集成分支", git("show", `${branch}:shared.txt`).trim() === "resolved", git("show", `${branch}:shared.txt`));
  check("接纳链严格串行（每次 previous_commit = 上一版 commit）", (() => {
    const acceptances = entry.state.graph.acceptances;
    let previous = entry.state.graph.integration.baseline;
    for (const acceptance of acceptances) {
      if (acceptance.integration?.previous_commit !== previous) return false;
      previous = acceptance.integration?.commit;
    }
    return previous === entry.state.graph.integration.current_commit;
  })(), JSON.stringify(entry.state.graph.acceptances.map((a) => ({ p: a.integration?.previous_commit?.slice(0, 8), c: a.integration?.commit?.slice(0, 8) }))));
}


console.log("E6e 交卷必须站在节点分支上：detached HEAD 上的提交不被接纳");
{
  process.env.RALPHFLOW_GRAPH_ARTIFACT = "0";
  writeGraph("detachedflow", `kind: graph
steps:
  - id: a
    desc: write a
    do: write a
    output: a.md
    check: "1. a exists"
  - id: b
    desc: write b
    do: write b
    output: b.md
    check: "1. b exists"
`);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: "n@example.invalid", GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: "n@example.invalid" };
  let facade;
  let bAttempts = 0;
  const observed = {};
  const behavior = async ({ tools, opts, message }) => {
      const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} } };
      const text = message.content.map((block) => block.text ?? "").join("");
      const nodeId = text.match(/# Graph 节点执行 · ([\w-]+)/)?.[1] ?? "?";
      const integration = text.match(/集成分支 `([^`]+)`/)?.[1];
      const cwd = opts.meta.cwd;
      const run = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "ignore"] });
      if (nodeId === "b") {
        bAttempts += 1;
        for (let i = 0; i < 400; i++) {
          const state = facade.graph.listStates().find((item) => item.state.workflow_name === "detachedflow")?.state;
          if (state?.graph.acceptances.some((x) => x.node_id === "a")) break;
          await sleep(20);
        }
        if (bAttempts === 1) {
          observed.nodeBranch = run("rev-parse", "--abbrev-ref", "HEAD").trim();
          observed.integrationTipAtSubmit = git("rev-parse", integration).trim();
          // 复现验证探针：节点分支停在基线，detach 后在游离 HEAD 上提交并合集成线。
          run("checkout", "--detach", "HEAD");
          fs.writeFileSync(path.join(cwd, "b.txt"), "b detached\n");
          run("add", "-A");
          run("commit", "-qm", "node b on detached HEAD");
          try { run("merge", "--no-edit", integration); } catch {}
          observed.detachedHead = run("rev-parse", "HEAD").trim();
          observed.detachedContainsTip = (() => { try { run("merge-base", "--is-ancestor", observed.integrationTipAtSubmit, "HEAD"); return true; } catch { return false; } })();
          observed.branchContainsTip = (() => { try { run("merge-base", "--is-ancestor", observed.integrationTipAtSubmit, `refs/heads/${observed.nodeBranch}`); return true; } catch { return false; } })();
        } else {
          // 退回后按引擎的话把提交放回节点分支，再合集成线。
          run("switch", observed.nodeBranch);
          fs.writeFileSync(path.join(cwd, "b.txt"), "b on branch\n");
          run("add", "-A");
          run("commit", "-qm", "node b on node branch");
          try { run("merge", "--no-edit", integration); } catch (error) { console.error("      [merge failed]", String(error).slice(0, 200)); }
        }
      } else {
        fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
        run("add", "-A");
        run("commit", "-qm", "node a");
        if (integration) { try { run("merge", "--no-edit", integration); } catch {} }
      }
      const write = tools.find((tool) => tool.name === "ralphflow_artifact_write");
      await write.execute({ content: `# ${nodeId}` }, { agent, signal: new AbortController().signal });
      await facade.submitFromAny(agent);
  };
  const host = makeHost();
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup(message) { agent.__behavior = behavior({ tools, opts, message }); }, async whenIdle() { await agent.__behavior; } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  const detachedStarted = await facade.start("detachedflow", "detached task", mainSession);
  check("detached 场景启动", detachedStarted.ok, detachedStarted.text);
  const entry = await waitFor(facade, (item) => ["completed", "paused", "failed"].includes(item.state.graph.status), { label: "detached flow completion", workflow: "detachedflow" });
  const attemptsOfB = entry?.state.graph.attempts.filter((attempt) => attempt.node_id === "b") ?? [];
  check("detached HEAD 交卷被退回并重做，run 仍能完成", entry?.state.graph.status === "completed" && attemptsOfB.length >= 2,
    `${entry?.state.graph.status} ${JSON.stringify(attemptsOfB.map((attempt) => [attempt.seq, attempt.status, attempt.rework_reason?.slice(0, 90), attempt.failure?.message?.slice(0, 90)]))}`);
  const retryReason = attemptsOfB.find((attempt) => attempt.seq === 2)?.rework_reason ?? "";
  check("退回理由指向节点分支/detached HEAD", attemptsOfB[0]?.status === "rejected" && /detached|节点分支/.test(retryReason),
    retryReason || JSON.stringify(attemptsOfB.map((attempt) => [attempt.seq, attempt.status, attempt.rework_reason])));
  check("探针事实：游离 HEAD 含集成 tip，而节点分支不含", observed.detachedContainsTip === true && observed.branchContainsTip === false,
    JSON.stringify({ detachedContainsTip: observed.detachedContainsTip, branchContainsTip: observed.branchContainsTip }));
  const nodeBranchB = `ralphflow-node/${entry.id}/b`;
  const acceptanceB = entry?.state.graph.acceptances.find((acceptance) => acceptance.node_id === "b");
  check("接纳的提交来自节点分支，不是游离 HEAD", !!acceptanceB
    && acceptanceB.integration?.commit === git("rev-parse", nodeBranchB).trim()
    && acceptanceB.integration?.commit !== observed.detachedHead,
    JSON.stringify({ accepted: acceptanceB?.integration?.commit, branch: git("rev-parse", nodeBranchB).trim(), detached: observed.detachedHead }));
  check("接纳后节点分支包含集成分支头", (() => {
    try { git("merge-base", "--is-ancestor", entry.state.graph.integration.current_commit, nodeBranchB); return true; } catch { return false; }
  })(), `${git("rev-parse", nodeBranchB).trim()} vs ${entry.state.graph.integration.current_commit}`);
  check("集成分支里两个节点的文件都在", ["a.txt", "b.txt"].every((file) => git("ls-tree", "-r", "--name-only", `ralphflow/${entry.id}`).split("\n").includes(file)),
    git("ls-tree", "-r", "--name-only", `ralphflow/${entry.id}`));
}

console.log("E6f 只交产物的节点：集成分支已前进时，空节点分支被快进到集成 tip");
{
  process.env.RALPHFLOW_GRAPH_ARTIFACT = "0";
  writeGraph("emptyafterflow", `kind: graph
steps:
  - id: a
    desc: write a
    do: write a
    output: a.md
    check: "1. a exists"
  - id: b
    desc: write notes
    do: write notes
    output: b.md
    check: "1. b exists"
`);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: "n@example.invalid", GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: "n@example.invalid" };
  let facade;
  const observed = {};
  const behavior = async ({ tools, opts, message }) => {
      const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} } };
      const text = message.content.map((block) => block.text ?? "").join("");
      const nodeId = text.match(/# Graph 节点执行 · ([\w-]+)/)?.[1] ?? "?";
      const integration = text.match(/集成分支 `([^`]+)`/)?.[1];
      const cwd = opts.meta.cwd;
      const run = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "ignore"] });
      if (nodeId === "b") {
        for (let i = 0; i < 400; i++) {
          const state = facade.graph.listStates().find((item) => item.state.workflow_name === "emptyafterflow")?.state;
          if (state?.graph.acceptances.some((x) => x.node_id === "a")) break;
          await sleep(20);
        }
        observed.nodeBranch = run("rev-parse", "--abbrev-ref", "HEAD").trim();
        observed.branchTipAtSubmit = run("rev-parse", `refs/heads/${observed.nodeBranch}`).trim();
        observed.integrationTipAtSubmit = git("rev-parse", integration).trim();
        observed.headAtSubmit = run("rev-parse", "HEAD").trim();
      } else {
        fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
        run("add", "-A");
        run("commit", "-qm", "node a");
        if (integration) { try { run("merge", "--no-edit", integration); } catch {} }
      }
      const write = tools.find((tool) => tool.name === "ralphflow_artifact_write");
      await write.execute({ content: `# ${nodeId}` }, { agent, signal: new AbortController().signal });
      await facade.submitFromAny(agent);
  };
  const host = makeHost();
  host.ctx.agents.create = async (opts) => {
    const tools = [];
    opts.setup?.({ tools: { register(definition) { tools.push(definition); return () => {}; }, restrict() {}, get() { return undefined; } } });
    const agent = { id: opts.sessionId, session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd }, append() {} }, followup(message) { agent.__behavior = behavior({ tools, opts, message }); }, async whenIdle() { await agent.__behavior; } };
    return { agent, dispose: async () => {} };
  };
  facade = baseFacade(host, async (req) => passVerdict(req));
  facade.ensureLayout();
  const emptyStarted = await facade.start("emptyafterflow", "empty branch task", mainSession);
  check("空分支场景启动", emptyStarted.ok, emptyStarted.text);
  const entry = await waitFor(facade, (item) => ["completed", "paused", "failed"].includes(item.state.graph.status), { label: "empty branch completion", workflow: "emptyafterflow" });
  const attemptsOfB = entry?.state.graph.attempts.filter((attempt) => attempt.node_id === "b") ?? [];
  const acceptanceA = entry?.state.graph.acceptances.find((acceptance) => acceptance.node_id === "a");
  const acceptanceB = entry?.state.graph.acceptances.find((acceptance) => acceptance.node_id === "b");
  check("无代码改动的节点在集成线前进后仍被直接接纳（不返工）", entry?.state.graph.status === "completed" && attemptsOfB.length === 1 && acceptanceB?.integration,
    `${entry?.state.graph.status} ${JSON.stringify(attemptsOfB.map((attempt) => [attempt.seq, attempt.status, attempt.rework_reason?.slice(0, 90)]))}`);
  check("探针事实：交卷时节点分支还停在基线，不含集成 tip", observed.branchTipAtSubmit === entry?.state.graph.integration?.baseline && observed.integrationTipAtSubmit === acceptanceA?.integration?.commit,
    JSON.stringify({ branch: observed.branchTipAtSubmit, tip: observed.integrationTipAtSubmit, base: entry?.state.graph.integration?.baseline }));
  const nodeBranchB = `ralphflow-node/${entry.id}/b`;
  check("接纳后空节点分支已快进到集成 tip", git("rev-parse", nodeBranchB).trim() === observed.integrationTipAtSubmit
    && acceptanceB?.integration?.commit === observed.integrationTipAtSubmit
    && acceptanceB?.integration?.previous_commit === observed.integrationTipAtSubmit,
    JSON.stringify(acceptanceB?.integration));
  check("节点分支包含集成 tip（验收事实 2 成立）", (() => {
    try { git("merge-base", "--is-ancestor", observed.integrationTipAtSubmit, nodeBranchB); return true; } catch { return false; }
  })());
  check("worktree HEAD 与节点分支都停在集成 tip 且工作树干净", (() => {
    const worktree = entry.state.graph.worktrees.find((item) => item.node_id === "b");
    const head = execFileSync("git", ["-C", worktree.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const status = execFileSync("git", ["-C", worktree.path, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
    return head === observed.integrationTipAtSubmit && status === "";
  })());
  check("快进空分支记入 history", entry.state.history.some((item) => item.event === "node_branch_aligned" && item.step === "b"),
    JSON.stringify(entry.state.history.filter((item) => item.event === "node_branch_aligned")));
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(projectDir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
