import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { clip, fence } from "./format.js";
import { findExecutable, inside, mathPath, relativeMath, safePath, slash } from "./paths.js";

export const DECLARATION = /^\s*(?:@\[[^\]]*\]\s*)*(?:private\s+|protected\s+|noncomputable\s+|partial\s+|unsafe\s+)*(theorem|lemma|def|abbrev|class|structure|inductive|instance)\s+([A-Za-z0-9_'.]+)/;
const KINDS = new Set(["theorem", "lemma", "def", "abbrev", "class", "structure", "inductive", "instance", "all"]);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 30000;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 300000;
const INDEX_FILE = fileURLToPath(new URL("../data/lean-index.json.gz", import.meta.url));
let cachedIndex;

function indexSearch(roots, targets, { query, kind, literal, limit, context }) {
  if (!cachedIndex) {
    const index = JSON.parse(gunzipSync(fs.readFileSync(INDEX_FILE)).toString("utf8"));
    if (index.version !== 1 || !Array.isArray(index.files)) throw new Error("Unsupported Lean index format.");
    cachedIndex = index;
  }
  const needle = query.toLowerCase();
  const regex = literal ? null : new RegExp(query, "i");
  const matches = [];
  // The precomputed index covers the real project tree. If the caller points
  // at a fixture or another tree, the indexed relative paths will not exist on
  // disk; let searchLean use the bounded Node walk instead.
  let candidate = null;
  for (const file of cachedIndex.files) {
    const filename = path.resolve(roots.math, file.path);
    if (targets.some(target => inside(target.directory, filename))) { candidate = filename; break; }
  }
  if (!candidate || !fs.existsSync(candidate)) return null;
  for (const file of cachedIndex.files) {
    const filename = path.resolve(roots.math, file.path);
    if (!targets.some(target => inside(target.directory, filename))) continue;
    for (const declaration of file.declarations) {
      if (kind !== "all" && declaration.kind !== kind) continue;
      if (literal ? declaration.name.toLowerCase().includes(needle) : regex.test(declaration.name)) {
        matches.push({ ...declaration, path: file.path });
      }
    }
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  matches.sort((a, b) => compare(a.name, b.name) || compare(a.path, b.path) || a.line - b.line);
  const hits = [];
  let skipped = 0, outputSize = 0, truncated = "";
  for (const match of matches) {
    let lines;
    try {
      const filename = safePath(roots.math, match.path);
      if (fs.statSync(filename).size > MAX_FILE) { skipped++; continue; }
      lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
      const declaration = DECLARATION.exec(lines[match.line - 1] || "");
      if (!declaration || declaration[1] !== match.kind || declaration[2] !== match.name) { skipped++; continue; }
    } catch { skipped++; continue; }
    const snippet = [clip(lines[match.line - 1], 500)];
    for (let j = match.line; j < lines.length && snippet.length <= context; j++) {
      if (lines[j].trim()) snippet.push(clip(lines[j], 500));
    }
    const hit = `### ${match.kind} ${match.name}\n- Source: \`${match.path}:${match.line}\`\n\n${fence(snippet.join("\n"), "lean")}`;
    if (outputSize + hit.length > 58000) { truncated = "output cap (~60,000 characters)"; break; }
    hits.push(hit);
    outputSize += hit.length + 2;
    if (hits.length >= limit) { truncated = `result limit (${limit}); more matches may exist`; break; }
  }
  const status = "Precomputed Lean index: project sources only; .lake dependencies are not indexed.";
  const skippedNote = skipped ? ` Skipped ${skipped} stale, missing, oversized, or unsafe entries; rebuild with npm run index:lean.` : "";
  return clip(`${status}${skippedNote}${truncated ? `\nTruncated: ${truncated}.` : ""}\n\n${hits.length ? hits.join("\n\n") : "No Lean declarations found."}`, 60000);
}

function excluded(filename, defaultRoot) {
  const name = slash(filename);
  return /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/.test(name)
    || /(?:^|\/)\.lake\/build(?:\/|$)/.test(name)
    // Default search covers the project tree plus Mathlib as a separate root.
    // Do not walk every dependency checkout under .lake/packages.
    || (defaultRoot && /(?:^|\/)\.lake(?:\/|$)/.test(name));
}

function* walk(directory, defaultRoot, state) {
  if (state.truncated || excluded(directory, defaultRoot)) return;
  let stat;
  try { stat = fs.lstatSync(directory); } catch { state.skipped++; return; }
  // Do not follow nested symlinks or junctions; search roots are resolved first.
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (directory.endsWith(".lean")) yield directory;
    return;
  }
  if (!stat.isDirectory()) return;
  let handle;
  try { handle = fs.opendirSync(directory); } catch { state.skipped++; return; }
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (++state.entries > MAX_ENTRIES) {
        state.truncated = "directory-entry cap (300,000)";
        return;
      }
      const filename = path.join(directory, entry.name);
      if (excluded(filename, defaultRoot) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* walk(filename, defaultRoot, state);
      else if (entry.isFile() && entry.name.endsWith(".lean")) yield filename;
      if (state.truncated) return;
    }
  } finally { handle.closeSync(); }
}

function* files(directory, defaultRoot, rg, state) {
  if (rg) {
    const args = ["--files", "--hidden", "--no-ignore", "--null", "-g", "*.lean",
      "-g", "!.git", "-g", "!node_modules", "-g", "!**/.lake/build/**"];
    if (defaultRoot) args.push("-g", "!**/.lake/**");
    const result = spawnSync(rg, [...args, "--", directory], {
      shell: false, encoding: "utf8", timeout: 15000,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    if (!result.error && (result.status === 0 || result.status === 1)) {
      state.backends.add("rg file discovery");
      for (const filename of result.stdout.split("\0")) {
        if (filename && !excluded(filename, defaultRoot)) yield filename;
      }
      return;
    }
  }
  state.backends.add("Node fallback");
  yield* walk(directory, defaultRoot, state);
}

function rgSearch(roots, targets, { query, kind, literal, limit, context, rg }) {
  const hits = [];
  let outputSize = 0;
  let truncated = "";
  const declarationPrefix = String.raw`^\s*(?:@\[[^\]]*\]\s*)*(?:private\s+|protected\s+|noncomputable\s+|partial\s+|unsafe\s+)*(?:theorem|lemma|def|abbrev|class|structure|inductive|instance)\s+`;
  const needle = literal ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : `(?:${query})`;
  const pattern = `${declarationPrefix}.*${needle}`;
  for (const target of targets) {
    const args = ["--json", "--no-config", "--color", "never", "--line-number",
      "--ignore-case", "--max-count", "5", "--glob", "*.lean",
      "--glob", "!.git/**", "--glob", "!node_modules/**"];
    if (target.defaultRoot) args.push("--glob", "!**/.lake/**");
    args.push("--regexp", pattern, "--", target.directory);
    const result = spawnSync(rg, args, {
      shell: false, encoding: "utf8", timeout: 30000,
      maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    if (result.error) return null;
    if (result.status === 1) continue;
    if (result.status > 1) return `Invalid regex or search error: ${clip(result.stderr || "rg failed", 2000)}`;
    let lines = null;
    let filename = null;
    for (const record of (result.stdout || "").split(/\r?\n/)) {
      if (!record) continue;
      let event;
      try { event = JSON.parse(record); } catch { continue; }
      if (event.type !== "match" || !event.data?.path?.text || !event.data.lines?.text) continue;
      const text = event.data.lines.text.replace(/\r?\n$/, "");
      const declaration = DECLARATION.exec(text);
      if (!declaration || (kind !== "all" && declaration[1] !== kind)) continue;
      const checked = safePath(roots.math, event.data.path.text);
      const relative = relativeMath(roots, checked);
      if (event.data.path.text !== filename) {
        filename = event.data.path.text;
        lines = null;
      }
      if (!lines) {
        try { lines = fs.readFileSync(checked, "utf8").split(/\r?\n/); } catch { lines = []; }
      }
      const lineNumber = event.data.line_number;
      const snippet = [clip(text, 500)];
      for (let j = lineNumber; j < lines.length && snippet.length <= context; j++) {
        if (lines[j].trim()) snippet.push(clip(lines[j], 500));
      }
      const hit = `### ${declaration[1]} ${declaration[2]}\n- Source: \`${relative}:${lineNumber}\`\n\n${fence(snippet.join("\n"), "lean")}`;
      if (outputSize + hit.length > 58000) { truncated = "output cap (~60,000 characters)"; break; }
      hits.push(hit);
      outputSize += hit.length + 2;
      if (hits.length >= limit) { truncated = `result limit (${limit}); more matches may exist`; break; }
    }
    if (hits.length >= limit || truncated) break;
  }
  return `${truncated ? `Truncated: ${truncated}.\n\n` : ""}${hits.length ? hits.join("\n\n") : "No Lean declarations found."}`;
}

function nodeSearch(roots, targets, { query, kind, literal, limit, context }) {
  let matches;
  if (literal) {
    const needle = query.toLowerCase();
    matches = line => line.toLowerCase().includes(needle);
  } else {
    try {
      const regex = new RegExp(query, "i");
      matches = line => regex.test(line);
    } catch (error) { return clip(`Invalid regex: ${error.message}`, 60000); }
  }

  const state = { files: 0, bytes: 0, entries: 0, skipped: 0, truncated: "", backends: new Set() };
  const hits = [];
  let outputSize = 0;
  search: for (const target of targets) {
    if (excluded(relativeMath(roots, target.directory), target.defaultRoot)) continue;
    const realRoot = fs.realpathSync(target.directory);
    for (const filename of files(realRoot, target.defaultRoot, null, state)) {
      if (state.files >= MAX_FILES) { state.truncated = "file cap (30,000)"; break search; }
      state.files++;
      let text, relative;
      try {
        const local = path.join(target.directory, path.relative(realRoot, filename));
        const checked = safePath(roots.math, local);
        relative = relativeMath(roots, checked);
        if (excluded(relative, target.defaultRoot)) continue;
        const stat = fs.statSync(checked);
        if (!stat.isFile() || stat.size > MAX_FILE) { state.skipped++; continue; }
        if (state.bytes + stat.size > MAX_BYTES) { state.truncated = "byte cap (200 MB)"; break search; }
        text = fs.readFileSync(checked, "utf8");
        state.bytes += stat.size;
      } catch { state.skipped++; continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const declaration = DECLARATION.exec(lines[i]);
        if (!declaration || (kind !== "all" && declaration[1] !== kind) || !matches(lines[i])) continue;
        const snippet = [clip(lines[i], 500)];
        for (let j = i + 1; j < lines.length && snippet.length <= context; j++) {
          if (lines[j].trim()) snippet.push(clip(lines[j], 500));
        }
        const hit = `### ${declaration[1]} ${declaration[2]}\n- Source: \`${relative}:${i + 1}\`\n\n${fence(snippet.join("\n"), "lean")}`;
        if (outputSize + hit.length > 58000) { state.truncated = "output cap (~60,000 characters)"; break search; }
        hits.push(hit);
        outputSize += hit.length + 2;
        if (hits.length >= limit) { state.truncated = `result limit (${limit}); more matches may exist`; break search; }
      }
    }
  }
  const status = `${[...state.backends].join(" / ") || "Lean search"}: scanned ${state.files} files, ${state.bytes} bytes.${state.skipped ? ` Skipped ${state.skipped} oversized, unreadable, or unsafe entries.` : ""}`;
  const note = state.truncated ? `\nTruncated: ${state.truncated}. Narrow path/query or adjust limit.` : "";
  return clip(`${status}${note}\n\n${hits.length ? hits.join("\n\n") : "No Lean declarations found."}`, 60000);
}

/** Search declaration lines, not elaborated Lean syntax or imported namespaces. */
export function searchLean(roots, args = {}) {
  const { query, path: requestedPath, kind = "all", literal = true, limit = 20, context = 0 } = args;
  if (typeof query !== "string" || !query.length) return "Usage error: query must be a non-empty string.";
  if (!KINDS.has(kind)) return "Usage error: invalid declaration kind.";
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return "Usage error: limit must be an integer from 1 to 100.";
  if (!Number.isInteger(context) || context < 0 || context > 3) return "Usage error: context must be an integer from 0 to 3.";
  if (typeof literal !== "boolean" || (requestedPath !== undefined && typeof requestedPath !== "string")) {
    return "Usage error: literal must be boolean and path must be a string.";
  }
  if (!literal) {
    try { new RegExp(query, "i"); } catch (error) { return clip(`Invalid regex: ${error.message}`, 60000); }
  }
  try {
    const selected = mathPath(roots, requestedPath ?? "lean");
    const leanRoot = safePath(roots.math, "lean");
    if (!fs.existsSync(leanRoot) || !fs.statSync(leanRoot).isDirectory()) {
      return "Lean directory math/lean is missing. Clone the openai/math corpus into math/ (or point this workspace at an existing clone), then retry.";
    }
    if (!fs.existsSync(selected)) return `Lean search path does not exist: ${relativeMath(roots, selected)}.`;
    const targets = [{ directory: selected, defaultRoot: requestedPath === undefined }];
    if (requestedPath === undefined) {
      const mathlib = safePath(roots.math, "lean/.lake/packages/mathlib/Mathlib");
      if (fs.existsSync(mathlib)) targets.push({ directory: mathlib, defaultRoot: false });
    }
    const executable = process.env.MATH_TOOLKIT_DISABLE_RG ? null : findExecutable("rg");
    const rg = executable && !/\.(cmd|bat)$/i.test(executable) ? executable : null;
    if (rg) {
      const result = rgSearch(roots, targets, { query, kind, literal, limit, context, rg });
      if (result !== null) return clip(result, 60000);
    }
    let indexNote = "";
    try {
      const indexed = indexSearch(roots, targets, { query, kind, literal, limit, context });
      if (indexed !== null) return clip(indexed, 60000);
    } catch (error) {
      indexNote = error.code === "ENOENT"
        ? "Lean declaration index is missing. Rebuild with npm run index:lean."
        : `Lean declaration index could not be loaded: ${error.message}`;
    }
    return clip(`${indexNote ? `${indexNote}\n\n` : ""}${nodeSearch(roots, targets, { query, kind, literal, limit, context })}`, 60000);
  } catch (error) { return clip(`Lean search error: ${error.message}`, 60000); }
}
