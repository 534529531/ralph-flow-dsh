# 播报对人类可见（客户端半边）

> 任务书是**目标书**，不是实现说明书（见 [brief-style.md](brief-style.md)）。机制取证见
> [ui-notice-research.md](ui-notice-research.md)，本文不重复。

## 问题

[v1.2](design.md) 把播报从 `steer` 改成直接 append 到会话可见面，修好了「播报唤醒执行者」。
但它如实记录的那条代价成了新的用户侧缺陷：**通过、失败、暂停、审查门、完成这五类事件，
用户在 Chat 时间线上一个都看不到。**

作者原话：「当前的整体流程，用户侧看起来体验不好，比如通过或者失败的时候用户没有任何提示，
不像 opencode 的版本那么好。我们之前试过有提示呢会破坏并行校验。没有提示呢又影响用户体验。」

根因**不在投递，在渲染**：dsh 的 Chat 客户端把 `source.kind !== "user"` 的 user/message 一律
归类成 `context`，再整行过滤掉。`form:"notice"` + `summary` 只决定**已经可见的** context 行怎么
展开，不能让行免于被过滤。

**这条缺陷能活到今天，是因为验收锚错了地方**：[`scripts/visibility-test.mjs`](../../scripts/visibility-test.mjs)
断言的是 `source.form === "notice"` —— 「成为可见面节点」，不是「用户看得见」。20 支套件全绿，
用户什么都看不到。

## 目标

**每一步的进度、通过、失败、暂停、审查门、完成，都要在 Chat 时间线上立刻出现一行用户看得见的
记录；而这条记录不得唤醒驱动器、不得把收尾中的回合续上。**

路线已定（作者选定）：**给本包补一个只负责渲染的客户端半边**，宿主侧的投递载体与分类一位不变。
"往会话里塞消息换可见性"这条路已被证伪——在 dsh 的时间线里「可见」与「驱动」是同一根开关，
不要再走。

对标一句：opencode 版靠 `noReply:true`（一条既显示又不启动回合的通道）；dsh 没有这条通道，
它的等价物是**客户端插件自己声明一个 Chat 节点**，dsh 自己的 `dsh-client-ui-workflow-run`
就是这么把「一次 workflow 运行」画进 Chat 的。

## 边界（不许动的东西）

1. **绝不唤醒驱动器**：不碰收件箱、不碰 `steer`、验证期间不开新回合。这是 v1.2 修好的东西，
   不许退回去。
2. **投递分类不漂移**：指令仍走 `agent.steer`，播报仍走 append；
   [`docs/v2/delivery-classification.md`](delivery-classification.md) 的台账与
   [`scripts/delivery-classification-test.mjs`](../../scripts/delivery-classification-test.mjs)
   的计数不变。
3. **判定权与冻结产物不动**：验证者协议、fail-closed 计票、reset 时序一律不碰。
4. **不加轮询 / 定时器**：可见性必须由**已有**的会话事件折叠出来，不许新开一条等待通道。
5. **不改 dsh 本体**，不为更老的 dsh 留兼容分支（跟最新版走）。
6. **模型面不变**：替换完成后，模型上下文仍精确等于「系统提示 + 交接稿 + 本步 DO」。

## 完成判据

1. **用户看得见（真机）**：在真实 `dsh web` 里跑一个短 `loop`，Chat 时间线上出现 —— 每一张
   验证票的进度行、判定聚合行、以及暂停 / 审查门 / 完成行。逐条可见，**刷新页面后仍在**。
2. **人类时间线与模型面解耦**：一次「失败 → 重置 → 返工」之后，用户在时间线上**仍看得到**
   重置前的播报。这条要与判据 6 同时成立（dsh 的设计意图就是如此，见调研 §4b）。
3. **不唤醒（回归）**：验证期间该会话保持空闲；投播报不开新回合、不把收尾中的回合续上。
   [`scripts/notice-delivery-test.mjs`](../../scripts/notice-delivery-test.mjs) 的 N1/N2 继续绿。
4. **验收锚点改对**：可见性断言从「source 字段长什么样」改成「存在一个用户看得见的节点」，
   并且**必须带负对照** —— 把渲染半边拿掉（或把节点 kind 改回 `context`）后，同一断言必须变红。
   只有正向断言不算完成。
5. **文档假前提改正**：仓库里三处写着「用户可见性与 kind 无关」，与 dsh 的代码直接冲突
   （[`src/message-source.ts`](../../src/message-source.ts) 的注释、
   [`docs/v2/design.md`](design.md)、[`docs/how-it-works.md`](../how-it-works.md)）。逐处改正，
   并把**正确的规则**写清楚（谁决定可见性、`form:"notice"` 到底管什么）。
   另外 [`design.md`](design.md) 路线图里 v1.2 那条留着「要人动作的三条（暂停 / 审查门 / 完成）
   同样不显示，**待议**」——本次把它结掉：加一行路线图记录本版做了什么（准入按仓库惯例写
   「作者直接指示」），并把 v1.2 的待议指向它。
6. **打包合法且不连累宿主**：`npm pack` 的产物里含客户端 bundle；`dsh.client` /
   `exports["./client"]` 声明合法 —— dsh 的 client-modules 在装配期对非法声明**直接抛**，
   会连累宿主半边。这必须是一道闸（测试或构建期检查），不是一句声明。
7. **全绿**：`npm run build && npm run typecheck && npm run verify`。测试跟着功能改，
   不许为了让测试过而妥协功能。

## 取证路径（自行复核，不采信本文与调研的自述）

- 根因：`dsh-client-ui-chat/lib/client.js` 的 `isVisibleChatNode`（约 `8335`）与
  `messageDefinition.start`（约 `9868-9922`）；唯一进 store 的调用点是
  `orderedVisibleChatNodes`（约 `8890`）。
- 对标实现：`dsh-client-ui-workflow-run/lib/client.js`（Definition 约 `584-628`，
  注册约 `633-654`）—— 私有 kind + `conversation.chat.node` 渲染器，因此不受过滤。
- 活体槽位：`cordis_inspect_query`（platform `client`，provider `Slots`，method `listSubTree`）
  查 `conversation.chat.node` 的 key 域与占用者，确认新 kind 不撞已有 key。
- 投递侧对照：`~/.dsh/sessions/.../session.v4.jsonl.zstd` 里播报事件**确实落盘** ——
  用来证明"不是投递问题"。
- 真机：`dsh web` 里跑 loop，肉眼确认；以及故意制造一次失败，看判据 2。

## 已知的坑（防呆）

- 客户端 bundle 是**启动时**扫 Loader entries 组图的：改完必须**重启 `dsh web`** 才会被提供，
  `patchReload: live` 只管之后的热更。
- 落在**进行中的回合内**的节点会被「Worked for Xs」折叠吞掉。播报本来就在空闲边界投递
  （`canAppendNoticeNow`），但节点的**位置**要显式落在会话级，不要挂在回合上。
- 节点 kind 是**本包私有**的新名字：不要复用 dsh 已有的 kind（会顶掉它的渲染器）。
- 同一个事件会被多个 Definition 同时匹配，各自成节点、互不干扰 —— 内置的那个不可见 `context`
  节点照旧会存在，这是预期的，不是 bug。
