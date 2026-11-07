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
  scripts/math_compute.py                  # allowlisted SymPy worker
  scripts/test-*.mjs                       # portable tests
  data/math-index.json                     # generated; do not hand-edit
  data/lean-index.json.gz                  # generated Lean index; do not hand-edit
.opencode/skills/math-workflow/SKILL.md
.opencode/commands/math.md
scripts/setup-lean.ps1                     # native Windows patch normalization + cache
scripts/lean-docker.ps1                    # Docker Lean wrapper
docker/                                     # Linux Lean + Comparator images
docs/comparator-wsl.md                     # Linux/WSL Comparator constraints
test/fixtures/                              # portable PDF/Lean fixtures
bench/                                      # with/without plugin harness
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
npm run index          # corpus index; requires a math/ clone
npm run index:lean     # Lean declaration index; requires math/lean
opencode.cmd reload    # after changing the plugin or index
opencode.cmd plugin list
```

`math/` is ignored and is not committed. The prebuilt `data/math-index.json` keeps `math_search` usable without the 3.3 GB clone; manuscript reads, `math_grep`, PDF extraction, Lean search, and Lean tools require `math/CONTENTS.md`.

New tools: `math_lean_search`, `math_pdf_text`, `math_compute`. `math_lean_search` uses `rg` when available, then the 21.9 MB gzip `lean-index.json.gz`, then a bounded Node walk. `math_pdf_text` uses `unpdf`; `math_compute` uses the fixed `math_compute.py` allowlist, never raw `sympify`.

## Docker Lean

Docker is the recommended Lean path on Windows; it avoids the NTFS-invalid AINTLIB path:

```powershell
docker build -f docker/lean.Dockerfile -t opencode-math-lean .
docker volume create opencode-math-lean
docker run --rm -it -v opencode-math-lean:/work opencode-math-lean verify-lean.sh
```

`docker/comparator.Dockerfile` adds Go, landrun, Comparator, and lean4export. The Comparator/lean4export build and challenge compile succeeded, but the export step failed with an incompatible `.olean` header because standalone Comparator pulled Lean 4.35.0 while the corpus pins 4.34.1. Do not claim Comparator verification.

Verified Docker evidence: Mathlib smoke (`LEAN_DOCKER_OK`) and focused build `OAI.Analysis.AffineBernstein.ABPCriticalDensity` (9,201 jobs, exit 0). The full `OAI.Analysis` target is ~18k modules and was stopped at ~12,815 after ~5 hours. Native Windows `scripts/setup-lean.ps1` is a fallback, not a full-build guarantee. See `docs/verification.md`.

## Verification expectations

- Run `npm test` and `npm run check` after changes.
- The test suite skips corpus-dependent tests when `math/` is absent; CI must not require `math/`, Lean, SymPy, or `rg`.
- Lean/Comparator tests do not require the toolchain; they assert actionable missing-tool errors.
- Do not claim Lean verification unless `math_lean_check`, `math_lean_build`, or `math_comparator` actually succeeded.
- Rebuild the index after corpus changes; never edit `data/math-index.json` by hand.
- Native Windows Lean builds are blocked by a pinned dependency path invalid on NTFS, and Comparator/landrun need Linux/WSL. Do not silently upgrade the Lean pin to work around this.

## Index facts

- 721 manuscripts, 373 families, 175 Lean-formalized papers, 22,723 indexed section headings.
- `math/CONTENTS.md` is HTML-in-Markdown; titles can contain `<`, `>`, and nested parentheses. The parser intentionally strips only real HTML tags and handles balanced link parentheses.
- LaTeX titles may contain `\texorpdfstring{display}{pdf}`; the parser keeps the display form.
