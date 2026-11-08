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
import { leanCheck, comparator, runDocker } from "../lib/lean.js";
import { DEFAULT_AXIOMS, leanVerify } from "../lib/verify.js";
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
assert.equal(tools.size, 16);
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
const verifySchema = tools.get("math_lean_verify").input;
assert.deepEqual(verifySchema.required, ["theorem", "expectedType"]);
assert.equal(verifySchema.oneOf, undefined);
assert.match(verifySchema.description, /exactly one of code or file/i);
assert.deepEqual(verifySchema.properties.imports.default, ["Mathlib"]);
assert.deepEqual(verifySchema.properties.allowedAxioms.default, DEFAULT_AXIOMS);
assert.equal(verifySchema.additionalProperties, false);

const call = async (name, args = {}) => {
  const result = await tools.get(name).execute(args, {});
  return typeof result === "string" ? result : result.content;
};

// Pure runner fixtures: no Docker, Lean, network, or long waits.
const verificationFixture = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-verify-test-"));
try {
  const roots = { math: verificationFixture, workspace: verificationFixture };
  fs.mkdirSync(path.join(verificationFixture, "lean", "ComparatorChallenges"), { recursive: true });
  fs.writeFileSync(path.join(verificationFixture, "lean", "ComparatorChallenges", "Sample.json"), "{}");
  fs.writeFileSync(path.join(verificationFixture, "lean", "Solution.lean"), "theorem Demo.answer : True := True.intro\n");
  for (const docker of [false, true]) {
    for (const explicit of [undefined, 42000]) {
      let calls = 0;
      const expected = explicit ?? (docker ? 1800000 : 600000);
      const check = limit => { calls++; assert.equal(limit, expected); return "**FAIL** — timeout"; };
      const runners = {
        runDocker(args, limit, options) {
          assert.equal(docker, true);
          assert.deepEqual(args, ["verify-comparator.sh"]);
          assert.equal(options.challenge, "ComparatorChallenges/Sample.json");
          return check(limit);
        },
        runLake(actualRoots, args, limit) {
          assert.equal(docker, false);
          assert.equal(actualRoots, roots);
          assert.equal(args[1], "comparator");
          return check(limit);
        },
      };
      const result = comparator(roots, { challenge: "Sample", docker, timeoutMs: explicit }, runners);
      assert.equal(calls, 1);
      assert.match(result, /FAIL.*timeout/);
      assert.doesNotMatch(result, /PASS/);
    }
  }
  const dockerCalls = [];
  const dockerStub = {
    findExecutable: () => "docker",
    spawnSync(executable, args, options) {
      assert.equal(executable, "docker");
      assert.equal(options.shell, false);
      dockerCalls.push(args);
      if (args[0] !== "run") return { status: 0, stdout: "", stderr: "" };
      assert.equal(options.timeout, 42000);
      return { status: 0, error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) };
    },
  };
  const timedDocker = runDocker(["lake", "--version"], 42000, {}, dockerStub);
  assert.match(timedDocker, /\*\*FAIL\*\*/);
  assert.doesNotMatch(timedDocker, /\*\*PASS\*\*/);
  runDocker(["lake", "--version"], 42000, {}, dockerStub);
  const runs = dockerCalls.filter(args => args[0] === "run");
  const removals = dockerCalls.filter(args => args[0] === "rm");
  assert.equal(runs.length, 2);
  assert.equal(removals.length, 2);
  const containers = runs.map(args => args[args.indexOf("--name") + 1]);
  assert.notEqual(containers[0], containers[1]);
  removals.forEach((args, i) => assert.deepEqual(args, ["rm", "--force", containers[i]]));
  console.log("PASS: CORE-01 native/Docker default and explicit timeouts; timeout is FAIL; cleanup removes only each invocation's unique container (all stubbed).");

  const input = { code: "theorem Demo.answer : True := True.intro", theorem: "Demo.answer", expectedType: "True" };
  const checkedNames = new Set();
  const fixtureRunner = ({ report = "'$CHECKED' depends on axioms: [propext, Quot.sound, Classical.choice]", status = 0, error, diagnostic, stderr = false, markers = true, notRun = false } = {}) => (actualRoots, source, options) => {
    assert.equal(actualRoots, roots);
    assert.equal(options.timeoutMs, 60000);
    assert.match(source, /^import Mathlib\n/);
    const marker = source.match(/#eval IO.println "(math_verify_\w+)_begin"/)[1];
    const checkedName = `${marker}_checked`;
    assert(!checkedNames.has(checkedName), "Each invocation must generate a unique checked declaration");
    checkedNames.add(checkedName);
    assert(source.includes(`theorem _root_.${checkedName} : (True) := _root_.Demo.answer\n#print axioms _root_.${checkedName}`));
    assert.doesNotMatch(source, /#print axioms _root_\.Demo\.answer/);
    const line = source.split("\n").findIndex(line => line.startsWith(`theorem _root_.${checkedName}`)) + 1;
    const text = [markers ? `${marker}_begin` : "", diagnostic?.(line), report.replaceAll("$CHECKED", checkedName), markers ? `${marker}_end` : ""].filter(Boolean).join("\n");
    return { status, error, notRun, stdout: stderr ? "" : text, stderr: stderr ? text : "" };
  };
  const verify = (options, args = input) => JSON.parse(leanVerify(roots, args, fixtureRunner(options)));
  const valid = verify();
  assert.equal(valid.version, "math-lean-verify/v1");
  assert.equal(valid.execution.status, "completed");
  assert.equal(valid.execution.mode, "native");
  assert.equal(valid.execution.exitCode, 0);
  assert(valid.execution.durationMs >= 0);
  assert.equal(valid.compilation.status, "compiled");
  assert.equal(valid.target.status, "identified");
  assert.equal(valid.proof.status, "verified");
  assert.deepEqual(valid.proof.axioms, DEFAULT_AXIOMS);
  assert.deepEqual(valid.proof.unauthorizedAxioms, []);
  assert.equal(valid.checker.tool, "lake env lean");
  assert.match(valid.note, /Informal correspondence is not assessed/);
  assert.equal(verify({ stderr: true }).proof.status, "verified");
  assert.equal(verify({ report: "'$CHECKED' does not depend on any axioms" }).proof.status, "verified");
  assert.equal(verify({ report: "'$CHECKED' depends on axioms:\n[propext,\n Quot.sound, Classical.choice]" }).proof.status, "verified");
  const missing = verify({ status: 1, report: "", diagnostic: line => `Check.lean:${line}:26: error: Unknown identifier \u0060Demo.answer\u0060` });
  assert.equal(missing.target.status, "missing");
  assert.equal(missing.compilation.status, "failed");
  assert.equal(missing.proof.status, "unverified");
  const mismatch = verify({ status: 1, diagnostic: line => `Check.lean:${line}:26: error: Type mismatch\n  Demo.answer\nhas type\n  False\nbut is expected to have type\n  True` });
  assert.equal(mismatch.target.status, "mismatch");
  assert.equal(mismatch.proof.status, "unverified");
  const unauthorized = verify({ report: "'$CHECKED' depends on axioms: [Secret.assumption]" });
  assert.equal(unauthorized.proof.status, "rejected");
  assert.deepEqual(unauthorized.proof.unauthorizedAxioms, ["Secret.assumption"]);
  assert.equal(verify({ report: "'$CHECKED' depends on axioms: [Secret.assumption]" }, { ...input, allowedAxioms: ["Secret.assumption"] }).proof.status, "verified");
  const sorry = verify({ report: "'$CHECKED' depends on axioms: [sorryAx]" }, { ...input, allowedAxioms: ["sorryAx"] });
  assert.equal(sorry.proof.status, "incomplete");
  assert.equal(sorry.proof.sorryAx, true);
  const timeout = verify({ error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) });
  assert.equal(timeout.execution.status, "timeout");
  assert.equal(timeout.compilation.status, "failed");
  assert.notEqual(timeout.proof.status, "verified");
  const absent = verify({ error: Object.assign(new Error("lake missing"), { code: "ENOENT" }) });
  assert.equal(absent.execution.status, "missing-tool");
  assert.equal(absent.compilation.status, "not-run");
  assert.notEqual(absent.proof.status, "verified");
  for (const options of [{ report: "" }, { markers: false }, { report: "'Other.theorem' depends on axioms: []" }, { report: "'Demo.answer' depends on axioms: []" }, { report: "'$CHECKED' depends on axioms: [not a name]" }, { report: "'$CHECKED' depends on axioms: []\n'$CHECKED' depends on axioms: []" }, { status: 1 }, { error: new Error("buffer exceeded") }]) {
    assert.notEqual(verify(options).proof.status, "verified");
  }
  const validReport = "'$CHECKED' depends on axioms: []";
  for (const extra of ["'$CHECKED' depends on axioms: [not a name]", "'$CHECKED' depends on axioms: [", "'$CHECKED' unfamiliar report format"]) {
    for (const reports of [[validReport, extra], [extra, validReport]]) {
      assert.equal(verify({ report: reports.join("\n") }).proof.status, "unverified", "Every extra candidate must fail closed, regardless of order or format");
    }
  }
  const notRun = verify({ notRun: true });
  assert.equal(notRun.execution.exitCode, 0);
  assert.equal(notRun.compilation.status, "not-run");
  assert.equal(notRun.proof.status, "unverified");
  const fileReceipt = verify({}, { ...input, code: undefined, file: "lean/Solution.lean", docker: true });
  assert.equal(fileReceipt.proof.status, "verified");
  assert.equal(fileReceipt.execution.mode, "docker");
  for (const args of [null, [], "invalid", {}, { ...input, file: "Solution.lean" }, { ...input, theorem: "Demo.answer\n#eval 1" }, { ...input, expectedType: "" }, { ...input, imports: ["Mathlib; exit"] }, { ...input, timeoutMs: 0 }, { ...input, code: undefined, file: "../escape.lean" }]) {
    const invalid = JSON.parse(leanVerify(roots, args, () => assert.fail("Invalid input must not invoke Lean")));
    assert.equal(invalid.execution.status, "error");
    assert.equal(invalid.compilation.status, "not-run");
    assert.equal(invalid.target.status, "not-requested");
    assert.equal(invalid.proof.status, "not-requested");
  }
  const registeredInvalid = JSON.parse(await call("math_lean_verify", {}));
  assert.equal(registeredInvalid.compilation.status, "not-run");
  const registeredNull = JSON.parse(await call("math_lean_verify", null));
  assert.equal(registeredNull.execution.status, "error");
  assert.equal(registeredNull.proof.status, "not-requested");
  console.log("PASS: VERIFY-01 JSON receipt/schema, valid/axiom-free/multiline/stderr/file targets, missing/mismatched targets, unauthorized axioms, sorryAx, timeouts/missing tools, malformed/absent output and invalid inputs (all stubbed).");
  console.log("PASS: Generated-declaration audit only; valid+malformed/unrecognized reports in both orders fail closed; null/invalid requests and contradictory notRun runner cannot verify (all stubbed).");
} finally { fs.rmSync(verificationFixture, { recursive: true, force: true }); }

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

for (const name of ["math_lean_check", "math_lean_verify", "math_lean_build", "math_comparator"]) {
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
  const verified = JSON.parse(await call("math_lean_verify", { docker: true, code: "theorem verify_smoke : True := True.intro", theorem: "verify_smoke", expectedType: "True", imports: ["Mathlib.Data.Nat.Basic"], timeoutMs: 120000 }));
  assert.equal(verified.proof.status, "verified", JSON.stringify(verified));
  const incomplete = JSON.parse(await call("math_lean_verify", { docker: true, code: "theorem verify_smoke : False := by sorry", theorem: "verify_smoke", expectedType: "False", imports: ["Mathlib.Data.Nat.Basic"], timeoutMs: 120000 }));
  assert.equal(incomplete.proof.status, "incomplete", JSON.stringify(incomplete));
  console.log("PASS: Docker strict-verifier smoke and sorryAx rejection with the already-available Lean image/volume.");
  const instanceSource = `class VerifyPremise : Prop where
  out : False
axiom unauthorizedInstance : VerifyPremise
attribute [instance] unauthorizedInstance
theorem Demo.answer [h : VerifyPremise] : False := h.out
#print axioms Demo.answer`;
  const instanceArgs = { docker: true, theorem: "Demo.answer", expectedType: "False", allowedAxioms: [], imports: ["Mathlib.Data.Nat.Basic"], timeoutMs: 120000 };
  const unauthorizedInstance = JSON.parse(await call("math_lean_verify", { ...instanceArgs, code: instanceSource }));
  assert.equal(unauthorizedInstance.compilation.status, "compiled", JSON.stringify(unauthorizedInstance));
  assert.equal(unauthorizedInstance.proof.status, "rejected", JSON.stringify(unauthorizedInstance));
  assert(unauthorizedInstance.proof.unauthorizedAxioms.includes("unauthorizedInstance"), JSON.stringify(unauthorizedInstance));
  const sorryInstance = JSON.parse(await call("math_lean_verify", { ...instanceArgs, code: instanceSource.replace("axiom unauthorizedInstance : VerifyPremise", "theorem unauthorizedInstance : VerifyPremise := by sorry") }));
  assert.equal(sorryInstance.compilation.status, "compiled", JSON.stringify(sorryInstance));
  assert.equal(sorryInstance.proof.status, "incomplete", JSON.stringify(sorryInstance));
  assert(sorryInstance.proof.axioms.includes("sorryAx"), JSON.stringify(sorryInstance));
  console.log("PASS: Real Docker Lean elaboration-only dependencies: synthesized unauthorized instance is rejected; synthesized sorry instance is incomplete and reports sorryAx.");
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
    assert.match(missingComparator, /Comparator v4\.34\.0 is rebuilt with the corpus Lean 4\.34\.1 toolchain/);
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
  for (const docker of [false, true]) {
    const missing = JSON.parse(await call("math_lean_verify", { docker, code: "theorem proof : True := True.intro", theorem: "proof", expectedType: "True" }));
    assert.equal(missing.execution.status, "missing-tool");
    assert.equal(missing.compilation.status, "not-run");
    assert.equal(missing.proof.status, "unverified");
  }
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

// PERF-01: real child-process regex isolation, with a short deadline for CI.
const { runRegexLines } = await import("../lib/regex-search.js");
const pathologicalPattern = "^(a+)+$";
const pathologicalLine = "a".repeat(30000) + "!";
assert.deepEqual(runRegexLines(["ALPHA beta", "other"], "^alpha", { timeoutMs: 1000 }), {
  status: "ok", matches: [true, false],
});
const timeoutStart = performance.now();
const regexTimeout = runRegexLines(["aaaa", pathologicalLine], pathologicalPattern, { timeoutMs: 100 });
const timeoutDuration = performance.now() - timeoutStart;
assert.equal(regexTimeout.status, "timeout");
assert.equal(regexTimeout.matches, undefined, "Timeout must discard even earlier successful matches");
assert.match(regexTimeout.message, /^Regex search timed out after 100 ms; use literal:true or simplify the pattern\.$/);
assert(timeoutDuration < 3000, `Regex worker took ${timeoutDuration.toFixed(1)} ms to terminate`);
const regexError = runRegexLines(["a"], "[", { timeoutMs: 1000 });
assert.equal(regexError.status, "error");
assert.equal(regexError.matches, undefined);
assert.match(regexError.message, /use literal:true or simplify the pattern/);
console.log(`PASS: PERF-01 catastrophic regex child terminated in ${timeoutDuration.toFixed(1)} ms (100 ms deadline), without partial matches.`);

const regexFixture = fs.mkdtempSync(path.join(os.tmpdir(), "math-toolkit-regex-"));
const regexEnv = Object.fromEntries(["MATH_TOOLKIT_REGEX_TIMEOUT_MS", "MATH_TOOLKIT_PDF_CACHE", "MATH_TOOLKIT_DISABLE_PDF_CACHE"].map(name => [name, process.env[name]]));
try {
  process.env.MATH_TOOLKIT_REGEX_TIMEOUT_MS = "1000";
  process.env.MATH_TOOLKIT_PDF_CACHE = path.join(regexFixture, "cache");
  delete process.env.MATH_TOOLKIT_DISABLE_PDF_CACHE;
  fs.copyFileSync(path.join(workspace, "test/fixtures/overview.pdf"), path.join(regexFixture, "sample.pdf"));
  const roots = { math: regexFixture, workspace: regexFixture };
  const candidates = () => [{ manuscript: { pdf: "sample.pdf" } }, { manuscript: { pdf: "sample.pdf" } }];
  // Seed valid cache keys, then supply controlled extracted lines through the cache.
  for (const maxChars of [5000, 50000]) {
    assert.match(await pdfText(roots, { path: "sample.pdf", pages: "1", maxChars }), /## Page 1/);
  }
  const cacheFiles = fs.readdirSync(process.env.MATH_TOOLKIT_PDF_CACHE);
  assert.equal(cacheFiles.length, 2);
  for (const file of cacheFiles) {
    const filename = path.join(process.env.MATH_TOOLKIT_PDF_CACHE, file);
    const cached = JSON.parse(fs.readFileSync(filename, "utf8"));
    // Corpus extraction is capped at 5000 chars; 2000 a's already trigger ReDoS.
    const longLine = JSON.parse(cached.key).maxChars === 5000 ? "a".repeat(2000) + "!" : pathologicalLine;
    cached.text = `# PDF text: sample.pdf\n\n## Page 7\naaaa\n${longLine}\nALPHA beta\n${pathologicalPattern}\n`;
    fs.writeFileSync(filename, JSON.stringify(cached));
  }
  const fixtureIndex = () => ({ version: 1, generatedAt: "fixture", counts: { documents: 1, pages: 1, chars: 30050 }, documents: [
    { path: "sample.pdf", pages: [{ page: 7, text: `aaaa\n${pathologicalLine}\nALPHA beta\n${pathologicalPattern}` }] },
  ] });
  const searches = [
    args => pdfSearch(roots, { path: "sample.pdf", pages: "1", ...args }),
    args => pdfCorpusSearch(roots, candidates, { pages: "1", ...args }),
    args => pdfIndexSearch(args, fixtureIndex),
  ];
  for (const search of searches) {
    assert.match(await search({ query: "^alpha (beta|gamma)$", literal: false }), /page 7, line 3: ALPHA beta/);
    assert.match(await search({ query: "[", literal: false }), /^Invalid regex:/);
    assert.match(await search({ query: pathologicalPattern }), /page 7, line 4: \^\(a\+\)\+\$/);
    assert.match(await search({ query: "aaaa" }), /page 7, line 2: a+/);
    process.env.MATH_TOOLKIT_REGEX_TIMEOUT_MS = "100";
    const start = performance.now();
    const timed = await search({ query: pathologicalPattern, literal: false, limit: 1 });
    const duration = performance.now() - start;
    assert.equal(timed, "Regex search timed out after 100 ms; use literal:true or simplify the pattern.");
    assert.doesNotMatch(timed, /- page |Showing the first|# PDF/);
    assert(duration < 3000, `PDF regex search took ${duration.toFixed(1)} ms`);
    process.env.MATH_TOOLKIT_REGEX_TIMEOUT_MS = "1000";
    console.log(`PASS: PERF-01 PDF search timeout in ${duration.toFixed(1)} ms; normal regex, literal long text, invalid regex and no partial matches.`);
  }
} finally {
  for (const [name, value] of Object.entries(regexEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(regexFixture, { recursive: true, force: true });
}
