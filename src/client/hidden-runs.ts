/**
 * Ralph Flow for dsh — 手动隐藏 run 卡（存量僵尸卡的最终出口）
 *
 * 修复前的历史遗留：某些旧卡片收不到任何终态帧（跨会话接管时代产生的僵尸），
 * 实例本身可能早已销毁——没有任何帧能把它们救活。给终态卡一个 × 关闭按钮，
 * runId 进 localStorage 屏蔽名单，折叠器 match 层直接过滤。内存缓存避免高频
 * localStorage 读；跨标签页通过 storage 事件同步。
 */
const KEY = "ralphflow:hidden-runs";

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

function persist(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set].slice(-300)));
    cache = set;
  } catch {}
}

export function isRunHidden(runId: string | undefined): boolean {
  if (!runId) return false;
  try {
    return load().has(runId);
  } catch {
    return false;
  }
}

export function hideRun(runId: string): void {
  try {
    const s = load();
    s.add(runId);
    persist(s);
  } catch {}
}

/** 折叠器入口：被屏蔽的 run 直接不匹配（不建卡、不更新） */
export function isHiddenEvent(data: { runId?: unknown }): boolean {
  const id = data?.runId;
  return typeof id === "string" && id.length > 0 && isRunHidden(id);
}
