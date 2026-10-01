/**
 * 问题二 · CHECK 阶段承诺的时长是编的：**输出里不许再出现任何时长承诺**。
 *
 * 现象：多处对用户说「独立验证通常 1–5 分钟」。实测 3m53s / 7m29s / 8m34s，而且委派
 * **没有超时上界**（生命周期跟随宿主原生能力，见 src/verify.ts）—— 预估无从谈起，任何
 * 数字都是编的。用户看得见我们委派的子 agent 在干什么，所以真话是「它在读文件、跑命令
 * 取证，你能看到」，并保留逃生口（`/ralphflow-status` 看进度、`/ralphflow-cancel` 中止）。
 *
 * 本文件断言：
 *   T1  扫描器本身分得清「承诺」与「实测」（预置承诺必须被抓；`3 分钟前` 这类实测不误报）；
 *   T2  真跑一遍插件，把**所有用户/模型可见的文本**收集起来 → 零时长承诺，且新措辞在；
 *   T3  静态扫描运行时面（src/*.ts 剥注释、workflows/*.yaml、README.md）→ 零时长承诺；
 *   T4【负对照】把文案还原成修复前那句编造的时长承诺 → **同一个判据必然判不通过**。
 *
 * 纪律（任务书 §4）：一切临时资产走 mkdtemp + 隔离 HOME。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  mkEnv, toolOf, cmdOf, execTool, execCommand, textOf, sleep, mkTmp, cleanupTmp,
} from "./helpers/plugin-harness.mjs";
import { REPO, buildPluginCopy, revertHonestVerifyNotice, revertMechanismWording } from "./helpers/reverted-build.mjs";
import { findDurationPromises, scanRuntimeSurfaces } from "./helpers/time-promise-scan.mjs";

// HOME 隔离：索引/全局工作流目录都在 ~/.dsh 下，测试绝不读写真实 HOME。
process.env.HOME = mkTmp("home");
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const RUN = Math.random().toString(36).slice(2, 8);
const PLUGIN_ENTRY = pathToFileURL(path.join(REPO, "lib", "index.js")).href;

/** 收集到的「可见文本」→ 时长承诺清单 */
const promisesIn = (texts) => texts.flatMap(({ label, text }) => findDurationPromises(text).map((h) => ({ label, ...h })));
/** 唯一判据：这一批文本里没有任何时长承诺 */
const noTimePromise = (texts) => promisesIn(texts).length === 0;
const dump = (hits) => hits.slice(0, 6).map((h) => `${h.label}@${h.line}：${h.match} ← ${h.snippet}`).join(" | ");

/**
 * 真跑一遍插件，收集**所有会被人（用户/模型）读到的文本**。
 *
 * 覆盖：工具描述、命令描述、DO 提示词（工具返回）、交卷回执、投递出去的每一条播报
 * （含验证中 notice 的正文与 summary）、status/list/doctor 的返回、create 指引、
 * 以及命令触发词注入的机制说明（SHARED_MECHANISM 就是从这里进对话的）。
 */
async function collectVisibleTexts(entryUrl, suffix) {
  const ws = mkTmp("promise");
  process.env.RALPHFLOW_WORKSPACE = ws;
  const sid = `promise-${RUN}${suffix}`;
  const texts = [];
  const push = (label, s) => { if (typeof s === "string" && s.trim()) texts.push({ label, text: s }); };

  let resolveVerify;
  const A = mkEnv(ws, sid, { start: () => ({ id: "child", result: new Promise((r) => { resolveVerify = r; }) }) });
  const plugin = await import(entryUrl + (suffix ? `?${suffix}` : ""));
  plugin.apply(A.ctx);

  for (const t of A.registered.tools) push(`tool.description(${t.name})`, t.description);
  for (const c of A.registered.commands) push(`command.description(/${c.name})`, c.description);

  // DO 阶段：启动返回的 DO 提示词（含「交卷方式」那段）
  push("ralphflow_start 返回", await execTool(toolOf(A.registered, "ralphflow_start"), { workflow: "loop", task: "时长承诺用例" }, sid));
  A.sent.length = 0;

  // CHECK 阶段：交卷回执 + 验证中播报（正文与 summary）
  push("ralphflow_submit 返回", await execTool(toolOf(A.registered, "ralphflow_submit"), { summary: "做完了" }, sid));
  await sleep(150);
  for (const m of A.sent) push(`投递播报(summary=${m?.source?.summary ?? ""})`, textOf(m));

  for (const name of ["ralphflow_status", "ralphflow_list", "ralphflow_doctor"]) {
    push(`${name} 返回`, await execTool(toolOf(A.registered, name), {}, sid));
  }
  push("ralphflow_create 返回", await execTool(toolOf(A.registered, "ralphflow_create"), { idea: "示例流程" }, sid));

  // 命令触发词：注入给模型的机制说明（/ralphflow-start 与 /loop、/spec 共用 SHARED_MECHANISM）
  for (const cname of ["ralphflow-start", "ralphflow-continue", "ralphflow-status", "ralphflow-cancel", "loop", "spec"]) {
    const cmd = cmdOf(A.registered, cname);
    if (!cmd) continue;
    const before = A.sent.length;
    await execCommand(cmd, sid);
    for (const m of A.sent.slice(before)) push(`命令 /${cname} 注入的指令`, textOf(m));
  }

  // 判定落地后的完成播报
  A.sent.length = 0;
  resolveVerify({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" });
  await sleep(200);
  for (const m of A.sent) push(`完成播报(summary=${m?.source?.summary ?? ""})`, textOf(m));

  return { ws, texts };
}

// ─────────────────────────────────────────────────────────────────────────────

console.log("T1 扫描器分得清「承诺」与「实测」");
{
  const prefixed = [
    "验证通常需要 1–5 分钟（它要真的去读文件、跑命令取证）。",
    "独立验证中（1–5 分钟，无需操作）",
    "通常需要 1–5 分钟，期间不需要你做任何操作，跑完会自动唤醒本会话。",
    "异步，分钟级；不阻塞主会话回合",
    "大约 8 分钟就好",
    "预计 2 分钟出结果",
    "几分钟内自动继续",
  ];
  const measured = ["最后活动：3 分钟前", "耗时 3m12s", "刚刚", "本步耗时 0s", "验证未跑成（基础设施问题）"];
  check("七种旧措辞一个不漏（含区间 / 分钟级 / 概略词组合）",
    prefixed.every((s) => findDurationPromises(s).length > 0),
    prefixed.filter((s) => findDurationPromises(s).length === 0).join(" | "));
  check("实测耗时/相对时间不误报（`3 分钟前`、`耗时 3m12s` 是事实不是承诺）",
    measured.every((s) => findDurationPromises(s).length === 0),
    measured.map((s) => `${s}→${JSON.stringify(findDurationPromises(s))}`).join(" | "));
}

console.log("\nT2 真跑一遍插件：所有可见文本零时长承诺，且新措辞在（说清它在干什么 + 保留逃生口）");
const fixed = await collectVisibleTexts(PLUGIN_ENTRY, "");
{
  const hits = promisesIn(fixed.texts);
  check(`收集到的 ${fixed.texts.length} 段可见文本里没有任何时长承诺`, hits.length === 0, dump(hits));

  const verifyNotice = fixed.texts.find((t) => t.label.startsWith("投递播报") && /独立验证者/.test(t.text));
  check("验证中播报存在且可见", !!verifyNotice, JSON.stringify(fixed.texts.map((t) => t.label)));
  const notice = verifyNotice?.text ?? "";
  check("验证中播报说清「它在读文件、跑命令取证」", /读文件/.test(notice) && /跑命令取证/.test(notice), notice.slice(0, 300));
  check("验证中播报说清「你看得到」（不猜时间，给可观察的事实）", /看得到/.test(notice), notice.slice(0, 300));
  check("验证中播报保留逃生口：/ralphflow-status 与 /ralphflow-cancel",
    /ralphflow-status/.test(notice) && /ralphflow-cancel/.test(notice), notice.slice(0, 400));
  check("验证中 summary 自带「无需操作」（默认唯一可见行仍可行动）", /无需操作/.test(verifyNotice?.label ?? ""), verifyNotice?.label);
  check("DO 提示词要求模型不要给时长预估", /不要给任何时长预估/.test(fixed.texts.find((t) => t.label === "ralphflow_start 返回")?.text ?? ""));
  cleanupTmp(fixed.ws);
}

console.log("\nT3 静态扫描运行时面（src/*.ts 剥注释、workflows/*.yaml、README.md）");
{
  const files = scanRuntimeSurfaces(REPO);
  const bad = files.filter((f) => f.hits.length > 0);
  check(`扫描 ${files.length} 个文件（${files.map((f) => f.path).join("、")}）零时长承诺`,
    bad.length === 0, bad.map((f) => `${f.path}:${f.hits.map((h) => `${h.line}(${h.match})`).join(",")}`).join(" | "));
}

console.log("\nT4【负对照】把文案还原成修复前那句编造的时长承诺 → 同一判据必然判不通过");
{
  const legacy = buildPluginCopy(
    { "engine.ts": revertHonestVerifyNotice, "tools.ts": revertMechanismWording },
    "promise-reverted",
  );
  try {
    const reverted = await collectVisibleTexts(legacy.entry, "reverted");
    const hits = promisesIn(reverted.texts);
    check("还原后：可见文本里确实又出现了时长承诺（否则负对照没有鉴别力）", hits.length > 0, dump(hits));
    check("还原后：命中修复前那句「通常需要 1–5 分钟」", hits.some((h) => /1\s*[–—\-]\s*5\s*分钟/.test(h.match)), dump(hits));
    check("还原后：**同一个判据** noTimePromise 为假 —— 新用例在旧文案上必然失败", noTimePromise(reverted.texts) === false);
    console.log(`     命中原样：${dump(hits)}`);
    cleanupTmp(reverted.ws);
  } finally {
    legacy.cleanup();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
