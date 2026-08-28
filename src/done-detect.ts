/**
 * done tag 检测（自 opencode 版 driver.ts 提取）：模型在回复最后输出
 * <promise>done</promise> 表示 DO 阶段完成。代码围栏/行内代码里的标记被忽略。
 *
 * 匹配策略（兼顾两类误判）：
 * - 标签必须落在文本末尾（允许尾随空白）——既容忍「完成。<promise>done</promise>」
 *   的同行写法，又排除正文提及（「…不要忘记输出 <promise>done</promise>」后面
 *   还跟实质内容时不会命中，避免提前触发验证白烧失败计数）；
 * - 未闭合围栏：``` 成对替换后仍剩奇数个时，最后一个开围栏之后的内容整体按
 *   代码处理，围栏内的标记不参与检测。
 */
const DONE_TAG_TAIL = /<promise>\s*done\s*<\/promise>[ \t]*$/i;

export function stripCodeBlocks(text: string): string {
  let result = text.replace(/```[\s\S]*?```/g, "");
  const openFences = result.split("```").length - 1;
  if (openFences % 2 === 1) {
    const idx = result.lastIndexOf("```");
    result = result.slice(0, idx);
  }
  result = result.replace(/`[^`\n]+`/g, "");
  return result;
}

export function detectDoneTag(lastOutput: string): boolean {
  const text = stripCodeBlocks(lastOutput).trimEnd();
  if (!text) return false;
  return DONE_TAG_TAIL.test(text);
}
