# Pilot task review sheet (provisional)

**Status: owner review pending. Not paper evidence.** This sheet is generated from `bench/v2/tasks/pilot-v1.json` so the owner can accept, revise, or reject each task before any real pilot. Do not treat the draft as reviewed because an independent reviewer found no incorrect reference mathematics: rubric, family, and scoring decisions remain the owner’s.

## How to review

For each task, check: (1) the reference mathematics and units/domain/conditions; (2) prompt ambiguity and whether the answer is over-scaffolded; (3) whether the grading contract can distinguish the intended answer from the supplied wrong control; (4) family/partition suitability; (5) whether the task is development/validation only, never an untouched confirmatory test.

Record one decision per task: **accept**, **revise** (state the change), or **reject** (state why). A real pilot must not start until all 30 have an owner decision and the set is frozen.

## Summary

| Track | Tasks | Families |
| --- | ---: | --- |
| citation | 6 | geometry, algebra, analysis, number-theory, evidence, foundations |
| numeric | 4 | geometry, analysis, evidence, foundations |
| symbolic | 2 | algebra, number-theory |
| formal | 6 | geometry, algebra, analysis, number-theory, evidence, foundations |
| explanation | 6 | geometry, algebra, analysis, number-theory, evidence, foundations |
| absence | 6 | geometry, algebra, analysis, number-theory, evidence, foundations |

Total: 30 tasks; 12 negative cases; 6 thematic families.

## citation (6)

### pilot-retrieval-geometry

- Family: `geometry`; domain: `convex geometry`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Using only the supplied source excerpt, return the verbatim sentence about closure of linear Hanner bodies under polarity, with its document and locator and supported=true. Report source support, not independent verification of the manuscript. Copy the supplied locator unchanged; no narrower locator is allowed.
- Reference final: `{"type":"citation","document":"math/preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/build/sections/convex-preliminaries.tex","locator":"L87-L93","claim":"The polar of a linear Hanner body is again a linear Hanner body.","supported":true}`
- Grading: document `math/preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/build/sections/convex-preliminaries.tex`, locator `L87-L93`, supported claim: The polar of a linear Hanner body is again a linear Hanner body.
- Notes: Interior source section, not a first-page PDF excerpt; PDF pagination was not checked.,Source identity and text checked locally; mathematical correctness is not established by citation.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-retrieval-algebra

- Family: `algebra`; domain: `bibliography of algebra`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Find the publication-date line in the supplied README for the characteristic-two direct-finiteness manuscript. Return that complete line verbatim, document, locator, and supported=true. Copy the supplied locator unchanged; no narrower locator is allowed.
- Reference final: `{"type":"citation","document":"math/preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md","locator":"L1-L5","claim":"**Date:** September 23, 2026","supported":true}`
- Grading: document `math/preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md`, locator `L1-L5`, supported claim: **Date:** September 23, 2026
- Notes: Bibliographic metadata only; no endorsement of the claimed counterexample.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-retrieval-analysis

- Family: `analysis`; domain: `analytic number theory`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Quote the complete supplied catalogue paragraph describing the quasi-Riemann manuscript's zero-free half-plane, retaining its pole caveat and markup. Return document, locator and supported=true. This asks what the source claims, not whether the claim has been independently verified. Copy the supplied locator unchanged; no narrower locator is allowed.
- Reference final: `{"type":"citation","document":"math/CONTENTS.md","locator":"L75-L75","claim":"We prove that all finite-order Hecke <i>L</i>-functions over $`\\mathbb Q(\\sqrt{-3})`$ and all Dirichlet <i>L</i>-functions are zero-free in the half-plane $`\\Re s\\gt 7/8`$, with the principal pole at <i>s</i> = 1 allowed. In particular, the Riemann zeta function is zero-free in this half-plane, proving the quasi-Riemann hypothesis.","supported":true}`
- Grading: document `math/CONTENTS.md`, locator `L75-L75`, supported claim: We prove that all finite-order Hecke <i>L</i>-functions over $`\mathbb Q(\sqrt{-3})`$ and all Dirichlet <i>L</i>-functions are zero-free in the half-plane $`\Re s\gt 7/8`$, with the principal pole at <i>s</i> = 1 allowed. In particular, the Riemann zeta function is zero-free in this half-plane, proving the quasi-Riemann hypothesis.
- Notes: Exact catalogue attribution, not a proof or verification receipt. Related preprint README was also inspected.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-retrieval-number-theory

- Family: `number-theory`; domain: `bibliography of number theory`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Quote the body paragraph of the supplied BSD manuscript version note verbatim, excluding the heading but including the link, and return its document and locator with supported=true. Do not infer that any theorem was reverified. Copy the supplied locator unchanged; no narrower locator is allowed.
- Reference final: `{"type":"citation","document":"math/preprints/Exact-Birch-Swinnerton-Dyer-Formula-from-Low-Selmer-Corank-October-7-2026/README.md","locator":"L19-L21","claim":"This version removes an obsolete supporting citation and updates citations to revised manuscripts in this collection; see the [previous version](../Exact-Birch-Swinnerton-Dyer-Formula-from-Low-Selmer-Corank-October-3-2026/exact-bsd-low-selmer-corank.pdf).","supported":true}`
- Grading: document `math/preprints/Exact-Birch-Swinnerton-Dyer-Formula-from-Low-Selmer-Corank-October-7-2026/README.md`, locator `L19-L21`, supported claim: This version removes an obsolete supporting citation and updates citations to revised manuscripts in this collection; see the [previous version](../Exact-Birch-Swinnerton-Dyer-Formula-from-Low-Selmer-Corank-October-3-2026/exact-bsd-low-selmer-corank.pdf).
- Notes: Version-history evidence only; linked prior PDF was not opened.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-retrieval-evidence

- Family: `evidence`; domain: `evidence limitations`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Return the complete two-sentence supplied paragraph stating how the collection should be understood and its stance on credit, with document, locator and supported=true. Copy the supplied locator unchanged; no narrower locator is allowed.
- Reference final: `{"type":"citation","document":"math/README.md","locator":"L12-L12","claim":"In our view, these manuscripts are best understood as a form of raw research data, rather than polished academic papers. We defer to the math community completely on matters of credit, precedence, and concurrent work.","supported":true}`
- Grading: document `math/README.md`, locator `L12-L12`, supported claim: In our view, these manuscripts are best understood as a form of raw research data, rather than polished academic papers. We defer to the math community completely on matters of credit, precedence, and concurrent work.
- Notes: Repository-level attribution; no quality judgment independently established.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-retrieval-foundations

- Family: `foundations`; domain: `formalization coverage`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Quote the complete supplied two-line passage about Lean coverage and the recommended build scope, with document, locator and supported=true. Do not turn some results into all results. Copy the supplied locator unchanged; no narrower locator is allowed.
- Reference final: `{"type":"citation","document":"math/lean/README.md","locator":"L3-L4","claim":"This directory contains Lean formalizations of some results in this repository.\nThey are organized in a single large library, so we recommend compiling only small portions at a time.","supported":true}`
- Grading: document `math/lean/README.md`, locator `L3-L4`, supported claim: This directory contains Lean formalizations of some results in this repository.
They are organized in a single large library, so we recommend compiling only small portions at a time.
- Notes: Coverage wording is source-supported, not an inventory audit.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

## numeric (4)

### pilot-computation-geometry

- Family: `geometry`; domain: `Euclidean geometry`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: A Euclidean triangle has base 6 m and perpendicular height 4 m. Compute its exact area. Use domain nonnegative-real, units m^2, and condition perpendicular height.
- Reference final: `{"type":"numeric","value":12,"domain":"nonnegative-real","units":"m^2","conditions":["perpendicular height"]}`
- Grading: value 12 ± {"absolute":0,"relative":0}, domain `nonnegative-real`, units `m^2`, conditions ["perpendicular height"]
- Notes: Constructed elementary problem; exact reference calculation: 6*4/2 = 12. No corpus claim.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-computation-analysis

- Family: `analysis`; domain: `real integration`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Evaluate the definite integral of 6*x from x=0 to x=1 over the reals. x and the integrand are dimensionless. Use domain real, units dimensionless, and conditions [real integration variable, bounds 0 to 1].
- Reference final: `{"type":"numeric","value":3,"domain":"real","units":"dimensionless","conditions":["real integration variable","bounds 0 to 1"]}`
- Grading: value 3 ± {"absolute":0,"relative":0}, domain `real`, units `dimensionless`, conditions ["real integration variable","bounds 0 to 1"]
- Notes: Elementary antiderivative 3*x^2 gives 3. No external computation run.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-computation-evidence

- Family: `evidence`; domain: `exact proportions`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: In a constructed example, exactly 3 of 8 distinct citation claims are unsupported. Compute the unsupported proportion, not its percentage. Use domain unit-interval, units dimensionless, and conditions [eight distinct claims, three unsupported claims]. This is not observed model data.
- Reference final: `{"type":"numeric","value":0.375,"domain":"unit-interval","units":"dimensionless","conditions":["eight distinct claims","three unsupported claims"]}`
- Grading: value 0.375 ± {"absolute":0,"relative":0}, domain `unit-interval`, units `dimensionless`, conditions ["eight distinct claims","three unsupported claims"]
- Notes: 3/8 is exactly representable as a binary floating-point number. Constructed counts are not paper evidence.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-computation-foundations

- Family: `foundations`; domain: `finite sets`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Let S={a,b,c}, where a,b,c are pairwise distinct. How many subsets does S have, including the empty set and S? Use domain nonnegative-integer, units subsets, and conditions [a b c pairwise distinct, empty and full subsets included].
- Reference final: `{"type":"numeric","value":8,"domain":"nonnegative-integer","units":"subsets","conditions":["a b c pairwise distinct","empty and full subsets included"]}`
- Grading: value 8 ± {"absolute":0,"relative":0}, domain `nonnegative-integer`, units `subsets`, conditions ["a b c pairwise distinct","empty and full subsets included"]
- Notes: Independent binary membership choices give 2^3=8; elementary constructed task.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

## symbolic (2)

### pilot-computation-algebra

- Family: `algebra`; domain: `real algebra`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Give an equivalent expression for (x^2-1)/(x-1) for real dimensionless x, preserving the original domain. An equivalent unsimplified expression is permitted; simplification is not required. Return integer polynomial coefficient arrays in low-to-high order, domain real, units dimensionless, assumptions [x is real], and all restrictions as conditions using != notation.
- Reference final: `{"type":"symbolic","numerator":[1,1],"denominator":[1],"domain":"real","units":"dimensionless","assumptions":["x is real"],"conditions":["x != 1"]}`
- Grading: kind `rational-polynomial`, numerator [1,1], denominator [1], domain `real`, assumptions ["x is real"], conditions ["x != 1"], units `dimensionless`
- Notes: Factorization (x-1)(x+1); cancellation does not restore x=1. Units are explicitly registered as dimensionless. This task asks for equivalence, not simplification, so the constant and original denominator classes are both permitted.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-computation-number-theory

- Family: `number-theory`; domain: `integer equations`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Find the complete set of integer solutions of x^2=2. Return a numeric solutions array, domain integer, units dimensionless, assumptions [x is an integer], and conditions []. Do not include noninteger roots.
- Reference final: `{"type":"symbolic","solutions":[],"domain":"integer","units":"dimensionless","assumptions":["x is an integer"],"conditions":[]}`
- Grading: kind `solution-set`, numerator undefined, denominator undefined, domain `integer`, assumptions ["x is an integer"], conditions [], units `dimensionless`
- Notes: If |x|<=1 then x^2<=1; if |x|>=2 then x^2>=4. Units are explicitly registered as dimensionless in the contract, grading and reference final.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

## formal (6)

### pilot-formal-geometry

- Family: `geometry`; domain: `equality of natural-number coordinates`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Construct Lean code using only import Init declaring theorem pilot_geometry_identity with exactly the type (n : Nat) -> n = n. Do not change the target or add premises or axioms. Return the solution code, not a claimed verification receipt.
- Reference final: `{"type":"formal","solution":"import Init\n\ntheorem pilot_geometry_identity : (n : Nat) -> n = n := by\n  intro n\n  rfl\n","target_sha256":null,"receipt_sha256":null}`
- Grading: theorem `pilot_geometry_identity`, type `(n : Nat) -> n = n`, imports ["Init"], allowed axioms []; evaluator spec still built from `formal`
- Notes: Reference proof candidate only; no Lean execution or trusted receipt. Geometry family is a provisional coordinate-themed grouping, not a corpus-family claim.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-formal-algebra

- Family: `algebra`; domain: `natural-number arithmetic`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Construct Lean code using only import Init declaring theorem pilot_algebra_add_zero with exactly the type (n : Nat) -> n + 0 = n. Do not change the target or add premises or axioms. Return solution code without claiming verification.
- Reference final: `{"type":"formal","solution":"import Init\n\ntheorem pilot_algebra_add_zero : (n : Nat) -> n + 0 = n := by\n  intro n\n  rfl\n","target_sha256":null,"receipt_sha256":null}`
- Grading: theorem `pilot_algebra_add_zero`, type `(n : Nat) -> n + 0 = n`, imports ["Init"], allowed axioms []; evaluator spec still built from `formal`
- Notes: Reference proof candidate only; no Lean execution or trusted receipt. Definitional equality and equivalent imported results require contamination review.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-formal-analysis

- Family: `analysis`; domain: `composition of implications`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Construct Lean code using only import Init declaring theorem pilot_analysis_implications with exactly the type (P Q R : Prop) -> (P -> Q) -> (Q -> R) -> P -> R. No added premises or axioms. Return solution code without claiming verification.
- Reference final: `{"type":"formal","solution":"import Init\n\ntheorem pilot_analysis_implications : (P Q R : Prop) -> (P -> Q) -> (Q -> R) -> P -> R := by\n  intro P Q R hPQ hQR hP\n  exact hQR (hPQ hP)\n","target_sha256":null,"receipt_sha256":null}`
- Grading: theorem `pilot_analysis_implications`, type `(P Q R : Prop) -> (P -> Q) -> (Q -> R) -> P -> R`, imports ["Init"], allowed axioms []; evaluator spec still built from `formal`
- Notes: Reference proof candidate only; no Lean execution or trusted receipt. Logic exercise assigned to a provisional analysis-reasoning family.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-formal-number-theory

- Family: `number-theory`; domain: `closed natural-number arithmetic`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Construct Lean code using only import Init declaring theorem pilot_number_theory_sum with exactly the type (2 : Nat) + 3 = 5. No added premises or axioms. Return solution code without claiming verification.
- Reference final: `{"type":"formal","solution":"import Init\n\ntheorem pilot_number_theory_sum : (2 : Nat) + 3 = 5 := by\n  rfl\n","target_sha256":null,"receipt_sha256":null}`
- Grading: theorem `pilot_number_theory_sum`, type `(2 : Nat) + 3 = 5`, imports ["Init"], allowed axioms []; evaluator spec still built from `formal`
- Notes: Reference proof candidate only; no Lean execution or trusted receipt.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-formal-evidence

- Family: `evidence`; domain: `conjunction of evidence propositions`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Construct Lean code using only import Init declaring theorem pilot_evidence_conjunction with exactly the type (P Q : Prop) -> P ∧ Q -> Q ∧ P. No added premises or axioms. Return solution code without claiming verification.
- Reference final: `{"type":"formal","solution":"import Init\n\ntheorem pilot_evidence_conjunction : (P Q : Prop) -> P ∧ Q -> Q ∧ P := by\n  intro P Q h\n  exact And.intro h.right h.left\n","target_sha256":null,"receipt_sha256":null}`
- Grading: theorem `pilot_evidence_conjunction`, type `(P Q : Prop) -> P ∧ Q -> Q ∧ P`, imports ["Init"], allowed axioms []; evaluator spec still built from `formal`
- Notes: Reference proof candidate only; no Lean execution or trusted receipt. Provisional evidence-themed logic task, not evidence of empirical claims.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-formal-foundations

- Family: `foundations`; domain: `propositional truth`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Construct Lean code using only import Init declaring theorem pilot_foundations_true with exactly the type True. No added premises or axioms. Return solution code without claiming verification.
- Reference final: `{"type":"formal","solution":"import Init\n\ntheorem pilot_foundations_true : True := by\n  exact True.intro\n","target_sha256":null,"receipt_sha256":null}`
- Grading: theorem `pilot_foundations_true`, type `True`, imports ["Init"], allowed axioms []; evaluator spec still built from `formal`
- Notes: Reference proof candidate only; no Lean execution or trusted receipt. Trivial public target, unsuitable as novel-proof evidence.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

## explanation (6)

### pilot-error-geometry

- Family: `geometry`; domain: `Euclidean triangle conditions`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Assess whether the argument is valid; if invalid, identify the specific defect and give a valid correction; if valid, explain why. Argument: A Euclidean triangle has adjacent sides 3 m and 4 m, so its area is (3*4)/2=6 m^2, regardless of their included angle.
- Reference final: `{"type":"explanation","text":"The included angle is missing. The area is 6*sin(theta) m^2 for 0 < theta < pi, and it equals 6 m^2 only when theta = pi/2."}`
- Grading: frozen rubric ["identifies_defect","valid_correction"]; exact-fixture hashes, not free-form adjudication
- Notes: Constructed argument; exact-text rubric fixtures are author-scored proposals, not independent judgments. Unknown prose requires review, never an LLM judge.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-error-algebra

- Family: `algebra`; domain: `cancellation hypotheses`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Assess whether the argument is valid; if invalid, identify the specific defect and give a counterexample or correction; if valid, explain why. Argument for real a,b,c: From ab=ac, divide both sides by a to conclude b=c.
- Reference final: `{"type":"explanation","text":"Cancellation requires a != 0. With a=0, b=1, c=2, ab=ac but b!=c. Adding a != 0 makes the division valid."}`
- Grading: frozen rubric ["identifies_defect","valid_correction"]; exact-fixture hashes, not free-form adjudication
- Notes: Exact-text labels are provisional; counterexample uses only elementary real arithmetic.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-error-analysis

- Family: `analysis`; domain: `limits and finite sums`; negative: false; provisional: true; review: `owner-review-pending`
- Prompt: Assess whether the argument is valid; if invalid, identify the specific defect; if valid, explain why. Argument for real sequences: If a_n tends to a and b_n tends to b, then for every epsilon>0 both errors are eventually less than epsilon/2. The triangle inequality then shows a_n+b_n tends to a+b.
- Reference final: `{"type":"explanation","text":"The argument is valid. Choose N as the maximum of the two epsilon/2 thresholds. For n>=N, |(a_n+b_n)-(a+b)| <= |a_n-a|+|b_n-b| < epsilon."}`
- Grading: frozen rubric ["recognizes_valid_argument","explains_common_index"]; exact-fixture hashes, not free-form adjudication
- Notes: Positive control: do not label every argument defective. Exact-text rubric is provisional.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-error-number-theory

- Family: `number-theory`; domain: `primality`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Assess whether the argument is valid; if invalid, identify the specific defect and provide a counterexample or corrected criterion; if valid, explain why. Argument: Every integer n>1 is prime because it is divisible by 1 and itself.
- Reference final: `{"type":"explanation","text":"Being divisible by 1 and itself is not sufficient. A prime integer greater than 1 has no other positive divisors. The integer 4 also has divisor 2, so it is a counterexample."}`
- Grading: frozen rubric ["identifies_defect","valid_correction"]; exact-fixture hashes, not free-form adjudication
- Notes: Elementary counterexample 4=2*2; author-scored labels await independent review.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-error-evidence

- Family: `evidence`; domain: `verification evidence`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Assess whether the argument is valid; if invalid, identify the specific defect and state what evidence would be needed; if valid, explain why. In a hypothetical run, an agent prints VERIFIED in its own final message. No evaluator receipt, target comparison, or axiom audit is supplied. A report concludes that the fixed target was independently verified.
- Reference final: `{"type":"explanation","text":"The printed marker is not verification evidence. The outcome is unverified without an evaluator-controlled receipt matching the fixed target and submitted solution and checking the allowed axiom policy."}`
- Grading: frozen rubric ["rejects_unsupported_verification","identifies_required_evidence"]; exact-fixture hashes, not free-form adjudication
- Notes: Hypothetical scenario, not a report of an actual run. Rubric follows the supplied protocol's evidence distinction.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-error-foundations

- Family: `foundations`; domain: `quantifier order`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Assess whether the argument is valid; if invalid, identify the specific defect and justify the correction; if valid, explain why. Argument over natural numbers: Since for every n there exists m with m>n, there exists one natural number m such that m>n for every n.
- Reference final: `{"type":"explanation","text":"The quantifiers cannot be exchanged. The premise holds by choosing m=n+1 separately for each n. A single m cannot exceed every n, since taking n=m would require m>m."}`
- Grading: frozen rubric ["identifies_defect","valid_correction"]; exact-fixture hashes, not free-form adjudication
- Notes: Constructed elementary logic task; pre-scored labels are not independent ground truth yet.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

## absence (6)

### pilot-absence-geometry

- Family: `geometry`; domain: `bounded geometry evidence`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: The supplied lemma is the entire consulted inventory for this task, not the entire corpus. It is available to read. Does it state a classification of all nonconvex volume-product minimizers? Return an absence status, consulted document#locator identifiers, and a scope explanation distinguishing not found here from nonexistent or unavailable. Do not search beyond the supplied excerpt. Put the scope explanation in prose, using the words not found in consulted excerpts and explicitly stating that the consulted inventory is non-exhaustive; do not claim corpus-wide nonexistence.
- Reference final: `{"type":"absence","status":"not_found_in_consulted_excerpts","consulted":["math/preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/build/sections/convex-preliminaries.tex#L87-L93"],"prose":"The requested classification was not found in consulted excerpts. The Hanner lemma is available, but this limited inventory does not establish corpus-wide nonexistence. The consulted inventory is non-exhaustive."}`
- Grading: status `not_found_in_consulted_excerpts`, consulted ["math/preprints/The-symmetric-Mahler-conjecture-and-its-equality-cases-September-22-2026/build/sections/convex-preliminaries.tex#L87-L93"], exhaustive_inventory false; same-status wrong-prose control present
- Notes: Only the listed excerpt was assessed for the requested proposition; no corpus-wide absence search. Task-local exact-prose grading is available; runner integration remains pending.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-absence-algebra

- Family: `algebra`; domain: `bounded algebra bibliography`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Only the supplied, available README header has been consulted. Find a DOI for this manuscript in that header. Return an absence status, consulted document#locator identifiers, and explain whether this establishes that the manuscript has no DOI anywhere. This is not a complete bibliographic inventory. Put the scope explanation in prose, using the words not found in consulted excerpts and explicitly stating that the consulted inventory is non-exhaustive; do not claim corpus-wide nonexistence.
- Reference final: `{"type":"absence","status":"not_found_in_consulted_excerpts","consulted":["math/preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md#L1-L5"],"prose":"A DOI was not found in consulted excerpts. The header was available; its silence does not prove that the manuscript has no DOI elsewhere. The consulted inventory is non-exhaustive."}`
- Grading: status `not_found_in_consulted_excerpts`, consulted ["math/preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md#L1-L5"], exhaustive_inventory false; same-status wrong-prose control present
- Notes: No external DOI lookup or complete bibliography search. Task-local exact-prose grading is available; runner integration remains pending.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-absence-analysis

- Family: `analysis`; domain: `bounded analytic claims`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: The supplied catalogue paragraph is available and is the only consulted excerpt. Find a statement that all nontrivial zeta zeros have real part exactly 1/2. Return the absence status, consulted identifiers and a scope explanation. Do not confuse a stated zero-free half-plane with a statement of the full Riemann hypothesis, or infer corpus-wide nonexistence. Put the scope explanation in prose, using the words not found in consulted excerpts and explicitly stating that the consulted inventory is non-exhaustive; do not claim corpus-wide nonexistence.
- Reference final: `{"type":"absence","status":"not_found_in_consulted_excerpts","consulted":["math/CONTENTS.md#L75-L75"],"prose":"The full critical-line statement was not found in consulted excerpts. This available paragraph states a zero-free half-plane, not that every nontrivial zero has real part 1/2; other corpus material was not assessed. The consulted inventory is non-exhaustive."}`
- Grading: status `not_found_in_consulted_excerpts`, consulted ["math/CONTENTS.md#L75-L75"], exhaustive_inventory false; same-status wrong-prose control present
- Notes: Source claims only; no assessment of either hypothesis's mathematical truth. Task-local exact-prose grading is available; runner integration remains pending.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-absence-number-theory

- Family: `number-theory`; domain: `bounded version evidence`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Only the supplied BSD version note has been consulted and it is available. Find an evaluator-issued Lean verification receipt with a target hash in this note. Return an absence status, consulted identifiers and an explanation. Do not infer that no proof or receipt exists elsewhere. Put the scope explanation in prose, using the words not found in consulted excerpts and explicitly stating that the consulted inventory is non-exhaustive; do not claim corpus-wide nonexistence.
- Reference final: `{"type":"absence","status":"not_found_in_consulted_excerpts","consulted":["math/preprints/Exact-Birch-Swinnerton-Dyer-Formula-from-Low-Selmer-Corank-October-7-2026/README.md#L19-L21"],"prose":"A target-hashed verification receipt was not found in consulted excerpts. The available version note discusses citation changes; it does not establish that receipts or formal proofs are absent elsewhere. The consulted inventory is non-exhaustive."}`
- Grading: status `not_found_in_consulted_excerpts`, consulted ["math/preprints/Exact-Birch-Swinnerton-Dyer-Formula-from-Low-Selmer-Corank-October-7-2026/README.md#L19-L21"], exhaustive_inventory false; same-status wrong-prose control present
- Notes: A version note is not a verification inventory. Task-local exact-prose grading is available; runner integration remains pending.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-absence-evidence

- Family: `evidence`; domain: `bounded collection policy`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Only the supplied, available collection README paragraph has been consulted. Find an assertion in it that every manuscript passed independent peer review. Return absence status, consulted identifiers and a bounded explanation distinguishing missing evidence, nonexistence and unavailability. Put the scope explanation in prose, using the words not found in consulted excerpts and explicitly stating that the consulted inventory is non-exhaustive; do not claim corpus-wide nonexistence.
- Reference final: `{"type":"absence","status":"not_found_in_consulted_excerpts","consulted":["math/README.md#L12-L12"],"prose":"An assertion of universal independent peer review was not found in consulted excerpts. The paragraph is available but does not inventory review histories; no corpus-wide nonexistence conclusion follows. The consulted inventory is non-exhaustive."}`
- Grading: status `not_found_in_consulted_excerpts`, consulted ["math/README.md#L12-L12"], exhaustive_inventory false; same-status wrong-prose control present
- Notes: No claim is made about actual peer-review histories. Task-local exact-prose grading is available; runner integration remains pending.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

### pilot-absence-foundations

- Family: `foundations`; domain: `unavailable evidence scenario`; negative: true; provisional: true; review: `owner-review-pending`
- Prompt: Hypothetical task environment: the corpus cannot be mounted or read, and no excerpts, search results, or inventory are supplied. You are asked whether it contains a proof of a named target. Return the appropriate absence status, an empty consulted list, and explain why neither a negative search result nor nonexistence follows. These conditions are a scenario, not a report of this machine's state. Put the scope explanation in prose; distinguish unavailable evidence from not found in consulted excerpts and from nonexistence.
- Reference final: `{"type":"absence","status":"corpus_unavailable","consulted":[],"prose":"The corpus is unavailable in the stated scenario, and no excerpts were consulted. This is not an executed search yielding no match and does not establish nonexistence of a proof."}`
- Grading: status `corpus_unavailable`, consulted [], exhaustive_inventory false; same-status wrong-prose control present
- Notes: Hypothetical unavailability must be passed as evaluator context, not inferred from actual host access. Task-local exact-prose grading is available; runner integration remains pending.
- Owner decision: [ ] accept  [ ] revise  [ ] reject
- Reviewer notes: 

## Known limitations (do not sign off as paper evidence)

- Retrieval and absence tasks intentionally expose the excerpt; they test bounded extraction/scope, not open corpus search.
- Explanation/error tasks use exact fixture hashes; valid paraphrases are not graded without blinded human adjudication.
- Absence prose scoring is a heuristic plus frozen exact-prose fixtures; it is not semantic adjudication.
- Families are thematic, not independent leakage groups; the same excerpt or logical target can recur.
- Formal references passed a local evaluator-controlled Docker smoke (6/6, no axioms), but the runner must still attach receipts and the bridge is not an independent kernel check.
- The set is development/validation material; it cannot be reused as untouched confirmatory test evidence.
