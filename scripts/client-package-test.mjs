/** The installed host parser/composer is the packaging gate, including its throw paths. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Context } from "@deepseek-ai/cordis";
import { evaluatePluginCompatibility } from "@deepseek-ai/dsh-app-boot";
import { ClientModuleRegistry } from "@deepseek-ai/dsh-client-modules";
import { loadNoticeClient } from "./helpers/notice-client.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rf-client-package-"));
try {
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", root], { encoding: "utf8" });
  assert.equal(pack.status, 0, pack.stderr);
  const packResult = JSON.parse(pack.stdout);
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  assert(packed.files.some((f) => f.path === "lib/client.js"));
  assert(packed.files.some((f) => f.path === "lib/client/index.d.ts"));
  assert(packed.files.some((f) => f.path === "lib/typert.js"));
  assert(packed.files.some((f) => f.path === "lib/status-contract.js"));
  assert(packed.files.some((f) => f.path === "lib/status-service.js"));
  assert.equal(spawnSync("tar", ["-xzf", path.join(root, packed.filename), "-C", root]).status, 0);
  const packageDir = path.join(root, "package");
  const manifestPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  function compose(manifest) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const ctx = new Context();
    ctx.provide("logger", { warn() {} });
    ctx.provide("loader", { entries: () => [{
      options: { name: path.join(packageDir, "lib/index.js") }, fiber: {},
      parent: { tree: { ctx: { baseUrl: pathToFileURL(root + "/").href } } },
    }] });
    return new ClientModuleRegistry(ctx).graph();
  }
  // Exercise the host's real compatibility gate, not a hand-written semver check.
  for (const version of ["0.2.0-rc.2", "0.2.1-alpha.1", "0.2.1-alpha.2"]) {
    assert.equal(evaluatePluginCompatibility(pkg, {}, version), undefined, `host admission: ${version}`);
  }
  assert(evaluatePluginCompatibility(pkg, {}, "0.1.7-rc.2"), "older hosts remain unsupported");
  const alphaOnly = structuredClone(pkg);
  for (const name of Object.keys(alphaOnly.peerDependencies)) if (name.startsWith("@deepseek-ai/dsh-")) {
    alphaOnly.peerDependencies[name] = "^0.2.1-alpha.1";
  }
  assert(evaluatePluginCompatibility(alphaOnly, {}, "0.2.0-rc.2"), "negative: original alpha-only manifest rejects npm latest");
  // These remain host-version constraints, but must not install a second host via npm peers.
  for (const name of Object.keys(pkg.peerDependencies)) assert.equal(pkg.peerDependenciesMeta[name].optional, true);
  const graph = compose(pkg);
  assert(JSON.stringify(graph).includes(pkg.name));
  loadNoticeClient(); // The factory must also materialize and register its client face.
  for (const mutation of [
    (p) => { p.dsh.client.platform = 1; },
    (p) => { p.dsh.client.inject = "slots"; },
    (p) => { p.dsh.client.external = [1]; },
    (p) => { delete p.exports["./client"]; },
    (p) => { p.exports["./client"] = { types: "./lib/client/index.d.ts" }; },
    (p) => { p.exports["./client"].default = "./lib/missing.js"; },
  ]) {
    const bad = structuredClone(pkg);
    mutation(bad);
    assert.throws(() => compose(bad), /client-modules/);
  }
  console.log("13 passed, 0 failed — npm pack, native runtime admission, alpha-only negative, 6 negative declarations");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
