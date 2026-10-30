/**
 * 未完成项归一化（两个引擎共用，纯函数）。
 *
 * 这是**模型自述**，只决定「要不要启动验证」，不参与任何判定（T1）。
 * 限条数与单条长度只为一件事：别让一段失控的自述把 `state.json` 与通知面撑爆。
 * 单条 800 字符：提醒会把清单原文带回模型，200 实测会把英文技术条目（230–509
 * 字符）截成半句；20 条上限仍在，体积可控。
 */
export const UNFINISHED_MAX_ITEMS = 20;
export const UNFINISHED_MAX_LENGTH = 800;

export function normalizeUnfinished(unfinished: unknown): string[] {
  if (!Array.isArray(unfinished)) return [];
  return unfinished
    .map((item) => String(item ?? "").trim().slice(0, UNFINISHED_MAX_LENGTH))
    .filter((item) => item.length > 0)
    .slice(0, UNFINISHED_MAX_ITEMS);
}
