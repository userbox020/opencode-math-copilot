# ArXivLean harness findings

Status: exploratory harness work, not a benchmark result. Seven attempts on
task 1 only produced six timeout/incomplete outcomes and one DSML-only
unverified output; none produced a final Lean block. The five-task set was
selected, not completed; no five- or 60-task study was completed.

## Consolidated outcome

- Across all seven attempts: **0 verified, 0 rejected, 6 timeout/incomplete,
  1 unverified**. The final four clean attempts are a subset: **3 timeout and
  1 unverified**. The first timeout was 900s; clean2 OFF completed in 186s.
- Observed usage subtotals: **1,034,214 tokens, $0.5272**, with incomplete billing.
- Three leakage channels: web/subagent access; `execute.fetch`; and
  `math_lean_check` `#eval`/`IO.Process` with corpus/network access.
- The OFF baseline emits a DSML text tool call instead of a Lean submission.
- The external benchmark is paused. See `RESULTS.md` for the run table and the
  conditions for resuming.

## Why this record exists

The first ArXivLean pilots looked like model timeouts, but inspection of tool
events showed they were also measuring web retrieval and prior-session leakage.
This file records each invalid attempt, the fix, and the minimum conditions for
a valid run.

## Timeline

### 0. Initial full workspace ON, 900 seconds

- Timeout; 15 tools, 70,728 observed tokens, $0.0256 observed cost, no Lean block.
- This attempt is part of the seven-attempt total, not the final clean subset.

### 1. Full workspace, 30-minute ON/OFF (invalid)

- ON: 16 tools, 12 math-tool calls, 184,254 tokens, $0.1130 recorded, timeout.
- OFF: 17 tools, 0 math tools, 157,932 tokens, $0.0714 recorded, timeout.
- Leakage: ON used `webfetch` on arXiv `2609.01010v1` and spawned a librarian
  subagent to extract Theorem 2.1. OFF searched `.opencode/state` and found prior
  prompts.

### 2. Clean workspace v1 (`webfetch` deny only) (invalid)

- The clean workspace had only the math-toolkit plugin and denied `webfetch`,
  `websearch`, subagents, shell, writes, reads, and external directories.
- ON: 55 `execute` calls, 42 `math_lean_check` calls, 273,000 tokens, $0.1202,
  timeout. It was iterating on a 160+ line Lean proof; the last checks were
  narrowing real Lean errors.
- OFF: 100 `execute` calls, 225,641 tokens, $0.1171, timeout. It used the Code
  Mode `fetch` to retrieve `datasets-server.huggingface.co` rows from
  `MathArena/arxivlean-0926_outputs`, including a Claude-Opus-5.5 transcript and
  a proof block. It also called the live Comparator API and search endpoints.
- Root cause: denying the `webfetch` tool does not remove `fetch` from the
  `execute` Code Mode runtime. Both conditions were still online.

### 3. Clean workspace v2 (Code Mode route blocked, not offline)

- The modified temporary plugin copy sets `options: { codemode: false }`, so
  its seven `verify`-toolset tools are direct calls. That selector exists only
  in the temporary copy: the checked-in plugin treats unknown toolsets,
  including `verify`, as full. An environment label alone does not mask tools.
- The config denies `execute`, `webfetch`, `websearch`, subagents, shell, writes,
  reads, grep/glob, `external_directory`, `question`, and `skill`.
- Probe results:
  - `math_status` and `math_compute` are callable directly.
  - The model reports `execute` as an unknown tool.
  - The available tools are `math_status`, `math_doctor`, `math_compute`,
    `math_lean_check`, `math_lean_build`, `math_lean_verify`,
    `math_comparator`. Lean elaboration still provided a network/filesystem path.
- These probes established only that the direct Code Mode route was blocked.
  They did not establish offline operation or OS isolation.
- Clean2 OFF result: completed in 186s with 0 tools and no Lean block. It emitted
  `<｜DSML｜ calls>` / `<｜DSML｜ invoke name="execute">` as plain text because
   the model expected an `execute` tool that the restricted config denies. The
  grader classifies this as `unverified` (agent-interface failure), not
  `rejected`.
- Implication: OFF is not yet a fair no-tools baseline. It needs either a safe
  generic sandbox with no network (for example a network-isolated Python/Lean
  runner) or a model that does not emit DSML tool-call text.

### 4. Clean2 ON: `math_lean_check` escape (invalid for math)

- ON: 24 direct math-tool calls, 122,659 tokens, $0.0799, 30-minute timeout, no
  Lean block.
- 22 calls were `math_lean_check`; many inputs used Lean
  `#eval do ... IO.Process.output { cmd := "bash", ... }`.
- The model scanned `/work/math/preprints` (778 PDFs) for
  Motzkin/stability/sum-of-squares text and ran `pip install pypdf` inside the
  container. It did not produce a Lean proof.
- Implication: `math_lean_check` is not a safe verification sandbox. It exposes
  arbitrary process execution, the corpus volume, and network access inside
  Docker. Lean can execute arbitrary elaboration code without literal `#eval`,
  `IO`, or `Process` tokens, so keyword bans and a compile-only label are not
  containment. Controlled evaluation needs an OS-isolated unprivileged runtime,
  immutable dependencies, no network/corpus/secrets, resource limits, and an
  independent trusted checker outside the solver's control.

## What the plugin did well

- In the clean v1 ON run, the model used `math_lean_check` with `docker: true`
  and iterated on concrete Lean errors. The proof grew past 160 lines and the
  errors narrowed, but 30 minutes was insufficient.
- Host `math_lean_check` failed on a trivial `(1:ℝ) + 1 = 2`; Docker mode passed.
  The model discovered Docker after the host failure. This is a real Windows
  usability issue: the default host path is broken, and the Docker path should
  be more prominent.

## Minimum conditions for a valid run

1. Fresh workspace with no prior sessions, prompts, or `.opencode/state` logs.
2. Only the intended plugin; no slim/subagent plugin.
3. No `execute` tool, or a network-isolated container. A `webfetch` deny alone is
   not sufficient.
4. `codemode: false` on the plugin tools, so verification/computation remains
   available without Code Mode.
5. Inspect the actual tool inventory and mask answer-bearing corpus/PDF access.
   `MATH_TOOLKIT_TOOLSET=verify` worked only in the modified temporary plugin;
   it does not select a restricted toolset in the checked-in plugin.
6. Comparator grading; timeouts and missing submissions are `incomplete`, not
   `rejected`.
7. Positive and negative checker controls plus OS/network/filesystem isolation
   probes before model spending. Confirming `execute` is unknown is necessary
   for that configuration, but insufficient to validate containment.

## Open decision

There was no validated comparison: six task-1 attempts timed out (the first at
900s), while clean2 OFF returned DSML text in 186s. Budget, model, and task
selection remain open. First validate the pipeline using known positive and
negative controls; do not require a solver to prove this research task as a
pipeline gate. Do not scale to five or 60 tasks before isolation and checker
controls pass and the protocol is frozen.

The OFF condition also needs a safe generic tool. Without one, the model emits a
DSML text tool call and the comparison becomes ON-with-tools versus
OFF-with-no-tools-and-an-agent-interface-failure. Both conditions need OS-level
isolation and an independently trusted grader; the current `math_lean_check`
can read the corpus and run network commands inside Docker.

## Artifact paths

- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-smoke5-on-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-smoke5-off-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean-on-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean-off-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean2-on-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean2-off-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-env` — clean workspace
