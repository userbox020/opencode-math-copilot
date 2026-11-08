import { clip, fence } from "./format.js";
import { pdfText } from "./pdf.js";

/**
 * Search the extracted text of one PDF/preprint. This is intentionally bounded:
 * it does not scan the entire 778-PDF corpus, which would require a separate
 * full-text index and many minutes of extraction.
 */
export async function pdfSearch(roots, args = {}) {
  const { query, path: requested, pages, literal = true, limit = 10 } = args;
  if (typeof query !== "string" || !query.trim()) return "Usage error: query must be a non-empty string.";
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return "Usage error: limit must be an integer from 1 to 20.";
  if (typeof literal !== "boolean") return "Usage error: literal must be boolean.";

  let regex;
  if (!literal) {
    try { regex = new RegExp(query, "i"); } catch (error) { return `Invalid regex: ${error.message}`; }
  }

  const extracted = await pdfText(roots, { path: requested, pages, maxChars: 50000 });
  if (extracted.startsWith("PDF extraction error:")) return extracted;

  const blocks = [];
  const parts = extracted.split(/^## Page /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    if (newline === -1) continue;
    const page = Number(part.slice(0, newline).trim());
    if (!Number.isSafeInteger(page)) continue;
    blocks.push({ page, text: part.slice(newline + 1) });
  }

  const hits = [];
  for (const block of blocks) {
    const lines = block.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (literal ? line.toLowerCase().includes(query.toLowerCase()) : regex.test(line)) {
        hits.push({ page: block.page, line: i + 1, text: clip(line.trim(), 700) });
        if (hits.length >= limit) break;
      }
    }
    if (hits.length >= limit) break;
  }

  if (!hits.length) {
    return `No matches for ${JSON.stringify(query)} in the extracted PDF text.${pages ? ` Pages: ${pages}.` : " Default extraction is the first 10 pages; pass pages to search more."}`;
  }

  const output = hits.map((hit) => `- page ${hit.page}, line ${hit.line}: ${hit.text}`).join("\n");
  return `# PDF search: ${JSON.stringify(query)}\n${hits.length === limit ? "Showing the first " + limit + " matches.\n" : ""}\n${fence(output)}`;
}
