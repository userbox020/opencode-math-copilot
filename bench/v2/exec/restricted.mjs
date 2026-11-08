import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { assert, parseArgs } from '../lib.mjs';

export const POLICY = Object.freeze({ network: 'none', root: 'read-only', user: '65532:65532', memory: '512m', cpus: '1', pids: '64', capabilities: 'ALL-dropped', privileges: 'no-new-privileges', timeout_ms: 30000 });

// Preparation performs only local path/policy checks. It never contacts Docker.
// The mount must be a dedicated staging directory with Lean source files ONLY.
export function prepareRestricted({ codeDirectory, image, entry = 'Main.lean' }) {
  assert(typeof codeDirectory === 'string' && codeDirectory.length > 0, 'Dedicated code directory required');
  assert(typeof image === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(image), 'An immutable, pre-provisioned image@sha256:digest is required');
  assert(/^[A-Za-z0-9_-]+\.lean$/.test(entry), 'Only a plain Lean entry filename is permitted');
  const supplied = path.resolve(codeDirectory);
  assert(!lstatSync(supplied).isSymbolicLink() && lstatSync(supplied).isDirectory(), 'Code mount must be a real directory, not a symlink');
  const source = realpathSync(supplied);
  assert(!/[,\r\n]/.test(source), 'Unsafe Docker mount source');
  const files = readdirSync(source);
  assert(files.includes(entry), 'Lean entry is missing');
  for (const file of files) {
    const stat = lstatSync(path.join(source, file));
    assert(/^[A-Za-z0-9_-]+\.lean$/.test(file) && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Code staging may contain only non-linked Lean files; no credentials, sockets, directories or reports');
  }
  const args = [
    'run', '--rm', '--pull', 'never',
    '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    '--user', POLICY.user, '--memory', POLICY.memory, '--memory-swap', POLICY.memory,
    '--cpus', POLICY.cpus, '--pids-limit', POLICY.pids,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--log-driver', 'none',
    '--mount', `type=bind,source=${source},target=/code,readonly`,
    '--workdir', '/tmp', '--env', 'HOME=/tmp', '--env', 'LEAN_PATH=/opt/lean/lib/lean',
    '--entrypoint', '/opt/lean/bin/lean', image, '-o', '/tmp/Main.olean', `/code/${entry}`
  ];
  return { executable: 'docker', args, codeDirectory: source, image, entry, policy: POLICY, timeout_ms: POLICY.timeout_ms };
}

// Explicit execution is a separate opt-in. The v2 runner never imports/calls it.
// Injecting spawn is for deterministic tests; default execution is Docker only.
export function executeRestricted(plan, { spawn = spawnSync } = {}) {
  const prepared = prepareRestricted(plan);
  assert(JSON.stringify(prepared.args) === JSON.stringify(plan.args) && plan.executable === 'docker' && plan.timeout_ms === POLICY.timeout_ms, 'Prepared Docker plan was modified');
  const config = mkdtempSync(path.join(os.tmpdir(), 'math-eval-docker-config-'));
  const name = `math-eval-v2-${randomUUID()}`;
  const environment = { DOCKER_CONFIG: config };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key];
  const options = { encoding: 'utf8', shell: false, env: environment, timeout: POLICY.timeout_ms, maxBuffer: 1024 * 1024, windowsHide: true };
  let launched = false;
  try {
    const available = spawn('docker', ['version', '--format', '{{.Server.Version}}'], options);
    assert(!available.error && available.status === 0, 'Docker unavailable: restricted execution cannot proceed; host fallback is forbidden');
    launched = true;
    const args = [...prepared.args];
    args.splice(1, 0, '--name', name);
    const result = spawn('docker', args, options);
    if (result.error) throw new Error(`Restricted Docker execution failed: ${result.error.message}; no host fallback`);
    return { exit_code: result.status, signal: result.signal ?? null, stdout: result.stdout, stderr: result.stderr, simulated: false, policy: POLICY };
  } finally {
    // Killing a Docker client does not guarantee the container stopped.
    // Remove ONLY this invocation's unique container, even on timeout.
    if (launched) spawn('docker', ['rm', '--force', name], options);
    rmSync(config, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2), ['--code-dir', '--image', '--entry', '--dry-run', '--execute']);
    assert(Boolean(args['--dry-run']) !== Boolean(args['--execute']), 'Choose exactly one of --dry-run or --execute');
    const plan = prepareRestricted({ codeDirectory: args['--code-dir'], image: args['--image'], entry: args['--entry'] ?? 'Main.lean' });
    if (args['--dry-run']) console.log(JSON.stringify({ dry_run: true, ...plan }, null, 2));
    else {
      const result = executeRestricted(plan);
      console.log(JSON.stringify(result));
      if (result.exit_code !== 0) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
