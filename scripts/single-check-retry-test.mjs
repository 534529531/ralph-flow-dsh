/** Single check uses the voting recovery budget; verify actual state, UI and cancellation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createEngine } from "../lib/engine.js";
import { mkTmp, cleanupTmp } from "./helpers/plugin-harness.mjs";

const root = mkTmp("single-check-retry");
process.env.DSH_HOME = `${root}/isolated-home`;
const calls = [], notices = [], directives = [];
const engine = createEngine(root, {
  deliverDirective: (sid, text) => { directives.push({ sid, text }); return true; },
  deliverNotice: (sid, text, summary) => { notices.push({ sid, text, summary }); return true; },
  verify: (req) => {
    const p = Promise.withResolvers();
    calls.push({ req, ...p }); return p.promise;
  }, log() {},
});
const tick = () => new Promise(setImmediate);
const forRun = (id) => calls.filter((c) => c.req.instId === id);
function start(sid, workflow = "single") {
  const result = engine.start(workflow, sid, sid); assert(result.ok, result.text);
  assert(engine.onSubmit(sid, "交卷").ok);
  return engine.listInstances().find((item) => item.state.owner_session === sid).id;
}
async function answer(id, status) {
  const c = forRun(id).at(-1);
  c.resolve({ status, reason: `controlled ${status}`, check_index: c.req.checkIndex, step_id: c.req.step.id, ts: new Date().toISOString() });
  await tick();
}
try {
  engine.ensureLayout();
  for (const [name, max] of [["single", 3], ["limited", 1]]) {
    fs.writeFileSync(`${engine.workflowsDir}/${name}.yaml`, `manual_step: [a]\nsteps:\n  - id: a\n    desc: 单检查\n    do: 执行\n    input: 任务\n    output: 产物\n    check: 验收\n    on_pass: done\n    on_fail: a\n    max_fail_count: ${max}\n`);
  }
  // A successful automatic retry keeps the original submission and never sends another DO.
  {
    const id = start("recovered"), before = directives.length;
    assert.equal(engine.readState(id).delegations[0].attempt, 1);
    await answer(id, "infra");
    const state = engine.readState(id);
    assert.equal(forRun(id).length, 2);
    assert.equal(state.paused, false); assert.equal(state.fail_count, 0); assert.equal(state.do_submitted, true);
    assert.equal(state.delegations[0].attempt, 2);
    assert.equal(engine.uiStatus("recovered").status.stage, "verifying");
    assert.equal(engine.uiStatus("recovered").status.votes[0].status, "running", "old infra must not mask the new verifier");
    assert.equal(directives.length, before, "infrastructure recovery does not wake the executor");
    assert(notices.some((n) => n.sid === "recovered" && n.summary.includes("自动重试")));
    await answer(id, "passed");
    assert.equal(engine.uiStatus("recovered").status.stage, "gate");
    assert.equal(engine.uiStatus("recovered").status.votes[0].status, "passed");
    assert.equal(engine.readState(id).fail_count, 0);
    engine.cancelInstance("recovered");
  }
  // Exhaustion pauses, and an explicit continue renews exactly one automatic retry.
  {
    const id = start("exhausted");
    await answer(id, "infra"); await answer(id, "infra");
    assert.equal(forRun(id).length, 2);
    assert.equal(engine.readState(id).pause_reason, "check_infra");
    assert.equal(engine.readState(id).fail_count, 0);
    assert.equal(engine.uiStatus("exhausted").status.votes[0].status, "infra");
    assert(engine.continueInstance("exhausted").ok); await tick();
    assert.equal(forRun(id).length, 3);
    assert.equal(engine.readState(id).delegations[0].attempt, 1);
    await answer(id, "infra");
    assert.equal(forRun(id).length, 4);
    assert.equal(engine.readState(id).delegations[0].attempt, 2);
    await answer(id, "infra");
    assert.equal(forRun(id).length, 4, "no third automatic attempt");
    assert.equal(engine.readState(id).pause_reason, "check_infra");
    assert.equal(engine.readState(id).fail_count, 0);
    assert(engine.continueInstance("exhausted").ok); await tick();
    await answer(id, "passed");
    assert.equal(engine.uiStatus("exhausted").status.stage, "gate");
    engine.cancelInstance("exhausted");
  }
  // Real work failure consumes one failure, without an infrastructure retry.
  {
    const id = start("work-failed"); await answer(id, "failed");
    assert.equal(forRun(id).length, 1);
    assert.equal(engine.readState(id).fail_count, 1);
    assert.equal(engine.readState(id).do_submitted, false);
    assert.equal(engine.readState(id).paused, false);
    assert(engine.onSubmit("work-failed", "返工交卷").ok); await tick();
    assert.equal(engine.readState(id).delegations[0].attempt, 1);
    await answer(id, "infra"); await answer(id, "passed");
    assert.equal(engine.uiStatus("work-failed").status.stage, "gate");
    engine.cancelInstance("work-failed");
    const limited = start("work-limit", "limited"); await answer(limited, "infra"); await answer(limited, "failed");
    assert.equal(forRun(limited).length, 2);
    assert.equal(engine.readState(limited).fail_count, 1);
    assert.equal(engine.readState(limited).pause_reason, "max_failures");
    engine.cancelInstance("work-limit");
  }
  // Malformed results and thrown transport errors share the same bounded infra path.
  {
    const id = start("bad-result"); forRun(id).at(-1).resolve(undefined); await tick();
    assert.equal(forRun(id).length, 2);
    forRun(id).at(-1).reject(new Error("transport unavailable")); await tick();
    assert.equal(engine.readState(id).pause_reason, "check_infra");
    assert.equal(engine.readState(id).fail_count, 0);
    engine.cancelInstance("bad-result");
  }
  // Cancellation before or during retry rejects late outcomes without reviving the instance.
  for (const retryStarted of [false, true]) {
    const sid = `cancel-${retryStarted}`, id = start(sid);
    if (retryStarted) await answer(id, "infra");
    const count = forRun(id).length, active = forRun(id).at(-1);
    assert(engine.cancelInstance(sid).ok); assert(active.req.signal.aborted);
    await answer(id, "infra");
    assert.equal(engine.readState(id), null);
    assert.equal(forRun(id).length, count, "late infra cannot start another verifier");
  }
  console.log("single check retry checks passed — one automatic retry, pause/continue budget, UI, no executor wake, failures, invalid results, cancellation");
} finally {
  for (const { state } of engine.listInstances()) engine.cancelInstance(state.owner_session);
  cleanupTmp(root);
}
