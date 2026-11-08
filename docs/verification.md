# Verification evidence

## Docker Lean environment

Image: `opencode-math-lean` (Ubuntu 24.04, Lean 4.34.1, Lake 5.0.0).

### Mathlib-backed snippet

Ran inside the container with the persistent volume `opencode-math-lean`:

```text
lake exe cache get
lake env lean /tmp/MathCopilotCheck.lean
```

Result:

```text
Nat : Type
LEAN_DOCKER_OK
```

The snippet imports `Mathlib`, proves `1 + 1 = 2`, and checks `Nat`.

### Focused corpus build

```text
lake build OAI.Analysis.AffineBernstein.ABPCriticalDensity
```

Result:

```text
Build completed successfully (9201 jobs).
EXIT_CODE=0
```

This confirms that the corpus Lean source compiles with the pinned Lean 4.34.1 toolchain inside the Linux container.

### Full `OAI.Analysis` target

The full target was attempted but is enormous: after about five hours it had built ~12,815 of ~18,496 modules and was still expanding. It was stopped intentionally to avoid an unbounded build. This is a scale limitation, not a compile failure.

## Comparator

Image: `opencode-math-comparator` (Go 1.24.5, landrun 0.1.18, Comparator v4.34.0 + lean4export).

### Toolchain pin

The standalone Comparator checkout pins Lean 4.34.0 and its lean4export dependency pins 4.36.0-rc1. The corpus pins Lean 4.34.1; the 4.35/4.36 exporter could not read 4.34.1 `.olean` headers and failed with `incompatible header`.

The Docker verification now checks out Comparator **v4.34.0** and rebuilds it with `leanprover/lean4:v4.34.1`:

```text
Build completed successfully (21 jobs).
```

### Minimal end-to-end check

A trivial Lean 4.34.1 challenge (`Smoke.smoke : (1 : Nat) = 1`) was exported and compared with the rebuilt binaries:

```text
Running Lean default kernel on solution.
Lean default kernel accepts the solution
Your solution is okay!
```

The rebuilt image's `verify-comparator.sh` also completed the same smoke challenge through its cached build path and printed `COMPARATOR_DOCKER_OK`. This proves the toolchain-pin blocker and the Docker wrapper are fixed. It is a toolchain smoke test, not verification of a corpus theorem.

### QuasiRiemannHypothesis challenge

The challenge module compiled (`Build completed successfully (8924 jobs)`), and its `.olean` is present. The initial solution build aborted at **4,389/7,075 modules** because the corpus-pinned `rellich-kondrachov` package (2026-05-14) predates the pinned Mathlib API (2026-09-24, Lean 4.34.1). This was an upstream source break, not Comparator/lean4export drift or a local edit.

A checked-in compatibility patch now adapts eleven dependency modules:

- `Kernels`, `Restrict`, `H1`, `Translation`, `Compactness`, `Transfer`
- `TranslationEstimateH1`, `TranslationEstimateL2`, `Approximation`, `ArzelaAscoli`, `Rellich`

All eleven compile under Lean 4.34.1/Mathlib `d13f23b7`. `verify-comparator.sh` applies `docker/patches/rellich-kondrachov-lean4341.patch` once per volume, idempotently, before running a challenge. The corpus manifest is unchanged.

The full challenge now passes:

```text
Build completed successfully (7075 jobs).
Exporting #[..., OAI.riemannZeta_ne_zero_of_seven_eighths_lt_re, ...]
Running Lean default kernel on solution.
Lean default kernel accepts the solution
Your solution is okay!
COMPARATOR_DOCKER_OK
```

The challenge module (`8924 jobs`) and the solution closure (`7075 jobs`) build under the pinned Lean 4.34.1 toolchain. Comparator exports the target theorem and accepts the solution. This is Comparator verification of the Lean formalization, not a peer review of the paper.

The installed plugin's `math_comparator` tool with `{ docker: true, challenge: "ComparatorChallenges/QuasiRiemannHypothesis.json" }` also completed the same challenge and returned `Your solution is okay!` / `COMPARATOR_DOCKER_OK`, confirming the tool routing as well as the CLI wrapper.

Rerun:

```powershell
docker run --rm -v opencode-math-lean:/work -v opencode-comparator-tools:/opt -w /work/math/lean `
  -e CHALLENGE=ComparatorChallenges/QuasiRiemannHypothesis.json opencode-math-comparator verify-comparator.sh
```

The challenge file contains a `sorry` warning; that is the challenge statement, not a proof.

## Benchmark

See `bench/RESULTS.md` for the full tables and caveats.

Original run: two models, 10 problems, 1 repeat.

| Model | With plugin | Without plugin |
| --- | ---: | ---: |
| DeepSeek V4.1 Flash | 8/10, 93.97s | 4/10, 142.42s |
| GLM-5.3-Flash | 9/10, 36.77s | 8/10, 76.98s |

Core run: three models, 4 problems, 3 repeats.

| Model | With plugin | Without plugin |
| --- | ---: | ---: |
| DeepSeek V4.1 Flash | 12/12, 27.48s | 8/12, 105.05s |
| GLM-5.3-Flash | 12/12, 39.08s | 8/12, 105.01s |
| GPT-6-Luna | 12/12, 20.89s | 7/12, 38.98s |

Full run: three models, 10 problems, 3 repeats. With plugin **83/90**; without **62/90**.

| Model | With plugin | Without plugin |
| --- | ---: | ---: |
| DeepSeek V4.1 Flash | 30/30, 31.37s | 19/30, 92.42s |
| GLM-5.3-Flash | 26/30, 27.17s | 20/30, 65.41s |
| GPT-6-Luna | 27/30, 20.57s | 23/30, 47.49s |

## Index refresh

The `Refresh indexes` workflow was dispatch-tested (run `42452644635`) and completed successfully. It produced both artifacts; their counts match the committed indexes:

- 721 manuscripts, 373 families, 22,723 sections, 245 Lean docs
- 3,139,860 Lean declarations across 163,029 files

The artifact timestamps differ, so no index replacement was needed.

## Native Windows

Native Windows Lean remains blocked by the pinned AINTLIB path `2026-07-16T07:39:08Z`, which NTFS cannot represent. Docker is the recommended workaround and is tested above.
