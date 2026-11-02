# 快捷入口参考

启动类入口（`/ralphflow-start`、`/ralphflow-<工作流>`）是**技能**；其余是**命令**。人敲的形态不变，但机制不同：技能落成一条**普通用户消息** + 宿主注入技能正文（所以新会话第一句敲它们**会有标题**）；命令落成 `command/run`（`dsh-session-title` 只认 `source.kind === "user"` 的 `user/message`，命令永远拿不到标题）。逐条归类见 [`v2/skills-vs-commands.md`](v2/skills-vs-commands.md)。

## 命令

| 命令 | 参数 | 功能 |
|------|------|------|
| `/ralphflow-continue` | `[实例ID]` | 放行审查门 · 恢复暂停 · 接管实例 |
| `/ralphflow-status` | `[实例ID]` | 查看本会话的实例、指定实例详情，或全部活跃实例概览 |
| `/ralphflow-list` | — | 列出可用工作流 + 活跃实例（只答"现在有什么在跑"） |
| `/ralphflow-cancel` | `[实例ID] [原因]` | 取消实例（先归档报告；Flow 再销毁实例目录，Graph 保留状态/产物/worktree 供复核） |
| `/ralphflow-cleanup` | `[实例ID]` | **Graph only**：只删除已记录且干净的节点 worktree；不动 state / artifacts / reports；Flow 没有 worktree |
| `/ralphflow-reset` | — | **Flow only**：重做当前步（换干净上下文 + 重投 DO，失败计数保留）；Graph 明确拒绝 |
| `/ralphflow-rewind` | `<步骤> <原因>` | **Flow only**：回退到更早步骤并换方向；Graph 是无环 DAG，明确拒绝 |
| `/ralphflow-doctor` | `[工作流名或工作区路径]` | 诊断全部，或只诊断一个资产（Flow / Graph 各自 schema） |

**命令语义 = 触发词。** `/ralphflow-*` **一律**由模型自然语言回复（含用法错误），**零程序化卡片返回**——参数不全时由模型说明用法并追问，与 opencode / claude 版一致。

**机械命令是例外**：`/ralphflow-reset`、`/ralphflow-rewind`、`/ralphflow-cleanup` 的机械动作由命令处理器**直接驱动引擎**完成（不要求模型记得去调），结果仍交回模型自然语言回复；**都不注册同名工具**——不给模型可调用的修复入口。前两条是 Flow-only，最后一条是 Graph-only；对另一类实例调用时明确说明不适用。

**暂停没有命令**：点发送键旁的方块停止当前回合即可。Flow 与 Graph 同一动作（`paused(user_stop)`）；恢复用 `/ralphflow-continue`，结束用 `/ralphflow-cancel`。Graph 在跑后台节点、主回合没有可停的回合时，输入区会出现独立的「暂停」按钮；在飞节点会被中断（attempt 标 `interrupted`），不再启动新节点。

**Graph 人工审查门**用 `ralphflow_respond` 回答（“批准此版本”或说明要改什么），不要用 `/ralphflow-continue` 代答；`continue` 只恢复暂停/中断。

## 启动技能（自动注册）

### `/ralphflow-start`（通用入口，两面可见）

```
/ralphflow-start loop "实现用户认证"
```

- **人敲**：`/ralphflow-start <工作流> <任务描述>` → 普通用户消息 → 宿主注入技能正文（调 `ralphflow_start`，参数从那条消息里取）。
- **模型自然触发**：技能的**描述**就是触发词（原文见 [`v2/skills-vs-commands.md`](v2/skills-vs-commands.md) 表 B）——用户点名 ralphflow、或要求「做完由独立验证者验收才算完成」时，模型据此加载同一条正文。触发词只写在那一条描述里（工具描述与系统提示词都不复述）。

### `/ralphflow-<工作流>`（每个可启动工作流一个，只给人看）

```
/ralphflow-loop "用 JWT 和 refresh token 实现用户认证模块"
/ralphflow-spec "添加 OAuth2 用户认证功能"
/ralphflow-<你的自定义工作流> "任务描述"
```

机制说明：

- **自动注册**：引擎创建时、以及新会话创建时，枚举**工作区 → 全局 → 内置**三层的 **Flow 与 Graph** 资产各注册一个技能（如 `/ralphflow-loop`、`/ralphflow-codewiki`、`/ralphflow-create-graph`）。
- **只给人看**：`modelInvocable: false` —— 模型目录里 ralphflow 相关的条目只有 `ralphflow-start` 一条（同义描述重复 = 一个触发分支写两遍）。
- **同名先到先得**：与已登记的技能撞名时跳过（不影响 `/ralphflow-start <工作流> <任务>` 启动它）。
- **名字必须是小写 kebab**：技能名必须匹配 `[a-z0-9]+(-[a-z0-9]+)*`。工作流名里带大写/下划线/空格时**注册不了快捷技能**——这时会**如实告诉你原因与改法**（投一条可见播报：改成小写 kebab 名，如目录 `my-flow/workflow.yaml`），**不静默跳过**；在那之前它仍可用 `/ralphflow-start <工作流> <任务>` 启动。
- **无效定义不注册**：启动必然失败的工作流不会出现，用 `/ralphflow-doctor` 查看原因。
- **Graph 的 Git 前置**：Graph 需要 Git 仓库、HEAD 基线和干净工作区。缺失时 `ralphflow_start` 返回提示；先问用户是否初始化，用户同意后由 AI 执行 `git init` / `git add -A` / `git commit -m baseline`，再重新启动。引擎不自动初始化。

## 使用示例

```
# 最快：直接用工作流快捷技能
/ralphflow-loop "实现用户认证"

# 通用入口（工作流名不合技能名语法时也走它）
/ralphflow-start loop "实现用户认证"

# 查看状态（本会话；无活跃实例时给全部活跃实例概览）
/ralphflow-status

# 暂停后恢复、批准审查门，或接管指定实例（支持唯一前缀）
/ralphflow-continue
/ralphflow-continue loop-mudrr90d

# 上下文脏了只想重做当前步
/ralphflow-reset

# 后期才发现早期步骤方向错了：回退并说明新方向
/ralphflow-rewind propose "第二步技术文档里 API 假设错了，得重设计"

# 取消并归档报告
/ralphflow-cancel

# 诊断每个工作流定义与实例
/ralphflow-doctor
```

---

## 工具（由模型调用）

斜杠命令驱动这些下划线命名的工具；模型也可以直接调用它们（命令是触发词，工具才是动作）。

| 工具 | 参数 | 功能 |
|------|------|------|
| `ralphflow_start` | `workflow`（必填）、`task`（Flow 必填；Graph 可选，作为任务上下文） | Flow：创建实例并返回第一步 DO。Graph：创建实例并启动 DAG 调度，返回启动回执 |
| `ralphflow_submit` | `summary`（可选）、`unfinished`（必填） | Flow：DO 交卷；Graph：节点 agent 提交本 attempt 产物（按调用者绑定分派；被拒绝时不结束回合）。`unfinished` 为空 = 没有剩余事项，进入验证（完成由独立验证者判定）；非空 = 报进度（Flow 记 `submit_incomplete` 后不启动验证，Graph 直接拒收） |
| `ralphflow_continue` | `instance`（可选，可前缀） | 放行审查门 / 恢复暂停 / 接管；必要时重新委派验证 |
| `ralphflow_status` | `instance`（可选） | 单实例详情或活跃实例概览 |
| `ralphflow_list` | — | 可用工作流 + 活跃实例 |
| `ralphflow_cancel` | `instance`（可选）、`reason`（可选） | 取消实例并归档报告 |
| `ralphflow_doctor` | `workflow`（可选，名字或工作区路径） | 只读诊断报告；按资产类别报 Graph/Flow schema |
| `ralphflow_respond` | `text`（必填）、`todoId`（可选） | **仅 Graph 人工待办时可见**：批准此版本或提交改稿要求；含糊回复不算批准 |
| `ralphflow_artifact_write` | `content`（必填） | **仅 Graph 节点 agent 可见**：写声明的节点产物（路径由引擎决定） |
| —— | —— | 合并没有专用工具：节点在自己的分支上合入集成分支，引擎只做快进 |

> `ralphflow_submit` 的 `summary` **只用于审查门改稿重交去重**（内容与上次完全相同则不重复验证）。它**不流向验证者**——验证者只判"结果是否满足检查依据"，不判"执行者自称做了什么"。
>
> `unfinished` 是**机械闸门**：模型自述的未完成项非空时，引擎不委派验证者、不消耗返工预算，只把清单还回去让它继续。这条信息也**不流向验证者**（自述不参与独立判定）。

---

## 实例模型

- 每次 `ralphflow_start` 在工作区 `.dsh/ralph-flow/instances/<实例ID>/` 下创建一个实例（Flow / Graph 同根）。
- 一个会话最多驱动一个实例；同一工作区的多个会话各驱动各的，互不干扰。
- **Graph 实例**：DAG 就绪节点全部放行，由 DSH 的 agent 并发限制排队；每节点独立 agent / attempt / 产物；`manual_step` 节点在 CHECK 通过后停人工门；完成/取消**保留** `state.json`、日志、产物与 worktree，供交付验收与复核。宿主重开只标 `interrupted`，必须用户 `continue`。
- Graph 的 CHECK 与 Flow 走同一个独立验证者运行时（T1）；节点 agent 看不到验证者，验证者看不到执行者自述。Git 节点在自己的分支上完成并合入集成分支，引擎只做快进。
- 属主是实例状态里的 `owner_session` 字段。**接管的两条口径**：
  - `/ralphflow-continue` **只在无属主**（`owner_session` 为空）时自动接管——恰好一个无属主实例就直接接管；有属主（或不止一个无属主、无法判定）→ 列出候选（含属主会话）并要求 `/ralphflow-continue <实例ID>` **显式指定**（显式点名仍可接管有属主的实例）。
  - `/ralphflow-status` 无参且本会话没有活跃实例时，给**全部活跃实例的概览**（每行带属主会话，本会话的标出来），而不是随便挑最后一个实例讲成自己的；实例详情也显示属主会话。
- 崩溃恢复不会隐式推进：属主心跳过期 → 标中断（`host_restarted`）、清掉在飞委派，等 `/ralphflow-continue`；心跳还新鲜 → 等一个刷新窗口复查（区分另一个活着的 host 与快速重启），绝不误伤（见[工作原理 → 崩溃恢复与属主心跳](how-it-works.md#崩溃恢复与属主心跳)）。

---

## 日志与复盘

每个活跃实例在 `instances/<实例ID>/execution.log` 追加**一行一个 JSON 对象**的 JSONL 日志：

```jsonl
{"ts":"2026-10-04T10:30:01.000Z","level":"info","event":"step_start","instId":"loop-mudrr90d-xd5d","step":"loop"}
{"ts":"2026-10-04T10:31:12.000Z","level":"info","event":"do_submitted","instId":"loop-mudrr90d-xd5d","step":"loop"}
{"ts":"2026-10-04T10:33:40.000Z","level":"info","event":"verdict_passed","instId":"loop-mudrr90d-xd5d","step":"loop"}
```

**报告给人看，日志给机器（`grep` / `jq`）看。** 日志完整记录生命周期事件，以及**验证者提示词原文与判定原文（不截断）**——想知道"验证者到底看到了什么、凭什么这么判"，读它。

结束/取消时，日志随报告归档到 `reports/<实例ID>-execution.log`，报告里因此多一行 `- 执行日志：…` 指路。

- 单文件上限 **10 MB**、保留 **3** 份轮转（`.log.1` … `.log.3`）。
- 阈值可用环境变量 `RALPHFLOW_LOG_MAX_BYTES` 注入小值（便于测试轮转）。
- 写日志失败（目录只读、磁盘满）**只记一条 warning**，绝不影响工作流推进。

### 事件一览

| 事件 | 说明 |
|------|------|
| `start` / `complete` / `cancelled` / `destroy` | 实例生命周期 |
| `step_start` | 进入某步骤的 DO 阶段 |
| `do_submitted` | 主会话调用 `ralphflow_submit` 交卷 |
| `verify_start` | 引擎委派独立验证者 |
| `verdict_passed` / `verdict_failed` / `verdict_infra` | 单验证者判定落地 |
| `voter_verdict` | 投票的一票判定落地 |
| `voting_infra_retry` | 基础设施故障后自动重试（只重跑故障票） |
| `advance` / `gate_opened` / `gate_released` / `gate_reopened` | 推进与审查门 |
| `check_skipped` | 本步无检查依据，跳过对抗性验证（**绝不写成检查通过**） |
| `rework_rewind` | 判定失败，按 `on_fail` 返工 |
| `pause` / `resume` | 暂停（`user_stop` / `max_failures` / `check_infra` / `no_submit`）与恢复 |
| `submit_reminder` / `submit_activity` / `reminder_exhausted` | 回合收尾提醒（空回合 / 有动作）与连续空回合达上限后的暂停 |
| `manual_reset` / `manual_reset_dropped` | 手动重置生效 / 未生效（绝不静默作废） |
| `rewind` | 用户回退到更早的步骤（含 `from → to：reason`） |
| `reset_surface` / `reset_surface_skipped` / `reset_skipped_first_step` | 上下文重置落地 / 放弃 / 首步结构上无法重置 |
| `adopted` / `interrupted` / `orphan_delegation_recovered` | 接管实例 / 属主心跳失联标中断 / 验证失败后按孤儿兜底重派 |
| `verifier_prompt` / `verifier_result` | 验证者提示词与判定的原文快照 |

> 另有诊断级事件（`state_write_failed`、`report_archive_failed`、`instance_dir_not_removed`、`deliver_failed`、`reset_surface_failed` 等）只写插件日志端口，用于排查，不改变推进判定。完整清单见[设计文档](v2/design.md)。

### 查看日志

```bash
# 某个实例的日志（替换 <实例ID>）
cat .dsh/ralph-flow/instances/<实例ID>/execution.log

# 只看判定事件
grep '"event":"verdict' .dsh/ralph-flow/instances/<实例ID>/execution.log

# 归档日志（实例已结束）
cat .dsh/ralph-flow/reports/<实例ID>-execution.log

# 最近 10 条
tail -10 .dsh/ralph-flow/instances/<实例ID>/execution.log
```

---

## 最终报告

工作流完成或取消时，报告归档到**项目根**的 `.dsh/ralph-flow/reports/<实例ID>.md`（**永久保留**，历史的唯一入口）。

报告头部字段：

```
# ralphflow 报告 · <工作流名>
- 实例：<实例ID>
- 状态：**完成** | **取消**
- 任务：<任务原文>
- 开始 / 结束 / 总耗时
- 失败轮数
- 产出目录：.dsh/ralph-flow/artifacts/<产出目录名>/
- 执行日志：.dsh/ralph-flow/reports/<实例ID>-execution.log   ← 有日志时才出现
```

正文三节：`## 步骤耗时与重试`（每步耗时与重试次数，从轨迹现算）、`## 轨迹`（生命周期事件）、`## 判定`（验证者判定的理由）。

**归档是永久的，实例是临时的。** 完成/取消时：报告归档 → 从实例列表除名 → 销毁实例目录。报告归档失败时**不销毁**实例目录（宁可留一个可见残留，也不静默丢掉轨迹），`/ralphflow-doctor` 会报出来。

---

## 目录结构

运行时数据落在**项目根**（与 dsh 原生 Skill 同一条规则：从会话的当前目录向上最近的含 `.git` 的祖先目录；没有 `.git` 就用该目录本身）：

```
<项目根>/.dsh/ralph-flow/
├── workflows/<名字>/workflow.yaml  # Flow 资产（内置 loop/spec 不在此）
├── graphs/<名字>/graph.yaml        # Graph 资产（内置 codewiki 不在此）
├── instances/                      # 活跃 Flow 实例 + 保留的 Graph 实例
│   └── <实例ID>/
│       ├── state.json              # 状态（勿手改；kind 区分 Flow/Graph）
│       ├── execution.log           # JSONL 执行日志
│       └── worktrees/              # 仅 Graph：每节点独立 worktree（节点分支 ralphflow-node/<实例>/<节点>）
├── reports/                        # 完成/取消后归档（永久）
│   ├── <实例ID>.md
│   └── <实例ID>-execution.log
└── artifacts/                      # 每实例隔离的产出（永久；只有空目录随实例销毁）
    └── <产出目录名>/
        └── nodes/                  # 仅 Graph：<node>/<attempt>/<artifact>
```

用户级工作流目录（`$DSH_HOME` 支持 `~`，空值视为未设置，缺省 `~/.dsh`）：

```
$DSH_HOME/ralph-flow/workflows/     # Flow：所有项目可用（<名字>/workflow.yaml）
$DSH_HOME/ralph-flow/graphs/        # Graph：同上（<名字>/graph.yaml）
```

**Flow 实例状态字段**（`state.json`，由插件管理，勿手改）：`active`、`workflow_name`、`current_step`、`user_task`、`fail_counts`（每步一份）、`paused`、`pause_reason`、`do_submitted`、`owner_session`、`last_submit_summary`、`artifacts_dir_name`、`delegations`、`verdicts`、`history`、`started_at`、`updated_at`。

**Graph 实例状态字段**：`kind: "graph"`、`active`、`workflow_name`、`user_task`、`owner_session`、`artifacts_dir_name`、`graph.asset`（启动时冻结）、`graph.status`、`graph.project`、`graph.integration`、`graph.attempts`、`graph.verdicts`、`graph.acceptances`、`graph.human_todos`、`graph.worktrees`、`history`。**没有** `node.status` / `currentStage` / `waitReason`——这些是投影，由状态现算。

**一个项目根一个引擎**：引擎的根就是项目根，所以列表、历史、`doctor`、自定义工作流查找全都落在同一个地方；同一仓库的任意子目录会话共享这套状态。不同项目根之间互相独立、互不可见，**没有全局索引**。

---

## 环境变量

| 变量 | 作用 | 缺省 |
|------|------|------|
| `DSH_HOME` | 用户级目录的根（`$DSH_HOME/ralph-flow/{workflows,graphs}/`，与原生 Skill 同一套解析） | `~/.dsh` |
| `RALPHFLOW_LOG_MAX_BYTES` | 执行日志单文件轮转阈值（正整数） | 10 MB |
