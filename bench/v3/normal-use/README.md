# Normal-use evaluation

This exploratory track records free-form outputs in ordinary OpenCode sessions, not the strict A/B/F contract. Conditions are full `plugin-on`, six-tool `plugin-on-minimal`, and `plugin-off` (`MATH_TOOLKIT_DISABLE=1`). Off disables this toolkit, not all other plugins or built-in tools. The normal workspace was `C:\_Work\__OPENAI_MATH`.

## Evidence status

See [RESULTS.md](RESULTS.md) and [EVIDENCE-AUDIT.md](EVIDENCE-AUDIT.md): **114 completed outputs; 92 usage-known, 22 usage-missing; 75 recorded legacy scores, 39 blank**. Legacy reviewer provenance is unavailable (assistant/model adjudication per conversation), not authenticated human review. Completion, answer validity, receipt assertion, observed receipt, and proof verification must be reported separately.

v5's 7/7, 7/7, 1/7 is a biased plugin-receipt comparison, not mathematical accuracy. v6's 21 outputs are complete and AI-inspected but remain unreviewed in the preserved score sheet. No authentic receipts are preserved for the 36 formal v5/v6 answers; absence from saved artifacts does not establish that none existed. No general mathematical benefit or billing-efficiency claim follows.

## Runner artifacts

The runner writes `manifest.json`, `episodes.jsonl`, `summary.json`, `review.md`, and `review.csv`. Review scores begin blank; recording a score does not authenticate a reviewer. Existing `summary.json` and older `report.*` files are historical, may treat unknown usage as zero, and may label scores as human review. Keep them unchanged and use separate corrected reports.

Model execution is a separate opt-in operation (`NORMAL_USE_ALLOW_EXECUTE=1` and `npm run normal:run -- --model <provider/model> --out <fresh-study>`). The audit/report commands below are **local artifacts-only**: no model calls, APIs, Lean execution, or rescoring.

## Corrected reporting

```powershell
node bench/v3/normal-use/report-normal.mjs --out <source-study> --report-out <fresh-report-directory>
node bench/v3/normal-use/audit-normal.mjs --artifacts-root C:/Users/MiPC/AppData/Local/Temp/opencode --out <fresh-audit-directory>
node --test bench/v3/normal-use/tests/audit.test.mjs
```

The report builder is exported and pure. CLI `--report-out` is required and must be fresh. Existing reports are never overwritten. CSV validation rejects duplicate/orphan reviews, malformed/nonbinary scores, and ambiguous repeated task/condition reviews without a repeat identity. New review rows should use `study_id,task_id,condition,repeat_id,score,notes` (an optional `status` must match the episode). A missing or blank review remains unreviewed; there is no condition-derived score.

`normal-use-report/v2` retains each `(study_id, task_id, repeat_id)` in `tasks`, with per-condition entries. Condition metrics use `review_scored`, `review_correct`, `review_score_rate`, and `review_provenance: legacy_unattributed`, not `human_*`. `tokens` and `cost_usd` are null when their respective coverage is incomplete; known subtotals and joint usage-known/missing counts remain visible. Tool counts retain recorded lexical references and do not certify successful tool execution. No authenticated receipt is assumed.

The seven-study audit validates saved fields and expected coverage, hashes source files, and adds a separate explicit answer-by-answer AI-inspection table for v5/v6. Those annotations are bound to the inspected episode hashes and never replace legacy scores. It writes `audit.json`, `audit.md`, and one corrected report pair per study. The completed audit is at `C:\Users\MiPC\AppData\Local\Temp\opencode\normal-use-evidence-audit-20261111`; reruns require another fresh directory.
