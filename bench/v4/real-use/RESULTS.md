# Real-use g004: stopped first-pair study

Date: 2026-11-12. Run: `real-use-g004-20261112`.

**The safety gate required a stop after two captured episodes. This is not a completed 20-episode study and supports no efficacy or accuracy comparison.** One Hanner retrieval episode completed; its counterpart retained an answer but failed capture/finalization completeness. Eighteen episodes were not started. No retries, replacement, resume, or further dispatch occurred.

## Frozen protocol and treatment

- Model: `opencode-go/deepseek-v4.1-flash`, effective variant `default`.
- Ten frozen public workflows, one adjacent ON/OFF pair per workflow, one repeat, seeded order `real-use-v1`; maximum 20 episodes, concurrency 1.
- Identical assembled task prompt within each pair; 300000 ms solver deadline per episode. No fallback model, retries, reseeding, or task replacement.
- Reported-cost soft limit: USD 1, not a provider billing cap. Unknown-cost policy: first-pair counterpart only; it cannot override a safety stop.
- Both conditions have six shared baseline tools over the same frozen three-source snapshot. ON additionally has the two navigation tools `math_search` and `math_manuscript`; OFF does not. This is a narrow navigation treatment, **not the full 16-tool plugin versus no tools**.
- The first prescheduled pair was `hanner-released-pdf`, ON then OFF. The remaining schedule was not altered.

## Gates completed before and during execution

The parent approved the frozen source bindings after the recorded 31 actual runtime controls, independent bound proof-checker positive and negative controls, closure of two security-medium and two correctness-P1 findings, 113 focused tests, and 111 parent syntax checks. The earlier two trusted proof positives were infrastructure controls, not model solves. No formal solver task was attempted in this study.

The genuine no-inference handoff exercised private capability consumption and dispatch construction only. It did not establish live finalization compatibility. The subsequent real ON episode did establish live model/session identity, a passed native guard, clean native completion, a validated owned finalization receipt, and confirmed cleanup. OFF did not establish equivalent completion evidence.

These bounded controls and safety tests are not proof of operating-system isolation, a security-escape assessment, or mathematical efficacy. They were not rerun for this report.

## Captured first pair: operational status is not grading eligibility

Task: quote the closing sentence of Lemma 2.2 in the released Hanner manuscript PDF, with its filename, physical page, printed page, and claim-versus-verification distinction.

| Condition | Operational status | Grading eligibility / result | Observed input subtotal | Observed output subtotal | Reported USD subtotal | Solver seconds | Tool events |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| ON | `completed_answer`; identity/guard validated; safety false | Eligible; condition-blind model review: pass, adequate evidence | 6316 | 577 | 0.001747392 | 23.139 | 5 |
| OFF | `finalization_failure`; identity unavailable; safety true; CLI exit 0 | Ineligible for completed-answer rubric grading; correctness unknown | 8729 | 634 | 0.002502702 | 53.342 | 9 |

ON usage is complete **for the observed stream only**, not reconciled provider billing. OFF totals are **unknown**; its numbers are retained known subtotals. Combined known subtotals are 15045 input + 1211 output = **16256 tokens**, and **USD 0.004250094**. Combined total tokens and cost remain unknown. The JSON floating-point subtotal is displayed rounded to nine decimal places. These are not complete-bill amounts or a basis for percentage savings.

The time and tool-count differences describe one workflow with an incomplete counterpart, not general performance or efficiency.

## Frozen pair accounting

| Pair order | Task | Scheduled order | ON operational status | OFF operational status | Completed-answer grading eligibility | Paired outcome |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `hanner-released-pdf` | ON / OFF | Completed | Failed finalization | ON only; OFF ineligible | Ungraded |
| 2 | `jacobsthal-strengthened-scope` | OFF / ON | Not started | Not started | Neither | Ungraded |
| 3 | `compilation-scope-evidence` | ON / OFF | Not started | Not started | Neither | Ungraded |
| 4 | `rational-equation` | OFF / ON | Not started | Not started | Neither | Ungraded |
| 5 | `bounded-search-miss` | ON / OFF | Not started | Not started | Neither | Ungraded |
| 6 | `matrix-determinant` | OFF / ON | Not started | Not started | Neither | Ungraded |
| 7 | `lean-rational-odd-sum` | ON / OFF | Not started | Not started | Neither | Ungraded |
| 8 | `metadata-characteristic-two` | OFF / ON | Not started | Not started | Neither | Ungraded |
| 9 | `rational-integral` | ON / OFF | Not started | Not started | Neither | Ungraded |
| 10 | `lean-cancellation-repair` | OFF / ON | Not started | Not started | Neither | Ungraded |

The maintained `evaluation/report.json` records **10 ungraded pairs**, with ON-only, OFF-only, both, and neither outcome counts all **0**. There are 1 completed episode, 1 operational failure, 18 not started, 9 incomplete pairs, and 0 missing reviews. The first pair has both terminal records, so it is not counted among the nine missing-member pairs; it remains ungraded because OFF is ineligible. “Neither” in the eligibility column is not a scored paired outcome.

The maintained grader exported only the completed answer. The reviewer read only the condition-blind packet and returned pass / adequate evidence for blind ID `4178d2a3-3751-4803-beee-457fc444d8f9`. This was **one model review, zero human reviews**; executor model identity was not exposed. There is no ON-1/OFF-0 accuracy result.

## Missingness, stop reason, and cleanup

`execution-stop.json` records `safety_failure`, two attempted setups, two captured episodes, and no setup failures. OFF's stored reasons are `native_closure_incomplete`, `unfinished_step`, `terminal_step_finish_missing`, and `finalization_failed`. CLI exit 0 does not establish a complete native stream, validated identity, or complete accounting.

This is **not a missing answer or demonstrated mathematical inability**. The OFF retained answer is 3216 bytes. Parent literal-reference inspection found the exact expected sentence in both answers: “The polar of a linear Hanner body is again a linear Hanner body.” That observation does not retroactively make OFF eligible for completed-answer grading.

The completed causal review found OFF step 7 starting at 21:35:46, followed by answer text at 21:36:00, but no terminal finish or error event; the CLI exited 0. No timeout, resource-limit failure, capture error, extraction error, or provider error was recorded. **The root cause remains indeterminate:** provider behavior, CLI event delivery, monitor behavior, and RPC behavior cannot be distinguished from the retained evidence. Monitor exceptions were reduced to a boolean, and live guard records were not persisted. No specific code bug is established. Do not infer guard violations, a security escape, or a mathematical error from the safety classification.

ON's episode receipt confirms CLI/server/daemon cleanup. OFF's capture receipt records CLI cleanup confirmed but finalization bridge cleanup unconfirmed (`bridge.confirmed: false`). Separately, the eventual `setup/00.cleanup.json` and `setup/01.cleanup.json` both confirm server and daemon cleanup with zero active processes. Together with the CLI cleanup receipts, eventual server, CLI, and daemon cleanup is confirmed for both episodes. Eventual resource cleanup does not repair OFF's finalization, identity, or billing evidence and does not invalidate the required stop.

The user authorized continuation only while the gates held. The gate did not hold: stopping was protocol compliance, not abandonment of the requested study.

## Interpretation and readiness

No plugin-superiority, mathematical-accuracy, formal-solving, cost-saving, or general speed claim follows from this stopped pair. Missing/unscorable outcomes are not mathematical failures. Prior infrastructure proof positives must not be counted as solver successes.

**ArXiv five-task smoke: NOT READY.** Fair live capture and accounting have not proved reliable in both conditions. The 60-task pilot and broad matrix remain paused.

The next bounded action is to diagnose the unresolved terminal capture gap and add a focused regression under separate implementation authorization; the completed review does not justify assuming a particular code defect. Any subsequent model attempt requires a newly approved, fresh preregistered run that preserves this stopped study; do not silently resume or replace an episode. This report authorizes no new study or model call.

## Evidence and preservation

Local run directory: `C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-study-g004-20261112`.

- Detailed report: `evaluation/report.md`; maintained machine report: `evaluation/report.json`.
- Authority: `real-use-controller-handoff-final-1b9Kow/parent-approval.json` under the same approved temp root.
- Candidate source-binding bundle SHA256: `8a5310f846cd085e01bad98615f22b90c7939e66b4e6a9027ca5e1cfc7b40d82`.
- Construction-control receipt SHA256: `2733a0f9f2eea46d0ad9e04a48001e5a5485e516eee71f17a43e255b4b455dad`.
- Before-grading integrity snapshot: **21/21 preserved files unchanged**. Historical `evidence-integrity-g003.json`: **38/38 unchanged**. These are byte-hash checks, not regrading or new scientific verification.

Only this new summary and the new run-local Markdown report were added. Captures, manifests, setup records, reviews, machine report, source code, PINS, and prior results were not rewritten. Nothing was published; parent retains final validation ownership.
