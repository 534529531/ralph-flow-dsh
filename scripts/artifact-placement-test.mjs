/**
 * 回归：**过程文档不得漏进工作目录** —— DO/CHECK 提示词的落点边界 + **拼装后自洽**。
 *
 * 病根不在「有没有 `## 产出目录` 这一节」。上一轮就是这么修的、也就这么漏过去的：
 * `workflows/loop.yaml` 的 `output: 实现的代码/文件 + summary.md（执行摘要）` 经引擎拼成 DO 的
 * `## 交付物`，把一份**过程文档**列成和代码并列的交付物，与紧邻的 `## 产出目录` 直接矛盾；
 * 那句话单独看没错、那一节单独看也没错，**两句拼到一起才打架**——按文件审永远看不见。
 *
 * 所以这里的断言都对着**整篇拼装之后的提示词**做，按 `## ` 分节逐节核对：
 *   1. 病根（loop 的交付物不再列过程文档；do 仍保留累积器要求）；
 *   2. DO 提示词每节只说一种落点，`## 交付物` 不再把过程文档列成工作目录交付物；
 *   3. 任何 `output` 里写了过程文档名的自定义工作流，也要被同一句「落点由产出目录决定」兜住；
 *   4. CHECK 提示词同样写明边界，并明说「工作目录里的副本是落点错误、不算满足」（验证者曾被带偏）；
 *   5. 同一条规则的三份拷贝（DO 提示词 / CREATE_GUIDE / docs/custom-workflows.md）用同一批锚点，不分叉。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../lib/engine.js";
import { buildCheckPrompt } from "../lib/verify.js";
import { CREATE_GUIDE } from "../lib/create.js";
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

// ── A) 病根：loop 的交付物不再列过程文档；累积器要求仍在 ─────────────────────
console.log("A) loop 的「交付物」不再把 summary.md 列成交付物（病根）");
const loopDef = engine.loadWorkflow("loop").def;
const loopStep = loopDef.steps[0];
check("loop 的 output 不含过程文档名 summary.md", !/summary\.md/.test(String(loopStep.output)), loopStep.output);
check("loop 的 do 仍要求「每轮把摘要追加到 summary.md」（累积器保留）",
  /追加/.test(loopStep.do) && loopStep.do.includes("summary.md"), loopStep.do);

// ── B) 拼装后的 DO 提示词：逐节自洽 ──────────────────────────────────────────
console.log("\nB) 整篇拼装后的 DO 提示词：关于「过程文档落在哪」只有一个说法");
const started = engine.start("loop", "回归：过程文档落点", "ap-s1");
const loopId = engine.listInstances().at(-1).id;
const doSec = sections(started.text);
const art = doSec.get("产出目录") ?? "";
const deliv = doSec.get("交付物") ?? "";

check("DO 提示词有 ## 产出目录 一节（旧的弱断言保留）", doSec.has("产出目录") && started.text.includes(relOf(loopId)));
check("DO 产出目录一节写明『过程文档』与『产物』的落点边界",
  art.includes("过程文档") && art.includes("产物") && art.includes("工作目录只放本步的**产物**"), art);
check("DO 产出目录一节写明裸文件名归位产出目录、明确路径按写的路径来",
  art.includes("裸文件名") && art.includes("落到这个目录") && art.includes("明确路径"), art);
check("DO 产出目录一节禁止在工作目录留副本",
  art.includes("同一份过程文档只写一处") && art.includes("留副本"), art);
check("DO 交付物一节不再出现过程文档 summary.md（两节拼装后自洽）",
  deliv.length > 0 && !deliv.includes("summary.md"), deliv);
check("DO 交付物一节点明落点由产出目录决定",
  deliv.includes("产出目录") && deliv.includes("哪里"), deliv);
check("DO 提示词不再含旧的矛盾句「… + summary.md（执行摘要）」",
  !started.text.includes("summary.md（执行摘要）") && !/实现的代码\/文件 \+ summary\.md/.test(started.text));
// 「同一个说法」的可机械判据：位置指令句只在产出目录一节出现一次
const locationClaims = [...doSec.entries()].filter(([, body]) => body.includes("落到这个目录")).map(([t]) => t);
check("位置指令句（裸文件名落到这个目录）只在 ## 产出目录 一节出现，别无第二处说法",
  locationClaims.length === 1 && locationClaims[0] === "产出目录", JSON.stringify(locationClaims));

// ── C) 任何 output 列了过程文档名的工作流，也被同一句兜住 ─────────────────────
console.log("\nC) 自定义工作流的 output 列了过程文档名时，`## 交付物` 仍附「落点由产出目录决定」");
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
const genSec = sections(genStarted.text);
check("自定义 output 里的过程文档名仍被原样展示（不擅自改写作者写的 output）",
  (genSec.get("交付物") ?? "").includes("summary.md"), genSec.get("交付物"));
check("同一节附「落在哪里由产出目录决定」的兜底句（矛盾被消解为唯一说法）",
  /落在\*\*哪里\*\*由「产出目录」一节决定/.test(genSec.get("交付物") ?? ""), genSec.get("交付物"));
check("自定义工作流的产出目录一节同样禁止副本",
  (genSec.get("产出目录") ?? "").includes("不要留副本"), genSec.get("产出目录"));

// ── D) CHECK 提示词：同样写明边界，且明说副本不算满足 ────────────────────────
console.log("\nD) CHECK 提示词写明落点边界 + 「副本是落点错误、不算满足」");
const voter = { index: 0, count: loopStep.check_voting.length, check: loopStep.check_voting[0].check };
const cp = buildCheckPrompt({
  instId: loopId,
  step: loopStep,
  workflow: loopDef,
  userTask: "回归：过程文档落点",
  checkIndex: 0,
  voter,
  artifactsRelDir: relOf(loopId),
  signal: new AbortController().signal,
}, true);
const cpSec = sections(cp);
const cpArt = [...cpSec.entries()].find(([t]) => t === "本步上下文")?.[1] ?? "";
check("CHECK 提示词含 ## 本步上下文", cpSec.has("本步上下文"));
check("CHECK 的本步上下文写明『过程文档』/『产物』落点边界",
  cpArt.includes("过程文档") && cpArt.includes("工作目录只放本步的**产物**"), cpArt);
check("CHECK 写明裸文件名 → 产出目录、明确路径 → 按那个路径",
  cpArt.includes("裸文件名") && cpArt.includes("明确路径"), cpArt);
check("CHECK 明说工作目录里的副本是落点错误、不要把副本判成满足",
  cpArt.includes("落点错误") && cpArt.includes("不要把副本判成满足"), cpArt);
check("CHECK 的交付物一项点明落点看下一行「产出目录」",
  cpArt.includes("这一项只说产出**什么**") && cpArt.includes("产出目录"), cpArt);

// ── E) 同一条规则的三份拷贝不分叉 ────────────────────────────────────────────
console.log("\nE) 三份拷贝（DO 提示词 / CREATE_GUIDE / docs/custom-workflows.md）同说一条边界");
const docText = fs.readFileSync(path.join(repoRoot, "docs", "custom-workflows.md"), "utf-8");
const anchors = ["过程文档", "工作目录只放本步的**产物**", "同一份过程文档只写一处", "明确路径"];
for (const [name, text] of [["DO 提示词", art], ["CREATE_GUIDE", CREATE_GUIDE], ["docs/custom-workflows.md", docText]]) {
  const missing = anchors.filter((a) => !text.includes(a));
  check(`${name} 含全部 4 个边界锚点`, missing.length === 0, `缺：${missing.join(" / ")}`);
}
check("CREATE_GUIDE 的示例 output 不再把过程文档列成交付物", !/output:[^\n]*\n\s*实现的代码 \+ summary\.md/.test(CREATE_GUIDE));
check("CREATE_GUIDE 点明 CHECK 会把副本判为落点错误", CREATE_GUIDE.includes("副本是落点错误"));

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
