# AGENTS.md

## What this repo is

A portable, project-local OpenCode math plugin. It indexes the `openai/math` corpus and exposes `math_*` tools plus the `math-workflow` skill and `/math` command.

## Layout

```text
.opencode/plugins/math-toolkit.js          # only auto-discovered plugin entry
.opencode/plugins/math-toolkit/
  main.js                                  # V2 Plugin.define + ctx.tool.transform
  lib/                                     # search, corpus, Lean, PDF, SymPy, paths
  scripts/build-index.mjs                  # corpus index builder
  scripts/build-lean-index.mjs             # Lean declaration index builder
  scripts/build-pdf-index.mjs              # PDF excerpt index builder
  scripts/math_compute.py                  # allowlisted SymPy worker
  scripts/test-*.mjs                       # portable tests
  data/math-index.json                     # generated; do not hand-edit
  data/lean-index.json.gz                  # generated Lean index; do not hand-edit
  data/pdf-index.json.gz                   # generated PDF excerpts; do not hand-edit
.opencode/skills/math-workflow/SKILL.md
.opencode/commands/math.md
scripts/setup-lean.ps1                     # native Windows patch normalization + cache
scripts/lean-docker.ps1                    # Docker Lean wrapper
scripts/verify-challenges.ps1              # batch Comparator verification
docker/                                     # Linux Lean + Comparator images
docs/comparator-wsl.md                     # Linux/WSL Comparator constraints
docs/verification-automation.md            # batch/self-hosted verification
docs/troubleshooting.md                    # install/cache/Docker recovery
test/fixtures/                              # portable PDF/Lean fixtures
bench/                                      # with/without plugin harness
bench/analyze.mjs                           # Wilson/CI benchmark analysis
```

The implementation directory deliberately has `main.js`, not `index.js`, so OpenCode does not discover it as a second plugin. Keep `math-toolkit.js` as the single plugin entry.

## API constraint

OpenCode 2.0.29+ uses the V2 plugin API. The entry must export `Plugin.define({ id, setup })` from `@opencode/plugin` and register tools through `ctx.tool.transform(...)`. V1 `{ server }` plugins do not load.

Tools use `options: { codemode: true }` because this environment's models call tools through Code Mode.

## Commands

```powershell
npm install
npm test
npm run check
npm run bench          # model inference; optional
npm run bench:analyze  # analyze saved benchmark results
npm run index          # corpus index; requires a math/ clone
npm run index:lean     # Lean declaration index; requires math/lean
npm run index:pdf      # PDF excerpt index; requires a math/ clone
opencode.cmd reload    # after changing the plugin or index
opencode.cmd plugin list
```

`math/` is ignored and is not committed. The prebuilt `data/math-index.json` keeps `math_search` usable without the 3.3 GB clone; manuscript reads, `math_grep`, PDF extraction, Lean search, and Lean tools require `math/CONTENTS.md`.

Sixteen tools total. `math_lean_verify` checks a named user solution against a trusted `expectedType` and axiom allowlist, returning a `math-lean-verify/v1` JSON receipt; `math_lean_check` still reports compilation only. `math_pdf_corpus_search` scans top BM25 candidates; `math_pdf_index_search` reads the prebuilt `pdf-index.json.gz` (789 PDFs / 1,548 selected pages / ~1.46 MB gzip; default first 2 pages, no OCR); `math_doctor` reports corpus/index/cache/Docker/toolchain/disk health. `math_lean_search` uses `rg`, then the 21.9 MB gzip `lean-index.json.gz`, then a bounded Node walk. PDF extraction uses `unpdf` with a persistent cache (500 entries / 200 MB; `MATH_TOOLKIT_PDF_CACHE` / `MATH_TOOLKIT_DISABLE_PDF_CACHE`). `math_compute` uses the fixed `math_compute.py` allowlist, never raw `sympify`. Lean tools accept `docker: true` for the Linux Docker volume.

## Docker Lean

Docker is the recommended Lean path on Windows; it avoids the NTFS-invalid AINTLIB path:

```powershell
docker build -f docker/lean.Dockerfile -t opencode-math-lean .
docker volume create opencode-math-lean
docker run --rm -it -v opencode-math-lean:/work opencode-math-lean verify-lean.sh
```

`docker/comparator.Dockerfile` adds Go, landrun, Comparator, and lean4export. Comparator v4.34.0 is built against corpus Lean 4.34.1, resolving the historical exporter-header mismatch. The idempotent eleven-module `rellich-kondrachov` compatibility patch enables the recorded `QuasiRiemannHypothesis` pass: 7,075 solution modules, `Your solution is okay!`, and `COMPARATOR_DOCKER_OK`. This verifies that challenge's Lean formalization, not every corpus theorem, all 418 challenges, or the informal paper. See `docs/verification.md`.

Verified Docker evidence: Mathlib smoke (`LEAN_DOCKER_OK`) and focused build `OAI.Analysis.AffineBernstein.ABPCriticalDensity` (9,201 jobs, exit 0). The full `OAI.Analysis` target is ~18k modules and was stopped at ~12,815 after ~5 hours. Native Windows `scripts/setup-lean.ps1` is a fallback, not a full-build guarantee. See `docs/verification.md`.

## Verification expectations

- Run `npm test` and `npm run check` after changes.
- The test suite skips corpus-dependent tests when `math/` is absent; CI must not require `math/`, Lean, SymPy, or `rg`.
- Lean/Comparator tests do not require the toolchain; they assert actionable missing-tool errors.
- Compilation/build success is not a verified proof. For user solutions require `math_lean_verify` with a trusted type and `proof.status: "verified"`; report execution, target and axiom failures honestly. Informal correspondence is not assessed. See `docs/verification-contract.md`.
- A `sorry` in `ComparatorChallenges/*.lean` is the challenge statement, not the solution. Use `math_comparator` and its actual solution-validation result for that path; do not classify the placeholder as a proved solution.
- Rebuild the index after corpus changes; never edit `data/math-index.json` by hand.
- Native Windows Lean builds are blocked by a pinned dependency path invalid on NTFS, and Comparator/landrun need Linux/WSL. Do not silently upgrade the Lean pin to work around this.

## Index facts

- Refresh indexes: `scripts/refresh-indexes.ps1` updates the corpus and both indexes; the weekly/manual workflow uploads artifacts without committing. See [docs/index-refresh.md](docs/index-refresh.md) and review large index changes before committing.

- 721 manuscripts, 373 families, 175 Lean-formalized papers, 22,723 indexed section headings.
- `math/CONTENTS.md` is HTML-in-Markdown; titles can contain `<`, `>`, and nested parentheses. The parser intentionally strips only real HTML tags and handles balanced link parentheses.
- LaTeX titles may contain `\texorpdfstring{display}{pdf}`; the parser keeps the display form.
