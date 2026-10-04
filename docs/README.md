# ralphflow-dsh 文档

## 快速上手

| 文档 | 说明 |
|------|------|
| [主页 README](../README.md) | 功能介绍、快速开始、安装、内置工作流 |
| [自定义工作流](custom-workflows.md) | YAML 字段参考、检查依据、重置门、回退、嵌套、投票 |
| [命令参考](commands.md) | 所有 slash 命令、工具参数、日志事件、目录结构 |

## 指南

| 指南 | 5 分钟读 | 说明 |
|------|----------|------|
| [写第一个工作流](custom-workflows.md#快速示例) | ✅ | YAML 从零到一，附完整示例 |
| [步骤字段参考](custom-workflows.md#步骤字段参考) | ✅ | 六个必填字段、加载期硬错误与告警的边界 |
| [产出目录](custom-workflows.md#产出目录与模板变量) | ✅ | 交付物放哪、为什么不需要模板变量 |
| [人工审查门](custom-workflows.md#manual_step) | ✅ | 先自动验证、通过后停下请你审查 |
| [检查依据：check 与 check_voting](custom-workflows.md#检查依据决定本步是否被独立验证) | ✅ | 单验证者、多验证者投票、跳过对抗验证 |
| [对抗性验证配置](custom-workflows.md#adversarial_check) | | 验证模型与优先级链 |
| [上下文重置门（reset）](custom-workflows.md#上下文重置门reset) | | 步骤级 `reset`、工作流级 `auto_reset`、调用点、手动重置 |
| [中途回退（rewind）](custom-workflows.md#中途回退rewind) | | 回退到更早的步骤并换方向 |
| [子工作流与嵌套](custom-workflows.md#子工作流与嵌套) | | 组合可复用工作流组件（加载期静态展开） |
| [多步骤流程设计](custom-workflows.md#多步骤流程设计) | | 线性 / 分支 / 恢复 / 回环四种模式 |

## 参考

| 文档 | 说明 |
|------|------|
| [工作原理](how-it-works.md) | 架构：DO/CHECK 循环、裁判权定理、状态模型、生命周期、工作区锚定 |
| [命令参考](commands.md) | 命令表、使用示例、工具 API、日志事件、实例与报告格式 |
| [设计定稿与宪法](v2/design.md) | 完整设计决策、十二条不可违反的宪法、版本路线图 |
| [投递分类台账](v2/delivery-classification.md) | 每一处投进会话的消息是「指令（唤醒）」还是「播报（只记录）」——含逐条清单与守卫用例 |
| [历史档案](v2/) | 各功能的任务书（brief）与验收证据 —— **面向实现者，不是读者文档** |

## 进阶：场景速查

| 你在 | 需要 | 做法 |
|------|------|------|
| 流程跑到一半上下文太长了 | 换干净上下文继续当前步 | `/ralphflow-reset` |
| 后期发现早期某步方向走错 | 回到那步重做 | `/ralphflow-rewind <步骤> <原因>` |
| 某步完了停下来等你审查 | 通过 → 继续 | `/ralphflow-continue`；或直接跟 AI 说要改哪里 |
| 工作流卡死/暂停 | 恢复执行 | `/ralphflow-continue` |
| 彻底放弃 | 取消并留报告 | `/ralphflow-cancel` |
| 不确定工作流定义有没有坑 | 预检 | `/ralphflow-doctor` |
| 多个会话要跑不同任务 | 并行启动 | 各自开一个会话，各自 `/ralphflow-start` |
| 换个会话接管中断的实例 | 续命 | `/ralphflow-continue <实例前缀>` |
| 想设计一个新工作流 | 交互式创建 | `/ralphflow-create` |
| 想知道验证者到底看到了什么 | 复盘取证 | 读实例的 JSONL 执行日志（含提示词与判定原文），见[命令参考](commands.md#日志与复盘) |

---

## 阅读路线

**第一次用：**
1. [主页 README](../README.md) → 了解它是干什么的
2. [写第一个工作流](custom-workflows.md#快速示例) → 写一个最简单的两步骤，跑 `/ralphflow-doctor` 检查
3. [命令参考](commands.md#slash-命令) → 摸熟所有可用操作

**深入理解：**
1. [工作原理](how-it-works.md) → 消化 DO/CHECK 循环、裁判权定理和独立验证的设计理由
2. [自定义工作流 → 子工作流与嵌套](custom-workflows.md#子工作流与嵌套) → 构建复合流水线
3. [设计定稿与宪法](v2/design.md) → 每个决策的来龙去脉与不可违反的边界

## 三端姊妹项目

同一份工作流 YAML 在三个端可跑，方言共享是硬约束。载体各不相同：

| 端 | 仓库 | 交卷方式 |
|----|------|----------|
| **dsh（本仓库）** | [ralph-flow-dsh](https://github.com/534529531/ralph-flow-dsh) | 调用 `ralphflow_submit` 工具 |
| opencode | [ralph-flow](https://github.com/534529531/ralph-flow) | 输出 `<promise>done</promise>` 文本标记 |
| claude code | 姊妹仓库 | 输出 `<promise>done</promise>` 文本标记 |

本端与另两端的刻意差异（超时归属、`extra_dirs`、子工作流模型、fail-fast 口径）见 [主页 README → 与 opencode 和 claude 版的关系](../README.md#与-opencode-和-claude-版的关系)。
