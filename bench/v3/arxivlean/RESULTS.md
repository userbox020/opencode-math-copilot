# ArXivLean results

Status: **paused; exploratory; 0 verified.** These are harness runs, not a
benchmark result. Do not use them to claim that the plugin improves or harms
mathematical performance.

## Pinned source

- MathArena repository commit `d98156fa67822629b7554faabeeea5682f4ad0ca`.
- Dataset `MathArena/arxivlean-0926`, revision
  `e346a992a3da17797bc2ea616f5fca0e7d61570b`, split `train`, 53 rows.
- Frozen smoke set: `problem_idx` 1–5.
- Lean `4.34.1`, mathlib `d13f23b723b8a846827a245b89c10fc7d3f11612`.
- Comparator assets: `comparator` + `lean4export` built for `v4.34.0` with
  Lean `v4.34.1`.

## Runs

| Run | Condition | Result | Evidence |
|---|---|---|---|
| 900s full workspace | ON | `incomplete` timeout | 15 tools, 70,728 tokens, $0.0256, no Lean block |
| 1800s full workspace | ON | `incomplete` timeout | 16 tools, 12 math-tool calls, 184,254 tokens, $0.1130; fetched arXiv and used a librarian subagent |
| 1800s full workspace | OFF | `incomplete` timeout | 17 tools, 157,932 tokens, $0.0714; found prior prompts in `.opencode/state` |
| Clean v1 | ON | `incomplete` timeout | 55 `execute` calls, 42 `math_lean_check`, 273,000 tokens, $0.1202; `execute.fetch` available |
| Clean v1 | OFF | `incomplete` timeout | 100 `execute` calls, 225,641 tokens, $0.1171; fetched `MathArena/arxivlean-0926_outputs`, including a Claude proof |
| Clean v2 | OFF | `unverified` | 186s, 0 tools, no Lean block; emitted a `<｜DSML｜ … execute>` text artifact |
| Clean v2 | ON | `incomplete` timeout | 24 math-tool calls, 122,659 tokens, $0.0799; `math_lean_check` scanned 778 corpus PDFs and ran `pip install pypdf`; no Lean block |

All **seven attempts concerned task 1 only**: **six timeouts and one DSML-only
unverified output**, **0 verified and 0 rejected**. The five-task smoke set was
selected, not completed; no five- or 60-task study was completed. The first
timeout was **900 seconds**, and clean2 OFF completed in **186 seconds**.

Observed cost subtotal: **$0.5272**; token subtotal: **1,034,214**. Billing/usage
coverage is incomplete where the provider omitted it; these are not full totals.

## Bottom line

- The **final four clean attempts are a subset**: 0 verified, 0 rejected,
  **3 timeout/incomplete and 1 DSML unverified**, not the total seven attempts.
- No valid plugin-ON/OFF math comparison exists.
- Timeout, captured final text, and independently verified proof are separate
  outcomes. Neither the 900-second attempt nor the 186-second OFF output was a
  30-minute timeout.

## Why the runs are invalid

Three leakage channels were found:

1. **Web/subagent access** in the full workspace. ON fetched arXiv
   `2609.01010v1`; OFF found prior prompts in `.opencode/state`.
2. **`execute.fetch`**. Denying the `webfetch` tool does not remove `fetch` from
   OpenCode's `execute` Code Mode runtime. The clean v1 OFF run fetched the
   MathArena outputs dataset and read another model's transcript/proof.
3. **`math_lean_check` process execution**. The tool accepts Lean
   `#eval`/`IO.Process`, and its Docker check mounts the corpus with network
   access. The clean v2 ON run scanned `/work/math/preprints` (778 PDFs) and
   installed `pypdf` instead of constructing a proof.

The OFF baseline is also invalid: with no tools, the model emits a DSML text
tool call instead of a Lean submission.

## Harness capabilities and limits

- Comparator grading, including the official `sorry`-placeholder challenge.
- Submission extraction and structural checks.
- `incomplete` vs `unverified` vs `rejected` classification.
- Denying `execute` and using direct tools (`codemode:false`) closed the Code
  Mode fetch route, but **did not establish an offline environment**: Lean
  elaboration retained arbitrary-code, filesystem, and network paths.

## Plugin findings for real users

- Host `math_lean_check` failed on a trivial `(1:ℝ) + 1 = 2` on Windows.
  Docker mode (`docker: true`) passed; the model had to discover it after the
  host failure. The default path is broken and the Docker fallback is not
  prominent enough.
- `math_lean_check` is a general process-execution channel, not a verification
  sandbox. It can read the corpus, install packages, and reach the network.
- The `verify` toolset existed **only in the modified temporary plugin copy**.
  The checked-in selector recognizes full/minimal, not verify; an unknown
  `MATH_TOOLKIT_TOOLSET` value falls through to full. Even the temporary verify
  selection was not an isolation boundary.

## If the study is resumed

1. Treat Lean elaboration as arbitrary code. A keyword blacklist or a
   “compile-only” label is not a security boundary. Use an OS-isolated,
   unprivileged runtime with immutable dependencies, no network/corpus/secrets,
   resource limits, and a separately trusted independent checker.
2. Establish a fair isolated OFF interface; DSML text is not a tool execution
   or a Lean submission.
3. Validate the pipeline with known positive and negative checker controls and
   isolation probes before model spending. The gate is pipeline behavior, not
   whether a solver can prove the chosen research task.
4. Freeze model, tasks, budgets, and actual registered tools. No five- or
   60-task study should start until the pipeline and isolation gates pass.

## Artifacts

- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\report-clean2-pilots\report.md`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-smoke5-on-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-smoke5-off-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean-on-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean-off-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean2-on-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-smoke\run-clean2-off-pilot`
- `C:\Users\MiPC\AppData\Local\Temp\opencode\arxivlean-env` — clean workspace
