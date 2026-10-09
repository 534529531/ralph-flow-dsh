/**
 * 一键跑完全部验收套件（`npm run verify`）。
 *
 * 为什么要有它：`prepublishOnly` 需要一个**fail-closed** 的验证入口 —— 发布前必须证明
 * 「这批代码是绿的」，而不是靠人记得手跑 16 条命令。任何一支非零退出，整体非零，发布被拒。
 *
 * 与 `npm test` 的分工：这里跑的是**全量**（含慢的真实 Session / 真实插件装配套件），
 * 所以它挂在 `prepublishOnly` 上，不是挂在每次保存上。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(path.join(dir, "scripts"))
  .filter((f) => f.endsWith("-test.mjs") || f === "verify-activation.mjs")
  .sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts", f)], { cwd: dir, encoding: "utf-8" });
  const lines = (r.stdout ?? "").split("\n");
  const tail = lines.filter((l) => /passed|APPLY_OK|failed/.test(l)).slice(-1)[0] ?? "";
  console.log(`${r.status === 0 ? "✓" : "✗"} ${f.padEnd(32)} ${tail.trim().slice(0, 60)}`);
  if (r.status !== 0) {
    failed++;
    for (const l of lines.filter((l) => l.includes("✗")).slice(0, 5)) console.log(`    ${l.trim().slice(0, 150)}`);
    for (const l of (r.stderr ?? "").split("\n").filter(Boolean).slice(-5)) console.log(`    ${l.trim().slice(0, 150)}`);
  }
}
console.log(failed === 0 ? `\n全部 ${files.length} 支通过` : `\n${failed}/${files.length} 支失败`);
process.exit(failed === 0 ? 0 : 1);
