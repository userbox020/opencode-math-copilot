# Troubleshooting

## Plugin installation

There are two supported installs:

- **Project-local**: copy `index.js`, `.opencode/plugins/math-toolkit.js`, and `.opencode/plugins/math-toolkit/` into a project. OpenCode discovers it.
- **Global Git spec**: `opencode.cmd plugin add github:userbox020/opencode-math-copilot#v0.4.0` (replace the tag with the current release).

After changing the install, restart OpenCode or reload the session and check:

```powershell
opencode.cmd plugin list
```

### Duplicate `math-toolkit` IDs

Do not install the same workspace both project-locally and globally. OpenCode reports:

```text
Duplicate plugin ID: math-toolkit
```

Keep one installation. If the local entry is not needed, disable or remove `.opencode/plugins/math-toolkit.js` in that workspace.

### `NpmInstallFailedError` or “Plugin failed to load” during update

OpenCode’s plugin cache can retain a broken Git/npm checkout. Symptoms:

```text
Failed to update Server plugin "math-toolkit": NpmInstallFailedError
Plugin failed to load
```

Recovery:

1. Fully quit OpenCode.
2. Back up and remove the stale cache directory:
   `C:\Users\<user>\.cache\opencode\npm\git-opencode-math-copilot-*`
   (`~/.cache/opencode/npm/...` on Linux/macOS).
3. Re-add the tag from a clean cache:
   ```powershell
   opencode.cmd plugin add github:userbox020/opencode-math-copilot#v0.4.0
   opencode.cmd plugin list
   ```
4. Do not pin the global config to a tag while the cache is stale; OpenCode may list the plugin as failed and remove the live tools.

If the updater still fails, install the package directly with npm and verify it first:

```powershell
npm install github:userbox020/opencode-math-copilot#v0.4.0
```

## Corpus and indexes

`math_search` works from the bundled index. Most other tools need a clone of `openai/math`:

```powershell
git clone --depth 1 https://github.com/openai/math math
```

Refresh the indexes after corpus changes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-indexes.ps1
```

The refresh workflow produces artifacts for review; it does not commit or push automatically. Review the counts and sizes before committing generated indexes.

## Docker Lean

Docker is the recommended path on Windows because the pinned AINTLIB path `2026-07-16T07:39:08Z` is invalid on NTFS. Native Windows Lean builds can fail before compilation starts.

```powershell
docker build -f docker/lean.Dockerfile -t opencode-math-lean .
docker volume create opencode-math-lean
docker run --rm -v opencode-math-lean:/work opencode-math-lean verify-lean.sh
```

Set `MATH_TOOLKIT_LEAN_IMAGE`, `MATH_TOOLKIT_LEAN_VOLUME`, `MATH_TOOLKIT_COMPARATOR_IMAGE`, and `MATH_TOOLKIT_COMPARATOR_VOLUME` to override names.

## Comparator

```powershell
docker build -f docker/comparator.Dockerfile -t opencode-math-comparator .
docker volume create opencode-comparator-tools
docker run --rm -v opencode-math-lean:/work -v opencode-comparator-tools:/opt `
  -w /work/math/lean -e CHALLENGE=ComparatorChallenges/QuasiRiemannHypothesis.json `
  opencode-math-comparator verify-comparator.sh
```

The first run of a large challenge builds its solution-module closure and can take hours; later runs reuse `/work/math/lean/.lake` and are much faster. The image applies `docker/patches/rellich-kondrachov-lean4341.patch` once per volume; do not silently change corpus pins. A failed export or kernel check is not a pass.

## Benchmarks

```powershell
npm run bench -- --models opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash,opencode-go/gpt-6-luna `
  --problems bench/problems.json --repeats 3 --standalone --json --md
```

The benchmark harness does not run inference in CI. Results are heuristic keyword scores; see `bench/RESULTS.md` for the committed runs and caveats. The `without plugin` condition still has global OpenCode plugins; it excludes only `math-toolkit` via the temporary project config.

## Verification reports

- `docs/verification.md` — Docker Lean/Comparator evidence.
- `docs/index-refresh.md` — index refresh and artifacts.
- `docs/verification-automation.md` — self-hosted challenge verification.
- `SECURITY.md` — token/secret handling and reporting.

## Security

Never commit or paste npm tokens. Revoke exposed tokens immediately at:

`https://www.npmjs.com/settings/userbox020/tokens`

The package is private and distributed by Git spec/project-local install; no npm publishing is required.
