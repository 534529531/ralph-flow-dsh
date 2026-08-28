/**
 * Ralph Flow for dsh — client bundle 构建脚本
 *
 * 用 esbuild 把 src/client 目录打成 dsh 官方 client bundle 格式：
 * 单文件 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，
 * 外部依赖（react、@deepseek-ai/*）走 factory 参数 require 由 dsh 运行时解析
 * （同 @deepseek-ai/dsh-client-ui-workflow-run/lib/client.js 结构）。
 * 产物写入 lib/client.js（与官方 packages/client/ui-workflow-run/lib/client.js 同构）。
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "lib", "client.js");

const entryPoints = [join(root, "src", "client", "client.ts")];

const result = await build({
  entryPoints,
  outfile,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "@deepseek-ai/*"],
  write: false,
  logLevel: "silent",
  minify: false,
});

const body = result.outputFiles[0].text;

mkdirSync(dirname(outfile), { recursive: true });

// dsh client bundle 外壳：window.__ModuleLoader__.load({ id, factory })
// factory 形参 require 即 dsh 运行时模块解析器（seed/static/registered factory）。
const wrapper = `window.__ModuleLoader__.load({
	id: "ralphflow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
`;

writeFileSync(outfile, wrapper);
console.log(`client bundle -> ${outfile} (${Buffer.byteLength(wrapper)} bytes)`);