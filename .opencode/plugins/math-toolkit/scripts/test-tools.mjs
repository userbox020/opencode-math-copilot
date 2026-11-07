import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import plugin from "../../math-toolkit.js";
import { createSearch } from "../lib/search.js";
import { pdfText } from "../lib/pdf.js";
import { searchLean } from "../lib/lean-search.js";
import { findExecutable, resolveRoots, safePath } from "../lib/paths.js";

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const corpusAvailable = fs.existsSync(path.join(workspace, "math", "CONTENTS.md"));
const index = JSON.parse(fs.readFileSync(new URL("../data/math-index.json", import.meta.url), "utf8"));

assert.equal(index.counts.families, 373);
assert.equal(index.counts.manuscripts, 721);
assert.equal(index.counts.formalized, 175);
assert.equal(index.families.length, 373);
assert.equal(index.manuscripts.length, 721);
assert.equal(index.manuscripts.filter(m => m.formalized).length, 175);

const search = createSearch(index);
assert(search({ query: "Riemann hypothesis", limit: 5 }).some(r => r.manuscript.family === "003"));
const leanResults = search({ query: "lean:true", limit: 20 });
assert(leanResults.length && leanResults.every(r => r.manuscript.formalized));
assert(search({ query: "family:003 has:lean", limit: 20 }).every(r => r.manuscript.family === "003" && r.manuscript.formalized));

assert.equal(plugin.id, "math-toolkit");
assert.equal(typeof plugin.setup, "function");
const tools = new Map();
await plugin.setup({
  location: { directory: workspace, project: { directory: workspace } },
  tool: {
    async transform(edit) {
      await edit({
        add(definition) { tools.set(definition.name, definition); },
        list() { return []; },
        get() { return undefined; },
        namespace() {},
        update() {},
        remove() {},
      });
    },
  },
});
assert.equal(tools.size, 11);

const call = async (name, args = {}) => {
  const result = await tools.get(name).execute(args, {});
  return typeof result === "string" ? result : result.content;
};

let manuscript = null;
let grepArgs = null;
if (corpusAvailable) {
  manuscript = index.manuscripts.find(m => m.family === "003");
  assert(manuscript.sections.length);

  const metadata = await call("math_manuscript", { path: `math/${manuscript.pdf}` });
  assert(metadata.includes(manuscript.title), metadata);
  assert(metadata.includes("Family: 003"));
  assert(metadata.includes("## Section outline"));
  assert(metadata.includes(manuscript.sections[0].title));
  assert(metadata.includes("## README citation/metadata"));

  const section = await call("math_manuscript", { path: manuscript.dir, section: manuscript.sections[0].title, maxChars: 2000 });
  assert(section.includes("## Section source:"), section);
  assert(section.includes(`Source: \`${manuscript.sections[0].file}:${manuscript.sections[0].line}-`));
  assert(section.includes("\\section"));

  grepArgs = { query: "Introduction", path: manuscript.texFile, literal: true, limit: 3, context: 1 };
  const grep = await call("math_grep", grepArgs);
  assert(grep.includes(`${manuscript.texFile}:`), grep);
  assert(grep.includes("Introduction"));
  assert.match(await call("math_grep", { query: "[", path: manuscript.dir, literal: false }), /invalid regex/i);
} else {
  console.log("SKIP: math/ corpus clone not present; skipping manuscript/section/grep tests.");
}

const leanAvailable = fs.existsSync(path.join(workspace, "math", "lean"));
if (leanAvailable) {
  const lean = await call("math_lean_search", { query: "linearizedMA_critical_density", limit: 5 });
  assert(lean.includes("linearizedMA_critical_density"), lean);
  assert(lean.includes("ABPCriticalDensity.lean"), lean);
} else {
  console.log("SKIP: math/lean not present; skipping real-corpus Lean search (fixture tested below).");
}

// Always exercise fixture roots, including on local workspaces with the corpus.
// Force the non-rg path so this covers the precomputed-index coverage check.
const fixtureDisableRg = process.env.MATH_TOOLKIT_DISABLE_RG;
try {
  process.env.MATH_TOOLKIT_DISABLE_RG = "1";
  const fixtureLean = searchLean({ math: path.join(workspace, "test/fixtures/math"), workspace }, {
    query: "fixture_theorem_one", path: "lean",
  });
  assert(fixtureLean.includes("fixture_theorem_one"), fixtureLean);
  assert(fixtureLean.includes("theorem"), fixtureLean);
  assert(fixtureLean.includes("Sample.lean"), fixtureLean);
} finally {
  if (fixtureDisableRg === undefined) delete process.env.MATH_TOOLKIT_DISABLE_RG;
  else process.env.MATH_TOOLKIT_DISABLE_RG = fixtureDisableRg;
}

const pdfAvailable = fs.existsSync(path.join(workspace, "math", "overview.pdf"));
if (pdfAvailable) {
  const pdf = await call("math_pdf_text", { path: "overview.pdf", pages: "1", maxChars: 2000 });
  assert(pdf.includes("## Page 1"), pdf);
  assert(pdf.length > 100, pdf);
} else {
  console.log("SKIP: math/overview.pdf not present; skipping real-corpus PDF extraction (fixture tested below).");
}

const fixturePdf = await pdfText({ math: path.join(workspace, "test/fixtures"), workspace }, {
  path: "overview.pdf", pages: "1", maxChars: 2000,
});
assert.match(fixturePdf, /## Page 1\b/);
const fixturePageText = fixturePdf.split("## Page 1")[1].trim();
assert(fixturePageText.length > 0, "Expected non-empty fixture page text");
assert.doesNotMatch(fixturePageText, /No extractable text found|PDF extraction error/);

const python = findExecutable("python") || findExecutable("python3");
const sympyAvailable = Boolean(python) && spawnSync(python, ["-c", "import sympy"], { encoding: "utf8" }).status === 0;
if (sympyAvailable) {
  const simplify = await call("math_compute", { operation: "simplify", expression: "sin(x)^2 + cos(x)^2" });
  assert(simplify.includes("Result: 1"), simplify);
  const det = await call("math_compute", { operation: "det", matrix: [[1, 2], [3, 4]] });
  assert(det.includes("Result: -2"), det);
  const rejected = await call("math_compute", { operation: "simplify", expression: "__import__('os')" });
  assert(/SymPy error|forbidden|Unknown|allowlist/i.test(rejected), rejected);
} else {
  console.log("SKIP: Python/SymPy not present; skipping math_compute tests.");
}

assert.match(await call("math_manuscript", { path: "../README.md" }), /traversal/i);
assert.match(await call("math_grep", { query: "test", path: "../" }), /traversal/i);
assert.match(await call("math_lean_check", { file: "../README.lean" }), /traversal/i);
assert.match(await call("math_comparator", { challenge: "../escape" }), /traversal/i);
assert.throws(() => safePath(path.join(workspace, "math"), path.dirname(workspace)), /inside/i);

assert.match(await call("math_lean_check", {}), /exactly one/i);
assert.match(await call("math_lean_check", { code: "", file: "test.lean" }), /exactly one/i);
assert.match(await call("math_lean_build", { target: "--help" }), /invalid build target/i);

const status = await call("math_status");
assert(status.includes("Manuscripts: 721"), status);
assert(status.includes("Lean toolchain:"));
assert.equal(findExecutable("definitely-not-a-math-tool", { PATH: "" }), null);

const originalPath = process.env.PATH;
const originalDisableRg = process.env.MATH_TOOLKIT_DISABLE_RG;
const originalDisableExtras = process.env.MATH_TOOLKIT_DISABLE_EXTRAS;
try {
  process.env.PATH = "";
  process.env.MATH_TOOLKIT_DISABLE_RG = "1";
  process.env.MATH_TOOLKIT_DISABLE_EXTRAS = "1";
  if (corpusAvailable) {
    const fallback = await call("math_grep", grepArgs);
    assert(fallback.includes("Node fallback:"), fallback);
    assert(fallback.includes(`${manuscript.texFile}:`));
    assert(fallback.includes("Introduction"));
  }
  const absent = await call("math_status");
  assert(absent.includes("Manuscripts: 721"));
  assert(absent.includes("lake: not found on PATH"));
  assert.match(await call("math_lean_check", { code: "example : True := by trivial" }), /install elan\/Lean/i);
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalDisableRg === undefined) delete process.env.MATH_TOOLKIT_DISABLE_RG;
  else process.env.MATH_TOOLKIT_DISABLE_RG = originalDisableRg;
  if (originalDisableExtras === undefined) delete process.env.MATH_TOOLKIT_DISABLE_EXTRAS;
  else process.env.MATH_TOOLKIT_DISABLE_EXTRAS = originalDisableExtras;
}

if (corpusAvailable) {
  assert.equal(resolveRoots({ directory: path.join(workspace, "math") }).math, path.join(workspace, "math"));
}
assert((await call("math_search", { query: "Riemann hypothesis" })).includes("003"));
console.log("PASS: index counts, BM25/filters, schema, PDF/Lean fixtures, path safety, status and missing-tool behavior. Lean/LaTeX/Comparator/network are not required.");
