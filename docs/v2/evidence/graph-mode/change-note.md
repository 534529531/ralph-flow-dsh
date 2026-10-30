# Graph 模式实现记录（change note）

> 依据：[`graph-mode-design.md`](../../graph-mode-design.md) §8 阶段 1→6；宪法以 [`design.md`](../../design.md) 为准。
> 实现日期：2026-10-21。状态：**已实现**；本文件记录改了什么、验收取证、与参考实现的刻意差异与未覆盖项。

## 改了什么

### 阶段 1：资产契约与加载
- 新增 `src/graph/asset.ts`：Graph 资产 schema、`kind: graph`、依赖环、输入引用、`manual_step`、`maxParallelAgents`、CHECK 归一化、`DSH_RALPHFLOW_*` 环境命名空间。
- 新增 `src/graph/assets.ts`：`graphs/`（工作区 → 全局 → 内置）发现、目录/kind 一致性、跨类别同名冲突、内置 `codewiki` / `design-graph`。
- 新增 `src/assets.ts`：统一资产清单（Flow + Graph、kind、步骤/节点数、冲突标记）。
- `src/engine.ts`：Flow 加载器接受可选 `kind: flow`；`nodes` 进 `workflows/`、`kind: graph` 进 Flow 加载器都是硬错误；`WorkflowEntry` 增加步骤数；Flow 状态读取跳过 `kind: graph`；doctor 不再把保留的 Graph 实例当异常残留。
- 新增 `graphs/codewiki.yaml`、`graphs/design-graph.yaml` 与 `references/` 随包参考（design-methods / graph-authoring / testing-workflow / writing-for-agents）。

### 阶段 2：Graph 状态、调度与 CHECK
- 新增 `src/graph/state.ts`：**只存主事实**（attempts / submissions / verdicts / acceptances / human_todos / integration / worktrees），节点状态、当前节点、等待原因全部现算；Graph 实例完成/取消保留状态。
- 新增 `src/graph/engine.ts`：DAG 调度（`dependsOn` + `maxParallelAgents`，单调度器防 pause/continue 重入）、节点 attempt、背景节点 `ctx.agents.create`（独立会话 / worktree / 作用域工具，显式传父会话模型选项）、主执行节点（`execution: main`）、人工审查门（改稿要求进入下一 attempt 的 DO）、返工上限 2、暂停/继续/取消/cleanup、宿主重开标记 `interrupted`。
- 新增 `src/graph/workspace.ts`：Git 基线、节点 worktree、integration ref `refs/ralphflow/runs/<instance>/integration`、临时 index 造节点结果提交（`RalphFlow-*` trailer）、merger agent、引擎机械校验（HEAD/祖先/干净树/测试/CAS）。
- `src/verify.ts`：`VerifyRequest.graph` 与 Graph CHECK 提示词 / 逐条证据结构化输出；判定仍走同一个 `runVerifier`（T1），解析不出 → infra。
- 新增 `src/facade.ts`：按 `kind` 路由 Flow / Graph；统一 `start/continue/cancel/status/list/doctor/restore/uiStatus`；Flow 分支逐字委托原引擎。
- `src/index.ts`：每个工作区一个门面，状态流/事件/技能改用门面。

### 阶段 3：工具、命令与技能
- 主工具仍是 8 个；`ralphflow_start` 增加 Graph `inputs` / 资源根；Graph 节点 agent 只见 `ralphflow_artifact_write`（作用域）与 `ralphflow_submit`（按绑定分派）；`ralphflow_respond` 只在有 Graph 人工待办时挂到主会话作用域。
- 新增 `/ralphflow-pause`、`/ralphflow-cleanup`（Graph-only 机械命令，均不注册同名工具）；`/ralphflow-reset`、`/ralphflow-rewind` 对 Graph 明确拒绝。
- `ralphflow_create` 增加 `kind`：Flow 返回创建指南；Graph 用同一公开 `start` 启动 `design-graph` 设计运行。
- 技能发现同时枚举 Flow 与 Graph（`/ralphflow-codewiki`、`/ralphflow-design-graph`）。

### 阶段 4：报告、历史与保留
- Graph 报告归档到 `.dsh/ralph-flow/reports/<instance>.md`（头部字段与 Flow 历史解析兼容），执行日志同格式归档。
- 完成/取消保留 `state.json`、日志、产物、worktree；`ralphflow_list` 同时显示保留的 Graph 实例；doctor 不再误报。
- `cleanup` 只删除已登记、干净、HEAD 未移动的节点 worktree，不动 state/artifacts/reports。

### 阶段 5：只读查看器
- `src/status-contract.ts`：`WorkflowStatus.kind` 与 `graph` 投影、`StatusFrame.catalog`（Flow 步骤链 + Graph DAG 的 DO/CHECK/依赖）。
- `src/facade.ts`：`viewerCatalog()`（5 秒缓存，只读）；`uiStatus` 在 Flow/Graph 间按活跃度/更新时间选择。
- `src/client/viewer.tsx`：右侧栏只读 tab（Flow/Graph 分组、节点详情、当前状态覆盖）；与状态胶囊共享同一个 `ralphflowStatus` 流。
- `src/client/index.ts` / `package.json`：注册 `@deepseek-ai/dsh-client-ui-sidebar-right`，`dsh.client.inject` 增加该包；`files` 增加 `graphs/`。

### 阶段 6：design-graph、create 与文档
- 公开内置 `design-graph`（主执行节点、runInputs、校验 → 交付）；`codewiki` 迁入 `graphs/` 并去掉 RalphGraph 命名。
- `ralphflow_doctor` 可只诊断工作流名或工作区路径，Graph 按 Graph schema 报错并列出有效 CHECK。
- 文档同步：`README`、`docs/commands.md`、`docs/custom-workflows.md`、`docs/how-it-works.md`、`docs/README.md`、`docs/v2/design.md`、`docs/v2/README.md`、`docs/v2/delivery-classification.md`、`docs/v2/skills-vs-commands.md`、`references/workflow-authoring.md`；新增根目录 `GLOSSARY.md`（Flow/Graph/节点/attempt/接纳等产品词汇）。

## 验收取证

- `npm run typecheck`：通过。
- `npm run build`：通过（含 `lib/client.js` bundle）。
- `npm run verify`：**32/32 支通过**（含全部既有 Flow 回归与 4 支新增 Graph 用例）。
- 新增用例：
  - `scripts/graph-asset-test.mjs` 29 条：内置资产、kind/目录/结构、跨类别同名、check_voting 硬错误、依赖环、runInputs、Flow 回归。
  - `scripts/graph-engine-test.mjs` 42 条：DAG 完成与派生状态、并发上限、人工门批准/改稿、CHECK 返工上限与显式恢复、宿主重开不自动推进、真实 Git worktree/merger/CAS/cleanup、取消保留状态与报告。
  - `scripts/graph-surface-test.mjs` 23 条：8 个主工具不变、start inputs、submit 绑定、respond 作用域、reset/rewind 拒绝、pause/cleanup、create→design-graph（fixture 模型）。
  - `scripts/graph-status-test.mjs` 19 条：Graph 状态投影不伪造 step、严格解析器、catalog、查看器只读边界。
- 真实宿主页面验收：`scripts/ui-graph-web.mjs`（本地 fixture 模型、真实 dsh web / 真 Graph 引擎 / 真客户端 bundle）：
  - Graph 状态面到达 `done`，弹层显示节点与完成计数；
  - 右侧只读查看器显示 Graph 资产、节点 DO/CHECK，无启动/取消控制；
  - `create(kind: graph)` 在真实宿主启动 `design-graph` 并完成（main 执行节点）。
  - 证据：[`viewer.png`](viewer.png)、[`graph-viewer-result.json`](graph-viewer-result.json)。
- 既有 Flow 真机状态面验收 `scripts/ui-status-web.mjs` 仍 PASS（逐字未改 Flow 行为）。

## 负对照（证明新用例有鉴别力）

- **无 kind 的 nodes**、`kind: flow + nodes`、同时 steps/nodes、Graph 资产放 `workflows/`、Flow 资产放 `graphs/`、跨类别同名、依赖环、Graph 节点 `check_voting`、固定 `mode: default`：全部在加载期被拒（`graph-asset-test` G2/G3/G4）。`kind: graph + steps` 现在是有效的新格式。
- **node.status 落盘**：状态文件断言 `graph` 里没有 `nodes` / `currentStage` / `waitReason`；完成后状态仍保留，但节点状态由 attempts/verdicts/acceptances 现算（`graph-engine-test` E1）。
- **取消保留**：取消后 `state.json` 与报告都存在、`active:false`；若沿用 Flow 的销毁口径，该断言必红（E7）。
- **宿主重开**：`restore()` 后 `interrupted` 且不自动推进；若自动继续，E5 必红。
- **合入决定权**：只有引擎校验通过才 `update-ref`；E6 断言 ref 前进到接纳 commit 且 integration worktree 有节点文件。
- **查看器只读**：源码断言没有 `ralphflow_start/cancel/continue/respond/artifact_write` 调用；页面按钮断言无启动/取消（`graph-status-test` V4、`ui-graph-web`）。
- **CHECK fail-closed**：真实宿主首轮曾因 fixture 证据为空被判 infra；修正后仍保持“证据不匹配 → infra”的路径（`graph-engine-test` 与 `verify.ts` 解析）。
- **损坏状态**：手工写入缺 `attempts` / `asset.nodes` 的 `state.json`，`restore()` / `listStates()` / `statusOf()` 不抛错并忽略坏实例（E8）；否则这份坏状态会成为重启崩溃点。

## 与参考实现 / 文档的刻意差异

1. **后台节点提问不在 v1**（作者选择）：Graph 节点不注册 `ask` 工具；只有 `execution: main` 节点在主会话直接与用户讨论。人工审查门仍通过 `ralphflow_respond` 回答。
2. **merger 保持轻量**（作者要求 less is more）：仍由独立 merger agent 做内容合并，但参考实现的大量冲突/恢复状态机没有搬；引擎只做机械校验（commit/祖先/干净树/测试/CAS）。失败时暂停，用户 `continue` 重试合入。
3. **Graph 不支持 `check_voting` / Flow 键**：出现即加载期硬错误，不静默忽略（静默等于悄悄关掉验证/分支）。
4. **环境变量命名空间**：Graph 用 `DSH_RALPHFLOW_*`（参考实现是 `DSH_RG_*`）；Graph 尚未上线，没有兼容包袱。
5. **`sample` 不进入 v1**：Graph 设计交付不再提供隔离样例启动；`design-graph` 只提供“停止并保留 / 用户明确启动真实实例”。
6. **Graph 保留实例**：完成/取消不销毁 `state.json`、日志、产物、worktree；`design.md` §4 已同步修订“instances/ 只装活跃实例”的旧句子。
7. **`ralphflow_respond` 作用域**：主会话有 Graph 待办时才注册；真实宿主已验证作用域工具通道（artifact_write 同一机制），没有升为第 9 个主工具。

## 未覆盖 / 后续

- **codewiki 的完整内容运行**未在真实宿主上跑（需要真实模型写多页 wiki 与 manifest）；本次验证了加载、目录/冲突、Graph 引擎、Git merger 与 design-graph 主执行路径。建议在真实需求上跑一次 codewiki 并按报告复核。
- **后台节点提问**是 v1 明确不做；将来若加，需要新增作用域工具与 `ralphflow_respond` 的信息待办分支。
- **`workspaceEnvironment` 注入**已实现（`shellEnv` 注册 + 缺值启动拒绝），但没有真实工作区资产用例；当前内置资产未使用该字段。
- **merger 的冲突内容质量**由 agent 负责；引擎只保证可核对的事实（commit/祖先/干净树/测试）。真实冲突场景建议在项目中跑一次。
- 真机验收使用本地 fixture 模型（不调用远端模型）；产物内容只用于验证协议与 UI，不代表真实任务质量。

## 结论

一个插件、一套命令/工具、一个运行根、一个只读查看器；Flow 行为逐字保持不变，Graph 作为第二类资产由门面路由。所有静态/单元/回归/真机页面验收均已通过；上列未覆盖项已如实记录。

## 重启兼容性排查（针对“重启后 DSH 打不开”的担心）

已用**当前真实 web profile 的同构副本**做冷启动审计，不触碰正在运行的 3080 服务：

- 副本包含：**整份 `~/.dsh/profiles/web` 的拷贝**（含 `package.json`、`pnpm-lock`、`node_modules`、`cordis.patch.yml`、`cordis.yml`），其中 `ralphflow-dsh` link 指向本仓库；即 `dsh-base` + `dsh-web-app` + `dsh-opencode-session-header` + **`ralphgraph-dsh` 参考插件** + `ralphflow-dsh`。
- 整份 profile 拷贝冷启动：HTTP 200，`pageerror` 为空，右侧栏同时出现 `RalphGraph 工作图（只读）` 与 `RalphFlow 工作图（只读）`。
- 另用同一 profile 的同构配置连续冷启动 **3 次**（每次杀掉 `dsh web` 再起）：HTTP 200，`pageerror` 为空，两个查看器 tab 都在。
- 精确 live patch 的单独一轮同样 200 / 无 pageerror（`restart-audit.json`、`restart-live-profile.png`）。
- 结论：**当前实现不会阻止 DSH 启动**；两个插件可共存。

降低重启风险的额外改动：

- 客户端不再把 `sidebarRightTabs` 写进硬 `inject`：宿主没有右侧栏服务时，插件其余功能照常激活，只跳过查看器 tab（`ctx.get("sidebarRightTabs")` 判空）。
- `viewerCatalog()` 包了异常边界：某个坏资产/目录权限错误返回空目录，不阻断状态流。
- Graph 资产发现对 YAML 解析/读取错误逐文件容错；坏资产只报告，不抛到插件启动路径。
- `restore()` 只把运行中的 Graph 标为 `interrupted`，不自动推进；现有 `/home/yj/.dsh/ralph-flow/instances` 为空，不涉及旧状态迁移。

如果重启仍异常，**最小回滚**（不删任何运行数据）：

```bash
dsh plugin --profile web remove ralphflow-dsh
# 重启 dsh web；Flow/Graph 的 .dsh/ralph-flow 状态、报告、产物都保留
```

或临时从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 移除 `ralphflow-dsh` 后重启。参考插件 `ralphgraph-dsh` 不受影响。

## 移除参考插件 `ralphgraph-dsh`（2026-10-21 19:04）

作者决策：Graph 已并入 `ralphflow-dsh`，不再需要独立的 `ralphgraph-dsh`。本次只改**live web profile**，不删参考源码/归档：

- 备份：`~/.dsh/profiles/web/package.json.bak-remove-ralphgraph-20261021-190433`
- 从 `dsh.profile.bundles` 移除 `ralphgraph-dsh`
- 从 `dependencies` 移除 `ralphgraph-dsh`
- 保留：`~/.dsh/profiles/web/node_modules/ralphgraph-dsh`（未加载；下次 `dsh plugin install` 可清理）、`/home/yj/ralph-graph-dsh` 源码、`/tmp` 安装包，作为参考材料
- 未动正在运行的 PID 2041648；**重启后**才不再加载参考插件

移除后的同构 profile 拷贝冷启动审计：

- HTTP 200，浏览器 `pageerror` 为空
- 右侧栏**只有** `RalphFlow 工作图（只读）`，没有 `RalphGraph`
- 启动日志没有 `cannot resolve profile bundle`
- 证据：`restart-without-ralphgraph.png`（配合 `restart-audit.json` 的共存版本）

## 只读查看器视觉重做（2026-10-21 20:45）

作者反馈旧版“一眼又丑又简陋，不知道每一栏的含义和边界”。参考 RalphGraph 的只读工作图重做：

- **删除左右双栏资产列表**：顶部一个“工作流”选择器 + 下方单一画布/步骤链，不再让用户猜左栏是什么。
- **不再用原生 `<select>`**：Linux/深色下系统下拉会炸成一大块白色弹层；改用 dsh 原生 `Menu` 组件（Flow/Graph 分组、选中勾、键盘可达）。
- **Graph**：依赖层画布（列 = 依赖层，SVG 曲线 = dependsOn 边）、节点卡片（状态 / CHECK 模式 / 人工门 / 主会话 / 依赖）、列头“依赖层 01”；点卡片进入节点 inspector。
- **Flow**：垂直步骤链（编号、当前/已通过/失败、CHECK、人工门、`on_pass`），点步骤进入步骤 inspector。
- **Inspector**：明确的 `NODE · id` / `STEP · id` eyebrow；分区 `DO · 节点任务` / `CHECK · 独立验收` / `运行状态` / `依赖` / `输入与资料` / `交付物`；Flow 另有 `流转`（`on_pass` / `on_fail`）与输入/产出。
- **视觉**：全部使用 dsh 原生 token（`--dsw-alias-*`、`--dsh-content-font-size-secondary`），状态色区分完成/执行/等待/失败；卡片有 hover、焦点环、`prefers-reduced-motion` 降级；窄栏 <520px 自动降级为列表视图，可手动切回“图”。
- **契约**：`ViewerAssetNode` 增加 `checkMode`（custom/disabled），静态浏览也能准确显示“自定义/关闭”，不再猜。
- 仍然只读：没有启动/取消/暂停/审批/写产物，数据仍来自同一个 `ralphflowStatus` 流。

截图：

- [viewer-graph.png](viewer-graph.png)（单节点运行）
- [viewer-codewiki.png](viewer-codewiki.png)（多列 DAG）
- [viewer-flow.png](viewer-flow.png)（Flow 步骤链）
- [viewer-picker.png](viewer-picker.png)（工作流下拉）
- [viewer-picker-dark.png](viewer-picker-dark.png)（深色工作流下拉）
- [viewer.png](viewer.png)（节点 inspector）
- [viewer-codewiki-dark.png](viewer-codewiki-dark.png)（深色）

真实宿主验收 `scripts/ui-graph-web.mjs` 仍 PASS（Graph 状态面、查看器 DO/CHECK、无控制、design-graph 主执行）。


## Graph 格式对齐 Flow + 移除固定默认 CHECK（2026-10-21）

作者决定：Graph 不需要“固定使用 loop 判据”的旧逻辑；CHECK 由资产作者/设计模型按 writing-for-agents 显式写。Graph 的用户 YAML 格式尽量与 Flow 一致。

### 移除固定默认 CHECK

- 删除 `DEFAULT_CHECK_CRITERIA` / `DEFAULT_CHECK_SOURCE_VERSION`；`src/graph/check.ts` 只接受判据字符串或 `null`。
- `check: {mode: default}` 现在是**加载期硬错误**，报错明确说明“不再提供固定的默认 CHECK”；旧对象 `{mode: custom, criteria}` 仅作兼容。
- `GraphCheck` 内部类型只剩 `custom`；状态/报告/查看器的 `checkMode` 只剩 `custom | disabled`，不再显示“默认 CHECK”。
- `design-graph`、`codewiki`、`references/graph-authoring.md`、`docs/custom-workflows.md`、`docs/v2/graph-mode-design.md` 都改成“显式判据或 `check: null`”。

### Graph YAML 对齐 Flow

新格式（内置与文档默认）：

```yaml
kind: graph
description: ...
run_inputs: [...]
shared_resources: [...]
max_parallel_agents: 2
manual_step: [summary]
steps:
  - id: tests
    desc: 跑测试
    do: ...
    output: tests.md
    run_inputs: [...]
    check: |
      1. ...
  - id: summary
    desc: 汇总
    do: ...
    output: release.md
    depends_on: [tests]
    check: null
```

- 与 Flow 同名同形：`steps`、`id`、`desc`、`do`、`output`、`check`；Graph 只额外要 `depends_on`。
- 上游 `output` 自动注入下游只读材料，不再写 `inputs: [{fromNode, artifact}]`。
- 顶层/步骤字段改用直觉名：`inputs`（运行输入）、`resources`（共享资料）、`parallel`（并发）；旧 `run_inputs`/`shared_resources`/`max_parallel_agents` 仍兼容为别名。`workspace_resources`/`workspace_environment` 是高级能力，不进入普通格式文档。
- 文件名为启动名/资产名，不再要求 `id` / `name`；loader 会为旧文件补 identity。
- `nodes` 旧格式仍可加载并给一条迁移告警，但新资产、内置、doctor/查看器/文档都以 `steps` 为准。
- 内置 `codewiki`、`design-graph` 已迁移到新格式；`design-graph` 的设计指引也改成写 `steps` / `output` / `check` 字符串。

### 验收

- `graph-asset-test` 29 条（新增：Flow 风格 steps 正常加载、`depends_on` 自动生成上游引用、固定 default 被拒）
- `graph-engine-test` 42 条
- `graph-status-test` 19 条
- `graph-surface-test` 23 条
- 真实宿主 `ui-graph-web` 通过（含 `design-graph` 新格式主执行）
- `npm run verify` 32/32

## Git 启动提示与 AGENTS.md（2026-10-21）

作者决定：Graph 初始化 Git 是 AI 的判断与沟通，不是引擎的机械动作。

- 引擎只做事实检查：是否 Git 仓库、是否有 HEAD、工作区是否干净；不提供 `initGit` 参数，不自动 `git init`，不自动提交基线。
- 非 Git / 无 HEAD / 脏工作区时，`resolveProject` / `start` 返回可执行的模型提示：先问用户，得到明确同意后由 AI 执行 `git init` / `git add -A` / `git commit -m baseline`，再重新调用 `ralphflow_start`。
- 工作区“干净”判定忽略 `.dsh/ralph-flow/`（运行时目录不进基线，也不该阻止 Graph 启动）。
- 新增根目录 `AGENTS.md`：写/改 DO、CHECK 或模型可见的工具描述、错误、提示、通知、`references/*.md` 前，先读 `references/writing-for-agents.md`；交付前按上下文指针、步骤完成条件、信息层级、引导词、正表述、单一事实来源逐条核对。
- Git 错误提示按 writing-for-agents 收紧：先陈述缺失事实，再给出“先问用户”的同意门，再给命令，最后给恢复步骤；不使用“否则会……”的恐吓式否定。

## Graph 极简版：Git-only、无运行输入/共享资料/并发字段（2026-10-22）

作者决定：Graph 尚未上线，不考虑兼容；工作流格式只保留 Flow 同形的 `steps`，并行写靠 Git 隔离。

### 资产格式

```yaml
kind: graph
description: 一句话说明
manual_step: [review]   # 可选

steps:
  - id: tests
    desc: 跑测试
    do: ...
    output: tests.md
    check: |
      1. ...
  - id: summary
    desc: 汇总
    do: ...
    output: review.md
    depends_on: [tests]
    check: null
```

- 保留：`kind` / `description` / `manual_step` / `steps`；步骤 `id` / `desc` / `do` / `output` / `depends_on` / `execution` / `check`
- 移除：`inputs` / `resources` / `parallel` / `workspace` / `version` / 步骤 `model` / `workspace_resources` / `workspace_environment`，以及旧 `nodes` / `dependsOn` / `artifact` / 对象 CHECK
- `output` 省略默认 `<id>.md`；上游 `output` 自动注入下游只读材料，不需要 `inputs` 映射

### Git 默认与初始化

- Graph 始终要求 Git 仓库、HEAD、干净工作区；没有 workspace 开关。
- 引擎只做事实检查；缺失时返回给模型的提示：**先问用户是否初始化**，用户同意后由 AI 执行 `git init` / `git add -A` / `git commit -m baseline`，再重新启动。
- 没有 `initGit` 参数，不自动初始化，不自动提交用户文件；工作区脏时拒绝启动。
- `.dsh/ralph-flow/` 运行时目录不参与“干净工作区”判定。

### 并发

- 删除工程内 `parallel` / `maxParallelAgents`；调度器把就绪步骤全部放行，由 DSH 的 agent 并发限制排队。
- 写隔离由每步骤独立 Git worktree + integration ref 提供；merger 合入顺序仍由引擎控制。

### 内置与验证

- `codewiki` / `design-graph` 去掉 inputs/resources/parallel/workspace 字段；任务文本承载变化的值；内置参考目录由引擎内部注入，不暴露字段。
- `graph-asset-test` 31 条、`graph-engine-test` 45 条、`graph-status-test` 19 条、`graph-surface-test` 22 条。
- `npm run verify` 32/32；真实宿主 `ui-graph-web` 通过（测试夹具用 artifact 隔离开关，Git 路径由 E6 覆盖）。

### 合入协议再精简（2026-10-22）

按 less-is-more 砍掉三处仪式：

- `ralphflow_merge_report` 不再要求 `commit`；merger 只报 `status / tests / notes`，引擎直接读 integration worktree 的 HEAD。
- 删除 `integration.order`（只写不读）。
- 删除 acceptance 的 `merger.{agent_id,tests,notes}`（没有消费者；history 已记录合入事件）。

保留的机械校验不变：HEAD 包含上一版与节点结果提交、测试全过、tracked 树干净、CAS 前进 integration ref。`graph-engine-test` 45 条通过。

## 创建入口改为 skill：`ralphflow-create`（2026-10-22）

作者决定：创建/修改工作流是**作者知识**，按 harness 的原生 seam 做成 skill；Flow 和 Graph 的创建不是同一套流程。

- 新增 `ralphflow-create` skill（`src/skills.ts` 注册，`resourceBase` 指向随包 `references/`）。
  - Flow 分支：澄清目标 → 读 `workflow-authoring.md` → 写 YAML → doctor；不读 Matt。
  - Graph 分支：读随包 Matt 的 grilling / to-spec / to-tickets，启动 `create-graph` Flow。
- 删除 `ralphflow_create` 工具、`/ralphflow-create` 命令和 `src/create.ts` 静态指南；主工具 8 → 7。
- `Graph` 分支的 `create-graph` Flow（`workflows/create-graph.yaml`）承载：
  - grill（CHECK）→ spec（CHECK + 人工门）→ tickets（CHECK + 人工门）→ graph（CHECK + doctor）。
  - spec/tickets 的独立 CHECK 由 Flow 的验证者执行，人工门由 `/ralphflow-continue` 放行。
- 删除单节点 `design-graph` Graph 内置；`codewiki` 仍是 Graph 执行示例。
- 随包 MIT 复用 Matt 的 `grilling`、`to-spec`、`to-tickets`、`writing-for-agents`（`references/matt/`，含 LICENSE、SOURCE 与 commit），不依赖用户全局技能包；只加 `references/ralphflow-authoring.md` 做本地文件路径适配。
- 生成物自包含：设计时读随包参考，生成的 Graph 不引用插件内部路径。
- 引擎不再按工作流名注入 authoring 参考；上下文只在 skill 被加载时进入。
- 本轮验收：`graph-asset-test` 31、`graph-engine-test` 45、`graph-status-test` 19、`graph-surface-test` 22、`skills-surface-test` 37；真实宿主 `ui-graph-web` 去掉 design-graph 后仍通过。

## 回合收尾检查：从「催交卷」改成「问做完了吗」（2026-10-22）

作者判断：`agent/turn-stopping` 那条提醒问错了问题。它原本说「你还没交卷」，但正确的语义是
「做完了吗」——做完了就交卷、没做完就接着做、在等用户就直接说。同时 goal 机制被排除了：

- goal 判断「做完没做完」也是**模型自报**（`update_goal complete` 只校验状态与身份，不校验目标是否达成；
  `dsh-goal-round-driver` 的 README 自己写着 *No independent evaluator*），driver 只是「active + armed +
  轮次未到 → 空闲就开一轮」的计数器。没有可模仿的判定，接它反而比我们的独立验证者弱。
- 两个驱动抢同一个「回合结束」信号会互相打架：流催 2 次先把实例暂停，goal 驱动随后把会话叫起来继续跑，
  UI 显示「已暂停」而模型还在动。`loop.yaml` 里的目标引导因此删除。

判定改成两条线：

- `submit_activity`：上次提醒之后发生过 `tool/call`。只计入总次数，**清零**连续空回合累计。
- `submit_reminder`：空回合。连续 `SUBMIT_REMINDER_STALL_LIMIT = 2` 次且这一轮仍是空回合 → 暂停
  （`no_submit`）；总提醒 `SUBMIT_REMINDER_TOTAL_LIMIT = 20` 次仍未交卷 → 同样暂停（防「一直调工具但没进展」）。
- 提醒次数仍**从 history 派生**（不新增落盘字段）；`step_start` / `rework_rewind` / `do_submitted` / `resume`
  仍是新一轮的边界。

「上次提醒之后有没有干活」的观察值：宿主 `session/event` 里的 `tool/call.time`，经门面注入两个引擎
（`EnginePorts.lastActionAt`）。它**只在进程内**，不落盘：宿主重启后第一条提醒按空回合计，最多多催一次。

Graph 统一：主执行节点用同一套判定；到上限时 `setStatus(run, "paused", "no_submit")`。因为
`executeMainAttempt` 仍等在原地的 submit waiter 上，`/ralphflow-continue` 恢复时**补投一条继续指令**
（否则 DO 已经投递过、模型没有任何新输入，主节点会一直停着）。顺带修：`resume` 轨迹里的
`reason=` 之前永远缺失（`setStatus` 先清掉了 `pause_reason` 再读它）。

验收：新增 `scripts/reminder-test.mjs` 21 条（空回合 / 有动作 / 交替 / 总上限 / resume 边界 / 措辞）；
`graph-engine-test` 新增 E9（主节点暂停 + 恢复补投）55 条；`npm run verify` **33/33**。

### 追加：交卷前置条件由引擎统一注入（2026-10-22）

只靠验证者兜底时，模型提前交卷会反复触发 CHECK 与返工。把「完成条件满足才交卷」写进
`doPrompt` 的 `## 交卷方式`（引擎生成，所有工作流自动生效，不靠每个 YAML 自己写）：

- 交卷是**完成声明**，不是进度汇报；逐条核对完成条件（有验收依据按判据，没有则按「本步要做什么」与「交付物」），每条都能指出可复核的证据才交卷。
- 没满足就继续做；被打回会整步返工，并占用一次返工预算。
- 无法验证的事项如实标明，不要把计划当作完成。

`loop.yaml` 里重复的「交卷前自行核验完成情况…」删除（单一事实来源）。措辞用正向条件
（「满足才交卷」）而不是禁令（「不要提前交卷」）：禁令会把那个行为重新拉进注意力。
验收：`prompt-contract-test` 与 `engine-test` 17b 各加断言；`npm run verify` 33/33。

## 只读工作图：详情无法滚动 + 其余显示缺陷（2026-10-22）

作者实测：步骤链点开步骤详情后无法下拉。根因是 `.rv-inspector` 的 `overflow: hidden` 让它成了
滚动容器，在被约束高度的 grid 里 auto 轨道塌成面板高度（面板 `scrollHeight` 2370、`clientHeight` 760），
剩余内容被裁掉；查看器根节点因此也没有可滚的余量。改为 `overflow: clip`（只裁圆角，不建立滚动容器），
轨道回到内容高度，根节点（`overflow-y: auto`）成为滚动容器。

同轮排查一并修掉：

- 返回步骤链 / 打开另一个详情时不重置滚动位置 → 资产、视图、选中项变化时 `scrollTop = 0`。
- 固定高度节点卡片：长节点名挤掉页脚 → 标题 2 行截断。
- 定义无效资产的横幅：多条问题用 `\n` 连接但被空白折叠 → `white-space: pre-wrap`；无效资产隐藏图/列表切换。
- 状态投影的英文枚举直出中文界面（`人工门：pending`、`合入：accepted`、`CHECK failed`）→ 全部映射成中文。
- 步骤详情第一段双边框 → `head + section` 去掉重复边框。
- `on_pass: done` 原样显示 → “通过 → 结束”。
- 状态胶囊长文本无省略号 → 子 `span` 自己裁剪。
- 删除无效的 `graph ? "/ralphflow-continue" : "/ralphflow-continue"`。

`scripts/ui-graph-web.mjs` 新增真机断言（长详情可滚、能到底、返回归零）。证据：
`docs/v2/evidence/ui-viewer/`。`npm run verify` 33/33；`ui-graph-web` / `ui-status-web` 通过。

### 追加：loop 的每票检查依据要看得见（2026-10-22）

`ViewerAssetStep.check` 把投票步折成了「投票 3 票」，详情里看不到任何一条判据。契约改为
`checks: string[]`（单 `check` 一条、`check_voting` 每票一条），详情按「验证者 i/N」逐条列出，
步骤卡预览显示第一条 + 「等 N 条」。`WorkflowStatus.votes[]` 增加可选 `check`（来自步骤定义），
状态弹层的「本轮验证」每票下面显示「检查依据：…」。真机断言见 `scripts/ui-graph-web.mjs`；
证据 `docs/v2/evidence/ui-viewer/`。

### 追加：Graph 默认列表（2026-10-22）

作者反馈画布作为首屏体验不好。`ViewerPage` 的 `mode` 缺省改为 `outline`（原先是 `columns`，
只有窄栏才降级列表）；用户主动选过「图」仍记住，下次沿用。列表容器补 `data-ralphflow-outline`，
`ui-graph-web` 增加「默认没有 DAG」的真机断言。证据 `docs/v2/evidence/ui-viewer/viewer-outline.png`。

## 并行 DAG 的接纳竞态（2026-10-22）

作者问「4 个无依赖节点会不会并发 4 个 agent」时实测确认：执行是并行的（4 个独立 worktree +
4 个 agent），但**接纳/合入也并行** —— 两个节点几乎同时完成时会同时创建/重置同一个
integration worktree，第二个 `worktree add` 撞上「路径已存在但不是 Git worktree」，
整个 run 以 `node_failure` / `integration_failed` 暂停。

修复：`RunContext.acceptTail` 串行队列，`acceptAttempt` 排队执行；排队期间 run 已被前面的
合入失败暂停则跳过。DO/CHECK 仍然并行，只有「写 integration ref / worktree」这件全局事实串行。

新增 `scripts/graph-parallel-git-test.mjs`（8 条）：4 个无依赖节点 → 4 个并发执行、4 个接纳、
合入链 `previous_commit` 严格等于上一版 `commit`、最终 integration 树含四个文件。
`npm run verify` 34/34（该套件连跑 3 次稳定）。

同步确认：DSH 的 `maxActiveSubagents`（默认 8）只在 `dsh-subagent` 服务的 slot pool 里生效，
约束走 `ctx.subagents` 的委派（验证者）；Graph 节点 agent 走 `ctx.agents.create`，**不经过该池**，
所以节点并发没有宿主上限（要不要加引擎级上限是另一个产品选择）。

### 追加：验证者委派在宿主池满时排队（2026-10-22）

作者追问「10 个节点 / 池子上限 8 / 每个节点还有验证者，怎么算」。实测与读码结论：

- **节点 agent 不占池**：`ctx.agents.create` 不经 `dsh-subagent` 的 slot pool，10 个节点就是 10 个并发。
- **验证者占池**：`ctx.subagents.startActivation` 走 `SubagentManager.materialize`，共享
  `maxActiveSubagents`（默认 8）；而且池满时是 **fail-fast**（`ACTIVATION_LIMIT_REACHED`），不是排队。
- 原行为：第 9/10 个验证委派直接抛错 → `verify.ts` 归成 infra → 自动重试一次（多半仍满）→
  整个 Graph run `check_infra` 暂停。10 个节点同时交卷时这会真的发生。

修复：`verify.ts` 的委派点识别 `ACTIVATION_LIMIT_REACHED`，等 1s 再试（`startWaitingForSlot`）；
非池满错误仍然 fail-fast。验证者本来异步等待，等槽不改变语义。`native-delegation-test` 增加 D7：
池满两次后成功拿到判定；普通错误不重试。

`npm run verify` 34/34。

### 追加：节点 agent 进入宿主的子智能体 catalog（2026-10-22）

作者问「节点 agent 会不会出现在左上角子智能体监控里」。读码结论：不会——顶部监控只折叠
`subagent/catalog` 事件，而这条事实只由 `dsh-subagent` 的 `materialize` 写入；节点 agent 走
`ctx.agents.create`，不过那个服务。同时侧栏会话列表显式过滤 `origin === "subagent"`，所以
它的会话虽然持久化（`parentSession` + worktree cwd），却没有任何 UI 入口。

修复：节点 agent 创建后由引擎在 **owner 会话**上补一条 `subagent/catalog`（`version: 0`,
`mode: "one-shot"`, `label: "Graph 节点 <id>"`, `childCreatedAt` 取子会话 header）。事实本来
就是真的（它就是直接子会话），只是那条发现记录没人写。效果：运行期间顶部「N 个子智能体」
会计入节点 agent，下拉里可以打开它的会话看完整轨迹（one-shot，只读，不可续）；跑完计数归零
（与验证者一致）。

真机断言：`ui-graph-web` 在 owner session 的事件里断言这条 catalog 存在。
`graph-parallel-git-test` 断言 4 个节点各写一条。`npm run verify` 34/34。

### 追加：工作图分得出 DO / CHECK，夜间模式不再纯黑白（2026-10-22）

作者反馈两件事：跑工作流时看不出当前在 DO 阶段还是 CHECK 阶段；夜间模式下工作图「就是纯黑白」。

根因（读码 + 真机取证）：

- **Flow 步骤卡把两个阶段写成同一句话**：当前步的芯片不论 `stage` 是 `executing` 还是 `verifying` 都渲染
  「执行中」，颜色也是同一种。阶段信息本来就在状态投影里（`stage` / `votes`），界面没消费。
- **在飞色是黑白中性色**：`--rv-run` 取的是 `--dsw-alias-brand-primary`，而品牌色在明暗两套主题里分别是
  `neutral-bluish-1000/50`（近黑 / 近白），本来就没有彩度；夜间模式下卡片、边框、在飞标记全是灰阶，
  整张工作图因此退化成纯黑白。宿主自己的「进行中」状态点用的是 `--dsw-alias-state-business-primary`，
  我们跟它对齐。

修复：

- 新增 `src/client/phase.ts`（纯函数）：`flowPhaseChips` / `graphPhaseChips` / `graphAssetChips` / `flowPanelStatus`，
  把「哪个阶段、什么状态、什么语气」集中成一份映射。语气固定五种：run 在飞 / done 已通过 /
  wait 等你或等依赖 / fault 失败 / off 未开始。
- 在飞色改成 `--dsw-alias-state-business-primary`（明暗两套都有彩度）；品牌色只留给焦点环与选中态。
- 当前步 / 当前节点出两枚阶段芯片：DO 阶段 = `DO · 执行中` + `CHECK · 待验证`；CHECK 阶段 = `DO · 已交卷` +
  `CHECK · 验证中 n/N`（Flow 带票数进度，表头同步 `独立验证中 n/N 票`）；跑完 = `已完成` + `CHECK · 已通过`。
- 静态属性（`CHECK · 自定义` / `CHECK · 关闭` / `主会话`）一律中性，不再用最强前景色跟运行状态抢注意力。
- 步骤详情顶部状态条按阶段着色（DO → 在飞、CHECK → 验证、gate/paused → 等待、done → 完成）。

真机取证（`scripts/ui-graph-web.mjs`；fixture 在交卷前、出判定前受控挂起，两个阶段在页面上真实存在）：

- DO 阶段：`[当前 · DO · 执行中, CHECK · 待验证]`，且此时不得出现「CHECK · 验证中」→ `viewer-phase-do.png`。
- CHECK 阶段：`[当前 · DO · 已交卷, CHECK · 验证中]` → `viewer-phase-check.png`。
- Flow 侧（`loop` 三票挂起）：`[DO · 已交卷, CHECK · 验证中 0/3]`，表头 `独立验证中 0/3 票` → `viewer-flow-check.png`。
- 主题：同一页面切浅色 / 夜间，探针读 `--rv-run` 的计算色 —— 浅色 `rgb(65, 118, 230)`、夜间 `rgb(122, 170, 255)`，
  RGB 通道极差 165 / 133（都有彩度）；夜间断言 `body[data-ds-dark-theme]` 真的生效 → `viewer-phase-dark.png`。

`scripts/viewer-phase-test.mjs` 62 条覆盖阶段映射（含「executing 与 verifying 的芯片必须不同」这条回归）、
投票进度、静态中性、在飞色不是品牌色。`npm run verify` 35/35。

### 追加：打开工作图先看运行中的工作流（2026-10-22）

作者提出：「如果一个工作流在跑，那应该一工作图就是那个工作流，并且下拉框展开能看出哪个工作流在运行」。

原行为：查看器的资产选择是 `pinned ?? 当前运行 ?? 目录第一个` —— 上次手动浏览过的资产（`localStorage`
的 `ralphflow:viewer:asset`）**盖住**了正在运行的工作流，于是跑着 A 却打开 B。

修复（`src/client/selection.ts`，纯函数）：

- 优先级改成：本次打开里手动选过的 → 当前会话正在跑的工作流 → 上次浏览偏好 → 目录第一个。
- 运行中的工作流换了身份（新一轮 / 换成另一个 / 状态消失）时作废手动选择，重新跟随运行；同一次运行内
  手动切到别的资产仍然有效，不会被拽回。
- 下拉里只有运行中的那一个带 `· 运行中` 标记；浏览别的资产时表头补一句 `运行中：<name>`，不用回头猜。

真机取证（`scripts/ui-graph-web.mjs`）：

- 在 DO 阶段挂住时打开下拉：断言**恰好一行**带「运行中」且是 `status-graph`。
- 点 `codewiki` 切走：断言查看器变成 codewiki，且表头出现 `运行中：status-graph`。
- `page.reload()` 后重新进入（`localStorage` 里记的是 codewiki）：断言工作图回到 `status-graph`
  → `viewer-running-default.png`。

`scripts/viewer-selection-test.mjs` 18 条覆盖优先级、未知名字、运行中标记。`npm run verify` 36/36。

### 追加：没做完就先交卷 → 不再启动验证（2026-10-22）

现场（`ra2-engine-rebuild` 的 `loop` 实例）：模型做完七条判据里的一条，summary 里自己写明
「其余六项按 docs/STATUS.md 保持 open」，然后仍然交卷 —— 三个验证者跑了 40 分钟才给出
「七项仅 2 项可独立证实」，整轮白烧；返工后重来一遍。提示词早就写了「交卷是完成声明，不是进度汇报」，
但它需要的是**结束回合的出口**，而交卷正是那个出口。

根因不是提示词不够重，而是**缺一条机械通道**：模型知道还剩什么，引擎却只能靠 3 个 LLM 验证者
花 40 分钟去发现「它自己已经写下来的事」。

修复：`ralphflow_submit` 必填 `unfinished`（本步还没做完的事项，逐条写）。

- **空数组 = 完成声明** → 照旧进入独立验证（Flow）/ CHECK（Graph）。
- **非空 = 本轮进度** → Flow：记一条 `submit_incomplete`、不设 `do_submitted`、不委派验证者、
  不占返工预算；回合照常结束（模型拿到它要的边界），回执把清单逐条还给模型让它接着做。
  Graph：交卷被拒（`ok:false`，回合不结束）、attempt 留在 `running`、CHECK 不启动。
- 闸门是**机械**的：命令行层面拿不到「验证已启动」，因为引擎根本不会走到那一步。
- 交卷本身不再算「在干活」（`tool/call` 里跳过 `ralphflow_submit`）：只交卷不动手的回合按空回合计，
  催促上限（连续 2 次空回合计 / 共 20 次）照常生效，不会被「交卷刷活动」绕过。
- 提醒与 DO 提示词同步点名这条通道（「这一轮先停：把剩下的事写进 `unfinished`」）。

验收：`scripts/incomplete-gate-test.mjs` 19 条（Flow：不设 do_submitted、无 `verify_start`、
零委派、返工预算不变、回执带清单、空回合计数、`unfinished` 留空才验证、空白条目视同完成）；
`graph-engine-test.mjs` E11 4 条（Graph：拒收、回执点明 CHECK 没启动、账本无新 verdict、完成声明后照常 CHECK）。
`npm run verify` 37/37。

### 追加：催促与闸门合流（2026-10-22）

作者问「加了参数就算解决方案吗？催促那套为什么不行？要不要砍掉？」

- 催促（Ralph loop 语义）监听的是**空闲收尾**；ra2 的模型不是沉默收尾，是**交卷**，所以它一次都没触发。
  它的文案甚至把模型往交卷推（「做完了：调用 submit」）。保留：它管的是另一种失效（长任务里模型只写一段
  进度说明就停），砍掉会退回「静默停机」。两者互补，不是替代。
- 合流：记录过进度（`unfinished` 非空）的回合，催促不再是「做完了吗」，而是**「接着做上一轮记下的 N 项」**；
  干过活的回合不算空回合，只交卷不动手的回合照常累计（`ralphflow_submit` 不计入 `noteAction`）。
- 真值仍由验证者独占：闸门只决定「要不要启动验证」，不产生任何判定。

`scripts/incomplete-gate-test.mjs` 增到 23 条（新增：接着做清单、干过活后不算空回合、交卷调用不算干活）。

### 追加：按 writing-for-agents 复审这次改动（2026-10-22）

作者要求「检查一下刚才的改动在 harness 和提示词上是不是最优」。复审发现四处不优，已改：

1. **提示词自相矛盾**：第 1 条写「`unfinished` 留空才交卷」，第 2 条又写「写清单也能交卷」——同一份
   说明里给了两个互斥的条件。改成一条两分支：「交卷有两种。**完成**：…；**报进度**：…」。
2. **术语漂移**：同一个概念在提示词里叫「报进度 / 记录进度 / 完成声明」，工具描述里又叫「本轮进度」。
   现在统一成一对leading word：**完成**（`unfinished` 留空）/ **报进度**（列出未完成项），工具描述、
   参数描述、DO 提示词、技能正文、提醒、文档全部对齐。
3. **工具描述在 Graph 上不准确**：原句「列出未完成项则只记录本轮进度」——Flow 是记录，Graph 是**拒收**。
   改成两种 kind 都成立的说法（不启动验证、不占返工预算、把清单还给你接着做），kind 差异交给结果文案。
4. **工具名与文案形状各写各的**：`noteAction` 里硬编码 `"ralphflow_submit"`（改名就漏），进度记录的
   detail 形状由写入方、读回方各写一遍（改一处就漂）。现在工具名导出为 `SUBMIT_TOOL_NAME` 共用；
   `checkpointDetail` 与 `lastCheckpointOf` 放在一起，读写同一形状；未完成项归一化抽到
   `src/unfinished.ts`（两个引擎共用同一组上限）。

另外两处顺手修正：报进度回执按「本步有没有检查依据」分别说「独立验证没有启动 / 本步没有推进」；
Graph 节点按有没有 CHECK 分别说「CHECK 没有启动 / 节点没有推进」。

复审后：`npm run verify` 37/37。
