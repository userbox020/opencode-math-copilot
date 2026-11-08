import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { clip, fence } from "./format.js";

export const PDF_INDEX_FILE = fileURLToPath(new URL("../data/pdf-index.json.gz", import.meta.url));
export const PDF_INDEX_BUILD = "node .opencode/plugins/math-toolkit/scripts/build-pdf-index.mjs";

export function createPdfIndexReader(filename = PDF_INDEX_FILE) {
  let index;
  return () => {
    if (!index) {
      const parsed = JSON.parse(gunzipSync(fs.readFileSync(filename)).toString("utf8"));
      if (parsed.version !== 1 || !parsed.counts || !Array.isArray(parsed.documents)) throw new Error("Unsupported or invalid PDF excerpt index");
      index = parsed;
    }
    return index;
  };
}

export const getPdfIndex = createPdfIndexReader();

export function pdfIndexSearch(args = {}, getIndex = getPdfIndex) {
  const { query, limit = 10, literal = true } = args;
  if (typeof query !== "string" || !query.trim()) return "Usage error: query must be a non-empty string.";
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return "Usage error: limit must be an integer from 1 to 20.";
  if (typeof literal !== "boolean") return "Usage error: literal must be boolean.";
  let regex;
  if (!literal) {
    try { regex = new RegExp(query, "i"); } catch (error) { return `Invalid regex: ${error.message}`; }
  }
  let index;
  try { index = getIndex(); }
  catch (error) { return `PDF excerpt index unavailable: ${clip(error.message, 500)}\n\nBuild from the workspace root:\n\n\`${PDF_INDEX_BUILD}\`\n\nReload/restart the plugin afterward.`; }
  const groups = [];
  let hits = 0;
  const needle = query.toLowerCase();
  for (const document of index.documents) {
    const matches = [];
    for (const page of document.pages) {
      const lines = page.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(needle)) {
          matches.push(`- page ${page.page}, line ${i + 1}: ${clip(lines[i].trim(), 700)}`);
          if (++hits >= limit) break;
        }
      }
      if (hits >= limit) break;
    }
    if (matches.length) groups.push(`## ${document.path}\n${fence(matches.join("\n"))}`);
    if (hits >= limit) break;
  }
  return `# PDF excerpt index search: ${JSON.stringify(query)}\nIndex version: ${index.version}; documents: ${index.counts.documents}; pages: ${index.counts.pages}; chars: ${index.counts.chars}. Generated: ${index.generatedAt}.\nPrebuilt selected-page excerpts only (default first 2 pages); not a full-text corpus; no OCR. Use math_pdf_search for deeper page lookup.\n\n${groups.length ? groups.join("\n\n") : "No matches in the indexed excerpts."}${hits === limit ? `\n\nShowing the first ${limit} matches.` : ""}`;
}
