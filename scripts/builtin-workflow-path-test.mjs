/**
 * 回归：**内置工作流的回落路径在任何安装路径下都必须成立**（Windows / 带空格·非 ASCII）。
 *
 * 病根：`builtinWorkflowPath` 用 `new URL(import.meta.url).pathname` 取模块目录。`.pathname`
 * 是**纯 URL 语义**：不做百分号解码，Windows 上还给出 `/C:/…`（盘符前多一个 `/`，`path.resolve`
 * 之后盘符变成一个**字面目录名**）。两者都让 `statSync` 必然失败 → 内置工作流回落不到 →
 * 而 `listWorkflows` 仍无条件列出 `loop`/`spec`，于是用户看到的是「(无描述)（定义无效）」，
 * 全新安装的 Windows 用户**一个可用工作流都没有**（从 0.2.0 起就是这样）。
 *
 * 为什么这样测：
 *   · **A 把构建产物搬进一个名字带空格 + 中文的目录再从那里 import** —— 这是 Linux 上唯一能
 *     复现「安装路径含需转义字符」那一半的方式（也就是 pnpm 装到 `C:\Users\张三\…` 或任何
 *     含空格的 profile 路径时的形态）；
 *   · **B 负对照**：把搬过去的那份 `lib/engine.js` 还原成 `.pathname`，同一条断言必须失败 ——
 *     证明这个用例有鉴别力，而不是「碰巧通过」；
 *   · **C 静态禁用扫描**：Windows 的**盘符**那一半在 Linux 上**复现不了**（`fileURLToPath` 在
 *     POSIX 上不会把 `/C:/…` 变成 `C:\…`），所以另配一条扫描：全仓库代码不许用 `.pathname`
 *     取模块目录，只允许 `fileURLToPath` / `import.meta.dirname`。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupTmp, mkTmp } from "./helpers/plugin-harness.mjs";
import { deliveryPorts } from "./helpers/ports.mjs";

// HOME 隔离（工作协议）：绝不读写真实 ~/.dsh —— `listWorkflowsIn` 会读全局工作流目录。
process.env.HOME = mkTmp("bwp-home");
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const check = (n, c, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.error(`  ✗ ${n}\n      ${String(e).slice(0, 500)}`); }
};

// 旧写法与扫描针都**拆开拼**：这个文件自己不许出现那个字面量，否则扫描会把自己的测试数据
// 当成违规（也别"顺手"把这两个常量合并成一个字符串）。
const OLD_EXPR = "path.dirname(new URL(import.meta.url)" + ".pathname)";
const FIXED_EXPR = "path.dirname(fileURLToPath(import.meta.url))";
const NEEDLE = "import.meta.url)" + ".pathname";

/**
 * 把**构建产物**（`lib/` + `workflows/`）搬进一个名字带空格 + 中文的临时目录。
 *
 * 依赖解析：软链仓库的 `node_modules`（绝对目标，随目录搬迁仍有效；`rmSync` 不跟进软链，
 * 清理是安全的）。`lib/engine.js` 的运行时依赖只有 `node:*`、`js-yaml`、`./voting.js`，
 * 所以这份搬迁是自足的。
 */
function relocate(label) {
  const dir = mkTmp(label); // mkTmp 拼出 `rf-<label>-XXXXXX`：label 里的空格与中文原样进路径
  fs.cpSync(path.join(REPO, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.cpSync(path.join(REPO, "workflows"), path.join(dir, "workflows"), { recursive: true });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  return {
    dir,
    engineUrl: pathToFileURL(path.join(dir, "lib", "engine.js")).href,
    cleanup: () => {
      try { fs.unlinkSync(path.join(dir, "node_modules")); } catch {}
      cleanupTmp(dir);
    },
  };
}

const tmpDirs = [];
const mkWs = (label) => { const d = mkTmp(label); tmpDirs.push(d); return d; };

// ── A) 搬进「带空格 + 中文」的安装路径：内置工作流仍解析得到 ─────────────────
console.log("A) 安装路径含空格 / 非 ASCII 时，内置工作流仍可解析");
const moved = relocate("win path 中文");
const mEngine = await import(moved.engineUrl);

check("搬迁后的包路径确实含空格与中文（用例的前提，不然测的是别的东西）",
  moved.dir.includes(" ") && /[\u4e00-\u9fa5]/.test(moved.dir), moved.dir);

const loopPath = mEngine.builtinWorkflowPath("loop");
const specPath = mEngine.builtinWorkflowPath("spec");
check("builtinWorkflowPath('loop') 返回真实存在的文件",
  typeof loopPath === "string" && fs.statSync(loopPath).isFile(), String(loopPath));
check("builtinWorkflowPath('spec') 返回真实存在的文件",
  typeof specPath === "string" && fs.statSync(specPath).isFile(), String(specPath));
check("解析出的路径坐落在**搬迁后**的包目录里（不是仓库那一份）",
  typeof loopPath === "string" && loopPath.startsWith(moved.dir), `${loopPath} ⊄ ${moved.dir}`);

// 用户看到的症状：`/ralphflow-list` 里内置工作流「无描述」。
const ws = mkWs("bwp-ws");
const listed = mEngine.listWorkflowsIn(ws);
const byName = new Map(listed.map((w) => [w.name, w]));
check("listWorkflowsIn 含内置 loop 与 spec",
  byName.has("loop") && byName.has("spec"), JSON.stringify(listed.map((w) => w.name)));
check("两者的 description 都非空（不再是「(无描述)」）",
  (byName.get("loop")?.desc ?? "") !== "" && (byName.get("spec")?.desc ?? "") !== "",
  JSON.stringify(listed));

// 端到端一步：真实引擎加载内置工作流，定义必须有效。
const eng = mEngine.createEngine(ws, {
  ...deliveryPorts(),
  verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "passed", reason: "bwp-test" }),
  log: () => {},
});
eng.ensureLayout();
const loaded = eng.loadWorkflow("loop");
check("loadWorkflow('loop') 定义有效（无 problems）",
  !!loaded.def && loaded.problems.length === 0, JSON.stringify(loaded.problems));
check("内置 loop 的 description 非空且步骤非空",
  typeof loaded.def?.description === "string" && loaded.def.description !== "" && (loaded.def?.steps?.length ?? 0) > 0,
  JSON.stringify({ desc: loaded.def?.description, steps: loaded.def?.steps?.length }));
// 用户可见的那一面：`/ralphflow-list` 渲染的是引擎的 `listWorkflows()`（它**无条件**列出内置名）。
const listedByEngine = eng.listWorkflows().filter((w) => w.name === "loop" || w.name === "spec");
check("引擎 listWorkflows 里 loop/spec 都是**有效**定义且带描述（不再是「(无描述)（定义无效）」）",
  listedByEngine.length === 2 && listedByEngine.every((w) => !w.invalid && w.desc !== ""),
  JSON.stringify(listedByEngine.map((w) => ({ name: w.name, desc: w.desc, invalid: w.invalid }))));

// ── B)【负对照】还原成 `.pathname` → 同一条断言必须失败 ──────────────────────
console.log("\nB)【负对照】把搬迁后的 lib/engine.js 还原成修复前的写法");
const neg = relocate("win path neg 中文");
const negEntry = path.join(neg.dir, "lib", "engine.js");
const negSrc = fs.readFileSync(negEntry, "utf-8");
if (!negSrc.includes(FIXED_EXPR)) {
  throw new Error("负对照锚点不见了：lib/engine.js 里找不到 `" + FIXED_EXPR + "` —— 修复被改写，请同步更新负对照");
}
fs.writeFileSync(negEntry, negSrc.replace(FIXED_EXPR, OLD_EXPR), "utf-8");
const nEngine = await import(pathToFileURL(negEntry).href);
check("【负对照】还原成 `.pathname` 后，builtinWorkflowPath('loop') 找不到 —— 用例有鉴别力",
  nEngine.builtinWorkflowPath("loop") === undefined, String(nEngine.builtinWorkflowPath("loop")));
// 两个失败面要分别钉住（它们的表现不同，别把它们混成一个）：
//   · 引擎 `listWorkflows()` **无条件**列出内置名 → 用户看到「(无描述)（定义无效）」（你报的症状）；
//   · `listWorkflowsIn()` 是「找不到就不列」→ 内置工作流整个消失，`/ralphflow-loop` 快捷也没了。
const nEng = nEngine.createEngine(ws, {
  ...deliveryPorts(),
  verify: async (req) => ({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "passed", reason: "bwp-neg" }),
  log: () => {},
});
const nList = nEng.listWorkflows().filter((w) => w.name === "loop");
check("【负对照】还原后引擎 listWorkflows 里 loop 是「无描述 + 定义无效」（复现用户看到的症状）",
  nList.length === 1 && nList[0].desc === "" && nList[0].invalid === true,
  JSON.stringify(nList.map((w) => ({ desc: w.desc, invalid: w.invalid, problems: w.problems.slice(0, 1) }))));
check("【负对照】还原后 listWorkflowsIn 里连 loop 都没有（快捷技能也一起消失）",
  !nEngine.listWorkflowsIn(ws).some((w) => w.name === "loop"),
  JSON.stringify(nEngine.listWorkflowsIn(ws).map((w) => w.name)));
neg.cleanup();

// ── C) 静态禁用扫描：Windows 盘符那一半在 Linux 上复现不了，只能靠禁 API ─────
console.log("\nC) 静态禁用扫描：全仓库代码不许用 `.pathname` 取模块目录");

/** 只剥注释再扫：说明性注释里提到这个写法是**应该的**（它是病根记录），不该判违规。 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const hits = [];
for (const d of ["src", "scripts", "e2e-harness"]) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|mjs|js)$/.test(e.name)) continue;
      const text = stripComments(fs.readFileSync(p, "utf-8"));
      text.split("\n").forEach((line, i) => {
        if (line.includes(NEEDLE)) hits.push(`${path.relative(REPO, p)}:${i + 1}`);
      });
    }
  };
  walk(path.join(REPO, d));
}
check("src / scripts / e2e-harness 里不再出现 `.pathname` 取模块目录（只允许 fileURLToPath / import.meta.dirname）",
  hits.length === 0, hits.join(", "));

// ── 收尾 ────────────────────────────────────────────────────────────────────
moved.cleanup();
for (const d of tmpDirs) cleanupTmp(d);
cleanupTmp(process.env.HOME);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
