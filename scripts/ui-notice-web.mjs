/** Real dsh web acceptance, including native spawn voters, reset and browser negative control.
 * Run after build: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/ui-notice-web.mjs
 * All host data and workspaces are isolated. No remote model requests are made.
 */
import fs from "node:fs";
import yaml from "js-yaml";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const VOTE_COUNT = yaml.load(fs.readFileSync(new URL("../workflows/loop.yaml", import.meta.url), "utf8")).steps[0].check_voting.length;
const voterNotice = new RegExp(`验证者 \\d+/${VOTE_COUNT}`);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "/home/yj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs");
const out = process.env.RALPHFLOW_UI_EVIDENCE_DIR ?? path.join(repo, "docs/v2/evidence/ui-notice");
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rf-notice-web-"));
const profile = path.join(root, "profiles/web"), workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });
fs.symlinkSync(process.env.RALPHFLOW_UI_PLUGIN_DIR ?? repo, path.join(profile, "node_modules/ralphflow-dsh"));
fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "notice-acceptance", private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ralphflow-dsh"] } } }));
fs.writeFileSync(path.join(profile, "cordis.yml"), "[]\n");
fs.writeFileSync(path.join(profile, "cordis.patch.yml"), `- id: agent-default-model\n  config:\n    provider: notice-fixture\n    model: notice\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: notice-web-fixture\n      name: ${path.join(repo, "scripts/helpers/notice-web-fixture.mjs")}\n`);
const workflows = path.join(workspace, ".dsh/ralph-flow/workflows");
fs.mkdirSync(workflows, { recursive: true });
for (const mode of ["pause", "gate"]) fs.writeFileSync(path.join(workflows, `ui-${mode}.yaml`),
  `description: 真机播报验收\n${mode === "gate" ? "manual_step: [only]\n" : ""}steps:\n  - id: only\n    desc: 真机步骤\n    do: 执行任务\n    input: 用户任务\n    output: 验收产物\n    check: 核对任务\n    on_pass: done\n    on_fail: only\n    max_fail_count: 1\n`);
const host = spawn("dsh", ["web", "--no-open", "--port", "0"], {
  cwd: workspace, env: { ...process.env, DSH_HOME: root, RALPHFLOW_WORKSPACE: workspace }, stdio: ["ignore", "pipe", "pipe"],
});
let log = "", browser, page;
host.stdout.on("data", (b) => { log += b; }); host.stderr.on("data", (b) => { log += b; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(80); }
  throw new Error(`timeout: ${label}`);
}
const versionCheck = spawnSync("dsh", ["--version"], { encoding: "utf8" });
assert.equal(versionCheck.status, 0, "acceptance must launch the selected dsh CLI");
const runtimeVersion = versionCheck.stdout.trim();
assert.equal(runtimeVersion, JSON.parse(fs.readFileSync(path.join(repo, "node_modules/@deepseek-ai/dsh/package.json"))).version,
  "CLI and test imports must come from the same dsh release");
const evidence = { runtime: `dsh ${runtimeVersion}`, controlled: "local model outputs; real AgentLoop, ToolRuntime, spawn, persistence, Chat DOM", runs: {} };
try {
  const authUrl = await until(() => log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], "web startup", 30000);
  const base = new URL(authUrl).origin;
  async function api(route) {
    const r = await fetch(`${base}/__notice/${route}`); const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value)); return value;
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/yj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome" });
  page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(authUrl);
  const welcome = page.getByRole("button", { name: "继续", exact: true });
  await welcome.waitFor(); await welcome.click();
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  async function select(mode) {
    const group = page.getByRole("treeitem", { name: /^未分组/ });
    if (await group.getAttribute("aria-expanded") === "false") await group.click();
    await page.getByRole("treeitem").filter({ hasText: `完成 UI_NOTICE_${mode.toUpperCase()}` }).click();
    await page.getByRole("tab", { name: "对话", exact: true }).click();
  }
  const notices = (state) => state.events.filter((e) => e.type === "user/message" && e.surfaceOp === "append"
    && e.data.source.kind === "ralphflow" && e.data.source.form === "notice");
  // This single assertion is also used against the SAME Session with the renderer removed.
  async function assertChatNotices(state, timeout = 5000) {
    assert.equal(await page.getByRole("tab", { name: "对话", exact: true }).getAttribute("aria-selected"), "true");
    for (const event of notices(state)) {
      const row = page.locator(`[data-ralphflow-notice="${event.seq}"] > summary`);
      await row.waitFor({ state: "visible", timeout });
      assert.equal(await row.innerText(), event.data.source.summary);
    }
    assert.equal(await page.locator("[data-ralphflow-notice]").count(), notices(state).length);
  }
  async function stateOf(sid) { return api(`status?sid=${sid}`); }
  function record(state) {
    return { status: state.status, inboxPending: state.inboxPending,
      events: state.events.filter((e) => ["turn/start", "turn/end"].includes(e.type)
        || (e.type === "user/message" && ["user", "ralphflow"].includes(e.data.source.kind))),
      summaries: notices(state).map((e) => ({ seq: e.seq, summary: e.data.source.summary })) };
  }
  const { sessionId: sid } = await api("start?mode=loop");
  await until(async () => { const s = await stateOf(sid); return s.pending.length === VOTE_COUNT && s.status === "idle" && s; }, "native voters, parent idle");
  console.log("web ready; native loop voters; parent idle");
  await select("loop");
  let state = await stateOf(sid); await assertChatNotices(state);
  const summary = page.locator("[data-ralphflow-notice] > summary").first();
  await summary.focus(); await page.keyboard.press("Enter");
  assert.equal(await summary.locator("..").getAttribute("open"), "");
  await page.keyboard.press("Enter");
  assert.equal(state.events.filter((e) => e.type === "turn/start").length, 1);
  assert.equal(state.inboxPending, false);
  await page.screenshot({ path: path.join(out, "loop-start.png") });
  const rounds = [];
  for (let i = 1; i <= VOTE_COUNT; i++) {
    await api("release?pass=false");
    state = await until(async () => { const s = await stateOf(sid); return notices(s).filter((e) => voterNotice.test(e.data.source.summary)).length >= i && s; }, `failed vote ${i}`);
    await assertChatNotices(state);
    if (i < VOTE_COUNT) { assert.equal(state.status, "idle"); assert.equal(state.events.filter((e) => e.type === "turn/start").length, 1); }
    rounds.push(record(state));
    console.log(`visible vote ${i}`);
  }
  state = await until(async () => { const s = await stateOf(sid); return s.holds === 1 && s; }, "reset and rework DO");
  await assertChatNotices(state);
  const rep = state.events.find((e) => typeof e.surfaceOp === "object" && e.surfaceOp.op === "replace");
  assert(rep);
  // Audit the exact DO-entry boundary using the real Session fold. The next pre-step can
  // add host runtime-context / skill-catalog snapshots; these are not part of the reset.
  const doEvent = state.events.find((e) => e.seq > rep.seq && e.type === "user/message" && JSON.stringify(e.data.content).includes("本步要做什么"));
  const prefix = state.events.filter((e) => e.seq <= doEvent.seq);
  const boundary = Session.create(sid, prefix, { version: SESSION_FORMAT_VERSION, id: sid, createdAt: 0, cwd: workspace, isSeeded: false }, 0);
  const boundaryMessages = boundary.deriveMessages();
  assert.equal(boundaryMessages.length, 3);
  const msgText = (m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.match(msgText(boundaryMessages[0]), /DeepSeek Harness/);
  assert.match(msgText(boundaryMessages[1]), /ralphflow 交接稿/);
  assert.match(msgText(boundaryMessages[2]), /本步要做什么/);
  assert(notices(state).some((e) => e.seq < rep.seq));
  await page.reload(); await assertChatNotices(state);
  console.log("reset model exact 3; historical notices visible after refresh");
  await page.screenshot({ path: path.join(out, "loop-reset-refreshed.png") });
  evidence.modelAfterReset = { count: 3, roles: boundaryMessages.map((m) => m.role), replaceSeq: rep.seq, doSeq: doEvent.seq,
    nextPreStepSources: state.messages.slice(3).map((m) => m.source.kind),
    beforeResetNotices: notices(state).filter((e) => e.seq < rep.seq).map((e) => e.seq) };
  await api("rework");
  await until(async () => { const s = await stateOf(sid); return s.pending.length === VOTE_COUNT && s.status === "idle"; }, "rework voters");
  for (let i = 1; i <= VOTE_COUNT; i++) {
    await api("release?pass=true");
    state = await until(async () => { const s = await stateOf(sid); return notices(s).filter((e) => voterNotice.test(e.data.source.summary)).length >= VOTE_COUNT + i && s; }, `pass vote ${i}`);
    await assertChatNotices(state);
    rounds.push(record(state));
    console.log(`visible vote ${i}`);
  }
  state = await until(async () => { const s = await stateOf(sid); return notices(s).some((e) => /工作流.*完成/.test(e.data.source.summary)) && s; }, "loop completion");
  await assertChatNotices(state); await page.reload(); await assertChatNotices(state);
  assert.equal(state.status, "idle"); assert.equal(state.inboxPending, false);
  assert.equal(state.events.filter((e) => e.type === "turn/start").length, 2);
  await page.screenshot({ path: path.join(out, "loop-complete-refreshed.png") });
  evidence.runs.loop = { sessionId: sid, rounds, final: record(state) };
  const providers = await api(`inspect?sid=${sid}`);
  const slotsProvider = providers.providers.find((p) => p.platform === "client" && p.id === "Slots");
  assert(slotsProvider.methods.some((m) => m.name === "listSubTree"));
  evidence.slots = await api(`inspect?sid=${sid}&query=${encodeURIComponent(JSON.stringify({ root: "conversation.chat.node" }))}`);
  assert.equal(evidence.slots.selected.occupants.filter((o) => o.key === "ralphflow-notice" && o.active).length, 1);
  // Browser negative control: suppress only our factory in the served combo, keep Session and host untouched.
  const storageState = await page.context().storageState();
  const bundle = fs.readFileSync(path.join(repo, "lib/client.js"), "utf8").trim();
  let stripped = 0;
  await page.route(/\/plugins\/.*\.js/, async (route) => {
    const response = await route.fetch(); let body = await response.text();
    if (body.includes(bundle)) {
      stripped++; body = body.replace(bundle, 'window.__ModuleLoader__.load({id:"ralphflow-dsh",factory:()=>({inject:[],apply(){}})});');
    }
    await route.fulfill({ response, body });
  });
  await page.reload();
  await page.getByRole("tab", { name: "对话", exact: true }).waitFor();
  assert(stripped > 0, "negative control must actually remove the published client factory");
  await assert.rejects(() => assertChatNotices(state, 1500), /Timeout/);
  assert.equal(await page.locator("[data-ralphflow-notice]").count(), 0);
  await page.screenshot({ path: path.join(out, "negative-without-client.png") });
  evidence.negative = { sameSessionId: sid, sameAssertionRejected: true, clientFactoriesRemoved: stripped, visibleNoticeRows: 0 };
  await page.unrouteAll({ behavior: "wait" }); await page.close();
  // The intercepted immutable bundle can be cached. A fresh context restores the real bundle
  // while retaining authentication and the exact selected Session from before the control.
  page = await browser.newPage({ storageState, locale: "zh-CN", viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base); await assertChatNotices(state);
  for (const mode of ["pause", "gate"]) {
    const { sessionId } = await api(`start?mode=${mode}`);
    await until(async () => (await stateOf(sessionId)).pending.length === 1, `${mode} voter`);
    await select(mode); await api(`release?pass=${mode === "gate"}`);
    const result = await until(async () => { const s = await stateOf(sessionId); return notices(s).some((e) => mode === "pause" ? /暂停/.test(e.data.source.summary) : /审查门/.test(e.data.source.summary)) && s; }, `${mode} notice`);
    await assertChatNotices(result); await page.reload(); await assertChatNotices(result);
    await page.screenshot({ path: path.join(out, `${mode}-refreshed.png`) });
    assert.equal(result.status, "idle"); assert.equal(result.inboxPending, false);
    evidence.runs[mode] = { sessionId, ...record(result) };
  }
  evidence.diskLogs = {};
  for (const [mode, run] of Object.entries(evidence.runs)) {
    const relative = fs.readdirSync(path.join(root, "sessions"), { recursive: true })
      .find((name) => name.endsWith(`${run.sessionId}/session.v4.jsonl.zstd`));
    assert(relative, "real Session persistence file must exist");
    const file = path.join(root, "sessions", relative);
    const expected = mode === "loop" ? run.final.summaries : run.summaries;
    const persisted = await until(() => {
      const r = spawnSync("zstd", ["-dc", file], { encoding: "utf8" });
      if (r.status !== 0) return false;
      const events = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
      const found = notices({ events });
      return found.length === expected.length && found;
    }, `${mode} append notices persisted`);
    assert.deepEqual(persisted.map((e) => ({ seq: e.seq, summary: e.data.source.summary })), expected);
    evidence.diskLogs[mode] = { path: file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      appendNotices: persisted.map((e) => ({ seq: e.seq, summary: e.data.source.summary })) };
  }
  assert.deepEqual(errors, []);
  fs.rmSync(path.join(out, "failure.png"), { force: true });
  evidence.result = "PASS: Chat rows per vote, aggregates, pause, gate, completion, reset+refresh, model exact 3, no wake, SAME DOM assertion red without client";
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(evidence.result);
  console.log(`Evidence: ${out}`);
} catch (error) {
  await page?.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  console.error((await page?.locator("body").innerText().catch(() => ""))?.slice(0, 1200));
  throw error;
} finally {
  await browser?.close(); host.kill("SIGTERM");
  // Preserve the isolated disk log for forensic replay; it never touches the user's ~/.dsh.
  fs.writeFileSync(path.join(out, "isolated-home.txt"), root + "\n");
}
