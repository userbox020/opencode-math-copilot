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
4. Quota/auth errors are recorded with `next_attempt_at` and retried after a per-provider wait; `not included in the free plan`, retired models, and context/config errors are terminal until reset; no fake success.
5. The free matrix is an exploratory **feasibility/robustness** appendix. It is not the confirmatory DeepSeek pilot and not paper evidence.

## Retry statuses

The runner now records the provider error event instead of collapsing it to
`OpenCode exit 1`:

- `quota_wait` — 402/429/credit/balance exhaustion; retried after the provider wait or `X-RateLimit-Reset`.
- `auth_error` — provider/integration authentication failure; retried after 15 minutes.
- `not_in_plan` — model is not in the upstream free plan; terminal.
- `unavailable` — retired or unlisted model; terminal.
- `config_error` — context/output-limit mismatch; terminal until reset.
- `provider_output` — provider stream/event bug; retried after the provider wait.
- `tool_protocol_failure` / `error` — parser or adapter failure; terminal until reset.

`--reset <regex>` resets matching non-`full_complete` entries to `pending`.
`--no-wait` exits after the current pass instead of sleeping until the next
`next_attempt_at`. Retries use a new `screen/<model>/attempt-N` directory so a
resumed study never reuses a different protocol directory.

## Run

```text
node bench/v2/free-models/run-matrix.mjs --mode all --wait-minutes 30
```

- State: `C:\Users\MiPC\AppData\Local\Temp\opencode\free-matrix\state.json` (resumable)
- Reports: `matrix-report.json`, `matrix-report.md`
- Screen outputs: `free-matrix/screen/<model>/attempt-N/`
- Full outputs: `free-matrix/full/<model>/attempt-N/`
- Subset: `--only 'free-cloudflare|opencode/'`
- Screen only: `--mode screen`; full only: `--mode full`.
- Reset and retry one provider now: `--only '^opencode-go/' --reset '^opencode-go/' --max-passes 1 --no-wait`.
- Concurrency: `--per-provider 2` (default) and `--concurrency 8` (default global cap). Providers can advance in parallel, but no provider runs more than two models at once. Each model still runs A/B/F episodes sequentially.
- Timeouts: `--study-timeout-min 15` for screening; `--full-timeout-min 240` for full 90-episode studies.
- Score export: `npm run scores:report` writes the pilot and full-run A/B/F score report.

Cloudflare’s free adapters advertise a 32k output default even for the
24k-context Llama model. The adapter now injects
`limit: { context: 24000, output: 8192 }` for
`free-cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast`, and an 8192 output
limit for other Cloudflare models. The remaining Cloudflare `invalid-output`
stream events are provider/plugin bugs, not context-limit failures.

OpenAI balance is not sufficient for this harness: the copied safe home has an
OpenAI OAuth credential, but `opencode run --standalone` still returns
`Integration.Authorization: Request failed: 400`. Re-authenticate OpenAI in the
safe home before running the OpenAI queue; without that, the queue records
`auth_error` and does not spend the balance.

The queue uses the safe credential home, the staged math indexes and `MATH_TOOLKIT_MATH_ROOT`, and the study runner's 600 s/40-tool-call/200k-token/$1-per-episode budgets with a $25 cap. Free models are recorded at cost 0. No credential is written to the output; the output can be copied after the run, but the safe home must not be committed.

## Dashboard

`dashboard.html` is a self-contained status console for the free and
other-provider queues. Generate a fresh sanitized snapshot before opening it:

```text
node bench/v2/free-models/build-dashboard.mjs
```

Then open `bench/v2/free-models/dashboard.html` directly. It loads
`dashboard-data.js` (assigned to `window.DASHBOARD_DATA`) and makes no network
requests. The snapshot excludes credentials, raw stdout/stderr, and session
identifiers; it includes model/status rows, error categories, retry times, task
metadata, and aggregate counts. The dashboard is read-only: it does not run
models or mutate queue state.

`running.html` is the focused current-runs view. Generate its snapshot with:

```text
node bench/v2/free-models/build-live.mjs
```

It resolves each active model's latest `attempt-N` directory, counts the
episodes written so far, shows the current task/condition, elapsed time and
last activity, and flags runs with no file activity for more than 10 minutes.
It is a snapshot too; regenerate and reload to update it. The page keeps the
full queue counters and retry timeline visible when no run is active.

For a complete per-model status export:

```text
npm run status:models
```

This writes `all-model-status.csv` and `all-model-status.md` under
`C:\Users\MiPC\AppData\Local\Temp\opencode\`.

`scores.html` is the dedicated score comparison page: historical with/without
plugin, real pilot A/B/F, and full-complete matrix model scores. Generate its
data with `npm run scores:report`, then open the page or use the live server.

For a live view, run:

```text
npm run dashboard:serve
```

Then open `http://127.0.0.1:8765/dashboard.html` or
`http://127.0.0.1:8765/running.html`. The server regenerates the relevant
snapshot on each request (1s coalescing), disables caching, injects a **LIVE ·
15s auto-refresh** badge, and reloads the page every 15 seconds. It binds only
to `127.0.0.1`; use `--port <n>` to change the port.

## Status

- The main paper pilot is the 90-episode `opencode-go/deepseek-v4.1-flash` run in `bench/v2/real/`.
- This free matrix is exploratory and may take hours/days because of quota waits.
- The screen and full results must be labeled accordingly; a free model that fails B/F is a negative feasibility result, not a general claim about all models.

## Other-provider matrix (parallel)

`models-other.json` contains the **569 direct-provider models** from the safe
credential home: `openai/*`, `opencode-go/*`, `opencode/*` paid, `google/*`,
`groq/*`, `cloudflare-workers-ai/*`, `ollama-cloud/*`, `openrouter/*` and
`zai/*`; `free-*`, `opencode/*-free` and local `ollama/*` are excluded because
the free queue covers them. The direct provider's `:free` variants remain and
are charged at zero by the free-model accounting.

```text
node bench/v2/free-models/run-matrix.mjs --mode all \
  --models bench/v2/free-models/models-other.json \
  --out C:\Users\MiPC\AppData\Local\Temp\opencode\other-matrix \
  --wait-minutes 30 --total-cap-usd 25 --max-passes 0
```

The queue has a **global $25 cap** across screening and full studies, in
addition to each study's per-episode budget. When the cap is reached it stops
and records the state; rerun with a higher cap to continue. The free queue and
the other-provider queue can run in parallel; both use the safe credential home
and the staged math indexes. The first direct model in the list is
`cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017`.
