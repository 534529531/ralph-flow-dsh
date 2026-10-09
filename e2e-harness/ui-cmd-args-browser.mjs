/**
 * ⚠️ **历史探针（v1）**：它断言的「/ralphflow-start + 参数被当命令执行」在 v2 已不成立 ——
 * 启动类入口现在是**技能**（人敲落成普通 user/message，宿主注入技能正文；同名命令必须保持
 * 删除，否则新会话拿不到标题）。见 `docs/v2/skills-vs-commands.md`。现行验收面 =
 * `scripts/skills-surface-test.mjs`（真 SkillRegistry + 真 CommandRuntime + 真标题服务）。
 */
/**
 * ralphflow 命令+参数验证 —— 真实 chromium 验证 opencode 式交互
 *
 * 前置：dsh --profile web 已启动（http://127.0.0.1:3080），ralphflow 已装入 profile
 * 验证（命令需声明 CommandDefinition.input.hint，否则 dsh 把"命令+参数"行当普通消息发给模型）：
 *   1) 裸 "/ralphflow-start" + Enter → 进入 claim（输入框保留 "/ralphflow-start "，可继续输入）
 *   2) 逐字输入 "/ralphflow-start loop <任务>" + Enter → 作为命令执行（工作流启动，页面出现"已启动"）
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
const check = (n, c, d = "") => { results.push({ name: n, pass: !!c, detail: String(d).slice(0, 160) }); console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));

try {
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(4000);
  const target = page.locator("textarea:visible").first();

  // 1) 裸命令 Enter → claim
  await target.click();
  await target.type("/ralphflow-start");
  await target.press("Enter");
  await page.waitForTimeout(2500);
  const val = await target.inputValue().catch(() => "");
  check("裸 /ralphflow-start + Enter 进入 claim（可继续输入）", val.startsWith("/ralphflow-start "), `输入框="${val}"`);

  // 2) 补参数继续输入并提交 → 执行
  await target.type("loop 命令参数端到端验证");
  await page.waitForTimeout(300);
  await target.press("Enter");
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${outDir}/cmd-args-after.png`, fullPage: false });
  const body = await page.evaluate(() => document.body.innerText);
  const started = /已启动/.test(body) || /已取消/.test(body) || /实例/.test(body);
  check("claim 后补充参数提交 → 命令执行", started, body.slice(0, 80).replace(/\n/g, "|"));
  check("页面无致命 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
} catch (e) {
  results.push({ name: "playwright", pass: false, detail: e.message });
  console.error("PLAYWRIGHT ERROR:", e.message);
} finally {
  await browser.close();
}

const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
fs.writeFileSync(`${outDir}/cmd-args-result.json`, JSON.stringify({ pass, fail, results }, null, 2));
console.log(`\n===== UI-CMD-ARGS (命令+参数): ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail === 0 ? 0 : 1);