# OpenCode Math Copilot

A project-local [OpenCode](https://opencode.ai) plugin that turns the [OpenAI math repository](https://github.com/openai/math) into searchable, readable, verifiable tools for any model.

It provides BM25 search over **721 manuscripts / 373 result families**, reads manuscript metadata and LaTeX sections, searches TeX/Markdown/Lean text, extracts PDF text, searches Lean declarations, runs restricted SymPy computations, and wraps Lean/Lake/Comparator checks.

## Requirements

- **OpenCode 2.0.29+** with the V2 plugin API (`Plugin.define` / `ctx.tool.transform`). V1 plugin implementations do not run in OpenCode 2.x.
- **Node.js 24** for the index builder and tests.
- A clone of `openai/math` at `./math` for `math_manuscript`, `math_grep`, `math_pdf_text`, `math_pdf_search`, and the Lean tools.
- `npm install` installs `unpdf` for PDF text extraction.
- Recommended: `ripgrep` (`rg`) for fast Lean declaration search. Without it, a prebuilt declaration index is used, then a bounded Node fallback.
- Optional: elan/Lean for `math_lean_check` / `math_lean_build`; Docker for reproducible Linux Lean verification; Python 3 + SymPy for `math_compute`; Comparator + landrun + lean4export in Linux/Docker for `math_comparator`; LaTeX for document builds.

The repository includes a prebuilt `math-index.json`, so `math_search` works immediately. Manuscript reads and Lean checks need the `math/` clone.

## Install

```powershell
git clone https://github.com/userbox020/opencode-math-copilot.git
cd opencode-math-copilot
git clone https://github.com/openai/math math
npm install
```

Open the folder in OpenCode. The plugin is auto-discovered from `.opencode/plugins/`:

```powershell
opencode.cmd plugin list
```

You should see `math-toolkit`. If you change the plugin or rebuild the index, run:

```powershell
opencode.cmd reload
```

### Global Git install (no npm registry auth)

```powershell
opencode plugin add github:userbox020/opencode-math-copilot
opencode plugin list
```

This installs the package from GitHub and does not require an npm token. The `math/` clone is still required for manuscript, PDF, and Lean tools; `math_search` works from the bundled index.

## Use

```text
/math <problem>
```

The `/math` command loads the `math-workflow` skill and instructs the model to search first, read only relevant sections, and report verification honestly.

Tools are also available directly in Code Mode:

```js
tools.math_status({})
tools.math_search({ query: "Riemann hypothesis", limit: 5 })
tools.math_search({ query: "family:003 has:lean", limit: 10 })
tools.math_manuscript({ path: "preprints/The-Quasi-Riemann-Hypothesis-September-30-2026", section: "Introduction" })
tools.math_grep({ query: "Quasi-Riemann", path: "preprints/The-Quasi-Riemann-Hypothesis-September-30-2026" })
tools.math_lean_check({ code: "example : True := by trivial" })
tools.math_lean_build({ target: "OAI.Analysis" })
tools.math_lean_search({ query: "linearizedMA_critical_density" })
tools.math_pdf_text({ path: "overview.pdf", pages: "1-3" })
tools.math_pdf_search({ path: "overview.pdf", query: "Research Catalog", pages: "1" })
tools.math_compute({ operation: "simplify", expression: "sin(x)^2 + cos(x)^2" })
tools.math_compute({ operation: "det", matrix: [[1, 2], [3, 4]] })
tools.math_comparator({ challenge: "QuasiRiemannHypothesis" })
tools.math_reindex({})
```

## Tools

| Tool | Purpose |
| --- | --- |
| `math_search` | BM25 search with `family:003`, `lean:true`, and `has:lean` filters. |
| `math_manuscript` | Metadata, abstract, file outline, section headings, or a specific LaTeX section. |
| `math_grep` | Search TeX, Markdown, and Lean text under `math/`. |
| `math_lean_check` | Type-check a Lean snippet or existing file with `lake env lean`. |
| `math_lean_build` | Build a focused Lake target such as `OAI.Analysis`. |
| `math_lean_search` | Search declaration lines in `math/lean` and Mathlib by name or regex. |
| `math_pdf_text` | Extract bounded text from a manuscript PDF (no OCR). |
| `math_pdf_search` | Search the extracted text of one manuscript PDF/preprint (bounded pages; no OCR). |
| `math_compute` | Restricted SymPy operations: simplify, factor, expand, solve, diff, integrate, limit, series, evalf, det, eigenvalues. |
| `math_comparator` | Run an existing Comparator challenge JSON. |
| `math_status` | Index counts and PATH availability for Lean/LaTeX/Python/rg/SymPy. |
| `math_reindex` | Rebuild the index after `math/` changes. |

## How it works

1. `scripts/build-index.mjs` parses:
   - `math/CONTENTS.md` for families, abstracts, and PDF links
   - `math/preprints/*/README.md` for citation metadata
   - `math/lean/formalization.yaml` for Lean-formalized papers
   - `math/preprints/*/build/**/*.tex` for section headings
2. `lib/search.js` builds an in-memory BM25 index over titles, family titles, abstracts, section headings, and Lean titles.
3. `main.js` registers the tools with the OpenCode V2 plugin API. Tools are exposed in Code Mode.
4. `lib/lean.js` shells out to `lake` with `shell: false`; it never interpolates user input into a shell string.
5. `lib/lean-search.js` uses `rg --json` for declaration matching and falls back to a bounded Node walk.
6. `lib/pdf.js` uses `unpdf`; `lib/compute.js` runs a fixed Python/SymPy script over an allowlisted AST.

## Rebuild the index

After updating `math/`:

```powershell
npm run index
npm run index:lean
opencode.cmd reload
```

or from an OpenCode session:

```js
await tools.math_reindex({})
```

`index:lean` writes the gzip declaration index used when `rg` is unavailable.

**Refresh indexes:** Run `scripts/refresh-indexes.ps1` to update the corpus and both indexes, or download the weekly workflow artifacts. See [index refresh](docs/index-refresh.md) for review and commit steps.

## Test and check

```powershell
npm test
npm run check
```

The test suite passes with or without `math/`. Corpus-dependent manuscript/section/grep tests are skipped when the corpus is absent; the fixture PDF, fixture Lean declaration, SymPy, status, schema, path-safety, and missing-toolchain tests run everywhere. CI installs SymPy and uses the fixtures on Windows and Ubuntu.

## Lean setup

**Recommended: Docker.** It gives a Linux filesystem and avoids the NTFS-invalid AINTLIB path:

```powershell
docker build -f docker/lean.Dockerfile -t opencode-math-lean .
docker volume create opencode-math-lean
docker run --rm -it -v opencode-math-lean:/work opencode-math-lean verify-lean.sh
```

For a quick Mathlib check without the large `OAI.Analysis` build:

```powershell
docker run --rm -it -v opencode-math-lean:/work -e SKIP_BUILD=1 opencode-math-lean verify-lean.sh
```

For a focused, practical corpus build:

```powershell
docker run --rm -it -v opencode-math-lean:/work `
  -e TARGET=OAI.Analysis.AffineBernstein.ABPCriticalDensity `
  opencode-math-lean verify-lean.sh
```

The focused module builds successfully (9,201 jobs under Lean 4.34.1). The full `OAI.Analysis` target is far larger (~18k modules) and may take many hours. See `docs/verification.md`.

The Comparator layer is in `docker/comparator.Dockerfile`. Comparator/lean4export build, but the standalone Comparator pulled Lean 4.35.0 and cannot read the corpus’s 4.34.1 `.olean` (`incompatible header`); this is an unresolved version-pin blocker, not a verification pass.

**Native Windows** is still supported by `scripts/setup-lean.ps1`, which normalizes the corpus patch files to LF and runs `lake exe cache get`. It is not enough for a full build:

- The pinned dependency set contains at least one path that is invalid on NTFS (a timestamp containing `:`), so dependency checkout fails.
- Comparator/landrun require Linux/Landlock.

`math_status` reports what is actually available; `math_lean_check` and `math_lean_build` report failures honestly.

## Benchmark

```powershell
npm run bench -- --json bench/results/latest.json --md bench/results/latest.md
```

The benchmark compares the same prompts with and without the plugin on a cheap model. Results are indicative, not a scientific benchmark; see `bench/README.md`.

## Distribution

There are two supported installs:

1. **Project-local** — clone the repository or copy `.opencode/plugins/math-toolkit.js` plus `.opencode/plugins/math-toolkit/` into a project. OpenCode discovers it automatically.
2. **Global Git install** — no npm registry auth or 2FA:

   ```powershell
   opencode plugin add github:userbox020/opencode-math-copilot
   ```

`npm install` is only needed for `unpdf` and test dependencies. `package.json` is `"private": true` to prevent accidental registry publishing; `npm pack --dry-run` still validates the package. See `RELEASING.md` for details.

## Limitations

- This is retrieval and tool execution, not a proof guarantee. The corpus is raw research output; not every claim is independently verified.
- 175 papers currently have Lean formalizations. `math/lean/formalization.yaml` is the catalogue; presence there does not certify every claim in the paper.
- Lean/Comparator checks require an installed toolchain. Missing tools are reported as failures, never as successful verification.
- `math_grep` and `math_lean_search` prefer `rg`; without it, bounded pure-Node fallbacks scan only text files under `math/`.
- `math_pdf_text` performs text extraction only; it does not OCR scanned pages and caps extraction at 50 pages / 80 MB per PDF.
- `math_compute` is allowlisted SymPy, not general Python execution. It enforces AST, size, and timeout limits, but it is not an OS-level memory sandbox.
- Full Lake builds are huge. Prefer focused targets; the whole package may hit `vm.max_map_count` on Linux (see `math/lean/README.md`).
- The plugin reads only under `math/` (plus its own index and scripts). It does not expose arbitrary filesystem reads.

## Repository layout

```text
.opencode/plugins/math-toolkit.js          # V2 plugin entry
.opencode/plugins/math-toolkit/
  main.js                                  # Plugin.define + ctx.tool.transform
  lib/                                     # search, corpus, Lean, PDF, SymPy, paths
  scripts/build-index.mjs                  # corpus index builder
  scripts/math_compute.py                  # allowlisted SymPy worker
  scripts/test-*.mjs                       # portable feature tests
  data/math-index.json                     # generated index
  README.md
.opencode/skills/math-workflow/SKILL.md
.opencode/commands/math.md                 # /math
scripts/setup-lean.ps1                     # native Windows patch normalization + cache
scripts/lean-docker.ps1                    # Docker Lean wrapper
docker/                                     # Linux Lean + Comparator images
docs/comparator-wsl.md                     # Comparator/Linux constraints
test/fixtures/                              # portable PDF/Lean fixtures
bench/                                      # with/without plugin harness + results
.github/workflows/test.yml                 # Linux/Windows CI
```

## Attribution

`math-index.json` is derived from [openai/math](https://github.com/openai/math), which is licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`.
