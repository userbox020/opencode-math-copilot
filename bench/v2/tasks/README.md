# Provisional pilot-v1 task draft

**provisional: true**  
**review_status: owner-review-pending**

This is a 30-task **development/review draft**, not an executed pilot, untouched
test set, independent ground truth, or paper evidence. No model inference,
simulation, Docker, Lean, or Comparator run was performed to prepare it.
`correct_final` names an author-proposed reference fixture, not a verified outcome.

## Contents and allocation

`pilot-v1.json` preserves the existing fixture array and core fields, adding
`track`, provisional labels, notes, formal targets, and selected wrong-answer
fixtures. `validate.mjs` is a local structural/reference consistency check;
`grade-absence.mjs` is a task-local, exact-prose smoke-test grader.

| Track ID | Content | Count |
| --- | --- | ---: |
| retrieval | Extraction smoke tests: exact document/locator and quotation | 6 |
| computation | Four exact numeric and two symbolic/domain tasks | 6 |
| formal | Fixed-statement, Init-only Lean proof candidates | 6 |
| error-detection | Validation smoke tests: five defective arguments and one valid control | 6 |
| absence | Scope smoke tests: five bounded absences and one hypothetical unavailable corpus | 6 |

Retrieval/absence/error tasks are **extraction/scope/validation smoke tests**, not
general search or free-form explanation grading. Retrieval prompts require copying
the supplied locator unchanged; narrower locators are not accepted. The BSD
version-note task asks for the body paragraph excluding the heading, while keeping
the supplied L19-L21 locator. All six error prompts neutrally ask whether the
argument is valid; their exact rubric labels and reference prose are unchanged.

Each of `geometry`, `algebra`, `analysis`, `number-theory`, `evidence`, and
`foundations` has **five tasks**, one per track. There are **12 negative cases**:
one empty integer solution set, five defective arguments, and six absence cases.
`negative` describes task content, not whether a submitted answer should fail.
All citation references are affirmative; the negative evidence cases are in the
absence track because the existing citation grader only accepts positive support.

These six labels are **provisional thematic families**, not independent groups,
validated statistical independence units, or the corpus's numbered manuscript families. Several tiny
Lean targets are definitionally related despite their different thematic labels.
Do not split this draft across development/validation/test and pretend those
labels prevent leakage. Keep the entire draft in development until independent
review groups manuscript revisions, paraphrases, direct equivalents and related
logical targets. Final family regrouping may change the six-by-five allocation.

The requested fifth track is deliberately the narrower absence/scope task set.
It does **not** cover the protocol's broader out-of-corpus mathematical explanation
track. Owner approval or additional tasks are needed before claiming full protocol
coverage; the protocol was not changed.

## Evidence and provenance

Source snapshot inspected: local `openai/math` checkout at
`4eaee87548250b2682affda7d05d947c05554bae`, on 2026-11-08, under
`C:\_Work\__OPENAI_MATH\math`. `math/` document identifiers are portable paths
relative to a corpus parent, not claims that the portable plugin repository
contains a tracked corpus. No full-repository scan was performed.

Six distinct exact excerpt ranges are embedded:

- `math/preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/build/sections/convex-preliminaries.tex`, L87-L93.
- `math/preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md`, L1-L5.
- `math/CONTENTS.md`, L75-L75 (quasi-Riemann catalogue paragraph).
- `math/preprints/Exact-Birch-Swinnerton-Dyer-Formula-from-Low-Selmer-Corank-October-7-2026/README.md`, L19-L21.
- `math/README.md`, L12-L12 (raw-research-data qualification).
- `math/lean/README.md`, L3-L4 (partial formalization coverage/build scope).

Bounded read/grep checks also inspected the corresponding manuscript READMEs
and nearby catalogue entries. Quotations of research claims establish what the
source says, not that its mathematics is correct. One excerpt comes from an
interior LaTeX section rather than first-page metadata; no PDF pagination or
released-PDF/source equivalence was verified. Links inside verbatim quotations
are not claims that every linked document was opened.

The five consulted-excerpt absence tasks use only their explicitly listed ranges.
Their answers say **not found in consulted excerpts**, never corpus-wide
nonexistence. No correct fixture uses `nonexistent`. The unavailable-corpus task
is explicitly hypothetical, not a statement about the local filesystem.
Elementary computation/error tasks are constructed problems with inspectable
derivations or counterexamples, not invented manuscript references.

## Grading and integration limitations

- Numeric answers have zero absolute/relative tolerance and fixed domains, units
  and conditions. Symbolic references include restrictions, assumptions, units
  and exact comparison metadata. All six computation tasks require `units` in the
  answer contract, grading metadata and reference final; the validator checks their
  consistency with the prompt and intended units. The algebra task now asks for an
  **equivalent expression preserving the original domain**, explicitly permitting
  an unsimplified expression. Its `allowed_denominators` remain `[[1],[-1,1]]`,
  consistent with equivalence rather than canonical simplification. The existing
  symbolic grader checks denominator classes up to nonzero scalar multiples and
  enforces registered units; literal denominator normalization is not requested.
  No existing grader was changed by this task.
- Error explanations preserve correct and plausible-wrong prose plus criterion
  booleans. `grading.labels` maps SHA-256 of exact UTF-8 prose to author-proposed
  scores, matching the current explanation grader. These are not independent
  human scores. Unregistered prose is not semantically graded; the current grader
  rejects it. Establish blinded human adjudication before accepting free prose.
  No LLM judge is used.
- Absence answers now require `prose:string` (not the legacy `text` field).
  The five bounded-absence references explicitly say **not found in consulted
  excerpts** and **The consulted inventory is non-exhaustive.** The unavailable
  scenario instead distinguishes unavailable evidence from an executed search.
  Each task retains the wrong-status fixture and adds
  `prose_variants.same_status_wrong_prose`, which preserves the correct status and
  consulted set but repeats a scored nonexistence overclaim. Frozen labels hash
  `prose` for absence tasks, and still hash `text` for error tasks.
- `grade-absence.mjs` checks status, consulted IDs and evaluator context before
  applying the exact-prose rubric. It is independent of the existing absence
  grader's prose keyword filters, which can reject explicit denials of global
  nonexistence. It rejects
  all six same-status/wrong-prose controls, missing `prose`, and unregistered prose.
  This is **not semantic explanation grading**: valid paraphrases need independent
  human adjudication, not an LLM judge. The bench grader enforces an excerpt-scope
  and global-claim heuristic, and the six reference/wrong pairs pass an
  integration test, but this task-local exact-prose helper is still not invoked
  by the runner.
  The adapter must separately supply consulted identifiers or the hypothetical
  unavailability context; the answer itself is not evidence of retrieval.
- Formal references provide `imports`, `theorem`, `expected_type`,
  `solution_code`, and `allowed_axioms` (empty), plus explicit not-run/pending
  statuses. They use only `Init` and do not need the archive's Lake dependencies.
  On 2026-11-08 all six reference solutions were compiled and proof-verified
  through the evaluator-controlled bridge (`bench/v2/verifiers/lean.mjs`) with
  real Docker, schema-2.1.0 envelopes, and no axioms; the formal grader accepted
  6/6. This is a local engineering smoke, not an independent kernel check or
  informal-correspondence review. Target and receipt identifiers in
  `correct_final` remain deliberately `null`; the runner must construct the
  fixed target spec and attach evaluator-issued receipts. Do not interpret a
  supplied candidate proof as a trusted receipt.
- The set is consumable by `bench/v2/study/run-study.mjs --dry-run`; execution is
  gated on a runtime-verified inventory. It is not wired into a real run.

## Validation

From the portable repository root:

```powershell
node bench/v2/tasks/validate.mjs
node bench/v2/tasks/validate.mjs --corpus "C:\_Work\__OPENAI_MATH\math"
```

The check enforces 30 tasks, six per track, unique IDs, one family per task,
one task per track/family cell, required fields, typed references, provisional
labels, formal target/solution consistency, exact-text rubric hashes and positive/
wrong label polarity. It also checks all six computation unit contracts and the
algebra equivalence/denominator contract, and runs the task-local absence grader against
the reference, wrong-status and same-status/wrong-prose fixtures. Missing prose,
legacy-text-only answers and missing evaluator context must fail. Public excerpts
may contain only document/locator/text;
guards reject recognizable private grader/answer fields in public text and
copied explanation/reference proofs. With `--corpus`, all embedded excerpt
occurrences must exactly match the specified local lines after CRLF normalization.

It does not prove mathematics, test a verifier, audit all semantic answer leakage,
establish independent review, or run a model/pilot. Reference-versus-key equality
checks cannot detect an answer key that is itself wrong. Expected source drift
must be reviewed, not silently repaired by this read-only validator.

## Required review and contamination gates

Before pilot use, the owner and an independent qualified reviewer must check
problem consistency, mathematical references, domains/restrictions, rubric labels,
negative cases, ambiguity, difficulty, family grouping, exact source snapshot,
licenses, and informal/formal correspondence. Verify all Lean candidates with an
evaluator-controlled fixed target and axiom policy; resolve the adapter gaps above.
Freeze the reviewed tasks, source hashes, rubric/adjudication policy and family map
before outcomes, and obtain separate execution/budget authorization.

Public elementary targets and public corpus excerpts may be in model training
data; overlap is unknown. Supplied excerpts make retrieval tasks closer to bounded
evidence selection/copying than open-ended search. Related retrieval/absence tasks
share excerpts, and broad family labels do not remove that dependence. Imported
Lean declarations and definitional equivalents may give immediate solutions.
These are contamination and difficulty limitations, not novel-proof evidence.

This file contains answer keys and reference proofs. Never mount the entire task
JSON or this directory in a resolving agent's workspace. Expose only a separately
sanitized prompt, answer contract and permitted excerpts (and the public fixed
statement/import policy for formal tasks); keep grading, notes, solutions, hashes
and wrong-answer fixtures evaluator-only. Do not reuse these exposed development
tasks as untouched confirmatory tests. They are **not paper evidence**.
