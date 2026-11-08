# Math toolkit

A project-local OpenCode math copilot using the bundled `math/` clone of `openai/math`. It provides corpus lookup and wrappers for external formal-verification tools; it does not perform model inference itself.

## Prerequisites

- Node.js 24.
- OpenCode 2.0.29+ with the V2 plugin API. The entry point uses `Plugin.define` from `@opencode/plugin`; V1 plugin implementations do not run in OpenCode 2.x.
- `@opencode/plugin@2.0.29` available from the repo's `npm install` (OpenCode also provides it at runtime).
- A clone of `openai/math` at `math/` for manuscript reads, grep, PDF extraction, Lean search, and the Lean tools. The prebuilt index makes `math_search` usable without it.
- `npm install` installs `unpdf` for PDF extraction.
- Recommended: `ripgrep` (`rg`) for fast Lean declaration search. Without it, the prebuilt `data/lean-index.json.gz` is used, then a bounded Node fallback.
- Optional: elan with the pinned Lean/Lake toolchain; Docker for reproducible Linux Lean verification; Comparator, landrun, and lean4export in Linux/Docker for challenge checks; LaTeX for document builds; Python 3 + SymPy for computations.

Lean, Lake, Comparator, and LaTeX are optional. Missing prerequisites must be reported, not treated as successful verification. Run `math_status` for current availability. Native Windows Lean builds can be blocked by an NTFS-invalid path in the pinned dependency set; Docker is the recommended path (`docker/README.md`).

## Install / verify

After the prerequisites are installed, run from the repo root:

```powershell
npm install
npm run index
opencode.cmd plugin list
```

Confirm the project-local plugin appears in the list, then use `math_status` in an OpenCode session. This is not a global plugin installation.

## Tools

| Tool | Purpose |
| --- | --- |
| `math_search` | BM25 search across manuscripts, returning abstracts, PDF paths, and Lean formalization status. |
| `math_manuscript` | Read metadata, abstract, file outline, section headings, or a specific LaTeX section. |
| `math_grep` | Search TeX, Markdown, and Lean text under `math/`. |
| `math_lean_check` | Type-check a Lean 4 snippet or file with `lake env lean`. |
| `math_lean_verify` | Check a named user solution against a trusted target type and axiom allowlist; return a JSON receipt. |
| `math_lean_build` | Build a focused Lake target such as `OAI.Analysis`. |
| `math_lean_search` | Search declaration lines in `math/lean` and Mathlib by name or regex. |
| `math_pdf_text` | Extract bounded text from a manuscript PDF (no OCR). |
| `math_pdf_search` | Search the extracted text of one manuscript PDF/preprint (bounded pages; no OCR). |
| `math_pdf_corpus_search` | Search PDF lines across top BM25 manuscript candidates (default 5, maximum 10), grouped by path/page/line. |
| `math_pdf_index_search` | Search prebuilt PDF excerpts by literal text or regex, grouped by path/page/line (not full text; no OCR). |
| `math_compute` | Restricted SymPy operations over allowlisted expressions/matrices. |
| `math_comparator` | Run an existing Comparator challenge JSON. |
| `math_status` | Report index counts and toolchain availability. |
| `math_doctor` | Bounded corpus/index/cache, Docker image/volume, host-tool and disk-space health with setup hints; no builds. |
| `math_reindex` | Rebuild the manuscript index after `math/` changes. |

Use `/math <problem>` to invoke the project command, which loads the `math-workflow` skill. Lean tools are used when formal verification or a Lean statement is requested.

There are 16 tools. The manuscript index is parsed lazily on first use, not during plugin startup.

### Strict proof verification

`math_lean_check` is still compilation-only: a PASS can contain a `sorry` placeholder. `math_lean_verify` instead accepts exactly one of `code`/`file`, a fully qualified `theorem`, and a trusted `expectedType`. Optional `imports` defaults to `["Mathlib"]`; `allowedAxioms` defaults to `["propext", "Quot.sound", "Classical.choice"]`; `docker` defaults to false and `timeoutMs` to 60000 (1000–120000). An explicit empty imports/axioms list is respected.

```json
{ "code": "theorem answer : True := True.intro", "theorem": "answer", "expectedType": "True" }
```

The JSON string receipt is versioned `math-lean-verify/v1`. Verification requires successful compilation, a matching target type, a recognized axiom report and no unauthorized axiom or `sorryAx`. Execution/compilation/target/proof statuses are separate; missing tools and timeouts never verify. Informal correspondence is not assessed. `ComparatorChallenges/*.lean` can intentionally contain `sorry` statements: use `math_comparator` to validate their solutions, not this placeholder as a user proof. See [the contract](../../../docs/verification-contract.md) for receipt fields, trust assumptions and parsing limits.

## PDF cache and excerpt index

Complete PDF extractions are cached under `~/.cache/opencode-math-copilot/pdf`. Set `MATH_TOOLKIT_PDF_CACHE` to override the directory, or `MATH_TOOLKIT_DISABLE_PDF_CACHE=1` to bypass reads and writes. Keys include absolute PDF path, size, modification time, requested pages, character limit and extraction-format version. Invalid/unavailable cache files fall back to extraction; errors and truncated/capped output are never cached. Before writing, oldest entries are pruned to keep at most 500 JSON files / 200 MB.

Build the optional gzip excerpt index from the repo root (requires the corpus and the existing `unpdf` dependency):

```powershell
node .opencode/plugins/math-toolkit/scripts/build-pdf-index.mjs
# Quick sample, separate output, machine-readable report:
node .opencode/plugins/math-toolkit/scripts/build-pdf-index.mjs --pages 1-2 --limit 2 --out pdf-sample.json.gz --json
```

The default output is `data/pdf-index.json.gz` under the plugin directory. The builder prefers released preprint PDFs, then includes other PDFs outside `.lake/`, `node_modules/` and `.git/`, skipping duplicates and unreadable files. `--pages` defaults to `1-2` and accepts at most 5 distinct positive pages; extraction is bounded to 20000 characters per document. `--limit` caps attempted PDFs; `--math-root` can select a fixture/corpus directory. Progress and skipped-file counts are reported. Reload the plugin after rebuilding an already-loaded excerpt index.

Use `math_pdf_index_search` with `{ "query": "Riemann hypothesis", "limit": 10 }` (`literal: false` enables regex). It searches only prebuilt first-N/selected-page excerpts, **not a full-text corpus**, and performs no OCR. Missing matches do not establish absence from the corpus; use `math_pdf_search` for deeper page lookup. Use `math_doctor` with `{}` to inspect index presence/count/age and cache health without running Lean or building Docker images.

## Docker Lean execution

`math_lean_check`, `math_lean_verify`, `math_lean_build`, and `math_comparator` accept `docker: true` to run inside Linux Docker rather than the host toolchain. The default is `false` (native behavior is unchanged). Start Docker Desktop with Linux containers on Windows, or Docker Engine on Linux. Build the images and initialize the persistent Lean volume using `docker/README.md`; the volume must contain `/work/math`, its pinned toolchain dependencies, and the Mathlib cache.

Example tool arguments:

```json
{ "docker": true, "code": "example : 1 = 1 := rfl" }
{ "docker": true, "target": "OAI.Analysis.AffineBernstein.ABPCriticalDensity" }
{ "docker": true, "challenge": "ComparatorChallenges/QuasiRiemannHypothesis.json" }
```

Configure the OpenCode process environment to override these defaults:

| Environment variable | Default |
| --- | --- |
| `MATH_TOOLKIT_LEAN_IMAGE` | `opencode-math-lean` |
| `MATH_TOOLKIT_LEAN_VOLUME` | `opencode-math-lean` |
| `MATH_TOOLKIT_COMPARATOR_IMAGE` | `opencode-math-comparator` |
| `MATH_TOOLKIT_COMPARATOR_VOLUME` | `opencode-comparator-tools` |

Snippet checks add `imports` (default `Mathlib`) and mount a unique host temp directory read-only at `/check`; it is removed afterward. With `file`, the tool validates and reads the host file under `math/lean`, then copies its contents to `/check/Check.lean`. Project-relative imports may not resolve unless the file is self-contained; imports available in the volume's Lean package/cache remain usable. Docker Desktop receives native absolute Windows paths as individual mount arguments, without shell quoting.

Builds use the clone in the volume, not host source edits. Comparator validates the challenge path against the host clone, then runs that relative challenge path in the volume's clone; keep the clones aligned. Its tools volume is created if needed and retained at `/opt`. The image pins Comparator v4.34.0 built with the corpus Lean 4.34.1 toolchain. Comparator defaults to `1800000` ms in Docker and `600000` ms natively; explicit `timeoutMs` is respected. The first run builds the solution-module dependency closure and can exceed even this timeout; later runs reuse the volume cache. On execution error/timeout only that invocation's uniquely named container is removed. A failed export is not verification.

Legacy results include `[docker]` PASS/FAIL and bounded output; `math_lean_verify` returns structured JSON instead. Missing prerequisites never verify. `npm test` exercises Docker snippet/file checks, strict-verifier smokes, the focused build, and missing-image/volume diagnostics when the Lean image and volume are available; otherwise it prints SKIP. Stubbed timeout/verification tests always run without external tools.

## Refresh the index

After changing or updating `math/`, invoke `math_reindex`, or run from the workspace root:

```powershell
npm run index
npm run index:lean
```

`index:lean` regenerates the gzip declaration index used when `rg` is unavailable.

Restart OpenCode or reload the project session after external index rebuilds. `math_reindex` invalidates the in-memory manuscript index, which reloads on next use. Check counts with `math_status`.

## Example session

For bounded corpus-wide PDF lookup, use `math_pdf_corpus_search` with `{ "query": "Riemann hypothesis", "candidates": 5, "pages": "1-2", "limit": 10 }`. Only `query` is required; matching is case-insensitive and literal by default (`literal: false` enables regex).

1. Ask: “Use `math_search` to find manuscripts about concentration inequalities.”
2. Choose a returned manuscript identifier and ask: “Use `math_manuscript` to read its outline, then only the section containing the relevant theorem.”
3. If the TeX source is missing, ask: “Use `math_pdf_text` on this preprint directory, pages 1–3.”
4. Ask: “Use `math_lean_search` for `linearizedMA_critical_density`, then `math_lean_check` this snippet.”

   ```lean
   import Mathlib
   example (n : Nat) : n + 0 = n := by simp
   ```

Report the actual check result, or the missing-toolchain error. This snippet checks only its stated identity, not the manuscript's theorem.

For symbolic work, use `math_compute` (for example `simplify sin(x)^2+cos(x)^2` or `det [[1,2],[3,4]]`). It is not a general Python executor.

## Limitations

- The plugin provides retrieval and tool execution, not inference or an automatic proof guarantee.
- `math_pdf_corpus_search` is not a full-text index: only the top indexed candidates are inspected, with at most 5 distinct pages and 5000 extraction characters each (50000 total). Pages default to `1-2`; missing/unreadable PDFs are reported and skipped, and no OCR is performed. Unselected manuscripts/pages or truncated text may contain additional matches.
- `CONTENTS.md` maps 721 manuscripts in 373 families; 175 papers currently have Lean formalizations catalogued in `lean/formalization.yaml`. These are raw research data, and not all claims are verified.
- Consult `history.md` for revisions and withdrawals when a result looks suspicious. Cite corpus paths relative to `math/`.
- Lean/Comparator checks require external tools and dependencies. The single `OAI` Lake package is pinned to `leanprover/lean4:v4.34.1`; full builds are huge, so prefer focused targets.
- Windows long-path support is required for this archive; keep Git `core.longpaths=true` enabled and quote paths.
- Corpus file reads are restricted to `math/`; arbitrary files elsewhere are not exposed. The plugin also loads its own code and generated index, and verification invokes external tools.

## File layout

Paths below are relative to the workspace root:

```text
.opencode/plugins/
  math-toolkit.js                  # Project-local plugin entry (V2 default export)
  math-toolkit/
    main.js                       # Plugin.define + ctx.tool.transform registration
    lib/                          # Tool and corpus helpers
    scripts/build-index.mjs        # Index builder
    scripts/build-pdf-index.mjs    # Bounded PDF excerpt index builder
    data/math-index.json           # Generated manuscript index
    data/pdf-index.json.gz         # Optional generated PDF excerpts (no OCR)
    README.md
.opencode/skills/math-workflow/SKILL.md
.opencode/commands/math.md
```
