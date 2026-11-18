import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readChallenge, validatePack } from './pack.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

// Resolve existing ancestors, including junctions, without creating anything.
function canonical(filename, io) {
  if (io.existsSync(filename)) return io.realpathSync(filename);
  const parent = path.dirname(filename);
  if (parent === filename) throw new Error(`Cannot resolve path: ${filename}`);
  return path.join(canonical(parent, io), path.basename(filename));
}

export function validateOutDir(out, { repo = REPO_ROOT, corpus, io = fs } = {}) {
  if (!out || !path.isAbsolute(out)) throw new Error('Output directory must be absolute');
  const destination = canonical(path.resolve(out), io);
  if (within(canonical(path.resolve(repo), io), destination) ||
      (corpus && within(canonical(path.resolve(corpus), io), destination))) {
    throw new Error('Output directory must be outside the repository and corpus');
  }
  if (io.existsSync(destination) &&
      (!io.statSync(destination).isDirectory() || io.readdirSync(destination).length)) {
    throw new Error('Output directory must be new or empty');
  }
  return destination;
}

export function parseArgs(args) {
  const options = { execute: false, timeoutMs: 600_000, limit: 8, pack: fileURLToPath(new URL('./tasks.json', import.meta.url)) };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === '--execute') { options.execute = true; continue; }
    if (!['--corpus', '--out', '--pack', '--timeout', '--limit'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
    if (arg === '--timeout' || arg === '--limit') {
      if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid numeric argument: ${arg}`);
      const number = Number(value);
      const max = arg === '--timeout' ? 1800 : 8;
      if (!Number.isSafeInteger(number) || number > max) throw new Error(`Out of bounds: ${arg}`);
      options[arg === '--timeout' ? 'timeoutMs' : 'limit'] = arg === '--timeout' ? number * 1000 : number;
    } else options[arg.slice(2)] = value;
  }
  if (!options.corpus || !path.isAbsolute(options.corpus)) throw new Error('--corpus must be absolute');
  if (!options.out || !path.isAbsolute(options.out)) throw new Error('--out must be absolute');
  return options;
}

export function classify(result) {
  if (result.timedOut) return 'timeout';
  if (result.error || result.unavailable || result.signal ||
      result.protocol !== 'comparator-process-exit/v1' || !Number.isInteger(result.exitCode)) return 'unavailable';
  // Comparator's CLI process exit is the protocol. Never parse success text
  // or apply this rule to a Lean compiler/build/wrapper process.
  return result.exitCode === 0 ? 'accepted' : 'rejected';
}

export function executable(name, env = process.env) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const filename = path.join(directory, name);
    try { fs.accessSync(filename, fs.constants.X_OK); if (fs.statSync(filename).isFile()) return filename; } catch {}
  }
  return null;
}

export function availability() {
  if (process.platform !== 'linux') return 'Native Comparator/landrun require Linux. Run this adapter in a provisioned offline Linux/WSL environment.';
  const missing = ['lake', 'comparator', 'landrun', 'lean4export', 'unshare'].filter(name => !executable(name));
  return missing.length ? `Missing executables on PATH: ${missing.join(', ')}` : null;
}

export function transport({ corpus, task, timeoutMs }) {
  return new Promise(resolve => {
    // A fresh network namespace prevents package/cache downloads. The shell
    // only executes a fixed program and receives the config as a quoted argv.
    // Namespace/setup failure exits 125, not a Comparator rejection.
    const script = 'lake env true >/dev/null 2>&1 || exit 125; printf ready >&3; exec lake env comparator "$1"';
    const child = spawn('unshare', ['--user', '--map-root-user', '--net', '--', 'sh', '-c', script, 'comparator-adapter', task.challenge_path.slice('lean/'.length)], {
      cwd: path.join(corpus, 'lean'), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, error = null, killed = false, ready = '';
    const maxBytes = 8 * 1024 * 1024;
    let bytes = 0;
    function kill() {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); killed = true; } catch (failure) {
        if (failure.code !== 'ESRCH') error = `Process-group cleanup failed: ${failure.message}`;
      }
    }
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    function capture(chunk, stream) {
      bytes += chunk.length;
      if (bytes > maxBytes) { error = 'Output exceeded 8 MiB capture limit'; kill(); return; }
      if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    }
    child.stdout.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(chunk, 'stderr'));
    child.stdio[3].on('data', chunk => { ready = (ready + chunk.toString()).slice(0, 20); });
    child.on('error', failure => { error = failure.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      // Also reap descendants surviving an early parent exit.
      kill();
      resolve({
        protocol: 'comparator-process-exit/v1', exitCode, signal, timedOut, error, stdout, stderr,
        unavailable: ready !== 'ready' || [125, 126, 127].includes(exitCode),
        cleanup: { process_group_kill_sent: killed, complete: !error?.startsWith('Process-group cleanup failed') },
      });
    });
  });
}

export async function run(options, { invoke = transport, checkAvailable = availability, repo = REPO_ROOT } = {}) {
  if (!options.execute) return { status: 'not_run', reason: '--execute is required', retrieval_assisted: true };
  const out = validateOutDir(options.out, { repo, corpus: options.corpus });
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 1_800_000 ||
      !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 8) throw new Error('Invalid execution bounds');
  const pack = validatePack(JSON.parse(fs.readFileSync(options.pack, 'utf8')), options.corpus);
  const unavailable = await checkAvailable();
  fs.mkdirSync(out, { recursive: true });
  const results = { schema: 'comparator-results/v1', retrieval_assisted: true, results: [] };
  for (const task of pack.tasks.slice(0, options.limit)) {
    const started = Date.now();
    const current = readChallenge(options.corpus, task.challenge_path);
    if (current.hash !== task.challenge_sha256) throw new Error(`Hash mismatch before execution: ${task.id}`);
    let response;
    if (unavailable) response = { unavailable: true, error: unavailable, stdout: '', stderr: '', cleanup: { required: false } };
    else {
      try { response = await invoke({ corpus: options.corpus, task, timeoutMs: options.timeoutMs }); }
      catch (error) { response = { error: error.message, stdout: '', stderr: '', cleanup: { complete: false } }; }
    }
    const postHash = readChallenge(options.corpus, task.challenge_path).hash;
    if (postHash !== task.challenge_sha256) throw new Error(`Hash mismatch after execution: ${task.id}`);
    results.results.push({
      id: task.id, status: classify(response), retrieval_assisted: true,
      challenge_path: task.challenge_path, challenge_sha256: current.hash,
      post_challenge_sha256: postHash, duration_ms: Date.now() - started,
      stdout: response.stdout || '', stderr: response.stderr || '',
      exit_code: response.exitCode ?? null, reason: response.error || null,
      cleanup: response.cleanup || { complete: false, reason: 'Transport did not report cleanup' },
    });
    fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await run(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
