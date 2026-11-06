import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { compute } from "../lib/compute.js";
import { findExecutable } from "../lib/paths.js";

const python = findExecutable("python") || findExecutable("python3");
if (!python || spawnSync(python, ["-c", "import sympy"], {
  shell: false, encoding: "utf8", timeout: 30000,
}).status !== 0) {
  console.log("SKIP: Python with SymPy is not installed.");
  process.exit(0);
}

const samples = [
  [{ operation: "simplify", expression: "sin(x)^2 + cos(x)^2" }, /Result: 1\n/],
  [{ operation: "solve", expression: "x^2 - 1" }, /Result: \[-1, 1\]/],
  [{ operation: "diff", expression: "x^3" }, /Result: 3\*x\*\*2\n/],
  [{ operation: "det", matrix: [[1, 2], [3, 4]] }, /Result: -2\n/],
];
for (const [args, expected] of samples) {
  const output = compute({}, args);
  assert.match(output, expected);
  console.log(output);
}
assert.match(compute({}, {
  operation: "simplify", expression: '__import__("os").system("echo bad")',
}), /^SymPy error:/);

const previousPath = process.env.PATH;
const previousDisableExtras = process.env.MATH_TOOLKIT_DISABLE_EXTRAS;
try {
  process.env.PATH = "";
  process.env.MATH_TOOLKIT_DISABLE_EXTRAS = "1";
  assert.match(compute({}, { operation: "simplify", expression: "x" }), /Install Python/);
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousDisableExtras === undefined) delete process.env.MATH_TOOLKIT_DISABLE_EXTRAS;
  else process.env.MATH_TOOLKIT_DISABLE_EXTRAS = previousDisableExtras;
}
console.log("PASS");
