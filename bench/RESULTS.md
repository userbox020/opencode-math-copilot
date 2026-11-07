# Math plugin benchmark

Model: `opencode-go/deepseek-v4.1-flash`

| Problem | Condition | Repeat | Seconds | Exit | Score |
| --- | --- | --- | --- | --- | --- |
| quasi-riemann | with plugin | 1 | 162.34 | 0 | PASS |
| quasi-riemann | without plugin | 1 | 179.66 | 0 | PASS |
| landau-siegel | with plugin | 1 | 27.00 | 0 | PASS |
| landau-siegel | without plugin | 1 | 180.02 | error | FAIL |
| computation | with plugin | 1 | 25.22 | 0 | PASS |
| computation | without plugin | 1 | 15.50 | 0 | FAIL |

**Summary**

- with plugin: 3/3 passed, 0 errors, 71.52s mean
- without plugin: 1/3 passed, 1 error (timeout), 125.06s mean

## Caveats

- This is an indicative smoke benchmark, not a scientific evaluation: 3 problems, 1 repeat, 1 model.
- The “without plugin” project still has global OpenCode plugins; only `math-toolkit` is absent.
- Scoring is keyword-based and checks only that the required terms appear.
- The `landau-siegel` run without the plugin hit the 180s timeout.
- The quasi-Riemann prompt passed in both conditions; the plugin’s advantage is not universal.
- Full stdout/stderr is in `bench/results/latest.json` locally; that directory is gitignored.

## Pending

The expanded 10-problem, multi-model matrix has not run yet. The results above
remain the original 3-problem run; expanded results will replace them after integration.
