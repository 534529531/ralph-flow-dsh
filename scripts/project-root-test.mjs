#!/usr/bin/env node
/**
 * 项目根 / 用户根：路径规则必须与 DSH 原生 Skill 同源。
 *
 * 原生规则（`dsh-skill-filesystem` 的 `findProjectRoot` + `dsh-home-paths` 的
 * `resolveDshHome`）：
 *  - 项目根 = 从目录向上最近的含 `.git` 的祖先；没有就用该目录本身。
 *  - 用户根 = 显式配置 > `$DSH_HOME`（`~` 展开、空值视为未设置）> `~/.dsh`。
 *
 * 本用例断言：资产、实例、报告、产出全部挂在项目根；用户级资产挂在用户根；
 * 不存在 `RALPHFLOW_WORKSPACE` 这类第二套解析。
 */
import fs from "node:fs";
import path from "node:path";
import * as plugin from "../lib/index.js";
import { dshUserRoot, projectRootOf } from "../lib/paths.js";
import { globalWorkflowsDirOf } from "../lib/engine.js";
import { graphGlobalDir } from "../lib/graph/assets.js";
import { mkEnv, toolOf, execTool, mkTmp, cleanupTmp, instanceDirs, rfDir, statePathOf } from "./helpers/plugin-harness.mjs";

// HOME 隔离：用户根解析必须可观测，且绝不读写真实 ~/.dsh。
process.env.HOME = mkTmp("home");
delete process.env.DSH_HOME;
delete process.env.RALPHFLOW_WORKSPACE;

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };

console.log("P 项目根：最近的含 .git 的祖先，没有就用目录本身");
{
  const root = mkTmp("root-gitdir");
  fs.mkdirSync(path.join(root, ".git"));
  const deep = path.join(root, "packages", "app", "src");
  fs.mkdirSync(deep, { recursive: true });
  check("嵌套目录 → 仓库根", projectRootOf(deep) === root, projectRootOf(deep));
  check("根自己 → 自己", projectRootOf(root) === root, projectRootOf(root));

  const worktree = mkTmp("root-gitfile");
  fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere\n");
  const wtDeep = path.join(worktree, "a", "b");
  fs.mkdirSync(wtDeep, { recursive: true });
  check(".git 是文件（worktree/submodule）也算项目根", projectRootOf(wtDeep) === worktree, projectRootOf(wtDeep));

  const plain = mkTmp("root-none");
  const plainDeep = path.join(plain, "x", "y");
  fs.mkdirSync(plainDeep, { recursive: true });
  check("没有 .git → 会话目录本身（不向上猜）", projectRootOf(plainDeep) === plainDeep, projectRootOf(plainDeep));

  const sibling = mkTmp("root-sibling");
  fs.mkdirSync(path.join(sibling, ".git"));
  const notChild = mkTmp("root-not-child");
  check("兄弟仓库的 .git 不生效", !projectRootOf(notChild).startsWith(sibling), projectRootOf(notChild));

  for (const dir of [root, worktree, plain, sibling, notChild]) cleanupTmp(dir);
}

console.log("U 用户根：$DSH_HOME（含 ~ 与空值）> ~/.dsh");
{
  const home = process.env.HOME;
  check("未设置 → ~/.dsh", dshUserRoot() === path.join(home, ".dsh"), dshUserRoot());

  const absolute = path.join(mkTmp("dsh-home"), "custom");
  process.env.DSH_HOME = absolute;
  check("绝对路径 $DSH_HOME 生效", dshUserRoot() === absolute, dshUserRoot());
  check("Flow 用户级目录跟着用户根", globalWorkflowsDirOf() === path.join(absolute, "ralph-flow", "workflows"), globalWorkflowsDirOf());
  check("Graph 用户级目录跟着用户根", graphGlobalDir() === path.join(absolute, "ralph-flow", "graphs"), graphGlobalDir());

  process.env.DSH_HOME = "~/tilde-dsh";
  check("~ 展开到 HOME", dshUserRoot() === path.join(home, "tilde-dsh"), dshUserRoot());

  process.env.DSH_HOME = "   ";
  check("空白 $DSH_HOME 视为未设置（不落到进程 cwd）", dshUserRoot() === path.join(home, ".dsh"), dshUserRoot());

  delete process.env.DSH_HOME;
  cleanupTmp(path.dirname(absolute));
}

console.log("R1 Flow：会话在子目录，资产/实例落在项目根");
{
  process.env.HOME = mkTmp("home-flow");
  fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });
  const root = mkTmp("flow-root");
  fs.mkdirSync(path.join(root, ".git"));
  const deep = path.join(root, "packages", "app");
  fs.mkdirSync(deep, { recursive: true });
  const wfDir = path.join(root, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "root-flow.yaml"), [
    "description: 项目根探针",
    "steps:",
    "  - id: only",
    "    desc: 步骤 only",
    "    input: 任务",
    "    output: 产出",
    "    on_pass: done",
    "    on_fail: only",
    "    max_fail_count: 3",
    "    do: 做事。",
    "    check: 核对。",
  ].join("\n"));

  const { ctx, registered, sid } = mkEnv(deep, "sess-root-flow");
  plugin.apply(ctx);
  const start = toolOf(registered, "ralphflow_start");
  const list = toolOf(registered, "ralphflow_list");

  const listed = await execTool(list, {}, sid);
  check("子目录会话也看得到项目根的自定义工作流", listed.includes("`root-flow`"), listed.slice(0, 200));

  const out = await execTool(start, { workflow: "root-flow", task: "项目根用例" }, sid);
  check("启动按项目根解析到资产", !out.includes("未找到工作流") && !out.includes("无法启动"), out.slice(0, 240));
  const ids = instanceDirs(root);
  check("实例落在项目根 .dsh/ralph-flow/instances", ids.length === 1 && fs.existsSync(statePathOf(root, ids[0])), JSON.stringify(ids));
  check("子目录没有生成第二套 .dsh（没有双轨）", !fs.existsSync(path.join(deep, ".dsh")), path.join(deep, ".dsh"));

  const st = JSON.parse(fs.readFileSync(statePathOf(root, ids[0]), "utf8"));
  check("实例归属会话不变", st.owner_session === sid, st.owner_session);
  check("资产根与实例根一致", ids.length === 1 && fs.existsSync(path.join(rfDir(root), "workflows", "root-flow.yaml")));

  cleanupTmp(root);
  cleanupTmp(process.env.HOME);
}

console.log("R2 Graph：资产发现同样按项目根");
{
  process.env.HOME = mkTmp("home-graph");
  fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });
  const root = mkTmp("graph-root");
  fs.mkdirSync(path.join(root, ".git"));
  const deep = path.join(root, "src", "nested");
  fs.mkdirSync(deep, { recursive: true });
  const gDir = path.join(root, ".dsh", "ralph-flow", "graphs");
  fs.mkdirSync(gDir, { recursive: true });
  fs.writeFileSync(path.join(gDir, "root-graph.yaml"), [
    "kind: graph",
    "description: 项目根 Graph 探针",
    "steps:",
    "  - id: only",
    "    desc: 步骤 only",
    "    do: 做事。",
    "    output: out.md",
  ].join("\n"));

  const { ctx, registered, sid } = mkEnv(deep, "sess-root-graph");
  plugin.apply(ctx);
  const listed = await execTool(toolOf(registered, "ralphflow_list"), {}, sid);
  check("子目录会话看得到项目根的 Graph 资产", /\| `root-graph` \| Graph \|/.test(listed), listed.slice(0, 300));
  check("Graph 资产没有被当成 Flow", !/\| `root-graph` \| Flow \|/.test(listed), listed.slice(0, 300));

  cleanupTmp(root);
  cleanupTmp(process.env.HOME);
}

console.log("R3 用户级资产：$DSH_HOME 下的工作流对所有项目可见");
{
  process.env.HOME = mkTmp("home-global");
  const dshHome = mkTmp("dsh-home-global");
  process.env.DSH_HOME = dshHome;
  const globalWf = path.join(dshHome, "ralph-flow", "workflows");
  fs.mkdirSync(globalWf, { recursive: true });
  fs.writeFileSync(path.join(globalWf, "user-flow.yaml"), [
    "description: 用户级探针",
    "steps:",
    "  - id: only",
    "    desc: 步骤 only",
    "    do: 做事。",
    "    check: 核对。",
  ].join("\n"));

  const ws = mkTmp("user-asset-ws");
  const { ctx, registered, sid } = mkEnv(ws, "sess-user-asset");
  plugin.apply(ctx);
  const listed = await execTool(toolOf(registered, "ralphflow_list"), {}, sid);
  check("没有 .git 的项目也能看到用户级工作流", listed.includes("`user-flow`"), listed.slice(0, 250));
  check("全局目录就是 $DSH_HOME/ralph-flow/workflows", fs.existsSync(path.join(globalWf, "user-flow.yaml")));

  cleanupTmp(ws);
  cleanupTmp(dshHome);
  cleanupTmp(process.env.HOME);
  delete process.env.DSH_HOME;
}

console.log("R4 没有第二套解析：RALPHFLOW_WORKSPACE 不再生效");
{
  process.env.HOME = mkTmp("home-decoy");
  fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });
  const root = mkTmp("decoy-root");
  fs.mkdirSync(path.join(root, ".git"));
  const deep = path.join(root, "sub");
  fs.mkdirSync(deep, { recursive: true });
  const decoy = mkTmp("decoy-workspace");
  process.env.RALPHFLOW_WORKSPACE = decoy;

  const { ctx, registered, sid } = mkEnv(deep, "sess-decoy");
  plugin.apply(ctx);
  const out = await execTool(toolOf(registered, "ralphflow_start"), { workflow: "loop", task: "环境变量旁路用例" }, sid);
  const ids = instanceDirs(root);
  check("实例仍落在项目根", ids.length === 1, JSON.stringify(ids));
  check("RALPHFLOW_WORKSPACE 指向的目录没有被写入", !fs.existsSync(path.join(decoy, ".dsh")), out.slice(0, 160));

  delete process.env.RALPHFLOW_WORKSPACE;
  cleanupTmp(root);
  cleanupTmp(decoy);
  cleanupTmp(process.env.HOME);
}

console.log("R5 有效工作目录：workingDirectory 服务在场时按它解析");
{
  process.env.HOME = mkTmp("home-wd");
  fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });
  const launchRoot = mkTmp("wd-launch");
  fs.mkdirSync(path.join(launchRoot, ".git"));
  const deep = path.join(launchRoot, "sub");
  fs.mkdirSync(deep, { recursive: true });
  const currentRoot = mkTmp("wd-current");
  fs.mkdirSync(path.join(currentRoot, ".git"));
  const wfDir = path.join(currentRoot, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "wd-flow.yaml"), [
    "description: 有效目录探针",
    "steps:",
    "  - id: only",
    "    desc: 步骤 only",
    "    input: 任务",
    "    output: 产出",
    "    on_pass: done",
    "    on_fail: only",
    "    max_fail_count: 3",
    "    do: 做事。",
    "    check: 核对。",
  ].join("\n"));

  const { ctx, registered, sid } = mkEnv(deep, "sess-working-dir");
  // 用户 `/cd` 后的有效目录：与 header.cwd 不同，原生 Skill 也按它解析项目根。
  ctx.provide("workingDirectory", { get: () => currentRoot });
  plugin.apply(ctx);
  const out = await execTool(toolOf(registered, "ralphflow_start"), { workflow: "wd-flow", task: "有效目录用例" }, sid);
  check("启动按有效工作目录找到资产", !out.includes("未找到工作流") && !out.includes("无法启动"), out.slice(0, 200));
  const ids = instanceDirs(currentRoot);
  check("实例落在当前项目根，而不是会话 header 的原始目录", ids.length === 1 && !fs.existsSync(path.join(launchRoot, ".dsh")), JSON.stringify(ids));

  cleanupTmp(launchRoot);
  cleanupTmp(currentRoot);
  cleanupTmp(process.env.HOME);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
