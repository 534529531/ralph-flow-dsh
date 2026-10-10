# 客户端播报验收（2026-10-09，Asia/Shanghai）

实现路线：保留原宿主 append / steer 分类，增加 `ralphflow-notice` 私有 Chat Definition 和渲染槽。
只匹配本包带 notice + 非空 summary 的 append 原始日志，位置显式为 session。
`form: notice` 本身不决定 Chat 可见性；内置 context 仍被过滤，本包私有节点另行显示。
未修改 dsh、验证协议、冻结产物、计票或 reset 时序，客户端没有轮询或定时器。

## 真机范围与原始证据

在本机 **dsh 0.2.1-alpha.1 的真实 `dsh web`** 上运行，Chromium 打开**对话 / Chat**标签，
不是轨迹页。模型是测试夹具的本地受控 adapter；父会话 AgentLoop、ToolRuntime、四票并行
原生 spawn 子会话、Session 持久化、客户端装配和 DOM 都是宿主原件。未使用远程模型。
独立 `DSH_HOME` 与工作区由脚本创建，未拿用户会话做实验。

[result.json](ui-notice/result.json) 保存会话 id、每票落地时的时间线、实际 append 事件、
reset seq、模型边界、Slots 查询及磁盘日志 SHA-256；[isolated-home.txt](ui-notice/isolated-home.txt)
指向保留的隔离磁盘原件。脚本用 `zstd -dc` 读取真实 `session.v4.jsonl.zstd`，
逐项核对磁盘播报 seq / summary 与 DOM 断言输入一致：loop 13 条，暂停和审查门各 2 条。

| 完成判据 | 实际验证 |
|---|---|
| 1 真机可见 | 内置 loop：四票逐一失败 → 自动返工聚合行 → reset → 四票逐一通过 → 完成；每票落地后立即查对应 seq 的 `summary` DOM。另跑单票失败上限暂停与验证通过审查门。三个场景刷新后再次逐条断言。 |
| 2 人类记录与模型面解耦 | reset 后仍保留失败票、验证开始和 reset 告知；刷新重放也保留。13 条最终 Chat 记录包含重置前的 6 条播报。 |
| 3 不唤醒 | 四票在飞时父会话 idle、收件箱空、turn/start=1；前三票失败逐一落地仍只有 1 个回合。整轮仅返工 DO 再开一次回合，最终 turn/start=2，idle、收件箱空。原 N1/N2 继续通过。 |
| 4 负对照 | 对**同一个已完成会话、同一批事件、同一个 `assertChatNotices`**，浏览器拦截 combo 资源，仅将本包 factory 换成无注册客户端。实际移除 1 个 factory，13 条播报变为 0 条，该断言抛 Timeout；恢复真实 factory 后同一断言通过。单元验收也包含撤掉客户端注册与 kind 改回 context 两种负例。 |
| 5 文档 | 三处错误前提已改正；额外修正宿主入口注释。design 的 v1.2 待议结案指向 v1.4；准入为作者直接指示。 |
| 6 包与模型边界 | `npm pack` 包含 `lib/client.js` 和声明；真实 ClientModuleRegistry 装配通过，非法 platform / inject / external / 缺 client export / 无 default / 缺 bundle 六种负例全部被拒。模型边界核对见下。 |
| 7 全绿 | `npm run build && npm run typecheck && npm run verify`，全部 23 支通过。独立真机脚本也 PASS。 |

判定聚合沿用原事件的表达：失败是「验证未通过，自动返工」，通过后的终步聚合与「工作流完成」
合在现有完成记录中；审查门使用「已通过验证，停在审查门」。没有新增宿主投递点。
原投递台账未改，计数仍为 **32 处 = 指令 11 + 播报 21**（其中 notify 包装 17），
非运行期台账仍覆盖 12 个文件。静态扫描只排除 `Slots.inject` 的 UI 注册误报，仍扫描客户端
其它投递形态；新增两个客户端文件的投递计数均为零。

## 模型检查的精确边界

取同一真机会话从 seq 0 到返工 DO 入场的完整日志前缀，用宿主真实 `Session.create` /
`deriveMessages` 重放，断言**恰好三条**：system、ralphflow 交接稿、ralphflow 本步 DO。
没有通过过滤 messages 来凑三条，也没有改变宿主配置来禁用上下文注入。

下一次模型请求前，完整 web profile 本来就会再注入 `runtime-context` 和 `skill-catalog`，
所以不能把「请求准备后的五条」谎报成三条。本次核对的是任务要求的**替换完成与 DO 入场边界**；
后续宿主注入的来源另记在 `modelAfterReset.nextPreStepSources`，客户端半边不参与模型面。
`scripts/reset-surface-test.mjs` 的精确模型面回归也保持通过。

## 页面证据

- [验证开始，父会话已收工](ui-notice/loop-start.png)
- [reset 后刷新，旧失败票仍在](ui-notice/loop-reset-refreshed.png)
- [四票失败 → 返工四票通过 → 完成，刷新后](ui-notice/loop-complete-refreshed.png)
- [同会话撤掉客户端，播报全部消失](ui-notice/negative-without-client.png)
- [暂停，刷新后](ui-notice/pause-refreshed.png)
- [审查门，刷新后](ui-notice/gate-refreshed.png)

已逐张查看截图；摘要默认可读，全文使用原生 details 展开。真机脚本也验证 summary 聚焦后
按 Enter 能打开和收起。活体 `Slots.listSubTree` 表明新 key 只有一个 active 占用者，
`context` / `turn-trigger` / `workflow-run` 等原有 key 仍在（原响应保存在 result.json）。

## 复跑

```bash
npm run build && npm run typecheck && npm run verify
node scripts/ui-notice-web.mjs
```

真机脚本需要 Playwright、Chromium、dsh 和 zstd。默认使用本机已有浏览器运行时；其它机器用
`PLAYWRIGHT_MODULE=/绝对路tin径/playwright/index.mjs` 和 `CHROMIUM_PATH=/绝对路径/chrome`
指定运行时。它每次启动新的 `dsh web`，重新装配客户端并重新生成证据。
已有用户 `dsh web` 必须重启才能发现新 `dsh.client` 声明；本次未中断用户原来的 3080 进程。
