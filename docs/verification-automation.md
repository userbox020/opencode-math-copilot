# Comparator verification automation

`scripts/verify-challenges.ps1` runs sorted Comparator JSON challenges sequentially, with a timeout per challenge. It never commits or pushes. A pass requires **both exit code 0 and `COMPARATOR_DOCKER_OK`**; stderr output alone is not a failure.

## Prerequisites and caching

Use Docker Desktop with Linux containers on Windows, or Docker Engine on Linux. The host needs Windows PowerShell 5.1 or PowerShell 7 (`pwsh`; required on Linux), plus `math/lean/ComparatorChallenges` for enumeration. If the local corpus is absent, run `git clone --depth 1 https://github.com/openai/math math` from the repository root. Keep the host challenge list aligned with the corpus in the Docker volume: names are selected locally, but verification uses the volume's JSONs and sources.

Run these identical Docker commands from the repository root on Windows or Linux:

```text
docker build -f docker/lean.Dockerfile -t opencode-math-lean .
docker build -f docker/comparator.Dockerfile -t opencode-math-comparator .
docker volume create opencode-math-lean
docker volume create opencode-comparator-tools
docker run --rm -v opencode-math-lean:/work -e SKIP_BUILD=1 opencode-math-lean verify-lean.sh
```

Initialization clones the corpus, retrieves dependencies/cache, and runs a Lean smoke check without the full `OAI.Analysis` build. Merely creating the volume is insufficient. `opencode-math-lean` is mounted at `/work`; `opencode-comparator-tools` is mounted at `/opt`. Keep both volumes to reuse the corpus, tool binaries, and solution build products. Existing corpus checkouts are reused, not automatically updated; inspect/update them deliberately rather than silently changing pins.

**Runtime warning:** all 418 current configurations can take many hours, potentially much longer than a CI job. The first challenge builds an expensive solution dependency closure and can itself take hours. Later runs reuse the cache. The local default timeout is 1,800 seconds per challenge; increase it for cold builds. A timeout is a failure, not evidence against the mathematics. Avoid simultaneous local/CI verification against these same writable volumes.

`verify-comparator.sh` applies the checked-in **eleven-module rellich-kondrachov compatibility patch** idempotently. Automation does not replace it or silently change corpus dependency/toolchain pins. See [verification.md](verification.md) for the existing verification evidence; this automation does not imply all challenges have passed.

## Windows commands

From the repository root:

```powershell
# Preview only: no Docker calls, prerequisite probes, or report writes.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-challenges.ps1 -DryRun -Limit 2
# Verify one challenge (name, Name.json, or a path is accepted).
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-challenges.ps1 -Challenge QuasiRiemannHypothesis -TimeoutSeconds 18000
# Small sorted batch.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-challenges.ps1 -Limit 2 -TimeoutSeconds 18000
# All configurations: intentionally opt in; this may take many hours.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-challenges.ps1 -Limit 0 -TimeoutSeconds 18000
```

PowerShell 7 users can substitute `pwsh` for `powershell`.

## Linux / pwsh commands

From the repository root:

```bash
pwsh -NoProfile -File scripts/verify-challenges.ps1 -DryRun -Limit 2
pwsh -NoProfile -File scripts/verify-challenges.ps1 -Challenge ComparatorChallenges/QuasiRiemannHypothesis.json -TimeoutSeconds 18000
pwsh -NoProfile -File scripts/verify-challenges.ps1 -Limit 2 -TimeoutSeconds 18000
# Full batch, only when explicitly desired:
pwsh -NoProfile -File scripts/verify-challenges.ps1 -Limit 0 -TimeoutSeconds 18000
```

`-Limit 0` means all matching challenges, and a positive limit caps the selection after `-Challenge` filtering. A path selects its filename from the required local challenge directory; it does not run arbitrary external JSONs. Relative `-OutDir` paths resolve from the repository root, not the caller's working directory.

## Reports and failures

The default output is `artifacts/challenge-verification` (override with `-OutDir`). Each run overwrites `report.json`, `report.md`, and logs for selected challenges; logs from earlier, unselected challenges can remain. Use a fresh output directory for isolated runs.

- `report.json`: UTC timestamps, total elapsed time, counts, and per-selected-challenge status, exit code, duration, timeout flag, failure reason, and log filename.
- `report.md`: human-readable counts and result table.
- `<name>.log`: command, stdout, stderr, and result. Streams are grouped, not interleaved chronologically. Separate `.stdout.log` and `.stderr.log` files are retained, including partial output while running.
- Skipped means **not selected** by the challenge/limit filters, not verified. Failed challenges do not prevent later selections from running. The script exits nonzero if any selected challenge fails; missing prerequisites fail immediately.

Timed-out containers receive `docker rm -f` using a unique per-run name, so the Docker client cannot leave expensive computation running unnoticed. Cleanup errors are included in the failure reason; inspect the named container manually if Docker becomes unavailable. Interruptions/runner termination may leave partial logs without final reports and can require manual container cleanup. No resumable run database is maintained; cached build products still speed up retries.

## Weekly / manual GitHub Actions

`.github/workflows/verify-docker.yml` requires a **self-hosted Linux x64 runner**, labeled `self-hosted`, `linux`, `x64`, with Docker daemon access and `pwsh` on PATH. GitHub-hosted runners are too small for the corpus/build closure. Provision substantial persistent disk/RAM and allow up to six hours per job; exact requirements depend on the selected challenge. Only run this workflow on trusted code/inputs; Docker access is privileged.

The workflow checks prerequisites, builds both images, creates/reuses the two volumes, initializes the corpus with `SKIP_BUILD=1`, copies the volume's challenge configurations for local enumeration, invokes the PowerShell batch script, and uploads `artifacts/challenge-verification` even after verification failures. It does not require npm authentication. Concurrency prevents overlapping instances of this workflow from mutating the shared caches; it does not lock out unrelated local jobs.

Weekly runs select only `QuasiRiemannHypothesis`, the previously verified challenge, with a five-hour per-challenge timeout inside the six-hour job limit. Manual dispatch accepts `challenge` and `limit` (defaults: `QuasiRiemannHypothesis`, `1`). Clear `challenge` and set a positive `limit` for a bounded sorted batch; clear `challenge` and set `limit` to `0` only to deliberately request all configurations. Large batches can exceed the job limit and leave only partial logs.

All 418 are **not run on every push**: cold solution builds are too expensive, and this workflow is weekly/manual only. Success on the default challenge is not a claim that the entire corpus is verified.
