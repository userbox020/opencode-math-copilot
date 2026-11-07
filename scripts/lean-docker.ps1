#requires -Version 5.1
param(
    [switch]$SkipBuild,
    [string]$Target = "OAI.Analysis",
    [string]$Image = "opencode-math-lean",
    [string]$Volume = "opencode-math-lean"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker was not found on PATH. Start Docker Desktop and retry."
}

Push-Location $repo
try {
    Write-Host "Building $Image..."
    docker build -f docker/lean.Dockerfile -t $Image .
    if ($LASTEXITCODE -ne 0) { throw "docker build failed with exit code $LASTEXITCODE" }

    docker volume create $Volume | Out-Null
    $skip = if ($SkipBuild) { "1" } else { "0" }
    Write-Host "Running Lean verification in $Image (volume: $Volume)..."
    docker run --rm -it -v "${Volume}:/work" -e "TARGET=$Target" -e "SKIP_BUILD=$skip" $Image verify-lean.sh
    if ($LASTEXITCODE -ne 0) { throw "Lean verification failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
