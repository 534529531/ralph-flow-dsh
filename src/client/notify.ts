/**
 * Ralph Flow for dsh — 桌面通知 + 标签页标题提醒
 *
 * 等待的本质问题是「你在等它，但不知道要等多久」——于是切去干别的，回来才
 * 发现它早就停在那等你了。终态事件（审查门/暂停/完成）弹系统通知并让标签页
 * 标题闪烁，点通知聚焦窗口。全部容错：权限被拒/环境不支持时静默降级为零
 * 存在感；sessionStorage 去重防止事件重放（接管历史回放）重复轰炸。
 */

const NOTIFIED_KEY = "ralphflow:notified";
/** 同一会话内已通知过的 `${runId}:${kind}` 集合 */
function notifiedSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(NOTIFIED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function markNotified(key: string): void {
  try {
    const s = notifiedSet();
    s.add(key);
    sessionStorage.setItem(NOTIFIED_KEY, JSON.stringify([...s].slice(-200)));
  } catch {}
}

export function notificationsSupported(): boolean {
  try {
    return typeof window !== "undefined" && "Notification" in window;
  } catch {
    return false;
  }
}

/** 首次交互时请求权限（浏览器要求用户手势）；静默失败不打扰 */
export function primeNotifications(): void {
  try {
    if (!notificationsSupported()) return;
    if (Notification.permission === "default") {
      // 不在加载即请求：挂一次性的一次性手势监听
      const ask = (): void => {
        try { void Notification.requestPermission(); } catch {}
        window.removeEventListener("pointerdown", ask);
        window.removeEventListener("keydown", ask);
      };
      window.addEventListener("pointerdown", ask, { once: true });
      window.addEventListener("keydown", ask, { once: true });
    }
  } catch {}
}

function systemNotify(title: string, body: string, tag: string): void {
  try {
    if (!notificationsSupported() || Notification.permission !== "granted") return;
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      try { window.focus(); n.close(); } catch {}
    };
  } catch {}
}

// ── 标签页标题闪烁 ─────────────────────────────────────────────────────────────
let flashTimer: ReturnType<typeof setInterval> | undefined;
let flashCount = 0;

/** 标题闪烁直到窗口获得焦点或超次；原始标题始终可恢复 */
export function flashTitle(text: string): void {
  try {
    if (flashTimer) return; // 已在闪烁中：保留最早的提醒，不叠加
    const original = document.title;
    flashCount = 0;
    flashTimer = setInterval(() => {
      try {
        flashCount++;
        if (flashCount > 40 || document.hasFocus()) { stopFlashTitle(original); return; }
        document.title = flashCount % 2 === 1 ? `⏰ ${text}` : original;
      } catch { stopFlashTitle(original); }
    }, 1200);
    const onFocus = () => stopFlashTitle(original);
    window.addEventListener("focus", onFocus, { once: true });
  } catch {}
}

function stopFlashTitle(original: string): void {
  try {
    if (flashTimer) { clearInterval(flashTimer); flashTimer = undefined; }
    document.title = original;
  } catch {}
}

/**
 * 判定一个 run 状态变化是否值得提醒用户（供 UI 层调用；纯函数便于单测）。
 * kind: gate=待审查 / paused=已暂停 / done=已完成。cancelled 是用户自己点的，
 * 不打扰。
 */
export function shouldNotifyRun(
  prevStopReason: string | undefined,
  nextStopReason: string | undefined,
  prevGate: unknown,
  nextGate: unknown,
): "gate" | "paused" | "done" | null {
  const hasGate = !!nextGate;
  const gateArrived = hasGate && !prevGate;
  if (gateArrived) return "gate";
  if (nextStopReason === "failed" && prevStopReason !== "failed") return "paused";
  if (nextStopReason === "done" && prevStopReason !== "done") return "done";
  return null;
}

const CROSS_TAB_KEY = "ralphflow:notif-cross-tab";
const CROSS_TAB_WINDOW_MS = 6000;

/**
 * 跨标签页去重：同一 runId:kind 在短窗口内只提醒一次。每个标签页各自跑全局
 * 监视（notify-watch），两个标签都会算出同一事件——用 localStorage 时间戳
 * 协调，桌面通知只响一次。窗口内键淘汰，防无限增长。
 */
function crossTabSeen(key: string): boolean {
  try {
    const raw = window.localStorage.getItem(CROSS_TAB_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    for (const k of Object.keys(map)) {
      if (now - map[k] > 60_000) delete map[k];
    }
    if (map[key] && now - map[key] < CROSS_TAB_WINDOW_MS) return true;
    map[key] = now;
    window.localStorage.setItem(CROSS_TAB_KEY, JSON.stringify(map));
    return false;
  } catch {
    return false;
  }
}

/** UI 副作用入口：去重后发系统通知 + 标题闪烁 */
export function notifyRunEvent(runId: string, workflow: string, kind: "gate" | "paused" | "done"): void {
  try {
    const key = `${runId || "?"}:${kind}`;
    if (notifiedSet().has(key)) return;
    // 跨标签页协调（同一浏览器多个 tab 都开着的场景）
    if (crossTabSeen(key)) return;
    markNotified(key);
    const label = kind === "gate" ? "待你审查" : kind === "paused" ? "已暂停，需要处理" : "已完成 ✓";
    const title = `🌀 Ralph Flow · ${workflow || "工作流"} ${label}`;
    systemNotify(title, kind === "gate" ? "点击回到对话处理审查门。" : "点击回到对话查看详情。", key);
    flashTitle(`Ralph Flow · ${label}`);
  } catch {}
}
