# Real pilot readiness

**Status: not run.** No model inference, real adapter execution, Docker challenge, publication, or release was performed for the real pilot.

The owner has granted broad authorization to continue the work. Authorization is not the same as having a valid study: the handoff requires independently reviewed tasks, an isolated real adapter, trusted verification, and a budget/model plan. Running a real matrix before those exist would create non-reproducible or misleading data.

## Implemented

- `bench/v2` deterministic simulation: A/B/F profiles, clean workspaces, typed graders, append-only provenance/resume, family bootstrap.
- Receipt envelope schema 2.1.0 aligned with `math-lean-verify/v1`; formal grading rejects unknown/alias statuses and requires a trusted side-channel.
- Restricted execution profile (`bench/v2/exec/restricted.mjs`) with preparation/execution separation, no network, read-only root, resource limits, no Docker socket; dry-run and mocked tests only.
- Strict `math_lean_verify` contract with generated-declaration axiom audit, malformed-report rejection, null/`notRun` handling, and real Docker negative fixtures.
- Research protocol, claims/evidence map, related work, paper skeleton, acceptance checklist.
- OpenCode 2.0.29 isolation contract in `research/opencode-isolation.md`: native `agents` + `permissions`, A wildcard-deny, B no `math_*`, F explicit plugin plus `execute`, fresh HOME/XDG/OPENCODE config roots, and NDJSON extraction. This is documented but not yet exercised by a real adapter.

## Draft assets (not paper evidence)

- `bench/v2/tasks/pilot-v1.json`: 30 provisional tasks, six per track and five per provisional family; 12 negative cases. The structural validator passes, including units, absence prose, and same-status/wrong-prose controls. An independent review found no incorrect reference mathematics or fabricated citations; its scoring-gate findings were applied. Owner sign-off is still pending, families are thematic rather than independent, and retrieval/absence/error tasks are extraction/scope/validation smoke tests.
- All six formal reference solutions were compiled and proof-verified through `bench/v2/verifiers/lean.mjs` with real Docker: schema-2.1.0 envelopes, `proof.status: verified`, no axioms, and 6/6 accepted by the formal grader. This is an evaluator-controlled local smoke, not an independent kernel check or informal-correspondence review.
- `bench/v2/adapters/opencode.mjs`: dry-run A/B/F adapter with fresh HOME/XDG/OPENCODE config roots, explicit local plugin loading, project-discovery disabling, and NDJSON final-message grouping. B now stages a generic four-tool plugin (`corpus_search`, `read_excerpt`, `compute`, `lean_check`) with no shell and no `math_*`. The inventory audit is **static-equivalent**: exact staged IDs and permissions match, but no session-free runtime endpoint was found in OpenCode 2.0.29, so `--execute` remains blocked. A server-API investigation is in progress.
- `bench/v2/study/run-study.mjs`: dry-run-first real study runner. It validates tasks, builds the A/B/F matrix, runs the inventory audit, prints episode count and maximum USD exposure, and writes `plan.json`; `--execute` refuses without a runtime-verified audit, explicit budgets/model/toolchain, and `--allow-provisional` for provisional tasks. Four mocked tests pass; no real episode has been run.
- `bench/v2/verifiers/lean.mjs`: evaluator-controlled bridge that turns a strict v1 receipt into the study envelope and fails closed on execution, target, policy, or source mismatches. It is not a signature or OS sandbox.
- `research/opencode-isolation.md`: exact native OpenCode 2.0.29 `agents`/`permissions`/`plugins` contract and its residual trust limits.
- `research/real-study-runner.md`: integration design for the real study; no real-run implementation yet.
- These assets remain **provisional**: owner task review and a real runtime audit are still required.

## Blocking gaps before a real pilot

1. **Task set.** The 30 provisional tasks pass structural validation and an independent review found no incorrect reference mathematics or fabricated citations. Remaining gaps: owner sign-off, independent rubric/family adjudication, blind prose scoring for explanation/absence, and the fact that the tracks are extraction/scope/validation smoke tests. The set is not paper evidence.
2. **Real A/B/F adapter.** The dry-run adapter and the study runner exist, including the generic B plugin and the evaluator-controlled receipt bridge. The inventory audit remains **static-equivalent**: `/api/agent` does not enumerate the staged config-defined agent, so no non-inference runtime proof was found. No real model call has been made and `--execute` remains blocked. The adapter is not an OS sandbox.
3. **Trusted verification side channel.** The evaluator bridge issues schema-2.1.0 envelopes and passed all six formal references with real Docker. The study runner still has to attach those receipts by hash, and the bridge remains a local evaluator-controlled check, not an independent kernel check or authentication.
4. **Budget and model plan.** Broad authorization does not specify a dollar cap, model list, retry policy, or stop-loss. A 30-task × 2-model × 3-condition × 2-repeat pilot is 360 episodes; the expanded example is 5,400 before ablations. The owner must choose the actual allocation, or explicitly authorize a smaller engineering smoke.
5. **Data protection and partitions.** Freeze development/validation/test families, protect answers/graders, define redaction/licensing, and record immutable hashes before any confirmatory run.
6. **Real execution and analysis.** No real episode has been run. Paper results remain pending; no table may be generated from simulated values.

## Recommended next gate

1. Owner reviews and signs off the 30 provisional tasks, or supplies replacements; freeze the reviewed set and family map.
2. Complete the runtime inventory/isolation audit and run one engineering smoke episode per condition with an explicit model and budget.
3. Wire the real study runner (adapter -> grader -> evaluator verifier side channel), then dry-run the full matrix with a printed maximum spend.
4. Freeze model versions, spend cap, retry rules, cache regime, and the analysis script.
5. Only then run the authorized pilot and generate paper tables from the resulting immutable artifacts.

Until steps 1–4 are evidenced, the honest status remains **engineering/simulation complete; real pilot not started**.
