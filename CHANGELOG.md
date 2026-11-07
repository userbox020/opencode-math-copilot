# Changelog

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
- Docker image built; Linux Lean verification is tracked in the release notes.
- Benchmark results are in `bench/RESULTS.md`.
