#!/usr/bin/env node
/**
 * 工作图阶段投影（DO / CHECK 可分辨 + 在飞色不再退化成黑白）。
 *
 * 判据：
 * 1. Flow 当前步在 DO 与 CHECK 两个阶段给出的芯片**不同**（旧版两阶段都写「执行中」，
 *    光看工作图分不出引擎在哪个阶段）；
 * 2. Graph 节点的 执行中 / 验证中 也分别落在 DO / CHECK 芯片上，且保留节点投影里的 label；
 * 3. 在飞语气 run 走的是有彩色的业务色，不是黑白品牌色（夜间模式不能退化成纯黑白）；
 * 4. 静态浏览只描述结构，不假装有进度。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flowPanelStatus, flowPhaseChips, graphAssetChips, graphPhaseChips, statusToneOf } from "../lib/client/phase.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const TONES = ["run", "done", "wait", "fault", "off"];
const labels = (chips) => chips.map((chip) => chip.label);
const tones = (chips) => chips.map((chip) => chip.tone);
const shapeOk = (chips) => chips.length > 0 && chips.every((chip) => typeof chip.label === "string" && chip.label.length > 0 && TONES.includes(chip.tone));

const flow = (stage, votes = []) => ({ stage, votes: votes.map((status, index) => ({ index: index + 1, status, reason: "" })) });
const node = (status, label, check = { mode: "custom", status: "pending" }) => ({
  id: "n", name: "N", status, label, dependsOn: [], attempts: 1, current: true, execution: "background",
  artifact: null, check: { ...check, reason: "", reworks: 0 }, manual: "not_required", integration: "not_required",
  integrationCommit: null, todoId: null,
});

console.log("Flow：当前步分得出 DO 与 CHECK");
const doing = flowPhaseChips(flow("executing", ["pending", "pending", "pending"]));
check("executing → DO 执行中 + CHECK 待验证", labels(doing).join("|") === "DO · 执行中|CHECK · 待验证", JSON.stringify(doing));
check("executing 的 DO 芯片是在飞语气", tones(doing)[0] === "run");
const checking = flowPhaseChips(flow("verifying", ["running", "pending", "pending"]));
check("verifying → DO 已交卷 + CHECK 验证中", labels(checking).join("|") === "DO · 已交卷|CHECK · 验证中 0/3", JSON.stringify(checking));
check("verifying 与 executing 的芯片不同（旧版两阶段都是「执行中」）", labels(doing).join("|") !== labels(checking).join("|"));
check("verifying 的 DO 芯片是已完成语气、CHECK 是在飞语气", tones(checking)[0] === "done" && tones(checking)[1] === "run");
const partial = flowPhaseChips(flow("verifying", ["passed", "infra", "running"]));
check("投票进度按已出终态的票数算", partial[1].label === "CHECK · 验证中 2/3", JSON.stringify(partial));
const single = flowPhaseChips(flow("verifying", ["running"]));
check("单票 CHECK 不写 0/1", single[1].label === "CHECK · 验证中", JSON.stringify(single));
const noCheck = flowPhaseChips(flow("executing"));
check("无 CHECK 的步骤只报 DO", labels(noCheck).join("|") === "DO · 执行中", JSON.stringify(noCheck));
check("gate（有票）→ 已交卷 + CHECK 已通过 + 等待你放行", labels(flowPhaseChips(flow("gate", ["passed", "passed", "passed"]))).join("|") === "DO · 已交卷|CHECK · 已通过|等待你放行");
check("gate（无票）不假称 CHECK 已通过", labels(flowPhaseChips(flow("gate"))).join("|") === "DO · 已交卷|等待你放行");
check("switching（有票）→ 已交卷 + CHECK 已通过", labels(flowPhaseChips(flow("switching", ["passed", "passed", "passed"]))).join("|") === "DO · 已交卷|CHECK · 已通过");
check("switching（无票）不假称已交卷", labels(flowPhaseChips(flow("switching"))).join("|") === "切换步骤中");
check("paused → 已暂停（等你）", labels(flowPhaseChips(flow("paused"))).join("|") === "已暂停" && tones(flowPhaseChips(flow("paused")))[0] === "wait");
check("done → 已完成", labels(flowPhaseChips(flow("done"))).join("|") === "已完成");
check("failed → 失败（故障语气）", tones(flowPhaseChips(flow("failed")))[0] === "fault");
check("cancelled → 已取消", labels(flowPhaseChips(flow("cancelled"))).join("|") === "已取消");
check("unavailable → 状态不可用", labels(flowPhaseChips(flow("unavailable"))).join("|") === "状态不可用");
for (const stage of ["executing", "verifying", "gate", "paused", "switching", "done", "cancelled", "failed", "unavailable"]) {
  const chips = flowPhaseChips(flow(stage, ["passed", "failed", "infra"]));
  check(`阶段 ${stage} 的芯片形状合法`, shapeOk(chips), JSON.stringify(chips));
}

console.log("Graph：节点分得出 DO 与 CHECK");
const running = graphPhaseChips(node("running", "执行中"));
check("running → DO 执行中 + CHECK 待验证", labels(running).join("|") === "DO · 执行中|CHECK · 待验证", JSON.stringify(running));
check("running（CHECK 关闭）→ CHECK 关闭", labels(graphPhaseChips(node("running", "执行中", { mode: "disabled", status: "skipped" }))).join("|") === "DO · 执行中|CHECK · 关闭");
const verifying = graphPhaseChips(node("verifying", "验证中"));
check("verifying → DO 已交卷 + CHECK 验证中", labels(verifying).join("|") === "DO · 已交卷|CHECK · 验证中", JSON.stringify(verifying));
check("verifying 与 running 的芯片不同", labels(running).join("|") !== labels(verifying).join("|"));
check("reworking → 未通过 + 节点 label", labels(graphPhaseChips(node("reworking", "等待返工"))).join("|") === "DO · 已交卷|CHECK · 未通过|等待返工");
check("waiting_review → CHECK 已通过 + 等待你放行", labels(graphPhaseChips(node("waiting_review", "等待你放行"))).join("|") === "DO · 已交卷|CHECK · 已通过|等待你放行");
check("integrating → CHECK 已通过 + 合入中（在飞）", labels(graphPhaseChips(node("integrating", "合入中"))).join("|") === "CHECK · 已通过|合入中" && tones(graphPhaseChips(node("integrating", "合入中")))[1] === "run");
check("completed（有 CHECK）→ 已完成 + CHECK 已通过", labels(graphPhaseChips(node("completed", "已完成", { mode: "custom", status: "passed" }))).join("|") === "已完成|CHECK · 已通过");
check("completed（CHECK 关闭）不写 CHECK 已通过", labels(graphPhaseChips(node("completed", "已完成", { mode: "disabled", status: "skipped" }))).join("|") === "已完成");
check("blocked → 等待依赖（未开始语气）", labels(graphPhaseChips(node("blocked", "等待依赖"))).join("|") === "等待依赖" && tones(graphPhaseChips(node("blocked", "等待依赖")))[0] === "off");
check("pending → 待开始", labels(graphPhaseChips(node("pending", "待开始"))).join("|") === "待开始");
check("failed → 失败（故障语气）", tones(graphPhaseChips(node("failed", "失败")))[0] === "fault");
check("interrupted → 已中断（故障语气）", tones(graphPhaseChips(node("interrupted", "已中断")))[0] === "fault");
for (const status of ["pending", "blocked", "running", "verifying", "reworking", "waiting_review", "waiting", "integrating", "accepting", "completed", "failed", "cancelled", "interrupted"]) {
  const chips = graphPhaseChips(node(status, "标签"));
  check(`节点状态 ${status} 的芯片形状合法`, shapeOk(chips), JSON.stringify(chips));
}

console.log("静态浏览与详情状态条");
check("静态节点只说结构：待开始 + CHECK 自定义（都中性）", labels(graphAssetChips({ checkMode: "custom" })).join("|") === "待开始|CHECK · 自定义" && tones(graphAssetChips({ checkMode: "custom" })).every((tone) => tone === "off"));
check("静态节点（CHECK 关闭）", labels(graphAssetChips({ checkMode: "disabled" })).join("|") === "待开始|CHECK · 关闭");
check("详情状态条：DO → running，CHECK → verifying", flowPanelStatus(flow("executing"), true) === "running" && flowPanelStatus(flow("verifying"), true) === "verifying");
check("详情状态条：gate/paused → waiting，done → completed", flowPanelStatus(flow("gate"), true) === "waiting" && flowPanelStatus(flow("paused"), true) === "waiting" && flowPanelStatus(flow("done"), true) === "completed");
check("非当前步的详情条不显示在飞", flowPanelStatus(flow("verifying"), false) === "pending" && flowPanelStatus(null, true) === "pending");
check("语气枚举封闭", ["completed", "running", "waiting_review", "failed", "whatever"].map(statusToneOf).join("|") === "done|run|wait|fault|off");

console.log("在飞色不能是黑白品牌色");
const css = fs.readFileSync(path.join(repo, "src/client/viewer.tsx"), "utf8");
check("--rv-run 用业务色（有彩色）", /--rv-run:\s*var\(--dsw-alias-state-business-primary\)/.test(css), css.match(/--rv-run:[^;]*/)?.[0] ?? "missing");
check("--rv-accent 用彩色业务色（焦点环/选中不再用黑白品牌色）", /--rv-accent:\s*var\(--rv-run\)/.test(css) && !/--rv-accent:\s*var\(--dsw-alias-brand-primary\)/.test(css), css.match(/--rv-accent:[^;]*/)?.[0] ?? "missing");
check("查看器不再把「执行中」写死给当前步骤", !/current\s*\?\s*"执行中"/.test(css));
check("查看器颜色全部来自 dsh token", !/rgba?\(|#[0-9a-f]{3,8}\b/i.test(css));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
