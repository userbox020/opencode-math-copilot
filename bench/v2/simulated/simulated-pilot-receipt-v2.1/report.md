# SIMULATED pilot — no real-model results

Study: simulated-pilot-v2-receipt-2.1
Started: 48; terminal records: 48; expected: 48.
Missing expected: 0; pending started: 0.

Primary: correct under budget / all started (no failure or negative-case exclusions).

| Condition | Correct / started | Rate |
|---|---:|---:|
| A | 2 / 16 | 12.50% |
| B | 12 / 16 | 75.00% |
| F | 14 / 16 | 87.50% |

Main paired contrast F−B: 0.125; exploratory 95% family-bootstrap CI: [-0.25, 0.5].
Seed 20260101; 2000 resamples; 3 families. Repetitions are not independent tasks.

## Per-model and per-domain rates

| Breakdown | A | B | F |
|---|---:|---:|---:|
| simulated-model-a | 2/8 | 8/8 | 8/8 |
| simulated-model-b | 0/8 | 4/8 | 6/8 |
| arithmetic | 2/4 | 4/4 | 3/4 |
| algebra | 0/4 | 2/4 | 4/4 |
| evidence | 0/8 | 6/8 | 7/8 |

## Exclusions and limitations

- all_started_metric: None. Negative cases, extraction failures, operational failures and pending started episodes remain in the denominator; unknown monetary cost is not under budget.
- not_started: 0
- paired_contrast: Only B/F cells with both starts are paired. Pending starts score zero; unpaired cells are enumerated as excluded from contrast only.
- SIMULATED fixture outcomes only; no inference, real corpus, Lean compilation or Docker execution.
- Three task families and four pilot tasks. Formal and explanation graders are exercised by tests, not this pilot.
- Simulation durations, clock and estimated zero cost are fixture accounting, not measured performance or price estimates.
- Blind explanation scoring recognizes only pre-scored fixture texts; symbolic checking is a bounded registered integer-polynomial/solution-set checker.
- Bootstrap resamples whole task families, retaining repetitions and paired conditions; CIs are exploratory, especially with few families.

Full model × domain breakdown, missing composite keys, and provenance hashes are in report.json.
