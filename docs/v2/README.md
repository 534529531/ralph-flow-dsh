# 设计档案（docs/v2）

> **这里不是读者文档。** 本目录是 v2 开发过程留下的**任务书（brief）、调研与验收证据**，面向实现者，保留原始措辞与验收判据。想了解产品功能请看 [主页 README](../../README.md) 与 [文档主页](../README.md)；想看权威设计请看[设计定稿与宪法](design.md)。

## 权威设计

| 文档 | 说明 |
|------|------|
| [design.md](design.md) | **设计定稿与宪法**：中心定理、状态模型、验证者协议、命令面、十二条不可违反的宪法、版本路线图。这是本仓库设计的单一权威来源。 |

## 任务书（brief）

任务书是**目标书**，不是实现说明书——写死实现方案会收窄验证空间（见 [brief-style.md](brief-style.md)）。它们记录"当时要达成什么、怎么算做成了"，实现完成后保留原样，**不随代码回改**。

| 文档 | 主题 | 状态 |
|------|------|------|
| [completion-brief.md](completion-brief.md) | v0 功能补全：产出目录、运行时目录改 dot-dir | 已实现 |
| [no-check-semantics-brief.md](no-check-semantics-brief.md) | 无 `check` 步骤的语义对齐（与 opencode 一致） | 已实现 |
| [verifier-config-simplification-brief.md](verifier-config-simplification-brief.md) | 验证者配置精简（`adversarial_check` 只留 `model`） | 已实现 |
| [instance-lifecycle-brief.md](instance-lifecycle-brief.md) | 实例生命周期：归档、销毁序列、产出保留 | 已实现（验收 5 的"历史节"判据已被 `/ralphflow-list` 改版取代，文件内已加注记） |
| [execution-log-brief.md](execution-log-brief.md) | 执行日志（JSONL、归档、轮转） | 已实现 |
| [spec-4step-brief.md](spec-4step-brief.md) | 内置 `spec` 从 7 步换成 4 步（三端一致） | 已实现 |
| [hardening-brief.md](hardening-brief.md) | 插件加固（审计 dsh 原生能力用法与恶性 bug） | 已执行 |
| [notice-wake-brief.md](notice-wake-brief.md) | 「播报唤醒会话」缺陷修复：播报不再叫醒驱动器（指令仍走 `steer`） | 已实现（验收 7 的真实运行复核已在 RA2 实例上现场走通） |
| [shortcut-skills-brief.md](shortcut-skills-brief.md) | 启动类快捷从命令改成技能（修掉新会话未命名 + 技能描述成为自然语言触发词） | 已实现 |
| [workspace-anchoring-brief.md](workspace-anchoring-brief.md) | 发现面锚定修复 | ⛔ **已作废**——思路被"引擎按工作区实例化"取代 |
| [ui-notice-brief.md](ui-notice-brief.md) | 播报对人类可见（客户端半边）：通过 / 失败 / 暂停 / 审查门 / 完成在 Chat 时间线上看得见，且不唤醒驱动器 | 📋 **待实现** |
| [workflow-status-ui-refine-brief.md](workflow-status-ui-refine-brief.md) | 工作流状态界面精修：一处常驻、只在该出现时出现、与 dsh 同源（上一版把 UI 组成写死，导致同一件事说三遍） | 📋 **待实现** |
| [brief-style.md](brief-style.md) | 任务书写作规范（给作者） | 规范 |

## 调研与预研

| 文档 | 说明 |
|------|------|
| [reset-feasibility.md](reset-feasibility.md) | reset 在 dsh 上的载体：全范围替换会话可见面（五路源码取证 + 五条硬约束） |
| [subworkflow-nesting-research.md](subworkflow-nesting-research.md) | 子工作流 / 可复用子流程的业界六系统横向调研 |
| [sync-verification-research.md](sync-verification-research.md) | 验证同步化调研（dsh / opencode / claude 三端各能做到什么） |
| [ui-notice-research.md](ui-notice-research.md) | 播报可见性调研：Chat 时间线的可见性规则、为什么 dsh 没有 `noReply`、可行与已否决的载体（逐条 文件:行 证据） |

## 验收证据

| 文档 | 说明 |
|------|------|
| [evidence/summary-completion.md](evidence/summary-completion.md) | v0 功能补全的完成记录与证据 |
| [evidence/summary-hardening.md](evidence/summary-hardening.md) | 加固轮的执行摘要（审计出的恶性 bug 与不成立项） |
| [evidence/e2e-20260923-submit-native.md](evidence/e2e-20260923-submit-native.md) | 真实宿主 E2E：DO 交卷改原生工具调用 |
| [evidence/e2e-20260923-loop-passed.md](evidence/e2e-20260923-loop-passed.md) | 真实宿主 E2E：loop 工作流跑通 |
| [evidence/spec-gate-20260923.md](evidence/spec-gate-20260923.md) | 真实宿主 E2E：spec 审查门 |

## 代码级验收

功能的行为契约由 `scripts/*.mjs` 的断言钉住（16 个套件，覆盖裁判权、加载期硬校验、生命周期、执行日志、投票、子工作流、reset、rewind、判定完整性、可见性等）。这些脚本不在 `package.json` 的 scripts 里，直接 `node scripts/<name>.mjs` 运行。
