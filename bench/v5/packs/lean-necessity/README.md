# Lean verification necessity

Ten original synthetic Lean/Mathlib tasks: five valid proofs and five invalid
submissions. `pilot.json` selects five fixed tasks (two valid, three invalid).
`baselines.json` has an empty external list. No model calls or scores are included.
Fixture text is dedicated to the public domain under CC0-1.0.

## Build and independently verify

From this directory:

```powershell
node build.mjs
node verify.mjs
node --check build.mjs
node --check verify.mjs
node --check tests/lean-necessity.test.mjs
node --test tests/lean-necessity.test.mjs
node --input-type=module -e "import {readTasks} from '../../external/schema.mjs'; for (const f of ['tasks.json','pilot.json']) console.log(f, readTasks(f).tasks.length, readTasks(f).hash)"
```

Build is deterministic and does **not** claim to verify proofs. Verification
requires the maintained, already initialized Docker image and volume, both named
`opencode-math-lean`. It never pulls images, changes dependency pins, uses the
plugin verifier, or accesses the network. The native host Lake path is blocked
by AINTLIB's Windows-invalid timestamp path; Docker is the explicit replacement.

`verify.mjs` runs exactly ten `lake env lean /check/Check.lean` checks, using the
inspected image digest, `/work/math/lean` working directory, read-only corpus
volume mounted at `/work`, read-only owned check-directory mount, no network,
a read-only container root, and a 120-second timeout per proof. Temporary files
stay within this pack and are cleaned up; timed-out containers are removed by
their unique owned name. Environment/hash inspection is not a proof check.
Missing Docker, dependencies, unexpected diagnostics, or missing axiom output
are execution failures, **not** mathematical INVALID verdicts.

Each check elaborates a trusted `GoldExpected` proposition **before** the submitted
code, prints the target's transitive axioms, and attempts
`theorem GoldWitness : GoldExpected := Submission.claim`, then prints its axioms.
This catches a shadowed definition even when the submitted theorem compiles.
Target-only type errors are separated from submitted-source errors by line
number. Only `propext`, `Quot.sound`, and `Classical.choice` are allowed.
Canonical fixture matching rejects modified tasks before invoking Lean.
This is a verifier for these owned fixtures, not an arbitrary-code sandbox.

Only a successful complete run writes evaluator-only `gold.json`: full source,
trusted target, exact reason, raw Lean stdout/stderr/status, both axiom lists,
source/check hashes, Lean version, image digest, corpus/Mathlib commits and Lake
manifest hash. Commits are provenance, not a claim of a pristine dependency tree.
The evidence contains no plugin-verifier receipts. A failed rerun exits nonzero;
any existing gold file is historical evidence, not evidence that the rerun passed.

Tests validate the recorded actual checks without spending another ten Lean
invocations. Missing gold is explicitly skipped, never reported as verified.
The optional fresh integration test is skipped unless `LEAN_NECESSITY_LIVE=1`;
do not enable it when the current run has a ten-check limit.

## Evaluator-only expected outcomes

| ID | Verdict | Reason |
| --- | --- | --- |
| lean-valid-01 | VALID | Natural-number arithmetic, `norm_num` |
| lean-valid-02 | VALID | Addition by zero, `simp` |
| lean-valid-03 | VALID | Reverse twice, `simp` |
| lean-valid-04 | VALID | Set intersection with itself, extensionality and `simp` |
| lean-valid-05 | VALID | Conjunction swap, direct constructors |
| lean-invalid-01 | INVALID | Used helper depends on `sorryAx` |
| lean-invalid-02 | INVALID | Used explicit axiom `Submission.addition_identity` |
| lean-invalid-03 | INVALID | Existential declaration instead of universal target |
| lean-invalid-04 | INVALID | Local `Monotone` is not Mathlib `_root_.Monotone` |
| lean-invalid-05 | INVALID | Impossible reversed inequality; `omega` fails |

## Exposure and interpretation

Give the model **only the prompt** (and, if necessary, neutral metadata). IDs
encode the requested split; do not expose IDs, answers, grading, this README,
build/verify sources, or `gold.json`. Prompt metadata uses shared-schema
`review_note`, not unsupported `note`. Code and the fresh-environment target
are inside each prompt; the exact answer and reason are evaluator-only.

The intended comparison is ON with `math_lean_verify`, OFF with generic read
only; this pack does not configure or execute those arms. These small examples
test proof-validation pitfalls, not an established inability to reason without
tools. Some invalid cases are recognizable by inspection. No tool-necessity or
accuracy-improvement claim follows without a separately controlled experiment.
