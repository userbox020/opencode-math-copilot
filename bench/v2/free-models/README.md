# Free-model screening matrix

75 free models are enumerated from the safe credential home:

- `free-*` community providers from `opencode-openfree-models` (cloudflare, gemini, groq, kilo, ollama-cloud, openrouter, zai);
- `opencode/*-free`.

The list is `models.json` (generated 2026-11-09 from `opencode models --standalone`).

## Policy

A full 90-episode pilot for all 75 models would be 6,750 episodes. Instead:

1. **Screen every model** with a 3-episode A/B/F slice of the first provisional task.
2. **Run the full 90** only for models whose A/B/F slice completes (the model can produce a final answer with the tools).
3. Models whose B/F slice is an extraction/operational failure are recorded as `tool_protocol_failure`; running 90 episodes would only multiply fixtures that cannot be scored.
4. Quota errors are retried every `--wait-minutes`; `402 not included in free plan` and `model not listed` are terminal; no fake success.
5. The free matrix is an exploratory **feasibility/robustness** appendix. It is not the confirmatory DeepSeek pilot and not paper evidence.

## Run

```text
node bench/v2/free-models/run-matrix.mjs --mode all --wait-minutes 30
```

- State: `C:\Users\MiPC\AppData\Local\Temp\opencode\free-matrix\state.json` (resumable)
- Reports: `matrix-report.json`, `matrix-report.md`
- Screen outputs: `free-matrix/screen/<model>/`
- Full outputs: `free-matrix/full/<model>/`
- Subset: `--only 'free-cloudflare|opencode/'`
- Screen only: `--mode screen`; full only: `--mode full`.

The queue uses the safe credential home, the staged math indexes and `MATH_TOOLKIT_MATH_ROOT`, and the study runner's 600 s/40-tool-call/200k-token/$1-per-episode budgets with a $25 cap. Free models are recorded at cost 0. No credential is written to the output; the output can be copied after the run, but the safe home must not be committed.

## Status

- The main paper pilot is the 90-episode `opencode-go/deepseek-v4.1-flash` run in `bench/v2/real/`.
- This free matrix is exploratory and may take hours/days because of quota waits.
- The screen and full results must be labeled accordingly; a free model that fails B/F is a negative feasibility result, not a general claim about all models.
