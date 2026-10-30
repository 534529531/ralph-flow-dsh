/**
 * 中断判断：属主运行时失联 → 不再显示"执行中"。
 *
 * 判据是实例心跳（`src/owner.ts`）：
 *   - 过了 TTL 或没有心跳：立即标中断；
 *   - 还新鲜：可能是另一个活着的 host，也可能是快速重启 —— 等一个刷新窗口再看心跳是否
 *     继续往前走。往前走了 = 活着；没走 = 真死了。
 *
 * 这里用**手写的最小 state.json** 模拟「上一个进程已经死了」：没有活的定时器会再刷它，
 * 所以不会把测试自己的进程当成属主。
 *
 * 断言：
 *   F1 Flow：心跳过期 → restore 立即标中断（host_restarted），状态行不再说执行中；
 *   F2 Flow：快速重启（心跳还新鲜）→ 不当场标；复查窗口后心跳没动 → 标中断；
 *   F3 Flow：另一个活着的 host 持续刷心跳 → 复查不误伤；
 *   F4 Flow：审查门 / 已暂停不因心跳缺失被动；
 *   F5 Flow：continue 从 host_restarted 恢复并重投 DO；
 *   G1 Graph：心跳过期 → interrupted（不是"引擎一创建就无条件中断"）；
 *   G2 Graph：快速重启 → 复查后 interrupted；
 *   G3 Graph：活着的 host 持续刷心跳 → 复查后仍是 running。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";
import { createFacade } from "../lib/facade.js";
import { OWNER_HEARTBEAT_TTL_MS } from "../lib/owner.js";
import { deliveryPorts } from "./helpers/ports.mjs";
import { mkEnv, sleep, rfDir, mkTmp, cleanupTmp } from "./helpers/plugin-harness.mjs";

process.env.HOME = mkTmp("home");
process.env.DSH_HOME = path.join(process.env.HOME, ".dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
// 把 15s 的复查窗口缩短到 60ms，测试不用真的等 15 秒。
process.env.RALPHFLOW_OWNER_RECHECK_MS = "60";

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const iso = () => new Date().toISOString();
const statePathOf = (ws, id) => path.join(ws, ".dsh", "ralph-flow", "instances", id, "state.json");

function flowState(sid, overrides = {}) {
  return {
    active: true, workflow_name: "loop", current_step: "loop", user_task: "中断用例",
    fail_counts: {}, paused: false, do_submitted: false, owner_session: sid,
    owner_runtime: "dead-runtime", owner_heartbeat_at: Date.now() - OWNER_HEARTBEAT_TTL_MS - 5_000,
    delegations: [], verdicts: [], history: [], started_at: iso(), updated_at: iso(), artifacts_dir_name: "x",
    ...overrides,
  };
}

function writeFlow(ws, id, state) {
  const dir = path.dirname(statePathOf(ws, id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePathOf(ws, id), JSON.stringify(state, null, 2));
}

function graphState(sid, beat) {
  return {
    kind: "graph", active: true, workflow_name: "mini", user_task: "中断用例", owner_session: sid,
    owner_runtime: "dead-runtime", owner_heartbeat_at: beat,
    artifacts_dir_name: "x", started_at: iso(), updated_at: iso(),
    graph: {
      asset: { id: "mini", name: "mini", nodes: [] }, asset_hash: "x", status: "running",
      project: { mode: "artifact" },
      attempts: [], verdicts: [], acceptances: [], human_todos: [], worktrees: [], rework_counts: {}, fault_retries: {},
    },
    history: [],
  };
}

function writeGraph(ws, id, state) {
  const dir = path.dirname(statePathOf(ws, id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePathOf(ws, id), JSON.stringify(state, null, 2));
}

const flowPorts = (sink) => ({
  ...deliveryPorts(sink),
  verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, status: "passed", reason: "ok", ts: iso() }),
  log: () => {},
});

console.log("F1 Flow：心跳过期 → restore 立即标中断");
{
  const ws = mkTmp("int-flow-stale");
  const sid = "session-f1";
  writeFlow(ws, "f1-inst", flowState(sid, {
    owner_heartbeat_at: Date.now() - OWNER_HEARTBEAT_TTL_MS - 5_000,
    delegations: [{ run_id: "v-dead", check_index: 0, ts: iso() }],
  }));
  const sent = [];
  const e = createEngine(ws, flowPorts(sent));
  e.restore();
  const st = e.readState("f1-inst");
  check("心跳过期 → paused", st.paused === true, JSON.stringify({ p: st.paused }));
  check("原因 host_restarted", st.pause_reason === "host_restarted", JSON.stringify(st.pause_reason));
  check("不可回来的委派被清空", st.delegations.length === 0, JSON.stringify(st.delegations.length));
  check("轨迹留下 interrupted", st.history.some((h) => h.event === "interrupted"), JSON.stringify(st.history.map((h) => h.event)));
  check("状态行不再说“执行中”", /已中断/.test(e.statusOf(sid).text), e.statusOf(sid).text.slice(0, 160));
  check("用户收到中断播报", sent.some((m) => String(m).includes("已中断")));
  cleanupTmp(ws);
}

console.log("F2/F5 Flow：快速重启 → 复查后标中断；continue 恢复并重投 DO");
{
  const ws = mkTmp("int-flow-recheck");
  const sid = "session-f2";
  writeFlow(ws, "f2-inst", flowState(sid, { owner_heartbeat_at: Date.now() }));
  const sent = [];
  const e = createEngine(ws, flowPorts(sent));
  e.restore();
  check("心跳还新鲜：不当场标中断（可能是另一个活着的 host）", e.readState("f2-inst").paused === false);
  await sleep(180);
  const st = e.readState("f2-inst");
  check("复查窗口后心跳没动 → 标中断", st.paused === true && st.pause_reason === "host_restarted",
    JSON.stringify({ p: st.paused, r: st.pause_reason }));
  sent.length = 0;
  const resumed = e.continueInstance(sid);
  check("continue 从 host_restarted 恢复", resumed.ok && e.readState("f2-inst").paused === false, resumed.text);
  check("恢复后重投当前步 DO", sent.some((m) => String(m).includes("loop")), JSON.stringify(sent.length));
  cleanupTmp(ws);
}

console.log("F3 Flow：另一个活着的 host 持续刷心跳 → 复查不误伤");
{
  const ws = mkTmp("int-flow-live");
  const sid = "session-f3";
  const beatAt = Date.now();
  writeFlow(ws, "f3-inst", flowState(sid, { owner_runtime: "live-other-host", owner_heartbeat_at: beatAt }));
  const beat = setInterval(() => {
    const st = JSON.parse(fs.readFileSync(statePathOf(ws, "f3-inst"), "utf-8"));
    st.owner_heartbeat_at = Date.now();
    fs.writeFileSync(statePathOf(ws, "f3-inst"), JSON.stringify(st, null, 2));
  }, 20);
  try {
    const e = createEngine(ws, flowPorts([]));
    e.restore();
    await sleep(200);
    const st = e.readState("f3-inst");
    check("活着的属主心跳在走 → 不标中断", st.paused === false, JSON.stringify({ p: st.paused, r: st.pause_reason }));
  } finally {
    clearInterval(beat);
    cleanupTmp(ws);
  }
}

console.log("F4 Flow：审查门 / 已暂停不因心跳缺失被动");
{
  const ws = mkTmp("int-flow-stable");
  writeFlow(ws, "gate-inst", flowState("session-gate", {
    do_submitted: true, verdicts: [{ check_index: 0, status: "passed", reason: "ok", step_id: "loop", ts: iso() }],
  }));
  writeFlow(ws, "paused-inst", flowState("session-paused", { paused: true, pause_reason: "user_stop" }));
  const e = createEngine(ws, flowPorts([]));
  e.restore();
  check("审查门（已交卷、无在飞委派）不标中断", e.readState("gate-inst").paused === false);
  check("已暂停实例保持原样", e.readState("paused-inst").paused === true && e.readState("paused-inst").pause_reason === "user_stop");
  cleanupTmp(ws);
}

console.log("G1 Graph：心跳过期 → restore 标 interrupted");
{
  const ws = mkTmp("int-graph-stale");
  const sid = "session-g1";
  writeGraph(ws, "g1-inst", graphState(sid, Date.now() - OWNER_HEARTBEAT_TTL_MS - 5_000));
  const env = mkEnv(ws, sid);
  const facade = createFacade(ws, { ctx: env.ctx, ports: flowPorts([]) });
  facade.restore();
  const st = facade.graph.readState("g1-inst");
  check("心跳过期 → interrupted", st.graph.status === "interrupted", JSON.stringify(st.graph.status));
  check("原因 host_restarted", st.graph.pause_reason === "host_restarted", JSON.stringify(st.graph.pause_reason));
  cleanupTmp(ws);
}

console.log("G2 Graph：快速重启 → 复查后 interrupted");
{
  const ws = mkTmp("int-graph-recheck");
  const sid = "session-g2";
  writeGraph(ws, "g2-inst", graphState(sid, Date.now()));
  const env = mkEnv(ws, sid);
  const facade = createFacade(ws, { ctx: env.ctx, ports: flowPorts([]) });
  facade.restore();
  check("心跳新鲜：不当场标中断", facade.graph.readState("g2-inst").graph.status === "running");
  await sleep(180);
  check("复查后 → interrupted", facade.graph.readState("g2-inst").graph.status === "interrupted",
    JSON.stringify(facade.graph.readState("g2-inst").graph.status));
  cleanupTmp(ws);
}

console.log("G3 Graph：活着的 host 持续刷心跳 → 复查不误伤");
{
  const ws = mkTmp("int-graph-live");
  const sid = "session-g3";
  writeGraph(ws, "g3-inst", graphState(sid, Date.now()));
  const beat = setInterval(() => {
    const st = JSON.parse(fs.readFileSync(statePathOf(ws, "g3-inst"), "utf-8"));
    st.owner_heartbeat_at = Date.now();
    fs.writeFileSync(statePathOf(ws, "g3-inst"), JSON.stringify(st, null, 2));
  }, 20);
  try {
    const env = mkEnv(ws, sid);
    const facade = createFacade(ws, { ctx: env.ctx, ports: flowPorts([]) });
    facade.restore();
    await sleep(200);
    check("活着的属主心跳在走 → 仍是 running", facade.graph.readState("g3-inst").graph.status === "running",
      JSON.stringify(facade.graph.readState("g3-inst").graph.status));
  } finally {
    clearInterval(beat);
    cleanupTmp(ws);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
