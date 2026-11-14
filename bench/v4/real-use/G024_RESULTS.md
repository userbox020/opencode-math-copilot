# G024 complete workflow study — 20/20 delivered

**Status: complete run, exploratory, not confirmatory.** All twenty scheduled
episodes completed over the stdin transport with validated owned native receipts,
complete platform accounting, and zero operational failures. The correctness
figures below are model-reviewed and checker-backed, not human-adjudicated.

## Deliverable

| Measure | Value |
|---|---:|
| Scheduled / attempted / completed | 20 / 20 / 20 |
| Operational failures | 0 |
| Setup failures | 0 |
| End-to-end delivery | 20/20 (1.00) |
| Main first-pair checkpoint | passed (nine checks) |

## Final correctness

| Measure | Value |
|---|---:|
| Reviewed | 20 |
| Pass | 20 |
| Fail | 0 |
| Unscorable | 0 |
| Pass rate | 20/20 (1.00) |

- plugin-on: 10/10; plugin-off: 10/10.
- Pairs: **10 both, 0 ON-only, 0 OFF-only, 0 neither**; none ungraded.

All four Lean submissions were accepted by the evaluator-owned checker under the
frozen import/axiom policy.

## How the score moved — every step is a tooling correction, not a re-run

The run was never re-executed. The same twenty answers were graded four times as
evaluation defects were found and fixed. Each step is preserved on disk.

| Stage | Pass / fail / unscorable | What changed |
|---|---|---|
| A. Independent two-pass, no checker | 15 / 1 / 4 | Baseline; Lean unscorable without receipts |
| B. Checker enabled | 18 / 1 / 1 | 3 Lean proofs accepted |
| C. Packet reference corrected | 19 / 0 / 1 | `compilation-scope-evidence` reference restored to the full L9; adjudicated pass |
| D. Target-aware extraction | **20 / 0 / 0** | The last answer quotes the broken example and the fix as two Lean blocks; selection by the frozen target name resolved it |

Directories: `evaluation-prechecker/` (A), `evaluation-checker-v1/` (B),
`evaluation-checker-v2/` (C), `evaluation/` (D).

**This is a trajectory, not replication.** A rising score produced by successive
tooling fixes deserves scrutiny, which is why each correction is recorded with
its rationale and the earlier results are kept rather than overwritten:

1. **Checker wiring.** The first pass omitted the checker flags; Lean responses
   were honestly unscorable. Re-grading with the maintained checker
   (`build-receipt` `fc4c52bc…`) accepted them. No answer changed.
2. **Packet reference.** The blind packet supplied only the final sentence of
   `lean/docs/021.md:L9`, while the sibling Jacobsthal task quotes the full line.
   That made a correct answer look like a misrepresentation; two reviewers failed
   it. An evidence-complete adjudication with the full L9 returned pass. The
   defect was in the packet.
3. **Extraction.** Two Lean blocks existed because the answer first quotes the
   broken code and then the fix. Language-tagged selection was not enough; the
   final rule selects the unique block declaring the frozen target name, and
   still rejects when zero or several blocks qualify.

A human review of the twenty answers remains the independent check on this
chain. The packet is prepared and unfilled.

## Accounting — complete platform totals

OpenCode-calculated values, not provider invoices; upstream completeness stays
unknown and provider billed USD stays null.

| Metric | Total |
|---|---:|
| input_tokens | 93,581 |
| output_tokens | 21,851 |
| cache_read_tokens | 139,776 |
| cache_write_tokens | 0 |
| reasoning_tokens | 27,652 |
| cost_usd | 0.044158278 |

By condition: plugin-off USD 0.020196774, plugin-on USD 0.023961504. Far below
the USD 0.90 soft threshold; the USD 1 combined figure was never a billing cap.

## Transport and controls

- Prompt delivered as exact stdin bytes; argv carries fixed flags only.
- 31/31 runtime controls against the final launcher
  (`runtime-controls-g021-bed9aab2144f`, SHA-256
  `6fa5f7a14dc1194b2994678bdab99590a4db6264961ad9370581bf89336fc0e5`).
- Zero-inference CLI audit before the probe and before the study
  (`real-use-transport-control-cA2lcN`, SHA-256
  `cafc016e7b62d3f6d4c74c946c0ad6595ea5d3f1823274df9333aa465a992c8a`).
- Compatibility probe g023 passed both conditions (checkpoint
  `fea18d3d0b44c1ae1c4ae6882a05241845564e1189cd83951a9e07a740ea651c`).
- Auxiliary gate ruling: gates unchanged, attribution added; the gate did not
  fire in this run.

## Verification

Parent verification (`evaluation/parent-verification.json`, SHA-256
`28639709f7de4b5aa0bd55a1eea553ff867ec0f994777dab4e97ddf1289bd24e`):

- report recomputes **byte-identically** (SHA-256
  `f39007367e613c783cd42eefc7ec1dfeb651e4fc22693d4a1a9dd5301de3263d`);
- 460 preserved artifacts unchanged (188 g024 + 53 g022 + 108 g018 + 26 + 26 +
  21 + 38);
- 11 frozen sources unchanged;
- both checkpoints pass all nine checks.

## Governance and open items

- **Grader amendment re-pin.** `grade.mjs` now hashes `cd73166b…` while the
  amendment pinned `5b7c9cf3…`. A fresh synthetic smoke and a re-pin are being
  produced so the validator keeps its strictness rather than being relaxed.
- **Human review.** `evaluation-prechecker/human-review/` holds the packet and
  an empty `verdicts.csv`. `g024-apply-human-review.mjs` converts a filled CSV
  into typed human reviews and a human-provenance report in one command. Until
  then, every reported verdict is a model verdict.
- **ArXiv.** `ARXIVLEAN_MASKING_PLAN.md` records the decided design: per-task
  excerpt snapshots enforced at storage and tools, with the finding that the
  adapter accepts a proof of `P` **or** a disproof of `¬P`, so the truth
  direction and paper titles/abstracts are answer-bearing. Six negative controls
  are specified. Five-task smoke and the 60-task matrix remain **NOT READY**.

## Artifacts

- Run: `C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g024-workflows-20261113`
- Report: `evaluation/report.json` (recompute with
  `node bench/v4/real-use/report.mjs --out <run> --reviews <run>/evaluation/reviews-checker-aware.json`)
- Lineage: `evaluation-prechecker/`, `evaluation-checker-v1/`,
  `evaluation-checker-v2/`, `evaluation/`
- Blind packets and private evidence per lineage directory
- Orchestrator reviewer pass: `G024_ORCHESTRATOR_REVIEW.md` (AI, not human)
- Freeze/approval root: `real-use-g007-freeze-handoff-aHq2du`
- Probe: `real-use-g023-compat-20261113`

Earlier runs (g004 study; g005, g007, g009, g011, g013, g015, g019 probes; g017
and g021 passing probes; g018 and g022 partial studies) remain immutable and are
**not** pooled with this one.
