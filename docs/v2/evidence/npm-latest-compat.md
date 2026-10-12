# npm 默认频道兼容性验收

2026-10-12（Asia/Shanghai）。基于 GitHub main `8858433`，本轮只修改依赖声明、开发锁文件、安装文档与验收脚本，**产品 src 没有修改**。

## 为何以前要求 alpha

上一轮 CI 修复发现本机借用了 dsh 安装目录中的 `cordis@4.0.5-alpha.1` / `dsh-*@0.2.1-alpha.1`，
于是把开发依赖与宿主 peer 都收紧到 alpha，以解决干净检出的依赖解析冲突。
这证明了构建环境可复现，却没有验证 npm 默认频道是否缺少功能。当前实测证明可以兼容默认频道。

registry 实时查询：`@deepseek-ai/dsh` 的 `latest` / `next` 为 **0.2.0-rc.2**，`alpha` 为 **0.2.1-alpha.2**；
Cordis 默认版为 **4.0.4**。0.2.0-rc.2 是 npm 默认安装版本，其名称本身仍带 rc。
各个 dsh 子包的 `latest` 标签并不全同步，因此构建依赖按 **dsh 整套 0.2.0-rc.2** 固定，不能逐个装子包 `@latest`。

## 依赖修改

- dsh peer：`^0.2.0-rc.2 || ^0.2.1-alpha.1`；Cordis peer：`^4.0.4 || ^4.0.5-alpha.1`。
- devDependencies 固定整套 `0.2.0-rc.2` / `4.0.4`，保留 dsh 与 TypeScript，维持完整类型闭包。
- 宿主 peer 设置 `peerDependenciesMeta.optional: true`，让 npm 不自动补装另一套宿主。
  这是包管理器的安装策略，**运行时宿主服务仍必需**，dsh 仍检查 manifest 的 peer 版本范围。
  dsh 自己的 profile 也使用 `autoInstallPeers: false`，通过运行时模块解析器提供宿主安装树。
- 完整重生成锁文件，锁文件里没有 alpha 版本的 `@deepseek-ai/*`。

这里不能仅放宽范围：一个空项目同时安装 `@deepseek-ai/dsh@latest` 和打包后的插件，
若没有上述 peer metadata，npm 会另补装 **60 个 alpha 包**，而默认版 dsh 仍为 0.2.0-rc.2。
负对照记录：[consumer-negative.json](npm-latest-compat/consumer-negative.json)。

修复后重新干净安装：`npm ci --ignore-scripts` 安装 539 个包，`npm ls --depth=0` 成功，
dsh 为 0.2.0-rc.2，alpha 包为 **0**，17 个已安装宿主 peer 均满足声明范围。
记录：[consumer.json](npm-latest-compat/consumer.json)。不使用 `--force` 或 `--legacy-peer-deps`。

## 功能验证

从干净归档目录用 npm 安装完整默认版依赖，不借用本机的 `node_modules/@deepseek-ai` 软链。
核对实际 CLI、测试 imports 与宿主版本一致。类型和实现比对确认以下接口在 rc.2 已存在：

- Typert 严格 InvocationDescriptor、Remote stream、Session lookup。
- `RemoteSnapshotStream`、`ctx.remote.$stream`、`ctx.remote.$mount`。
- `conversation.session.header.actions` 与 `conversation.input.dock`。
- 原生 `StateDot`、点击外部关闭、`sessionQuery.readSession`。

其中 RemoteStream / RemoteSnapshotStream 实现、Typert 类型、StateDot 类型和 SessionQuery 类型
与原先使用的 alpha.1 文件逐字一致。

| 运行环境 | 验证 |
|---|---|
| npm 默认版 0.2.0-rc.2 + Cordis 4.0.4，干净依赖树 | `npm ci`、build、typecheck、**26 支全量回归通过** |
| 原有 alpha.1 + Cordis 4.0.5-alpha.1 | build、typecheck、**26 支全量回归通过** |
| 默认版：Chat 播报 | 真 AgentLoop / ToolRuntime / spawn / Session / Chat，逐票播报、重置精确三条、暂停、审查门、完成、刷新及客户端负对照。[结果](npm-latest-compat/notice/result.json) |
| 默认版：工作流状态 | 常驻计数、条件提示、实色浅深主题、断线重连、接管、fork、原生审批、冷启动、精确报告、零额外唤醒及三组负对照。[结果](npm-latest-compat/status/result.json) |
| 默认版：**实际 npm pack 产物** | 消费者目录安装后的插件提供 lib 与 manifest，完整状态 UI 真机验收通过，包含三组负对照。[结果](npm-latest-compat/packed-status/result.json) |
| 原有 alpha.1：状态 UI | 同一真机脚本通过。[结果](npm-latest-compat/alpha-status/result.json) |

所有真机模型输出由本地 fixture 提供，没有远程模型消耗。宿主和工作区隔离，未重启用户正在使用的 dsh。
一次额外复跑曾因 `/tmp` 用户写入额度触顶而出现解包／落盘错误；清理本轮消费者测试的依赖目录后，
干净安装和最终回归重新通过。该环境失败没有通过增加兼容性豁免或修改产品行为绕过。

安装门新增原生 `evaluatePluginCompatibility` 断言：默认版、alpha.1、alpha.2 均允许；
0.1.7-rc.2 仍拒绝；把 manifest 还原成 alpha-only 后默认版必须拒绝。
这里 alpha.2 是**版本准入**验证，完整运行实测覆盖默认版与原有 alpha.1，不把准入冒充 alpha.2 全量运行测试。

## 验收脚本可复跑性

`scripts/ui-notice-web.mjs` / `ui-status-web.mjs` 读取实际 `dsh --version`，拒绝 CLI 与测试 imports 混用版本。
原生后台任务选择器改用公开 ARIA 名称，不依赖随构建目录改变的 CSS hash。
`RALPHFLOW_UI_EVIDENCE_DIR` 分开保留不同宿主的证据，`RALPHFLOW_UI_PLUGIN_DIR` 可指定实际安装的打包产物。
默认行为不变，未弱化任何正负断言。

复跑时先在一个干净目录安装本仓库，再使用其 CLI：

```bash
npm ci && npm run build && npm run typecheck && npm run verify
PATH="$PWD/node_modules/.bin:$PATH" node scripts/ui-notice-web.mjs
PATH="$PWD/node_modules/.bin:$PATH" node scripts/ui-status-web.mjs
```

发布沿用 `.github/workflows/release.yml` 的 `bump=patch`，其 gate 会再次对干净默认版环境运行完整检查，
通过后才定版、打 tag、建立 GitHub Release 并发布 npm。
