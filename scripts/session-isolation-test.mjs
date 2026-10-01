/**
 * 问题一 · 会话之间互相踩：**A 的验证在飞时，别的会话碰 ralphflow 不得影响它，一点都不能**。
 *
 * 真实现象（复现过两次，时间戳抄自实例 state.json）：
 *   15:58:10 verify_start → 15:59:45 orphan_delegation_recovered（被别的会话踩停）
 *   16:16:19 resume + verify_start → 16:18:24 orphan_delegation_recovered（又被踩停）
 *
 * 机制：所有工具（含只读的 list/status/doctor）都从 `engineFor()` 进引擎；某个工作区**第一次**
 * 建引擎时会跑 `restore()`，而修复前的 `restore()` **无条件**清空所有在飞 `delegations` 并暂停
 * 实例 —— 于是别处的 ralphflow 一碰，正在飞的验证就被当成孤儿清掉：验证白烧、判定被丢弃、
 * 用户被迫手动 resume。
 *
 * 判活为什么不能看 pid（第一版就是这么写的，被真实部署打回）：本部署里各 agent 进程有**独立
 * 的 PID namespace 与 /proc 视图** —— 宿主进程明明活着，验证者的沙箱里 `kill(host_pid, 0)`
 * 却是 `ESRCH`，于是活属主被判成死的。跨进程唯一共享的是**文件系统**，所以判据是**心跳**：
 * 属主在等判定期间按周期刷新 `delegations[i].heartbeat_at`，心跳停了才是真孤儿。
 *
 * 本文件断言：
 *   I1  同一进程里，B 碰 ralphflow（只读）→ A **一个字节都不受影响**，且验证照样落地；
 *   I2  **另一个进程**（真 spawn 一个 node，模拟验证者的沙箱）碰 ralphflow → 同上；
 *   I3  同一次 restore() 里两件事同时成立：心跳停了的老账被兜住、心跳还新的那个一点不动；
 *   I4  判据边界：心跳新鲜 → 活；过期 → 死；没有心跳字段（老 state.json）→ 按孤儿兜底；
 *       且在飞期间心跳**确实在往前走**（否则一切判活都是空谈）；
 *   I5  兼容：老 state.json（无心跳字段）仍走原安全网；
 *   I6【负对照】把判据还原成「无条件当孤儿」→ **同一段用例、同一个判据**必然判不通过。
 *
 * 纪律（任务书 §4）：一切临时资产走 mkdtemp + 隔离 HOME，绝不碰真实工作区/`~/.dsh`。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createEngine, delegationOwnerAlive, DELEGATION_HEARTBEAT_TTL_MS } from "../lib/engine.js";
import {
  mkEnv, toolOf, execTool, textOf, sleep, mkTmp, cleanupTmp,
  instanceDirs, readStateFile, readTextFile, statePathOf, reportPathOf, instanceDirOf,
} from "./helpers/plugin-harness.mjs";
import { REPO, buildPluginCopy, revertOrphanLivenessGuard } from "./helpers/reverted-build.mjs";

// HOME 隔离：索引/全局工作流目录都在 ~/.dsh 下，测试绝不读写真实 HOME。
process.env.HOME = mkTmp("home");
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const RUN = Math.random().toString(36).slice(2, 8);
const PLUGIN_ENTRY = pathToFileURL(path.join(REPO, "lib", "index.js")).href;
const TOUCH_PROBE = path.join(REPO, "scripts", "helpers", "touch-probe.mjs");

/** 只读工具（别处用它碰 ralphflow —— 全是「不该有任何副作用」的那种） */
const READONLY_TOOLS = ["ralphflow_list", "ralphflow_status", "ralphflow_doctor"];

/** 让**另一个进程**去碰 ralphflow（真实部署里验证者就是这样一个 sandbox 进程） */
function touchFromAnotherProcess(entryUrl, ws, sid, tool = "ralphflow_list") {
  const probeHome = mkTmp("probe-home");
  fs.mkdirSync(path.join(probeHome, ".dsh"), { recursive: true });
  const r = spawnSync(process.execPath, [TOUCH_PROBE, entryUrl, ws, sid, tool], {
    encoding: "utf-8",
    env: { ...process.env, HOME: probeHome, RALPHFLOW_WORKSPACE: ws },
    timeout: 60_000,
  });
  cleanupTmp(probeHome);
  if (r.status !== 0) throw new Error(`跨进程探针失败（exit=${r.status}）：${r.stderr || r.stdout}`);
  return r.stdout ?? "";
}

/**
 * 用例本体：会话 A 交卷 → 验证钉在飞行中 → **别处**碰 ralphflow → 观察 A。
 *
 * 同一段代码既跑**修复后**的构建，也跑**还原修复**的构建（负对照），判据函数完全相同。
 *
 * @param {"inprocess"|"crossprocess"} via 别处碰 ralphflow 的方式
 */
async function runIsolationCase(entryUrl, via) {
  const ws = mkTmp("iso");
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sidA = `iso-a-${RUN}-${via}`;
  const sidB = `iso-b-${RUN}-${via}`;

  let resolveVerify;
  const hangingStart = () => ({ id: "child-A", result: new Promise((r) => { resolveVerify = r; }) });

  // ── 会话 A：起工作流 → 交卷 → 验证在飞（subagents.start 永远不 resolve）──
  const A = mkEnv(ws, sidA, { start: hangingStart });
  const pluginA = await import(entryUrl);
  pluginA.apply(A.ctx);
  await execTool(toolOf(A.registered, "ralphflow_start"), { workflow: "loop", task: "会话隔离用例" }, sidA);
  await sleep(40);
  await execTool(toolOf(A.registered, "ralphflow_submit"), { summary: "做完了" }, sidA);
  await sleep(150);

  const instId = instanceDirs(ws)[0];
  const beforeState = readTextFile(statePathOf(ws, instId));
  A.sent.length = 0; // 只看别处动手之后 A 有没有再收到播报

  // ── 别处碰 ralphflow：另一个进程（沙箱）或本进程里另装载一份插件 ──
  let bListOutput = "";
  if (via === "crossprocess") {
    bListOutput = touchFromAnotherProcess(entryUrl, ws, sidB);
  } else {
    const B = mkEnv(ws, sidB, {});
    const pluginB = await import(`${entryUrl}?session=B-${RUN}`);
    pluginB.apply(B.ctx);
    for (const name of READONLY_TOOLS) {
      const out = await execTool(toolOf(B.registered, name), {}, sidB);
      if (name === "ralphflow_list") bListOutput = String(out ?? "");
    }
  }
  await sleep(150);

  const afterState = readTextFile(statePathOf(ws, instId));
  const st = JSON.parse(afterState);
  const obs = {
    via,
    instId,
    listOutput: bListOutput,
    // 「一点都不能」= 连字节都没变（paused / delegations / updated_at / 心跳 全在这份文件里）
    stateTouched: afterState !== beforeState,
    paused: st.paused === true,
    pauseReason: st.pause_reason ?? null,
    delegations: (st.delegations ?? []).length,
    recovered: (st.history ?? []).some((h) => h.event === "orphan_delegation_recovered"),
    pauseNotices: A.sent.filter((m) => /暂停|孤儿|orphan/.test(textOf(m))).length,
    bSawInstance: bListOutput.includes(instId) && bListOutput.includes("验证中"),
    // ── 在飞的那份验证还必须**真的落地**（否则就是白烧一份 token）──
    verifyLanded: false,
    ws,
  };

  resolveVerify({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" });
  await sleep(250);
  obs.verifyLanded = !fs.existsSync(instanceDirOf(ws, instId)) && fs.existsSync(reportPathOf(ws, instId));
  return obs;
}

/** 唯一的一份判据：A 完全不受影响 ∧ 在飞验证照样落地 */
const isolationHolds = (o) =>
  o.stateTouched === false && o.paused === false && o.delegations === 1 && o.recovered === false
  && o.pauseNotices === 0 && o.verifyLanded === true;

/** 两种「别处」跑同一组断言（措辞只有这一处） */
function assertIsolation(label, obs) {
  check(`${label}：A 的 state.json 一个字节都没被改（没暂停、委派还在、updated_at 没动）`,
    obs.stateTouched === false, `touched=${obs.stateTouched} paused=${obs.paused} reason=${obs.pauseReason}`);
  check(`${label}：A 的在飞委派仍是 1 笔，轨迹里没有 orphan_delegation_recovered`,
    obs.delegations === 1 && obs.recovered === false, JSON.stringify({ d: obs.delegations, recovered: obs.recovered }));
  check(`${label}：A 没有收到任何暂停/孤儿播报`, obs.pauseNotices === 0, `n=${obs.pauseNotices}`);
  check(`${label}：别处确实看到了 A 的实例且在验证中（证明它真的碰了 ralphflow）`,
    obs.bSawInstance === true, obs.listOutput.slice(0, 200));
  check(`${label}：在飞的验证照样落地：判定通过 → 实例完成 + 报告归档（token 没白烧）`,
    obs.verifyLanded === true);
  check(`${label}：判据 isolationHolds 为真`, isolationHolds(obs) === true);
}

// ─────────────────────────────────────────────────────────────────────────────

console.log("I1 同一进程里，B 碰 ralphflow（只读）→ A 不受影响，且验证照样落地");
{
  const obs = await runIsolationCase(PLUGIN_ENTRY, "inprocess");
  assertIsolation("I1", obs);
  cleanupTmp(obs.ws);
}

console.log("\nI2 **另一个进程**（模拟验证者的 sandbox）碰 ralphflow → A 同样不受影响");
console.log("    （真实部署里踩停在飞验证的就是这个形状：跨进程 + 各自的 /proc 视图）");
{
  const obs = await runIsolationCase(PLUGIN_ENTRY, "crossprocess");
  assertIsolation("I2", obs);
  cleanupTmp(obs.ws);
}

console.log("\nI3 同一次 restore() 里两件事同时成立：心跳停的老账**照样兜住**、在飞的那个**一点不动**");
{
  const ws = mkTmp("iso-crash");
  process.env.RALPHFLOW_WORKSPACE = ws;
  const pluginA = await import(PLUGIN_ENTRY);
  const hanging = () => ({ id: "child", result: new Promise(() => {}) });

  // 实例①：会话 A 的验证**在飞**（心跳由属主持续刷新）
  const A = mkEnv(ws, `crash-a-${RUN}`, { start: hanging });
  pluginA.apply(A.ctx);
  await execTool(toolOf(A.registered, "ralphflow_start"), { workflow: "loop", task: "在飞实例" }, A.sid);
  await execTool(toolOf(A.registered, "ralphflow_submit"), { summary: "做完了" }, A.sid);
  await sleep(150);

  // 实例②：会话 C 的委派心跳**早已停**（= 上一个进程崩溃后留下的孤儿）
  const C = mkEnv(ws, `crash-c-${RUN}`, { start: hanging });
  pluginA.apply(C.ctx);
  await execTool(toolOf(C.registered, "ralphflow_start"), { workflow: "loop", task: "孤儿实例" }, C.sid);
  await execTool(toolOf(C.registered, "ralphflow_submit"), { summary: "做完了" }, C.sid);
  await sleep(150);

  const bySession = (sid) => instanceDirs(ws).find((id) => readStateFile(ws, id)?.owner_session === sid);
  const liveId = bySession(A.sid);
  const orphanId = bySession(C.sid);
  check("两个实例都已就位（在飞的那个 + 心跳停了的那个）", !!liveId && !!orphanId && liveId !== orphanId,
    JSON.stringify({ liveId, orphanId }));
  const liveBefore = readTextFile(statePathOf(ws, liveId));

  const orphan = readStateFile(ws, orphanId);
  orphan.delegations[0].heartbeat_at = Date.now() - DELEGATION_HEARTBEAT_TTL_MS - 5_000; // 心跳停了
  fs.writeFileSync(statePathOf(ws, orphanId), JSON.stringify(orphan, null, 2));

  // 第三个会话（**另一个进程**）碰 ralphflow → 触发一次 restore()，两个实例在同一趟里被判断
  touchFromAnotherProcess(PLUGIN_ENTRY, ws, `crash-b-${RUN}`);
  await sleep(150);

  const liveAfter = readTextFile(statePathOf(ws, liveId));
  const orphanAfter = readStateFile(ws, orphanId);
  check("心跳停了的：暂停 check_infra + 清空委派 + 留下 orphan_delegation_recovered（可诊断）",
    orphanAfter.paused === true && orphanAfter.pause_reason === "check_infra"
    && orphanAfter.delegations.length === 0
    && orphanAfter.history.some((h) => h.event === "orphan_delegation_recovered"),
    JSON.stringify({ p: orphanAfter.paused, r: orphanAfter.pause_reason, d: orphanAfter.delegations.length }));
  check("同一趟里的在飞实例：**一个字节都没被改**（没暂停、委派还在）",
    liveAfter === liveBefore && JSON.parse(liveAfter).paused !== true,
    JSON.stringify({ touched: liveAfter !== liveBefore, paused: JSON.parse(liveAfter).paused }));
  cleanupTmp(ws);
}

console.log("\nI4 判据边界：心跳新鲜/过期/缺字段，以及「在飞期间心跳确实在走」");
{
  const now = Date.now();
  check("心跳刚刷过 → 活",
    delegationOwnerAlive({ run_id: "r", check_index: 0, ts: "", heartbeat_at: now }) === true);
  // 「含边界」必须**冻结时钟**才测得准：判据内部读 `Date.now()`，而 `now` 是上面几行取的，
  // 两次读之间只要有 1ms 抖动，`now - TTL` 就落到界外 —— 那是在**碰运气**，不是判据错
  // （实测约 1/4 的运行会因此偶发变红）。冻结后既确定、又精确钉住「含」这一侧。
  const realDateNow = Date.now;
  const FROZEN = realDateNow();
  Date.now = () => FROZEN;
  try {
    check("心跳在 TTL 内（含边界）→ 活",
      delegationOwnerAlive({ run_id: "r", check_index: 0, ts: "", heartbeat_at: FROZEN - DELEGATION_HEARTBEAT_TTL_MS }) === true);
    check("心跳过期 → 死（属主失联）",
      delegationOwnerAlive({ run_id: "r", check_index: 0, ts: "", heartbeat_at: FROZEN - DELEGATION_HEARTBEAT_TTL_MS - 1 }) === false);
  } finally {
    Date.now = realDateNow;
  }
  check("穷途末路的老账：没有心跳字段 → 不是活（按孤儿兜底）",
    delegationOwnerAlive({ run_id: "r", check_index: 0, ts: "" }) === false);
  check("心跳字段是垃圾值 → 不是活",
    delegationOwnerAlive({ run_id: "r", check_index: 0, ts: "", heartbeat_at: Number.NaN }) === false);

  // 心跳必须**真的在走**：否则上面所有判活都是空谈
  const ws = mkTmp("iso-heartbeat");
  process.env.RALPHFLOW_WORKSPACE = ws;
  let resolveVerify;
  const A = mkEnv(ws, `hb-${RUN}`, { start: () => ({ id: "child", result: new Promise((r) => { resolveVerify = r; }) }) });
  const plugin = await import(PLUGIN_ENTRY);
  plugin.apply(A.ctx);
  await execTool(toolOf(A.registered, "ralphflow_start"), { workflow: "loop", task: "心跳用例" }, A.sid);
  await execTool(toolOf(A.registered, "ralphflow_submit"), { summary: "做完了" }, A.sid);
  await sleep(150);
  const instId = instanceDirs(ws)[0];
  const first = readStateFile(ws, instId).delegations[0];
  check("在飞委派带属主运行时 id（诊断）+ 心跳起点（判活）",
    typeof first.owner_runtime === "string" && typeof first.heartbeat_at === "number", JSON.stringify(first));
  await sleep(6_500); // > 一个心跳周期
  const later = readStateFile(ws, instId).delegations[0];
  check("等了 6.5s 后心跳**确实往前走了**（属主在持续续期，TTL 判活才有意义）",
    later.heartbeat_at > first.heartbeat_at, JSON.stringify({ first: first.heartbeat_at, later: later.heartbeat_at }));
  void resolveVerify;
  cleanupTmp(ws);
}

console.log("\nI5 兼容：老 state.json（委派无心跳字段）仍走原安全网（引擎单测，不经插件）");
{
  const ws = mkTmp("iso-legacy-state");
  const e = createEngine(ws, {
    deliver: () => true,
    verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "passed", reason: "ok" }),
    log: () => {},
  });
  e.ensureLayout();
  const sid = `legacy-${RUN}`;
  e.start("loop", "老 state.json 兼容", sid);
  const instId = e.listInstances().at(-1).id;
  const st = e.readState(instId);
  st.delegations.push({ run_id: "legacy-orphan", check_index: 0, ts: new Date().toISOString() });
  fs.writeFileSync(statePathOf(ws, instId), JSON.stringify(st, null, 2));
  e.restore();
  const after = e.readState(instId);
  check("老格式孤儿委派 → fail-safe 暂停 check_infra 且清空委派",
    after.paused === true && after.pause_reason === "check_infra" && after.delegations.length === 0,
    JSON.stringify({ p: after.paused, r: after.pause_reason, d: after.delegations.length }));
  cleanupTmp(ws);
}

console.log("\nI6【负对照】把判据还原（心跳判活改成「无条件当孤儿」）→ 同一段用例必须判不通过");
{
  const legacy = buildPluginCopy({ "engine.ts": revertOrphanLivenessGuard }, "iso-reverted");
  try {
    const inproc = await runIsolationCase(legacy.entry, "inprocess");
    check("还原后（同进程）：别处一碰 ralphflow，A 就被踩停（paused + 委派被清 + 留下 orphan_delegation_recovered）",
      inproc.paused === true && inproc.stateTouched === true && inproc.recovered === true && inproc.delegations === 0,
      JSON.stringify({ touched: inproc.stateTouched, paused: inproc.paused, d: inproc.delegations, recovered: inproc.recovered }));
    check("还原后（同进程）：在飞验证白烧（判定被丢弃 → 实例没完成、没有报告）",
      inproc.verifyLanded === false && inproc.listOutput.includes("暂停"), inproc.listOutput.slice(0, 200));
    check("还原后（同进程）：**同一个判据** isolationHolds 为假 —— 新用例在旧行为上必然失败",
      isolationHolds(inproc) === false);
    cleanupTmp(inproc.ws);

    const cross = await runIsolationCase(legacy.entry, "crossprocess");
    check("还原后（跨进程，真实部署形状）：另一个进程碰一下同样把 A 踩停",
      cross.paused === true && cross.recovered === true && isolationHolds(cross) === false,
      JSON.stringify({ paused: cross.paused, recovered: cross.recovered, touched: cross.stateTouched }));
    cleanupTmp(cross.ws);
  } finally {
    legacy.cleanup();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
