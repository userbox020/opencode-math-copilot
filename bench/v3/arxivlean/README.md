# ArXivLean smoke test

**Status: paused.** A five-task smoke set was selected, but only task 1 was
attempted: **seven attempts, six timeouts and one DSML-only unverified output,
0 verified and 0 rejected**. The first timeout was 900s; the DSML OFF output
completed in 186s. The final four clean attempts are a subset (three timeouts,
one unverified), not the total. No five- or 60-task study was completed.
Observed subtotals are **1,034,214 tokens and $0.5272**, with incomplete billing.
See `RESULTS.md` and `HARNESS-FINDINGS.md` for leakage and interface failures.
Resume only after OS isolation and independent checker controls are validated.

See `HARNESS-FINDINGS.md` for the invalid-run timeline, the `execute.fetch`
leak, and the minimum conditions for a valid offline run.

Pinned source: MathArena repository commit `d98156fa67822629b7554faabeeea5682f4ad0ca`;
dataset `MathArena/arxivlean-0926`, revision `e346a992a3da17797bc2ea616f5fca0e7d61570b`,
split `train`, first five `problem_idx` values 1–5. The task file excludes `answer`.
Prompts use the official September 2026 instruction unchanged, with the problem and frozen definitions inserted.

Conditions run in order: full plugin (`plugin-on`), minimal plugin
(`plugin-on-minimal`, `MATH_TOOLKIT_TOOLSET=minimal`), then plugin-off
(`plugin-off`, `MATH_TOOLKIT_DISABLE=1`). Inherited toolkit switches are cleared first.

From the repository root, in PowerShell:

```powershell
$env:NORMAL_USE_ALLOW_EXECUTE = '1'
node bench/v3/arxivlean/run-arxivlean.mjs --execute --model opencode-go/deepseek-v4.1-flash --condition all --out C:/Users/MiPC/AppData/Local/Temp/opencode/arxivlean-smoke-run
```

Both authorization gates are required. The default workspace is
`C:/_Work/__OPENAI_MATH`; override it with `ARXIVLEAN_WORKSPACE`.
Use `--tasks <file>`, `--limit <N>` (0 means all), or `--timeout-ms <ms>`
(default 900000) to bound the run. Existing episodes are skipped unless `--force` is supplied.
Outputs are `episodes/<taskid>.<condition>.json`,
`submissions/<taskid>.<condition>.lean`, and `manifest.json` beneath the output directory.

Grading is separate:

```text
node bench/v3/arxivlean/grade-arxivlean.mjs --out <dir>
```

Model output alone is not proof; Comparator is the acceptance boundary.
Quota and transport failures are infrastructure failures, not math failures.
Inspect registered `math_*` tools before claiming plugin-ON: environment switches
and observed tool calls alone do not establish which tools were registered.

## Why this uses a local runner

The stock MathArena OpenCode adapter pins OpenCode `1.18.27` and launches with
`--pure`, which disables plugins. It therefore cannot load this project's
OpenCode 2.x V2 plugin. This track keeps the pinned dataset, official September
2026 instruction, and the official Comparator contract, but drives the model
with the workspace's own `opencode run` so ON/OFF conditions are real.

The official instruction mentions `verify_submission`, which is provided by the
MathArena API harness and is not registered in this workspace. It is left in the
prompt verbatim so both conditions see the same benchmark contract; this
mismatch is a harness-adaptation limitation, not evidence about the plugin.

## Leakage control (clean workspace)

The first 30-minute pilots were invalid for a math comparison: the ON run
fetched the source paper with `webfetch` and a librarian subagent, and the OFF
run found prior prompts in `.opencode/state`. The clean re-pilot uses a fresh
workspace at `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-env` with:

- only the math-toolkit plugin (no slim plugin, no subagents);
- deny `webfetch`, `websearch`, `task`, `bash`, `shell`, `edit`, `write`,
  `read`, `grep`, `glob`, and `external_directory`;
- a `math` junction to the corpus for the plugin only; the model has no
  filesystem read tool;
- no prior sessions, prompts, or state logs;
- In the **modified temporary plugin copy only**, `MATH_TOOLKIT_TOOLSET=verify`
  registers only `math_doctor`,
  `math_lean_check`, `math_lean_verify`, `math_lean_build`, `math_compute`,
  `math_comparator`, and `math_status`. Direct corpus/PDF retrieval tools are
  excluded, but Lean execution still exposes corpus and network access. The
  checked-in plugin has no verify selector: unknown toolset values fall through
  to full. Do not treat this environment variable as a checked-in restriction.

The ON condition is therefore labeled `plugin-on-verify` and must be compared
with `plugin-off` from the same clean workspace. Do not compare it directly
with the earlier full-plugin pilot.

**Critical:** denying `webfetch` is not enough. The `execute` Code Mode tool
exposes `fetch`, and the first clean run used it to fetch the MathArena
`arxivlean-0926_outputs` dataset, which contains other models' transcripts and
a proof. The clean plugin copy sets `codemode: false`, so the math tools are
direct tool calls, and the config denies `execute`. Probe that `execute` is
unknown as one probe, not as evidence of offline operation. No truly offline
run was established: Lean elaboration bypassed the apparent tool restrictions.

`math_lean_check` is also not a sandbox. It accepts Lean `#eval`/`IO.Process`,
and its Docker check mounts the corpus with network access. The clean2 ON run
scanned 778 PDFs and installed a package instead of proving. Lean compilation
can execute arbitrary elaboration code even without those literal tokens;
blacklisting them or calling the checker compile-only is not containment.
Controlled runs require an OS-isolated unprivileged runtime, immutable
dependencies, no network/corpus/secrets, resource limits, and an independently
trusted grader outside the solver's control.

## Status meanings

- Episode: `completed` (final assistant text captured), `timeout` (model process
  exceeded `--timeout-ms`), or `failed` (transport/process error).
- Grade: `verified` (Comparator returned `Your solution is okay!`), `rejected`
  (Comparator ran and rejected, or the completed submission was structurally
  invalid), `unverified` (Comparator/infrastructure unavailable), or
  `incomplete` (the model episode did not produce a final submission).

`incomplete` is not a mathematical failure. Do not merge it into `rejected`.

## Historical smoke commands (not a validated isolation recipe)

These commands document the temporary-plugin pilot, not a supported checked-in
`verify` selector. Do not execute another study until positive/negative checker
controls and isolation probes pass. The gate validates the pipeline, not a
solver's ability to prove the chosen research task. Any resumed run needs a
fresh output directory and a frozen protocol.

```powershell
# One-task clean ON pilot (30 minutes)
$env:NORMAL_USE_ALLOW_EXECUTE = '1'
$env:ARXIVLEAN_WORKSPACE = 'C:/Users/MiPC/AppData/Local/Temp/opencode/arxivlean-env'
node bench/v3/arxivlean/run-arxivlean.mjs --execute --model opencode-go/deepseek-v4.1-flash `
  --tasks bench/v3/arxivlean/tasks/arxivlean-smoke5.json `
  --condition plugin-on-verify --limit 1 --timeout-ms 1800000 `
  --out C:/Users/MiPC/AppData/Local/Temp/opencode/arxivlean-smoke-on-pilot

# Grade and report
node bench/v3/arxivlean/grade-arxivlean.mjs --out C:/Users/MiPC/AppData/Local/Temp/opencode/arxivlean-smoke-on-pilot
node bench/v3/arxivlean/build-arxivlean-report.mjs `
  --run on=C:/Users/MiPC/AppData/Local/Temp/opencode/arxivlean-smoke-on-pilot `
  --out C:/Users/MiPC/AppData/Local/Temp/opencode/arxivlean-smoke-report
```

The September competition config sets `max_cost_usd: 100` and no overall time
limit. The recommended smoke adaptation is $2 and 600 seconds per attempt; the
runner's default 900 seconds is a local bound, not the official budget. Record
the chosen bound with every result.
