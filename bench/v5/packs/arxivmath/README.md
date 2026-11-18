# arxivmath closed-book pack

103 tasks in supplied MathArena snapshot row order; a deterministic 20-task pilot.
This is a **declared closed-book** pack (`metadata.retrieval_assisted: false`).
No source papers are supplied or downloaded. An open-book/retrieval-assisted
track would require a different snapshot and is out of scope.

## Snapshot and conversion

- Input: `arxivmath.rows.json`, schema `matharena-arxivmath-rows/v1`.
- Input SHA-256: `c2e38ed7e0be498d9d48df4f0a4fd17360322251eb5bd95a3085a23bdff2b22e`.
- `build.mjs` defaults to the supplied local snapshot path; pass another local
  path to the identical bytes as its only argument. A different hash is rejected.
- IDs: `arxivmath-<competition-month>-<problem_idx padded 3>`, for example
  `arxivmath-january-001`. Source indices restart each month, so IDs must be
  competition-scoped. Original indices remain in `metadata.problem_number`.
- Prompts preserve the exact problem text, followed by two newlines and the
  specified FINAL instruction. Answers and source metadata are not appended.
- Answers are trimmed strings. Grading is symbolic for `\frac`, `\sqrt`, `^`,
  multiple equals signs, or commas; otherwise exact. This classification does
  not assert that every symbolic answer can be parsed or confidently compared.
- `metadata.source` and `metadata.arxiv_id` are `String(source)`; no source-ID
  precision absent from the snapshot is reconstructed.
- Empty source problem types become `["unspecified"]`; nonempty types are kept.
  The supplied snapshot does not specify a license, so metadata explicitly
  records that uncertainty. No contest year is inferred.
- Short numeric/LaTeX answer occurrences are allowed. Long normalized answer
  occurrences are flagged, not rejected, with `answer_in_prompt` and
  `review_note`. Normalization applies NFKC, lowercasing, removes whitespace,
  math delimiters, `\left`/`\right`, and LaTeX spacing commands. Raw matches of
  answers of length at least eight are also flagged for shared-schema parity.
  Explicit FINAL lines, “the answer is” followed by the answer, and solution
  sections containing the full answer are rejected before outputs are written.
  The appended FINAL instruction is not source disclosure.

## Pilot and audit

Competitions are ordered by count descending, then name ascending: February
(32), March (31), January (23), December (17). Within each competition, tasks
are sorted by `problem_idx`; five endpoint-inclusive positions are selected
using `Math.round(i * (n - 1) / 4)`. The pilot preserves that grouped order.

`review.json` records the input SHA-256, task/pilot counts, grading distribution,
flagged IDs, and SHA-256 of the exact UTF-8 `tasks.json` and `pilot.json` bytes.
Empty flags mean no long-answer occurrence was detected, not independent
mathematical review. Outputs use two-space JSON indentation and a final newline,
with no timestamps or machine-specific paths. Rebuilding overwrites only the
four generated JSON files in this directory.

`baselines.json` contains no numeric score. It preserves the requested external
baseline caveat for `opencode-go/deepseek-v4.1-flash`; no new literature search,
model execution, or empirical scoring was performed to build this pack.

## Local rebuild and verification

From the repository root:

```powershell
node bench/v5/packs/arxivmath/build.mjs
node --check bench/v5/packs/arxivmath/build.mjs
node --test bench/v5/packs/arxivmath/tests/arxivmath-pack.test.mjs
```

The builder validates tasks with `bench/v5/external/schema.mjs`; tests additionally
call its `readTasks` on both full and pilot files. Tests use only local artifacts
and synthetic cases. No model calls, network requests, or Docker are involved.
