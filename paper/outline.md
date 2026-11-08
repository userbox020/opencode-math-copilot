# Manuscript outline

Working title: **OpenCode Math Copilot: A Model-Agnostic Tool Layer for Mathematical Retrieval, Computation, and Verification**.

**Status:** skeleton; new Results are **pending**. Protocol and study sizes are **proposed**, not measured. Future dry-run artifacts must say **simulated**. No simulation, inference, or LaTeX build was run for this document. Author names, affiliations, acknowledgments, and submission venue are placeholders under owner control. “Model-agnostic” describes interface scope, not guaranteed success with every model.

## 1. Introduction and scope of claims

State the model + agent + tools + corpus hypothesis without claiming increased intrinsic intelligence or expertise. Present reusable integration and an auditable evidence contract as intended contributions; controlled utility evidence is pending. Link `../research/claims-and-evidence.md`.

## 2. Related work

Discuss ToRA, Lean Copilot, miniF2F, and Lean proof validation. Distinguish training from inference-time integration, formal workflow assistance from broad tool integration, and public benchmarks from protected test data. Verify references before submission; do not assert novelty from an incomplete review.

## 3. Architecture and tool surface

Describe retrieval/index coverage, PDF limits, computation, Lean/Comparator wrappers, and agent workflow from the eventual pinned implementation. Insert an evidence-backed inventory and provenance; avoid stale numerical inventories. No new architecture work is implied.

## 4. Trust model and verification contract

Separate execution, compilation, target identity, proof policy, and informal correspondence. Describe protected graders, transitive axioms, controlled receipts, and trusted setup versus restricted execution. Label controls proposed or implemented with linked checks; do not claim sandbox security or that formal verification proves an entire paper.

## 5. Preregistered experimental protocol

Use `../research/protocol.md`: RQ1–RQ4; A/B/F; primary F−B; five task tracks; family-level splits and contamination controls; episode/attempt/repeat schemas; frozen external graders and budgets. Proposed pilot: 30 × 2 × 3 × 2 = 360 episodes. Proposed expanded example: 150 × 4 × 3 × 3 = 5,400 before ablations. No completed preregistration or run is claimed.

## 6. Results separated by retrieval, computation, and proof

**Pending.** Reserve subsections for retrieval/evidence, exact/symbolic computation, fixed-statement proof construction, error/hypothesis detection, and out-of-corpus explanation. Do not add plausible result tables. Historical project-reported keyword heuristics, if discussed, stay separate and retain the GPT `landau-siegel` negative case; they are not mathematical accuracy or F−B evidence.

## 7. Ablations, costs, and negative cases

Register only leave-one-out ablations: remove retrieval, computation, or resolution-time verification from F. Preserve external evaluation. Report family-paired uncertainty, all-started failures, cost per correct episode, cold/warm strata, and negative differences. These analyses are pending and require authorization beyond the main matrix where applicable.

## 8. Limitations, contamination, and threats to validity

Address public benchmark exposure, corpus-specific advantages, family dependence, small model samples, unavailable version/cost metadata, human adjudication, remote API drift, and formal/informal correspondence. Limit causal language to the registered system comparison.

## 9. Reproducibility, licenses, and artifact availability

Identify immutable manifests, corpus/index versions, graders, records, receipts, patches, environments, redaction, licenses, and regeneration steps. Availability is pending, not a fabricated archive URL. Report deviations and missing records. Disclose AI assistance under venue policy without assigning authorship to agents.

## 10. Conclusion limited to observed evidence

Summarize only substantiated implementation and measured results once available. Currently conclude only that the evaluation and evidence requirements are specified, with empirical utility and efficiency pending.
