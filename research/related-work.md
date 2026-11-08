# Related-work notes

**Status: initial source-linked notes, not an exhaustive review.** Sources and narrow characterizations below come from the supplied handoff, section 12 (E01–E04). No external source retrieval was performed in this documentation task. Verify current bibliographic metadata and the cited passages against primary sources before submission; do not treat inherited notes as a completed literature audit.

## ToRA: tool integration and training

Gou et al., *ToRA: A Tool-Integrated Reasoning Agent for Mathematical Problem Solving*, arXiv:2309.17452 (2023). Primary identifier: <https://arxiv.org/abs/2309.17452>. BibTeX key: `tora2023`.

The handoff identifies ToRA as tool-integrated mathematical reasoning with task-specific training. It is a precedent for combining language models and external mathematical tools, not evidence that this plugin originated that idea. The proposed study instead evaluates an inference-time integration layer without changing model weights. Training-based and integration-based interventions have different costs and confounders; no performance superiority or equivalent-budget comparison is supported here. Verify the precise training procedure and any eventual comparative wording before submission. Do not import reported benchmark scores without checking their setting and source.

## Lean Copilot: assistance within a formal workflow

Song, Yang, and Anandkumar, *Towards Large Language Models as Copilots for Theorem Proving in Lean*, arXiv:2404.12534 (2024). Primary identifiers: <https://arxiv.org/abs/2404.12534> and <https://github.com/lean-dojo/LeanCopilot>. BibTeX key: `leanCopilot2024`.

The handoff describes Lean Copilot as integrating models into Lean theorem-proving workflows with local or remote model options. This is directly related to model-assisted formal work; portability across models alone is not a novelty claim for OpenCode Math Copilot. The present proposed scope combines corpus retrieval, symbolic computation, and formal checking in a general agent workflow. Different interfaces and scopes are not evidence of superior proof performance. Pin any compared software revision and verify current paper metadata/features before submission; the repository is a software pointer, not a fifth independent citation.

## miniF2F: public formal benchmark

Zheng, Han, and Polu, *MiniF2F: a cross-system benchmark for formal Olympiad-level mathematics*, arXiv:2109.00110 (2021). Primary identifier: <https://arxiv.org/abs/2109.00110>. BibTeX key: `minif2f2021`.

miniF2F is an evaluation antecedent, not a competing plugin method. Its public status creates possible exposure through training, published solutions, and imported declarations. Do not call a local run contamination-free. Before adopting tasks, record the exact implementation repository/commit, Lean version/port and patches, statement identities, splits, allowed premises, and overlap audit. Keep reproduction of accessible proofs separate from construction against protected solutions. Verify any claim of comparability with published scores, especially when statements, dependencies, or splits differ.

## Lean proof validation: trust and target scope

*Lean Language Reference — Validating a Lean Proof*. Primary identifier supplied by the handoff: <https://lean-lang.org/doc/reference/latest/ValidatingProofs/>. BibTeX key: `leanProofValidation`.

This is a methodological reference for distinguishing a compiled file from a verified proof of the intended statement. The handoff highlights target meaning, transitive axioms, incomplete proofs via `sorryAx`, and additional trust considerations for native computation. A controlled checker and explicit policy are required; neither a text search for `sorry` nor a self-reported success marker establishes the claim. Validation of a formal proposition does not by itself validate its translation from an informal problem.

The `latest` documentation URL is mutable. Before implementation claims or submission, verify guidance against the pinned Lean 4.34.1 environment and record a versioned documentation URL or archived snapshot. The handoff records consultation on 2026-11-08; that is not an access date for this task. No publication year or individual author is assumed for the manual entry.

## Bibliography and unresolved items

`paper/references.bib` contains exactly these four source identifiers, using the handoff's supplied surnames (and `Gou and others`) rather than inventing author lists, affiliations, venues, DOIs, pages, or publication versions. Years for the arXiv entries refer to initial arXiv identifiers, not an asserted conference edition. Manuscript authorship remains the owner's decision and is separate from cited-source authorship.

Before submission: verify full author metadata and titles for all three papers, choose the intended arXiv/published versions, pin Lean Copilot and any miniF2F implementation used, pin the Lean manual snapshot, and expand the literature review only with inspected primary sources. Do not claim first tool-integrated mathematical reasoning, first model-portable proof assistant, universal expertise, or novelty established by this short list.
