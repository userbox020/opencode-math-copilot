import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULTS, options, validateOutput, copyFixture, retryableTimeout, main, cli } from '../checker-smoke.mjs';
import { sha256 } from '../lib.mjs';

// All fixture/output writes are in memory. No subprocess, Docker, real fixture,
// provider, or filesystem writes are used by these tests.
function memoryFS() {
  const entries = new Map();
  const key = file => path.resolve(file);
  const error = code => Object.assign(new Error(code), { code });
  const get = file => { const value = entries.get(key(file)); if (!value) throw error('ENOENT'); return value; };
  const io = {
    entries,
    lstatSync(file) {
      const value = get(file);
      return { isDirectory: () => value.kind === 'dir', isFile: () => value.kind === 'file',
        isSymbolicLink: () => value.kind === 'link' };
    },
    realpathSync(file) {
      const absolute = key(file);
      get(absolute);
      for (let ancestor = absolute; ; ancestor = path.dirname(ancestor)) {
        const entry = entries.get(ancestor);
        if (entry?.kind === 'link') return path.join(entry.target, path.relative(ancestor, absolute));
        if (path.dirname(ancestor) === ancestor) return absolute;
      }
    },
    mkdirSync(file, opts = {}) {
      file = key(file);
      if (entries.has(file)) { if (opts.recursive) return; throw error('EEXIST'); }
      if (opts.recursive && path.dirname(file) !== file) io.mkdirSync(path.dirname(file), opts);
      entries.set(file, { kind: 'dir' });
    },
    readFileSync(file, encoding) { const data = Buffer.from(get(file).data); return encoding ? data.toString(encoding) : data; },
    writeFileSync(file, data, opts = {}) {
      if (opts.flag === 'wx' && entries.has(key(file))) throw error('EEXIST');
      entries.set(key(file), { kind: 'file', data: Buffer.from(data) });
    },
    copyFileSync(from, to) { io.writeFileSync(to, io.readFileSync(from)); },
    cpSync(from, to) {
      const source = key(from);
      for (const [name, value] of [...entries]) if (name === source || name.startsWith(source + path.sep)) {
        entries.set(key(path.join(to, path.relative(source, name))), structuredClone(value));
      }
    },
    rmSync(file) {
      const target = key(file);
      for (const name of entries.keys()) if (name === target || name.startsWith(target + path.sep)) entries.delete(name);
    },
    renameSync(from, to) { get(from); io.cpSync(from, to); io.rmSync(from); },
    readdirSync(file) { get(file); return [...entries.keys()].filter(name => name !== key(file) && path.dirname(name) === key(file)).map(name => path.basename(name)); },
  };
  return io;
}

const put = (io, file, data) => io.writeFileSync(file, JSON.stringify(data));
const read = (io, file) => JSON.parse(io.readFileSync(file, 'utf8'));
const TASK = 'lean-cancellation-repair';
const ID = `operator_checker_cli_positive.${TASK}.r1.fixture.plugin-off`;
function harness() {
  const io = memoryFS(), base = path.resolve(DEFAULTS.tempRoot);
  const config = { ...DEFAULTS, tempRoot: base, fixtureRoot: path.join(base, 'fixture'),
    buildReceipt: path.join(base, 'build.json'), gradeFile: path.join(base, 'grade.mjs'), adapterFile: path.join(base, 'adapter.mjs') };
  io.mkdirSync(base, { recursive: true });
  io.mkdirSync(path.join(config.fixtureRoot, 'captured-synthetic', 'episodes'), { recursive: true });
  io.mkdirSync(path.join(config.fixtureRoot, 'captured-synthetic', 'evaluation'), { recursive: true });
  put(io, path.join(config.fixtureRoot, 'captured-synthetic', 'evaluation', 'stale.json'), { stale: true });
  put(io, path.join(config.fixtureRoot, 'captured-synthetic', 'manifest.json'), {
    run_id: 'operator_checker_cli_positive', model: 'fixture/no-provider-call', schedule: [{ episode_id: ID }],
  });
  put(io, path.join(config.fixtureRoot, 'captured-synthetic', 'episodes', `${ID}.json`), {
    episode_id: ID, task_id: TASK, model: 'fixture/no-provider-call', status: 'completed',
    fixture_kind: 'operator positive control; synthetic capture, not a model solve',
  });
  put(io, path.join(config.fixtureRoot, 'evaluator-gold.json'), []);
  io.writeFileSync(config.gradeFile, '// synthetic grade source');
  io.writeFileSync(config.adapterFile, '// synthetic adapter source');
  const policy = { schema: 'real-use-checker-policy/v1', theorem: 'synthetic' };
  const request = { schema: 'real-use-checker-request/v1', code: '#check Nat\n', code_sha256: sha256('#check Nat\n'), policy, policy_sha256: sha256(policy) };
  const image = letter => `sha256:${letter.repeat(64)}`;
  const build = { schema: 'eval-checker-build/v1', status: 'images_built',
    runtime_image_id: image('a'), core_image_id: image('b'), export_worker_image_id: image('c'), checker_image_id: image('d'),
    source_hashes: { 'bench/v4/real-use/checker-adapter.mjs': sha256(io.readFileSync(config.adapterFile)) },
    challenges: { [TASK]: { policy_sha256: request.policy_sha256, challenge_source_sha256: sha256('source'), challenge_export_sha256: sha256('export') } },
  };
  put(io, config.buildReceipt, build);
  const binding = { code_sha256: request.code_sha256, policy_sha256: request.policy_sha256 };
  const checker = { status: 'accepted', ...binding };
  const outcome = (status, image) => ({ status, image, cleanup: 'confirmed_absent', exit_code: 0,
    signal: null, failure: null, state: { Running: false, ExitCode: 0, OOMKilled: false } });
  const receipt = { schema: 'real-use-checker-receipt/v1', task_id: TASK, status: 'accepted', evidence: 'local-docker',
    ...binding, adapter_sha256: build.source_hashes['bench/v4/real-use/checker-adapter.mjs'],
    ...build.challenges[TASK], images: { runtime: image('a'), core: image('b'), export: image('c'), checker: image('d') },
    cleanup: 'confirmed_absent', outcomes: { export: outcome('exported', image('c')), check: outcome('accepted', image('d')) } };
  const data = { result: { episode_id: ID, blind_id: 'blind-id', checker: { ...checker }, receipt },
    requestRecord: { episode_id: ID, request }, blind: { schema: 'real-use-blind/v1', blind_id: 'blind-id',
      task: { id: TASK }, checker_required: true, candidate_status: 'candidate', checker: { ...checker }, checker_binding: binding } };
  const calls = [], delays = [], printed = [], out = path.join(base, 'fresh-smoke');
  function emit(root, packet = data) {
    io.mkdirSync(path.join(root, 'captured-synthetic', 'evaluation', 'private'), { recursive: true });
    io.mkdirSync(path.join(root, 'private-checker-work'));
    put(io, path.join(root, 'captured-synthetic', 'evaluation', 'private', 'checker-results.json'), [packet.result]);
    put(io, path.join(root, 'captured-synthetic', 'evaluation', 'private', 'checker-requests.json'), [packet.requestRecord]);
    put(io, path.join(root, 'captured-synthetic', 'evaluation', 'blind.json'), [packet.blind]);
  }
  const dependencies = { io, config, print: text => printed.push(text), sleep: async ms => { delays.push(ms); },
    runner: async invocation => { calls.push(invocation); emit(invocation.root); return { code: 0, signal: null, providerCalls: 0 }; } };
  return { io, config, out, data, calls, delays, printed, emit, dependencies };
}

function unavailable(data, role = 'export', reason = 'timeout') {
  const copy = structuredClone(data);
  copy.result.receipt.status = 'unavailable';
  copy.result.checker.status = copy.blind.checker.status = 'grader_unavailable';
  copy.blind.candidate_status = 'pending_rubric';
  Object.assign(copy.result.receipt.outcomes[role], { status: 'unavailable', reason, failure: reason, exit_code: null });
  if (role === 'export') copy.result.receipt.outcomes.check = null;
  return copy;
}

test('strict options, defaults, integer boundaries and duplicates', () => {
  assert.deepEqual(options(['--out', 'x']), { out: 'x', attempts: 2, retryDelayMs: 5000 });
  for (const args of [[], ['--unknown', 'x'], ['--out'], ['--out', 'x', '--out', 'y'],
    ...['0', '-1', '1.5', 'Infinity', '9007199254740992'].map(value => ['--out', 'x', '--attempts', value]),
    ['--out', 'x', '--retry-delay-ms', '-1']]) assert.throws(() => options(args));
  assert.equal(options(['--out', 'x', '--attempts', '3', '--retry-delay-ms', '0']).retryDelayMs, 0);
});

test('absolute approved fresh paths only, including existing empty roots and junction escapes', () => {
  const h = harness(), deps = { io: h.io, tempRoot: h.config.tempRoot };
  assert.equal(validateOutput(h.out, deps), h.out);
  for (const out of ['relative', h.config.tempRoot, path.resolve(h.config.tempRoot, '..', 'outside'),
    path.join(h.config.tempRoot, '..') + '/escape', h.out + '\0']) assert.throws(() => validateOutput(out, deps));
  h.io.mkdirSync(h.out);
  assert.throws(() => validateOutput(h.out, deps), /already exists/);
  const linked = path.join(h.config.tempRoot, 'redirect');
  h.io.entries.set(linked, { kind: 'link', target: path.resolve(h.config.tempRoot, '..', 'outside') });
  assert.throws(() => validateOutput(path.join(linked, 'fresh'), deps), /escapes/);
});

test('copy retains fixture inputs, strips evaluation only from copy, never mutates source', () => {
  const h = harness(), before = [...h.io.entries].map(([file, value]) => [file, structuredClone(value)]);
  copyFixture(h.out, { io: h.io, fixtureRoot: h.config.fixtureRoot });
  assert.ok(h.io.lstatSync(path.join(h.out, 'evaluator-gold.json')).isFile());
  assert.ok(h.io.lstatSync(path.join(h.out, 'captured-synthetic', 'manifest.json')).isFile());
  assert.throws(() => h.io.lstatSync(path.join(h.out, 'captured-synthetic', 'evaluation')), /ENOENT/);
  for (const [file, value] of before) assert.deepEqual(structuredClone(h.io.entries.get(file)), value);
});

test('success produces exact summary keys, canonical absolute layout, flags and actual hashes', async () => {
  const h = harness(), result = await main(['--out', h.out], h.dependencies);
  assert.equal(result.exit_code, 0);
  assert.equal(result.attempt_count, 1);
  const summary = read(h.io, path.join(h.out, 'smoke-summary.json'));
  assert.deepEqual(Object.keys(summary).sort(), ['schema', 'fixture', 'cli_exit', 'checker_status', 'code_sha256',
    'policy_sha256', 'images', 'adapter_sha256', 'grade_source_sha256', 'build_receipt', 'build_receipt_sha256',
    'private_result', 'blind_packet', 'checker_work', 'cleanup', 'no_provider_calls'].sort());
  assert.equal(summary.schema, 'real-use-grade-cli-smoke/v1');
  assert.equal(summary.fixture, 'operator gold positive; synthetic captured episode; NOT a model solve or study score');
  for (const field of ['build_receipt', 'private_result', 'blind_packet', 'checker_work']) assert.ok(path.isAbsolute(summary[field]));
  assert.equal(summary.private_result, path.join(h.out, 'captured-synthetic/evaluation/private/checker-results.json'));
  assert.equal(summary.blind_packet, path.join(h.out, 'captured-synthetic/evaluation/blind.json'));
  assert.equal(summary.checker_work, path.join(h.out, 'private-checker-work'));
  assert.equal(summary.build_receipt_sha256, sha256(h.io.readFileSync(h.config.buildReceipt)));
  assert.equal(summary.grade_source_sha256, sha256(h.io.readFileSync(h.config.gradeFile)));
  assert.deepEqual(summary.images, h.data.result.receipt.images);
  assert.equal(summary.no_provider_calls, true);
  const flags = Object.fromEntries(h.calls[0].args.reduce((pairs, item, i, all) => i % 2 ? pairs : [...pairs, [item, all[i + 1]]], []));
  assert.deepEqual(flags, { '--checker-build-receipt': h.config.buildReceipt,
    '--checker-work-dir': path.join(h.out, 'attempt-1/private-checker-work'), '--docker-executable': h.config.dockerExecutable,
    '--corpus-root': h.config.corpusRoot, '--gold': path.join(h.out, 'attempt-1/evaluator-gold.json'),
    '--out': path.join(h.out, 'attempt-1/captured-synthetic') });
  assert.deepEqual(Object.keys(result.artifacts), ['summary', 'results', 'requests', 'blind']);
  for (const artifact of Object.values(result.artifacts)) assert.equal(artifact.sha256, sha256(h.io.readFileSync(artifact.path)));
  assert.deepEqual(read(h.io, path.join(h.out, 'checker-smoke-result.json')), result);
  assert.equal(JSON.parse(h.printed[0]).attempt_count, 1);
});

for (const role of ['export', 'check']) test(`${role} timeout with confirmed cleanup retries in fresh copy with backoff`, async () => {
  const h = harness();
  h.dependencies.runner = async invocation => {
    h.calls.push(invocation);
    assert.throws(() => h.io.lstatSync(path.join(invocation.root, 'captured-synthetic/evaluation')), /ENOENT/);
    h.emit(invocation.root, invocation.attempt === 1 ? unavailable(h.data, role) : h.data);
    return { code: 0, signal: null, providerCalls: 0 };
  };
  const result = await main(['--out', h.out, '--retry-delay-ms', '7'], h.dependencies);
  assert.equal(result.exit_code, 0);
  assert.equal(result.attempt_count, 2);
  assert.deepEqual(h.delays, [7]);
  assert.equal(result.attempts[0].failure, 'checker_transport_timeout');
  assert.ok(h.io.lstatSync(path.join(h.out, 'attempt-1/captured-synthetic/evaluation')).isDirectory());
  assert.notEqual(h.calls[0].root, h.calls[1].root);
});

test('timeout attempt limit stops with failure evidence and no summary', async () => {
  const h = harness();
  h.dependencies.runner = async invocation => {
    h.calls.push(invocation); h.emit(invocation.root, unavailable(h.data));
    return { code: 0, providerCalls: 0 };
  };
  assert.equal(await cli(['--out', h.out, '--attempts', '3', '--retry-delay-ms', '0'], h.dependencies), 1);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.delays, [0, 0]);
  assert.throws(() => h.io.readFileSync(path.join(h.out, 'smoke-summary.json')), /ENOENT/);
  assert.equal(read(h.io, path.join(h.out, 'checker-smoke-result.json')).attempts.length, 3);
});

test('non-timeouts and unconfirmed cleanup never qualify for retry', () => {
  const h = harness();
  for (const reason of ['compile_export_failed', 'transport_error', 'worker_process_failure', 'cleanup_unconfirmed']) {
    assert.equal(retryableTimeout(unavailable(h.data, 'export', reason).result.receipt), false);
  }
  const timeout = unavailable(h.data).result.receipt;
  timeout.outcomes.export.cleanup = 'unconfirmed';
  assert.equal(retryableTimeout(timeout), false);
  timeout.outcomes.export.cleanup = 'confirmed_absent';
  timeout.cleanup = 'unconfirmed';
  assert.equal(retryableTimeout(timeout), false);
});

for (const [name, mutate] of [
  ['non-timeout failure', (data) => Object.assign(data, unavailable(data, 'export', 'compile_export_failed'))],
  ['unconfirmed timeout cleanup', data => { Object.assign(data, unavailable(data)); data.result.receipt.cleanup = 'unconfirmed'; }],
  ['nonzero CLI exit', (data, run) => { run.code = 1; }],
  ['CLI signal', (data, run) => { run.signal = 'SIGTERM'; }],
  ['provider call', (data, run) => { run.providerCalls = 1; }],
  ['not accepted', data => { data.result.receipt.status = 'rejected'; }],
  ['export cleanup', data => { data.result.receipt.outcomes.export.cleanup = 'unconfirmed'; }],
  ['check cleanup', data => { data.result.receipt.outcomes.check.cleanup = 'unconfirmed'; }],
  ['image mismatch', data => { data.result.receipt.images.core = `sha256:${'f'.repeat(64)}`; }],
  ['policy mismatch', data => { data.requestRecord.request.policy_sha256 = '0'.repeat(64); }],
  ['binding mismatch', data => { data.blind.checker_binding.code_sha256 = '0'.repeat(64); }],
  ['worker running', data => { data.result.receipt.outcomes.check.state.Running = true; }],
  ['timeout with unrelated image mismatch', data => {
    Object.assign(data, unavailable(data)); data.result.receipt.images.export = `sha256:${'f'.repeat(64)}`;
  }],
]) test(`${name}: exits nonzero, no summary, no retry`, async () => {
  const h = harness();
  h.dependencies.runner = async invocation => {
    h.calls.push(invocation);
    const data = structuredClone(h.data), run = { code: 0, signal: null, providerCalls: 0 };
    mutate(data, run); h.emit(invocation.root, data); return run;
  };
  assert.equal(await cli(['--out', h.out], h.dependencies), 1);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
  assert.throws(() => h.io.readFileSync(path.join(h.out, 'smoke-summary.json')), /ENOENT/);
  assert.equal(read(h.io, path.join(h.out, 'checker-smoke-result.json')).attempts[0].retryable, false);
});

test('extra graded episode fails acceptance without retry or summary', async () => {
  const h = harness();
  h.dependencies.runner = async invocation => {
    h.calls.push(invocation); h.emit(invocation.root);
    put(h.io, path.join(invocation.root, 'captured-synthetic/evaluation/private/checker-results.json'),
      [h.data.result, h.data.result]);
    return { code: 0, signal: null, providerCalls: 0 };
  };
  assert.equal(await cli(['--out', h.out], h.dependencies), 1);
  assert.equal(h.calls.length, 1);
  assert.throws(() => h.io.readFileSync(path.join(h.out, 'smoke-summary.json')), /ENOENT/);
});

test('missing timeout evidence and runner errors stop immediately', async () => {
  for (const throws of [false, true]) {
    const h = harness();
    h.dependencies.runner = async invocation => {
      h.calls.push(invocation);
      if (throws) throw new Error('timeout');
      return { code: 1, signal: null, providerCalls: 0, stderr: 'checker export timeout' };
    };
    assert.equal(await cli(['--out', h.out], h.dependencies), 1);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.delays, []);
    assert.throws(() => h.io.readFileSync(path.join(h.out, 'smoke-summary.json')), /ENOENT/);
  }
});

test('existing nonempty output and invalid arguments spawn nothing and write nothing', async () => {
  const h = harness();
  h.io.mkdirSync(h.out); h.io.writeFileSync(path.join(h.out, 'preserve.txt'), 'original');
  const before = h.io.entries.size;
  assert.equal(await cli(['--out', h.out], h.dependencies), 1);
  assert.equal(await cli(['--out', 'relative'], h.dependencies), 1);
  assert.equal(await cli(['--out', h.out, '--attempts', '0'], h.dependencies), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.io.entries.size, before);
  assert.equal(h.io.readFileSync(path.join(h.out, 'preserve.txt'), 'utf8'), 'original');
});
