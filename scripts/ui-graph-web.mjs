/** Real dsh web acceptance for the read-only Graph viewer and Graph status projection.
 * Run after build: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/ui-graph-web.mjs
 * All host data/workspaces are isolated; the model is a local fixture (no remote requests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "/home/yj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs");
const out = process.env.RALPHFLOW_GRAPH_UI_EVIDENCE_DIR ?? path.join(repo, "docs/v2/evidence/graph-mode");
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rf-graph-web-"));
const profile = path.join(root, "profiles/web"), workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
for (const pkg of ["ralphflow-dsh", "@deepseek-ai/dsh-client-ui-sidebar-right"]) {
  const target = pkg === "ralphflow-dsh" ? repo : path.join(repo, "node_modules", pkg);
  const link = path.join(profile, "node_modules", pkg);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
}
fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "graph-viewer-acceptance", private: true,
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
fs.mkdirSync(path.join(workspace, ".dsh/ralph-flow/graphs"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".dsh/ralph-flow/graphs/status-graph.yaml"), `kind: graph
description: 查看器与状态面的真机 Graph 示例
steps:
  - id: inspect
    desc: 检查仓库
    do: 检查仓库结构并写出结论。
    output: inspect.md
    check: |
      1. inspect.md 存在且非空
`);

const host = spawn("dsh", ["web", "--no-open", "--port", "0"], {
  cwd: workspace,
  env: { ...process.env, DSH_HOME: root, RALPHFLOW_GRAPH_ARTIFACT: "1", RALPHFLOW_GRAPH_UI_HOLD: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
host.stdout.on("data", (b) => { log += b; });
host.stderr.on("data", (b) => { log += b; if (process.env.RALPHFLOW_GRAPH_UI_DEBUG) process.stderr.write(b); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page;
const evidence = { runtime: "dsh web", controlled: "local fixture model; real host, real Graph engine, real client bundle", checks: [] };
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(100); }
  throw new Error(`timeout: ${label}\n${log.slice(-2000)}`);
}
try {
  const url = await until(() => log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], "web startup", 40000);
  const base = new URL(url).origin;
  const created = await (await fetch(`${base}/__notice/graph`)).json();
  assert.equal(typeof created.sessionId, "string");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/yj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome" });
  page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 1000 } });
  if (process.env.RALPHFLOW_UI_DARK) await page.emulateMedia({ colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // 关掉宿主弹窗（首次是作者引导，刷新后可能是「预览版说明」）：遮罩会挡住侧栏。
  const dismissDialog = async () => {
    const dialog = page.locator('[role="dialog"]').first();
    if (!await dialog.isVisible().catch(() => false)) return false;
    const cont = dialog.getByRole("button", { name: /继续|开始使用|知道了|关闭/ }).first();
    if (await cont.isVisible().catch(() => false)) await cont.click({ timeout: 3000 }).catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
    await pause(400);
    return true;
  };
  const clickWhenFree = async (locator) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await locator.click({ timeout: 4000 }); return; } catch (error) {
        if (!await dismissDialog()) { await pause(400); if (attempt === 4) throw error; }
      }
    }
  };

  // 首次进入与刷新后进入走同一段：作者引导 / 预览说明可能已经消费过，也可能晚一步再弹。
  const enterSession = async () => {
    const ready = page.locator("button").filter({ hasText: "新会话" })
      .or(page.getByRole("button", { name: "继续", exact: true }));
    await ready.first().waitFor({ timeout: 30000 }).catch(async (error) => {
      console.error("PAGE TEXT:", (await page.locator("body").innerText().catch(() => "")).slice(0, 2000));
      console.error("HOST LOG:", log.slice(-3000));
      throw error;
    });
    await pause(800);
    for (let index = 0; index < 4; index++) { if (!await dismissDialog()) break; }
    await page.locator("button").filter({ hasText: "新会话" }).waitFor({ timeout: 20000 });
    await pause(600);
    const group = page.getByRole("treeitem", { name: /^未分组/ });
    await group.waitFor({ state: "visible" });
    if (await group.getAttribute("aria-expanded") === "false") await clickWhenFree(group);
    const row = page.locator(`[data-row-key="session:${created.sessionId}"]`);
    await row.waitFor({ state: "visible", timeout: 20000 });
    await clickWhenFree(row);
    await clickWhenFree(page.getByRole("tab", { name: "对话", exact: true }));
  };

  await page.goto(url);
  await enterSession();

  const viewer = page.locator("[data-ralphflow-viewer]");
  // 右侧栏可能收起或回到引导页：确认栏开、按需打开只读工作图 tab。
  const openViewer = async () => {
    if (!await page.locator("[data-sidebar-right-open]").isVisible().catch(() => false)) {
      await page.locator("[data-sidebar-right-expand]").click({ timeout: 5000 }).catch(() => {});
      await page.locator("[data-sidebar-right-open]").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    }
    if (await viewer.isVisible().catch(() => false)) return true;
    const guideButton = page.getByRole("button", { name: /RalphFlow 工作图/ });
    if (await guideButton.isVisible().catch(() => false)) await guideButton.click({ timeout: 5000 }).catch(() => {});
    return viewer.isVisible().catch(() => false);
  };

  // 趁节点还在飞先看阶段：查看器卡片必须分得出 DO 与 CHECK（fixture 在交卷/出判定前挂住）。
  await until(openViewer, "只读工作图", 30000);
  await viewer.getByText("status-graph", { exact: false }).first().waitFor({ state: "visible" });
  const nodeChips = async () => (await viewer.locator('[data-ralphflow-node="inspect"] .rv-chip').allInnerTexts()).map((text) => text.trim());
  // 受控挂起的放行口是 /__notice/rework（/__notice/release 是放行一张验证票）。
  const resume = () => fetch(`${base}/__notice/rework`);

  await until(async () => (await nodeChips()).some((text) => text.includes("DO · 执行中")), "DO 阶段芯片");
  const pauseDock = page.locator("[data-ralphflow-status-pause]");
  await pauseDock.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await pauseDock.innerText(), /暂停/);
  evidence.graphPauseDock = await pauseDock.innerText();
  const doingChips = await nodeChips();
  assert.ok(doingChips.some((text) => text.includes("CHECK · 待验证")), `DO 阶段要带 CHECK 待验证：${JSON.stringify(doingChips)}`);
  assert.ok(doingChips.every((text) => !text.includes("CHECK · 验证中")), `DO 阶段不能写验证中：${JSON.stringify(doingChips)}`);
  await page.screenshot({ path: path.join(out, "viewer-phase-do.png"), fullPage: true });
  evidence.phaseDoScreenshot = "viewer-phase-do.png";
  evidence.checks.push(`DO 阶段在卡片上可分辨：${JSON.stringify(doingChips)}`);

  // 工作流在跑时：下拉里只有一个「运行中」，手动切走的资产不会被强行拽回。
  await page.getByRole("button", { name: "选择工作流" }).click();
  const menuItems = await page.getByRole("menuitem").allInnerTexts();
  const runningItems = menuItems.filter((text) => text.includes("运行中"));
  assert.equal(runningItems.length, 1, `下拉只该标一个运行中：${JSON.stringify(menuItems)}`);
  assert.match(runningItems[0], /status-graph/);
  await page.getByRole("menuitem", { name: /^codewiki ·/ }).click();
  await viewer.getByText("codewiki", { exact: false }).first().waitFor({ state: "visible" });
  assert.equal(await viewer.locator('[data-ralphflow-node="inspect"]').count(), 0, "切到 codewiki 后不该还显示 status-graph 的节点");
  assert.match(await viewer.locator(".rv-head .rv-meta").innerText(), /运行中：status-graph/, "浏览别的资产时要点出运行中的是哪个");
  evidence.checks.push("运行中：下拉标出唯一运行中的工作流；手动可以切走；表头点明运行中的是哪个");

  // 重开页面：跑着的那个优先于上次浏览偏好（localStorage 记的是刚点过的 codewiki）。
  await page.reload();
  await enterSession();
  await until(openViewer, "重开页面后的只读工作图", 30000);
  await viewer.getByText("status-graph", { exact: false }).first().waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await viewer.locator('[data-ralphflow-node="inspect"]').count(), 1, "重开页面后应回到运行中的 status-graph");
  assert.match(await viewer.locator(".rv-head .rv-title").innerText(), /status-graph/);
  evidence.checks.push("重开页面后工作图回到运行中的工作流（不被上次浏览偏好覆盖）");
  await page.screenshot({ path: path.join(out, "viewer-running-default.png"), fullPage: true });
  evidence.runningDefaultScreenshot = "viewer-running-default.png";
  await until(async () => (await nodeChips()).some((text) => text.includes("DO · 执行中")), "重开页面后的 DO 阶段芯片");

  await resume();
  await until(async () => (await nodeChips()).some((text) => text.includes("CHECK · 验证中")), "CHECK 阶段芯片");
  const checkingChips = await nodeChips();
  assert.ok(checkingChips.some((text) => text.includes("DO · 已交卷")), `CHECK 阶段要带 DO 已交卷：${JSON.stringify(checkingChips)}`);
  await page.screenshot({ path: path.join(out, "viewer-phase-check.png"), fullPage: true });
  evidence.phaseCheckScreenshot = "viewer-phase-check.png";
  evidence.checks.push(`CHECK 阶段在卡片上可分辨：${JSON.stringify(checkingChips)}`);

  // 在飞色必须是有彩色：夜间模式下工作图不能退化成纯黑白。
  const probeTone = async (scheme) => {
    if (scheme) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction((isDark) => document.body.hasAttribute("data-ds-dark-theme") === isDark, scheme === "dark", { timeout: 10000 });
    }
    return page.evaluate(() => {
      const host = document.querySelector("[data-ralphflow-viewer]");
      const probe = document.createElement("span");
      probe.className = "rv-chip";
      probe.dataset.tone = "run";
      host.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      const channels = color.match(/\d+/g).map(Number);
      return { color, spread: Math.max(...channels) - Math.min(...channels), dark: document.body.hasAttribute("data-ds-dark-theme") };
    });
  };
  const lightTone = await probeTone("light");
  const darkTone = await probeTone("dark");
  assert.ok(lightTone.spread >= 40, `浅色在飞色要有彩度：${JSON.stringify(lightTone)}`);
  assert.equal(darkTone.dark, true, "夜间主题必须真的生效");
  assert.ok(darkTone.spread >= 40, `夜间在飞色不能是黑白：${JSON.stringify(darkTone)}`);
  evidence.toneProbe = { light: lightTone, dark: darkTone };
  evidence.checks.push(`在飞色明暗都有彩度：${lightTone.color} / ${darkTone.color}`);
  await page.screenshot({ path: path.join(out, "viewer-phase-dark.png"), fullPage: true });
  evidence.darkScreenshot = "viewer-phase-dark.png";
  await probeTone(process.env.RALPHFLOW_UI_DARK ? "dark" : "light");

  await resume();
  const done = page.locator('[data-ralphflow-status][data-stage="done"][data-connection="live"]').first();
  await done.waitFor({ state: "visible", timeout: 45000 }).catch(async (error) => {
    console.error("UI:", JSON.stringify(await (await fetch(`${base}/__notice/ui?sid=${created.sessionId}`)).json()).slice(0, 3000));
    for (const file of fs.readdirSync(path.join(workspace, ".dsh/ralph-flow/instances"), { withFileTypes: true })) {
      if (!file.isDirectory()) continue;
      const state = JSON.parse(fs.readFileSync(path.join(workspace, ".dsh/ralph-flow/instances", file.name, "state.json"), "utf8"));
      if (state.kind === "graph") console.error("STATE:", JSON.stringify({ id: file.name, status: state.graph.status, reason: state.graph.pause_reason, attempts: state.graph.attempts.map((a) => ({ s: a.status, f: a.failure })), verdicts: state.graph.verdicts.map((v) => v.status), history: state.history.slice(-8).map((h) => h.event) }));
    }
    throw error;
  });
  evidence.checks.push("Graph 状态面在真实页面上到达 done");
  assert.match(await done.innerText(), /已完成/);
  // 节点 agent 是 owner 会话的直接子会话：引擎补一条 subagent/catalog，
  // 顶部「子智能体」监控才会把它列出来并可打开（走 agents.create 不会自动写这条）。
  const sessionState = await (await fetch(`${base}/__notice/state?sid=${created.sessionId}`)).json();
  const catalog = (sessionState.events ?? []).filter((event) => event.type === "subagent/catalog").map((event) => event.data);
  assert.ok(catalog.some((entry) => entry.mode === "one-shot" && String(entry.label).startsWith("Graph 节点 ")),
    `node agent must be announced in the subagent catalog: ${JSON.stringify(catalog)}`);
  evidence.checks.push("节点 agent 出现在宿主子智能体 catalog（顶部监控可见）");
  await done.click();
  const popover = page.locator("[data-ralphflow-status-popover]");
  await popover.waitFor({ state: "visible" });
  const popoverText = await popover.innerText();
  assert.match(popoverText, /inspect/);
  assert.match(popoverText, /已完成/);
  evidence.checks.push("状态弹层显示 Graph 节点与完成计数");
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" }).catch(() => {});

  // Graph 默认是列表：DAG 画布要横向滚动，不该是打开时的第一屏。
  await viewer.locator("[data-ralphflow-outline]").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await viewer.locator("[data-ralphflow-dag]").count(), 0, "graph should default to the outline list");
  // 跑完之后卡片要收在「已完成 + CHECK 已通过」，而不是退回笼统的静态标签。
  const doneChips = await nodeChips();
  assert.ok(doneChips.some((text) => text.includes("已完成")) && doneChips.some((text) => text.includes("CHECK · 已通过")), `done 节点芯片：${JSON.stringify(doneChips)}`);
  evidence.checks.push(`完成节点芯片：${JSON.stringify(doneChips)}`);
  await page.screenshot({ path: path.join(out, "viewer-outline.png"), fullPage: true });
  evidence.outlineScreenshot = "viewer-outline.png";
  await viewer.getByRole("button", { name: "图", exact: true }).click();
  await viewer.locator('[data-ralphflow-dag]').waitFor({ state: "visible", timeout: 10000 });
  await page.screenshot({ path: path.join(out, "viewer-graph.png"), fullPage: true });
  evidence.graphScreenshot = "viewer-graph.png";
  await page.getByRole("button", { name: "选择工作流" }).click();
  await page.screenshot({ path: path.join(out, "viewer-picker.png"), fullPage: true });
  evidence.pickerScreenshot = "viewer-picker.png";
  await page.getByRole("menuitem", { name: /^codewiki ·/ }).click();
  await viewer.locator('[data-ralphflow-dag]').waitFor({ state: "visible", timeout: 10000 });
  await page.screenshot({ path: path.join(out, "viewer-codewiki.png"), fullPage: true });
  evidence.codewikiScreenshot = "viewer-codewiki.png";
  // 长 DO 的详情必须能滚动到底：inspector 若是滚动容器（overflow:hidden），
  // grid 轨道会塌成面板高度、剩余内容被裁掉，页面上看不出还能滚。
  await viewer.locator('[data-ralphflow-node="survey"]').click();
  await viewer.locator("[data-ralphflow-inspector]").waitFor({ state: "visible" });
  const detail = await viewer.evaluate((el) => ({ clientH: el.clientHeight, scrollH: el.scrollHeight }));
  assert.ok(detail.scrollH > detail.clientH, `long inspector should scroll: ${JSON.stringify(detail)}`);
  await viewer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  assert.ok(await viewer.evaluate((el) => el.scrollTop) > 0, "long inspector must reach the bottom");
  await page.screenshot({ path: path.join(out, "viewer-inspector-bottom.png"), fullPage: true });
  await viewer.getByRole("button", { name: "返回工作图" }).click();
  assert.equal(await viewer.evaluate((el) => el.scrollTop), 0, "closing the detail returns to the top");
  evidence.checks.push("长 DO 详情能滚动到底，返回后回到顶部");
  await viewer.locator('[data-ralphflow-dag]').waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "选择工作流" }).click();
  await page.getByRole("menuitem", { name: /^spec ·/ }).click();
  await viewer.locator('[data-ralphflow-step="explore"]').waitFor({ state: "visible", timeout: 10000 });
  await page.screenshot({ path: path.join(out, "viewer-flow.png"), fullPage: true });
  evidence.flowScreenshot = "viewer-flow.png";
  // loop 是三票投票步：详情里必须逐条列出每票的检查依据，不能只写「投票 3 票」。
  await page.getByRole("button", { name: "选择工作流" }).click();
  await page.getByRole("menuitem", { name: /^loop ·/ }).click();
  // 状态流在刷新后仍会推帧，卡片可能刚好在重渲染：给它一点落定时间再点。
  const loopStep = viewer.locator('[data-ralphflow-step="loop"]');
  await loopStep.waitFor({ state: "visible", timeout: 10000 });
  await pause(400);
  await loopStep.click({ timeout: 15000 });
  await viewer.locator("[data-ralphflow-step-inspector] .rv-check").first().waitFor({ state: "visible" });
  const criteria = await viewer.locator("[data-ralphflow-step-inspector] .rv-check pre").allInnerTexts();
  assert.equal(criteria.length, 3, `loop should show all three criteria: ${JSON.stringify(criteria)}`);
  assert.match(criteria[0], /用户任务的每一条要求都已落实/);
  assert.match(criteria[1], /实现的行为和实际产出符合预期/);
  assert.match(criteria[2], /修改不影响原有功能和既有约定/);
  evidence.checks.push("loop 的 3 票检查依据在步骤详情里逐条可见");
  await page.screenshot({ path: path.join(out, "viewer-loop-checks.png"), fullPage: true });
  await viewer.getByRole("button", { name: "返回步骤链" }).click();
  await page.getByRole("button", { name: "选择工作流" }).click();
  await page.getByRole("menuitem", { name: /^status-graph ·/ }).click();
  await viewer.locator('[data-ralphflow-dag]').waitFor({ state: "visible", timeout: 10000 });
  const inspectNode = viewer.locator('[data-ralphflow-node="inspect"]');
  await inspectNode.click();
  await viewer.getByText("检查仓库结构并写出结论。", { exact: false }).waitFor({ state: "visible" });
  await viewer.getByText(/inspect\.md 存在且非空/).first().waitFor({ state: "visible" });
  evidence.checks.push("右侧只读查看器显示 Graph 资产、节点 DO 与 CHECK");
  const viewerButtons = await viewer.locator("button").allInnerTexts();
  assert.equal(viewerButtons.some((text) => /^启动\b|启动$|^启动 /.test(text.trim())), false, `viewer has no start control: ${JSON.stringify(viewerButtons)}`);
  assert.equal(viewerButtons.some((text) => /^取消\b|取消$/.test(text.trim())), false, `viewer has no cancel control: ${JSON.stringify(viewerButtons)}`);
  evidence.checks.push("查看器没有启动/取消控制面");
  await page.screenshot({ path: path.join(out, "viewer.png"), fullPage: true });
  evidence.screenshot = "viewer.png";

  // Flow 侧同样要在真机上分得出阶段：loop 的三票由 fixture 挂起，当前步必须是 CHECK 验证中。
  const loopRun = await (await fetch(`${base}/__notice/start?mode=loop`)).json();
  const loopRow = page.locator(`[data-row-key="session:${loopRun.sessionId}"]`);
  await loopRow.waitFor({ state: "visible", timeout: 20000 });
  await loopRow.click();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await until(openViewer, "Flow 会话的只读工作图", 30000);
  await page.getByRole("button", { name: "选择工作流" }).click();
  await page.getByRole("menuitem", { name: /^loop ·/ }).click();
  await viewer.locator('[data-ralphflow-step="loop"]').waitFor({ state: "visible", timeout: 10000 });
  const stepChips = async () => (await viewer.locator('[data-ralphflow-step="loop"] .rv-chip').allInnerTexts()).map((text) => text.trim());
  await until(async () => (await stepChips()).some((text) => text.includes("CHECK · 验证中")), "Flow CHECK 阶段芯片", 45000);
  const flowChips = await stepChips();
  assert.ok(flowChips.some((text) => text.includes("DO · 已交卷")), `Flow CHECK 阶段要带 DO 已交卷：${JSON.stringify(flowChips)}`);
  assert.ok(flowChips.some((text) => /CHECK · 验证中 \d+\/3/.test(text)), `Flow 要显示投票进度：${JSON.stringify(flowChips)}`);
  assert.match(await viewer.locator(".rv-head .rv-meta").innerText(), /独立验证中 \d+\/3 票/);
  evidence.checks.push(`Flow 步骤在 CHECK 阶段可分辨：${JSON.stringify(flowChips)}`);
  await page.screenshot({ path: path.join(out, "viewer-flow-check.png"), fullPage: true });
  evidence.flowCheckScreenshot = "viewer-flow-check.png";

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "graph-viewer-result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  try { await browser?.close(); } catch {}
  try { host.kill("SIGTERM"); } catch {}
  await pause(300);
  fs.rmSync(root, { recursive: true, force: true });
}
