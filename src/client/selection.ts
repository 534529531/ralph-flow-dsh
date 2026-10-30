/**
 * 打开工作图时先看哪一个资产（纯函数）。
 *
 * 优先级：
 * 1. 本次打开里用户手动选过的资产 —— 显式选择最高；
 * 2. 当前会话正在跑的工作流 —— 「工作流在跑，一打开工作图就是它」；
 * 3. 上次记住的浏览偏好（localStorage，跨会话）；
 * 4. 目录里的第一个。
 *
 * 运行中的工作流换了身份（新一轮开始、换成另一个工作流、跑完状态消失）时，调用方作废
 * 显式选择并重新跟随运行 —— 否则「上次浏览过哪个」会盖住「现在在跑哪个」。
 *
 * 边界：只做名字选择，不读 localStorage、不碰实例状态；未知名字一律当没写。
 */
import type { ViewerAsset } from "../status-contract.js";

type PickInput = {
  catalogNames: readonly string[];
  /** 当前会话正在跑的工作流；没有就是 null。 */
  running: string | null;
  /** 本次打开里手动选过的资产。 */
  chosen: string | null;
  /** 上次记住的浏览偏好。 */
  pinned: string | null;
};

export function pickAssetName(input: PickInput): string {
  const known = (name: string | null): string | null => (name !== null && input.catalogNames.includes(name) ? name : null);
  return known(input.chosen) ?? known(input.running) ?? known(input.pinned) ?? input.catalogNames[0] ?? "";
}

/** 工作流选择器的一行：步骤/节点数 + 定义无效标记 + 运行中标记。 */
export function assetMenuLabel(asset: ViewerAsset, running: string | null): string {
  const size = asset.kind === "flow" ? `${asset.steps.length} 步` : `${asset.nodes.length} 节点`;
  return `${asset.name} · ${size}${asset.invalid ? "（定义无效）" : ""}${asset.name === running ? " · 运行中" : ""}`;
}
