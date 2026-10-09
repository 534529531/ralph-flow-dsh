/**
 * 判据 1：**全仓所有把消息投进会话的调用点都归类过**（指令 / 播报），且这个判定在代码里看得见。
 *
 * 为什么需要一支静态审计：投递分类是**意图契约**，一旦将来有人加一条 `agent.steer(...)` 或
 * 一条 `session.append("user/message", …)` 而不说它属于哪一类，缺陷就会以另一种形状回来
 * （把给人看的播报投成唤醒指令，或把要模型干活的指令投成看不见的记录）。所以这里不看行为，
 * 只看**形态**：
 *
 *   S1 运行期（`src/`）：所有注入会话的调用点只允许出现在**五个载体**上，且载体里的每一次
 *      注入都带 `@delivery directive|notice` 标记 —— 载体是唯一入口，标记是分类本身。
 *   S2 运行期不得再有「不带分类的通用投递 helper」：`deliver(` 这个名字不许裸用，
 *      只能用 `deliverDirective(` / `deliverNotice(`（分类写在调用点上，一眼看得出）。
 *   S3 运行期每一处 `deliverDirective` / `deliverNotice` / `notify` **调用点**都被枚举并计数
 *      （清单变了就必须来改这支用例 —— 想静默加一条投递是做不到的）。
 *   S4 仓里其它代码文件（测试替身 / e2e 夹具）：凡出现注入 API 的，必须在**台账**里给出
 *      归类与理由；台账外的文件一律算漏归类（漏一处即未完成）。
 *   S5 台账文档 `docs/v2/delivery-classification.md` 必须覆盖扫描到的全部文件（文档与代码同步）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };

const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * 扫描范围与排除项（写清楚，免得「全仓」被读成「只扫 src」或者反过来）：
 *   · 扫：仓库里所有代码文件（上面这些扩展名）；
 *   · 排除 `lib/`（tsc 产物，与 src 同源）、`.dsh/` 与 `.opencode/`（运行时数据与历史产出）、
 *     `.git/`、`node_modules/`、`ui/`（早期无关原型，已确认无注入 API）；
 *   · 文档（*.md）不扫：那是叙述不是调用点（历史 brief 里提到旧写法不代表运行期）。
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", ".dsh", ".opencode", "ui", "e2e-harness-archived"]);

/** 注入会话的**调用**形态：命中即算一个投递点（消息构造不算投递，见 S1c） */
const INJECTION_PATTERNS = [
  { id: "steer", re: /\.steer\s*\(/ },
  { id: "inject", re: /\.inject\s*\(/ },
  { id: "send-next", re: /\.send\s*\(\s*[^)]*,\s*["']next-(step|turn)["']/ },
  { id: "followup", re: /\.followup\s*\(/ },
  { id: "append-user-message", re: /\.append!?\(\s*["']user\/message["']/ },
];

/** 宽松形态（只用于非运行期文件的**文件级**发现）：替身里的 `steer: (m) => …` 也算投递点 */
const LOOSE_PATTERNS = [...INJECTION_PATTERNS, { id: "double", re: /\b(steer|inject|followup)\s*:\s*(\(|async|function)/ }];

const isComment = (line) => { const t = line.trim(); return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (CODE_EXT.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 扫一个文件的投递点；`patterns` 决定严格（运行期）还是宽松（替身） */
function scanFile(file, patterns = INJECTION_PATTERNS) {
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    for (const { id, re } of patterns) {
      if (!re.test(line)) continue;
      const marker = /@delivery\s+(directive|notice)/.exec(line) ?? /@delivery\s+(directive|notice)/.exec(lines[i - 1] ?? "");
      hits.push({ line: i + 1, pattern: id, text: line.trim().slice(0, 100), marker: marker?.[1] ?? null });
    }
  }
  return hits;
}

/** 只数**调用点**：定义处（`function x(` / `const x = (` / 注释）不算 */
function countCalls(text, name) {
  return text.split("\n").filter((l) => {
    if (isComment(l)) return false;
    const t = l.trim();
    if (t.startsWith(`function ${name}`) || t.startsWith(`const ${name}`) || t.startsWith(`${name}:`)) return false;
    // 端口管道（载体内部往端口投）不算「调用点」：载体自身在 S1 里单独审计
    if (t.includes(`ports.${name}(`)) return false;
    return new RegExp(`(?<![A-Za-z0-9_])${name}\\s*\\(`).test(l);
  }).length;
}

const files = walk(REPO);
const byFile = new Map();
for (const f of files) {
  const hits = scanFile(f);
  if (hits.length > 0) byFile.set(path.relative(REPO, f), hits);
}
const looseFiles = files
  .map((f) => ({ rel: path.relative(REPO, f), hits: scanFile(f, LOOSE_PATTERNS) }))
  .filter((x) => x.hits.length > 0)
  .map((x) => x.rel)
  .sort();

const runtimeFiles = [...byFile.keys()].filter((f) => f.startsWith("src/")).sort();
const otherFiles = looseFiles.filter((f) => !f.startsWith("src/"));

/**
 * 运行期的**五个载体**（唯五允许出现注入 API 的地方）。频率/位置变了都必须来改这张表。
 * `directive` = 唤醒（要模型干活）；`notice` = 只记录（不唤醒）。
 */
const RUNTIME_CARRIERS = {
  "src/index.ts": {
    "deliverNotice → session.append!(user/message, msg, …)": "notice",
    "flushNotices → session.append!(user/message, queue[0], …)": "notice",
    "deliverDirective → agent.steer(msg)": "directive",
  },
  "src/reset.ts": {
    "resetSurface → session.append(user/message, notice, …)": "notice",
    "resetSurface → session.append(user/message, handoff, …)": "directive",
  },
};

/** 代码之外的注入点台账（测试替身 / e2e 夹具 / 审计脚本自身），逐条给归类与理由。 */
const LEDGER = {
  "scripts/helpers/plugin-harness.mjs": "测试替身：真 Session + 同时记录指令（steer/followup）与播报（append 包装）",
  "scripts/delivery-classification-test.mjs": "本审计脚本自身：模式文本里出现 `steer:` 等字样，不是调用点",
  "scripts/visibility-test.mjs": "用例替身：真 Session + steer 记录 + append 记录（captureAppends）",
  "scripts/voting-test.mjs": "用例替身：真 Session + steer 记录 + append 记录（captureAppends）",
  "scripts/submit-flow-test.mjs": "用例替身：真 Session + steer 记录 + append 记录（captureAppends）",
  "scripts/notice-delivery-test.mjs": "用例替身：真 Session + steer 记录（播报走真实 append 载体）",
  "scripts/reset-surface-test.mjs": "用例夹具：真 Session 上种旧对话 / 模拟驱动器把收件箱 drain 成 user/message",
  "scripts/rewind-test.mjs": "用例夹具：真 Session 上种旧对话 / 模拟驱动器把收件箱 drain 成 user/message",
  "e2e-harness/index.js": "e2e 夹具：followup 把任务喂给真实 agent（驱动真实回合）",
  "scripts/real-loop-wake-test.mjs": "真实运行用例：真实 AgentLoop + 真实 Session；stub 模型用真工具链交付，替身 subagents 只决定判定",
  "scripts/skills-surface-test.mjs": "技能面用例替身：真 SkillRegistry/CommandRuntime/SessionTitleService + `steer` 空实现（只记技能注册与命令解析，不投递）",
  "smoke-client.mts": "历史客户端冒烟：cordis ctx 替身的 `inject:` 属性，不是会话投递",
};

console.log("S1 运行期：注入会话的调用点只允许出现在五个载体上，且每个都带 @delivery 标记");
{
  const carriers = Object.keys(RUNTIME_CARRIERS).sort();
  check("S1a 运行期出现注入调用点的文件恰好是两个载体文件",
    JSON.stringify(runtimeFiles) === JSON.stringify(carriers),
    `扫描到 ${JSON.stringify(runtimeFiles)}，期望 ${JSON.stringify(carriers)}`);

  const unmarked = runtimeFiles.flatMap((f) => (byFile.get(f) ?? []).filter((h) => h.marker === null).map((h) => `${f}:${h.line} ${h.pattern}`));
  check("S1b 运行期每一处注入调用点都带 `@delivery directive|notice` 标记（分类写在代码里）",
    unmarked.length === 0, unmarked.join(" | "));

  const classes = new Set(runtimeFiles.flatMap((f) => (byFile.get(f) ?? []).map((h) => h.marker)).filter(Boolean));
  check("S1c 两类都真的用到了（既没有全指令化，也没有全播报化）",
    classes.has("directive") && classes.has("notice"), [...classes].join(","));

  // 消息**构造**（createUserMessage）也必须只出现在载体里：否则就是「在别处造消息、再想办法塞进会话」
  const constructors = files
    .filter((f) => f.startsWith(path.join(REPO, "src")))
    .filter((f) => /createUserMessage\s*\(/.test(fs.readFileSync(f, "utf-8").replace(/^\s*(\*|\/\/).*$/gm, "")))
    .map((f) => path.relative(REPO, f)).sort();
  check("S1d 消息构造（createUserMessage）也只出现在载体里",
    JSON.stringify(constructors) === JSON.stringify(carriers), JSON.stringify(constructors));

  for (const [f, expected] of Object.entries(RUNTIME_CARRIERS)) {
    const hits = byFile.get(f) ?? [];
    check(`S1e ${f}：注入调用点数 = ${Object.keys(expected).length}（与台账一致）`,
      hits.length === Object.keys(expected).length,
      `实际 ${hits.length}：${hits.map((h) => `${h.line}:${h.pattern}:${h.marker}`).join(" | ")}`);
  }
}

console.log("\nS2 运行期不得再有「不带分类的通用投递 helper」");
{
  const srcFiles = files.filter((f) => f.startsWith(path.join(REPO, "src")));
  const bare = [];
  for (const f of srcFiles) {
    fs.readFileSync(f, "utf-8").split("\n").forEach((line, i) => {
      if (isComment(line)) return;
      if (/(?<![A-Za-z])deliver\s*\(/.test(line)) bare.push(`${path.relative(REPO, f)}:${i + 1}`);
    });
  }
  check("S2a 运行期没有任何裸 `deliver(` 调用点（分类只能靠 deliverDirective / deliverNotice）",
    bare.length === 0, bare.join(" | "));
}

console.log("\nS3 运行期投递调用点清单（改了清单就必须来改这支用例）");
{
  const census = {};
  for (const f of files.filter((x) => x.startsWith(path.join(REPO, "src")))) {
    const rel = path.relative(REPO, f);
    const text = fs.readFileSync(f, "utf-8");
    census[rel] = {
      deliverDirective: countCalls(text, "deliverDirective"),
      deliverNotice: countCalls(text, "deliverNotice"),
      notify: countCalls(text, "notify"),
    };
  }
  const expected = {
    "src/create.ts": { deliverDirective: 0, deliverNotice: 0, notify: 0 },
    "src/engine.ts": { deliverDirective: 6, deliverNotice: 2, notify: 17 },
    "src/index.ts": { deliverDirective: 1, deliverNotice: 1, notify: 0 },
    "src/message-source.ts": { deliverDirective: 0, deliverNotice: 0, notify: 0 },
    "src/reset.ts": { deliverDirective: 0, deliverNotice: 0, notify: 0 },
    // 技能注册面：名字不合语法的工作流要**当场把原因说清给人听**（播报，不唤醒）—— 唯一的投递点。
    "src/skills.ts": { deliverDirective: 0, deliverNotice: 1, notify: 0 },
    "src/tools.ts": { deliverDirective: 4, deliverNotice: 0, notify: 0 },
    "src/verify.ts": { deliverDirective: 0, deliverNotice: 0, notify: 0 },
    "src/voting.ts": { deliverDirective: 0, deliverNotice: 0, notify: 0 },
  };
  check("S3a 投递调用点计数与清单一致（新增/删除投递都要来改这里）",
    JSON.stringify(census) === JSON.stringify(expected),
    `实际 ${JSON.stringify(census)}`);
  const sum = (o) => o.deliverDirective + o.deliverNotice + o.notify;
  const total = Object.values(census).reduce((a, c) => a + sum(c), 0);
  const directives = Object.values(census).reduce((a, c) => a + c.deliverDirective, 0);
  const notices = Object.values(census).reduce((a, c) => a + c.deliverNotice, 0);
  const viaNotify = Object.values(census).reduce((a, c) => a + c.notify, 0);
  check("S3b 清单非空且两类都在（指令 + 播报）", total > 0 && directives > 0 && notices + viaNotify > 0, JSON.stringify({ total, directives, notices, viaNotify }));
  console.log(`     运行期投递调用点共 ${total} 处：指令 ${directives} · 播报 ${notices + viaNotify}（其中 notify 包装 ${viaNotify}）`);
}

console.log("\nS4 代码之外：出现注入 API 的文件必须在台账里逐条归类");
{
  const missing = otherFiles.filter((f) => !(f in LEDGER));
  check("S4a 台账外没有未归类的注入点文件", missing.length === 0, missing.join(" | "));
  const stale = Object.keys(LEDGER).filter((f) => !otherFiles.includes(f));
  check("S4b 台账里没有已经消失的文件（台账跟着代码走，不留幽灵条目）", stale.length === 0, stale.join(" | "));
  console.log(`     台账覆盖 ${otherFiles.length} 个非运行期文件`);
}

console.log("\nS5 台账文档覆盖扫描到的全部文件");
{
  const docPath = path.join(REPO, "docs", "v2", "delivery-classification.md");
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf-8") : "";
  check("S5a 台账文档存在", doc.length > 0, docPath);
  const uncovered = [...byFile.keys()].concat(otherFiles).filter((f, i, a) => a.indexOf(f) === i).filter((f) => !doc.includes(f));
  check("S5b 文档覆盖每一个被扫描到的文件（逐一列出，不靠「等等」）",
    uncovered.length === 0, uncovered.join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
