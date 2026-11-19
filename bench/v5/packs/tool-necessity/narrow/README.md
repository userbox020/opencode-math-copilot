# Narrowed-toolkit smoke — 2026-11-18 local / 2026-11-19 UTC

**Completed: exactly one task per arm, one model, no retries. Not a demonstrated
fix.** Both answers pass the existing whitespace-normalized quote grader, but
the OFF episode was exposed to the saved ON answer through a broad `grep`.
The paired comparison is therefore contaminated and must not be interpreted
as evidence that removing the three tools caused an improvement.

## Workspace and patch

Copied workspace:

```text
C:\Users\MiPC\AppData\Local\Temp\opencode\math-bench-env-narrow-20261118
```

Source: `...\math-bench-env-v2-20261118`. Copied `.opencode` and recreated its
`math` junction to `C:\_Work\__OPENAI_MATH\math`; did not traverse/copy the corpus.
Neither v2, the real plugin/workspace, nor existing packs was edited.

Only the copied plugin's `main.js` registration selection was changed:

```diff
 export function selectedToolNames(environment = process.env) {
-  const names = Object.keys(inputs);
+  // Temporary narrowed experiment: retain implementations; omit only registration.
+  const omitted = new Set(["math_search", "math_manuscript", "math_grep"]);
+  const names = Object.keys(inputs).filter(name => !omitted.has(name));
```

Exactly `math_search`, `math_manuscript`, and `math_grep` are omitted. Their
implementations, schemas, descriptions, imports, and minimal-set constants
remain. Searching the copied source confirmed those retained references;
`lib/pdf.js` still advises `math_search` in one failure message. No unrelated
code was removed. `math_reindex` remains because the instruction was to omit
exactly three registrations and keep all others.

The copied config omits the denials of `read`, `grep`, `glob`, `list`, and
`find`. Web, execute, shell/bash, edit/write, AST-grep, LSP, task/task-lifecycle,
and external-directory denials remain. The direct-tool `codemode: false` setting
and `oh-my-opencode-slim@2.2.24` provider route remain. OFF sets
`MATH_TOOLKIT_DISABLE=1`; neither arm sets the minimal-toolset mode.

After clarification delegated the runtime choice, credentials-only runtime
state and the cached slim package were staged under `.runtime/` in the copied
workspace; no prior sessions were copied. OpenCode home/config/data/state/cache
and temporary directories were redirected there. No credentials were printed
or added to this repository. **The temporary runtime contains sensitive material;
do not commit or publish it.** Provider inference was the selected network
exception; no web tools, external research, Docker, or dependency downloads
were used. This setup is not an OS sandbox.

## Inventory

A paired inventory probe asked each arm for its actual callable names; ON was
also asked to call `math_status` once if available. Model-reported inventories
were checked against the copied registration-selection function and config.
This is not an independently captured provider-schema inventory.

Both arms report these six non-math tools:

```text
glob, grep, question, read, skill, wait_for_user
```

`list` and `find` are no longer denied, but are not separate registered tools
in the observed inventory.

ON additionally reports all 13 retained math tools:

```text
math_comparator, math_compute, math_doctor,
math_lean_build, math_lean_check, math_lean_search, math_lean_verify,
math_pdf_corpus_search, math_pdf_index_search, math_pdf_search, math_pdf_text,
math_reindex, math_status
```

ON reports none of the three omitted tools. OFF reports no math tools.
ON probe: one completed `math_status` event, 32.109 s. OFF probe: zero tool
events, 7.564 s. Raw events and extracted inventories are preserved as
`inventory-plugin-{on,off}.raw.jsonl` and `inventory-plugin-{on,off}.json`
inside the copied workspace.

## Smoke protocol and results

Model: `opencode-go/deepseek-v4.1-flash`; CLI: 2.0.29.
Task: only `tool-text-01` from the unchanged `pilot.json`.
Original prompt, fresh sessions, ON then OFF, one repeat, 300-second timeout,
no retries or fallback. The remaining nine pilot tasks were not run.

The existing `bench/v5/external/run.mjs` was run once per condition with:

```text
--tasks <tool-necessity/pilot.json>
--model opencode-go/deepseek-v4.1-flash
--condition plugin-on|plugin-off
--limit 1 --repeat 1 --timeout-ms 300000
--out <copied-workspace>/smoke-on|smoke-off
```

`EXTERNAL_BENCH_WORKSPACE` pointed at the copied workspace. The unchanged
`bench/v5/external/grade.mjs` produced `grades-on/` and `grades-off/`.

| Arm | Completion | Existing quote grade | Exact raw quote | Calls | Wall duration |
|---|---|---|---|---:|---:|
| ON | completed, exit 0 | correct (1/1) | fail: LF rather than CRLF | 16 | 51.010 s |
| OFF | completed, exit 0 | correct (1/1), contaminated | fail: LF rather than CRLF | 5 | 21.613 s |

Tools counted from actual `tool_use` events, not lexical mentions:

- ON: `glob` 6, `read` 5, `grep` 2, `math_pdf_index_search` 1,
  `math_status` 1, `math_pdf_corpus_search` 1.
- OFF: `glob` 1, `grep` 3, `read` 1.

Both returned the correct source path, ending
`build/manuscript/approximation.tex`, and starting line 14 (sentence spans
14–15). Both quotes match after newline normalization, but the returned
code-block strings contain LF, not the source's CRLF. Both describe CRLF in
prose; that does not make the quoted string byte-exact. The existing quote
grader normalizes all whitespace/NFKC and checks presence in the final answer;
its pass is not an exact-source-formatting pass or mathematical accuracy.

## Residual issues and interpretation

1. **Cross-arm answer leakage:** OFF's second tool call, a workspace-wide
   `grep` for the section name, returned the saved ON episode and raw trace,
   including the answer and locator. OFF then read the actual source, but it
   was no longer an independent retrieval trial. Artifacts/runtime were inside
   the model-searchable workspace because of the bounded write locations.
   This is an experimental setup error, not a clean OFF baseline. No extra
   episode was run to repair it because the two-episode cap was reached.
2. ON eventually retrieved the answer with generic tools, but first spent
   calls on retained PDF tools. The PDF excerpt search found no match; the
   PDF corpus search skipped candidates because `unpdf` was not installed.
   No dependencies were installed to change the copied environment.
3. ON used 16 calls versus OFF's 5 and took longer, but OFF's contamination,
   fixed ordering, caching, and one observation make an efficiency comparison
   unreliable. Removal did not eliminate all tool-selection detours.
4. The writable corpus junction and retained build/reindex/checker tools are
   not a security boundary. Runtime credentials and saved answers were not
   physically isolated from generic filesystem tools; a future approved
   experiment needs private artifacts/runtime outside the searchable project.
5. One task and one model cannot establish that the redundant tools caused the
   historical 6/10 versus 9/10 gap. No baseline full-plugin rerun was made.
   The supported result is limited to: **the registration filter works, and ON
   produced a normalized-correct answer on this smoke.**

## Verification and artifacts

`audit-smoke.mjs` in the copied workspace passed after its local JSON reader
was adjusted to accept the copied config's existing BOM. It checks the exact
three-name omission, that `main.js` differs from v2 only by the shown filter,
generic-tool permission omissions, retained denials/direct-tool setting,
reported inventory agreement, one scheduled task per arm, grades, newline
fidelity, tool counts, and exposure of the prior answer.

`smoke-audit.json` contains the inventory, event summaries, raw-trace SHA-256s,
durations, grades, and `comparison_valid: false`. The manifests, full raw
events, answers, and grades remain under `smoke-{on,off}/` and
`grades-{on,off}/` in the copied workspace. No full benchmark or broader test
suite was run.
