---
description: Solve or verify a math problem with the bundled corpus and Lean tools
agent: build
---

Load and use the `math-workflow` skill for this request:

$ARGUMENTS

Restate the problem, domain, assumptions, and requested kind of answer. Keep the user's goal fixed.
Run `math_search` first, then use `math_manuscript` to read only relevant abstracts, outlines, and sections. Use `math_grep` for exact names or notation as needed.
For a proof, give a lemma plan before algebra and distinguish corpus results from new derivation.
Use Lean tools only if the request asks for formal verification or a Lean statement: check small snippets, build only the focused target, and run Comparator only if a matching config exists.
Check edge cases, quantifiers, and hypotheses. Report missing prerequisites or failed checks honestly; corpus membership is not verification.
End with **Statement**, **Proof / derivation**, **Verification** (including open gaps), and **Sources** (paths relative to `math/`).
