# Evaluation v2 — simulator and fail-closed adapter preparation

This standalone, dependency-free Node harness implements EVAL-01/02/03,
STAT-01 and the EXEC-01 restricted execution preparation profile. It does not
modify or replace the historical keyword benchmark. **The committed simulated pilot is
simulated; its scores say nothing about real models or mathematical validity.**
A separate exploratory real-adapter pilot (90 episodes, one model, one repeat,
30 provisional tasks) is preserved under `real/pilot-2026-11-09-...`; it is not
confirmatory and its F−B result is negative/neutral. See `real/README.md`.

From the repository root (Node 20+):

```text
node --test bench/v2/tests/v2.test.mjs
node bench/v2/run.mjs
node bench/v2/analyze.mjs
```

The default output is `bench/v2/simulated/simulated-pilot-receipt-v2.1/`. Both commands accept
`--out <directory>`. A second run resumes idempotently; it does not rewrite the
manifest, completed episodes, starts or existing content-addressed artifacts.
The analyzer regenerates only `report.json` and `report.md`.

The earlier `simulated/simulated-pilot/` snapshot is preserved unchanged: it
completed against the original 15-tool interface before a concurrent delivery
added `math_lean_verify`. The subsequent `simulated/simulated-pilot-full-plugin/`
48-episode snapshot is also preserved unchanged. The current pilot enumerates
all 16 tools, records receipt schema 2.1.0 and has its own study ID and 48 episodes.
Neither old snapshot should be resumed with the new source/schema fingerprint;
their saved reports remain historical simulated artifacts. This schema-update
pilot is still entirely simulated and adds no formal task to the four-task pilot.

## Conditions and isolation (EVAL-01)

| Condition | Effective interfaces | Corpus |
|---|---|---|
| A | No tools | Not mounted/copied |
| B | `corpus_search`, `read_excerpt`, `compute`, `lean_check` | Same toy excerpts as F |
| F | All 16 plugin tool names, enumerated in `profiles/F.json` | Same toy excerpts as B |

Profile validation checks exact tool sets, uniqueness, corpus permissions and
configuration mode **before execution**. A/B reject any `math_*` tool. The actual
simulated dispatcher checks the manifest for every call; availability is not a
prompt-only promise. F exposes the complete plugin interface, but all endpoints
are simulated. Non-pilot endpoints return explicit non-executed fixture results;
they do not claim to perform computation, Lean checks or maintenance.

Every episode gets a new `mkdtemp` workspace with only `task.json`, `profile.json`,
the identical common instructions, empty home/cache/tmp directories, and (B/F)
public corpus excerpts. A recursive exact-file/content allowlist rejects extra
files, symlinks, history, answers, graders, reference reports or configs. Private
grading specifications and expected finals are stripped from task payloads.
Workspaces are checked before every tool call and after the adapter returns, then removed.
Simulated endpoints accept only the public `task_id`, never arbitrary file paths;
attempts to request evaluator files fail before any event/evidence is emitted.
No session state, agent history, user/global configuration, shared cache, skill or
plugin instructions are loaded. The simulated adapter has no persistent state.

The fixture controller is trusted evaluator code: it holds pre-authored outputs
outside the agent workspace. **This same-process simulator is not a security
sandbox for a real agent.** The future real adapter must be a separate restricted
process/container, receive only the public workspace and allowlisted environment,
deny traversal into evaluator files, and independently audit effective tool
availability. Merely changing HOME is not sufficient OS isolation. The simulator
does not enable real inference. The separate adapter below prepares real CLI
invocations but currently refuses execution without an audited runtime boundary.

Task text, common prompt, token/tool/time/USD budgets and cold-cache state are
identical across A/B/F. Unavoidable interface differences are the available tool
names, schemas, retrieval conveniences and the absence of corpus access in A.
For comparability, no math-workflow skill or condition-specific advice is added.
The synthetic adapter intentionally varies fixture outcomes by condition; these
are scripted test cases, **not evidence that a tool improves performance**.

## Typed grading (EVAL-02)

`final` and structured tool `events` are separate protocol fields and separate
hashed artifacts. Nothing parses or scores process stdout/stderr. Missing or
malformed typed finals produce `extraction_failure`; correct text in tool output
cannot rescue them. The typed final fields, not extraneous prose, are authoritative.

- **Numeric:** finite numeric JSON value; preregistered absolute/relative
  tolerance; exact domain, units and complete condition set.
- **Symbolic:** exact cross-multiplication of bounded integer-coefficient rational
  polynomials (coefficients low-to-high, magnitude at most 10,000, length at most
  eight), explicit assumptions/domain/conditions, and preregistered denominator
  classes to prevent extra poles. Alternatively exact finite solution sets.
  This is not a general-purpose CAS or a numeric-sampling equivalence test.
- **Citation:** exact document ID, locator and fixture-supported verbatim claim,
  with an affirmative support flag. A correct claim with the wrong document fails.
- **Formal:** fixed target hash/name/type, solution hash, exact v1 execution,
  compilation, target and proof statuses, toolchain, allowed axioms and policy
  hash in a versioned, schema-validated study receipt envelope (specified below).
  The receipt must arrive through a **trusted verifier side-channel**, never
  self-asserted in the answer. Its digest provides integrity, not authentication.
  Simulated receipts require explicit opt-in and are labeled as simulated; the
  fixture compilation status is **not actual Lean verification**. No reference proof
  is provided to the agent. The separate executor alone does not issue a trusted
  receipt or prove target/policy compliance.
- **Explanation:** exact text hashes map to preregistered, blind rubric labels;
  the grader receives no model or condition identity. Unknown prose fails as
  unscored. No LLM judge or keyword-overlap proxy is used.
- **Absence:** distinguishes `not_found_in_consulted_excerpts`, `nonexistent`
  and `corpus_unavailable`. Consulted excerpt IDs must match observed structured
  evidence; nonexistence requires an explicitly exhaustive inventory and trusted
  inventory evidence; unavailability requires trusted unavailable-corpus evidence.

`fixtures/tasks.json` contains four small, self-authored public toy tasks: speed,
rational cancellation, citation and negative excerpt retrieval. Three families
are used; the two retrieval tasks intentionally share a family. Adversarial tests
cover keywords only in logs, negation, missing domain restrictions, extra
solutions/poles, wrong citations, fabricated receipts and absence overclaims.
Formal/explanation fixtures are tested, not included in the 48-episode pilot.

### Receipt alignment: study schema 2.1.0 / `math-study-verification/v1`

The envelope's `verifier` field contains the structurally valid
`math-lean-verify/v1` receipt, with its actual status vocabulary preserved, not
translated. All status fields are required. Unknown statuses, wrong versions,
extra fields and the old flat study schema 2.0.0 fail closed. Recognized failure
statuses are valid receipt data but cannot be passing proofs.

| v1 field | Complete accepted vocabulary | Required for a passing formal grade |
|---|---|---|
| `execution.status` | `completed`, `timeout`, `missing-tool`, `error` | `completed`, with `exitCode: 0` |
| `compilation.status` | `not-run`, `compiled`, `failed` | `compiled` |
| `target.status` | `not-requested`, `identified`, `missing`, `mismatch` | `identified`; exact registered theorem and expected type |
| `proof.status` | `not-requested`, `unverified`, `incomplete`, `rejected`, `verified` | `verified`; no `sorryAx` or unauthorized axioms |

Terminology crosswalk for the proposed research vocabulary (documentation only;
**no implicit alias conversion is performed by the grader**):

| Proposed term | Actual v1 spelling / study treatment |
|---|---|
| execution `tool_missing` | `missing-tool`; failing grade |
| compilation `success` | `compiled`; necessary but insufficient for success |
| target `absent` | `missing`; failing grade |
| proof `verified_under_policy` | `verified`; accepted only with all other target/policy/provenance checks |
| proof `rejected` | `rejected`; failing grade, including unauthorized-axiom rejection |
| Any other status above | Identity mapping; all non-passing states fail |
| Any unfamiliar status/alias | Schema rejection, never guessed or coerced |

The envelope adds target/solution/policy hashes, toolchain, a digest of the nested
v1 payload, issuer and provenance. `provenance.issuance` must be
`evaluator-controlled`; `evidence` is `simulated-fixture` for simulation and
`verifier-output` otherwise. The trusted evaluator is responsible for binding
the invocation's source, target and policy to those hashes. A standalone v1
receipt supplies neither these source bindings nor issuer authentication and is
not accepted as an envelope. Neither the digest nor an agent-supplied receipt is
evidence of trusted issuance.

**“Independent receipt” means evaluator-controlled issuance, not automatically
an independent kernel check.** This envelope version explicitly fixes
`provenance.independent_kernel_check` to `false`. No separate kernel/Comparator
check is implemented or implied. `correspondence.status` is fixed to
`not-assessed`, with scope `fixed-lean-target-only`: v1 does not establish that
the formal target expresses an informal problem. A `verified` proof status does
not change this. Actual independent checks or correspondence adjudication would
need their own explicitly versioned evidence, not a renamed success status.

### Linked Delivery 3 acceptance evidence

All checks below are in [`tests/v2.test.mjs`](tests/v2.test.mjs); bracketed IDs are
literal test-name prefixes. They execute only local fixtures/mocks.

| Requirement | Linked test name / evidence |
|---|---|
| Receipt vocabulary and fail-closed mapping | `[RECEIPT-01]`: every v1 status, rejected/unknown/alias/missing status and legacy receipt |
| Evaluator issuance, binding and correspondence | `[RECEIPT-02]`: rehashed adversarial receipts cannot bypass policy, source binding, provenance or correspondence |
| Fresh workspace, grader/answer-access denial, file/content allowlist | `[EVAL-01] dispatch denies evaluator files and content tampering before returning any evidence`; existing workspace/profile tests also verify A has no corpus/tools |
| Log-only correct keywords, negation, missing domain/units/conditions, wrong document | `[EVAL-02] observed correct tool evidence cannot rescue absent, negated or wrong-document finals`; existing numeric/symbolic/citation tests cover tolerance and equivalent correct answers |
| Interrupted resume, duplicate identity, missing pair, all-started denominator | `[EVAL-03/STAT-01]`: pending F remains paired failure, resume records interruption without rerun, duplicate start blocks writes, unpaired B is counted explicitly |
| Repeats not independent; tasks/models retained within family | `[STAT-01] resampling preserves opposing tasks and models within one family, not independent repeats`; existing two-family bootstrap test checks seeded CI |
| Simulation not measurements | `[EVAL-03] saved simulated artifacts and reports explicitly disclaim measured cost, duration and real-model inference`; verifies markers, null observed cost, fixture timing, negative cases and failures |
| Determinism, schema validation, append-only resume | Existing `48-episode pilot is deterministic...`, schema, ledger-corruption and budget tests |

These tests establish the simulated protocol boundary only, not OS containment,
real model behavior, Lean correctness, or an independent kernel check.

## Provenance, recovery and adapter contract (EVAL-03)

- `manifest.json`: protocol/schema/adapter/grader/Node versions, repository base
  commit (or null), corpus commit (null for toys), SHA-256 hashes of evaluation
  sources/schemas/profiles/fixtures, effective profiles, exact prompts/contracts,
  common budgets, cold cache, environment, model/task/family catalog, seed,
  resample count and expected Cartesian product. Source hashes cover working-tree
  code even if the repository commit predates this delivery. Tests, documentation
  and generated output are excluded from the evaluation source fingerprint.
- `starts.jsonl`: fsynced append-only start ledger, written before episode work.
  Composite identity is the collision-safe JSON tuple
  `[study_id, model_id, task_id, condition_id, repeat_id, attempt_id]`.
- `episodes.jsonl`: fsynced append-only terminal records with the same unique key,
  grade, final, events, usage, budget flag, error category, duration/source,
  observed/estimated cost/source/date and artifact hashes. Wrong answers remain
  completed episodes with a failed grade, not operational errors.
- `artifacts/<key-sha256>/`: immutable content-addressed final and event files.
  Loading/analyzing verifies hashes and exact correspondence with ledger fields.
- A directory lock excludes concurrent writers. Duplicate keys, unexpected keys,
  changed protocol, corrupted artifacts and truncated JSONL fail closed. A stale
  lock requires manual inspection/removal after confirming no writer is alive.
  Truncated ledgers require explicit repair; the harness never silently truncates.
- If a start has no terminal record, analysis already counts it as failure.
  Resume appends an `interrupted` failure **without rerunning that attempt**.
  A stopped batch with no pending start resumes the next expected episode.
  Completed records are never overwritten; orphan crash artifacts may remain.
  Changed fixtures/code require a new output directory/study preregistration.

The public adapter boundary is: isolated public task/profile/workspace in;
`{final, usage: {tokens, tool_calls}, duration_ms}` out, plus ordered dispatcher
events and evaluator-only verifier/evidence context. Future real adapters must
retain the same schemas, keys, extraction/grade rules, budgets, evidence channels
and family-paired analysis. The schemas already allow real model strings,
`simulated: false`, wall-clock/monotonic timing and isolated-adapter provenance;
the runner is deliberately locked to `simulated-model-a/b` and does not expose
real inference. Real execution needs an actual audited adapter, tool
implementation, measured costs and verifier integration, not a protocol change.

The pilot's fixed epoch (`2026-01-01`) and durations are a **synthetic clock**.
Observed cost is null; estimated cost is zero with a dated fixture-accounting
source. These are not measured runtime or real price estimates. Unknown monetary
cost cannot count as within a USD budget. Fixture outputs and episode bytes are
deterministic; the manifest also records the actual host Node/platform and Git
base commit, so cross-environment manifests/reports may differ.

## Analysis (STAT-01)

Primary metric: **correct episodes under every budget / all started episodes**.
Negative tasks, wrong answers, extraction failures, operational failures,
over-budget answers and unfinished starts all stay in the denominator. Unstarted
expected episodes are reported explicitly, not silently labeled failures.

The main contrast is paired **F−B**. A cell pairs task, model, repeat and attempt;
both starts are required. Missing terminal records score zero. Unpaired cells
are excluded only from this contrast and their count is reported. Full missing
expected composite keys are listed. Per-model, per-domain and model × domain
condition metrics are included; model/domain contrasts have their own caveats.

The percentile bootstrap draws **whole task families with replacement**, retaining
all tasks, models, paired conditions and repetitions within a drawn family. It
uses seed `20260101`, 2,000 resamples and the floor-index empirical 2.5/97.5%
quantiles. The point estimate is episode-cell weighted; repeated observations are
retained, **not treated as independent tasks**. With three pilot families (and
as few as one in domain strata), these are exploratory CIs, not confirmatory
evidence or real-model comparisons. There are no post hoc outcome exclusions.

## Restricted Lean preparation (EXEC-01)

`exec/restricted.mjs` separates `prepareRestricted` from explicit
`executeRestricted`. The evaluation runner never invokes Docker. Preparation and
`--dry-run` require only a dedicated local staging directory containing ordinary,
non-linked `.lean` files and a pre-provisioned immutable image digest:

```text
node bench/v2/exec/restricted.mjs --dry-run --code-dir <lean-only-directory> --image <image>@sha256:<64-hex-digest>
```

The JSON output prints the executable and complete Docker arguments. The image
contract is `/opt/lean/bin/lean` with libraries at `/opt/lean/lib/lean`; any further
trusted libraries/toolchain must be baked into the approved image, not mounted
from credentials-bearing host directories. The image must already be installed
(`--pull never`). There is no build/download step.

Restrictions: no network; read-only root; bounded noexec/nosuid/nodev `/tmp`
tmpfs; UID/GID 65532; 512 MiB memory/swap ceiling; one CPU; 64 PIDs; all capabilities
dropped; no new privileges; one read-only code bind mount; no Docker socket,
credential or home mounts; sanitized Docker-client environment and empty
temporary Docker config. Execution fixes the Lean entrypoint/output location,
has a 30-second deadline and attempts removal of only its unique container after
success/failure/timeout. It never runs Lean on the host. Docker unavailability
fails explicitly. A container is defense in depth, not a complete kernel security
boundary, and cannot defend against a trusted host mutating staging concurrently.

`--execute` exists as an explicit, separate opt-in for later authorized use; it
was **not run** for this delivery. Tests exercise dry-run and mock execution only,
including Docker absence and timeout cleanup. They do not establish that an image,
Lean compiler or real formal verifier works.

## OpenCode adapter: exploratory real pilot; no confirmatory pilot

`adapters/opencode.mjs` is separate from the unchanged simulator/graders. **An
exploratory 90-episode real-adapter pilot was run with one model, one repeat,
and 30 provisional tasks; see `real/README.md`.** It is not confirmatory.
The real integration layer is `study/run-study.mjs`; see `study/README.md`. Its
dry-run builds the full matrix; the pilot used a runtime plugin-load audit, a
safe credential-home copy, evaluator receipts, and session-export usage. Free
model routes were tested and were not viable for B/F.
It supports `--tasks <JSON-array-file>` (including provisional task sets) and an
optional `--task <id>` filter. Without `--tasks`, `--task` selects a toy fixture.

```text
node bench/v2/adapters/opencode.mjs --profile A --task numeric-speed --model provider/model --out <output-directory>
node bench/v2/adapters/opencode.mjs --profile B --task citation-toy --model provider/model --out <output-directory> --dry-run
node bench/v2/adapters/opencode.mjs --profile F --tasks <task-file> --task <id> --model provider/model --out <output-directory> --dry-run
node bench/v2/adapters/opencode.mjs --profile F --task citation-toy --model test/no-inference --out <output-directory> --audit --dry-run
node --test bench/v2/tests/v2.test.mjs bench/v2/tests/opencode.test.mjs bench/v2/tests/generic-tools.test.mjs
```

Dry-run is the default. Without `--audit`, it does not launch OpenCode, resolve providers, load user
credentials, run model inference, invoke plugin tools, or install dependencies.
Each task gets a fresh temporary workspace and a uniquely named output directory
containing `plan.json`. The printed JSON includes the exact executable/argv/cwd,
sanitized environment, proposed config, requested inventory, public-input/config/
profile/workspace hashes and diagnostics. Workspaces are retained for inspection;
remove only the explicitly reported temporary directories when finished.

### Non-inference inventory audit (`--audit`)

`--audit` runs the audit and exits, optionally with `--dry-run`; it cannot be
combined with `--execute`. **The current runtime guarantee is
`runtime-plugin-load`: the real server loads the staged `.js` plugin after
`/api/config`, and the static permission/registration audit matches.** It is
not a filtered catalog snapshot or an OS sandbox. It creates no OpenCode
session, sends no prompt, invokes no tool implementation and makes no model
call. The model argument is only a plan label. A `MATH_BENCH_SAFE_HOME` copy of
the host config/cache and credential DB is supported for the real adapter; the
exploratory pilot used it. No OpenCode server or port is opened by the
static-only fallback.

Read-only investigation of installed CLI 2.0.29 covered `--help`, `serve --help`,
`agent --help` (no such subcommand), `debug --help`, `debug agents --help`,
`debug config --help`, and `api --help`. The installed 2.0.29 client contract
(`@opencode/client/dist/promise/generated/{client,types}.d.ts` and its generated
HTTP implementation) exposes GET `/api/agent`, `/api/agent/{agentID}` and
`/api/plugin`, but agent results contain permissions, not an effective tool
snapshot. Config sources/plugin metadata do not prove catalog filtering. No
supported session-free effective inventory endpoint was found; no guessed tool
endpoint, session creation or inference was used as a substitute.

The fallback imports the **copied staged V2 plugin entry** in a bounded Node child
process with staged cwd and fresh HOME/XDG/OPENCODE_CONFIG_DIR. It observes
`ctx.tool.transform` registrations in that process, without calling their executors.
This is not OpenCode's plugin loader or resolver. It checks the exact hashed staging
tree before and after, the manifest, the staged `.js` entry and exact registrations.
Ordered agent permissions (the adapter's agent is `benchmark`) and `tool.use`
policies are normalized last-match-wins. Unsupported rules, wildcard/unknown
allows, duplicate, extra or missing tools, plugin failures, malformed responses,
timeout and cleanup failure all fail closed. Expected inventories are:

- A: no plugin and zero tools.
- B: `corpus_search`, `read_excerpt`, `compute`, `lean_check`, plus `execute`;
  no `math_*`, core read/grep or shell equivalent.
- F: the manifest's 16 `math_*` tools, core `read`, `glob`, `grep`, `shell`,
  plus `execute`. Core tools are adapter allowances, not plugin registrations.

Reports retain `runtime_verified: false`, `supported: false` and
`isolation_verified: false` even when the deterministic comparison passes.
`plan.json` and `audit.json` remain in the output directory; audit child processes
are closed and the entire temporary workspace is removed on success/failure.
The stdout summary reports the comparison and blocker. Exit 2 means static
comparison passed but execution remains unsupported; exit 1 means audit/error
failure. There is no runtime-proof override. The exact execution blocker is:

```text
static-equivalent: no supported session-free effective tool inventory endpoint was found in OpenCode 2.0.29; runtime inventory remains unverified
```

### Current unsupported cases (exit code 2 for prepared dry-runs)

All three unaudited plans report `supported: false` and
`runtime_inventory_status: "unverified"`. B now reports `inventory_supported: true`,
`inventory_status: "staged-plugin-exact"` and the four exact `effective_tools` of
its local plugin. This is a **staged plugin inventory**, not a successful OpenCode
runtime/isolation audit. A/F retain `effective_tools: null` and
`inventory_status: "unverified"`. The installed CLI was inspected with `opencode run --help` and
`opencode --version` (2.0.29); the local 2.0.29 schema supplies `agents`,
`permissions`, and `policies`. The concurrent source inspection in
[`research/opencode-isolation.md`](../../research/opencode-isolation.md) confirms
deny-based tool snapshot filtering, including the Code Mode transport. This is
not yet a per-episode runtime inventory or exclusive-config audit. No legacy
`agent.tools` setting is assumed to work.

- **A:** requests zero tools; exact zero-tool runtime exposure remains unaudited.
- **B:** explicitly stages the V2 generic plugin with exactly `corpus_search`,
  `read_excerpt`, `compute`, `lean_check`, plus the separately listed `execute`
  transport. Wildcard-deny permissions/policies allow only those five identifiers.
  No shell, generic read/grep, math plugin or `math_*` tool is exposed. Tests import
  the staged plugin and check its registrations and public-only retrieval.
  Real execution remains refused pending the runtime/isolation audit.
- **F:** copies the actual 16-tool plugin entry, implementation, worker/reindex
  scripts and installed runtime dependencies into the temporary workspace. Tests
  import that local copy and observe its 16 registrations without executing tools.
  No symlink, global plugin, generated archive index, user skill, full corpus or
  Lean toolchain is copied. Its required `execute` transport is allowed separately
  from the 16 logical plugin tools, alongside the adapter's four core allowances.
  The public excerpt JSON is **not** a native plugin
  corpus; retrieval/Lean availability and transport filtering are not established.
  Missing corpus/indexes must not be reported as evidence of mathematical absence.

### B generic plugin limits

`generic-tools.mjs` uses `Plugin.define` and `ctx.tool.transform`. Its runtime and
installed `@opencode/plugin` dependency closure are copied, not linked or loaded
from global config. Tool implementations do not perform network requests, install
packages or invoke a shell. Subprocess tests are mocked; installed Python/SymPy
and Lean availability has not been established by this delivery.

- Retrieval snapshots only the adapter's `corpus/excerpts.json` (at most 2 MiB /
  2000 entries). Extra/private fields and linked files are rejected. Search is
  case-insensitive literal substring matching, at most 10 results / 2000 characters
  each. Read accepts exact public document/locator identifiers, not paths, and
  returns at most 8000 characters. No grader/answer files are consulted. A miss is
  not evidence of corpus-wide nonexistence.
- Compute copies the unchanged fixed `math_compute.py` worker as `generic/compute.py`
  and invokes preinstalled Python with `-I -B`, a bounded JSON argument, no shell
  and a 10-second maximum timeout. It supports simplify/factor/expand/solve,
  differentiation/integration, limit/series/evalf and determinant/eigenvalues.
  The worker's AST allowlist limits expressions to 2000 characters, 500 nodes,
  depth 50, bounded numeric powers and at most 10×10 matrices. Strings, arbitrary
  function calls and Python evaluation are forbidden. Results are strings, not
  graded answers; simplification does not preserve/report domain restrictions for
  the model automatically. Python and SymPy must already be installed.
- Lean accepts one theorem/example with a single-line type and a bounded `by`
  proof (8000 characters, 40 tactic lines). Supported tactics are `trivial`, `rfl`,
  `decide`, `assumption`, `constructor`, `simp`, `intro <names>` and
  `exact <identifier>` / `exact True.intro`. Imports are limited to `Init`,
  `Init.Data.Nat.Basic`, `Init.Data.Int.Basic`, `Init.Data.List.Basic`; no Mathlib,
  custom imports, file arguments, strings, comments, commands, IO, `#eval`,
  `run_tac` or metaprogramming. A preinstalled native `lean` compiles a fresh
  temporary file with one thread, 256 MiB compiler limit and at most 10 seconds;
  that temporary directory is removed afterward. Elan shims and package/build
  downloads are not used. **This is compilation only:** even `compiled` returns
  `verification: "not-performed"`, `receipt: null`, with no target/axiom audit or
  `math_lean_verify` semantics.

These bounds and trusted-runtime assumptions are not an OS sandbox. Real execution
still requires evaluator-controlled containment against host filesystem/network
access and an audited Code Mode transport; the inventory fix does not bypass it.

### Isolation and execution boundary

Preparation uses `prepareWorkspace`/`assertWorkspace` on sanitized public task
fields and excerpts, then extends the exact-file/content allowlist for adapter
runtime assets. Grading/correct finals and private-marked excerpts are excluded.
It records per-file SHA-256 values and audits the complete staging tree. Unknown
files, payload changes and links fail closed. B/F plugins are **auto-discovered
from the staged `.opencode/plugins` directory**: the entry file must be `.js`
(the runtime lives in a subdirectory so it is not loaded as a second plugin).
A real `opencode run` smoke with the normal HOME confirmed the staged plugin
load log and a working `execute` call, but that smoke was not isolated and is
not pilot evidence.

The proposed child environment is allowlisted, redirects HOME/USERPROFILE, all
XDG state/data/config/cache directories, APPDATA/LOCALAPPDATA and temporary paths,
points `OPENCODE_CONFIG` at the generated config and `OPENCODE_CONFIG_DIR` at the
external home's config directory. `OPENCODE_CONFIG_PROJECT_DISABLE` is deliberately
**not** set: project discovery is confined to the fresh staged workspace. No
inherited `OPENCODE_CONFIG_CONTENT`, credential variables, `NODE_OPTIONS` or prior
sessions are passed. The command uses `--standalone --format json`, never `--auto`,
`--continue`, `--session` or `--server`. These are **preparation measures, not an
OS sandbox or an audited guarantee** against managed/ancestor config discovery,
host filesystem access, subprocess access or networking. The adapter can copy an
evaluator-supplied `MATH_BENCH_AUTH_FILE` and its sibling `account.json` into the
external home; no credential enters the agent-visible workspace. A provider
infrastructure package can be staged, but the exact model must be listed by
`opencode models --standalone` before any episode.

System/managed config may still load in OpenCode despite redirected HOME/XDG.
Config permissions and plugin code are **not an OS sandbox**. The runtime audit
requests `/api/config` and observes the real `loading plugin` log for the staged
entry; it does not snapshot the filtered Code Mode catalog or establish OS
containment. A no-tool run can end with `text` and no `step_finish`, so usage is
unavailable; the study runner records that as an operational failure, never as an
under-budget success. B has no `shell` equivalent; its bounded compute/Lean
wrappers are not arbitrary shell.

`--execute` is separate and additionally requires `MATH_BENCH_ALLOW_EXECUTE=1`.
That environment variable **does not bypass unsupported profiles**: the CLI has
no runtime-audit override: it runs this audit and stops before invoking OpenCode. The
exported execution seam is tested only with mock subprocess output and a mock
evaluator audit. A passing static-equivalent report can never authorize execution,
even with the opt-in. The execution seam requires a passing runtime-verified,
workspace/hash-bound exact inventory (including core and transport), verified
isolation and successful cleanup. Before enabling real execution, integrate a version-specific,
inference-free runtime inventory/isolation audit, a public corpus bridge for F,
and evaluator-controlled process containment and
authentication. Do not set an audit flag merely because the requested config
looks plausible.

The execution seam captures stdout/stderr, exit status and duration and emits an
**ungraded episode candidate**, not a study ledger entry. Its conservative parser
recognizes source-documented NDJSON `text` plus final `step_finish`
(`stop`/`end_turn`), grouped by final assistant `messageID`; this envelope has not
been confirmed against a real 2.0.29 inference stream. Other
formats, malformed JSON, error events, nonzero exits, missing terminal text or
non-JSON finals fail closed. CLI usage/cost fields remain unvalidated observations,
not budget verification. Formal candidates always have `verification: pending`
and no trusted receipt. Even an agent's plugin verifier output is not an
evaluator-controlled receipt.

## Files

- `run.mjs`, `lib.mjs`, `simulator.mjs`: isolated simulation and provenance.
- `analyze.mjs`: all-started metrics, missingness and family-paired bootstrap.
- `schemas/`: study, episode and verifier-receipt JSON schemas; local validation
  supports exactly their declared keyword subset and rejects unknown assertions.
- `profiles/`, `graders/`, `fixtures/`: preregistered conditions and deterministic checks.
- `exec/restricted.mjs`: prepare/execute separation and restricted Docker arguments.
- `tests/v2.test.mjs`: deterministic, inference-free validation.
- `adapters/opencode.mjs`, `tests/opencode.test.mjs`: dry-run preparation,
  runtime plugin-load audit, safe credential-home mode, and a mocked fail-closed
  execution boundary. The exploratory 90-episode real pilot is under `real/`.
- `study/run-study.mjs`, `tests/study.test.mjs`, `study/README.md`: real study
  runner, provider/model preflight, append-only ledger, evaluator grading and
  receipts; the 90-episode exploratory pilot ran through it.
- `real/pilot-2026-11-09-opencode-go-deepseek-v4.1-flash/`: 90-episode
  exploratory real-adapter artifact (manifest, starts, episodes, receipts,
  immutable final/event artifacts, reports); not confirmatory.
- `adapters/generic-tools.mjs`, `adapters/generic-runtime.mjs`,
  `tests/generic-tools.test.mjs`: exact four-tool B implementation and bounded,
  public-only retrieval / mocked subprocess tests.
- `simulated/simulated-pilot-receipt-v2.1/`: current schema-update simulation manifest, starts, 48 terminal
  episodes, separate artifacts, and JSON/Markdown analysis reports.
- `simulated/simulated-pilot-full-plugin/`: unchanged earlier 16-tool simulation snapshot.
- `simulated/simulated-pilot/`: unchanged earlier 15-tool simulation snapshot.
