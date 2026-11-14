import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
export const POLICY = Object.freeze({
  version: 'arxivlean-compile-policy/v1', sourceBytes: 131072, outputBytes: 131072,
  wallMs: 120000, controlMs: 10000, memory: '2g', cpus: '2', pids: '64',
  user: '10001:10001', command: '/opt/lean/bin/lean',
  environment: Object.freeze({
    PATH: '/opt/lean/bin:/usr/bin:/bin', HOME: '/work', TMPDIR: '/tmp', LANG: 'C.UTF-8',
    LEAN_PATH: ['/opt/mathlib/.lake/build/lib/lean', ...['plausible', 'LeanSearchClient', 'importGraph', 'proofwidgets', 'aesop', 'Qq', 'batteries', 'Cli'].map(p => `/opt/mathlib/.lake/packages/${p}/.lake/build/lib/lean`)].join(':'),
  }),
});
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const POLICY_HASH = sha256(JSON.stringify(POLICY));

// Host-side Docker transport. No shell, model-selected command, or inherited Docker options.
// Injection is for unit tests only; its receipts are explicitly non-production.
export function dockerTransportForTests(spawnProcess, options = {}, hostEnvironment = process.env) { return transport(spawnProcess, options, hostEnvironment); }
export function createDockerTransport(options = {}) { return transport(spawn, options); }
function transport(spawnProcess = spawn, options = {}, hostEnvironment = process.env) {
  if (Object.keys(options).some(key => !['endpoint', 'dockerExecutable'].includes(key))) throw new Error('unknown_docker_client_option');
  const endpoint = options.endpoint ?? (process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
  if (typeof endpoint !== 'string' || !(/^(?:unix:\/\/\/(?!\/)[^\s\\\0?#]+|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+)$/.test(endpoint))) throw new Error('local_docker_endpoint_required');
  const dockerExecutable = options.dockerExecutable ?? 'docker';
  if (options.dockerExecutable !== undefined && (typeof dockerExecutable !== 'string' || !path.isAbsolute(dockerExecutable) || dockerExecutable.includes('\0'))) throw new Error('absolute_docker_executable_required');
  // Snapshot only native executable lookup essentials. Never enumerate/copy the parent
  // environment or read Docker context/auth/proxy/TLS/home configuration.
  const environment = Object.freeze({
    PATH: hostEnvironment.PATH ?? hostEnvironment.Path ?? '',
    ...(process.platform === 'win32' && hostEnvironment.SystemRoot ? { SystemRoot: hostEnvironment.SystemRoot } : {}),
  });
  const tempRoot = os.tmpdir();
  return (args, { stdin = '', timeoutMs = POLICY.controlMs, signal } = {}) => new Promise(resolve => {
    let child, timer, settled = false, failure = null, size = 0;
    let configDirectory, directoryIdentity, configIdentity;
    const chunks = { stdout: [], stderr: [] };
    const sameIdentity = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
    const cleanupConfig = () => {
      if (!configDirectory) return 'not_created';
      const directory = fs.lstatSync(configDirectory);
      if (!directory.isDirectory() || !sameIdentity(directory, directoryIdentity)) throw new Error('client_config_ownership_mismatch');
      const configFile = path.join(configDirectory, 'config.json');
      if (configIdentity) {
        const file = fs.lstatSync(configFile);
        if (!file.isFile() || !sameIdentity(file, configIdentity)) throw new Error('client_config_ownership_mismatch');
        fs.unlinkSync(configFile);
      }
      // Intentionally nonrecursive: never delete unexpected files or a user directory.
      fs.rmdirSync(configDirectory);
      if (fs.existsSync(configDirectory)) throw new Error('client_config_cleanup_failed');
      return 'confirmed_removed';
    };
    const finish = (code = null, sig = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      let client_config_cleanup;
      try { client_config_cleanup = cleanupConfig(); }
      catch { client_config_cleanup = 'unconfirmed'; failure ??= 'client_config_cleanup_failed'; }
      resolve({ code, signal: sig, failure, client_config_cleanup, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    };
    const stop = reason => {
      failure ??= reason;
      try { child?.kill('SIGKILL'); } catch { /* Cleanup still has to query Docker. */ }
      // Do not depend on a cooperative Docker client emitting close. Container cleanup follows.
      finish();
    };
    const abort = () => stop('cancelled');
    if (signal?.aborted) { failure = 'cancelled'; finish(); return; }
    try {
      configDirectory = fs.mkdtempSync(path.join(tempRoot, 'arxivlean-docker-client-'));
      directoryIdentity = fs.lstatSync(configDirectory);
      fs.chmodSync(configDirectory, 0o700);
      const configFile = path.join(configDirectory, 'config.json');
      fs.writeFileSync(configFile, '{}\n', { flag: 'wx', mode: 0o600 });
      configIdentity = fs.lstatSync(configFile);
      child = spawnProcess(dockerExecutable, ['--config', configDirectory, '--host', endpoint, ...args], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...environment, ...(process.platform === 'win32' ? { TEMP: configDirectory, TMP: configDirectory } : { TMPDIR: configDirectory }) },
      });
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
        if (settled) return;
        const bytes = Buffer.from(data);
        const remaining = Math.max(0, POLICY.outputBytes - size);
        chunks[stream].push(bytes.subarray(0, remaining));
        size += bytes.length;
        if (size > POLICY.outputBytes) stop('output_limit');
      });
      child.on('error', () => { failure ??= 'process_error'; finish(); });
      child.on('close', finish);
      child.stdin.on('error', () => stop('stdin_error'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      child.stdin.end(stdin);
    } catch { failure = 'process_error'; finish(); }
  });
}

const ok = result => result?.code === 0 && !result.signal && !result.failure;
function jsonResult(result) {
  if (!ok(result)) throw new Error(result?.failure || 'docker_command_failed');
  return JSON.parse(result.stdout);
}

export function containerArguments(image, name, owner) {
  if (!IMAGE_ID.test(image)) throw new Error('immutable_image_id_required');
  return ['create', '--pull=never', '--name', name,
    '--label', `org.opencode.eval.owner=${owner}`, '--label', 'org.opencode.eval.role=compile',
    '--interactive', '--network', 'none', '--user', POLICY.user, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--memory', POLICY.memory, '--memory-swap', POLICY.memory, '--cpus', POLICY.cpus,
    '--pids-limit', POLICY.pids, '--ulimit', 'nofile=128:128', '--ulimit', 'fsize=16777216:16777216',
    '--ulimit', 'core=0:0', '--restart', 'no', '--ipc', 'none',
    '--tmpfs', '/work:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=700',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=700',
    '--workdir', '/work', ...Object.entries(POLICY.environment).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    '--entrypoint', POLICY.command, image, '--stdin'];
}

function sandbox(image, docker, evidence) {
  if (!IMAGE_ID.test(image ?? '')) throw new Error('immutable_image_id_required');
  async function inspectImage() {
    const [info] = jsonResult(await docker(['image', 'inspect', image]));
    if (info?.Id !== image || info.Os !== 'linux' || info.Config?.Labels?.['org.opencode.eval.runtime'] !== 'mathlib-only-v1') throw new Error('unknown_eval_image');
    if (Object.keys(info.Config?.Volumes ?? {}).length || info.Config?.OnBuild?.length) throw new Error('image_volumes_or_hooks_forbidden');
    for (const entry of info.Config?.Env ?? []) {
      const i = entry.indexOf('=');
      if (i < 0 || POLICY.environment[entry.slice(0, i)] !== entry.slice(i + 1)) throw new Error('unexpected_image_environment');
    }
    return { id: info.Id, inspect_sha256: sha256(JSON.stringify(info)), evidence, provenance: 'not_authenticated' };
  }
  async function cleanup(name, owner, createUncertain) {
    const inspected = await docker(['container', 'inspect', name]);
    if (ok(inspected)) {
      const [info] = jsonResult(inspected);
      if (info?.Name !== `/${name}` || info.Config?.Labels?.['org.opencode.eval.owner'] !== owner || !/^[a-f0-9]{64}$/.test(info.Id ?? '')) throw new Error('cleanup_ownership_mismatch');
      if (!ok(await docker(['container', 'rm', '--force', info.Id]))) throw new Error('cleanup_remove_failed');
    } else if (createUncertain) throw new Error('cleanup_not_confirmed_after_uncertain_create');
    const remaining = await docker(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
    if (!ok(remaining) || remaining.stdout.trim()) throw new Error('cleanup_not_confirmed');
    return 'confirmed_absent';
  }
  async function compile(input, { signal } = {}) {
    const base = { schema: 'eval-compile/v1', evidence, image, policy_sha256: POLICY_HASH, proof: { status: 'not_assessed' }, cleanup: 'not_needed' };
    if (!input || Object.keys(input).length !== 1 || typeof input.code !== 'string' || !input.code.trim() || Buffer.byteLength(input.code) > POLICY.sourceBytes) return { ...base, status: 'blocked', reason: 'bounded_code_only_required' };
    if (signal?.aborted) return { ...base, status: 'blocked', reason: 'cancelled' };
    try { await inspectImage(); } catch (error) { return { ...base, status: 'blocked', reason: error.message }; }
    const owner = randomUUID();
    const name = `arxivlean-eval-${owner}`;
    let result = { ...base, container: name, status: 'error', reason: 'container_not_started' };
    let createUncertain = true;
    try {
      const created = await docker(containerArguments(image, name, owner), { signal });
      createUncertain = Boolean(created.failure || created.signal);
      if (!ok(created)) throw new Error(created.failure || 'container_create_failed');
      const execution = await docker(['start', '--attach', '--interactive', name], { stdin: input.code, timeoutMs: POLICY.wallMs, signal });
      result = { ...result, status: ok(execution) ? 'compiled' : 'error',
        reason: ok(execution) ? 'compilation_only_not_proof_verification' : execution.failure || (execution.signal ? 'process_signal' : 'compiler_nonzero'),
        exit_code: execution.code, signal: execution.signal, diagnostics: { stdout: execution.stdout, stderr: execution.stderr, trust: 'untrusted_source_output' } };
    } catch (error) { result.reason = error.message; }
    finally {
      try { result.cleanup = await cleanup(name, owner, createUncertain); }
      catch (error) { result = { ...result, status: 'error', reason: error.message, cleanup: 'unconfirmed' }; }
    }
    return result;
  }
  return Object.freeze({ compile, inspectImage, evidence });
}

// Operator-only configuration. Never expose this factory or image selection as a model tool.
export function createCompilerSandbox(options = {}) {
  if (Object.keys(options).some(key => !['image', 'endpoint', 'dockerExecutable'].includes(key))) throw new Error('unknown_sandbox_option');
  return sandbox(options.image, transport(spawn, { endpoint: options.endpoint, dockerExecutable: options.dockerExecutable }), 'local-docker');
}
export function createTestSandbox({ image, docker }) {
  return sandbox(image, docker, 'test-only');
}
