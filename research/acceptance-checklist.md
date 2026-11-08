# Acceptance checklist

Status legend: **implemented** = code/docs with linked local checks; **implemented (simulated)** = deterministic fixture/simulation checks only, no real-model or mathematical-validity result; **pending** = requires an authorized real run or external review.

This checklist records delivery scope, not scientific evidence.

| Handoff acceptance check | Status | Evidence / limitation |
| --- | --- | --- |
| Comparator timeout parameters: omitted defaults, explicit values, cancellation | **implemented** | `lib/lean.js` injectable runners; `scripts/test-tools.mjs` CORE-01 tests; no 30-minute wait or Docker challenge required. |
| Compilation and verified proof are distinct states | **implemented** | `math_lean_verify` returns `math-lean-verify/v1`; `math_lean_check` remains compilation-only; `docs/verification-contract.md`. |
| Target/axiom checks; legitimate challenge `sorry` is not treated as a solution | **implemented** | Generated checked declaration + `#print axioms`; allowlist; `sorryAx` -> incomplete; Comparator placeholder exception documented. |
| Missing tools/errors are never successful verification | **implemented** | Receipt execution/compilation/proof statuses; missing-tool, timeout, malformed-output and contradictory-runner fixtures. |
| Oracle high finding: audit dependencies introduced by elaboration | **implemented** | `math_lean_verify` audits a unique generated declaration, not the original theorem. Real Docker regression: synthesized unauthorized instance -> `rejected`; synthesized `sorry` instance -> `incomplete`/`sorryAx`. |
| Oracle medium finding: malformed extra reports fail closed | **implemented** | All lines beginning with the checked declaration are counted; valid+malformed/unrecognized reports fail in both orders; stubbed tests. |
| Oracle low findings: null request and `notRun` runner | **implemented** | Null request returns a receipt (`not-requested`, no Lean call); `notRun: true` cannot verify even with exit 0 and valid markers; tests. |
| Experimental mode does not expose answers, editable graders, personal config, or prior sessions | **implemented (simulated)** | Fresh `mkdtemp` per episode, exact-file/content allowlist, profile validation and leak tests in `bench/v2/tests/v2.test.mjs`; real adapter pending. |
| Generic condition uses comparable corpus and budgets | **implemented (simulated)** | A/B/F profile manifests and exact tool inventories; no live condition has been run. |
| Grader scores final answer/artifact, not the full log | **implemented (simulated)** | Typed `final`/events, extraction-failure path, six deterministic graders, log-only/negation/wrong-citation/domain traps. |
| Incremental, resumable, unique records; missing/duplicate detection | **implemented (simulated)** | Append-only `starts.jsonl`/`episodes.jsonl`, idempotent resume, interrupted/duplicate/missing/tamper tests; 48-episode simulated pilot. |
| Scripts distinguish observed, reported, and simulated results | **implemented (simulated)** | `simulated: true`, `simulated-model-a/b`, source hashes and report labels; no observed model data. |
| Statistics preserve task/family pairing and negative results | **implemented (simulated)** | `bench/v2/analyze.mjs` paired-family bootstrap; 3 families only; F−B +12.5 pp exploratory CI [−25,+50]. |
| Paper avoids universal expertise, hallucination-elimination, or superiority without evidence | **implemented (docs)** | `paper/main.tex`, `research/protocol.md`, `research/claims-and-evidence.md` mark results pending and preserve historical negative cases. |
| Every publishable table can be regenerated from an identified artifact | **implemented (simulated)** | `bench/v2/simulated/simulated-pilot-receipt-v2.1/{manifest,starts,episodes,report}`; confirmatory real-data tables pending. |
| Historical benchmark is not presented as mathematical accuracy | **implemented** | `bench/RESULTS.md` caveats, Wilson-interval note, and `research/claims-and-evidence.md`; keyword heuristic only. |
| PERF-01: configurable regex searches have an effective time limit | **implemented** | Child-process worker with 1000 ms default; catastrophic regex terminates in ~125 ms; literal mode is process-free; no partial matches. |
| Real pilot readiness | **pending** | `research/pilot-readiness.md`: no 30 reviewed tasks, real A/B/F adapter, trusted verifier side-channel, or model/budget plan yet. No real episode was run. |
| No release, publication, or costly model matrix was performed | **implemented** | No tag/release; code changes only; no model inference in this work. |

## Simulated pilot (not evidence)

The current `bench/v2/simulated/simulated-pilot-receipt-v2.1/` run contains 48 scripted episodes: A 2/16, B 12/16, F 14/16. The F−B difference is +12.5 percentage points with an exploratory three-family bootstrap CI of [−25, +50], seed 20260101, 2,000 resamples. These numbers test the harness, graders, provenance and accounting; they do **not** measure model mathematics or plugin effectiveness. The 15-tool and pre-2.1 snapshots are preserved separately.

## Required next gate

A real pilot requires the owner's explicit budget authorization, a separately isolated adapter, trusted verifier integration, frozen task/grader versions, and a completed execution-profile review. The simulated same-process adapter is not a security sandbox.
