import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import plugin from "../../math-toolkit.js";
import { createSearch } from "../lib/search.js";
import { pdfText } from "../lib/pdf.js";
import { pdfSearch } from "../lib/pdf-search.js";
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
assert.equal(tools.size, 12);

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
