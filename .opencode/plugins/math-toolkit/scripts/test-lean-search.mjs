import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchLean } from "../lib/lean-search.js";
import { resolveRoots } from "../lib/paths.js";

const roots = resolveRoots({ directory: fileURLToPath(new URL("../../../../", import.meta.url)) });
if (!fs.existsSync(path.join(roots.math, "lean"))) {
  console.log("SKIP: math/lean is absent; skipping real-corpus Lean search tests. test-tools.mjs covers fixture search.");
  process.exit(0);
}

// Located in the real corpus before writing this test (line 20).
const filename = "lean/OAI/Analysis/AffineBernstein/ABPCriticalDensity.lean";
const name = "linearizedMA_critical_density";
const result = searchLean(roots, { query: name, path: filename, context: 1 });
assert(result.includes(`${filename}:20`), result);
assert(result.includes(`theorem ${name}`), result);

const theorems = searchLean(roots, { query: ".", literal: false, path: path.posix.dirname(filename), kind: "theorem", limit: 10 });
const headings = [...theorems.matchAll(/^### (\w+) (.+)$/gm)];
assert(headings.length > 0, theorems);
assert(headings.every(([, kind]) => kind === "theorem" || kind === "lemma"), theorems);
assert(headings.every(([, kind]) => kind === "theorem"), "Kind filters must be exact.");
assert.match(searchLean(roots, { query: "[", literal: false }), /invalid regex/i);
assert.match(searchLean(roots, { query: name, path: "../" }), /traversal/i);

const originalPath = process.env.PATH;
const originalDisableRg = process.env.MATH_TOOLKIT_DISABLE_RG;
try {
  process.env.PATH = "";
  process.env.MATH_TOOLKIT_DISABLE_RG = "1";
  const fallback = searchLean(roots, { query: name.toUpperCase(), path: filename });
  assert.match(fallback, /Node fallback/);
  assert(fallback.includes(`${filename}:20`), fallback);
  assert(fallback.includes(name), fallback);
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalDisableRg === undefined) delete process.env.MATH_TOOLKIT_DISABLE_RG;
  else process.env.MATH_TOOLKIT_DISABLE_RG = originalDisableRg;
}

console.log(`Sample query: ${JSON.stringify({ query: name, path: filename, context: 1 })}\n${result}`);
console.log("PASS: Lean declaration search, kind filter, invalid regex, traversal rejection, and Node fallback.");
