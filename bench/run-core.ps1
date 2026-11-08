$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$benchArgs = @(
    'run', 'bench', '--',
    '--models', 'opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash,opencode-go/gpt-6-luna',
    '--problems', 'bench/problems-core.json',
    '--repeats', '3',
    '--standalone', '--json', '--md'
) + $args

Push-Location -LiteralPath $repoRoot
try {
    Write-Host ('npm ' + (($benchArgs | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ' '))
    & npm @benchArgs
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $exitCode
