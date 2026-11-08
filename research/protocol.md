# Research protocol: OpenCode Math Copilot

**Status: proposed protocol, not a completed preregistration or executed study.** New evaluation results are **pending**. A future dry-run plan or fixture result must be labeled **simulated**, never measured model performance. No inference or simulation was run in preparing this document. Budget authorization is required before inference or substantial resource use.

This protocol implements the research portion of `handoffv1.md` (2026-11-08). Repository documents were inspected at commit `55df3cd0d79f91be826e3efa5c72f8df299e0376`; the handoff reviewed `f4a7b57d19ba399caf52bec822bd177d68a2a7a4`. Neither identifies a new experimental run. Freeze a versioned protocol and study manifest before collecting test outcomes. Unresolved launch fields below are blockers, not permission to choose after observing test results.

## 1. Research questions and estimand

- **RQ1 — Utility:** Does the system improve end-to-end success on defined mathematical tasks for the selected compatible models under fixed budgets?
- **RQ2 — Integration value:** Does the plugin improve success over a generic agent with the same corpus and comparable underlying capabilities?
- **RQ3 — Reliability:** Does it reduce unsupported citations, incorrect verification claims, and algebraic answers missing necessary hypotheses or domains?
- **RQ4 — Efficiency and limits:** How do cost, latency, failure modes, and coverage vary by model, track, and tool availability?

The evaluated unit is model + agent + tools + corpus, not intrinsic mathematical expertise. The primary contrast is **F−B** in operational episode success. Report the possibility of zero or negative differences. F−A estimates the assistance package, not integration alone or an increase in pure reasoning ability. Even controlled F−B results concern the registered interface/workflow bundle, selected models, tasks, and budgets; they do not identify the effect of every component or generalize to all models.

## 2. Conditions and isolation

| Condition | Resolution-time access | Interpretation |
| --- | --- | --- |
| A | Same model and common task instructions; no tools, corpus access, shell, or network retrieval during resolution. | Unassisted reference. |
| B | Generic agent; same corpus snapshot and comparable file/PDF reading, search, symbolic calculation, and Lean/Comparator capabilities; no `math_*` interfaces or math-workflow instructions. | Main integration baseline, not an intentionally weak substitute. |
| F | Same agent/model with the full plugin and its registered workflow. | Integrated system. |

Freeze the generic adapters, effective corpus coverage, library access, and tool-specific limits before validation is closed. B may access the same indexes and data as F through generic interfaces. Document unavoidable interface/instruction differences instead of claiming perfect equivalence. Hold task statements, common instructions, model settings, hardware allocation, permissions, and overall resolution budgets constant within paired comparisons. All conditions use the same external graders; A's generated Lean artifact can be verified after resolution without returning verifier feedback to A.

Each episode gets a fresh workspace/session and explicit configuration. Isolate global plugins, memory, instructions, history, writable caches, and personal configuration. Enumerate effective tools before starting; fail closed on forbidden access. Permissions must prevent grader/solution access, not merely discourage it. Counterbalance A/B/F order within model/task/repeat blocks using a recorded schedule seed; record actual order and concurrent load. Failure to enforce isolation blocks a valid run and is logged, not quietly relabeled as a result.

## 3. Registered ablation design

**Choose leave-one-out only:** F minus retrieval, F minus symbolic computation, and F minus resolution-time formal verification. Do not also interpret retrieval-only/compute-only/verification-only profiles as part of this design. These are proposed follow-up conditions, excluded from the main pilot and expanded-study episode counts; they need separate budget authorization.

Disable the removed capability through effective permissions across plugin and generic fallback paths. For retrieval removal, block corpus search/read routes; permit only task materials and registered trusted dependencies needed by the remaining components. Computation removal blocks equivalent symbolic-execution fallbacks. Verification removal blocks resolution-time Lean/Comparator execution, but never external final grading. Specify shared-capability boundaries in the manifest and validate them with benign fixtures. If a component cannot be isolated, do not claim its ablation was implemented. Contrasts with F measure removal within this bundle, not additive contributions or interactions.

## 4. Task tracks and external grading

| Track | Required content | Success criterion |
| --- | --- | --- |
| Bibliographic retrieval/evidence | Correct documents, locators, supported claims; include evidence beyond first-page excerpts and absence/coverage questions. | Frozen rubric checks source identity, locator, actual support, and appropriately bounded search/absence claims. |
| Exact/symbolic computation | Typed final answers, assumptions, domains, units where applicable, restrictions, edge cases, and complete solution sets. | Exact comparison or preregistered tolerance/equivalence under stated assumptions; reject extraneous roots and omitted necessary conditions. |
| Lean proof construction | Evaluator-fixed statements, allowed imports and premises, protected target solutions. | Independent verification receipt matches the trusted target and axiom policy; compilation alone is insufficient. |
| Error/hypothesis detection | Correct and defective arguments, missing hypotheses, and unsupported verification claims. | Blinded rubric checks the specific defect or justified absence of a defect and a valid explanation/correction. |
| Out-of-corpus explanation | Problems not dependent on indexed manuscripts; independently reviewed references and rubrics. | Blinded competent review of correctness, conditions, and support; another LLM's preference is not ground truth. |

Extract the final answer/artifact separately from events and stdout/stderr. An extraction failure cannot fall back to keyword scoring of the log. A symbolic checker returning undecidable triggers blinded human adjudication under the frozen rubric; unresolved decisions remain `unresolved`, not passes or infrastructure errors. Define reviewer qualifications, adjudication procedure, and turnaround before launch. Lock rubrics before test; record disagreements and adjudications without condition labels where feasible.

Existing Comparator challenges may form a separately labeled **reproduction/verification** track. They are not evidence of novel proof construction when the solution is already accessible. Do not pool that track into proof-generation success.

## 5. Partitions, contamination, and protected evaluation

Split development, validation, and test by manuscript/problem **family**, grouping revisions, paraphrases, near-duplicates, and direct theorem equivalents together. Freeze family assignments, task IDs, prompts, reference answers, graders, and hashes before looking at test outputs. Use development for implementation and validation for the last rubric/configuration decisions. Pilot tasks are development/validation tasks; do not reuse them as untouched confirmatory test tasks.

Screen allowed corpus and imported declarations for direct target solutions and equivalents. A renamed target is not sufficient protection when an imported theorem proves it immediately. Register allowed premises and task-specific corpus redactions, identically for B/F. Keep reference proofs, graders, answer keys, prior result reports, and harness fixtures outside agent-readable mounts. Publish sanitized evaluation artifacts only after the evaluation is frozen/completed as permitted by licenses.

For miniF2F, pin repository, commit, Lean port/version, patches, statement identities, allowed imports, and split mapping. Respect its public-benchmark status: local execution does not make it contamination-free. Audit overlap with corpus, development tasks, and available solution libraries; report unknown model-training overlap. Any remapped family split must be disclosed separately from standard benchmark splits. New/generated tasks require independent checks of consistency, solutions, and difficulty before inclusion; do not let one system generate both test and unquestioned ground truth.

## 6. Proposed data model and accounting

These are **proposed schema requirements**, not an assertion that the harness already implements them. Every artifact needs a schema version and provenance. Unknown fields are `null` with a reason, never guessed.

### Study manifest

Record `study_id`, protocol version/hash/date, immutable `run_id`, plugin commit and dirty-tree state; corpus commit (including effective container corpus), index and dataset hashes, partition/family map, provenance and licenses. Record OpenCode, Node, Python, SymPy, Lean, Mathlib, Comparator and exporter versions, patch hashes, image digests, hardware/resource limits, and environment configuration.

Record requested `model_id` and provider-resolved version when exposed; context, temperature, supported random seed, reasoning effort, budget/time/attempt limits, and missing-metadata reasons. Include condition policies, effective tool inventories, instruction/prompt hashes, schedule and seed, retry rules, evaluator/rubric versions, axiom policy, cache preparation/reset policy, and cost-rate source/date. Store execution mode explicitly: `simulated` versus `live`; the latter does not itself imply a verified outcome.

### Episode and attempt records

- **Repeat:** an independently initialized replication index for a model/task/condition, not a new task.
- **Episode:** one model/task/condition/repeat allocation under a single fixed total budget; may include retries or proof revisions.
- **Attempt:** a recorded resolution attempt inside that episode; all attempts share its budget. Retries never reset the denominator or become additional independent tasks.
- Episode key: `(study_id, model_id, task_id, condition_id, repeat_id)`.
- Unique attempt composite key: `(study_id, model_id, task_id, condition_id, repeat_id, attempt_id)`; each attempt links to the parent episode and execution `run_id`.

Persist immutable attempt records and exactly one final episode summary, append-only/incrementally, including final answer separately from structured tool events, artifact hashes, timing for preparation/resolution/evaluation, observed tokens, observed/estimated cost with source/date, retry rationale, errors, grader decision and supporting evidence. Instrument execution events rather than counting visible Code Mode markers. If event capture is unavailable, report missing telemetry instead of inventing counts.

Resume idempotently: retain identities and completed outcomes, detect duplicates/missing pairs, and record interrupted attempts. Never replace previous outcomes with a favorable rerun. Do not call an episode with hidden retries `pass@1`. A started episode is one for which resolution has been dispatched, even if the provider immediately errors. Preflight failures and never-started allocations remain in the planned-versus-started flow report. All started episodes enter operational accounting; unresolved grading and interruptions are not established successes. Report incomplete collection explicitly rather than presenting a selected complete-case matrix as the planned study.

### Verification receipt

Record target declaration, trusted statement and provenance, evaluated solution and hashes, dependency closure, allowed and observed transitive axioms, controlled verifier identity/version, Lean/exporter/Comparator versions, patches, effective host/container corpus commits, status, and informal-to-formal correspondence review.

Keep distinct dimensions: execution (`completed`, `timeout`, `error`, `tool_missing`), compilation (`success`, `failed`, `not_run`), target (`identified`, `absent`, `mismatch`, `not_requested`), proof (`verified_under_policy`, `incomplete`, `unverified`, `not_requested`), and informal correspondence (`reviewed`, `pending`, `not_applicable`). Strict success requires a trusted target comparison, permitted transitive axioms, and evaluator-controlled verification. Reject solution dependence on `sorryAx` or unauthorized axioms, not every classical axiom. A hash tracks artifacts, not semantic equivalence. A challenge-statement placeholder is not the solution and must not be automatically rejected as an incomplete solution. Review native computation's trust assumptions for the pinned Lean version. An agent-printed success marker is not a receipt.

**Mapping to the implemented portable receipt:** `math_lean_verify` emits `math-lean-verify/v1` with execution `completed|timeout|error|missing-tool`, compilation `compiled|failed|not-run`, target `identified|missing|mismatch|not-requested`, and proof `verified|incomplete|rejected|unverified|not-requested`. A study envelope must either use these v1 statuses verbatim or declare a versioned, complete mapping from the proposed labels above; it must preserve `rejected`, and must not treat v1 `verified` as evidence beyond the named target/type/policy. An "independent receipt" means evaluator-controlled issuance and provenance, not automatically an independent kernel recheck. `docs/verification-contract.md` remains the v1 field-level authority; a study envelope that omits `rejected` or invents statuses is invalid.

## 7. Execution controls and budget gate

Separate trusted preparation (dependency downloads, pinned builds, cache construction) from restricted generated-code execution. The proposed execution profile uses an unprivileged user, protected dependencies/evaluators, per-attempt scratch space, CPU/memory/time limits, and disabled network unless explicitly justified. Do not expose credentials, personal configuration, host services, or Docker sockets. Provider networking is separate from proof execution. Never silently fall back to native execution on container failure. Require benign permission, isolation, cancellation, and resource-limit checks before live use. These are proposed controls whose implementation must be evidenced, **not a security proof** or assurance of a complete sandbox.

**Proposed pilot, not run:** 30 tasks × 2 models × 3 conditions × 2 repeats = **360 episodes**. It diagnoses task/grader failures, variability, and expenditure; it is not a statistical power guarantee. Prepare a simulated plan first, labeled `simulated`; simulated records cannot populate measured-performance tables.

**Proposed expanded example, not run:** 150 tasks × 4 models × 3 conditions × 3 repeats = **5,400 episodes**, before ablations. Final size depends on pilot family-level variability, target effect, and authorized cost. Both designs require explicit budget approval. Choose compatible models before test; record identifiers rather than assuming closed-model parameter counts or undocumented size categories.

Before launch, freeze task/track counts and family allocation, model versions, per-episode token/time/attempt/cost caps, pricing sources, permitted retries, schedule, cache regime, rubric/adjudication rules, and an overall stop-loss budget. None is supplied by the episode arithmetic alone.

## 8. Metrics and paired analysis

**Primary outcome:** proportion of all started episodes achieving externally graded objective success within the registered budget, reported by track and model. **Primary contrast:** F−B for that outcome. F−A is secondary. Freeze a reporting hierarchy; do not select only favorable tracks, models, or alternative metrics after results arrive.

For the proposed aggregate, average repeat outcomes within task/model/condition, then average tasks within family, families within track, tracks equally, and models equally. Report ordinary all-started episode counts/rates alongside this family-balanced estimand. Preserve the same weights across conditions and explicitly flag incomplete paired collection. Per-track and per-model estimates remain mandatory, including negative differences.

Use a paired family bootstrap: resample whole families with replacement, preserving every task, condition, repeat, and model within each sampled family. Use one global family draw if families span tracks, preserving cross-track dependence; report unsupported replicates if a track is absent rather than silently changing weights. Proposed fixed analysis settings: 10,000 resamples, seed 20261108, percentile 95% intervals. These are design constants, not measurements. Report family counts and bootstrap support; with few families, label intervals exploratory and do not infer precision from repeated episodes. Pilot analyses are exploratory; no population-of-models inference or confirmatory multiplicity claims are planned.

Secondary outcomes: false verification claims per episode and per verification claim (report both denominators); supported-citation precision plus citation coverage; formal success under policy; hypothesis/domain omissions; tool availability/coverage; preparation, resolution, evaluation and total latency; observed tokens, tool events, cost, and failures. Undefined denominators are reported as undefined. Report non-success durations/timeouts, not only successful latencies; label success-conditioned analyses explicitly.

Cost per correct episode is **total cost of all started episodes and their attempts / correct episodes**, including failures. Report preparation costs separately and disclose any amortization in total cost. With no correct episodes the ratio is undefined; with unavailable cost data report unknown/partial coverage, not zero. Separate measured costs from estimates with price source/date; subscriptions do not imply free inference.

Report **cold and warm cache strata separately** with preparation/reset policies and actual cache state. Within each paired block use comparable cache preparation; do not report only the faster regime. The proposed episode totals assume one prespecified cache regime per allocation. Running the full matrix in both regimes adds episodes and requires a revised manifest/budget, not hidden duplication.

Failure categories: incorrect reasoning/answer, unsupported citation, missing hypothesis/domain, false verification claim, formalization/target/axiom failure, provider error, agent timeout/budget exhaustion, missing tool, tool/runtime error, extraction error, grader error, undecidable/unresolved grading, isolation/configuration failure, and interrupted run. Allow diagnostic secondary labels but one recorded terminal operational status. Never silently exclude infrastructure failures from end-to-end success; any conditional sensitivity analysis must retain the primary accounting and state its denominator.

## 9. Reporting and completion gates

Publish planned/started/completed/graded counts, missing pairs, failures, protocol deviations, negative cases, artifact hashes, redacted logs, and regeneration instructions. Keep historical keyword heuristics separate from the new evaluation. No claim of universal expertise, hallucination elimination, causality beyond the registered comparison, or proof of a mathematical paper follows from tool availability or compilation.

See [claims and evidence](claims-and-evidence.md) for admissible wording and [related work](related-work.md) for citation limitations. Publication-ready tables, inferential conclusions, full receipts, budget approval, protected datasets, and live study execution are **pending**.
