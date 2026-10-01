/**
 * Ralph Flow for dsh v2 — 自定义工作流创建指引（面向模型，与 opencode/claude 版语义一致）
 *
 * /ralphflow-create = 触发词：给模型指令 → 模型调用本工具的引导文本 → 与用户交互式
 * 设计 → 写 YAML → ralphflow_doctor 校验到「全部 ✅ 且无告警」。
 *
 * §1.6：本指引与引擎**实际行为**逐条对齐（含 dot-dir 路径、`/ralphflow-<工作流名>` 快捷命令、
 * 各字段的可选性与缺省行为、doctor 的真实输出形态）。
 */

export const CREATE_GUIDE = `和用户一起交互式设计一个自定义 Ralph Flow 工作流，写入 \`<workspace>/.dsh/ralph-flow/workflows/<name>.yaml\`（仅本工作区生效）或 \`~/.dsh/ralph-flow/workflows/<name>.yaml\`（全局可用，插件更新不覆盖），并用 ralphflow_doctor 工具校验，直到它的输出里**每一项都是 ✅、没有 ❌、也没有告警**。

## 步骤

1. **理解要自动化的流程。** 一轮问清，不要盘问：
   - 要让工作流运行的是什么重复性流程？它有哪些阶段？
   - 哪里要设人工审查门（该步停下等人放行：有 \`check\` 时是**对抗验证通过后**停，没有 \`check\` 时是**纯人工审查**）？
   如果用户已描述清楚，跳过提问直接设计。

2. **呈现步骤图**再写文件：紧凑概览（步骤 id → 做什么 → on_pass/on_fail 目标），按反馈调整。

3. **写 YAML**（kebab-case 命名）。存放范围：默认本工作区；与内置（loop/spec）同名会遮蔽内置，确认有意再写。

4. **校验**：调用 ralphflow_doctor 工具，修复它报出的每个 ❌ 与告警，重跑直到**全部 ✅ 且无告警**（doctor 的结论行写作「所有 ❌ 项即阻塞项，修复后重跑本命令直至全部 ✅」）。

5. **交接**：展示最终步骤概览与运行方式：\`/ralphflow-start <名字> <任务>\`；下个会话起也可直接用自动注册的**快捷命令 \`/ralphflow-<工作流名>\`**（例如工作流叫 \`migrate\` 就是 \`/ralphflow-migrate <任务>\`）。

## 本版本支持的 YAML 方言（引擎硬校验）

\`\`\`yaml
description: 一行描述，显示在工作流列表里   # 可选，建议填

manual_step:            # 可选：停下等人放行的步骤 id（有 check → 对抗验证通过后停；无 check → 纯人工审查）
  - design              # 列表写法；也接受逗号字符串 "design,review"
                        # 引用不存在的步骤 = 硬错误（门会静默失效，绝不放过）

adversarial_check:      # 可选：独立验证者配置（**只允许 model 一个字段**）
  model: deepseek/deepseek-chat   # 可选：验证模型。两种写法都行：
                        #   "provider/model" 字符串，或对象 { providerID, modelID }（两者都要填）
                        #   裸模型名（如 sonnet）解析不出 provider → 告警并回退发起会话当前模型
                        # 不写则验证者沿用发起会话当前模型；别的字段一律告警忽略，不生效
                        # 验证者身份/职责是 Ralphflow 内部定义，不需要也**不能**在 YAML 里配置
                        # 验证超时不在这里设置（交给宿主 dsh 的原生看门狗）

steps:                  # 必填，非空；从第一个元素开始执行
  - id: step-id         # 必填，唯一
    desc: 一句话说明     # 可选，但强烈建议填（会进 DO/CHECK 提示词）
    do: |               # 必填：主会话执行的 DO 指令（缺失/非字符串/空串 = 硬错误）
      完成实际工作…
    check: |            # 非 manual_step 步骤请务必填：独立验证者的取证判定配方
      检查…              # 缺 check = 该步不做独立验证，DO 完成直接进入下一步；
                        # manual_step 步骤缺 check 则是纯人工审查（停门等你放行）
    # check_voting:     # 与 check 二选一（同写 = 硬错误）：多验证者投票，1-5 个验证者**并行**、
                        # 各查一条检查依据、**全过才放行**；任一票不通过 → 整体失败并聚合所有失败理由
    #   - check: 用户任务的每一条要求都已落实
    #   - check: 实现的行为符合预期，真实可用
    #     model: deepseek/deepseek-chat   # 可选：该票专用模型（不填继承全局 adversarial_check.model）
    input: proposal.md  # 可选：输入说明（**只进 CHECK 提示词**；DO 提示词不注入 input）
    output: |           # 可选：交付物说明（进 DO 的「交付物」与 CHECK；裸文件名即落在产出目录）
      实现的代码 + summary.md
    on_pass: next-id    # 可选，缺省 = 顺序下一步（末步视为 "done"）；写了必须指向存在的步骤或 "done"
    on_fail: step-id    # 可选，缺省 = 自身；写了必须指向存在的步骤（不允许 "done"）
    max_fail_count: 3   # 可选，缺省 3；写了必须是 ≥1 的整数（0/负数/小数 = 硬错误）
    check_model: deepseek/deepseek-chat   # 可选：**本步**的验证模型，覆盖全局 model（写法同 model）
                        # 仅单 check 场景生效：与 check_voting 同写、或本步没有 check = 硬错误
\`\`\`

**验证模型优先级链**（与 opencode/claude 一致）：\`check_voting\` 条目 \`model\` > 步骤 \`check_model\` > 全局 \`adversarial_check.model\` > 发起会话当前模型（都不写时不传模型覆盖，由宿主继承发起会话的 provider/model）。

**硬规则**（违反 → 启动即被拒绝并说人话）：\`do\` 必填且为非空字符串；\`check\` 若出现必须是字符串（\`check: true\` 这类会被拒绝：非字符串会被视为未配置检查并跳过验证，本意是跳过请直接删掉该字段）；\`check\` 与 \`check_voting\` **互斥**（同写 = 硬错误）；\`check_voting\` 必须是 1-5 条的数组、每条有非空的 \`check\`（空数组/超 5 条/条目缺 check = 硬错误）；on_pass/on_fail 可省略，但一旦写了必须引用存在的步骤 id（"done" 仅 on_pass 有效）；manual_step 必须引用存在的步骤 id；\`max_fail_count\` 可省略（缺省 3），但一旦写了必须是 ≥1 的整数；\`check_model\` 与 \`check_voting\` 同写、或写了 \`check_model\` 却没有 \`check\`，都是硬错误；steps 非空、id 唯一。

**doctor 告警**（能启动，但会出问题）：不可达步骤（从第一个步骤沿 on_pass/on_fail 走不到）；没有任何可达步骤的 \`on_pass: done\`（工作流永远无法完成）；\`{{...}}\` 模板记号（本版本**不解析任何**模板变量）；**非 manual_step 且既无 \`check\` 也无 \`check_voting\`** 的步骤（该步不会被独立验证，DO 完成后直接进入下一步——manual_step 的这类步骤是纯人工审查，**不告警**）；\`check_voting\` 只有 1 票且没配 \`model\`（等同单验证者，建议直接用 \`check\` 或配多视角/多模型）；\`model\`/\`check_model\`/投票条目的 \`model\` 解析不出 provider（裸模型名，或对象缺 providerID/modelID）——此时该配置被忽略并回退，**不会静默生效**；\`adversarial_check\` 不是对象、或写了 \`model\` 以外的字段、投票条目里写了 \`check\`/\`model\` 以外的字段——这些字段被忽略（不生效），错误照旧在加载期就报出来，不拖到验证阶段。

**产出目录**：每个实例有隔离的产出目录 \`<workspace>/.dsh/ralph-flow/artifacts/<实例ID 摘要>/\`（目录名 = 任务摘要 slug + 实例 id 尾段），实例启动时自动建好。DO 与 CHECK 提示词都会自动带上「产出目录」一行，所以在 \`do\`/\`output\` 里**写裸文件名**即可（例如 \`summary.md\`），不用写路径、也不需要任何模板记号。

**实例生命周期**：工作流完成或取消时，实例目录与 \`state.json\` 会被**销毁**，最终报告归档到 \`<workspace>/.dsh/ralph-flow/reports/<实例ID>.md\`（报告与产出是永久的，插件永不自动删除；只有**空的**产出目录会被删掉）。要回看已结束的运行，用 \`/ralphflow-list\` 的「历史运行」节或直接读报告文件。

**本版本未支持**：**子工作流步骤**——\`workflow: xxx\` 这个键本身会被警告忽略，但按子工作流形状写的步骤（只有 \`workflow\`/\`input\`/\`output\`、**没有 \`do\`**）会因 \`do\` 必填而**硬错误、工作流无法启动**（本版本没有子工作流，请把子流程展开成普通步骤）；其它未识别键警告忽略。

## 设计最佳实践（除非用户反对，都应用）

- do 必须要求真实工作而非分析：建文件、跑命令、产出指定输出；主会话以调用 \`ralphflow_submit\` 工具交卷。
- check 写成**自包含验证配方**：打开哪些文件、跑哪些命令、具体的通过/失败标准。含糊标准（"代码质量好"）会让验证形同虚设。
- 开放式任务用**检查清单模式**：第一步把需求拆解成 summary.md（每项客观可验证并标注验证方法），后续步骤执行并勾选；它们的 check 独立地重新验证每一项，不信任勾选本身。
- 需要**多视角/多标准**验证同一步产出时用 \`check_voting\`（每条一条独立标准，如「需求逐条落实」「行为真实可用」「无遗漏边界」），或对同一产出用不同模型交叉检查；票数越多成本越高，2-3 条通常够用。
- check 里加一行轻量角色暗示让验证更犀利，例如「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」一行，不要重角色设定。
- on_fail 通常指向步骤自身；只有当一次失败真的让早前产出失效时，才指向更早步骤。max_fail_count：有界步骤 3–5，"磨到通过"的循环 100。
- 人工门用在方向错了代价大的步骤（方案、设计、破坏性操作）——把 id 列进 manual_step。
- do/check 正文用用户的语言书写。`;
