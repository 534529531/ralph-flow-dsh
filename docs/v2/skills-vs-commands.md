# 快捷入口的逐条归类：哪些是**技能**，哪些是**命令**

> 判据（任务书「完成判据」1/2/3/6）：**全仓每一处 `commands.register` 的条目与每一处技能注册，
> 逐条写明是「技能」还是「命令」、以及 `invocation` 取值；启动类不再是命令；触发词只出现一次。**

全仓只有两个注册点（`grep -rn "commands.register\|skills.register" src/`）：

| 注册点 | 注册什么 |
|---|---|
| [`src/tools.ts`](../../src/tools.ts) `registerCommands` 的 `defs` 循环（`commands.register`） | 下面表 A 的 8 条命令 |
| [`src/skills.ts`](../../src/skills.ts) `registerSkills`（`ctx.skills.register`） | 下面表 B 的 1 条通用技能 + 表 C 的动态工作流技能 |

## 表 A：命令（8 条，`ctx.commands.register`）

`invocation` 这一列对命令不适用（命令没有 `invocation` 策略，`ctx.commands` 不分模型面/人面）；
「面」一列写的是它在 dsh 里的可见面与载体。

| 命令 | 面 / 载体 | 为什么留命令（任务书「边界」） |
|---|---|---|
| `/ralphflow-continue` | 人敲 → `command/run` → 指令投给模型 | **人的权限**（放行审查门）。命令由处理器机械放行、即时生效；技能要绕一个模型回合，还可能被模型忽略 |
| `/ralphflow-cancel` | 同上 | **人的权限**（中止实例）。同上 |
| `/ralphflow-reset` | 人敲 → `command/run` → 处理器**直接**驱动引擎（`run`） | 机械执行，且**没有对应工具**（设计如此：不给模型修复入口） |
| `/ralphflow-rewind` | 同上 | 同上 |
| `/ralphflow-status` | 人敲 → `command/run` → 指令投给模型 | 纯读操作，命令零 token 即时回 |
| `/ralphflow-list` | 同上 | 同上 |
| `/ralphflow-doctor` | 同上 | 同上 |
| `/ralphflow-create` | 人敲 → `command/run` → 指令投给模型 | 同类（「把指令交给模型」），但它不是「启动一条运行」，也不涉及新会话第一句；这次不动，避免扩大验证面 |

## 表 B：通用启动技能（1 条，`ctx.skills.register`）

| 技能 | `invocation` | 面 | 内容 |
|---|---|---|---|
| `ralphflow-start` | **省略** ⇒ 注册表默认 `{ modelInvocable: true, userInvocable: true }`（`dsh-skill/lib/index.js:203`；类型注释原文 *omission permits both model and user surfaces*） | **两面都有**：人敲 `/ralphflow-start <工作流> <任务>` → 普通 `user/message` + 宿主注入正文；模型按描述自然触发 → 调 `skill` 工具加载正文 | 描述 = 触发词（逐字，见下）；正文 = 「调 `ralphflow_start`，参数从用户那条消息里取」+ 工作流机制说明 |

**触发词（`description`）逐字为**：

```
每步都由独立会话的验证者验收的工作流。用户点名 ralphflow，或要求做完由独立验证者验收才算完成时用它。
```

它是**唯一一处**触发词：`ralphflow_start` 的工具描述不复述它，也没有另加系统提示词段落。
模型目录只渲染 `name` + `description`（`dsh-tool-skill/lib/index.js:929` 的 `renderCatalogEntries`：
`` `- \`${entry.name}\`: ${escapeText(entry.description)}` ``），`whenToUse` 不进目录 —— 所以触发词
只能写在 `description` 里，写两处就是把它的权重抬到不真实的层级。

全仓逐字出现这句话的只有三处，各有各的角色（`scripts/skills-surface-test.mjs` 里有一条静态断言：
**运行期源码 `src/*.ts` 里恰好出现 1 次**）：

| 位置 | 角色 |
|---|---|
| [`src/skills.ts`](../../src/skills.ts) 的 `START_SKILL_DESCRIPTION` | **定义**（唯一的事实源；注册进 `ctx.skills` 的就是它） |
| 本页 | 契约陈述（这份归类文档要说明「触发词是哪一句」） |
| [`scripts/skills-surface-test.mjs`](../../scripts/skills-surface-test.mjs) | 判据字面量（要断言「逐字相等」，测试里就必须有那一句） |

**都不是**模型目录、工具描述或系统提示词。

## 表 C：工作流快捷技能（动态，`ctx.skills.register`）

每个可启动的工作流一个，名字 = `ralphflow-` + 工作流名（`loop` → `ralphflow-loop`）。

| 技能 | `invocation` | 面 | 描述 |
|---|---|---|---|
| `ralphflow-<工作流>` | `{ userInvocable: true, modelInvocable: false }` | **只给人看**：人敲 `/ralphflow-loop <任务>` → 普通 `user/message` + 宿主注入正文；**不进模型目录** | 直接用该工作流 YAML 的 `description`（如 loop 的「单步对抗验证循环：实现与验证在同一环节内迭代，直到通过」）；没有时回落 `用 <工作流名> 工作流跑一个任务。` |

**为什么只给人看**：它们是同一个触发分支的敲字捷径。进模型目录只会让模型在 N 条同义描述里挑
（writing-for-agents：一段一个触发分支，同义重复就是一个分支写了两遍）。

**名字合语法**：技能名必须满足 `[a-z0-9]+(-[a-z0-9]+)*`（`dsh-skill/lib/index.js:17` 的 `SKILL_NAME`）。
工作流名直接拼进技能名，所以名字里有大写/下划线/空格时**注册不了快捷技能** —— 这时我们
**如实拒绝并说清原因**（`workflowSkillNameRejection`：写 warn 日志 + 往发起会话投一条可见播报，
说清语法、给出改法，并说明它仍可用 `/ralphflow-start <工作流> <任务>` 启动），**绝不静默跳过**。

## 为什么启动类必须是技能（缺陷本体）

新会话第一句敲 `/ralphflow-start …` 时会话**永远没有标题**（侧栏「未命名」）。两层根因：

1. dsh 的会话标题只认一种输入 —— `user/message` 且 `source.kind === "user"`
   （`dsh-session-title/lib/index.js:90` 的 `sessionTitleUserMessageOf`：
   `if (event.type !== "user/message" || event.data.source.kind !== "user") return void 0;`）。
   **兜底标题也要先有合格输入**，所以没有合格输入 = 连兜底名字都没有。
2. 斜杠**命令**落成 `command/run` + `command/done`（`dsh-commands/lib/index.js:327` 的 `execute`），
   永远不被上面那条式子看中。

技能走的是另一条路：`/name` 由 `dsh-tool-skill` 在 `agent/pre-step` 用
`SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`（`:1009`）从**普通用户消息**里扫出来
（`invokedSkillNames`，`:1017`，**只扫 `source.kind === "user"` 的消息**），再由宿主把技能正文注入为
`skill-invocation` 消息。于是「敲技能」= 一条普通用户消息（标题口径成立）+ 一次宿主注入
（不多花模型回合）。

**同名命令必须删掉**：只要同名命令还在，客户端就把它解析成命令（`dsh-client-ui-commands/lib/client.js:1631`
的 `matchEnter`：`desc === undefined` 时才 `return void 0` 落回普通消息），标题照旧没有。
`scripts/skills-surface-test.mjs` 的 T2 用**真** `CommandRuntime.execute` 钉住这件事：`/ralphflow-start …`
与 `/ralphflow-loop …` 必须解析不出命令（返回 `undefined`）。

## 可复核证据（每条判据对应哪支用例）

| 判据 | 证据 |
|---|---|
| 1 每一处快捷入口都归类过 | 本页表 A/B/C；`scripts/skills-surface-test.mjs` T2 断言命令面**恰好**是表 A 那 8 条 |
| 2 启动类不再是命令（含动态登记路径） | T2：真 `CommandRuntime` 解析 `/ralphflow-start …`、`/ralphflow-loop …` 均为 `undefined`；动态快捷命令的注册代码已删除（`src/tools.ts` 的 `registerWorkflowShortcuts` 不复存在） |
| 3 触发词只出现一次 | T1：真 `SkillRegistry.snapshot()` 里 model-invocable 的 ralphflow 条目**恰好 1 条**，且描述逐字等于触发词；目录行逐字等于 `` - `ralphflow-start`: <触发词> `` |
| 4 名字合语法 | T1：每个 `ralphflow-*` 技能名都过 `isSkillName`；T4：`Bad_Name` 不注册 + 投播报说清原因 |
| 5 两条路都有可复核证据 | **人敲**：T3 用**真** `SessionTitleService` 断言 `source.kind === "user"` 的普通消息真的产出兜底标题（负对照：`command/run` 永远没有）；**自然语言**：T1 断言模型目录里的渲染行 + 触发词；目录自带的路由指令在 `dsh-tool-skill/lib/index.js:886`（*"If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool …"*） |
| 6 其余快捷行为不变 | T2：8 条命令仍在（`/ralphflow-status` 解析成功）；`scripts/rewind-test.mjs`、`scripts/reset-surface-test.mjs` 全绿（机械执行不变） |
| 7 原有功能不退化 | `npm run build && npm run typecheck && npm run verify` 全绿 |

## 边界：这些保持命令，不要顺手改

| 快捷 | 为什么留命令 |
|---|---|
| `/ralphflow-reset`、`/ralphflow-rewind` | 机械执行，而且**没有对应工具**（设计如此：不给模型修复入口）。做成技能等于让模型发起重置/回退，而且技能里没有工具可调 |
| `/ralphflow-cancel`、`/ralphflow-continue` | 人的权限（中止实例 / 放行审查门）。命令由处理器机械执行、即时生效；技能要绕一个模型回合，还可能被模型忽略 |
| `/ralphflow-status`、`/ralphflow-list`、`/ralphflow-doctor` | 纯读操作，命令零 token 即时回 |
| `/ralphflow-create` | 同类（也是「把指令交给模型」），但它不是「启动一条运行」，也不涉及新会话第一句；这次不动，避免扩大验证面 |

另外：判定 / 推进 / 重置 / 计票语义一字不改；**不给模型任何新的可调用入口**（工具面仍是 8 个：
`ralphflow_start` / `submit` / `continue` / `status` / `list` / `cancel` / `create` / `doctor`）。
