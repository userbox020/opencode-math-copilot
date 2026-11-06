import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable } from "./paths.js";

const script = fileURLToPath(new URL("../scripts/math_compute.py", import.meta.url));
const operations = new Set([
  "simplify", "factor", "expand", "solve", "diff", "integrate",
  "limit", "series", "evalf", "det", "eigenvalues",
]);

export function sympyVersion() {
  const python = findExecutable("python") || findExecutable("python3");
  if (!python) return null;
  const result = spawnSync(python, ["-c", "import sympy; print(sympy.__version__)"], {
    shell: false,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  return result.status === 0 ? (result.stdout || "").trim() || null : null;
}

export function compute(roots, args) {
  const python = findExecutable("python") || findExecutable("python3");
  if (!python) return "Python is missing. Install Python 3 and SymPy (`python -m pip install sympy`), then put python or python3 on PATH.";
  if (!args || !operations.has(args.operation)) return "SymPy error: Unsupported operation.";
  const timeout = args.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    return "SymPy error: timeoutMs must be an integer from 1000 to 120000.";
  }
  if (args.order !== undefined && (!Number.isInteger(args.order) || args.order < 1 || args.order > 50)) {
    return "SymPy error: order must be an integer from 1 to 50.";
  }
  const matrixOperation = args.operation === "det" || args.operation === "eigenvalues";
  if (matrixOperation) {
    const matrix = args.matrix;
    if (!Array.isArray(matrix) || matrix.length < 1 || matrix.length > 10 ||
        matrix.some(row => !Array.isArray(row) || row.length !== matrix.length ||
          row.some(value => typeof value !== "number" || !Number.isFinite(value)))) {
      return "SymPy error: matrix must be a square array of finite numbers, size 1 to 10.";
    }
  } else if (typeof args.expression !== "string" || !args.expression.trim() || args.expression.length > 2000) {
    return "SymPy error: expression must contain 1 to 2000 characters.";
  }
  if (args.variable !== undefined && typeof args.variable !== "string") {
    return "SymPy error: variable must be a symbol name.";
  }
  if (args.point !== undefined && !(typeof args.point === "string" && args.point.length <= 2000) &&
      !(typeof args.point === "number" && Number.isFinite(args.point))) {
    return "SymPy error: point must be a bounded expression string or a finite number.";
  }
  // Only fixed fields are sent. JSON is one argv value, never shell source.
  const payload = {
    operation: args.operation,
    expression: matrixOperation ? undefined : args.expression,
    matrix: matrixOperation ? args.matrix : undefined,
    variable: args.variable,
    point: args.point,
    order: args.order,
  };
  const child = spawnSync(python, [script, JSON.stringify(payload)], {
    shell: false,
    cwd: roots?.workspace || path.dirname(script),
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (child.error || child.status !== 0) {
    const reason = child.error?.code === "ETIMEDOUT" ? "timed out" : "process failed";
    const tail = (child.stderr || "").trim().slice(-2000);
    return `SymPy ${reason}: ${tail || child.error?.code || `exit ${child.status}`}`;
  }
  let output;
  try {
    output = JSON.parse(child.stdout);
  } catch {
    return "SymPy error: Python returned invalid JSON.";
  }
  if (output?.ok === false) return `SymPy error: ${output.error || "Computation failed."}`;
  if (output?.ok !== true || typeof output.result !== "string") return "SymPy error: Python returned an invalid result.";
  const input = matrixOperation ? JSON.stringify(args.matrix) : args.expression;
  const content = `Input: ${input}\nResult: ${output.result}`;
  const fence = "`".repeat(Math.max(3, ...Array.from(content.matchAll(/`+/g), match => match[0].length + 1)));
  return `### SymPy: ${args.operation}\n\n${fence}text\n${content}\n${fence}`;
}
