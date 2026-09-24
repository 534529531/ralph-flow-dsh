# ralphflow 插件加固任务书（自迭代用）

> 用法：新会话里执行
> `/ralphflow-start loop 按 docs/v2/hardening-brief.md 加固 ralphflow 插件：审计 dsh 原生能力用法与恶性 bug，修复并保持边界不变，交付变更清单与证据。`
> 本文件是**唯一验收依据**：执行者按它干活，独立验证者按它判定。

## 0. 你的角色

你是 ralphflow-dsh 插件（仓库即当前工作区）的维护者。本轮任务**只做加固**，不做扩张。

## 1. 必读（动手前全部读完）

| 文件 | 它决定什么 |
|---|---|
| [docs/v2/design.md](design.md) | **§0 中心定理**（T1 裁判权在独立会话 / T2 推进权在机械程序）、§10 宪法 12 条、§11 路线图与准入条件、§8 命令面边界 |
| `src/engine.ts` `src/verify.ts` `src/tools.ts` `src/index.ts` | 全部实现（约 900 行，四个文件） |
| `scripts/engine-test.mjs` | 引擎/裁判权测试（当前 23 项，必须保持全绿） |
| `scripts/verify-activation.mjs` | 激活冒烟（apply() 不抛） |
| `docs/v2/evidence/` | 真实宿主 E2E 证据（loop 全链路、spec 审查门 + 返工） |
| `/home/yj/ralph-flow-claude/docs/design.md`、`~/.config/opencode/plugins/ralph-flow/dist/` | 两个兄弟实现（用户旅程基准；**只借语义，不移植引擎**） |

## 2. 三条要求

1. **充分利用 dsh 原生能力，更优雅更完美地实现**：优先用宿主已提供的服务/事件/契约替换自制机制。做任何替换前，先用 `cordis_inspect_list` + `cordis_inspect_query` 读**部署版**的确切契约（Service/Event/Tool/Slot），并在交付里引用你依据的方法签名。
2. **修复可能存在的恶性 bug**：恶性 = 会导致数据错位/状态损坏/判定不可信/流程卡死/用户看不到反馈的问题。每条修复必须有**复现证据 + 修复后验证**。
3. **不新增敲定边界以外的功能**：见 §3。

## 3. 边界（硬性，违反即判不通过）

**允许**：修 bug、改实现机制（只要能证明更贴合 dsh 原生）、补测试、改文档、改内部数据结构（保持 state.json 向后兼容读取）。

**禁止新增**：
- 客户端 UI / 传输通道 / 系统通知 / 验证者沙箱 / 多验证者投票 —— 均有 §11 准入条件，未触发不做。
- `reset` / `rewind` 的实现（作者定案暂缓，涉及上下文管理）——保持"只声明不实现"。
- 新的 slash 命令或工具（命令面固定为：`start` `list` `status` `continue` `cancel` `create` `doctor` + 工作流快捷命令 + `reset`/`rewind` 占位）。
- 任何形式的"修复类命令"（doctor/unbrick/reset 的实现）——宪法 §10.8。
- **自建超时 / 看门狗 / 竞速**（`timeout_ms` 重启用、给验证者委派包一层 `Promise.race` 等）——作者定案：模型卡死、打转等异常属**宿主职责**，由 dsh 原生能力（请求级空闲看门狗、工具调用时限策略）维护；插件重复造轮子只会分叉行为、随宿主演进腐化。`timeout_ms` **永久 warn+ignore**，后续轮次**不要**重新引入有界竞速。

> **§3 修订记录（作者在会话中直接定案，非执行者擅改）**
> **DO 交卷协议改为 dsh 原生工具调用**：新增**恰好一个**模型可见工具 `ralphflow_submit`，
> 取代原先「模型在最后一行输出 `<promise>done</promise>`、引擎正则扫描」的文本标记机制。
> - **动机**：文本标记与 YAML 资产无关（资产零命中），是纯运行时机制；其失败模式是**静默**的
>   （标记写进代码块 / 措辞变化 → 交卷蒸发）。dsh 原生的完成方式是**工具调用**——宿主自己的
>   `dsh-subagent-in-process-driver` 就注册 `structured_output` 工具，模型调用即完成，
>   结果带 `concludesTurn` 由机器结束回合。
> - **边界影响（如实记录）**：这是**新增工具**，且该工具名与 opencode/claude 版不再逐字一致；
>   但 **slash 命令面零变化**（未新增命令），用户旅程与 `ralph-flow/` 目录布局不变。
> - **兜底**：`agent/turn-stopping`（原生，claude 版 Stop hook 的等价物）负责「忘了交卷」，
>   提醒上限 2 次后暂停（`no_submit`）等用户，绝不死循环催促。
> - **CHECK 侧**：判定**首选原生 `outputSchema`**；`<promise-check>` 文本标签仅在 provider
>   不支持 `outputSchema` 时作为降级兜底。

**必须保持**：
- 命令语义 = **触发词**：`/ralphflow-*` 一律把指令投给模型、由模型自然语言回复，**零程序化卡片返回**（含用法错误与未实现命令）。
- 命名与用户旅程与 opencode/claude 版一致（命令名、工具名、`ralph-flow/` 目录布局、报告归档）。

## 4. 工作协议

1. **先审计，后动手**：第一轮不改代码，产出一份**审计清单**写入 `summary.md`：每条 = 类型（原生能力/恶性 bug）· 位置（`文件:行`）· 证据 · 建议改法 · 是否触碰边界。没有证据的条目不许进清单。
2. **一次一条**：每轮修一条（或一组强相关条目），最小 diff。改完立即跑测试与冒烟。
3. **每轮追加 `summary.md`**：完成事项 / 变更文件 / 验证证据 / 未完成与下一步（工作流 do 已要求）。
4. **测试是底线**：`node scripts/engine-test.mjs` 全绿 + `node scripts/verify-activation.mjs` 输出 APPLY_OK。新增修复应配新断言。
5. **不得违反宪法 §10 任何一条**；尤其：绝不写自定义会话事件帧、状态不存派生量、判定 fail-closed、引擎是唯一写入者。
6. **批量交付、再重启**：改动只在 `npm run build` 后由作者重启 GUI 生效（宿主持有模块缓存）——把需要重启才能验证的项集中列出，不要指望中途生效。

## 5. 已知陷阱（本会话踩过，别再踩）

| 陷阱 | 事实 |
|---|---|
| `defineTool` 的 `parameters` | 必须是**属性映射**形态 `{ name: { type, required?, description } }`；用 JSON-Schema 形态（`{type:"object",properties:...}`）会让插件在真实宿主直接激活失败 |
| 命令返回 | 命令 handler 返回可见文本 = 程序化卡片 = 用户看不到（dsh web 零消息会话不渲染命令卡）。所有命令必须走 `deps.deliver` 注入指令，回复交给模型 |
| 投递通道 | 用 `agent.steer(createUserMessage(...))`；`followup` 仅作旧版本兜底 |
| 实例与报告位置 | 必须都在**发起会话的工作区** `<workspace>/ralph-flow/{instances,reports}`；发现靠 `~/.dsh/ralphflow-instances-index.json`。曾出现"实例在新工作区、报告写进旧根"的分裂 bug |
| 工作区解析 | `RALPHFLOW_WORKSPACE` > 会话 cwd > 进程 cwd；**不要**再用"首个会话 cwd"这类全局启发式 |
| 重复投递 | 已有 5 秒同文本去重护栏；若发现单击命令产生多条指令，查注册幂等 |
| 宿主日志 | 插件日志进 GUI 终端（`/proc/<pid>/fd/1`），会话里读不到——验证要靠 `scripts/*.mjs`、实例 `state.json`、`ralph-flow/reports/` 与真实 GUI 行为 |
| 验证者能力 | 委派用 `ctx.subagents.start(provider, {...})`；provider 名从 `ctx.subagents.list()` 取（优先 `spawn`）；`outputSchema`/`toolFilter` 要先看 provider 的 `capabilities` |
| **复现脚本的删除范围（血泪）** | 上一轮有复现脚本执行了 `rmSync(realWs, …)`，把**真实工作区的 `ralph-flow/`** 删了（连同它自己正在跑的实例状态）→ 实例消失 → 之后的交卷无归属被忽略，整轮验证作废。**规则：一律 `mkdtemp` 临时工作区，禁止对真实工作区/`~/.dsh` 索引做任何删除**；清理只允许针对你 `mkdtemp` 出来的目录 |
| 交卷无归属 | 已加告警（`src/index.ts`）：会话曾有活跃实例、交卷时却找不到实例 → 会明确播报"交卷未被处理"并提示改用临时工作区。看到这条告警就说明实例状态已丢，**重建实例重跑**，不要继续在旧实例上磨 |

## 6. 验收标准（独立验证者逐条核对）

1. `summary.md` 含**审计清单**，每条都有 `文件:行` 级证据；无证据的条目不计。
2. 清单中判为"恶性 bug"的条目**全部**有：复现证据 + 修复 + 修复后验证（新增断言或 E2E 记录）。
3. "原生能力替换"类改动每条都引用了部署版契约（Service/Event 方法签名），并能说明为何比原实现更优（更少的自制机制 / 更少的边界情况 / 更贴合宿主生命周期）。
4. `node scripts/engine-test.mjs` **全绿**（项数 ≥ 23；新增断言计入），`node scripts/verify-activation.mjs` 输出 `APPLY_OK`。
5. **边界证明**：交付中列出本轮新增/修改/删除的全部文件与命令清单，逐项说明**没有**触碰 §3 禁止项。
6. 宪法 §10 十二条逐条未被违反（在 summary.md 里显式自查一遍）。
7. 命令面仍为触发词语义（无程序化卡片返回）；实例与报告仍落在会话工作区。

## 7. 交付物

- 代码与测试（最小 diff，`npm run build` 通过）
- `summary.md`：审计清单 / 逐条修复与证据 / 宪法自查 / 边界证明 / 需要作者重启验证的项
- 若某条"看起来是 bug"其实不是：写明**为何不成立**（同样计入清单，标 `不成立` + 理由）——避免下一轮重复调查
