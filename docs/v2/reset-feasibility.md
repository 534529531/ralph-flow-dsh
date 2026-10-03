# reset 在 dsh 上的载体:全范围替换会话可见面

> 状态:**预研完成,方案成立,待实现。** 本文是实现的必读参考。
> 结论来自五路源码取证(替换契约 / source-form / 并发时序 / opencode 对照 / 我方落点)+ 本会话日志实测。
> 标注「未证实」的条目没有实跑过,只有源码路径或代码推断。

## 0. 一句话方案

在**步骤边界的空闲窗口**里,把属主会话可见面的 `nodes[1]` 到末尾**整段替换**成一条 ralphflow 自己写的「交接稿」,
使模型此后收到的 messages = **系统提示 + 交接稿 + 本步 DO 提示**。

这就是 opencode reset 的等价物:opencode 换一个新顶级会话 + 一条「会话交接说明」,我们**原地替换**。
reset 的「目的」(干净、自包含的上下文)与「载体」(换会话 / 原地替换 / 开窗)在 opencode 自己文档里就是分离的。

`SurfaceOp` 的契约原文(`dsh-session/lib/types/types.d.ts:428-433`):**"Used by compaction; any surface-replacing producer may use it"**。
非压缩的生产者已有先例:`dsh-agent-loop/lib/index.js:283-295`(SystemPromptProjection)、`dsh-compaction-tool-result-pruner/lib/index.js:175`。

**可行性总判**:宿主原语存在且是公开契约;ralphflow 侧缺的是端口与渲染器,不是能力。

---

## 1. 硬约束(违反任一条 = 静默损坏或直接失败)

### 1.1 替换起点必须是 `nodes[1]`
`nodes[0]` 通常是 `system/message`。覆盖 node0 的 replacement 必须**自身是 system/message 且只覆盖那一个节点**(`dsh-session/lib/types/surface.js:333-341`),用 `user/message` 交接稿去覆盖**必被拒**。
即使绕过,`SystemPromptProjection` 找不到 system 节点会把系统提示 append 到尾部(`dsh-agent-loop/lib/index.js:264-270`),压缩「node0 是 system 头、永不入选」的假设也随之失效(`dsh-compaction-basic/lib/index.js:375-397`)。
⇒ **合法范围 = `nodes[1] … nodes[N]`**(端点 inclusive)。

### 1.2 不能在工具调用内部替换
`ralphflow_submit` 本身就是工具。若在它的 handler 里替换,最后一个节点正是**携带该 tool-call 的 `assistant/message`**;它的 `tool/result` 之后会 append 到**新** surface 尾部 ⇒ 新 surface 以**孤儿 tool/result** 结尾:
- 之后**任何**一次平衡查询都会抛 `dsh-compaction/lib/types/tool-pairing.js:35`("corrupt surface")
- 模型会收到一个没有对应 call 的结果

⇒ 替换必须发生在 **tool 结果落地之后的空闲窗口**。
好消息:交卷工具带 `concludeTurn`(`src/tools.ts:151`,handler 在 `:209-212` 调 `exec.concludeTurn()`),**交卷即结束回合**;而下一步 DO 是 `steer` 送进去的,空闲驱动器会**开新一轮**(`src/index.ts:97` 注释原文)。所以工作流是**一步一回合**,每步之间都有空闲窗口。

### 1.3 放进 `agent.runMaintenance`
宿主**没有**可参与的压缩锁服务(`ctx.compaction` 每 context 一实现,已被 `compaction-basic` 占)。
官方给空闲期用的互斥入口是 `agent.runMaintenance`(`dsh-agent-loop/lib/index.js:803-826`):**phase ≠ idle 同步抛错**,与 turn、其它 maintenance、`/compact` 天然互斥(`/compact` 自己就用它,`dsh-compaction-basic/lib/index.js:955`)。

### 1.4 用自有 plugin source,不冒用压缩检查点
source 用 `{kind:'plugin', plugin:'ralphflow', …}`。
**不要**用 `plugin:'compact'`:**压缩 invariant 只在 `isCompactCheckpointSource` 为真时校验**(`dsh-compaction/lib/invariant.js:127-131`),一旦冒用就要求配对 `compaction/start`(直接失败 `:76-79`),Chat 还会把它渲染成压缩标记(`dsh-client-ui-chat/lib/client.js:5776-5781`)。
**也不要发任何 `compaction/*` 事件** —— 那等于伪造一次压缩事务。
`form` 建议**缺省**;要写就只用 `notice` + `summary`(各 form 的必填字段见 `client.js:780-812`,字段不可读只会静默回落 opaque,不报错)。

### 1.5 替换前自检平衡,不平衡就放弃本次
平衡 = 该切口处「未回答的 tool call 数 == 0」(`dsh-compaction/lib/types/tool-pairing.js:9,83,94`)。
- **实测 80 个真实会话日志**:闭合回合全部平衡(`last=turn/end` + `tail=0` 71 个,`end-seed` 7 个,在飞 2 个;`min<0` **出现 0 次**)
- **但有一个代码层反例**(未观测到):工具调度失败路径会让 turn 以 `reason=error` 结束却留下未回答的 `tool/call`(`dsh-agent-loop/lib/index.js:636-648`)⇒ 空闲但不平衡

⇒ 替换前自己调一次 `toolPairingBalancedAfter(last)`(**要 try/catch,它自己可能抛**);不平衡就**放弃本次**,下一步再说。

### 1.6 `sourceEventSeqs` 必须逐条列出每个被遮蔽节点
`dsh-session/lib/types/surface.js:207-239`:非空、无重复、全部早于当前 seq、且**必须覆盖每一个被 shadow 的节点**,缺一个即抛。
(本会话日志里那条真实 replacement 的 `sourceEventSeqs` 有 778 项。)

### 1.7 不要在 `session/event` 观察者里直接 append
会撞重入保护(`dsh-session/lib/index.js:1247-1248`:"session append cannot reenter while another append is being published")。必须延后到发布边界之外。

### 1.8 交接稿必须写小
见 §2 的 token-meter 一行:交接稿写大了会被 dsh 的**自动压缩**总结掉。压缩在本机**是活的**(本会话日志实测 `4 × compaction/start` + `4 × compaction/end` + `4 × compaction/summary`;`dsh-base/cordis.patch.yml:327-328` 挂着 `compaction-basic`)。

---

## 2. 消费者后果(记账用)

| 消费者 | 我们的替换会造成什么 |
|---|---|
| **Chat 视图** | 我们的替换消息**完全不显示**(只认 append-origin 与 compact 检查点,`dsh-client-ui-chat/lib/client.js:5961,6078`)。**旧对话因是 append 来源,仍然显示** |
| **Trajectory 视图** | 显示为一条 context 行,producer 标签 = plugin id(`client.js:1216-1223`、`:566-569`) |
| **token-meter** | `measure()` 全量折叠对任意 replace 正确;但 `contextPressure` 的 **O(1) 折叠靠压缩的 shadow-price 协议**,我们不发 claim ⇒ delta=0、保留替换前的**高位估计** ⇒ 可能触发一次不必要的自动压缩,而那次会把交接稿压成模型摘要(`dsh-token-meter/lib/types/surface-projection.js:37-66,11-13`) |
| api-session-controller / session-title / turn-outline / repeat-tool-reminder / session-reference | 都按 `kind==='user'` 过滤 ⇒ **忽略交接稿**(好事:不算用户活动,刷新后历史不含它,也不会被别的会话引用) |
| 前缀缓存 | 从第一条被 shadow 的消息起失效(一次性,`dsh-session/README.md:148`) |
| 模型上下文 | `deriveMessages()` 只遍历 `surface.nodes`(`dsh-session/lib/index.js:1336-1350`),replace 用 splice 移除 shadowed(`surface.js:386`),而模型请求的唯一来源就是它 ⇒ 被 shadow 的内容 **100% 不进模型上下文**;原始事件仍留在日志里(可重放) |

**注意**:每个 step 还会 append 一条运行时上下文 `user/message`(`dsh-agent-loop/lib/index.js:891-899 → :1026`),所以模型上下文**不会精确等于**「系统提示 + 交接稿 + DO」。

---

## 3. 已定的两个决定

1. **交接稿不含「已完成勾选」**(opencode 有 `build ✓` / `review 👈`)。
   理由:要它就得造一个「已通过步骤」事实源,而三条路都不好走——落 state 字段**倾向违反宪法 §10.4**;从「工作流定义 + current_step」推导**不成立**(`on_fail` 可回退 ⇒ 分不清首达/返工;定义每次入口都从磁盘重载 ⇒ 会漂移;子工作流是加载期静态展开);`history` 只有 **200** 条(`src/engine.ts:1652-1655`,按事件条数裁、不按步保底)。
   交接稿只写:**工作流名 / 第几步 / 产出目录 / 交互契约** —— 全都能现算,**不新增任何状态字段**。

2. **必须另发一条可见告知**。因为 Chat 视图不显示我们的替换消息,不告知就是「用户看到的 ≠ 模型看到的」且是**静默**的——按本项目「绝不伪造、如实标注」的原则不能接受。
   做法:走 `deliver`(append,可见)发一条说明本步开始前做了上下文重置。

---

## 4. 工程前置

| 项 | 位置 |
|---|---|
| `EnginePorts` 加 `resetSurface(sessionId, handoff)` | `src/engine.ts:673-690` |
| 接三处投递:**首步 DO 是工具返回值**、`advance` 投递、返工投递 | `engine.ts:2613` / `:2370` / `:2318` |
| 交接稿渲染器 | 新增 |
| 手柄 | `ctx.sessions`(SessionStore)已 inject 且已在用:`src/index.ts:14`、`:26-27` |
| 若要把 `input` 注进 DO | 改 `doPrompt`(`engine.ts:1843-1902`)**且必须改 `engine-test.mjs:755-764` 这条已接受契约**(`:759` 断言 DO 不含 input,`:764` 断言 CHECK 含 input) |
| 构建 | profile 走 link,`main = lib/index.js` ⇒ 改 `src` 必须 `npm run build` |
| 流程 | reset 现被 `docs/v2/design.md` 框成「只声明不实现」,按 §11 需作者准入 —— **作者已放行** |

---

## 5. 未证实项(实现时须自己复现)

1. **端到端跑一次 replace** 的可行性(80 个日志只证明了「闭合回合平衡」,没跑过 replace 本身),以及 provider 是否接受由此产生的请求
2. 有孤儿 `tool/result` 的 surface 上,自动压缩抛错后上层如何处置
3. `compaction-invariant` 是否已在运行 profile 注册
4. 直接 `append` 与 agent 回合的并发安全(本方案的答案是靠 `runMaintenance` 规避,而非证明)
