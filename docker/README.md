# Lean in Docker

Docker is the recommended way to run the math corpus’s Lean verification on Windows.

It is better than native Windows for this project because:

- The Lean project and dependency clones live on a Linux filesystem, so the pinned AINTLIB path `2026-07-16T07:39:08Z` is valid.
- The toolchain, Mathlib cache, and build output are reproducible across machines.
- Comparator/landrun also require Linux, so the same container can be extended for Comparator.
- Windows only needs Docker Desktop; no WSL distro setup or host PATH changes.

## Build

```powershell
docker build -f docker/lean.Dockerfile -t opencode-math-lean .
```

## Verify

Use a named volume so the 3.3 GB clone, Mathlib cache, and build products persist:

```powershell
docker volume create opencode-math-lean
docker run --rm -it -v opencode-math-lean:/work opencode-math-lean verify-lean.sh
```

The first run clones `openai/math`, downloads the Mathlib cache, checks a Mathlib-backed Lean snippet, and builds `OAI.Analysis`. Later runs reuse the volume.

Skip the large build for a quick Mathlib smoke test:

```powershell
docker run --rm -it -v opencode-math-lean:/work -e SKIP_BUILD=1 opencode-math-lean verify-lean.sh
```

Choose another target:

```powershell
docker run --rm -it -v opencode-math-lean:/work -e TARGET=OAI.Algebra opencode-math-lean verify-lean.sh
```

## Interactive use

```powershell
docker run --rm -it -v opencode-math-lean:/work opencode-math-lean bash
# inside:
cd /work/math/lean
lake env lean /tmp/MathCopilotCheck.lean
```

## Window wrapper

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lean-docker.ps1
```

Add `-SkipBuild` for the quick check, or `-Target OAI.Algebra`.

## Verification result

See [`docs/verification.md`](../docs/verification.md). The focused module `OAI.Analysis.AffineBernstein.ABPCriticalDensity` builds successfully under Lean 4.34.1. The full `OAI.Analysis` target is enormous and was stopped after ~12,815 / ~18,496 modules.

## Comparator

Comparator/landrun are Linux-only. Build the comparator layer after the Lean image:

```powershell
docker build -f docker/comparator.Dockerfile -t opencode-math-comparator .
docker run --rm -it -v opencode-math-lean:/work opencode-math-comparator verify-comparator.sh
```

The script installs/builds landrun, Comparator, and lean4export inside the container. It reports build failures explicitly; do not treat a failed comparator build as a verification pass. The standalone Comparator is version-sensitive to the project’s Lean 4.34.1 pin; do not silently upgrade the project toolchain.

Run a specific challenge:

```powershell
docker run --rm -it -v opencode-math-lean:/work -e CHALLENGE=ComparatorChallenges/Other.json opencode-math-comparator verify-comparator.sh
```
