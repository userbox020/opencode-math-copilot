[CmdletBinding()]
param(
  [string]$RuntimeImageId = '',
  [string]$CoreBuildReceipt = '',
  [switch]$OperatorFreezeOnly,
  [string]$DockerExecutable = '',
  [string]$NodeExecutable = ''
)
$ErrorActionPreference = 'Stop'
if ($RuntimeImageId -and $RuntimeImageId -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Immutable runtime image ID required' }
if (-not $DockerExecutable) { $DockerExecutable = (Get-Command docker.exe -ErrorAction Stop).Source }
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
$Repository = Split-Path -Parent $PSScriptRoot
$Work = Join-Path 'C:\Users\MiPC\AppData\Local\Temp\opencode' ('eval-checker-g004-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $Work
$Driver = Join-Path $Work 'build-driver.mjs'
$Source = @'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const [repo, work, executable, runtime, previous, mode] = process.argv.slice(2);
const freezeOnly = mode === 'freeze-only';
const { hash, POLICIES, PRIMITIVES, LIMITS, PINS, PROTOCOL, validateCoreReceipt, validateCoreProvenance } = await import(pathToFileURL(path.join(repo, 'bench/v4/real-use/checker/policies.mjs')));
const original = 'sha256:d65d1b70ed3503fb4f0b1caf72474ed05eb54fe7a7560e59488341d3f83f65ed';
const host = 'npipe:////./pipe/docker_engine', nonce = randomUUID().replaceAll('-', '');
const save = (file, value) => fs.writeFileSync(path.join(work, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const space = () => { const s = fs.statfsSync(work); const free = s.bavail * s.bsize; if (free < 15 * 1024 ** 3) throw new Error(`disk_floor:${free}`); return free; };
const env = { PATH: `${path.dirname(executable)};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, SystemRoot: process.env.SystemRoot, TEMP: work, TMP: work };
let sequence = 0;
const receipt = { schema: 'eval-checker-build/v1', status: 'building', work, endpoint: host, pins: PINS, limits: LIMITS, protocol_sha256: hash(PROTOCOL), primitive_list_sha256: hash(PRIMITIVES), started: new Date().toISOString(), trust: 'Pinned public Comparator/exporter/parser and Lean kernel; accepted local original toolchain; Docker/host OS. No claim of informal mathematical truth.' };
async function docker(args, name, { stdin = '', timeout = 120000, allowFailure = false } = {}) {
  space(); const n = String(++sequence).padStart(3, '0');
  const config = fs.mkdtempSync(path.join(work, 'client-')); fs.writeFileSync(path.join(config, 'config.json'), '{}\n', { flag: 'wx' });
  if (args[0] === 'build') {
    const buildx = path.resolve(path.dirname(executable), '../cli-plugins/docker-buildx.exe');
    fs.mkdirSync(path.join(config, 'cli-plugins')); fs.copyFileSync(buildx, path.join(config, 'cli-plugins/docker-buildx.exe'));
    receipt.buildx_sha256 = hash(fs.readFileSync(buildx));
  }
  const stdoutPath = path.join(work, `${n}-${name}.stdout.log`), stderrPath = path.join(work, `${n}-${name}.stderr.log`);
  const out = fs.openSync(stdoutPath, 'wx'), err = fs.openSync(stderrPath, 'wx');
  const argv = ['--config', config, '--host', host, ...args];
  const result = await new Promise(resolve => {
    let failure = null, size = 0;
    const child = spawn(executable, argv, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = why => { failure ??= why; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const disk = setInterval(() => { try { space(); } catch { stop('disk_floor'); } }, 5000);
    child.stdout.on('data', b => { fs.writeSync(out, b); size += b.length; if (size > 128 * 1024 ** 2) stop('output_limit'); });
    child.stderr.on('data', b => { fs.writeSync(err, b); size += b.length; if (size > 128 * 1024 ** 2) stop('output_limit'); });
    child.on('error', () => { failure ??= 'spawn_error'; });
    child.on('close', (code, signal) => { clearTimeout(timer); clearInterval(disk); resolve({ code, signal, failure }); });
    child.stdin.on('error', () => { failure ??= 'stdin_error'; }); child.stdin.end(stdin);
  });
  fs.closeSync(out); fs.closeSync(err); save(`${n}-${name}.json`, { argv, ...result, stdoutPath, stderrPath });
  if (!allowFailure && (result.code !== 0 || result.signal || result.failure)) throw new Error(`docker_failed:${name}:${JSON.stringify(result)}:${stderrPath}`);
  return { ...result, stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: fs.readFileSync(stderrPath, 'utf8') };
}
const identity = async ref => JSON.parse((await docker(['image', 'inspect', '--format', '{{json .}}', ref], 'image-inspect')).stdout);
const owned = new Map();
async function remove(name, owner) {
  const info = JSON.parse((await docker(['container', 'inspect', name], 'cleanup-inspect')).stdout)[0];
  if (info.Name !== `/${name}` || info.Config.Labels?.['org.opencode.eval.owner'] !== owner) throw new Error('cleanup_identity');
  await docker(['container', 'rm', '--force', info.Id], 'cleanup-remove');
  if ((await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], 'cleanup-confirm')).stdout.trim()) throw new Error('cleanup_unconfirmed');
  owned.delete(name);
}
async function alias(id, kind) {
  if ((await identity(id)).Id !== id) throw new Error('image_id_mismatch');
  const tag = `eval-checker-g004-${kind}:${nonce}`;
  await docker(['tag', id, tag], 'tag-' + kind); return tag;
}
try {
  receipt.free_before = space();
  const context = path.join(work, 'context'); fs.mkdirSync(context); fs.mkdirSync(path.join(context, 'challenges'));
  const files = { 'Dockerfile': 'docker/eval-checker.Dockerfile', 'CheckOnly.lean': 'bench/v4/real-use/checker/CheckOnly.lean', 'export-launcher.py': 'bench/v4/real-use/checker/export-launcher.py' };
  receipt.source_hashes = {};
  for (const [dest, source] of Object.entries(files)) { const bytes = fs.readFileSync(path.join(repo, source)); fs.writeFileSync(path.join(context, dest), bytes); receipt.source_hashes[source] = hash(bytes); }
  for (const source of ['scripts/build-eval-checker.ps1', 'bench/v4/real-use/checker-adapter.mjs', 'bench/v4/real-use/checker/policies.mjs']) if (fs.existsSync(path.join(repo, source))) receipt.source_hashes[source] = hash(fs.readFileSync(path.join(repo, source)));
  fs.writeFileSync(path.join(context, 'roots.json'), JSON.stringify(Object.fromEntries(POLICIES.map(p => [p.task_id, p.roots]))));
  fs.writeFileSync(path.join(context, 'policies.json'), JSON.stringify(POLICIES.map(({positive_control, ...p}) => p)));
  for (const p of POLICIES) fs.writeFileSync(path.join(context, 'challenges', p.task_id + '.lean'), p.challenge_source);
  let base, core, originalReceiptPath;
  const coreInputs = { dockerfile: receipt.source_hashes['docker/eval-checker.Dockerfile'], checkonly: receipt.source_hashes['bench/v4/real-use/checker/CheckOnly.lean'] };
  if (previous) {
    const prior = JSON.parse(fs.readFileSync(previous, 'utf8'));
    validateCoreReceipt(prior, coreInputs);
    core = prior.core_image_id; base = prior.base_reference; receipt.core_build_receipt = previous;
    originalReceiptPath = path.resolve(previous);
  } else {
    const baseInfo = await identity('ubuntu:24.04');
    base = baseInfo.RepoDigests.find(s => /^ubuntu@sha256:[a-f0-9]{64}$/.test(s));
    if (!base || baseInfo.Architecture !== 'amd64') throw new Error('ubuntu_pinned_base_missing');
    const toolchain = await alias(original, 'toolchain');
    const iid = path.join(work, 'core-image-id.txt');
    console.log(`CORE_BUILD_START ${work}`);
    await docker(['build', '--platform', 'linux/amd64', '--progress', 'plain', '--no-cache', '--pull=false', '--target', 'checker_core', '--build-arg', `BASE_IMAGE=${base}`, '--build-arg', `TOOLCHAIN_IMAGE=${toolchain}`, '--build-arg', `RUNTIME_IMAGE=${toolchain}`, '--build-arg', `CORE_IMAGE=${toolchain}`, '--iidfile', iid, '--tag', `eval-checker-g004-core:${nonce}`, context], 'core-build', { timeout: 1800000 });
    core = fs.readFileSync(iid, 'utf8').trim();
    if ((await identity(toolchain)).Id !== original) throw new Error('toolchain_alias_changed');
  }
  receipt.base_reference = base; receipt.core_image_id = core;
  if (!originalReceiptPath) {
    save('core-build-receipt.json', { ...receipt, status: 'core_built', finished: new Date().toISOString() });
    originalReceiptPath = path.join(work, 'core-build-receipt.json');
  }
  const originalDirectory = path.dirname(originalReceiptPath);
  const receiptText = fs.readFileSync(originalReceiptPath, 'utf8');
  const originalReceipt = JSON.parse(receiptText);
  const driverText = fs.readFileSync(path.join(originalDirectory, 'build-driver.mjs'), 'utf8');
  receipt.core_provenance = {
    original_receipt_path: originalReceiptPath, receipt_text: receiptText, receipt_sha256: hash(receiptText),
    dockerfile_text: fs.readFileSync(path.join(originalDirectory, 'context/Dockerfile'), 'utf8'),
    checkonly_text: fs.readFileSync(path.join(originalDirectory, 'context/CheckOnly.lean'), 'utf8'),
    build_driver_text: driverText, build_driver_sha256: hash(driverText),
    original_build_script_sha256: originalReceipt.source_hashes['scripts/build-eval-checker.ps1'],
  };
  validateCoreProvenance(receipt.core_provenance, coreInputs);
  const coreAlias = await alias(core, 'core-pin');
  if (!runtime) { receipt.status = 'core_built'; }
  else {
    const runtimeInfo = await identity(runtime);
    if (runtimeInfo.Config.Labels?.['org.opencode.eval.runtime'] !== 'mathlib-only-v1') throw new Error('fresh_mathlib_runtime_required');
    const runtimeAlias = await alias(runtime, 'runtime-pin'); receipt.runtime_image_id = runtime;
    // An unadmitted fresh runtime may be used as a root operator builder only.
    // This mode deliberately cannot produce an adapter-admissible build receipt.
    for (const target of freezeOnly ? ['checker'] : ['export_worker', 'checker']) {
      const iid = path.join(work, `${target}-image-id.txt`);
      await docker(['build', '--platform', 'linux/amd64', '--progress', 'plain', '--pull=false', '--target', target, '--build-arg', `BASE_IMAGE=${base}`, '--build-arg', `TOOLCHAIN_IMAGE=${coreAlias}`, '--build-arg', `RUNTIME_IMAGE=${runtimeAlias}`, '--build-arg', `CORE_IMAGE=${coreAlias}`, '--iidfile', iid, '--tag', `eval-checker-g004-${target}:${nonce}`, context], target + '-build', { timeout: 600000 });
      receipt[target + '_image_id'] = fs.readFileSync(iid, 'utf8').trim();
    }
    if ((await identity(runtimeAlias)).Id !== runtime || (await identity(coreAlias)).Id !== core) throw new Error('image_alias_changed');
    const owner = randomUUID(), name = `eval-checker-g004-freeze-${nonce}`; owned.set(name, owner);
    await docker(['create', '--name', name, '--label', `org.opencode.eval.owner=${owner}`, '--network', 'none', '--read-only', receipt.checker_image_id], 'freeze-create');
    // Only trusted, never-started image data is copied. No tar or filenames from A.
    const exports = path.join(work, 'frozen-challenges');
    await docker(['cp', `${name}:/opt/challenges`, exports], 'freeze-exports');
    await remove(name, owner);
    receipt.challenges = Object.fromEntries(POLICIES.map(p => [p.task_id, { policy_sha256: p.policy_sha256, challenge_source_sha256: p.challenge_source_sha256, challenge_export_sha256: hash(fs.readFileSync(path.join(exports, p.task_id + '.export'))) }]));
    receipt.status = freezeOnly ? 'challenge_checker_built_runtime_not_admitted' : 'images_built';
  }
} catch (e) { receipt.status = 'failed'; receipt.error = e.message; process.exitCode = 1; }
finally {
  for (const [name, owner] of owned) try { await remove(name, owner); } catch { receipt.cleanup_unconfirmed ??= []; receipt.cleanup_unconfirmed.push(name); }
  receipt.finished = new Date().toISOString(); save('build-receipt.json', receipt);
  console.log(JSON.stringify({ status: receipt.status, core_image_id: receipt.core_image_id, checker_image_id: receipt.checker_image_id, export_worker_image_id: receipt.export_worker_image_id, error: receipt.error, receipt: path.join(work, 'build-receipt.json') }));
}
'@
[System.IO.File]::WriteAllText($Driver, $Source, [System.Text.UTF8Encoding]::new($false))
$Mode = if ($OperatorFreezeOnly) { 'freeze-only' } else { 'full' }
& $NodeExecutable $Driver $Repository $Work $DockerExecutable $RuntimeImageId $CoreBuildReceipt $Mode
exit $LASTEXITCODE
