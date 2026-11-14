# Normal-use evidence audit — 2026-11-11

## Scope and provenance

Local artifacts only: seven studies, **114 episodes / 114 completed outputs**. No new Lean checks, model/API calls, or proof grades. Original manifests, episode ledgers, reviews, summaries, and historical reports remain unchanged. Source SHA-256 hashes and evidence paths are recorded in the generated `audit.json` and `audit.md`.

The 75 populated legacy scores have unavailable reviewer provenance (assistant/model adjudication per conversation); no authenticated human review is established. The previously alleged v1 second-review provenance was not saved. The remaining **39 scores are blank**: 18 v3-original and 21 v6. Inspection is not a replacement review sheet.

## Coverage

Order within each row is full / minimal / off; `—` means that condition was not run.

| Source directory | Episodes | Usage known/total by condition | Scored / blank |
| --- | ---: | --- | ---: |
| normal-use-v1 | 12 | 4/6 / — / 4/6 | 12 / 0 |
| normal-use-v2-minimal | 18 | 4/6 / 6/6 / 3/6 | 18 / 0 |
| normal-use-v3-glm | 18 | 5/6 / 5/6 / 3/6 | 0 / 18 |
| normal-use-v3b-glm | 18 | 4/6 / 3/6 / 3/6 | 18 / 0 |
| normal-use-v4-hard | 6 | 2/2 / 2/2 / 2/2 | 6 / 0 |
| normal-use-v5-hard-deepseek | 21 | 7/7 / 7/7 / 7/7 | 21 / 0 |
| normal-use-v6-hard-glm | 21 | 7/7 / 7/7 / 7/7 | 0 / 21 |

Usage known: **92**, missing: **22**. Observed subtotals: **1,741,289 tokens, $0.390200076**, not complete billing. See [RESULTS.md](RESULTS.md) for per-condition subtotals. All expected counts matched the artifacts; no missing values were converted into measured zero usage.

## Answer evidence is not receipt evidence

The supplied code-reviewer AI inspection covered all **42 v5/v6 answers**. The audit encodes an explicit per-answer annotation table, bound to these `episodes.jsonl` SHA-256 values:

- v5: `782b1de41f7d7d3ecef3be42240c1519eae824e7cba60f73bd0ddddac9346bbe`
- v6: `826d2c9df07a310e5ee71b0721fcb8be30cbcf710f59dedba896dd4b97bade3e`

Findings:

- **36 plausible formal proof terms by AI inspection**, no fresh compilation or verification. There are **35 fenced Lean blocks**; v6 off/add-zero is an inline-only waiting recap, an incomplete standalone deliverable despite its plausible term and `completed` output status.
- **24 assertions of a receipt**, **12 explicit receipt-unavailable statements**, **0 authentic tool receipts preserved**. The records retain final answers and lexical tool names, not authenticated receipt payloads. Do not infer that receipts never existed.
- **Six PDF reference matches** to the released root `preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/paper.pdf`, page 6: “The polar of a linear Hanner body is again a linear Hanner body.” The supplied reviewer inspected that PDF. This is a manuscript-reference match, not theorem verification.
- v6 off/implications and off/conjunction misidentify `math_lean_check` as a strict receipt producer; that tool is compilation-only. v5 off/implications and off/true use incorrect receipt status vocabulary.
- v5 off's `math_status` count is a lexical reference, not successful tool evidence.

v5's recorded 7/7, 7/7, 1/7 reflects six plugin-receipt requirements and condition-derived scoring, not mathematical accuracy. This audit preserves those figures without treating the off penalty as proof failure. There is no supported general mathematical-benefit or percentage billing-efficiency claim.

## Generated artifacts and report contract

Audit root: `C:\Users\MiPC\AppData\Local\Temp\opencode\normal-use-evidence-audit-20261111`.

- `audit.json`: source hashes/paths, coverage, and all 42 AI annotations with episode identities, source lines, and answer hashes.
- `audit.md`: readable coverage and inspection tables, source hashes/paths.
- Each of the seven source-directory names above has a subdirectory containing corrected `report.json` and `report.md`.

Reports use `normal-use-report/v2`. `conditions[condition]` exposes episodes, completed, operational/extraction failures, mean duration, nullable token/cost totals, known subtotals, usage coverage, recorded review coverage/correct/rate, `review_provenance: legacy_unattributed`, and recorded tool counts. `tasks` preserves study/task/repeat identities and per-condition review state. Blank scores remain `null`/`unreviewed`. Output status, inspection validity, receipt assertions, preserved receipt evidence, and proof verification are separate.

The CLI refuses existing output. It rejects duplicate/orphan review IDs, ambiguous legacy reviews for repeated episodes, malformed CSV/nonbinary scores, invalid episode fields, and changed v5/v6 inspection-source hashes. It never edits `review.csv`, old reports, or raw episode artifacts. Reproduce with the commands in [README.md](README.md), using a new output directory.
