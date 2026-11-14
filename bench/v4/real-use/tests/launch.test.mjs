import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import childProcess, { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { runOwned, createOwnedLauncher } from '../trusted-launch.mjs';

const windows = process.platform === 'win32';
const tempRoot = process.env.OWNED_LAUNCH_TEST_TEMP ?? 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode';
const launcherUrl = new URL('../trusted-launch.mjs', import.meta.url).href;
const fixtureSource = `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const [role, dir, mode] = process.argv.slice(2);
fs.writeFileSync(path.join(dir, role + '.pid'), String(process.pid), {flag:'wx'});
if (role === 'grandchild') {
  fs.writeFileSync(path.join(dir, 'owned-marker'), 'owned fixture only', {flag:'wx'});
  setInterval(() => {}, 1000);
} else {
  const next = role === 'root' ? 'child' : 'grandchild';
  cp.spawn(process.execPath, [__filename, next, dir, mode], {stdio:'inherit', env:process.env});
  const wait = setInterval(() => {
    if (!fs.existsSync(path.join(dir, 'owned-marker'))) return;
    clearInterval(wait);
    if (role === 'root') {
      process.stdout.write('READY ' + JSON.stringify(process.argv.slice(5)) + '\\n');
      process.stderr.write('stderr: \\u211d \\u03bb\\n');
      if (mode === 'normal') setTimeout(() => process.exit(7), 120);
    }
  }, 10);
  setInterval(() => {}, 1000);
}
`;
function fixture() {
  const directory = mkdtempSync(path.join(tempRoot, 'owned-test-'));
  const script = path.join(directory, 'fixture.cjs');
  writeFileSync(script, fixtureSource, { flag: 'wx', mode: 0o600 });
  const options = { executable: process.execPath, args: [script, 'root', directory, 'normal'], cwd: directory,
    env: { SystemRoot: process.env.SystemRoot, FIXTURE_ONLY: 'explicit-ℝ' }, timeoutMs: 4000,
    owner: 'owned-launch-test', tempRoot: directory };
  return { directory, script, options, remove: () => rmSync(directory, { recursive: true, force: false, maxRetries: 10, retryDelay: 50 }) };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function until(check, ms = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('fixture deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function assertReaped(directory) {
  const pids = ['root', 'child', 'grandchild'].map(role => Number(readFileSync(path.join(directory, role + '.pid'), 'utf8')));
  for (const pid of pids) assert.equal(alive(pid), false, `owned PID ${pid} survived`);
  assert.equal(readFileSync(path.join(directory, 'owned-marker'), 'utf8'), 'owned fixture only');
}
function assertReceipt(result) {
  assert.equal(result.spawn_error, null, JSON.stringify(result));
  assert.equal(result.cleanup.confirmed, true, JSON.stringify(result));
  assert.equal(result.cleanup.files_removed, true);
  assert.equal(result.ownership.job_assigned, true);
  assert.equal(result.ownership.kill_on_close, true);
  assert.equal(typeof result.ownership.enclosing_job_present, 'boolean');
  assert.equal(result.ownership.breakaway_allowed, false);
  assert.equal(result.cleanup.active_processes, 0);
  assert.match(result.ownership_sha256, /^[a-f0-9]{64}$/);
}

for (const mode of ['normal', 'timeout', 'abort']) {
  test(`actual Windows job: ${mode}, nested descendants, UTF-8 and raw streams`, { skip: !windows, timeout: 30000 }, async t => {
    const f = fixture();
    const controller = new AbortController();
    const args = ['ℝ λ 😀', 'a "quoted" word', '', 'space here', 'trailing\\', '\\"mixed'];
    f.options.args[3] = mode;
    f.options.args.push(...args);
    f.options.timeoutMs = mode === 'timeout' ? 1000 : 4000;
    const stdout = [], stderr = [];
    let observedLive = false;
    let handle;
    try {
      handle = createOwnedLauncher(f.options, { signal: controller.signal,
        onStdout: chunk => {
          stdout.push(chunk);
          if (Buffer.concat(stdout).toString('utf8').includes('READY ')) {
            observedLive = alive(Number(readFileSync(path.join(f.directory, 'root.pid'), 'utf8')));
            if (mode === 'abort') controller.abort();
          }
        }, onStderr: chunk => stderr.push(chunk) });
      const result = await handle.closed;
      assertReceipt(result);
      t.diagnostic(`enclosing_job_present=${result.ownership.enclosing_job_present}; assigned_before_resume=true; active_after=0`);
      assert.equal(observedLive, true, 'output must stream before close');
      assert.equal(Buffer.concat(stdout).toString('utf8'), `READY ${JSON.stringify(args)}\n`);
      assert.equal(Buffer.concat(stderr).toString('utf8'), 'stderr: ℝ λ\n');
      assert.equal(result.timeout, mode === 'timeout');
      if (mode === 'normal') assert.equal(result.exit_code, 7);
      if (mode === 'abort') assert.equal(result.signal, 'ABORT');
      assertReaped(f.directory);
      assert.equal(readdirSync(f.directory).some(name => name.startsWith('owned-job-')), false);
    } finally { await handle?.cleanupOwned(); f.remove(); }
  });
}

test('actual Windows job: missing executable fails without leaked process', { skip: !windows, timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const result = await runOwned({ ...f.options, executable: path.join(f.directory, 'missing.exe') });
    assert.equal(result.spawn_error, 'CreateProcessW');
    assert.equal(result.ownership.win32_error, 2);
    assert.equal(result.ownership.pid, null);
    assert.equal(result.ownership.job_assigned, false);
    assert.equal(result.cleanup.confirmed, true);
    assert.equal(result.cleanup.active_processes, 0);
    assert.equal(existsSync(path.join(f.directory, 'root.pid')), false);
  } finally { f.remove(); }
});

test('actual Windows job: explicit environment only and no stream framing', { skip: !windows, timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const stdout = [], stderr = [];
    const result = await runOwned({ ...f.options, args: ['-e',
      'process.stdout.write(JSON.stringify(process.env));process.stderr.write(Buffer.from([0,255,10,13]));'],
      env: { SystemRoot: process.env.SystemRoot, ONLY_TEST_VALUE: 'ℝ " spaces' } }, {
      onStdout: bytes => stdout.push(bytes), onStderr: bytes => stderr.push(bytes),
    });
    assertReceipt(result);
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString('utf8')), { SystemRoot: process.env.SystemRoot, ONLY_TEST_VALUE: 'ℝ " spaces' });
    assert.deepEqual(Buffer.concat(stderr), Buffer.from([0, 255, 10, 13]));
  } finally { f.remove(); }
});

test('actual Windows job: evaluator death closes cancellation pipe and reaps descendants', { skip: !windows, timeout: 30000 }, async () => {
  const f = fixture();
  let evaluator;
  try {
    f.options.args[3] = 'parent-death';
    f.options.timeoutMs = 15000;
    evaluator = spawn(process.execPath, ['--input-type=module', '-e',
      `import {createOwnedLauncher} from ${JSON.stringify(launcherUrl)};
       import {writeFileSync} from 'node:fs';
       const handle = createOwnedLauncher(${JSON.stringify(f.options)});
       writeFileSync(${JSON.stringify(path.join(f.directory, 'helper.pid'))}, String(handle.child.pid), {flag:'wx'});
       await handle.closed;`],
    { cwd: f.directory, env: { SystemRoot: process.env.SystemRoot }, stdio: 'ignore', shell: false });
    const exit = new Promise(resolve => evaluator.once('exit', resolve));
    await until(() => existsSync(path.join(f.directory, 'owned-marker')));
    evaluator.kill(); // This exact test-created evaluator, never PID/name discovery.
    await exit;
    await until(() => ['root', 'child', 'grandchild'].every(role => !alive(Number(readFileSync(path.join(f.directory, role + '.pid'), 'utf8')))));
    assertReaped(f.directory);
    // With the evaluator gone, PowerShell can exit on a broken output pipe before
    // writing a receipt. Check its exact recorded PID, not receipt availability.
    await until(() => !alive(Number(readFileSync(path.join(f.directory, 'helper.pid'), 'utf8'))));
  } finally { evaluator?.kill(); f.remove(); }
});

test('actual Windows job: helper death triggers kernel kill-on-close, no false cleanup receipt', { skip: !windows, timeout: 30000 }, async () => {
  const f = fixture();
  let handle;
  try {
    f.options.args[3] = 'helper-death';
    handle = createOwnedLauncher(f.options);
    await until(() => existsSync(path.join(f.directory, 'owned-marker')));
    handle.child.kill();
    const result = await handle.closed;
    assert.equal(result.cleanup.confirmed, false);
    assert.equal(result.spawn_error, 'helper_receipt_missing');
    await until(() => ['root', 'child', 'grandchild'].every(role => !alive(Number(readFileSync(path.join(f.directory, role + '.pid'), 'utf8')))));
    assertReaped(f.directory);
  } finally { await handle?.cleanupOwned(); f.remove(); }
});

test('actual Windows job: full byte streams exceed pipe capacity without framing or truncation', { skip: !windows, timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const stdout = [], stderr = [];
    const result = await runOwned({ ...f.options, args: ['-e',
      'const b=Buffer.alloc(262144);for(let i=0;i<b.length;i++)b[i]=i%256;process.stdout.write(b);process.stderr.write(b);'] },
    { onStdout: bytes => stdout.push(bytes), onStderr: bytes => stderr.push(bytes) });
    assertReceipt(result);
    const expected = Buffer.alloc(262144);
    for (let i = 0; i < expected.length; i++) expected[i] = i % 256;
    assert.deepEqual(Buffer.concat(stdout), expected);
    assert.deepEqual(Buffer.concat(stderr), expected);
  } finally { f.remove(); }
});

test('trusted options reject NUL/relative paths/ambiguous env before spawning; pre-abort does not spawn', { skip: !windows }, async () => {
  const f = fixture();
  try {
    for (const overrides of [{ executable: 'node.exe' }, { executable: 'C:\\Windows\\System32\\cmd.exe' }, { cwd: 'C:relative' }, { args: ['bad\0arg'] },
      { env: { X: 'a\0b' } }, { env: { Path: 'x', PATH: 'y' } }, { timeoutMs: 0 }, { owner: '../unsafe' }, { shell: true }]) {
      assert.throws(() => createOwnedLauncher({ ...f.options, ...overrides }));
    }
    const controller = new AbortController(); controller.abort();
    const result = await runOwned(f.options, { signal: controller.signal });
    assert.equal(result.cleanup.confirmed, true);
    assert.equal(result.cleanup.method, 'not-started');
    assert.equal(existsSync(path.join(f.directory, 'root.pid')), false);
    assert.equal(readdirSync(f.directory).some(name => name.startsWith('owned-job-')), false);
  } finally { f.remove(); }
});

test('unsupported platforms fail closed', { skip: windows }, () => {
  assert.throws(() => createOwnedLauncher({}), /unsupported_platform/);
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stdinReader = 'const b=require("node:fs").readFileSync(0);process.stdout.write(JSON.stringify({length:b.length,sha256:require("node:crypto").createHash("sha256").update(b).digest("hex")}));';
for (const [name, payload] of [
  ['small buffer', Buffer.from('fixture stdin')],
  ['spaces quotes newlines leading-dash tokens and trailing LF', Buffer.from('  "quoted words" \'single\'\n-2, -- --model\r\n\tUnicode: ℝ λ 😀\n')],
  ['binary bytes', Buffer.from([0, 255, 13, 10, 32, 34, 45])],
  ['empty buffer', Buffer.alloc(0)],
  ['maximum buffer', Buffer.alloc(1048576, 97)],
  ['absent stdin retains NUL EOF', undefined],
]) {
  test(`actual Windows job stdin: ${name} is byte-exact through EOF and removed`, { skip: !windows, timeout: 30000 }, async () => {
    const f = fixture();
    let handle;
    try {
      const stdout = [], stderr = [];
      handle = createOwnedLauncher({ ...f.options, args: ['-e', stdinReader], ...(payload === undefined ? {} : { stdin: payload }) },
        { onStdout: bytes => stdout.push(bytes), onStderr: bytes => stderr.push(bytes) });
      const owned = readdirSync(f.directory).filter(name => name.startsWith('owned-job-'));
      assert.equal(owned.length, 1);
      const inputPath = path.join(f.directory, owned[0], 'stdin.bin');
      assert.equal(existsSync(inputPath), payload !== undefined);
      if (payload !== undefined) assert.equal(digest(readFileSync(inputPath)), digest(payload));
      const result = await handle.closed;
      assertReceipt(result);
      assert.equal(result.exit_code, 0);
      assert.equal(result.ownership.reason, 'exit');
      const expected = payload ?? Buffer.alloc(0);
      assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString('utf8')), { length: expected.length, sha256: digest(expected) });
      assert.equal(Buffer.concat(stderr).length, 0);
      assert.equal(result.ownership.stdin_sha256, payload === undefined ? undefined : digest(payload));
      assert.equal(existsSync(inputPath), false);
      assert.equal(existsSync(path.dirname(inputPath)), false);
    } finally { await handle?.cleanupOwned(); f.remove(); }
  });
}

test('actual Windows job stdin: matching supplied digest delivers exact bytes', { skip: !windows, timeout: 30000 }, async () => {
  const f = fixture();
  let handle;
  try {
    const stdin = Buffer.from([0, 255, 13, 10, 32, 34, 45, 128]);
    const stdout = [], stderr = [];
    handle = createOwnedLauncher({ ...f.options, stdin, stdin_sha256: digest(stdin),
      args: ['-e', 'process.stdout.write(require("node:fs").readFileSync(0));'] },
    { onStdout: bytes => stdout.push(bytes), onStderr: bytes => stderr.push(bytes) });
    const result = await handle.closed;
    assertReceipt(result);
    assert.equal(result.exit_code, 0);
    assert.equal(result.ownership.stdin_sha256, digest(stdin));
    assert.deepEqual(Buffer.concat(stdout), stdin);
    assert.equal(Buffer.concat(stderr).length, 0);
    assert.equal(readdirSync(f.directory).some(name => name.startsWith('owned-job-')), false);
  } finally { await handle?.cleanupOwned(); f.remove(); }
});

for (const [name, overrides, message] of [
  ['mismatched digest', { stdin: Buffer.from('fixture'), stdin_sha256: digest(Buffer.from('different')) }, 'stdin_sha256: stdin digest mismatch'],
  ['digest without buffer', { stdin_sha256: digest(Buffer.alloc(0)) }, 'stdin_sha256: stdin Buffer required'],
  ...['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '', null, undefined, 123].map(stdin_sha256 =>
    [`malformed digest ${JSON.stringify(stdin_sha256)}`, { stdin: Buffer.from('fixture'), stdin_sha256 }, 'stdin_sha256: 64 lowercase hex characters required']),
  ['unknown key', { stdin: Buffer.from('fixture'), stdin_sha256: digest(Buffer.from('fixture')), unknown: true }, 'unknown launcher option'],
]) {
  test(`stdin validation: ${name} throws before helper spawn or staging`, { skip: !windows }, t => {
    const f = fixture();
    const before = readdirSync(f.directory);
    const mocked = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected_spawn'); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => createOwnedLauncher({ ...f.options, ...overrides }), { name: 'TypeError', message });
      assert.equal(mocked.mock.callCount(), 0);
      assert.deepEqual(readdirSync(f.directory), before);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); f.remove(); }
  });
}

test('stdin bounds and Buffer type are rejected before helper spawn or staging', { skip: !windows }, t => {
  const f = fixture();
  const before = readdirSync(f.directory);
  const mocked = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected_spawn'); });
  syncBuiltinESMExports();
  try {
    for (const stdin of [Buffer.alloc(1048577), 'text', new Uint8Array([1]), null, undefined, {}])
      assert.throws(() => createOwnedLauncher({ ...f.options, stdin }), /stdin: Buffer of at most 1 MiB required/);
    assert.equal(mocked.mock.callCount(), 0);
    assert.deepEqual(readdirSync(f.directory), before);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); f.remove(); }
});

for (const mode of ['tampered', 'missing', 'oversized-file', 'reparse']) {
  test(`actual Windows job stdin: ${mode} fails closed before target spawn`, { skip: !windows, timeout: 30000 }, async t => {
    const f = fixture(), originalSpawn = childProcess.spawn;
    let inputPath, handle;
    const mocked = t.mock.method(childProcess, 'spawn', (executable, args, options) => {
      inputPath = path.join(options.cwd, 'stdin.bin');
      assert.equal(existsSync(inputPath), true);
      if (mode === 'tampered') writeFileSync(inputPath, 'modified fixture');
      if (mode === 'oversized-file') writeFileSync(inputPath, Buffer.alloc(1048577));
      if (mode === 'missing' || mode === 'reparse') rmSync(inputPath);
      if (mode === 'reparse') symlinkSync(f.directory, inputPath, 'junction');
      return originalSpawn(executable, args, options);
    });
    syncBuiltinESMExports();
    try {
      const stdout = [], stderr = [];
      handle = createOwnedLauncher({ ...f.options, stdin: Buffer.from('original fixture') },
        { onStdout: bytes => stdout.push(bytes), onStderr: bytes => stderr.push(bytes) });
      mocked.mock.restore(); syncBuiltinESMExports();
      const result = await handle.closed;
      assert.equal(result.spawn_error, 'stdin_rejected');
      assert.equal(result.ownership.reason, 'stdin_rejected');
      assert.equal(result.ownership.pid, null);
      assert.equal(result.ownership.job_assigned, false);
      assert.equal(result.exit_code, null);
      assert.equal(result.cleanup.confirmed, true);
      assert.equal(result.cleanup.active_processes, 0);
      assert.equal(result.cleanup.files_removed, true);
      assert.equal(existsSync(path.join(f.directory, 'root.pid')), false);
      assert.equal(Buffer.concat(stdout).length, 0);
      assert.equal(Buffer.concat(stderr).length, 0);
      assert.equal(existsSync(path.dirname(inputPath)), false);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); await handle?.cleanupOwned(); f.remove(); }
  });
}

for (const mode of ['abort', 'timeout']) {
  test(`actual Windows job stdin: file EOF leaves helper ${mode} channel intact`, { skip: !windows, timeout: 30000 }, async () => {
    const f = fixture(), controller = new AbortController();
    let handle;
    try {
      const stdout = [];
      handle = createOwnedLauncher({ ...f.options, stdin: Buffer.from('fixture\n'), timeoutMs: mode === 'timeout' ? 300 : 4000,
        args: ['-e', 'require("node:fs").readFileSync(0);process.stdout.write("READY\\n");setInterval(()=>{},1000);'] },
      { signal: controller.signal, onStdout: bytes => {
        stdout.push(bytes);
        if (mode === 'abort' && Buffer.concat(stdout).toString() === 'READY\n') controller.abort();
      } });
      const result = await handle.closed;
      assertReceipt(result);
      assert.equal(Buffer.concat(stdout).toString(), 'READY\n');
      assert.equal(result.ownership.reason, mode === 'abort' ? 'cancel' : 'timeout');
      assert.equal(result.timeout, mode === 'timeout');
      if (mode === 'abort') assert.equal(result.signal, 'ABORT');
      assert.equal(alive(result.ownership.pid), false);
      assert.equal(readdirSync(f.directory).some(name => name.startsWith('owned-job-')), false);
    } finally { await handle?.cleanupOwned(); f.remove(); }
  });
}
