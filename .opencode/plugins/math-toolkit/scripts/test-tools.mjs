import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import plugin from "../../math-toolkit.js";
import { createSearch } from "../lib/search.js";
import { pdfText } from "../lib/pdf.js";
import { pdfCorpusSearch, pdfSearch } from "../lib/pdf-search.js";
import { createPdfIndexReader, pdfIndexSearch, PDF_INDEX_BUILD } from "../lib/pdf-index.js";
import { searchLean } from "../lib/lean-search.js";
import { leanCheck, comparator } from "../lib/lean.js";
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
const originalReadFile = fs.readFileSync;
let manuscriptIndexReads = 0;
fs.readFileSync = function (filename, ...args) {
  if (String(filename).endsWith("math-index.json")) manuscriptIndexReads++;
  return originalReadFile.call(this, filename, ...args);
};
try {
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
assert.equal(manuscriptIndexReads, 0, "Plugin startup must not parse the manuscript index");
await tools.get("math_search").execute({ query: "Riemann" });
await tools.get("math_search").execute({ query: "Riemann" });
assert.equal(manuscriptIndexReads, 1, "First use loads the index once");
} finally { fs.readFileSync = originalReadFile; }
assert.equal(tools.size, 15);
console.log(`PASS: ${tools.size} registered tools.`);
assert.deepEqual(tools.get("math_doctor").input, { type: "object", properties: {}, additionalProperties: false });
const excerptSchema = tools.get("math_pdf_index_search").input;
assert.deepEqual(excerptSchema.required, ["query"]);
assert.equal(excerptSchema.properties.limit.default, 10);
assert.equal(excerptSchema.properties.limit.maximum, 20);
assert.equal(excerptSchema.properties.literal.default, true);
assert.equal(excerptSchema.additionalProperties, false);
assert.equal(excerptSchema.properties.path, undefined);
const corpusSchema = tools.get("math_pdf_corpus_search").input;
assert.deepEqual(corpusSchema.required, ["query"]);
assert.equal(corpusSchema.properties.candidates.maximum, 10);
assert.equal(corpusSchema.properties.candidates.default, 5);
assert.equal(corpusSchema.properties.pages.default, "1-2");
assert.equal(corpusSchema.properties.limit.maximum, 20);
assert.equal(corpusSchema.properties.limit.default, 10);
assert.equal(corpusSchema.properties.literal.default, true);

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
const fixtureSearch = await pdfSearch({ math: path.join(workspace, "test/fixtures"), workspace }, {
  path: "overview.pdf", query: "Research Catalog", pages: "1", limit: 3,
});
assert.match(fixtureSearch, /page 1, line \d+/i, fixtureSearch);
assert.match(await pdfSearch({ math: path.join(workspace, "test/fixtures"), workspace }, {
  path: "overview.pdf", query: "[", pages: "1", literal: false,
}), /Invalid regex/i);

const cacheFixture = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-pdf-cache-"));
const cacheEnv = Object.fromEntries(["MATH_TOOLKIT_PDF_CACHE", "MATH_TOOLKIT_DISABLE_PDF_CACHE"].map(name => [name, process.env[name]]));
try {
  const filename = path.join(cacheFixture, "sample.pdf");
  fs.copyFileSync(path.join(workspace, "test/fixtures/overview.pdf"), filename);
  process.env.MATH_TOOLKIT_PDF_CACHE = path.join(cacheFixture, "cache");
  delete process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE;
  const roots = { math: cacheFixture, workspace: cacheFixture };
  const args = { path: "sample.pdf", pages: "1", maxChars: 50000 };
  let reads = 0;
  fs.readFileSync = function (file, ...options) {
    if (file === filename) reads++;
    return originalReadFile.call(this, file, ...options);
  };
  const first = await pdfText(roots, args);
  assert.match(first, /## Page 1/);
  assert.doesNotMatch(first, /Output truncated/);
  assert.equal(reads, 1);
  assert.equal(await pdfText(roots, args), first);
  assert.equal(reads, 1, "Cache hit must avoid reading/re-extracting the PDF");
  const cacheFiles = () => fs.readdirSync(process.env.MATH_TOOLKIT_PDF_CACHE).filter(name => name.endsWith(".json"));
  assert.equal(cacheFiles().length, 1);
  const stat = fs.statSync(filename);
  fs.utimesSync(filename, stat.atime, new Date(stat.mtimeMs + 5000));
  assert.equal(await pdfText(roots, args), first);
  assert.equal(reads, 2, "Changed mtime must miss the cache");
  assert.equal(cacheFiles().length, 2);
  process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE = "1";
  assert.equal(await pdfText(roots, args), first);
  assert.equal(reads, 3, "Disable flag must bypass cache reads");
  assert.equal(cacheFiles().length, 2, "Disable flag must bypass writes");
  delete process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE;
  for (const file of cacheFiles()) fs.writeFileSync(path.join(process.env.MATH_TOOLKIT_PDF_CACHE, file), "invalid json");
  assert.equal(await pdfText(roots, args), first);
  assert.equal(reads, 4, "Corrupt cache must fall back to extraction");
  const truncated = await pdfText(roots, { ...args, pages: "1-2", maxChars: 1000 });
  assert.match(truncated, /Output truncated/);
  assert.equal(cacheFiles().length, 2, "Partial output must not be cached");
  fs.writeFileSync(path.join(cacheFixture, "broken.pdf"), "not a pdf");
  assert.match(await pdfText(roots, { ...args, path: "broken.pdf" }), /PDF extraction error/);
  assert.equal(cacheFiles().length, 2, "Errors must not be cached");
  process.env.MATH_TOOLKIT_PDF_CACHE = filename; // Not a directory: writes fail harmlessly.
  assert.equal(await pdfText(roots, args), first);
  console.log("PASS: PDF cache hits, disable flag, stale mtime, corrupt/inaccessible cache fallback, and no partial/error caching.");
} finally {
  fs.readFileSync = originalReadFile;
  for (const [name, value] of Object.entries(cacheEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(cacheFixture, { recursive: true, force: true });
}

const excerptFixture = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-pdf-index-"));
try {
  const filename = path.join(excerptFixture, "pdf-index.json.gz");
  const getIndex = createPdfIndexReader(filename);
  const missing = pdfIndexSearch({ query: "alpha" }, getIndex);
  assert.match(missing, /PDF excerpt index unavailable/);
  assert(missing.includes(PDF_INDEX_BUILD));
  const fixture = { version: 1, generatedAt: "2026-01-01T00:00:00.000Z", counts: { documents: 2, pages: 3, chars: 40 }, documents: [
    { path: "preprints/one.pdf", pages: [{ page: 1, text: "Alpha.*\nAlpha beta" }, { page: 2, text: "Other\nALPHA gamma" }] },
    { path: "two.pdf", pages: [{ page: 1, text: "Alpha delta" }] },
  ] };
  fs.writeFileSync(filename, gzipSync(JSON.stringify(fixture)));
  const literal = pdfIndexSearch({ query: "Alpha.*" }, getIndex);
  assert.match(literal, /Index version: 1; documents: 2; pages: 3; chars: 40/);
  assert.equal((literal.match(/- page /g) || []).length, 1);
  assert.match(literal, /## preprints\/one.pdf[\s\S]*page 1, line 1: Alpha\.\*/);
  const regex = pdfIndexSearch({ query: "alpha (beta|gamma|delta)", literal: false }, getIndex);
  assert.equal((regex.match(/- page /g) || []).length, 3);
  assert.match(regex, /page 2, line 2: ALPHA gamma/);
  assert.match(regex, /## two.pdf/);
  const limited = pdfIndexSearch({ query: "alpha", limit: 2 }, getIndex);
  assert.equal((limited.match(/- page /g) || []).length, 2);
  assert.match(limited, /Showing the first 2 matches/);
  assert.match(pdfIndexSearch({ query: "absent" }, getIndex), /No matches/);
  assert.match(pdfIndexSearch({ query: "[", literal: false }, getIndex), /Invalid regex/);
  for (const args of [{}, { query: " " }, { query: "a", limit: 21 }, { query: "a", limit: 0 }, { query: "a", literal: "true" }]) assert.match(pdfIndexSearch(args, getIndex), /Usage error/);
  fs.unlinkSync(filename);
  assert.equal(pdfIndexSearch({ query: "Alpha.*" }, getIndex), literal, "Reader must cache the parsed gzip index lazily");
  console.log("PASS: lazy PDF excerpt gzip reader, missing index command, literal/regex search, grouping and limits.");
} finally { fs.rmSync(excerptFixture, { recursive: true, force: true }); }

const corpusFixture = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-pdf-corpus-"));
try {
  fs.mkdirSync(path.join(corpusFixture, "released"));
  fs.mkdirSync(path.join(corpusFixture, "broken"));
  fs.copyFileSync(path.join(workspace, "test/fixtures/overview.pdf"), path.join(corpusFixture, "released", "title-derived.pdf"));
  fs.writeFileSync(path.join(corpusFixture, "broken", "paper.pdf"), "not a PDF");
  const fixtureRoots = { math: corpusFixture, workspace: corpusFixture };
  const documents = ["missing", "broken", "released"].map((dir, i) => ({
    id: String(i), dir, title: "Research Catalog", sections: [],
  }));
  const fixtureIndexSearch = createSearch({ manuscripts: documents });
  const corpusHits = await pdfCorpusSearch(fixtureRoots, fixtureIndexSearch, { query: "Research Catalog" });
  assert.match(corpusHits, /## released\b/);
  assert.match(corpusHits, /page 1, line \d+:.*Research Catalog/i);
  assert.match(corpusHits, /Skipped candidates[\s\S]*missing:[\s\S]*broken:/);
  assert.match(await pdfCorpusSearch(fixtureRoots, fixtureIndexSearch, { query: "zzznocandidatezzz" }), /No candidate manuscripts/);
  const noHits = await pdfCorpusSearch(fixtureRoots, fixtureIndexSearch, { query: "Research Catalog zzznomatchzzz" });
  assert.match(noHits, /No matches in the extracted candidate PDF text/);
  assert.match(noHits, /Skipped candidates/);
  const regexHits = await pdfCorpusSearch(fixtureRoots, fixtureIndexSearch, {
    query: "Research.*Catalog", literal: false, pages: "1", limit: 1,
  });
  assert.equal((regexHits.match(/- page \d+, line \d+:/g) || []).length, 1);
  assert.match(regexHits, /Showing the first 1 matches/);

  const invalidSearch = () => assert.fail("Invalid inputs must not search the index");
  for (const args of [
    {}, { query: " " }, { query: 12 },
    ...[0, 11, 1.5, "5", null].map(candidates => ({ query: "Research", candidates })),
    ...[0, 21, 1.5, "10"].map(limit => ({ query: "Research", limit })),
    { query: "Research", literal: "true" },
    ...["", "0", "2-1", "1-6", "1-999999999", "1,3,5,7,9,11", "9007199254740992", "x", 1, "1,".repeat(51)].map(pages => ({ query: "Research", pages })),
  ]) {
    assert.match(await pdfCorpusSearch(fixtureRoots, invalidSearch, args), /Usage error/);
  }
  assert.match(await pdfCorpusSearch(fixtureRoots, invalidSearch, { query: "[", literal: false }), /Invalid regex/);
  assert.match(await pdfCorpusSearch(fixtureRoots, fixtureIndexSearch, { query: "Research", pages: "1-5,1" }), /page 1, line/);

  // Even an over-returning search implementation cannot exceed the candidate cap.
  const cappedSearch = ({ query, limit }) => {
    assert.equal(query, "Research Catalog");
    assert.equal(limit, 10);
    return Array.from({ length: 11 }, (_, i) => ({ manuscript: { dir: `absent-${i}` } }));
  };
  const capped = await pdfCorpusSearch(fixtureRoots, cappedSearch, { query: "Research Catalog", candidates: 10 });
  assert.match(capped, /Inspected 10 of 10/);
  assert.equal((capped.match(/- absent-\d+:/g) || []).length, 10);
  assert.doesNotMatch(capped, /absent-10/);
  let defaultCandidates;
  await pdfCorpusSearch(fixtureRoots, args => { defaultCandidates = args.limit; return []; }, { query: "Research" });
  assert.equal(defaultCandidates, 5);
  assert.match(await call("math_pdf_corpus_search", { query: "zzznocandidatezzz" }), /No candidate manuscripts/);
  assert.match(await call("math_pdf_corpus_search", { query: "Research", candidates: 11 }), /Usage error/);
  console.log("PASS: bounded PDF corpus search fixtures, schema/defaults, invalid inputs, candidate/page caps, global hit limit and missing/unreadable PDF skips.");
} finally {
  fs.rmSync(corpusFixture, { recursive: true, force: true });
}

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

for (const name of ["math_lean_check", "math_lean_build", "math_comparator"]) {
  assert.equal(tools.get(name).input.properties.docker.type, "boolean");
  assert.equal(tools.get(name).input.properties.docker.default, false);
}
assert.match(await call("math_lean_check", { docker: true }), /exactly one/i);
assert.match(await call("math_lean_check", { docker: true, code: "", file: "test.lean" }), /exactly one/i);
assert.match(await call("math_lean_check", { docker: true, code: "", imports: ["Mathlib; exit"] }), /imports must be Lean module names/i);
assert.match(await call("math_lean_check", { docker: true, file: "../escape.lean" }), /traversal/i);
assert.match(await call("math_lean_build", { docker: true, target: "OAI.Analysis; echo unsafe" }), /invalid build target/i);
assert.match(await call("math_comparator", { docker: true, challenge: "../escape" }), /traversal/i);

const docker = findExecutable("docker");
const dockerProbe = args => spawnSync(docker, args, { shell: false, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
const leanImage = process.env.MATH_TOOLKIT_LEAN_IMAGE || "opencode-math-lean";
const leanVolume = process.env.MATH_TOOLKIT_LEAN_VOLUME || "opencode-math-lean";
if (!docker || /\.(cmd|bat)$/i.test(docker) || dockerProbe(["image", "inspect", "--", leanImage]).status !== 0) {
  console.log(`SKIP: Docker unavailable or image ${leanImage} absent; skipping Docker Lean integration tests.`);
} else if (dockerProbe(["volume", "inspect", "--", leanVolume]).status !== 0) {
  console.log(`SKIP: Docker Lean volume ${leanVolume} absent; skipping Docker Lean integration tests.`);
} else {
  const check = await call("math_lean_check", { docker: true, code: "example : 1 = 1 := rfl", imports: ["Mathlib.Data.Nat.Basic"], timeoutMs: 120000 });
  assert.match(check, /\[docker\] \*\*PASS\*\*/, check);
  console.log("PASS: Docker Lean snippet with Mathlib cache and read-only host temp mount.");
  const build = await call("math_lean_build", { docker: true, target: "OAI.Analysis.AffineBernstein.ABPCriticalDensity" });
  assert.match(build, /\[docker\] \*\*PASS\*\*/, build);
  console.log("PASS: Docker focused build OAI.Analysis.AffineBernstein.ABPCriticalDensity.");

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-docker-test-"));
  const fixtureRoots = { math: fixture, workspace: fixture };
  const savedEnv = Object.fromEntries(["MATH_TOOLKIT_LEAN_IMAGE", "MATH_TOOLKIT_COMPARATOR_IMAGE", "MATH_TOOLKIT_LEAN_VOLUME"].map(name => [name, process.env[name]]));
  try {
    fs.mkdirSync(path.join(fixture, "lean", "ComparatorChallenges"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "lean", "Sample.lean"), "example : 1 = 1 := rfl\n");
    fs.writeFileSync(path.join(fixture, "lean", "ComparatorChallenges", "Sample.json"), "{}");
    const fileCheck = leanCheck(fixtureRoots, { docker: true, file: "lean/Sample.lean", timeoutMs: 120000 });
    assert.match(fileCheck, /\[docker\] \*\*PASS\*\*/, fileCheck);
    process.env.MATH_TOOLKIT_LEAN_IMAGE = "math-toolkit-missing-image-test:nonexistent";
    const missing = await call("math_lean_check", { docker: true, code: "example : True := by trivial" });
    assert.match(missing, /Docker image math-toolkit-missing-image-test:nonexistent is not available/);
    assert.match(missing, /docker build -f docker\/lean\.Dockerfile -t math-toolkit-missing-image-test:nonexistent \./);
    process.env.MATH_TOOLKIT_COMPARATOR_IMAGE = "math-toolkit-missing-comparator-test:nonexistent";
    const missingComparator = comparator(fixtureRoots, { docker: true, challenge: "Sample" });
    assert.match(missingComparator, /docker build -f docker\/comparator\.Dockerfile/);
    assert.match(missingComparator, /may not match the corpus Lean 4\.34\.1 pin/);
    process.env.MATH_TOOLKIT_LEAN_IMAGE = leanImage;
    process.env.MATH_TOOLKIT_LEAN_VOLUME = "math-toolkit-missing-volume-test";
    const missingVolume = await call("math_lean_build", { docker: true, target: "OAI.Analysis" });
    assert.match(missingVolume, /Docker volume math-toolkit-missing-volume-test is not available/);
    assert.match(missingVolume, /verify-lean\.sh/);
    console.log("PASS: Docker host-file check and actionable missing Lean/Comparator image and volume errors.");
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

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
  const health = await call("math_doctor");
  assert.match(health, /# Math toolkit doctor/);
  assert.match(health, /Corpus clone path:/);
  assert.match(health, /Manuscript counts:.*"manuscripts":721/);
  assert.match(health, /Lean declaration index:.*bytes/);
  assert.match(health, /PDF cache:/);
  assert.match(health, /PDF excerpt index:/);
  assert.match(health, /Docker executable: missing/);
  assert.match(health, /Comparator tools volume/);
  assert.match(health, /lake: not found/);
  assert.match(health, /Disk space/);
  assert(health.length <= 16000);
  assert.match(await call("math_lean_check", { code: "example : True := by trivial" }), /install elan\/Lean/i);
  assert.match(await call("math_lean_check", { docker: true, code: "example : True := by trivial" }), /docker was not found on PATH.*Install Docker/i);
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
