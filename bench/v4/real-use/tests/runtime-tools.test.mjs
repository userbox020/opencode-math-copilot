import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { POLICY as LEAN_POLICY } from '../../../v3/arxivlean/lib/eval-sandbox.mjs';
import { buildSnapshot } from '../snapshot.mjs';
import { APPROVED_PATHS, GENERIC_DEFINITIONS } from '../lib/snapshot-tools.mjs';
import { BASELINE_DEFINITIONS, RUNTIME_INVENTORY_HASHES, createRuntimeTools } from '../runtime-tools.mjs';
import { COMPUTE_WORKER_HASH, RUNTIME_BACKEND_POLICY, RUNTIME_BACKEND_POLICY_HASH, createRuntimeBackend,
  createFixtureRuntimeBackend, runtimeBackendIdentity, cleanupOwned, cleanupOwnedForTests } from '../runtime-backend.mjs';

const image = `sha256:${'a'.repeat(64)}`;
const owner = { runId: 'fixture-run', episodeId: 'fixture-episode', nonce: 'fixture-nonce-1234567890' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const reply = (value = '') => ({ code: 0, signal: null, failure: null, client_config_cleanup: 'confirmed_removed', stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
function temporary(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-tools-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function ledger(file) { return readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse); }
function fakeDocker(options = {}) {
  const calls = [], containers = new Map();
  let sequence = 0;
  const docker = async (args, settings = {}) => {
    calls.push({ args: [...args], settings });
    if (args[0] === 'image') return reply([{ Id: image, Os: 'linux', Config: {
      Labels: { 'org.opencode.eval.runtime': options.badImage ? 'wrong-runtime' : 'mathlib-only-v1' },
      Env: options.badEnvironment ? ['HTTP_PROXY=unwanted'] : Object.entries(LEAN_POLICY.environment).map(([key, value]) => `${key}=${value}`),
      ...(options.imageVolumes ? { Volumes: { '/unapproved': {} } } : {}),
    } }]);
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      options.beforeCreate?.(args, name);
      if (options.uncertainNoContainer) return { ...reply(), code: null, failure: 'timeout' };
      const labels = {};
      for (let i = 0; i < args.length; i++) if (args[i] === '--label') {
        const entry = args[++i], split = entry.indexOf('='); labels[entry.slice(0, split)] = entry.slice(split + 1);
      }
      const id = (++sequence).toString(16).padStart(64, '0');
      const info = { Name: `/${name}`, Id: id, Image: image, Config: { Labels: labels } };
      containers.set(name, info);
      options.afterCreate?.(info);
      if (options.createCrash) throw new Error('fixture_child_crash');
      return reply(id + '\n');
    }
    if (args[0] === 'start') {
      options.onStart?.(settings);
      if (options.execution) return typeof options.execution === 'function' ? options.execution(args, settings) : options.execution;
      const info = [...containers.values()].find(container => container.Id === args.at(-1));
      return reply(info.Config.Labels['org.opencode.eval.role'] === 'compute' ? { ok: true, result: '589' } : '');
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const info = containers.get(args[2]);
      return info ? reply([structuredClone(info)]) : { ...reply(), code: 1, stderr: 'No such container' };
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      if (options.removeFailure) return { ...reply(), code: 1 };
      for (const [name, info] of containers) if (info.Id === args.at(-1)) containers.delete(name);
      return reply();
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      if (options.confirmationFailure) return { ...reply(), code: null, failure: 'process_error' };
      const filter = args[args.indexOf('--filter') + 1];
      const matches = filter.startsWith('name=') ? [...containers].filter(([name]) => filter === `name=^/${name}$`).map(([name]) => name)
        : [...containers.values()].filter(info => filter === `id=${info.Id}`).map(info => info.Id);
      return reply(matches.join('\n'));
    }
    throw new Error(`unexpected_fixture_docker_command:${args[0]}`);
  };
  return { docker, calls, containers };
}
function fixtureBackend(t, options = {}) {
  const root = temporary(t), ledgerPath = path.join(root, 'owned.ndjson');
  const fake = fakeDocker(options);
  const backend = createFixtureRuntimeBackend({ image, owner, ledgerPath }, fake.docker);
  return { root, ledgerPath, backend, ...fake };
}
function fixturePdf() {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let n = 1; n <= 6; n++) {
    const id = objects.length; kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const stream = `BT /F1 12 Tf 30 700 Td (Fixture Hanner page ${n}.) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Count 6 /Kids [${kids.join(' ')}] >>`;
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(result + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}
async function toolFixture(t) {
  const f = fixtureBackend(t), corpusRoot = path.join(f.root, 'corpus'), snapshotRoot = path.join(f.root, 'snapshot');
  for (const [i, logical] of APPROVED_PATHS.entries()) {
    const file = path.join(corpusRoot, logical); mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, i === 2 ? fixturePdf() : `# ${i ? 'Jacobsthal' : 'Kaplansky'} fixture\nUnicode ∀ α\n`);
  }
  const built = await buildSnapshot({ corpusRoot, out: snapshotRoot });
  const config = { snapshotRoot, expectedManifestHash: built.manifestHash, backend: f.backend };
  return { ...f, config, on: await createRuntimeTools({ ...config, condition: 'plugin-on' }), off: await createRuntimeTools({ ...config, condition: 'plugin-off' }) };
}

test('baseline parity is exact, only two ON wrappers, strict frozen inventories, fixture never production-admitted', async t => {
  const { on, off } = await toolFixture(t);
  assert.deepEqual(Object.keys(off.tools), ['approved_list', 'approved_read', 'approved_search', 'approved_pdf_text', 'compute', 'lean_compile']);
  assert.deepEqual(Object.keys(on.tools).filter(name => !off.tools[name]), ['math_search', 'math_manuscript']);
  for (const name of Object.keys(off.tools)) {
    const { handler: a, ...left } = on.tools[name], { handler: b, ...right } = off.tools[name];
    assert.deepEqual(left, right); assert.equal(typeof a, 'function'); assert.equal(typeof b, 'function');
    assert.equal(left.name, name); assert.equal(left.permission, name); assert.deepEqual(left.options, { codemode: false });
    assert.equal(left.inputSchema.additionalProperties, false);
  }
  for (const [name, original] of Object.entries({ approved_list: 'list_sources', approved_read: 'read_source', approved_search: 'search_source', approved_pdf_text: 'read_pdf' })) {
    assert.equal(BASELINE_DEFINITIONS[name].inputSchema, GENERIC_DEFINITIONS[original].inputSchema);
  }
  assert.equal(on.evidence, 'fixture'); assert.equal(off.imageInspected, false); assert.equal(on.imageInspected, false);
  assert.equal(on.baselineInventoryHash, off.baselineInventoryHash);
  assert.equal(off.inventoryHash, RUNTIME_INVENTORY_HASHES['plugin-off']);
  assert.notEqual(on.inventoryHash, off.inventoryHash);
  assert.throws(() => { off.tools.extra = {}; }, TypeError);
  assert.throws(() => { off.tools.compute.options.codemode = true; }, TypeError);
  assert.equal(on.tools.math_search.handler({ query: 'Jacobsthal' }).results[0].path, APPROVED_PATHS[1]);
});

test('operator config and backend identity cannot be spoofed; absent/test backend is not production', async t => {
  const f = await toolFixture(t);
  for (const backend of [undefined, { evidence: 'local-docker' }, { ...f.backend, evidence: 'local-docker' }, { ...f.backend }]) {
    await assert.rejects(() => createRuntimeTools({ ...f.config, backend, condition: 'plugin-on' }), /backend_identity_required/);
  }
  for (const extras of [{ condition: 'unknown' }, { env: {} }, { limits: { timeoutMs: 999 } }, { limits: null }, { limits: { calls: 201 } }]) {
    await assert.rejects(() => createRuntimeTools({ ...f.config, condition: 'plugin-off', ...extras }), /configuration|limits/);
  }
  assert.equal(runtimeBackendIdentity(f.backend).evidence, 'fixture');
  assert.throws(() => createRuntimeBackend({ image: 'mutable:latest', owner, ledgerPath: path.join(f.root, 'other') }), /immutable_image/);
  assert.throws(() => createRuntimeBackend({ image, owner, ledgerPath: path.join(f.root, 'other'), dockerExecutable: 'relative' }), /absolute_docker/);
  assert.throws(() => createRuntimeBackend({ image, owner, ledgerPath: path.join(f.root, 'other'), endpoint: 'tcp://remote:2375' }), /local_docker_endpoint/);
  assert.throws(() => createRuntimeBackend({ image, owner, ledgerPath: path.join(f.root, 'other'), env: {} }), /invalid_keys/);
  assert.equal(existsSync(path.join(f.root, 'other')), false);
});

test('approved paths, schema unknown keys, PDF/line caps, tampering and shared call budgets remain enforced', async t => {
  const f = await toolFixture(t), tools = f.off.tools;
  for (const logical of ['../gold.json', '/etc/passwd', 'C:/outside', 'file:///outside', 'lean/docs/021.md\0']) {
    assert.throws(() => tools.approved_read.handler({ path: logical }), /path_rejected|path_not_approved/);
  }
  for (const name of Object.keys(tools)) assert.throws(() => tools[name].handler({ arbitrary: true }), /invalid_keys/);
  assert.throws(() => tools.approved_pdf_text.handler({ path: APPROVED_PATHS[2], pages: '1-6' }), /page_limit/);
  assert.throws(() => tools.approved_read.handler({ path: APPROVED_PATHS[0], limit: 101 }), /invalid_line_range/);
  assert.throws(() => tools.approved_search.handler({ query: 'x'.repeat(257) }), /invalid_query/);
  const limited = await createRuntimeTools({ ...f.config, condition: 'plugin-on', limits: { calls: 1 } });
  limited.tools.approved_list.handler({});
  assert.throws(() => limited.tools.compute.handler({ operation: 'factor', expression: 'x^2-1' }), /call_budget_exhausted/);
  const source = path.join(f.config.snapshotRoot, APPROVED_PATHS[0]); chmodSync(source, 0o644); writeFileSync(source, 'changed');
  assert.throws(() => tools.approved_list.handler({}), /hash_mismatch/);
});

test('fixed compute worker is byte-hashed unchanged, data-only argv, fixed isolated Docker policy, ledger intent precedes create', async t => {
  let ledgerPath;
  const f = fixtureBackend(t, { beforeCreate(args, name) {
    const record = ledger(ledgerPath).at(-1); assert.equal(record.event, 'intent'); assert.equal(record.name, name);
  } });
  ledgerPath = f.ledgerPath;
  const worker = readFileSync(fileURLToPath(new URL('../../../../.opencode/plugins/math-toolkit/scripts/math_compute.py', import.meta.url)));
  assert.equal(COMPUTE_WORKER_HASH, digest(worker));
  assert.equal(RUNTIME_BACKEND_POLICY.compute_worker_sha256, COMPUTE_WORKER_HASH);
  assert.equal(RUNTIME_BACKEND_POLICY.outputBytes, 131072);
  const input = { operation: 'det', matrix: [[3, -2, 5, 1], [4, 0, -1, 2], [-3, 6, 2, -4], [1, 5, -2, 3]] };
  const result = await f.backend.compute(input);
  assert.equal(result.status, 'computed'); assert.equal(result.evidence, 'fixture'); assert.equal(result.output.result, '589');
  assert.equal(result.cleanup, 'confirmed_absent');
  const args = f.calls.find(call => call.args[0] === 'create').args;
  const tail = args.slice(args.indexOf('--entrypoint'));
  assert.deepEqual(tail.slice(0, 5), ['--entrypoint', '/usr/bin/python3', image, '-I', '-c']);
  assert.equal(tail[5], worker.toString('utf8')); assert.deepEqual(JSON.parse(tail[6]), input);
  for (const [flag, value] of [['--network', 'none'], ['--user', '10001:10001'], ['--cap-drop', 'ALL'], ['--memory', LEAN_POLICY.memory], ['--cpus', LEAN_POLICY.cpus], ['--pids-limit', '64']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('--pull=never'));
  assert.ok(!args.some(arg => ['--volume', '--mount', '--privileged', '--env-file'].includes(arg)));
  const start = f.calls.find(call => call.args[0] === 'start'); assert.equal(start.settings.stdin, ''); assert.equal(start.settings.timeoutMs, LEAN_POLICY.wallMs);
  assert.deepEqual(ledger(f.ledgerPath).map(record => record.event), ['owner', 'intent', 'created', 'result']);
  assert.equal(f.containers.size, 0);
});

test('compile is fixed Mathlib compilation only, diagnostics untrusted, proof never verified', async t => {
  const f = fixtureBackend(t), code = 'import Mathlib\nexample : 1 + 1 = 2 := by norm_num';
  const result = await f.backend.compile({ code });
  assert.equal(result.status, 'compiled'); assert.equal(result.proof.status, 'not_assessed');
  assert.match(result.reason, /not_proof_verification/); assert.equal(result.diagnostics.trust, 'untrusted_container_output');
  const args = f.calls.find(call => call.args[0] === 'create').args;
  assert.deepEqual(args.slice(-4), ['--entrypoint', '/opt/lean/bin/lean', image, '--stdin']);
  assert.ok(args.includes(`LEAN_PATH=${LEAN_POLICY.environment.LEAN_PATH}`));
  assert.equal(f.calls.find(call => call.args[0] === 'start').settings.stdin, code);
});

test('closed model inputs reject unknown operations/host options/oversized expressions and matrices before Docker', async t => {
  const f = fixtureBackend(t);
  for (const input of [{ operation: 'exec', expression: '1' }, { operation: 'factor', expression: 'x', image },
    { operation: 'expand', expression: 'x'.repeat(2001) }, { operation: 'det', matrix: Array.from({ length: 11 }, () => Array(11).fill(1)) },
    { operation: 'det', matrix: [[1, 2]] }, { operation: 'det', matrix: [[Infinity]] }, { operation: 'series', expression: 'x', order: 51 },
    { operation: 'factor', expression: 'x', env: {} }, { operation: 'factor', expression: 'x', timeoutMs: 999 }]) {
    assert.equal((await f.backend.compute(input)).status, 'blocked');
  }
  for (const input of [{ code: 'x', executable: '/bin/sh' }, { code: 'α'.repeat(131072) }, { code: '' }, { code: 'x', image }]) assert.equal((await f.backend.compile(input)).status, 'blocked');
  assert.equal(f.calls.length, 0); assert.equal(ledger(f.ledgerPath).length, 1);
});

test('injection-like expressions remain JSON data; rejection is worker evidence, never host Python execution', async t => {
  const f = fixtureBackend(t, { execution: reply({ ok: false, error: 'Unknown or forbidden name in expression.' }) });
  const expression = '__import__("os").system("touch HOST_SENTINEL")';
  const result = await f.backend.compute({ operation: 'simplify', expression });
  assert.equal(result.status, 'rejected'); assert.equal(result.output.ok, false); assert.equal(result.evidence, 'fixture');
  const args = f.calls.find(call => call.args[0] === 'create').args;
  assert.equal(JSON.parse(args.at(-1)).expression, expression);
  assert.equal(digest(args.at(-2)), COMPUTE_WORKER_HASH);
  assert.equal(existsSync(path.join(f.root, 'HOST_SENTINEL')), false);
});

test('malformed/nonzero/overflow worker outputs fail closed and still confirm cleanup', async t => {
  const cases = [reply('diagnostic\n{"ok":true,"result":"2"}'), reply({ ok: true, result: '2', extra: true }), reply({ ok: true, result: 2 }),
    { ...reply({ ok: true, result: '2' }), code: 1 }, reply('x'.repeat(131073)), { ...reply(), failure: 'output_limit', code: null }];
  for (const execution of cases) {
    const f = fixtureBackend(t, { execution }), result = await f.backend.compute({ operation: 'expand', expression: '(x+1)^2' });
    assert.equal(result.status, 'error'); assert.equal(Object.hasOwn(result, 'output'), false);
    assert.equal(result.cleanup, 'confirmed_absent'); assert.equal(f.containers.size, 0);
  }
});

test('timeout, abort, child crash and create-before-ID failure are ledger-owned and cleaned without aborted cleanup signal', async t => {
  for (const failure of ['timeout', 'cancelled', 'process_error']) {
    const controller = new AbortController();
    const f = fixtureBackend(t, { onStart() { if (failure === 'cancelled') controller.abort(); }, execution: { ...reply(), code: null, failure } });
    const result = await f.backend.compile({ code: 'example : True := by trivial' }, { signal: controller.signal });
    assert.equal(result.status, 'error'); assert.equal(result.cleanup, 'confirmed_absent');
    assert.equal(ledger(f.ledgerPath).at(-1).cleanup, 'confirmed_absent');
    for (const call of f.calls.filter(call => call.args[0] === 'container')) assert.equal(call.settings.signal, undefined);
  }
  const crashed = fixtureBackend(t, { createCrash: true });
  const result = await crashed.backend.compile({ code: 'example : True := by trivial' });
  assert.equal(result.status, 'error'); assert.equal(result.cleanup, 'confirmed_absent');
  assert.deepEqual(ledger(crashed.ledgerPath).map(record => record.event), ['owner', 'intent', 'result']);
  const cancelled = fixtureBackend(t); const controller = new AbortController(); controller.abort();
  assert.equal((await cancelled.backend.compute({ operation: 'factor', expression: 'x' }, { signal: controller.signal })).reason, 'cancelled');
  assert.equal(cancelled.calls.length, 0);
});

test('ownership mismatch or unconfirmed cleanup can never yield compiled/computed success or delete unrelated containers', async t => {
  for (const options of [{ afterCreate(info) { info.Config.Labels['org.opencode.eval.owner'] = 'some-other-owner'; } },
    { afterCreate(info) { info.Id = 'b'.repeat(64); } }, { afterCreate(info) { info.Image = `sha256:${'b'.repeat(64)}`; } },
    { afterCreate(info) { info.Name = '/unrelated'; } },
    { removeFailure: true }, { confirmationFailure: true }, { uncertainNoContainer: true }]) {
    const f = fixtureBackend(t, options), result = await f.backend.compute({ operation: 'factor', expression: 'x^2-1' });
    assert.equal(result.status, 'error'); assert.equal(result.cleanup, 'unconfirmed'); assert.equal(Object.hasOwn(result, 'output'), false);
    if (options.afterCreate) assert.equal(f.calls.filter(call => call.args[1] === 'rm').length, 0);
  }
});

test('parent cleanup recovers a crash before ID by exact name/image/all owner labels, and refuses wrong ownership', async t => {
  const f = fixtureBackend(t, { removeFailure: true });
  await f.backend.compile({ code: 'example : True := by trivial' });
  const records = ledger(f.ledgerPath), intent = records[1], retained = structuredClone(f.containers.get(intent.name));
  writeFileSync(f.ledgerPath, records.slice(0, 2).map(JSON.stringify).join('\n') + '\n');
  const recovery = fakeDocker(); recovery.containers.set(intent.name, retained);
  recovery.containers.set('unrelated', { Name: '/unrelated', Id: 'f'.repeat(64), Image: image, Config: { Labels: {} } });
  const result = await cleanupOwnedForTests({ ledgerPath: f.ledgerPath, owner: { nonce: owner.nonce, episodeId: owner.episodeId, runId: owner.runId } }, recovery.docker);
  assert.equal(result.status, 'confirmed_absent'); assert.equal(recovery.containers.size, 1); assert.ok(recovery.containers.has('unrelated'));
  for (const key of Object.keys(intent.labels)) {
    const other = fakeDocker(), wrong = structuredClone(retained); wrong.Config.Labels[key] = 'wrong'; other.containers.set(intent.name, wrong);
    assert.equal((await cleanupOwnedForTests({ ledgerPath: f.ledgerPath, owner }, other.docker)).status, 'unconfirmed');
    assert.equal(other.calls.filter(call => call.args[1] === 'rm').length, 0);
  }
  await assert.rejects(() => cleanupOwnedForTests({ ledgerPath: f.ledgerPath, owner: { ...owner, nonce: 'different-nonce-1234567' } }, recovery.docker), /owner_mismatch/);
  // Production cleanup rejects fixture ledgers before issuing any Docker command.
  await assert.rejects(() => cleanupOwned({ ledgerPath: f.ledgerPath, owner }), /owner_mismatch/);
});

test('fresh ledgers are not overwritten, mutations/torn records fail closed, and image environment/labels gate execution', async t => {
  const f = fixtureBackend(t), before = readFileSync(f.ledgerPath);
  assert.throws(() => createFixtureRuntimeBackend({ image, owner, ledgerPath: f.ledgerPath }, f.docker), /fresh_empty_ledger/);
  assert.deepEqual(readFileSync(f.ledgerPath), before);
  writeFileSync(f.ledgerPath, Buffer.concat([before, Buffer.from('{torn')]));
  assert.equal((await f.backend.compile({ code: 'example : True := by trivial' })).status, 'blocked');
  assert.equal(f.calls.some(call => call.args[0] === 'create'), false);
  const torn = await cleanupOwnedForTests({ ledgerPath: f.ledgerPath, owner }, f.docker);
  assert.equal(torn.status, 'unconfirmed'); assert.equal(torn.reason, 'ledger_torn_suffix'); assert.deepEqual(torn.results, []);
  for (const options of [{ badImage: true }, { badEnvironment: true }, { imageVolumes: true }]) {
    const rejected = fixtureBackend(t, options);
    assert.equal((await rejected.backend.compile({ code: 'example : True := by trivial' })).status, 'blocked');
    assert.equal(rejected.calls.some(call => call.args[0] === 'create'), false);
    await assert.rejects(() => rejected.backend.inspectImage(), /unknown_eval_image|unexpected_image_environment|image_volumes/);
  }
  assert.equal(runtimeBackendIdentity(f.backend).policy_sha256, RUNTIME_BACKEND_POLICY_HASH);
});

test('recovery binds the exact local Docker endpoint and fingerprint before any query, including fixtures', async t => {
  const root = temporary(t), ledgerPath = path.join(root, 'endpoint.ndjson');
  const endpointA = 'unix:///fixture/daemon-a.sock', endpointB = 'npipe:////./pipe/fixture-daemon-b';
  const active = fakeDocker({ removeFailure: true });
  const backend = createFixtureRuntimeBackend({ image, owner, ledgerPath, endpoint: endpointA }, active.docker);
  assert.equal(backend.identity.docker_endpoint, endpointA);
  assert.equal(backend.identity.docker_endpoint_sha256, digest(endpointA));
  assert.equal(ledger(ledgerPath)[0].identity.docker_endpoint, endpointA);
  await backend.compile({ code: 'example : True := by trivial' });
  const intent = ledger(ledgerPath)[1], retained = structuredClone(active.containers.get(intent.name));
  for (const endpoint of [undefined, endpointB]) {
    const otherDaemon = fakeDocker();
    await assert.rejects(() => cleanupOwnedForTests({ ledgerPath, owner, endpoint }, otherDaemon.docker), /ledger_endpoint_mismatch/);
    assert.equal(otherDaemon.calls.length, 0);
    assert.ok(active.containers.has(intent.name));
  }
  const sameDaemon = fakeDocker(); sameDaemon.containers.set(intent.name, retained);
  assert.equal((await cleanupOwnedForTests({ ledgerPath, owner, endpoint: endpointA }, sameDaemon.docker)).status, 'confirmed_absent');
  assert.deepEqual(sameDaemon.calls.map(call => call.args.slice(0, 2)), [
    ['container', 'inspect'], ['container', 'rm'], ['container', 'ls'], ['container', 'ls'],
  ]);
  const bytes = readFileSync(ledgerPath), records = ledger(ledgerPath);
  records[0].identity.docker_endpoint_sha256 = '0'.repeat(64);
  writeFileSync(ledgerPath, records.map(JSON.stringify).join('\n') + '\n');
  const mismatch = fakeDocker();
  await assert.rejects(() => cleanupOwnedForTests({ ledgerPath, owner, endpoint: endpointA }, mismatch.docker), /ledger_endpoint_mismatch/);
  assert.equal(mismatch.calls.length, 0);
  writeFileSync(ledgerPath, bytes);
  for (const endpoint of ['tcp://127.0.0.1:2375', 'ssh://localhost', 'unix:////remote/socket', 'npipe://remote/pipe/docker']) {
    assert.throws(() => createFixtureRuntimeBackend({ image, owner, endpoint, ledgerPath: path.join(root, 'never-created') }, active.docker), /local_docker_endpoint_required/);
    await assert.rejects(() => cleanupOwnedForTests({ ledgerPath, owner, endpoint }, active.docker), /local_docker_endpoint_required/);
  }
  assert.equal(existsSync(path.join(root, 'never-created')), false);
  const defaults = fixtureBackend(t);
  const expected = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  assert.equal(defaults.backend.identity.docker_endpoint, expected);
  assert.equal(defaults.backend.identity.docker_endpoint_sha256, digest(expected));
});

test('torn or malformed suffix recovers only complete validated owned intents, without claiming total cleanup', async t => {
  const f = fixtureBackend(t, { removeFailure: true });
  await f.backend.compile({ code: 'example : True := by trivial' });
  const records = ledger(f.ledgerPath), intent = records[1], retained = structuredClone(f.containers.get(intent.name));
  const prefix = records.slice(0, 3).map(JSON.stringify).join('\n') + '\n';
  for (const [suffix, reason] of [
    ['{"event":"result","name":', 'ledger_torn_suffix'],
    [JSON.stringify(records[3]), 'ledger_torn_suffix'], // valid JSON without commit newline is still untrusted
    ['{malformed}\n' + JSON.stringify(records[3]) + '\n', 'ledger_invalid_record'],
    [JSON.stringify({ ...intent, name: 'unrelated' }) + '\n', 'ledger_invalid_record'],
    [JSON.stringify({ ...records[3], cleanup: 'made-up' }) + '\n', 'ledger_invalid_record'],
  ]) {
    const recovery = fakeDocker(); recovery.containers.set(intent.name, structuredClone(retained));
    recovery.containers.set('unrelated', { Name: '/unrelated', Id: 'f'.repeat(64), Image: image, Config: { Labels: {} } });
    const saved = prefix + suffix; writeFileSync(f.ledgerPath, saved);
    const result = await cleanupOwnedForTests({ ledgerPath: f.ledgerPath, owner }, recovery.docker);
    assert.equal(result.status, 'unconfirmed'); assert.equal(result.ledger_integrity, 'incomplete'); assert.equal(result.reason, reason);
    assert.deepEqual(result.results, [{ name: intent.name, cleanup: 'confirmed_absent' }]);
    assert.equal(recovery.containers.size, 1); assert.ok(recovery.containers.has('unrelated'));
    assert.deepEqual(recovery.calls.filter(call => call.args[1] === 'rm').map(call => call.args.at(-1)), [retained.Id]);
    assert.equal(readFileSync(f.ledgerPath, 'utf8'), saved, 'recovery must not overwrite or repair the ledger');
  }
  for (const text of ['{"schema":', '{invalid}\n' + prefix, JSON.stringify({ ...records[0], identity: {} }) + '\n' + prefix]) {
    writeFileSync(f.ledgerPath, text); const recovery = fakeDocker();
    await assert.rejects(() => cleanupOwnedForTests({ ledgerPath: f.ledgerPath, owner }, recovery.docker), /ledger_invalid/);
    assert.equal(recovery.calls.length, 0, 'valid complete header is required before cleanup');
  }
});

test('tool factory exposes inspection bindings only, never overall admission or model-run authorization', async t => {
  const { on, off } = await toolFixture(t);
  for (const runtime of [on, off]) {
    assert.equal(Object.hasOwn(runtime, 'productionAdmitted'), false);
    assert.equal(runtime.imageInspected, false, 'fixture inspection is not a real Docker inspection');
    assert.equal(runtime.admission, 'not_assessed'); assert.equal(runtime.canAuthorizeModelRun, false);
    assert.match(runtime.imageInspectionHash, /^[a-f0-9]{64}$/);
    assert.equal(runtime.backendIdentity.docker_endpoint_sha256, digest(runtime.backendIdentity.docker_endpoint));
    assert.throws(() => { runtime.canAuthorizeModelRun = true; }, TypeError);
    assert.throws(() => { runtime.admission = 'ready'; }, TypeError);
  }
});
