/**
 * Ralph Flow for dsh — 实例级推进互斥
 *
 * 单进程内同一实例的「读状态→异步推进」段可能被并发进入：两个会话同时对同一
 * 实例 continue、job 事件驱动与 continue 同时触发 runCheckAndAdvance。这里用
 * 每实例一条 Promise 链把关键段串行化，避免双重验证/双重推进。
 */

const locks = new Map<string, Promise<void>>();

/** 在 instId 的互斥段内执行 fn；同实例的调用按到达顺序串行，不同实例互不阻塞。 */
export function withInstanceLock<T>(instId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(instId) ?? Promise.resolve();
  const next = prev.then(fn);
  // 链锚点吞掉 rejection：前一个调用失败不能阻断后一个排队者
  const anchor = next.then(
    () => {},
    () => {},
  );
  locks.set(instId, anchor);
  void anchor.finally(() => {
    if (locks.get(instId) === anchor) locks.delete(instId);
  });
  return next;
}
