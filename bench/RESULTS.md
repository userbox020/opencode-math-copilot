# Math plugin benchmark

Model: `opencode-go/deepseek-v4.1-flash`

Run: 10 problems, 1 repeat, with/without plugin, `--standalone`.

| Problem | Condition | Seconds | Exit | Score | Tool calls |
| --- | --- | ---: | --- | --- | ---: |
| quasi-riemann | with plugin | 180.05 | error | FAIL | 5 |
| quasi-riemann | without plugin | 100.16 | 0 | PASS | 1 |
| landau-siegel | with plugin | 180.06 | error | FAIL | 7 |
| landau-siegel | without plugin | 180.03 | error | FAIL | 1 |
| family-lookup | with plugin | 34.80 | 0 | PASS | 5 |
| family-lookup | without plugin | 180.06 | error | FAIL | 1 |
| lean-declaration | with plugin | 130.04 | 0 | PASS | 5 |
| lean-declaration | without plugin | 180.03 | error | FAIL | 1 |
| pdf-overview | with plugin | 35.79 | 0 | PASS | 2 |
| pdf-overview | without plugin | 180.04 | error | FAIL | 0 |
| sympy-simplify | with plugin | 26.76 | 0 | PASS | 1 |
| sympy-simplify | without plugin | 18.88 | 0 | PASS | 0 |
| sympy-solve | with plugin | 34.15 | 0 | PASS | 3 |
| sympy-solve | without plugin | 117.40 | 0 | PASS | 0 |
| sympy-determinant | with plugin | 84.95 | 0 | PASS | 1 |
| sympy-determinant | without plugin | 107.58 | 0 | PASS | 3 |
| theorem-explanation | with plugin | 66.75 | 0 | PASS | 5 |
| theorem-explanation | without plugin | 180.03 | error | FAIL | 0 |
| no-corpus-answer | with plugin | 166.31 | 0 | PASS | 4 |
| no-corpus-answer | without plugin | 180.03 | error | FAIL | 1 |

**Summary**

- with plugin: **8/10 passed**, 2 errors, 93.97s mean, 3.80 mean tool calls
- without plugin: **4/10 passed**, 6 errors, 142.42s mean, 0.80 mean tool calls

## What this shows

- The plugin materially helps on corpus-specific retrieval, PDF extraction, Lean declaration lookup, and “no exact match” behavior.
- Pure SymPy problems pass both ways; the model does not need the plugin for simple arithmetic/symbolic work.
- The two with-plugin failures (`quasi-riemann`, `landau-siegel`) were 180s timeouts, not incorrect answers. The prompts are deliberately citation-heavy.
- The “without plugin” condition still has global OpenCode plugins; only `math-toolkit` is absent.

## Caveats

- One model, one repeat, 10 problems: indicative, not scientific.
- Keyword scoring is heuristic; tool-call counts are regex counts of `⚙ execute` / tool activity.
- Timeouts are counted as failures.
- `bench/results/latest.json` contains full stdout/stderr locally; that directory is gitignored.
- The second model (`opencode-go/glm-5.3-flash`) is configured in the harness but its run is tracked separately when available.
