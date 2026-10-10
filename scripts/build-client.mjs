import { build } from "esbuild";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const output = await build({
  entryPoints: ["src/client/index.ts"], bundle: true, write: false,
  platform: "browser", target: "es2022", format: "cjs", external: pkg.dsh.client.external,
});
// Match dsh's factory protocol. React comes from the host's shared module table.
fs.writeFileSync("lib/client.js", `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${output.outputFiles[0].text}\nreturn module.exports;\n}});\n`);
