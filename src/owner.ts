/**
 * 属主租约：判断「这个实例还有没有运行时在推进它」的唯一事实。
 *
 * 为什么不用 PID：本部署里各 agent 进程跑在各自的 sandbox 里，有独立的 PID namespace 与
 * `/proc` 视图 —— 实测宿主进程明明活着，另一个进程 `kill(pid, 0)` 却是 `ESRCH`。跨进程
 * 唯一可靠共享的是**文件系统**，所以判活写在实例的 `state.json` 里，不引入第二个事实源。
 *
 * 判活分两段：
 *   - `ownerAlive`：超过 TTL 没刷新 = 属主已死（硬判据）。
 *   - `ownerRecheckMs`：重启后的最后一下心跳必然还新鲜。等一个刷新窗口再看：心跳若往前
 *     走了，属主是另一个活着的 host；没走，才是真死了。这样快速重启不用等满 TTL，也不会
 *     误伤另一个仍在同一个项目里工作的 dsh。
 *
 * 心跳只由**正在驱动实例**的运行时刷新（Flow：DO/验证中；Graph：running）。暂停、审查门、
 * 等待人工处理都不需要属主 —— 它们本来就该由任何一个 host 接管。
 */
export const OWNER_HEARTBEAT_REFRESH_MS = 5_000;
export const OWNER_HEARTBEAT_TTL_MS = 60_000;
/** 快速复查窗口：3 个刷新周期，容忍两次漏刷。 */
export const OWNER_RECHECK_MS = 15_000;

export interface OwnerStamp {
  owner_runtime?: string;
  owner_heartbeat_at?: number;
}

/** 本进程的运行时 id（只作诊断与心跳归属，不参与 PID 判活）。 */
let cachedRuntimeId: string | undefined;
export function runtimeId(): string {
  if (cachedRuntimeId === undefined) {
    cachedRuntimeId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return cachedRuntimeId;
}

/** 心跳是否仍在 TTL 内。缺字段 = 来源不可考的旧状态，按已死处理。 */
export function ownerAlive(state: OwnerStamp, now = Date.now()): boolean {
  return typeof state.owner_heartbeat_at === "number" && Number.isFinite(state.owner_heartbeat_at)
    && now - state.owner_heartbeat_at <= OWNER_HEARTBEAT_TTL_MS;
}

/**
 * 快速复查延迟。测试可经 `RALPHFLOW_OWNER_RECHECK_MS` 缩短（不落盘、不影响生产默认值）。
 * 返回 0 表示不复查（调用方仍可用 `ownerAlive` 的硬判据）。
 */
export function ownerRecheckMs(): number {
  const raw = process.env.RALPHFLOW_OWNER_RECHECK_MS;
  if (raw === undefined || raw.trim() === "") return OWNER_RECHECK_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : OWNER_RECHECK_MS;
}

/** 把当前运行时登记为属主（写心跳起点）。 */
export function stampOwner(state: OwnerStamp, now = Date.now()): void {
  state.owner_runtime = runtimeId();
  state.owner_heartbeat_at = now;
}
