# External math benchmarks (v5)

Lightweight **exploratory, not confirmatory** paired capture and deterministic
grading. Independent of v4 admission code. No model judge, proof checker, Docker,
network client, external dependency, automatic retries, fallback, or resume.
Only `run.mjs` invokes OpenCode; that invocation can call a paid model and tools.
Importing any module does not execute its CLI.

## CLI contract

From the repository root, with an authenticated OpenCode CLI on PATH:

```text
node bench/v5/external/run.mjs --tasks <file> --model <provider/model> --condition plugin-on|plugin-off --out <fresh absolute dir> [--limit N] [--timeout-ms 300000] [--repeat 1]
node bench/v5/external/grade.mjs --run <run-dir> --tasks <same-file> --out <fresh absolute dir>
node bench/v5/external/report.mjs --grades <on-grades-dir/grades.json> --grades <off-grades-dir/grades.json> --out <fresh absolute dir> [--baseline <json>]
```

Run once per condition, with the **same tasks file, model, limit, timeout,
workspace, and repeat count**, into separate fresh directories. Grade each
capture separately, then combine the two grade files. No default model, task
file, or output directory. Numeric arguments must be positive integers; omit
`--limit` for all tasks. Order is file order, then repeat order, serially.

Every output directory must be absolute, nonexistent (even an existing empty
directory is refused), outside this repository, with an existing parent.
Symlink/junction parents resolving inside the repo are refused. Files are
write-exclusive. Existing artifacts are never modified by grading/reporting.

Workspace: `EXTERNAL_BENCH_WORKSPACE`, or `C:/_Work/__OPENAI_MATH`, for both
conditions. The executable resolver and spawning pattern follow the v3 runner:

```text
opencode run --model <model> --format json --standalone -- <task.prompt>
```

`shell:false`; the prompt is exactly one argv argument, with no instructions,
metadata, grading configuration, or answer appended. Tasks cannot supply CLI
flags. The v3 transport does not support stdin; OS command-line length limits,
NULs, CLI argv parsing bugs, and process-list visibility therefore remain.
There is no transport fallback. A direct-child timeout is not guaranteed
descendant cleanup; native/provider recovery is not controlled by this harness.

Both conditions preserve the same inherited environment except toolkit flags:

| Condition | `MATH_TOOLKIT_DISABLE` | `MATH_TOOLKIT_TOOLSET` |
|---|---|---|
| plugin-on | removed | removed |
| plugin-off | `1` | removed |

This leaves the workspace plugin active for ON and requests its disable switch
for OFF. It does not attest plugin loading or disable other plugins/built-in
tools. No configuration, credential, or safe-home files are copied. This is an
ordinary workspace runner, **not a sandbox or gold-isolation boundary**. Keep
gold-bearing task files outside the model workspace and do not grant the model
access to them. The runner never supplies their path in the prompt, but cannot
prevent an otherwise authorized tool from reading host files.

## Task schema

Input is a nonempty JSON array:

```json
[
  {
    "schema": "math-bench-task/v1",
    "benchmark": "example-benchmark",
    "id": "q1",
    "prompt": "Compute six times seven. Give your final answer.",
    "answer": "42",
    "grading": { "type": "integer" },
    "metadata": {
      "source": "public problem source",
      "license": "source license",
      "contest": "example",
      "year": 2026,
      "problem_number": 1,
      "url": "https://example.invalid/problem"
    }
  }
]
```

All top-level fields are required; `answer` may be null. `metadata` can be `{}`.
All objects have closed keys. Metadata text fields are nonempty strings; year
and problem number are safe integers. `benchmark`, `id`, and `prompt` must be
nonempty strings; `(benchmark,id)` is unique. Known graders: `integer`, `exact`,
`symbolic`. Optional `grading.answer` supplies evaluator gold when `answer` is
null; when both exist they must match exactly. Optional `grading.tolerance` must
be finite and nonnegative; **nonzero tolerances are refused**, because none of
these exact/bounded graders performs approximate numeric comparison.

Both gold fields are checked: an answer of trimmed length at least eight
embedded as a case-insensitive substring of the prompt causes refusal, not just
a warning. This is only a leakage heuristic; short answers and paraphrases
cannot be detected reliably. Nothing downloads tasks or determines their license.

## Captures and immutability

- `plan.json`: frozen schedule/configuration, written once before dispatch.
- `episodes/tN-rN.raw.json`: exact CLI stdout, normally JSON/NDJSON; may be
  malformed or partial on failure. Never discarded or truncated by serialization.
- `episodes/tN-rN.json`: final assistant text, status/failure, exit/signal/error,
  duration, stderr, usage and raw usage records. No gold or metadata.
- `manifest.json`: written once after the loop, with model/condition/workspace,
  raw task-file SHA-256, task IDs, prompt hashes, repeat/timeout, start/end,
  toolkit environment state, schedule/results, `exploratory:true` and
  `not_confirmatory:true`. The returned manifest is recursively frozen.

Process capture has the v3 64 MiB maxBuffer; overflow is a failed episode, not
a completed answer. Classes include timeout, spawn error, signal, nonzero exit,
invalid JSON, CLI error, and empty answer. No retries. Text is taken only from
assistant text events, selecting the last message ID; without IDs, the last text
event is used rather than combining possibly separate messages. Tool outputs,
reasoning, and user messages are not answers.

Step-finish token/cost fields are summed only with complete per-field coverage.
A single generic usage record is recognized; multiple generic records are
preserved but not summed because incremental vs cumulative semantics are unknown.
All original usage fields remain in capture records/raw JSON. Unknown totals
are null, never zero; reports include known subtotals and coverage.

If interrupted before final manifest creation, grading reads `plan.json` and
counts absent episode records as missing. Attempted means a recorded attempt,
so abrupt interruption can undercount actual dispatches. No resume is permitted.
Task file bytes must still match the manifest hash at grading time.

## Deterministic grading rules (`bounded-final-answer/v1`)

Only completed, exit-zero, nonempty, error-free answers are graded. Failed,
timed-out, absent, and empty answers are `missing`; their partial answers cannot
pass. Missing gold is `unparseable`, not incorrect.

Extraction uses the latest `\boxed{...}` or labeled `Final:`, `Final answer:`,
or `Answer:` line. Boxes support nested braces. Otherwise use the last nonempty
line. An unclosed box is unparseable. No prompt suffix is added to impose this
convention; public task prompts may already request a final answer.

- **integer:** last standalone signed integer in the extracted answer; compare
  using BigInt, not floating point. Decimal/fraction/scientific/power/grouped
  numeric notation is rejected as ambiguous rather than taking its last digit.
- **exact:** remove `$`, `\(`, `\)`, `\[`, `\]`; collapse whitespace, trim, and
  lowercase. Compare strings. Punctuation/algebra are not rewritten.
- **symbolic:** strip those delimiters, `\left`, `\right`, `\,`, `\!`, and
  whitespace. Maximum 512 characters. Bounded grammar: numeric literals,
  single-letter variables, explicit `+ - * / ^`, parentheses/braces, `\frac`,
  `\sqrt`, and `\pi`. No implicit multiplication, arbitrary commands, eval,
  numerical sampling, or general CAS. Identical canonical strings pass.
  Distinct plain integer literals can be incorrect; other nonidentical forms
  are **unparseable**, since equivalence/non-equivalence is not established.
  For example, `x+x` vs `2*x` is unparseable, not an incorrect mathematical answer.

Each episode has one of `correct`, `incorrect`, `unparseable`, `missing`, with a
reason and extracted answer. Solver claims of correctness are never a grade.
These rules evaluate final-answer agreement, not the validity of a derivation.

## Reports and external baselines

`grades.json` is a separate hash-bound grading artifact, including scheduled rows.
`report.json` and `report.md` show per-benchmark **and model** condition counts:
scheduled, recorded attempted, completed, correct, incorrect, unparseable,
missing, accuracy `correct/(correct+incorrect)` (null when none graded), and
pass rate `correct/scheduled`. Usage/cost has coverage and known subtotals.

Pair identity is `(model, benchmark, task_id, repeat)`. Pairing refuses differing
task-file hashes, workspace, timeout, repeat configuration, prompt hash, or
grading rules; duplicate conditions are refused rather than pooled. Different
task subsets yield explicit unmatched slots. Matched slots split into both
correct, ON-only correct, OFF-only correct, neither correct, and ungraded
(either side unparseable/missing). Ungraded never silently becomes neither.

Optional baseline JSON is an array of closed objects:

```json
[
  {
    "benchmark": "example-benchmark",
    "model": "external/model",
    "score": "80%",
    "source": "registered result URL or citation",
    "notes": "different version, sample, and scoring protocol"
  }
]
```

`notes` is optional. Score may be a finite number or nonempty string and is
displayed verbatim; units are not inferred. Entries are a separate
`external_baseline` column/table and JSON field, never pooled with captured
results. Entries for benchmarks absent from captures remain in the baseline
table.

Every report states: exploratory/not confirmatory; one repeat by default;
model/version drift and uncontrolled condition ordering; external baselines
not apples-to-apples; retrieval-assisted reproduction not distinguished unless
the task says so. Baseline provenance is supplied, not independently attested.
No result implies the plugin improves general mathematical accuracy.

## Hermetic validation

```text
node --test bench/v5/external/tests/external.test.mjs
node --check bench/v5/external/schema.mjs
node --check bench/v5/external/run.mjs
node --check bench/v5/external/grade.mjs
node --check bench/v5/external/report.mjs
```

Tests inject the runner, grader, clock, environment, and in-memory filesystem.
They do not write fixtures to disk or call a model, Docker, or the network.
