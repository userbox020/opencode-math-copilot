import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fence } from "./format.js";
import { findExecutable, safePath, slash } from "./paths.js";

const SETUP = "Install elan/Lean, ensure `lake` is on PATH, then run `lake exe cache get` from `math/lean`.";
const COMPARATOR = "`comparator`, `landrun`, and `lean4export` must be on PATH.";

function dockerResult(result, tailSize = 10000) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const tail = output.length > tailSize ? "[earlier output truncated]\n" + output.slice(-tailSize) : output;
  return `[docker] **${result.status === 0 && !result.error ? "PASS" : "FAIL"}** — exit code: ${result.status ?? "none"}${result.signal ? `; signal: ${result.signal}` : ""}${result.error ? `\nExecution error: ${result.error.message}` : ""}\n${fence(tail || "(no output)")}`;
}

function runDocker(args, timeout, { comparatorImage = false, checkDirectory, challenge } = {}) {
  const docker = findExecutable("docker");
  if (!docker) return "[docker] Cannot run Lean: docker was not found on PATH. Install Docker Desktop (Linux containers) or Docker Engine and start it.";
  if (/\.(cmd|bat)$/i.test(docker)) return `[docker] Found ${docker}, but batch shims cannot run safely with shell:false. Put the native Docker executable on PATH.`;
  const image = comparatorImage ? (process.env.MATH_TOOLKIT_COMPARATOR_IMAGE || "opencode-math-comparator") : (process.env.MATH_TOOLKIT_LEAN_IMAGE || "opencode-math-lean");
  const volume = process.env.MATH_TOOLKIT_LEAN_VOLUME || "opencode-math-lean";
  const toolsVolume = process.env.MATH_TOOLKIT_COMPARATOR_VOLUME || "opencode-comparator-tools";
  if (![volume, ...(comparatorImage ? [toolsVolume] : [])].every(name => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))) return "[docker] Invalid Docker volume name. Configure MATH_TOOLKIT_LEAN_VOLUME / MATH_TOOLKIT_COMPARATOR_VOLUME with named volumes, not paths.";
  const run = (command, limit = 30000) => spawnSync(docker, command, { shell: false, encoding: "utf8", timeout: limit, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const available = result => result.status === 0 && !result.error;
  const imageCheck = run(["image", "inspect", "--", image]);
  if (!available(imageCheck)) {
    const daemon = run(["info", "--format", "{{.ServerVersion}}"]);
    if (!available(daemon)) return `[docker] Docker is unavailable. Start Docker Desktop (Linux containers) or Docker Engine and check docker info.\n${dockerResult(daemon)}`;
    return `[docker] Docker image ${image} is not available. Build it with docker build -f docker/${comparatorImage ? "comparator" : "lean"}.Dockerfile -t ${image} .`;
  }
  if (!available(run(["volume", "inspect", "--", volume]))) {
    const leanImage = process.env.MATH_TOOLKIT_LEAN_IMAGE || "opencode-math-lean";
    return `[docker] Docker volume ${volume} is not available. Create and initialize it with docker volume create ${volume}, then docker run --rm -v ${volume}:/work ${leanImage} verify-lean.sh.`;
  }
  const mounts = ["-v", `${volume}:/work`];
  if (comparatorImage) {
    const created = run(["volume", "create", "--", toolsVolume]);
    if (!available(created)) return `[docker] Could not create/use Comparator tools volume ${toolsVolume}.\n${dockerResult(created)}`;
    mounts.push("-v", `${toolsVolume}:/opt`);
  }
  // Pass the native absolute Windows path as one argv element; Docker Desktop
  // accepts the drive colon in -v without MSYS conversion or shell quoting.
  if (checkDirectory) mounts.push("-v", `${checkDirectory}:/check:ro`);
  const environment = challenge === undefined ? [] : ["-e", `CHALLENGE=${challenge}`];
  const container = `math-toolkit-${randomUUID()}`;
  const result = run(["run", "--rm", "--name", container, ...mounts, "-w", "/work/math/lean", ...environment, image, ...args], timeout);
  // Killing the Docker client on timeout does not necessarily stop its container.
  // Only remove this invocation's uniquely named container, never other runs.
  if (result.error) run(["rm", "--force", container]);
  return dockerResult(result, checkDirectory ? 8000 : 10000);
}

function dockerCheck(source, timeout) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-check-"));
  try {
    fs.writeFileSync(path.join(directory, "Check.lean"), source, { flag: "wx" });
    return runDocker(["lake", "env", "lean", "/check/Check.lean"], timeout, { checkDirectory: directory });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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

export function leanCheck(roots, { code, file, imports, timeoutMs = 60000, docker = false }) {
  if ((code !== undefined) === (file !== undefined)) return "Usage error: provide exactly one of `code` or `file`.";
  const leanRoot = safePath(roots.math, "lean");
  if (file !== undefined) {
    const normalized = slash(file).replace(/^(?:math\/)?lean\//i, "");
    const filename = safePath(leanRoot, normalized);
    if (path.extname(filename).toLowerCase() !== ".lean") return "Usage error: file must have a .lean extension.";
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return "Lean file does not exist.";
    if (docker) return dockerCheck(fs.readFileSync(filename, "utf8"), timeoutMs);
    return runLake(roots, ["env", "lean", path.relative(leanRoot, filename)], timeoutMs, 8000);
  }
  const modules = imports?.length ? imports : ["Mathlib"];
  if (modules.some(name => !/^[\p{L}_][\p{L}\p{N}_']*(?:\.[\p{L}_][\p{L}\p{N}_']*)*$/u.test(name))) return "Usage error: imports must be Lean module names, not source code or paths.";
  if (docker) return dockerCheck(modules.map(name => `import ${name}`).join("\n") + "\n\n" + code, timeoutMs);
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

export function leanBuild(index, roots, { target = "OAI.Analysis", timeoutMs = 600000, docker = false }) {
  const validName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(target);
  if (!validName || !(index.lean.libraries.includes(target) || /^(?:OAI\.|HodgeConjecture(?:\.|$)|ComparatorChallenges(?:\.|$))/.test(target))) {
    return `Invalid build target. Available targets:\n${index.lean.libraries.map(name => `- ${name}`).join("\n")}`;
  }
  const result = docker ? runDocker(["bash", "-lc", `lake build ${target}`], timeoutMs) : runLake(roots, ["build", target], timeoutMs, 10000);
  return `Whole-library builds are expensive; prefer a focused library/module target.\n\n${result}`;
}

export function comparator(roots, { challenge, timeoutMs, docker = false }) {
  // The first Docker run builds the challenge dependency closure and can take
  // far longer than a host run; later runs reuse the persistent volume.
  const limit = timeoutMs ?? (docker ? 1800000 : 600000);
  const leanRoot = safePath(roots.math, "lean");
  const challengeRoot = safePath(leanRoot, "ComparatorChallenges");
  let normalized = slash(challenge).replace(/^(?:(?:math\/)?lean\/)?ComparatorChallenges\//i, "");
  if (!normalized.toLowerCase().endsWith(".json")) normalized += ".json";
  const filename = safePath(challengeRoot, normalized);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return `Challenge file does not exist. ${COMPARATOR}`;
  if (docker) {
    const result = runDocker(["verify-comparator.sh"], timeoutMs, { comparatorImage: true, challenge: slash(path.relative(leanRoot, filename)) });
    return `${result}\n\nNote: the standalone Comparator version may not match the corpus Lean 4.34.1 pin.`;
  }
  return `${COMPARATOR}\n\n${runLake(roots, ["env", "comparator", path.relative(leanRoot, filename)], timeoutMs, 10000)}`;
}
