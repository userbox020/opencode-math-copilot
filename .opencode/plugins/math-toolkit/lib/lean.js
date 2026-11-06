import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { clip, fence } from "./format.js";
import { findExecutable, safePath, slash } from "./paths.js";

const SETUP = "Install elan/Lean, ensure `lake` is on PATH, then run `lake exe cache get` from `math/lean`.";
const COMPARATOR = "`comparator`, `landrun`, and `lean4export` must be on PATH.";

export function runLake(roots, args, timeout, tailSize) {
  const lake = findExecutable("lake");
  if (!lake) return `Cannot run Lean: lake was not found on PATH. ${SETUP}`;
  // Node cannot execute Windows batch files with shell:false. Do not route
  // user-controlled arguments through cmd.exe; require the native elan shim.
  if (/\.(cmd|bat)$/i.test(lake)) return `Found ${lake}, but batch shims cannot run safely with shell:false. Put elan's native lake.exe on PATH. ${SETUP}`;
  const cwd = safePath(roots.math, "lean");
  if (!fs.existsSync(cwd)) return `Lean directory does not exist: ${cwd}. ${SETUP}`;
  const result = spawnSync(lake, args, { cwd, shell: false, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const tail = output.length > tailSize ? "[earlier output truncated]\n" + output.slice(-tailSize) : output;
  return `**${result.status === 0 && !result.error ? "PASS" : "FAIL"}** — exit code: ${result.status ?? "none"}${result.signal ? `; signal: ${result.signal}` : ""}${result.error ? `\nExecution error: ${result.error.message}` : ""}\n${fence(tail || "(no output)")}`;
}

export function leanCheck(roots, { code, file, imports, timeoutMs = 60000 }) {
  if ((code !== undefined) === (file !== undefined)) return "Usage error: provide exactly one of `code` or `file`.";
  const leanRoot = safePath(roots.math, "lean");
  if (file !== undefined) {
    const normalized = slash(file).replace(/^(?:math\/)?lean\//i, "");
    const filename = safePath(leanRoot, normalized);
    if (path.extname(filename).toLowerCase() !== ".lean") return "Usage error: file must have a .lean extension.";
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return "Lean file does not exist.";
    return runLake(roots, ["env", "lean", path.relative(leanRoot, filename)], timeoutMs, 8000);
  }
  const modules = imports?.length ? imports : ["Mathlib"];
  if (modules.some(name => !/^[\p{L}_][\p{L}\p{N}_']*(?:\.[\p{L}_][\p{L}\p{N}_']*)*$/u.test(name))) return "Usage error: imports must be Lean module names, not source code or paths.";
  if (!findExecutable("lake")) return `Cannot run Lean: lake was not found on PATH. ${SETUP}`;
  if (!fs.existsSync(leanRoot)) return `Lean directory does not exist. ${SETUP}`;
  const directory = safePath(leanRoot, path.join(".lake", "math-toolkit"));
  const filename = safePath(leanRoot, path.join(directory, `${randomUUID()}.lean`));
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(filename, modules.map(name => `import ${name}`).join("\n") + "\n\n" + code, { flag: "wx" });
    return runLake(roots, ["env", "lean", path.relative(leanRoot, filename)], timeoutMs, 8000);
  } finally {
    fs.rmSync(filename, { force: true });
  }
}

export function leanBuild(index, roots, { target = "OAI.Analysis", timeoutMs = 600000 }) {
  const validName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(target);
  if (!validName || !(index.lean.libraries.includes(target) || /^(?:OAI\.|HodgeConjecture(?:\.|$)|ComparatorChallenges(?:\.|$))/.test(target))) {
    return `Invalid build target. Available targets:\n${index.lean.libraries.map(name => `- ${name}`).join("\n")}`;
  }
  return `Whole-library builds are expensive; prefer a focused library/module target.\n\n${runLake(roots, ["build", target], timeoutMs, 10000)}`;
}

export function comparator(roots, { challenge, timeoutMs = 600000 }) {
  const leanRoot = safePath(roots.math, "lean");
  const challengeRoot = safePath(leanRoot, "ComparatorChallenges");
  let normalized = slash(challenge).replace(/^(?:(?:math\/)?lean\/)?ComparatorChallenges\//i, "");
  if (!normalized.toLowerCase().endsWith(".json")) normalized += ".json";
  const filename = safePath(challengeRoot, normalized);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return `Challenge file does not exist. ${COMPARATOR}`;
  return `${COMPARATOR}\n\n${runLake(roots, ["env", "comparator", path.relative(leanRoot, filename)], timeoutMs, 10000)}`;
}
