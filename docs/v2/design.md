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
- **审查门不是人的特权，是程序的规则。** 门是状态机的一等推进语义：程序判定通过后，若该步骤声明门，放行的唯一入口仍是程序（`ralphflow_continue` fail-closed：有检查依据读判定，无检查依据读**工作流定义**的免验证声明，见 §12.1）。

## 1. 术语

沿用 ralph-flow-claude `CONTEXT.md` 词汇，括号内为 dsh 载体名词：

- **引擎**：持状态、唯一推进者 = dsh **插件内常驻 Service**（v1 移植了 2880 行引擎；v2 是原生 Service，按 dsh 原生件重新组合，不移植 v1 引擎）。
- **驱动器**：读状态宣告下一步、记录验证者交卷（观测事实） = 引擎 Service 内部的事件监听面，不单独存在。
- **主会话**：执行当前步骤 = dsh `Agent`（`ctx.agents.get(sessionId)`）。
- **验证者**：独立取证的子代理 = dsh **`ralph-check` 委派**（全新独立会话，见 §7）。
- **属主会话**：实例归属的会话；推进与取消以它为准。
- **审查门**：由人放行的那道门（工作流级 `manual_step` 列表中的步骤，§6）。有检查依据（`check` / `check_voting`）时是**对抗验证通过后停**，都没有时是**纯人工审查**（交卷即停）。
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
- 完成/取消后：归档报告到 `<workspace>/.dsh/ralph-flow/reports/<instId>.md`，然后**销毁实例目录**（`state.json` 随之消失）。`instances/` 因此只装活跃实例，历史从 `reports/` 读出（`listHistory()`）。`artifacts_dir_name` 是 state 里唯一"非派生"的额外字段：产出目录名在启动时固定，之后无法重算（原设想的理由是子工作流会改写 `user_task`；**本实现的子工作流是加载期静态展开、不改写 `user_task`**，但名字仍在启动时固定落盘：重算依赖实例 id 尾段与当时的原始任务，事后不保证重算出同一个目录名）。

**推进规则（T2 的落点，引擎唯一决策）：**

| 条件 | 引擎做什么 |
|---|---|
| **定义已声明免验证**（`check` / `check_voting` 都不写，§9） | 不委派验证者、不写 `verdicts[]`：非门 → 交卷即按 `on_pass` 推进；门 → 交卷即停在门状态等 `continue`（§12.1 第二支） |
| 判定齐且全 `passed` | 若当前步在**工作流级** `manual_step` 列表里 → 停在门状态等 `continue`；否则按 `on_pass` 推进 |
| 任一条 `failed` | 按 `on_fail` 回退，`fail_count + 1`；未达上限 → 恢复 DO 等待重做；达上限 → 暂停 |
| 任一条 `infra` | 暂停（`check_infra`），**不烧 fail_count** |
| 用户 cancel | 中止在飞验证者，归档报告，`user_cancelled` |

**崩溃恢复**：插件重载扫描 instances/：`active` 且 `delegations[]` 非空（进程死时验证者已 aborted）→ 判定作废、暂停 `check_infra`、清 delegations。**无人驱动 = 暂停等用户，永不隐式推进。**

## 5. 三时刻（dsh 版本）

1. **DO 交卷**：主会话**调用 `ralphflow_submit` 工具**（dsh 原生：工具调用即事实，工具结果带 `concludesTurn` 结束回合）→ 引擎在工具 handler 内受理 → **本步有检查依据时**：若无在飞委派 → **引擎自己委派验证者**（`subagents.start`）；**没有检查依据时**按 §4 表直接推进 / 开门，不委派。主会话全程无委派能力（T1 结构性成立）。
   - **忘了交卷的兜底**：`agent/turn-stopping`（serial、可 await，claude/opencode 版 Stop hook 的原生等价物）在回合关闭前检查「有活跃实例 / 本步未交卷 / 无在飞委派」，是则以 `agent.steer` 提醒调用 `ralphflow_submit`；提醒次数由 history 派生，达上限（2 次）则暂停（`no_submit`）等用户，绝不死循环催促。
   - 交卷工具**必定返回结果**（受理 / 已交卷 / 无实例 / 暂停中），模型与用户都能看到 —— 交卷不再有「静默消失」的路径。
2. **验证者交卷**（本步有检查依据时才发生）：await `run.result`（与宿主 `dsh-tool-subagent` 同款，不设 ralphflow 自造超时）；判定**首选原生结构化输出**，`structured` 经 `outputSchema` 校验后写 `verdicts[]`；provider 不支持 `outputSchema` 时才降级要求 `<promise-check>` 文本标签；**任何解析失败 = infra，绝不 passed**。`subagent/end` 记审计（含 `agent_id`）。
3. **`ralphflow_continue`**：引擎按 §4 表推进。有检查依据时校验判定存在 / `step_id` 等于当前步（归属校验）；**定义已声明免验证的步骤没有判定**，这一支退化为「本步确实没有检查依据」（§12.1 第二支）。不足推进 → 拒绝并说明原因，**不烧 fail_count**。

**审查门（§6 详述）通过后**：人在门上 `continue` 放行；人说"改一下" → 主会话修改、再次调用 `ralphflow_submit`，然后再次回到门（**有检查依据的门重跑验证，无检查依据的门直接回到门**）（**轻量打回，无程序化 return**，等价于 reset 当前步但不算 reset 命令；重开前会真正中止在飞委派，避免孤儿）。

## 6. 审查门（manual_step，v0 就要）

- 门由**工作流级**（顶层，与 `steps` 同级）的 `manual_step:` **列表**声明——列进去的步骤 id 就是审查门：

  ```yaml
  manual_step:            # 顶层：停下等人放行的步骤 id
    - propose
  steps:
    - id: propose
      # …（不要在这里写 manual_step）
  ```

  也接受逗号字符串写法 `manual_step: "propose,review"`（对齐 opencode）。引用不存在的步骤 id = **加载期硬错误**（门会静默失效，绝不放过）。
- **步骤级 `manual_step` 键已删除**：写在步骤里（不论 `true`/`false`/空值）都是**加载期硬错误**，报错文案直接给出正确写法（把该步 id 列进顶层列表）。理由：两种写法在本引擎里曾语义相同、纯冗余；但 opencode/pi **只认工作流级列表**，步骤级写法在那边只是「不认识的步骤键」→ 警告忽略 → **人工审查门静默消失**。静默跳过审查门比报错严重得多，故 fail-fast；同一份 YAML 四端同解是方言的硬约束（§9）。
- **无检查依据的门 = 纯人工审查**：该步**不叠加机器验证**——交卷后跳过对抗性验证，直接停在门等放行。门的判据是 `isGate(wf, step) && (!stepHasVerification(step) || 判定齐且全 passed)`：「本步免验」由**工作流定义**声明（`check` / `check_voting` 都没写），执行者在运行期无法影响（§12.1 精修）。
- `loop` 不设门（自动循环）；`spec` 的 propose 步设门（内置集与 claude/opencode 一致）。
- 门是**工作流定义的属性**（哪些步是门由 YAML 声明），不是全局总闸，也不是运行期开关。

## 7. 验证者协议

- **形态**：全新独立会话的子代理；只见「任务 + 检查依据 + 工件」，不见主会话对话历史，**也看不到执行者的交卷摘要**；跑完即焚。
- **后端选择（按能力，不按名字）**：验证者后端属于 Ralphflow **内部**，工作流没有任何入口影响它。只考虑 `getProvider(n).inheritsParentContext === false` 的 provider（全新上下文）——**绝不**回退到 `true` 的 provider（`fork` 继承主会话历史，T1 静默失效）；未声明该字段的同样不选（fail-closed）。候选里优先 `capabilities.persona && capabilities.toolFilter` 都支持的（这是「独立 + 有纪律的只读裁判」的前置条件；缺了 `start()` 本就会抛 `UNSUPPORTED_CAPABILITY`）。provider 名可配置（`providerName`），**名字不参与判定**。没有可用后端 → `infra`，理由写明「本部署没有全新上下文的委派后端」或点名缺失的能力；两种情况都**不生成通过判定**。
- **身份是内部定义（单一来源）**：验证者职责（独立性、只读取证、不采信自述、默认不通过）收敛为 `verify.ts` 的 `VERIFIER_PERSONA`，经 DSH 原生子代理 `persona` 传入（在子代理 scope 注册 `deployment:persona-prefix` 系统提示段）。**切分线**：persona 只承载「你是谁、你的纪律」；本次任务的事实与**按 `wantStructured` 分支的判定提交方式**（`structured_output` 工具 / `<promise-check>` 文本标记）仍由 `buildCheckPrompt` 承载——后者是逐请求状态，搬进 persona 会让降级路径失效。工作流的 `check` 因此只写判据与事实，不写角色设定。
- **判定**：`outputSchema` 结构化 `{ passed: boolean, reason: string }`；reason 必须给证据（读到的文件/跑出的结果）。
- **只读**：`toolFilter: { allow: [read, grep, glob, bash, read_image] }`。bash 内的间接写（`sed -i`/`tee`）**有意接受**（ADR-0002 同款弱点；将来用 dsh 沙箱收紧，见 §11）。
- **模型**：默认同主会话模型；YAML 可覆盖（§0 推论：独立性 ≠ 模型隔离）。优先级链**与 opencode/claude 一致**：`check_voting` 条目 `model` > 步骤 `check_model` > 全局 `adversarial_check.model` > 发起会话当前模型。
  - `model` 通过 DSH 原生 `agentOptions` 传给验证者，不由提示词要求模型自行切换。**没有覆盖时不传 `agentOptions`**，由宿主 `resolveChildAgentOptions` 继承**父级** provider/model（即发起会话当前模型）。
  - 两种形态都支持（dsh/opencode/claude 三端同解）：`"provider/model"` 字符串、`{ providerID, modelID }` 对象（两者都必须非空）。**裸模型名**（如 `sonnet`）、对象缺字段、或类型非法 → 解析不出 → **告警并回退发起会话当前模型**，绝不静默忽略（否则用户以为换了验证模型，实际没换）。归一化只有一处：引擎的 `resolveCheckModel`（照抄 opencode 语义），验证者只消费结果。
  - `check_model` **仅单 `check` 场景生效**：与 `check_voting` 同写、或本步没有 `check` → **加载期硬错误**（照抄 opencode）。投票步各票用自己条目里的 `model`。
- **公开配置契约（`adversarial_check`）**：可选对象，**唯一允许的字段是 `model`**。`agent` / `system_prompt` / `timeout_ms` **已从公开契约中删除**——它们（以及任何未知字段、`adversarial_check` 非对象）在**加载期**与 `doctor` 都告警并忽略：不拒收、不静默、不改作别的含义。口径与未知键、`check_voting` 统一为 **warn+ignore**（§8 Q13）：dsh 对「自己不兑现的键」只有这一条规则，忽略后回落到固定的内部验证者正是文档承诺的默认行为。告警必须在加载期出现，不能拖到验证阶段。
- **prompt 由引擎构造**：任务原文 + 本步上下文（`desc`/`do`/`input`/`output`/产出目录）+ 检查依据（来自工作流定义，主会话零输入）+ 工作区可读。任务消息正文只保留这些**事实**，通用角色说明走 persona 通道（见上）。验证者 prompt 是 T1 防污染的唯一注入点。
- **绝不注入执行者自述（T1 硬规则）**：验证者**看不到**执行者的交卷摘要/实现总结——它只判「结果是否满足检查依据」，不判「执行者怎么做的、自称做了什么」。自述是**锚点**，会软化独立判定。opencode 与 claude 版同样从不传入，并在提示词里明令"不要依赖任何外部提供的实现总结"。
  - 交卷摘要仍存于 `state.last_submit_summary`，但**唯一消费者是审查门改稿重交去重**（`onSubmit` 里"内容与上次完全相同则不重复验证"），不流向验证者。`VerifyRequest` 类型上**没有** `submitSummary` 字段——从类型层面阻止它被重新引入。
- **数量**：v0 单验证者；**v0.2 起 `check_voting` 激活**（1–5 票并行、全过才放行，见 §11）。`verdicts[]` 与 `delegations[]` 从一开始就按数组建模，投票没有引入新的状态字段：每票一条 `Verdict`（`check_index` = 票号）、一笔 `Delegation`（`attempt` = 第几轮投票）。
- **不注入环境异常条款（作者定案）**：验证者 prompt **不**加「取证期间宿主可能重启/源码可能漂移，请区分环境干扰与被验证对象缺陷」这类提示。理由：环境异常是开放集合（重启、改码、并发写、宿主升级、权限、网络……），逐条枚举等于对不可控环境做猜测，**每条猜测都是一个新增的误判入口**，复杂度换不来正确性。与 `timeout_ms` 同一条原则：宿主职责交宿主，内核不造轮子。
  - **已知代价（如实记录，不修）**：用正在被修改的插件验证它自己的改动时，中途重启会让在飞验证被 `restore()` 孤儿恢复清记账，其判定被 `run_superseded` 丢弃；而**验证者进程仍活着**，它会在一个正在变动的树里取证，可能把环境噪声写进判定（实测：`loop-mudrr90d-xd5d` 两次重启，其中一轮判定即因此失真，其"残留项 #1"经干净环境复现判定为**不成立**）。这是 fail-safe 的诚实代价，**接受**。
  - **正确应对是流程而非代码**：批量交付、需要重启才能生效的改动集中到最后一次重启（见 `hardening-brief.md` §6）。

## 8. 命令面与 v0 范围

**命令/工具（与 claude/opencode 同名，心智通用）。命令语义＝「触发词，回复＝大模型」**（迭代 1 实测定案）：`/ralphflow-*` **一律**给模型注入一条指令（`source: plugin`），由模型调用同名工具、自然回复——**含用法错误**（向 opencode 看齐：参数不全由模型说明用法并追问）——**零程序化卡片返回**。这也根治了「dsh web 新会话首条命令结果不渲染」：命令全部走普通消息路径，平台命令卡渲染缺陷不再涉及。唯一兜底是会话离线时给一行错误提示。工具侧不变：模型可随时直接调用已实现的 `ralphflow_*` 工具。**两条机械命令是例外**：`/ralphflow-reset`（重做当前步）与 `/ralphflow-rewind`（回退到更早的步骤并换方向）的机械动作在命令处理器里直接驱动引擎完成（这是本程序的职责，不要求模型记得去调），结果仍交回模型自然语言回复（零程序化卡片返回不变），且**都不注册**同名工具（不给模型可调用的修复入口，见 §10.10）。

| 命令 | 工具 | v0 形态 |
|---|---|---|
| `/ralphflow-start` | `ralphflow_start` | 实现（命令=触发词 → 模型调工具） |
| `/ralphflow-list` | `ralphflow_list` | 实现（同上） |
| `/ralphflow-status` | `ralphflow_status` | 实现（同上） |
| `/ralphflow-continue` | `ralphflow_continue` | 实现（同上） |
| `/ralphflow-cancel` | `ralphflow_cancel` | 实现（同上） |
| `/ralphflow-create` | `ralphflow_create` | 实现（引导式设计指引 → `ralphflow_doctor` 校验到全部 ✅ 且无告警） |
| `/ralphflow-doctor` | `ralphflow_doctor` | 实现（工作流/实例诊断，坏文件说人话） |
| `/ralphflow-<工作流名>` | — | 动态注册的工作流快捷命令，如 `/ralphflow-loop`、`/ralphflow-spec`（命名与 claude code 版一致） |
| `/ralphflow-reset` | —（不注册同名工具） | **实现**：命令处理器直接驱动引擎做机械重置（换干净上下文 + 重投当前步 DO），结果交回模型自然语言回复。**不赦免失败**（`fail_counts` 原样保留），**暂停中拒绝**并指向 `/ralphflow-continue`，只在 DO 阶段生效。不注册 `ralphflow_reset` 工具——不给模型可调用的修复入口（§10.10）。见下方 §8 |
| `/ralphflow-rewind` | —（不注册同名工具） | **实现**：回退到当前步**之前**的步骤并换方向 = `reset` 的机械动作（整段替换上下文 + 重投目标步 DO）+ **状态机倒退**（`current_step` 拨到目标步，清 `paused` / `pause_reason` / `fail_counts` / `do_submitted` / `verdicts` / `delegations` 并中止在飞验证者，记 `rewind` + `step_start`）+ **带走原因**（原因写进目标步 DO，**自成一段**，并点明下游旧产出仍在盘上、基于旧方向）。目标合法性**只有一条**：按工作流定义顺序、**当前步之前的普通步骤**——没有「已通过 CHECK」这道门（引擎对进度的全部认知就是 `current_step`；不移植 opencode 的 `step-records.json`）。**暂停态允许回退并顺带解除暂停**（判据是 `do_submitted === false`，不是 `paused`：`max_failures` / `check_infra` 的暂停路径留下 `do_submitted=true` 只是那一轮的残留，暂停即意味着机械程序已收尾）。`<步骤> <原因>` 两个都必填，缺参数交回模型自然语言追问；各条拒绝理由（当前步 / 未来步 / 不存在的步骤 / 调用点 / 已交卷）交回模型转达。命令处理器直接驱动引擎，不注册 `ralphflow_rewind` 工具（§10.10）。见下方 §8 |
| —（无命令，DO 阶段由模型自动调用） | `ralphflow_submit` | DO 交卷（dsh 原生工具调用；取代 `<promise>done</promise>` 文本标记）。见 §5 三时刻① |

**reset 门（已实现）**：进入该步前，在**步骤边界的空闲窗口**（`agent.runMaintenance`，phase ≠ idle 即放弃）把属主会话可见面的 `nodes[1]` 到末尾**整段替换**成一条 ralphflow 自己写的「交接稿」，使模型收到的 messages = **系统提示 + 交接稿 + 本步 DO**。载体 = `src/reset.ts`（自有 plugin source `{kind:'plugin', plugin:'ralphflow'}`，**不冒用压缩检查点**、不发任何 `compaction/*` 事件）；策略与投递 = 引擎的 `deliverStepDo` + `EnginePorts.resetSurface`。三种触发**行为完全一致**、只按来源分措辞：步骤级 `reset: true`、工作流级 `auto_reset: true`（= 给所有步骤标 reset，含失败重试）、手动 `/ralphflow-reset`（`resetCurrent`，用户发起、无论该步有没有标都强制重置）。交接稿只写**能现算**的四项（工作流名 / 第几步 / 产出目录 / 交互契约，**零新增状态字段**）；另发一条 append 来源的**可见告知**（Chat 可见），它被同一次替换一并遮蔽，因此不进模型上下文（决定②：不让「用户看到的 ≠ 模型看到的」变成静默）。两条结构性边界：**工作流首步的初次进入无法重置**（首步 DO 是 `ralphflow_start` 的工具返回值，替换会落在工具调用内部 → 孤儿 `tool/result` → 静默损坏会话），启动回执如实说明（并**按来源分两支**：`auto_reset` 带出的重置绝不说成「本步标了 `reset: true`」——作者没标；子工作流的 `auto_reset` 在加载期静态展开下沉为子步骤 `reset: true` 时**同时打来源标记 `reset_from_auto`**，否则合成键会冒充作者标记、让这句错话重新出现）；**面不平衡时放弃本次替换**，DO 照常投递并把原因写进播报行。手动重置另有三条机械护栏：**不赦免失败**（`fail_counts` 原样保留，否则反复 reset 就能绕过 `max_fail_count`）、**暂停中拒绝**并指向 `/ralphflow-continue`（那条路径才是显式的失败赦免）、**只在 DO 阶段**（已交卷 = 验证在飞/审查门，重置会打断验证）。手动重置是异步落地的（等空闲窗口），而命令处理器当场已回 `success`（零程序化卡片）——因此空闲窗口复查若判定实例已交卷/推进/取消，必须**发一条可见告知**（写 `manual_reset_dropped` 进执行日志）说明这次重置没有生效，绝不静默作废。

**回退（`/ralphflow-rewind <步骤> <原因>`，已实现）**：机械动作 = **reset 的动作 + 状态机倒退 + 带走原因**，全部在命令处理器里直接驱动引擎（不经过模型调工具，也不注册工具，§10.10）；载体（`src/reset.ts`）**一行都不用动**——回退只是 `deliverStepDo` 这根现有接线的第四个触发来源（`opts.rewind`，与 `opts.manual` 一样**强制**替换，无论目标步有没有标 `reset`）。① 状态机倒退：`current_step` 拨到目标步，清 `paused` / `pause_reason` / `fail_counts` / `do_submitted` / `verdicts` / `delegations`（并中止在飞验证者），记 `rewind` + `step_start`；② 同一根接线：整段替换上下文（交接稿 + 可见告知）+ 重投目标步 DO；③ **原因写进 DO 提示词、自成一段**（不是只写交接稿：换上下文失败时 DO 照样带着原因落地，所以没有 `keep_session` 这类逃生口），那一段同时点明**下游旧产出仍在盘上、基于旧方向**（回退不删除、不作废任何已有产出）。**目标合法性只有一条**：按工作流定义顺序、当前步**之前**的普通步骤 —— 没有「已通过 CHECK」这道门：引擎对进度的全部认知就是 `current_step`，「哪些步已通过」是 `verdicts[]` / `history` 的**现算派生量**，opencode 那份 `step-records.json` 现算出来的「已通过列表」本仓库已定案**不移植**（第二个事实源，见 §9）。拒绝理由必须各说各的（目标 = 当前步 / 在未来 / 不存在 / 是子工作流调用点 / 当前步已交卷，各有准确说法），并交回模型自然语言转达。**暂停态允许回退并顺带解除暂停**（这正是「停下来后回到更早一步换方向」的旅程）：判据是 `do_submitted === false`，**不是** `paused` —— `max_failures` / `check_infra` 的暂停路径会留下 `do_submitted=true`（那一轮的残留），而暂停本身就意味着机械程序已把该轮收尾（判定已终态、委派已摘除），所以「已交卷」拒绝只在**未暂停**时生效（未暂停 + 已交卷 = 验证在飞 / 审查门已开，回退会把判定变成孤儿）。审查门是 `manual_step` 现算的、静态展开后没有栈帧，**没有标记要清**。顺带修一处：`submit_reminder` 次数按**本次进入该步**起算（`step_start` 就是那条边界；`rework_rewind` / `do_submitted` / `resume` 同样开启新一轮），否则回退到一个已用光提醒预算的步骤会立刻 `no_submit` 暂停。验收：`scripts/rewind-test.mjs`（引擎级判据矩阵 + 真实 Session/命令处理器的整段替换与带原因 DO）。

**v0 没有**（**v0.2 已激活多验证者投票；重置门（步骤级 `reset` / 工作流级 `auto_reset` / 手动 `/ralphflow-reset`）与 `/ralphflow-rewind` 均已实现**）：客户端 UI、HTTP 通道、通知、沙箱。

**v0 有**：YAML 引擎、内置 `loop` + `spec`、审查门、续跑、落盘、失败重试、多实例、报告归档、崩溃 fail-safe。

**方言容错（Q13 定案）**：未知/未支持键（`adversarial_check` 下 `model` 以外的字段如 `agent`/`system_prompt`/`timeout_ms`、`check_voting` 条目里 `check`/`model` 以外的字段、其它未识别键）→ **警告该键未支持/已删除、已忽略，按默认语义跑**；不做语义降级兼容（不加工作量）。`adversarial_check` 写了非对象（`true`/`"foo"`/`[...]`）同样告警并忽略。语法错误、`on_pass`/`on_fail` 引用不存在的步骤 → **fail-fast 带人话报错**。

**超时不在内核里造（作者定案）**：委派生命周期（含模型卡死/打转等异常）**一律交给宿主 dsh 的原生能力**（请求级空闲看门狗、工具调用时限策略），ralphflow 不自建超时轮询或竞速。理由：这是宿主职责，插件重复实现只会分叉行为、随宿主演进腐化。故 `timeout_ms` 永久 warn+ignore，**不要**在后续轮次重新引入有界竞速（claude 版 ADR 独立得出同一结论：`timeout_ms` 零消费者 → 必须静默忽略）。

**`extra_dirs` 不实现（作者定案，与 `timeout_ms` 同一原则）**：**权限是宿主的职责，插件不建平行权限面。** dsh 的验证者子代理**继承发起会话的工作区与权限面**——`SubagentStartRequest` 的字段只有 `label/prompt/parent/signal/agentOptions/outputSchema/maxDepth/toolFilter/persona`，**没有任何路径/权限字段可表达「额外可读目录」**；子代理的权限在启动时固定，dsh 原话：*"your permission scope was fixed when you were started and cannot be widened from inside this session"*。因此「验证者能读什么 = 发起会话能读什么」，opencode 的 `extra_dirs` 在 dsh **没有对应物**（opencode 需要它，是因为它的 check 会话是独立会话 + 自己的权限配置，读项目外必须显式授权）。**不要**在后续轮次把它当缺口补上。

## 9. 工作流文件即资产（Q5 定案）

- YAML 方言跨端共享（opencode/claude/dsh/pi 同一套 `description / manual_step（工作流级 id 列表，步骤级写法已删除 = 硬错误）/ adversarial_check（仅 model，两形态）/ steps / do / check / check_voting（条目 check + model）/ check_model / input / output / on_pass / on_fail / max_fail_count`），是**硬约束**：同一份资产四端可跑，hub 生态押注于此。**`check_model` 与模型引用两形态（§7）已对齐**，故这三项资产在四端同解。dsh 是方言基准：`adversarial_check` 的 `agent`/`system_prompt`/`timeout_ms` 已在 dsh 端删除（opencode/claude 版的对应收敛另行处理），同一份旧 YAML 在 dsh 端 warn+ignore 后仍可跑。
  **维护与收敛范围 = dsh / opencode / claude 三端**（作者定案）。第四端 `ralph-flow-pi`（Pi SDK 的独立 CLI，npm v0.2.1，最后更新 2026-07）**已搁置，不纳入范围**——它的方言事实相同（已核实同样支持被删的三个字段，且验证是同步的 `await adversarialCheck`），但不再维护、不做收敛。上文「四端可跑」是对**既有事实**的陈述，不是维护承诺。
- **六个步骤字段是必填（`desc` / `input` / `output` / `on_pass` / `on_fail` / `max_fail_count`）**：缺失、非字符串、**空串**都 = **加载期硬错误**（整份拒收，不再静默丢步）。来源是 opencode / claude 的加载期校验**代码**（那边缺一个就 `skipStep` —— 该步被静默丢弃，或整份定义因「没有任何有效步骤」被拒收）；本仓库对「会让资产不再表示它所说的话」的配置一律 fail-fast（悬空 `on_pass`、成环、步骤级 `manual_step` 同一口径）。因此**不再有**「`on_pass` 缺省 = 顺序下一步」「`on_fail` 缺省 = 自身」「`max_fail_count` 缺省 3」。**子工作流调用点同样必填这六个**（那两家的加载器把这六项校验排在第 `workflow` 分支之前）；调用点接受并校验 `id`/`desc`/`do`/`input`/`output`/`workflow`/`on_pass`/`on_fail`/`max_fail_count`/`reset`，其余键（`check`/`check_voting`/`check_model`/`inputs`/未识别键）照旧**逐键告警 + 指路**（`inputs` 的文案**指路到调用点的 `do`**）。调用点上的 `reset: true` **生效**：按本实现的静态展开模型 = **首个展开后子步骤**的重置（下沉时打来源标记 `reset_from_call`，措辞说得出是哪个调用点标的）。调用点上的 `do` 同样**生效**：语义 = 「这段子工作流要做什么」= 子工作流的任务，加载期静态展开时下沉到子步骤的 `task`（DO 与 CHECK 提示词的「## 任务」都取它），不写就继承父级任务描述（向后兼容）；嵌套按**最内层优先、外层继承**组合，与 `adversarial_check.model` 的逐层继承同一形态。`task` 是**定义期**字段，不落状态（§10.4）。
- **检查依据是可选语义键（`check` / `check_voting` 都不写 = 免验证，与 opencode 对齐）**：不写检查依据 → 该步**跳过对抗性验证**，DO 完成直接按 `on_pass` 推进；在**工作流级** `manual_step` 列表里时则**纯人工审查**（停在门等 `continue`）。判据 `stepHasVerification(step)` 只读 `StepDef`（工作流定义的属性，不是运行事实，故不落状态）= 有 `check` **或** `check_voting`；`check` 写了但**非字符串**（如 `check: true`）仍是**加载期硬错误**——绝不把「想要 check」误读成「不想 check」（本意是免验证请直接删掉该键）。
- 目录：`<workspace>/.dsh/ralph-flow/workflows/` 自定 + 内置 loop/spec；每实例隔离的**产出目录**为 `<workspace>/.dsh/ralph-flow/artifacts/<artifacts_dir_name>/`（目录名 = 任务摘要 slug + 实例 id 尾段，按码点截断；实例启动时建好、终止后**保留**，DO/CHECK 提示词各注入一行工作区相对路径；只有空目录随实例销毁被 `rmdir` 删掉）。
- **实例生命周期（§4 的落点）**：活跃 vs 历史分两层。工作流完成/取消时 `destroyInstance()` 严格按序执行：① 先 `archiveReport()`，失败则**中止销毁**（保留可见残留 + 告警，绝不静默丢轨迹）；①b 落 `destroy` 事件、并把执行日志归档到 `reports/<id>-execution.log`（**失败只告警、不阻塞销毁**——报告是主事实、日志是辅助证据，与第①步有意不对称）；② **先把全部路径解析并固定**（产出目录名、实例目录、`state.json` 路径 —— 产出目录名只存在于 `state.json` 里，删掉就查不到了）；③ `unlink(state.json)`（失败记 `state_unlink_failed`，ENOENT 除外）；④ 递归删实例目录（失败记 `instance_dir_remove_failed`）；⑤ 非递归 `rmdir(本实例产出目录)`（非空即保留）；⑥ **复查**实例目录是否真的没了（`instanceDirRemoved`），没删掉就记 `instance_dir_not_removed` 并让完成/取消播报**如实说残留**、指向 `doctor`（绝不谎称"已销毁"）。`writeState` 会 `mkdirSync` 实例目录，因此**销毁后不得再写 state**——迟到的验证回调由 `launchVerification` 的 `readState === null` 护栏挡下（记 `verdict_discarded/instance_state_missing`）。存量已结束实例**不自动迁移**，由 `doctor` 报出、用户显式决定。
- **执行日志（JSONL，机器可读的复盘证据）**：每实例一份 `instances/<id>/execution.log`，每行 `{ts, level, event, instId, ...extra}`；生命周期事件（`start / step_start / do_submitted / verify_start / verdict / advance / gate_opened / gate_released / check_skipped / pause / resume / complete / cancelled / destroy`）与既有内部告警（`state_unlink_failed` / `instance_dir_remove_failed` / `instance_dir_not_removed` 等）逐个入流，**验证者提示词原文与判定原文全文**（不截断）也在其中——报告给人看、日志给机器（`grep` / `jq`）看，**两者不互相抄**（报告只新增一行指路）。轮转照 opencode：单文件 **10 MB**、保留 **3** 份（`.log.1..3`），阈值可注入（`EnginePorts.logMaxBytes` 或环境变量 `RALPHFLOW_LOG_MAX_BYTES`），否则轮转这条验收不可测。写日志的任何异常（目录只读 / 磁盘满 / 轮转失败）**只记一条 warning 到插件 `log()` 端口**，绝不抛出、绝不中断工作流、绝不改变推进判定；实例目录不存在时一律不写（**绝不把已销毁的目录 mkdir 回来**）。**零新状态字段**：日志是 append-only 的**文件事实**，不是状态，`state.json` 一个字节都不因它改变（§10.4）。**不移植 `step-records.json`**：它是 opencode 用来**现算**「rewind 的已通过列表」的第二个事实源（我们的 `/ralphflow-rewind` **已实现**，而它的合法性判据只需要 `current_step` ——「哪些步已通过」是 `verdicts[]` / `history` 的派生量），且每步耗时/重试报告已从 `history` 派生（`stepStats()`）——再移植一份就是给同一件事造第二个事实源。任务书：`docs/v2/execution-log-brief.md`；验收：`scripts/execution-log-test.mjs`。
- **工作区运行时目录用 dot-dir**（`<workspace>/.dsh/ralph-flow/`）：与 opencode `.opencode/ralph-flow/`、claude `.claude/ralph-flow/` 形状一致，并与全局 `~/.dsh/ralph-flow/` 对称（同一作用域命名空间 `ralph-flow`）。`.gitignore` 只忽略 `.dsh/ralph-flow/`（精确），不忽略整个 `.dsh/`——将来 dsh 可能往工作区 `.dsh/` 放需要入库的项目配置。
- 所有者：用户手写（进 git）；交互式创建器 `ralphflow_create` **已实现**（`src/create.ts` 的 CREATE_GUIDE 引导设计 + `ralphflow_doctor` 校验到全部 ✅），手写与引导两条路都通。
- **内置工作流不落盘**（对齐 opencode/claude 的 `ensureProjectWorkflows`）：`loadWorkflow` 回落插件目录，内置因此**始终是随插件发布的最新版**。播种副本会遮蔽插件目录、并在插件升级后变成陈旧副本——**实测踩过**：工作区里那份 7 步 `spec` 副本把新版 4 步内置整个挡住了，改内置却"没生效"。定制入口是"放同名文件遮蔽内置"（有意行为）。
- **内置 `spec` = 4 步**（`explore → propose → implement → archive`），与 opencode 现行版同源；7 步是 opencode 在 2.6.0 废弃的旧版（我们此前从 claude 版抄来）。**与 opencode 完全一致**：`propose`/`implement` 标 `reset: true`（重置门，本版本已实现，见 §8）。首步 `explore` **不标**——首步 DO 是启动工具的返回值，结构上无法重置。依据与完整分析见 `spec-4step-brief.md` 与 `reset-feasibility.md`。
- **内置 `loop` = 4 票 `check_voting`**：前三条**逐字照抄** opencode 版 `loop.yaml`（用户任务的每一条要求都已落实 / 实现的行为符合预期，真实可用 / 没有遗漏的需求，边界情况已覆盖），第 4 条是本仓库自己的口径「**修改不影响原有功能，不破坏需求以外的边界**」。第 4 条**刻意只写判断、不写取证动作**（不写「跑仓库自带测试 / 与基线比对」这类）：内置工作流要对任意项目通用，不能假定项目有测试套件、lint 工具链或 git 基线；取证方式由验证者按项目现状自选（它有 `read`/`grep`/`glob`/`bash`），这与前三条的形态也一致。**自包含取证配方**（打开哪些文件、跑哪些命令）是给**项目自己写的**工作流的建议，见 `ralphflow_create` 的设计最佳实践，不要上移到内置件里。与 opencode 版的**差异只写在注释里**（不抄进来）：它的 `reset: true`（本端**已支持**该方言，但 loop 只有一步、永远是首步 → 标了也只会得到启动回执里一行「首步无法重置」的如实说明）与 `adversarial_check.timeout_ms`（本端已从公开契约删除）——后者抄进来只会得到告警。形状由 `scripts/engine-test.mjs` §1 断言钉住（票数 / 三条逐字文案 / 第 4 票纯判断且不含项目专有假定 / 不含生效的 `reset`·`timeout_ms` 键 / 零告警），不只断言告警；reset 门的端到端验收见 `scripts/reset-surface-test.mjs`。
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
10. **不允许引入自动修复类命令的实现**（`unbrick`）。`ralphflow_doctor` 是**诊断**命令——只报问题与修法，绝不代替用户修，因此不属本禁令；需要自动修复 = 设计错了。**边界**：重置门（步骤级 `reset: true`、工作流级 `auto_reset: true`）是工作流作者写的键、由引擎在步骤边界机械执行，不是「命令」、也不给模型任何可调用的修复入口，故不在本禁令内。`/ralphflow-reset` 与 `/ralphflow-rewind` **是作者已放行的两条例外**（前者原定「只声明不实现」，后者原定「命令只声明不实现」，见 §8 命令表）：两者都是**用户手里**的入口，由命令处理器**直接驱动引擎**（**不注册同名工具**，不给模型可调用的修复入口），且都**不替用户修、也不判断「修好了」** —— 推进权仍在机械程序手里（都必须重新通过独立验证）。两条的语义差异是刻意的：`/ralphflow-reset` = 重做**当前步**，只换干净上下文、**不赦免失败**（`fail_counts` 原样保留，反复 reset 不能绕过 `max_fail_count`），暂停中一律拒绝并指向 `/ralphflow-continue` 这条显式赦免路径；`/ralphflow-rewind` = 回退到**更早的步骤**并换方向，按用户显式意图清掉旧方向的推进事实（暂停、失败计数、判定与在飞委派），**暂停态也允许**（顺带解除暂停）——它不是「修复」而是「这条方向作废，回去重做」，且它**不删除任何产出**（下游旧产出仍在盘上，DO 里明写这一点）。
11. **每个功能入场合规**：带"最小版失败"的复现记录（§11 准入列）。
12. **不支持的方言键 = 警告忽略，不兼容、不加工作量**（Q13 定案）。

## 11. 路线图（每级只由"最小版失败"触发）

| 版本 | 加什么 | 准入 |
|---|---|---|
| **v0** | 本文所定义的一切 | — |
| 迭代 1 | 真实使用反馈修复（明天开跑） | 作者日常使用中炸了/别扭了 |
| 迭代 1 记录 | **已解决（重构定案）**：① 命令返回"工具原始文本"不像大模型回复 → 命令改为**触发词**（注入指令给模型，模型调同名工具并自然回复）；② 该重构顺带根治了「dsh web 新会话首条斜杠命令结果不渲染」——命令现在走普通消息路径，平台命令卡渲染缺陷不再影响（无需上游 issue，v0.4 命令卡作 UI 润色而非必需） | 已复现并解决 |
| v0.2 | 多验证者投票（`check_voting` 激活）**已实现** | 原准入是「单验证者 ≥3 次误放/误烧的证据」；本次由作者**直接指示**实现，**未按原样收集该证据**（如实记录，不补造）。行为对齐 opencode `check-voting.ts` + `voting-progress.ts`（权威参考），载体按 dsh 无相位模型落地：进度不另立文件（`state.json` 单根事实源） |
| v0.3 | `create` 交互式、`doctor` 薄版（fail-fast 的人话出口）**已实现** | 手写 YAML 开始成为摩擦 |
| v0.4 | UI（页头/抽屉，复用 v1 配方） | loop+spec 在 ≥20 个真实任务上跑过；命令卡渲染作为本次实测问题的补药 |
| v0.5+ | 验证者沙箱化、通知 | 各自的最小版失败证据（`/ralphflow-rewind` **命令**已在 v1.1 实现） |
| v0.7 | **reset 门（步骤级 `reset: true`）已实现** —— 进入该步前在步骤边界的空闲窗口整段替换会话可见面（交接稿 = 系统提示之后唯一内容），模型收到的 messages = 系统提示 + 交接稿 + 本步 DO。载体 `src/reset.ts`（`agent.runMaintenance` 互斥 + `toolPairingBalancedAfter` 自检 + 自有 plugin source），策略/投递在引擎（`deliverStepDo` + `EnginePorts.resetSurface`）。**零新增状态字段**（交接稿只写能现算的四项）；**首步无法重置**（首步 DO 是工具返回值）→ 启动回执如实说明；**面不平衡时放弃替换**且 DO 照常投递。验收 `scripts/reset-surface-test.mjs`（真实 Session + 真实插件装配的端到端 + 负对照 + 五条硬约束负例）。预研与五条硬约束见 `reset-feasibility.md` | 作者**直接指示**（同 v0.2/v0.6：未按原准入收集最小版失败证据，如实记录）；预研阶段已完成五路源码取证 |
| v0.8 | **reset 补齐两处已实现**：① 工作流级 `auto_reset: true`（= 给所有步骤标 reset，含失败重试；子工作流的 `auto_reset` 在加载期静态展开时下沉为子步骤 `reset: true` **并保留来源标记 `reset_from_auto`**，嵌套 auto_reset 的措辞仍走 auto 支）；② 手动 `/ralphflow-reset`（`resetCurrent`）。同一根接线（`deliverStepDo` 的 `opts.manual`）、同一语义（只换干净上下文、**不赦免失败**），三种来源只按**措辞**分述（`auto_reset` 绝不说成「本步标了 `reset: true`」——作者没标）。`/ralphflow-reset` 是命令处理器直接驱动引擎的机械路径，**不注册** `ralphflow_reset` 工具（§10.10：不给模型可调用的修复入口）；暂停中拒绝并指向 `/ralphflow-continue`，只在 DO 阶段生效；在回合进行中按下、回合以交卷收尾而被丢弃时**发可见告知并写执行日志 `manual_reset_dropped`**（绝不静默作废）。`auto_reset` 非布尔 = 加载期硬错误；纯线性流配 `auto_reset` 给 doctor 成本提示 | 作者**直接指示**（同 v0.2/v0.6/v0.7：未按原准入收集最小版失败证据，如实记录）。第二轮对抗验证抓出两个反例后修复：嵌套 auto_reset 来源被合成键抹掉、手动重置在「模型在飞」时静默失败 |
| v0.9 | **六个必填步骤字段 + 调用点 reset + 接管/status 两处体验已实现**：① `desc` / `input` / `output` / `on_pass` / `on_fail` / `max_fail_count` **加载期必填**（缺失/非字符串/**空串** = 整份拒收）——来源是 opencode / claude 的加载期校验**代码**（缺一个就 `skipStep`：静默丢步或整份拒收），**子工作流调用点同样必填这六个**（那两家把这六项校验排在第 `workflow` 分支之前）；调用点接受并校验 `id`/`desc`/`input`/`output`/`workflow`/`on_pass`/`on_fail`/`max_fail_count`/`reset`，其余键（`do`/`check*`/`inputs`/未识别键）照旧逐键告警 + 指路。② 调用点上的 `reset: true` **生效**：按本实现的静态展开模型 = **首个展开后子步骤**的重置，下沉时打来源标记 `reset_from_call`（记调用点 id），措辞按来源分述（步骤级 / `auto_reset` / **调用点**），可见告知一律写明来源。③ 接管**只在无属主**（`owner_session` 为空）时自动；有属主（或多个无属主无法判定）→ 列候选（含属主会话）并要求 `/ralphflow-continue <实例ID>` 显式指定（显式指定仍可接管有属主实例）。`/ralphflow-status` 无参且本会话无实例 → **全部活跃实例概览**（含属主），详情也显示属主会话 | 作者**直接指示**（同 v0.2/v0.6/v0.7/v0.8：未按原准入收集最小版失败证据，如实记录）。参照实现按**代码**取证（文档把 `check` 写成必填、代码里它是可选的 —— 本任务明确「读代码，别信文档」） |
| v0.6 | **子工作流（`workflow:` 代替 `do:`）已实现** —— **加载期静态展开**：调用点就地内联成子步骤（id 加 `调用点id/` 前缀），子工作流出口接到调用点的 `on_pass`。**零新增 InstanceState 字段**（不用 opencode 的运行时状态栈：`current_step` 仍是单字符串、失败预算仍按步记账）。与 opencode 的四处刻意差异：① 它静默忽略或拖到运行期才炸的（成环 / 子文件加载不出来 / id 含 `/` 撞展开）一律**加载期硬错误**；② 展开后步骤总数上限 **2000**（展开中计数、超了立刻中止）与**嵌套深度上限 32 层**（含最外层：展开器是递归的，1900 个「每层零步骤」的串联文件步数只有 1、步数上限看不见，深度闸在展开任何一层之前拒绝，绝不冒泡 `RangeError`）；③ 子步骤耗尽 `max_fail_count` → **暂停等人**（不做「自动走父级 `on_fail`」）；④ 调用点**接受并校验** `id`/`desc`/`do`/`input`/`output`/`workflow`/`on_pass`/`on_fail`/`max_fail_count`/`reset`（六个必填；`reset` 与 `do` 在调用点上**生效**：前者下沉到首个展开后子步骤的重置、后者下沉到子步骤的 `task` = 「## 任务」），其余键**逐键告警 + 指路**，`manual_step` 标调用点 = **整段子工作流跑完后停门**（opencode 禁止这种写法）。子文件里的 `adversarial_check.model` 下沉到它各步的 `check_model`（逐层继承）；调用点的 `do` 下沉到子步骤的 `task`（最内层优先、外层继承）；不传参（`inputs` 告警忽略，文案指路到调用点的 `do`）。验收 `scripts/subworkflow-test.mjs`（含负对照） | 作者**直接指示**（同 v0.2：未按原准入收集最小版失败证据，如实记录）。与 `subworkflow-nesting-research.md` 的推荐（独立子实例 + `awaiting_child` 指针）方向不同——该调研的两条主要顾虑（展开会把一次逻辑失败拆成多个物理步骤、运行时状态栈与宪法冲突）正是本实现正面绕开的：展开后失败预算仍按**步**记账，且不引入任何栈 |
| v1.0 | **调用点上的 `do` 生效**（零新概念：同一个键、同一个意思，只是层级不同）：调用点的 `do` = 「这段子工作流要做什么」= 子工作流的任务，加载期静态展开时下沉到子步骤的 `task`，**DO 与 CHECK 提示词的「## 任务」都取它**（执行者与验证者对着同一个任务干活）；不写就继承父级任务描述（向后兼容）。嵌套**最内层优先、外层继承**（与 `adversarial_check.model` 的逐层继承同一形态）。`StepDef.task` 是**定义期**字段、**零新增 InstanceState 字段**（§10.4）。`inputs` 仍告警忽略，文案改为**指路到调用点的 `do`**。调用点 `do` 非字符串 = 加载期硬错误；`do:` 只写键名（空值）= 没写（与 `reset` 同口径） | 作者**直接指示**（同 v0.2/v0.6–v0.9：未按原准入收集最小版失败证据，如实记录）。验收 `scripts/subworkflow-test.mjs` 第 9 节：两个调用点以不同 `do` 调用同一子工作流各拿各自的任务 / 不写则继承父级 / 嵌套最内层优先 / DO 与 CHECK 同源 / `inputs` 文案指路到 `do` / 负对照「按锚点还原不下沉 → 同一批判据必须为假」 |
| v1.1 | **`/ralphflow-rewind` 从「只声明」做成真命令**（§8）：机械动作 = reset 的动作 + 状态机倒退 + 带走原因 —— `current_step` 拨到目标步，清 `paused` / `pause_reason` / `fail_counts` / `do_submitted` / `verdicts` / `delegations`（并中止在飞验证者），记 `rewind` + `step_start`，再走 `deliverStepDo` 这根现有接线（整段替换 + 可见告知 + 重投目标步 DO）；**载体（`src/reset.ts`）一行未动**（回退只是第四个触发来源 `opts.rewind`）。目标合法性 = 按工作流定义顺序、当前步之前的**普通步骤**（没有「已通过 CHECK」这道门；不移植 `step-records.json`）；原因写进目标步 DO 自成一段并点明下游旧产出仍在盘上；暂停态允许回退并顺带解除暂停（判据 `do_submitted === false`，不是 `paused`）；命令处理器直接驱动引擎、不注册工具，`<步骤> <原因>` 两个都必填、缺参数交回模型追问、各条拒绝理由交回模型转达。顺带修：`submit_reminder` 次数按本次进入该步（`step_start`）起算 —— 否则回退到已用光提醒预算的步骤会立刻 `no_submit` 暂停 | 作者**直接指示**（同 v0.2/v0.6–v1.0：未按原准入收集最小版失败证据，如实记录）。验收 `scripts/rewind-test.mjs` |

## 12. 验收（v0 完成判据）

1. **裁判权测试组全绿**：伪造判定 / **执行者自行跳过验证推进** / 过旧判定复用 / 无判定推进 / 主会话试图委派——全部被拒（§5 三时刻 + §7 协议的自动化测试）。
   - **2026-09 精修（作者批准）**：原措辞「跳过验证推进」收窄为「**执行者自行**跳过验证推进」。判据是机械可判的两支：`可推进 ⇔ stepHasVerification(step) ? (判定齐 ∧ 全 passed ∧ 归属本步) : 定义已声明本步免验证`（`stepHasVerification` = 有 `check` **或** `check_voting`，见 §9；v0.2 引入投票后判据由此从 `stepHasCheck` 升级，`stepHasCheck` 现在只留在单 `check` 专用的几处：期望票数、`check_model` 下沉、`buildCheckPrompt` 的守卫）。
   - **为什么仍是 fail-closed**：决策输入是**工作流定义**（作者所有），不是执行者——`stepHasVerification` 只读 `StepDef`，与 state、与模型输出无关，执行者在运行期无法影响它。故「无检查依据（`check` / `check_voting` 都不写）的步骤跳过验证」是**作者声明的机械推进**，不是执行者绕过裁判。同类先例：审查门的放行本就是「无机器判定即推进」（由人决定）。
   - **不得放宽的攻击向量**：伪造判定、**无判定且定义未声明免验证时的推进**、过旧判定复用、主会话试图委派。
   - 落地任务书：`docs/v2/no-check-semantics-brief.md`（**已实现**：`stepHasVerification(step)` 只读 `StepDef`；无检查依据的步骤不委派验证者、不写 `verdicts[]`，DO 完成直接推进 / `manual_step` 停在门等放行；跳过一律诚实标注「跳过对抗性验证」，通用兜底配方已退役）。
2. **loop 完美符合要求**：作者用它在真实需求开发任务上跑通（含失败重试、审查门、续跑）。
3. **坏 YAML fail-fast 说人话**；未知键警告忽略。
4. 安装进作者日常使用的 web profile，明日起即用。

## 13. 目录与仓库动作

- 现状冻结：`git branch archive/v1`（tag v0.1.1 已有）。
- v2 源码结构：
  ```
  src/index.ts     入口：Service 注册 / 工具 / 命令 / 事件监听 / 重启扫描
  src/engine.ts    状态机 + 三时刻 + 审查门 + 推进规则 + 崩溃恢复
  src/verify.ts    ralph-check 委派（selectBackend 按能力选后端 / persona / toolFilter / outputSchema / 打回）
  src/tools.ts     工具与命令注册（含 ralphflow_submit）+ 动态工作流快捷命令
  src/voting.ts    多验证者投票（聚合优先级 / infra 重试）
  src/create.ts    自定义工作流创建指引（CREATE_GUIDE）
  workflows/loop.yaml  spec.yaml   内置工作流（发货）
  ```
- 包名 `ralphflow-dsh` 沿用；成熟后发 2.0.0。