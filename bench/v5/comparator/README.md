# Comparator reproduction integration pack

**Retrieval-assisted reproduction, not fresh proof discovery or an accuracy
benchmark.** The runner validates existing corpus solution modules. It does not
grade a newly generated/model-supplied proof. No model calls are made.

## Pack

`tasks.json` contains eight configs from the local `openai/math` corpus.
Every JSON config is schema-checked before selection. Explicit statement or
description length is preferred, with SHA-256 of the filename as tie-breaker.
The current 418 configs contain no statement/description metadata, so selection
uses filename hashes exclusively; no claim of mathematical simplicity is made.
The fallback statement identifies declarations, not their full Lean types.
No solution sources or proof bodies are read or placed in prompts.
Nonempty config prompt fields are refused entirely: arbitrary term proofs cannot
be reliably recognized lexically. Proof-like statement/description text is also
conservatively rejected (this lexical guard is not a general proof detector).
Pack prompts must exactly match regeneration.
IDs, config bytes, grading bindings, and paths are revalidated before execution.
License metadata is deliberately `verify`: redistribution rights need checking.

Generate once (refuses to overwrite `tasks.json`):

```powershell
node bench/v5/comparator/pack.mjs --corpus C:\_Work\__OPENAI_MATH\math
```

## Operator-only execution

Use a pre-provisioned Linux/WSL checkout, matching Lean toolchain and cached
dependencies, with `lake`, `comparator`, `landrun`, `lean4export`, and `unshare`
on PATH. User/network namespaces must be permitted. No installation, fetch,
Docker image pull, package update, or toolchain download is performed by this
adapter. The execution network namespace blocks network access. Native Windows
is reported unavailable. The existing Docker setup wrapper is intentionally not
invoked because it can fetch repositories and modify tool installations.

```sh
node bench/v5/comparator/run.mjs \
  --corpus /absolute/math --out /absolute/outside-repo/fresh-results \
  --execute --limit 2 --timeout 600
```

Without `--execute`, returns `not_run` without executing or creating output.
`--pack` optionally selects another pack. Timeout is in seconds (1–1800;
default 600). Limit is 1–8. Output must be absolute, outside this repository and
the corpus, and new or empty; symlink/junction aliases are resolved.

The maintained command is `lake env comparator <config>` from `math/lean`.
The actual Comparator CLI exit status is its acceptance protocol: zero means
accepted; nonzero means rejected. This rule is **not** applied to compilation,
build commands, printed success strings, or the setup wrapper. Setup/namespace/
spawn failures are unavailable; bounded expiry is timeout. Comparator itself
can report dependency/build failures via a nonzero exit; `rejected` means the
Comparator invocation did not accept, not a claim that the theorem is false.
Results capture stdout/stderr (8 MiB combined cap), exact config hashes before
and after, duration, and process-group cleanup. Each challenge completes before
the next begins. The parent and remaining descendants are killed on timeout.

Only trusted local corpus configs should be executed. Lean elaboration and
Comparator may execute code and create build artifacts in the corpus; the
network namespace is **not** a complete hostile-code sandbox. Config hashes do
not bind all transitively imported Lean sources or the toolchain.

## Validation and local smoke record

```sh
node --test bench/v5/comparator/tests/comparator-pack.test.mjs
node --check bench/v5/comparator/pack.mjs
node --check bench/v5/comparator/run.mjs
```

Tests use synthetic configs and fake transport only. Temporary fixtures are
created and removed under `tests/`; there are no real Comparator tests by
default.

Smoke status: **not_run**. No challenge was executed. `lake.exe` and
`docker.exe` were found, but `comparator`, `landrun`, and `lean4export` were not
on PATH. Bounded Docker image/volume availability probes failed:

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running:
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
```

No `results.json` claiming a real execution was created.
