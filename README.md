# Ralph Flow for DeepSeek Harness (dsh)

> **npm:** [`ralphflow-dsh`](https://www.npmjs.com/package/ralphflow-dsh) · **源码:** [github.com/534529531/ralph-flow-dsh](https://github.com/534529531/ralph-flow-dsh) · 上游: [github.com/534529531/ralph-flow](https://github.com/534529531/ralph-flow)

> 插件名 **ralphflow** —— slash 命令与工具命名和 opencode 版**一字不差**，opencode 用户零学习成本。
> 目标：把 ralphflow 的 DO/CHECK 状态机工作流引擎做成 dsh 的原生插件，像 dsh 本来就有的功能。

## 这是什么

dsh 版的 ralphflow：同一个 DO → CHECK → 人工门 → 验证 → 报告 状态机，但 UI 全部是 dsh 原生形态（对话内嵌卡 + 页头入口），不引入独立大页面（无 Studio/Dashboard/Runs 表格页）。

- 插件名：`ralphflow`
- slash 命令：`/ralphflow-start` `/ralphflow-continue` `/ralphflow-status` `/ralphflow-list` `/ralphflow-cancel` `/ralphflow-rewind` `/ralphflow-reset` `/ralphflow-doctor` `/ralphflow-unbrick`
- 工具：`ralphflow_start` `ralphflow_continue` `ralphflow_status` `ralphflow_list` `ralphflow_cancel` `ralphflow_rewind` `ralphflow_reset` `ralphflow_doctor` `ralphflow_create` `ralphflow_unbrick`（10 个，除 create/unbrick 外与 opencode 同名同参）
- 工作流快捷命令：`/loop` `/spec` 等（按工作流目录动态注册）

## 安装

### 从 npm 安装（发布后）

```bash
dsh plugin --profile web add ralphflow-dsh   # pnpm 从 registry 解析并装入 profile
```

然后照常三步：`cordis.patch.yml` 追加 `insert: [{ id: ralphflow, name: ralphflow-dsh }]`，重启 dsh。npm 包名 `ralphflow-dsh`（`ralphflow` 已被其它项目占用）；插件名保持 `ralphflow`（命令/工具命名与 opencode 版一致）。

### 本地源码安装

构建产物在 `lib/`（host: `lib/index.js`，client: `lib/client/client.js`）。

```bash
cd ~/ralph-flow-dsh
npm install            # 安装构建依赖
npm run build          # 产出 lib/（host 端 tsc + client 端 esbuild bundle）
```

构建分两步：`build:host`（tsc 编译 host 引擎）与 `build:client`（`scripts/build-client.mjs` 用 esbuild 把 `src/client/**` 打成 dsh 官方 client bundle 单文件 `lib/client.js`）。client bundle 格式与官方 `@deepseek-ai/dsh-client-ui-workflow-run/lib/client.js` 同构：`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，外部依赖（react、`@deepseek-ai/*`）走 factory 参数 `require` 由 dsh 浏览器运行时解析，不做任何跨插件值导入。

把插件装进 dsh profile（以 web profile 为例）并启用：

```bash
# 1) 安装到 profile（pnpm link，包名 ralphflow-dsh）
dsh plugin --profile web add ~/ralph-flow-dsh

# 2) 在 ~/.dsh/profiles/web/cordis.patch.yml 里追加：
#    - insert:
#        - id: ralphflow
#          name: ralphflow-dsh

# 3) 重启 dsh
dsh --profile web
```

插件加载验证：dsh 启动后浏览器控制台 Network 面板可见 `/plugins/ralphflow/client.js`（client 端组合成功）；对话里执行 `/ralphflow-list` 能列出工作流即 host 端就绪。

### 可重复验证（无模型也可跑）

模型配额 429 时，真实模型链路（DO 执行 / 验证者 subagent）无法在线跑通。除引擎层等价脚本外，还有**真实 dsh 运行时**与**真实浏览器**验证：

```bash
npm run build

# A. 真实 dsh 进程内端到端（真实 ctx + 真实 ralphflow_start 工具 + 真实落盘 + 重启接管 + 权限）
RALPHFLOW_WORKSPACE=/home/yj/ralph-flow-dsh dsh --profile headless-e2e "noop"
#  → 结果在 e2e-harness/result.json（33 项断言，真实 dsh 运行时）

# B. 真实 chromium 浏览器 UI（client.js 加载 + 渲染 + 截图）
dsh --profile web &        # 先启动 web（建议 RALPHFLOW_WORKSPACE=<插件工作区> 指定工作流目录）
node e2e-harness/ui-browser.mjs
#  → 结果在 e2e-harness/ui-result.json + ui-home.png

# B2. 真实浏览器执行 slash 命令（补全面板点选 /ralphflow-list → 输出渲染 diff）
node e2e-harness/ui-cmd-browser.mjs
#  → 结果在 e2e-harness/cmd-ui-result.json + cmd-ui-after.png

# C. 引擎层/折叠逻辑单元级补充（不依赖模型）
node --experimental-strip-types smoke-host.mts
node --experimental-strip-types smoke-client.mts
node --experimental-strip-types e2e-verify.mts
node --experimental-strip-types ui-verify.mts
```

`headless-e2e` 是一个专门用于验证的 dsh profile（bundle 同 headless，patch 注入 ralphflow + e2e-harness）；`e2e-harness/` 是真实 cordis/dsh 插件，在真实 dsh 进程内通过真实 `ctx.tools` 调用 `ralphflow_start` 创建真实实例并推进。完整报告见工作流产出 `verification.md`。

### 依赖解析说明

本插件 peerDependencies 指向 dsh 官方包（`@deepseek-ai/dsh-*`，版本 `^0.1.0-rc.7`）。这些包随 dsh 一起安装于 `/usr/lib/deepseek-harness/node_modules/@deepseek-ai/`。构建时若 npm 无法解析，可用符号链接指向 dsh 自带包：

```bash
mkdir -p node_modules
ln -s /usr/lib/deepseek-harness/node_modules/@deepseek-ai node_modules/@deepseek-ai
ln -s /usr/lib/deepseek-harness/node_modules/cordis node_modules/cordis
ln -s /usr/lib/deepseek-harness/node_modules/react node_modules/react
```

## 使用

```text
/ralphflow-start loop 用 JWT 实现用户认证模块
/ralphflow-start spec 修复登录模块的空指针
/ralphflow-continue            # 批准人工审查 / 恢复暂停 / 接管实例
/ralphflow-status              # 查看进度
/ralphflow-list                # 工作流 + 活跃实例
/ralphflow-rewind propose 第二步的技术文档 API 假设错了，重新设计
/ralphflow-reset 模型跑偏了，换干净上下文重做当前步
/ralphflow-cancel              # 取消并归档报告
/ralphflow-doctor              # 诊断工作流定义与实例状态（含会话卫生检查）
/ralphflow-unbrick             # 会话解砖（备份并移除会话日志中的插件自定义帧）
```

- 启动后模型在对话里执行 DO；完成时输出 `<promise>done</promise>`，后台 job 自动转入独立验证（多验证者投票）。
- 实时 UI 挂在**页面顶部 Ralph Flow 入口**（HTTP 状态通道轮询，2.5s 刷新）：活跃/待审查/已暂停徽标（trigger 微缩含当前步骤与耗时）、任务列表（「待处理」与「运行中」分区）、验证票进度（本地化状态 + 语义色 + 票飞行时长）、**CHECK 剩余时间进度条**（超时上限给了等待一个终点）、失败原因全文、暂停原因、审查材料、属主；审查门可**一键通过**（POST 直连 host），打回附意见内联发送后模型带意见返工，暂停实例直接「继续」恢复，**取消**两步确认防误触；「已结束」区带**报告按钮**直接打开最终报告。
- 通知是**全局模块级监视**（不依赖任何页面组件）：审查门到达 / 暂停 / 完成都弹系统通知 + 标题闪烁，任意页面（含空态页）都提醒；历史完成记录预填游标，切页/刷新不历史轰炸；同标签去重（sessionStorage）+ 跨标签协调（localStorage 短窗口），多开标签页只响一次。
- 命令结果卡折叠**官方 `command/run` + `command/done` 事件**渲染在对话流（宿主动态词汇表成员，持久化安全）——插件不再向会话日志写任何自定义帧（第三方自定义事件类型无 ignorable 逃生门，落盘会让整个会话无法加载，历史版本因此砖过会话，`/ralphflow-unbrick` 一键修复）。
- 人工审查门（`manual_step`）的步骤：DO 完成后停下，页头徽标变「待审查」，在抽屉点「通过」或 `/ralphflow-continue` 批准后进入验证。
- 跨会话/重启后：任何会话 `/ralphflow-continue` 可接管实例；插件加载时自动扫描实例目录恢复任务视图（影子 registry）。

## 与 opencode 版的功能对照

| 能力 | opencode 版 | dsh 版（本插件） |
|---|---|---|
| 命令/工具命名 | `/ralphflow-*` + `ralphflow_*` | 完全一致 |
| DO/CHECK 状态机 | 引擎驱动 | 引擎移植复用，驱动换 dsh jobs + 会话事件流 |
| 多验证者投票 | `check_voting` 并行投票 | 相同，验证者改 dsh 子代理 |
| 人工审查门 | `manual_step` 暂停等待 | 相同，抽屉一键通过/打回（POST 直连） |
| 实例持久化 | `.opencode/ralph-flow/instances/` | `<workspace>/ralph-flow/instances/`（同布局） |
| 跨会话接管 | 任意会话 continue | 相同（jobs + 影子 registry） |
| 崩溃恢复 | idle 重跑 + 孤儿清理 | job 重建 + 状态文件恢复 |
| UI | TUI + 自绘 | dsh 原生插槽：页头任务列表 + 对话内命令结果卡（官方 command/done 事件折叠） |
| 主题 | 自绘 | dsh `--dsw-*` token |
| 独立大页面（Studio/Dashboard 等） | 有（原型） | **无**（评审结论：会话中心不引入全局面板） |

## 对 plugin-design.md 的实现偏离（留痕）

0. **2025-08 dsh 契合度修复批次**（诊断 + 修复，目标：完美契合 dsh 的 ralphflow）：
   - **会话砖化根除**：移除命令路径的 `session.append("tool-ralphflow/command-result")`（宿主持久化读路径只认 KNOWN_SESSION_EVENT_TYPES，第三方自定义类型落盘后整个会话拒绝加载，无 ignorable 逃生门——历史因此砖过两个真实会话，`~/.dsh/unbrick-backup-*` 有备份为证）。命令结果卡改为折叠宿主自动追加的官方已知类型 `command/run` + `command/done`（dsh-commands 的 execute 生命周期，落盘重放安全）。
   - **抽屉中心化**：run 帧通道废弃后对话内不再折叠 run 卡——通知/快照/审批全部迁到页头任务列表（HTTP 状态通道数据源）：审查门/暂停/完成到达弹系统通知 + 标题闪烁（全局模块级监视，不依赖组件挂载；sessionStorage 去重 + localStorage 跨标签协调）、「通过/继续/取消（两步确认）」POST 直连 host 动作端点（webServer 路由，逻辑抽到 actions.ts 可单测）、「打回」抽屉内联意见发送、CHECK 剩余时间进度条（timeoutMs/checkStartedAt 透出）、验证票本地化状态 + 飞行时长（voterProgress 带 startedAt）、「状态详情」抽屉展开（任务/审查材料/失败原因全文/属主）、「已结束」区报告按钮（recentEnded 带 reportPath）。回退守卫：POST 失败自动退回命令注入链路。
   - **会话卫生自愈**：新增 `ralphflow_unbrick` 工具 + `/ralphflow-unbrick` 命令（备份后按 dsh 多帧 zstd 格式重写，自实现不依赖外部脚本）；`/ralphflow-doctor` 增加会话卫生节 + 资源占用节（reports/artifacts/instances/history/logs 增长报告）。
   - **成本与安全**：DO/CHECK prompt 长文本截断（任务 4k / 步骤正文 8k / 输入输出 2k，截断处明确标注）；markdown 链接协议白名单（https/mailto/file/相对路径，拒绝 javascript:/data:）；删除死导出 `RALPH_CHECK_AGENT_PERMISSION`；`get_agent_missing_session` 降噪为 info（影子恢复的正常降级）。
   - **文案对齐**：ONBOARDING/README/对照表改为抽屉 + 命令卡的真实能力描述。
   - HTTP GET 通道 payload 增加 `workflows`（命令卡折叠器识别 /loop /spec）与 `recentEnded`（完成通知与报告按钮数据源）。

0b. **2025-08 UX 评审修复批次**（4 路独立评审：对齐/用户旅程/健壮性/UI，汇总 40+ 问题后迭代）：
   - **人工审查门接线修复**：此前 jobs 检测的是恒不存在的 `.manual-gate` → manual 步 DO 完成后直接自动进验证，门形同虚设；且 gate 卡在步骤开始前就弹出并谎称「DO 已完成」。现改为：DO 完成检测点真实写 `.manual-gate` + 发 gate 帧 + 停下等待；推进预告只提示「完成后会停下等你审查」；`e2e-verify.mts` 的伪断言替换为 stub 验证者驱动的全链路真断言。
   - **「验证进行中」防线生效**：`.adversarial-session` 此前从未被写入（读侧防线全部恒假）。现在每个验证者子代理启动/结束时登记/移除该文件——CHECK 运行中不再被重复触发或误判为崩溃恢复。
   - **终态帧可达**：实例销毁后 report/run-end 帧因读不到 state.json 属主而被静默丢弃（UI 永远停在旧状态）。新增 `emitFinal(instId, owner, ...)` 在销毁前锁定属主会话发送。
   - **审批按钮行为拆分**：「✗ 打回」此前与「✓ 通过」绑定同一动作。现打回填入 `/ralphflow-reset `（附意见回车返工）、通过填入 `/ralphflow-continue` 并尝试代提交；两种结果都有可见反馈，绝不静默。命令错误结果同样发可见卡（error 视觉态），不再落入不可见的日志行。
   - 其余：no_check 步骤保留直通（不再静默丢弃）；continue 的 paused/crash/attach 分支补齐子工作流重入；status 输出对齐 opencode 版信息量（属主/最后活动/失败原因全文/投票进度/友好暂停文案）；start 空 task 拒绝 + 启动引导块；实例级互斥锁（双会话并发 continue 串行化）；cancel 真正中止在飞验证者（AbortSignal registry）并补日志/kill job；writeVotingProgress 防复活已销毁目录；崩溃重启后 continue 保留已投出的票只补跑；doctor 移除幽灵命令引用与占位符泄漏；client 终态冻结/verdict upsert 幂等/runId 丢帧/虚构 token 修正/条件 hook 修复/页头徽标状态换色/任务行改传实例 id。
   - **create 双端落地**：dsh 命令通道 log-only（never model surface，见 dsh-commands "without sending it to the model"），opencode 式模板命令无注入模型的通道。改为：host 工具 `ralphflow_create` 承载完整设计指引（模型被调用后引导用户设计 YAML 并 doctor 校验），`/ralphflow-create [想法]` 命令作用户侧入口（展示如何唤起模型 + 引导卡）。
   - **卡片运行耗时**：step-start 帧携带 `ts` 时间戳，client 折叠为 `stepStartedAt`，卡片头部显示当前步骤「⏱ 已运行 Xm」。
   - **i18n 补全**：HeaderAction 状态标签与 aria 接入 locale 词典（zh/en status.* 键），RunCard/HeaderAction 均接收 slot 注入的 `t`。

1. **reset/rewind 的"换新会话"语义**：设计稿提出复用 opencode 的"新顶级会话"路径；实现改为工具返回完整过渡文本、在当前会话继续重做。理由：dsh 没有 opencode 的 TUI session 导航；跨会话接管由 `/ralphflow-continue` 承担，与 dsh 会话心智一致。
2. **验证者沙箱**：设计稿建议子代理会话 `read-only` sandbox。当前实现以 `toolFilter` 白名单（read/bash/grep/glob/read_image）+ system prompt 铁律实现 edit 硬拒；子代理 sandbox 继承依赖 in-process provider 的会话配置，若宿主未配置 read-only 继承，则文件写入仍可能被工具白名单之外的途径阻塞——README 记录此约束，待真机验证后按宿主能力收紧。
3. **事件帧收敛**：`onVoteProgress` 不再注入可见消息，改由每个验证者的 `check-verdict` 事件帧逐票推送（client 卡片实时刷新），避免消息风暴。
4. **全局工作流目录**：opencode 版在 `~/.config/opencode/ralph-flow/workflows/`；dsh 版改在 `~/.dsh/ralph-flow/workflows/`（尊重 `$DSH_HOME`），doctor/list 文案同步。
5. **工作流快捷命令**：`/loop` `/spec` 等动态注册移植自 opencode 版，撞名/无效定义静默跳过（同 opencode 规则）；dsh 命令注册冲突会抛错，故冲突时捕获跳过。
6. **验证者模型与工具白名单**：设计稿的"验证者沙箱"以 dsh 原生 `toolFilter`（allow: read/bash/grep/glob/read_image）+ 验证 prompt 铁律落地；模型解析用 dsh 的 `AgentOptions`（provider/model 分字段，来自工作会话或全局默认），与 opencode 版"会话模型"同源。命令 handler 严格遵循 dsh 的 `CommandInvocation`（rawInput/agent/signal）契约。
6a. **验证者必须携带 parent agent**：dsh-subagent 的 `start` 内部强制读 `parent.options`（无 parent 即抛 `reading 'options'`）。因此插件 host 入口 `inject` 必须含 `agents`，`getAgent(sessionId)` 经 `ctx.agents.get` 解析工作会话 agent 作为验证者子代理的 parent；缺失时验证者全部失败并 `check_error` 暂停（e2e 已覆盖）。
6b. **验证者模型解析保留 provider**：工作会话 `agent.options` 的 `provider`/`model` 分字段存在时，须组合为 `"provider/model"` 传给子代理 `agentOptions`（单独给 model 会丢 provider，请求路由错误）。
6c. **命令的 opencode 式反馈**：早期实现向会话追加 `tool-ralphflow/command-result` 帧渲染结果卡（见 batch 0a 的砖化教训）；现已改为折叠宿主自动追加的官方 `command/run` + `command/done` 事件（kind `ralphflow-command`），既保留显眼结果卡又零持久化风险。6d 起同下。
6d. **client chat.node 槽组件签名**：dsh 的 keyed Chat Node 组件接收 `{ node, renderSlot, t }`，数据在 `node.data`（与官方 CommandNodeView 一致），不能用 `{ data }`；页头组件用 `useSessions` 必须在组件顶层调用（不得包进 useMemo，违反 hooks 规则会让 React 崩溃 `reading 'length'`）。
6e. **命令必须声明 `input.hint` 才能"命令+参数"**：dsh 输入机的 `matchEnter` 对带参数的命令——若命令未声明 `CommandDefinition.input`，返回 undefined 把整行当普通消息发给模型（`/ralphflow-start loop 任务` 会变成模型提示而不是启动工作流）。声明 `input: { hint }` 后：裸命令 Enter 进入 claim（输入框保留 `/name `）可继续输入；带参数 Enter 作为命令执行。ralphflow-* 与快捷命令（/loop、/spec）均已声明。
7. **client bundle 打包**：设计稿要求"client 端与 host 端双入口"。dsh 要求 client bundle 是单文件 `__ModuleLoader__.load({id, factory})` CJS 格式（tsdown/官方打包产物），直接 `tsc` 的多文件 ESM 产物在经典 `<script>` 加载下必然抛错且相对导入 404。故 `build:client` 用 esbuild 打成官方同构单文件，`exports["./client"]` 指向 `lib/client.js`；`lib/client/*.js`（tsc 产物）仅作类型/开发引用。已在真实浏览器加载链路验证（`/plugins/ralphflow/client.js` HTTP 200 + VM 实执 factory）。
8. **主题 token**：设计稿要求"全部消费 dsh 主题 token（design-platform.css 变量）"。初版误用虚构 token 名（`--dsw-alias-surface-l2`/`text-primary`/`border-default` 等），官方 CSS 无定义，运行时落到硬编码 fallback。已全部替换为官方真实 token（`--dsw-alias-bg-layer-1/3`、`border-l1/l2`、`label-primary/secondary/tertiary`、`state-success/error/warn/business-*` 等，逐一核对 `dsh-client-ui-theme/lib/styles/design-platform.css` 有定义），删除所有硬编码非 token 色值。
9. **会话事件订阅 API**：opencode 版监听 `session.idle`/会话事件驱动状态机；dsh 的 `Session` 类**没有** `.on` 方法（真实运行时 `typeof session.on === 'undefined'`），会话事件由 `SessionStore` 经 `ctx.on("session/event", (session, event) => …)` 分发（`emitCtx` 即 store 的 ctx，carrier 的 filter 对无 scope 的 ctx 放行）。job 守护者（`src/jobs.ts`）改用该官方同构写法订阅、按 session id 过滤事件，do→check→advance 由 `assistant/message` 中的 `<promise>done</promise>` 触发（见官方 `dsh-agent-instructions/lib/index.js:1255`）。订阅随 job `run()`（`start()` 内同步调用）注册，cancel 时解除。

## 目录结构

```
src/
├── index.ts          # host 入口（apply/inject + HTTP 状态/动作通道）
├── engine.ts         # 状态机引擎（移植自 opencode 版，去 .opencode 硬编码）
├── driver.ts         # CHECK 编排 + 事件发射（移植自 driver.ts）
├── check.ts          # 验证者调度（dsh 子代理）
├── check-voting.ts   # 多验证者投票（移植）
├── voting-progress.ts# 投票进度持久化（移植）
├── jobs.ts           # jobs 生产者 + 影子 registry
├── events.ts         # 事件帧发射（tool-ralphflow/*，仅审计落盘）
├── tools.ts          # 10 个工具（defineTool）
├── commands.ts       # slash 命令（结果反馈走官方 command/run+done，零自定义帧）
├── session-hygiene.ts# 会话卫生：扫描/解砖（备份并移除插件自定义事件帧）
├── deps.ts           # 共享依赖装配
├── done-detect.ts    # <promise>done</promise> 检测
└── client/
    ├── client.ts     # client 入口（apply/inject）
    ├── definition.ts # 事件折叠器（kind ralphflow-run 遗留 / ralphflow-command 官方帧）
    ├── RunCard.tsx   # 遗留 run 节点渲染（历史折叠产物）
    ├── CommandCard.tsx # 命令结果卡（command/run + command/done）
    └── HeaderAction.tsx # 页头入口：任务列表/通知/审批（POST 直连）/详情
scripts/
└── build-client.mjs # client bundle 打包（esbuild → lib/client.js，官方同构格式）
workflows/            # 内置工作流（loop / spec）
```

## 许可

MIT