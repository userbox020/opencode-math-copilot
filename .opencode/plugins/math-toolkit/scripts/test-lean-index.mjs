#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { searchLean } from "../lib/lean-search.js";

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const roots = { workspace, math: path.join(workspace, "math") };
if (!fs.existsSync(path.join(roots.math, "lean"))) {
  console.log("SKIP: math/lean not present; Lean declaration index tests require the corpus.");
  process.exit(0);
}
const indexFile = fileURLToPath(new URL("../data/lean-index.json.gz", import.meta.url));
if (!fs.existsSync(indexFile)) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build-lean-index.mjs", import.meta.url))], {
    cwd: workspace, stdio: "inherit", timeout: 600000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Lean index build failed");
}
const compressed = fs.readFileSync(indexFile);
const index = JSON.parse(gunzipSync(compressed).toString("utf8"));
assert.equal(index.version, 1);
assert(index.counts.files > 0);
assert(index.counts.declarations > 0);
assert.equal(index.counts.files, index.files.length);
assert.equal(index.counts.declarations, index.files.reduce((total, file) => total + file.declarations.length, 0));
assert(index.files.every(file => !/(?:^|\/)(?:\.lake|\.git|node_modules)(?:\/|$)/.test(file.path)));
const name = "linearizedMA_critical_density";
const source = index.files.find(file => file.declarations.some(declaration => declaration.name === name));
assert(source, `Missing known declaration ${name}`);
const original = process.env.MATH_TOOLKIT_DISABLE_RG;
try {
  process.env.MATH_TOOLKIT_DISABLE_RG = "1";
  const result = searchLean(roots, { query: name, context: 2 });
  assert.match(result, /Precomputed Lean index/);
  assert.match(result, /ABPCriticalDensity\.lean:20/);
  assert.match(result, /```lean\s+theorem linearizedMA_critical_density/);
  assert.match(searchLean(roots, { query: name, kind: "theorem" }), /### theorem linearizedMA_critical_density/);
  assert.match(searchLean(roots, { query: name, kind: "def" }), /No Lean declarations found/);
  assert.match(searchLean(roots, { query: "[", literal: false }), /Invalid regex/);
  assert.match(searchLean(roots, { query: "^linearizedMA_critical_density$", literal: false, path: source.path }), /ABPCriticalDensity\.lean:20/);
  assert.match(searchLean(roots, { query: "__math_toolkit_no_such_declaration_987654321__" }), /No Lean declarations found/);
} finally {
  if (original === undefined) delete process.env.MATH_TOOLKIT_DISABLE_RG;
  else process.env.MATH_TOOLKIT_DISABLE_RG = original;
}
console.log(`PASS: Lean index counts, known declaration, no-rg search, path/kind filters, regex and no matches. Compressed index: ${compressed.length} bytes (${(compressed.length / 1024 / 1024).toFixed(2)} MiB).`);
