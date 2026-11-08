#requires -Version 5.1
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$math = Join-Path $repo "math"

foreach ($tool in @("node", "git")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool was not found on PATH. Install Node.js 24 and Git, then reopen the shell."
    }
}
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) { throw "npm was not found on PATH. Install Node.js 24 with npm, then reopen the shell." }

Push-Location $repo
try {
    if (-not (Test-Path -LiteralPath $math)) {
        & git clone --depth 1 https://github.com/openai/math $math
        if ($LASTEXITCODE -ne 0) { throw "Cloning openai/math failed. Check network access and the math/ checkout before retrying." }
    } else {
        # Checking .git prevents Git from accepting the parent plugin repository.
        if (-not (Test-Path -LiteralPath (Join-Path $math ".git"))) {
            throw "math/ exists but is not a Git checkout. Move it aside manually or supply a clone of openai/math."
        }
        $insideWorkTree = & git -C $math rev-parse --is-inside-work-tree
        if ($LASTEXITCODE -ne 0 -or $insideWorkTree -ne "true") {
            throw "math/ is not a usable Git working tree. Repair the checkout before retrying."
        }
        & git -C $math pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            throw "Updating math/ failed. Resolve local changes, branch divergence, or network issues manually; this script does not reset or discard changes."
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $math "lean") -PathType Container)) {
        throw "math/lean is unavailable. A complete openai/math checkout is required for the Lean declaration index."
    }

    & $npm.Source run index
    if ($LASTEXITCODE -ne 0) { throw "Corpus index build failed (npm run index)." }
    & $npm.Source run index:lean
    if ($LASTEXITCODE -ne 0) { throw "Lean declaration index build failed (npm run index:lean)." }

    foreach ($name in @("math-index.json", "lean-index.json.gz")) {
        $file = Get-Item -LiteralPath (Join-Path $repo ".opencode/plugins/math-toolkit/data/$name")
        Write-Host ("{0}: {1:N0} bytes ({2:N2} MiB)" -f $name, $file.Length, ($file.Length / 1MB))
    }
    & git -C $repo status --short
    if ($LASTEXITCODE -ne 0) { throw "Could not read repository status for review." }
    Write-Host "Review the generated indexes before committing. Nothing was committed or pushed."
} finally {
    Pop-Location
}
