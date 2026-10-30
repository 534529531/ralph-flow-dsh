# 投递分类台账：每一处投进会话的消息，都是「指令」或「播报」

> 判据 1（任务书）：**全仓所有把消息投进会话的调用点，逐条判定「指令」还是「播报」，代码里
> 看得出这个判定。** 本页是那份判定的人类可读台账；机器可执行的同一份审计在
> [`scripts/delivery-classification-test.mjs`](../../scripts/delivery-classification-test.mjs)
> （`npm run verify` 会跑它，覆盖与计数一旦漂移就红）。

## 为什么必须分类（缺陷本体）

引擎过去把播报与指令**共用同一个出口**（`agent.steer`）。dsh 的 `steer` 在**空闲**驱动器上会
开一个新回合（`dsh-agent` 文档原话 *An idle driver starts a turn*），于是「给人看的进度播报」
把模型叫醒了：验证期间模型在没有 DO 的情况下自己开工、正在收尾的回合被续上、返工的重置与 DO
投不出去。分类不是命名洁癖，它决定**载体**：

| 类别 | 意图 | 载体 | 空闲会话 | 收尾中的回合 | 立刻可见 |
|---|---|---|---|---|---|
| **指令** directive | 要模型干活 | `agent.steer(msg)` | **开新回合** | 在下一个 step 边界被取走（续跑一步） | 否（成为节点后可见） |
| **新一轮** round | 要模型接着干**下一轮** | `agent.followup(msg)` | **开新回合** | **本回合先收尾**，它是下一回合的第一条消息 | 否（成为节点后可见） |
| **播报** notice | 给人看的记录 | `session.append("user/message", msg, { surfaceOp: "append" })` | **保持空闲** | **不续**（不碰收件箱） | **是**（马上多一行） |

「指令」为什么要分两个边界：`steer` 落 next-step，`followup` 落 next-turn，而回合循环的判据是
`turnEnds && inbox.nextStep.length === 0`。引擎的**交卷提醒**走 `steer` 就等于「把模型刚想收尾的
那个回合续上」——实测 RA2 loop 单步 8 小时、**84 轮共用 4 个回合**，模型到第 150 步自己写出
*I've reached the limit of what this turn can carry out* 之后不再推进。提醒改走 `followup` 后
**一轮 = 一个回合**，与 opencode 版（每条催促是一次 `session.promptAsync`）同形。

关于 `inject`：它（`send(msg,'next-step',false)`）不唤醒**空闲**驱动器，但它是**收件箱**投递 ——
`dsh-agent-loop` 的回合循环判据是 `turnEnds && inbox.nextStep.length === 0`，收件箱里躺一条
next-step 消息，正在收尾的回合就会被续上；而且收件箱里的东西在**被 claim 之前不进可见面**
（客户端 `inbox-definition` 的 `publication: () => "none"`），用户时间线上不会立刻多一行。
所以播报**不用 inject**，用直接 append。

## 运行期载体（唯八处注入会话的地方）

`src/` 里出现注入 API 的文件**只能是**下面三个，且每次注入都带 `@delivery <class>` 标记
（`scripts/delivery-classification-test.mjs` 的 S1 逐行强制）：

| 文件 | 载体 | 类别 | 说明 |
|---|---|---|---|
| `src/index.ts` | `deliverDirective` → `agent.steer(msg)` | **指令** | 唤醒载体：在下一个 step 边界取走 |
| `src/index.ts` | `deliverRound` → `agent.followup(msg)` | **新一轮** | 收尾中的回合也**先结束**，提醒成为下一回合的第一条消息 |
| `src/index.ts` | `deliverNotice` → `session.append!("user/message", msg, {surfaceOp:"append"})` | **播报** | 唯一的播报载体：立刻可见、不唤醒 |
| `src/index.ts` | `flushNotices` → `session.append!("user/message", queue[0], {surfaceOp:"append"})` | **播报** | 播报的挂起补齐（可见面尾部工具配对不平衡时先挂起）；与上一条同一个载体 |
| `src/reset.ts` | `resetSurface` → `session.append("user/message", notice, …)` | **播报** | 重置前的可见告知；随后被同一次替换遮蔽（用户看得到、模型看不到） |
| `src/reset.ts` | `resetSurface` → `session.append("user/message", handoff, …)` | **指令** | 交接稿：替换后上下文本身，永远与紧随其后的指令（DO）同生共死 |
| `src/graph/engine.ts` | 节点 DO → `agent.followup(…)` | **指令** | 唤醒**子 agent**（节点 worker）执行本 attempt 的 DO；不是主会话投递 |

`createUserMessage(` 只在 `src/index.ts` 出现（S1d）：Graph 节点消息是直接构造的
`user` 消息（同一形状），不允许「在别处造消息、再想办法塞进会话」。

## 运行期投递调用点（53 处）

端口是 `EnginePorts.deliverDirective` / `EnginePorts.deliverNotice`（[`src/engine.ts`](../../src/engine.ts)），
`ToolContext.deliverDirective`（[`src/tools.ts`](../../src/tools.ts)），
`SkillContext.deliverNotice`（[`src/skills.ts`](../../src/skills.ts)）。调用点计数由 S3 钉住。

### 指令（15 处：要模型干活 —— 14 处 `steer` + 1 处 `followup`）

| 文件 | 调用点 | 为什么是指令 |
|---|---|---|
| `src/index.ts` | turn-stopping「你还没交卷」提醒 `deliverRound`（`followup`） | 提醒必须**开下一轮**：用 `steer` 会把正在收尾的回合续上，一轮就不再是一个回合（见上文与 `round-turn-test`） |
| `src/engine.ts` | `deliverStepDo`：下一步 DO / 返工 DO / 重置后 DO（`deliverDirective` ×5：无 reset、无 reset 端口、替换成功、替换失败、宿主异常） | DO 就是「要模型干活」本身；替换失败也绝不吞掉 DO |
| `src/engine.ts` | `continueInstance` 解除暂停后重投当前步 DO | 让模型继续做这一步 |
| `src/tools.ts` | `/ralphflow-reset` 被拒绝 → 让模型转达 | 命令语义 = 触发词，交回模型自然语言回复 |
| `src/tools.ts` | `/ralphflow-rewind` 参数不完整 → 让模型追问 | 同上 |
| `src/tools.ts` | `/ralphflow-rewind` 被拒绝 → 让模型转达 | 同上 |
| `src/tools.ts` | 命令 shim（`kind:"directive"`）注入指令 | 模型必须去调同名工具 |
| `src/tools.ts` | `/ralphflow-cleanup` 的结果交回模型转达 | 机械命令直接驱动引擎，结果由模型自然语言说明；暂停走宿主的停止按钮或状态面暂停按钮，没有命令 |
| `src/tools.ts` | `/ralphflow-reset`、`/ralphflow-rewind` 对 Graph 实例的明确拒绝 | Graph 无步骤上下文 / 无环，必须说清不适用，而不是静默 |
| `src/graph/engine.ts` | 节点 DO → 子 agent `followup` | 一个载体行（见上表）；子 agent 被唤醒执行，不是主会话 |

启动类快捷入口（`/ralphflow-start`、`/ralphflow-<工作流>`）**不在**这张表里：它们是**技能**，
指令随宿主注入的技能正文进对话（`dsh-tool-skill` 的 `agent/pre-step`），不是插件投的。

### 播报（38 处：给人看的记录，不唤醒）

`src/engine.ts` 的 `notify()`（19 处调用）全部是播报 —— 它逐字等于
`deliverNotice(state, "[ralphflow] …", summary)`：

| 位置 | 播报内容 |
|---|---|
| `skipVerification` ×2 | 跳过对抗性验证（停审查门 / 直接推进） |
| `pauseForUserStop` | 「已暂停：你停止了运行」——停止按钮或状态面暂停按钮触发的主动暂停（Flow / Graph 同一句） |
| `launchVerification` | 「已交卷，独立验证者正在取证（无需操作）」 |
| 投票进度 | 每票一行「验证者 i/N 通过 / 不通过 / 重试」 |
| 投票基础设施故障 | 「N 张票故障，自动重试中（已通过的保留）」 |
| 判定聚合 ×2 | 返工 / 推进的结论 |
| `pauseCheck` ×2 | 验证未跑成（infra）暂停 / 连续未通过暂停 |
| `on_fail` 定义无效 | 暂停（引擎拒绝跳步） |
| 审查门 | 「🙋 已通过独立验证，停在审查门等你放行」 |
| `on_pass` 指向不存在 | 暂停（工作流定义错误） |
| `complete` ×2 | 工作流完成（报告已归档；实例目录未销毁时的如实告知） |
| `reportArtifacts` | 产出目录已归档的提示 |
| `cancelInstance` ×2 | 实例已取消（含报告路径） |
| `src/index.ts` | turn-stopping 的「已暂停等你处理」 |
| `src/engine.ts` | 被丢弃的手动重置的可见告知（`deliverNotice` 直调：文本自带前缀） |
| `src/skills.ts` | 自定义工作流名不合语法 → **如实拒绝并说清原因**（`deliverNotice` 直调：绝不静默跳过） |
| `src/graph/engine.ts` 的 `notify()`（15 处） | Graph 启动回执、节点交卷/完成、人工门打开、暂停/中断/取消/完成、CHECK 基础设施故障与返工上限、合入失败、恢复（含主节点恢复时补投继续指令）等 | 全部是给人看的记录；不唤醒主会话。Graph 的节点事件走同一分类 |

## 代码之外（测试替身 / e2e 夹具，台账）

这些文件里出现注入 API 是**测试脚手架**，不是运行期投递；每个都在审计脚本的 `LEDGER` 里
逐条给出归类与理由，台账外的文件一律算漏归类（S4）：

| 文件 | 归类与理由 |
|---|---|
| `scripts/helpers/plugin-harness.mjs` | 替身：真 `Session` + 同时记录指令（steer/followup）与播报（append 包装 `captureAppends`） |
| `scripts/delivery-classification-test.mjs` | 本审计脚本自身：模式文本里出现 `steer:` 等字样，不是调用点 |
| `scripts/visibility-test.mjs` | 用例替身：真 `Session` + steer 记录 + append 记录 |
| `scripts/voting-test.mjs` | 用例替身：真 `Session` + steer 记录 + append 记录 |
| `scripts/submit-flow-test.mjs` | 用例替身：真 `Session` + steer 记录 + append 记录 |
| `scripts/incomplete-gate-test.mjs` | 用例替身：真 Session + `captureAppends`；只验未完成项闸门，不投递 |
| `scripts/notice-delivery-test.mjs` | 用例替身：真 `Session` + steer 记录（播报走真实 append 载体） |
| `scripts/reset-surface-test.mjs` | 用例夹具：真 `Session` 上种旧对话 / 模拟驱动器把收件箱 drain 成 `user/message` |
| `scripts/rewind-test.mjs` | 用例夹具：同上 |
| `e2e-harness/index.js` | e2e 夹具：`followup` 把任务喂给真实 agent（驱动真实回合） |
| `scripts/real-loop-wake-test.mjs` | 真实运行用例：真实 `AgentLoop` + 真实 `Session`；stub 模型经真工具链投递，替身 `subagents` 只决定判定 |
| `scripts/round-turn-test.mjs` | 真实运行用例：真实 `AgentLoop` + 真实 `Session`；stub 模型在 DO 之后主动结束回合，验「提醒落 next-turn 还是 next-step」（负对照把载体还原成 `steer`） |
| `scripts/skills-surface-test.mjs` | 技能面用例替身：真 `SkillRegistry` / `CommandRuntime` / `SessionTitleService`；`steer` 是空实现（只记技能注册与命令解析，不投递） |
| `scripts/stop-pause-test.mjs` | 停止按钮=暂停用例替身：真 `Session` + steer/append 记录，模拟宿主 `turn/end aborted/user` |
| `smoke-client.mts` | 历史客户端冒烟：cordis ctx 替身的 `inject:` 属性，不是会话投递 |

## 行为判据（谁在守）

| 判据 | 守卫 |
|---|---|
| 播报不唤醒（空闲保持空闲；收尾中的回合不被续上） | [`scripts/notice-delivery-test.mjs`](../../scripts/notice-delivery-test.mjs) N1/N2 |
| 播报立刻可见（同一调用里成为可见面节点） | 同上 N1a/N1b |
| 指令仍唤醒（DO / 命令 / 交卷提醒） | 同上 N3 + [`scripts/submit-flow-test.mjs`](../../scripts/submit-flow-test.mjs) |
| 工具调用在飞时不劈开 tool 配对（挂起 + 补齐） | 同上 N4 |
| 重置遮蔽不变（替换后 = 系统提示 + 交接稿 + DO） | [`scripts/reset-surface-test.mjs`](../../scripts/reset-surface-test.mjs) |
| 播报做成 notice 行（`form:"notice"` + 非空 summary） | [`scripts/visibility-test.mjs`](../../scripts/visibility-test.mjs) |
| 一轮 = 一个回合（提醒先收尾本回合，再作为下一回合的第一条消息） | [`scripts/round-turn-test.mjs`](../../scripts/round-turn-test.mjs) R1/R2（含 R3 负对照） |
| 真实运行复核（验证期间无新回合 / 四票齐后 replace + DO） | [`scripts/real-loop-wake-test.mjs`](../../scripts/real-loop-wake-test.mjs) R1/R2（含 R3 负对照） |
| 分类完整性（漏一处即红） | [`scripts/delivery-classification-test.mjs`](../../scripts/delivery-classification-test.mjs) |

状态 UI 的 `ctx.inject([服务名], …)` 是 Cordis 依赖装配；`ctx.slots.inject` 是 UI 槽装配，均不投递会话。新增 `src/status-service.ts`、`src/status-contract.ts`、`src/typert.ts`、`src/client/status-source.ts`、`src/client/status.tsx`、`src/client/viewer.tsx`、`src/client/phase.ts`（查看器的阶段投影，纯函数）、`src/client/selection.ts`（打开时看哪个资产的纯函数）、`src/unfinished.ts`（未完成项归一化）、`src/paths.ts`（项目根 / 用户根解析）、`src/owner.ts`（属主心跳，纯状态函数）、`src/facade.ts`、`src/assets.ts` 与 `src/graph/{asset,assets,check,state,report,workspace,agent-registry}.ts` 的投递计数均为零；Graph 只在 `src/graph/engine.ts` 增加了子 agent 唤醒（2 处指令）与 15 处播报。现有 53 个指令/播报调用点由 S3 钉住。
