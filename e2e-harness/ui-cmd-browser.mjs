/**
 * ralphflow UI 命令端到端 —— 真实 chromium + 真实 dsh web 执行 /ralphflow-list
 *
 * 前置：dsh --profile web 已启动（http://127.0.0.1:3080），且 ralphflow 已装入 profile
 * 验证：
 *   1) dsh web 页面加载 + ralphflow client.js 被浏览器请求（HTTP 200）
 *   2) 输入 / 后出现含 ralphflow-list 的命令补全面板（host 命令已注册到 UI）
 *   3) 点选执行后，页面新增渲染 "可用工作流" 输出（前后 body 快照 diff）
 *   4) opencode 式命令结果卡（Ralph Flow 徽标 + /list 命令名）渲染在对话流中
 *   5) 全程无致命 JS 错误（含 header.actions / chat.node 槽不崩溃）；截图存档 cmd-ui-*.png
 */
import pw from "/home/yj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js";
const { chromium } = pw;
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.DSH_WEB_BASE || "http://127.0.0.1:3080";
const outDir = fileURLToPath(new URL(".", import.meta.url));

const browser = await chromium.launch({ executablePath: "/home/yj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const results = [];
const check = (n, c, d = "") => { results.push({ name: n, pass: !!c, detail: String(d).slice(0, 200) }); console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };
const bodyText = () => page.evaluate(() => document.body.innerText);
const countOf = (text, s) => text.split(s).length - 1;
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
let clientOk = false;
page.on("response", (r) => {
  if (r.url().includes("/plugins/ralphflow/client.js")) clientOk = r.status() === 200;
});

try {
  const resp = await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  check("dsh web 页面加载", !!resp && resp.status() === 200);
  await page.waitForTimeout(4000);
  check("ralphflow client.js 已被浏览器请求且 HTTP 200", clientOk);

  // 在输入框输入 /ralphflow-list 并从补全面板点选执行
  const target = page.locator("textarea:visible").first();
  await target.click();
  const before = await bodyText();
  await target.fill("/ralphflow-list");
  await page.waitForTimeout(800);
  let picked = false;
  try {
    const panelItem = page.getByText("ralphflow-list", { exact: false }).first();
    await panelItem.waitFor({ state: "visible", timeout: 5000 });
    await panelItem.click();
    picked = true;
  } catch {}
  check("命令补全面板出现并可点选 ralphflow-list", picked);
  if (!picked || (await target.inputValue().catch(() => "")).includes("ralphflow-list")) {
    await target.press("Enter").catch(() => {});
  }
  await page.waitForTimeout(6000);

  const after = await bodyText();
  await page.screenshot({ path: `${outDir}/cmd-ui-after.png`, fullPage: false });
  const delta = countOf(after, "可用工作流") - countOf(before, "可用工作流");
  check("/ralphflow-list 输出新增渲染（Δ>0）", delta > 0, `Δ=${delta}`);
  // opencode 式命令结果卡：Ralph Flow 徽标 + /list 命令名（区别于 dsh 灰色工具行）
  const cardDelta = countOf(after, "Ralph Flow") - countOf(before, "Ralph Flow");
  check("命令结果卡已渲染（Ralph Flow 徽标新增）", cardDelta > 0, `Δ=${cardDelta}`);
  check("命令卡含命令名 /list", /\/list/.test(after));
  check("页面无致命 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
} catch (e) {
  results.push({ name: "playwright", pass: false, detail: e.message });
  console.error("PLAYWRIGHT ERROR:", e.message);
  await page.screenshot({ path: `${outDir}/cmd-ui-error.png` }).catch(() => {});
} finally {
  await browser.close();
}

const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
fs.writeFileSync(`${outDir}/cmd-ui-result.json`, JSON.stringify({ pass, fail, results }, null, 2));
console.log(`\n===== UI-CMD-BROWSER (真实 dsh web + chromium): ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail === 0 ? 0 : 1);
