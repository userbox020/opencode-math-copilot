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

Image: `opencode-math-comparator` (Go 1.24.5, landrun 0.1.18, Comparator + lean4export).

What succeeded:

- Comparator and lean4export built: `Build completed successfully (21 jobs)`.
- `ComparatorChallenges.QuasiRiemannHypothesis` compiled: `Build completed successfully (8924 jobs)`
- The challenge file contains a `sorry` warning; that is the challenge statement, not a proof.

What failed:

```text
uncaught exception: failed to read file
'/work/math/lean/.lake/build/lib/lean/ComparatorChallenges/QuasiRiemannHypothesis.olean',
incompatible header
```

Cause: the standalone Comparator checkout pulled Lean **4.35.0**, while the corpus pins Lean **4.34.1**. The challenge was built with 4.34.1; the 4.35.0 exporter cannot read its `.olean` header.

This is the known Comparator version-pin blocker. Do not treat the comparator run as a verification pass. A compatible Comparator/lean4export revision for 4.34.1, or a deliberate corpus toolchain upgrade, is required.

## Benchmark

See `bench/RESULTS.md`. Two models, 10 problems, 1 repeat:

| Model | With plugin | Without plugin |
| --- | ---: | ---: |
| DeepSeek V4.1 Flash | 8/10, 93.97s | 4/10, 142.42s |
| GLM-5.3-Flash | 9/10, 36.77s | 8/10, 76.98s |

## Native Windows

Native Windows Lean remains blocked by the pinned AINTLIB path `2026-07-16T07:39:08Z`, which NTFS cannot represent. Docker is the recommended workaround and is tested above.
