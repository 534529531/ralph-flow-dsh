/**
 * DSH 原生路径规则：**项目根 / 用户根**。
 *
 * 规则与 `@deepseek-ai/dsh-skill-filesystem` 的 Skill 根一致（源码在
 * `findProjectRoot` 与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`）：
 *
 * - 项目根：从目录向上找到最近的**含 `.git`** 的祖先目录；一个都没有就用该目录本身
 *   （原生 Skill 的 `<projectRoot>/.dsh/skills` 就是这条规则）。
 * - 用户根：`resolveDshHome()` —— 显式配置 > `$DSH_HOME`（支持 `~`，空值视为未设置）
 *   > `~/.dsh`。
 *
 * 插件的项目级数据（资产 + 实例/报告/产出）全部挂在项目根；用户级资产挂在用户根。
 * 这里只解析路径，不建目录、不校验内容。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** 插件命名空间：项目内 `.dsh/ralph-flow/`，用户级 `<DSH_HOME>/ralph-flow/`。 */
export const RALPH_FLOW_NAME = "ralph-flow";

/**
 * 项目根：最近的含 `.git` 的祖先目录；没有就用 `dir` 本身。
 *
 * `.git` 既可以是目录也可以是文件（worktree/submodule），`existsSync` 两种都算。
 */
export function projectRootOf(dir: string): string {
  const start = path.resolve(dir);
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** 用户根：`$DSH_HOME` 或 `~/.dsh`（与原生 Skill 用户根同一套解析）。 */
export function dshUserRoot(): string {
  return resolveDshHome();
}

/** 用户级插件目录：`<DSH_HOME|~/.dsh>/ralph-flow[/...]`。 */
export function userRalphFlowDir(...segments: string[]): string {
  return path.join(dshUserRoot(), RALPH_FLOW_NAME, ...segments);
}
