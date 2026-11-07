#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { DECLARATION } from "../lib/lean-search.js";
import { findExecutable, slash } from "../lib/paths.js";

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const mathRoot = path.join(workspace, "math");
const leanRoot = fs.realpathSync(path.join(mathRoot, "lean"));
const output = fileURLToPath(new URL("../data/lean-index.json.gz", import.meta.url));
const excluded = new Set([".lake", ".git", "node_modules"]);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_ENTRIES = 2000000;
let entries = 0;

function* walk(directory, depth = 0) {
  if (depth > 128) throw new Error("Node discovery depth cap (128) reached; index not written.");
  const handle = fs.opendirSync(directory);
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (++entries > MAX_ENTRIES) throw new Error("Node discovery entry cap (2,000,000) reached; index not written.");
      if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(filename, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".lean")) yield filename;
    }
  } finally { handle.closeSync(); }
}

function discover() {
  const rg = process.env.MATH_TOOLKIT_DISABLE_RG ? null : findExecutable("rg");
  if (rg && !/\.(cmd|bat)$/i.test(rg)) {
    const result = spawnSync(rg, ["--files", "--no-config", "--hidden", "--no-ignore", "--null",
      "-g", "*.lean", "-g", "!.lake", "-g", "!.git", "-g", "!node_modules", "--", leanRoot], {
      shell: false, encoding: "utf8", timeout: 120000, maxBuffer: 128 * 1024 * 1024, windowsHide: true,
    });
    if (!result.error && (result.status === 0 || result.status === 1)) {
      console.log("Discovery: rg --files");
      return result.stdout.split("\0").filter(Boolean);
    }
    console.warn(`rg discovery failed (${result.error?.message || result.stderr || result.status}); using bounded Node walk.`);
  }
  console.log("Discovery: bounded Node walk (2,000,000 entries, depth 128; cap aborts rather than emitting a partial index)");
  return [...walk(leanRoot)];
}

const index = { version: 1, generatedAt: new Date().toISOString(), counts: { files: 0, declarations: 0 }, files: [] };
let oversized = 0;
for (const filename of discover().sort()) {
  const relative = slash(path.relative(leanRoot, filename));
  if (relative.split("/").some(part => excluded.has(part))) continue;
  if (fs.statSync(filename).size > MAX_FILE) { oversized++; continue; }
  const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
  const declarations = [];
  for (let i = 0; i < lines.length; i++) {
    const match = DECLARATION.exec(lines[i]);
    if (match) declarations.push({ name: match[2], kind: match[1], line: i + 1 });
  }
  index.files.push({ path: `lean/${relative}`, declarations });
  index.counts.files++;
  index.counts.declarations += declarations.length;
}
const compressed = gzipSync(JSON.stringify(index), { level: 9 });
if (compressed.length > 25 * 1024 * 1024) throw new Error(`Compressed index is ${(compressed.length / 1024 / 1024).toFixed(2)} MiB (>25 MiB); index not written. Narrowing scope requires approval.`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, compressed);
console.log(`Wrote ${output}`);
console.log(`Files: ${index.counts.files}; declarations: ${index.counts.declarations}; skipped oversized (>2 MiB): ${oversized}`);
console.log(`Compressed size: ${compressed.length} bytes (${(compressed.length / 1024 / 1024).toFixed(2)} MiB)`);
