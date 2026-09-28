# 无 check 步骤的语义对齐任务书

> **读者**：`ralph-flow-dsh` 的实现者。读完后应能仅在本仓库完成改造，并用下列验收项判断是否交付。
>
> **状态**：待实现。
>
> **前置定案（作者）**：与 opencode 对齐——**没有 `check` 的步骤跳过对抗性验证**。理由：有的步骤很简单，不值得再花一次独立验证的时间与 token。

## 目标

让「本步是否需要独立验证」完全由 `check` 的有无决定，与 `manual_step` 正交：

| `check` | `manual_step` | 目标行为 |
|---|---|---|
| 有 | 否 | 独立验证 → 通过则 `on_pass` 推进；失败则 `on_fail` 返工（**现状不变**）|
| 有 | 是 | 独立验证 → **通过后停在审查门**等你放行（**现状不变**）|
| **无** | 否 | **跳过验证** → DO 完成直接 `on_pass` |
| **无** | 是 | **跳过验证** → DO 完成直接停在审查门（纯人工审查）|

**本任务只改后两行。** 前两行是回归基线，必须逐字不动。

## 关键约束：跳过必须诚实标注

跳过**不是**"检查通过"。任何用户可见的输出（通知、历史轨迹、报告、审查门提示）都不得出现「检查通过」这类字样，必须写「**跳过对抗性验证**」（照 opencode 的措辞：`## 步骤已通过（跳过对抗性验证）`）。

这是本任务书最重要的一条：**省 token 不能以伪造事实为代价。**

## 实现边界

### 1. 判据来自工作流定义，不新增状态字段

某步有没有 `check` 是**工作流定义的属性**，不是运行事实。因此新增纯函数谓词（命名如 `stepHasCheck(step)`），直接从 `StepDef` 计算：

```
stepHasCheck(step) = typeof step.check === "string" && step.check.trim() !== ""
```

（`check_voting` 本版本未支持，按 warn+ignore 处理，不参与此判据。）

**不要**往 `InstanceState` 加 `skipped_steps[]` 之类字段——那是派生量，违反宪法 §10.4。

### 2. 交卷路径（`onSubmit`）

交卷受理后：

- `stepHasCheck(step)` 为真 → 现状不变：`void launchVerification(...)`。
- 为假 → **不委派验证**：
  - 记 `pushHistory(state, "check_skipped", ...)`（含步骤 id 与「该步未配置 check」）；
  - 记 `log("info", "check_skipped", ...)`；
  - `manual_step`（`isGate(wf, step)`）→ **停在审查门**，通知用户「本步未配置对抗性检查，已跳过验证，请你审查后 `/ralphflow-continue` 放行」；
  - 否则 → **直接推进**（`advance`），通知里写明「跳过对抗性验证」。

**两个分支都不写 `verdicts[]`**——没有验证者就没有判定。`do_submitted` 的置位与 `last_submit_summary` 的写入保持现状（审查门重交去重仍需要）。

### 3. 推进与门的判据

- `atOpenGate(wf, state, step)` 现为 `isGate && allPassedVerified`，改为：
  `isGate(wf, step) && (!stepHasCheck(step) || allPassedVerified(state, step))`
- `continueInstance` 的放行判据同步（它现在要求 `allPassedVerified` 才推进）。
- 其余推进规则（`failed` 返工、`infra` 暂停）**不变**：无 check 的步骤不产生判定，自然不会走到那两条。

### 4. DO 提示词要说明本步不验证

无 check 的步骤，其 DO 提示词（`doPrompt`）末尾追加一句，照 opencode 的措辞（`opencode/src/engine.ts:1565`）：

> ℹ️ 本步骤**不配置对抗性检查**：完成即可，不会有独立的验证进程来复核。请务必自查产出是否满足任务要求（manual_step 步骤则由你审查后运行 `/ralphflow-continue` 放行）。

### 5. `doctor` lint 改文案，并区分 manual

现状（`engine.ts:342`）对**所有**无 check 的步骤都告警，文案是「…只会按通用兜底配方验证…」——**兜底配方已取消，该文案作废**。

改为照 opencode（`opencode/src/engine.ts:1287-1288`）：

- **非 `manual_step`** 且无 check → 告警：`步骤 "<id>" 未配置对抗性检查（无 check），DO 完成后直接进入下一步，不会被独立验证`
- **是 `manual_step`** 且无 check → **不告警**（人工审查是刻意的默认，不是问题）

### 6. 保留的硬错误

- `check` 写了非字符串（如 `check: true`）→ **加载期硬错误**，文案说明「非字符串会被视为未配置检查并跳过验证；若你本意是跳过请直接删掉该字段」（照 opencode `opencode/src/engine.ts:957-960`）。
- 写了 `check_model` 却没有可用 `check` → 硬错误（现状，与 opencode 一致）。
- 其余加载期校验不动。

### 7. 兜底配方退役

`buildCheckPrompt` 里那句「（本步未声明检查依据，请按任务的每一条要求严格核对…）」（`verify.ts:152`）在无 check 步骤不再被验证后**不可达**。改为：`buildCheckPrompt` 只在有 check 时被调用；若被传入无 check 的步骤，**明确抛错或记 infra**（不得静默用兜底配方——那等于把已删除的行为留成暗门）。

### 8. 文档与测试同步

- `docs/v2/design.md`：
  - **§12.1 验收条目已精修完毕**（作者批准，措辞与理由见下方 §9）——实现者只需核对代码与之一致，**不需要**再改验收条目。
  - §6 审查门：补「无 `check` 时是**纯人工**审查，不叠加机器验证」。
  - §9 方言表：`check` 的可选语义（缺 = 免验证）。
- **`docs/v2/completion-brief.md:67`**：那张「不能照搬 opencode 的地方」表里，「**无 `check` 的步骤** → 不可照搬：design §12.1 要求「跳过验证推进必须被拒」→ 保留通用兜底 + doctor 告警」这一行**已作废**。改为：与 opencode 对齐（跳过验证直接推进），并把该行原有的顾虑指向 §12.1 的精修说明。
- `src/create.ts` 创建指引：`check` 的说明从「缺 check → doctor 告警（DO 后仍会按通用兜底配方验证，不会被跳过）」改为「**缺 check = 该步不做独立验证**，DO 完成直接进入下一步；manual_step 步骤则由你审查放行」。
- `README.md`：如有「每步都经独立验证」这类表述，同步修正。
- `workflows/*.yaml`：**内置四步全有 check，无需改动**；`spec.yaml` 里 `manual_step: [propose]` 的注释「propose 通过独立验证后停下等你放行」**正确，不动**。
- 测试（已核实无运行期用例钉住旧行为，改动面比预想小）：
  - `engine-test.mjs:415-416`：lint 断言。旧文案含「对抗检查」，新文案含「对抗性检查」且**新增 manual 不告警**的分支 → 该用例需按新文案改写，并**新增**一条「manual 且无 check → 不告警」的断言。
  - `engine-test.mjs:314/516`：`check_model` 无 `check` → 硬错误。**该行为保留，用例不动**。
  - 新增运行期断言：无 check 步骤交卷后**验证端口零调用**、不写 `verdicts[]`、直接推进/停门（见验收 2–4）。

### 9. 与 design §12.1 的关系（**唯一触及中心定理的地方**）

> **状态：精修已获作者批准，并已写入 `design.md` §12.1 与 `completion-brief.md:67`。** 实现者只需让代码与之一致，不需要再改验收条目。

`design.md:192`（§12.1 验收）原文要求裁判权测试组拒绝这五个攻击向量，其中第二个是「**跳过验证推进**」。

而 `completion-brief.md:67` 当年正是据此判定「无 check 跳过验证」**不可照搬**，才有了通用兜底配方。**所以本任务与 §12.1 的字面要求冲突，必须精修，不能假装不存在。**

**精修（已获作者批准，已写入 `design.md` §12.1）：**

> §12.1 第二条「跳过验证推进」精确化为「**执行者不能自行跳过验证推进**」——即：**在没有判定、且工作流定义未声明本步免验证时，推进必须被拒**。

判据由此变成机械可判的两支：

```
可推进 ⇔ stepHasCheck(step) ? (判定齐 ∧ 全 passed ∧ 归属本步) : 定义已声明本步免验证
```

**为什么这不削弱 T2（推进权在机械程序）**：

- 决策输入是**工作流定义**（作者所有），**不是执行者**。执行者在运行期无法影响它——`stepHasCheck` 只读 `StepDef`，与 state、与模型输出无关。
- 因此这不是 fail-open，而是「**作者已声明本步免验证**」的机械推进。
- 与既有机制同类：审查门的放行也是"无机器判定即推进"（由人决定），本就存在第二类推进依据。本任务只是把"作者声明"这类依据显式化，并让判据可机械判定。

**必须保留的攻击向量**（精修后仍全部被拒）：伪造判定、**无判定且定义未声明免验证时的推进**、过旧判定复用、主会话试图委派。`verdict-integrity-test` 的相关断言不得因本任务而放宽。

## 验收标准

1. **回归**：有 check 的步骤（普通步与 `manual_step`）行为**逐字不变**——仍委派验证、仍按判定推进/返工/暂停、`manual_step` 仍"通过后停门"。
2. **跳过**：无 check 的步骤交卷后**验证端口一次都不被调用**（用假 ctx 计数器断言，不能只看返回值），且不写 `verdicts[]`。
3. 无 check + 非 manual → 交卷后**直接推进**到 `on_pass` 目标；历史里有 `check_skipped`。
4. 无 check + manual → 交卷后**停在审查门**；`/ralphflow-continue` 能放行推进。
5. **诚实标注**：上述两种情况下，通知文本、历史轨迹、归档报告里**都不出现**「检查通过」；必须出现「跳过对抗性验证」或等义表述。
6. **零新状态字段**：`InstanceState` 的字段集合与改造前**完全相同**（可用逐字段对比断言）。
7. DO 提示词：无 check 的步骤含「不配置对抗性检查」说明；有 check 的步骤**不含**该说明。
8. `doctor`：非 manual 无 check → 告警「不会被独立验证」；manual 无 check → **不告警**。
9. 硬错误保留：`check: true` 仍加载期硬错误。
10. 兜底配方不可达：向 `buildCheckPrompt` 传无 check 的步骤时明确失败，**不静默**产出兜底配方。
11. **内置工作流零变化**：`loop` 与 `spec` 加载后的步骤行为、告警集合与改造前一致（四步全有 check）。
12. **§12.1 精修后仍 fail-closed**：在没有判定、且**工作流定义未声明本步免验证**时，任何推进尝试仍被拒绝；`verdict-integrity-test` 原有的拒推进断言（伪造判定 / 无判定 / 过旧判定 / 主会话委派）**一条都不放宽**。另加一条正向断言：定义声明免验证时，推进**不需要**判定即可发生（且不产生 `verdicts[]` 条目）。
13. `npm run typecheck`、`npm run build`，以及 `scripts/` 下**全部** `*.mjs` 脚本通过，无失败、无回归。

**测试纪律**（既有陷阱表）：复现脚本一律 `mkdtempSync` 造工作区 + 隔离 `process.env.HOME`；**绝不** `rmSync` 真实工作区或真实 `.dsh/` 路径。

## 交付物

- 本仓库的实现、必要测试及同步后的文档。
- 一份简短变更说明：列出四格真值表的前后对比、跳过路径的诚实标注落点、lint 文案变化、被推翻的旧定案（§12.1），以及验收命令的实际结果。

## 附：opencode 版依据（供实现者省去重新取证）

| 事实 | 位置 |
|---|---|
| `skipCheck` 的完整表达式（`no_check` **或** 无有效 check 且非 voting） | `driver.ts:353-354` |
| 解析器**只在没有 check 时**才标 `no_check`；注释原话「除非步骤显式写了 check，那样 parse 不会标 no_check」 | `engine.ts:951-961` |
| 跳过分支：`{ passed: true, skipped: true, reason }`，「直接视为通过并放行」 | `driver.ts:356-370` |
| 门的布防条件含 `checkResult.passed`，故**跳过的 manual 步照样停门** → 纯人工审查 | `driver.ts:479` |
| 诚实显示「步骤已通过（跳过对抗性验证）」 | `engine.ts:1997-2001` |
| lint **只对非 manual 的无 check 步骤告警**，文案「…不会被独立验证」 | `engine.ts:1283-1289` |
| DO 提示词对无 check 步骤追加「不配置对抗性检查」说明 | `engine.ts:1565` |
| `check` 非字符串是硬错误（避免把"想要 check"误读成"不想 check"） | `engine.ts:955-960` |
| 写了 `check_model` 却无可用 `check` → 硬错误 | `engine.ts:946-950` |

## 附：dsh 改造前的现状（逐行核实）

| 事实 | 位置 |
|---|---|
| `onSubmit` 两个分支都**无条件** `void launchVerification(...)`，从不读该步有无 check | `engine.ts:1413`、`engine.ts:1419` |
| `allPassed` 要求 `verdicts.length > 0 && every(passed)` | `engine.ts:866-868` |
| `atOpenGate` = `isGate && allPassedVerified` → 门需要「判定存在」 | `engine.ts:885-887` |
| 通用兜底配方（本任务后应不可达） | `verify.ts:152` |
| 旧 lint 文案（本任务作废） | `engine.ts:342` |
