# 自定义工作流

把 `.yaml`（或 `.yml`）文件放到下面三个位置之一即可定义自己的工作流，或运行 `/ralphflow-create` 交互式设计并校验：

| 位置 | 作用范围 | 优先级 |
|------|----------|--------|
| `<workspace>/.dsh/ralph-flow/workflows/` | **仅本工作区** | 最高 |
| `~/.dsh/ralph-flow/workflows/`（或绝对路径的 `$DSH_HOME/ralph-flow/workflows/`；`DSH_HOME` 为相对路径时忽略、回落 `~/.dsh`） | **全局**——所有工作区可用 | 中 |
| 插件内置（`loop` / `spec`） | 随插件发布，**不落盘** | 最低 |

**工作流名 = 文件名去掉扩展名**：`design-flow.yaml` 用 `/ralphflow-start design-flow <任务>` 或 `/ralphflow-design-flow <任务>` 启动。快捷入口 `/ralphflow-<工作流名>` 是**技能**，名字必须是小写 kebab（`[a-z0-9]+(-[a-z0-9]+)*`）；名字不合语法时**注册不了快捷入口**，我们会**如实告诉你原因与改法**（不静默跳过），而 `/ralphflow-start <工作流名> <任务>` 照旧可用。目录不存在时自己建（`mkdir -p .dsh/ralph-flow/workflows`）；只读操作（list / doctor / status）对目录缺失是容错的。

解析顺序是**工作区 → 全局 → 内置**：同名工作流靠前的层**遮蔽**靠后的。所以你可以用全局层覆盖内置，或在某个工作区覆盖全局版本。内置工作流只存在于插件目录，因此**始终是随插件发布的最新版本**；要定制就在工作区（或全局）放一个同名文件。

> 写完后运行 **`/ralphflow-doctor`**。输出里 `✅` = 该工作流可用，其下 `⚠️` 子项 = 能启动但有告警（不生效的键、成本提示等），`❌` = 加载期硬错误（该工作流无法加载）。**如果你刚写的工作流没出现在 doctor 的清单里，就是位置放错了**——它只会扫描上表三个位置。

> 本端把两类问题分得很清：
>
> - **会让资产不再表示它所说的话**的配置 → **加载期硬错误**，整份拒收（缺必填字段、悬空 `on_pass`、`check` 与 `check_voting` 同写、步骤级 `manual_step`、子工作流成环……）。
> - **自己不兑现的键** → **加载期告警 + 忽略 + 指路**，工作流照常跑（`adversarial_check` 的 `timeout_ms`、投票条目的 `system_prompt`、调用点的 `inputs`、未知键……）。
>
> 绝不静默跳过审查门，也绝不静默忽略一个作者以为生效的键。

---

## 快速示例

```yaml
description: 先分析再实现

steps:
  - id: analyze
    desc: 任务分析
    do: 分析需求，产出设计文档。
    input: 用户需求
    output: "design.md"
    check: 打开 design.md，核对是否完整、技术上合理。
    on_pass: execute
    on_fail: analyze
    max_fail_count: 3

  - id: execute
    desc: 实现
    do: 按设计实现，跑测试直到全绿。
    input: design.md
    output: 测试通过的可工作代码
    check: 自己跑测试套件，核对实现与 design.md 一致。
    on_pass: done
    on_fail: execute
    max_fail_count: 5
```

执行从**第一个**步骤开始。`on_pass: done` 结束工作流。

---

## 步骤字段参考

### 普通步骤

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 步骤唯一标识（重复是加载期硬错误） |
| `desc` | ✅ | 人类可读描述（状态与提示词里显示） |
| `do` | ✅ | 任务提示词——主会话要做什么 |
| `input` | ✅ | 本步骤消费什么（进 CHECK 提示词的「本步上下文」） |
| `output` | ✅ | 本步骤必须产出什么（进 DO 的「交付物」与 CHECK） |
| `check` / `check_voting` | ❌ | `check`：单验证者检查依据；`check_voting`：多验证者投票。**可选**——都不写则跳过对抗验证（见[检查依据](#检查依据决定本步是否被独立验证)） |
| `check_model` | ❌ | 单 `check` 场景的步骤级验证模型覆盖 |
| `on_pass` | ✅ | 通过后的下一步 id，或 `"done"` 表示完成 |
| `on_fail` | ✅ | 失败后重试/回退到的步骤 id（**不允许 `"done"`**） |
| `max_fail_count` | ✅ | 暂停前的最大失败次数（整数 ≥ 1，每步独立） |
| `reset` | ❌ | `true` 时，**进入**本步骤前换入干净上下文（见[上下文重置门](#上下文重置门reset)） |

> **必填字段**：`id`、`desc`、`do`、`input`、`output`、`on_pass`、`on_fail`、`max_fail_count`。
>
> 其中 `desc` / `input` / `output` / `on_pass` / `on_fail` / `max_fail_count` 这**六个**，opencode / claude 版的加载器同样逐个校验——只是那边缺一个就 `skipStep`（该步被**静默丢弃**，或整份定义因「没有任何有效步骤」被拒收）。本端把它改成**加载期硬错误，整份拒收**：缺失、非字符串、**空串**都算缺。理由不是对齐而是**静默**——被丢弃的步骤会让资产不再表示它所说的话。

> `check` 和 `check_voting` **都**是可选的，两者**互斥**——同写是**硬错误**（工作流无法加载）；把 `check` 写成非字符串（如 `check: true`）同样硬错，因为那不是"我要跳过"，而是配置写错了（本意是免验证请直接删掉该键）。

### 子工作流调用点

步骤可以用 `workflow:` 代替 `do` 委托给另一个工作流：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 步骤唯一标识（含 `/` 是硬错误——`/` 是展开后的 id 分隔符） |
| `desc` | ✅ | 人类可读描述 |
| `workflow` | ✅ | 要调用的工作流名称（只能是名字，**不能含路径分隔符**） |
| `input` | ✅ | 本步骤消费什么 |
| `output` | ✅ | 本步骤必须产出什么 |
| `on_pass` | ✅ | 整段子工作流跑完后去哪（步骤 id 或 `"done"`） |
| `on_fail` | ✅ | 只做引用校验（子步骤失败**不会**回到它，见下文） |
| `max_fail_count` | ✅ | 同上，只做引用校验 |
| `do` | ❌ | **在调用点上生效**：这段子工作流"要做什么"，下沉到子步骤的「任务」；不写就继承父级任务描述 |
| `reset` | ❌ | **在调用点上生效**：进入子工作流 = **首个展开后子步骤**的重置 |
| `check` / `check_voting` / `check_model` / `inputs` | — | **加载期告警 + 指路**（调用点没有 DO/CHECK 阶段；参数传递见下文） |

详见[子工作流与嵌套](#子工作流与嵌套)。

---

## 产出目录与模板变量

每个工作流实例有一个隔离的交付物目录：

```
<workspace>/.dsh/ralph-flow/artifacts/<产出目录名>/
```

目录名 = 任务摘要 slug + 实例 id 尾段（按**码点**截断，中文/emoji 不会被切碎），实例启动时建好、工作流结束后**保留**（非空目录整个保留，只有空目录才随实例销毁被删）。

- 每个 DO 和 CHECK 提示词都自动携带「产出目录」一节，所以 `do` / `output` 里写**裸文件名**（如 `summary.md`、`design.md`）即可落到该实例的目录，跨任务不串味、也不进仓库根。写了其它路径的按写的路径来。
- **本版本不解析任何 `{{...}}` 模板变量**（连产出目录记号都没有——产出目录已自动注入提示词，不需要记号）。其它任何 `{{...}}` 会原样进入提示词，`/ralphflow-doctor` 会标记出来。

---

## 工作流级选项

### `description`

`/ralphflow-list` 里显示的一句话描述。可选。

```yaml
description: 实现、测试并文档化一个功能
```

### `manual_step`

需要**人工审查**的步骤 id。**只有工作流级这一种写法**（顶层，与 `steps` 同级），列表或逗号字符串都行：

```yaml
manual_step: [design]
# 或
manual_step: design, review
```

手动步骤在 **CHECK 通过后**暂停：独立验证先跑，通过后会话停下，让你审查**已验证的产物**。你运行 `/ralphflow-continue` 是**放行**——直接进入下一步，不重复验证（该步骤没写 `check` 时，你的审查即最终验证）。check 失败只会自动重试，**不会**把你卷进"改 → 审 → 再改"的循环；你要改，会话就改并再次交卷，自动重新验证、通过后再停下等你审查。

> **步骤级 `manual_step` 键已删除**：写进步骤里（不论 `true` / `false` / 空值）都是**加载期硬错误**，报错文案会给出正确写法（把该步 id 列进顶层列表）。理由：opencode / pi **只认这个顶层列表**，步骤级写法在那边只是「不认识的步骤键」——被警告忽略后**人工审查门静默消失**。静默跳过审查门比报错严重得多，所以这里 fail-fast。

> `manual_step` 里对不上真实步骤 id 的条目是**硬错误**。打错字绝不能静默跳过你指望的审查门。

> `manual_step` **可以**标子工作流调用点：语义是**整段子工作流跑完后停门**（映射到子工作流的出口步骤）。这是本端与 opencode 的一处刻意差异（那边禁止这种写法）。

### `auto_reset`

`true` 时，等价于给每个步骤都标 `reset: true`——进入任何步骤都换入干净上下文（含失败重试），与步骤级 `reset` 语义完全一致。缺省 `false`。非布尔值（如 `"true"`）是**加载期硬错误**。

```yaml
auto_reset: true
```

适合多步长程工作流（每一步都在干净上下文里发挥最佳质量，失败重试同样换新上下文），代价是每步重建现场的 token 成本。粒度更细的控制用步骤级 `reset: true`。纯线性工作流（每步 `on_fail` 都指回自身）开 `auto_reset` 时 doctor 会给成本提示。

**完整示例**——`manual_step` 里的 id 必须对应 `steps` 里的某个步骤：

```yaml
description: 带设计审查门的功能开发

manual_step: [design]        # design 步骤 CHECK 通过后停下审查

steps:
  - id: design
    desc: 技术设计
    do: 写 design.md，覆盖数据模型、API 形态、错误处理。
    input: 用户需求
    output: "design.md"
    check: 打开 design.md，核对是否覆盖数据模型、API 形态、错误处理。
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现
    do: 按批准的设计实现，跑测试直到全绿。
    input: design.md
    output: 测试通过的可工作代码
    check: 自己跑测试套件，核对代码与 design.md 一致。
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

运行时会发生什么：

1. **design** 步骤跑 DO 阶段，完成后调用 `ralphflow_submit` 交卷。
2. 独立验证者**先**检查 `design.md`；通过后，因为 `design` 在 `manual_step` 里，会话**停下**——你去读 `design.md`。
3. 你运行 `/ralphflow-continue` **放行**进入 **implement**（不再重复验证）。你要改，就说要改哪里，模型修改后自动重新验证、通过后再停下等你。
4. **implement** 是普通步骤，会自动验证，不会为你停下。

### `adversarial_check`

配置独立验证会话的模型。**本版本只接受 `model` 一个字段**：

```yaml
adversarial_check:
  model: anthropic/claude-haiku-4-5        # "provider/model" 字符串形式
  # 或对象形式：
  # model:
  #   providerID: anthropic
  #   modelID: claude-haiku-4-5
```

| 字段 | 说明 |
|------|------|
| `model` | `{providerID, modelID}` 对象或 `"provider/model"` 字符串；不填则沿用发起会话当前模型 |

> **验证者的身份与职责是插件内部定义的**，工作流不再能配置它——验证者的纪律（独立性、只读取证、不采信自述、默认不通过）收敛在插件里，`check` 只写判据与事实。opencode / claude 版的 `agent` / `system_prompt` / `timeout_ms` 三个字段在**本端已从公开契约中删除**：写了（以及任何未知字段、或 `adversarial_check` 不是对象）会在**加载期**告警并忽略，`/ralphflow-doctor` 同样报出——不拒收、不静默、不改作别的含义。
>
> **验证超时不在插件里设置**：委派生命周期（含模型卡死/打转）一律交给宿主 dsh 的原生能力（请求级空闲看门狗）。插件重复实现只会分叉行为，故 `timeout_ms` 永久 warn+ignore。

> **裸模型名**（如 `sonnet`）、对象缺 `providerID`/`modelID`、或类型非法 → 解析不出 → **告警并回退发起会话当前模型**，绝不静默忽略（否则你以为换了验证模型，实际没换）。`/ralphflow-doctor` 对这两种情况都会警告。

---

## 检查依据：决定本步是否被独立验证

**一条规则**：步骤写了 `check` **或** `check_voting` → 交卷后由独立验证者取证判定；**两者都不写 → 该步跳过对抗性验证**，DO 完成直接按 `on_pass` 推进（在 `manual_step` 列表里则是**纯人工审查**：交卷后停在门等你放行）。

跳过时，通知、轨迹与归档报告一律写「跳过对抗性验证」——**绝不会写成「检查通过」**。

```yaml
steps:
  - id: docs
    desc: 更新文档
    do: 把新字段写进 README 和 API 文档。
    input: 本次变更内容
    output: 更新后的文档
    on_pass: done
    on_fail: docs
    max_fail_count: 3
```

什么情况下适合不写 check：

- 纯编排、文档整理这类不需要独立复核的步骤；
- `manual_step` 列表里的步骤（没写 check 时，你的审查即最终验证；写了 check 才会两者叠加）。

注意两点（doctor 会提醒）：

- **`manual_step` 之外**的步骤不写 check 会收到 doctor 警告——防止"忘了写 check"被当成"故意跳过"。确实想跳过就忽略该警告。
- 把 `check` 写成非字符串（如 `check: true`）是**硬错误**（工作流无法加载）——这更像笔误，不是刻意的跳过。

### `check_voting`——多验证者投票

步骤级**多验证者并行验证**：N 个独立验证会话同时检查，每个验证者查一条自己的检查依据（可配不同模型），**全过才放行**。与 `check` **互斥**（同写 → 加载期硬错）。

```yaml
steps:
  - id: implement
    desc: 实现功能
    do: 按 design.md 实现
    input: design.md
    output: 测试通过的代码
    check_voting:                              # 1-5 条；写几条就是几个验证者
      - check: 用户任务的每一条要求都已落实
        model: anthropic/claude-sonnet         # 可选：该票专用模型
      - check: 实现的行为符合预期，真实可用
      - check: 没有遗漏的需求，边界情况已覆盖
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `check` | ✅ | 该验证者独立的检查依据（只查这一条） |
| `model` | ❌ | 该票专用模型；不填继承全局 `adversarial_check.model`（含子工作流继承链），再往后是发起会话当前模型 |
| `timeout_ms` / `system_prompt` | — | **加载期告警 + 忽略**（与 `adversarial_check` 下同名键同一口径） |

**行为要点：**

- **全过才放行**：任一票不通过 → 整体失败，聚合所有失败者的 reason（含各票检查依据原文）反馈 DO 返工。
- **每票实时进度**：每票完成立即推送一行（`✅ 通过` / `❌ 不通过` / `⚠️ 基础设施故障，自动重试中`），长投票不再无声；`/ralphflow-status` 可看每票状态。
- **基础设施故障（infra）自动重试一次**：只重跑故障票，**已通过的票保留**；重试仍故障且无 failed 票 → `check_infra` 暂停（**不计失败次数**），`/ralphflow-continue` 后只补跑未通过的票。
- **failed 优先于 infra**：一票工作失败 + 一票基础设施故障时，直接判失败反馈 DO，不会被故障遮蔽。
- 验证者 prompt 自动注入"你是 N 个之一，只查自己的检查依据"约束，防止各票趋同。
- 投票进度**不另立文件**：每票状态就是实例状态里的判定与在飞委派（单一事实源），`/ralphflow-status` 现算。

**加载期硬错误**：票数超过 5、空数组、条目缺 `check`、条目 `model` 类型非法、`check` 与 `check_voting` 同写、`check_voting` 与 `check_model` 同写。

**推荐场景**：用不同标准/视角验证同一份产出（需求逐条落实 / 行为真实可用 / 无遗漏边界），或对同一产出用不同模型交叉检查。成本 ≈ N 票的验证 token，每票可配便宜模型缓解。

### `check_model`——步骤级验证模型覆盖

仅单 `check` 场景生效：该步骤的验证模型覆盖全局 `adversarial_check.model`。

```yaml
steps:
  - id: quick
    desc: 小事一桩
    do: 改一个拼写错误。
    input: 用户指出的位置
    output: 修正后的文件
    check: 核对拼写已修正。
    check_model: anthropic/claude-haiku-4-5   # 这步用便宜模型验
    on_pass: done
    on_fail: quick
    max_fail_count: 3
```

**加载期硬错误**：与 `check_voting` 同写、或本步没有有效 `check`、或类型非法（裸模型名是**告警回退**，不是硬错误——它解析不出但形态合法）。

### 模型优先级链

从强到弱：

```
check_voting 条目 model  >  步骤 check_model  >  全局 adversarial_check.model  >  发起会话当前模型
```

子工作流里的 `adversarial_check.model` 会下沉到它各步的 `check_model`（投票步则填进缺 `model` 的票），子层没填就**逐层回退父级**——所以最外层统一配一次即可。

---

## 子工作流与嵌套

一步可以整段委托给另一个工作流，多层可嵌套，通用流程因此可以做成可复用资产：

```yaml
# workflows/full-dev.yaml
steps:
  - id: analyze
    desc: 需求分析
    input: proposal.md
    output: analysis.md
    workflow: analyze              # 调用 workflows/analyze.yaml
    on_pass: build
    on_fail: analyze
    max_fail_count: 3
    do: 把 proposal 整理成 analysis.md   # 可选且生效：这段子工作流的任务

  - id: build
    desc: 实现
    input: analysis.md
    output: 可工作代码
    workflow: build
    on_pass: done
    on_fail: build
    max_fail_count: 3
```

### 落地方式：加载期静态展开

调用点在**加载期**被就地替换成子工作流的步骤，子步骤 id 是 `调用点id/子步骤id`（多层继续叠加），子工作流的出口接到调用点的 `on_pass`。

所以运行期「嵌套」不可见——`current_step` 仍是单字符串、失败预算仍按步记账、审查门与验证者全按普通步骤走，**零新增实例状态字段**。（opencode 版用运行期状态栈保存父级上下文；本端选择静态展开，因为状态栈会与"状态不存派生量"的宪法冲突。）

### 三层下沉（调用点上生效的键）

| 调用点上的键 | 下沉到哪 |
|--------------|----------|
| `do` | 子工作流每个步骤的「任务」（DO 与 CHECK 同源）；嵌套**最内层优先、外层继承**；不写就继承父级任务描述 |
| `reset: true` | **首个**展开后子步骤的重置（措辞会写明来源是哪个调用点，绝不说成"本步标了 `reset: true`"） |
| 子工作流的 `auto_reset: true` | 每个展开后子步骤的 `reset: true`（保留来源标记，措辞走 auto 支） |
| 子工作流的 `adversarial_check.model` | 单 check 步的 `check_model`、投票步缺 `model` 的票 |

### 加载期硬错误（本端比 opencode 严格的地方）

opencode 静默忽略、或拖到运行期才炸的，这里一律**加载期硬错误**：

- 子工作流文件加载不出来（报错含**完整调用链**）；
- **子工作流成环**（含自调用，打印环路径 `a → b → a`）；
- 调用点 id 或子步骤 id 含 `/`（撞展开分隔符）；
- 展开后 **id 撞名**；
- `workflow` 名含路径分隔符；
- **嵌套深度 > 32 层**（含最外层；展开器是递归的，过深的链在展开前就被拒——步数上限看不见「每层只有调用点」的长链，这道闸负责不让宿主调用栈被打爆）；
- **展开后步骤总数 > 2000**（面向长程工作流；展开过程中计数，超了立刻中止）。

### 与 opencode 的四处刻意差异

1. 上面那些它静默忽略、或拖到运行期才炸的，这里一律加载期硬错误。
2. 用**步数上限 2000 + 深度上限 32** 取代它的「运行期最多嵌套 5 层」。
3. 子工作流内某步耗尽 `max_fail_count` → **暂停等人**（不做它那条「自动走父级 `on_fail`」）。调用点的 `on_fail` / `max_fail_count` 因此**只做引用校验**。
4. `manual_step` 标在调用点 = **整段子工作流跑完后停门**（opencode 禁止这种写法）。子工作流内部的 `manual_step` 前缀化后原样生效。

另外：**展开是复制**——同一个子工作流被 N 个调用点引用就展开 N 份，步数与验证次数同倍增长（计入 2000 上限）。

> **调用点不接收参数**：opencode 的 `inputs` 在本端**不生效**（加载期告警，文案指路到调用点的 `do`）。要用一句话说明这段子工作流要做什么，就写调用点的 `do`。

---

## 上下文重置门（reset）

长工作流跑到后半段，主会话的上下文已经塞满前面步骤的探索、试错和验证记录——模型开始丢需求、跑偏、重复犯错。重置门让你在步骤边界**换入干净上下文**继续工作流。

### 四种触发方式

| 方式 | 写法 | 适用 |
|------|------|------|
| 步骤级 | 步骤上标 `reset: true` | 在进入最重的步骤前切一刀（推荐，如 `implement`） |
| 工作流级 | 顶部 `auto_reset: true` | 多步长程流，每步都换（等价于给所有步骤标 `reset`） |
| 调用点 | 调用点上标 `reset: true` | 进入该子工作流时换（= 首个展开后子步骤的重置） |
| 手动 | 随时运行 `/ralphflow-reset` | 感觉当前上下文"脏了"，立即换个干净的重做当前步骤 |

### 重置时发生什么

把属主会话的可见面**整段替换**成一条插件写的「交接稿」，使模型收到的 messages = **系统提示 + 交接稿 + 本步 DO**。交接稿只写能现算的四项（工作流名 / 第几步 / 产出目录 / 交互契约），**零新增状态字段**；替换**不冒用压缩检查点、不发任何 `compaction/*` 事件**。

### 触发规则与护栏

**一条规则**：标了 `reset` 的步骤（`auto_reset: true` = 所有步骤），**任何方式进入都触发**——包括同步骤失败重试（`on_fail` 指回自身）。失败原因会带进返工的 DO 提示，重试换上下文不丢现场。

- 未标 `reset` 的步骤：同步骤重试**不触发**（轻量步骤的现场记忆有用），跨步骤转换也不触发。
- **首步的初次进入结构上无法重置**：首步 DO 是 `ralphflow_start` 工具的返回值，在工具调用内部替换会静默损坏会话。启动回执会**如实说明**（并区分来源：`auto_reset` 带出的重置绝不说成「本步标了 `reset: true`」）。**失败重试时首步会正常重置。**
- **只换上下文、不赦免失败**：`fail_counts` 原样保留——否则反复 reset 就能绕过 `max_fail_count`。想清零失败预算走「暂停 → `/ralphflow-continue`」的显式路径。
- **手动重置的护栏**：属主必须是本会话；**暂停中拒绝**并指向 `/ralphflow-continue`；**只在 DO 阶段**（已交卷 = 验证在飞 / 审查门已开，重置会打断验证）；**不赦免失败**。
- **绝不静默作废**：手动重置是异步落地的（等空闲窗口），而命令处理器当场已回成功——空闲窗口复查若发现实例已交卷/推进/取消，会**发一条可见告知**说明这次重置没有生效并给出下一步（并写执行日志 `manual_reset_dropped`）。
- **失败绝不吞掉 DO**：面不平衡、会话不空闲等情况下放弃本次替换，DO 照常投递，并在播报里说明「本次上下文重置未生效」及原因。

> 内置 `spec` 的 `propose` / `implement` 标了 `reset: true`（与 opencode 一致）；`explore` 是首步，不标。

---

## 中途回退（rewind）

`on_pass` / `on_fail` 是工作流**作者**预设的静态路由——只有当判定失败时引擎才按图跳另一格。**用户在运行时主观判断"前面某步方向错了、要回去重做"** 则是另一回事——这正是 `/ralphflow-rewind`。

```
/ralphflow-rewind propose "第二步的技术文档里 API 假设错了，得回过去重设计"
```

| 限定 | 说明 |
|------|------|
| **目标** | 必须是本工作流里**当前步之前**的普通步骤（按工作流定义顺序）。当前步（请用 `/ralphflow-reset`）、未来步骤、不存在的步骤、子工作流调用点都会被拒绝并给出准确理由 |
| **状态机** | `current_step` 拨到目标步；`fail_counts` **清空**；`paused` / `pause_reason` **清除**；`do_submitted` / `last_submit_summary` / `verdicts` / `delegations` 清空并中止在飞验证者 |
| **下游产物** | 已落盘的代码/文档**保留**——插件**不会自动删除**任何产物。DO 里会明写"下游旧产出仍在盘上、基于旧方向" |
| **原因** | `<步骤> <原因>` **两个都必填**。原因写进**目标步 DO、自成一段**（不是只写交接稿：换上下文失败时 DO 照样带着原因落地，所以没有 `keep_session` 这类逃生口） |
| **上下文** | 与 reset 同一根接线：整段替换属主会话可见面 + 一条可见告知（写明"用户执行了 `/ralphflow-rewind`"）+ 重投目标步 DO |
| **paused 实例** | **允许回退并顺带解除暂停**——很多用户正是发现卡死之后才决定换个方向重来 |
| **拒绝条件** | 目标 = 当前步 / 在未来 / 不存在 / 是子工作流调用点；或**未暂停 + 已交卷**（= 验证在飞 / 审查门已开，回退会把判定变成孤儿） |

> **没有「已通过 CHECK」这道门**：目标合法性只有"当前步之前的普通步骤"一条。引擎对进度的全部认知就是 `current_step`，"哪些步已通过"是判定与历史的**现算派生量**——本端不移植 opencode 那份 `step-records.json`（第二个事实源）。

---

## 完成标记

| 阶段 | 标记 | 含义 |
|------|------|------|
| DO | **调用 `ralphflow_submit` 工具** | 任务完成（dsh 原生：工具调用即事实，工具结果结束回合） |
| CHECK | `structured_output` 工具（provider 支持时） | 结构化判定 `{passed, reason}` |
| CHECK | `<promise-check>true</promise-check>` / `false` | provider 不支持结构化输出时的文本兜底 |

DO 阶段**不对模型自由文本做正则匹配**——交卷是工具调用。忘了交卷时，回合结束前会收到提醒（按"本次进入该步"起算，**上限 2 次**），用尽则暂停（`no_submit`）等你，绝不死循环催促。

验证者的判定**解析失败一律按基础设施故障处理，绝不 passed**（fail-closed）。

---

## 多步骤流程设计

> 下面每个示例都是完整、合法的工作流——每个普通步骤都带必填字段。

### 线性流程

```yaml
steps:
  - id: design
    desc: 设计阶段
    do: 创建技术设计。
    input: 用户需求
    output: "design.md"
    check: 核对 design.md 是否完整、合理。
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现阶段
    do: 按 design.md 写代码。
    input: design.md
    output: 可工作代码
    check: 跑测试并核对通过。
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### 分支流程

根据检查结果跳到不同步骤：

```yaml
steps:
  - id: analyze
    desc: 分析问题
    do: 判断这是 bug 修复还是新功能。
    input: 用户报告
    output: "analysis.md（对任务的分类）"
    check: analysis.md 的分类是否有报告依据支撑？
    on_pass: implement
    on_fail: clarify
    max_fail_count: 2

  - id: clarify
    desc: 请求澄清
    do: 向用户询问缺失细节并记录回答。
    input: analysis.md
    output: "clarification.md（含回答）"
    check: clarification.md 是否含有足以推进的细节？
    on_pass: analyze
    on_fail: clarify
    max_fail_count: 3

  - id: implement
    desc: 实现修复
    do: 写代码。
    input: analysis.md
    output: 可工作代码
    check: 是否能构建并通过测试？
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### 恢复流程

用 `on_fail` 路由到专门的恢复步骤：

```yaml
steps:
  - id: build
    desc: 构建项目
    do: 运行构建。
    input: 源码树
    output: 构建产物
    check: 构建成功了吗？
    on_pass: test
    on_fail: fix-build
    max_fail_count: 2

  - id: fix-build
    desc: 修复构建错误
    do: 阅读错误输出并修复问题。
    input: 构建错误输出
    output: 能构建的源码树
    check: 现在构建能过吗？
    on_pass: test
    on_fail: fix-build
    max_fail_count: 5

  - id: test
    desc: 跑测试
    do: 执行测试套件。
    input: 构建产物
    output: 测试结果
    check: 所有测试都通过吗？
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 3

  - id: fix-tests
    desc: 修复失败的测试
    do: 分析失败并修复。
    input: 测试失败输出
    output: 通过的测试套件
    check: 现在测试通过吗？
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 5
```

### 循环流程（回环）

把 `on_fail` 指向更早的步骤形成环：

```yaml
steps:
  - id: design
    desc: 设计
    do: 创建技术设计。
    input: 需求
    output: "design.md"
    check: 设计是否完整、合理？
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现
    do: 按 design.md 写代码。
    input: design.md
    output: 能编译、lint 干净的代码
    check: 代码能编译并通过 lint 吗？
    on_pass: test
    on_fail: design          # 实现暴露出设计缺陷则回到 design
    max_fail_count: 3

  - id: test
    desc: 测试
    do: 跑全量测试套件。
    input: 实现
    output: 测试结果
    check: 所有测试都通过吗？
    on_pass: done
    on_fail: implement       # 测试失败则回到 implement
    max_fail_count: 5
```

形成环 `design → implement → test → implement → test → …`。工作流自然收敛到可工作的解。

---

## 加载期硬错误 vs 告警忽略（速查）

| 写法 | 后果 |
|------|------|
| 缺 `id` / `desc` / `do` / `input` / `output` / `on_pass` / `on_fail` / `max_fail_count`，或为空串 | **硬错误**，整份拒收 |
| `on_fail: done`、`on_pass`/`on_fail` 引用不存在的步骤 | **硬错误** |
| `check` 非字符串、`check` 与 `check_voting` 同写 | **硬错误** |
| `check_voting` 空数组 / 超过 5 条 / 条目缺 `check` / 条目 `model` 类型非法 | **硬错误** |
| `check_model` 与 `check_voting` 同写 / 本步无有效 `check` / 类型非法 | **硬错误** |
| `reset`、`auto_reset` 非布尔 | **硬错误** |
| 步骤级 `manual_step` 键（任何值） | **硬错误** |
| `manual_step` 引用不存在的步骤 | **硬错误** |
| 子工作流成环 / 加载不出 / 深度 > 32 / 展开 > 2000 步 / id 撞名 | **硬错误** |
| `adversarial_check` 的 `agent` / `system_prompt` / `timeout_ms`、非对象 | 告警 + 忽略 |
| 投票条目的 `timeout_ms` / `system_prompt` | 告警 + 忽略 |
| 调用点的 `check*` / `inputs` | 告警 + 指路 |
| 模型引用解析不出（裸名、对象缺字段） | 告警 + 回退 |
| 未知顶层键 / 未知步骤键 | 告警 + 忽略 |
| `{{...}}` 模板记号 | 告警（doctor）；原样进入提示词 |

---

## 建议

- **步骤要聚焦**——每个步骤把一件事做好。
- **写自包含的 `check` 配方**——验证者完全没看过 DO 对话，所以要写明打开哪些文件、跑哪些命令、具体的通过/失败标准。模糊标准（"代码质量好"）让 CHECK 失效。
- **轻量 persona 助推验证**——`check` 开头加一句如「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」很有用。保持一行，别搞重型角色设定。
- **合理设 `max_fail_count`**——有界步骤 3–5，磨到全绿的循环设大（如 100）。
- **在错误方向代价高的地方用 `manual_step`**——方案、设计、破坏性操作。
- **用子工作流复用**——通用模式（分析、构建、测试）可以共享。
- **验证用更便宜的模型**——`adversarial_check.model` / `check_model` 能在保持质量的同时省钱。
- **`do` / `check` 正文用用户的语言写。**
