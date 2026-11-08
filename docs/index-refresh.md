# Refresh indexes

Refresh from a source checkout of this repository with Node.js 24, npm, and Git on PATH. The corpus lives in the gitignored `math/` directory; do not commit it.

## Manual refresh

Install dependencies once with `npm ci`, then run from PowerShell:

```powershell
.\scripts\refresh-indexes.ps1
```

The script resolves the repository from its own location, shallow-clones `https://github.com/openai/math` if `math/` is missing, or runs `git pull --ff-only` in an existing Git checkout. It does not reset or discard local changes. If updating fails, resolve the reported checkout or network problem manually and retry.

It runs `npm run index` and `npm run index:lean`, then prints both output sizes and `git status --short`. The Lean index requires `math/lean`. Ripgrep (`rg`) is recommended for discovery; without it, the builder's bounded Node fallback is slower and aborts if its limits are reached rather than writing a partial index. No Lean build is needed.

## Weekly workflow

The **Refresh indexes** workflow (`.github/workflows/refresh-index.yml`) runs every Sunday at **03:00 UTC**, or manually via **Actions → Refresh indexes → Run workflow**. It uses Ubuntu, Node 24, and ripgrep with a fresh shallow corpus clone. Runs are serialized and have a 60-minute timeout.

After building both indexes, the workflow logs `git diff --stat` and `git status --short` and uploads a **refreshed-indexes** artifact containing `math-index.json` and `lean-index.json.gz`. Download the artifact from the completed run and extract its files into `.opencode/plugins/math-toolkit/data/` in your source checkout. It requires no npm authentication and never commits or pushes.

## Review and commit intentionally

The generated indexes are large: approximately **9 MB** for the corpus JSON and **22 MB** for the compressed Lean index. Review builder logs, counts, file sizes, and changes before deliberately committing them. A refresh updates generation timestamps even when corpus content is unchanged.

```powershell
git diff --stat -- .opencode/plugins/math-toolkit/data/math-index.json .opencode/plugins/math-toolkit/data/lean-index.json.gz
git status --short
# Only after review:
git add -- .opencode/plugins/math-toolkit/data/math-index.json .opencode/plugins/math-toolkit/data/lean-index.json.gz
git commit -m "Refresh corpus and Lean indexes"
```

Reload OpenCode (`opencode.cmd reload`) after replacing local indexes. Neither the script nor the workflow commits, pushes, or publishes a package automatically.
