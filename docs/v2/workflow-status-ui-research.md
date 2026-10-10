# 当前会话的工作流状态可视化：机制调研与建议

调研日期：2026-10-10。范围是方案与取证；本次没有实现产品代码，也没有调用模型。

**建议在 Chat 输入框上方放一张可折叠状态卡，页头放一个紧凑状态徽章。** dsh 已有这两个公开扩展位置，无需修改 dsh 本体。实时数据应由 Ralph Flow 引擎提供只读快照，经插件自己的 typed Remote 流送到浏览器；不要把每次状态变化写成模型消息，也不要新增自定义 SessionEvent。

## 1. 取证版本与证据边界

- 本机 `dsh`、`dsh-client-ui-conversation`、`dsh-client-ui-session`、`dsh-session-projection`、`dsh-api-session-controller` 的 `package.json` 均为 **0.2.1-alpha.1**。源码证据来自 `/usr/lib/deepseek-harness/node_modules/@deepseek-ai/` 下的实际构建产物、类型声明与随包 README。
- 已读取官方 [Slots 文档](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots)、[Typert 文档](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/typert)、[Session Projections 文档](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-projection)，以及 [官方架构源码文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)。官方文档用于核对扩展方向，精确名称与运行限制以本机版本为准。
- 官方网页仍出现 `dsh-client-runtime`、`session/projection` 等描述；本机对象层在 `dsh-api-session-controller/client` 中，实际协议是 `SessionFollowFrame`、`SessionControlFrame`。不能据网页旧名编造 `sessionState` / `sessionNode` 推送接口。
- 前次播报机制见 [ui-notice-research.md](/home/yj/ralph-flow-dsh/docs/v2/ui-notice-research.md)；真机播报验收见 [ui-notice.md](/home/yj/ralph-flow-dsh/docs/v2/evidence/ui-notice.md)。那次只证明 notice 可见，**不证明新的固定状态卡或 Remote 流已经工作**。

## 2. dsh 可以放在哪里

| 位置 | 本机公开契约 | 适合用途与限制 |
|---|---|---|
| `conversation.input.dock` | `list`、`session`，输入卡上方的整宽条目 | **主推荐**：两行摘要，展开流程步骤与验证票。内置 Todo 与 Goal 已使用它；选择独立 `id` 并通过 `ctx.slots.inject` 注册。 |
| `conversation.session.header.actions` | `list`、`session`，标题旁控件 | 紧凑徽章：当前步、暂停/审查提示；审批接管输入框时仍可作为入口。窄屏不可塞整棵步骤树。 |
| `conversation.composer.dock` | `list`、`session`，输入卡下方条目 | 可放很短的环境状态；位置较弱，输入组件部分变体不渲染它，不建议作唯一可见面。 |
| `sidebar.right.pane.tab` | session keyed body；另有 `ctx.sidebarRightTabs.register` 注册页型 | 适合后续较大的完整流程树、历史运行、产物列表；侧栏可能折叠，不适合作唯一入口。 |
| `conversation.view` | `list`、`session`，一次选中一个 View | 可以新增 Workflow 标签，但要离开当前 Chat 才能看完整内容，不满足持续看状态的主要诉求。 |
| `conversation.chat.node` | 私有 keyed renderer + Conversation Definition | 适合既有生命周期播报/历史记录；记录会随时间线滚走，不能替代常驻当前状态。 |

证据：

- 槽名、基数、作用域与位置语义：[slots.d.ts:119](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:119)，重点为 155–164、184–193、213–228。
- 实际位置：[conversation/client.js:21128](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:21128) 把 input dock 放在 composer stack；21163–21166 显示 composer 与 Views 同处滚动容器。**粘附来自 CSS**：同文件 20624 的 active 布局令 `composerSeat` 为 `position:sticky; bottom:0`，不是另造页面固定区域。
- 输入接管：[conversation/client.js:21140](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:21140) 是 `conversation.composer` chain、`overlay:true`。审批等接管可能遮住默认输入区，状态卡不能承诺任何模式下始终完整可见。
- 页头渲染：[conversation/client.js:21325](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:21325)。`header.corner` 为 single 且内置右侧栏已经使用，避免占用它。
- 原生参照：[TodoDock:22566](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:22566) 读取 `useProjection("todos")`；[GoalDock 注册:554](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-goal/lib/client.js:554) 使用同一 input dock，私有 `inject.hooks` 提供状态 source。
- 侧栏扩展：[sidebar-right/README.md:81](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/README.md:81) 的 type 注册 + keyed body 两步；74 的布局持久化按 sessionId 分开，**布局存储不等于业务状态存储**。

没有核实到一个可以随意插入整宽状态栏的 `session.top` / `session.bottom` 槽。公开的 single 位置是替换点，不能把整块 Conversation Header/Composer 替换掉当作普通增补。

## 3. 推荐的数据通道：引擎只读快照 + 插件 Remote 流

### 已确认的宿主能力

宿主 Service 可以继承 `TypertRemoteService`，使用 `@Remote` 暴露只读查询；流方法使用 `@Remote({ mode: 'stream' })`，返回 `AsyncIterable` / `RemoteStream<Out>`。浏览器通过 `ctx.remote.$mount()` 装配对应的生成贡献，再调用该 namespace 的方法。逻辑流复用 dsh 的 Remote mux，不需要自己开放 HTTP 服务器或 WebSocket。

本机证据：[protocol/index.d.ts:64](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.d.ts:64)、[gateway/README.md:27](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-api-gateway/README.md:27)、35、52–60。`ctx.remote.$stream()` 负责跨 carrier generation 重开；[RemoteSnapshotStream:4](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/client/snapshot-stream.d.ts:4) 定义 opening snapshot → updates、原子 replace、failure、restart 与 dispose。订阅注入应返回稳定 `getSnapshot` / `subscribe` source，由 slot renderer 绑定成 hook；组件不接收 Cordis `ctx`。参照 [renderer/README.md:36](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-renderer/README.md:36) 与 [Goal activation source:20](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-goal/lib/client.js:20)。

**不能直接写 `ctx.remote.$on("ralphflow/status-changed")` 就认为收到推送。** 本机应用的 forwarded event 名单在 `dsh-api-remotes` 内固定，新增 `ctx.emit` 不会自动入网；替换宿主的唯一 `$events` 来源又会影响原生事件。证据：[remotes/README.md:43](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-api-remotes/README.md:43)、75–77；[gateway/README.md:43](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-api-gateway/README.md:43)、62。因此选插件自己导出的只读流，不依赖新增宿主 forwarded event。

### 建议装配（待实施）

```text
现有 state.json + workflow 定义 + 引擎在飞任务事实
               ↓ 只读派生，不获得推进权
引擎状态读取面 / 变更订阅（需要新增，当前不存在）
               ↓
插件自有 typed Remote 查询与流
每次连接先完整快照，再按实例/属主发送完整替换值
               ↓
客户端按 sessionId 的稳定 observable
               ↓
input.dock 状态卡 + header.actions 徽章
```

1. 以现有引擎为唯一事实源，增加只读读取与变化订阅。卡片状态是派生展示，不向 `state.json` 写入新的 `phase` / 进度百分比 / 完成勾选。
2. 订阅时先建立监听再取同一稳定切面的完整快照，避免“首读与开始监听之间”丢更新。第一版发送小的完整快照即可，不必维护复杂增量 patch。流 generation / 发布 revision 属传输排序，不能当业务失败计数或推进事实。
3. 发布点不能只机械包住 `writeState`。`complete` 直接归档内存终态再销毁；cancel、恢复、属主转移、异步 reset 门也有独立边界。每次成功落账/生命周期收尾之后通知只读 source，观察错误不能改变验证结果或中断工作流。
4. 当前 `writeState` 捕获写盘异常只记 warning。必须能区分写入是否成功，不能把未持久化的新内存值发布成“已确认状态”；异常时显示同步/持久化错误，保留最后确认值。
5. 断线保留最后快照并标“连接中断/重新同步”，重连必须重读完整快照；不能把上次收到的状态继续当实时。流关闭、会话切换、插件卸载须释放监听与迭代器，迟到结果以 session binding / generation 检查丢弃。
6. 输入卡与页头共享同一 session source，避免重复请求和不同步。只有 owner 会话显示活跃卡；接管要清除旧属主、立即更新新属主，fork 不能把继承日志当作自己仍在运行。

**构建缺口仍需最小 spike**：本仓库当前是 `tsc + esbuild`，没有生成 Host/Client Remote artifacts 的构建步骤（[package.json](/home/yj/ralph-flow-dsh/package.json)、[build-client.mjs](/home/yj/ralph-flow-dsh/scripts/build-client.mjs)）。需要核对外部插件产物生成、Host 注册与 Client `$mount`、输入 codec/lookup 的会话读取授权，以及卸载/重连行为。上述公共能力已取证，**本仓库的这条完整装配尚未真机验证**。spike 可用确定性假状态零模型调用完成。

## 4. 为什么不直接使用 Session Projection

`ctx.sessionProjections.register()` 与 slot 标准 `useProjection(key)` 是真实的一等机制：宿主从 SessionEvent 纯 fold 得到状态，并通过 opening baseline 与带 sessionId/key/seq 的更新发送到客户端。[projection/index.d.ts:30](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:30) 要求同步纯转换；[ui-session/index.d.ts:77](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-session/lib/types/client/index.d.ts:77) 提供 `useProjection`；[controller/types.d.ts:515](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts:515) 定义 snapshot/control baseline 与投影帧；[controller/client.js:1537](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js:1537) 按 seq 防旧快照覆盖新值，1661 清除旧 Host generation。

但 Ralph Flow 的业务状态在自己的 `state.json`，现有 notice 只是人类播报；**事件 fold 不会自动观察文件写入**。在 `apply` 中偷偷 `readState()` 会破坏纯重放与一致切面。新增 `ralphflow/status` SessionEvent 则违反 [设计宪法第 6 条](/home/yj/ralph-flow-dsh/docs/v2/design.md:197)。不能因为宿主允许 merge-extensible events 就跳过本项目禁令。

备选是在既有 `user/message` notice 上携带完整状态 metadata，再 fold 为投影。它保持 native event type，但 notice 按安全步骤边界挂起，不能表示每个即时执行态；若为了更新状态另外 append 消息，又会改变模型 surface 与投递台账。前次 [notice 安全门](/home/yj/ralph-flow-dsh/src/index.ts:102) 明确禁止劈开工具调用/结果。该备选可支持稀疏历史索引，**不作为实时状态通道**。

原生 `workflow-run` 卡只消费 `tool-workflow/run-start` 等自有事件家族（[workflow-run/client.js:584](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-client-ui-workflow-run/lib/client.js:584)），不会认识 Ralph Flow 的实例状态。不能伪造那套生命周期来冒充内置 workflow。

## 5. 卡片应该显示哪些可靠事实

建议的默认折叠态（示意，未实现）：

```text
Ralph Flow · spec
当前 implement · 独立验证中
本步未通过 1 / 3     验证 2 / 4 已返回
▸ 展开步骤与本轮验证
```

执行阶段显示“待交卷”；只有正在验证时显示本轮票数。暂停时摘要换成具体原因与下一行动，审查门明确“等待你放行”。宿主模型是否运行用独立辅标，不把 `do_submitted=false` 误说成模型正在工作。

| 展示项 | 已有事实与正确口径 |
|---|---|
| 工作流、当前步、任务 | `workflow_name`、`current_step`、`user_task`；[InstanceState:843](/home/yj/ralph-flow-dsh/src/engine.ts:843)。 |
| 当前步失败预算 | `fail_counts[current_step]` 对应步的 max；通过、显式恢复/rewind 会按现有语义清预算。显示“本步未通过 n/max”，不要改名成整个运行累计失败。 |
| 本轮验证 | 当前轮 `delegations`、`verdicts`，显示在飞/已返回/通过/未通过/验证者故障。每票不能当一次工作失败，唯一聚合结果才决定失败预算。 |
| 运行/暂停/审查/切换中 | 只读派生 `active`、`paused/pause_reason`、`do_submitted`、工作流 manual gate、已有判定与进程在飞事实；参考 [phaseLabel/nextActionHint:4130](/home/yj/ralph-flow-dsh/src/engine.ts:4130)，不可照搬 `do_submitted=true` 一律“待放行”。 |
| 展开步骤 | 根据 workflow 拓扑/子步骤和当前事实渲染；不能把当前位置 `index/总步数` 当完成百分比。回退分支、rewind、嵌套展开会让位置变化。缺少历史证据时显示未知，不画虚假完成勾选。 |
| 历史失败 | `history` 只保留 200 条；执行日志会轮转。首版不承诺无限完整的累计次数。可展示最近已记录失败与原因，完整累计口径留正式任务书设计。 |

业务证据：[writeState:2025](/home/yj/ralph-flow-dsh/src/engine.ts:2025)、[失败预算/history:2058](/home/yj/ralph-flow-dsh/src/engine.ts:2058)、[验证票与 infra 重试:2511](/home/yj/ralph-flow-dsh/src/engine.ts:2511)、[voter_verdict:2602](/home/yj/ralph-flow-dsh/src/engine.ts:2602)、[聚合失败:2635](/home/yj/ralph-flow-dsh/src/engine.ts:2635)、[advance:2798](/home/yj/ralph-flow-dsh/src/engine.ts:2798)、[reset DO 挂起:3114](/home/yj/ralph-flow-dsh/src/engine.ts:3114)、[属主接管:3602](/home/yj/ralph-flow-dsh/src/engine.ts:3602)。

本次另一纯内存探针调用现有构建的 `stepStats`：同轮两条失败 `voter_verdict` 加一条聚合 `verdict_failed` 得到失败轮数 **1**，随后通过并清预算得到当前预算 **0**；把这次失败挤出 200 条 history 窗口后，重算历史失败变成 **0**。多票重复计数在现有实现已规避，长期完整累计仍受截断限制。

## 6. 刷新后的终态与会话隔离

活跃状态可以从引擎文件恢复，但结束后文件会被删除：[complete:2841](/home/yj/ralph-flow-dsh/src/engine.ts:2841)、[destroyInstance:3239](/home/yj/ralph-flow-dsh/src/engine.ts:3239)。内存里保留一张“已完成”卡不够，刷新或进程重启会丢。报告是已有永久归档，但[报告头:3181](/home/yj/ralph-flow-dsh/src/engine.ts:3181) 没有完整 owner_session，不能拿工作区“最新报告”猜当前会话最后一次运行。

建议给**已经会投递的**完成/取消等生命周期 notice 的 `source` 添加版本化 `runId/reportRef` 索引 metadata：只扩展本插件声明的来源结构，不新增事件类型，不额外发送消息，不改 content/summary/surfaceOp。只读查询据本会话自己的 append-origin 记录关联归档报告；fork 的 inherited prefix 必须排除为当前会话运行，或明确标成继承历史。新活跃运行优先，历史终态折叠为上一运行的报告入口。

可行性证据：[MessageSourceMap:94](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:94) 是生产者自有 merge-extensible sum type；[snapshotSessionEvent:1106](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-session/lib/index.js:1106) 对事件 structuredClone、消息整对象冻结，不裁剪 source 子字段；[pi-ai textOnlyContext:1290](/usr/lib/deepseek-harness/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1290) 构造模型 user 消息只取 content，不把自有 source metadata 序列化进去。

本次做过一次**真实库内存探针**：`createUserMessage` → `snapshotSessionEvent`，附加 source `uiRef:{v:1,runId,reportRef}`，结果 `sourceRefPreserved=true`、`deepFrozen=true`、`contentUnchanged=true`。没有向任何真实会话 append。JSONL 落盘/冷读、图像分支、压缩/导出、报告引用授权和路径校验仍需下一次 spike 完整 roundtrip。旧 notice 无索引时显示“历史关联暂不可用”，不能靠中文摘要正则冒充可靠索引。

## 7. 下一步先验证通道，再落实任务书

先做最小机制 spike：当前插件 bundle 装配一个只读 Remote 查询/流，用确定性状态模拟新运行、换步、一次失败、2/4 票、暂停、完成、属主转移；输入区与页头各读一个稳定 source。核验外部 Remote 产物生成与会话授权、断线取消/重连 baseline，并对已有 source metadata 做真实 JSONL 冷读。通过后再写正式 brief，把终态索引、展示口径与生命周期发布点定死。

正式完成判据应包含：

1. **真机 Chat 可见**：正常启动 `dsh web`，在当前会话真实 DOM/截图看到 input dock 卡；长 Chat 向上滚动仍可见，展开/收起可用。审批接管时页头状态入口仍可见；无实例会话不出现空卡。
2. **状态变化准确**：真实引擎路径依次覆盖执行→交卷→验证票更新→失败返工→暂停/审查门→放行→终态。比较 DOM 与引擎事实；多票一次失败只增加一次预算，infra 重试区别标识，回退不输出假的百分比。写盘失败不得发布新确认值。
3. **恢复与隔离**：刷新、断线期间状态改变后重连、宿主重启、reset 模型面、A/B 会话切换、接管与 fork；断线要有陈旧标记，基线原子覆盖，旧 owner 清卡，完成/取消后刷新仍正确关联该会话的报告。禁止按全局最近实例/报告串台。
4. **负对照**：同一真实 workflow 和同一 DOM 断言，移除状态客户端注册后必须失败；恢复后通过。另停掉推送路径验证实时变化断言会失败，保留 initial snapshot 不能掩盖实时通道缺失。
5. **行为隔离**：观察与展开 UI 不追加模型消息、不唤醒 AgentLoop、不创建验证者、不更改 state/判定/推进；关闭卡、切换会话与卸载释放订阅。模型请求和会话投递台账与基线一致。

当前结论是**公开 UI 位置与只读流机制足够支持该方案，具体产品实现和真机状态链仍待下一步验证**。本轮只新增这份调研文档。

后续实施：作者于本轮调研后批准继续，已按本机公开机制落地；新的真机结果与边界见 [ui-status.md](evidence/ui-status.md)。上述“待实施”描述保留为调研时点记录。
