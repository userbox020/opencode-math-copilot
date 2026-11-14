# G018 partial workflow study — first valid paired dataset

**Status: partial, exploratory, NOT confirmatory.** The frozen 20-episode protocol
was executed until a pre-committed safety gate stopped it after 11 attempts.
10 episodes completed with validated owned native receipts; 1 attempt failed on
a transport limitation; 9 never ran. No retry, replacement, reseed or pooling
with any earlier attempt was performed.

This is the first run in the whole programme that produced paired episodes with
complete operational delivery **and** complete platform-recorded accounting in
both conditions.

## Why the run stopped

The `matrix-determinant` plugin-off prompt contains negative-number tokens
(`-2`, `-1`, `-4`). The compiled native CLI parses each argv fragment, so those
fragments were rejected as unknown flags (`ERRORS / Unrecognized flag: -2`). The
CLI exited 1 after 1.4 s and admission correctly refused the resulting facts
(`invalid_fresh_finish_facts`). The controller then applied the frozen
`safety_failure` rule and stopped.

The `--` separator cannot fix this: it was previously shown to corrupt the
native prompt, and argv splitting is mandatory because the CLI quotes any
argument containing spaces. Prompts containing leading-dash tokens are therefore
incompatible with this transport. This is a task/transport limitation, not a
model failure and not a mathematical failure.

## Frozen preconditions

- Pair: `g017-compat` (2 episodes) then `g018-workflows` (20 episodes), same
  model `opencode-go/deepseek-v4.1-flash#default`, seed `real-use-v1`, one
  repeat, 300 s per episode, concurrency 1, no retries/resume/fallback.
- Reported-cost soft thresholds USD 0.10 (probe) and USD 0.90 (main); combined
  USD 1 is **not** a billing cap and no borrowing occurred.
- Both registrations frozen at one timestamp before any inference, against an
  externally approved verification artifact, with nine source bytes archived.
- A genuine no-inference handoff passed first: private admission, dispatch
  construction without invoking the launcher, clean CLI/server/daemon cleanup,
  outputs absent, and a read-only route-envelope probe.

## Compatibility probe — passed

Both conditions completed the fixed operational task (`approved_list`, then
`approved_read` at offset 5, limit 1) with validated owned receipts:

| Condition | Completion basis | Setup / solver / end-to-end |
|---|---|---:|
| plugin-on | `cli_terminal` | 5464 / 18307 / 23773 ms |
| plugin-off | `native_corroborated` (timestamped snapshot path) | 5329 / 18617 / 23947 ms |

The first-pair checkpoint passed all nine checks (exact pair, distinct fresh
sessions, distinct native assistant IDs, operational delivery, owned cleanup,
complete platform accounting, under threshold, consistent configured pricing).
Probe recorded cost: **USD 0.001309836**.

The off-condition episode is the one that exercised the new post-seal timestamp
predicate: its CLI terminal finish was absent, yet native completion was
corroborated from sealed snapshots with `idle <= closedAt`.

## Main study — delivery

| Measure | Value |
|---|---:|
| Scheduled | 20 |
| Attempted | 11 |
| Completed (validated receipt) | 10 |
| Operational failures | 1 |
| Not started | 9 |
| End-to-end delivery | 10/20 (0.50) |
| Delivery among attempted | 10/11 (0.909) |

Attempted and completed per condition: plugin-on 5/5, plugin-off 6 attempted /
5 completed (the `matrix-determinant` transport failure).

Completed tasks, both conditions each: `bounded-search-miss`,
`compilation-scope-evidence`, `hanner-released-pdf`,
`jacobsthal-strengthened-scope`, `rational-equation`.

## Correctness — independent blinded model review

Ten answers were exported to a blinded packet that hides condition, model and
tool branding. The first grading pass read the minified packet and wrongly
reported seven answers as truncated; the answers were verified complete
(all end with a finished sentence) and a second blind pass read one
pretty-printed file per response.

| Measure | Value |
|---|---:|
| Eligible completed episodes | 10 |
| Reviewed | 10 |
| Pass | 9 |
| Fail | 1 |
| Unscorable | 0 |
| Pass rate among scored | 9/10 (0.90) |

By condition: plugin-on 5/5, plugin-off 4/5. The single failure was an
off-condition rational-equation answer that excluded both forbidden values and
found the correct roots but omitted the rubric's required rejection of the
extraneous root introduced by clearing denominators.

Paired outcomes over the five scoreable pairs: **4 both, 1 ON-only, 0 OFF-only,
0 neither**; five pairs are ungraded because they never ran.

**Interpretation limits.** n = 5 pairs, one model, one repeat, one model
reviewer (not an authenticated human), and a single observed difference. This
does **not** establish plugin superiority, mathematical accuracy, or a stable
effect. It is a feasibility and delivery result with a weak, non-confirmatory
correctness signal.

## Accounting

Platform-recorded values only; these are OpenCode-calculated, not provider
invoices. Upstream usage completeness remains **unknown**; provider billed USD
is **null**.

| Metric | Total | Known subtotal | Complete / attempted |
|---|---:|---:|---:|
| input_tokens | null | 42,601 | 10 / 11 |
| output_tokens | null | 10,703 | 10 / 11 |
| cache_read_tokens | null | 57,088 | 10 / 11 |
| cache_write_tokens | null | 0 | 10 / 11 |
| reasoning_tokens | null | 18,921 | 10 / 11 |
| cost_usd | null | 0.024335814 | 10 / 11 |

Totals are null because one attempted episode is incomplete; the subtotal is not
a bill. No CLI and native totals are added together.

## Harness defects found and fixed during this continuation

Each was discovered from a real abort, attributed by the bounded diagnostics,
fixed, and covered by hermetic regressions:

1. Empty native message page returned `cursor.next`, and the pager treated that
   as a malformed cursor (`native_message_cursor_rejected`).
2. Empty children result returned `cursor.next`, and finalization treated that
   as extra children (`native_child_scope_rejected`).
3. Unknown owned-session events were fatal even when non-durable; they are now
   ignorable bounded observations, while unknown **durable** events reject with
   a named code (`native_unknown_durable_event`).
4. Admission's artifact row model rejected the optional leading `agent-switched`
   row that the bridge already permitted (`native_artifact_snapshot_mismatch`),
   which wrongly discarded a fully corroborated completion.
5. Event-timestamp hygiene bounds rejected a legitimately delivered event; they
   now allow ±2000 ms while every authority bound stays exact.
6. Finalization errors were collapsed to `unknown_failure`; enumerated
   rejection codes, a stage and a bounded branch snapshot are now retained.

Policy change made prospectively, not retroactively: a missing CLI terminal
finish may be corroborated from sealed snapshots when the recorded native
completion timestamps precede the bridge-owned closure instant, with two equal
snapshots, the first already passing, no waiting or extra reads. Evidence kinds
are recorded distinctly (`cli_terminal`, `native_preclose_witness`,
`native_timestamped_snapshot`). This proves platform-recorded completion at or
before closure, not atomic ordering or provider-internal behaviour.

## Artifacts and reproduction

- Run: `C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g018-workflows-20261113`
- Maintained report: `evaluation/report.json` (recompute with
  `node bench/v4/real-use/report.mjs --out <run> --reviews <run>/evaluation/reviews.json`)
- Blinded packet: `evaluation/blind.json`; readable expansion and manifest under
  `evaluation/blind-readable/`
- Typed reviews: `evaluation/reviews.json` (10 model reviews)
- Probe: `C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g017-compat-20261113`
  with the passing `first-pair-checkpoint.json`
- Freeze and approval root: `real-use-g007-freeze-handoff-rfAoV3`
- Pre-grading integrity: 108 g018 files
  SHA-256 `7e640470c9abfc8ce3221c67c23d9294483bacf00ec071acdd19369eae94679c`;
  26 probe files SHA-256
  `0ea4dc06db7f508fe97b7b109412184e7a4a31290919a99c35b5ac415237c01d`

All earlier attempts (g004 study; g005, g007, g009, g011, g013, g015 probes)
remain immutable and are **not** pooled with this run. Their dispositions are
recorded in `RETIRED_PROFILES` and disclosed in the registrations.

## Readiness

ArXivLean five-task smoke and the sixty-task matrix remain **NOT READY**. The
transport cannot carry prompts containing leading-dash tokens, and this study is
underpowered. A defensible next step is either a prompt-safe transport or a
task set that excludes such prompts by design — decided before any further paid
run, not by dropping tasks after seeing outcomes.
