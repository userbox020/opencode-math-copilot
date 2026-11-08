import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

assert.ok(process.argv[2], "Usage: node scripts/test-package.mjs <package-root>");
const root = resolve(process.argv[2]);
const requiredFiles = [
  "package.json",
  "index.js",
  ".opencode/plugins/math-toolkit/main.js",
  ".opencode/plugins/math-toolkit/data/math-index.json",
  ".opencode/plugins/math-toolkit/data/lean-index.json.gz",
  "docker/verify-comparator.sh",
  "docs/verification.md",
];

for (const file of requiredFiles) {
  assert.ok(statSync(join(root, file)).isFile(), `Required package file: ${file}`);
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(manifest.private, true, "Package must retain private: true");
console.log(`Package smoke test: ${requiredFiles.length} files present; private: true.`);
