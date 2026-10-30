# 只读工作图：详情滚动与其余显示缺陷

真机证据由 `scripts/ui-graph-web.mjs` 生成（隔离 profile + 本地 fixture 模型 + 真实 dsh web + 真实客户端 bundle）。

## 报告的问题

步骤链里点开步骤详情后**无法向下滚动**：长 DO / CHECK 被截断在右侧栏底边。

## 根因

`.rv-inspector` 用了 `overflow: hidden`。在被约束高度的 grid 容器里，滚动容器会让 auto 轨道塌成
面板高度（实测 `grid-template-rows: 144px 760px`，面板 `scrollHeight` 2370），内容被 `hidden`
裁掉；而查看器根节点的 `scrollHeight` 也正好等于 `clientHeight`，所以外层也没有可滚的余量。
改成 `overflow: clip`（只裁剪圆角，不建立滚动容器）后轨道回到内容高度，根节点变成滚动容器。

## 一并修复的显示问题

- **返回列表后滚动位置不重置**：从长详情返回、或打开另一个详情时，旧的 `scrollTop` 会盖住新面板标题。
  现在资产 / 视图 / 选中项变化时回到顶部。
- **固定高度节点卡片把页脚挤出卡片**：长节点名换行到 3 行时，"依赖 / 详情"会被裁掉。标题改为 2 行截断。
- **定义无效的资产**：多条校验问题用 `\n` 连接，但横幅是普通空白折叠，几条挤成一段。改为 `pre-wrap`；
  无效资产不再显示图/列表切换。
- **状态投影的英文枚举直接进中文界面**：详情里的 `人工门：pending`、`合入：accepted`、
  `CHECK failed`、状态弹层的 `CHECK passed`。统一映射成中文（验证未跑成 / 待验证等）。
- **步骤详情第一段双边框**：头部有 `border-bottom`，第一段又有 `border-top`；`:first-child` 选择器实际
  命不中（头部才是首个子元素）。改为 `head + section`。
- **`on_pass: done` 原样显示**：步骤卡与详情里的"通过 → done"改为"通过 → 结束"。
- **状态胶囊长文本无省略号**：`text-overflow` 在 flex 容器上不生效，子 `span` 自己裁剪；给子 span
  补 `min-width: 0` + 省略号。
- **无效的 `graph ? "/ralphflow-continue" : "/ralphflow-continue"`**：删掉。

## 回归

- `npm run verify` 33/33。
- `scripts/ui-graph-web.mjs`：新增断言——长 DO 详情 `scrollHeight > clientHeight`、能滚到底、返回后
  `scrollTop === 0`（截图 `viewer-inspector-bottom.png`）。
- `scripts/ui-status-web.mjs`：通过。

截图：`viewer-inspector-bottom.png`（长详情滚到底）、`viewer-flow.png`（步骤链）、`viewer-codewiki.png`（DAG）。

## 追加：loop 的每票检查依据不可见（2026-10-22）

作者实测：loop 的步骤详情在「CHECK · 独立验收」只显示「投票 3 票」，看不到三个检查依据。

- 原因：`ViewerAssetStep` 只有一个 `check: string`，facade 对投票步把它折成了 `投票 N 票`。
- 改法：契约改成 `checks: string[]`（单 `check` 一条、`check_voting` 每票一条），详情按
  「验证者 1/3…」逐条列出；步骤卡预览显示第一条 + 「等 N 条」。
- 状态弹层同样补上每票的依据：`WorkflowStatus.votes[]` 增加可选 `check`（来自步骤定义），
  「本轮验证」里每票下面显示「检查依据：…」。

证据：`viewer-loop-checks.png`（详情三条）、`popover-votes.png`（弹层三票依据）。
真机断言：`scripts/ui-graph-web.mjs` 选择 loop、点开步骤，断言 `.rv-check pre` 恰好 3 条且内容匹配。

## 追加：Graph 默认显示列表（2026-10-22）

作者反馈：Graph 打开时默认是依赖图画布，体验不好；默认列表更合适。

- `mode` 的缺省从 `columns`（窄栏才降级 `outline`）改成 `outline`；用户主动点过「图」仍会记住
  （`localStorage` 的 `ralphflow:viewer:view`），下次打开沿用。
- 列表容器加 `data-ralphflow-outline`，真机断言「打开时没有 `[data-ralphflow-dag]`」。
- `scripts/ui-graph-web.mjs` 先断言默认列表并截图 `viewer-outline.png`，再点「图」进入原来的画布断言。

证据：`viewer-outline.png`。

## 节点 agent 的入口在哪（2026-10-22）

截图 `subagent-entry.png` 标了三个位置：

- **A 最左侧会话列表**：节点 agent 的会话**不会**出现在这里（宿主 `sessionVisible` 过滤 `origin === "subagent"`，子会话统一走父会话的 catalog）。
- **B 聊天窗口顶部、会话标题右边的「N 个子智能体」**：点它。
- **C 点开后的列表**：`Graph 节点 inspect`（一次性 · 当前未运行）与 `Ralph Check: graph inspect …`（验证者）。

catalog 条目是持久的：图跑完之后 B 仍然显示“2 个子智能体”，条目也还在（截图就是跑完之后拍的）。

## 追加：阶段可分辨 + 夜间不再纯黑白（2026-10-22）

作者反馈：跑工作流时看不出当前在 DO 还是 CHECK 阶段；夜间模式下工作图「就是纯黑白」。

- 当前步 / 当前节点现在出两枚阶段芯片：DO 阶段 `DO · 执行中` + `CHECK · 待验证`；CHECK 阶段
  `DO · 已交卷` + `CHECK · 验证中 n/N`；跑完 `已完成` + `CHECK · 已通过`。映射在 `src/client/phase.ts`。
- 在飞色从品牌色（黑白中性色）换成 `--dsw-alias-state-business-primary`：浅色 `rgb(65, 118, 230)`、
  夜间 `rgb(122, 170, 255)`，两套主题都有彩度。

证据：`viewer-phase-do.png`（DO 阶段）、`viewer-phase-check.png`（CHECK 阶段）、`viewer-flow-check.png`
（Flow `loop` 三票挂起时 `CHECK · 验证中 0/3`，表头 `独立验证中 0/3 票`）、`viewer-phase-dark.png`（夜间）。

真机断言：`scripts/ui-graph-web.mjs` 用 fixture 在交卷前与出判定前挂起，断言两阶段的芯片文本互不相同；
再用探针读 `--rv-run` 的计算色，断言明暗两套主题的 RGB 通道极差 ≥ 40，且 `body[data-ds-dark-theme]` 生效。
`scripts/viewer-phase-test.mjs` 覆盖阶段映射与语气枚举。

## 追加：打开工作图先看运行中的工作流（2026-10-22）

作者提出：工作流在跑时，工作图打开就该是那个工作流；下拉展开要能看出哪个在运行。

- 选择优先级：本次手动选过的 → **正在跑的** → 上次浏览偏好 → 目录第一个（`src/client/selection.ts`）。
  运行中的工作流换了身份时，手动选择作废、重新跟随运行。
- 下拉行只有运行中的那一个带 `· 运行中`；浏览别的资产时表头补 `运行中：<name>`。

证据：`viewer-running-default.png`（刷新后仍落在运行中的 `status-graph`，而不是上次浏览的 `codewiki`）。

真机断言：`scripts/ui-graph-web.mjs` 断言下拉里恰好一行带「运行中」、手动切走后表头点明运行中的是哪个、
`page.reload()` 后重新进入仍回到运行中的工作流。`scripts/viewer-selection-test.mjs` 覆盖优先级规则。
