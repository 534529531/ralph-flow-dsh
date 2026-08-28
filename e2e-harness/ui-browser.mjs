/**
 * ralphflow UI 真实浏览器验证 —— 用 playwright chromium 访问真实 dsh web
 *
 * 验证：
 *   1) dsh web 页面真实加载（HTTP 200）
 *   2) /plugins/ralphflow/client.js 被浏览器真实请求并加载（client 端组合成功）
 *   3) 页面无致命 JS 错误
 *   4) 截图存档（UI 渲染证据）
 */
import pw from "/home/yj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js";
const { chromium } = pw;
import * as fs from "node:fs";

const BASE = "http://127.0.0.1:3080";
const outDir = "/home/yj/ralph-flow-dsh/e2e-harness";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: "/home/yj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const results = [];
const check = (n, c, d = "") => { results.push({ name: n, pass: !!c, detail: d }); console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };

const clientLoaded = { count: 0 };
const jsErrors = [];

page.on("response", (r) => {
  const url = r.url();
  if (url.includes("/plugins/ralphflow/client.js")) {
    clientLoaded.count++;
    check(`client.js 被浏览器请求（HTTP ${r.status()}）`, r.status() === 200, url);
  }
});
page.on("pageerror", (e) => { jsErrors.push(String(e)); });

try {
  const resp = await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  check("dsh web 页面真实加载（HTTP 200）", !!resp && resp.status() === 200);
  await page.waitForTimeout(4000);

  // 页面标题/正文存在
  const title = await page.title().catch(() => "");
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 200) : "").catch(() => "");
  check("页面渲染出内容（body 非空）", bodyText.length > 0, `title="${title}"`);

  await page.screenshot({ path: `${outDir}/ui-home.png`, fullPage: false });
  check("首页截图已生成", fs.existsSync(`${outDir}/ui-home.png`));

  // 再次确认 client.js 至少请求过一次
  await page.waitForTimeout(2000);
  check("ralphflow client.js 已真实加载（>0 次请求）", clientLoaded.count > 0, `count=${clientLoaded.count}`);
  check("页面无致命 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
} catch (e) {
  results.push({ name: "playwright", pass: false, detail: e.message });
  console.error("PLAYWRIGHT ERROR:", e.message);
} finally {
  await browser.close();
}

const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
fs.writeFileSync(`${outDir}/ui-result.json`, JSON.stringify({ pass, fail, results, screenshots: ["ui-home.png"] }, null, 2));
console.log(`\n===== UI-BROWSER (真实 dsh web + chromium): ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail === 0 ? 0 : 1);
