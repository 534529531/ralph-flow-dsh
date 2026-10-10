/** Real dsh web acceptance for the refined status UI: one persistent location, conditional input prompt.
 * Run after build: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/ui-status-web.mjs
 * All host data and workspaces are isolated. No remote model requests are made.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const source = fs.readFileSync(path.join(repo, "src/client/status.tsx"), "utf8");
assert.doesNotMatch(source, /rgba?\(|#[0-9a-f]{3,8}\b|fontSize\s*:\s*\d|font-size\s*:\s*\d|borderRadius\s*:\s*\d|border-radius\s*:\s*\d|boxShadow\s*:\s*["']|box-shadow\s*:\s*(?!var\()[\d]/i,
  "colors, fonts, radii and shadows must come from native dsh tokens");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "/home/yj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs");
const out = path.join(repo, "docs/v2/evidence/ui-status-refine");
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rf-status-web-"));
const profile = path.join(root, "profiles/web"), workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });
fs.symlinkSync(repo, path.join(profile, "node_modules/ralphflow-dsh"));
fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "notice-acceptance", private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ralphflow-dsh"] } } }));
fs.writeFileSync(path.join(profile, "cordis.yml"), "[]\n");
fs.writeFileSync(path.join(profile, "cordis.patch.yml"), `- id: agent-default-model
  config:
    provider: notice-fixture
    model: notice
- id: session-title-llm
  disabled: true
- insert:
    - id: notice-web-fixture
      name: ${path.join(repo, "scripts/helpers/notice-web-fixture.mjs")}
`);
const workflows = path.join(workspace, ".dsh/ralph-flow/workflows");
fs.mkdirSync(workflows, { recursive: true });
for (const mode of ["pause", "gate"]) fs.writeFileSync(path.join(workflows, `ui-${mode}.yaml`),
  `description: 真机播报验收\n${mode === "gate" ? "manual_step: [only]\n" : ""}steps:\n  - id: only\n    desc: 真机步骤\n    do: 执行任务\n    input: 用户任务\n    output: 验收产物\n    check: 核对任务\n    on_pass: done\n    on_fail: only\n    max_fail_count: 1\n`);
let host = spawn("dsh", ["web", "--no-open", "--port", "0"], {
  cwd: workspace, env: { ...process.env, DSH_HOME: root, RALPHFLOW_WORKSPACE: workspace, RALPHFLOW_STATUS_LONG_CHAT: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
let log = "", browser, page;
host.stdout.on("data", (b) => { log += b; }); host.stderr.on("data", (b) => { log += b; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(80); }
  throw new Error(`timeout: ${label}`);
}
const sessionIds = {};
const evidence = { runtime: "dsh 0.2.1-alpha.1", controlled: "local model outputs; real AgentLoop, ToolRuntime, spawn, persistence, Chat DOM", runs: {} };
try {
  const authUrl = await until(() => log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], "web startup", 30000);
  const base = new URL(authUrl).origin;
  async function api(route) {
    const r = await fetch(`${base}/__notice/${route}`); const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value));
    if (route.startsWith("start?")) sessionIds[new URLSearchParams(route.split("?")[1]).get("mode")] = value.sessionId;
    return value;
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/yj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome" });
  page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 1100 } });
  let blockSockets = false;
  const sockets = new Set();
  await page.routeWebSocket(/\/api\/remote\.mux/, (socket) => {
    if (blockSockets) { void socket.close({ code: 1013, reason: "controlled offline" }); return; }
    const server = socket.connectToServer(); sockets.add({ socket, server });
  });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(authUrl);
  const welcome = page.getByRole("button", { name: "继续", exact: true });
  await welcome.waitFor(); await welcome.click();
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  async function select(mode) {
    const group = page.getByRole("treeitem", { name: /^未分组/ });
    if (await group.getAttribute("aria-expanded") === "false") await group.click();
    const more = page.getByText(/^展开其余 \d+ 个会话$/);
    if (await more.isVisible()) await more.click();
    await page.locator(`[data-row-key="session:${sessionIds[mode]}"]`).click();
    await page.getByRole("tab", { name: "对话", exact: true }).click();
  }
  /** Select an already-known Session id (used where no mode key exists, e.g. after a cold restart). */
  async function selectSession(sessionId) {
    const group = page.getByRole("treeitem", { name: /^未分组/ });
    await group.waitFor();
    if (await group.getAttribute("aria-expanded") === "false") await group.click();
    const more = page.getByText(/^展开其余 \d+ 个会话$/);
    if (await more.isVisible()) await more.click();
    await page.locator(`[data-row-key="session:${sessionId}"]`).click();
    await page.getByRole("tab", { name: "对话", exact: true }).click();
  }
  const notices = (state) => state.events.filter((e) => e.type === "user/message" && e.surfaceOp === "append"
    && e.data.source.kind === "ralphflow" && e.data.source.form === "notice");
  async function assertChatNotices(state, timeout = 5000) {
    assert.equal(await page.getByRole("tab", { name: "对话", exact: true }).getAttribute("aria-selected"), "true");
    for (const event of notices(state)) {
      const row = page.locator(`[data-ralphflow-notice="${event.seq}"] > summary`);
      await row.waitFor({ state: "visible", timeout });
      assert.equal(await row.innerText(), event.data.source.summary);
    }
    assert.equal(await page.locator("[data-ralphflow-notice]").count(), notices(state).length);
  }
  // The single persistent location: the header control carrying where / running-or-waiting.
  async function assertStatus(stage, timeout = 5000) {
    const control = page.locator(`[data-ralphflow-status][data-stage="${stage}"][data-connection="live"]`).first();
    await control.waitFor({ state: "visible", timeout });
    await assertExactlyOnePersistent();
    return control;
  }
  async function assertExactlyOnePersistent() {
    assert.equal(await page.locator("[data-ralphflow-status]").count(), 1, "exactly one persistent status location");
  }
  async function assertNoInputPlaceholder() {
    assert.equal(await page.locator("[data-ralphflow-status-action]").count(), 0, "input area must have no persistent placeholder");
  }
  async function assertPopoverText(text, timeout = 5000) {
    const popover = page.locator("[data-ralphflow-status-popover]");
    if (await popover.isVisible()) { await page.keyboard.press("Escape"); await popover.waitFor({ state: "hidden" }); }
    await page.locator("[data-ralphflow-status]").first().click();
    await popover.waitFor({ state: "visible", timeout });
    const needle = new RegExp(text);
    const deadline = Date.now() + timeout;
    let last = "";
    for (;;) {
      last = await popover.innerText();
      if (needle.test(last)) break;
      if (Date.now() >= deadline) {
        await page.keyboard.press("Escape").catch(() => {});
        throw new Error(`timeout: popover text ${text} (last: ${last.slice(0, 160)})`);
      }
      await pause(100);
    }
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
  }
  async function stateOf(sid) { return api(`status?sid=${sid}`); }
  function record(state) {
    return { status: state.status, inboxPending: state.inboxPending,
      events: state.events.filter((e) => ["turn/start", "turn/end"].includes(e.type)
        || (e.type === "user/message" && ["user", "ralphflow"].includes(e.data.source.kind))),
      summaries: notices(state).map((e) => ({ seq: e.seq, summary: e.data.source.summary })) };
  }
  const { sessionId: sid } = await api("start?mode=loop");
  await until(async () => { const s = await stateOf(sid); return s.pending.length === 4 && s.status === "idle" && s; }, "four native voters, parent idle");
  console.log("web ready; four native loop voters; parent idle");
  await select("loop");
  let state = await stateOf(sid); await assertChatNotices(state);
  // Criterion 1: exactly one persistent location, visible while the chat scrolls.
  await assertStatus("verifying");
  await assertExactlyOnePersistent();
  // Criterion 2: input area has zero persistent placeholder during verifying.
  await assertNoInputPlaceholder();
  await page.screenshot({ path: path.join(out, "input-empty-verifying.png") });
  // Criterion 6: the default display carries no internal budget (no 0/100).
  assert.doesNotMatch(await page.locator("[data-ralphflow-status]").first().innerText(), /0\s*\/\s*100/, "no internal n/m in the persistent display");
  // Both light and dark themes must paint opaque surfaces using actual native tokens.
  async function assertOpaque(selector) {
    const paint = await page.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, radius: style.borderRadius, shadow: style.boxShadow, fontSize: style.fontSize,
        token: style.getPropertyValue("--dsw-alias-bg-layer-2").trim() };
    });
    assert.match(paint.background, /^rgb\(/, "surface must be opaque, not rgba or transparent");
    assert(paint.token, "native opaque surface token exists");
    return paint;
  }
  // Criterion 5: the persistent control is bare text + dot, no container (jobs-trigger style).
  const controlBox = await page.locator("[data-ralphflow-status]").first().boundingBox();
  assert(controlBox && controlBox.height <= 40, "persistent control is a compact single line");
  // Details live in the on-demand popover, not a second persistent place.
  await assertPopoverText(/本轮验证 · 0\/4 已返回/);
  await page.locator("[data-ralphflow-status]").first().click();
  await page.getByRole("list", { name: "本轮验证 · 0/4 已返回" }).waitFor();
  evidence.theme = { light: { popover: await assertOpaque("[data-ralphflow-status-popover]") } };
  await page.screenshot({ path: path.join(out, "popover-votes.png") });
  assert.equal(await page.getByRole("list", { name: "本轮验证 · 0/4 已返回" }).locator("li").count(), 4);
  await page.keyboard.press("Escape");
  await page.locator("[data-ralphflow-status-popover]").waitFor({ state: "hidden" });
  const initialEvents = (await stateOf(sid)).events;
  assert.deepEqual(initialEvents, state.events, "viewing and expanding status must not append any Session event");
  assert.equal(initialEvents.filter((e) => e.type === "turn/start").length, 1);
  // Criterion 1 (scroll): the persistent location stays in the viewport while the chat scrolls.
  const scrolled = await page.locator("[data-ralphflow-notice]").first().evaluate((el) => {
    while (el && el.scrollHeight <= el.clientHeight + 50) el = el.parentElement;
    if (!el) return false;
    el.scrollTop = 0;
    return true;
  });
  assert(scrolled, "long Chat must have a scrollable region");
  const rect = await page.locator("[data-ralphflow-status]").first().boundingBox();
  assert(rect && rect.y >= 0 && rect.y + rect.height <= 1100, "persistent status stays in viewport while chat scrolls");
  await page.screenshot({ path: path.join(out, "persistent-header.png") });
  // Test-only interception of the real service's change notifications; opening snapshot remains intact.
  await api("status-stream?blocked=true");
  await page.reload(); await assertStatus("verifying");
  assert.equal((await api("status-stream?blocked=true")).subscriptions, 1, "header and dock share one stream");
  await api("release?pass=false");
  await until(async () => notices(await stateOf(sid)).some((e) => /验证者 \d+\/4/.test(e.data.source.summary)), "negative vote committed");
  await assert.rejects(() => assertPopoverText(/1\/4 已返回/, 1200), /timeout: popover text/);
  await assertPopoverText(/0\/4 已返回/);
  await page.screenshot({ path: path.join(out, "negative-without-push.png") });
  evidence.pushNegative = { openingSnapshotPresent: true, actualVoteCommitted: true, sameLiveAssertionRejected: true };
  await api("status-stream?blocked=false");
  await assertPopoverText(/1\/4 已返回/);
  console.log("real status control visible");
  const summary = page.locator("[data-ralphflow-notice] > summary").first();
  await summary.focus(); await page.keyboard.press("Enter");
  assert.equal(await summary.locator("..").getAttribute("open"), "");
  await page.keyboard.press("Enter");
  assert.equal(state.events.filter((e) => e.type === "turn/start").length, 1);
  assert.equal(state.inboxPending, false);
  await page.screenshot({ path: path.join(out, "loop-start.png") });
  const rounds = [];
  for (let i = 1; i <= 4; i++) {
    if (i === 2) {
      blockSockets = true;
      for (const { socket, server } of sockets) { await socket.close({ code: 1001 }); await server.close({ code: 1001 }); }
      await page.locator('[data-ralphflow-status][data-connection="offline"]').waitFor();
    }
    if (i > 1) await api("release?pass=false");
    state = await until(async () => { const s = await stateOf(sid); return notices(s).filter((e) => /验证者 \d+\/4/.test(e.data.source.summary)).length >= i && s; }, `failed vote ${i}`);
    if (i === 2) {
      assert.equal(await page.locator('[data-ralphflow-status][data-connection="offline"]').count(), 1, "offline marker");
      assert.match(await page.locator("[data-ralphflow-status]").first().innerText(), /同步中/);
      // The last confirmed value is retained and marked stale while the socket is down.
      await assertPopoverText(/1\/4 已返回/);
      await page.screenshot({ path: path.join(out, "disconnected-stale.png") });
      blockSockets = false;
      await assertPopoverText(/2\/4 已返回/, 15000);
      evidence.reconnect = { actualVoteChangedWhileDisconnected: true, staleMarked: true, fullSnapshotRestored: true };
    }
    await assertChatNotices(state);
    if (i < 4) await assertStatus("verifying");
    if (i < 4) await assertPopoverText(new RegExp(`${i}/4 已返回`));
    if (i < 4) { assert.equal(state.status, "idle"); assert.equal(state.events.filter((e) => e.type === "turn/start").length, 1); }
    rounds.push(record(state));
    console.log(`visible vote ${i}`);
  }
  state = await until(async () => { const s = await stateOf(sid); return s.holds === 1 && s; }, "reset and rework DO");
  await assertChatNotices(state); await assertStatus("executing");
  await assertNoInputPlaceholder();
  await page.screenshot({ path: path.join(out, "input-empty-executing.png") });
  assert.match(await page.locator("[data-ralphflow-status]").first().innerText(), /待交卷/);
  // The failure budget is an engine fact; the UI only surfaces n/m near the limit (criterion 6).
  const uiAfterReset = await api(`ui?sid=${sid}`);
  assert.equal(uiAfterReset.status.failures, 1);
  assert.equal(uiAfterReset.status.maxFailures, 100);
  assert.doesNotMatch(await page.locator("[data-ralphflow-status]").first().innerText(), /100/, "internal budget not in the default display");
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
  await page.reload(); await assertChatNotices(state); await assertStatus("executing");
  await assertNoInputPlaceholder();
  await page.screenshot({ path: path.join(out, "input-empty-executing.png") });
  console.log("reset model exact 3; historical notices visible after refresh");
  await page.screenshot({ path: path.join(out, "loop-reset-refreshed.png") });
  evidence.modelAfterReset = { count: 3, roles: boundaryMessages.map((m) => m.role), replaceSeq: rep.seq, doSeq: doEvent.seq,
    nextPreStepSources: state.messages.slice(3).map((m) => m.source.kind),
    beforeResetNotices: notices(state).filter((e) => e.seq < rep.seq).map((e) => e.seq) };
  await api("rework");
  await until(async () => { const s = await stateOf(sid); return s.pending.length === 4 && s.status === "idle"; }, "rework four voters");
  for (let i = 1; i <= 4; i++) {
    await api("release?pass=true");
    state = await until(async () => { const s = await stateOf(sid); return notices(s).filter((e) => /验证者 \d+\/4/.test(e.data.source.summary)).length >= 4 + i && s; }, `pass vote ${i}`);
    await assertChatNotices(state);
    if (i < 4) await assertStatus("verifying");
    if (i < 4) await assertPopoverText(new RegExp(`${i}/4 已返回`));
    rounds.push(record(state));
    console.log(`visible vote ${i}`);
  }
  state = await until(async () => { const s = await stateOf(sid); return notices(s).some((e) => /工作流.*完成/.test(e.data.source.summary)) && s; }, "loop completion");
  await assertChatNotices(state); await page.reload(); await assertChatNotices(state);
  // Criterion 4: terminal collapses to a minimal result marker; input area empty; report accessible.
  await assertStatus("done");
  assert.match(await page.locator("[data-ralphflow-status]").first().innerText(), /已完成/);
  await assertNoInputPlaceholder();
  const terminalRef = notices(state).at(-1).data.source.uiRef;
  assert.equal(terminalRef.ended, "done");
  // Criterion 4 + 6: the collapsed form keeps the exact archived report path, and no internal budget.
  await assertPopoverText(new RegExp(`报告：.*${terminalRef.reportRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(await page.locator("[data-ralphflow-status]").first().innerText(), /100/, "internal budget not in the terminal display");
  await page.screenshot({ path: path.join(out, "terminal-done.png") });
  evidence.terminal = terminalRef;
  assert.equal(state.status, "idle"); assert.equal(state.inboxPending, false);
  assert.equal(state.events.filter((e) => e.type === "turn/start").length, 2);
  await page.screenshot({ path: path.join(out, "loop-complete-refreshed.png") });
  evidence.runs.loop = { sessionId: sid, rounds, final: record(state) };
  const providers = await api(`inspect?sid=${sid}`);
  const slotsProvider = providers.providers.find((p) => p.platform === "client" && p.id === "Slots");
  assert(slotsProvider.methods.some((m) => m.name === "listSubTree"));
  evidence.slots = await api(`inspect?sid=${sid}&query=${encodeURIComponent(JSON.stringify({ root: "conversation.chat.node" }))}`);
  assert.equal(evidence.slots.selected.occupants.filter((o) => o.key === "ralphflow-notice" && o.active).length, 1);
  // Browser negative control 1: suppress only our factory in the served combo, keep Session and host untouched.
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
  await assert.rejects(() => assertStatus("done", 1200), /Timeout/);
  assert.equal(await page.locator("[data-ralphflow-notice]").count(), 0);
  await page.screenshot({ path: path.join(out, "negative-without-client.png") });
  evidence.negative = { sameSessionId: sid, sameStatusAssertionRejected: true, clientFactoriesRemoved: stripped, visibleStatusControls: await page.locator("[data-ralphflow-status]").count() };
  await page.unrouteAll({ behavior: "wait" }); await page.close();
  // The intercepted immutable bundle can be cached. A fresh context restores the real bundle
  // while retaining authentication and the exact selected Session from before the control.
  page = await browser.newPage({ storageState, locale: "zh-CN", viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base); await assertChatNotices(state); await assertStatus("done");
  for (const mode of ["pause", "gate"]) {
    const { sessionId } = await api(`start?mode=${mode}`);
    await until(async () => (await stateOf(sessionId)).pending.length === 1, `${mode} voter`);
    await select(mode); await api(`release?pass=${mode === "gate"}`);
    const result = await until(async () => { const s = await stateOf(sessionId); return notices(s).some((e) => mode === "pause" ? /暂停/.test(e.data.source.summary) : /审查门/.test(e.data.source.summary)) && s; }, `${mode} notice`);
    await assertChatNotices(result); await page.reload(); await assertChatNotices(result);
    await assertStatus(mode === "pause" ? "paused" : "gate");
    // Criterion 3: exactly one one-action prompt appears near the focus while the user must act.
    assert.equal(await page.locator("[data-ralphflow-status-action]").count(), 1, `${mode} shows exactly one action prompt`);
    assert.match(await page.locator("[data-ralphflow-status-action]").innerText(), mode === "pause" ? /失败已到上限/ : /等待你放行/);
    // Criterion 3: a single action, not a manual — one line, no command essay.
    const actionBox = await page.locator("[data-ralphflow-status-action]").boundingBox();
    assert(actionBox && actionBox.height <= 44, "action prompt is a single compact line");
    assert.equal(await page.locator("[data-ralphflow-status-action] code").count(), 1, "one obvious command");
    assert.match(await page.locator("[data-ralphflow-status-action]").innerText(), /输入 \/ralphflow-continue 继续/);
    await assertOpaque("[data-ralphflow-status-action]");
    await page.screenshot({ path: path.join(out, `${mode}-action.png`) });
    if (mode === "pause") {
      await api(`native-goal?sid=${sessionId}`);
      await page.locator("[data-goal-bar]").waitFor();
      await page.locator("[data-ralphflow-status]").click();
      await page.locator("[data-ralphflow-status-popover]").waitFor();
      // The real native job-list, goal strip, and our UI share this same Chat frame.
      await page.locator(".Hcm_Iq_trigger").waitFor();
      await page.screenshot({ path: path.join(out, "native-comparison-light.png") });
      await page.keyboard.press("Escape");
      await page.locator(".Hcm_Iq_trigger").click();
      await page.locator(".Hcm_Iq_menu").waitFor();
      await page.screenshot({ path: path.join(out, "native-jobs-light.png") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => document.body.setAttribute("data-ds-dark-theme", ""));
      await page.locator("[data-ralphflow-status]").click();
      await page.locator("[data-ralphflow-status-popover]").waitFor();
      evidence.theme.dark = { popover: await assertOpaque("[data-ralphflow-status-popover]"), action: await assertOpaque("[data-ralphflow-status-action]") };
      assert.notEqual(evidence.theme.dark.popover.background, evidence.theme.light.popover.background, "native dark theme actually changes surface paint");
      await page.screenshot({ path: path.join(out, "native-comparison-dark.png") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => document.body.removeAttribute("data-ds-dark-theme"));
      await api(`native-goal-clear?sid=${sessionId}`);
      await page.locator("[data-goal-bar]").waitFor({ state: "hidden" });
    }
    assert.equal(result.status, "idle"); assert.equal(result.inboxPending, false);
    evidence.runs[mode] = { sessionId, ...record(result) };
  }
  // Native approval takes over the input area; the persistent header must still open details.
  await api(`approval?sid=${evidence.runs.gate.sessionId}`);
  await page.getByText("UI_STATUS_APPROVAL：验证审批接管时页头工作流状态入口", { exact: false }).first().waitFor();
  await page.locator("[data-ralphflow-status]").first().click();
  await page.locator("[data-ralphflow-status-popover]").waitFor();
  await page.screenshot({ path: path.join(out, "approval-header.png") });
  await page.keyboard.press("Escape");
  await api("approval-cancel");
  await until(async () => (await stateOf(evidence.runs.gate.sessionId)).status === "idle", "approval withdrawn");
  evidence.approval = { nativeApprovalRequest: true, headerOpensStatusDuringTakeover: true };
  // Terminal fork inherits the log, but must not inherit a workflow/report card.
  const fork = await api(`fork?sid=${sid}`);
  await page.getByRole("treeitem").filter({ hasText: "UI_STATUS_FORK" }).click();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await until(async () => (await api(`ui?sid=${fork.sessionId}`)).status === null, "fork has no status");
  await pause(300); assert.equal(await page.locator("[data-ralphflow-status]").count(), 0);
  assert.equal((await api("status-stream?blocked=false")).subscriptions, 1);
  // Criterion 7: a session with no workflow shows no empty shell.
  const empty = await api("empty");
  await page.getByRole("treeitem").filter({ hasText: "UI_STATUS_EMPTY" }).click();
  await pause(300); assert.equal(await page.locator("[data-ralphflow-status]").count(), 0);
  await assertNoInputPlaceholder();
  assert.equal((await api(`ui?sid=${empty.sessionId}`)).status, null);
  const gateSid = evidence.runs.gate.sessionId;
  const gateId = (await api(`ui?sid=${gateSid}`)).status.id;
  await api(`action?sid=${empty.sessionId}&name=ralphflow_continue&instance=${gateId}`);
  await until(async () => (await api(`ui?sid=${empty.sessionId}`)).status?.stage === "done", "new owner adopted and gate released");
  await assertStatus("done");
  // Criterion 3 (removal): the action prompt withdraws once the gate is handled.
  assert.equal(await page.locator("[data-ralphflow-status-action]").count(), 0, "action prompt withdraws after handling");
  await select("gate"); await pause(300);
  assert.equal(await page.locator("[data-ralphflow-status]").count(), 0, "old owner clears its card");
  await page.getByRole("treeitem").filter({ hasText: "UI_STATUS_EMPTY" }).click();
  await assertStatus("done"); await page.reload(); await assertStatus("done");
  // Criterion 4 (refresh): the terminal result and its exact report path stay retrievable.
  // The new owner adopted the gate run, so its own archived report is the one it must show.
  const adopted = await api(`ui?sid=${empty.sessionId}`);
  assert(adopted.status.report, "new owner keeps an exact report path after refresh");
  await assertPopoverText(new RegExp(`报告：.*${adopted.status.report.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await select("pause");
  await assertStatus("paused");
  await api(`action?sid=${evidence.runs.pause.sessionId}&name=ralphflow_cancel`);
  // Criterion 4: cancelled also collapses to a minimal marker.
  await assertStatus("cancelled");
  assert.match(await page.locator("[data-ralphflow-status]").first().innerText(), /已取消/);
  await assertNoInputPlaceholder();
  await page.reload(); await assertStatus("cancelled");
  evidence.isolation = { empty: empty.sessionId, fork: fork.sessionId, inheritedTerminalHidden: true,
    ownerTransferClearedOldCard: true, gateReleased: true, cancellationSurvivesRefresh: true };
  evidence.diskLogs = {};
  for (const [mode, run] of Object.entries(evidence.runs).filter(([mode]) => mode === "loop")) {
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
  const cancelledSid = evidence.runs.pause.sessionId;
  const pausedRestart = await api("start?mode=pause");
  await until(async () => (await stateOf(pausedRestart.sessionId)).pending.length === 1, "paused restart voter");
  await api("release?pass=false"); await select("pause"); await assertStatus("paused");
  // Close the page: shared UI source releases its sole server listener.
  await page.close();
  await until(async () => (await api("status-stream?blocked=false")).subscriptions === 0, "last unsubscribe releases host stream");
  host.kill("SIGTERM");
  await new Promise((resolve) => host.once("exit", resolve));
  log = "";
  host = spawn("dsh", ["web", "--no-open", "--port", "0"], { cwd: workspace,
    env: { ...process.env, DSH_HOME: root, RALPHFLOW_WORKSPACE: workspace }, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", (b) => { log += b; }); host.stderr.on("data", (b) => { log += b; });
  const restartedUrl = await until(() => log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], "cold host restart", 30000);
  page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(restartedUrl);
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  await select("loop"); await assertStatus("done");
  await select("pause"); await assertStatus("paused");
  await page.screenshot({ path: path.join(out, "paused-cold-restart.png") });
  await page.locator(`[data-row-key="session:${cancelledSid}"]`).click();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await assertStatus("cancelled");
  await page.screenshot({ path: path.join(out, "cancelled-cold-restart.png") });
  evidence.coldRestart = { completionRestored: true, cancellationRestored: true, activePauseRestored: true, releaseOnLastUnsubscribe: true };  // Browser negative control 3: remove only the persistent location; the "exactly one" assertion must fail.
  const storageState2 = await page.context().storageState();
  let removedPersistent = 0, neutralized = 0;
  await page.route(/\/plugins\/.*\.js/, async (route) => {
    const response = await route.fetch(); let body = await response.text();
    if (body.includes(bundle)) {
      removedPersistent++;
      const patched = body.replace("}, WorkflowStatusControl));", "}, () => null));");
      if (patched !== body) neutralized++;
      body = patched;
    }
    await route.fulfill({ response, body });
  });
  await page.reload();
  await page.getByRole("tab", { name: "对话", exact: true }).waitFor();
  assert(removedPersistent > 0 && neutralized > 0, "negative control must actually neutralize the persistent location renderer");
  await assert.rejects(() => assertExactlyOnePersistent(), /exactly one persistent status location/);
  // The conditional prompt is a separate component, so it must also vanish with the persistent one for this terminal session.
  assert.equal(await page.locator("[data-ralphflow-status-action]").count(), 0);
  await page.screenshot({ path: path.join(out, "negative-without-persistent.png") });
  evidence.negativePersistent = { sameSessionId: cancelledSid, exactlyOneRejected: true, persistentRenderersNeutralized: neutralized };
  await page.unrouteAll({ behavior: "wait" }); await page.close();
  page = await browser.newPage({ storageState: storageState2, locale: "zh-CN", viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  // The cold restart spawned a new port; restore the real bundle on that exact host.
  await page.goto(restartedUrl);
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  await selectSession(cancelledSid);
  await assertStatus("cancelled");
  // Criterion 4: after the persistent location is restored, the terminal form comes back intact.
  assert.match(await page.locator("[data-ralphflow-status]").first().innerText(), /已取消/);
  await assertNoInputPlaceholder();
  await assertExactlyOnePersistent();
  assert.deepEqual(errors, []);
  fs.rmSync(path.join(out, "failure.png"), { force: true });
  evidence.result = "PASS: real Chat status, one persistent header location, conditional input prompt, native votes, one failure per round, reset, refresh, pause/gate, completion/cancel, empty/fork/owner isolation, disconnect/reconnect, native approval, cold host restart, one shared stream, no wake, three negative controls (client, push, persistent location)";
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(evidence.result);
  console.log(`Evidence: ${out}`);
} catch (error) {
  await page?.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  console.error(log.slice(-7000).replace(/token=[^\s&]+/g, "token=REDACTED"));
  console.error((await page?.locator("body").innerText().catch(() => ""))?.slice(0, 1200));
  throw error;
} finally {
  await browser?.close(); host.kill("SIGTERM");
  // Preserve the isolated disk log for forensic replay; it never touches the user's ~/.dsh.
  fs.writeFileSync(path.join(out, "isolated-home.txt"), root + "\n");
}
