#requires -Version 5.1
param(
    [switch]$Build,
    [string]$Target = "OAI.Analysis"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$mathLean = Join-Path $repo "math\lean"
$elan = Join-Path $env:USERPROFILE ".elan\bin"

if (-not (Test-Path -LiteralPath $mathLean)) {
    throw "math/lean was not found. Clone https://github.com/openai/math into $repo\math first."
}
if (Test-Path -LiteralPath $elan) {
    $env:Path = "$elan;$env:Path"
}

# The pinned math/lean patches are stored with LF on the source side. A Windows
# clone made with core.autocrlf=true gives them CRLF and every patch fails.
$patches = Join-Path $mathLean "patches"
if (Test-Path -LiteralPath $patches) {
    $changed = 0
    Get-ChildItem -LiteralPath $patches -Filter "*.patch" | ForEach-Object {
        $text = [IO.File]::ReadAllText($_.FullName)
        if ($text -match "`r`n") {
            [IO.File]::WriteAllText($_.FullName, ($text -replace "`r`n", "`n"))
            $changed++
        }
    }
    Write-Host "Normalized $changed patch files to LF."
}

# Make every child git clone/checkout use LF, including Lake dependency clones.
$env:GIT_CONFIG_COUNT = "1"
$env:GIT_CONFIG_KEY_0 = "core.autocrlf"
$env:GIT_CONFIG_VALUE_0 = "false"

if (-not (Get-Command lake -ErrorAction SilentlyContinue)) {
    throw "lake was not found. Install elan from https://github.com/leanprover/elan and reopen the shell."
}

Push-Location $mathLean
try {
    Write-Host "Fetching Mathlib cache (several GB; requires network and free disk)..."
    & lake exe cache get
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Mathlib cache failed. Native Windows can fail on an NTFS-invalid path in the pinned dependency set; use WSL/Linux for a full build."
        exit $LASTEXITCODE
    }
    if ($Build) {
        Write-Host "Building $Target..."
        & lake build $Target
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Build failed. See docs/comparator-wsl.md and the root README for native-Windows limitations."
            exit $LASTEXITCODE
        }
    }
} finally {
    Pop-Location
}

Write-Host "Lean setup complete. Use math_status / math_lean_check from OpenCode."
