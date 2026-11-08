import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mathPath, relativeMath, safePath } from "./paths.js";

const MAX_BYTES = 80 * 1024 * 1024;
const MAX_PAGES = 50;

export function pdfCacheDirectory() {
  return process.env.MATH_TOOLKIT_PDF_CACHE || path.join(os.homedir(), ".cache", "opencode-math-copilot", "pdf");
}

function cacheLocation(filename, stat, pages, maxChars) {
  if (process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE === "1") return null;
  const key = JSON.stringify({ path: path.resolve(filename), size: stat.size, mtimeMs: stat.mtimeMs, pages: pages ?? null, maxChars, format: "pdf-text-v1" });
  return { key, file: path.join(pdfCacheDirectory(), createHash("sha256").update(key).digest("hex") + ".json") };
}

function readCache(cache) {
  if (!cache) return null;
  try {
    const value = JSON.parse(fs.readFileSync(cache.file, "utf8"));
    return value.key === cache.key && typeof value.text === "string" && value.text.startsWith("# PDF text:") ? value.text : null;
  } catch { return null; }
}

function writeCache(cache, text) {
  if (!cache) return;
  let temporary;
  try {
    const directory = path.dirname(cache.file);
    fs.mkdirSync(directory, { recursive: true });
    const content = JSON.stringify({ key: cache.key, text });
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
      .map(entry => { const file = path.join(directory, entry.name); return { file, ...fs.statSync(file) }; })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0) + Buffer.byteLength(content);
    let count = entries.length + 1;
    for (const entry of entries) {
      if (count <= 500 && bytes <= 200 * 1024 * 1024) break;
      fs.unlinkSync(entry.file);
      bytes -= entry.size;
      count--;
    }
    temporary = cache.file + `.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, cache.file);
  } catch { /* Cache failures must never prevent extraction. */ }
  finally { if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Already renamed or unavailable. */ } } }
}

function clipOutput(text, limit) {
  if (text.length <= limit) return text;
  const note = "\n\n[Output truncated; request fewer pages or increase maxChars.]";
  return text.slice(0, limit - note.length) + note;
}

export function resolvePdf(roots, requested) {
  let filename = mathPath(roots, requested);
  if (!fs.existsSync(filename)) {
    const preprints = mathPath(roots, "preprints");
    const normalize = value => value.toLowerCase().replace(/[-\s]+/g, " ");
    const query = normalize(requested.trim());
    const matches = fs.existsSync(preprints)
      ? fs.readdirSync(preprints, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && normalize(entry.name).includes(query))
        .map(entry => entry.name).sort()
      : [];
    if (!matches.length) throw new Error("No PDF or preprint found. Use math_search to find a title, then provide its PDF path relative to math/.");
    if (matches.length > 1) {
      throw new Error(`Ambiguous title; provide one of these preprint paths:\n${matches.slice(0, 50).map(name => `- preprints/${name}`).join("\n")}${matches.length > 50 ? `\n… ${matches.length - 50} more candidates; narrow the title.` : ""}`);
    }
    filename = safePath(roots.math, path.join(preprints, matches[0]));
  }
  if (fs.statSync(filename).isDirectory()) {
    const directory = filename;
    const readme = safePath(roots.math, path.join(directory, "README.md"));
    if (fs.existsSync(readme)) {
      const source = fs.readFileSync(readme, "utf8");
      const links = source.matchAll(/\[[^\]\r\n]*\]\(\s*<?([^\r\n]*?\.pdf)>?\s*(?:"[^"\r\n]*"\s*)?\)/gi);
      for (const link of links) {
        const target = decodeURIComponent(link[1]);
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(target)) continue;
        // Validate before resolving so a README link cannot hide traversal.
        const linked = safePath(roots.math, safePath(directory, target));
        if (fs.existsSync(linked) && fs.statSync(linked).isFile()) return linked;
      }
    }
    const first = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.pdf$/i.test(entry.name))
      .map(entry => entry.name).sort()[0];
    if (!first) throw new Error("No released PDF found in this directory. Provide a direct .pdf path relative to math/ or download the manuscript PDF first.");
    filename = safePath(roots.math, path.join(directory, first));
  }
  if (!/\.pdf$/i.test(filename) || !fs.statSync(filename).isFile()) {
    throw new Error("Provide a .pdf file, a preprint directory, or a unique manuscript title substring.");
  }
  return filename;
}

function parsePages(value, total) {
  if (value === undefined) return { pages: Array.from({ length: Math.min(10, total) }, (_, i) => i + 1), capped: false };
  if (typeof value !== "string" || !value.trim()) throw new Error('Invalid pages: use positive page numbers or ranges, e.g. "1-5,8".');
  const ranges = value.split(",").map(part => {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    const start = Number(match?.[1]);
    const end = Number(match?.[2] ?? match?.[1]);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error('Invalid pages: use ascending positive ranges, e.g. "1-5,8".');
    }
    return [start, Math.min(end, total)];
  });
  const pages = new Set();
  for (const [start, end] of ranges) {
    for (let n = start; n <= end; n++) {
      pages.add(n);
      if (pages.size > MAX_PAGES) return { pages: [...pages].slice(0, MAX_PAGES), capped: true };
    }
  }
  if (!pages.size) throw new Error(`No requested pages are in this PDF. Choose pages between 1 and ${total}.`);
  return { pages: [...pages], capped: false };
}

async function loadPdfEngine() {
  try {
    const direct = await import("unpdf");
    if (direct.getDocumentProxy) return direct;
  } catch { /* Try local package locations below. */ }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [
    path.resolve(here, "..", "..", "..", "node_modules", "unpdf"),
    path.resolve(here, "..", "..", "..", "..", "node_modules", "unpdf"),
  ];
  for (const root of roots) {
    // Prefer the bundled PDF.js entry: it has no "unpdf/pdfjs" self-reference.
    const bundle = path.join(root, "dist", "pdfjs.mjs");
    if (fs.existsSync(bundle)) {
      try {
        const engine = await import(pathToFileURL(bundle).href);
        if (engine.getDocument) return engine;
      } catch { /* Try the package entry next. */ }
    }
    const index = path.join(root, "dist", "index.mjs");
    if (fs.existsSync(index)) {
      try {
        const engine = await import(pathToFileURL(index).href);
        if (engine.getDocumentProxy) return engine;
      } catch { /* Try the next location. */ }
    }
  }
  return null;
}

export async function pdfText(roots, args = {}) {
  const { path: requested, pages, maxChars = 12000 } = args;
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 50000) return "PDF extraction error: maxChars must be an integer between 1000 and 50000.";
  let pdf;
  let destroyPdf;
  try {
    if (typeof requested !== "string" || !requested.trim()) throw new Error("Provide a PDF path relative to math/, a preprint directory, or a unique title substring.");
    const filename = resolvePdf(roots, requested);
    const stat = fs.statSync(filename);
    if (stat.size > MAX_BYTES) throw new Error("PDF exceeds the 80 MB extraction limit. Provide a smaller PDF.");
    const cache = cacheLocation(filename, stat, pages, maxChars);
    const cached = readCache(cache);
    if (cached !== null) return cached;
    const engine = await loadPdfEngine();
    if (!engine) throw new Error("the `unpdf` package is not installed. Run `npm install` in the repo root (or `.opencode`), then reload the plugin.");
    const data = new Uint8Array(fs.readFileSync(filename));
    if (engine.getDocumentProxy) {
      pdf = await engine.getDocumentProxy(data);
      destroyPdf = async () => {
        if (typeof pdf.destroy === "function") await pdf.destroy();
        else if (pdf.loadingTask?.destroy) await pdf.loadingTask.destroy();
      };
    } else {
      const task = engine.getDocument({ data });
      pdf = await task.promise;
      destroyPdf = async () => task.destroy();
    }
    const selection = parsePages(pages, pdf.numPages);
    let output = `# PDF text: ${relativeMath(roots, filename)}\n\nPDF pages: ${pdf.numPages}. Selected pages: ${selection.pages.join(", ")}. Text extraction only; no OCR.\n`;
    if (selection.capped) output += "\n[Page selection capped at 50 pages; request remaining pages separately.]\n";
    for (const number of selection.pages) {
      const page = await pdf.getPage(number);
      let text;
      try {
        const { items } = await page.getTextContent();
        text = items.filter(item => "str" in item).map(item => item.str + (item.hasEOL ? "\n" : " ")).join("").trim();
      } finally {
        page.cleanup();
      }
      output += `\n## Page ${number}\n\n${text || "No extractable text found on this page; it may be scanned or image-only. No OCR was performed."}\n`;
      if (output.length > maxChars) break;
    }
    // Do not persist truncated, capped, failed, or concurrently changed documents.
    await destroyPdf();
    destroyPdf = null;
    const after = fs.statSync(filename);
    if (!selection.capped && output.length <= maxChars && after.size === stat.size && after.mtimeMs === stat.mtimeMs) writeCache(cache, output);
    return clipOutput(output, maxChars);
  } catch (error) {
    let message = error?.message || String(error);
    if (error?.name === "PasswordException" || /password|encrypt/i.test(message)) {
      message = "PDF is encrypted or password-protected. Provide an unencrypted PDF; password handling is not supported.";
    } else if (error?.name === "InvalidPDFException" || /invalid pdf|malformed|bad xref/i.test(message)) {
      message = "PDF is malformed or invalid. Download a valid PDF and try again.";
    }
    return clipOutput(`PDF extraction error: ${message}`, maxChars);
  } finally {
    if (destroyPdf) { try { await destroyPdf(); } catch { /* Preserve the extraction error. */ } }
  }
}
