# 验证基础设施故障重试：dsh 实现与产品取舍

核验日期：2026-10-12。此文记录发布版 2.2.1 的评审快照；后续已按用户要求统一单 `check` 与投票的基础设施恢复规则，其余建议保留为评审意见。范围：Ralphflow 2.2.1 源码，以及本机安装的 `@deepseek-ai/dsh-llm`、`dsh-llm-retry`、`dsh-subagent`（均为 0.2.1-alpha.1）。只读设计评审，不修改产品代码。下列链接指向核验时的本地一手源码；安装目录和 `/tmp` 文件不是长期归档。

## 结论

现有方向基本符合 dsh：模型请求恢复归宿主，插件负责工作流判定与有限的新验证者重跑；基础设施问题不消耗工作失败次数；保留通过票降低重复验证成本。但“所有 infra 都重跑一次”丢失错误分类，单 check 与投票的恢复体验不一致，全票等待又使流程活性受最慢验证者限制。优先改善错误信息与恢复决策，不应再造请求重试、超时控制器或持久验证相位。

## 已核验事实

| 层次 | 行为 | 一手依据 |
| --- | --- | --- |
| dsh 模型请求 | normal 模式只重试允许的 failure.code，受 maxRetries 限制；指数退避、jitter、provider Retry-After；等待可取消且等待前持久记录 | [dsh-llm-retry index.js:44](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js:44)、[index.js:116](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js:116)、[index.js:151](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js:151) |
| 默认请求策略 | 默认 maxRetries=5；默认可重试码为空响应、RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT；always 模式不受 normal 的次数和码表限制 | [dsh-llm index.js:247](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm/lib/index.js:247)、[retry index.js:153](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js:153) |
| 单 check | 委派返回 infra 后直接暂停 check_infra，没有插件级自动重跑 | [engine.ts:2530](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2530)、[engine.ts:2754](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2754) |
| check_voting | 全票终态后聚合；failed 优先于 infra；只有没有 failed 的首轮 infra 才自动重跑故障票一次；通过票保留，再故障暂停 | [engine.ts:2631](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2631)、[engine.ts:2645](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2645)、[engine.ts:2650](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2650)、[engine.ts:2658](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2658) |
| 人工恢复 | check_infra 的投票恢复保留 passed，只发起其余票，并把 attempt 重设为 1，因此又获得一次自动重跑；DO 重新交卷则所有票失效 | [engine.ts:3663](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L3663)、[engine.ts:3705](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L3705)、[engine.ts:2430](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2430) |
| 委派生命周期 | runVerifier 透传取消 signal，直接 await run.result，没有插件总时长上界 | [verify.ts:282](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L282)、[verify.ts:317](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L317)、[verify.ts:338](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L338) |

`/tmp/ralphflow-rc2-inspect` 中可比默认源的请求预算及码表也是上述值：[dsh-llm index.js:247](/tmp/ralphflow-rc2-inspect/dsh-llm/package/lib/index.js:247)。这只是默认源码一致性证据；本次未读取实际部署 provider retryPolicy，因此不能认定运行时一定采用 normal/5 次，也不能以默认预算给验证总耗时估上界。

两层重试有明确区别：宿主恢复一次模型请求；插件重新调用 `subagents.start`，启动一次新验证。后者可能重新读文件、跑命令，不能描述成接着原请求重试。[verify.ts:338](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L338)、[engine.ts:2668](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2668)

## 事实推导与局限

**错误信息确实被压扁。** 无后端、无法解析判定、委派抛错都成为 infra；catch 保留 message，未保留结构化 code/cause。dsh 的子代理结果可带 diagnostic，但 runVerifier 解析及结果日志只读取 structured/output/stopReason，未保留 diagnostic。因此插件当前无法可靠区分配置永久错误、请求恢复耗尽、判定格式错误或其它终止原因。[verify.ts:199](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L199)、[verify.ts:260](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L260)、[verify.ts:346](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L346)、[verify.ts:355](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L355)、[dsh-subagent index.js:2617](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2617)

**待核验的判定边界：终止状态与部分输出。** parseVerdict 先接受 structured.passed 或文本标签，并未先检查 stopReason；只有没有文本时才把 stopReason 放进 infra 原因。dsh 的取消/错误终态仍可能携带 collectOutput()，所以应通过可达路径测试核验异常终止时能否留下看似有效的标签，以及此时宿主如何处理 structured。当前仅能确认解析顺序，不能据此声称已经发生实际误通过。建议先验证这个边界，再决定是否要求正常完成才能接受判定。[verify.ts:203](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L203)、[verify.ts:209](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L209)、[dsh-subagent index.js:2620](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2620)

**全票等待是合理的默认，但不保证活性。** 等齐票能收集完整失败依据，让工作失败不被早到的基础设施故障遮蔽，也避免过早启动重跑后另一票才失败的浪费。代价是，即便已经拿到 failed，另一票若不结束，返工仍不能启动；infra 也须等待其余票才开始重跑。这是聚合守卫的直接推论，不是已经复现的线上故障。[engine.ts:2631](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2631)、[engine.ts:2645](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2645)

**心跳证明属主运行时仍在维护委派，不能证明验证者有有效进展。** 心跳由插件 setInterval 自行刷新，不消费子代理 token、工具完成或终态事件；所以请求退避、工具长等待甚至悬挂时，心跳仍可能健康。当前代码没有插件验证超时；宿主整次验证的绝对上界、实际 provider 看门狗配置未完整核验，不能仅由心跳承诺“马上自动完成”。[engine.ts:1294](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L1294)、[verify.ts:282](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/verify.ts#L282)

保留通过票的正确性依赖于“同次交卷的工作没有变化”。DO 重新交卷时全票清空支持这一设计，但暂停期间用户直接编辑产物后 continue，当前 passed 仍被保留；暂停状态下 submit 会直接拒绝交卷，因此不能把“暂停后改产物，再重新交卷”描述成当前已有的顺畅恢复通道。恢复设计应区分“只修复基础设施，保留通过票”与“产物已改，全部重新验证”。[engine.ts:3432](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L3432)[engine.ts:2430](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L2430)、[engine.ts:3668](https://github.com/534529531/ralph-flow-dsh/blob/90a936ebeb2d6c73fc7656d4f8bad53f5edbda78/src/engine.ts#L3668)

## 建议，按优先级

1. **P1：保留已有错误证据，明确永久错误不自动重跑。** 在验证端口保留宿主实际提供的 code、diagnostic、stopReason，并利用现有结果日志/判定原因展示。缺后端、已确认的配置/认证错误等直接暂停并给修复动作；格式错误可保留一次新验证重跑；不靠字符串猜测错误码。宿主已用 normal 码表避免若干不可恢复错误，但插件的全 infra 重跑绕过了这层选择。宿主未提供分类时明确“原因未知”，不要冒充已识别的瞬态故障。
2. **P1：统一有限的新验证者重跑语义。** 单 check 和投票采用同一分类决策及“一次自动重跑，再暂停”的预算；投票只重跑故障票、failed 仍优先、同次交卷 passed 保留。continue 作为明确人工恢复重置预算，提示“将重新启动验证者”，产物已变更时提供明确的全量重验恢复入口，不能无条件复用暂停前的通过票。不要在插件里追加模型请求退避、改 provider 策略或自动切模型。
3. **P1：状态文案准确表达活性和进展。** 基于现有 delegations/verdicts/时间展示“等待第几票、开始时间、哪些票已有结果、可取消”；不新增 UI 定时器或轮询。心跳只标属主存活。已有宿主会话可以供用户查看真实轨迹。没有可靠子代理进度信号时不增加 last_progress 一类猜测持久字段，不把等待时长自动变成失败，不用插件 timeout 抢宿主生命周期。
4. **P2：先保持全票聚合，评估失败后的等待成本。** 已有 failed 时即时告知“本轮已确定需要返工，仍在等待其余票补充依据”，最终仍一次聚合。只有实际延迟证据表明损失显著，再考虑经宿主取消剩余票的失败快退选项；须保留已完成依据与现有 run_id 归属校验，避免迟到结果污染。不要先增加新事件体系或持久验证相位来解决一个尚未量化的问题。

这四项保留宿主取消/恢复能力与现有 state.json 单一事实源。最有价值的第一步是让 infra 有可采取行动的原因，其次再统一恢复体验；单纯增加重跑次数会放大永久错误成本，并不能解决一票永远不结束的问题。

官方版本文档：[dsh 0.2.0-rc.2 的请求重试说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/llm-retry/README.md)。确认请求恢复在同一 open turn 中执行，并具有策略预算、退避、Retry-After 和取消语义。
