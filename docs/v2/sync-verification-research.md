# 验证同步化调研（dsh）

> **读者**：作者。本文件回答一个架构问题：**dsh 版的验证该不该从「后台异步」改成「回合内同步」**，以及三个端（dsh / opencode / claude）各自能做到什么。
>
> **状态**：调研完成。**作者已定案：保持异步，且不新增任何护栏机制**（定案与理由见 §7）。
>
> 本文件保留完整的调研与权衡过程，**供将来重新评估时不必重做取证**；§7 的结论以定案为准，不要再把同步化当作待办。
>
> **未改任何源码**（本仓库当时另有 loop 会话在跑，`src/engine.ts` / `src/verify.ts` 有它的未提交改动）。

## 0. 结论摘要

> **定案（作者，本轮）：保持异步，不新增护栏机制。** 下面的 1–7 是调研结论，不是待办；§7 是定案与理由。

1. **我原先的框架是错的。** opencode 的验证确实被 `await` 到底，但**不在工具 handler 内**，而在 `session.idle` 事件钩子里——被等待的那一刻，**执行者的回合早就结束了**（`driver.ts:5` 原文：*"the check runs while the session is **IDLE**"*）。它是「**空闲期同步阻塞驱动器**」，不是「回合内阻塞模型」。
2. **三端实际都是「验证时执行者回合已结束」**：opencode（idle handler 内 await）、claude（harness 强制后台）、dsh（我们 `void`）。
3. **所以「同步化」在 dsh 里是一个三端都没有的新语义**：把验证挪进工具调用内 await → 执行者回合被阻塞 → **同时冻结被审对象**。这不是「回到 opencode」，是**比 opencode 更进一步**。
4. **dsh 能做，而且优雅。** 「在工具调用里等子代理」是**宿主自己的一等公民模式**（`dsh-tool-subagent` 前台模式）；没有任何上界；GUI 有 stop 控件；`followup` 的闩锁机制原生解决「推进 vs 结束回合」。
5. **收益很大**：可删掉 `delegations[]` 账本 + 护栏 + 6 处清账 + `restore()` 的孤儿恢复——**就是那个两次让你困惑的机制**。并且拿到三端都没有的 T1 保证（冻结被审对象）。
6. **代价**：实测每次验证阻塞 **7–8.5 分钟**；验证期间**没有流式进度**（用户只看到 submit 工具卡在跑）。
7. **claude 无法跟随**（harness 强制后台，改造面 5 项）；**opencode 不需要跟随**它的交错问题已由驱动器同步解决，但**它的执行者也没被冻结**——要跟随「冻结」这条原则，它得加相位锁，而它明确拒绝过（理由在 dsh 不成立）。

## 1. 三端真相（我原来的框架错在哪）

> **范围声明**：本章只考察了 **opencode / claude / dsh 三端**。本家族还有**第四端** `ralph-flow-pi`（Pi SDK 的独立 CLI，npm v0.2.1），**本章未考察它**——事后才注意到它存在。
> 已核实的两点（供将来参考）：pi 的验证是 `await adversarialCheck(...)`，即**同步**（CLI 能阻塞，无宿主回合概念）；且 pi 同样支持 `adversarial_check.agent` / `system_prompt` / `timeout_ms`。
> 这不影响本文件的定案（§7 保持异步），但它意味着「同步只 dsh 能做」这类说法**不成立**——pi 本来就是同步的。
> **作者定案：pi 已搁置，不纳入维护与收敛范围**（范围 = dsh/opencode/claude 三端，见 design §9）。

### 1.1 opencode：驱动器同步，回合不阻塞

| 事实 | 证据 |
|---|---|
| 触发点是**事件钩子**，不是工具 | `index.ts:128-136`：`event: async ({event}) => { if (event.type === "session.idle") { await handleSessionIdle(...) } }` |
| 验证在 idle handler 内被**完整 await** | `driver.ts:788-790` → `driver.ts:414/435` → `check.ts:300-308`（`await Promise.race([promptPromise, timeout])`）；verdict 路径上**无一处** `void` / 未锚定 promise |
| **执行者回合已结束** | `driver.ts:4-6`、`driver.ts:311-314` 两处注释原文 |
| 工具**不跑**验证 | `tools.ts:12`：*"Check is NOT run from any tool — the driver runs it automatically on idle"*；`tools.ts:186` 工具描述亦然 |
| 验证进行中 `continue` 被拒 | `tools.ts:297-299` → `"## ⏳ 验证进行中…请等待完成"` |
| 有超时（30 分钟默认，上限 1 小时） | `engine.ts:2492` `DEFAULT_ADVERSARIAL_TIMEOUT_MS = 1_800_000`；`engine.ts:1052-1055` `Math.min(adv.timeout_ms, 3600000)` |
| 有在飞标记 | `.adversarial-session`（`check.ts:256` 写 / `:382` 删）+ 进程内 `activeChecks`（`check.ts:31`）+ `drivingSessions`（`driver.ts:37`） |
| **护栏是结构性的，不是身份式的** | `driver.ts:448-458`：五元组 `(active, paused, current_phase, workflow_name, current_step)` 相等 + 实例目录存在；**无 `run_id` / 轮次 id / CAS**（已 grep 确认） |
| **执行者未被冻结** | `index.ts:116-126` 权限门**不看相位**，只判「是否拥有活跃实例」→ 验证期间照样 `Edit`/`Write` |

**为什么它不需要 `run_id`**：handler 把验证 await 住了，`drivingSessions` 挡住并发 idle，状态迁移只能由这条链发生——**交错在结构上不可能**，所以不需要身份校验。这正是我们要的那种「简单」。

### 1.2 claude：异步，而且是 harness 强制的

| 事实 | 证据 |
|---|---|
| **异步**，插件不 await 任何东西 | 每个 hook 是短命 node 进程，`process.exit(0)` 即走 |
| **不是它选的** | `docs/adr/0005-async-delegation.md:3`：*"交互式会话默认开 fork mode，Agent 工具的 `run_in_background` 参数被移除，所有委派一律后台；调用在任务转入后台时即返回"* |
| **唯一杠杆且插件无法强制** | 同文件 `:5`：*"唯一能拿回前台语义的杠杆是环境变量 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` … 而且**插件无法强制**"* |
| 真实时序（转录为证） | `10:02:44.633` 派发 → `10:02:48.736` `"Async agent launched successfully"` → **`10:02:48.600` Stop hook `{}` 回合结束** → `10:02:53.471` `<task-notification>` 唤醒 |
| **无相位锁（明确拒绝）** | `hooks/pre-tool-use.js:25-27`：*"防「验证中改现场」在**异步委派下没有对象可冻结**，还把主会话钉死成只能另开终端取消"*；`docs/design.md:127` 同 |
| **无超时、无法强杀** | `docs/subagent-verification-design.md:303-315`：*"**无进程句柄，无法强杀**正在运行的验证子 agent"*；`timeout_ms` 已撤回（commit `61c77a1`） |
| **护栏拦不住幽灵票，且文档承认** | `hooks/subagent-stop.js:295/298`：`step_id` 与 `ts` 是**落盘那刻从当前 state 取的**，不是验证者给的 → 认不出「上一轮派出的幽灵验证者这一轮才落盘」。`:314-321` 注释承认并靠「覆盖度 + 全过才过」fail-closed 兜底 |

> **这一条直接回答了你的问题「护栏能拦得住所有情况吗」：拦不住。** claude 版自己承认了，并把「fail-closed 而非身份识别」写成了设计取舍。

### 1.3 dsh（我们）：真·后台，所以需要账本

`onSubmit` → `void launchVerification(...)`（`engine.ts:1190/1198/1309/1344` 四处）→ 回合立即结束。因为**驱动器链断了**，验证落地时世界可能已经变了，于是需要 `delegations[]` 账本 + 护栏（`engine.ts:872-884`），而账本的正确性依赖 **6 处**记得清账（`engine.ts:778/924/968/1303/1365/1530`）。

**所以三端里只有我们的护栏是「靠别人记得记账」式的。** 你的不安是准的。

## 2. dsh 能不能优雅地做同步

### 2.1 「工具调用里等子代理」是宿主自己的模式 ✅

`dsh-tool-subagent/README.md:87`：
> A foreground call **awaits `run.result`** … and **always awaits `run.dispose()` before returning**

`:59`：
> Under `one-shot` policy, an omitted `run_in_background` **waits in the foreground** and returns the child's final text

而 `dsh-base/cordis.patch.yml:369-374` 给 `subagent_fork` 配的就是 `backgroundMode: one-shot` = **默认前台等待**。我们不是在发明用法。

### 2.2 没有任何上界 ✅

| 可能的掐断点 | 结论 |
|---|---|
| `dsh-tool-call-timeout-policy` | `lib/index.js:123-124`：`const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs; if (timeoutMs === void 0) return next();` —— **未声明 `timeoutMs` 的工具完全不被包装**。我们的 submit 未声明（已 grep 确认）。 |
| `dsh-timeout.idleWatchdog` | 只被 `dsh-llm-deepseek` / `dsh-llm-pi-ai` 使用；README：*"counts only time spent waiting for provider reads"* —— 阻塞的工具调用期间那条流不在飞。 |
| `dsh-agent-loop` | 无 `timeoutMs` / `deadline` / `maxDuration`（已 grep）。 |
| 传输层 | `dsh-web` / `dsh-api-gateway` 无会掐断长调用的超时。 |

### 2.3 取消路径存在，而且 GUI 有 stop ✅

- 远程：`dsh-api-session-controller/lib/index.js:880-885` → `agent.cancel({kind:"user"}, {keepInbox:true})` → 中止回合 → `exec.signal` abort → 我们的 `runVerifier` 捕获 → `status:"infra"`。
- 客户端：`dsh-client-ui-conversation/lib/client.js:3221-3224`：`cancel()` 文档原文 *"Cancel the scoped session's **in-flight turn** while preserving Queue"*；`:17039-17041` 把它挂在输入框的 `stop:` 控件上。

**这恰是 claude 拒绝相位锁的理由在 dsh 不成立的原因**：claude 说「会把主会话钉死成只能另开终端取消」，而 dsh 的 GUI 里就有 stop。

### 2.4 「推进 vs 结束回合」不需要协调——我们只是用错了方法 ✅

`dsh-agent-loop/lib/index.js:787-792`：
```js
followup(input) { this.send(input, "next-turn", true); }   // ← 投给下一回合
steer(input)    { this.send(input, "next-step", true); }   // ← 投给本回合的下一步
```

`wakeDriver`（`:835-850`）+ 回合结束处的闩锁重放（`:874-879`）：
```js
if (wakeRequested && this.inbox.hasPending) this.wakeDriver();
```

**所以：** submit handler 内 `await` 验证 → 应用判定 → `advance()` 用 **`followup`** 投递下一步 DO 提示（此时回合仍在跑 → `wakeRequested` 闩住）→ 工具返回 `concludesTurn` → 回合结束 → **闩锁重放，自动开新一轮**。一步一回合，确定性成立。

**而我们现在的 `deliver` 优先用 `steer`**（`src/index.ts:97`），还把 `followup` 注释成「旧版本兼容兜底」——**那个注释是错的**，`followup` 是一等方法。`steer` 恰恰是「塞进当前回合」的那个。

**两处投递的语义需求不同，必须分开**：
- `remindToSubmit`（来自 `agent/turn-stopping`）**必须**用 `steer`/next-step —— 提醒要在回合关闭前被模型看到，否则提醒失效还会死循环。
- 其余全部（DO 提示、播报、推进）→ `followup`/next-turn。

### 2.5 实测阻塞时长

从真实报告 `reports/loop-muey7m8h-x1x0.md` 算出的两笔：

| 验证 | 耗时 |
|---|---|
| `03:21:21.743` → `03:29:56.326` | **8 分 34 秒** |
| `03:33:27.801` → `03:40:56.914` | **7 分 29 秒** |

**这是同步化要付出的真实代价，不是估计。**

## 3. 同步化后的形态（设计草案，**已否决——仅存档**，见 §7）

1. **`ralphflow_submit` 内 await**：`void launchVerification(...)`（4 处）→ 单点 `await`。判定落地即应用（`advance` / 暂停 / 停在门）。
2. **`deliver` 显式带投递目标**：默认 `followup`（next-turn），仅 `remindToSubmit` 传 `steer`（next-step）。
3. **删掉 `delegations[]` 账本与护栏**（见 §4）。
4. **崩溃恢复退化成一条规则**：`restore()` 见 `active && do_submitted && verdicts.length === 0` → 暂停 `check_infra`，理由「验证被中断（进程重启）」。**基于已有字段，不需要账本**。
5. **取消期间的验证**：用户按 stop → `exec.signal` abort → `runVerifier` 返回 `infra`（reason「验证已中止」）→ 走既有 infra 路径暂停（**不烧 fail_count**），用户可 `/ralphflow-continue` 或 `/ralphflow-cancel`。
6. **`writeState` 不再 `mkdirSync`**（纵深防御，见 §5.4）。

## 4. 能删掉什么（**已否决——仅存档**，见 §7）

| 删除项 | 位置 |
|---|---|
| `delegations[]` 字段 + 6 处清账 + push + filter | `engine.ts:183/778/830/886/924/968/1303/1365/1530` |
| 迟到判定护栏（5 种 reason） | `engine.ts:872-884` |
| `restore()` 的 `orphan_delegation_recovered` | `engine.ts:1493-1503` ← **两次让你困惑的就是它** |
| 4 处 `void launchVerification` → 1 处 `await` | `engine.ts:1190/1198/1309/1344` |
| `remindToSubmit` 里的 `delegations.length > 0` 判断 | `engine.ts:1238` |
| 「未返回的验证」这个概念本身 | — |

**净变化：大幅变简单。** 新增只有「`deliver` 多一个目标参数」和「崩溃恢复一条规则」。

## 5. 代价与风险

### 5.1 8 分钟阻塞（实测）
回合被工具调用占住。用户看到 `ralphflow_submit` 工具卡在跑 7–8.5 分钟。可随时按 stop。

### 5.2 验证期间没有流式进度
`steer`/`followup` 都只在**步/回合边界**投递，所以「🔍 独立验证者正在取证」这类播报在阻塞期间**送不出去**。现状（异步）能立刻播报、会话看起来 idle 但知情。**这是同步化丢掉的主要 UX。**

### 5.3 播报会唤醒模型
`notify` → `deliver` → wake。在审查门/完成时这可能**正是你想要的**（模型用自然语言收尾，符合你「命令要由大模型回答、不要程序化卡片」的偏好），但需要明确决定；纯进度类播报应改用不唤醒的通道。

### 5.4 纵深防御（**已否决，见 §7**）
`writeState` 现在 `mkdirSync(instanceDir, {recursive:true})`（`engine.ts:617`）——**任何销毁后的写入都会复活实例目录**。改成「目录不存在 → 不创建、写入失败并告警」。这样「僵尸复活」从机制上不可能，与护栏是否完备无关。**物理层不该给逻辑层兜底造假。**

### 5.5 需要实验确认的三件事（**已作废，见 §7——不做同步，无需实验**）
1. **8 分钟阻塞在真实 GUI 里是否优雅**：传输是否稳定、工具卡是否正常、浏览器/SSE 有无断连。
2. **`followup` 闩锁是否如代码所述**：`concludesTurn` 结束后自动开新一轮。
3. **stop 按钮是否干净地中止工具调用**并落到 infra/暂停路径。

## 6. 三端对照与「看齐」的真实含义

| | 验证时执行者回合 | 状态交错 | 被审对象冻结 | 护栏形式 |
|---|---|---|---|---|
| **opencode** | 已结束（idle） | **结构上不可能** | ❌ 未冻结（明确不加相位锁） | 五元组结构性复核，无 `run_id` |
| **claude** | 已结束（harness 强制后台） | 可能 | ❌ 明确拒绝 | `step_id` + `ts` 新鲜度；**承认认不出幽灵票**，靠 fail-closed 兜底 |
| **dsh 现状** | 已结束（我们 `void`） | 可能 | ❌ 未冻结 | `run_id` 账本，**依赖 6 处记得清账** |
| **dsh 同步化后** | **被阻塞 8 分钟** | **结构上不可能** | ✅ **冻结** | 不需要 |

**「看齐」的真实含义**：
- **claude 跟不了**：改造面 5 项（删静默分支、恢复 `post-tool-use.js` 整个文件、处理 `SubagentStop`/`PostToolUse` 时序竞争、重写 2 个 ADR、重写 3 套测试），而且 harness 层面就不给前台语义。
- **opencode 不需要跟**交错问题，但**要跟「冻结」这条原则得加相位锁**——它拒绝过，理由是「钉死成只能另开终端取消」，而 **dsh 有 GUI stop，这个理由在 dsh 不成立**。
- 所以同步化后，**dsh 会在「验证期间不得有第二个写入者改动被审对象」这条原则上成为三端里最强的**，而这条原则恰恰是 T1（裁判权在独立会话）的完整性所要求的。

## 7. 定案：保持异步，不新增护栏机制

**作者定案（本轮）**：

1. **不做同步化。** 保持现有的后台异步验证。
2. **不新增任何护栏机制。** 本文件中提出的 epoch 世代号（§5.4 曾议）、单一写入者队列、事件日志 + fold，以及「`writeState` 不再建目录」的一行纵深防御——**全部不做**。
3. **现有的 `delegations[]` 账本与迟到判定护栏保持原样**，不重构、不删减。它是承重的，且已在实际使用中工作。

**定案理由（作者）**：

- opencode 版长期使用没有暴露这类问题；不为罕见情况建设复杂机制。
- 用户不主动操作时，opencode 的驱动器同步与异步在**可观察行为上等价**（会话空闲、用户可随时说话）。
- 保持异步能让 dsh 与 claude 版（harness 强制异步）在**可观察行为**上自然一致；若改成同步，dsh 反而会成为三端里唯一「验证期间会话被占住 8 分钟」的那个，那才是真正的不对齐。

**对将来会话的约束**：

- **不要**因为「同步更简单」重新提出同步化——本条已权衡并否决，取证在 §1–§6，不必重做。
- **不要**在异步前提下追加身份式护栏（轮次 id / CAS / 队列）——按定案，这类机制属于「为假想情况建机制」。
- 唯一仍然成立、且**与架构无关**的后续工作是实例生命周期（销毁/列表/历史入口/doctor 异常检查），见 `instance-lifecycle-brief.md`；该任务书已明确写明「不要动这条护栏」，与本定案一致。

**为什么保留本文件**：§1 的三端真相（尤其 opencode 是「驱动器同步」而非「回合阻塞」、claude 是 harness 强制异步）是**一次性取证成果**，重新评估时不必再去读三个仓库的源码。§2 的 dsh 宿主能力结论（工具调用无上界、`followup` 闩锁、GUI stop）同样可复用。
