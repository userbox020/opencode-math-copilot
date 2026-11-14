# Evaluation-local runtime: preparation, not certification

**Current admission: BLOCKED.** No safe independent checker or validated model-runner
integration is installed. This change neither builds an image nor runs models,
submitted Lean, or old solver-writable caches. The ordinary math plugin is unchanged.
Lean elaboration executes arbitrary code; keyword bans are not a sandbox. Even an
exit-zero compile is only a diagnostic, with `proof.status = not_assessed`.

## Local interfaces

* `bench/v3/arxivlean/lib/eval-sandbox.mjs` is the sole new compilation backend.
  Operators select a local `sha256:<64 hex>` image ID. Model-facing input is exactly
  `{code}`; images, paths, host files, arguments and policy are not model inputs.
  Source goes over bounded stdin to `/opt/lean/bin/lean --stdin`. There is no Lake
  update, host fallback, corpus/home/gold/socket mount, persistent volume or port.
  Each Docker-client invocation creates its own new temporary directory (0700) and
  exclusively writes an empty `config.json` (0600; Windows permissions remain subject
  to native ACL semantics). Fixed global `--config` and `--host` arguments precede
  the Docker verb. No actual user Docker config/credentials are read or copied;
  configured proxy injection at container creation is not inherited. Client env is
  limited to executable lookup PATH, Windows SystemRoot when needed, and temporary
  paths pointing to that owned directory—not inherited Docker context/auth/TLS,
  proxy, HOME or USERPROFILE settings. Default endpoint is
  `npipe:////./pipe/docker_engine` on Windows or `unix:///var/run/docker.sock` elsewhere.
  Operator-only factory options can pin an absolute Docker executable and a local
  Unix socket/local named-pipe endpoint; TCP, SSH and remote named pipes are rejected.
  These options are snapshotted and are not model-call arguments. Existing adapter
  and preflight calls use the fixed defaults without API changes. Client cleanup
  checks generated directory/file identity and removes only its own file and empty
  directory, never recursively deleting unexpected contents; uncertainty fails closed.
  This is client-configuration isolation, not validation of the daemon, executable,
  image or adversarial Lean execution. Admission remains unconditionally BLOCKED.
* Each call creates a uniquely named/labeled container, uses an unprivileged UID,
  read-only root, dropped capabilities, no-new-privileges, network none, fixed env,
  capped memory/swap/CPU/processes/files, and disposable `/work` and `/tmp` tmpfs.
  Source/output limits and wall time are host enforced. Cleanup checks ownership,
  removes that container only, and queries absence. Cleanup uncertainty fails closed.
  Ordinary cancellation via AbortSignal is handled; host crash/SIGKILL/daemon failure
  can still leave an orphan. An `unconfirmed` cleanup is never reported as success.
* `eval-tools.js` is a separate V2 adapter, not default-plugin configuration. Only
  `eval-restricted-on` / `eval-restricted-off` and `eval-restricted-v1` are accepted.
  Both expose exactly `lean_compile` with `codemode:false`. There is no
  `math_lean_check` alias or claim of incremental proof-verification capability.
  ON's optional `math_compute` is BLOCKED/unregistered: no pinned contained SymPy
  exists. These conditions currently have identical tools, not a useful toolkit
  efficacy comparison. Full/minimal/verify selectors and inherited selection fail.
  This adapter alone does **not** remove other OpenCode tools/plugins: final session
  inventory, explicit execute/host-tool denial and gold separation remain gates.

Run a fresh, no-model preflight (nonzero exit 2 means BLOCKED):

```powershell
node bench/v3/arxivlean/preflight-arxivlean.mjs --out C:\path\new-readiness.json
# Only after preparing and reviewing a purpose-built image, never the corpus image:
node bench/v3/arxivlean/preflight-arxivlean.mjs --image sha256:<local-image-id> --run-controls --out C:\path\another-new-readiness.json
```

The receipt hashes exact implementation sources, selected configuration, task file,
image ID and policy, and records timestamp and individual controls. Registration
probes use the real adapter path, but are not a final model-session inventory. Safe
synthetic controls check positive/negative Init compilation and read-only-root write
failure, never research-task solvability. They cannot satisfy trusted proof-checker
positive/negative controls. Image labels and inspection identify a runtime, not
authenticated provenance. Test injection is labeled test-only; neither mock success,
caller booleans, fresh hashes nor a handwritten `ready` receipt can authorize a run.

The legacy ArXivLean runner first preserves its authorization error, then rejects
every authorized execution before task loading, output creation or model spawn.
Use the v4 real-use dry-run or this preflight for preparation; neither is admission.
The archived grader never executes submitted Lean. Timeout, malformed DSML and
structural diagnostics are retained; unknown tasks/configuration are unverified.
Otherwise admissible code is unverified because the independent checker is absent.
`Your solution is okay!`, `COMPARATOR_RC=0`, duplicated markers and process failures
can never verify anything. Generate diagnostics into a **new** directory:

```powershell
node bench/v3/arxivlean/grade-arxivlean.mjs --out C:\path\archive --report-out C:\path\fresh-diagnostics
```

## Runtime build (g004)

This operator-authorized build step supersedes the earlier recipe-only runtime
status above; it does **not** unlock evaluation admission or certify proofs.
`scripts/build-eval-runtime.ps1` builds an actual fresh local image and runs only
own-written synthetic compilation/boundary controls. It never invokes models,
saved submissions, corpus mounts or existing named volumes.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-eval-runtime.ps1
# A retry can reuse only the recorded immutable public base image, not old Lean caches:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-eval-runtime.ps1 -BaseImage ubuntu@sha256:<recorded-digest>
```

The explicitly accepted original toolchain input is local image
`sha256:d65d1b70ed3503fb4f0b1caf72474ed05eb54fe7a7560e59488341d3f83f65ed`.
It predates solver mutations and has no registry digest. A unique evaluation-owned
local alias is checked against that ID before/after the build; nothing is published.
Only `/root/.elan/toolchains/leanprover--lean4---v4.34.1` is copied to `/opt/lean`.
An inventory of original toolchain file hashes is compared with the copied inventory.
Neither old `.lake` directories nor solver-writable overlays/volumes are inputs.

The initial actual input capture recorded Ubuntu linux/amd64 image
`sha256:d9b8c34d61a9b9a3c44cab883d7d2f2619d674966ab520186f799cf32e3e0377`, pinned as
`ubuntu@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852`.
The original toolchain inventory SHA256 was
`a73f9239936ce77d625c3e9170c36029664ee431dcc8987ab1c0db1cc6d8c34a`.
The first attempt stopped before building because isolated client configuration hid
Buildx; its evidence remains in
`eval-runtime-g004-7318ca3cae004458861f5bc07752960d/build-receipt.json` beneath the
approved temporary root. The builder now copies only the installed Docker sibling
`docker-buildx.exe` into its own temporary plugin directory and records its hash,
without consulting user plugin/config directories.

The builder pulls public Ubuntu 24.04 for linux/amd64 once and pins its recorded
repository digest. Every Docker call has a new empty owned configuration, fixed
`npipe:////./pipe/docker_engine`, an absolute executable and minimal native environment;
actual user Docker config, proxies, auth and contexts are not read/copied/inherited.
The build context is an explicit single-file Dockerfile allowlist, never the repository.
`--no-cache` excludes prior build-cache reuse. No existing images/cache/volumes are
pruned. A preflight and periodic host disk guard stop work below 15 GiB free.

Build artifacts, command records, logs and the final `build-receipt.json` are retained
in a fresh `C:\Users\MiPC\AppData\Local\Temp\opencode\eval-runtime-g004-*` directory.
Receipts include the source Dockerfile/script/backend hashes, immutable base and
original/final image identities, platform, toolchain/source/artifact inventories,
dependency lock, apt/Python/SymPy versions, actual container inspection, compile
control results and disk measurements. Failed attempts retain their logs too.

The fresh downstream project pins Mathlib
`d13f23b723b8a846827a245b89c10fc7d3f11612` / Lean 4.34.1. The Dockerfile checks the
exact nine-package lock and checkout HEADs. Build-only `lake update` uses
`MATHLIB_NO_CACHE_ON_UPDATE=1`; cache endpoint overrides are unset. A new
`MATHLIB_CACHE_DIR` receives only `lake exe cache get! --cache-from=master Mathlib`.
Missing master artifacts are a build finding, not permission to reuse old caches or
switch to forks. Library directories are copied in full, including companion artifacts.
The final runtime also contains apt Python 3/SymPy for the same future contained worker
in both conditions; installing the libraries does not register or validate that worker.
Its environment remains exactly compatible with the current compiler policy.

Mathlib cache keys hash build **inputs**, not authenticated downloaded bytes. Separate
downloaded-byte SHA256 inventories record the fetched material, not its authenticity.
The original compiler, public base/apt repositories, Mathlib source and master cache
producers are explicitly trusted for this local developer study. This is not a
cryptographically authenticated upstream or hermetic/reproducible-build claim.
Successful controls demonstrate only the particular runtime observations recorded;
compilation is not proof verification, and independent checker/admission work remains.

## Why adversarial proof certification remains blocked

The pinned Comparator build invokes Landrun with `--best-effort`. It needs reviewed
AF_UNIX protection; Docker `--network none` is **not** an AF_UNIX blockade. A container
reduces exposure but is not evidence that arbitrary elaboration cannot forge a
checker result. There is no documented exported-NDJSON-only Comparator CLI; do not
invent one or accept solver-generated serialized proof objects as trusted.

A future reviewed checker must separate untrusted elaboration from the trusted
target/axiom validation and its authenticated result channel; validate wrong targets,
extra axioms, forged/duplicate output and process errors independently. It must use
immutable reviewed dependencies with no shared writable state or gold visibility.
Actual final tool manifests/parity, pipeline gold separation, trusted image provenance
and independent checker positive/negative controls are mandatory. Until then the
readiness result is BLOCKED, not a pass with skipped controls.
