# Changelog

## Unreleased

- Fixed Comparator's effective timeouts: 30 minutes in Docker, 10 minutes native, or the explicit override; added stubbed timeout and invocation-scoped cleanup tests.
- Added `math_lean_verify` (16 tools total) with a versioned JSON receipt, trusted target-type check and fail-closed axiom policy; compilation-only `math_lean_check` is unchanged. See `docs/verification-contract.md`.
- Corrected Comparator/benchmark documentation, benchmark CLI flags, duplicate `bench:analyze` script and stale root lockfile version metadata (0.4.0; no dependency upgrades).
- Added `bench/v2` deterministic evaluation harness (simulated only): A/B/F profiles, typed graders, append-only provenance/resume, family-paired bootstrap, and a restricted execution profile. No model inference is enabled.
- Added `research/` protocol, claims/evidence map, related-work notes and `paper/` skeleton. New results are pending/simulated; no release or publication.
- Addressed the independent review: strict verification audits a generated checked declaration (including synthesized instances/`sorry`), rejects malformed extra reports, handles null/`notRun`, and aligns the v2 study receipt schema 2.1.0 with `math-lean-verify/v1`.

## 0.4.0 - 2026-11-08

- Added `math_doctor` for bounded corpus/index/cache/Docker/toolchain/disk diagnostics.
- Added a persistent PDF extraction cache (500 entries / 200 MB default), metadata-based invalidation, lazy manuscript-index loading, and index invalidation after reindex.
- Added a prebuilt PDF excerpt index and `math_pdf_index_search` (15 tools total): **789 PDFs / 1,548 pages / 1.46 MB gzip**. Excerpts are selected pages (default first 2, max 5 pages/20k chars per PDF); no OCR, not a full-text corpus.
- Added Comparator batch verification (`scripts/verify-challenges.ps1`), JSON/Markdown reports, and a self-hosted Linux Docker verification workflow.
- Added Dependabot, security audit and dependency-review workflows, a manual release workflow, and `SECURITY.md`.
- Added `bench/analyze.mjs` with Wilson 95% intervals, p95/median durations, per-problem counts, and benchmark rigor documentation.
- Added `docs/troubleshooting.md` and `docs/verification-automation.md`.

## 0.3.1 - 2026-11-08

- Extended the `rellich-kondrachov` Lean 4.34 compatibility patch to `Rellich`, `TranslationEstimateH1`, and `Transfer`.
- The full `QuasiRiemannHypothesis` Comparator challenge passes: 7,075 solution modules build, `OAI.riemannZeta_ne_zero_of_seven_eighths_lt_re` is exported, and the Lean kernel accepts the solution (`Your solution is okay!`, `COMPARATOR_DOCKER_OK`).
- Full benchmark: **83/90** with plugin vs **62/90** without (10 problems × 3 repeats × 3 models).

## 0.3.0 - 2026-11-08

- Docker execution mode for `math_lean_check`, `math_lean_build`, and `math_comparator` (`docker: true`), with configurable images/volumes and actionable missing-image errors.
- `math_pdf_search` for bounded full-text phrase/regex search in one manuscript PDF.
- `math_pdf_corpus_search` for bounded PDF line search across the top BM25-indexed manuscript candidates (maximum 10 candidates, 5 pages each; not a full-text index).
- Comparator Docker verification pinned to `v4.34.0` built against the corpus's Lean v4.34.1 toolchain, with an idempotent build cache.
- The Comparator toolchain pin is smoke-verified. A checked-in compatibility patch adapts the corpus-pinned `rellich-kondrachov` source (`70f85d4`) to Lean 4.34.1/Mathlib `d13f23b7`; the full QuasiRiemann challenge pass is recorded under 0.3.1.
- Index refresh automation: `scripts/refresh-indexes.ps1`, weekly/manual `refresh-index.yml`, and `docs/index-refresh.md`.
- Core benchmark set (`bench/problems-core.json`, `bench/run-core.ps1`) for 4 problems Ã— 3 repeats Ã— 3 models.
- Distribution is project-local discovery plus the global Git-spec install:
  `opencode plugin add github:userbox020/opencode-math-copilot`.
- Removed npm registry publishing; `package.json` is `private: true` and the publish workflow is gone.
- No npm registry auth or 2FA is required. `math_search` works from the bundled index; `math/` is still needed for manuscript/PDF/Lean tools.

## 0.2.0

### Added

- Docker Lean verification: `docker/lean.Dockerfile`, `docker/verify-lean.sh`, and `scripts/lean-docker.ps1`.
- Docker Comparator/landrun layer: `docker/comparator.Dockerfile`, `docker/verify-comparator.sh`.
- Precomputed Lean declaration index (`data/lean-index.json.gz`, ~21.9 MB) used when `rg` is unavailable.
- Portable PDF and Lean fixtures plus SymPy installation in CI.
- Expanded 10-problem benchmark harness with multi-model, with/without-plugin matrix and tool-call counts.
- Release-triggered npm publishing workflow using `NPM_TOKEN` and provenance.
- `CHANGELOG.md`, Docker documentation, and expanded AGENTS/README guidance.

### Fixed

- PDF extraction fallback for runtimes that cannot resolve `unpdf` self-references.
- Lean index fallback correctly ignores fixture trees and uses the bounded Node walk.
- Cross-platform path containment check (Linux absolute paths no longer reported as Windows paths).
- `iut`/AINTLIB CRLF and NTFS constraints documented; Docker is the recommended Linux path.

### Verification

- CI passes on Windows and Ubuntu with Node 24, PDF/Lean fixtures, and SymPy.
- Lean declaration index tested for known declarations, kind filters, regex, and no-`rg` search.
- Docker Mathlib smoke passed: `Nat : Type`, `LEAN_DOCKER_OK`.
- Focused corpus build passed: `lake build OAI.Analysis.AffineBernstein.ABPCriticalDensity` (9,201 jobs, exit 0).
- Full `OAI.Analysis` build was attempted and stopped at ~12,815 / ~18,496 modules after ~5 hours; this is a scale limitation, not a compile failure.
- Comparator/lean4export and the challenge built, but the export failed with `incompatible header` because standalone Comparator uses Lean 4.35.0 and the corpus pins 4.34.1. Documented as a blocker.
- Benchmark results are in `bench/RESULTS.md` (DeepSeek 8/10 vs 4/10; GLM 9/10 vs 8/10).
- Detailed evidence: `docs/verification.md`.
