# Continuation results — g005 stopped; g006 not started

**NOT READY:** the genuine g005 operational compatibility probe stopped at
`safety_failure` after one ON capture and one setup. OFF was not started. The
frozen g006 main study (20 episodes) never started and has no output. Main,
Arxiv5 and the 60-episode matrix remain blocked by the failed probe gate.
This is failed operational delivery, **not a mathematical failure** or an
accuracy benchmark. No reviews or mathematical scores were generated.

## Implemented and frozen before the probe

Diagnostics/replay, native corroboration, closed profiles and the private
checkpoint were implemented. Reviewed security/correctness findings were
closed. Parent validation passed **201 focused tests** and **114 syntax checks**;
these are prior parent results, not tests rerun for this report.

The genuine **NO-INFERENCE handoff passed**: private admission and dispatch
construction, zero live-launcher invocations, no live prompt sent. This was not
positive inference/completion evidence; it did not assert absence of all HTTP
(authentication HTTP may precede). Both registrations were frozen on
**2026-11-13**, before the probe, with nine source files archived. The frozen
run-ID labels containing `20261112` were not changed.

Approval root:
`C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g005-freeze-handoff-W9Ub4y`

| Evidence | SHA-256 |
|---|---|
| `parent-approval.json` | `0b237304035e589156f19bf9376dc7197ecd42dfc0da1fa03f0512cc2bbe6358` |
| `two-registration-freeze.json` (shared freeze) | `cc8913cf44bb57ab5236d8901ba1e812075243fc98e8150712f599409470f726` |
| `handoff-receipt.json` | `7d3b83d7d27d38f86c4dfe2161bb83e38bf8f9d71e0a7554e65fb307551d5c25` |

Parent verification: `real-use-g005-final-validation-W2Owzm/verification.json`
under the same temp `opencode` root, SHA-256
`125ffa556ddfef0861c6d9359a516ae68f95fe86a65c2d7b02873adaa5d0f9c7`.

## Actual probe outcome

Run `real-use-g005-compat-20261112` stopped on 2026-11-13 UTC. Of two scheduled
episodes, one was attempted, none met the maintained delivery definition, one
failed operationally, and one never started. One pair remains incomplete and
ungraded. Captured answer text is not owned-finalization or identity evidence.
The episode records `finalization_failure`, `safety_failure: true`, and
unconfirmed finalization. **No established upstream cause** is available in the
inspected safe records; the unavailable pre-restart diagnosis was not duplicated
or guessed.

| Recorded metric | Total | Known subtotal |
|---|---:|---:|
| Input tokens | null | 1639 |
| Output tokens | null | 125 |
| Cost USD | null | 0.00032085 |

Each metric has one partial/unknown episode, no complete episode, and one
subtotal-covered episode. OFF totals and subtotals remain null, not zero.
No cache/reasoning usage is imputed. Upstream completeness is unknown and
provider billed USD is null: recorded configured-rate cost is **not a bill**.

Episode latency: setup 5530 ms, solver 9167 ms, cleanup 0 ms (recorded),
end-to-end 14699 ms. Later controller `setup/00.cleanup.json` independently
records **14705 ms**, confirmed cleanup and **CLI/server/daemon 0/0/0** active
processes. The maintained report retains episode timings; controller cleanup
does not retroactively establish successful finalization. Missing timings are
not zero and no latency/cost comparison is warranted.

## Saved report and reproduction

Evaluation directory:
`C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g005-compat-20261112\evaluation`

- `report.json`: maintained `real-use-report/v2`, actual disk-adapter inputs,
  registration/source-lineage provenance, no reviews or altered observations.
- `report.md`: delivery, missingness, partial accounting, separate timing scopes
  and interpretation limits.
- `integrity.json`: byte-hash checks against 16 probe, 21 g004 and 38 historical
  artifact baseline records; `generate-report.mjs` reproduces/computes these
  locally, preserving existing report files rather than overwriting them.

Probe before-report baseline:
`C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g005-probe-before-report-integrity.json`,
SHA-256 `940baaefd6694923798b4c95e8114a3ff4b267e2abdc456c7d655485a20ce2d5`.

From the repository root, print the report without writes:

```powershell
node bench/v4/real-use/report.mjs --out 'C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g005-compat-20261112'
```

The exact exported API is `loadFreshReportInputs(out, manifest)`, followed by
`report(manifest, inputs.episodes, [], [], inputs.context)` (or
`main(['--out', out])`). No `--reviews` argument. Read-only report recomputation
and 16/21/38 integrity checks:

```powershell
node 'C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g005-compat-20261112\evaluation\generate-report.mjs' --check
```

Parent owns independent validation. No retry, resume, replacement, reseed,
fallback, source repair, main execution, model/provider call, grading,
Docker/Lean run, or publication was performed for this report. Previously
stopped **g004 and historical `RESULTS.md` remain unchanged and separately
reported**. No pooling of historical/probe/main data, plugin-accuracy or
effectiveness claim, or billing-savings comparison is supported.
