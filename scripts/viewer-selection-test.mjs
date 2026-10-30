#!/usr/bin/env node
/**
 * 工作图打开时显示哪个工作流（选择规则 + 下拉标记）。
 *
 * 判据：
 * 1. 有工作流在跑时，打开工作图就是它 —— 上次浏览偏好不能盖住运行中的那个；
 * 2. 用户本次手动选过的资产最高优先（浏览别的不能被强行拽回）；
 * 3. 没在跑时回落到上次浏览偏好，再回落到目录第一个；
 * 4. 下拉里只有运行中的那一个带「运行中」标记。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetMenuLabel, pickAssetName } from "../lib/client/selection.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const pick = (catalogNames, running, chosen, pinned) => pickAssetName({ catalogNames, running, chosen, pinned });

console.log("打开工作图先看哪个");
check("在跑时显示运行中的那个（不被上次浏览偏好盖住）", pick(["loop", "codewiki", "spec"], "loop", null, "codewiki") === "loop");
check("手动选过的资产最高优先（在跑时也能浏览别的）", pick(["loop", "codewiki"], "loop", "codewiki", "codewiki") === "codewiki");
check("没在跑 → 回到上次浏览偏好", pick(["loop", "codewiki"], null, null, "codewiki") === "codewiki");
check("没在跑也没偏好 → 目录第一个", pick(["loop", "codewiki"], null, null, null) === "loop");
check("运行中的工作流不在目录里 → 当作没在跑", pick(["loop", "codewiki"], "ghost", null, "codewiki") === "codewiki");
check("未知的手动选择被忽略", pick(["loop", "codewiki"], null, "ghost", "codewiki") === "codewiki");
check("未知的浏览偏好被忽略", pick(["loop"], null, null, "ghost") === "loop");
check("空目录返回空串", pick([], null, null, null) === "");
check("单资产目录稳定", pick(["loop"], "loop", "loop", "loop") === "loop");

console.log("下拉里的运行中标记");
const flow = { name: "loop", kind: "flow", steps: [1], nodes: [], invalid: false };
const graph = { name: "status-graph", kind: "graph", steps: [], nodes: [1, 2, 3, 4, 5], invalid: false };
const broken = { name: "bad", kind: "flow", steps: [1], nodes: [], invalid: true };
check("运行中的 Flow 行标「运行中」", assetMenuLabel(flow, "loop") === "loop · 1 步 · 运行中", assetMenuLabel(flow, "loop"));
check("非运行中的行不带标记", assetMenuLabel(graph, "loop") === "status-graph · 5 节点", assetMenuLabel(graph, "loop"));
check("运行中的 Graph 行标「运行中」", assetMenuLabel(graph, "status-graph") === "status-graph · 5 节点 · 运行中");
check("定义无效的标记仍然保留", assetMenuLabel(broken, null) === "bad · 1 步（定义无效）", assetMenuLabel(broken, null));
check("一行里标记不重复", assetMenuLabel(flow, "loop").match(/运行中/g).length === 1);

console.log("查看器不再让「上次浏览」盖住「正在跑」");
const source = fs.readFileSync(path.join(repo, "src/client/viewer.tsx"), "utf8");
check("查看器走 pickAssetName 这一条规则", source.includes("pickAssetName({ catalogNames"));
check("旧的 pinned 优先写法已消失", !/const pinned = pinnedName &&/.test(source));
check("运行中的工作流变化时作废手动选择", /setChosenName\(null\);\s*\}, \[running\]\)/.test(source));
check("下拉行统一走 assetMenuLabel", source.includes("assetMenuLabel(asset, running)"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
