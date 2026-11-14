import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONTROL_NAMES, parseRuntimeControlArgs, runtimeControlsForTests as fixture } from '../runtime-controls.mjs';
import { BASELINE_DEFINITIONS, NAVIGATION_DEFINITIONS, RUNTIME_INVENTORY_HASHES } from '../runtime-tools.mjs';
import { RUNTIME_BACKEND_POLICY_HASH, COMPUTE_WORKER_HASH } from '../runtime-backend.mjs';

const image = `sha256:${'a'.repeat(64)}`, snapshotHash = 'b'.repeat(64);
const context = { role: 'compile', expected: 'compiled', image, evidence: 'fixture', backendId: 'explicit-fixture-backend' };
function result(overrides = {}) {
  return { schema: 'real-use-runtime-compile/v1', evidence: 'fixture', image, backend_id: context.backendId,
    policy_sha256: RUNTIME_BACKEND_POLICY_HASH, worker_sha256: COMPUTE_WORKER_HASH,
    proof: { status: 'not_assessed' }, status: 'compiled', reason: 'compilation_only_not_proof_verification', cleanup: 'confirmed_absent', exit_code: 0,
    diagnostics: { stdout: '', stderr: '', trust: 'untrusted_container_output' }, ...overrides };
}
function toolset(condition) {
  return { schema: 'real-use-runtime-tools/v1', condition, evidence: 'fixture', imageInspected: false, admission: 'not_assessed', canAuthorizeModelRun: false,
    inventoryHash: RUNTIME_INVENTORY_HASHES[condition], baselineInventoryHash: RUNTIME_INVENTORY_HASHES.baseline,
    tools: Object.fromEntries(Object.entries({ ...BASELINE_DEFINITIONS, ...(condition === 'plugin-on' ? NAVIGATION_DEFINITIONS : {}) }).map(([name, definition]) =>
      [name, { ...structuredClone(definition), handler: () => { throw new Error('explicit_fixture_only'); } }])) };
}
function temp(t) {
  const root = mkdtempSync(path.join(process.platform === 'win32' ? 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode' : tmpdir(), 'runtime-controls-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: false, maxRetries: 10, retryDelay: 50 }));
  return root;
}

test('fixture CLI validation: strict immutable identity, absolute paths, bounded hashes, no injection flags', t => {
  const root = temp(t);
  const options = { image, snapshotRoot: root, snapshotHash, dockerExecutable: path.join(root, 'docker.exe'), out: path.join(root, 'fresh') };
  const args = ['--image', image, '--snapshot-root', root, '--snapshot-hash', snapshotHash, '--docker-executable', options.dockerExecutable, '--out', options.out];
  assert.deepEqual(parseRuntimeControlArgs(args), options);
  for (const override of [{ image: 'eval:latest' }, { image: 'sha256:abc' }, { image: `sha256:${'A'.repeat(64)}` },
    { dockerExecutable: 'docker' }, { dockerExecutable: `bad\0path` }, { snapshotRoot: 'relative' }, { snapshotHash: 'x'.repeat(64) },
    { snapshotHash: `${snapshotHash}\n` }, { out: 'relative' }, { fixture: true }, { endpoint: 'tcp://remote' }]) {
    assert.throws(() => fixture.validateOptions({ ...options, ...override }));
  }
  for (const suffix of [['--fixture', 'true'], ['--image', image], ['--out'], ['--env', 'anything']]) assert.throws(() => parseRuntimeControlArgs([...args, ...suffix]));
  assert.equal(existsSync(options.out), false, 'invalid/fixture validation must never launch or reserve output');
});

test('fixture output freshness refuses even an existing empty directory', t => {
  const root = temp(t), out = path.join(root, 'existing'); mkdirSync(out);
  assert.throws(() => fixture.validateOptions({ image, snapshotRoot: root, snapshotHash, dockerExecutable: path.join(root, 'docker.exe'), out }), /output_exists/);
});

test('fixture inventory parity compares every name/schema/option and only two ON wrappers', () => {
  const on = toolset('plugin-on'), off = toolset('plugin-off');
  assert.equal(fixture.assessParity(on, off, 'fixture'), true);
  assert.equal(fixture.assessParity(on, off, 'local-docker'), false);
  for (const mutate of [value => { value.tools.compute.options.codemode = true; }, value => { value.tools.compute.inputSchema.additionalProperties = true; },
    value => { value.tools.compute.name = 'renamed'; }, value => { value.tools.compute.permission = 'other'; },
    value => { value.tools.extra = value.tools.compute; }, value => { delete value.tools.lean_compile; },
    value => { value.imageInspected = true; }, value => { value.canAuthorizeModelRun = true; }, value => { value.productionAdmitted = true; }]) {
    const changed = toolset('plugin-on'); mutate(changed);
    assert.equal(fixture.assessParity(changed, off, 'fixture'), false);
  }
});

test('fixture failed, unknown, malformed and incomplete runtime results cannot pass', () => {
  assert.equal(fixture.assessRuntime(result(), context).status, 'passed');
  for (const candidate of [null, true, {}, result({ status: 'success' }), result({ status: 'error', reason: 'runtime_nonzero', exit_code: 1 }),
    result({ proof: { status: 'verified' } }), result({ evidence: 'local-docker' }), result({ backend_id: 'different' }), result({ image: 'mutable:latest' }),
    result({ policy_sha256: '0'.repeat(64) }), result({ worker_sha256: '0'.repeat(64) }), result({ exit_code: null }), result({ diagnostics: {} }),
    result({ cleanup: undefined }), result({ status: 'compiled', reason: undefined })]) {
    assert.notEqual(fixture.assessRuntime(candidate, context).status, 'passed');
  }
  assert.equal(fixture.assessRuntime(result({ status: 'blocked', reason: 'runtime_image_not_admitted', cleanup: 'not_needed' }), context).status, 'blocked');
  assert.equal(fixture.assessRuntime(result(), { ...context, expected: 'unknown' }).status, 'failed');
});

test('fixture wrong-type expected failure is a control pass only with real nonzero type diagnostic', () => {
  const wrong = result({ status: 'error', reason: 'runtime_nonzero', exit_code: 1,
    diagnostics: { stdout: 'error: type mismatch\n  "not a Nat" has type String', stderr: '', trust: 'untrusted_container_output' } });
  const assessed = fixture.assessRuntime(wrong, { ...context, expected: 'wrong-type' });
  assert.equal(assessed.status, 'passed'); assert.match(assessed.reason, /not_math_assessment/);
  assert.equal(wrong.proof.status, 'not_assessed');
  for (const override of [{ exit_code: 0 }, { reason: 'timeout' }, { diagnostics: { ...wrong.diagnostics, stdout: 'unrelated failure' } }, { cleanup: 'unconfirmed' }]) {
    assert.equal(fixture.assessRuntime({ ...wrong, ...override }, { ...context, expected: 'wrong-type' }).status, 'failed');
  }
});

test('fixture rejection, timeout, abort and output overflow require exact expected failure; never success', () => {
  for (const expected of ['timeout', 'cancelled', 'output_limit']) {
    const failed = result({ status: 'error', reason: expected, exit_code: null });
    assert.equal(fixture.assessRuntime(failed, { ...context, expected }).status, 'passed');
    assert.equal(fixture.assessRuntime(failed, context).status, 'failed');
    assert.equal(fixture.assessRuntime(result(), { ...context, expected }).status, 'failed');
  }
  const compute = result({ schema: 'real-use-runtime-compute/v1', status: 'rejected', reason: 'worker_input_rejected', output: { ok: false, error: 'Unknown or forbidden name in expression.' } });
  assert.equal(fixture.assessRuntime(compute, { ...context, role: 'compute', expected: 'rejected' }).status, 'passed');
  assert.equal(fixture.assessRuntime({ ...compute, output: { ok: true, result: '0' } }, { ...context, role: 'compute', expected: 'rejected' }).status, 'failed');
});

test('fixture cleanup failure overrides otherwise successful started control; missing controls are blocked', () => {
  const calls = [{ control: 'compile_init', started: true, names: ['owned-only'], result: { cleanup: 'confirmed_absent' } }];
  for (const cleanup of [{ status: 'unconfirmed', results: [] }, { status: 'confirmed_absent', results: [] },
    { status: 'confirmed_absent', results: [{ name: 'different', cleanup: 'confirmed_absent' }] }]) {
    const report = fixture.report({}, [{ name: 'compile_init', status: 'passed' }], calls, cleanup);
    assert.equal(report.controls.find(control => control.name === 'compile_init').status, 'failed');
    assert.equal(report.summary.blocked, CONTROL_NAMES.length - 1);
    assert.equal(report.evidence, 'fixture'); assert.equal(report.canAuthorizeModelRun, false); assert.equal(report.admission, 'not_assessed');
  }
  const cleanup = { status: 'confirmed_absent', results: [{ name: 'owned-only', cleanup: 'confirmed_absent' }] };
  assert.equal(fixture.report({}, [{ name: 'compile_init', status: 'passed' }], calls, cleanup).summary.passed, 1);
  const failedCalls = structuredClone(calls); failedCalls[0].result.cleanup = 'unconfirmed';
  assert.equal(fixture.report({}, [{ name: 'compile_init', status: 'passed' }], failedCalls, cleanup).summary.failed, 1);
});

test('fixture even all-passed JSON cannot mint readiness; incomplete/unknown states fail closed', () => {
  const controls = CONTROL_NAMES.map(name => ({ name, status: 'passed' }));
  const report = fixture.report({}, controls);
  assert.equal(report.summary.passed, CONTROL_NAMES.length);
  assert.equal(report.canAuthorizeModelRun, false); assert.equal(report.proof.status, 'not_assessed');
  assert.equal(report.evidence, 'fixture'); assert.equal(Object.hasOwn(report, 'ready'), false);
  assert.throws(() => { report.canAuthorizeModelRun = true; }, TypeError);
  assert.equal(fixture.report({}, [{ name: 'compile_init', status: 'unknown' }]).summary.failed, 1);
});

test('fixture actual HostConfig facts require network none, resource caps, read-only and no host mounts', () => {
  const facts = { running: true, user: '10001:10001', network: 'none', ipc: 'none', readonly: true, privileged: false,
    memory: 2147483648, memory_swap: 2147483648, nano_cpus: 2000000000, pids: 64, restart: 'no', cap_drop: ['ALL'], cap_add: [],
    security_options: ['no-new-privileges=true'], binds: null, host_mounts: [], mounts: [],
    tmpfs: Object.fromEntries(['/work', '/tmp'].map(name => [name, 'rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=700'])),
    ulimits: [{ Name: 'nofile', Soft: 128, Hard: 128 }, { Name: 'fsize', Soft: 16777216, Hard: 16777216 }, { Name: 'core', Soft: 0, Hard: 0 }] };
  assert.equal(fixture.validHostFacts(facts), true);
  for (const override of [{ running: false }, { network: 'bridge' }, { user: '0' }, { readonly: false }, { memory_swap: -1 }, { memory: 1073741824 }, { nano_cpus: 1000000000 },
    { pids: 0 }, { privileged: true }, { cap_add: ['SYS_ADMIN'] }, { mounts: [{ Type: 'bind', Destination: '/host' }] },
    { binds: ['/host:/host'] }, { security_options: [] }, { tmpfs: {} }, { ulimits: [] }, { cap_drop: true }, { tmpfs: { '/work': true, '/tmp': true } }]) assert.equal(fixture.validHostFacts({ ...facts, ...override }), false);
});
