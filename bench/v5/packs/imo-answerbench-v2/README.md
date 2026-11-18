# IMO-AnswerBench v2 pack

Offline conversion of all 400 rows of `imobench/answerbench_v2.csv`, in CSV order.
Data: **CC-BY-4.0**; software: **Apache-2.0**. Original attribution is retained in
each task's `metadata.source_text` (the CSV `Source`); category and subcategory
are metadata only. `metadata.source` identifies the source dataset/file.

## Rebuild and test

From the repository root:

```powershell
node bench/v5/packs/imo-answerbench-v2/build.mjs
node --test bench/v5/packs/imo-answerbench-v2/tests/imo-pack.test.mjs
node --check bench/v5/packs/imo-answerbench-v2/build.mjs
```

The builder defaults to the supplied local CSV:
`C:/Users/MiPC/AppData/Local/Temp/opencode/math-benchmarks-20261117/imobench/answerbench_v2.csv`.
Pass a local CSV path as the first argument to use a relocated byte-identical copy.
No network, model, Docker, or third-party package is used. Tests use the generated
pack, synthetic CSV fixtures, and the original local CSV to verify the repair
and compare all unaffected records.

CSV SHA-256:
`275877a9d988d85278fad3a5f8a41d7f83393a60bf259531ec0a5161e6b21cf9`.
The builder checks this hash before conversion, validates all rows before writes,
and emits deterministic two-space JSON with a trailing newline. It writes only
`tasks.json`, `pilot.json`, `baselines.json`, `repairs.json`, and `review.json`
next to the builder. Its stdout
records input/output hashes, counts, distributions, and pilot IDs.

## Authorized repair

Only `imo-bench-algebra-036` (physical lines 150–154) is repaired in memory.
Insert one closing double quote immediately after the Problem's final `\]`,
before the newline. Because the next physical line starts with the comma
separating Problem and Short Answer, the parser treats that post-quote newline
as a record continuation **only for this repaired row**. The Problem ends at
`\]`, without a trailing newline. All other fields retain their original text.
The source CSV is never rewritten.

`repairs.json` records schema `math-bench-repairs/v1`, the original CSV SHA-256,
and exactly one entry with row ID, line range, action, original excerpt, and
repaired excerpt. The build verifies the six repaired fields, all 400 non-empty
Short Answer fields, and equality of every other parsed row. Since the original
full CSV is malformed, the before comparison parses its untouched prefix and
suffix with only the malformed record excluded, then compares those 399 rows
against the repaired parse. No other row is repaired.

## Conversion and rejection

Tasks use `math-bench-task/v1`. The prompt preserves the decoded CSV `Problem`
field exactly, followed by two newlines and:

> Solve the problem. Put the final answer on its own last line in the form: FINAL: &lt;answer&gt;.

Only the trimmed `Short Answer` is placed in `answer` and `grading.answer`.
The grading type is `symbolic` for any backslash, caret, underscore, comma, or
more than one equals sign; otherwise it is `exact`. This is a routing label,
not a claim that arbitrary LaTeX or multipart answers can be compared reliably.
The grading note explicitly requires an unparseable outcome when comparison
is not confident.

Leakage normalization is Unicode NFKC followed by whitespace collapsing and
trimming, applied to both prompt and answer; case and LaTeX syntax are preserved.
A normalized answer of at least eight characters appearing as a verbatim
substring of its normalized Problem sets `metadata.answer_in_prompt=true`
and `metadata.review_note`; the task is retained and listed in `review.json`.
Short numeric/LaTeX overlaps are not rejected. Explicit `FINAL:` lines,
"the answer is <answer>" phrases, and solution/answer sections containing the
full answer are rejected. Checks run on the Problem, not the appended output
instruction. Empty problems/answers,
empty/duplicate IDs, malformed CSV, and unexpected columns also reject the build.
Rejection fails the build rather than silently dropping rows: all 400 must pass.

This source produces 400 tasks (100 each: Algebra, Combinatorics, Geometry,
Number theory); 260 use exact grading and 140 symbolic. Only
`imo-bench-number_theory-005` is flagged for review.

## Deterministic pilot

Group tasks by category, retaining CSV order within each group. Rank categories
by descending task count, then ascending category name using code-point order
(no locale-dependent comparison). Select the first four categories, taking
up to ten tasks per category. For a category of size `n` and sample size
`k = min(10, n)`, select zero-based positions
`floor(i * (n - 1) / (k - 1))` for `i = 0 .. k - 1`; if `k = 1`, select position
zero. This spans both endpoints with evenly spaced positions. Pilot order is
category-rank order, then sampled CSV order. The builder requires exactly 40 tasks.

## Baseline

`baselines.json` contains no external scores or invented numbers. Use the paired
plugin-off arm for `opencode-go/deepseek-v4.1-flash`; external leaderboard results
are not apples-to-apples. This pack creation does not execute or score any model.
