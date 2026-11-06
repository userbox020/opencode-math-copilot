import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { clip, fence } from "./lib/format.js";
import { findExecutable, REBUILD, resolveRoots } from "./lib/paths.js";
import { createSearch, formatSearch } from "./lib/search.js";
import { grepCorpus, manuscript } from "./lib/corpus.js";
import { comparator, leanBuild, leanCheck } from "./lib/lean.js";
import { searchLean } from "./lib/lean-search.js";
import { pdfText } from "./lib/pdf.js";
import { compute, sympyVersion } from "./lib/compute.js";

const indexFile = fileURLToPath(new URL("./data/math-index.json", import.meta.url));

const inputs = {
  math_search: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      family: { type: "string" },
      leanOnly: { type: "boolean" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  math_manuscript: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      section: { type: "string" },
      maxChars: { type: "integer", minimum: 1000, maximum: 50000 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  math_grep: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      path: { type: "string" },
      glob: { type: "string" },
      literal: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      context: { type: "integer", minimum: 0, maximum: 3 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  math_lean_check: {
    type: "object",
    properties: {
      code: { type: "string" },
      file: { type: "string" },
      imports: { type: "array", items: { type: "string" } },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
    },
    additionalProperties: false,
  },
  math_lean_build: {
    type: "object",
    properties: {
      target: { type: "string" },
      timeoutMs: { type: "integer", minimum: 10000, maximum: 1800000 },
    },
    additionalProperties: false,
  },
  math_lean_search: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      path: { type: "string" },
      kind: { type: "string", enum: ["theorem", "lemma", "def", "abbrev", "class", "structure", "inductive", "instance", "all"] },
      literal: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      context: { type: "integer", minimum: 0, maximum: 3 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  math_pdf_text: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      pages: { type: "string" },
      maxChars: { type: "integer", minimum: 1000, maximum: 50000 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  math_compute: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["simplify", "factor", "expand", "solve", "diff", "integrate", "limit", "series", "evalf", "det", "eigenvalues"],
      },
      expression: { type: "string" },
      matrix: { type: "array", items: { type: "array", items: { type: "number" } } },
      variable: { type: "string" },
      point: { anyOf: [{ type: "string" }, { type: "number" }] },
      order: { type: "integer", minimum: 1, maximum: 50 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
    },
    required: ["operation"],
    additionalProperties: false,
  },
  math_comparator: {
    type: "object",
    properties: {
      challenge: { type: "string", minLength: 1 },
      timeoutMs: { type: "integer", minimum: 10000, maximum: 1800000 },
    },
    required: ["challenge"],
    additionalProperties: false,
  },
  math_status: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  math_reindex: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

function loadIndex() {
  try {
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    return { index, search: createSearch(index), error: null };
  } catch (error) {
    return { index: null, search: null, error: `Math index unavailable: ${error.message}\n\n${REBUILD}` };
  }
}

function makeExecutors(roots) {
  const { index, search, error } = loadIndex();
  const run = (fn, requiresIndex = true) => async (values = {}) => {
    if (requiresIndex && error) return error;
    try {
      return clip(await fn(values), 75000);
    } catch (caught) {
      return clip(`Error: ${caught.message}`, 4000);
    }
  };

  return {
    math_search: run((args) => formatSearch(search(args))),
    math_manuscript: run((args) => manuscript(index, roots, args)),
    math_grep: run((args) => grepCorpus(roots, args)),
    math_lean_check: run((args) => leanCheck(roots, args)),
    math_lean_build: run((args) => leanBuild(index, roots, args)),
    math_lean_search: run((args) => searchLean(roots, args), false),
    math_pdf_text: run((args) => pdfText(roots, args), false),
    math_compute: run((args) => compute(roots, args), false),
    math_comparator: run((args) => comparator(roots, args)),
    math_status: run(() => {
      const stat = fs.statSync(indexFile);
      const availability = ["lake", "lean", "comparator", "landrun", "lean4export", "latexmk", "pdflatex", "python", "rg"]
        .map((name) => `- ${name}: ${findExecutable(name) || "not found on PATH"}`)
        .join("\n");
      const sympy = sympyVersion();
      return `# Math toolkit status\n- Math root: ${roots.math}\n- Index: ${indexFile}\n- Index size: ${stat.size} bytes\n- Index mtime: ${stat.mtime.toISOString()}\n- Generated: ${index.generatedAt}\n- Families: ${index.counts.families}\n- Manuscripts: ${index.counts.manuscripts}\n- Formalized: ${index.counts.formalized}\n- Sections: ${index.counts.sections}\n- Lean docs: ${index.counts.leanDocs}\n- Lean toolchain: ${index.lean.toolchain}\n- Libraries: ${index.lean.libraries.length}\n\n## PATH availability\n${availability}\n- sympy: ${sympy || "not installed"}\n\nIf the index is stale: ${REBUILD}`;
    }),
    math_reindex: run(() => {
      const node = findExecutable("node");
      if (!node) return `Node.js was not found on PATH. Install Node.js, then ${REBUILD}`;
      if (/\.(cmd|bat)$/i.test(node)) return `Put the native Node.js executable on PATH (batch shims are not supported with shell:false). ${REBUILD}`;
      const script = fileURLToPath(new URL("./scripts/build-index.mjs", import.meta.url));
      const result = spawnSync(node, [script, "--math-root", roots.math, "--out", indexFile], { cwd: roots.workspace, shell: false, encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      return `Reindex ${result.status === 0 && !result.error ? "PASS" : "FAIL"}; exit code: ${result.status ?? "none"}${result.error ? `\n${result.error.message}` : ""}\n${fence(clip([result.stdout, result.stderr].filter(Boolean).join("\n"), 12000))}\n\nReload/restart the plugin to pick up the new index.`;
    }, false),
  };
}

const descriptions = {
  math_search: "Find math manuscripts by topic using the prebuilt BM25 index. Supports family:003, lean:true and has:lean filters; use before opening a paper.",
  math_manuscript: "Read an indexed manuscript's citation, metadata and section outline, or a named section's TeX source. Use a PDF/directory path or a unique title substring.",
  math_grep: "Search local math text sources for a phrase or regex. Prefer a small preprint/Lean subtree; excludes dependencies, binaries and oversized files.",
  math_lean_check: "Compile a Lean snippet with imports or check one existing .lean file using lake env lean. Executes Lean code locally; requires an installed Lean toolchain and cached dependencies.",
  math_lean_build: "Build a focused Lean library/module, default OAI.Analysis. Whole-library builds are expensive and may generate Lake build artifacts.",
  math_lean_search: "Search declaration lines in math/lean and Mathlib by name or regex. Use to locate theorems, lemmas, definitions, classes, and instances before editing Lean.",
  math_pdf_text: "Extract bounded text from a manuscript PDF (no OCR). Use when TeX source is missing or you need the released PDF's exact wording.",
  math_compute: "Run a restricted SymPy operation (simplify, factor, expand, solve, diff, integrate, limit, series, evalf, det, eigenvalues). Expressions are allowlisted, not arbitrary Python.",
  math_comparator: "Validate an existing ComparatorChallenges JSON challenge. Requires comparator, landrun and lean4export on PATH plus the Lean toolchain.",
  math_status: "Inspect math index counts, root paths, Lean toolchain, and local executable availability without running Lean or a build.",
  math_reindex: "Regenerate the prebuilt math index after corpus updates. Reload/restart the plugin afterward to load the new index.",
};

export default Plugin.define({
  id: "math-toolkit",
  async setup(ctx) {
    const roots = resolveRoots({
      directory: ctx.location?.directory,
      worktree: ctx.location?.project?.directory,
    });
    const executors = makeExecutors(roots);
    await ctx.tool.transform((editor) => {
      for (const name of Object.keys(inputs)) {
        editor.add({
          name,
          description: descriptions[name],
          input: inputs[name],
          options: { codemode: true },
          async execute(args = {}) {
            return { content: await executors[name](args) };
          },
        });
      }
    });
  },
});
