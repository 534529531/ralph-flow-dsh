/** Truthful read-only status projection, strict native contract, and stream lifetime. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Context } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { createEngine } from "../lib/engine.js";
import { WorkflowStatusService } from "../lib/status-service.js";
import { parseStatusFrame, statusDescriptors } from "../lib/status-contract.js";
import { TYPERT } from "../lib/typert.js";
import { mkTmp, cleanupTmp } from "./helpers/plugin-harness.mjs";

const root = mkTmp("status"), notes = [], pending = [];
process.env.DSH_HOME = `${root}/isolated-home`;
let publications = 0;
const engine = createEngine(root, {
  deliverDirective: () => true,
  deliverNotice: (sid, text, summary, options) => { notes.push({ sid, text, summary, options }); return true; },
  verify: (req) => new Promise((resolve) => pending.push({ req, resolve })),
  statusChanged: () => publications++, log() {},
});
const tick = () => new Promise((r) => setTimeout(r, 25));
const ui = (sid) => engine.uiStatus(sid);
function answer(status) {
  const p = pending.shift(); assert(p);
  p.resolve({ status, reason: `controlled ${status}`, check_index: p.req.checkIndex, step_id: p.req.step.id, ts: new Date().toISOString() });
}
try {
  assert.equal(ui("empty").status, null);
  assert.equal(fs.existsSync(engine.root), false, "read must not create layout");
  engine.ensureLayout();
  fs.writeFileSync(`${engine.workflowsDir}/status-test.yaml`, `manual_step: [a]\nsteps:\n  - id: a\n    desc: 实施\n    do: 执行\n    input: 任务\n    output: 产物\n    check_voting:\n      - check: 一\n      - check: 二\n    on_pass: done\n    on_fail: a\n    max_fail_count: 3\n`);
  assert(engine.start("status-test", "状态验收", "owner").ok);
  const id = engine.listInstances()[0].id;
  const file = `${engine.instanceDir(id)}/state.json`;
  const initial = fs.readFileSync(file, "utf8"), originalPublications = publications;
  assert.equal(ui("owner").status.stage, "executing");
  assert.equal(ui("other").status, null);
  assert.equal(fs.readFileSync(file, "utf8"), initial);
  assert.equal(publications, originalPublications);
  engine.onSubmit("owner", "交卷"); await tick();
  assert.equal(ui("owner").status.stage, "verifying");
  assert.equal(ui("owner").status.votes.length, 2);
  answer("failed"); await tick();
  assert.equal(ui("owner").status.failures, 0, "one returned failed vote is not an aggregate failure");
  assert.equal(ui("owner").status.votes[0].status, "failed");
  answer("failed"); await tick();
  assert.equal(ui("owner").status.failures, 1, "two failed votes consume one round");
  assert.equal(ui("owner").status.stage, "executing");
  // Ownership moves at an actual engine boundary; both views read their own binding.
  engine.continueInstance("other", id); await tick();
  assert.equal(ui("owner").status, null);
  assert.equal(ui("other").status.id, id);
  engine.onSubmit("other", "重交"); await tick();
  answer("passed"); answer("passed"); await tick();
  assert.equal(ui("other").status.stage, "gate");
  assert.equal(ui("other").status.failures, 0, "pass clears the current budget");
  assert.equal(ui("other").status.votes.every((v) => v.status === "passed"), true);
  const frame = { kind: "snapshot", sessionId: "other", ...ui("other") };
  assert.deepEqual(parseStatusFrame(frame), frame);
  assert.throws(() => parseStatusFrame({ ...frame, status: { ...frame.status, failures: -1 } }));
  assert.throws(() => parseStatusFrame({ ...frame, kind: "made-up" }));
  engine.continueInstance("other"); await tick();
  assert.equal(ui("other").status, null);
  const ref = notes.at(-1).options.uiRef;
  assert.equal(ref.ended, "done");
  assert.equal(engine.uiReport(ref).stage, "done");
  assert.equal(createEngine(root, { deliverDirective() {}, deliverNotice() {}, verify() {} }).uiReport(ref).id, id);
  assert.equal(engine.uiReport({ ...ref, reportRef: "../../etc/passwd" }), null);
  assert.equal(engine.uiReport({ ...ref, ended: "cancelled" }), null);
  assert.equal(engine.uiReport({ ...ref, runId: "../escape" }), null);
  // Failed writes publish an error, and the view keeps the last confirmed disk value.
  engine.start("status-test", "写盘故障", "write-error");
  const badId = engine.listInstances()[0].id;
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (String(to).includes(badId)) throw new Error("controlled disk failure"); return rename(from, to); };
    engine.onSubmit("write-error", "未落盘"); await tick();
    assert.equal(ui("write-error").status.stage, "executing");
    assert.match(ui("write-error").error, /写盘失败/);
  } finally { fs.renameSync = rename; }
  engine.cancelInstance("write-error"); await tick();
  assert.equal(notes.at(-1).options.uiRef.ended, "cancelled");
  pending.length = 0;
  engine.start("status-test", "基础设施故障", "infra");
  engine.onSubmit("infra", "交卷"); await tick();
  answer("passed"); answer("infra"); await tick();
  assert.equal(ui("infra").status.stage, "verifying");
  assert.equal(ui("infra").status.failures, 0);
  assert.equal(ui("infra").status.votes[0].status, "passed");
  assert.equal(ui("infra").status.votes[1].status, "running");
  answer("infra"); await tick();
  assert.equal(ui("infra").status.stage, "paused");
  assert.equal(ui("infra").status.failures, 0);
  assert.equal(ui("infra").status.votes[1].status, "infra");
  engine.continueInstance("infra"); await tick();
  assert.equal(ui("infra").status.votes[0].status, "passed");
  assert.equal(ui("infra").status.votes[1].status, "running");
  answer("passed"); await tick();
  assert.equal(ui("infra").status.stage, "gate");
  engine.cancelInstance("infra");
  fs.writeFileSync(`${engine.workflowsDir}/manual-status.yaml`, `manual_step: [review]\nsteps:\n  - id: review\n    desc: 人工审查\n    do: 执行\n    input: 任务\n    output: 产物\n    on_pass: done\n    on_fail: review\n    max_fail_count: 3\n`);
  engine.start("manual-status", "纯人工审查", "manual");
  engine.onSubmit("manual", "交卷"); await tick();
  assert.equal(ui("manual").status.stage, "gate", "a no-check manual gate must not display switching forever");
  assert.deepEqual(ui("manual").status.votes, []);
  assert.match(ui("manual").status.hint, /跳过对抗性验证/);
  engine.continueInstance("manual");
  assert.equal(notes.at(-1).options.uiRef.ended, "done");
  // A failed report archive retains a visible unavailable state, not a false completed card.
  engine.start("status-test", "归档故障", "archive-error");
  fs.rmSync(engine.reportsDir, { recursive: true }); fs.writeFileSync(engine.reportsDir, "blocked");
  engine.cancelInstance("archive-error");
  assert.equal(ui("archive-error").status.stage, "unavailable");
  assert.equal(notes.at(-1).options?.uiRef, undefined);

  const ctx = new Context();
  const registry = new TypertRegistry(ctx);
  registry.register(TYPERT);
  assert.equal(registry.local.get("ralphflowStatus/watch").mode, "stream");
  assert.equal(statusDescriptors[0].parameters[0].codec.typeSymbol, "@deepseek-ai/dsh-session/types#SessionId");
  const listeners = new Set(); let revision = 0, reads = 0;
  const service = new WorkflowStatusService(ctx, {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async read() { reads++; return { status: null, error: `revision ${revision}` }; },
  });
  const cancellation = new AbortController();
  const stream = service.watch({ id: "bound" }, cancellation.signal);
  assert.equal((await stream.next()).value.kind, "snapshot");
  revision++; for (const listener of listeners) listener();
  const update = (await stream.next()).value;
  assert.equal(update.sessionId, "bound"); assert.equal(update.error, "revision 1");
  assert.equal(update.kind, "update");
  const waiting = stream.next(); cancellation.abort();
  assert.equal((await waiting).done, true); assert.equal(listeners.size, 0);
  assert.equal(reads, 2, "no polling reads");
  // Context disposal must also terminate a blocked iterator.
  const again = service.watch({ id: "second" }, new AbortController().signal);
  await again.next(); const blocked = again.next();
  await ctx.fiber.dispose(); assert.equal((await blocked).done, true); assert.equal(listeners.size, 0);
  console.log("workflow status checks passed — status facts, round budget, owner fence, disk/archive failure, exact reports, strict native registry and stream disposal");
} finally { cleanupTmp(root); }
