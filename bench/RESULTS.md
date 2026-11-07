# Math plugin benchmark

10 problems, 1 repeat, with/without `math-toolkit`, each run with `--standalone`.

| Model | Condition | Passed | Errors | Mean time | Mean tool calls |
| --- | --- | ---: | ---: | ---: | ---: |
| `opencode-go/deepseek-v4.1-flash` | with plugin | **8/10** | 2 | 93.97s | 3.80 |
| `opencode-go/deepseek-v4.1-flash` | without plugin | **4/10** | 6 | 142.42s | 0.80 |
| `opencode-go/glm-5.3-flash` | with plugin | **9/10** | 0 | 36.77s | 2.80 |
| `opencode-go/glm-5.3-flash` | without plugin | **8/10** | 2 | 76.98s | 0.70 |

## DeepSeek V4.1 Flash

| Problem | With plugin | Without plugin |
| --- | --- | --- |
| quasi-riemann | FAIL (timeout, 5 calls) | PASS (1 call) |
| landau-siegel | FAIL (timeout, 7 calls) | FAIL (timeout, 1 call) |
| family-lookup | PASS (5 calls) | FAIL (timeout, 1 call) |
| lean-declaration | PASS (5 calls) | FAIL (timeout, 1 call) |
| pdf-overview | PASS (2 calls) | FAIL (timeout, 0 calls) |
| sympy-simplify | PASS (1 call) | PASS (0 calls) |
| sympy-solve | PASS (3 calls) | PASS (0 calls) |
| sympy-determinant | PASS (1 call) | PASS (3 calls) |
| theorem-explanation | PASS (5 calls) | FAIL (timeout, 0 calls) |
| no-corpus-answer | PASS (4 calls) | FAIL (timeout, 1 call) |

## GLM-5.3-Flash

| Problem | With plugin | Without plugin |
| --- | --- | --- |
| quasi-riemann | PASS (3 calls) | PASS (1 call) |
| landau-siegel | PASS (2 calls) | FAIL (timeout, 1 call) |
| family-lookup | PASS (3 calls) | PASS (1 call) |
| lean-declaration | PASS (2 calls) | PASS (0 calls) |
| pdf-overview | PASS (3 calls) | FAIL (timeout, 0 calls) |
| sympy-simplify | PASS (1 call) | PASS (1 call) |
| sympy-solve | **FAIL (2 calls)** | PASS (0 calls) |
| sympy-determinant | PASS (1 call) | PASS (2 calls) |
| theorem-explanation | PASS (9 calls) | PASS (0 calls) |
| no-corpus-answer | PASS (2 calls) | PASS (1 call) |

## What this shows

- The plugin materially helps on corpus-specific retrieval, PDF extraction, Lean declaration lookup, and “no exact match” behavior.
- Pure SymPy problems pass both ways; the plugin is not required for simple arithmetic or symbolic work.
- The plugin is not a universal win: DeepSeek had two with-plugin timeouts, and GLM’s plugin run failed `sympy-solve` while its no-plugin run passed.
- Timeouts are counted as failures. Several “without plugin” failures are 180s timeouts, not necessarily wrong answers.

## Caveats

- One repeat, two models, 10 problems: indicative, not scientific.
- Keyword scoring is heuristic; tool-call counts are regex counts of tool activity.
- The “without plugin” condition still has global OpenCode plugins; only `math-toolkit` is absent.
- Full stdout/stderr and JSON are in `bench/results/` locally; that directory is gitignored.
- The full 10-problem matrix ran in separate detached processes to survive OpenCode server restarts.
