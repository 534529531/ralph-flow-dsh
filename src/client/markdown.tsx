/**
 * Ralph Flow for dsh — 轻量 Markdown 渲染（报告卡专用）
 *
 * 最终报告是 markdown 写的，用等宽 pre 渲染等于看源码。这里实现一个克制的
 * 子集解析：标题/列表/围栏代码/行内代码/粗体/斜体/链接/引用/分割线。
 * 不引外部依赖（bundle external 面只允许官方包，自写最稳），样式全部消费
 * dsh 主题 token。解析失败永远降级为纯文本——绝不因格式怪异白屏。
 */
import * as React from "react";

interface InlineToken {
  type: "text" | "bold" | "italic" | "code" | "link";
  text: string;
  href?: string;
}

/** 行内解析：`code` → **bold** → *italic* → [text](href)，顺序 tokenize */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ type: "text", text: text.slice(last, m.index) });
    const raw = m[0];
    if (raw.startsWith("`")) tokens.push({ type: "code", text: raw.slice(1, -1) });
    else if (raw.startsWith("**")) tokens.push({ type: "bold", text: raw.slice(2, -2) });
    else if (raw.startsWith("*")) tokens.push({ type: "italic", text: raw.slice(1, -1) });
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw);
      tokens.push(link ? { type: "link", text: link[1], href: link[2] } : { type: "text", text: raw });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens.length > 0 ? tokens : [{ type: "text", text }];
}

function renderInline(tokens: InlineToken[], keyPrefix: string): React.ReactNode[] {
  return tokens.map((tk, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (tk.type) {
      case "code": return <code key={key} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.92em", background: "var(--dsw-alias-bg-layer-2)", borderRadius: "4px", padding: "1px 5px" }}>{tk.text}</code>;
      case "bold": return <strong key={key} style={{ fontWeight: 600 }}>{tk.text}</strong>;
      case "italic": return <em key={key}>{tk.text}</em>;
      case "link": {
        // 链接目标消毒：只放行相对路径与安全 scheme，挡住 javascript:/data: 等
        // 注入向量（报告/判定文本来自子代理输出，不能信任）。
        const href = safeLinkHref(tk.href);
        return href === null
          ? <span key={key}>{tk.text}</span>
          : <a key={key} href={href} target="_blank" rel="noreferrer" style={{ color: "var(--dsw-alias-state-business-primary)" }}>{tk.text}</a>;
      }
      default: return <span key={key}>{tk.text}</span>;
    }
  });
}

/** 链接协议白名单：相对路径/锚点/文件/https/http/mailto；其余一律降级为纯文本 */
export function safeLinkHref(href: string | undefined): string | null {
  try {
    if (!href) return null;
    const h = href.trim();
    if (h.startsWith("#") || h.startsWith("/") || h.startsWith("./") || h.startsWith("../")) return h;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) {
      return /^(https?|mailto|file):/i.test(h) ? h : null;
    }
    return null;
  } catch {
    return null;
  }
}

const block = {
  h1: { fontSize: "16px", fontWeight: 600, margin: "10px 0 4px", color: "var(--dsw-alias-label-primary)" },
  h2: { fontSize: "14.5px", fontWeight: 600, margin: "10px 0 4px", color: "var(--dsw-alias-label-primary)" },
  h3: { fontSize: "13.5px", fontWeight: 600, margin: "8px 0 3px", color: "var(--dsw-alias-label-primary)" },
  p: { margin: "3px 0" },
  li: { margin: "2px 0", marginLeft: "18px" },
  quote: { borderLeft: "3px solid var(--dsw-alias-border-l2)", margin: "6px 0", padding: "2px 10px", color: "var(--dsw-alias-label-secondary)" },
  codeBlock: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    background: "var(--dsw-alias-bg-layer-2)",
    borderRadius: "6px",
    padding: "8px 10px",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    margin: "6px 0",
  },
  hr: { border: "none", borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "10px 0" },
};

/**
 * 解析并渲染 markdown 子集。任何异常都降级为纯文本 pre——报告可读性优先于
 * 格式正确性，绝不让渲染器本身成为新的故障点。
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  try {
    const lines = String(text ?? "").split("\n");
    const out: React.ReactNode[] = [];
    let i = 0;
    let key = 0;
    while (i < lines.length) {
      const line = lines[i];
      // 围栏代码块
      if (/^\s*```/.test(line)) {
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过闭合围栏
        out.push(<pre key={key++} style={block.codeBlock}>{buf.join("\n")}</pre>);
        continue;
      }
      // 分割线
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push(<hr key={key++} style={block.hr} />); i++; continue; }
      // 标题
      const head = /^(#{1,4})\s+(.*)$/.exec(line);
      if (head) {
        const level = head[1].length;
        const st = level === 1 ? block.h1 : level === 2 ? block.h2 : block.h3;
        out.push(<div key={key++} style={st}>{renderInline(parseInline(head[2]), `h${key}`)}</div>);
        i++; continue;
      }
      // 引用（连续行合并）
      if (/^\s*>\s?/.test(line)) {
        const buf: string[] = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push(<blockquote key={key++} style={block.quote}>{renderInline(parseInline(buf.join(" ")), `q${key}`)}</blockquote>);
        continue;
      }
      // 无序列表（连续行）
      if (/^\s*[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
        out.push(
          <ul key={key++} style={{ margin: "4px 0", paddingLeft: "4px" }}>
            {items.map((it, j) => <li key={j} style={block.li}>{renderInline(parseInline(it), `u${key}-${j}`)}</li>)}
          </ul>,
        );
        continue;
      }
      // 有序列表（连续行）
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
        out.push(
          <ol key={key++} style={{ margin: "4px 0", paddingLeft: "20px" }}>
            {items.map((it, j) => <li key={j} style={block.li}>{renderInline(parseInline(it), `o${key}-${j}`)}</li>)}
          </ol>,
        );
        continue;
      }
      // 空行跳过；其余按段落聚合连续非空行
      if (!line.trim()) { i++; continue; }
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(#{1,4}\s|[-*]\s|\d+[.)]\s|>|```|---+$)/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      if (buf.length > 0) out.push(<p key={key++} style={block.p}>{renderInline(parseInline(buf.join("\n")), `p${key}`)}</p>);
      else i++; // 防御：单行不匹配任何块且不进段落时前进，避免死循环
    }
    return <div>{out}</div>;
  } catch {
    return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{String(text ?? "")}</div>;
  }
}

export default Markdown;
