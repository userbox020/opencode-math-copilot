import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runLeanSource } from "./lean.js";
import { safePath, slash } from "./paths.js";

export const DEFAULT_AXIOMS = ["propext", "Quot.sound", "Classical.choice"];
const NAME = /^[\p{L}_][\p{L}\p{N}_']*(?:\.[\p{L}_][\p{L}\p{N}_']*)*$/u;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Fail closed on absent, duplicate, malformed, or unfamiliar Lean diagnostics.
function readAxioms(output, theorem) {
  const name = escapeRegex(theorem);
  const lines = output.split(/\r?\n/);
  // Count candidates before recognizing their format: a malformed second report
  // must not disappear merely because the first report was valid.
  const candidates = lines.flatMap((line, index) => line.startsWith(`'${theorem}`) || line.startsWith(theorem) ? [index] : []);
  if (candidates.length !== 1) return null;
  const report = lines.slice(candidates[0]).join("\n").match(new RegExp(`^'${name}' (?:depends on axioms:\\s*\\[([^\\]]*)\\]|does not depend on any axioms)\\s*$`));
  if (!report) return null;
  const axioms = report[1] === undefined || !report[1].trim() ? [] : report[1].split(",").map(name => name.trim());
  if (!axioms.every(name => NAME.test(name))) return null;
  return [...new Set(axioms)];
}

export function leanVerify(roots, args = {}, runner = runLeanSource) {
  const started = performance.now();
  const validRequest = args !== null && typeof args === "object" && !Array.isArray(args);
  const { code, file, theorem, expectedType, imports = ["Mathlib"], allowedAxioms = DEFAULT_AXIOMS, docker = false, timeoutMs = 60000 } = validRequest ? args : {};
  const receipt = {
    version: "math-lean-verify/v1",
    execution: { status: "error", mode: docker ? "docker" : "native", exitCode: null, durationMs: 0 },
    compilation: { status: "not-run" },
    target: { theorem: theorem ?? null, expectedType: expectedType ?? null, status: "not-requested" },
    proof: { status: "not-requested", axioms: [], allowedAxioms, unauthorizedAxioms: [], sorryAx: false },
    checker: { tool: "lake env lean" },
    note: "Informal correspondence is not assessed. This receipt checks a user solution against the supplied trusted type, not the meaning of an informal claim.",
  };
  try {
    if (!validRequest) throw new Error("Usage error: request must be an object, not null or an array.");
    if ((code !== undefined) === (file !== undefined)) throw new Error("Usage error: provide exactly one of `code` or `file`.");
    if (typeof theorem !== "string" || !NAME.test(theorem) || theorem.startsWith("_root_.")) throw new Error("Usage error: theorem must be a fully qualified Lean name (without _root_.).");
    if (typeof expectedType !== "string" || !expectedType.trim()) throw new Error("Usage error: expectedType must be a nonempty trusted Lean type.");
    for (const [label, names] of [["imports", imports], ["allowedAxioms", allowedAxioms]]) {
      if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !NAME.test(name))) throw new Error(`Usage error: ${label} must contain Lean names, not source code or paths.`);
    }
    if (typeof docker !== "boolean" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Usage error: docker must be boolean; timeoutMs must be an integer from 1000 to 120000.");
    let userSource = code;
    if (file !== undefined) {
      if (typeof file !== "string") throw new Error("Usage error: file must be a .lean path under math/lean.");
      const filename = safePath(safePath(roots.math, "lean"), slash(file).replace(/^(?:math\/)?lean\//i, ""));
      if (path.extname(filename).toLowerCase() !== ".lean") throw new Error("Usage error: file must have a .lean extension.");
      userSource = fs.readFileSync(filename, "utf8");
    }
    if (typeof userSource !== "string") throw new Error("Usage error: code must be Lean source text.");
    receipt.proof.status = "unverified";
    const marker = `math_verify_${randomUUID().replaceAll("-", "")}`;
    const checkedName = `${marker}_checked`;
    const prefix = imports.map(name => `import ${name}`).join("\n") + "\n\n" + userSource + `\n\n#eval IO.println "${marker}_begin"\n`;
    // Audit the elaborated application, including synthesized instances,
    // implicit arguments and coercions, rather than just the original theorem.
    const checked = `theorem _root_.${checkedName} : (${expectedType}) := _root_.${theorem}\n`;
    const checkedStart = prefix.split("\n").length;
    const checkedEnd = checkedStart + checked.split("\n").length - 2;
    const source = prefix + checked + `#print axioms _root_.${checkedName}\n#eval IO.println "${marker}_end"\n`;
    const result = runner(roots, source, { docker, timeoutMs });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const timedOut = result.error?.code === "ETIMEDOUT" || result.timedOut === true;
    const missingTool = result.missingTool === true || result.error?.code === "ENOENT";
    receipt.execution.status = timedOut ? "timeout" : missingTool ? "missing-tool" : result.error || result.signal || result.status == null ? "error" : "completed";
    receipt.execution.exitCode = result.status ?? null;
    if (result.error || result.signal) receipt.execution.error = result.error?.message || `Terminated by ${result.signal}`;
    const compiled = !result.notRun && receipt.execution.status === "completed" && result.status === 0 && !/^.*\berror:/m.test(output);
    receipt.compilation.status = result.notRun || missingTool ? "not-run" : compiled ? "compiled" : "failed";
    receipt.proof.sorryAx = /\bsorryAx\b/.test(output);
    const begin = `${marker}_begin`;
    const end = `${marker}_end`;
    const lines = output.split(/\r?\n/);
    const first = lines.indexOf(begin);
    const last = lines.indexOf(end);
    const complete = first >= 0 && last > first && lines.lastIndexOf(begin) === first && lines.lastIndexOf(end) === last;
    const axioms = complete ? readAxioms(lines.slice(first + 1, last).join("\n"), checkedName) : null;
    if (axioms !== null) {
      receipt.target.status = "identified";
      receipt.proof.axioms = axioms;
      receipt.proof.unauthorizedAxioms = axioms.filter(name => !allowedAxioms.includes(name));
    }
    // Lean diagnostics are version-dependent. Only classify known target errors;
    // all other failures remain unverified, never inferred successful.
    const targetError = new RegExp(`(?:unknown (?:identifier|constant)|unknown declaration)[^\\n]*['\u0060](?:_root_\\.)?${escapeRegex(theorem)}['\u0060]`, "i");
    if (targetError.test(output)) receipt.target.status = "missing";
    const diagnostics = [...output.matchAll(/:(\d+):\d+: error:([^]*?)(?=\n[^\n]*:\d+:\d+: (?:error|warning):|$)/g)];
    if (diagnostics.some(match => Number(match[1]) >= checkedStart && Number(match[1]) <= checkedEnd && /type mismatch|has type[\s\S]*expected|is expected to have type/i.test(match[2]))) receipt.target.status = "mismatch";
    if (receipt.proof.sorryAx) receipt.proof.status = "incomplete";
    else if (receipt.proof.unauthorizedAxioms.length) receipt.proof.status = "rejected";
    else if (receipt.compilation.status === "compiled" && complete && axioms !== null && receipt.target.status === "identified") receipt.proof.status = "verified";
    if (!compiled && output) receipt.compilation.diagnostics = output.slice(-8000);
    if (compiled && (!complete || axioms === null)) receipt.proof.reason = "Missing, ambiguous, or unrecognized axiom/checker output; no proof certified.";
  } catch (error) {
    receipt.execution.status = "error";
    receipt.execution.error = error.message;
  }
  receipt.execution.durationMs = Math.round(performance.now() - started);
  return JSON.stringify(receipt);
}
