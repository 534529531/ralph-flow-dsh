/**
 * 测试基建：**负对照**用的「还原构建器」。
 *
 * 任务书要求每个新用例都附负对照：「把修复还原后，新用例必须失败」。做法是——把当前
 * `src/` 复制到临时目录，按**锚点**把某一处修复还原成修复前的写法，用仓库自己的 tsc
 * 编出一份 lib，再让**同一段用例**跑这份构建，断言它必然判不通过。
 *
 * 这样做的三条纪律：
 *   · 绝不改真实工作树里的任何文件（复制 + 编译都在 mkdtemp 里）；
 *   · 锚点找不到就**大声失败**，绝不静默跳过（静默跳过 = 负对照形同虚设）；
 *   · 用的是同一条用例、同一个判据函数 —— 判据在修复后的构建上为真、在还原后的构建上
 *     为假，才叫「新用例有鉴别力」。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkTmp, cleanupTmp } from "./plugin-harness.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 把当前 `src/` 复制到临时目录、按 `patches` 改写、用仓库的 tsc 编译，返回入口 URL。
 *
 * @param {Record<string, (src: string) => string>} patches 文件名 → 改写函数（缺省原样复制）
 * @param {string} label 临时目录标签（进 mkdtemp 前缀，便于排查残留）
 * @returns {{ entry: string, dir: string, cleanup: () => void }}
 */
export function buildPluginCopy(patches, label) {
  const dir = mkTmp(`build-${label}`);
  const srcDir = path.join(dir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, "src"))) {
    if (!f.endsWith(".ts")) continue;
    const raw = fs.readFileSync(path.join(REPO, "src", f), "utf-8");
    const patched = patches?.[f] ? patches[f](raw) : raw;
    fs.writeFileSync(path.join(srcDir, f), patched, "utf-8");
  }
  // NodeNext 解析要靠 package.json 的 "type": "module"（缺了会把 import.meta 判成 CJS）
  for (const f of ["tsconfig.json", "package.json"]) {
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  // 内置工作流（loop/spec）由 `lib/../workflows/*.yaml` 解析：漏了它，还原构建里连
  // `ralphflow_start loop` 都跑不起来（负对照会变成「构建不全」的证据，而不是修复的证据）
  fs.cpSync(path.join(REPO, "workflows"), path.join(dir, "workflows"), { recursive: true });
  // 依赖解析：软链仓库的 node_modules（rmSync 不会跟进软链，清理是安全的）
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");

  const tsc = path.join(REPO, "node_modules", ".bin", "tsc");
  const r = spawnSync(tsc, ["-p", "tsconfig.json"], { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`负对照构建失败（${label}）：tsc exit=${r.status}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
  return {
    entry: pathToFileURL(path.join(dir, "lib", "index.js")).href,
    dir,
    cleanup: () => {
      try { fs.unlinkSync(path.join(dir, "node_modules")); } catch {}
      cleanupTmp(dir);
    },
  };
}

/**
 * 【问题一的还原】把「属主活着就不打扰」的判据还原成修复前的行为：**无条件当作孤儿**
 * （`restore()` 见委派就清空 + 暂停）。
 *
 * 锚点 `ralphflow:orphan-liveness` 就写在判据函数上方；找不到它说明修复被改写，这里直接抛。
 */
export function revertOrphanLivenessGuard(src) {
  const lines = src.split("\n");
  const marker = lines.findIndex((l) => l.includes("ralphflow:orphan-liveness"));
  if (marker < 0) throw new Error("负对照锚点 `ralphflow:orphan-liveness` 不见了 —— 修复被改写，请同步更新负对照");
  let end = -1;
  for (let i = marker + 1; i < lines.length; i++) {
    if (lines[i] === "}") { end = i; break; }
  }
  if (end < 0) throw new Error("负对照锚点后找不到判据函数的结尾 `}`");
  lines.splice(marker, end - marker + 1, "function delegationOwnerAlive(_d: Delegation): boolean { return false; } // 负对照：还原为修复前的「无条件清空委派」");
  return lines.join("\n");
}

/**
 * 【问题二的还原】把诚实的「它在读文件、跑命令取证，你看得到」还原成修复前那句
 * **编出来的时长承诺**（逐字回到旧文案）。
 */
export function revertHonestVerifyNotice(src) {
  const honest = "它现在正在读文件、跑命令取证，它在做什么你在会话里看得到（这里不给时长预估：没有超时上界，任何时间承诺都是编的）。";
  if (!src.includes(honest)) throw new Error("负对照锚点（诚实的验证播报文案）不见了 —— 修复被改写，请同步更新负对照");
  return src.replace(honest, "验证通常需要 1–5 分钟（它要真的去读文件、跑命令取证）。");
}

/** 【问题二的还原·第二处】机制说明（tools.ts）：把诚实措辞还原成编造的时长承诺。 */
export function revertMechanismWording(src) {
  const honest = "验证者（独立会话）会真的去读文件、跑命令取证，它在做什么你在会话里看得到；期间不需要你做任何操作，跑完会自动唤醒本会话。**不要给时长预估**——委派没有超时上界，任何时间承诺都是编的。";
  if (!src.includes(honest)) throw new Error("负对照锚点（机制说明文案）不见了 —— 修复被改写，请同步更新负对照");
  return src.replace(honest, "通常需要 1–5 分钟，期间不需要你做任何操作，跑完会自动唤醒本会话。");
}
