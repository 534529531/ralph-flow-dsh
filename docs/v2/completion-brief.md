# ralphflow v0 功能补全任务书

> 任务：把**已有功能里没做完善的部分**补齐。**不含**任何有意推迟的设计（见 §2）。
> 验收依据就是本文件。每一轮完成后追加 `summary.md`（完成项 / 变更文件 / 证据 / 未完成）。
> 配套阅读：`docs/v2/design.md`（宪法与设计）、`docs/v2/hardening-brief.md` §5（已知陷阱表，仍然有效）。

---

## 1. 为什么做这一轮

上一轮（`loop-mudrr90d-xd5d`）修的是**恶性 bug**（判定不可信、流程卡死）。这一轮修的是**「静默」**——用户写了一份看起来合法的 YAML，引擎不报错、doctor 报 ✅、却按**非用户本意**的方式运行。这类问题不炸、不报错，只是悄悄做错事，比崩溃更难发现。

判定标准：**任何"用户写错了但没有任何信号"的路径，都是本轮的补全对象。**

---

## 2. 范围（硬性边界）

**做**：加载期校验补全、doctor 覆盖补全、验证者/DO 提示词补全、文档与实现对齐、索引卫生、报告完整性。

**不做（有意推迟，违反即判不通过）**：
- `check_voting` 多验证者投票（design §11 → v0.2，需"最小版失败"证据）
- `reset` / `rewind` / 重置门 / `auto_reset` / `isNewOpen`（design §11 → v0.5+）
- 子工作流（`workflow:` / `inputs` / 嵌套）
- 客户端 UI / 通知 / 沙箱 / HTTP 通道
- **不要新增** slash 命令或模型可见工具（命令面固定，`ralphflow_submit` 已由作者定案）
- **不要**为环境异常（重启、源码漂移）加代码（design §7 作者定案）
- **不要**自建超时 / 看门狗 / 竞速（design §8 作者定案）

**待作者定案，本轮先不做**：§6 的三项（产出目录、执行日志、`input` 语义）。**不要**擅自实现。

---

## 3. 补全条目

每条格式：**现象 → 证据 → 期望 → 验收**。
所有"证据"都是作者在本仓库实测得到的，可复现。

### 3.0 必填集合与缺省语义（P1–P6 的总纲，先定死再动手）

避免实现者把"校验"做成"全部必填"而误伤现有工作流。**本版本最终语义如下**：

| 字段 | 缺失时 | 存在但非法时 |
|---|---|---|
| `id` | **fail-fast**（已有） | 重复 → fail-fast（已有） |
| `do` | **fail-fast**（P6 新增） | 非字符串 → fail-fast |
| `check` | 允许；用通用兜底 + doctor ⚠️（P2） | 非字符串 → **fail-fast**（P1） |
| `max_fail_count` | 允许；默认 `3`（**保持现状**） | 非 ≥1 整数 → **fail-fast**（P5） |
| `on_pass` | 允许；默认"下一个步骤，末步则 `done`"（**保持现状**，但 guide 要写明） | 引用不存在的步骤 → fail-fast（已有） |
| `on_fail` | 允许；默认"自身"（**保持现状**，但 guide 要写明） | 引用不存在 / `done` → fail-fast（已有） |
| `desc` / `input` / `output` | 允许（可选） | — |
| 未知键 | ⚠️ 警告忽略（宪法 §10.12，**不变**） | — |

> 即：**只对"没有它工作流就没有意义"（`do`）和"写了但明显写错"（`check` 非串 / `max_fail_count` 非正 / `manual_step` 未知 id）做 fail-fast**；有合理默认的一律保持默认。`input`/`output` 不参与校验。

### P1 `check` 存在但非字符串 → 静默降级

- **现象**：`check: true`（明显的配置笔误）被静默接受，验证者拿到通用兜底标准。
- **证据**：实测 `check: true` → `invalid=false`，`problems=[]`，`warnings=[]`（完全静默）。
  根因 `src/engine.ts:306`：`check: typeof s.check === "string" ? s.check : undefined` —— 非字符串被吞成 `undefined`，随后 `src/verify.ts:88` 用通用兜底。
- **期望**：`check` **存在但不是字符串** → 加载期 **fail-fast**，人话报错（例：``步骤 `a` 的 `check` 必须是字符串；若想跳过验证请删除该键``）。参照 opencode：非字符串 check 是硬错误（"那不是我要跳过，而是配置写错了"）。
- **验收**：`check: true` / `check: 123` / `check: []` 三种输入都加载失败且报错文案点明是 `check` 类型问题。

### P2 `check` 完全缺失 → 无告警且文档不实

- **现象**：步骤不写 `check` 时，验证者按通用标准（"每一条要求是否落实 / 是否真实可用 / 有无遗漏"）判定，但**用户不知道**，doctor 也报 ✅。
- **证据**：实测无 `check` 步骤 → 验证端口收到 `step.check === undefined`，仍创建验证会话；`doctor` 报 ✅。
  且 `src/create.ts:44` 自称「`check`：**必填**」，与实现矛盾。
- **期望（推荐方案，**需作者确认**）**：
  - **保留通用兜底**，不实现 opencode 的"跳过验证"——理由：design §12.1 的验收第 1 条明列「**跳过验证推进**…全部被拒」，实现"无 check 即跳过验证直接推进"会**直接违反我们自己的验收判据**。但兜底必须**显式化**：
    1. `doctor` 对**不在 `manual_step` 里**且无 `check` 的步骤给 ⚠️ 告警（"该步骤没有检查依据，验证者将按通用标准判定；确认是有意为之可忽略"）；
    2. `src/create.ts` 的方言说明改为如实描述（`check` 可选 + 缺省行为）。
- **验收**：无 check 步骤在 `ralphflow_doctor` 输出里有 ⚠️；`CREATE_GUIDE` 不再声称 `check` 必填。

### P3 `manual_step` 未知 id → 静默忽略

- **现象**：`manual_step: [nosuchstep]`（打错字）被静默接受，**审查门永不触发**。
- **证据**：实测 `manual_step: [nosuchstep]` → `invalid=false`，`problems=[]`，`warnings=[]`。
  `src/engine.ts:328-334` 只做 `Array.isArray` 判断，**从不校验 id 是否存在于 steps**。
  而 `src/create.ts:51` 自称「**硬规则**：… manual_step 必须引用存在的步骤 id」——**虚假声明**。
- **期望**：`manual_step` 里的每个 id 必须命中真实步骤 id，否则加载期 **fail-fast**（参照 opencode：硬错误，"打错字绝不能静默跳过你指望的审查门"）。
- **验收**：`manual_step: [nosuchstep]` 加载失败，报错列出无效 id 与全部合法 id。

### P4 `manual_step` 逗号字符串 → 静默忽略

- **现象**：`manual_step: design, review`（opencode 支持的写法）被整条忽略，**审查门不布防**，用户以为设了门。
- **证据**：实测 `manual_step: b, c` → `warnings: ["顶层 manual_step 不是列表，已忽略。"]`（仅警告，仍加载；用户极易忽略）。
- **期望**：支持逗号分隔字符串（与 opencode 同款：列表或逗号字符串两种写法都行）；解析后走 P3 的 id 校验。
- **验收**：`manual_step: a, b` 与 `manual_step: [a, b]` 行为完全一致（审查门正常布防）。

### P5 `max_fail_count` 非正整数 → 静默接受

- **现象**：`max_fail_count: 0` 或 `-1` 被接受，运行语义荒谬（首次失败即暂停）。
- **证据**：实测 `max_fail_count: 0` / `-1` → 均 `invalid=false`，零告警。
  根因 `src/engine.ts:626`：`const max = step.max_fail_count ?? 3;` 只做 nullish 兜底，不校验范围。
- **期望**：必须是 **≥1 的整数**（`0`/负数/小数/非数字 → fail-fast）。参照 opencode：`max_fail_count` 必填且"数字 ≥ 1"。
- **验收**：`0` / `-1` / `1.5` / `"3"` 全部加载失败；`1` / `3` / `100` 正常。

### P6 缺 `do` 的步骤 → 静默接受

- **现象**：步骤没有 `do` 时被接受，DO 提示词退化成 `step.desc || step.id`——模型拿到的"任务"只是一个 id。
- **证据**：实测缺 `do` → `invalid=false`，零告警。
  根因 `src/engine.ts` doPrompt：`(step.do || step.desc || step.id).trim()`。
  且 `src/create.ts:42` 自称 `do` **必填**。
- **期望**：`do` 缺失 → 加载期 **fail-fast**（没有 `do` 就没有任务，工作流无法执行）。
  **与 opencode 的差异（有意）**：opencode 对缺必填字段的步骤是**静默丢弃该步** + 由 doctor 报告。我们不采用"丢弃"——那正是本任务书要消灭的静默行为；按 design §8「语法错误 → fail-fast 带人话报错」处理。
- **验收**：缺 `do` 的步骤加载失败，报错点明步骤 id。

### P7 未知模板变量 `{{...}}` → 静默透传

- **现象**：`do: 写到 {{artifacts_dir}}/x.md` 里的记号原样进入提示词，模型看到一个没有定义含义的占位符。
- **证据**：实测含 `{{artifacts_dir}}` 的步骤 → 零告警，原样透传。
- **期望**：`doctor` **标记**任何 `{{...}}` 记号（至少 ⚠️ 告警，说明本版本不解析模板变量）。参照 opencode：doctor 会标记出来。
- **验收**：含 `{{anything}}` 的工作流在 `ralphflow_doctor` 输出里有 ⚠️ 且指明步骤与记号原文。

### P8 验证者 prompt 缺 `output` / `desc` → 验证者不知道本步该交付什么

- **现象**：DO 提示词含「## 交付物」（`step.output`），但**验证者 prompt 没有**——验证者不知道本步承诺交付什么，只能从 `check` 反推。
- **证据**：`src/verify.ts:82-102` `buildCheckPrompt` 只注入 任务 / 检查依据 / 交卷摘要 / 取证要求；`output` 与 `desc` 均缺失。
  对照 `src/engine.ts:537`（DO prompt）：`if (step.output) parts.push("", "## 交付物", ...)`。
- **期望**：验证者 prompt 补上 `desc`（本步是什么）与 `output`（本步承诺交付什么），与 DO 提示词对称。这是 T1 取证质量的一部分：裁判需要知道"承诺"，才能核对"兑现"。
- **验收**：`submit-flow-test.mjs` 或新测试断言验证者 prompt 含 `output` 文本（可用桩 `verify` 捕获 prompt 或直接单测 `buildCheckPrompt`）。

### P9 `doctor` 无可达性 lint → 永不完成的工作流报 ✅

- **现象**：`on_pass` 指回自身（没有任何可达步骤能到 `done`）的工作流，`doctor` 报 ✅，运行时**无限循环烧 token**；孤儿步骤（沿 `on_pass`/`on_fail` 到不了）永不执行也不报。
- **证据**：实测 `on_pass: a`（自指）→ 判定 passed 后 `step=a, active=true, paused=false`，轨迹 `do_submitted → verify_start → verdict_passed → step_start` 无限循环；`doctor` 输出 `- ✅ **never**: 永不完成`。
  对照 opencode `engine.js:1095-1101` 有两条 lint。
- **期望**：加载期补两条检查，进 `doctor` 与 `loadWorkflow` 的 warnings：
  1. 从入口（`steps[0]`）沿 `on_pass`/`on_fail` 不可达的步骤 → ⚠️（列出 id）；
  2. **没有任何可达步骤的 `on_pass` 为 `done`** → ❌ 或醒目 ⚠️（"工作流永远无法正常完成"）。
- **验收**：自指 `on_pass` 的工作流在 doctor 输出里有明确警告；孤儿步骤工作流有 ⚠️ 且列出孤儿 id；`loop`/`spec` 不产生误报。

### P10 `input` 字段被解析但从不使用（死字段）

- **现象**：`input` 被 `KNOWN_STEP_KEYS` 接受并存入 `StepDef`，但**引擎从不使用**它。
- **证据**：全仓库只有 `src/engine.ts:537` 用了 `step.output`；`step.input` 零消费点。
  且 `src/create.ts:53` 自称「本版本未支持（见到会警告并忽略）：… `input`/`output`（v0 不校验）」——**两处都不准**：`input` 不告警且无用；`output` 实际生效。
- **期望（需作者一句话定案，二选一）**：
  - (a) 把 `input` 注入 DO 提示词（与「## 交付物」对称，如「## 本步输入」）；
  - (b) 维持不使用，但在 `CREATE_GUIDE` 如实声明"`input` 当前不参与提示词"。
  **默认按 (a) 实现**（成本极低，且与 opencode 的字段语义一致）；若作者另行定案则从之。
- **验收**：按选定方案，`input` 要么出现在 DO prompt，要么在 guide 里被如实标注为不生效；不存在"解析了却无人知晓其无效"的状态。

### P11 `CREATE_GUIDE` 与实际实现不符（4 处）

- **现象**：`src/create.ts` 是模型引导用户写 YAML 的唯一依据，但有多处与实现矛盾。
- **证据**（逐条实测）：
  1. `:44` 称 `check` **必填** —— 实际可缺（见 P2）；
  2. `:51` 称 `manual_step` 必须引用存在的步骤 id（"硬规则"）—— 实际零校验（见 P3）；
  3. `:53` 称 `input`/`output` 未支持会警告忽略 —— 实际 `input` 静默无用、`output` 生效（见 P10）；
  4. `:23` 快捷命令写作 `/<名字>` —— 实际已是 **`/ralphflow-<名字>`**（命名对齐 claude 版后此处漏改）。
- **期望**：四处全部改正，且**改动后**的 guide 与引擎实际行为逐条一致。
- **验收**：按 guide 写的 YAML 与引擎实际接受/拒绝的集合一致（P1–P6 的 fail-fast 生效后，guide 必须同步反映）。

### P12 索引无 GC → 悬挂条目无限增长

- **现象**：`~/.dsh/ralphflow-instances-index.json` 只增不减；实例目录被删后条目永久残留。
- **证据**：实测 8 条中 **5 条悬挂**（`state.json` 已不存在），且包含作者自己调试产生的临时工作区条目。`listInstances()` 会过滤，功能无害，但文件无界增长，且污染 `activeInstanceOfSession` 的判定面（作者实测中曾因此让新实例启动被误拒）。
- **期望**：`restore()`（插件加载时）顺带 prune 掉 `state.json` 已不存在的条目；失败静默不阻塞加载。
- **验收**：删除某实例目录后重跑 `restore()`，索引里该条目消失，其余条目不变。

### P13 报告缺每步耗时 / 重试次数（低优先）

- **现象**：归档报告只有轨迹与判定，缺"每步耗时、重试次数"。
- **证据**：`archiveReport` 输出 = 头部 + `## 轨迹`（history）+ `## 判定`（verdicts）。对照 opencode 报告含"每步骤阶段、通过/失败、重试次数、失败原因、耗时"。
- **期望**：报告补一张**按步骤**的汇总表（步骤 id / 通过与否 / 重试次数 / 耗时 / 失败原因），数据可从 `history` 的 `ts` 与 `fail_counts` 派生（**不新增落盘字段**，遵守宪法"状态不存派生量"）。
- **验收**：跑一个含 1 次失败重试的实例，报告里该步重试次数为 1、耗时为合理正数。

---

## 4. 分组与建议顺序

| 组 | 条目 | 性质 |
|---|---|---|
| **A 加载期校验**（一组强相关，建议一轮做完） | P1 P2 P3 P4 P5 P6 | 引擎 `loadWorkflow` + 方言严格性 |
| **B 提示词** | P8 P10 | `verify.ts` / `engine.ts` 提示词构造 |
| **C 诊断** | P9 P7 | `doctor` / warnings |
| **D 文档对齐** | P11 | 必须**在 A 组之后**做（否则又对不上） |
| **E 卫生** | P12 P13 | 索引 GC、报告 |

**顺序要求**：A → B → C → D → E。D 依赖 A（guide 要反映新的 fail-fast 集合）。
每轮只做一组（或一条），最小 diff。

---

## 5. 工作协议

1. **先审计，后动手**：第一轮不改代码，产出审计清单写入 `summary.md`：每条 = 条目号 · 位置（`文件:行`）· **自己的复现证据** · 建议改法。没有复现证据的条目不许进清单。
2. **一次一组**：见 §4。改完立即跑测试。
3. **复现必须隔离**：所有复现脚本用 `mkdtemp` 建临时工作区，并 `HOME=<临时目录>` 隔离全局索引（否则会被真实索引里的活跃实例干扰——作者实测踩过：`start()` 因"已有活跃实例"直接失败）。**绝不删除真实工作区**（上一轮有过血案，见 hardening-brief §5）。
4. **测试是底线**：现有 8 个脚本全绿 + `APPLY_OK` + `tsc --noEmit` 干净。每条修复配新断言。
5. **不得违反宪法 §10**；尤其：引擎是唯一写入者、状态不存派生量、判定 fail-closed、绝不写自定义会话事件帧。
6. **批量交付、再重启**：改动需 `npm run build` + 作者重启 GUI 才生效。**不要在验证进行中重启或改源码**（会让在飞验证被 `run_superseded` 丢弃，且验证者会在变动中的树里取证写错判定——见 design §7）。

---

## 6. 待作者定案（本轮不做）

以下三项**不属"补全"而属"新增"**，须作者先定案，**不要擅自实现**：

1. **产出目录（artifacts）** —— 现象真实且已造成实际混乱：`workflows/loop.yaml` 的 `do` 要求"把执行摘要追加到 `summary.md`"，但**没有定义落点**，实测落在**仓库根**（`summary.md` 已长到 67KB）；`workflows/spec.yaml` 的 `proposal.md`/`specs.md`/`design.md` 同理（历史 E2E 证据显示落在仓库根）。最小方案是"每实例固定产出目录 + 在 DO/CHECK 提示词注入一行「产出目录」"，但这是新子系统，需作者定案。
2. **执行日志（JSONL）** —— opencode 有 `logs/execution.log`（JSONL，10MB 轮转）+ `step-records.json`。design 未承诺，故不算补全。
3. **`check` 缺失时的语义** —— P2 推荐"保留通用兜底 + 显式告警"，**不采用** opencode 的"跳过验证"（与 design §12.1 冲突）。**此条需作者确认**；若作者改判为"跳过验证"，则须同时修订 design §12.1 的验收判据，否则自相矛盾。

---

## 7. 验收标准（全部满足才算通过）

1. P1–P13（除已定案豁免项）全部完成，每条有**独立复现证据 + 修复后验证**。
2. **静默性检查通过**：§3 列出的每个"完全静默"输入，修复后都有明确信号（fail-fast 报错 或 doctor ⚠️），**不存在第三种"没反应"**。
3. **无误伤**：`loop`/`spec` 两个内置工作流、以及仓库里所有历史测试夹具仍能正常加载（P9 的可达性 lint 尤其容易误报，必须验）。
4. 现有 8 个测试脚本全绿 + `APPLY_OK` + `tsc --noEmit` 干净；每条修复配新断言。
5. `CREATE_GUIDE` 与引擎实际行为**逐条一致**（P11 的验收方式：按 guide 写的东西，引擎都接受；guide 没提的东西，引擎都拒绝或告警）。
6. 边界未破：命令面/工具面不变、无 reset/rewind 实现、无 check_voting 实现、无自建超时、无客户端代码。
7. `summary.md` 追加本轮记录：完成项、变更文件、证据、未完成与下一步。

---

## 8. 交付物

| 交付物 | 要求 |
|---|---|
| 源码改动 | `src/engine.ts`、`src/verify.ts`、`src/create.ts`（按需），最小 diff |
| 测试 | 每条修复配断言；建议新增 `scripts/dialect-test.mjs`（P1–P7 的加载期矩阵）+ `scripts/lint-test.mjs`（P9） |
| `summary.md` | 审计清单 + 每轮完成记录 + 证据 |
| 证据 | 复现脚本（`mkdtemp` + `HOME` 隔离）、修复前后输出、`doctor` 输出对比 |
