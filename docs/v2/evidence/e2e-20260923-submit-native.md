# 真实宿主 E2E 证据 — DO 交卷改原生工具调用（2026-09-23）

> 目的：证明第 4 轮的交卷协议改造（`ralphflow_submit` 工具 + `agent/turn-stopping` 兜底）
> 在**真实 dsh 宿主**里生效，而不只是在脚本 harness 里通过。
> 载体：作者重启 GUI 后的**外层 ralphflow 实例**（`loop-mudrr90d-xd5d`，工作流 `loop`）。
> 为什么用它：本会话已被该实例占用，而 dsh/ralphflow 的约束是「一个会话同时最多一个活跃实例」，
> 因此无法在同一会话里嵌套跑一个新 loop 充当测试 —— 外层实例本身就是最真实的那条链路。

## 0. 环境

| 项 | 值 |
|---|---|
| 插件部署方式 | `~/.dsh/profiles/web/node_modules/ralphflow-dsh` → 符号链接到本仓库 |
| 生效代码 | 本仓库 `lib/`（重启后由宿主重新加载） |
| `lib/` 与 `src/` 同步性 | 逐文件比对 mtime，`engine/verify/tools/index/create` **全部同步**（无需重建） |
| 工作区 | `/home/yj/ralph-flow-dsh` |

## 1. 证据 A：重启后新代码确实生效（直接观测）

解除暂停后，引擎投递的 DO prompt 末尾「交卷方式」为：

```
完成实际工作后，调用 **`ralphflow_submit`** 工具交卷（可在参数 `summary` 里简述你做了什么）。
独立验证者会立刻检查你的产出。

不要只在回复里说「完成了」——那样不会触发验证。**必须调用工具**。
```

**判定依据**：旧实现的同一位置写的是「在回复的**最后一行**单独输出 `<promise>done</promise>`」。
文案变更来自 `src/engine.ts` 的 `doPrompt()`，即**宿主已加载改造后的 `lib/engine.js`**。

辅助证据（静态）：`grep -c ralphflow_submit lib/tools.js` = 3；`grep -c turn-stopping lib/index.js` = 2。
辅助证据（运行时）：`ralphflow_continue` 真实工具调用成功解除暂停（返回「▶️ 已解除暂停（原因：check_infra）」）。

## 2. 证据 B：全量断言（针对当前已加载的 `lib/`，未重建）

| 检查 | 结果 |
|---|---|
| `node scripts/engine-test.mjs` | **24 passed, 0 failed** |
| `node scripts/hardening-test.mjs` | **29 passed, 0 failed** |
| `node scripts/native-delegation-test.mjs` | **16 passed, 0 failed** |
| `node scripts/submit-flow-test.mjs` | **14 passed, 0 failed** |
| `node scripts/alert-test.mjs` | **16 passed, 0 failed** |
| `node scripts/verify-activation.mjs` | **`APPLY_OK`** |

合计 **99 项断言全绿**。

## 3. 证据 C：真实交卷 → 真实独立验证（本实例）

- 交卷方式：模型（本会话）调用 **`ralphflow_submit` 工具**，非文本标记。
- 验证者：由引擎经 `subagents.start` 委派**真实子代理会话**（provider `spawn`，宿主原生能力）。
- 判定落地位置：`<workspace>/ralph-flow/instances/loop-mudrr90d-xd5d/state.json` 的 `verdicts[]`。
- 报告归档：`<workspace>/ralph-flow/reports/loop-mudrr90d-xd5d.md`（完成/取消时写入）。

> 该实例的判定与报告由引擎在验证返回后生成；本节以引擎落盘产物为准，不以执行者自述为准
> （T1：执行者无权产生判定）。

## 4. 覆盖到的真实链路 / 未覆盖

**已覆盖（本 E2E + 脚本）**
- 宿主重启后加载改造版插件（证据 A）
- 真实工具注册：工具面含 `ralphflow_submit`，命令面 11 条不变
- 真实 `agent/turn-stopping` 监听器注册（`lib/index.js` 已注册；暂停态下正确地**不**提醒）
- 真实模型调用交卷工具 → 引擎受理 → 委派真实验证者
- 真实 `session/event` 上下文捕获（供验证者 prompt 的「交卷摘要」）
- 异常路径：交卷必有反馈（受理/已交卷/无实例/暂停中），无静默消失

**未覆盖（如实记录）**
- `e2e-verify.mts`、`smoke-client.mts`、`ui-verify.mts` 均为 **v1 遗留**（引用 `lib/jobs.js`/`mutex.js`/`check.js`），
  **不适用于 v2**，本轮未使用也未修复。
- 「`concludeTurn` 在真实模型交互中的观感」（模型是否会在工具结果后继续输出）需在**非暂停、且本会话模型
  主动调用该工具**的场景下观察；本轮为单次观测，未做重复实验。
- 未做多工作区、多实例并发下的宿主级 E2E（脚本层已覆盖跨工作区，见 `engine-test` 第 8 组）。
