import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createCompilerSandbox, createTestSandbox, dockerTransportForTests, POLICY, POLICY_HASH, containerArguments } from '../lib/eval-sandbox.mjs';
import { CONDITIONS, TOOLSET, registerEvalTools, toolManifest } from '../eval-tools.js';
import { preflight, assertReadiness, MISSING_CONTROLS } from '../preflight-arxivlean.mjs';
import { classify, gradeEpisode, runComparator } from '../grade-arxivlean.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = `sha256:${'a'.repeat(64)}`;
const CONTAINER = 'b'.repeat(64);
const success = (stdout = '') => ({ code: 0, signal: null, failure: null, stdout, stderr: '' });
function fixture({ execution = success('compiled'), badImage = false, badOwner = false, removeFails = false, listFails = false, createFails = false } = {}) {
  const calls = [];
  let name, owner, present = false;
  const docker = async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'image') return success(JSON.stringify([{ Id: badImage ? 'wrong' : IMAGE, Os: 'linux', Config: { Env: Object.entries(POLICY.environment).map(([k, v]) => `${k}=${v}`), Labels: { 'org.opencode.eval.runtime': 'mathlib-only-v1' } } }]));
    if (args[0] === 'create') {
      name = args[args.indexOf('--name') + 1];
      owner = args.find(a => a.startsWith('org.opencode.eval.owner=')).split('=')[1];
      present = true;
      return createFails ? { ...success(), code: 1, failure: 'process_error' } : success(CONTAINER);
    }
    if (args[0] === 'start') return execution;
    if (args[1] === 'inspect') return present ? success(JSON.stringify([{ Id: CONTAINER, Name: `/${name}`, Config: { Labels: { 'org.opencode.eval.owner': badOwner ? 'other' : owner } } }])) : { ...success(), code: 1 };
    if (args[1] === 'rm') { if (removeFails) return { ...success(), code: 1 }; present = false; return success(); }
    if (args[1] === 'ls') return listFails ? { ...success(), code: 1 } : success(present ? name : '');
    throw new Error(`unexpected Docker command ${args}`);
  };
  return { calls, backend: createTestSandbox({ image: IMAGE, docker }), docker };
}
function temp(t) {
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'eval-boundaries-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('fixed Docker flags, environment, stdin and unique owned cleanup; compilation is not proof', async () => {
  const { backend, calls } = fixture({ execution: success('Your solution is okay!\nCOMPARATOR_RC=0') });
  const result = await backend.compile({ code: 'import Init\nexample : True := True.intro' });
  assert.equal(result.status, 'compiled');
  assert.equal(result.proof.status, 'not_assessed');
  assert.equal(result.evidence, 'test-only');
  assert.equal(result.cleanup, 'confirmed_absent');
  assert.equal(result.diagnostics.trust, 'untrusted_source_output');
  const args = calls.find(c => c.args[0] === 'create').args;
  const owner = args.find(a => a.startsWith('org.opencode.eval.owner=')).split('=')[1];
  assert.deepEqual(args, containerArguments(IMAGE, result.container, owner));
  for (const [flag, value] of [['--network', 'none'], ['--user', '10001:10001'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges=true'], ['--memory', '2g'], ['--memory-swap', '2g'], ['--cpus', '2'], ['--pids-limit', '64'], ['--entrypoint', '/opt/lean/bin/lean']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.equal(POLICY.wallMs, 120000);
  assert.equal(POLICY.controlMs, 10000);
  assert.equal(POLICY.sourceBytes, 131072);
  assert.equal(POLICY.outputBytes, 131072);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--pull=never'));
  assert.deepEqual(args.slice(-2), [IMAGE, '--stdin']);
  assert.deepEqual(args.flatMap((v, i) => v === '--env' ? [args[i + 1]] : []), Object.entries(POLICY.environment).map(([k, v]) => `${k}=${v}`));
  assert.equal(args.filter(v => v === '--tmpfs').length, 2);
  for (const forbidden of ['--mount', '-v', '--volume', '--volumes-from', '--env-file', '--privileged', '--publish', '-p', '--pid', '--device']) assert.ok(!args.includes(forbidden));
  assert.ok(!args.some(a => /docker\.sock|corpus|credential|gold|\/home\//.test(a)));
  assert.equal(calls.find(c => c.args[0] === 'start').options.stdin, 'import Init\nexample : True := True.intro');
  assert.equal(calls.find(c => c.args[0] === 'start').options.timeoutMs, POLICY.wallMs);
  assert.deepEqual(calls.find(c => c.args[1] === 'rm').args, ['container', 'rm', '--force', CONTAINER]);
  assert.equal(calls.at(-1).args[1], 'ls');
  const next = await backend.compile({ code: 'example : True := True.intro' });
  assert.notEqual(result.container, next.container);
});

test('immutable image and code-only bounded API fail closed before creation', async () => {
  for (const image of [undefined, 'latest', 'opencode-math-comparator', 'sha256:abc', `sha256:${'A'.repeat(64)}`]) assert.throws(() => createCompilerSandbox({ image }), /immutable_image/);
  assert.throws(() => createCompilerSandbox({ image: IMAGE, docker: () => {} }), /unknown_sandbox_option/);
  const { backend, calls } = fixture();
  for (const input of [{ code: 'x', file: '/host' }, { code: 'x', image: IMAGE }, { code: 'x', timeoutMs: 999999 }, { code: '' }, { code: 'é'.repeat(POLICY.sourceBytes) }]) assert.equal((await backend.compile(input)).status, 'blocked');
  assert.equal(calls.length, 0);
  const unknown = fixture({ badImage: true });
  assert.equal((await unknown.backend.compile({ code: 'example : True := True.intro' })).status, 'blocked');
  assert.equal(unknown.calls.length, 1);
});

test('image-declared volumes, hooks and inherited environment rejected', async () => {
  for (const extra of [{ Volumes: { '/data': {} } }, { OnBuild: ['anything'] }, { Env: ['UNREVIEWED=1'] }]) {
    const backend = createTestSandbox({ image: IMAGE, docker: async () => success(JSON.stringify([{ Id: IMAGE, Os: 'linux', Config: { Labels: { 'org.opencode.eval.runtime': 'mathlib-only-v1' }, ...extra } }])) });
    assert.equal((await backend.compile({ code: 'example : True := True.intro' })).status, 'blocked');
  }
});

test('timeout/output overflow/signal/cancellation/error/nonzero always clean up and never verify', async () => {
  const forged = 'Your solution is okay!\nCOMPARATOR_RC=0\nCOMPARATOR_RC=0';
  for (const execution of [
    { ...success(forged), failure: 'timeout' }, { ...success(forged), failure: 'output_limit' },
    { ...success(forged), signal: 'SIGTERM' }, { ...success(forged), failure: 'cancelled' },
    { ...success(forged), failure: 'process_error' }, { ...success(forged), code: 1 },
  ]) {
    const { backend, calls } = fixture({ execution });
    const result = await backend.compile({ code: 'import Init' });
    assert.equal(result.status, 'error'); assert.equal(result.cleanup, 'confirmed_absent');
    assert.equal(result.proof.status, 'not_assessed');
    assert.ok(calls.some(c => c.args[1] === 'rm'));
  }
  const partial = fixture({ createFails: true });
  assert.equal((await partial.backend.compile({ code: 'import Init' })).cleanup, 'confirmed_absent');
});

test('cleanup failures are explicit; never remove a differently owned container', async () => {
  for (const config of [{ removeFails: true }, { listFails: true }, { badOwner: true }]) {
    const { backend, calls } = fixture(config);
    const result = await backend.compile({ code: 'import Init' });
    assert.equal(result.status, 'error'); assert.equal(result.cleanup, 'unconfirmed');
    if (config.badOwner) assert.ok(!calls.some(c => c.args[1] === 'rm'));
  }
  const original = fixture();
  const uncertain = createTestSandbox({ image: IMAGE, docker: async (args, options) => {
    if (args[0] === 'create') return { ...success(), code: null, failure: 'timeout' };
    return original.docker(args, options);
  } });
  const result = await uncertain.compile({ code: 'import Init' });
  assert.equal(result.status, 'error');
  assert.equal(result.cleanup, 'unconfirmed');
  assert.match(result.reason, /uncertain_create/);
});

function childFixture(onInput) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = value => queueMicrotask(() => onInput(child, value));
  child.kill = () => { child.killed = true; return true; };
  return child;
}
test('async Docker transport enforces combined byte cap, wall timeout and AbortSignal', async () => {
  let child;
  const cap = dockerTransportForTests((command, args, options) => {
    assert.equal(command, 'docker'); assert.equal(options.shell, false);
    child = childFixture(c => { c.stdout.emit('data', Buffer.alloc(POLICY.outputBytes)); c.stderr.emit('data', 'overflow'); c.emit('close', 0, null); });
    return child;
  });
  const capped = await cap(['start'], { stdin: 'source' });
  assert.equal(capped.failure, 'output_limit'); assert.ok(child.killed);
  assert.equal(Buffer.byteLength(capped.stdout) + Buffer.byteLength(capped.stderr), POLICY.outputBytes);
  const hang = dockerTransportForTests(() => (child = childFixture(() => {})));
  assert.equal((await hang(['start'], { timeoutMs: 5 })).failure, 'timeout'); assert.ok(child.killed);
  const abort = new AbortController();
  const pending = hang(['start'], { signal: abort.signal }); abort.abort();
  assert.equal((await pending).failure, 'cancelled'); assert.ok(child.killed);
});

test('Docker client ignores hostile synthetic parent configuration, proxies and credentials', async t => {
  const dir = temp(t), syntheticConfig = path.join(dir, 'synthetic-docker');
  fs.mkdirSync(syntheticConfig);
  const sentinel = 'SYNTHETIC_PROXY_CREDENTIAL_MUST_NOT_LEAK';
  fs.writeFileSync(path.join(syntheticConfig, 'config.json'), JSON.stringify({ proxies: { default: { httpProxy: sentinel } }, auths: { synthetic: { auth: sentinel } } }));
  const hostile = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    DOCKER_CONFIG: syntheticConfig, DOCKER_HOST: 'tcp://synthetic.invalid:2375',
    DOCKER_CONTEXT: sentinel, DOCKER_AUTH_CONFIG: sentinel, DOCKER_TLS_VERIFY: sentinel,
    DOCKER_CERT_PATH: syntheticConfig, HTTP_PROXY: sentinel, HTTPS_PROXY: sentinel,
    ALL_PROXY: sentinel, NO_PROXY: sentinel, http_proxy: sentinel, https_proxy: sentinel,
    all_proxy: sentinel, HOME: syntheticConfig, USERPROFILE: syntheticConfig,
    SSL_CERT_FILE: sentinel, SSL_CERT_DIR: sentinel,
  };
  const directories = [];
  const runner = dockerTransportForTests((command, args, options) => {
    assert.equal(command, 'docker');
    assert.equal(args[0], '--config'); assert.equal(args[2], '--host');
    assert.equal(args[3], process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
    assert.deepEqual(args.slice(4), ['create', '--network', 'none', IMAGE]);
    const config = args[1]; directories.push(config);
    assert.notEqual(config, syntheticConfig);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config, 'config.json'), 'utf8')), {});
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(config).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(config, 'config.json')).mode & 0o777, 0o600);
    }
    const expectedNames = process.platform === 'win32' ? ['PATH', ...(hostile.SystemRoot ? ['SystemRoot'] : []), 'TEMP', 'TMP'] : ['PATH', 'TMPDIR'];
    assert.deepEqual(Object.keys(options.env).sort(), expectedNames.sort());
    assert.doesNotMatch(JSON.stringify({ args, env: options.env }), new RegExp(sentinel));
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) if (name in options.env) assert.equal(options.env[name], config);
    return childFixture(child => { child.stdout.emit('data', 'diagnostic only'); child.emit('close', 0, null); });
  }, {}, hostile);
  for (let i = 0; i < 2; i++) {
    const result = await runner(['create', '--network', 'none', IMAGE]);
    assert.equal(result.failure, null); assert.equal(result.client_config_cleanup, 'confirmed_removed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  }
  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(path.join(syntheticConfig, 'config.json')), true);
});

test('Docker endpoint/executable are immutable operator options; remote endpoint selection denied', async () => {
  for (const endpoint of ['tcp://localhost:2375', 'ssh://localhost', 'https://localhost', 'npipe:////remote/pipe/docker_engine', 'unix://remote/socket', 'unix:relative', 'unix:////remote/socket', 'unix:///tmp/socket\n', '']) {
    assert.throws(() => createCompilerSandbox({ image: IMAGE, endpoint }), /local_docker_endpoint_required/);
  }
  assert.throws(() => createCompilerSandbox({ image: IMAGE, dockerExecutable: 'relative/docker' }), /absolute_docker_executable_required/);
  const executable = path.resolve('synthetic-docker-executable');
  const options = { endpoint: 'unix:///var/run/evaluator.sock', dockerExecutable: executable };
  const runner = dockerTransportForTests((command, args) => {
    assert.equal(command, executable); assert.equal(args[3], 'unix:///var/run/evaluator.sock');
    return childFixture(child => child.emit('close', 0, null));
  }, options, {});
  options.endpoint = 'tcp://synthetic.invalid:2375'; options.dockerExecutable = 'untrusted';
  assert.equal((await runner(['image', 'inspect', IMAGE], { endpoint: 'ssh://synthetic.invalid' })).failure, null);
  const { backend } = fixture();
  assert.equal((await backend.compile({ code: 'import Init', endpoint: 'unix:///tmp/other.sock' })).status, 'blocked');
});

test('owned Docker config cleanup runs on all transport exits and never recursively deletes unexpected files', async () => {
  for (const mode of ['throw', 'error', 'timeout', 'cancel', 'overflow']) {
    let directory;
    const controller = new AbortController();
    const runner = dockerTransportForTests((command, args) => {
      directory = args[1];
      if (mode === 'throw') throw new Error('SYNTHETIC_SECRET_THROW');
      return childFixture(child => {
        if (mode === 'error') child.emit('error', new Error('SYNTHETIC_SECRET_ERROR'));
        if (mode === 'cancel') controller.abort();
        if (mode === 'overflow') child.stdout.emit('data', Buffer.alloc(POLICY.outputBytes + 1));
      });
    });
    const result = await runner(['start'], { timeoutMs: 5, signal: controller.signal });
    assert.ok(result.failure); assert.equal(result.client_config_cleanup, 'confirmed_removed');
    assert.equal(fs.existsSync(directory), false); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET/);
  }
  let unexpectedFile, directory;
  const runner = dockerTransportForTests((command, args) => {
    directory = args[1]; unexpectedFile = path.join(directory, 'unexpected-test-file');
    fs.writeFileSync(unexpectedFile, 'do not remove recursively');
    return childFixture(child => child.emit('close', 0, null));
  });
  try {
    const result = await runner(['start']);
    assert.equal(result.failure, 'client_config_cleanup_failed');
    assert.equal(result.client_config_cleanup, 'unconfirmed');
    assert.equal(fs.readFileSync(unexpectedFile, 'utf8'), 'do not remove recursively');
  } finally {
    // Test-created file only; the transport deliberately left it alone.
    fs.unlinkSync(unexpectedFile); fs.rmdirSync(directory);
  }
});

test('both restricted conditions register identical direct compile tools; unknown selectors denied', async () => {
  const inventories = [];
  for (const condition of CONDITIONS) {
    const actual = [];
    const manifest = await registerEvalTools({ tool: { transform: async fn => fn({ add: tool => actual.push(tool) }) } }, { condition, image: IMAGE });
    inventories.push(actual.map(({ name, input, options }) => ({ name, input, options })));
    assert.deepEqual(manifest.registered, ['lean_compile']);
    assert.equal(actual[0].options.codemode, false);
    assert.equal(JSON.parse((await actual[0].execute({ code: 'x', file: '/host' })).content).status, 'blocked');
    const abort = new AbortController(); abort.abort();
    assert.equal(JSON.parse((await actual[0].execute({ code: 'import Init' }, { signal: abort.signal })).content).reason, 'cancelled');
    assert.equal(manifest.incremental_proof_capability, false);
  }
  assert.deepEqual(inventories[0], inventories[1]);
  assert.equal(toolManifest(CONDITIONS[0]).math_compute.status, 'BLOCKED');
  for (const condition of ['plugin-on', 'plugin-off', 'verify', 'all', undefined]) assert.throws(() => toolManifest(condition), /unknown_evaluation/);
  for (const toolset of ['verify', 'minimal', 'all', '']) assert.throws(() => toolManifest(CONDITIONS[0], toolset), /unknown_evaluation/);
  assert.equal(toolManifest(CONDITIONS[0], TOOLSET).tools.length, 1);
});

test('preflight is honest BLOCKED; mocked compilation never satisfies checker controls', async () => {
  const fake = fixture();
  const receipt = await preflight({ image: IMAGE, runControls: true }, { backend: fake.backend });
  assert.equal(receipt.status, 'BLOCKED'); assert.equal(receipt.production_ready, false);
  assert.equal(receipt.evidence, 'test-only'); assert.equal(receipt.hashes.policy_sha256, POLICY_HASH);
  assert.equal(receipt.hashes.image_id, IMAGE);
  assert.match(receipt.hashes.task_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.hashes.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.controls.compile_positive.status, 'passed');
  for (const name of MISSING_CONTROLS) assert.equal(receipt.controls[name].status, 'BLOCKED');
  assert.ok(receipt.missing_controls.includes('test_only_evidence_not_admissible'));
  const bare = await preflight();
  assert.equal(bare.controls.compile_positive.status, 'not_run'); assert.equal(bare.status, 'BLOCKED');
  await assert.rejects(preflight({ production_ready: true }), /unknown_preflight_option/);
});

test('stale/mismatched/unknown-condition and forged ready receipts cannot admit execution', async () => {
  const receipt = await preflight({ image: IMAGE });
  const forged = { ...receipt, status: 'ready', production_ready: true, missing_controls: [] };
  const options = { condition: CONDITIONS[0] };
  assert.throws(() => assertReadiness(forged, receipt.hashes, options), /admission_blocked/);
  assert.throws(() => assertReadiness({ ...forged, generated_at: '2000-01-01' }, receipt.hashes, options), /stale_readiness/);
  for (const key of ['source_sha256', 'config_sha256', 'task_sha256', 'image_id', 'policy_sha256']) assert.throws(() => assertReadiness(forged, { ...receipt.hashes, [key]: 'wrong' }, options), /readiness_mismatch/);
  assert.throws(() => assertReadiness(forged, receipt.hashes, { condition: 'verify' }), /unknown_evaluation/);
});

test('preflight CLI creates fresh BLOCKED evidence and refuses to overwrite it', t => {
  const dir = temp(t), output = path.join(dir, 'readiness.json');
  const script = path.resolve(HERE, '../preflight-arxivlean.mjs');
  const result = spawnSync(process.execPath, [script, '--out', output], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  const original = fs.readFileSync(output, 'utf8');
  assert.equal(JSON.parse(original).status, 'BLOCKED');
  assert.equal(JSON.parse(original).runtime.status, 'not_inspected');
  const repeated = spawnSync(process.execPath, [script, '--out', output], { encoding: 'utf8' });
  assert.equal(repeated.status, 1); assert.match(repeated.stderr, /fresh_readiness_output_required/);
  assert.equal(fs.readFileSync(output, 'utf8'), original);
});

test('legacy runner preserves authorization gate and cannot spawn with fake ready JSON', t => {
  const dir = temp(t), out = path.join(dir, 'must-not-exist');
  const readiness = path.join(dir, 'ready.json');
  fs.writeFileSync(readiness, JSON.stringify({ status: 'ready', production_ready: true }));
  const script = path.resolve(HERE, '../run-arxivlean.mjs');
  const unauthorized = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, NORMAL_USE_ALLOW_EXECUTE: '' } });
  assert.equal(unauthorized.status, 1); assert.match(unauthorized.stderr, /execution_not_authorized/);
  const trap = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; cp.spawnSync=()=>{throw Error('MODEL_SPAWN_ATTEMPTED')}; syncBuiltinESMExports();`;
  const authorized = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(trap)}`, script, '--execute', '--readiness', readiness, '--out', out], { encoding: 'utf8', env: { ...process.env, NORMAL_USE_ALLOW_EXECUTE: '1' } });
  assert.equal(authorized.status, 1); assert.match(authorized.stderr, /legacy_runner_deprecated/);
  assert.doesNotMatch(authorized.stderr, /MODEL_SPAWN_ATTEMPTED/); assert.equal(fs.existsSync(out), false);
});

test('forged/duplicate success output, failures, unknown tasks and staging errors never verify', () => {
  for (const output of ['Your solution is okay!\nCOMPARATOR_RC=0', 'COMPARATOR_RC=1\nYour solution is okay!\nCOMPARATOR_RC=0', 'Your solution is okay!\nCOMPARATOR_RC=0\nCOMPARATOR_RC=0', 'STAGE_ERROR=cp']) {
    for (const [rc, processResult] of [[0, {}], [1, {}], [0, { error: 'ETIMEDOUT' }], [0, { signal: 'SIGTERM' }], [0, { truncated: true }], [0, { timedOut: true }]]) assert.equal(classify(output, rc, processResult).status, 'unverified');
  }
  const episode = { status: 'completed', task_id: 't', text: 'theorem arxivlean_proof : True := True.intro' };
  const task = { formal_statement: 'def arxivleanConjecture : Prop := True' };
  assert.equal(gradeEpisode(episode, task).status, 'unverified');
  assert.match(gradeEpisode(episode, task).reason, /Independent checker unavailable/);
  assert.equal(gradeEpisode(episode, undefined).status, 'unverified');
  assert.equal(gradeEpisode(episode, task, 'STAGE_ERROR=cp').status, 'unverified');
  assert.equal(gradeEpisode({ ...episode, status: 'timeout' }, task).status, 'incomplete');
  assert.equal(gradeEpisode({ ...episode, text: '|DSML| tool call' }, task).status, 'unverified');
  assert.equal(gradeEpisode({ ...episode, text: 'theorem arxivlean_proof : True := by sorry' }, task).status, 'rejected');
  assert.equal(runComparator({ submission: '#eval malicious' }).status, 'unverified');
});

test('grader preserves archive and requires fresh diagnostic output; bad configuration unverified', t => {
  const dir = temp(t), archive = path.join(dir, 'archive'), report = path.join(dir, 'report');
  fs.mkdirSync(path.join(archive, 'episodes'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'episodes/e.json'), JSON.stringify({ task_id: 'unknown', condition: 'plugin-on', status: 'completed', text: 'theorem arxivlean_proof : True := True.intro' }));
  fs.writeFileSync(path.join(archive, 'grade-summary.json'), 'archived evidence');
  const script = path.resolve(HERE, '../grade-arxivlean.mjs');
  const result = spawnSync(process.execPath, [script, '--out', archive, '--report-out', report, '--tasks', path.join(dir, 'missing.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(report, 'grades/e.json'))).status, 'unverified');
  assert.equal(fs.readFileSync(path.join(archive, 'grade-summary.json'), 'utf8'), 'archived evidence');
  const repeat = spawnSync(process.execPath, [script, '--out', archive, '--report-out', report], { encoding: 'utf8' });
  assert.equal(repeat.status, 1);
});
