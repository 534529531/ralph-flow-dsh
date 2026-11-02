/** Verify the assembled context after reset and the shipped disclosure pointer. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createEngine } from "../lib/engine.js";
import { buildCheckPrompt, VERIFIER_PERSONA } from "../lib/verify.js";
import { CREATE_SKILL_RESOURCES, SHARED_MECHANISM } from "../lib/skills.js";
import { mkTmp, cleanupTmp } from "./helpers/plugin-harness.mjs";

const root = mkTmp("prompt-contract");
process.env.HOME = `${root}/home`;
process.env.DSH_HOME = `${root}/home/.dsh`;
const delivered = [], checks = [], resets = [];
let loopSubmission = 0;
const engine = createEngine(root, {
  deliverDirective: (_sid, text) => { delivered.push(text); return true; },
  deliverNotice: () => true,
  resetSurface: async (_sid, request) => { resets.push(request); return { ok: true }; },
  verify: async (req) => {
    checks.push(buildCheckPrompt(req, true));
    return {
      status: req.workflow.name === "loop" ? "failed" : "passed",
      reason: req.workflow.name === "loop" ? (loopSubmission === 1 ? "局部问题：寻路卡住" : "采集与战斗仍未完成") : "controlled",
      check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(),
    };
  }, log() {},
});
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
try {
  const start = engine.start("spec", "保留现有 API，增加一项行为", "owner");
  assert(start.ok);
  const id = engine.listInstances()[0].id;
  const artifactDir = engine.artifactsDirOf(id);
  // Durable input survives the context boundary; the engine does not synthesize it from self-report.
  fs.writeFileSync(`${artifactDir}/proposal.md`, "用户已确认：保留现有 API\n验收：原调用仍成立");
  assert(engine.onSubmit("owner", "explore complete").ok); await settle();
  const propose = delivered.at(-1);
  assert(propose.includes("## 输入"));
  assert(propose.includes("## 本步验收依据（供自查）"));
  // 交卷的前置条件由引擎统一注入（不靠每个工作流自己写）：
  assert(propose.includes("还没完成的事项"));
  assert(propose.includes("没有就留空"));
  assert(propose.includes("剩余工作清单"));
  assert(propose.includes("不是完成声明"));
  assert(propose.includes("每一条都能指出可复核的证据"));
  assert(propose.includes("把**还没完成的事项**逐条写进 `unfinished`"));
  assert(propose.includes("调用 `ralphflow_submit` 结束本轮"));
  assert(propose.includes("被打回会整步返工"));
  // 不向执行者泄露判定的触发条件：DO 不能再把「没有剩余事项」和「启动验证」绑在一起。
  assert(!propose.includes("留空 = 做完了") && !propose.includes("完成开关"));
  assert(!propose.includes("没有剩余事项**") && !propose.includes("还有剩余事项"));
  assert(!propose.includes("引擎会启动独立验证"));
  assert(propose.indexOf("## 输入") < propose.indexOf("## 本步要做什么"));
  assert(propose.includes("proposal 的每条验收标准都有明确任务承接"));
  assert(propose.includes("proposal.md（本实例产出目录，含需求与已确认决定）"));
  assert(propose.includes("用户新反馈时先更新 proposal.md"));
  assert(propose.includes("审查门"));
  assert(propose.includes("交卷工具会结束当前回合"));
  assert(checks[0].includes("reason 必须自包含"));
  assert(!checks[0].includes("explore complete"));
  assert(fs.readFileSync(`${artifactDir}/proposal.md`, "utf8").includes("保留现有 API"));
  assert(engine.onSubmit("owner", "propose complete").ok); await settle();
  assert.equal(engine.uiStatus("owner").status.stage, "gate");
  fs.writeFileSync(`${artifactDir}/tasks.md`, "- [ ] 保留 API 并验证原调用\n");
  assert(engine.continueInstance("owner").ok); await settle();
  const implement = delivered.at(-1);
  assert(implement.includes("剩余工作清单"));
  assert(implement.includes("先读 proposal.md、tasks.md"));
  assert(implement.includes("proposal.md + tasks.md（+ 已有 design.md）"));
  assert(implement.includes("项目没有某类工具时"));
  assert(!implement.includes("每任务单独一个提交"));
  assert(!implement.includes("只改代码"));
  assert(resets.length >= 2, "real engine requests reset at propose and implement");
  assert(SHARED_MECHANISM.includes("基础设施故障自动重验一次"));
  assert(!SHARED_MECHANISM.includes("简短地确认一下"));
  assert(VERIFIER_PERSONA.includes("DO 是被验收工作的说明"));
  assert(VERIFIER_PERSONA.includes("文档本身是交付物"));

  // Baseline loop: reset keeps the full original task, without a mandatory task ledger.
  const largeTask = "完整复刻已确认的 RTS 范围：建造、资源采集、战斗和寻路均可用";
  const loopStart = engine.start("loop", largeTask, "large-owner");
  assert(loopStart.ok);
  const loopId = engine.listInstances().find((i) => i.state.owner_session === "large-owner").id;
  const loopDir = engine.artifactsDirOf(loopId);
  assert(!fs.existsSync(`${loopDir}/tasks.md`));
  fs.writeFileSync(`${loopDir}/summary.md`, "本轮局部问题：寻路卡住\n");
  const resetsBefore = resets.length;
  const checksBefore = checks.length;
  loopSubmission++;
  assert(engine.onSubmit("large-owner", "局部进度").ok); await settle();
  assert.equal(resets.length, resetsBefore + 1);
  const retryDo = delivered.at(-1);
  for (const prompt of [loopStart.text, retryDo]) {
    assert(prompt.includes(largeTask));
    assert(prompt.includes("按用户要求完成任务"));
    assert(!prompt.includes("tasks.md"));
  }
  assert(retryDo.includes("寻路卡住"));
  assert(retryDo.includes("完成条件仍是当前步的完整要求"));
  assert.equal(engine.readState(loopId).do_submitted, false);
  assert(fs.readFileSync(`${loopDir}/summary.md`, "utf8").includes("寻路卡住"));
  loopSubmission++;
  assert(engine.onSubmit("large-owner", "寻路修好了").ok); await settle();
  assert.equal(engine.readState(loopId).do_submitted, false);
  assert.equal(engine.readState(loopId).fail_count, 2);
  assert(delivered.at(-1).includes("采集与战斗仍未完成"));
  const loopChecks = checks.slice(checksBefore);
  assert.equal(loopChecks.length, 6);
  assert(loopChecks.every((prompt) => prompt.includes(largeTask) && !prompt.includes("tasks.md")));
  assert(loopChecks.filter((prompt) => prompt.includes("## 你的检查依据（专属视角）\n用户任务的每一条要求都已落实")).length === 2);

  // The pointer must resolve in the published layout, not merely in this source checkout.
  const authoringRef = `${CREATE_SKILL_RESOURCES}/workflow-authoring.md`;
  assert(fs.readFileSync(authoringRef, "utf8").includes("进 DO 与 CHECK 提示词"));
  const packResult = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { encoding: "utf8" }));
  const pack = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  assert(pack.files.some((f) => f.path === "skills/ralphflow-create/workflow-authoring.md"));
  assert(pack.files.some((f) => f.path === "skills/ralphflow-create/SKILL.md"));
  fs.mkdirSync(`${root}/packed`);
  execFileSync("tar", ["-xzf", `${root}/${pack.filename}`, "-C", `${root}/packed`]);
  // 解包目录不是 `npm install` 的产物：依赖从仓库的 node_modules 借，模拟安装后的解析
  // （lib/skills.js 现在要读 SKILL.md，import 时会用到 js-yaml）。
  fs.symlinkSync(path.join(CREATE_SKILL_RESOURCES, "..", "..", "node_modules"), `${root}/packed/package/node_modules`, "dir");
  const packedSkills = await import(pathToFileURL(`${root}/packed/package/lib/skills.js`).href);
  assert(packedSkills.CREATE_SKILL_RESOURCES.startsWith(`${root}/packed/package/skills/ralphflow-create`));
  assert(fs.readFileSync(`${packedSkills.CREATE_SKILL_RESOURCES}/workflow-authoring.md`, "utf8").includes("进 DO 与 CHECK 提示词"));
  console.log("prompt contract checks passed — reset inputs, gate, independent evidence, host-specific checks, shipped reference");
} finally {
  for (const { state } of engine.listInstances()) engine.cancelInstance(state.owner_session);
  cleanupTmp(root);
}
