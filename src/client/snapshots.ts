/**
 * Ralph Flow for dsh — client 端 run 状态快照（刷新失明的对策）
 *
 * 宿主的 session 持久化只保留「模型面」事件（message/tool/turn/step），
 * 插件经 session.append 发送的自定义帧（tool-ralphflow/*，连宿主自己的
 * command/run 也一样）不落盘——实时帧可达 client，但刷新页面后折叠器无帧
 * 可重放，卡片全部消失、页头计数归零（「刷新即瞎」）。
 *
 * 对策：RunCard 每次状态变化把精简快照写 localStorage；HeaderAction 的
 * collectRuns 以 chat.nodes 为主源、快照补盲——刷新后抽屉仍能看到实例
 * 列表与状态（对话流内嵌卡受框架限制暂不恢复，定位按钮降级为 status 查询）。
 */
const KEY = "ralphflow:run-snapshots";
const MAX_SNAPS = 20;
/** 单快照里长文本的截断上限（reasoning/失败原因可能上万字符） */
const MAX_TEXT = 1500;
/** 快照有效期：超龄的不再进抽屉（状态早已失真） */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** selector 高频执行——读结果做 1s 节流缓存 */
let cacheAt = 0;
let cacheValue: Record<string, Record<string, unknown>> = {};

interface SnapRecord {
  savedAt: number;
  state: Record<string, unknown>;
}

function loadAll(): Record<string, SnapRecord> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, SnapRecord>) : {};
  } catch {
    return {};
  }
}

function persist(all: Record<string, SnapRecord>): void {
  try {
    // 按 savedAt 淘汰最旧的，控制总量
    const entries = Object.entries(all)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_SNAPS);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

/** 精简一份 run state：长文本截断，去掉逐票 reasoning（体积大头） */
export function compactRunState(data: Record<string, unknown>): Record<string, unknown> {
  const clip = (v: unknown): unknown =>
    typeof v === "string" && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  const verdicts = Array.isArray(data.verdicts)
    ? (data.verdicts as Record<string, unknown>[]).map((v) => ({ ...v, reasoning: clip(v.reasoning) }))
    : data.verdicts;
  const lastCheck = data.lastCheck && typeof data.lastCheck === "object"
    ? { ...(data.lastCheck as Record<string, unknown>), reason: clip((data.lastCheck as Record<string, unknown>).reason) }
    : data.lastCheck;
  const report = data.report && typeof data.report === "object"
    ? { ...(data.report as Record<string, unknown>), text: clip((data.report as Record<string, unknown>).text) }
    : data.report;
  return { ...data, verdicts, lastCheck, report };
}

/** RunCard 状态变化时调用（写侧） */
export function saveRunSnapshot(data: Record<string, unknown>): void {
  try {
    const runId = String(data?.runId ?? "");
    if (!runId) return;
    const all = loadAll();
    all[runId] = { savedAt: Date.now(), state: compactRunState(data) };
    persist(all);
    cacheAt = 0; // 写后失效读缓存
  } catch {}
}

/** collectRuns 的补盲源（读侧）。返回 runId → state 映射（1s 节流 + 24h 过期） */
export function loadRunSnapshots(): Record<string, Record<string, unknown>> {
  try {
    const now = Date.now();
    if (now - cacheAt < 1000) return cacheValue;
    const all = loadAll();
    const out: Record<string, Record<string, unknown>> = {};
    for (const [runId, rec] of Object.entries(all)) {
      if (!rec?.state) continue;
      if (now - (rec.savedAt || 0) > MAX_AGE_MS) continue;
      out[runId] = rec.state;
    }
    cacheAt = now;
    cacheValue = out;
    return out;
  } catch {
    return {};
  }
}

/** 抽屉读快照时要跳过被用户手动关闭的 run */
export function isRunHiddenSnap(runId: string): boolean {
  try {
    const raw = localStorage.getItem("ralphflow:hidden-runs");
    const set: string[] = raw ? JSON.parse(raw) : [];
    return set.includes(runId);
  } catch {
    return false;
  }
}
