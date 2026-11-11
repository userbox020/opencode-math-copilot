# Normal-use pilot v1 — results

Study: `normal-use-2026-11-11T16-38-38-596Z-opencode-go-deepseek-v4.1-flash`

- Model: `opencode-go/deepseek-v4.1-flash`
- Workspace: `C:\_Work\__OPENAI_MATH` (real math corpus)
- Conditions: `plugin-on` and `plugin-off`
- Plugin off: `MATH_TOOLKIT_DISABLE=1` (plugin loads but registers no math tools)
- Tasks: 6 normal-use prompts, one repeat
- Grading: reference-based human review, independently checked by a second reviewer
- No typed-JSON benchmark contract

## Result

**Both conditions scored 6/6.** There was no correctness gain from the full
math-toolkit plugin on this small normal-use suite.

| Condition | Correct | Mean time | Tokens | Cost | Tool calls | Math-tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| plugin-on | **6/6** | **60s** | 90,055 | **$0.01777** | 30 | **29** |
| plugin-off | **6/6** | **37s** | 66,997 | **$0.01245** | 25 | 0 |

Plugin-on was **~61% slower**, used **~34% more tokens**, and cost **~43% more**
than plugin-off, with no additional correct answers.

## Per-task notes

| Task | Plugin-on | Plugin-off | Outcome |
| --- | --- | --- | --- |
| Hanner retrieval | 163s, 25 math-tool calls | 54s, grep/read only | Both correct; plugin-on much heavier |
| Characteristic-two date | 24s, 1 math search | 29s, grep/read | Both correct |
| Triangle area | 7s, no tools | 6s, no tools | Both correct |
| Lean identity | 77s, 3 math calls | 21s, shell/read | Both correct; off did not verify |
| Cancellation fallacy | 20s, no tools | 24s, no tools | Both correct |
| Verification evidence | 71s, 9 generic tools | 90s, 16 generic tools | Both correct |

The Hanner task is the clearest example: the plugin found the same sentence and
citation, but used 25 math calls and took three times as long as plugin-off.

## Interpretation

- This is a **negative normal-use result** for the full toolkit on this task set.
- The plugin was not needed for correctness on any of the six tasks.
- The plugin added retrieval/tool overhead and cost, especially on the
  corpus-search task.
- This is consistent with the earlier exploratory pilot: the full toolkit is
  not automatically better, and more tools can add cost without improving the
  answer.

## Caveats

- One model, six tasks, one repeat.
- Scores are from reference-based human review; they are not a blind
  adjudication or a statistical estimate.
- Tasks are derived from the provisional pilot and are not a user study.
- The plugin-off condition disables the math toolkit but does not remove other
  OpenCode plugins or built-in tools.
- The CLI uses `--standalone`; Desktop/TUI behavior may differ.
- Lean correctness was assessed by inspection, not a fresh compilation.
- This is exploratory, not confirmatory evidence.

## Artifacts

- `C:\Users\MiPC\AppData\Local\Temp\opencode\normal-use-v1\manifest.json`
- `...\episodes.jsonl`
- `...\review.csv`
- `...\review.md`
- `...\report.md`
- `...\report.json`
- `...\summary.json`

## Minimal-toolset follow-up (v2)

A second 6-task run compared the full 16-tool plugin, the six-tool minimal
toolset, and plugin-off.

| Condition | Correct | Mean time | Tokens | Cost | Tool calls | Math calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| plugin-on | **6/6** | **32s** | 69,092 | **$0.01209** | 15 | 9 |
| plugin-on-minimal | **6/6** | 37s | 72,584 | $0.01324 | 19 | 13 |
| plugin-off | **6/6** | **23s** | 49,263 | **$0.00847** | 11 | 0 |

The minimal toolset did **not** reduce latency or cost in this run. The full
plugin was slightly faster and cheaper than minimal; plugin-off remained the
fastest and cheapest. The Hanner task used 5 math calls with the full plugin, 6
with minimal, and 0 with plugin-off.

This is a negative result for the “fewer tools = less overhead” hypothesis.
Toolset size alone is not the lever; tool-selection policy, redundant calls, and
task difficulty matter more. The difference from v1 (full plugin: 60s, 29 math
calls) also shows high run-to-run variance with six tasks.

## Next steps

1. Expand to more tasks, especially retrieval/Lean tasks where tools should help.
2. Run multiple models and repeats.
3. Blind the reviewer to condition and randomize order.
4. Add a normal-use HTML summary page.
5. Measure tool precision, not just tool-call count.
6. Keep the controlled A/B/F benchmark as a separate diagnostic.
