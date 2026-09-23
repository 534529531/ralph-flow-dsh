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
| Stop hook 见 `<promise>done</promise>` | `session/event` 的 `assistant/message` 最后一行（v1 `lastAssistantText` 同款） |
| 「去验证」宣告（hook 注入） | `agent.steer(userMessage)`（source `{kind:"plugin"}`；v1 `agent.followup` 已实测可用） |
| `SubagentStop` 记录判定 | **`await subagents.start(...).result`（权威）** + `subagent/end` 事件（审计） |
| `ralph-check` agent 定义 | `subagents.start` 传 `toolFilter` + `persona` + `outputSchema`（程序级强制） |
| `ralphflow_*` MCP 工具 | `ctx.tools.register` + `ctx.commands.register` |
| .delegation-in-flight | 内存 `Set` + state.json `delegations[]` |

## 4. 状态（无相位）

```jsonc
// <workspace>/ralph-flow/instances/<instance-id>/state.json
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
  "delegations": [{ "run_id": "...", "agent_id": "...", "check_index": 0, "ts": "..." }],
  "verdicts": [{ "check_index": 0, "status": "passed | failed | infra",
                 "reason": "...", "agent_id": "...", "step_id": "loop", "ts": "..." }]
}
```

- **不存相位**（ADR-0004）：相位是派生量，存了就有两个写入者。v1 的 34 处文件标记位即此教训。
- 每次运行一个 JSON，原子写（临时文件 + rename）。
- 完成/取消后归档报告到 `ralph-flow/reports/`，实例转 `active: false`。

**推进规则（T2 的落点，引擎唯一决策）：**

| 条件 | 引擎做什么 |
|---|---|
| 判定齐且全 `passed` | 若当前步 `manual_step: true` → 停在高阶状态等 `continue`；否则按 `on_pass` 推进 |
| 任一条 `failed` | 按 `on_fail` 回退，`fail_count + 1`；未达上限 → 恢复 DO 等待重做；达上限 → 暂停 |
| 任一条 `infra` | 暂停（`check_infra`），**不烧 fail_count** |
| 用户 cancel | 中止在飞验证者，归档报告，`user_cancelled` |

**崩溃恢复**：插件重载扫描 instances/：`active` 且 `delegations[]` 非空（进程死时验证者已 aborted）→ 判定作废、暂停 `check_infra`、清 delegations。**无人驱动 = 暂停等用户，永不隐式推进。**

## 5. 三时刻（dsh 版本）

1. **DO 交卷**：主会话最后一行 `<promise>done</promise>`（协议与 opencode/claude 一致，资产与心智通用）→ 引擎在 `session/event` 观测 → 若无在飞委派 → **引擎自己委派验证者**（`subagents.start`）。主会话全程无委派能力（T1 结构性成立）。
2. **验证者交卷**：await `run.result`，`structured` 经 `outputSchema` 校验后写 `verdicts[]`；结构不合 → 打回重交（上限 3）；**任何解析失败 = infra 或打回，绝不 passed**。`subagent/end` 记审计（含 `agent_id`）。
3. **`ralphflow_continue`**：引擎读判定按 §4 表推进。校验：判定存在 / `step_id` 等于当前步 / `ts` 晚于本次进入 DO（防旧判定复用）。不足推进 → 拒绝并说明原因，**不烧 fail_count**。

**审查门（§6 详述）通过后**：人在门上 `continue` 放行；人说"改一下" → 主会话修改、重新 `done`、重新验证、再次回到门（**轻量打回，无程序化 return**，等价于 reset 当前步但不算 reset 命令）。

## 6. 审查门（manual_step，v0 就要）

- YAML 步骤 `manual_step: true` → 该步对抗验证通过后停在门状态，等 `continue`。
- `loop` 不设门（自动循环）；`spec` 的 propose 步设门（内置集与 claude/opencode 一致）。
- 门是**步骤级开关**，由工作流表达，不是全局总闸。

## 7. 验证者协议

- **形态**：全新独立会话的子代理；只见「任务 + 检查依据 + 工件」，不见主会话对话历史；跑完即焚。
- **判定**：`outputSchema` 结构化 `{ passed: boolean, reason: string }`；reason 必须给证据（读到的文件/跑出的结果）。
- **只读**：`toolFilter: { allow: [read, grep, glob, bash, read_image] }`。bash 内的间接写（`sed -i`/`tee`）**有意接受**（ADR-0002 同款弱点；将来用 dsh 沙箱收紧，见 §11）。
- **模型**：默认同主会话模型；YAML `adversarial_check.model` 可覆盖（§0 推论：独立性 ≠ 模型隔离）。
- **prompt 由引擎构造**：任务原文 + 检查依据（来自工作流定义，主会话零输入）+ 交卷摘要 + 工作区可读。验证者 prompt 是 T1 防污染的唯一注入点。
- **数量**：v0 单验证者。`verdicts[]` 与 `delegations[]` 按数组建模，为将来多票预留，但 v0 恒为 1。

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

**v0 没有**：多验证者投票、reset、rewind、客户端 UI、HTTP 通道、通知、沙箱。

**v0 有**：YAML 引擎、内置 `loop` + `spec`、审查门、续跑、落盘、失败重试、多实例、报告归档、崩溃 fail-safe。

**方言容错（Q13 定案）**：未知/未支持键（`check_voting`、`timeout_ms` 等）→ **警告该键 v0 未支持已忽略，按默认语义跑**；不做语义降级兼容（不加工作量）。语法错误、`on_pass`/`on_fail` 引用不存在的步骤 → **fail-fast 带人话报错**。

## 9. 工作流文件即资产（Q5 定案）

- YAML 方言跨端共享（opencode/claude/dsh 同一套 `description / adversarial_check / steps / do / check / on_pass / on_fail`），是**硬约束**：同一份资产四端可跑，hub 生态押注于此。
- 目录：`<workspace>/ralph-flow/workflows/` 自定 + 内置 loop/spec。
- 所有者：用户手写（进 git）；`ralphflow_create` 交互式创建器推迟（v0 只声明）。
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
  src/verify.ts    ralph-check 委派（toolFilter/persona/outputSchema/打回） ~140 行
  src/tools.ts     5 工具 + 4 只声明命令                                    ~110 行
  workflows/loop.yaml  spec.yaml   内置工作流（发货）
  ```
- 包名 `ralphflow-dsh` 沿用；成熟后发 2.0.0。