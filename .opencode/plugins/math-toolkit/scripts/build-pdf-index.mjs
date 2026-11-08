import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { pdfText, resolvePdf } from "../lib/pdf.js";
import { PDF_INDEX_FILE } from "../lib/pdf-index.js";
import { relativeMath } from "../lib/paths.js";

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const options = { pages: "1-2", limit: Infinity, out: PDF_INDEX_FILE, mathRoot: path.join(workspace, "math"), json: false };
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") options.json = true;
    else if (["--pages", "--limit", "--out", "--math-root"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      options[flag === "--math-root" ? "mathRoot" : flag.slice(2)] = flag === "--limit" ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.limit !== Infinity && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error("--limit must be a positive integer");
  const selected = new Set();
  if (options.pages.length > 100) throw new Error("--pages must select at most 5 positive pages");
  for (const part of options.pages.split(",")) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 5) throw new Error("--pages must select at most 5 positive pages");
    for (let page = start; page <= end; page++) selected.add(page);
    if (selected.size > 5) throw new Error("--pages must select at most 5 positive pages");
  }
  const roots = { workspace, math: path.resolve(options.mathRoot) };
  if (!fs.statSync(roots.math).isDirectory()) throw new Error(`Math corpus is not a directory: ${roots.math}`);
  const seen = new Set();
  function* walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".lake", "node_modules", ".git"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(filename);
      else if (entry.isFile() && /\.pdf$/i.test(entry.name)) yield filename;
    }
  }
  function* candidates() {
    const preprints = path.join(roots.math, "preprints");
    if (fs.existsSync(preprints)) {
      for (const entry of fs.readdirSync(preprints, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try { yield resolvePdf(roots, `preprints/${entry.name}`); } catch { /* Remaining PDFs are found by the walk. */ }
      }
    }
    yield* walk(roots.math);
  }
  const documents = [];
  let attempted = 0, skipped = 0;
  for (const filename of candidates()) {
    // Canonicalization failures are unreadable-PDF skips too, not fatal builds.
    let real;
    try { real = fs.realpathSync(filename); } catch { real = filename; }
    if (seen.has(real)) continue;
    seen.add(real);
    attempted++;
    try {
      const extracted = await pdfText(roots, { path: relativeMath(roots, filename), pages: [...selected].join(","), maxChars: 20000 });
      if (extracted.startsWith("PDF extraction error:")) throw new Error(extracted);
      const pages = extracted.split(/^## Page /m).slice(1).map(block => {
        const newline = block.indexOf("\n");
        return { page: Number(block.slice(0, newline).trim()), text: block.slice(newline + 1).replace(/\n\n\[Output truncated;[^\]]*\]$/, "").trim() };
      });
      if (!pages.length) throw new Error("No page excerpts extracted");
      documents.push({ path: relativeMath(roots, filename), pages });
    } catch (error) {
      skipped++;
      console.error(`Skipped ${relativeMath(roots, filename)}: ${String(error.message).slice(0, 250)}`);
    }
    if (attempted % 25 === 0) console.error(`PDF excerpts: ${attempted} attempted, ${documents.length} indexed, ${skipped} skipped`);
    if (attempted >= options.limit) break;
  }
  const counts = { documents: documents.length, pages: 0, chars: 0 };
  for (const document of documents) for (const page of document.pages) { counts.pages++; counts.chars += page.text.length; }
  const index = { version: 1, generatedAt: new Date().toISOString(), counts, documents };
  const output = path.resolve(options.out);
  const compressed = gzipSync(JSON.stringify(index));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + `.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, compressed); fs.renameSync(temporary, output); }
  finally { try { fs.unlinkSync(temporary); } catch { /* Renamed. */ } }
  const report = { output, ...counts, attempted, skipped, bytes: compressed.length };
  console.log(options.json ? JSON.stringify(report) : `PDF excerpt index: ${JSON.stringify(report, null, 2)}`);
} catch (error) {
  console.error(`PDF index build failed: ${error.message}`);
  process.exitCode = 1;
}
