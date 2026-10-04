/**
 * 测试替身：引擎的两类投递端口（指令 / 播报）。
 *
 * 引擎只认这两个端口名（见 `src/engine.ts` 的 `EnginePorts`）：载体分别是 `agent.steer`
 * （唤醒）与「直接 append 到会话可见面」（不唤醒）。用例里只需要「收到了哪些文本」时，
 * 用这个工厂把两类都记进同一个 sink —— 这样断言写法与改造前一致，而分类的事实留在端口名上。
 *
 * @param {string[] | Array<any> | Function} target
 *   · 数组 → push 文本；
 *   · 函数 → `(text, summary, cls)`，想连 summary/类别一起看时用它。
 * @returns {{ deliverDirective: Function, deliverNotice: Function }}
 */
export function deliveryPorts(target) {
  const put = (text, summary, cls) => {
    if (typeof target === "function") target(text, summary, cls);
    else if (Array.isArray(target)) target.push(text);
  };
  return {
    deliverDirective: (_sid, text, summary) => { put(text, summary, "directive"); return true; },
    deliverNotice: (_sid, text, summary) => { put(text, summary, "notice"); return true; },
  };
}
