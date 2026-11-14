import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { budgetStop, makeManifest, profileManifest, promptFor, RETIRED_PROFILES, sha256 } from '../lib.mjs';
import { admitEpisode, assertCapabilityConsumed, consumeEpisodeCapability, consumeFinalizationReceipt, dispatchAdmittedEpisode, finishAdmittedEpisode, isFinalizationReceipt,
  loadApprovedArtifacts, nativePromptTransportMatch, snapshotEpisodeInputs, snapshotFinishFacts, snapshotSettledEpisode,
  assertStudyContinuation, evaluateFirstPairCheckpoint, persistFirstPairCheckpoint, validateNativeCompletionData,
  validateProbeToolCorrespondence, validateNativeArtifactData,
  GRADER_INTEGRATION_AMENDMENT, validateGraderIntegrationAmendment } from '../admission.mjs';
import { executeFixtureSchedule, executeStudy, main } from '../execute.mjs';
import { nativePromptBytes } from '../bridge.mjs';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'real-use-execution-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function fixture(t, options = {}) {
  const root = directory(t), out = path.join(root, 'out');
  const tasks = Array.from({ length: 10 }, (_, i) => ({ schema: 'real-use-task/v1', id: `task-${i}`, category: 'computation', family: 'fixture', prompt: `Fixture ${i}` }));
  const manifest = makeManifest(tasks, { model: 'fixture/no-provider', run_id: 'fixture-execution', seed: 'real-use-v1', workspace: root, max_cost_usd: 1, max_episodes: 20 });
  const observed = [], returned = [], capabilities = new Set(); let active = 0, highWater = 0, cleanupCalls = 0, captured = 0, audits = 0, contextAudits = 0;
  const startBridge = async item => {
    active++; highWater = Math.max(highWater, active); observed.push(item.episode_id); let cleaned = false;
    return { audit: async () => { audits++; return {}; }, auditContext: async () => { contextAudits++; return {}; },
      admit: async cap => { assert.equal(isFinalizationReceipt(cap), false); assert.equal(capabilities.has(cap), false); capabilities.add(cap); },
      dispatch: async () => { if (options.dispatchFailure) throw new Error('synthetic-private-value-not-for-artifacts'); return Object.freeze({ fixture_only: true }); },
      finish: async () => ({ fixture_only: true, identity_validation: { status: 'fixture-only' } }),
      cleanup: async () => {
        cleanupCalls++; if (!cleaned) { active--; cleaned = true; }
        if (options.mutateEpisodeOnCleanup && returned.length) {
          returned.at(-1).usage.cost_usd = 0; returned.at(-1).usage.known_subtotal.cost_usd = 0;
          returned.at(-1).status = 'failed'; returned.at(-1).safety_failure = true;
        }
        if (options.hangCleanup) return new Promise(() => {});
        if (options.cleanupFailure) throw new Error('fixture cleanup error');
        return { confirmed: true, server: { confirmed: true, active_processes: 0 }, daemon: { confirmed: true, active_processes: 0 } };
      } };
  };
  const capture = async input => {
    captured++;
    assert.ok(fs.existsSync(path.join(out, 'execution-start.json')));
    assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
    assert.equal(active, 1); assert.equal(input.setupMs >= 0, true);
    if (options.captureFailure) {
      fs.writeFileSync(path.join(input.directory, `${input.item.episode_id}.answer.txt`), 'Retained fixture partial answer', { flag: 'wx' });
      throw new Error('fixture capture failure');
    }
    const result = { ...input.item, fixture_only: true, status: 'completed', safety_failure: false,
      usage: { cost_usd: options.cost === undefined ? 0 : options.cost, known_subtotal: { cost_usd: options.subtotal ?? 0 } },
      text: 'Fixture answer; not a provider call' };
    fs.writeFileSync(path.join(input.directory, `${input.item.episode_id}.json`), JSON.stringify(result), { flag: 'wx' });
    returned.push(result);
    return result;
  };
  return { input: { manifest, out, startBridge, capture, cleanupMs: 10 }, root,
    state: () => ({ observed, returned, highWater, cleanupCalls, captured, active, audits, contextAudits, capabilities: capabilities.size }) };
}
async function noExternalWork(operation) {
  const spawn = childProcess.spawn, fetch = globalThis.fetch; let calls = 0;
  childProcess.spawn = () => { calls++; throw new Error('unexpected spawn'); };
  globalThis.fetch = () => { calls++; throw new Error('unexpected fetch'); }; syncBuiltinESMExports();
  try { await operation(); assert.equal(calls, 0); }
  finally { childProcess.spawn = spawn; globalThis.fetch = fetch; syncBuiltinESMExports(); }
}

test('help, previews and unauthorized execution have no writes, network or spawning; unsupported bridge fails before staging', async t => {
  const root = directory(t), out = path.join(root, 'out'), fake = path.join(root, 'fake.json');
  fs.writeFileSync(fake, JSON.stringify({ status: 'ready', checks: { passed: true } }));
  const before = fs.readdirSync(root);
  await noExternalWork(async () => {
    assert.match((await main(['--help'], {})).help, /--registration-sha256/);
    await assert.rejects(() => executeStudy({ execute: true }, {}), /execution_not_authorized/);
    const args = ['--registration', fake, '--registration-sha256', 'a'.repeat(64), '--out', out];
    await assert.rejects(() => main([...args, '--execute'], {}), /execution_not_authorized/);
    await assert.rejects(() => main([...args, '--dry-run'], {}), /artifact_digest_mismatch/);
    await assert.rejects(() => executeStudy({ execute: true, prereg: fake, amendment: fake, approvedArtifacts: fake, out }, { REAL_USE_ALLOW_EXECUTE: '1' }),
      /historical_execution_forbidden/);
  });
  assert.deepEqual(fs.readdirSync(root), before); assert.equal(fs.existsSync(out), false);
});

test('JSON ready, fake handles and fixture objects cannot mint, consume or finish production capabilities', async () => {
  const fake = Object.freeze({ status: 'passed', active: true, production_admission: true, getBindings: () => ({ status: 'passed' }) });
  await noExternalWork(async () => {
    await assert.rejects(() => admitEpisode({ manifest: fake, item: fake, task: fake, bridge: fake, approvedArtifacts: fake }), /approved_artifacts_not_owned/);
    for (const cap of [{}, fake, JSON.parse(JSON.stringify(fake))]) {
      assert.throws(() => consumeEpisodeCapability(cap, fake, fake), /invalid_or_consumed/);
      assert.throws(() => assertCapabilityConsumed(cap), /did_not_consume/);
      await assert.rejects(() => finishAdmittedEpisode(cap, fake, {}), /invalid_finish/);
      await assert.rejects(() => dispatchAdmittedEpisode(cap, fake, {}, {}), /invalid_dispatch/);
      assert.equal(isFinalizationReceipt(cap), false);
      assert.equal(consumeFinalizationReceipt(cap, {}, ''), false);
    }
  });
});

const nativePrefix = ['run', '--server', 'http://127.0.0.1:4123', '--session', 'ses_fixture', '--model',
  'opencode-go/deepseek-v4.1-flash#default', '--agent', 'math-eval', '--format', 'json'];
const nativeTransport = prompt => {
  const stdin = nativePromptBytes(prompt);
  return Object.freeze({ args: Object.freeze([...nativePrefix]), stdin, stdin_sha256: sha256(stdin) });
};
test('native stdin transport uses only fixed flags and preserves literal prompt bytes', () => {
  for (const prompt of ['approved prompt', '  repeated   spaces ', '∀ x : ℝ,\n\tx = "x"\n-2, -4],\n', 'x - 2; -3, -4]', 'single']) {
    const launch = nativeTransport(prompt);
    assert.deepEqual(launch.args, nativePrefix);
    assert.deepEqual(launch.stdin, Buffer.from(prompt));
    assert.equal(Object.isFrozen(launch), true); assert.equal(Object.isFrozen(launch.args), true);
    assert.throws(() => { launch.stdin = Buffer.from('replacement'); }, TypeError);
    assert.equal(nativePromptTransportMatch(launch, prompt), true);
    assert.equal(isFinalizationReceipt(launch), false);
    for (const extra of [['extra'], ['--'], [prompt], prompt.split(' ')])
      assert.equal(nativePromptTransportMatch({ ...launch, args: [...nativePrefix, ...extra] }, prompt), false);
  }
  assert.equal(nativePromptTransportMatch({ args: nativePrefix, stdin: Buffer.alloc(0), stdin_sha256: sha256('') }, ''), false);
  assert.equal(nativePromptTransportMatch({ ...nativeTransport('approved prompt'), args: ['run', 'approved', 'prompt'] }, 'approved prompt'), false);
  assert.equal(nativePromptTransportMatch({ ...nativeTransport('approved prompt'), args: [...nativePrefix, 'approved', null] }, 'approved prompt'), false);
});

test('native transport accepts option-like stdin data but rejects changed flags/models and mismatched owned scope', () => {
  for (const fragment of ['--', '--model', '--title=fake', '-m', '-h', '-1--server', '-2,', '-4],']) {
    const prompt = `Text ${fragment} tail`;
    assert.equal(nativePromptTransportMatch(nativeTransport(prompt), prompt), true);
  }
  for (const [index, value] of [[0, 'serve'], [1, '--attach'], [2, 'https://example.invalid'], [2, 'http://127.0.0.1:65536'],
    [2, 'http://user:password@127.0.0.1:4123'], [3, '--continue'], [4, 'unscoped'], [6, 'other/model#default'], [8, 'other-agent'], [10, 'text']]) {
    const args = [...nativePrefix]; args[index] = value;
    assert.equal(nativePromptTransportMatch({ ...nativeTransport('Prompt'), args }, 'Prompt'), false);
  }
  const launch = nativeTransport('Prompt');
  assert.equal(nativePromptTransportMatch(launch, 'Prompt', { serverURL: nativePrefix[2], sessionID: nativePrefix[4] }), true);
  assert.equal(nativePromptTransportMatch(launch, 'Prompt', { serverURL: 'http://127.0.0.1:4124' }), false);
  assert.equal(nativePromptTransportMatch(launch, 'Prompt', { sessionID: 'ses_other' }), false);
});

test('native stdin matcher rejects missing, changed, NUL and oversize bytes and invalid digests', () => {
  const prompt = 'Exact prompt\n', launch = nativeTransport(prompt), changed = Buffer.from(launch.stdin);
  changed[0] ^= 1;
  for (const stdin of [undefined, null, prompt, new Uint8Array(launch.stdin), changed, Buffer.from('Exact\0prompt\n')])
    assert.equal(nativePromptTransportMatch({ ...launch, stdin, stdin_sha256: Buffer.isBuffer(stdin) ? sha256(stdin) : launch.stdin_sha256 }, prompt), false);
  for (const stdin_sha256 of [undefined, null, '0'.repeat(64)])
    assert.equal(nativePromptTransportMatch({ ...launch, stdin_sha256 }, prompt), false);
  const nul = Buffer.from('bad\0input');
  assert.equal(nativePromptTransportMatch({ ...launch, stdin: nul, stdin_sha256: sha256(nul) }, 'bad\0input'), false);
  assert.equal(nativePromptTransportMatch({ ...launch, args: [...nativePrefix.slice(0, -1), 'json\0'] }, prompt), false);
  const maximum = 'x'.repeat(1024 * 1024);
  assert.equal(nativePromptTransportMatch(nativeTransport(maximum), maximum), true);
  const oversized = Buffer.from(maximum + 'x');
  assert.equal(nativePromptTransportMatch({ ...launch, stdin: oversized, stdin_sha256: sha256(oversized) }, maximum + 'x'), false);
});

test('all ten frozen public prompts produce exact native stdin bytes with no positional arguments', () => {
  const tasks = JSON.parse(fs.readFileSync(new URL('../tasks/public.json', import.meta.url), 'utf8'));
  assert.equal(tasks.length, 10); assert.equal(sha256(tasks), 'eb0a0bcc1c8451dba11293c52e97e923640c005d9ef51107984a2bd2ad260d22');
  for (const task of tasks) {
    const prompt = promptFor(task), launch = nativeTransport(prompt);
    assert.equal(nativePromptTransportMatch(launch, prompt), true, task.id);
    assert.equal(launch.stdin.equals(Buffer.from(prompt)), true);
    assert.deepEqual(launch.args, nativePrefix);
  }
});

test('fixture controller uses exactly twenty frozen adjacent episodes sequentially with unique nonproduction capabilities', async t => {
  const f = fixture(t), original = sha256(f.input.manifest), result = await executeFixtureSchedule(f.input), state = f.state();
  assert.equal(result.fixture_only, true); assert.equal(result.captured_episodes, 20); assert.equal(result.reason, 'max_episodes');
  assert.equal(state.highWater, 1); assert.equal(state.active, 0); assert.equal(state.cleanupCalls, 20); assert.equal(state.capabilities, 20);
  assert.equal(state.audits, 20); assert.equal(state.contextAudits, 20, 'admission audits each episode exactly once; controller never duplicates it');
  assert.deepEqual(state.observed, f.input.manifest.schedule.map(item => item.episode_id)); assert.equal(sha256(f.input.manifest), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.out, 'manifest.json'), 'utf8')), f.input.manifest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.out, 'execution-stop.json'), 'utf8')).attempted_setups, 20);
});

test('fixture unknown cost permits only first counterpart, while known subtotal and safety failures stop immediately', async t => {
  for (const [options, count, reason] of [
    [{ cost: null, subtotal: 0.02 }, 2, 'unknown_cost'],
    [{ cost: null, subtotal: 1 }, 1, 'soft_cost_limit'],
    [{ cost: 1 }, 1, 'soft_cost_limit'],
    [{ cleanupFailure: true }, 1, 'safety_failure'],
    [{ hangCleanup: true }, 1, 'safety_failure'],
  ]) {
    const f = fixture(t, options), result = await executeFixtureSchedule(f.input);
    assert.equal(result.captured_episodes, count); assert.equal(result.reason, reason);
    assert.equal(f.state().cleanupCalls, count); assert.equal(f.state().observed.length, count);
    assert.equal(fs.readdirSync(path.join(result.out, 'episodes')).length, count, 'finally preserves captured evidence');
  }
});

test('setup and capture failures remain visible outside episodes, clean up once, and never replace an attempt', async t => {
  for (const options of [{ dispatchFailure: true }, { captureFailure: true }]) {
    const f = fixture(t, options), result = await executeFixtureSchedule(f.input);
    assert.equal(result.reason, 'safety_failure'); assert.equal(result.attempted_setups, 1); assert.equal(result.captured_episodes, 0);
    assert.equal(f.state().cleanupCalls, 1); assert.equal(f.state().observed.length, 1);
    const failure = fs.readFileSync(path.join(result.out, 'setup', '00.failure.json'), 'utf8');
    assert.doesNotMatch(failure, /synthetic-private-value/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.out, 'execution-stop.json'), 'utf8')).setup_failures.length, 1);
    if (options.captureFailure) assert.equal(fs.readFileSync(path.join(result.out, 'episodes', `${f.input.manifest.schedule[0].episode_id}.answer.txt`), 'utf8'), 'Retained fixture partial answer');
  }
});

test('fresh-output and test/production separation cannot be bypassed by fixture flags or rerunning a schedule', async t => {
  const f = fixture(t), out = f.input.out;
  fs.mkdirSync(out); fs.writeFileSync(path.join(out, 'existing.txt'), 'preserve');
  const modified = fs.statSync(path.join(out, 'existing.txt')).mtimeMs;
  await assert.rejects(() => executeFixtureSchedule(f.input), /output_exists/);
  assert.equal(f.state().observed.length, 0); assert.deepEqual(fs.readdirSync(out), ['existing.txt']);
  assert.equal(fs.statSync(path.join(out, 'existing.txt')).mtimeMs, modified);
  await assert.rejects(() => executeFixtureSchedule({ ...f.input, manifest: { ...f.input.manifest, run_id: 'real-use-g004-20261112' } }), /test_fixture_only/);
  await assert.rejects(() => executeStudy({ ...f.input, fixture_only: true }, {}), /execution_not_authorized/);
  assert.throws(() => loadApprovedArtifacts({ prereg: path.join(out, 'existing.txt'), amendment: '', approvedArtifacts: '', out }), /artifact_digest_mismatch/);
});

test('data-only authoritative snapshots resist caller mutation across awaited audit, dispatch and finish without minting authority', async t => {
  const f = fixture(t), manifest = f.input.manifest, original = manifest.schedule[0];
  const task = manifest.tasks.find(task => task.id === original.task_id);
  const callerItem = structuredClone(original), callerTask = structuredClone(task);
  let releaseAudit; const auditWait = new Promise(resolve => { releaseAudit = resolve; });
  const bound = snapshotEpisodeInputs(manifest, 0, callerItem, callerTask);
  const audited = (async () => { await auditWait; return bound; })();
  callerItem.model = 'mutated/model'; callerItem.episode_id = manifest.schedule[1].episode_id; callerTask.prompt = 'mutated prompt';
  releaseAudit(); const record = await audited;
  assert.deepEqual(record.item, original); assert.deepEqual(record.task, task);
  assert.notEqual(record.item, callerItem); assert.notEqual(record.task, callerTask);
  assert.ok(Object.isFrozen(record.item)); assert.ok(Object.isFrozen(record.task));
  let releaseDispatch; const dispatchWait = new Promise(resolve => { releaseDispatch = resolve; });
  const dispatched = (async ({ item, task }) => { await dispatchWait; return { item, prompt: promptFor(task) }; })(record);
  callerTask.prompt = 'changed during dispatch'; callerItem.condition = 'changed'; releaseDispatch();
  assert.deepEqual((await dispatched).item, original); assert.equal((await dispatched).prompt, promptFor(task));

  const controller = new AbortController(), promptHash = sha256(promptFor(task));
  const observations = { observed_models: [original.model], observed_session_ids: ['ses_original'], prompt_sha256: promptHash, signal: controller.signal };
  const facts = snapshotFinishFacts(observations, promptHash);
  let releaseFinish; const finishWait = new Promise(resolve => { releaseFinish = resolve; });
  const finished = (async () => { await finishWait; return facts; })();
  observations.observed_models[0] = 'mutated/model'; observations.observed_session_ids.push('ses_extra'); observations.prompt_sha256 = 'wrong';
  observations.signal = new AbortController().signal; controller.abort(); releaseFinish();
  const saved = await finished;
  assert.deepEqual(saved.observed_models, [original.model]); assert.deepEqual(saved.observed_session_ids, ['ses_original']);
  assert.equal(saved.prompt_sha256, promptHash); assert.equal(saved.signal.aborted, true);
  assert.throws(() => saved.observed_models.push('changed'), TypeError);
  assert.equal(isFinalizationReceipt(record), false); assert.equal(isFinalizationReceipt(saved), false);
  assert.throws(() => consumeEpisodeCapability(record, {}, {}), /invalid_or_consumed/);
  assert.throws(() => snapshotEpisodeInputs(manifest, 0, callerItem, callerTask), /admission_schedule/);
  assert.throws(() => snapshotFinishFacts({ ...observations, observed_models: [null] }, promptHash), /invalid_finish_observations/);
});

test('settlement clones and freezes billing, validates persisted identity/usage, and resists later mutations in budget decisions', async t => {
  const f = fixture(t, { cost: null, subtotal: 0.02, mutateEpisodeOnCleanup: true });
  const result = await executeFixtureSchedule(f.input);
  assert.equal(result.captured_episodes, 2); assert.equal(result.reason, 'unknown_cost');
  const stop = JSON.parse(fs.readFileSync(path.join(result.out, 'execution-stop.json'), 'utf8'));
  assert.ok(stop.episodes.every(episode => episode.status === 'completed' && episode.safety_failure === false));
  const item = f.input.manifest.schedule[0];
  const persisted = JSON.parse(fs.readFileSync(path.join(result.out, 'episodes', `${item.episode_id}.json`), 'utf8'));
  const caller = structuredClone(persisted), settled = snapshotSettledEpisode(caller, item, persisted);
  caller.usage.cost_usd = 0; caller.usage.known_subtotal.cost_usd = 0; caller.safety_failure = true;
  assert.equal(settled.usage.cost_usd, null); assert.equal(settled.usage.known_subtotal.cost_usd, 0.02); assert.equal(settled.safety_failure, false);
  assert.equal(budgetStop([settled], f.input.manifest.budgets), 'unknown_cost');
  assert.ok(Object.isFrozen(settled.usage)); assert.ok(Object.isFrozen(settled.usage.known_subtotal));
  assert.throws(() => snapshotSettledEpisode(caller, item, persisted), /persisted_mismatch/);
  for (const usage of [{ cost_usd: -1 }, { cost_usd: NaN }, { cost_usd: '0' }, { known_subtotal: { cost_usd: -1 } },
    { coverage: { cost_usd: -1 } }, { cost_usd: 0, completeness: { episode_complete: false } }]) {
    assert.throws(() => snapshotSettledEpisode({ ...persisted, usage }, item), /invalid_settled/);
  }
  assert.throws(() => snapshotSettledEpisode({ ...persisted, condition: 'other' }, item), /invalid_settled/);
});

function graderAmendmentDataFixture() {
  // Pinned operator-smoke artifacts are read only as data. No checker, Docker,
  // bridge, capability minting or model inference is performed by this fixture.
  const root = 'C:/Users/MiPC/AppData/Local/Temp/opencode', pin = GRADER_INTEGRATION_AMENDMENT;
  return { sourceHashes: { [pin.source]: pin.from_sha256, [pin.adapter_source]: pin.adapter_sha256,
    'unchanged-fixture-source': 'c'.repeat(64) }, currentGradeHash: pin.to_sha256, currentAdapterHash: pin.adapter_sha256,
    artifacts: Object.fromEntries(Object.entries(pin.artifacts).map(([key, value]) => [key, fs.readFileSync(path.join(root, pin.root, value.path))])),
    buildBytes: fs.readFileSync(path.join(root, 'eval-checker-g004-789fe1d19ce243fda0851cb8601e7712/build-receipt.json')),
    followupBytes: fs.readFileSync(path.join(root, 'eval-checker-g004-followup-summary-lbMi2u/followup-summary.json')) };
}

test('exact grader lineage validates fresh pinned synthetic smoke data and changes only the grader expectation', async () => {
  const input = graderAmendmentDataFixture(), before = { ...input.sourceHashes }, pin = GRADER_INTEGRATION_AMENDMENT;
  assert.equal(pin.to_sha256, 'cd73166bcd0ec44a67e97569dc3b6da4ac3e1eac9b1f161ac5ed82fd85973722');
  assert.equal(pin.to_sha256, sha256(fs.readFileSync(new URL('../grade.mjs', import.meta.url))));
  assert.equal(pin.root, 'eval-checker-g024-grade-cli-Q7xuKv');
  await noExternalWork(async () => {
    const result = validateGraderIntegrationAmendment(input);
    assert.deepEqual(input.sourceHashes, before, 'historical controls/source map are not mutated');
    assert.deepEqual(result.sourceHashes, { ...before, [pin.source]: pin.to_sha256 });
    assert.equal(result.metadata.scope, 'operator synthetic CLI smoke not model outcome');
    assert.equal(result.metadata.from_sha256, pin.from_sha256); assert.equal(result.metadata.to_sha256, pin.to_sha256);
    assert.equal(result.metadata.evidence_sha256.summary, pin.artifacts.summary.sha256);
    assert.ok(Object.isFrozen(result.metadata.evidence_sha256));
    assert.equal(isFinalizationReceipt(result), false);
    assert.throws(() => consumeEpisodeCapability(result, {}, {}), /invalid_or_consumed/);
  });
});

test('grader integration rejects the superseded to_sha256 despite otherwise valid fresh evidence', () => {
  const input = graderAmendmentDataFixture();
  input.currentGradeHash = '5b7c9cf3290d52aeff06a6e4fe145e3c02566e9bade9cadb92384708f39d0446';
  assert.throws(() => validateGraderIntegrationAmendment(input), { message: 'grader_integration_source_lineage_mismatch' });
});

test('grader integration amendment rejects other transitions, paths, missing/tampered artifacts, adapter changes and wrong build/follow-up', () => {
  const pin = GRADER_INTEGRATION_AMENDMENT;
  for (const update of [
    input => { input.currentGradeHash = '0'.repeat(64); },
    input => { input.sourceHashes[pin.source] = '0'.repeat(64); },
    input => { input.sourceHashes['other/grade.mjs'] = input.sourceHashes[pin.source]; delete input.sourceHashes[pin.source]; },
    input => { input.currentAdapterHash = '0'.repeat(64); },
    input => { input.sourceHashes[pin.adapter_source] = '0'.repeat(64); },
    input => { input.buildBytes = Buffer.from('{}'); },
    input => { input.followupBytes = Buffer.from('{}'); },
    ...Object.keys(pin.artifacts).flatMap(key => [
      input => { delete input.artifacts[key]; },
      input => { input.artifacts[key] = Buffer.concat([input.artifacts[key], Buffer.from(' ')]); },
    ]),
    input => { const summary = JSON.parse(input.artifacts.summary); summary.cleanup = 'unconfirmed'; input.artifacts.summary = Buffer.from(JSON.stringify(summary)); },
    input => { const summary = JSON.parse(input.artifacts.summary); summary.no_provider_calls = false; input.artifacts.summary = Buffer.from(JSON.stringify(summary)); },
  ]) {
    const input = graderAmendmentDataFixture(); update(input);
    assert.throws(() => validateGraderIntegrationAmendment(input), /grader_integration_(?:source_lineage|evidence_digest)_mismatch/);
  }
});

function nativeDataFixture(profile = 'g024-workflows') {
  const original = JSON.parse(fs.readFileSync('C:/Users/MiPC/AppData/Local/Temp/opencode/real-use-prereg-g004.json')).manifest;
  const manifest = profileManifest(profile, original, '2026-11-12T23:00:00.000Z');
  const facts = [], receipts = [], cleanups = [];
  const episodes = manifest.schedule.slice(0, 2).map((item, index) => {
    const final_text = 'Intentionally wrong quotation: reporting correctness is not the operational gate.';
    const input = { observed_session_ids: [`ses_fixture_${index}`], observed_models: [manifest.model],
      prompt_sha256: sha256(promptFor(manifest.tasks.find(task => task.id === item.task_id))),
      final_text, final_text_sha256: sha256(final_text), captured_assistant_message_ids: [`msg_fixture_${index}`],
      cli_closed_at: 1000, solver_deadline: 2000, native_closure_clean: false,
      capture_usage: { cost_usd: null, known_subtotal: { cost_usd: 0.003 }, completeness: { episode_complete: false } } };
    const usage = { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      cost_usd: 0.01, steps: 1, completeness: { status: 'platform_recorded_total', episode_complete: true, scope: 'OpenCode-recorded not billing' } };
    const receipt = { identity_validation: { status: 'validated', model: manifest.model, variant: 'default', session_id: input.observed_session_ids[0], prompt_sha256: input.prompt_sha256 },
      guard: { status: 'passed', nonce: `fixture-nonce-${index}-12345`, context_evidence_sha256: 'd'.repeat(64) },
      cleanup: { confirmed: true, server: { confirmed: true, active_processes: 0 }, daemon: { confirmed: true, active_processes: 0 },
        cli: { confirmed: true, active_processes: 0, status: 'confirmed_absent', process_tree_containment: true } },
      completion_evidence: { schema: 'real-use-completion-evidence/v1', policy: 'native-platform-v1', basis: 'native_corroborated', cli_complete: false,
        kind: 'native_preclose_witness', timestamp_basis: { closed_at_ms: 1000, idle_at_ms: 900, witness_present: true },
        witness_sha256: 'a'.repeat(64), post_release_bindings_sha256: 'b'.repeat(64), native_snapshot_sha256: ['c'.repeat(64), 'c'.repeat(64)],
        final_text_sha256: input.final_text_sha256, native_message_id: input.captured_assistant_message_ids[0], pricing_sha256: 'd'.repeat(64),
        native_usage_sha256: sha256(usage), evidence_path: 'C:/fixture/native-completion-evidence.json', evidence_sha256: 'e'.repeat(64) },
      native_recorded_usage: usage, tool_evidence: [], upstream_usage_complete: 'unknown', billed_usd: null };
    facts.push(input); receipts.push(receipt); cleanups.push({ episode_id: item.episode_id, cleanup: receipt.cleanup });
    return { ...item, ...receipt, status: 'completed', operational_classification: 'completed_answer', finalization: { status: 'validated_owned_receipt' },
      protocol_hash: manifest.protocol_hash, final_text, final_text_sha256: input.final_text_sha256, usage, capture_usage: input.capture_usage,
      safety_failure: false, model_mismatch: false, exit_code: 0, timeout: false, provider_errors: 0, extraction_failures: 0 };
  });
  return { manifest, episodes, facts, receipts, cleanups };
}

test('fresh finish snapshots copy all reconciliation facts before awaits and preserve only the live abort signal', () => {
  const data = nativeDataFixture(), input = data.facts[0], controller = new AbortController(); input.signal = controller.signal;
  const snapshot = snapshotFinishFacts(input, input.prompt_sha256, { fresh: true });
  input.captured_assistant_message_ids.push('msg_mutated'); input.capture_usage.known_subtotal.cost_usd = 999;
  input.final_text = 'changed'; input.solver_deadline = 1; controller.abort();
  assert.equal(snapshot.captured_assistant_message_ids.length, 1);
  assert.equal(snapshot.capture_usage.known_subtotal.cost_usd, 0.003);
  assert.equal(snapshot.solver_deadline, 2000); assert.equal(snapshot.signal.aborted, true);
  assert.equal(sha256(snapshot.final_text), snapshot.final_text_sha256);
  assert.ok(Object.isFrozen(snapshot.capture_usage.known_subtotal));
  assert.equal(isFinalizationReceipt(snapshot), false);
  for (const change of [f => { delete f.capture_usage; }, f => { f.final_text_sha256 = 'f'.repeat(64); },
    f => { f.cli_closed_at = 3000; }, f => { f.timeout = true; }, f => { f.captured_assistant_message_ids = []; }]) {
    const malformed = structuredClone(data.facts[1]); change(malformed);
    assert.throws(() => snapshotFinishFacts(malformed, malformed.prompt_sha256, { fresh: true }), /invalid_fresh_finish_facts/);
  }
});

test('native completion data rejects missing witness, changing snapshots, wrong text, pricing, usage or native identity without minting authority', () => {
  const data = nativeDataFixture(), result = validateNativeCompletionData(data.receipts[0], data.facts[0]);
  assert.equal(result.native_recorded_usage.cost_usd, 0.01);
  assert.equal(isFinalizationReceipt(result), false);
  assert.equal(consumeFinalizationReceipt(result, data.episodes[0], data.facts[0].prompt_sha256), false);
  for (const change of [r => { r.completion_evidence.witness_sha256 = null; },
    r => { r.completion_evidence.native_snapshot_sha256[1] = 'f'.repeat(64); },
    r => { r.completion_evidence.native_message_id = 'msg_other'; }, r => { r.completion_evidence.final_text_sha256 = 'f'.repeat(64); },
    r => { r.completion_evidence.pricing_sha256 = null; }, r => { r.native_recorded_usage.cost_usd = null; },
    r => { r.native_recorded_usage.input_tokens = NaN; }, r => { r.native_recorded_usage.completeness.episode_complete = false; },
    r => { r.upstream_usage_complete = true; }, r => { r.billed_usd = 0; }, r => { r.completion_evidence.ready = true; }]) {
    const malformed = structuredClone(data.receipts[0]); change(malformed);
    assert.throws(() => validateNativeCompletionData(malformed, data.facts[0]), /native_/);
  }
});

test('completion kind and exact timestamp basis are data only and reject every inconsistent variant', () => {
  const data = nativeDataFixture(), facts = data.facts[0], receipt = structuredClone(data.receipts[0]);
  Object.assign(receipt.completion_evidence, { kind: 'native_timestamped_snapshot', witness_sha256: null,
    timestamp_basis: { closed_at_ms: 1000, idle_at_ms: 1000, witness_present: false } });
  const snapshot = validateNativeCompletionData(receipt, facts);
  assert.equal(snapshot.completion_evidence.kind, 'native_timestamped_snapshot');
  assert.ok(Object.isFrozen(snapshot.completion_evidence.timestamp_basis));
  assert.equal(isFinalizationReceipt(snapshot), false);
  assert.equal(consumeFinalizationReceipt(snapshot, data.episodes[0], facts.prompt_sha256), false);
  for (const mutate of [
    c => { c.kind = 'unknown_kind'; }, c => { delete c.kind; }, c => { c.extra = true; },
    c => { delete c.timestamp_basis; }, c => { c.timestamp_basis.extra = true; },
    c => { delete c.timestamp_basis.closed_at_ms; }, c => { delete c.timestamp_basis.idle_at_ms; },
    c => { delete c.timestamp_basis.witness_present; }, c => { c.timestamp_basis.witness_present = 'false'; },
    c => { c.timestamp_basis.closed_at_ms = -1; }, c => { c.timestamp_basis.closed_at_ms = 1000.5; },
    c => { c.timestamp_basis.idle_at_ms = NaN; }, c => { c.timestamp_basis.idle_at_ms = -1; },
    c => { c.timestamp_basis.idle_at_ms = 1001; }, c => { c.timestamp_basis.witness_present = true; },
    c => { c.witness_sha256 = 'a'.repeat(64); }, c => { delete c.witness_sha256; },
    c => { c.witness_sha256 = undefined; }, c => { c.cli_complete = true; c.basis = 'cli_terminal'; },
    c => { c.kind = 'native_preclose_witness'; }, c => { c.kind = 'cli_terminal'; },
    c => { c.basis = 'cli_terminal'; },
  ]) {
    const changed = structuredClone(receipt); mutate(changed.completion_evidence);
    // Agreeing caller flags and a later caller timestamp must not weaken C.
    assert.throws(() => validateNativeCompletionData(changed, { ...facts, cli_closed_at: 1500,
      native_closure_clean: changed.completion_evidence.cli_complete }), /native_/);
  }
  const cli = structuredClone(receipt);
  Object.assign(cli.completion_evidence, { kind: 'cli_terminal', basis: 'cli_terminal', cli_complete: true });
  assert.equal(validateNativeCompletionData(cli, { ...facts, native_closure_clean: true }).completion_evidence.kind, 'cli_terminal');
  cli.completion_evidence.timestamp_basis.witness_present = true;
  assert.throws(() => validateNativeCompletionData(cli, { ...facts, native_closure_clean: true }), /native_completion_kind_mismatch/);
  assert.equal(validateNativeCompletionData(data.receipts[0], facts).completion_evidence.kind, 'native_preclose_witness');
});

test('admission rejects preclose without a hash and timestamped evidence carrying witness claims', () => {
  const data = nativeDataFixture(), facts = data.facts[0];
  for (const variant of ['preclose-null-hash', 'timestamped-present', 'timestamped-hash', 'timestamped-cli']) {
    const receipt = structuredClone(data.receipts[0]), completion = receipt.completion_evidence;
    completion.witness_sha256 = null;
    if (variant !== 'preclose-null-hash') {
      completion.kind = 'native_timestamped_snapshot'; completion.timestamp_basis.witness_present = false;
      if (variant === 'timestamped-present') completion.timestamp_basis.witness_present = true;
      if (variant === 'timestamped-hash') completion.witness_sha256 = 'a'.repeat(64);
      if (variant === 'timestamped-cli') { completion.cli_complete = true; completion.basis = 'cli_terminal'; }
    }
    assert.throws(() => validateNativeCompletionData(receipt, { ...facts, native_closure_clean: completion.cli_complete }),
      /native_completion_kind_mismatch/, variant);
    assert.equal(isFinalizationReceipt(receipt), false);
  }
});

test('first-pair data predicates accept wrong answers but reject safety, unknown accounting, reused sessions, wrong scope and borrowed budgets', () => {
  const data = nativeDataFixture();
  assert.equal(evaluateFirstPairCheckpoint(data.manifest, data.episodes, data.cleanups).passed, true);
  const compat = nativeDataFixture('g023-compat');
  assert.equal(evaluateFirstPairCheckpoint(compat.manifest, compat.episodes, compat.cleanups).passed, true, 'valid but wrong compat answers are not an operational gate');
  for (const change of [e => { e[1].safety_failure = true; }, e => { e[1].capture_scope_error = true; },
    e => { e[1].usage = { cost_usd: null }; }, e => { e[1].identity_validation.session_id = e[0].identity_validation.session_id; },
    e => { e[1].identity_validation.model = 'different/model'; }, e => { e[1].identity_validation.variant = 'fast'; },
    e => { e[1].protocol_hash = 'f'.repeat(64); }, e => e.reverse(), e => { e[1].task_id = 'different-task'; },
    e => { e[1].completion_evidence.native_usage_sha256 = 'f'.repeat(64); }]) {
    const episodes = structuredClone(data.episodes); change(episodes);
    assert.equal(evaluateFirstPairCheckpoint(data.manifest, episodes, data.cleanups).passed, false);
  }
  const cleanup = structuredClone(data.cleanups); cleanup[1].cleanup.cli.active_processes = 1;
  assert.equal(evaluateFirstPairCheckpoint(data.manifest, data.episodes, cleanup).passed, false);
  for (const [profile, cost] of [['g023-compat', 0.05], ['g024-workflows', 0.45]]) {
    const value = nativeDataFixture(profile);
    for (const episode of value.episodes) { episode.usage.cost_usd = cost; episode.completion_evidence.native_usage_sha256 = sha256(episode.usage); }
    const check = evaluateFirstPairCheckpoint(value.manifest, value.episodes, value.cleanups);
    assert.equal(check.passed, false); assert.ok(check.failure_codes.includes('below_profile_soft_threshold'));
  }
  for (const change of [e => { e[1].usage = { cost_usd: null }; }, e => { e[1].safety_failure = true; },
    e => { e[1].usage.cost_usd = 0.10; e[1].completion_evidence.native_usage_sha256 = sha256(e[1].usage); }]) {
    const episodes = structuredClone(compat.episodes); change(episodes);
    assert.equal(evaluateFirstPairCheckpoint(compat.manifest, episodes, compat.cleanups).passed, false);
  }
  for (const { profile_id, run_id } of Object.values(RETIRED_PROFILES)) {
    const check = evaluateFirstPairCheckpoint({ ...data.manifest, profile_id, run_id }, data.episodes, data.cleanups);
    assert.equal(check.passed, false); assert.ok(check.failure_codes.includes('closed_profile'));
  }
});

test('checkpoint JSON, copied receipts and same-ID caller objects cannot unlock private continuation', async () => {
  const data = nativeDataFixture(), fake = { manifest: data.manifest, passed: true, cursor: 2,
    checkpoint: evaluateFirstPairCheckpoint(data.manifest, data.episodes, data.cleanups), registration: { ready: true } };
  assert.throws(() => persistFirstPairCheckpoint(fake), /approved_artifacts_not_owned/);
  assert.throws(() => assertStudyContinuation(fake), /approved_artifacts_not_owned/);
  for (const item of [data.episodes[0], { ...data.episodes[0], model: 'forged/model' }, { ...data.episodes[0], condition: 'plugin-off' }]) {
    assert.equal(consumeFinalizationReceipt(data.receipts[0], item, data.facts[0].prompt_sha256), false);
  }
  await assert.rejects(() => executeStudy({ execute: true, prereg: 'historical', approvedArtifacts: fake }, { REAL_USE_ALLOW_EXECUTE: '1' }), /historical_execution_forbidden/);
});

test('first-pair checkpoint hook runs only after second saved cleanup and blocks third setup on failure or persistence error', async t => {
  for (const mode of ['unknown', 'persistence']) {
    const f = fixture(t, mode === 'unknown' ? { cost: null } : {}); let calls = 0;
    f.input.firstPairCheckpoint = () => {
      calls++;
      assert.ok(fs.existsSync(path.join(f.input.out, 'setup', '01.cleanup.json')));
      assert.equal(fs.existsSync(path.join(f.input.out, 'setup', '02.start.json')), false);
      if (mode === 'persistence') throw new Error('fixture_persistence_failure');
      return { passed: false, fixture_only: true };
    };
    const result = await executeFixtureSchedule(f.input);
    assert.equal(calls, 1); assert.equal(result.attempted_setups, 2);
    assert.equal(result.reason, mode === 'unknown' ? 'first_pair_checkpoint_failed' : 'controller_artifact_failure');
    assert.equal(fs.existsSync(path.join(f.input.out, 'setup', '02.start.json')), false);
  }
});

test('fresh CLI rejects legacy flags, relative registrations, missing digest and malformed prerequisites before output side effects', async t => {
  const root = directory(t), out = path.join(root, 'untouched'), file = path.join(root, 'fake.json');
  fs.writeFileSync(file, '{}'); const before = fs.readdirSync(root);
  await noExternalWork(async () => {
    await assert.rejects(() => main(['--prereg', file, '--execute'], { REAL_USE_ALLOW_EXECUTE: '1' }), /unknown|unsupported/i);
    await assert.rejects(() => main(['--registration', 'relative.json', '--registration-sha256', 'a'.repeat(64), '--out', out]), /absolute_binding_paths_required/);
    await assert.rejects(() => main(['--registration', file, '--out', out]), /explicit_binding_paths_required/);
    await assert.rejects(() => main(['--registration', file, '--registration-sha256', sha256('{}'), '--out', out,
      '--probe-checkpoint-sha256', 'b'.repeat(64)]), /invalid_registration_keys/);
  });
  assert.deepEqual(fs.readdirSync(root), before); assert.equal(fs.existsSync(out), false);
});

test('execute CLI requires the explicit two-registration freeze; bad preview references are not ignored', async t => {
  const root = directory(t), out = path.join(root, 'untouched'), file = path.join(root, 'fake.json');
  fs.writeFileSync(file, '{}'); const before = fs.readdirSync(root);
  const args = ['--registration', file, '--registration-sha256', sha256('{}'), '--out', out];
  await noExternalWork(async () => {
    const help = (await main(['--help'], {})).help;
    assert.match(help, /--freeze-record ABS_FILE --freeze-sha256 HEX/);
    await assert.rejects(main([...args, '--execute'], { REAL_USE_ALLOW_EXECUTE: '1' }), /two_registration_freeze_required/);
    await assert.rejects(main([...args, '--execute', '--freeze-record', file], { REAL_USE_ALLOW_EXECUTE: '1' }), /two_registration_freeze_required/);
    await assert.rejects(main([...args, '--dry-run', '--freeze-record', 'relative.json', '--freeze-sha256', 'a'.repeat(64)]), /invalid_freeze_artifact_path/);
    await assert.rejects(main([...args, '--dry-run', '--freeze-sha256', 'a'.repeat(64)]), /invalid_freeze_artifact_path/);
    await assert.rejects(main([...args, '--freeze-config', file]), /unknown|unsupported/i);
  });
  assert.deepEqual(fs.readdirSync(root), before); assert.equal(fs.existsSync(out), false);
});

test('probe requires actual ordered native/CLI list/read input-result correspondence, never prose or counts', () => {
  const source = 'preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md';
  const snapshot = 'f'.repeat(64), data = nativeDataFixture('g023-compat'), receipt = structuredClone(data.receipts[0]);
  const values = [
    ['approved_list', {}, { sources: [{ path: source, sha256: 'a'.repeat(64) }], manifest_sha256: snapshot }],
    ['approved_read', { path: source, offset: 5, limit: 1 }, { path: source, lines: [{ line: 5, text: 'Fixture date line' }], manifest_sha256: snapshot }],
  ];
  const events = values.map(([name, input, output], index) => ({ type: 'tool_use', sessionID: receipt.identity_validation.session_id,
    part: { id: `call_fixture_${index}`, messageID: receipt.completion_evidence.native_message_id, tool: name,
      state: { status: 'completed', input, output: JSON.stringify(output) } } }));
  receipt.tool_evidence = values.map(([name, input, output], index) => ({ name, call_id: `call_fixture_${index}`,
    native_assistant_id: receipt.completion_evidence.native_message_id, status: 'completed', input_sha256: sha256(input), output_sha256: sha256(JSON.stringify(output)) }));
  assert.equal(validateProbeToolCorrespondence(events, receipt, { snapshot_sha256: snapshot }), true);
  assert.equal(isFinalizationReceipt(receipt), false);
  for (const change of [e => e.reverse(), e => e.pop(), e => { e[0].part.id = 'call_forged'; },
    e => { e[1].part.messageID = 'msg_forged'; }, e => { e[1].sessionID = 'ses_forged'; },
    e => { e[1].part.state.input.limit = 2; }, e => { e[1].part.state.output = 'Printed success, no actual result'; },
    e => { e[1].part.state.status = 'pending'; }]) {
    const modified = structuredClone(events); change(modified);
    assert.throws(() => validateProbeToolCorrespondence(modified, receipt, { snapshot_sha256: snapshot }), /probe_|native_capture/);
  }
  assert.throws(() => validateProbeToolCorrespondence(events, receipt, { snapshot_sha256: 'b'.repeat(64) }), /probe_required_tools_missing/);
  assert.throws(() => validateProbeToolCorrespondence([], { ...receipt, tool_evidence: [], final_text: 'approved_list and approved_read succeeded' },
    { snapshot_sha256: snapshot }), /probe_required_tools_missing/);
});

function nativeArtifactDataFixture() {
  const data = nativeDataFixture(), facts = data.facts[0], receipt = structuredClone(data.receipts[0]);
  const modelHash = sha256({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default' });
  const binding = { profile_id: data.manifest.profile_id, protocol_hash: data.manifest.protocol_hash, registration_sha256: '1'.repeat(64),
    run_id: data.manifest.run_id, episode_id: data.episodes[0].episode_id, nonce: receipt.guard.nonce, prompt_sha256: facts.prompt_sha256,
    snapshot_sha256: '2'.repeat(64), source_sha256: { 'bench/v4/real-use/bridge.mjs': '3'.repeat(64) } };
  const incarnation = 'fixture-incarnation-1234';
  const pricing = { schema: 'real-use-native-pricing/v1', source: 'owned-selected-model-public-catalog', model_sha256: modelHash,
    rates: { input: 1, output: 1, cache_read: 0, cache_write: 0 } };
  const post = [{ ordinal: 1, release_digest: '4'.repeat(64), event_id: 'evt_step_fixture', event_sha256: '5'.repeat(64),
    native_assistant_id: facts.captured_assistant_message_ids[0], incarnation, session_sha256: sha256(receipt.identity_validation.session_id),
    prompt_sha256: facts.prompt_sha256, model_sha256: modelHash, basis: 'post_context_release_step_start', identity_sha256: '6'.repeat(64) }];
  const snapshot = { session_id: receipt.identity_validation.session_id, session_sha256: '7'.repeat(64),
    rows: [{ id: 'msg_user_fixture', type: 'user', sha256: '8'.repeat(64) },
      { id: facts.captured_assistant_message_ids[0], type: 'assistant', sha256: '9'.repeat(64) }, { id: 'msg_idle_fixture', type: 'idle', sha256: 'a'.repeat(64) }],
    inbox_count: 0, child_count: 0, final_message_id: facts.captured_assistant_message_ids[0], final_text_sha256: facts.final_text_sha256, idle_at_ms: 900 };
  const witness = { event_id: 'evt_success_fixture', created: 900, received_at_ms: 950, received_after_closure: false, seq: 2,
    session_sha256: sha256(receipt.identity_validation.session_id), incarnation, prompt_sha256: facts.prompt_sha256 };
  Object.assign(receipt.completion_evidence, { pricing_sha256: sha256(pricing), post_release_bindings_sha256: sha256(post),
    native_snapshot_sha256: [sha256(snapshot), sha256(snapshot)], witness_sha256: sha256(witness) });
  const { evidence_path, evidence_sha256, ...completion } = receipt.completion_evidence;
  const { snapshot_sha256, ...header } = binding;
  const artifact = { schema: 'real-use-native-completion-artifact/v1', ...header, incarnation, session_id: receipt.identity_validation.session_id,
    snapshot_manifest_sha256: snapshot_sha256, completion_evidence: completion, post_release_bindings: post, witness,
    seal: { phase: 'sealed', ordinal: 1, released: 1, model_requests: 1, active_tools: 0, violations: 0, records_sha256: 'b'.repeat(64) },
    native_snapshot: snapshot, native_recorded_usage: receipt.native_recorded_usage, pricing, tool_evidence: [], upstream_usage_complete: 'unknown', billed_usd: null };
  return { artifact, receipt, binding, facts };
}

test('native artifact allowlist binds source, registration, model, exact assistant interval, seal and pre-closure witness', () => {
  const { artifact, receipt, binding, facts } = nativeArtifactDataFixture();
  assert.equal(validateNativeArtifactData(artifact, receipt, binding, facts), true);
  assert.equal(isFinalizationReceipt(artifact), false);
  for (const change of [a => { a.profile_id = 'g023-compat'; }, a => { a.registration_sha256 = 'f'.repeat(64); },
    a => { a.source_sha256['bench/v4/real-use/bridge.mjs'] = 'f'.repeat(64); }, a => { a.nonce = 'forged-same-episode'; },
    a => { a.seal.active_tools = 1; }, a => { a.seal.phase = 'released'; }, a => { a.unexpected_data = {}; }]) {
    const value = structuredClone(artifact); change(value);
    assert.throws(() => validateNativeArtifactData(value, receipt, binding, facts), /native_/);
  }
  const late = structuredClone(artifact), lateReceipt = structuredClone(receipt);
  late.witness.received_at_ms = 1001;
  late.witness.received_after_closure = true;
  late.completion_evidence.witness_sha256 = sha256(late.witness);
  lateReceipt.completion_evidence.witness_sha256 = sha256(late.witness);
  assert.throws(() => validateNativeArtifactData(late, lateReceipt, binding, facts), /native_artifact_witness_mismatch/);
  late.witness.created = 1001;
  late.completion_evidence.witness_sha256 = sha256(late.witness);
  lateReceipt.completion_evidence.witness_sha256 = sha256(late.witness);
  assert.throws(() => validateNativeArtifactData(late, lateReceipt, binding, { ...facts, cli_closed_at: 1500 }), /native_artifact_witness_mismatch/);
  const timestamped = structuredClone(artifact), timestampedReceipt = structuredClone(receipt);
  timestamped.witness = null;
  for (const completion of [timestamped.completion_evidence, timestampedReceipt.completion_evidence]) {
    completion.kind = 'native_timestamped_snapshot'; completion.witness_sha256 = null; completion.timestamp_basis.witness_present = false;
  }
  assert.equal(validateNativeArtifactData(timestamped, timestampedReceipt, binding, facts), true);
  assert.equal(isFinalizationReceipt(timestampedReceipt), false);
  timestamped.native_snapshot.idle_at_ms = 1001;
  for (const completion of [timestamped.completion_evidence, timestampedReceipt.completion_evidence])
    completion.native_snapshot_sha256 = [sha256(timestamped.native_snapshot), sha256(timestamped.native_snapshot)];
  assert.throws(() => validateNativeArtifactData(timestamped, timestampedReceipt, binding, { ...facts, cli_closed_at: 1500 }), /native_artifact_snapshot_mismatch/);
  const reused = structuredClone(artifact), wrongReceipt = structuredClone(receipt);
  reused.post_release_bindings[0].model_sha256 = 'f'.repeat(64);
  reused.completion_evidence.post_release_bindings_sha256 = sha256(reused.post_release_bindings);
  wrongReceipt.completion_evidence.post_release_bindings_sha256 = sha256(reused.post_release_bindings);
  assert.throws(() => validateNativeArtifactData(reused, wrongReceipt, binding, facts), /native_artifact_correspondence_mismatch/);
});

for (const [name, leadingSwitch, mutate, error] of [
  ['no switch', false, () => {}, null],
  ['one leading switch', true, () => {}, null],
  ['two switches', true, rows => rows.splice(1, 0, { ...rows[0], id: 'msg_switch_second' }), /native_artifact_snapshot_mismatch/],
  ['switch not first', true, rows => { [rows[0], rows[1]] = [rows[1], rows[0]]; }, /native_artifact_snapshot_mismatch/],
  ['switch not followed by user', true, rows => { [rows[1], rows[2]] = [rows[2], rows[1]]; }, /native_artifact_snapshot_mismatch/],
  ['unsupported switch type', true, rows => { rows[0].type = 'system'; }, /native_artifact_snapshot_mismatch/],
  ['non-assistant interior type', true, rows => { rows[2].type = 'user'; }, /native_artifact_snapshot_mismatch/],
  ['unsupported interior type', true, rows => { rows[2].type = 'tool'; }, /native_artifact_snapshot_mismatch/],
  ['short list without switch', false, rows => rows.splice(1, 1), /native_artifact_snapshot_mismatch/],
  ['long list without switch', false, rows => rows.splice(1, 0, { id: 'msg_extra', type: 'user', sha256: 'c'.repeat(64) }), /native_artifact_snapshot_mismatch/],
  ['short list with switch', true, rows => rows.splice(2, 1), /native_artifact_snapshot_mismatch/],
  ['long list with switch', true, rows => rows.splice(2, 0, { id: 'msg_extra', type: 'user', sha256: 'c'.repeat(64) }), /native_artifact_snapshot_mismatch/],
  ['duplicate switch ID', true, rows => { rows[0].id = rows[1].id; }, /invalid_native_snapshot_row/],
  ['non-digest switch hash', true, rows => { rows[0].sha256 = 'not-a-digest'; }, /invalid_native_snapshot_row/],
  ['non-string switch ID', true, rows => { rows[0].id = 123; }, /invalid_native_snapshot_row/],
  ['oversized switch ID', true, rows => { rows[0].id = 'x'.repeat(257); }, /invalid_native_snapshot_row/],
]) {
  test(`native artifact row shape: ${name}`, () => {
    const { artifact, receipt, binding, facts } = nativeArtifactDataFixture();
    const rows = artifact.native_snapshot.rows;
    if (leadingSwitch) rows.unshift({ id: 'msg_switch_fixture', type: 'agent-switched', sha256: 'c'.repeat(64) });
    mutate(rows);
    for (const completion of [artifact.completion_evidence, receipt.completion_evidence])
      completion.native_snapshot_sha256 = [sha256(artifact.native_snapshot), sha256(artifact.native_snapshot)];
    if (error) assert.throws(() => validateNativeArtifactData(artifact, receipt, binding, facts), error);
    else assert.equal(validateNativeArtifactData(artifact, receipt, binding, facts), true);
  });
}

test('native artifact with leading switch still requires exact assistant-ID ordering', () => {
  const { artifact, receipt, binding, facts } = nativeArtifactDataFixture();
  const earlierID = 'msg_earlier_fixture';
  facts.captured_assistant_message_ids.unshift(earlierID);
  artifact.post_release_bindings.unshift({ ...artifact.post_release_bindings[0], native_assistant_id: earlierID, event_id: 'evt_earlier_fixture' });
  artifact.post_release_bindings[1].ordinal = 2;
  artifact.native_recorded_usage.steps = receipt.native_recorded_usage.steps = 2;
  Object.assign(artifact.seal, { ordinal: 2, released: 2, model_requests: 2 });
  const rows = artifact.native_snapshot.rows;
  rows.unshift({ id: 'msg_switch_fixture', type: 'agent-switched', sha256: 'c'.repeat(64) });
  rows.splice(2, 0, { id: earlierID, type: 'assistant', sha256: 'd'.repeat(64) });
  for (const completion of [artifact.completion_evidence, receipt.completion_evidence]) {
    completion.post_release_bindings_sha256 = sha256(artifact.post_release_bindings);
    completion.native_usage_sha256 = sha256(artifact.native_recorded_usage);
    completion.native_snapshot_sha256 = [sha256(artifact.native_snapshot), sha256(artifact.native_snapshot)];
  }
  assert.equal(validateNativeArtifactData(artifact, receipt, binding, facts), true);
  [rows[2], rows[3]] = [rows[3], rows[2]];
  for (const completion of [artifact.completion_evidence, receipt.completion_evidence])
    completion.native_snapshot_sha256 = [sha256(artifact.native_snapshot), sha256(artifact.native_snapshot)];
  assert.throws(() => validateNativeArtifactData(artifact, receipt, binding, facts), /native_artifact_snapshot_mismatch/);
});
