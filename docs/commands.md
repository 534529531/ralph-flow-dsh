# 快捷入口参考

启动类入口（`/ralphflow-start`、`/ralphflow-<工作流>`）是**技能**；其余是**命令**。人敲的形态不变，但机制不同：技能落成一条**普通用户消息** + 宿主注入技能正文（所以新会话第一句敲它们**会有标题**）；命令落成 `command/run`（`dsh-session-title` 只认 `source.kind === "user"` 的 `user/message`，命令永远拿不到标题）。逐条归类见 [`v2/skills-vs-commands.md`](v2/skills-vs-commands.md)。

## 命令

| 命令 | 参数 | 功能 |
|------|------|------|
| `/ralphflow-continue` | `[实例ID]` | 放行审查门 · 恢复暂停 · 接管实例 |
| `/ralphflow-status` | `[实例ID]` | 查看本会话的实例、指定实例详情，或全部活跃实例概览 |
| `/ralphflow-list` | — | 列出可用工作流 + 活跃实例（只答"现在有什么在跑"） |
| `/ralphflow-cancel` | `[实例ID] [原因]` | 取消实例（先归档报告，再销毁实例目录） |
| `/ralphflow-reset` | — | 重做当前步：换干净上下文 + 重投本步 DO（失败计数保留，不赦免失败） |
| `/ralphflow-rewind` | `<步骤> <原因>` | 回退到更早的步骤并换方向（状态机倒退、清暂停与失败计数） |
| `/ralphflow-doctor` | — | 诊断所有工作流定义与实例状态 |
| `/ralphflow-create` | `[流程想法]` | 交互式设计自定义工作流，校验到全部 ✅ 且无告警 |

**命令语义 = 触发词。** `/ralphflow-*` **一律**由模型自然语言回复（含用法错误），**零程序化卡片返回**——参数不全时由模型说明用法并追问，与 opencode / claude 版一致。

**两条机械命令是例外**：`/ralphflow-reset` 与 `/ralphflow-rewind` 的机械动作由命令处理器**直接驱动引擎**完成（不要求模型记得去调），结果仍交回模型自然语言回复；**两者都不注册同名工具**——不给模型可调用的修复入口。

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

- **自动注册**：引擎创建时、以及新会话创建时，枚举**工作区 → 全局 → 内置**三层工作流各注册一个技能。
- **只给人看**：`modelInvocable: false` —— 模型目录里 ralphflow 相关的条目只有 `ralphflow-start` 一条（同义描述重复 = 一个触发分支写两遍）。
- **同名先到先得**：与已登记的技能撞名时跳过（不影响 `/ralphflow-start <工作流> <任务>` 启动它）。
- **名字必须是小写 kebab**：技能名必须匹配 `[a-z0-9]+(-[a-z0-9]+)*`。工作流名里带大写/下划线/空格时**注册不了快捷技能**——这时会**如实告诉你原因与改法**（投一条可见播报：重命名成小写 kebab，如 `my-flow.yaml`），**不静默跳过**；在那之前它仍可用 `/ralphflow-start <工作流> <任务>` 启动。
- **无效定义不注册**：启动必然失败的工作流不会出现，用 `/ralphflow-doctor` 查看原因。

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
| `ralphflow_start` | `workflow`（必填）、`task`（必填） | 创建并绑定新实例，返回第一步的 DO 提示词 |
| `ralphflow_submit` | `summary`（可选） | **DO 交卷**（工具调用即事实，工具结果结束回合） |
| `ralphflow_continue` | `instance`（可选，可前缀） | 放行审查门 / 恢复暂停 / 接管；必要时重新委派验证 |
| `ralphflow_status` | `instance`（可选） | 单实例详情或活跃实例概览 |
| `ralphflow_list` | — | 可用工作流 + 活跃实例 |
| `ralphflow_cancel` | `instance`（可选）、`reason`（可选） | 取消实例并归档报告 |
| `ralphflow_create` | `idea`（可选） | 返回交互式创建工作流的指引（`CREATE_GUIDE`） |
| `ralphflow_doctor` | — | 只读诊断报告 |

> `ralphflow_submit` 的 `summary` **只用于审查门改稿重交去重**（内容与上次完全相同则不重复验证）。它**不流向验证者**——验证者只判"结果是否满足检查依据"，不判"执行者自称做了什么"。

---

## 实例模型

- 每次 `ralphflow_start` 在工作区 `.dsh/ralph-flow/instances/<实例ID>/` 下创建一个实例。
- 一个会话最多驱动一个实例；同一工作区的多个会话各驱动各的，互不干扰。
- 属主是实例状态里的 `owner_session` 字段。**接管的两条口径**：
  - `/ralphflow-continue` **只在无属主**（`owner_session` 为空）时自动接管——恰好一个无属主实例就直接接管；有属主（或不止一个无属主、无法判定）→ 列出候选（含属主会话）并要求 `/ralphflow-continue <实例ID>` **显式指定**（显式点名仍可接管有属主的实例）。
  - `/ralphflow-status` 无参且本会话没有活跃实例时，给**全部活跃实例的概览**（每行带属主会话，本会话的标出来），而不是随便挑最后一个实例讲成自己的；实例详情也显示属主会话。
- 崩溃恢复不会隐式推进：插件重载时，**心跳已停止**的在飞验证委派被判为孤儿，判定作废、暂停 `check_infra`；心跳仍新鲜的委派一律不动（见[工作原理 → 崩溃恢复与心跳](how-it-works.md#崩溃恢复与心跳)）。

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
| `pause` / `resume` | 暂停（`max_failures` / `check_infra` / `no_submit` / `user_cancelled`）与恢复 |
| `submit_reminder` / `reminder_exhausted` | 忘了交卷的提醒与用尽后暂停 |
| `manual_reset` / `manual_reset_dropped` | 手动重置生效 / 未生效（绝不静默作废） |
| `rewind` | 用户回退到更早的步骤（含 `from → to：reason`） |
| `reset_surface` / `reset_surface_skipped` / `reset_skipped_first_step` | 上下文重置落地 / 放弃 / 首步结构上无法重置 |
| `adopted` / `orphan_delegation_recovered` | 接管实例 / 恢复心跳已停的孤儿委派 |
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

工作流完成或取消时，报告归档到 `<workspace>/.dsh/ralph-flow/reports/<实例ID>.md`（**永久保留**，历史的唯一入口）。

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

工作区运行时数据落在**发起会话的工作区**（dot-dir，与 opencode `.opencode/ralph-flow/`、claude `.claude/ralph-flow/` 形状一致）：

```
<workspace>/.dsh/ralph-flow/
├── workflows/                      # 自定义工作流 YAML（内置 loop/spec 不在此）
├── instances/                      # 仅活跃实例的机器状态
│   └── <实例ID>/
│       ├── state.json              # 工作流状态（勿手改）
│       └── execution.log           # JSONL 执行日志
├── reports/                        # 完成/取消后归档（永久）
│   ├── <实例ID>.md
│   └── <实例ID>-execution.log
└── artifacts/                      # 每实例隔离的产出（永久；只有空目录随实例销毁）
    └── <产出目录名>/
```

全局工作流目录：

```
~/.dsh/ralph-flow/workflows/        # 所有工作区可用（$DSH_HOME 为绝对路径时以它为准）
```

**实例状态字段**（`state.json`，由插件管理，勿手改）：`active`、`workflow_name`、`current_step`、`user_task`、`fail_counts`（每步一份）、`paused`、`pause_reason`、`do_submitted`、`owner_session`、`last_submit_summary`、`artifacts_dir_name`、`delegations`、`verdicts`、`history`、`started_at`、`updated_at`。

**一个工作区一个引擎**：引擎的根就是发起会话的工作区，所以列表、历史、`doctor`、自定义工作流查找全都落在同一个地方。工作区之间互相独立、互不可见，**没有全局索引**。

---

## 环境变量

| 变量 | 作用 | 缺省 |
|------|------|------|
| `RALPHFLOW_WORKSPACE` | 引擎根的**回落值**（会话拿不到工作区信息时才用它；正常以会话工作区为准） | 进程 cwd |
| `DSH_HOME` | 全局工作流目录的根（`$DSH_HOME/ralph-flow/workflows`） | `~/.dsh` |
| `RALPHFLOW_LOG_MAX_BYTES` | 执行日志单文件轮转阈值（正整数） | 10 MB |
