# G022 partial workflow study — stdin transport validated, stopped by an auxiliary-activity gate

**Status: partial, exploratory, not confirmatory.** The 20-episode protocol ran 5
attempts before the frozen safety gate stopped it: 4 episodes completed with
validated owned receipts, 1 failed operationally, 15 never started. No retry,
replacement or pooling was performed.

This run is the first executed entirely over the new **stdin prompt transport**,
and the preceding compatibility probe (g021) passed both conditions on that
transport.

## Transport change that made this possible

argv was unusable for real prompts:

- a positional containing an ASCII space is wrapped in literal quotes by the CLI;
- `--` is dropped but its suffix is appended **twice** (Effect's lexer splits
  trailing operands, the parser adds them as positionals, and the CLI appends
  `argv.slice(separator + 1)` again);
- punctuation-bearing negative fragments (`-2,`, `-4],`) are lexed as clustered
  short options, which is what aborted g018.

With **zero positional message arguments** the CLI reads the prompt from stdin
unchanged, EOF-terminated. The harness now writes the exact prompt bytes to an
owned 0600 file, passes `stdin_path` + `stdin_sha256` to the Windows Job Object
helper, and the helper verifies the digest and reads it as the child's stdin
instead of `NUL`.

Two controls gate this, both passed before any paid episode:

- **31/31 runtime controls** re-run against the changed launcher
  (`runtime-controls-g021-bed9aab2144f`, SHA-256
  `6fa5f7a14dc1194b2994678bdab99590a4db6264961ad9370581bf89336fc0e5`).
- **Zero-inference CLI audit**: one real CLI launch with the guard aborting
  before inference, native prompt bytes matched, cleanup confirmed, output
  absent (`real-use-transport-control-NzH3UQ/transport-control.json`, SHA-256
  `66aab7ce0265cb94ee8c79c1d933bc49fa326873a4169c699181b2934845bf15`).

The earlier handoff had passed **without** exercising this path; that gap is why
g019 aborted before spawn and is now closed by an explicit control.

## Compatibility probe (g021) — passed

| Condition | Completion basis | Solver | Recorded cost |
|---|---|---:|---:|
| plugin-off | `native_corroborated` | 10.1 s | USD 0.00075069 |
| plugin-on | `native_corroborated` | 8.1 s | USD 0.000634386 |

Checkpoint passed all nine checks; probe cost USD 0.001385076.

## Main study (g022) — delivery

| Measure | Value |
|---|---:|
| Scheduled | 20 |
| Attempted | 5 |
| Completed | 4 |
| Operational failures | 1 |
| Not started | 15 |
| End-to-end delivery | 4/20 (0.20) |
| Delivery among attempted | 4/5 (0.80) |

Completed tasks: `hanner-released-pdf` (both conditions),
`jacobsthal-strengthened-scope` (both). Failed: `compilation-scope-evidence`
plugin-on.

## Why it stopped

The failing episode ran 5 tool steps, then the SSE observer rejected an event in
the **recovery/auxiliary class** (`native_recovery_or_auxiliary_observed`) while
a sixth guarded request was pending. That class covers retry, compaction, shell,
skill, model-selection, location, interrupted/failed execution and failed steps;
it is disqualifying **by design**, because such activity can invalidate the
assistant interval and its accounting. The monitor then fenced the run, the CLI
was aborted (`exit null`, `signal ABORT`), and capture reported
`fresh_finish_deadline` as a downstream symptom.

The specific auxiliary event type was not retained, so the exact trigger is
unknown. This is **not** a transport failure, **not** a model failure and **not**
a mathematical failure. Retrying would have been outcome selection.

## Correctness

Not adjudicated for this run. No blind packet or reviews were generated, so the
report shows `missing_review: 4` rather than an implied score. The separately
reported g018 partial study remains the only run with a blinded correctness
read (9 pass / 1 fail) and is **not** pooled with this one.

## Accounting

Platform-recorded only; upstream completeness unknown; provider billed USD null.

| Metric | Total | Known subtotal | Complete / attempted |
|---|---:|---:|---:|
| input_tokens | null | 33,191 | 4 / 5 |
| output_tokens | null | 5,873 | 4 / 5 |
| cache_read_tokens | null | 33,792 | 4 / 5 |
| cache_write_tokens | null | 0 | 4 / 5 |
| reasoning_tokens | null | 4,225 | 4 / 5 |
| cost_usd | null | 0.01328829 | 4 / 5 |

## Artifacts

- Run: `C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g022-workflows-20261113`
- Report: `evaluation/report.json`
- Pre-report integrity: 53 files, SHA-256
  `54fe83a5c7462abb34a89bf33a3180133aa3bca832e9e678094fb858dc3ffdf3`
- Probe: `...\real-use-g021-compat-20261113` (26 files, SHA-256
  `a59064ca62e81b86826330b729d9f554f0bba13782917fef12393a8d5b64c893`)
- Freeze/approval root: `real-use-g007-freeze-handoff-gdtaCW`

## Readiness

ArXivLean five-task smoke and the sixty-task matrix remain **NOT READY**. Two
partial runs exist (g018: 10/20 with a reviewed blind dataset; g022: 4/20 over
stdin), and the auxiliary-activity gate is now the binding constraint. A further
attempt should first extend the bounded diagnostics to name the rejected
auxiliary event type — an offline change — rather than retrying to see whether
it recurs.
