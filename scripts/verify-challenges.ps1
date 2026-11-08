#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)][int]$Limit = 0,
    [string]$Challenge,
    [ValidateRange(1, 2147483)][int]$TimeoutSeconds = 1800,
    [string]$OutDir = "artifacts/challenge-verification",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
# Native stderr (including Docker progress) is not itself a failure.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$repo = Split-Path -Parent $PSScriptRoot
$challengeDir = Join-Path $repo "math/lean/ComparatorChallenges"
if (-not (Test-Path -LiteralPath $challengeDir -PathType Container)) {
    throw "Missing $challengeDir. Clone openai/math into math/ or copy ComparatorChallenges from the initialized Docker volume; see docs/verification-automation.md."
}

$all = @(Get-ChildItem -LiteralPath $challengeDir -Filter "*.json" -File | Sort-Object Name)
$selected = $all
if ($Challenge) {
    # Accept a name, a ComparatorChallenges-relative path, or an absolute path.
    $name = ($Challenge -replace '\\', '/').Split('/')[-1]
    if (-not $name.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) { $name += '.json' }
    $selected = @($all | Where-Object { $_.Name -eq $name })
    if ($selected.Count -ne 1) { throw "Challenge '$Challenge' does not identify one JSON in $challengeDir." }
}
if ($Limit -gt 0) { $selected = @($selected | Select-Object -First $Limit) }
if ($selected.Count -eq 0) { throw "No challenge JSON files found in $challengeDir." }

Write-Warning "A full run may take many hours. The first challenge builds an expensive solution dependency closure; later runs reuse the Docker volumes. Per-challenge timeout: $TimeoutSeconds seconds."
Write-Host "Challenges: $($all.Count) available, $($selected.Count) selected, $($all.Count - $selected.Count) skipped (not selected)."

function Get-RunArguments([string]$Name, [string]$ContainerName) {
    @('run', '--rm', '--name', $ContainerName,
        '-v', 'opencode-math-lean:/work', '-v', 'opencode-comparator-tools:/opt',
        '-w', '/work/math/lean', '-e', "CHALLENGE=ComparatorChallenges/$Name",
        'opencode-math-comparator', 'verify-comparator.sh')
}

if ($DryRun) {
    foreach ($file in $selected) {
        $arguments = Get-RunArguments $file.Name 'challenge-verification-<unique-id>'
        Write-Host ('docker ' + (($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '))
    }
    Write-Host "Dry run only: no Docker commands or prerequisite probes executed; no reports written."
    return
}

$docker = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $docker) { throw "Docker is not on PATH. Install/start Docker Desktop (Linux containers) or Docker Engine, then reopen the shell." }
function Test-DockerResource([string[]]$Arguments) {
    # Windows PowerShell wraps native stderr in ErrorRecords; use the exit code.
    $ErrorActionPreference = 'Continue'
    & $docker.Source @Arguments 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}
if (-not (Test-DockerResource @('info'))) {
    throw "Docker Engine is unavailable. Start Docker and ensure this account can access its daemon (docker info)."
}
if (-not (Test-DockerResource @('image', 'inspect', 'opencode-math-comparator'))) {
    throw "Missing image opencode-math-comparator. From the repo root run: docker build -f docker/lean.Dockerfile -t opencode-math-lean . ; docker build -f docker/comparator.Dockerfile -t opencode-math-comparator ."
}
if (-not (Test-DockerResource @('volume', 'inspect', 'opencode-math-lean'))) {
    throw "Missing volume opencode-math-lean. Run: docker volume create opencode-math-lean ; docker run --rm -v opencode-math-lean:/work -e SKIP_BUILD=1 opencode-math-lean verify-lean.sh"
}

if (-not [IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $repo $OutDir }
$null = New-Item -ItemType Directory -Path $OutDir -Force
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$started = [DateTime]::UtcNow
$results = @()
foreach ($file in $selected) {
    $containerName = 'challenge-verification-' + [Guid]::NewGuid().ToString('N')
    $arguments = Get-RunArguments $file.Name $containerName
    # Start-Process joins ArgumentList; quote each argument to preserve spaces.
    if ($file.Name.Contains('"')) { throw "Unsupported quote in challenge filename: $($file.Name)" }
    $argumentLine = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $log = Join-Path $OutDir ($file.BaseName + '.log')
    $stdout = Join-Path $OutDir ($file.BaseName + '.stdout.log')
    $stderr = Join-Path $OutDir ($file.BaseName + '.stderr.log')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $exitCode = $null
    $timedOut = $false
    $reason = $null
    $marker = $false
    Write-Host "Running $($file.Name)..."
    try {
        $process = Start-Process -FilePath $docker.Source -ArgumentList $argumentLine -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        # Retain the handle so ExitCode remains available after process completion.
        $null = $process.Handle
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            $reason = "Timed out after $TimeoutSeconds seconds."
        } else {
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
    } catch {
        $reason = "Could not execute Docker: $($_.Exception.Message)"
    } finally {
        if ($process -and ($timedOut -or -not $process.HasExited)) {
            # Killing just the Docker client leaves its container running. Remove
            # only this uniquely named container, never other users' containers.
            $cleanup = $null
            try {
                $cleanup = Start-Process -FilePath $docker.Source -ArgumentList "rm -f $containerName" -NoNewWindow -PassThru -RedirectStandardOutput "$log.cleanup.stdout" -RedirectStandardError "$log.cleanup.stderr"
                $null = $cleanup.Handle
                if (-not $cleanup.WaitForExit(30000)) {
                    $cleanup.Kill()
                    $reason += " Container cleanup timed out; run docker rm -f $containerName manually."
                } elseif ($cleanup.ExitCode -ne 0) {
                    $reason += " Container cleanup failed; check docker ps -a for $containerName."
                }
            } catch {
                $reason += " Container cleanup error: $($_.Exception.Message); run docker rm -f $containerName manually."
            } finally {
                if ($cleanup) { $cleanup.Dispose() }
                if (-not $process.HasExited) { $process.Kill() }
                $process.WaitForExit()
                $exitCode = $process.ExitCode
            }
        }
        $clock.Stop()
        if ($process) { $process.Dispose() }
    }
    Set-Content -LiteralPath $log -Encoding UTF8 -Value "Challenge: $($file.Name)`nCommand: docker $argumentLine`n=== stdout ==="
    if (Test-Path -LiteralPath $stdout) {
        $marker = [bool](Select-String -LiteralPath $stdout -Pattern '^COMPARATOR_DOCKER_OK\s*$' -Quiet)
        Get-Content -LiteralPath $stdout | Add-Content -LiteralPath $log -Encoding UTF8
    }
    Add-Content -LiteralPath $log -Encoding UTF8 -Value '=== stderr ==='
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr | Add-Content -LiteralPath $log -Encoding UTF8 }
    $passed = -not $reason -and $exitCode -eq 0 -and $marker
    if (-not $passed -and -not $reason) {
        if ($exitCode -ne 0) { $reason = "Docker exited with code $exitCode; see log." }
        else { $reason = 'Exit code 0 but COMPARATOR_DOCKER_OK was missing.' }
    }
    $result = [pscustomobject]@{
        challenge = $file.Name
        status = $(if ($passed) { 'passed' } else { 'failed' })
        passed = [bool]$passed
        exitCode = $exitCode
        durationSeconds = [Math]::Round($clock.Elapsed.TotalSeconds, 3)
        timedOut = $timedOut
        failureReason = $reason
        log = $file.BaseName + '.log'
    }
    $results += $result
    Add-Content -LiteralPath $log -Encoding UTF8 -Value "=== result ===`n$($result | ConvertTo-Json)"
    Write-Host "$($file.Name): $($result.status) ($($result.durationSeconds)s) $reason"
}

$passedCount = @($results | Where-Object passed).Count
$report = [ordered]@{
    startedAt = $started.ToString('o')
    finishedAt = [DateTime]::UtcNow.ToString('o')
    durationSeconds = [Math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 3)
    timeoutSeconds = $TimeoutSeconds
    total = $all.Count
    selected = $selected.Count
    passed = $passedCount
    failed = $results.Count - $passedCount
    skipped = $all.Count - $selected.Count
    skippedReason = 'Not selected by Challenge/Limit (not a verification result).'
    results = @($results)
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutDir 'report.json') -Encoding UTF8
$markdown = @(
    '# Comparator challenge verification', '',
    "Passed: $($report.passed); failed: $($report.failed); skipped (not selected): $($report.skipped).",
    "Total duration: $($report.durationSeconds)s; timeout per challenge: ${TimeoutSeconds}s.", '',
    '| Challenge | Result | Exit code | Duration (s) | Failure reason |',
    '| --- | --- | --- | --- | --- |'
)
foreach ($result in $results) {
    $safeReason = ([string]$result.failureReason) -replace '\|', '\|' -replace '[\r\n]+', ' '
    $markdown += "| $($result.challenge) | $($result.status) | $($result.exitCode) | $($result.durationSeconds) | $safeReason |"
}
$markdown | Set-Content -LiteralPath (Join-Path $OutDir 'report.md') -Encoding UTF8
Write-Host "Reports: $OutDir (passed=$($report.passed), failed=$($report.failed), skipped=$($report.skipped)). Nothing committed or pushed."
if ($report.failed -gt 0) { exit 1 }
