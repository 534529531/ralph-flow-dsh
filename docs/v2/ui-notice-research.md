# 播报对人类可见：dsh 客户端机制调研

> 为 [ui-notice-brief.md](ui-notice-brief.md) 提供机制取证。本文只记**事实与出处**，不写实现方案。
> 结论都在已安装的 dsh 构建产物上逐行核过（`0.2.1-alpha.1`），路径相对
> `/usr/lib/deepseek-harness/node_modules/@deepseek-ai/`。凡未亲自核实的，在 §7 如实标注。

## 0. 结论摘要

1. **播报不是"不够显眼"，是根本进不了 Chat 时间线。** Chat 客户端有一条硬过滤：
   `kind === "context"` 且不含工具增删的节点**整行丢掉**；而 `source.kind !== "user"` 的
   user/message 一律被归类成 `context`。
2. `source.form === "notice"` + 非空 `summary` **只决定已经可见的 context 行怎么展开**，
   它**不能**让节点免于被过滤。我们（以及 dsh 自己的 `modelSwitchNotice`）过去都以为它可以。
3. 在 dsh 的时间线里，「可见」与「驱动」是**同一根开关**：唤醒 → 被收件箱认领 →
   `turn-trigger` → 可见；纯 append → `context` → 不可见。opencode 有 `noReply` 把两者拆开，
   dsh 没有。
4. dsh 里与驱动器解耦的可见面是**客户端插件**。dsh 自己的 `dsh-client-ui-workflow-run`
   就是注册一个**私有 Chat 节点 kind** + 一个 `conversation.chat.node` 渲染器，因此不受过滤。
5. **人类时间线读 append 事件日志，模型读可替换的 surface** —— 这是 dsh 刻意的设计，
   所以 reset 不会抹掉用户已经看过的对话。这条性质正对本需求。

## 1. 根因：Chat 时间线的可见性规则

```js
// dsh-client-ui-chat/lib/client.js:8335-8337
function isVisibleChatNode(node) {
  return node.visibility === "visible" && node.kind !== "system-prompt"
    && (node.kind !== "context" || node.data.content.some((b) => b.type === "tool-addition" || b.type === "tool-removal"))
    && !(node.kind === "command" && node.data.name === "permission");
}
```

官方文档同义背书（`dsh-client-ui-chat/README.md:45`）：*"Chat omits system-prompt, ordinary
Context injection, and `permission` command rows in every work-details mode. Context containing
tool additions or removals remains visible. The filter changes neither recorded Session events
nor Trajectory inspection."*

**调用点**（`dsh-client-ui-chat/lib/client.js`）：`8395`（Turn 导轨）、`8434`（回合过程布局）、
**`8891` `orderedVisibleChatNodes`（唯一进 store 的入口）**、`11405` / `11650`（分组差分）。
渲染链：`8891` 过滤 → `9376`/`9417` 写 `this.order` → `ChatView` `5759-5764` 直接
`order.map` → `ChatNodeSeat` `1770-1777` 按 `entryKey: routedNode.kind` 派发到
`conversation.chat.node` 槽。

**分类规则**（同文件 `messageDefinition`，`:9868-9922`）：

```js
if (event.data.source.kind !== "user") {
  return { ...contextMessage(event, event.data),      // kind: "context"
           waking: nextTurn?.currentClaimed.has(id) === true || idleSteer };
}
return claimedByNextStep ? { kind: "steering" } : { kind: "user" };   // 两者都可见
```

`buildViewNode`（`:9922`）只在 `context && waking === true` 时把 kind 改成 `turn-trigger`。
`developer/message`（`:9926-9938`）走同一套 context 呈现，**也一样被过滤** —— 能穿过滤的是它
携带的 `tool-addition`/`tool-removal` 内容，不是它的 kind。

⇒ **`{kind:"ralphflow", form:"notice", summary}` 走的正是"被丢掉"那条。** `contextBody` /
`NoticeBody`（`:830-877`、`:709-714`）只被 key `"context"` 的渲染器 `ContextInjectionRow`
（`:909-975`，注册在 `:7408-7412`）使用 —— 而 context 节点根本进不了 `order`，所以那条渲染器
对普通 notice 是死代码。**不存在第二条渲染路径。**

**dsh 自己的例子同样如此**：`dsh-agent/lib/index.js:133-147` 的 `modelSwitchNotice` 由
`dsh-agent-loop/lib/index.js:1061` 以 `surfaceOp:"append"` 落库，从不经收件箱 ⇒ 在 Chat 里看不见。
（`dsh-subagent` 的结算通知是另一个面：父会话**空闲**时走 `followup` → 被 next-turn 认领 →
`turn-trigger` → 可见；**忙**时走 next-step → 不可见。）

## 2. 为什么 dsh 没有 `noReply`（与 opencode 的机制差异）

opencode 版（`/home/yj/.config/opencode/plugins/ralph-flow`，`src/driver.ts:16-17`、`:95-115`）把提示
当**会话消息**投递，靠 `noReply:true` 拿到"既显示、又不启动回合"：头部注释原文
*"Driving the model uses promptAsync (non-blocking); user-facing notes use prompt+noReply."*
它的 `check-voting.ts:164-181` 就是"长耗时验证不让用户以为卡死"的现成配方（每票一行进度）。

**dsh 没有这条二合一通道。** 时间线里：

| 载体 | 唤醒空闲驱动器 | 续收尾中的回合 | 时间线可见 |
|---|---|---|---|
| `agent.steer` | **会**（开新回合） | 会在 step 边界取走 | 会（`turn-trigger`） |
| `inject` / next-step | 不会 | **会**（收件箱非空即续跑） | 不会（被 claim 前不进可见面） |
| 直接 `append` | 不会 | 不会 | **不会**（`context` 被过滤） |

所以过去只能三选二。**破局点在"载体"之外**：让**客户端**去读日志、自己声明一个可见节点。

## 3. 可行路线：私有 Chat 节点（对标 dsh 自己的实现）

`dsh-client-ui-workflow-run` 把"一次顶层 workflow 运行"画成 Chat 里的一等节点，做法：

```js
// dsh-client-ui-workflow-run/lib/client.js:584-628 —— Definition
const workflowRunDefinition = {
  kind: "workflow-run",                       // 私有 kind，同时是 chat node kind
  target: "chat",
  match: (event) => event.type === "tool-workflow/run-start"
    ? { id: String(event.data.runId), role: "start" }
    : (/* agent-start / agent-end / run-end */ { id: String(event.data.runId), role: "update" }),
  start:  (_context, match) => ({ name: match.event.data.name, members: [] }),
  update: (context, match) => /* fold */,
  buildViewNode: (context) => ({
    key: context.key, kind: "workflow-run", id: context.id,
    target: "chat", anchorSeq: context.start.event.seq,
    location: context.start.location, visibility: "visible", data,
  }),
};

// 同文件 :633-654 —— 注册
const inject = ["uiConversation", "uiWorkspace", "slots", "sessions", "locale"];
function apply(ctx) {
  ctx.uiConversation.events.register(workflowRunDefinition);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "…");
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register(
    { name: "conversation.chat.node", key: "workflow-run", locale: NS, inject: () => ({…}) },
    WorkflowRunPanel));
}
```

- `visibility:"visible"` 是"给可见"的唯一开关；引擎只校验 `key === context.key` 与 `target`
  （`dsh-client-ui-conversation/lib/client.js:3115-3119`），其余字段原样透传。
- **私有 kind 因 `kind !== "context"` 在 `isVisibleChatNode` 里短路放行。**
- 活体槽位（`cordis_inspect_query` platform `client` / provider `Slots` / `listSubTree`
  `conversation.chat.node`）实测：该槽是 `keyed`、scope `session`、`replaceRisk:
  "shadows-shipped-ui"`，已占 key 含 `context` / `user` / `steering` / `turn-trigger` /
  `workflow-run` 等；`conversation.session.header.actions`（list，`replaceRisk: none`）现占
  `subagent-catalog`(-30) / `agent-preset`(-10) / `job-list`(20)。
- 一个事件**可以**被多个 Definition 同时匹配（各自成节点、key 不同、互不干扰）—— 所以内置的
  `messageDefinition` 照旧产出那个不可见的 `context` 节点，我们另产出一个可见节点。

## 4. 三条已核实的性质

**(a) 落在回合之间的节点会渲染。** `orderedVisibleChatNodes`（`:8890-8897`）只按 anchor 排序、
不按 location 过滤；非 turn/step 的位置直接给 `{anchor: anchorSeq, rank: 0}`（`:8850-8855`），
位置索引照收（`:8687-8718`）。**唯一威胁**：节点若落在**进行中的回合内**，会被 `turn-process`
折叠吞进「Worked for Xs」（`:1518-1527` 的独立 kind 白名单不含新 kind）。

**(b) reset 不会抹掉用户已看过的行 —— 这是 dsh 刻意的设计。** 原文注释
（`dsh-client-ui-chat/lib/client.js:9500-9508`）：

> *The model-visible surface deliberately shadows replaced ranges, so it is the wrong source for a
> human transcript — a landed replacement would erase conversation the user already saw.
> Append-origin events are that transcript's durable source material; replacement copies stay
> model-only.*

代码对偶：`isAppendSurfaceEvent`（`:9511-9513`）与 `isReplacementSurfaceEvent`（`:9521-9523`）；
`messageDefinition.match` 只收 append（`:9884`）；`dsh-api-session-controller/lib/index.js:1655-1680`
按原始日志切片返回（含被遮蔽者）。

**(c) 这些播报今天并非绝对看不到 —— 在 Trajectory 标签页里。**
`dsh-client-ui-trajectory` 的 `trajectoryMessageDefinition` 匹配**任意** `user/message`（连
`surfaceOp` 都不查），把 context 渲染成可预览的 input cell；该页在本 profile 已挂载
（`dsh --profile web --dump-config` 有 `ui-trajectory`），`developerTools` 默认 true。
**但那是开发者工具，不是给用户的地方** —— 它只说明"投递没问题，是 Chat 的渲染规则挡住了"。

## 5. 否决的路线（逐条带致命证据）

| 路线 | 判决 | 致命证据 |
|---|---|---|
| **`ctx.jobs`**（把每轮注册成 job，复用会话头 job 控件） | ❌ 否决 | 结算时 `dsh-tool-jobs/lib/index.js:269` 之后对空闲 owner 走 `owner.followup(message)` ⇒ **唤醒驱动器**，正是 v1.2 修好的那个 bug。唯一压制手段是让结算变成 `awaited`（插件挂一个 live `ctx.jobs.wait`，`dsh-jobs-local/lib/index.js:510`/`:753`），但 wait 受 deadline 封顶，**超时与结算之间的竞态仍会唤醒**；省略 owner 则 `dsh-jobs-local/lib/index.js:493-494` 让该 job 出现在**每个**会话的列表里（串台） |
| **`source.kind` 改成 `"user"`** | ⚠️ 只配当临时退路 | 会渲染成**冒名用户气泡**（`:9905-9925`）；不触发回声去重（`observedInputs` 要求 `source.rpcId`，`:5703-5717`），但会更新 `lastInputTurn` 并进入导轨的 prompt 预览（`:8373-8377`）—— 语义上冒充人类输入 |
| **命令生命周期当载体**（`ctx.commands.execute`） | ⚠️ 技术上可行、语义上是挪用 | `dsh-commands/lib/index.js:419-421` 用**裸 `session.append`、无 `surfaceOp`** ⇒ 不是 surface 事件（模型看不到、不唤回合），客户端 `commandDefinition` 会渲染成一行可展开卡片（`GenericCommandCard`，`dsh-client-ui-chat:6668-6700`；标题=命令名、摘要=返回文本、error 变红）。**但**命令子系统自称只服务人类输入（`dsh-commands/lib/types/types.d.ts:65-77`：*"every executor caller is a human-facing UI surface dispatching a human-typed line, so the sole variant is `user`"*），且会多出一个用户可见命令 |
| **`SessionTitleService.rename`** | ⚠️ 只能当旁路环境信号 | 宿主公开 API（`dsh-session-title/lib/types/index.d.ts:135`），日志-only、不进模型输入，页头 + 侧栏 + **浏览器标签**都能看到。代价：`rename` 会把标题**钉死**（后续自动命名不再更新），且它本属于用户 |
| **文件产物 / `deliverables`** | ❌ 不可作播报 | `dsh-tool-present/lib/index.js:84-118` 强制要求**开着的回合**且文件真实存在；空闲窗口直接 append 不会被渲染 |

## 6. 现有验收的缺陷（这条缺陷能活到今天的原因）

- [`scripts/visibility-test.mjs`](../../scripts/visibility-test.mjs) 断言的是
  `source.form === "notice"` + 非空 `summary` —— **「成为可见面节点」而不是「用户看得见」**。
  于是 20 支套件全绿，用户在 Chat 里什么都看不到。
- 仓库三处写着"用户可见性与 kind 无关"，与 `0.2.1-alpha.1` 的代码直接冲突：
  [`src/message-source.ts`](../../src/message-source.ts) 的注释、
  [`docs/v2/design.md`](design.md) §3 的载体映射表、
  [`docs/how-it-works.md`](../how-it-works.md) 的会话事件表。
- [`docs/v2/evidence/summary-hardening.md`](evidence/summary-hardening.md) 自己承认过那次可见性修复
  "未获独立验证、需实机确认"—— 这次是那条欠账到期。

## 7. 未核实 / 待真机确认

- **没有浏览器 DOM 证据。** §1–§4 全部来自已构建 bundle、官方 README 与活体槽位查询；
  "私有 kind 的节点在真实页面上长什么样、位置对不对"未在 GUI 里看过。
- **reset 之后的行为**依据的是源码注释 + controller 的日志切片（§4b），**未在真机上跑一次
  "失败 → 重置 → 返工"** 去确认旧行确实还在。
- 未逐一核实 dsh 其它包（goal / jobs / plan-mode 等）的 notice 走的是 inject 还是收件箱，
  只抽样了 `modelSwitchNotice` 与 `dsh-subagent` 的结算通知。
- 私有 kind 需要 TS 类型增补（`ChatNodeKind` / `ChatNodeDataMap` 是 declaration-merged 的）；
  若客户端半边写成纯 JS（照 `templates/decoration/` 的形状）则不涉及，但那时类型闸就没了。
