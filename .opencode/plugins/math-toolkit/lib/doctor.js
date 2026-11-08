import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findExecutable, REBUILD } from "./paths.js";
import { sympyVersion } from "./compute.js";
import { pdfCacheDirectory } from "./pdf.js";
import { getPdfIndex, PDF_INDEX_FILE, PDF_INDEX_BUILD } from "./pdf-index.js";
import { clip } from "./format.js";

const data = fileURLToPath(new URL("../data/", import.meta.url));
function fileInfo(filename) {
  try { const stat = fs.statSync(filename); return `${stat.size} bytes; modified ${stat.mtime.toISOString()}`; }
  catch { return "missing or inaccessible"; }
}

function cacheInfo() {
  const directory = pdfCacheDirectory();
  let count = 0, bytes = 0, inspected = 0;
  try {
    const handle = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) && inspected++ < 10000) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        try { bytes += fs.statSync(path.join(directory, entry.name)).size; count++; } catch { /* Concurrent pruning. */ }
      }
    } finally { handle.closeSync(); }
    return `${directory}: ${count} entries, ${bytes} bytes${inspected > 10000 ? " (scan capped at 10000 directory entries)" : ""}`;
  } catch { return `${directory}: absent or inaccessible (created on first complete extraction)`; }
}

function diskFree(directory) {
  try {
    const stat = fs.statfsSync(directory, { bigint: true });
    return `${stat.bavail * stat.bsize} bytes available`;
  } catch { /* Windows Node versions may not implement statfs. */ }
  if (process.platform === "win32") {
    const powershell = findExecutable("powershell");
    if (powershell) {
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:MATH_DOCTOR_DISK_PATH -ErrorAction Stop).PSDrive.Free"], {
        env: { ...process.env, MATH_DOCTOR_DISK_PATH: directory }, shell: false, encoding: "utf8", timeout: 2000, maxBuffer: 4096, windowsHide: true,
      });
      if (result.status === 0 && /^\d+$/.test(result.stdout.trim())) return `${result.stdout.trim()} bytes available`;
    }
  }
  return "unavailable (path missing or filesystem probe unsupported)";
}

export function doctor(roots, getIndex) {
  const directoryExists = filename => { try { return fs.statSync(filename).isDirectory(); } catch { return false; } };
  const lines = ["# Math toolkit doctor", "", "## Corpus and indexes",
    `- Corpus clone path: ${roots.math}`,
    `- Math root: ${directoryExists(roots.math) ? "present" : "missing; clone openai/math into math/"}`,
    `- lean/: ${directoryExists(path.join(roots.math, "lean")) ? "present" : "missing; restore the corpus lean/ directory"}`,
    `- Manuscript index: ${fileInfo(path.join(data, "math-index.json"))}`,
  ];
  const loaded = getIndex();
  lines.push(loaded.index ? `- Manuscript counts: ${JSON.stringify(loaded.index.counts)}` : `- ${loaded.error || REBUILD}`);
  lines.push(`- Lean declaration index: ${fileInfo(path.join(data, "lean-index.json.gz"))} (not decompressed)`,
    `- PDF cache: ${cacheInfo()}${process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE === "1" ? "; disabled" : ""}`,
    `- PDF excerpt index: ${fileInfo(PDF_INDEX_FILE)}`);
  try {
    const index = getPdfIndex();
    const age = Date.now() - Date.parse(index.generatedAt);
    lines.push(`- PDF excerpts: version ${index.version}; ${JSON.stringify(index.counts)}; generated ${index.generatedAt}; age ${Number.isFinite(age) ? Math.max(0, Math.floor(age / 86400000)) + " days" : "unknown"}`);
  } catch { lines.push(`- PDF excerpts unavailable; run \`${PDF_INDEX_BUILD}\` and reload the plugin.`); }
  lines.push("", "## Host tools");
  for (const name of ["lake", "lean", "comparator", "landrun", "lean4export", "python", "rg"]) {
    const executable = findExecutable(name) || (name === "python" ? findExecutable("python3") : null);
    lines.push(`- ${name}: ${executable || "not found; install and add to PATH"}`);
  }
  lines.push(`- sympy: ${sympyVersion() || "unavailable; install with python -m pip install sympy"}`, "", "## Docker (inspection only)");
  const docker = findExecutable("docker");
  const usable = docker && !/\.(cmd|bat)$/i.test(docker);
  lines.push(`- Docker executable: ${docker || "missing; install/start Docker Desktop (Linux containers) or Docker Engine"}`);
  const resources = [
    ["image", "Lean image", process.env.MATH_TOOLKIT_LEAN_IMAGE || "opencode-math-lean", "build using docker/lean.Dockerfile; see docker/README.md"],
    ["image", "Comparator image", process.env.MATH_TOOLKIT_COMPARATOR_IMAGE || "opencode-math-comparator", "build using docker/comparator.Dockerfile; see docker/README.md"],
    ["volume", "Lean volume", process.env.MATH_TOOLKIT_LEAN_VOLUME || "opencode-math-lean", "initialize with verify-lean.sh as documented in docker/README.md"],
    ["volume", "Comparator tools volume", process.env.MATH_TOOLKIT_COMPARATOR_VOLUME || "opencode-comparator-tools", "created by the first Docker Comparator run; see docker/README.md"],
  ];
  for (const [kind, label, name, action] of resources) {
    const result = usable ? spawnSync(docker, [kind, "inspect", "--format", kind === "image" ? "{{.Id}}" : "{{.Name}}", "--", name], { shell: false, encoding: "utf8", timeout: 2000, maxBuffer: 16384, windowsHide: true }) : null;
    lines.push(`- ${label} (${name}): ${result?.status === 0 ? "present" : `missing or inspection unavailable; start Docker, then ${action}`}`);
  }
  lines.push("", "## Disk space", `- Repo (${roots.workspace}): ${diskFree(roots.workspace)}`, `- Corpus (${roots.math}): ${diskFree(roots.math)}`, "", "Availability only: no Lean checks, Docker builds, or recursive corpus scans were run.");
  return clip(lines.join("\n"), 16000);
}
