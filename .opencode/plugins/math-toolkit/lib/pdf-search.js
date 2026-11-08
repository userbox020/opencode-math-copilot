import { clip, fence } from "./format.js";
import { pdfText } from "./pdf.js";
import { runRegexLines } from "./regex-search.js";

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

  if (!literal) {
    try { new RegExp(query, "i"); } catch (error) { return `Invalid regex: ${error.message}`; }
  }

  const extracted = await pdfText(roots, { path: requested, pages, maxChars: 50000 });
  if (extracted.startsWith("PDF extraction error:")) return extracted;

  const lines = candidateLines(extracted);
  let matches;
  if (!literal) {
    const result = runRegexLines(lines.map(line => line.text), query);
    if (result.status !== "ok") return result.message;
    matches = result.matches;
  }
  const hits = matchingLines(lines, query, matches, limit);
  if (!hits.length) {
    return `No matches for ${JSON.stringify(query)} in the extracted PDF text.${pages ? ` Pages: ${pages}.` : " Default extraction is the first 10 pages; pass pages to search more."}`;
  }

  const output = hits.map((hit) => `- page ${hit.page}, line ${hit.line}: ${hit.text}`).join("\n");
  return `# PDF search: ${JSON.stringify(query)}\n${hits.length === limit ? "Showing the first " + limit + " matches.\n" : ""}\n${fence(output)}`;
}

function candidateLines(extracted) {
  const blocks = [];
  const parts = extracted.split(/^## Page /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    if (newline === -1) continue;
    const page = Number(part.slice(0, newline).trim());
    if (!Number.isSafeInteger(page)) continue;
    blocks.push({ page, text: part.slice(newline + 1) });
  }

  const candidates = [];
  for (const block of blocks) {
    const lines = block.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      candidates.push({ page: block.page, line: i + 1, text: lines[i] });
    }
  }
  return candidates;
}

function matchingLines(lines, query, matches, limit) {
  const hits = [];
  const needle = query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (matches ? matches[i] : line.text.toLowerCase().includes(needle)) {
      hits.push({ ...line, text: clip(line.text.trim(), 700) });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** Search only the top BM25 candidates, never walk the PDF corpus. */
export async function pdfCorpusSearch(roots, search, args = {}) {
  const { query, candidates = 5, pages = "1-2", limit = 10, literal = true } = args;
  if (typeof query !== "string" || !query.trim()) return "Usage error: query must be a non-empty string.";
  if (!Number.isInteger(candidates) || candidates < 1 || candidates > 10) return "Usage error: candidates must be an integer from 1 to 10.";
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return "Usage error: limit must be an integer from 1 to 20.";
  if (typeof literal !== "boolean") return "Usage error: literal must be boolean.";

  const pageError = 'Usage error: pages must select at most 5 distinct positive pages, e.g. "1-2,5" (maximum 100 characters).';
  if (typeof pages !== "string" || !pages.trim() || pages.length > 100) return pageError;
  const selectedPages = new Set();
  for (const part of pages.split(",")) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    const start = Number(match?.[1]);
    const end = Number(match?.[2] ?? match?.[1]);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 5) return pageError;
    for (let page = start; page <= end; page++) selectedPages.add(page);
    if (selectedPages.size > 5) return pageError;
  }

  if (!literal) {
    try { new RegExp(query, "i"); } catch (error) { return `Invalid regex: ${error.message}`; }
  }
  const results = search({ query, limit: candidates }).slice(0, candidates);
  if (!results.length) return `No candidate manuscripts found in the index for ${JSON.stringify(query)}. Try broader terms.`;

  const groups = [];
  const skipped = [];
  const regexCandidates = [];
  const addHits = (requested, hits) => {
    if (hits.length) {
      groups.push(`## ${requested}\n${fence(hits.map(hit => `- page ${hit.page}, line ${hit.line}: ${hit.text}`).join("\n"))}`);
      hitCount += hits.length;
    }
  };
  let hitCount = 0;
  let inspected = 0;
  for (const { manuscript } of results) {
    const requested = manuscript.dir || manuscript.pdf;
    inspected++;
    try {
      // At most 10 * 5000 returned extraction characters per request.
      const extracted = await pdfText(roots, { path: requested, pages: [...selectedPages].join(","), maxChars: 5000 });
      if (extracted.startsWith("PDF extraction error:")) {
        skipped.push(`- ${requested}: ${clip(extracted.replace(/\s+/g, " "), 250)}`);
        continue;
      }
      const lines = candidateLines(extracted);
      if (literal) addHits(requested, matchingLines(lines, query, undefined, limit - hitCount));
      else regexCandidates.push({ requested, lines });
    } catch (error) {
      skipped.push(`- ${requested}: ${clip(String(error?.message || error).replace(/\s+/g, " "), 250)}`);
    }
    if (hitCount >= limit) break;
  }

  if (!literal) {
    const result = runRegexLines(regexCandidates.flatMap(candidate => candidate.lines.map(line => line.text)), query);
    if (result.status !== "ok") return result.message;
    let offset = 0;
    for (const { requested, lines } of regexCandidates) {
      addHits(requested, matchingLines(lines, query, result.matches.slice(offset, offset + lines.length), limit - hitCount));
      offset += lines.length;
      if (hitCount >= limit) break;
    }
  }

  return `# PDF corpus search: ${JSON.stringify(query)}\nInspected ${inspected} of ${results.length} indexed candidates. Pages: ${pages}; at most 5 pages and 5000 extraction characters per candidate (50000 total). Not a full-text index; no OCR.\n\n${groups.length ? groups.join("\n\n") : "No matches in the extracted candidate PDF text."}${hitCount === limit ? `\n\nShowing the first ${limit} matches.` : ""}${skipped.length ? `\n\n## Skipped candidates\n${skipped.join("\n")}` : ""}`;
}
