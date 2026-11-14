[CmdletBinding()]
param(
  [string]$ToolchainImageId = 'sha256:d65d1b70ed3503fb4f0b1caf72474ed05eb54fe7a7560e59488341d3f83f65ed',
  [string]$BaseImage = '',
  [string]$RepairRuntimeImageId = '',
  [string]$ProvenanceReceipt = '',
  [string]$DockerExecutable = '',
  [string]$NodeExecutable = ''
)
$ErrorActionPreference = 'Stop'
if ($ToolchainImageId -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Immutable local toolchain image ID required' }
if ($BaseImage -and $BaseImage -notmatch '^ubuntu@sha256:[0-9a-f]{64}$') { throw 'Optional base must be a previously recorded Ubuntu digest' }
if ($RepairRuntimeImageId -and ($RepairRuntimeImageId -notmatch '^sha256:[0-9a-f]{64}$' -or $ProvenanceReceipt -notmatch '^C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\eval-runtime-g004-[a-f0-9]+\\build-receipt\.json$')) { throw 'Repair requires an immutable freshly built runtime ID and its owned build receipt' }
if (-not $DockerExecutable) { $DockerExecutable = (Get-Command docker.exe -ErrorAction Stop).Source }
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
$Repository = Split-Path -Parent $PSScriptRoot
$Work = Join-Path 'C:\Users\MiPC\AppData\Local\Temp\opencode' ('eval-runtime-g004-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $Work
$Driver = Join-Path $Work 'build-driver.mjs'
$Source = @'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const [repo, work, executable, original, suppliedBase = '', repairImage = '', provenanceFile = ''] = process.argv.slice(2).map(value => value === '-' ? '' : value);
const host = 'npipe:////./pipe/docker_engine';
const minimumFree = 15 * 1024 ** 3;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const freshJSON = (file, value) => fs.writeFileSync(path.join(work, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const freeBytes = () => { const s = fs.statfsSync(work); return s.bavail * s.bsize; };
const requireSpace = () => { const free = freeBytes(); if (free < minimumFree) throw new Error(`disk_floor_blocked:${free}`); return free; };
const nativeEnv = { PATH: `${path.dirname(executable)};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, SystemRoot: process.env.SystemRoot, TEMP: work, TMP: work };
process.env.TEMP = work; process.env.TMP = work; // sandbox-generated config stays within this owned build directory
let sequence = 0;
async function docker(args, { stdin = '', timeout = 120000, allowFailure = false, name = 'docker' } = {}) {
  requireSpace();
  const index = String(++sequence).padStart(3, '0');
  const config = fs.mkdtempSync(path.join(work, 'client-'));
  fs.writeFileSync(path.join(config, 'config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  if (args[0] === 'build') {
    // Discover only the shipped Docker executable sibling, never user plugin/config paths.
    const buildx = path.resolve(path.dirname(executable), '../cli-plugins/docker-buildx.exe');
    const plugins = path.join(config, 'cli-plugins'); fs.mkdirSync(plugins);
    fs.copyFileSync(buildx, path.join(plugins, 'docker-buildx.exe'), fs.constants.COPYFILE_EXCL);
    receipt.buildx_executable_sha256 = hash(fs.readFileSync(buildx));
  }
  const stdoutFile = path.join(work, `${index}-${name}.stdout.log`);
  const stderrFile = path.join(work, `${index}-${name}.stderr.log`);
  const out = fs.openSync(stdoutFile, 'wx'), err = fs.openSync(stderrFile, 'wx');
  const argv = ['--config', config, '--host', host, ...args];
  const started = new Date().toISOString();
  const result = await new Promise(resolve => {
    let failure = null, closed = false, bytes = 0;
    const proc = spawn(executable, argv, { env: nativeEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (code, signal) => {
      if (closed) return; closed = true; clearTimeout(timer); clearInterval(diskGuard);
      resolve({ code, signal, failure });
    };
    const stop = reason => { failure ??= reason; proc.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('wall_timeout'), timeout);
    const diskGuard = setInterval(() => { try { requireSpace(); } catch { stop('disk_floor_blocked'); } }, 5000);
    proc.stdout.on('data', chunk => { fs.writeSync(out, chunk); bytes += chunk.length; if (bytes > 128 * 1024 ** 2) stop('output_limit'); });
    proc.stderr.on('data', chunk => { fs.writeSync(err, chunk); bytes += chunk.length; if (bytes > 128 * 1024 ** 2) stop('output_limit'); });
    proc.on('error', () => { failure ??= 'docker_spawn_error'; finish(null, null); });
    proc.on('close', finish);
    proc.stdin.on('error', () => { failure ??= 'stdin_error'; });
    proc.stdin.end(stdin);
  });
  fs.closeSync(out); fs.closeSync(err);
  const record = { argv, started, finished: new Date().toISOString(), ...result, stdoutFile, stderrFile, free_bytes: freeBytes() };
  freshJSON(`${index}-${name}.json`, record);
  if (!allowFailure && (result.code !== 0 || result.signal || result.failure)) throw new Error(`docker_failed:${name}:${result.code}:${result.failure ?? result.signal ?? 'exit'}:${stderrFile}`);
  return { ...record, stdout: fs.readFileSync(stdoutFile, 'utf8'), stderr: fs.readFileSync(stderrFile, 'utf8') };
}
async function imageIdentity(ref, name) {
  const format = '{"id":"{{.Id}}","os":"{{.Os}}","architecture":"{{.Architecture}}","size":{{.Size}},"repo_digests":{{json .RepoDigests}}}';
  return JSON.parse((await docker(['image', 'inspect', '--format', format, ref], { name })).stdout);
}
const receipt = { schema: 'eval-runtime-build/v1', started: new Date().toISOString(), status: 'building', work, endpoint: host, original_image_id: original, minimum_free_bytes: minimumFree,
  trust: 'Local developer study accepts the original immutable pre-solver toolchain image and public Ubuntu/apt/Mathlib master-cache producers. Content hashes are inventories, not upstream authentication or a hermetic-build claim.',
  proof: { status: 'not_assessed' }, evaluation_admission: 'BLOCKED' };
const ownedContainers = new Map();
async function removeOwned(name, owner) {
  const info = JSON.parse((await docker(['container', 'inspect', name], { name: 'owned-inspect' })).stdout)[0];
  if (info.Name !== `/${name}` || info.Config.Labels?.['org.opencode.eval.owner'] !== owner) throw new Error('owned_container_identity_mismatch');
  await docker(['container', 'rm', '--force', info.Id], { name: 'owned-remove' });
  const remaining = await docker(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { name: 'owned-absence' });
  if (remaining.stdout.trim()) throw new Error('owned_container_cleanup_unconfirmed');
  ownedContainers.delete(name);
}
try {
  receipt.free_before_bytes = requireSpace();
  receipt.docker_version = JSON.parse((await docker(['version', '--format', '{{json .}}'], { name: 'docker-version' })).stdout);
  receipt.original_before = await imageIdentity(original, 'original-before');
  if (receipt.original_before.id !== original || receipt.original_before.os !== 'linux') throw new Error('original_image_mismatch');
  const nonce = randomUUID().replaceAll('-', '');
  let toolchainAlias;
  if (repairImage) {
    const prior = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
    if (prior.image_id !== repairImage || prior.original_image_id !== original || prior.original_after?.id !== original || prior.toolchain_inventory_sha256 !== prior.metadata_hashes?.['toolchain-sha256.txt']) throw new Error('fresh_runtime_provenance_mismatch');
    receipt.parent_build_receipt = provenanceFile;
    receipt.parent_build_receipt_sha256 = hash(fs.readFileSync(provenanceFile));
    receipt.parent_runtime_image_id = repairImage;
    receipt.base = prior.base; receipt.base_reference = prior.base_reference;
    receipt.toolchain_inventory_sha256 = prior.toolchain_inventory_sha256;
    receipt.toolchain_inventory_path = prior.toolchain_inventory_path;
    receipt.repair = 'Read-permission-only layer on the fresh immutable operator build; no corpus/solver caches and no new downloads.';
    const runtimeAlias = `eval-runtime-g004-repair-input:${nonce}`;
    await docker(['image', 'tag', repairImage, runtimeAlias], { name: 'tag-owned-repair-input' });
    receipt.repair_input_before = await imageIdentity(runtimeAlias, 'repair-input-before');
    if (receipt.repair_input_before.id !== repairImage) throw new Error('repair_input_mismatch');
    const context = path.join(work, 'context'); fs.mkdirSync(context);
    const dockerfile = `FROM ${runtimeAlias}\nUSER 0:0\nRUN chmod -R a+rX /opt/mathlib\nUSER 10001:10001\n`;
    fs.writeFileSync(path.join(context, 'Dockerfile'), dockerfile, { flag: 'wx' });
    receipt.context_allowlist = ['Dockerfile']; receipt.dockerfile_sha256 = hash(dockerfile);
    receipt.full_recipe_sha256 = hash(fs.readFileSync(path.join(repo, 'docker/eval-lean.Dockerfile')));
    receipt.builder_script_sha256 = hash(fs.readFileSync(path.join(repo, 'scripts/build-eval-runtime.ps1')));
    const imageTag = `eval-runtime-g004:${nonce}`, iidFile = path.join(work, 'image-id.txt');
    console.log(`REPAIR_BUILD_START ${work}`);
    const built = await docker(['build', '--platform', 'linux/amd64', '--progress', 'plain', '--no-cache', '--pull=false', '--tag', imageTag, '--iidfile', iidFile, '--file', path.join(context, 'Dockerfile'), context], { timeout: 1800000, name: 'repair-build' });
    receipt.build_stdout = built.stdoutFile; receipt.build_stderr = built.stderrFile;
    receipt.image_id = fs.readFileSync(iidFile, 'utf8').trim(); receipt.image_tag = imageTag;
    receipt.repair_input_after = await imageIdentity(runtimeAlias, 'repair-input-after');
    if (receipt.repair_input_after.id !== repairImage) throw new Error('repair_input_changed');
  } else {
  toolchainAlias = `eval-toolchain-g004:${nonce}`;
  await docker(['image', 'tag', original, toolchainAlias], { name: 'tag-owned-toolchain' });
  receipt.toolchain_alias = toolchainAlias;
  receipt.alias_before = await imageIdentity(toolchainAlias, 'alias-before');
  if (receipt.alias_before.id !== original) throw new Error('toolchain_alias_mismatch');
  if (!suppliedBase) await docker(['pull', '--platform', 'linux/amd64', 'ubuntu:24.04'], { timeout: 600000, name: 'pull-ubuntu' });
  receipt.base = await imageIdentity(suppliedBase || 'ubuntu:24.04', 'base-inspect');
  const base = suppliedBase || receipt.base.repo_digests.find(s => /^ubuntu@sha256:[a-f0-9]{64}$/.test(s));
  if (!base || receipt.base.architecture !== 'amd64') throw new Error('immutable_amd64_base_required');
  receipt.base_reference = base;

  // Hash only the trusted original toolchain, in a read-only, mount-free container.
  const hashOwner = randomUUID(), hashName = `eval-runtime-g004-toolchain-${nonce}`;
  ownedContainers.set(hashName, hashOwner);
  await docker(['create', '--name', hashName, '--label', `org.opencode.eval.owner=${hashOwner}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--memory', '1g', '--memory-swap', '1g', '--cpus', '2', '--pids-limit', '64', '--entrypoint', '/bin/bash', original, '-c', 'cd /root/.elan/toolchains/leanprover--lean4---v4.34.1 && find . -type f -print0 | sort -z | xargs -0 sha256sum'], { name: 'original-hash-create' });
  const toolchainHashes = await docker(['start', '--attach', hashName], { timeout: 600000, name: 'original-toolchain-sha256' });
  receipt.toolchain_inventory_sha256 = hash(toolchainHashes.stdout);
  receipt.toolchain_inventory_path = toolchainHashes.stdoutFile;
  await removeOwned(hashName, hashOwner);

  const context = path.join(work, 'context'); fs.mkdirSync(context);
  const dockerfile = fs.readFileSync(path.join(repo, 'docker/eval-lean.Dockerfile'));
  fs.writeFileSync(path.join(context, 'Dockerfile'), dockerfile, { flag: 'wx' });
  receipt.context_allowlist = ['Dockerfile'];
  receipt.dockerfile_sha256 = hash(dockerfile);
  receipt.builder_script_sha256 = hash(fs.readFileSync(path.join(repo, 'scripts/build-eval-runtime.ps1')));
  const imageTag = `eval-runtime-g004:${nonce}`, iidFile = path.join(work, 'image-id.txt');
  console.log(`BUILD_START ${work}`);
  const built = await docker(['build', '--platform', 'linux/amd64', '--progress', 'plain', '--no-cache', '--pull=false', '--build-arg', `TOOLCHAIN_IMAGE=${toolchainAlias}`, '--build-arg', `TOOLCHAIN_IMAGE_ID=${original}`, '--build-arg', `BASE_IMAGE=${base}`, '--tag', imageTag, '--iidfile', iidFile, '--file', path.join(context, 'Dockerfile'), context], { timeout: 1800000, name: 'build' });
  receipt.build_stdout = built.stdoutFile; receipt.build_stderr = built.stderrFile;
  receipt.image_id = fs.readFileSync(iidFile, 'utf8').trim(); receipt.image_tag = imageTag;
  }
  receipt.original_after = await imageIdentity(original, 'original-after');
  if (toolchainAlias) receipt.alias_after = await imageIdentity(toolchainAlias, 'alias-after');
  if (receipt.original_after.id !== original || (toolchainAlias && receipt.alias_after.id !== original)) throw new Error('toolchain_pin_changed');
  receipt.final_image = await imageIdentity(receipt.image_id, 'final-image');

  const modulePath = path.join(repo, 'bench/v3/arxivlean/lib/eval-sandbox.mjs');
  receipt.backend_source_sha256 = hash(fs.readFileSync(modulePath));
  const { createCompilerSandbox, containerArguments, POLICY_HASH } = await import(pathToFileURL(modulePath));
  receipt.policy_sha256 = POLICY_HASH;
  const backend = createCompilerSandbox({ image: receipt.image_id, dockerExecutable: executable, endpoint: host });
  receipt.backend_inspection = await backend.inspectImage();

  // A separate own-written Init control records actual Docker host/container policy.
  const owner = randomUUID(), name = `eval-runtime-g004-inspect-${nonce}`;
  ownedContainers.set(name, owner);
  await docker(containerArguments(receipt.image_id, name, owner), { name: 'policy-create' });
  const inspected = await docker(['container', 'inspect', name], { name: 'actual-container-policy' });
  receipt.actual_container_inspect = inspected.stdoutFile;
  const ci = JSON.parse(inspected.stdout)[0];
  if (ci.HostConfig.NetworkMode !== 'none' || !ci.HostConfig.ReadonlyRootfs || ci.Config.User !== '10001:10001' || ci.Mounts.some(m => m.Type !== 'tmpfs')) throw new Error('actual_container_policy_mismatch');
  const metadata = path.join(work, 'runtime-metadata');
  await docker(['cp', `${name}:/usr/share/eval-runtime`, metadata], { name: 'metadata-copy' });
  receipt.runtime_metadata = metadata;
  receipt.metadata_hashes = Object.fromEntries(fs.readdirSync(metadata).map(file => [file, hash(fs.readFileSync(path.join(metadata, file)))]));
  if (receipt.metadata_hashes['toolchain-sha256.txt'] !== receipt.toolchain_inventory_sha256) throw new Error('copied_toolchain_hash_mismatch');
  receipt.python_sympy = fs.readFileSync(path.join(metadata, 'python-sympy.txt'), 'utf8').trim();
  await docker(['start', '--attach', '--interactive', name], { stdin: 'import Init\nexample : True := True.intro\n', name: 'policy-init-control' });
  await removeOwned(name, owner);

  const pythonProbe = source => `import Init\n#eval do\n  let r <- IO.Process.output { cmd := "/usr/bin/python3", args := #[${JSON.stringify('-c')}, ${JSON.stringify(source)}] }\n  if r.exitCode != 0 then throw (IO.userError r.stderr)\n`;
  const controls = [
    ['init_true', 'import Init\ntheorem runtimeControl : True := True.intro\n', 'compiled'],
    ['mathlib_real_identity', 'import Mathlib.Data.Real.Basic\ntheorem runtimeRealIdentity (x : Real) : x + 0 = x := add_zero x\n', 'compiled'],
    ['mathlib_full_import', 'import Mathlib\ntheorem runtimeRealIdentity (x : Real) : x + 0 = x := add_zero x\n', 'compiled'],
    ['wrong_type', 'import Init\ntheorem runtimeControl : False := True.intro\n', 'error'],
    ['read_only_dependencies', 'import Init\n#eval IO.FS.writeFile "/opt/mathlib/eval-runtime-g004-write-probe" "probe"\n', 'error'],
    ['scratch_write_read', 'import Init\n#eval do\n  IO.FS.writeFile "/work/eval-runtime-g004-state" "probe"\n  let value <- IO.FS.readFile "/work/eval-runtime-g004-state"\n  if value != "probe" then throw (IO.userError "scratch mismatch")\n', 'compiled'],
    ['state_isolation', 'import Init\n#eval (do\n  if <- (System.FilePath.mk "/work/eval-runtime-g004-state").pathExists then throw (IO.userError "state leaked")\n  : IO Unit)\n', 'compiled'],
    ['no_corpus_or_socket', pythonProbe('import os; assert all(not os.path.exists(p) for p in ["/math", "/work/math", "/opt/comparator", "/var/run/docker.sock"]); assert os.getuid()==10001'), 'compiled'],
    ['network_isolation', pythonProbe('import os,socket; assert os.listdir("/sys/class/net")==["lo"]; s=socket.socket(); s.settimeout(0.5)\ntry:\n s.connect(("198.51.100.1",9))\nexcept OSError:\n pass\nelse:\n raise RuntimeError("unexpected network reachability")\nfinally:\n s.close()'), 'compiled'],
    ['sympy_contained_smoke', pythonProbe('import sympy as s; x=s.symbols("x"); assert s.expand((x+1)**2)==x**2+2*x+1'), 'compiled'],
  ];
  receipt.controls = [];
  for (const [control, code, expected] of controls) {
    const result = await backend.compile({ code });
    const passed = result.status === expected && result.cleanup === 'confirmed_absent' && (expected !== 'error' || result.reason === 'compiler_nonzero');
    const record = { control, code, expected, passed, result };
    freshJSON(`control-${control}.json`, record); receipt.controls.push(record);
    console.log(`CONTROL ${control} ${passed ? 'PASS' : 'FAIL'} ${result.reason}`);
  }
  receipt.status = receipt.controls.every(c => c.passed) ? 'built_compile_controls_passed' : 'built_control_failures';
  if (receipt.status === 'built_control_failures') process.exitCode = 2;
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1;
} finally {
  for (const [name, owner] of ownedContainers) {
    try { await removeOwned(name, owner); } catch { receipt.cleanup_unconfirmed ??= []; receipt.cleanup_unconfirmed.push(name); }
  }
  receipt.free_after_bytes = freeBytes(); receipt.finished = new Date().toISOString();
  freshJSON('build-receipt.json', receipt);
  console.log(JSON.stringify({ status: receipt.status, image_id: receipt.image_id, error: receipt.error, work, free_after_bytes: receipt.free_after_bytes, receipt: path.join(work, 'build-receipt.json') }));
}
'@
[System.IO.File]::WriteAllText($Driver, $Source, [System.Text.UTF8Encoding]::new($false))
Write-Output "Owned build directory: $Work"
$BaseArg = if ($BaseImage) { $BaseImage } else { '-' }
$RepairArg = if ($RepairRuntimeImageId) { $RepairRuntimeImageId } else { '-' }
$ReceiptArg = if ($ProvenanceReceipt) { $ProvenanceReceipt } else { '-' }
& $NodeExecutable $Driver $Repository $Work $DockerExecutable $ToolchainImageId $BaseArg $RepairArg $ReceiptArg
exit $LASTEXITCODE
