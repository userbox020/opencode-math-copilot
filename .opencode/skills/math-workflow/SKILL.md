---
name: math-workflow
description: Use when solving, checking, or explaining a mathematical problem, searching the bundled OpenAI math corpus, or verifying Lean formalizations.
---

# Math workflow

Solve the user's stated problem. Do not turn it into a broad research project.

## Workflow

1. Restate the problem and identify its mathematical domain. Determine whether the user wants a proof, computation, corpus lookup, or formal verification; clarify only blocking ambiguities.
2. Use `math_search` for related manuscripts and strategies. Start broad, then narrow by terminology or hypotheses. Use `math_manuscript` to read only the relevant abstract, outline, or LaTeX section. If the TeX source is missing or you need the released wording, use `math_pdf_text` on selected pages or `math_pdf_search` to locate a phrase first.
3. For a proof, give a lemma plan before algebra. Separate results cited from the corpus from new derivation, and check that each cited result's hypotheses apply.
4. For requested formal verification or a Lean statement, use `math_lean_search` to locate existing declarations, `math_lean_check` on small snippets first, then `math_lean_build` for the focused target. Use `math_comparator` only when a matching challenge config exists. Do not build the entire package by default.
5. For numerical or symbolic work, use `math_compute` for allowlisted SymPy operations. Otherwise show the computation and state the execution limitation. Numerical evidence is not a proof of an exact claim.
6. Independently check edge cases, quantifiers, hypotheses, and intermediate steps. Confirm whether each Lean check actually passed and what statement it checked; a passing unrelated snippet does not verify the requested theorem.

## Corpus and verification guardrails

- `math/CONTENTS.md` maps 721 manuscripts in 373 result families. The archive contains raw research outputs, not independently certified results.
- Currently 175 papers have Lean formalizations; `math/lean/formalization.yaml` is the catalogue. Presence in the catalogue does not certify every claim in a paper.
- Check `math/history.md` when a result looks suspicious; it records revisions and withdrawals. Do not rely silently on a withdrawn result.
- Never claim a paper is verified merely because it is in the corpus.
- Never claim Lean verification unless the relevant `math_lean_check`, `math_lean_build`, or `math_comparator` invocation actually succeeded. Report failures, skipped checks, missing prerequisites, and remaining gaps explicitly.
- `math/lean/` is the single Lake package `OAI`, pinned to `leanprover/lean4:v4.34.1`. Prefer focused targets such as `OAI.Analysis`.
- Use `math_status` to inspect current availability; do not treat an unavailable check as success. Native Windows Lean builds can be blocked by an NTFS-invalid path in the pinned dependency set, and Comparator/landrun require Linux/WSL. Report such blockers instead of silently switching claims.
- Cite source paths relative to `math/`, for example `lean/formalization.yaml`, with manuscript identifiers and section names where available.

## Tool-use patterns

- Query broad first, then narrow; do not perform repo-wide discovery for a localized question.
- Read relevant sections rather than whole PDFs. Resolve released PDF paths from metadata rather than assuming a filename; use `math_pdf_search` to find a phrase, then `math_pdf_text` for the selected pages.
- If the manuscript is unknown, use `math_pdf_corpus_search` for a bounded PDF search across top indexed candidates (default 5, pages 1-2). It is not a full-text index; no matches does not establish absence from the corpus.
- Use `math_pdf_index_search` for discovery across prebuilt selected-page excerpts (default first 2 pages; no OCR, not full text), then `math_pdf_search` for deeper lookup; `math_doctor` reports corpus/index/cache and tool health.
- Prefer `math_grep` for exact names or notation in TeX, Markdown, and Lean; use `math_lean_search` for declaration names. Scope searches to relevant files or directories when possible.
- Use `math_compute` for symbolic checks, but state the operation and verify the returned expression independently.
- Keep output bounded: summarize matches and quote only the needed statements or proof steps.
- Use `math_reindex` after `math/` changes when the index needs refreshing.

## Answer shape

1. **Theorem / claim:** precise statement, assumptions, and scope.
2. **Proof / derivation:** lemma plan and justified steps, or the requested computation or lookup.
3. **Verification status:** checks actually run, outcomes, and limits of their coverage.
4. **Sources:** relevant corpus paths and sections; distinguish citations from new work.
5. **Open gaps:** unresolved steps or missing checks, or explicitly none identified.
