/**
 * Graph CHECK 判据归一化与快照。
 *
 * Graph 不提供固定的“默认 CHECK”文本：判据必须由资产作者（或设计 Graph 的模型）按
 * writing-for-agents 写成显式验收条件。`check: null` 表示该节点跳过独立验证，
 * 与 Flow 的“不写 check = 跳过”同一语义。
 *
 * 判定本身不在这里产生：Graph CHECK 必须走 `src/verify.ts` 的独立验证者运行时（T1）。
 */
import { createHash } from "node:crypto";

export interface CheckDisabled {
  mode: "disabled";
  criteriaText: "";
  criteria: [];
}
export interface CheckCustom {
  mode: "custom";
  criteriaText: string;
  criteria: string[];
}
export type CheckDefinition = CheckDisabled | CheckCustom;

/** 多行判据：全部是列表项时逐项拆开，否则整段作为一条。 */
export function criteriaItems(criteria: string): string[] {
  const lines = criteria.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [criteria];
  // 单行也允许带一个列表标记：作者常写 `criteria: |` + `1. …`，这里剥掉外层标记后
  // 提示词再统一编号，证据才逐字对得上。
  if (!lines.every((line) => /^(?:[-*+]\s+|\d+[.)、]\s*)/.test(line))) return [criteria];
  return lines.map((line) => line.replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, ""));
}

/**
 * 归一化 Graph CHECK：
 *   - 字符串：显式判据（与 Flow 的 `check` 同形）
 *   - `null` / 省略：关闭独立 CHECK
 *
 * 对象写法（`{mode: default}` / `{mode: custom, criteria}`）已移除。
 */
export function checkDefinition(check: unknown): CheckDefinition {
  if (check === undefined || check === null) {
    return { mode: "disabled", criteriaText: "", criteria: [] };
  }
  if (check !== null && typeof check === "object") {
    throw new Error("Graph CHECK 只接受字符串或 `check: null`；`{mode, criteria}` 对象写法已移除。");
  }
  if (typeof check !== "string" || !check.trim()) {
    throw new Error("CHECK 需要非空判据字符串；要关闭 CHECK 请显式写 `check: null`。");
  }
  return { mode: "custom", criteriaText: check, criteria: criteriaItems(check) };
}

/** 判据版本：自定义判据用原文 sha256；关闭时为 null。 */
export function checkVersion(definition: CheckDefinition): string | null {
  if (definition.mode === "disabled") return null;
  return `sha256:${createHash("sha256").update(definition.criteriaText).digest("hex")}`;
}
