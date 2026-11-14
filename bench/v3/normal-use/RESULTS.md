# Normal-use studies — corrected evidence record

Seven preserved studies contain **114 completed outputs**, not 114 verified answers. Usage is known for **92/114** episodes and missing for **22**. The observed subtotals are **1,741,289 tokens** and **$0.390200076**; these are not complete billing totals.

There are **75 recorded legacy scores and 39 blank scores**. Reviewer provenance is unavailable (assistant/model adjudication per conversation); none is authenticated human review. The earlier v1 claim of an independent second reviewer has no saved provenance. Historical experiments and their original reports remain preserved, but their scores must not be described as verified mathematical accuracy.

## Preserved figures with coverage

Full = `plugin-on`; minimal = `plugin-on-minimal`; off = `plugin-off`. Scores below are recorded ones/number scored, not proof-verification rates. Usage columns are known subtotals even when coverage is complete; provider-reported cost is not a billing reconciliation.

| Study / model | Condition | Recorded score | Usage known/episodes | Token subtotal | USD subtotal |
| --- | --- | --- | ---: | ---: | ---: |
| v1 / DeepSeek | full | 6/6 | 4/6 | 90,055 | 0.017765862 |
| v1 / DeepSeek | off | 6/6 | 4/6 | 66,997 | 0.012452910 |
| v2 / DeepSeek | full | 6/6 | 4/6 | 69,092 | 0.012085176 |
| v2 / DeepSeek | minimal | 6/6 | 6/6 | 72,584 | 0.013240860 |
| v2 / DeepSeek | off | 6/6 | 3/6 | 49,263 | 0.008467524 |
| v3-original / GLM | full | unreviewed (6 blank) | 5/6 | 74,009 | 0.014609310 |
| v3-original / GLM | minimal | unreviewed (6 blank) | 5/6 | 68,086 | 0.012623080 |
| v3-original / GLM | off | unreviewed (6 blank) | 3/6 | 40,069 | 0.008728210 |
| v3b / GLM | full | 6/6 | 4/6 | 44,943 | 0.010136570 |
| v3b / GLM | minimal | 6/6 | 3/6 | 22,493 | 0.005237730 |
| v3b / GLM | off | 6/6 | 3/6 | 49,510 | 0.009756930 |
| v4-hard / DeepSeek | full | 2/2 | 2/2 | 32,522 | 0.006216606 |
| v4-hard / DeepSeek | minimal | 2/2 | 2/2 | 47,004 | 0.009954894 |
| v4-hard / DeepSeek | off | 1/2 | 2/2 | 55,330 | 0.011504496 |
| v5-hard / DeepSeek | full | 7/7 | 7/7 | 104,473 | 0.019818528 |
| v5-hard / DeepSeek | minimal | 7/7 | 7/7 | 80,512 | 0.018481908 |
| v5-hard / DeepSeek | off | 1/7 | 7/7 | 331,463 | 0.068417892 |
| v6-hard / GLM | full | unreviewed (7 blank) | 7/7 | 89,197 | 0.019998010 |
| v6-hard / GLM | minimal | unreviewed (7 blank) | 7/7 | 118,464 | 0.024285600 |
| v6-hard / GLM | off | unreviewed (7 blank) | 7/7 | 235,223 | 0.086417980 |

The original GLM date prompt was ambiguous; v3b disambiguated it. Both studies remain in this inventory rather than silently dropping v3-original. Mean durations, lexical tool counts, task identities, and repeat identities are retained in the corrected per-study reports.

## What the hard studies establish—and do not

- v5's historical **7/7, 7/7, 1/7** used six plugin-specific receipt requirements and condition-derived scoring. This mechanically disadvantaged off; it is not evidence of a mathematical accuracy benefit. v4's **2/2, 2/2, 1/2** also includes a plugin-receipt requirement. Earlier prose claimed an independent Docker check; this artifacts-only audit does not authenticate that claim from the saved episode records.
- AI inspection covered all **42 v5/v6 answers** separately from the recorded scores. All **36 formal answers contain plausible proof terms by inspection**, not newly compiled or verified proofs. **35** have fenced Lean blocks; v6 off/add-zero is an inline-only waiting recap and an incomplete standalone deliverable.
- The formal answers contain **24 receipt assertions** and **12 explicit receipt-unavailable statements**. **No authentic tool receipts are preserved** in these saved artifacts. This does **not** establish that receipts never existed. An assertion, observed receipt, proof verification, and answer-by-inspection are distinct evidence categories.
- All **six PDF answers reference-match** the released Hanner PDF, page 6: “The polar of a linear Hanner body is again a linear Hanner body.” The supplied code-reviewer audit inspected the root PDF. This establishes manuscript reference matching, not independent verification of the manuscript's mathematics.
- v6 off/implications and off/conjunction incorrectly name `math_lean_check` as a strict receipt producer. v5 off/implications and off/true use incorrect receipt status vocabulary. v5 off's recorded `math_status` entry is a lexical reference, not successful tool evidence.
- v6 has **21 completed outputs and 21 blank reviews**. Inspection did not fill its `review.csv` or create replacement proof grades.

## Interpretation and artifacts

These are small, exploratory, single-repeat studies with different prompts/models, incomplete usage, unauthenticated legacy scoring, and a biased receipt requirement. They support neither a general mathematical benefit claim nor percentage billing-efficiency claims. Plugin-off disabled this toolkit, not every OpenCode plugin or built-in tool.

Original directories remain under `C:\Users\MiPC\AppData\Local\Temp\opencode\normal-use-*`; their manifests, episodes, reviews, summaries, and historical reports were not rewritten. Corrected outputs are separate under `...\normal-use-evidence-audit-20261111\`: `audit.json`, `audit.md`, and seven per-study `report.json` / `report.md` pairs. See [EVIDENCE-AUDIT.md](EVIDENCE-AUDIT.md) for source hashes, paths, and limitations.
