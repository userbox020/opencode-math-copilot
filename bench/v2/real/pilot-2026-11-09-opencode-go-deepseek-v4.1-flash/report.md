# Evaluation report

Study: real-opencode-go-deepseek-v4.1-flash-2026-11-09
Started: 90; terminal records: 90; expected: 90.
Missing expected: 0; pending started: 0.

Primary: correct under budget / all started (no failure or negative-case exclusions).

| Condition | Correct / started | Rate |
|---|---:|---:|
| A | 18 / 30 | 60.00% |
| B | 15 / 30 | 50.00% |
| F | 14 / 30 | 46.67% |

Main paired contrast F−B: -0.03333333333333333; exploratory 95% family-bootstrap CI: [-0.1, 0].
Seed 20261108; 10000 resamples; 6 families. Repetitions are not independent tasks.

## Per-model and per-domain rates

| Breakdown | A | B | F |
|---|---:|---:|---:|
| opencode-go/deepseek-v4.1-flash | 18/30 | 15/30 | 14/30 |
| convex geometry | 1/1 | 1/1 | 1/1 |
| bibliography of algebra | 1/1 | 0/1 | 1/1 |
| analytic number theory | 1/1 | 1/1 | 1/1 |
| bibliography of number theory | 1/1 | 1/1 | 0/1 |
| evidence limitations | 1/1 | 1/1 | 1/1 |
| formalization coverage | 1/1 | 0/1 | 1/1 |
| Euclidean geometry | 1/1 | 0/1 | 0/1 |
| real algebra | 1/1 | 1/1 | 0/1 |
| real integration | 1/1 | 1/1 | 1/1 |
| integer equations | 1/1 | 0/1 | 1/1 |
| exact proportions | 1/1 | 1/1 | 0/1 |
| finite sets | 0/1 | 1/1 | 0/1 |
| equality of natural-number coordinates | 1/1 | 1/1 | 1/1 |
| natural-number arithmetic | 1/1 | 1/1 | 1/1 |
| composition of implications | 1/1 | 1/1 | 1/1 |
| closed natural-number arithmetic | 1/1 | 1/1 | 1/1 |
| conjunction of evidence propositions | 1/1 | 1/1 | 1/1 |
| propositional truth | 1/1 | 1/1 | 1/1 |
| Euclidean triangle conditions | 0/1 | 0/1 | 0/1 |
| cancellation hypotheses | 0/1 | 0/1 | 0/1 |
| limits and finite sums | 0/1 | 0/1 | 0/1 |
| primality | 0/1 | 0/1 | 0/1 |
| verification evidence | 0/1 | 0/1 | 0/1 |
| quantifier order | 0/1 | 0/1 | 0/1 |
| bounded geometry evidence | 1/1 | 1/1 | 1/1 |
| bounded algebra bibliography | 0/1 | 0/1 | 0/1 |
| bounded analytic claims | 0/1 | 0/1 | 0/1 |
| bounded version evidence | 0/1 | 0/1 | 0/1 |
| bounded collection policy | 0/1 | 0/1 | 0/1 |
| unavailable evidence scenario | 0/1 | 0/1 | 0/1 |

## Exclusions and limitations

- all_started_metric: None. Negative cases, extraction failures, operational failures and pending started episodes remain in the denominator; unknown monetary cost is not under budget.
- not_started: 0
- paired_contrast: Only B/F cells with both starts are paired. Pending starts score zero; unpaired cells are enumerated as excluded from contrast only.
- Blind explanation scoring recognizes only pre-scored fixture texts; symbolic checking is a bounded registered integer-polynomial/solution-set checker.
- Bootstrap resamples whole task families, retaining repetitions and paired conditions; CIs are exploratory, especially with few families.

Full model × domain breakdown, missing composite keys, and provenance hashes are in report.json.
