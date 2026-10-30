# Graph 重构简报：按 Matt 的 implement-spec 做多 agent 并行

## 目标

Graph 的任务图、并行节点、独立 CHECK 都保留；把**并行实现**这一段按 Matt Pocock `implement-spec` 的形状重做，用 DSH 的原生能力实现：每个节点在自己的 worktree 与分支上完成，合并只做快进，冲突由写代码的那个 agent 解决。引擎负责调度与验收事实，能力留在 agent 手里。

## 参照物：Matt 的 implement-spec

来源 `github.com/mattpocock/skills`（v1.3.1，commit `5beb35b`）：`docs/engineering/implement-spec.md`、`skills/engineering/implement-spec/SKILL.md`、`docs/engineering/resolving-merge-conflicts.md`、`docs/engineering/implement.md`。

四条硬事实：

1. 结果是**一条 integration 分支**，不是影子引用。"merges each finished branch into a single integration branch."
2. 节点**在报告完成之前**把集成 tip 合进自己的分支。"merges the integration branch tip into its own branch before reporting done, so landing it is a fast-forward."
3. 合入的成功标准是**快进**。"It's working if: Merges into the integration branch are fast-forwards, not conflict resolutions."
4. 冲突由**写这个改动的会话**解决，不是末尾的冷启动 agent。"the merge back is best done by the session that wrote the change, because it is the one that already knows the intent. If one agent resolves everybody's conflicts at the end, it loses the context."

另有两条已知代价，照抄时不假装不存在：worktree 只有 git 跟踪的文件，依赖未跟踪素材的测试会在里面静默跳过；并行节点在共享文件上仍会碰撞，靠阻塞边与共享笔记收敛，不靠权限隔离。

## 现在错在哪

1. **把 worktree 当权限边界。** 我们用 worktree 隔离权限（节点沙箱根 = worktree），而 Matt 的 worktree 只是工作目录。结果是节点的 `.git` 在仓库根、对它只读，任何 `git commit` 都撞只读。
2. **引擎替 agent 冻 commit。** 节点产物被定义成"文件快照 + 引擎用临时 index 造出的 commit"，agent 全程不拥有 git；于是"合并"只能变成引擎工序。
3. **纪律写成机制。** 影子 ref、`RalphFlow-*` trailer 校验、CAS 前进、独立 integration 仓库 + fetch 回主仓库、专职 merger agent——都是第 1、2 条逼出来的补丁。模型看不见这些约束，只会撞墙。

## DSH 的能力事实

- 会话权限由该会话日志里最后一条 `sandbox/mode` 事件决定；`workspace-write` 的边界 = 会话 cwd；`danger-full-access` 不做限制。（`@deepseek-ai/dsh-sandbox-policy` 的 `resolve`/`overrideOf`）
- 子 agent 的 cwd 由创建时的 `meta.cwd` 决定，worktree 因此可以既是工作目录、又不当监狱。
- 当前我们把节点与 merger 写死成 `workspace-write`（`src/graph/engine.ts` 的 `setSandbox`），所以它们不能写 `.git`。这行是选择，不是平台限制；Claude Code 的子 agent 就是全权限、cwd 交给它。

## 要建成的形状

1. Graph 资产契约、DAG 调度、并发、人工门、CHECK（独立验证者）、状态与报告保持不变——这是产品面，也是与 Flow 的分界。
2. 集成线是仓库里的一条真分支（例如 `ralphflow/<实例>`），从启动时的 HEAD 切出；跑完 `git branch` 可见、`git checkout` 可看、`git merge` 可合。
3. 每个后台节点：独立 worktree + 自己的分支；节点 agent 有权限，自己 `git add` / `commit`。
4. 节点交卷前：把集成分支 tip 合进自己的分支，解决冲突，跑相关测试，再交卷。
5. 验收：CHECK 通过后，引擎把节点分支合进集成分支，只接受快进；不是快进就退回该节点（说明第 4 步没做到），不是另起一个 agent 解冲突。
6. 旧机制删除而不是并存：`refs/ralphflow/runs/*/integration`、`RalphFlow-*` trailer 校验、CAS、`integration-repo` 与 fetch 回主仓库、专职 merger agent。

## 验收事实（逐条可核对）

1. `git branch` 里有集成分支；从它能看到所有已接纳节点的改动。
2. 节点分支在交卷时已经包含当时的集成 tip（`git merge-base --is-ancestor <集成 tip> <节点分支>` 成立）。
3. 引擎的接纳路径只做快进；故意制造非快进时，节点被退回并说明原因。
4. 代码里搜不到第 6 条列出的旧机制。
5. 真实 Git 集成测试覆盖：两个节点并行、先后合入、后者基于前者的成果；冲突路径由节点自己解决后快进合入。
6. `npm run verify` 全绿；Flow 的语义、提示词与测试不变。

## 边界

- Flow 不动。
- 不新增平行权限面；节点 agent 的权限与 Claude Code 的子 agent 对齐即可。
- 不保留两套机制、不为通过验证绕过问题。发现旧设计错了就重写。
- 提示词与文档遵循 `references/matt/writing-for-agents.md`：能力放 agent，纪律写进文本，机制只留调度与验收。

## 真实运行

三段真实模型 + 真实 Git 的运行，证据在本次交卷目录（`real-run-evidence.txt`、`codewiki-final-evidence.txt`、`codewiki-report.md`）：

1. `two`（两个后台节点）：各自 commit；beta 首轮因没合集成线被退回，第二轮自己 merge 后快进接纳。
2. `onecheck`（带独立 CHECK 的单节点）：验证者通过，`integration_advanced` 把集成分支从基线快进到节点提交。
3. `codewiki`（枢纽仓库，5 节点）：5/5 接纳，集成分支 `ralphflow/codewiki-mvmre8x7-zuvj` 走到 `11163cd`，`docs/codewiki/` 9 个文件在里面；主人的分支与工作树全程未变。`survey` 只交产物、没有代码改动，接纳时集成分支停在基线。过程中 `operations-pages` 在 CHECK 通过后因没合集成线被退回一次、`core-pages` 一次 CHECK 未过后重做（另有一次通过 CHECK 但没合集成线被退回）；两次都自己合入后快进。

复现（headless 组合缺 `agent-preset-registry`，用 overlay 补上；web profile 自带，不需要）：

```
cd /home/yj/ralphflow-hub
dsh --profile <你的 headless profile> --patch <overlay 里补 agent-preset-registry> headless \
  "调用 ralphflow_start（workflow codewiki，task「分析一下这个代码仓」），
   然后每 30 秒调一次 ralphflow_status，直到 completed 或 paused"
```

跑完看结果：`git log --oneline ralphflow/<实例>`、`git ls-tree -r --name-only ralphflow/<实例>`。旧实例（影子 ref 时代）读取时补集成分支名与节点分支名，恢复时把 detached worktree 对齐到节点分支后继续。
