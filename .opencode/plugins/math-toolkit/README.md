# Math toolkit

A project-local OpenCode math copilot using the bundled `math/` clone of `openai/math`. It provides corpus lookup and wrappers for external formal-verification tools; it does not perform model inference itself.

## Prerequisites

- Node.js 24.
- OpenCode 2.0.29+ with the V2 plugin API. The entry point uses `Plugin.define` from `@opencode/plugin`; V1 plugin implementations do not run in OpenCode 2.x.
- `@opencode/plugin@2.0.29` available from the repo's `npm install` (OpenCode also provides it at runtime).
- A clone of `openai/math` at `math/` for manuscript reads, grep, PDF extraction, Lean search, and the Lean tools. The prebuilt index makes `math_search` usable without it.
- `npm install` installs `unpdf` for PDF extraction.
- Recommended: `ripgrep` (`rg`) for fast Lean declaration search. Without it, the prebuilt `data/lean-index.json.gz` is used, then a bounded Node fallback.
- Optional: elan with the pinned Lean/Lake toolchain; Docker for reproducible Linux Lean verification; Comparator, landrun, and lean4export in Linux/Docker for challenge checks; LaTeX for document builds; Python 3 + SymPy for computations.

Lean, Lake, Comparator, and LaTeX are optional. Missing prerequisites must be reported, not treated as successful verification. Run `math_status` for current availability. Native Windows Lean builds can be blocked by an NTFS-invalid path in the pinned dependency set; Docker is the recommended path (`docker/README.md`).

## Install / verify

After the prerequisites are installed, run from the repo root:

```powershell
npm install
npm run index
opencode.cmd plugin list
```

Confirm the project-local plugin appears in the list, then use `math_status` in an OpenCode session. This is not a global plugin installation.

## Tools

| Tool | Purpose |
| --- | --- |
| `math_search` | BM25 search across manuscripts, returning abstracts, PDF paths, and Lean formalization status. |
| `math_manuscript` | Read metadata, abstract, file outline, section headings, or a specific LaTeX section. |
| `math_grep` | Search TeX, Markdown, and Lean text under `math/`. |
| `math_lean_check` | Type-check a Lean 4 snippet or file with `lake env lean`. |
| `math_lean_build` | Build a focused Lake target such as `OAI.Analysis`. |
| `math_lean_search` | Search declaration lines in `math/lean` and Mathlib by name or regex. |
| `math_pdf_text` | Extract bounded text from a manuscript PDF (no OCR). |
| `math_compute` | Restricted SymPy operations over allowlisted expressions/matrices. |
| `math_comparator` | Run an existing Comparator challenge JSON. |
| `math_status` | Report index counts and toolchain availability. |
| `math_reindex` | Rebuild the manuscript index after `math/` changes. |

Use `/math <problem>` to invoke the project command, which loads the `math-workflow` skill. Lean tools are used when formal verification or a Lean statement is requested.

## Refresh the index

After changing or updating `math/`, invoke `math_reindex`, or run from the workspace root:

```powershell
npm run index
npm run index:lean
```

`index:lean` regenerates the gzip declaration index used when `rg` is unavailable.

Restart OpenCode or reload the project session after rebuilding so the active plugin uses the refreshed index. Check counts with `math_status`.

## Example session

1. Ask: “Use `math_search` to find manuscripts about concentration inequalities.”
2. Choose a returned manuscript identifier and ask: “Use `math_manuscript` to read its outline, then only the section containing the relevant theorem.”
3. If the TeX source is missing, ask: “Use `math_pdf_text` on this preprint directory, pages 1–3.”
4. Ask: “Use `math_lean_search` for `linearizedMA_critical_density`, then `math_lean_check` this snippet.”

   ```lean
   import Mathlib
   example (n : Nat) : n + 0 = n := by simp
   ```

Report the actual check result, or the missing-toolchain error. This snippet checks only its stated identity, not the manuscript's theorem.

For symbolic work, use `math_compute` (for example `simplify sin(x)^2+cos(x)^2` or `det [[1,2],[3,4]]`). It is not a general Python executor.

## Limitations

- The plugin provides retrieval and tool execution, not inference or an automatic proof guarantee.
- `CONTENTS.md` maps 721 manuscripts in 373 families; 175 papers currently have Lean formalizations catalogued in `lean/formalization.yaml`. These are raw research data, and not all claims are verified.
- Consult `history.md` for revisions and withdrawals when a result looks suspicious. Cite corpus paths relative to `math/`.
- Lean/Comparator checks require external tools and dependencies. The single `OAI` Lake package is pinned to `leanprover/lean4:v4.34.1`; full builds are huge, so prefer focused targets.
- Windows long-path support is required for this archive; keep Git `core.longpaths=true` enabled and quote paths.
- Corpus file reads are restricted to `math/`; arbitrary files elsewhere are not exposed. The plugin also loads its own code and generated index, and verification invokes external tools.

## File layout

Paths below are relative to the workspace root:

```text
.opencode/plugins/
  math-toolkit.js                  # Project-local plugin entry (V2 default export)
  math-toolkit/
    main.js                       # Plugin.define + ctx.tool.transform registration
    lib/                          # Tool and corpus helpers
    scripts/build-index.mjs        # Index builder
    data/math-index.json           # Generated manuscript index
    README.md
.opencode/skills/math-workflow/SKILL.md
.opencode/commands/math.md
```
