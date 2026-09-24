/**
 * Ralph Flow for dsh v2 — 自定义工作流创建指引（面向模型，与 opencode/claude 版语义一致）
 *
 * /ralphflow-create = 触发词：给模型指令 → 模型调用本工具的引导文本 → 与用户交互式
 * 设计 → 写 YAML → ralphflow_doctor 校验到「可启动」。
 */

export const CREATE_GUIDE = `和用户一起交互式设计一个自定义 Ralph Flow 工作流，写入 \`<workspace>/ralph-flow/workflows/<name>.yaml\`（仅本工作区生效）或 \`~/.dsh/ralph-flow/workflows/<name>.yaml\`（全局可用，插件更新不覆盖），并用 ralphflow_doctor 工具校验，直到报告「可启动」。

## 步骤

1. **理解要自动化的流程。** 一轮问清，不要盘问：
   - 要让工作流运行的是什么重复性流程？它有哪些阶段？
   - 哪里要设人工审查门（该步**对抗验证通过后**停下等人放行）？
   如果用户已描述清楚，跳过提问直接设计。

2. **呈现步骤图**再写文件：紧凑概览（步骤 id → 做什么 → on_pass/on_fail 目标），按反馈调整。

3. **写 YAML**（kebab-case 命名）。存放范围：默认本工作区；与内置（loop/spec）同名会遮蔽内置，确认有意再写。

4. **校验**：调用 ralphflow_doctor 工具，修复它报出的每个问题与警告，重跑直到「可启动」且无警告。

5. **交接**：展示最终步骤概览与运行方式：\`/ralphflow-start <名字> <任务>\`；下个会话起可直接用自动注册的 \`/<名字>\` 快捷命令。

## 本版本支持的 YAML 方言（引擎硬校验）

\`\`\`yaml
description: 一行描述，显示在工作流列表里   # 可选，建议填

manual_step:            # 可选：对抗验证通过后停下等人放行的步骤 id 列表
  - design

adversarial_check:      # 可选：独立验证者配置
  model: deepseek/deepseek-chat   # 可选："provider/model" 验证模型；填则换，不填用默认
  # agent: spawn        # 可选：验证者子代理名（默认用部署可用者）
  # system_prompt: ...  # 可选：给验证者的 system 提示
  # 注：timeout_ms 本版本未支持（警告忽略）——验证超时交给宿主 dsh 的原生看门狗

steps:                  # 必填，非空；从第一个元素开始执行
  - id: step-id         # 必填，唯一
    desc: 一句话说明
    do: |               # 必填：主会话执行的 DO 指令
      完成实际工作…
    check: |            # 必填：独立验证者执行的取证判定配方
      检查…
    on_pass: next-id    # 必填：下个步骤 id，或 "done" 结束
    on_fail: step-id    # 必填：失败重试目标（通常指向自身，不允许 "done"）
    max_fail_count: 3   # 必填 ≥1：失败这么多次后暂停等用户
\`\`\`

**硬规则**：on_pass/on_fail 必须引用存在的步骤 id（"done" 仅 on_pass 有效）；manual_step 必须引用存在的步骤 id；steps 非空、id 唯一。违反 → 启动即被拒绝并说人话。

**本版本未支持（见到会警告并忽略，不报错）**：\`check_voting\`（多验证者投票，v0 单验证者按通用对抗检查执行）、子工作流步骤（\`workflow: xxx\`）、\`input\`/\`output\`（v0 不校验）、其它未识别键。

## 设计最佳实践（除非用户反对，都应用）

- do 必须要求真实工作而非分析：建文件、跑命令、产出指定输出；主会话以调用 \`ralphflow_submit\` 工具交卷。
- check 写成**自包含验证配方**：打开哪些文件、跑哪些命令、具体的通过/失败标准。含糊标准（"代码质量好"）会让验证形同虚设。
- 开放式任务用**检查清单模式**：第一步把需求拆解成 summary.md（每项客观可验证并标注验证方法），后续步骤执行并勾选；它们的 check 独立地重新验证每一项，不信任勾选本身。
- check 里加一行轻量角色暗示让验证更犀利，例如「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」一行，不要重角色设定。
- on_fail 通常指向步骤自身；只有当一次失败真的让早前产出失效时，才指向更早步骤。max_fail_count：有界步骤 3–5，"磨到通过"的循环 100。
- 人工门用在方向错了代价大的步骤（方案、设计、破坏性操作）——把 id 列进 manual_step。
- do/check 正文用用户的语言书写。`;