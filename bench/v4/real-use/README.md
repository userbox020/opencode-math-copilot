# Real-use workflow evaluation — preparation only

**Execution is BLOCKED.** This is a frozen ten-task preparation package, not a
completed evaluation, user study, or evidence of plugin benefit. Existing v3
artifacts are unchanged. No model calls or Lean proof checks were performed to
prepare these tasks. Lean positive controls are **prepared_unverified** until
the parent-owned independent safe checker gate runs them.

## Frozen protocol

- Ten tasks: three source-retrieval, three exact computation, two Lean, and two
  evidence-assessment workflows. One explicitly selected model, two conditions
  (`plugin-on`, `plugin-off`), one repeat: **10 × 2 × 1 = 20 episodes maximum**.
- Preserve the user's OpenAI skip with the explicit non-OpenAI route
  `opencode-go/deepseek-v4.1-flash`; availability is not asserted or probed here.
  No automatic provider/model fallback, retries, resume, or force overwrite.
- Both conditions receive identical public prompts and the same plain runner
  suffix: “Answer naturally, cite evidence where relevant, distinguish proposed
  work from actual verification, and do not modify the repository.” No global
  search-first rule or PDF prohibition. Only the released-PDF citation task
  specifically requires PDF evidence.
  `PROTOCOL.prompt_suffix` and `promptFor(task)` assemble the unchanged public
  prompt, two LF characters, and that literal suffix. Manifests freeze each
  assembled `prompt_sha256`, their aggregate `assembled_prompts_hash`, and
  `protocol_hash`; readiness must bind the aggregate too. Old ready artifacts
  are invalid after prompt/protocol changes.
- Default wall time is 300 seconds per episode; concurrency is one. Freeze the
  seed, task/model/protocol hashes and run identity before dispatch. Randomize
  task/repeat pairs by that seed and balance which condition goes first. Pair
  identities include task, model, run and repeat; do not pair by array position.
- Grade against the same evaluator-only `correctness` and `evidence` criteria
  in both conditions. Review packets hide condition/model identity and tool
  branding; task/category and trusted target remain available. This is a
  blinding procedure, not a guarantee that prose cannot reveal a condition.
- An external evaluator-controlled checker checks **both** conditions' Lean
  submissions against the frozen theorem/type/import/axiom policy. Solver-side
  receipt vocabulary is not a correctness requirement. Proposed code is not
  verified code; compilation alone does not establish the target/axiom contract.
  Formal correctness passes require an accepted evaluator-owned checker result
  bound to the submitted code and fixed policy, plus rubric review. Manual code
  inspection cannot substitute; unavailable checks remain unscorable, not failed
  proofs. Reports also refuse to count unsupported formal passes.
- Keep failed and started-but-incomplete episodes visible. Missing usage/cost is
  `null`, not zero; report known subtotals and coverage separately. The **USD 1**
  reported-cost limit is a soft stop between episodes, **not a hard spend cap**.
  Only the first scheduled episode may dispatch its already-frozen adjacent
  counterpart despite unknown cost. After that first pair, **any missing cost
  stops before pair two**. Without an explicit frozen schedule/policy, unknown
  cost stops immediately. A known full cost or partial subtotal reaching USD 1,
  cleanup/safety failure, or the absolute episode cap overrides this exception
  immediately, even mid-pair. Unknown billing is never free. No retries, replacement
  tasks, reordering, new seed, or outcome-selected counterpart is permitted.
  Two-repeat/other-model previews remain diagnostics, not the frozen live study.

## Capture interface (not live admission)

`captureEpisode({launcherFactory, launch, item, task, directory, limits?})` is an
evaluator-only export. Supply a synchronous `createOwnedLauncher`-compatible
factory and a frozen descriptor (including frozen `args` and `env`), with no
positional message arguments. The `stdin` Buffer must equal `Buffer.from(promptFor(task))`
byte-for-byte, contain no NUL, and be at most 1 MiB; `stdin_sha256` must match it.
The descriptor's stdin field is non-replaceable; Node Buffer elements cannot be
frozen, so admission and capture recheck the bytes and digest before launch.
Spaces, newlines (including a trailing LF), Unicode, quotes and leading-dash tokens
are passed unchanged. These transport checks never replace native-artifact/guard
prompt verification. The verified adapter supplies
owned-server arguments; capture never synthesizes `--standalone` or directly
spawns a process. The factory receives raw-byte stdout/stderr callbacks and an
AbortSignal, and returns `closed`, `cleanupOwned()` and `status`.

Capture incrementally sanitizes NDJSON/stderr, enforces 8-MiB lines and a 128-MiB
combined input cap, and preserves the complete captured last-assistant answer as
`final_text` (also `text` for existing consumers) and `answer_path`. Artifacts carry
byte counts/SHA-256; task, prompt, protocol, capture source and non-environment
launch-descriptor hashes are recorded; prompt stdin bytes/content are not persisted
from the descriptor. The factory receives the same Buffer without reconstruction.
Events are streamed, not reloaded whole.
Caps/callback errors abort the owned job; timeout does not wait indefinitely for
`closed`. Cleanup has a separate bounded 25-second grace period, all capture FDs
are closed, and a terminal episode JSON preserves failures, partial usage and
tool-event locators. Optional evaluator limits may only lower these caps.

Observed finished-step usage is always retained as `known_subtotal` and coverage,
not assumed to be the episode bill. Interruptions, timeouts, caps, malformed
events, provider/nonzero failures, or uncertain cleanup make all episode usage
totals `null`. `usage_completeness` records why. Only clean stream exhaustion with
no unfinished step and a final `step_finish` reason `stop` can establish observed
episode totals; missing individual fields still remain `null`, and a reported
zero remains zero. Even complete observed totals are **not bill reconciliation**.
Unknown totals remain subject to the first-scheduled-counterpart-only rule above.

Terminal JSON is written exclusively to an owned temporary file, flushed, closed,
then atomically hard-linked to the final name without overwriting any existing
file. No empty terminal placeholder is published. Failed writes/publication leave
start/temp evidence, not a completed record. Loading an empty/truncated legacy
terminal requires a valid matching start and yields an incomplete artifact-failure
record with unknown usage; the original bytes and other finished records remain
unchanged. Malformed records without matching starts, orphan/duplicate/mismatched
identities and linked artifact paths fail explicitly. This is crash visibility,
not authorization to resume, retry, overwrite or score an incomplete episode.

Delivery success is not mathematical correctness. DSML-only tool syntax, blocked
tool calls, provider/nonzero/extraction failures are explicit operational failures.
Observed model/session strings are retained but **identity validation remains
unavailable** until independently bound to the owned guard; configured model names
never validate actual identity. This interface does not authorize execution.

## Thin controller and pending bridge contract

`execute.mjs` is the sequential controller over the existing capture flow, not a
second benchmark. **Production remains blocked until the genuine reviewed bridge
implements the contract below and the parent approves final source bindings.**
No provider inference was performed to implement or test this controller.

**Current native stdin transport contract:** production argv is exactly
`run --server OWNED_URL --session OWNED_SID --model opencode-go/deepseek-v4.1-flash#default --agent math-eval --format json`,
with no extra argv elements or positional prompt fragments. No optional title flag
is accepted in production; the owned existing session's title is set by the parent
bridge. The audit invocation retains its fixed `--title` flag. Both use the exact
prompt Buffer on stdin and a matching `stdin_sha256`, without splitting, quoting,
joining or adding a newline. The launcher supplies verified file-backed stdin to
the child. Missing/mismatched stdin, NUL, more than 1 MiB, a mismatched digest or
any extra production argument is rejected. All ten frozen public prompts are
regression-tested for exact stdin bytes.
This fixed grammar is not ownership authority: only the genuine bridge may
return the descriptor, and its private URL/session/executable binding and exact
native-artifact/guard checks remain mandatory before releasing inference.

```
node bench/v4/real-use/execute.mjs --help
node bench/v4/real-use/execute.mjs --dry-run --prereg FILE --amendment FILE --approved-artifacts FILE --out EXACT_PREREGISTERED_PATH
```

Only the parent may subsequently use `--execute` with `REAL_USE_ALLOW_EXECUTE=1`.
Help/preview never stage, spawn, reserve outputs or call a provider. The production
entry point has no injectable bridge/capture factory. `run.mjs`'s older CLI stays
blocked. `executeFixtureSchedule` is Node-test-only, requires a `fixture-` run ID,
and cannot mint production capabilities or finalization receipts.

The approved-artifacts file is a bounded local JSON `real-use-execution-bindings/v1`
with exactly `schema`, `prereg_sha256`, `amendment_sha256`, `source_sha256` and
`operator`. `operator` contains only absolute `cliPackageDir` and safe relative
`nativeTmpRelative`, never credentials. `source_sha256` has exactly the repository
paths exported as `DRIVER_SOURCES` in `admission.mjs`. The parent must produce this
file **after final code review**, with exact current byte hashes. These hashes are
change bindings, not authority. Independently pinned preregistration/amendment,
runtime controls, checker build/follow-up, dependency sources, snapshot contents,
current immutable image IDs and a genuine active bridge are also required. Stale
dependent source evidence fails closed, rather than silently reusing old controls
or rerunning the campaign automatically.

The original preregistration is preserved verbatim in provenance. The effective
manifest retains its run ID, seed, schedule, base model, logical workspace,
prompts, budgets and protocol hash, adds effective variant `default`, and records
an explicit pre-inference controller-metadata amendment with source origins.
The exact preregistered output is atomically reserved; manifest, amendments and
execution-start are persisted before setup/dispatch. Per-episode setup/failure/
cleanup records live in `setup/`, outside the strict episode loader. No setup
failure disappears or triggers replacement. Cleanup is always attempted, bounded
at 60 seconds, and uncertainty fences the run in `execution-stop.json`.

Pending bridge-writer API (fixed module, no caller-selected imports):

- Export `ADMISSION_API = 'real-use-owned-live-bridge/v1'` and
  `isOwnedBridge(handle)`, backed by a private constructor WeakMap. Existing
  `startAuditBridge(options)` must accept run/episode bindings and effective
  variant. Unsupported API versions fail before staging.
- Handle methods: `audit()`, `auditContext()`, `getBindings()`, `admit(cap)`,
  `dispatch({item,task})`, `finish({observedSessionIDs,observedModels,promptSha256,signal})`,
  and idempotent `cleanup()`. `dispatch` returns only `{launch,launcherFactory}`;
  it must not start the solver before capture's clock. Construction must clean up
  any internally owned resources if it throws before returning a handle.
  **Admission alone calls `audit()` then `auditContext()`, once per episode.**
  The controller does not call either audit; the bridge must not duplicate the
  context submission during admit/dispatch. Admission binds frozen authoritative
  item/task copies before any await; bridge dispatch and finish must treat their
  evidence inputs as read-only. Observation arrays are copied before finish;
  settled episode identity/usage is validated against the owned terminal and
  deeply snapshotted so later caller mutations cannot change budget decisions.
- `getBindings()` is a stable, private-state-derived projection with `schema`
  equal to the API version, `active`, `run_id`, `episode_id`, `condition`, `model`,
  `variant`, `prompt_sha256`, unique `nonce`, actual absolute `workspace`,
  `snapshot_sha256`, and current repository-keyed `source_sha256` for bridge,
  stage, runtime-plugin and cli-builtins. It also supplies `startup_audit` and
  `context_abort_audit` equal to `passed`, plus `context_evidence_sha256` derived
  from the reviewed fresh native/guard evidence. Arbitrary caller-set properties
  or audit JSON cannot substitute for the private owned-handle brand.
- `admit(cap)` must call
  `consumeEpisodeCapability(cap, thisHandle, thisHandle.getBindings())` exactly
  once before arming its guard. Capabilities bind one handle, nonce, prompt and
  schedule position; concurrent minting/reuse/reordering is fenced.
- `dispatchAdmittedEpisode` consumes the dispatch opportunity once, checks the
  frozen owned-server descriptor, exact 300000-ms solver limit and staged cwd,
  and projects non-secret per-episode bindings into `setup/NN.admitted.json`.
- `finish` must return guard-backed identity `{status:'validated',model,variant,
  session_id,prompt_sha256}`, guard `{status:'passed',nonce,context_evidence_sha256}`,
  and cleanup `{confirmed:true,server:{confirmed:true,active_processes:0},
  daemon:{confirmed:true,active_processes:0}}`. `cleanup()` uses that cleanup shape.
  `finishAdmittedEpisode` validates and brands the projected receipt; raw fixture
  callbacks cannot produce a production-valid receipt. No credential-bearing
  object, raw environment, auth argv or password fingerprint is persisted.

Optional capture `finalize(facts)` runs before atomic terminal publication, with
a separate 60-second maximum (lowerable fixture `limits.finalizeMs`). The
controller's `finalize.abort()` starts owned server/daemon cleanup promptly on
solver abort, independently of the 25-second CLI cleanup grace. Failure, timeout
or an unbranded receipt preserves answer/artifacts/subtotals but marks the episode
operationally failed, usage unknown and safety-fenced. Without finalization,
legacy capture still never claims identity validation. Timings distinguish
`setup_ms`, `solver_ms`, `cleanup_ms`, and `end_to_end_ms`; the 300-second solver
clock begins at CLI launch, includes model binding/tool work, and excludes setup
and subsequent cleanup.

## Data boundary and gates

`tasks/public.json` is the only task data supplied to solvers. The reference
answers, full source hashes, rubrics, and positive controls in
`grader-data/gold.json` are **evaluator-only**. Do not mount or copy `grader-data`
into any solver workspace. Do not mount an output directory or the entire
evaluation repository into a solver. Mount only explicitly approved corpus
inputs and condition-specific runtime assets, with the same generic tools,
corpus visibility and resource limits in both conditions.

Readiness must enforce that exclusion through an authenticated sandbox mount /
copy allowlist and adversarial gold/output path-access probes, including resolved
links and parent directories. A declared `gold_separation: true` alone is not
proof of isolation. The current runner remains fail-closed without an
authenticated adapter; a hand-written readiness JSON cannot authorize execution.

Required gate pipeline, before any model episode: task schemas and source hashes
→ independent symbolic controls → sandbox/path exclusion and tool-parity probes
→ safe external checker positive **and negative** controls (wrong target,
unallowed axiom, missing theorem, invalid proof) → authenticated readiness bound
to this protocol/task/environment → explicitly authorized capped run. Do not
substitute cherry-picked solver successes for any gate. Integrated tests,
security/isolation and Lean checker validation belong to the parent owner.

## Commands (from repository root)

```powershell
node --test bench/v4/real-use/tests/tasks.test.mjs
$env:REAL_USE_CORPUS_ROOT='C:/_Work/__OPENAI_MATH/math'
node --test bench/v4/real-use/tests/tasks.test.mjs
node bench/v4/real-use/run.mjs --dry-run --model opencode-go/deepseek-v4.1-flash --tasks bench/v4/real-use/tasks/public.json --workspace ../real-use-solver --out ../real-use-run-001 --seed real-use-v1 --repeats 1 --max-episodes 20 --max-cost-usd 1
# Evaluator-only export for an existing captured run (not created by dry-run):
node bench/v4/real-use/grade.mjs --out ../real-use-run-001 --gold bench/v4/real-use/grader-data/gold.json --corpus-root C:/_Work/__OPENAI_MATH/math
# Opt in to the maintained independent checker (all three absolute paths required):
node bench/v4/real-use/grade.mjs --out ../real-use-run-001 --gold bench/v4/real-use/grader-data/gold.json --corpus-root C:/_Work/__OPENAI_MATH/math --checker-build-receipt C:/evaluator/checker-build/build-receipt.json --checker-work-dir C:/evaluator/fresh-checker-work-001 --docker-executable "C:/Program Files/Docker/Docker/resources/bin/docker.exe"
```

For grading, `--out` is the **existing captured run** containing `manifest.json`
and `episodes/`; its `evaluation/` output must not already exist. Choose one of
the two grader commands above, not both for the same run. The checker work directory
must be fresh, with an existing parent, and all evaluator artifacts must remain
outside the manifest's solver workspace. The three checker flags are all-or-none;
no checker image, policy, module or command overrides are accepted. Without them,
Lean checks remain `grader_unavailable`, not mathematical failures. With them,
the maintained adapter validates the frozen policies/build digests and runs the
isolated compile/export and independent data-only checker—never host Lean.
Only `evaluation/blind.json` goes to reviewers. The private map, code/policy-bound
checker results and provenance, and raw checker work artifacts stay evaluator-only;
printed answer receipts are never trusted. Existing corpus-reference hash checks
still apply. Started-only episodes are not treated as completed answers. This
grading command makes no provider calls and does not authorize model execution.

Dry-run is a preview, not authorization, and launches no model. Use a new output
path for each approved run. Adding `--execute`, `REAL_USE_ALLOW_EXECUTE=1`, budgets
and a readiness file still must fail until the authenticated adapter and all
controls above validate. No execution is authorized by this document.

## Reference provenance and local validation

Source paths are relative to the math corpus. The grader requires an explicit
`--corpus-root` whenever gold contains
references; it never guesses a host root or resolves against the gold directory.
Traversal, absolute paths and resolved symlink escapes are rejected. This option
is evaluator-only and does not expose gold or references to solver prompts.
SHA-256 covers the original file bytes, including UTF-8 text line endings (no
normalization); PDF hashes cover the
released binary artifact. Quotes must match literal source text or the extracted
PDF sentence. These records freeze source claims, **not their mathematical truth**.
The resolved references are the characteristic-two manuscript README at L5,
`lean/docs/021.md:L9`, and the symmetric Mahler manuscript's actual root
`paper.pdf`, physical page 6 / printed page 6, Lemma 2.2. The evidence snippets
are explicitly supplied scenarios, not claimed new executions.

Independent Python SymPy 1.14.0 validation: determinant 589, rank 4 and exact
inverse-product identity; rational equation roots {-4,1} with exclusions {-1,2},
cleared polynomial `(x-2)*(x-1)*(x+4)` and both original-root checks; integral
`3*log|x-1| + 2*atan(x)` with zero derivative residual on each real component.
The portable Node tests independently check exact algebraic self-consistency
without Python, SymPy or Lean. Corpus/PDF checks skip when the corpus is absent;
when present they check exact hashes, line quotes and the released PDF using the
existing `unpdf` dependency. No source reference is known missing at preparation.

## Closed fresh profiles (g023/g024)

The earlier g004 controller examples above are historical: execution now rejects
legacy bindings. Historical report v1 recomputation remains unchanged. Only the
source-defined `g023-compat` (1 fixed task, 2 episodes, USD 0.10 soft reported threshold) and
`g024-workflows` (original ten public tasks, 20 episodes/order, USD 0.90 soft reported threshold)
can execute, subject to parent approval and all gates. No borrowing between profiles;
the combined USD 1 soft reported threshold is not a billing cap. No
harness retry/resume or model fallback is allowed. Observed native recovery,
reused assistant IDs or unresolved correspondence blocks eligibility; this does
not claim to prevent unobservable native/provider recovery or cap provider bills.

Eleven runtime attempts have run: the earlier g004 study, six stopped probes (`g005-compat`,
`g007-compat`, `g009-compat`, `g011-compat`, `g013-compat`, `g015-compat`), the
passing `g017-compat` and `g021-compat` probes, and the partial `g018-workflows`
and `g022-workflows` studies. Separately, `g019-compat` aborted before spawn
(twelve attempts if that pre-spawn abort is included).
The six stopped compatibility attempts failed with `safety_failure`
after one ON attempt; none reached its OFF counterpart. The g005 finalization
failure's cause was not then attributable. The g007 cause was confirmed as
`native_message_cursor_rejected`: the message pager rejected a `next` cursor on
an empty page. The g009 cause was confirmed as `native_child_scope_rejected`:
the children route returned a `next` cursor on an empty result, and cursor
presence was incorrectly treated as more children. The g011 primary cause was
`native_event_correspondence_rejected`: an unclassified observer event was
rejected; `fresh_finish_deadline` was only a downstream finalization symptom.
The g013 attempt produced a fully corroborated native completion record for the
first time, but admission wrongly rejected it at final artifact binding because
its row model did not allow the optional leading `agent-switched` row already
permitted by the bridge. That assumption is now fixed: at most one leading switch,
`[agent-switched?, user, assistant×N, idle]`, with N+2 or N+3 rows.
The g015 attempt aborted mid-episode because an observer event-timestamp hygiene
bound rejected a legitimately delivered event: a harness hygiene-bound failure,
not model behaviour. The two hygiene bounds now allow a bounded ±2000 ms
tolerance, with `native_event_timestamp_before_creation` and
`native_event_timestamp_after_receipt` reasons and a clamped signed
`timestamp_delta_ms`; every authority bound remains unchanged.
The g017 probe was the first passing compatibility pair: both conditions had
validated receipts and a passing checkpoint. The g018 main study produced the
first partial paired dataset: 10 completed episodes, 1 operational failure and
9 not started out of 20. It stopped because the old argv transport rejected
punctuation-bearing negative-number prompt fragments. Exact stdin bytes now
replace prompt argv fragments, with file-backed stdin in the trusted launcher;
the refreshed runtime campaign passed 31/31 controls against that launcher.
The g019 first ON attempt aborted before spawn because the launcher rejected
the descriptor's `stdin_sha256` key as an unknown option. The earlier handoff
did not exercise the CLI transport, so its controls did not establish this
descriptor-to-launcher integration. The launcher now accepts the digest and
verifies that it matches the raw Buffer bytes; 21 actual Windows cases passed.
The g021 probe passed both conditions over stdin with validated receipts and a
passing checkpoint. The g022 main study ran five episodes: 4/20 delivered and
1 operational failure, stopping on a recovery/auxiliary event gate while a sixth
request was pending. The stdin transport is proven; the current binding constraint
is the recovery/auxiliary gate, not prompt transport. Attribution now records
`observer_event_type` and `observer_event_types`, so a recurrence names the exact
event type; rejection decisions are unchanged. No exact rejected type is inferred
for the stopped g022 artifacts.
The seven identified harness defects (empty-page message cursor, empty-result
children cursor, unclassified observer event, admission artifact row model,
event-timestamp hygiene bounds, the argv transport limitation, and the launcher
digest-key defect) are now
addressed. Unknown non-durable
owned-session events are ignored within existing limits; unknown durable events
still reject with `native_unknown_durable_event`. Observer diagnostics retain
`observer_reason`, up to eight safe unknown event type names and a bounded ignored
count. These fixes do not turn the failed attempts into successes.
The retired `g006-workflows`, `g008-workflows`, `g010-workflows`, `g012-workflows`, `g014-workflows`, `g016-workflows`, and `g020-workflows` main studies
never started. Stopped artifacts remain immutable and are not reinterpreted.
All g004 evidence and the g005/g007/g009/g011/g013/g015 disclosure bindings remain
unchanged, including g013's corroborated native completion artifact. The shared
g017/g018 parent approval and two-registration freeze, g017 passing checkpoint,
and g018 execution-stop record and evaluation report also remain unchanged.
The g019 parent approval, two-registration freeze and execution-stop record are
unchanged. The shared g021/g022 parent approval and two-registration freeze,
g021 passing checkpoint, and g022 execution-stop record and evaluation report are
additional fixed absolute-path/SHA-256 disclosures, not execution authority.
No g015 native completion artifact exists. The partial datasets are exploratory; no confirmatory accuracy or
plugin-benefit comparison exists.

The new run IDs are `real-use-g023-compat-20261113` and
`real-use-g024-workflows-20261113`; each output is the same-named directory under
`C:\Users\MiPC\AppData\Local\Temp\opencode`. Both retain the same model,
effective variant `default`, seed `real-use-v1`, one repeat, 300000-ms timeout,
concurrency one and identical generic tools; ON adds only `math_search` and
`math_manuscript`.

Freeze both external registrations with the **same pre-probe `created_at` and
source version**, after source/evidence review. Preview is read-only:

```text
node bench/v4/real-use/execute.mjs --dry-run --registration ABS_FILE --registration-sha256 APPROVED_SHA256 --out EXACT_REGISTERED_PATH
```

Execution additionally requires `--execute` and `REAL_USE_ALLOW_EXECUTE=1`.
Main requires `--probe-checkpoint-sha256 APPROVED_SHA256`, approved separately
after g023's immutable `C:\Users\MiPC\AppData\Local\Temp\opencode\real-use-g023-compat-20261113\first-pair-checkpoint.json`
exists; neither
registration is rewritten. Each run automatically persists its first-pair
checkpoint after both settlements and saved cleanup, before any third setup.
Probe tool correspondence, native evidence, complete recorded accounting, exact
identity/source bindings and cleanup are required; a wrong quoted answer alone
does not fail this operational gate. JSON booleans never mint private authority.
Fresh report v2 separates delivery, eligible correctness, raw CLI/native usage
and failed-attempt timing. Provider usage completeness and billing remain unknown.
