/**
 * 回归：**过程记录与交付物的落点按概念判，不按路径写法判**。
 *
 * 旧判据看「裸文件名 / 明确路径」，提示词因此要反复解释边界。现在判据是**用途**：
 * 过程记录（清单、方案、报告、摘要、草稿）落 `artifacts/<dir>/`，交付物（代码、文档产品、
 * 可执行文件）落工作目录或 `output` 写明的路径。实际行为不变：loop 的 `summary.md` 仍落
 * 实例产出目录。
 *
 * 断言对着**整篇拼装之后的提示词**做，按 `## ` 分节逐节核对：
 *   1. loop 的交付物不再列过程文档；do 仍保留累积器要求；
 *   2. DO 的 `## 落点` 一节写明两类落点，`## 交付物` 只放 `output` 原文；
 *   3. 任何 `output` 里写了过程文档名的自定义工作流，也由同一套落点规则兜住；
 *   4. CHECK 用同一份落点文案，并点明工作目录里的副本不算满足；
 *   5. DO 提示词 / 作者参考 / docs/custom-workflows.md 用同一套「过程记录 vs 交付物」锚点。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../lib/engine.js";
import { buildCheckPrompt } from "../lib/verify.js";
import { placementSection } from "../lib/asset-path.js";
import { CREATE_SKILL_RESOURCES } from "../lib/skills.js";
import { deliveryPorts } from "./helpers/ports.mjs";

// HOME 隔离：绝不读写真实 ~/.dsh（全局工作流目录在那里）。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-ap-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-ap-"));

let pass = 0, fail = 0;
const check = (n, c, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.error(`  ✗ ${n}\n      ${String(e).slice(0, 700)}`); }
};

const engine = createEngine(ws, {
  ...deliveryPorts(),
  verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "passed", reason: "ap-test" }),
  log: () => {},
});
engine.ensureLayout();

/** 把拼装后的提示词按 `## ` 分节（标题 → 该节正文，正文不含下一个标题行）。 */
function sections(prompt) {
  const heads = [...prompt.matchAll(/^## (.+)$/gm)].map((m) => ({ title: m[1].trim(), start: m.index, end: m.index + m[0].length }));
  const map = new Map();
  heads.forEach((h, i) => {
    const stop = i + 1 < heads.length ? heads[i + 1].start : prompt.length;
    map.set(h.title, prompt.slice(h.end, stop));
  });
  return map;
}
const relOf = (id) => path.relative(ws, engine.artifactsDirOf(id)).split(path.sep).join("/");
/** 取出一段带 `## 标题` 的文本的正文（去掉标题行）。 */
const bodyOf = (text) => text.split("\n").slice(1).join("\n").trim();

// ── A) 病根：loop 的交付物不再列过程文档；累积器要求仍在 ─────────────────────
console.log("A) loop 的「交付物」不再把 summary.md 列成交付物（病根）");
const loopDef = engine.loadWorkflow("loop").def;
const loopStep = loopDef.steps[0];
check("loop 的 output 不含过程文档名 summary.md", !/summary\.md/.test(String(loopStep.output)), loopStep.output);
check("loop 的 do 仍要求「每次交卷前把摘要追加到 summary.md」（累积器保留）",
  /追加/.test(loopStep.do) && loopStep.do.includes("summary.md"), loopStep.do);
check("summary 的边界是「每次交卷」，不是每个会话回合",
  loopStep.do.includes("每次交卷前") && loopStep.do.includes("一次交卷一节") && !loopStep.do.includes("每轮结束时"), loopStep.do);
check("loop 的 do 不暴露引擎内部协议（unfinished / 交卷方式 / 未完成部分）",
  !/unfinished/.test(loopStep.do) && !/交卷方式/.test(loopStep.do) && !/未完成部分/.test(loopStep.do), loopStep.do);

// ── B) 拼装后的 DO 提示词：过程记录 / 交付物 各只有一个落点说法 ─────────────
console.log("\nB) 整篇拼装后的 DO 提示词：落点按概念说一次");
const started = engine.start("loop", "回归：过程文档落点", "ap-s1");
const loopId = engine.listInstances().at(-1).id;
const rel = relOf(loopId);
const doSec = sections(started.text);
const placement = doSec.get("落点") ?? "";
const deliv = doSec.get("交付物") ?? "";

check("DO 提示词有 ## 落点 一节，并带本实例产出目录", doSec.has("落点") && placement.includes(rel), placement);
check("DO 落点写明过程记录落产出目录、只写文件名",
  placement.includes("过程记录") && placement.includes("只写文件名") && placement.includes(`\`${rel}/\``), placement);
check("DO 落点写明交付物落工作目录、output 明确路径按那个路径",
  placement.includes("交付物") && placement.includes("工作目录") && placement.includes("`output` 里写了明确路径的，按那个路径"), placement);
check("DO 不再有「## 产出目录」一节（路径写法不再是判据）", !doSec.has("产出目录"));
check("过程记录落点句（只写文件名）只在 ## 落点 一节出现",
  [...doSec.entries()].filter(([, body]) => body.includes("只写文件名")).map(([t]) => t).join(",") === "落点");
check("DO 交付物一节只放 output 原文，不附落点解释",
  deliv.trim() === String(loopStep.output).trim() && !deliv.includes("落点") && !deliv.includes("产出目录"), deliv);
check("DO 提示词不再含旧的矛盾句「… + summary.md（执行摘要）」",
  !started.text.includes("summary.md（执行摘要）") && !/实现的代码\/文件 \+ summary\.md/.test(started.text));
// 真实例：summary.md 的落点仍是本实例产出目录，工作目录根不出现副本。
const summaryPath = path.join(engine.artifactsDirOf(loopId), "summary.md");
fs.writeFileSync(summaryPath, "本轮摘要\n");
check("真实例：summary.md 落在产出目录而非工作目录根",
  fs.existsSync(summaryPath) && !fs.existsSync(path.join(ws, "summary.md")), summaryPath);

// 资产目录一节只讲资产资源参考根，不再重复落点规则。
const assetSec = doSec.get("资产目录") ?? "";
check("DO 资产目录一节只讲资产资源参考根与按需读取",
  assetSec.includes("本资产资源的基准目录") && assetSec.includes("契约、模板、校验清单按它解析") && assetSec.includes("需要时再读"), assetSec);
check("DO 资产目录一节不重复落点规则（无交付物 / 产出目录 / 裸文件名 / summary.md）",
  assetSec.length > 0 && !assetSec.includes("交付物") && !assetSec.includes("产出目录")
    && !assetSec.includes("裸文件名") && !assetSec.includes("summary.md"), assetSec);

// ── C) 任何 output 列了过程文档名的工作流，也由同一套落点规则兜住 ─────────────
console.log("\nC) 自定义工作流的 output 列了过程文档名时，交付物原样展示、落点仍由 ## 落点 说");
fs.writeFileSync(path.join(engine.workflowsDir, "ap-generic.yaml"), [
  "steps:",
  "  - id: a",
  "    desc: 步骤 a",
  "    do: 做事",
  "    input: 上游产出",
  "    output: 代码/文件 + summary.md（执行摘要）",
  "    check: 检查产出",
  "    on_pass: done",
  "    on_fail: a",
  "    max_fail_count: 1",
].join("\n"));
const gen = engine.loadWorkflow("ap-generic").def;
check("自定义工作流加载成功", !!gen, JSON.stringify(engine.loadWorkflow("ap-generic").problems));
const genStarted = engine.start("ap-generic", "回归：通用兜底", "ap-s2");
const genId = engine.listInstances().at(-1).id;
const genSec = sections(genStarted.text);
const genDeliv = genSec.get("交付物") ?? "";
const genPlace = genSec.get("落点") ?? "";
check("自定义 output 里的过程文档名仍被原样展示（不擅自改写作者写的 output）",
  genDeliv.includes("summary.md"), genDeliv);
check("自定义工作流的交付物一节只放 output 原文", genDeliv.trim() === "代码/文件 + summary.md（执行摘要）", genDeliv);
check("自定义工作流的落点一节同样写明过程记录落产出目录",
  genPlace.includes("过程记录") && genPlace.includes(`\`${relOf(genId)}/\``), genPlace);

// ── D) CHECK 提示词：同一份落点文案 + 副本不算满足 ───────────────────────────
console.log("\nD) CHECK 提示词用同一份落点文案，并点明副本不算满足");
const voter = { index: 0, count: loopStep.check_voting.length, check: loopStep.check_voting[0].check };
const cp = buildCheckPrompt({
  instId: loopId,
  step: loopStep,
  workflow: loopDef,
  userTask: "回归：过程文档落点",
  checkIndex: 0,
  voter,
  artifactsRelDir: rel,
  signal: new AbortController().signal,
}, true);
const cpSec = sections(cp);
const cpArt = cpSec.get("本步上下文") ?? "";
const cpPlace = cpSec.get("落点") ?? "";
check("CHECK 提示词有 ## 本步上下文 与 ## 落点", cpSec.has("本步上下文") && cpSec.has("落点"));
check("CHECK 落点写明过程记录在产出目录、用文件名即可读到",
  cpPlace.includes("过程记录") && cpPlace.includes("用文件名即可读到") && cpPlace.includes(`\`${rel}/\``), cpPlace);
check("CHECK 落点写明交付物落工作目录、output 明确路径按那个路径",
  cpPlace.includes("交付物") && cpPlace.includes("工作目录") && cpPlace.includes("`output` 里写了明确路径的，按那个路径"), cpPlace);
check("CHECK 落点判定口径：工作目录里的副本不算满足",
  cpPlace.includes("副本") && cpPlace.includes("不算满足"), cpPlace);
check("DO 与 CHECK 的落点段都来自同一个 placementSection（单一真相源）",
  placement.trim() === bodyOf(placementSection(rel))
    && cpPlace.trim() === bodyOf(placementSection(rel, true)),
  JSON.stringify({ do: placement.trim(), check: cpPlace.trim() }));
check("CHECK 本步上下文不再重复落点说明",
  cpArt.length > 0 && !cpArt.includes("产出目录") && !cpArt.includes("落点"), cpArt);
check("CHECK 交付物一项只列 output，不附落点解释",
  cpArt.includes("**交付物**：实现的代码/文件") && !cpArt.includes("这一项只说") && !cpArt.includes("产出目录"), cpArt);

// ── E) 同一套概念（DO 提示词 / 作者参考 / docs/custom-workflows.md）不分叉 ────
console.log("\nE) 同一套「过程记录 vs 交付物」锚点（DO 提示词 / 作者参考 / docs/custom-workflows.md）");
const docText = fs.readFileSync(path.join(repoRoot, "docs", "custom-workflows.md"), "utf-8");
const authoringText = fs.readFileSync(path.join(CREATE_SKILL_RESOURCES, "workflow-authoring.md"), "utf-8");
const anchors = ["过程记录", "交付物", "工作目录", "明确路径"];
for (const [name, text] of [["DO 提示词", placement], ["作者参考", authoringText], ["docs/custom-workflows.md", docText]]) {
  const missing = anchors.filter((a) => !text.includes(a));
  check(`${name} 含全部 4 个概念锚点`, missing.length === 0, `缺：${missing.join(" / ")}`);
}
check("作者参考点明 CHECK 把工作目录里的副本判为不满足",
  authoringText.includes("副本") && authoringText.includes("不算满足"));
check("作者参考与 docs 都已改用概念判据，不再把裸文件名当落点判据",
  !authoringText.includes("裸文件名") && !docText.includes("裸文件名"));

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
