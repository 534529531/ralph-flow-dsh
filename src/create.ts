/**
 * Ralph Flow for dsh — 自定义工作流创建指引（移植自 opencode 版 commands.ts 的
 * ralphflow-create 模板，路径改为 dsh 布局）
 *
 * dsh 的命令通道是 log-only（never model surface，见 dsh-commands/lib/index.js
 * "without sending it to the model"），无法像 opencode 那样把 prompt 模板注入
 * 模型对话。因此拆成两端：
 *  - 本模块导出 CREATE_GUIDE（完整设计指引），由 host 工具 ralphflow_create
 *    返回给模型——模型被调用后按指引与用户交互式设计 YAML 并落盘；
 *  - /ralphflow-create 命令作为用户入口：展示如何唤起模型 + 指引摘要卡。
 */

export const CREATE_GUIDE = `和用户一起交互式设计一个自定义 Ralph Flow 工作流，把它写入 \`<workspace>/ralph-flow/workflows/<name>.yaml\`（仅本工作区生效）或 \`~/.dsh/ralph-flow/workflows/<name>.yaml\`（全局可用，插件更新不覆盖），并用 ralphflow_doctor 工具校验，直到它干净且可启动。

## 步骤

1. **理解要自动化的流程。** 询问用户（一轮问清，不要盘问）：
   - 要让工作流运行的是什么重复性流程？它有哪些阶段？
   - 他们希望在哪里设人工审查门（工作流在验证前停下等他们批准）？
   - 某个阶段是否要复用现有工作流作为子工作流？（ralphflow_list 显示已有哪些。）
   如果用户已经把这些都描述清楚了，跳过提问直接设计。

2. **设计步骤图并呈现**，在写文件前给出一个紧凑的概览（步骤 id → 它做什么 → on_pass/on_fail 目标）。根据反馈调整。

3. **写 YAML**（kebab-case 命名）。询问用户存放范围，或默认放工作区：
   - 仅本工作区 → \`<workspace>/ralph-flow/workflows/<name>.yaml\`
   - 所有项目可用 → \`~/.dsh/ralph-flow/workflows/<name>.yaml\`

   需要时创建目录。如果名字和内置工作流（\`loop\`、\`spec\`）相同，告诉用户它会遮蔽内置的，并确认这是有意为之。

4. **校验**：调用 ralphflow_doctor 工具，检查新工作流那一节。修复它为该工作流报出的每一个问题和警告，重新运行 doctor，重复直到它的结论是「可启动」且没有警告。

5. **交接**：把最终的步骤概览展示给用户，并告诉他们怎么运行：本会话里用 \`/ralphflow-start\`，工作流填 \`<name>\`，再加上他们的任务描述；从下个会话起，还可以直接用自动注册的 \`/<name>\` 快捷命令。

## YAML 结构（精确——引擎会校验以下全部内容）

\`\`\`yaml
description: 一行描述，显示在工作流列表里   # 可选，但建议填

manual_step:            # 可选：在 DO 之后、验证之前暂停以供人工审查的步骤 id
  - design

adversarial_check:      # 可选：独立验证者会话的配置
  model:                # 可选：验证器模型；对象形式或 "provider/model" 字符串
    providerID: anthropic
    modelID: claude-sonnet-4-5
  agent: spawn          # 可选：验证者子代理名（默认 "spawn"，即临时独立会话）
  timeout_ms: 3600000   # 上限 3600000（1 小时）
  # system_prompt: ...  # 可选：给验证器的额外 system 提示
  # 嵌套时逐字段继承：子工作流只覆盖它填了且有效的字段，其余回退父工作流
\`\`\`

\`\`\`yaml
steps:                  # 必填，非空；执行从第一个元素开始
  - id: step-id         # 必填，唯一字符串
    desc: 一句话说明     # 必填
    do: |               # 必填（除非这是子工作流步骤）
      由执行会话运行的 DO 阶段指令。
    check: |            # 单步验证时必填；写 check_voting 则不需要 check
      由独立验证者会话运行的 CHECK 阶段指令。
    input: 上一步的产物或用户输入   # 必填：这一步消费什么
    output: "result.md"            # 必填：这一步必须产出什么
    on_pass: next-step-id          # 必填：步骤 id，或 "done" 表示结束工作流
    on_fail: step-id               # 必填：重试/回退到的步骤 id（不允许 "done"）
    max_fail_count: 3              # 必填，数字 ≥ 1：CHECK 失败这么多次后为用户暂停

  - id: delegate        # 子工作流步骤：用以下内容替代 do/check：
    workflow: loop      # 另一个工作流的名字（嵌套上限深度 5，不能成环）
    desc: ...
    input: ...
    output: ...
    on_pass: done
    on_fail: delegate
    max_fail_count: 3
\`\`\`

引擎强制的硬规则（违反会导致文件不可启动或静默丢弃步骤）：

- 上面标注必填的每个字段都是每个步骤必填——缺一个的步骤会被静默跳过，而工作流其余部分照常运行。绝不要省略 input/output。
- on_pass/on_fail 必须引用存在的步骤 id（"done" 仅 on_pass 有效）。
- manual_step 条目必须匹配存在的步骤 id——拼错是设计上的硬错误。
- manual_step 只能标在带 do/check 的最小步骤上，不能标在子工作流（复合）步骤上——否则加载即被拒绝。若要在子工作流后停下审查，把 manual_step 标在该子工作流内部最后一个普通步骤上。
- check 与 check_voting 二选一；check_voting 是 1-5 个验证者的数组，每项 {check, model?, timeout_ms?}，全票通过才放行。
- 没有模板变量。引擎除了内部的 {{artifacts_dir}} 转义记号什么都不解析，而你不需要它：每个 DO/CHECK 提示都会自动带上「产出目录」一节。在 output 里写裸文件名（例如 "plan.md"）；会话知道要把它们放进产出目录。

## 设计最佳实践（除非用户反对，都应用这些）

- do 必须要求真实工作，而不是分析：创建文件、运行命令、产出指定的输出。会话通过输出 \`<promise>done</promise>\` 结束 DO。
- check 由一个没看过任何 DO 对话的独立会话执行。把它写成自包含的验证配方：打开哪些文件、运行哪些命令、具体的通过/失败标准。含糊的标准（「代码质量好」）会让验证形同虚设。
- 检查清单模式适合开放式任务：第一步把需求拆解成一份 summary.md，其中每一项都客观可验证并标注验证方法；后续步骤执行并勾选；它们的 check 独立地重新验证每一项，而不是相信勾选。
- 在 check 里加轻量的角色暗示能让验证更犀利，例如开头写「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」保持一行——不要重量级的角色设定。
- 重试循环：on_fail 通常指向步骤自身；只有当一次失败真的让早前的产出失效时，才指向更早的步骤。max_fail_count 对有界步骤取 3–5，对「磨到通过」的循环取大值（如 100）。
- 人工门用在方向错了代价很大的地方（方案、设计、破坏性操作）——把这些步骤 id 列进 manual_step。
- 语言：do/check 的正文用用户的语言书写。`;

/** 用户侧摘要（/ralphflow-create 命令卡展示） */
export function createUserGuideSummary(userInput: string): string {
  const idea = userInput.trim();
  return `## 🛠 创建自定义工作流\n\n${idea ? `你的想法：**${idea}**\n\n` : ""}工作流的「设计—写盘—校验」由模型引导完成（dsh 的 slash 命令无法直接驱动模型，需要你发起一轮对话）：\n\n1. 把下面这句话发送给模型（直接复制）：\n\n   > ${idea ? `帮我创建一个 Ralph Flow 工作流：${idea}` : "帮我创建一个自定义 Ralph Flow 工作流"}（调用 ralphflow_create 工具获取设计指引，与我交互式完成）\n\n2. 模型会与你确认步骤图 → 写入 YAML → 自动跑 /ralphflow-doctor 校验到「可启动」。\n3. 完成后用 \`/ralphflow-start <名字> <任务>\` 运行；下个会话起可直接用 \`/<名字>\` 快捷命令。\n\n> 存放位置：工作区 \`<workspace>/ralph-flow/workflows/\` 只对本工作区生效；全局 \`~/.dsh/ralph-flow/workflows/\` 所有项目可用且插件更新不覆盖。`;
}
