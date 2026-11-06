import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { clip, fence, leanLabel } from "./format.js";
import { findExecutable, mathPath, relativeMath, rejectTraversal, safePath, slash } from "./paths.js";

const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const level = section => typeof section.level === "number" ? section.level : (LEVELS[section.level] ?? 2);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
const EXCLUSIONS = ["**/.git/**", "**/node_modules/**", "**/.lake/**", "**/build/tools/**", "**/build/figures/**", "**/.env", "**/.env.*", "**/*.{pem,key,p12,pfx}", "**/*credential*", "**/*token*", "**/*endpoint*", "**/*password*"];

function readSource(filename) {
  if (fs.statSync(filename).size > 8 * 1024 * 1024) throw new Error("Source exceeds the 8 MB read limit; use math_grep on a smaller file.");
  return fs.readFileSync(filename, "utf8");
}

export function resolveManuscript(index, roots, value) {
  rejectTraversal(value);
  const normalized = slash(value).replace(/^math\//i, "").replace(/\/$/, "");
  let key = normalized.toLowerCase();
  const absolute = path.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
  if (absolute || /^preprints(?:\/|$)/i.test(normalized)) {
    const resolved = mathPath(roots, normalized);
    safePath(path.join(roots.math, "preprints"), resolved);
    key = relativeMath(roots, resolved).toLowerCase();
  }
  const exact = index.manuscripts.filter(m => [m.id, m.pdf, m.dir, m.title, path.posix.basename(m.dir)].some(v => v?.toLowerCase() === key));
  if (exact.length) return exact;
  if (!key) return [];
  return index.manuscripts.filter(m => m.title.toLowerCase().includes(key) || path.posix.basename(m.dir).toLowerCase().includes(key));
}

export function manuscript(index, roots, { path: requested, section, maxChars = 12000 }) {
  const matches = resolveManuscript(index, roots, requested);
  if (!matches.length) return "No manuscript found. Use math_search to find an indexed title or PDF path.";
  if (matches.length > 1) return clip(`Ambiguous manuscript; use one of these PDF paths:\n${matches.slice(0, 30).map(m => `- ${m.title}: \`${m.pdf}\``).join("\n")}${matches.length > 30 ? `\n… ${matches.length - 30} more candidates.` : ""}`, 15000);
  const m = matches[0];
  const preprints = path.join(roots.math, "preprints");
  const sourcePath = value => safePath(preprints, mathPath(roots, value));
  const files = fs.readdirSync(sourcePath(m.dir), { withFileTypes: true });
  const outlineLine = s => `${"  ".repeat(Math.max(0, Math.min(8, level(s) - 2)))}- ${s.title} (${s.file}:${s.line})`;
  const fullOutline = m.sections.map(outlineLine).join("\n");
  const topLevel = m.sections.filter(s => level(s) <= 2);
  const compactOutline = (topLevel.length ? topLevel : m.sections.slice(0, 20)).map(outlineLine).join("\n");
  const outline = section !== undefined ? compactOutline : fullOutline;
  const outlineTitle = section !== undefined ? "## Section outline (top level)" : "## Section outline";
  const metadata = `# ${m.title}\n- Family: ${m.family} — ${m.familyTitle}\n- Authors: ${m.author || "unknown"}\n- Date: ${m.date || "unknown"}\n- Formalized: ${leanLabel(m)}\n- Lean title: ${m.leanTitle || "none"}\n- PDF: \`${m.pdf}\`\n- README: \`${m.readme}\`\n- Main TeX: \`${m.texFile || "not indexed"}\`\n\n## Top-level files\n${files.slice(0, 50).map(f => `- ${f.name}${f.isDirectory() ? "/" : ""}`).join("\n")}${files.length > 50 ? "\n… [file listing truncated]" : ""}\n\n${outlineTitle}\n${clip(outline || "No headings indexed.", section !== undefined ? 6000 : 18000)}`;
  if (section !== undefined) {
    const headings = m.sections.filter(s => s.title.toLowerCase().includes(section.toLowerCase()));
    const heading = headings.find(s => s.title.toLowerCase() === section.toLowerCase()) || headings[0];
    if (!heading) return `${metadata}\n\nNo section matches ${JSON.stringify(section)}.`;
    const lines = readSource(sourcePath(heading.file)).split(/\r?\n/);
    const next = m.sections.filter(s => s.file === heading.file && s.line > heading.line && level(s) <= level(heading)).sort((a, b) => a.line - b.line)[0];
    const end = next ? next.line - 1 : lines.length;
    const text = lines.slice(heading.line - 1, end).join("\n");
    return `${metadata}\n\n## Section source: ${heading.title}\n${headings.length > 1 ? "Multiple headings matched; showing the first/exact match.\n" : ""}Source: \`${heading.file}:${heading.line}-${end}\` (range before character truncation)\n${fence(clip(text, maxChars), "tex")}`;
  }
  return `${metadata}\n\n## README citation/metadata\n${fence(clip(readSource(sourcePath(m.readme)), maxChars), "markdown")}`;
}

function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  return match[1].split(",").flatMap(part => expandBraces(pattern.slice(0, match.index) + part + pattern.slice(match.index + match[0].length)));
}

function globRegex(pattern) {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { i++; expression += "(?:.*/)?"; }
      else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`, "i");
}

const excludedPatterns = EXCLUSIONS.flatMap(expandBraces).map(globRegex);
function excluded(relative) {
  return excludedPatterns.some(re => re.test(relative) || re.test(relative + "/"));
}

function grepFallback(roots, target, { query, glob, literal, limit, context }) {
  let regex;
  if (!literal) {
    try { regex = new RegExp(query); } catch (error) { return `Invalid regex: ${error.message}`; }
  }
  const patterns = expandBraces(slash(glob)).map(globRegex);
  const fileMatches = name => patterns.some(re => re.test(name.includes("/") ? name : path.basename(name)) || re.test(path.posix.basename(name)));
  let scanned = 0, bytes = 0, hits = 0, outputChars = 0, truncated = false, skipped = 0;
  const output = [];
  function* walk(filename) {
    const relative = relativeMath(roots, filename);
    if (excluded(relative)) return;
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(filename)) yield* walk(path.join(filename, entry));
    } else if (stat.isFile() && fileMatches(relative)) yield { filename, stat, relative };
  }
  for (const { filename, stat, relative } of walk(target)) {
    if (scanned >= 20000) { truncated = true; break; }
    scanned++;
    if (stat.size > MAX_FILE) { skipped++; continue; }
    if (bytes + stat.size > MAX_BYTES) { truncated = true; break; }
    bytes += stat.size;
    const buffer = fs.readFileSync(safePath(roots.math, filename));
    if (buffer.includes(0)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    const emitted = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (!(literal ? lines[i].includes(query) : regex.test(lines[i]))) continue;
      if (hits >= limit) { truncated = true; break; }
      hits++;
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
        if (emitted.has(j)) continue;
        emitted.add(j);
        const line = `${relative}:${j + 1}: ${clip(lines[j], 1000)}`;
        output.push(line);
        outputChars += line.length;
      }
      if (outputChars > 55000) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return `${hits ? fence(output.join("\n")) : "No matches found."}\n\nNode fallback: scanned ${scanned} files, ${bytes} bytes.${skipped ? ` Skipped ${skipped} oversized files.` : ""}${truncated ? " Results truncated (match, output, or scan budget reached)." : ""}`;
}

export function grepCorpus(roots, { query, path: requested = "preprints", glob = "*.{tex,md,lean}", literal = true, limit = 40, context = 0 }) {
  const target = mathPath(roots, requested);
  if (!fs.existsSync(target)) return "Search path does not exist.";
  if (!query) return "Provide a non-empty query.";
  const relative = relativeMath(roots, target);
  if (excluded(relative)) return "This path is excluded from text searches (generated, dependency, or sensitive files).";
  if (fs.statSync(target).isFile() && fs.statSync(target).size > MAX_FILE) return "File exceeds the 2 MB search limit.";
  const options = { query, glob, literal, limit, context };
  const rg = process.env.MATH_TOOLKIT_DISABLE_RG ? null : findExecutable("rg");
  if (!rg || /\.(cmd|bat)$/i.test(rg)) return grepFallback(roots, target, options);
  const args = ["--json", "--no-config", "--color", "never", "--max-filesize", "2M", "--max-count", String(limit + 1), "--context", String(context), "--glob", glob];
  for (const pattern of EXCLUSIONS) args.push("--iglob", "!" + pattern);
  if (literal) args.push("--fixed-strings");
  args.push("--", query, target);
  const result = spawnSync(rg, args, { cwd: roots.math, shell: false, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error?.code === "ENOENT") return grepFallback(roots, target, options);
  if (result.status > 1 && /regex|pattern|parse error/i.test(result.stderr || "")) return `Invalid regex or glob: ${clip(result.stderr, 2000)}`;
  let hits = 0, chars = 0, truncated = Boolean(result.error), stop = false;
  const output = [];
  for (const record of (result.stdout || "").split(/\r?\n/)) {
    if (!record) continue;
    let event;
    try { event = JSON.parse(record); } catch { truncated = true; continue; }
    if (event.type !== "match" && event.type !== "context") continue;
    if (event.type === "match") {
      if (hits >= limit) { truncated = true; stop = true; break; }
      hits++;
    }
    const data = event.data;
    if (!data.path?.text || !data.lines?.text) continue;
    const filename = safePath(roots.math, data.path.text);
    const text = `${relativeMath(roots, filename)}:${data.line_number}: ${clip(data.lines.text.replace(/\r?\n$/, ""), 1000)}`;
    output.push(text);
    chars += text.length;
    if (chars > 55000) { truncated = true; stop = true; break; }
  }
  const error = result.error || (result.status > 1 ? { message: result.stderr } : null);
  return `${hits ? fence(output.join("\n")) : "No matches found."}${truncated || stop ? "\n\nResults truncated (match/output limit or execution budget reached)." : ""}${error ? `\n\nSearch incomplete: ${clip(error.message, 2000)}` : ""}`;
}
