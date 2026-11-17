# ArXivLean preflight — five formal statements compile

**Date:** 2026-11-17
**Scope:** evaluator-side compilation preflight only. No model run, no ArXiv task
solved, no proof checked.

The five public formal statements in
`bench/v3/arxivlean/tasks/arxivlean-smoke5.json` were compiled as standalone
Lean files with the project's pinned Docker toolchain (`math_lean_check`,
`docker: true`). All five returned exit code 0.

| Task | Formal statement SHA-256 | Bytes | Compile |
|---|---|---:|---|
| arxivlean-01 | `e2164399ef4a88eb555877a9eb052ce245284716e3917926844c6d909ebcdc51` | 1446 | PASS |
| arxivlean-02 | `0eff8cb153501489fa96281fd0ee88f5ef164623ab4cf2a312b3d76138ebcb5f` | 1482 | PASS |
| arxivlean-03 | `02b309599298190e5cf3b88683243abcd02ad7a338e0740014f8aaab43150730` | 1366 | PASS |
| arxivlean-04 | `550fe9b9b2b4356d1a7ce5a281335b5f2d08397e59415e501d27bac1b884c571` | 1126 | PASS |
| arxivlean-05 | `a447944b984ceaadc20dae53ae05ea839084b35b418c1a84c62b24958bf6c745` | 902 | PASS |

Toolchain: Lean 4.34.1 / Mathlib `d13f23b723b8a846827a245b89c10fc7d3f11612`
(the same pins as the evaluator checker). The only diagnostics were pre-existing
local-change warnings for Lake dependencies; no statement produced a Lean error.

## What this does and does not establish

It establishes that each `formal_statement` is a valid Lean module and that the
frozen target `arxivleanConjecture` exists in each. It does **not** establish
that any proof exists, that a submitted proof is correct, or that the target is
true. Acceptance still requires the evaluator-owned checker contract: frozen
imports/axioms, a trusted target type, and either
`arxivlean_proof : arxivleanConjecture` or
`arxivlean_disproof : ¬ arxivleanConjecture`.

## Source policy for the smoke

The five source papers are real and fetchable, but their abstracts and theorem
statements are answer-bearing. Task 04's abstract, for example, states the
disproof outright. The conservative condition is therefore **public-input-only**:
the model receives only the task's `problem` and `formal_statement` (already the
benchmark prompt), with no paper, PDF, proof, Lean target module, Comparator
file, cache, transcript, or corpus index. That is stronger than masking selected
paper spans and avoids a human span-approval judgement that has not been made.

A five-task smoke under this condition must be reported as **restricted-source
ArXivLean**, not as the unchanged official benchmark. The retrieval tools can
only serve the two public-input files; the comparison therefore exercises the
non-retrieval toolkit (Lean/compute) more than retrieval. That limitation is
part of the result, not a footnote to hide.

## Public-input snapshot controls — passed

`arxivlean-public-input-controls.json` records a real run of
`arxiv-snapshot.mjs` + `arxiv-snapshot-runtime.mjs` against all five tasks. For
each task the public inputs were staged, hashed, rebuilt into a snapshot, served
through the actual staged handlers, and exercised by the ten controls in both
conditions.

| Result | Value |
|---|---:|
| Tasks | 5 |
| Conditions | 2 (`plugin-off`, `plugin-on`) |
| Controls per condition | 10 |
| Failed controls | 0 |
| Generic inventory | 3 tools, identical across conditions |
| ON-only inventory | + `math_search`, `math_manuscript` |

The controls cover the six negative classes through the handlers: excluded
proof/paper paths, evaluator-only sentinel search, PDF requests, old
index/cache/transcript paths, post-staging excerpt mutation, and
process/Lean-import-shaped path requests. The four positive controls confirm the
two sources list, exact first-line read, public-phrase search, and ON-only formal
statement retrieval. The mutation control restores the original bytes.

This establishes reader behavior and manifest binding. It is not process
isolation, not execution admission, and not a model run.

## Dataset gold check — no gold proofs

The pinned dataset `MathArena/arxivlean-0926` (revision
`e346a992a3da17797bc2ea616f5fca0e7d61570b`, split `train`) was queried through
the Hugging Face datasets server for rows 1–5. Its schema is
`problem_idx, problem, answer, formal_statement, source, title, arxiv_id`.
For all five selected tasks, the `answer` field is **byte-identical to
`formal_statement`**. The dataset therefore supplies the formal target, not a
proof or disproof.

Consequence: the plan's requirement for **task-bound positive checker controls**
cannot be met from the dataset. A positive control needs a genuine proof of
`arxivleanConjecture` or of `¬arxivleanConjecture` in the frozen context. None
exists in the task file or the dataset. A synthetic trivial theorem can validate
the checker machinery, but it does not validate a task's target binding; using
another model's transcript as a positive control would be a known-answer
contamination of that task.

This is a hard gate, not a tooling gap. Until a legitimate gold proof or
counterexample is supplied for at least the tasks used, a five-task smoke would
be uninterpretable under the stated NO-GO: a checker that rejects every
submission cannot be distinguished from a model that proves nothing.

## Still required before any smoke

1. An additive evaluator checker for the five proof-or-disproof contracts that
   does not disturb the g024-pinned checker adapter, policy registry, or build
   receipt.
2. Task-bound positive and negative checker controls (accepted proof, rejected
   wrong direction, rejected redefinition/shadowing). **Blocked by the missing
   gold proofs above.**
3. Snapshot staging and handler controls through the actual staged tools.
4. A frozen smoke protocol with per-episode budget and timeout, and a fresh
   output directory.

No ArXiv episode has been run. The infrastructure can be completed; the
task-bound positive controls cannot be fabricated.
