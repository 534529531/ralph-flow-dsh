# 验证者配置精简任务书

> **读者**：`ralph-flow-dsh` 的实现者。读完后应能仅在本仓库完成改造，并用下列验收项判断是否交付。
>
> **状态**：待实现。本文件描述目标行为，不代表当前代码已经如此运行。
>
> **前置定案（作者）**：**dsh 版是方言基准**。opencode / claude 版的对应删减在其后另行收敛；**本轮只改本仓库，不为兼容它们而保留字段，也不为它们而放宽口径**。

## 目标

让工作流只描述验证任务与可选的验证模型。Ralphflow 始终使用自身的独立验证者；工作流不再选择验证者角色，也不再改写验证者的提示词。验证者的职责是 Ralphflow 的**内部定义**，不是工作流资产的一项配置——同一个验证职责不该分散在「Agent 名称」「工作流提示词」「步骤检查依据」三处重复表达。

## 公开工作流契约

`adversarial_check` 为可选对象，**允许的字段只有 `model`**。不写时验证者沿用发起会话的当前模型；写了时该模型用于验证。步骤级 `check_model` 仍可覆盖工作流级 `model`，且仅适用于单条 `check` 的步骤。保留现有模型引用形式（`"provider/model"` 字符串与 `{providerID, modelID}` 对象）和解析规则；解析不了的模型引用须明确提示，不能让用户误以为覆盖已生效。

```yaml
adversarial_check:
  model: deepseek/deepseek-chat  # 可选；也接受 {providerID, modelID}

steps:
  - id: implement
    do: 实现需求
    check: 运行测试并核对需求是否满足
    check_model: deepseek/deepseek-reasoner  # 可选；仅覆盖本步骤的验证模型
```

**从公开契约中删除** `adversarial_check.agent`、`adversarial_check.system_prompt`、`adversarial_check.timeout_ms`：创建指引与 README 不再介绍，类型定义与解析不再保留。

**容错口径（沿用 design §Q13）**：这三个字段出现在工作流里时，**加载与 `doctor` 都给出可定位到字段的告警并忽略**——不拒收、不静默、不改作别的含义。告警必须在**加载期**出现，不能拖到验证阶段。

理由不是"怕拒收别人的资产"，而是**口径统一**：dsh 对「自己不兑现的键」只有一条规则——warn+ignore（未知键、`check_voting`、这三个字段一视同仁）。逐字段排一张"哪些警告、哪些致命"的严重度表，是把实现细节变成用户必须记住的知识。这三个字段都是**可选**的，忽略后回落到 dsh 固定的验证者，正是文档里承诺的默认行为，不是坏掉的工作流。

工作流的 `check` 继续写明本步骤的检查依据、取证命令与通过条件。验证者的通用职责由 Ralphflow 内部定义，不要求用户在每份工作流重复书写。

## 实现边界

1. **固定验证者职责，单一来源**：当前验证者身份被写了两遍——`verify.ts` 的 `persona` 短句，以及拼进任务消息正文的 `DEFAULT_ADVERSARIAL_SYSTEM_PROMPT` 长文。收敛为**一份内部定义**（建议改名 `VERIFIER_PERSONA`——它不再是被拼进消息的"system prompt"），通过 DSH 原生的子代理 `persona` 传入（它在子代理 scope 注册 `deployment:persona-prefix` 系统提示段，是角色说明的正确通道）。
   **切分线**：persona 承载「你是谁、你的纪律」（独立性、只读取证、不采信自述、只读不改文件）；`buildCheckPrompt` 继续承载本次任务的事实与**按 `wantStructured` 分支的判定提交方式**（`structured_output` 工具 / `<promise-check>` 文本标记）——后者是逐请求状态，**不要**跟着搬进 persona，否则降级路径会失效。任务消息正文只保留本次任务、检查依据、产出位置等事实。
   **不得**把执行者的交卷摘要写进任务消息（见「验证权不变」）。

2. **独立委派按能力判定，不按名字判定**：后端选择属于 Ralphflow 内部，工作流不再有任何入口影响它。选择规则（确定性、可测）：
   - 只考虑 `getProvider(n).inheritsParentContext === false` 的 provider（全新上下文）。**绝不**回退到 `true` 的 provider——`fork` 会继承主会话历史，T1 静默失效。
   - 候选里优先 `capabilities.persona && capabilities.toolFilter` 都支持的：这两项是「独立 + 有纪律的只读裁判」的前置条件，缺失时 `start()` 本来就会抛 `UNSUPPORTED_CAPABILITY`，所以直接选支持的那个，不要等抛错。
   - 名为 `spawn` 只是当前部署的配置值（`providerName` 可改），**名字不参与判定**。
   - 没有任何全新上下文 provider → 返回 `infra`，理由写明"本部署没有全新上下文的委派后端"；有全新 provider 但缺 `persona`/`toolFilter` → `infra`，理由**点名缺哪个能力**。两种情况都不生成通过判定。
   同时删掉现行 `providerName()` 里无人能解释的 `n !== "ralphcheck"` 遗留过滤，并把函数改成不再暗示"来自配置"的名字（如 `selectBackend(ctx)`）。

3. **模型覆盖**：保留现有 `check_model` > `adversarial_check.model` > 发起会话当前模型的优先级；没有覆盖时不传 `agentOptions`（由宿主 `resolveChildAgentOptions` 继承父级 provider/model）。模型通过 DSH 原生 `agentOptions` 传给验证者，不由提示词要求模型自行切换。

4. **验证权不变**：保留工具限制、原生结构化判定及文本兜底、无法解析时按基础设施故障处理、取消与实例归属检查。**不要借这次配置精简改写 DO/CHECK 状态机、命令面或验证判定规则。** 特别是 T1 硬规则：验证者 prompt 里**永远不含**执行者的交卷自述（`state.last_submit_summary` 仅用于审查门重复交卷去重，不得进入验证请求）。

5. **文档与测试同步**：更新工作流创建指引、README、design §7，以及现有 8 个测试脚本中的配置示例与断言；所有示例只展示当前实际生效的验证者配置，不再出现已删除字段。新增断言覆盖：三个字段各自「告警且不生效」、`agent` 不再影响后端选择、无全新上下文后端时不落到 `fork`、`persona` 承载唯一身份说明、任务消息不含交卷摘要。

   顺带收掉三处同类的静默失效与失真陈述：
   - `adversarial_check` 写了**非对象**（`true` / `"foo"` / `[...]`）时，现在被整个丢掉且**零告警**（`engine.ts:570` 只认对象）；改为告警「`adversarial_check` 必须是对象，已忽略」。
   - `VerifyRequest.model` 的注释写着 `undefined` = "用 provider/部署默认"，与服务层实际行为不符——不传 `agentOptions` 时由宿主 `resolveChildAgentOptions` 继承**父级** provider/model（即发起会话当前模型）。改为准确表述。
   - `native-delegation-test.mjs` 的假请求仍带着已被删除的 `submitSummary: ""` 死字段，一并清掉。

## 验收标准

1. 不写 `adversarial_check` 的工作流仍能完成独立验证，验证者使用发起会话当前模型和固定验证职责。
2. 工作流级 `model` 与步骤级 `check_model` 分别生效，步骤级覆盖优先；验证请求中的模型与配置一致。
3. `agent`、`system_prompt`、`timeout_ms` 任一字段出现在 `adversarial_check` 下时，加载与 `doctor` 都告警指出该字段并忽略；`adversarial_check` 为非对象时同样告警并忽略。不悄悄使用、不拒收、不改作别的含义。
4. 验证请求只含**一份**通用验证者角色说明，且该说明经 `persona` 通道传入；步骤 `check` 仍完整到达验证者；验证请求中不含执行者交卷摘要。验证结果继续由独立会话产生，解析失败不能放行。
5. 后端选择与名称无关，且绝不落到继承上下文的后端。**验法**（扩 `scripts/native-delegation-test.mjs` 的假 `ctx`，让 `list()`/`getProvider()` 返回带 `inheritsParentContext` 的 provider 描述）：
   - `list: ["fork"]`（`inheritsParentContext: true`）→ `runVerifier` 返回 `status: "infra"`，且 `start` **一次都没被调用**（用调用计数器断言，不能只看返回值——只看返回值会漏掉"先委派后判定"的实现）。
   - `list: ["fork", "fresh"]`（`fresh` 为 `false`）→ 选中 `fresh`；`list: ["fresh"]`（不叫 `spawn`）同样选中 `fresh`，证明判定与名字无关。
   - `list: ["fork", "spawn"]` 且 `spawn` 缺 `persona` → `infra`，理由里出现该能力名。
   - 现网 `list() = ["spawn","fork"]` 只作正向用例，**不能**用它验证本条——真实部署里 `spawn` 永远在，构造不出失败分支。
6. 验证通过：`npm run typecheck`、`npm run build`，以及 `scripts/` 下**全部 8 个** `*.mjs` 脚本（`engine-test`、`hardening-test`、`verdict-integrity-test`、`native-delegation-test`、`visibility-test`、`alert-test`、`submit-flow-test`、`verify-activation`）全部通过，无失败、无回归。

## 交付物

- 本仓库的实现、必要测试及同步后的文档。
- 一份简短变更说明：列出删除的公开字段与容错口径、保留的模型优先级、provider 选择判定的前后差异，以及验收命令的实际结果。

## 附：核实记录（供实现者省去重新取证）

| 事实 | 位置 |
|---|---|
| `persona` 是 provider 声明的能力，缺失时 `start()` 抛 `UNSUPPORTED_CAPABILITY`（**响亮失败，不会静默丢**） | `dsh-subagent/lib/index.js:3274`、`3293` |
| `persona` 落到子代理系统提示段 `deployment:persona-prefix` | `dsh-subagent/lib/index.js:551` |
| `inheritsParentContext` 是 provider 原生字段；`spawn`=false、`fork`=true | `dsh-subagent-spawn-in-process/lib/index.js:30`、`dsh-subagent-fork-in-process/lib/index.js:44` |
| 「Ralph 必须用全新上下文后端」在 dsh 内已有先例：start 前直接抛错 | `dsh-tool-ralph/lib/index.js:154` |
| provider 名可配置，**不是**固定字面量 | `dsh-subagent-*-in-process` 的 `Config.providerName` |
| 不传 `agentOptions` 时子代理继承父级 provider/model | `dsh-subagent/lib/index.js:470` |
| 三端现状：opencode 使用全部三字段；claude 支持 `system_prompt`、对 `agent` 仅 warn+ignore、对 `timeout_ms` 静默忽略 | `opencode/src/check.ts:186-188`、`claude/server.mjs:1174-1182` |
