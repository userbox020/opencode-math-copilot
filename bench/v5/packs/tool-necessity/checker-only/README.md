# Checker-only plugin smoke — 2026-11-19 UTC

**Exploratory, one model, one repeat. Not confirmatory. No broad math claim.**

## Configuration

- Workspace: `C:\_Work\_bench-stable\checker-20261118`, outside Temp. The
  earlier Temp checker workspace was invalidated when its plugin entry, corpus
  junction, and staged cache disappeared mid-run; that run is preserved as
  invalid and is not pooled here.
- Plugin: real `math-toolkit` copied, then `selectedToolNames` reduced to
  exactly `math_lean_verify`, `math_compute`, `math_comparator`.
- `options: { codemode: false }`: the evaluation config denies `execute`, and
  with the production `codemode: true` the tools were hidden from the model.
- Generic `read`/`grep`/`glob` allowed in both arms. Web, execute, bash/shell,
  edit/write, ast-grep, task, and external-directory tools denied.
- OFF: `MATH_TOOLKIT_DISABLE=1`.

## Inventory

- ON: `math_compute` executed `operation=evalf, expression=2+2` and returned
  `4.00000000000000`; `math_status` was absent. Only the three whitelisted math
  tools registered.
- OFF: no math tools.

## Text non-harm smoke

Task `tool-text-01` from `tool-necessity/pilot.json`, one task, 300 s.

| Arm | Grade | Tool events |
|---|---|---|
| plugin-on | correct | glob 6, grep 2, read 4; **zero math calls** |
| plugin-off | correct | glob 4, grep 6, read 3 |

This is one task, not a benchmark. It shows the checker-only surface did not
distract the model from the generic grep/read path, unlike the full plugin
(ON 6/10 vs OFF 9/10 over ten tasks) and the narrowed plugin (ON incorrect vs
OFF correct on this same task).

## Lean preservation pilot

Five tasks from `lean-necessity/pilot.json`, 300 s, Docker image
`opencode-math-lean` and volume present at start.

| Arm | Correct | Tool events |
|---|---|---|
| plugin-on | **5/5** | `math_lean_verify` 16 calls: 0 verified, 3 tool errors, 13 completed with failed compilation; 7 native failures; 1 glob |
| plugin-off | **5/5** | read 2, glob 4, grep 1 |

Paired: **5 both, 0 ON-only, 0 OFF-only, 0 neither, 0 ungraded**.

The ON arm answered by reading the proofs; every checker call failed. Native
Lean is blocked by the known AINTLIB path. Docker was up at the start, but the
checker's Docker calls returned exit 125 or the `npipe` unavailable error, and
Docker went down again after the run. No checker-assisted verification occurred.

## Interpretation

- Checker-only avoids the text-retrieval distraction in this one-task smoke.
- It does **not** demonstrate a Lean verification benefit: both arms ceiling at
  5/5, and the checker verified nothing.
- Checker reliability remains a blocker: host Lean unavailable, Docker
  intermittent.
- The honest product claim is narrow: a checker-only surface is less harmful
  than the full or narrowed toolkit on text retrieval, but no unique capability
  benefit has been measured.

## Evidence

- Text: `C:\_Work\_bench-stable\out\text-plugin-on`, `text-plugin-off`,
  `text-grades-*`.
- Lean: `C:\_Work\_bench-stable\out\lean-plugin-on`, `lean-plugin-off`,
  `lean-grades-*`, `lean-analysis`.
- Run log: `C:\_Work\_bench-stable\out\lean-run.log`.
- Prior invalid Temp run: `C:\Users\MiPC\AppData\Local\Temp\opencode\bench-v5-checker-runtime-20261118\RESULTS.md`
  (contains credentials; do not publish).
