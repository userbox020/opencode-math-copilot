import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pdfText } from "../lib/pdf.js";
import { mathPath, resolveRoots } from "../lib/paths.js";

const roots = resolveRoots({ directory: fileURLToPath(new URL("../../../../", import.meta.url)) });
if (!fs.existsSync(mathPath(roots, "overview.pdf"))) {
  console.log("SKIP: math/overview.pdf is absent; install the math corpus to test PDF extraction.");
  process.exit(0);
}

function assertText(output) {
  assert.match(output, /## Page 1\b/);
  const text = output.split("## Page 1")[1].trim();
  assert.ok(text.length > 0, "Expected non-empty page text");
  assert.doesNotMatch(text, /No extractable text found|PDF extraction error/);
  return text;
}

const overview = await pdfText(roots, { path: "math/overview.pdf", pages: "1" });
const sample = assertText(overview);
const preprint = await pdfText(roots, {
  path: "preprints/The-Quasi-Riemann-Hypothesis-September-30-2026",
  pages: "1",
});
assertText(preprint);

const traversal = await pdfText(roots, { path: "../overview.pdf" });
assert.match(traversal, /traversal|not allowed/i);
const missing = await pdfText(roots, { path: "nonexistent-pdf-test-8b3fca.pdf" });
assert.match(missing, /No PDF or preprint found/);
assert.match(missing, /math_search|provide/i);

console.log(`Sample: ${sample.slice(0, 180).replace(/\s+/g, " ")}`);
console.log("PASS: PDF extraction, preprint resolution, traversal rejection, and missing-path guidance.");
