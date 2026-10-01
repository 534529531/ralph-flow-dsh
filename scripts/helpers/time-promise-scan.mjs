/**
 * 「时长承诺」扫描器（问题二的唯一判据来源）。
 *
 * 背景：CHECK 阶段曾经对用户说「独立验证通常 1–5 分钟」—— 那是**编的**：
 * 实测 3m53s / 7m29s / 8m34s，而且委派**没有超时上界**（生命周期跟随宿主原生能力，
 * 见 src/verify.ts），根本给不出诚实的预估。所以判据不是「换个数字」，而是
 * **任何形式的时长承诺都不许出现**。
 *
 * 扫描要分得清两类「分钟」：
 *   · 承诺（禁止）：通常/预计/大约 + 分钟、`1–5 分钟` 这类区间、「分钟级」；
 *   · 实测（允许）：`3 分钟前`（相对时间显示）、`耗时 3m12s`（报告里的历史事实）——
 *     把实测也扫掉等于让报告不能说真话，那是另一种撒谎。
 *
 * 只扫**会进入输出的字符串**：TS 源码用 TypeScript 自己的解析器取出字符串/模板字面量
 * （注释、标识符、正则都不是「输出」），YAML 先剥 `#` 注释。
 *
 * 为什么用解析器而不是正则剥注释：本仓库的模板字面量里嵌着 `${cond ? `…` : ""}` 这种
 * 嵌套结构，正则式状态机剥注释会被嵌套反引号带偏，把后面的 `//` 注释当成代码 —— 那会让
 * 扫描结果取决于文本形状，而不是取决于事实。
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * 禁止出现的时长承诺模式。每条都是「对未来的时间下判断」，不是「对过去的耗时做陈述」。
 */
export const DURATION_PROMISE_PATTERNS = [
  { name: "编造的区间", re: /\d+\s*[–—\-~～至到]\s*\d+\s*分钟/ },
  { name: "「分钟级」这类措辞", re: /分钟级|秒级|小时级/ },
  { name: "模糊量词 + 分钟", re: /(几|数|十来|半)\s*个?\s*分钟/ },
  { name: "概略词 + 分钟（通常/预计/大约…）", re: /(通常|一般|大约|大概|预计|预估|约|差不多|往往|应该)[^\n。；]{0,8}分钟/ },
  { name: "概略词 + 秒/小时", re: /(通常|一般|大约|大概|预计|预估|差不多|往往)[^\n。；]{0,8}(秒|小时)/ },
];

/** 在一段文本里找出所有时长承诺（带行号与原文片段，便于直接贴证据） */
export function findDurationPromises(text) {
  const hits = [];
  if (typeof text !== "string" || !text) return hits;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const p of DURATION_PROMISE_PATTERNS) {
      const m = lines[i].match(p.re);
      if (m) hits.push({ pattern: p.name, match: m[0], line: i + 1, snippet: lines[i].trim().slice(0, 160) });
    }
  }
  return hits;
}

/**
 * 取出一份 TS 源码里**所有字符串/模板字面量**（含模板字面量的每一段），带源码行号。
 *
 * 注释、标识符、正则都不算「输出」—— 用户读不到它们；字符串才是会被人读到的文本。
 */
export function tsStringLiterals(src, fileName = "scan.ts") {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
      const text = typeof node.text === "string" ? node.text : node.getText(sf);
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ text, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 剥掉 YAML 的整行/行尾注释（`#` 前有空白或位于行首）；保留正文（正文才是输出） */
export function stripYamlComments(src) {
  return src
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

/** 扫一份 TS 源码的「输出面」：逐个字符串字面量扫，命中带上源码行号 */
function scanTsSource(relPath, src) {
  const hits = [];
  for (const lit of tsStringLiterals(src, relPath)) {
    for (const h of findDurationPromises(lit.text)) {
      hits.push({ ...h, line: lit.line + h.line - 1 });
    }
  }
  return { path: relPath, hits };
}

/**
 * 扫一个仓库的「运行时面」：`src/**\/*.ts`（只扫字符串字面量）、`workflows/*.yaml`
 * （剥 `#` 注释）、`README.md`（整篇都是给人看的，不剥）。
 *
 * **不扫 docs/**：那里是历史证据与设计记录，里面的分钟数是**实测值**（如 7–8.5 分钟），
 * 是事实不是承诺；把历史记录改掉才是销毁证据。
 */
export function scanRuntimeSurfaces(repo) {
  const files = [];
  const srcDir = path.join(repo, "src");
  if (fs.existsSync(srcDir)) {
    for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort()) {
      const p = path.join(srcDir, f);
      files.push(scanTsSource(path.relative(repo, p), fs.readFileSync(p, "utf-8")));
    }
  }
  const wfDir = path.join(repo, "workflows");
  if (fs.existsSync(wfDir)) {
    for (const f of fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
      const p = path.join(wfDir, f);
      files.push({ path: path.relative(repo, p), hits: findDurationPromises(stripYamlComments(fs.readFileSync(p, "utf-8"))) });
    }
  }
  const readme = path.join(repo, "README.md");
  if (fs.existsSync(readme)) files.push({ path: "README.md", hits: findDurationPromises(fs.readFileSync(readme, "utf-8")) });
  return files;
}
