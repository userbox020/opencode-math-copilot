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

This proves the toolchain-pin blocker is fixed. It is a toolchain smoke test, not verification of a corpus theorem.

### QuasiRiemannHypothesis challenge

The challenge module compiled earlier (`Build completed successfully (8924 jobs)`), and its `.olean` is present. Running the challenge additionally builds the solution module `OAI.NumberTheory.DirichletL.Nonvanishing`, whose first-time dependency closure is 7,075 modules. That build is a multi-hour linear chain and was still running when this file was updated; do not record the challenge as a pass until it exits with `Your solution is okay!`.

Resume command:

```powershell
docker run --rm -v opencode-math-lean:/work -v opencode-comparator-tools:/opt -w /work/math/lean `
  -e CHALLENGE=ComparatorChallenges/QuasiRiemannHypothesis.json opencode-math-comparator verify-comparator.sh
```

The challenge file contains a `sorry` warning; that is the challenge statement, not a proof.

## Benchmark

See `bench/RESULTS.md`. Two models, 10 problems, 1 repeat:

| Model | With plugin | Without plugin |
| --- | ---: | ---: |
| DeepSeek V4.1 Flash | 8/10, 93.97s | 4/10, 142.42s |
| GLM-5.3-Flash | 9/10, 36.77s | 8/10, 76.98s |

## Native Windows

Native Windows Lean remains blocked by the pinned AINTLIB path `2026-07-16T07:39:08Z`, which NTFS cannot represent. Docker is the recommended workaround and is tested above.
