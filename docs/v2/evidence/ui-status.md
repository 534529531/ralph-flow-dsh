# 工作流状态界面精修验收

2026-10-11（Asia/Shanghai），实现版本 **ralphflow-dsh 2.1.3**，真实宿主 **dsh 0.2.1-alpha.1**。
任务书：[workflow-status-ui-refine-brief.md](../workflow-status-ui-refine-brief.md)。
额外要求：弹层、输入区提示使用不透明背景，与原生子智能体、后台任务主题协调。

## 实现分工

会话头只有一个常驻入口：原生状态点加裸文字，显示当前步骤、第几轮和执行／验证／等待状态；暂停时显示失败次数。
点击才展开步骤、验证票、失败次数和最近轨迹。输入区仅在 `gate` / `paused` 时出现一行
「输入 `/ralphflow-continue` 继续」，失败达到上限也是 `paused`，明确标成「失败已到上限」。
处理后提示撤走。完成／取消缩成「已完成 · 报告」／「已取消 · 报告」，弹层只保留结果及精确报告路径。
时间线播报仍是可展开的记录，不承担常驻状态展示。

状态点和点击外部关闭行为直接复用 `dsh-client-ui-primitives` 的 `StateDot`、`useDismissOnOutsidePointer`。
圆角、阴影、颜色、字号来自原生主题 token。dsh 的 `--dsw-specific-menu` 本身带透明度，因此按用户要求
换成原生 **`--dsw-alias-bg-layer-2`** 实色背景，保留 `--dsw-radius-lg/md`、
`--dsw-elevation-prominent/panel` 和原生描边 token，不修改宿主样式。

## 真机与完成判据

脚本：[ui-status-web.mjs](../../../scripts/ui-status-web.mjs)。
原始结果：[result.json](ui-status-refine/result.json)，隔离数据目录：[isolated-home.txt](ui-status-refine/isolated-home.txt)。
启动真实 `dsh web`，在 Chromium 的当前会话 **对话 / Chat** 检查 DOM。
模型输出由本地 adapter 控制；AgentLoop、ToolRuntime、原生 spawn 验证者、Remote mux、审批、
Session 持久化与客户端装配都是宿主原件，无远程模型请求。未重启用户正在使用的 dsh。

| 判据 | 实际断言与截图 |
|---|---|
| 1 恰好一处常驻 | 每次实时阶段断言同时检查 `[data-ralphflow-status]` 数量为 1。真实长对话滚动容器滚到顶后，入口仍在视口。[常驻入口](ui-status-refine/persistent-header.png) |
| 2 执行／验证不占输入区 | 两阶段 `[data-ralphflow-status-action]` 均为 0，返回 null，连提示条外壳也不挂载。[执行](ui-status-refine/input-empty-executing.png)、[验证](ui-status-refine/input-empty-verifying.png) |
| 3 需要动作才提示 | 审查门、失败上限暂停均恰好一个单行提示、一个命令，高度不超过 44px。放行／取消后计数归零。[审查门](ui-status-refine/gate-action.png)、[暂停](ui-status-refine/pause-action.png) |
| 4 终态收束且报告可取 | 输入区为 0，入口只留结果与报告；弹层路径与本会话 `uiRef.reportRef` 匹配。刷新、真实冷启动后保持。[完成](ui-status-refine/terminal-done.png)、[取消冷恢复](ui-status-refine/cancelled-cold-restart.png) |
| 5 原生主题、实色背景 | 源码断言拒绝硬编码颜色／字号／圆角／阴影。截图中真实原生 job-list 与 goal 条同框；浅色、深色 computed background 均不透明。[浅色并列](ui-status-refine/native-comparison-light.png)、[深色并列](ui-status-refine/native-comparison-dark.png)、[原生 jobs 弹层](ui-status-refine/native-jobs-light.png) |
| 6 不默认展示内部预算 | 常驻入口不显示 `0/100`、`100`。详情显示本步失败次数、验证票返回进度；仅失败达到预算 80% 时展开提示 `n/m`。引擎真实值仍是失败 1 次、上限 100。 |
| 7 无实例无空壳 | 空会话、继承父终态日志的 fork，常驻入口和输入提示均为 0；接口确认 status 为 null。接管后原属主入口消失。 |
| 8 回归 | `npm run build && npm run typecheck && npm run verify`、`node scripts/ui-status-web.mjs`，结果见下。 |

原生视觉对照使用 fixture 通过公开 `goals` 服务创建后立即暂停的 goal，以及公开 `jobs` 服务的本地受控任务，
并非复制原生组件的静态样板。截图后清理 goal 和任务。深色对照通过宿主实际 `body[data-ds-dark-theme]` 选择器切换，
断言与浅色背景不同，避免把两张浅色截图误当成主题验收。

当前实际计算值（原始 result.json 记录）：

| 元素 | 浅色背景 | 深色背景 | 圆角 / 字号 |
|---|---|---|---|
| 详情弹层 | `rgb(255, 255, 255)` | `rgb(44, 44, 46)` | 原生 lg / 13px |
| 操作提示条 | 实色层 token，DOM 不透明断言通过 | `rgb(44, 44, 46)` | 原生 md / 13px |

这些计算值是取证结果，不是源码里的硬编码常量。源码检查：

```bash
rg -n 'boxShadow|borderRadius|rgba\(|fontSize' src/client
# 无输出
```

## 三组负对照

| 负对照 | 必须失败的同一断言 | 结果 |
|---|---|---|
| 撤掉客户端 factory | `assertStatus("done")` | 超时，状态入口为 0；恢复真实 bundle 后通过。[截图](ui-status-refine/negative-without-client.png) |
| 阻断真实服务的变化通知，保留首帧 | 详情显示 `1/4 已返回` | 真实票已落账，但 UI 留在 `0/4`，实时断言超时；恢复推送后通过。[截图](ui-status-refine/negative-without-push.png) |
| 只撤掉常驻入口渲染器 | `assertExactlyOnePersistent()` | 0 !== 1，原 factory、播报和条件提示组件仍保留；恢复后同一断言通过。[截图](ui-status-refine/negative-without-persistent.png) |

## 机制未变与额外验证

- 只读状态源、Typert 契约、引擎推进机制没有本轮修改；没有轮询、额外 SessionEvent 或模型消息。
- 查看、展开前后 Session events 完全相等，`turn/start` 仍为 1；双槽位共享 1 个宿主订阅，关闭最后一个页面后为 0。
- 断线保留上一份确认值并标记同步中；断线期间真实票发生变化，重连后从完整快照恢复。
- 原生审批接管输入区时，页头仍能打开工作流详情。[截图](ui-status-refine/approval-header.png)
- 空会话、fork、接管、完成、取消、活跃暂停的恢复与精确报告隔离仍通过。
- reset 用真实 Session 重放，DO 边界模型面仍精确三条；历史播报保留。
- 四票失败只聚合成一次本步失败；返工四票通过后完成，父会话最终 idle、无待处理收件箱。
- 磁盘压缩会话日志的 append 播报与 DOM 摘要逐条一致；SHA-256 记在 result.json。

## 本轮最终命令结果

最后一次客户端修改后重新运行：

| 命令 | 结果 |
|---|---|
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run verify` | **全部 26 支通过**，exit 0 |
| `node scripts/ui-status-web.mjs` | **PASS**，包含三组负对照、实色背景及原生主题对照，exit 0 |
| `git diff --check` | exit 0 |

源码视觉常量检查无匹配；证据链接全部存在，package.json 与 package-lock.json 的版本和根 peer 声明一致。

## 复跑与启用

```bash
npm run build && npm run typecheck && npm run verify
node scripts/ui-status-web.mjs
```

Playwright / Chromium 默认使用本机已有安装；其他机器可设置 `PLAYWRIGHT_MODULE` 和 `CHROMIUM_PATH`。
产品本身没有 fixture 接口或测试拦截开关。客户端 bundle 在 dsh 启动时装配；更新后重启 `dsh web` 并刷新页面生效。
