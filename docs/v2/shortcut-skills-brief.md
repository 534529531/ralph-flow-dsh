# 把「启动类」快捷入口从命令改成技能

两个目的，一个改动：**用户敲的入口不再是命令**（新会话因此能自动命名），**技能描述成为模型自然语言起工作流的触发词**。

## 问题

**现象**：新开一个会话，第一句就敲 `/ralphflow-start loop …` 或 `/ralphflow-<工作流> …`，这个会话**永远没有标题**，侧栏显示「未命名」，只能手动改名。

**根因**（两层，都可复核）：

1. dsh 的会话标题只认一种输入 —— `user/message` 且 `source.kind === "user"`。
   `dsh-session-title/lib/index.js:91`：`if (event.type !== "user/message" || event.data.source.kind !== "user") return void 0;`
   **兜底标题也要先有合格输入**，所以没有合格输入 = 连兜底名字都不会有。
2. dsh 的**斜杠命令**落成 `command/run` + `command/done`（不是 `user/message`），永远不会被上面那条式子看中。

我们的启动入口恰恰是「新会话第一条输入」的最典型形态，所以撞上的概率接近 100%。这不是 ralphflow 特有的 —— 任何命令当第一句都一样（RA2 那个会话里第一句是 dsh 自带的 `/permission danger-full-access`，那时就已经注定没标题了）。

**活样板（照它走）**：作者自己的 `session-c1a9fef0` 里，用户敲的是**技能** `/write-docs …`：

```
seq 9   user/message   source={"kind":"user","rpcId":…}                       ← 敲的内容就是普通用户消息
seq 12  user/message   source={"kind":"skill-invocation","name":"write-docs"}  ← 宿主在 pre-step 自动注入技能正文
seq 16  session/title  {"title":"/write-docs 请根据当前代码仓功","messageSeqs":[9],"source":{"kind":"fallback"}}
seq 18  session/title  {"title":"重写 README 与文档","messageSeqs":[9],"source":{"kind":"provider",…}}
```

会话**自动命名**，而且**没有** `skill` 工具调用 —— 技能正文由宿主注入，不多花模型回合。

**第二个现象**：现在模型目录里没有任何 ralphflow 的触发词，所以「用户自然说一句要一条带验收的工作流」不会起工作流 —— 只有人敲斜杠才行。

## 目标

1. **`ralphflow-start`**（通用启动）注册为技能，**两面可见**：
   - 人敲 → 普通 `user/message` → **会话有标题**；技能正文由宿主在同一步注入。
   - 模型按**描述**自然触发 → 调 `skill` 读正文（或直接调 `ralphflow_start`）→ 起工作流。
2. **`ralphflow-<工作流>`**（`loop` / `spec` / 自定义）注册为技能，**只给人看**：它们是同一个触发分支的敲字捷径，进模型目录只会让模型在 N 条同义描述里挑（writing-for-agents：一段一个触发分支，同义重复就是一个分支写了两遍）。
3. **不加系统提示词段落**：技能描述本身就是那个 context pointer —— dsh 的技能目录消息自带路由指令（原文见下），所以触发词只写一处。同一个触发写两处 = 重复，且会把它的权重抬到不真实的层级。

## 机制事实（照做，别自己发明）

- 注册：`ctx.skills.register({ name, description, content, invocation? })`（`@deepseek-ai/dsh-skill`）；插件 `inject` 里加 `"skills"`。
- `invocation` 省略 = **两面都有**（`SkillRegistration` 原文：*omission permits both model and user surfaces*）。
  · `ralphflow-start`：省略 `invocation`。
  · `ralphflow-<工作流>`：`{ userInvocable: true, modelInvocable: false }`。
- 模型目录**只渲染 `name` + `description`**（`dsh-tool-skill` 的 `renderCatalogEntries`：`` `- \`${entry.name}\`: ${escapeText(entry.description)}` ``）。`whenToUse` **不进目录**，所以触发词必须写在 `description` 里。
- dsh 的目录消息原文自带路由指令：*"If the user names a skill, or the task **clearly matches a skill's description**, call the `skill` tool with the exact skill name before taking task actions."* —— 描述就是触发器。
- 用户敲的 `/name` 由 `dsh-tool-skill` 在 `agent/pre-step` 扫出来（`SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`），而且**只扫 `source.kind === "user"` 的消息**（`invokedSkillNames`）。硬约束：**必须删掉同名命令** —— 只要同名命令还在，客户端就把它解析成 `command/run`，标题照旧没有。
- 技能名必须是小写 kebab：`[a-z0-9]+(-[a-z0-9]+)*`（`SKILL_NAME`）。自定义工作流名要按这个语法校验后再注册。
- 技能正文 = 现在 shim 里那段 directive 的语义（「用户用 `/ralphflow-<工作流>` 启动了 `<工作流>`：请调用 `ralphflow_start`，workflow = …，task = 用户那条消息里的任务」），保持精简；参数从用户那条消息里取。

## 描述文本（逐字使用，不要改写）

**`ralphflow-start`**（这一句是唯一的触发词，两面共用）：

```
每步都由独立会话的验证者验收的工作流。用户点名 ralphflow，或要求做完由独立验证者验收才算完成时用它。
```

**`ralphflow-<工作流>`**（只给人看，不是触发词）：直接用该工作流 YAML 里的 `description`（它本来就是面向人的一句话，例如 `loop.yaml` 的「单步对抗验证循环：实现与验证在同一环节内迭代，直到通过」）；没有时回落 `用 <工作流名> 工作流跑一个任务。`

**不要**把触发词同时写进 `ralphflow_start` 的工具描述，也不要另加系统提示词段落 —— 触发词只此一处。也**不要**在这段描述里复述「普通长任务用 goal、有界委派用 subagent」：那几段各自的工作自己描述自己，重述就是重复。

## 边界（这些保持命令，不要顺手改）

| 快捷 | 为什么留命令 |
|---|---|
| `/ralphflow-reset`、`/ralphflow-rewind` | 机械执行，而且**没有对应工具**（设计如此：不给模型修复入口）。做成技能等于让模型发起重置/回退，而且技能里没有工具可调 |
| `/ralphflow-cancel`、`/ralphflow-continue` | 人的权限（中止实例 / 放行审查门）。命令由处理器机械执行、即时生效；技能要绕一个模型回合，还可能被模型忽略 |
| `/ralphflow-status`、`/ralphflow-list`、`/ralphflow-doctor` | 纯读操作，命令零 token 即时回 |
| `/ralphflow-create` | 同类（也是「把指令交给模型」），但它不是「启动一条运行」，也不涉及新会话第一句；这次不动，避免扩大验证面 |

另外：判定/推进/重置/计票语义一字不改；不给模型任何新的可调用入口。

## 完成判据

1. **每一处快捷入口都归类过**：全仓所有 `commands.register` 的条目与新增的技能注册，逐条写明是「技能」还是「命令」、以及 `invocation` 取值。漏一处即未完成。
2. **启动类不再是命令**：`ralphflow-start` 与 `ralphflow-<工作流>` 都是技能，且**同名命令已删除** —— 包括动态登记自定义工作流的那条路径。
3. **触发词只出现一次**：模型目录里与 ralphflow 相关的条目**只有一条**（`ralphflow-start`），其描述逐字等于上面那句；`ralphflow-<工作流>` 的 `modelInvocable` 为 false。工具描述与系统提示词里都没有重复的触发词。
4. **名字合语法**：所有技能名满足 `[a-z0-9]+(-[a-z0-9]+)*`；自定义工作流名不合语法时如实拒绝并说清原因，不许静默跳过。
5. **两条路都有可复核证据**：
   - **人敲**：技能 `userInvocable` + 无同名命令 ⇒ 用户那条是 `source.kind:"user"` 的普通消息 ⇒ 标题口径成立（附源码位置）。
   - **自然语言**：模型目录里有那条描述（附 `renderCatalogEntries` 的渲染形态与目录自带的路由指令位置）。
   若能真起一个会话敲一次、或真用自然语言问一次，用真会话证据更好。
6. **其余快捷行为不变**：上表四条仍是命令；`/ralphflow-rewind`、`/ralphflow-reset` 仍机械执行。
7. **原有功能不退化**：`npm run build && npm run typecheck && npm run verify` 全绿。测试跟着功能改，不许为了让测试过而妥协功能。
