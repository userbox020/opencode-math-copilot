# MathArena 2026 pack

146 tasks in `math-bench-task/v1` format, ordered by contest then numeric
problem number: AIME 2026 (30), HMMT February 2026 (33), BRUMO 2025 (30),
SMT 2025 (53). The benchmark name is a pack identifier; it does not imply
that every contest occurred in 2026.

## Rebuild and validate

From the repository root:

```powershell
node bench/v5/packs/matharena-2026/build.mjs
node --test bench/v5/packs/matharena-2026/tests/matharena-pack.test.mjs
node --check bench/v5/packs/matharena-2026/build.mjs
```

The default read-only input directory is
`C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\matharena`.
An alternate directory containing the same checksum-pinned snapshots can be
passed as the builder's sole positional argument. Tests use the default input
directory. No downloads, model calls, Docker, or external dependencies are used.
The builder writes only `tasks.json`, `pilot.json`, and `review.json` beside
itself, with deterministic two-space JSON indentation and a trailing LF.

## Provenance

Inputs are supplied Hugging Face datasets-server responses (`rows[].row`).
Source metadata identifies each supplied snapshot rather than asserting an
unverified upstream URL. The responses do not include licensing information:
`metadata.license` records **Not specified in supplied raw response**.
This is not a license grant; upstream licensing must be established before
redistribution. No external license or leaderboard lookup was performed.

| Raw snapshot | SHA-256 |
| --- | --- |
| `aime_2026.rows.json` | `9c9173d4ad201ade936a993d0899f914521dd42657a6f418f2aad3d118a358a2` |
| `hmmt_feb_2026.rows.json` | `26fec94fb258cabecda67ab20ff3f4838f815cfbe930108af6aff7fd622e87d2` |
| `brumo_2025.rows.json` | `0f5f81433e3b2276e0ee2a7ec9beab5fe7dbd850be8e36542624cb7babd8061e` |
| `smt_2025.rows.json` | `843497f36a7f516db9786c8c674a2ff0ab95524dfb30022bbbd3cb5dda0d3748` |

The builder checks these hashes before normalization.

## Normalization and review

- IDs use contest slugs (`aime-2026`, `hmmt-feb-2026`, `brumo-2025`,
  `smt-2025`) and the two-digit source problem number. Metadata uses those
  same contest slugs and preserves `problem_type` when present.
- Prompts preserve the entire original problem verbatim, then append two
  newlines and:
  `Solve the problem. Put the final answer on its own last line in the form: FINAL: <answer>.`
  No source titles, answers, or metadata are appended.
- `answer` preserves the trimmed source answer string. Integer grading removes
  conventional thousands separators and allows negatives. Thus `1,234` is an
  integer but `13,14,18` is a list. Otherwise expressions containing `\frac`,
  `\sqrt`, `^`, multiple equals signs, or top-level comma-separated pieces use
  symbolic grading; remaining strings use exact grading.
- Case-insensitive verbatim normalized-answer matches of length at least eight
  in the original problem set `metadata.answer_in_prompt: true` and
  `metadata.review_note`. They are retained, not rejected. `review.json` lists
  their IDs and reasons. `brumo-2025-13` is flagged because `\frac{1}{3}` is
  both a legitimate problem-statement bound and the supplied answer.
- Empty problems and explicit disclosures (a `FINAL:` line, an answer-is
  phrase containing the answer, or a solution/answer section containing it)
  are rejected. These checks examine the original source, not the appended
  response-format instruction. No supplied task is rejected.

## Deterministic pilot

For each contest, sort by numeric problem number, then select ten zero-based
indices `Math.round(i * (n - 1) / 9)` for `i = 0, ..., 9`, where `n` is that
contest's task count. This includes both endpoints and distributes selections
as evenly as integer indices allow. Concatenate contests in pack order.
`pilot.json` contains the full 40 selected task objects, not just IDs.

## Baselines

`baselines.json` records the requested exact model identifier and an empty
external-score list. It contains no invented baseline numbers; use the paired
plugin-off arm. Its supplied note is not an independently verified leaderboard
search result.
