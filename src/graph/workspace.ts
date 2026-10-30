/**
 * Graph 的 Git 工作区：运行基线、集成分支、节点 worktree 与分支、节点改动快照。
 *
 * 分工与 `implement-spec` 一致：节点 agent 在自己的 worktree 和分支上改代码、提交，
 * 交卷前把集成分支合进自己的分支；引擎只做调度与验收——确认节点分支已经包含集成分支
 * 的最新提交，然后把集成分支快进到节点分支。**合入是一次引用前进**：两个分支都在同一个
 * 仓库里，验收与推进都只读写 `refs/heads/`。
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { graphInstanceDirOf } from "./state.js";
import { INTEGRATION_BRANCH_PREFIX, NODE_BRANCH_PREFIX, integrationBranchFor, nodeBranchFor } from "./branches.js";

const execFile = promisify(execFileCallback);

export { INTEGRATION_BRANCH_PREFIX, NODE_BRANCH_PREFIX, integrationBranchFor, nodeBranchFor };
export const WORKTREES_DIRNAME = "worktrees";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "RalphFlow",
  GIT_AUTHOR_EMAIL: "ralphflow@example.invalid",
  GIT_COMMITTER_NAME: "RalphFlow",
  GIT_COMMITTER_EMAIL: "ralphflow@example.invalid",
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout;
}

export async function gitSafe(cwd: string, ...args: string[]): Promise<string | null> {
  try { return await git(cwd, ...args); } catch { return null; }
}

export interface ProjectSnapshot {
  root: string;
  baseline: string;
  clean: boolean;
}

/** 工作区必须是 Git 仓库且有可用 HEAD；不要求工作树干净（只记录事实）。 */
export async function resolveProject(workspace: string): Promise<ProjectSnapshot> {
  let toplevel: string;
  try {
    toplevel = (await git(workspace, "rev-parse", "--show-toplevel")).trim();
  } catch (error) {
    throw new Error("Graph 需要 Git 隔离，但当前工作区不是 Git 仓库。先问用户是否初始化 Git；得到明确同意后执行 git init、git add -A、git commit -m baseline，再重新调用 ralphflow_start；启动成功即完成。");
  }
  const root = fs.realpathSync(toplevel);
  let baseline: string;
  try {
    baseline = (await git(root, "rev-parse", "--verify", "HEAD^{commit}")).trim();
  } catch {
    throw new Error("Graph 需要 Git 隔离，但这个仓库还没有 HEAD 基线。先问用户是否把当前文件提交为基线；同意后执行 git add -A、git commit -m baseline，再重新调用 ralphflow_start；启动成功即完成。");
  }
  const status = (await git(root, "status", "--porcelain=v1", "--untracked-files=all")).trim();
  // 运行时目录 `.dsh/ralph-flow/` 不进基线，也不应把 Graph 启动判成“脏工作区”。
  const relevant = status.split(/\r?\n/).filter((line) => line.length > 0 && !/\.dsh\/ralph-flow\//.test(line));
  return { root, baseline, clean: relevant.length === 0 };
}

/** 集成分支从基线切出；实例被恢复时沿用它当前的分支头。 */
export async function ensureIntegrationBranch(root: string, branch: string, baseline: string): Promise<string> {
  const existing = await gitSafe(root, "rev-parse", "--verify", `refs/heads/${branch}`);
  if (existing && existing.trim()) return existing.trim();
  await git(root, "branch", branch, baseline);
  return baseline;
}

export async function branchTip(root: string, branch: string): Promise<string | null> {
  const value = await gitSafe(root, "rev-parse", "--verify", `refs/heads/${branch}`);
  return value && value.trim() ? value.trim() : null;
}

/** 快进集成分支。调用方先证明节点分支包含 previous，这里只做引用前进。 */
export async function advanceIntegration(root: string, branch: string, previous: string, commit: string): Promise<void> {
  await git(root, "update-ref", `refs/heads/${branch}`, commit, previous);
}

export async function containsCommit(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

export function worktreeRootOf(workspace: string, instId: string): string {
  return path.join(graphInstanceDirOf(workspace, instId), WORKTREES_DIRNAME);
}

export function nodeWorktreePathOf(workspace: string, instId: string, nodeId: string): string {
  return path.join(worktreeRootOf(workspace, instId), nodeId);
}

async function listedWorktrees(root: string): Promise<Set<string>> {
  const listing = await git(root, "worktree", "list", "--porcelain");
  return new Set(listing.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length))));
}

/**
 * 把已存在的 worktree 对齐到节点分支。
 *
 * 已存在的 worktree 可能不在节点分支上（例如旧状态没有 `branch`，或 HEAD 是 detached）。
 * 恢复时若只沿用目录，节点会在一个不属于任何分支的 HEAD 上工作，提交无法按节点分支合入。
 * 分支已存在就切过去；不存在就在当前 HEAD 上补建（当前提交因此留在节点分支上）。
 */
async function alignWorktreeBranch(worktreePath: string, branch: string): Promise<void> {
  const current = (await git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (current === branch) return;
  try {
    const hasBranch = await gitSafe(worktreePath, "rev-parse", "--verify", `refs/heads/${branch}`);
    if (hasBranch) await git(worktreePath, "checkout", branch);
    else await git(worktreePath, "checkout", "-b", branch);
  } catch (error) {
    throw new Error(`节点 worktree \`${worktreePath}\` 当前在 \`${current}\`，无法对齐到节点分支 \`${branch}\`：${error instanceof Error ? error.message : String(error)}。先处理工作树里的未提交改动，再重新 continue。`);
  }
}

/** 节点 worktree 建在节点自己的分支上：`git worktree add -b <branch> <path> <起点>`。 */
export async function ensureNodeWorktree(root: string, workspacePath: string, branch: string, startPoint: string): Promise<{ path: string; created: boolean }> {
  const absolute = path.resolve(workspacePath);
  if (fs.existsSync(absolute)) {
    const head = await gitSafe(absolute, "rev-parse", "HEAD");
    if (!head) throw new Error(`节点 worktree 路径已存在但不是 Git worktree：${absolute}。保留现场，请人工检查。`);
    await alignWorktreeBranch(absolute, branch);
    return { path: fs.realpathSync(absolute), created: false };
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const hasBranch = await gitSafe(root, "rev-parse", "--verify", `refs/heads/${branch}`);
  if (hasBranch) await git(root, "worktree", "add", absolute, branch);
  else await git(root, "worktree", "add", "-b", branch, absolute, startPoint);
  return { path: fs.realpathSync(absolute), created: true };
}

export type NodeReadiness =
  | { ok: true; head: string; aligned: boolean }
  | { ok: false; reason: string };

/**
 * 节点交卷后的 Git 事实：worktree 的 HEAD 在**节点分支**上、工作树没有未提交的跟踪改动，
 * 且节点分支已经包含集成分支的最新提交。验收看的是状态里记录的节点分支，不是 worktree 的
 * 游离 HEAD —— 在 detached HEAD 上提交再合集成线，改动没有落在节点分支上，合入时接不住。
 *
 * 不成立就是「合入集成分支」这一步没做——退回节点自己处理，不另起 agent 解冲突。
 * 例外只有一个：节点没有任何提交（只交产物），它的节点分支还停在基线。这时没有内容要合，
 * 但分支仍要跟上集成 tip（一次 `merge --ff-only`），否则“节点分支包含集成 tip”不成立，
 * 后面节点的合入链也会断在一条旧分支上。
 */
export async function nodeReadyForIntegration(input: {
  worktreePath: string;
  nodeBranch: string;
  baseline: string;
  integrationBranch: string;
  integrationTip: string;
}): Promise<NodeReadiness> {
  const branchHead = (await gitSafe(input.worktreePath, "rev-parse", "--verify", `refs/heads/${input.nodeBranch}`))?.trim();
  if (!branchHead) {
    return {
      ok: false,
      reason: `节点分支 \`${input.nodeBranch}\` 不存在：提交要落在节点分支上，不能在 detached HEAD 或别的分支上。`,
    };
  }
  const attached = (await gitSafe(input.worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"))?.trim();
  if (!attached) {
    const head = (await gitSafe(input.worktreePath, "rev-parse", "HEAD"))?.trim() ?? "?";
    return {
      ok: false,
      reason: `worktree 现在在 detached HEAD（${head.slice(0, 12)}…），提交不在节点分支 \`${input.nodeBranch}\` 上。先 \`git switch ${input.nodeBranch}\`，把要保留的提交放回节点分支，再交卷。`,
    };
  }
  if (attached !== input.nodeBranch) {
    return {
      ok: false,
      reason: `worktree 现在在分支 \`${attached}\`，不是节点分支 \`${input.nodeBranch}\`。切回节点分支、确认提交在上面，再交卷。`,
    };
  }
  const head = (await gitSafe(input.worktreePath, "rev-parse", "HEAD"))?.trim();
  if (!head || head !== branchHead) {
    return { ok: false, reason: `worktree 的 HEAD 与节点分支 \`${input.nodeBranch}\` 的头不一致，先让两者对齐再交卷。` };
  }
  const dirty = ((await gitSafe(input.worktreePath, "status", "--porcelain", "--untracked-files=no")) ?? "").trim();
  if (dirty) {
    return { ok: false, reason: `工作树还有未提交的改动，先把它们提交到节点分支：\n${dirty}` };
  }
  // 这个节点没有提交任何东西（产物走 artifact）：没有内容要合，但分支要快进到集成 tip。
  if (branchHead === input.baseline) {
    if (input.integrationTip === branchHead) return { ok: true, head, aligned: false };
    if (!await containsCommit(input.worktreePath, branchHead, input.integrationTip)) {
      return {
        ok: false,
        reason: `集成分支 \`${input.integrationBranch}\` 的最新提交 ${input.integrationTip.slice(0, 12)}… 不包含节点分支的基线；先让工作区跟上集成分支再交卷。`,
      };
    }
    try {
      await git(input.worktreePath, "merge", "--ff-only", input.integrationTip);
    } catch (error) {
      return {
        ok: false,
        reason: `节点分支没有提交，引擎要把这条空分支快进到集成分支头，但工作树挡住了：${error instanceof Error ? error.message : String(error)}。先处理挡路的未跟踪文件，再交卷。`,
      };
    }
    const aligned = (await git(input.worktreePath, "rev-parse", "HEAD")).trim();
    return { ok: true, head: aligned, aligned: true };
  }
  if (!await containsCommit(input.worktreePath, input.integrationTip, branchHead)) {
    return {
      ok: false,
      reason: `节点分支 \`${input.nodeBranch}\` 还没有包含集成分支 \`${input.integrationBranch}\` 的最新提交 ${input.integrationTip.slice(0, 12)}…：把它合进你的分支（冲突在你这轮解决）、跑测试、再交卷。`,
    };
  }
  return { ok: true, head: branchHead, aligned: false };
}

export interface WorkspaceChanges {
  path: string;
  sha256: string;
  files: string[];
  head: string;
}

/**
 * 捕获节点工作区相对基线的变更快照（含节点自己的提交），供独立验证者取证。
 * 写入 `<artifactDir>/workspace-changes.json`；内容不可信，只作证据。
 */
export async function captureWorkspaceChanges(worktreePath: string, baseline: string, artifactDir: string): Promise<WorkspaceChanges> {
  const head = (await git(worktreePath, "rev-parse", "HEAD")).trim();
  const trackedDiff = await gitSafe(worktreePath, "diff", "--no-ext-diff", "--no-color", "--binary", "--unified=3", baseline, "--") ?? "";
  const tracked = (await gitSafe(worktreePath, "diff", "--name-only", "-z", baseline, "--") ?? "").split("\0").filter(Boolean);
  const untracked = (await gitSafe(worktreePath, "ls-files", "--others", "--exclude-standard", "-z") ?? "").split("\0").filter(Boolean);
  const commits = ((await gitSafe(worktreePath, "log", "--oneline", "--no-decorate", `${baseline}..HEAD`)) ?? "").trim();
  const files = [...new Set([...tracked, ...untracked])].sort();
  const snapshot = {
    baseline,
    head,
    commits: commits ? commits.split("\n") : [],
    files,
    trackedDiff: trackedDiff.slice(0, 256 * 1024),
    trackedDiffTruncated: trackedDiff.length > 256 * 1024,
    untrackedFiles: untracked,
  };
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, "workspace-changes.json");
  const content = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  fs.writeFileSync(file, content);
  return { path: file, sha256: createHash("sha256").update(content).digest("hex"), files, head };
}

/** cleanup：移除干净且已登记的节点 worktree；节点提交留在它自己的分支上。 */
export async function removeCleanWorktree(root: string, worktreePath: string): Promise<{ removed: boolean; reason?: string }> {
  const absolute = path.resolve(worktreePath);
  const registered = await listedWorktrees(root);
  if (!registered.has(absolute)) return { removed: false, reason: "not_registered" };
  const status = await gitSafe(absolute, "status", "--porcelain=v1", "--untracked-files=all", "--ignored");
  if (status === null) return { removed: false, reason: "unreadable" };
  if (status.trim()) return { removed: false, reason: "worktree_has_changes" };
  try {
    await git(root, "worktree", "remove", absolute);
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 用户可见的相对路径（正斜杠）；工作区外返回 null。 */
export function workspaceRelative(workspace: string, absolute: string): string | null {
  const rel = path.relative(path.resolve(workspace), path.resolve(absolute));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
