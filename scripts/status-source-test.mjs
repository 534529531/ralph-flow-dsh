/** Exercise the actual dsh stream consumers; only the host opener is deterministic. */
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { RemoteStream } from "../node_modules/@deepseek-ai/dsh-api-gateway/lib/types/client/remote-stream.js";
import { RemoteSnapshotStream } from "../node_modules/@deepseek-ai/dsh-api-gateway/lib/types/client/snapshot-stream.js";
const bundle = await build({ entryPoints: ["src/client/status-source.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["@deepseek-ai/dsh-api-gateway/client"] });
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, AbortController, AbortSignal,
  require: () => ({ RemoteSnapshotStream }) });
const { createStatusSource } = module.exports;
let opened = 0, closed = 0, queues = [], lastSignal;
const status = (failures) => ({ id: "run", workflow: "loop", task: "验收", step: "a", stage: "executing", hint: "等待交卷",
  failures, maxFailures: 3, updatedAt: "now", report: null, steps: [], votes: [], recent: [] });
const frame = (kind, failures, sessionId = "owner") => ({ kind, sessionId, status: status(failures), error: null });
let latest = frame("snapshot", 0);
const ctx = { remote: {
  $stream: (options) => new RemoteStream({ generation: { getSnapshot: () => "host", subscribe: () => () => {} } }, options),
  ralphflowStatus: { async *watch(sid, signal) {
    assert.equal(sid, "owner"); assert(signal instanceof AbortSignal); lastSignal = signal;
    opened++;
    let wake; const pending = [];
    const queue = { push(value) { pending.push(value); wake?.(); } }; queues.push(queue);
    const abort = () => wake?.(); signal.addEventListener("abort", abort);
    try {
      yield latest;
      while (!signal.aborted) {
        if (!pending.length) await new Promise((resolve) => { wake = resolve; if (signal.aborted) resolve(); });
        wake = undefined;
        if (signal.aborted) return;
        if (pending.length) yield pending.shift();
      }
    } finally { signal.removeEventListener("abort", abort); closed++; }
  } },
} };
const source = createStatusSource(ctx, "owner");
const tick = () => new Promise((r) => setTimeout(r, 15));
assert.equal(opened, 0, "getSnapshot does not start IO");
source.getSnapshot(); assert.equal(opened, 0);
let first = 0, second = 0;
const off1 = source.subscribe(() => first++), off2 = source.subscribe(() => second++);
await tick(); assert.equal(opened, 1, "header and card share one opener");
assert.equal(source.getSnapshot().connection, "live");
const stable = source.getSnapshot();
queues.at(-1).push(frame("update", 0)); await tick();
assert.equal(source.getSnapshot(), stable, "unchanged values preserve snapshot identity");
queues.at(-1).push(frame("update", 1)); await tick(); assert.equal(source.getSnapshot().status.failures, 1);
off1(); const before = first;
queues.at(-1).push(frame("update", 2)); await tick(); assert.equal(first, before); assert(second > 0); assert.equal(closed, 0);
off2(); await tick(); assert(lastSignal.aborted); assert.equal(closed, 1);
latest = frame("snapshot", 3);
const off3 = source.subscribe(() => {}); await tick(); assert.equal(opened, 2); assert.equal(source.getSnapshot().status.failures, 3);
queues[0].push(frame("update", 0)); await tick(); assert.equal(source.getSnapshot().status.failures, 3, "late old opener cannot overwrite a new snapshot");
queues.at(-1).push(frame("update", 0, "wrong-session")); await tick();
assert.equal(source.getSnapshot().connection, "offline"); assert.equal(source.getSnapshot().status.failures, 3, "invalid Session frame preserves confirmed data");
off3(); source.dispose(); await tick(); assert.equal(closed, 2);
console.log("status source checks passed — native snapshot consumer, stable values, one lazy shared stream, last unsubscribe, stale generation and Session fences");
