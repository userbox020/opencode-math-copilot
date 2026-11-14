// Evaluator-only process boundary. Never pass model/tool-supplied options here.
// The caller must freeze the trusted executable, argv, cwd and environment policy.
// This owns processes; it is NOT a filesystem, credential or network sandbox.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows-job.ps1', import.meta.url));
const DEFAULT_TEMP = 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode';
const STARTUP_MS = 15000;
const CLEANUP_MS = 5000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function text(value, label) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${label}: NUL-free string required`);
  return value;
}
function absolute(value, label) {
  text(value, label);
  // Refuse relative, drive-relative, UNC/device and alternate-stream paths.
  if (!/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f:*?"<>|]/.test(value.slice(2))) {
    throw new TypeError(`${label}: absolute local Windows path required`);
  }
  return path.win32.normalize(value);
}
function validate(options) {
  if (!options || typeof options !== 'object') throw new TypeError('trusted options required');
  const keys = ['executable', 'args', 'cwd', 'env', 'timeoutMs', 'owner', 'tempRoot', 'stdin', 'stdin_sha256'];
  if (Object.keys(options).some(key => !keys.includes(key))) throw new TypeError('unknown launcher option');
  if (Object.hasOwn(options, 'stdin') && (!Buffer.isBuffer(options.stdin) || options.stdin.length > 1048576)) {
    throw new TypeError('stdin: Buffer of at most 1 MiB required');
  }
  if (Object.hasOwn(options, 'stdin_sha256')) {
    if (typeof options.stdin_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.stdin_sha256)) {
      throw new TypeError('stdin_sha256: 64 lowercase hex characters required');
    }
    if (!Object.hasOwn(options, 'stdin')) throw new TypeError('stdin_sha256: stdin Buffer required');
    if (options.stdin_sha256 !== createHash('sha256').update(options.stdin).digest('hex')) {
      throw new TypeError('stdin_sha256: stdin digest mismatch');
    }
  }
  const executable = absolute(options.executable, 'executable');
  if (!/\.exe$/i.test(executable)) throw new TypeError('executable: trusted .exe required (no shell scripts)');
  if (/^(cmd|powershell|pwsh|wscript|cscript|mshta)\.exe$/i.test(path.win32.basename(executable))) {
    throw new TypeError('executable: command interpreters are not launcher entrypoints');
  }
  if (!Array.isArray(options.args)) throw new TypeError('args: array required');
  const args = options.args.map(arg => text(arg, 'argument'));
  // Windows CreateProcessW has a 32767 UTF-16 code-unit command-line limit.
  if (args.reduce((n, arg) => n + 2 * arg.length + 3, executable.length + 3) > 32766) {
    throw new TypeError('command line too long');
  }
  const cwd = absolute(options.cwd, 'cwd');
  if (!statSync(cwd).isDirectory()) throw new TypeError('cwd: directory required');
  const env = options.env;
  if (!env || typeof env !== 'object' || Array.isArray(env) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(env))) throw new TypeError('env: explicit whitelist object required');
  const seen = new Set();
  const entries = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seen.has(key.toUpperCase())) throw new TypeError('env: invalid/duplicate key');
    seen.add(key.toUpperCase());
    return [key, text(value, 'environment value')];
  }).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase(), 'en'));
  if (entries.reduce((n, [key, value]) => n + key.length + value.length + 2, 1) > 32767) throw new TypeError('environment too long');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86400000) {
    throw new TypeError('timeoutMs: integer in 1..86400000 required');
  }
  if (typeof options.owner !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(options.owner)) throw new TypeError('owner: safe identifier required');
  const tempRoot = absolute(options.tempRoot ?? DEFAULT_TEMP, 'tempRoot');
  if (!statSync(tempRoot).isDirectory()) throw new TypeError('tempRoot: existing directory required');
  return { executable, args, cwd, env: Object.fromEntries(entries), timeoutMs: options.timeoutMs, owner: options.owner, tempRoot,
    stdin: Object.hasOwn(options, 'stdin') ? Buffer.from(options.stdin) : undefined };
}

/**
 * Buffers are forwarded unchanged: no decoding, JSON framing, truncation or capture.
 * onStdout/onStderr must consume synchronously (the caller owns capture/backpressure).
 * closed never rejects for a process failure. Invalid configuration throws before spawn.
 * Unsupported platforms fail closed; there is deliberately no unowned spawn fallback.
 */
export function createOwnedLauncher(options, { onStdout = () => {}, onStderr = () => {}, signal } = {}) {
  if (process.platform !== 'win32') throw new Error('owned_launcher_unsupported_platform: Windows Job Object required');
  const { stdin, ...config } = validate(options);
  const stdinHash = stdin === undefined ? undefined : createHash('sha256').update(stdin).digest('hex');
  if (typeof onStdout !== 'function' || typeof onStderr !== 'function') throw new TypeError('stream callbacks required');
  if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw new TypeError('AbortSignal required');
  const status = { phase: 'starting', helper_pid: null, pid: null, owner: config.owner };
  if (signal?.aborted) {
    const result = { exit_code: null, signal: 'ABORT', timeout: false, spawn_error: null,
      cleanup: { confirmed: true, method: 'not-started', active_processes: 0 }, ownership: { ...status, phase: 'not-started' } };
    result.ownership_sha256 = hash(result.ownership);
    const closed = Promise.resolve(result);
    return { child: null, closed, cleanupOwned: () => closed, status: result.ownership };
  }
  const systemRoot = absolute(process.env.SystemRoot ?? 'C:\\Windows', 'SystemRoot');
  const directory = mkdtempSync(path.join(config.tempRoot, 'owned-job-'));
  const identity = lstatSync(directory);
  const receiptPath = path.join(directory, 'receipt.json');
  const nonce = randomUUID();
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // No host auth/config environment is inherited, even by the trusted helper.
  const helperEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: directory, TMP: directory };
  let child;
  let spawnError = null;
  let cancelReason = null;
  let finished = false;
  let watchdog;
  let killDeadline;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  function removeDirectory() {
    try {
      const current = lstatSync(directory);
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink()) return false;
      rmSync(directory, { recursive: true, force: false, maxRetries: 10, retryDelay: 50 });
      return true;
    } catch { return false; }
  }
  function finish(helperCode, helperSignal, forced = false) {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    clearTimeout(killDeadline);
    signal?.removeEventListener('abort', abort);
    let receipt = null;
    try {
      const info = lstatSync(receiptPath);
      if (info.isFile() && !info.isSymbolicLink() && info.size < 16384) receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (receipt?.nonce !== nonce || receipt?.helper_pid !== child?.pid) receipt = null;
    } catch { /* Missing evidence is explicitly unconfirmed, never inferred from exit. */ }
    const ownership = { owner: config.owner, helper_pid: child?.pid ?? null, pid: receipt?.pid ?? null,
      job_assigned: receipt?.job_assigned === true, kill_on_close: receipt?.kill_on_close === true,
      enclosing_job_present: receipt?.enclosing_job_present ?? null,
      job_assignment: 'atomic-createprocess-job-list; suspended-before-resume',
      breakaway_allowed: false, handle_inheritance: 'explicit-stdio-only',
      active_processes_before_cleanup: receipt?.active_before ?? null,
      active_processes_after_cleanup: receipt?.active_after ?? null,
      reason: receipt?.reason ?? cancelReason ?? 'helper-failed', win32_error: receipt?.win32_error ?? null,
       helper_exit_code: helperCode, helper_signal: helperSignal, encoding: 'UTF-8 stdin JSON; raw stdout/stderr bytes; UTF-16 Win32 argv/env',
       ...(stdinHash === undefined ? {} : { stdin_sha256: stdinHash }) };
    status.phase = 'closed';
    status.pid = ownership.pid;
    const confirmed = !forced && helperCode === 0 && receipt?.cleanup_confirmed === true;
    const filesRemoved = removeDirectory();
    resolveClosed({ exit_code: receipt?.exit_code ?? null,
      signal: cancelReason === 'abort' || receipt?.reason === 'cancel' ? 'ABORT' : helperSignal ?? null,
      timeout: receipt?.reason === 'timeout' || cancelReason === 'watchdog',
      spawn_error: spawnError ?? receipt?.spawn_error ?? (!receipt ? 'helper_receipt_missing' : null),
      cleanup: { confirmed, method: 'windows-job-object', active_processes: receipt?.active_after ?? null,
        files_removed: filesRemoved, error: confirmed ? null : 'owned_cleanup_unconfirmed' },
      ownership, ownership_sha256: hash(ownership) });
  }
  function cancel(reason) {
    if (finished || cancelReason) return;
    cancelReason = reason;
    status.phase = 'cancelling';
    // EOF is the helper's cancellation/parent-death channel, never target stdin.
    child?.stdin.end();
    killDeadline = setTimeout(() => {
      // Only this exact owned helper handle; closing its job handle kills members.
      child?.kill();
      child?.stdout.destroy();
      child?.stderr.destroy();
      finish(null, 'SIGTERM', true);
    }, STARTUP_MS + CLEANUP_MS);
  }
  const abort = () => cancel('abort');
  try {
    if (stdin !== undefined) {
      config.stdin_path = path.join(directory, 'stdin.bin');
      config.stdin_sha256 = stdinHash;
      writeFileSync(config.stdin_path, stdin, { flag: 'wx', mode: 0o600 });
    }
    child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], {
      cwd: directory, env: helperEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    status.helper_pid = child.pid ?? null;
    status.phase = 'running';
    child.once('error', error => { spawnError = error.code ?? 'helper_spawn_failed'; finish(null, null); });
    child.once('close', (code, sig) => finish(code, sig));
    child.stdin.on('error', () => { /* close/error delivers authoritative failure */ });
    for (const [stream, callback] of [[child.stdout, onStdout], [child.stderr, onStderr]]) {
      stream.on('data', bytes => {
        try { callback(bytes); } catch { spawnError = 'capture_callback_failed'; cancel('capture-error'); }
      });
    }
    // Credentials are neither read nor merged. Only runner-supplied whitelist values
    // enter the child; config is sent via pipe, never persisted as a request file.
    child.stdin.write(JSON.stringify({ ...config, tempRoot: undefined, nonce, receiptPath, cleanupMs: CLEANUP_MS }) + '\n', 'utf8');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    watchdog = setTimeout(() => cancel('watchdog'), config.timeoutMs + STARTUP_MS + CLEANUP_MS);
  } catch (error) {
    spawnError = error.code ?? 'helper_spawn_failed';
    finish(null, null);
  }
  return { child, closed, cleanupOwned: () => { cancel('abort'); return closed; }, status };
}

export async function runOwned(options, callbacks = {}) {
  return createOwnedLauncher(options, callbacks).closed;
}
