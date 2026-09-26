# ralph-flow-dsh v2 — 设计定稿与宪法

> 定稿依据：与作者的逐轮 grilling（理解 → 决策 → 收敛），取代此前所有草案。
> 状态：**已确认**。v0 范围即本文 §8；宪法 §10 不可违反。

## 0. 中心定理：裁判权定理

**ralphflow 为什么成立，只有两句话：**

> **T1 · 裁判权在独立会话**——判定只可能产生于一个与执行者互不可见的会话。它看不到执行者的自我辩护；判定经程序通道（结构化契约）返回；执行者无法转述、伪造、污染判定。
>
> **T2 · 推进的决定权在机械程序**——是否推进、回退、暂停，只由一段不读模型脸色、不可被说服的程序，根据判定与规则算出。模型可以干活、可以认错，但**不能声称自己通过**。

本设计的一切都从这两句话推导；任何丢掉了 T1/T2 的改动都不是 ralphflow。两条推论（写死，防误读）：

- **独立性 = 会话隔离 + 程序守卫，不是模型隔离。** 验证者默认与主会话同模型（§7.3），对抗性来自"它看不到主会话的自辩"，不来自"换了更强的模型"。将来若出现同模型被骗的证据，再升级模型，不动定理。
- **审查门不是人的特权，是程序的规则。** 门是状态机的一等推进语义：程序判定通过后，若该步骤声明门，放行的唯一入口仍是程序（`ralphflow_continue` fail-closed 读判定放行）。

## 1. 术语

沿用 ralph-flow-claude `CONTEXT.md` 词汇，括号内为 dsh 载体名词：

- **引擎**：持状态、唯一推进者 = dsh **插件内常驻 Service**（v1 移植了 2880 行引擎；v2 是原生 Service，v0 ≤700 行）。
- **驱动器**：读状态宣告下一步、记录验证者交卷（观测事实） = 引擎 Service 内部的事件监听面，不单独存在。
- **主会话**：执行当前步骤 = dsh `Agent`（`ctx.agents.get(sessionId)`）。
- **验证者**：独立取证的子代理 = dsh **`ralph-check` 委派**（全新独立会话，见 §7）。
- **属主会话**：实例归属的会话；推进与取消以它为准。
- **审查门**：对抗验证通过后由人放行的那道门（`manual_step` 步骤级开关，§6）。
- **检查依据**：验证者据以判定的要求，由程序从工作流定义注入（T1 的防污染点）。

## 2. 本质（作者确认）

执行者/验证者模式的具象化。内核五成员（缺一不可）：

1. **对抗验证**——T1/T2 的载体；
2. **自动化执行**——失败自动返工（ralphloop 的重试精神）；
3. **工作流文件即 AI 资产**——可分发、可版本化、可复用，跨端方言共享；
4. **关闭会话后续跑**——状态落盘、新会话可接管；
5. **失败重试**——`on_fail` 回退 + 上限暂停。

## 3. 角色与载体映射

| Claude/opencode 版机制 | dsh v2 机制 |
|---|---|
| 引擎 = MCP server（常驻） | 插件内 Service，进程内持有全部状态 |
| 驱动器 = hooks（一次性进程） | Service 内部监听 `session/event` + `agent/turn-stopping` |
| Stop hook 见 `<promise>done</promise>` | **模型调用 `ralphflow_submit` 工具**（工具调用是事实；工具结果带 `concludesTurn` 由机器结束回合）。不再对模型自由文本做正则匹配 |
| 「去验证」宣告（hook 注入） | `agent.steer(userMessage)`（source `{kind:"plugin"}`；v1 `agent.followup` 已实测可用） |
| `SubagentStop` 记录判定 | **`await subagents.start(...).result`（权威）** + `subagent/end` 事件（审计） |
| `ralph-check` agent 定义 | **内部固定 persona**（`VERIFIER_PERSONA`，经 `subagents.start` 的 `persona` 传） + 按能力选出的全新上下文后端 + `toolFilter` + `outputSchema`（程序级强制） |
| `ralphflow_*` MCP 工具 | `ctx.tools.register` + `ctx.commands.register` |
| .delegation-in-flight | 内存 `Set` + state.json `delegations[]` |

## 4. 状态（无相位）

```jsonc
// <workspace>/.dsh/ralph-flow/instances/<instance-id>/state.json
{
  "active": true,
  "workflow_name": "loop",
  "current_step": "loop",
  "user_task": "...",
  "fail_count": 0,
  "paused": false,
  "pause_reason": "max_failures | check_infra | user_cancelled",
  "do_submitted": true,
  "owner_session": "<session-id>",
  "artifacts_dir_name": "修复登录空指针-49lo",
  "delegations": [{ "run_id": "...", "agent_id": "...", "check_index": 0, "ts": "..." }],
  "verdicts": [{ "check_index": 0, "status": "passed | failed | infra",
                 "reason": "...", "agent_id": "...", "step_id": "loop", "ts": "..." }]
}
```

- **不存相位**（ADR-0004）：相位是派生量，存了就有两个写入者。v1 的 34 处文件标记位即此教训。
- 每次运行一个 JSON，原子写（临时文件 + rename）。
- 完成/取消后：归档报告到 `<workspace>/.dsh/ralph-flow/reports/<instId>.md`，然后**销毁实例目录**（`state.json` 随之消失）。`instances/` 因此只装活跃实例，历史从 `reports/` 读出（`listHistory()`）。`artifacts_dir_name` 是 state 里唯一"非派生"的额外字段：产出目录名在启动时固定，之后无法重算（子工作流会改写 `user_task`）。

**推进规则（T2 的落点，引擎唯一决策）：**

| 条件 | 引擎做什么 |
|---|---|
| 判定齐且全 `passed` | 若当前步 `manual_step: true` → 停在高阶状态等 `continue`；否则按 `on_pass` 推进 |
| 任一条 `failed` | 按 `on_fail` 回退，`fail_count + 1`；未达上限 → 恢复 DO 等待重做；达上限 → 暂停 |
| 任一条 `infra` | 暂停（`check_infra`），**不烧 fail_count** |
| 用户 cancel | 中止在飞验证者，归档报告，`user_cancelled` |

**崩溃恢复**：插件重载扫描 instances/：`active` 且 `delegations[]` 非空（进程死时验证者已 aborted）→ 判定作废、暂停 `check_infra`、清 delegations。**无人驱动 = 暂停等用户，永不隐式推进。**

## 5. 三时刻（dsh 版本）

1. **DO 交卷**：主会话**调用 `ralphflow_submit` 工具**（dsh 原生：工具调用即事实，工具结果带 `concludesTurn` 结束回合）→ 引擎在工具 handler 内受理 → 若无在飞委派 → **引擎自己委派验证者**（`subagents.start`）。主会话全程无委派能力（T1 结构性成立）。
   - **忘了交卷的兜底**：`agent/turn-stopping`（serial、可 await，claude/opencode 版 Stop hook 的原生等价物）在回合关闭前检查「有活跃实例 / 本步未交卷 / 无在飞委派」，是则以 `agent.steer` 提醒调用 `ralphflow_submit`；提醒次数由 history 派生，达上限（2 次）则暂停（`no_submit`）等用户，绝不死循环催促。
   - 交卷工具**必定返回结果**（受理 / 已交卷 / 无实例 / 暂停中），模型与用户都能看到 —— 交卷不再有「静默消失」的路径。
2. **验证者交卷**：await `run.result`（与宿主 `dsh-tool-subagent` 同款，不设 ralphflow 自造超时）；判定**首选原生结构化输出**，`structured` 经 `outputSchema` 校验后写 `verdicts[]`；provider 不支持 `outputSchema` 时才降级要求 `<promise-check>` 文本标签；**任何解析失败 = infra，绝不 passed**。`subagent/end` 记审计（含 `agent_id`）。
3. **`ralphflow_continue`**：引擎读判定按 §4 表推进。校验：判定存在 / `step_id` 等于当前步（归属校验）。不足推进 → 拒绝并说明原因，**不烧 fail_count**。

**审查门（§6 详述）通过后**：人在门上 `continue` 放行；人说"改一下" → 主会话修改、再次调用 `ralphflow_submit`、重新验证、再次回到门（**轻量打回，无程序化 return**，等价于 reset 当前步但不算 reset 命令；重开前会真正中止在飞委派，避免孤儿）。

## 6. 审查门（manual_step，v0 就要）

- YAML 步骤 `manual_step: true` → 该步对抗验证通过后停在门状态，等 `continue`。
- `loop` 不设门（自动循环）；`spec` 的 propose 步设门（内置集与 claude/opencode 一致）。
- 门是**步骤级开关**，由工作流表达，不是全局总闸。

## 7. 验证者协议

- **形态**：全新独立会话的子代理；只见「任务 + 检查依据 + 工件」，不见主会话对话历史，**也看不到执行者的交卷摘要**；跑完即焚。
- **后端选择（按能力，不按名字）**：验证者后端属于 Ralphflow **内部**，工作流没有任何入口影响它。只考虑 `getProvider(n).inheritsParentContext === false` 的 provider（全新上下文）——**绝不**回退到 `true` 的 provider（`fork` 继承主会话历史，T1 静默失效）；未声明该字段的同样不选（fail-closed）。候选里优先 `capabilities.persona && capabilities.toolFilter` 都支持的（这是「独立 + 有纪律的只读裁判」的前置条件；缺了 `start()` 本就会抛 `UNSUPPORTED_CAPABILITY`）。provider 名可配置（`providerName`），**名字不参与判定**。没有可用后端 → `infra`，理由写明「本部署没有全新上下文的委派后端」或点名缺失的能力；两种情况都**不生成通过判定**。
- **身份是内部定义（单一来源）**：验证者职责（独立性、只读取证、不采信自述、只读不改文件）收敛为 `verify.ts` 的 `VERIFIER_PERSONA`，经 DSH 原生子代理 `persona` 传入（在子代理 scope 注册 `deployment:persona-prefix` 系统提示段）。**切分线**：persona 只承载「你是谁、你的纪律」；本次任务的事实与**按 `wantStructured` 分支的判定提交方式**（`structured_output` 工具 / `<promise-check>` 文本标记）仍由 `buildCheckPrompt` 承载——后者是逐请求状态，搬进 persona 会让降级路径失效。
- **判定**：`outputSchema` 结构化 `{ passed: boolean, reason: string }`；reason 必须给证据（读到的文件/跑出的结果）。
- **只读**：`toolFilter: { allow: [read, grep, glob, bash, read_image] }`。bash 内的间接写（`sed -i`/`tee`）**有意接受**（ADR-0002 同款弱点；将来用 dsh 沙箱收紧，见 §11）。
- **模型**：默认同主会话模型；YAML 可覆盖（§0 推论：独立性 ≠ 模型隔离）。优先级链**与 opencode/claude 一致**：步骤 `check_model` > 全局 `adversarial_check.model` > 发起会话当前模型。
  - `model` 通过 DSH 原生 `agentOptions` 传给验证者，不由提示词要求模型自行切换。**没有覆盖时不传 `agentOptions`**，由宿主 `resolveChildAgentOptions` 继承**父级** provider/model（即发起会话当前模型）。
  - 两种形态都支持（三端同解）：`"provider/model"` 字符串、`{ providerID, modelID }` 对象（两者都必须非空）。**裸模型名**（如 `sonnet`）、对象缺字段、或类型非法 → 解析不出 → **告警并回退发起会话当前模型**，绝不静默忽略（否则用户以为换了验证模型，实际没换）。归一化只有一处：引擎的 `resolveCheckModel`（照抄 opencode 语义），验证者只消费结果。
  - `check_model` **仅单 `check` 场景生效**：与 `check_voting` 同写、或本步没有 `check` → **加载期硬错误**（照抄 opencode）。
- **公开配置契约（`adversarial_check`）**：可选对象，**唯一允许的字段是 `model`**。`agent` / `system_prompt` / `timeout_ms` **已从公开契约中删除**——它们（以及任何未知字段、`adversarial_check` 非对象）在**加载期**与 `doctor` 都告警并忽略：不拒收、不静默、不改作别的含义。口径与未知键、`check_voting` 统一为 **warn+ignore**（§8 Q13）：dsh 对「自己不兑现的键」只有这一条规则，忽略后回落到固定的内部验证者正是文档承诺的默认行为。告警必须在加载期出现，不能拖到验证阶段。
- **prompt 由引擎构造**：任务原文 + 本步上下文（`desc`/`do`/`input`/`output`/产出目录）+ 检查依据（来自工作流定义，主会话零输入）+ 工作区可读。任务消息正文只保留这些**事实**，通用角色说明走 persona 通道（见上）。验证者 prompt 是 T1 防污染的唯一注入点。
- **绝不注入执行者自述（T1 硬规则）**：验证者**看不到**执行者的交卷摘要/实现总结——它只判「结果是否满足检查依据」，不判「执行者怎么做的、自称做了什么」。自述是**锚点**，会软化独立判定。opencode 与 claude 版同样从不传入，并在提示词里明令"不要依赖任何外部提供的实现总结"。
  - 交卷摘要仍存于 `state.last_submit_summary`，但**唯一消费者是审查门改稿重交去重**（`onSubmit` 里"内容与上次完全相同则不重复验证"），不流向验证者。`VerifyRequest` 类型上**没有** `submitSummary` 字段——从类型层面阻止它被重新引入。
- **数量**：v0 单验证者。`verdicts[]` 与 `delegations[]` 按数组建模，为将来多票预留，但 v0 恒为 1。
- **不注入环境异常条款（作者定案）**：验证者 prompt **不**加「取证期间宿主可能重启/源码可能漂移，请区分环境干扰与被验证对象缺陷」这类提示。理由：环境异常是开放集合（重启、改码、并发写、宿主升级、权限、网络……），逐条枚举等于对不可控环境做猜测，**每条猜测都是一个新增的误判入口**，复杂度换不来正确性。与 `timeout_ms` 同一条原则：宿主职责交宿主，内核不造轮子。
  - **已知代价（如实记录，不修）**：用正在被修改的插件验证它自己的改动时，中途重启会让在飞验证被 `restore()` 孤儿恢复清记账，其判定被 `run_superseded` 丢弃；而**验证者进程仍活着**，它会在一个正在变动的树里取证，可能把环境噪声写进判定（实测：`loop-mudrr90d-xd5d` 两次重启，其中一轮判定即因此失真，其"残留项 #1"经干净环境复现判定为**不成立**）。这是 fail-safe 的诚实代价，**接受**。
  - **正确应对是流程而非代码**：批量交付、需要重启才能生效的改动集中到最后一次重启（见 `hardening-brief.md` §6）。

## 8. 命令面与 v0 范围

**命令/工具（与 claude/opencode 同名，心智通用）。命令语义＝「触发词，回复＝大模型」**（迭代 1 实测定案）：`/ralphflow-*` **一律**给模型注入一条指令（`source: plugin`），由模型调用同名工具、自然回复——**含用法错误与未实现命令**（向 opencode 看齐：参数不全由模型说明用法并追问，reset/rewind 由模型解释暂缓原因与可用命令）——**零程序化卡片返回**。这也根治了「dsh web 新会话首条命令结果不渲染」：命令全部走普通消息路径，平台命令卡渲染缺陷不再涉及。唯一兜底是会话离线时给一行错误提示。工具侧不变：模型可随时直接调用 `ralphflow_*`。

| 命令 | 工具 | v0 形态 |
|---|---|---|
| `/ralphflow-start` | `ralphflow_start` | 实现（命令=触发词 → 模型调工具） |
| `/ralphflow-list` | `ralphflow_list` | 实现（同上） |
| `/ralphflow-status` | `ralphflow_status` | 实现（同上） |
| `/ralphflow-continue` | `ralphflow_continue` | 实现（同上） |
| `/ralphflow-cancel` | `ralphflow_cancel` | 实现（同上） |
| `/ralphflow-create` | `ralphflow_create` | 实现（引导式设计指引 → doctor 校验到可启动） |
| `/ralphflow-doctor` | `ralphflow_doctor` | 实现（工作流/实例诊断，坏文件说人话） |
| `/loop`、`/spec`、`/<自定义>` | — | 动态注册的工作流快捷命令（与 opencode 一致） |
| `/ralphflow-reset` `/ralphflow-rewind` | 只声明不实现（涉及上下文管理，作者定案暂缓） |
| —（无命令，DO 阶段由模型自动调用） | `ralphflow_submit` | DO 交卷（dsh 原生工具调用；取代 `<promise>done</promise>` 文本标记）。见 §5 三时刻① |

**v0 没有**：多验证者投票、reset、rewind、客户端 UI、HTTP 通道、通知、沙箱。

**v0 有**：YAML 引擎、内置 `loop` + `spec`、审查门、续跑、落盘、失败重试、多实例、报告归档、崩溃 fail-safe。

**方言容错（Q13 定案）**：未知/未支持键（`check_voting`、`adversarial_check` 下 `model` 以外的字段如 `agent`/`system_prompt`/`timeout_ms`、其它未识别键）→ **警告该键 v0 未支持/已删除、已忽略，按默认语义跑**；不做语义降级兼容（不加工作量）。`adversarial_check` 写了非对象（`true`/`"foo"`/`[...]`）同样告警并忽略。语法错误、`on_pass`/`on_fail` 引用不存在的步骤 → **fail-fast 带人话报错**。

**超时不在内核里造（作者定案）**：委派生命周期（含模型卡死/打转等异常）**一律交给宿主 dsh 的原生能力**（请求级空闲看门狗、工具调用时限策略），ralphflow 不自建超时轮询或竞速。理由：这是宿主职责，插件重复实现只会分叉行为、随宿主演进腐化。故 `timeout_ms` 永久 warn+ignore，**不要**在后续轮次重新引入有界竞速（claude 版 ADR 独立得出同一结论：`timeout_ms` 零消费者 → 必须静默忽略）。

## 9. 工作流文件即资产（Q5 定案）

- YAML 方言跨端共享（opencode/claude/dsh/pi 同一套 `description / manual_step / adversarial_check（仅 model，两形态）/ steps / do / check / check_model / input / output / on_pass / on_fail / max_fail_count`），是**硬约束**：同一份资产四端可跑，hub 生态押注于此。**`check_model` 与模型引用两形态（§7）已对齐**，故这三项资产在四端同解。dsh 是方言基准：`adversarial_check` 的 `agent`/`system_prompt`/`timeout_ms` 已在 dsh 端删除（opencode/claude/pi 版的对应收敛另行处理；pi 已核实同样支持这三者），同一份旧 YAML 在 dsh 端 warn+ignore 后仍可跑。
- 目录：`<workspace>/.dsh/ralph-flow/workflows/` 自定 + 内置 loop/spec；每实例隔离的**产出目录**为 `<workspace>/.dsh/ralph-flow/artifacts/<artifacts_dir_name>/`（目录名 = 任务摘要 slug + 实例 id 尾段，按码点截断；实例启动时建好、终止后**保留**，DO/CHECK 提示词各注入一行工作区相对路径；只有空目录随实例销毁被 `rmdir` 删掉）。
- **实例生命周期（§4 的落点）**：活跃 vs 历史分两层。工作流完成/取消时 `destroyInstance()` 严格按序执行：① 先 `archiveReport()`，失败则**中止销毁**（保留可见残留 + 告警，绝不静默丢轨迹）；② 先解析出产出目录名；③ 从全局索引除名并落盘；④ `unlink(state.json)`；⑤ 递归删实例目录（失败只告警，实例已除名 → 不会成幽灵）；⑥ 非递归 `rmdir(artifactsDir)`（非空即保留）。`writeState` 会 `mkdirSync` 实例目录，因此**销毁后不得再写 state**——迟到的验证回调由 `launchVerification` 的 `readState === null` 护栏挡下（记 `verdict_discarded/instance_state_missing`）。存量已结束实例**不自动迁移**，由 `doctor` 报出、用户显式决定。
- **工作区运行时目录用 dot-dir**（`<workspace>/.dsh/ralph-flow/`）：与 opencode `.opencode/ralph-flow/`、claude `.claude/ralph-flow/` 形状一致，并与全局 `~/.dsh/ralph-flow/` 对称（同一作用域命名空间 `ralph-flow`）。`.gitignore` 只忽略 `.dsh/ralph-flow/`（精确），不忽略整个 `.dsh/`——将来 dsh 可能往工作区 `.dsh/` 放需要入库的项目配置。
- 所有者：用户手写（进 git）；`ralphflow_create` 交互式创建器推迟（v0 只声明）。
- **内置工作流不落盘**（对齐 opencode/claude 的 `ensureProjectWorkflows`）：`loadWorkflow` 回落插件目录，内置因此**始终是随插件发布的最新版**。播种副本会遮蔽插件目录、并在插件升级后变成陈旧副本——**实测踩过**：工作区里那份 7 步 `spec` 副本把新版 4 步内置整个挡住了，改内置却"没生效"。定制入口是"放同名文件遮蔽内置"（有意行为）。
- **内置 `spec` = 4 步**（`explore → propose → implement → archive`），与 opencode 现行版同源；7 步是 opencode 在 2.6.0 废弃的旧版（我们此前从 claude 版抄来）。**唯一差异**：opencode 给 `propose`/`implement` 标了 `reset: true`（重置门），而本版本未支持重置门，故以**注释**保留、reset 落地后启用。依据与完整分析见 `spec-4step-brief.md`。
- 坏文件 fail-fast 说人话（§8 方言容错）。

## 10. 宪法（违反即回退）

1. **T1**：裁判权只在独立会话。主会话任何路径都不得影响判定内容与判定产生过程。
2. **T2**：推进只由机械程序决定。`continue` 类入口一律 fail-closed 读程序持有的判定。
3. **引擎是唯一写入者**。驱动器（事件监听）只宣告与记账，不写状态迁移。
4. **状态不存派生量**。无相位、无文件标记位（v1 的 34 处 `writeMarker` 是反例）。
5. **判定 fail-closed**。解析失败/结构校验失败 = infra 或打回，绝无默认通过。
6. **永不写自定义会话事件帧**（v1 会话砖化的字面教训）。
7. **主会话永远不委派验证者**。委派只从引擎发出。
8. **不移植 opencode/claude 引擎**。只移植"裁判权在程序"语义与用户旅程，机制用 dsh 原生件组合。
9. **客户端代码禁止先于内核**（v0 没有客户端；UI 见 §11 门槛）。
10. **不允许引入 doctor/unbrick/reset 类修复命令的实现**（v0 只声明不实现）。需要它们 = 设计错了。
11. **每个功能入场合规**：带"最小版失败"的复现记录（§11 准入列）。
12. **不支持的方言键 = 警告忽略，不兼容、不加工作量**（Q13 定案）。

## 11. 路线图（每级只由"最小版失败"触发）

| 版本 | 加什么 | 准入 |
|---|---|---|
| **v0** | 本文所定义的一切 | — |
| 迭代 1 | 真实使用反馈修复（明天开跑） | 作者日常使用中炸了/别扭了 |
| 迭代 1 记录 | **已解决（重构定案）**：① 命令返回"工具原始文本"不像大模型回复 → 命令改为**触发词**（注入指令给模型，模型调同名工具并自然回复）；② 该重构顺带根治了「dsh web 新会话首条斜杠命令结果不渲染」——命令现在走普通消息路径，平台命令卡渲染缺陷不再影响（无需上游 issue，v0.4 命令卡作 UI 润色而非必需） | 已复现并解决 |
| v0.2 | 多验证者投票（`check_voting` 激活） | 单验证者 ≥3 次误放/误烧的证据 |
| v0.3 | `create` 交互式、`doctor` 薄版（fail-fast 的人话出口） | 手写 YAML 开始成为摩擦 |
| v0.4 | UI（页头/抽屉，复用 v1 配方） | loop+spec 在 ≥20 个真实任务上跑过；命令卡渲染作为本次实测问题的补药 |
| v0.5+ | 验证者沙箱化、reset/rewind、通知 | 各自的最小版失败证据 |

## 12. 验收（v0 完成判据）

1. **裁判权测试组全绿**：伪造判定 / 跳过验证推进 / 过旧判定复用 / 无判定推进 / 主会话试图委派——全部被拒（§5 三时刻 + §7 协议的自动化测试）。
2. **loop 完美符合要求**：作者用它在真实需求开发任务上跑通（含失败重试、审查门、续跑）。
3. **坏 YAML fail-fast 说人话**；未知键警告忽略。
4. 安装进作者日常使用的 web profile，明日起即用。

## 13. 目录与仓库动作

- 现状冻结：`git branch archive/v1`（tag v0.1.1 已有）。
- v2 源码结构：
  ```
  src/index.ts     入口：Service 注册 / 工具 / 命令 / 事件监听 / 重启扫描   ~90 行
  src/engine.ts    状态机 + 三时刻 + 审查门 + 推进规则 + 崩溃恢复           ~300 行
  src/verify.ts    ralph-check 委派（selectBackend 按能力选后端 / persona / toolFilter / outputSchema / 打回） ~170 行
  src/tools.ts     5 工具 + 4 只声明命令                                    ~110 行
  workflows/loop.yaml  spec.yaml   内置工作流（发货）
  ```
- 包名 `ralphflow-dsh` 沿用；成熟后发 2.0.0。