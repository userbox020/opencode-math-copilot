# Real pilot readiness

**Status: not run.** No model inference, real adapter execution, Docker challenge, publication, or release was performed for the real pilot.

The owner has granted broad authorization to continue the work. Authorization is not the same as having a valid study: the handoff requires independently reviewed tasks, an isolated real adapter, trusted verification, and a budget/model plan. Running a real matrix before those exist would create non-reproducible or misleading data.

## Implemented

- `bench/v2` deterministic simulation: A/B/F profiles, clean workspaces, typed graders, append-only provenance/resume, family bootstrap.
- Receipt envelope schema 2.1.0 aligned with `math-lean-verify/v1`; formal grading rejects unknown/alias statuses and requires a trusted side-channel.
- Restricted execution profile (`bench/v2/exec/restricted.mjs`) with preparation/execution separation, no network, read-only root, resource limits, no Docker socket; dry-run and mocked tests only.
- Strict `math_lean_verify` contract with generated-declaration axiom audit, malformed-report rejection, null/`notRun` handling, and real Docker negative fixtures.
- Research protocol, claims/evidence map, related work, paper skeleton, acceptance checklist.

## Blocking gaps before a real pilot

1. **Task set.** The v2 fixtures are four toy tasks (`numeric-speed`, `symbolic-cancel`, `citation-toy`, `absence-unicorn`). They validate the harness, not mathematical ability. The handoff's pilot requires 30 tasks across retrieval, exact/symbolic computation, fixed-statement Lean construction, error detection, and out-of-corpus explanation, with independently reviewed answers and family partitions. None of those tasks exists yet.
2. **Real A/B/F adapter.** The committed adapter is a same-process simulator. A real pilot needs separate workspaces/processes with effective tool inventories, no global configuration, no grader/answer access, structured event capture, and no silent host fallback.
3. **Trusted verification side channel.** `math_lean_verify` returns a local compiler-output receipt. A real formal track requires an evaluator-controlled verifier process and source/target/policy bindings; the local receipt is not an independent kernel check or authentication.
4. **Budget and model plan.** Broad authorization does not specify a dollar cap, model list, retry policy, or stop-loss. A 30-task × 2-model × 3-condition × 2-repeat pilot is 360 episodes; the expanded example is 5,400 before ablations. The owner must choose the actual allocation, or explicitly authorize a smaller engineering smoke.
5. **Data protection and partitions.** Freeze development/validation/test families, protect answers/graders, define redaction/licensing, and record immutable hashes before any confirmatory run.
6. **Real execution and analysis.** No real episode has been run. Paper results remain pending; no table may be generated from simulated values.

## Recommended next gate

1. Approve a task-authoring plan and provide (or authorize creation of) 30 reviewed tasks with reference answers/rubrics and family assignments.
2. Implement and dry-run the real isolated adapter for A/B/F; run one engineering smoke episode per condition only after isolation checks pass.
3. Integrate an evaluator-controlled verification receipt for formal tasks.
4. Freeze model versions, budget cap, retry rules, cache regime, and the analysis script.
5. Only then run the authorized pilot and generate paper tables from the resulting immutable artifacts.

Until steps 1–4 are evidenced, the honest status remains **engineering/simulation complete; real pilot not started**.
