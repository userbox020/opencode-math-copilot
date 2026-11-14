import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { budgetStop, COMPAT_TASK, makeSchedule, profileForRole, profileRole, promptFor, PROTOCOL, PROTOCOL_HASH, RETIRED_PROFILES, sha256, validatePublic } from '../lib.mjs';
import { admitEpisode, bridgeOptions, createFreshRegistration, currentSourceVersion, DRIVER_SOURCES,
  FRESH_HISTORICAL_EVIDENCE, FRESH_PROFILES, loadRegisteredArtifacts, nativePromptTransportMatch,
  PINS, profileManifest, validateFreshRegistration, validateTwoRegistrationFreeze, validateCheckpointFreezeBinding,
  assertStudyContinuation, isFinalizationReceipt } from '../admission.mjs';
import { main, executeStudy } from '../execute.mjs';

// Actual frozen historical bytes, not synthetic approval/capability fixtures.
const raw = readFileSync(FRESH_HISTORICAL_EVIDENCE.prereg.path);
const original = JSON.parse(raw).manifest;
const created_at = '2026-11-12T23:00:00.000Z';
const source_version = currentSourceVersion();
// A reference is only data at construction time. This deliberately does NOT
// satisfy loadRegisteredArtifacts' focused-verification evidence contract.
const verification = FRESH_HISTORICAL_EVIDENCE.diagnosis;
const registration = profile_id => createFreshRegistration({ profile_id, created_at, source_version, verification });
const mutate = (value, change) => { const copy = structuredClone(value); change(copy); return copy; };

function outputExists(out) {
  let stat;
  try { stat = lstatSync(out); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'present output is a real directory');
  return true;
}

function assertExecutableOutputState(options, absentError) {
  const load = () => loadRegisteredArtifacts({ ...options, execute: true });
  if (outputExists(options.out)) {
    assert.throws(load, /output_exists/, 'present output: executable loader fails closed');
    return null;
  }
  if (absentError) {
    assert.throws(load, absentError, 'absent output: downstream validation still rejects');
    return null;
  }
  let approved;
  assert.doesNotThrow(() => { approved = load(); assertStudyContinuation(approved); },
    'absent output: executable loader returns an owned continuation handle');
  return approved;
}

// Closed registrations cannot name arbitrary outputs. Redirect only these exact
// filesystem lookups to temporary fixtures; never change registration bindings,
// bypass loader checks, or read/write live checkpoint contents. Restore before
// returning (all callbacks are synchronous; no dispatch/setup is performed).
function withFixturePaths(t, redirects, check) {
  const mocks = ['lstatSync', 'readFileSync'].map(name => {
    const original = fs[name];
    return t.mock.method(fs, name, (file, ...args) => original(redirects.get(file) ?? file, ...args));
  });
  syncBuiltinESMExports();
  try { return check(); }
  finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
}

function freezeFixture(t) {
  const root = mkdtempSync(path.join(path.dirname(FRESH_HISTORICAL_EVIDENCE.prereg.path), 'two-freeze-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const file = path.join(root, name), raw = JSON.stringify(value, null, 2) + '\n';
    writeFileSync(file, raw); return { path: file, sha256: sha256(raw) };
  };
  const source = currentSourceVersion();
  const changes = createFreshRegistration({ profile_id: 'g023-compat', created_at, source_version: source, verification }).source_lineage.changes;
  const evidence = put('fixture-check.json', { fixture_only: true, no_model_calls: true });
  const check = put('verification.json', { schema: 'real-use-focused-verification/v1', source_version: source, changes,
    checks: [{ command: 'hermetic data fixture only; not external execution approval', exit_code: 0, evidence }] });
  const registrations = ['g023-compat', 'g024-workflows'].map(profile_id =>
    createFreshRegistration({ profile_id, created_at, source_version: source, verification: check }));
  const refs = registrations.map(value => ({ profile_id: value.profile_id, ...put(`${value.profile_id}.json`, value) }));
  const record = { schema: 'real-use-two-registration-freeze/v1', created_at: '2026-11-12T23:01:00.000Z', source_version: source, registrations: refs };
  const ref = put('freeze.json', record);
  const options = { registration: refs[0].path, registrationSha256: refs[0].sha256, out: registrations[0].study_out,
    freezeRecord: ref.path, freezeSha256: ref.sha256 };
  return { root, put, record, registrations, refs, ref, options };
}

test('two-registration freeze validates exact bytes and closed order without containing future outcomes or minting authority', t => {
  const f = freezeFixture(t), value = validateTwoRegistrationFreeze(f.options);
  assert.deepEqual(value.registrations, f.registrations); assert.deepEqual(value.record.registrations, f.refs);
  assert.equal(Object.isFrozen(value.record.registrations[0]), true); assert.equal(isFinalizationReceipt(value), false);
  assert.throws(() => assertStudyContinuation(value), /approved_artifacts_not_owned/);
  assert.deepEqual(Object.keys(value.record), ['schema', 'created_at', 'source_version', 'registrations']);
  assert.equal(value.record.registrations.some(ref => 'checkpoint_sha256' in ref), false);
});

test('freeze rejects swapped/missing profiles, extra keys, path/digest and stale source/time/lineage mismatches', t => {
  const f = freezeFixture(t);
  for (const change of [r => r.registrations.reverse(), r => r.registrations.pop(), r => { r.passed = true; },
    r => { r.probe_checkpoint_sha256 = 'a'.repeat(64); }, r => { r.registrations[1].ready = true; },
    r => { r.registrations[1].path = r.registrations[0].path; }, r => { r.registrations[1].sha256 = 'a'.repeat(64); },
    r => { r.registrations[1].path = 'relative.json'; }, r => { r.registrations[1].path = path.join(path.parse(f.root).root, 'outside.json'); },
    r => { r.source_version.source_sha256[DRIVER_SOURCES[0]] = 'a'.repeat(64); },
    r => { r.created_at = '2026-11-12T22:59:00.000Z'; }]) {
    const ref = f.put('bad-freeze.json', mutate(f.record, change));
    assert.throws(() => validateTwoRegistrationFreeze({ freezeRecord: ref.path, freezeSha256: ref.sha256 }));
  }
  for (const change of [r => { r.source_lineage.verification = verification; },
    r => { r.created_at = '2026-11-12T22:00:00.000Z'; r.manifest = profileManifest(r.profile_id, original, r.created_at); },
    r => { r.source_version.source_sha256[DRIVER_SOURCES[0]] = 'b'.repeat(64); }]) {
    const main = f.put('modified-main.json', mutate(f.registrations[1], change));
    const ref = f.put('bad-freeze.json', mutate(f.record, r => { r.registrations[1] = { profile_id: 'g024-workflows', ...main }; }));
    assert.throws(() => validateTwoRegistrationFreeze({ freezeRecord: ref.path, freezeSha256: ref.sha256 }));
  }
  const moved = `${f.refs[1].path}.saved`; renameSync(f.refs[1].path, moved);
  assert.throws(() => validateTwoRegistrationFreeze(f.options), /ENOENT/);
  renameSync(moved, f.refs[1].path);
  const alias = path.join(f.root, 'linked'); symlinkSync(f.root, alias, 'junction');
  const linked = f.put('linked-freeze.json', mutate(f.record, r => { r.registrations[1].path = path.join(alias, 'g024-workflows.json'); }));
  assert.throws(() => validateTwoRegistrationFreeze({ freezeRecord: linked.path, freezeSha256: linked.sha256 }), /unsafe_artifact/);
});

test('probe executable loader rejects absent/wrong freeze and modified main before output reservation or setup', async t => {
  const f = freezeFixture(t), before = existsSync(f.options.out);
  const { freezeRecord, freezeSha256, ...withoutFreeze } = f.options;
  const alias = f.put('same-probe-other-path.json', f.registrations[0]);
  for (const options of [withoutFreeze, { ...f.options, freezeSha256: 'a'.repeat(64) },
    { ...f.options, freezeRecord: undefined }, { ...f.options, registration: alias.path, registrationSha256: alias.sha256 },
    { ...f.options, registration: f.refs[1].path, registrationSha256: f.refs[1].sha256 }]) {
    await assert.rejects(executeStudy({ ...options, execute: true }, { REAL_USE_ALLOW_EXECUTE: '1' }));
    assert.equal(existsSync(f.options.out), before);
  }
  writeFileSync(f.refs[1].path, readFileSync(f.refs[1].path) + ' ');
  await assert.rejects(executeStudy({ ...f.options, execute: true }, { REAL_USE_ALLOW_EXECUTE: '1' }), /frozen_registration_digest_mismatch/);
  assert.equal(existsSync(f.options.out), before);
});

test('matching pair loads only with absent output, otherwise rejects output_exists; preview remains non-authorizing', async t => {
  const f = freezeFixture(t), before = existsSync(f.options.out);
  const approved = assertExecutableOutputState(f.options) ?? withFixturePaths(t,
    new Map([[f.options.out, path.join(f.root, 'absent-output')]]), () => assertExecutableOutputState(f.options));
  assertStudyContinuation(approved);
  assert.equal(isFinalizationReceipt(approved), false);
  assert.deepEqual(approved.registration_pair, f.refs);
  assert.equal(sha256(approved.freeze_raw), f.ref.sha256);
  const preview = loadRegisteredArtifacts({ ...f.options, execute: false });
  assert.throws(() => assertStudyContinuation(preview), /preview_not_executable/);
  await assert.rejects(admitEpisode({ manifest: preview.manifest, item: preview.manifest.schedule[0], task: COMPAT_TASK,
    bridge: { passed: true }, approvedArtifacts: preview }), /preview_not_executable/);
  const { freezeRecord, freezeSha256, ...withoutFreeze } = f.options;
  const pending = loadRegisteredArtifacts(withoutFreeze);
  assert.equal(pending.freeze_ref, null); assert.throws(() => assertStudyContinuation(pending), /preview_not_executable/);
  const shown = await main(['--registration', f.options.registration, '--registration-sha256', f.options.registrationSha256,
    '--out', f.options.out, '--freeze-record', freezeRecord, '--freeze-sha256', freezeSha256, '--dry-run']);
  assert.equal(shown.registration_freeze.status, 'validated_data_only'); assert.equal(shown.admission, 'not_assessed');
  await assert.rejects(admitEpisode({ manifest: approved.manifest, item: approved.manifest.schedule[0], task: COMPAT_TASK,
    bridge: { passed: true }, approvedArtifacts: approved }), /genuine_owned_bridge_required/);
  assert.equal(existsSync(f.options.out), before);
});

test('output-state gate and freeze/registration mutation independently fence setup and admission', async t => {
  for (const target of ['freeze', 'probe', 'main', 'verification']) {
    const f = freezeFixture(t);
    const approved = assertExecutableOutputState(f.options) ?? withFixturePaths(t,
      new Map([[f.options.out, path.join(f.root, 'absent-output')]]), () => assertExecutableOutputState(f.options));
    const file = target === 'freeze' ? f.ref.path : target === 'verification' ? f.registrations[0].source_lineage.verification.path : f.refs[target === 'probe' ? 0 : 1].path;
    writeFileSync(file, readFileSync(file) + ' ');
    assert.throws(() => assertStudyContinuation(approved), /freeze_digest_mismatch|frozen_registration_digest_mismatch|focused_verification_binding_mismatch/);
    assert.throws(() => bridgeOptions(approved, approved.manifest.schedule[0], COMPAT_TASK), /freeze_digest_mismatch|frozen_registration_digest_mismatch|focused_verification_binding_mismatch/);
    await assert.rejects(admitEpisode({ manifest: approved.manifest, item: approved.manifest.schedule[0], task: COMPAT_TASK,
      bridge: { passed: true }, approvedArtifacts: approved }), /freeze_digest_mismatch|frozen_registration_digest_mismatch|focused_verification_binding_mismatch/);
  }
});

test('probe checkpoint must bind the identical freeze and exact main bytes, never merely matching creation dates', t => {
  const f = freezeFixture(t);
  const checkpoint = { schema: 'real-use-first-pair-checkpoint/v1', profile_id: 'g023-compat', run_id: f.registrations[0].run_id,
    registration_sha256: f.refs[0].sha256, registration_hash: sha256(f.registrations[0]), protocol_hash: f.registrations[0].manifest.protocol_hash,
    source_version: f.record.source_version, episode_ids: [], passed: true, checks: {}, failure_codes: [], accounting: {}, artifacts: [],
    freeze_sha256: f.ref.sha256, registration_pair: f.refs };
  assert.equal(validateCheckpointFreezeBinding(checkpoint, f.ref.sha256, f.refs), true);
  assert.equal(isFinalizationReceipt(checkpoint), false);
  assert.throws(() => assertStudyContinuation(checkpoint), /approved_artifacts_not_owned/);
  for (const value of [mutate(checkpoint, c => { delete c.freeze_sha256; }),
    mutate(checkpoint, c => { c.freeze_sha256 = 'a'.repeat(64); }),
    mutate(checkpoint, c => { c.registration_pair[1].sha256 = 'a'.repeat(64); }),
    mutate(checkpoint, c => { c.registration_pair[1].path += '.later.json'; })])
    assert.throws(() => validateCheckpointFreezeBinding(value, f.ref.sha256, f.refs), /invalid_probe_checkpoint|probe_checkpoint_freeze_mismatch/);
  const options = { ...f.options, registration: f.refs[1].path, registrationSha256: f.refs[1].sha256,
    out: f.registrations[1].study_out };
  assertExecutableOutputState(options, /externally_bound_probe_checkpoint_required/);
  withFixturePaths(t, new Map([[options.out, path.join(f.root, 'absent-output')]]), () =>
    assertExecutableOutputState(options, /externally_bound_probe_checkpoint_required/));
});

test('synthetic output branch: present rejects output_exists; absent reaches focused-evidence validation', t => {
  const f = freezeFixture(t);
  const options = { ...f.options, registration: f.refs[1].path, registrationSha256: f.refs[1].sha256,
    out: f.registrations[1].study_out };
  const verificationPath = f.registrations[1].source_lineage.verification.path;
  writeFileSync(verificationPath, readFileSync(verificationPath) + ' ');
  // Existing fixture root versus an uncreated child: no study output is made or removed.
  withFixturePaths(t, new Map([[options.out, f.root]]), () => assertExecutableOutputState(options));
  const absent = path.join(f.root, 'absent-output');
  withFixturePaths(t, new Map([[options.out, absent]]), () =>
    assertExecutableOutputState(options, /artifact_digest_mismatch/));
  assert.equal(existsSync(absent), false, 'loader never reserves the synthetic output');
});

test('historical preregistration and protocol remain pinned', () => {
  assert.equal(sha256(raw), PINS.prereg);
  assert.equal(PROTOCOL_HASH, 'ba564a83403eb4e8baa33984ed3eea31c4e6633e7f53d8f7012c150f8f1552cb');
  assert.equal(sha256(PROTOCOL), original.protocol_hash);
  assert.equal(DRIVER_SOURCES.length, 8);
});
test('exactly two immutable source-defined profiles, disjoint nonborrowable budgets', () => {
  assert.deepEqual(Object.keys(FRESH_PROFILES), ['g023-compat', 'g024-workflows']);
  const probe = FRESH_PROFILES['g023-compat'], main = FRESH_PROFILES['g024-workflows'];
  assert.equal(probe.protocol.max_cost_usd, 0.1);
  assert.equal(main.protocol.max_cost_usd, 0.9);
  assert.equal(probe.protocol.max_episodes, 2);
  assert.equal(main.protocol.max_episodes, 20);
  assert.equal(probe.task_count, 1); assert.equal(main.task_count, 10);
  assert.equal(probe.run_id, 'real-use-g023-compat-20261113');
  assert.equal(main.run_id, 'real-use-g024-workflows-20261113');
  assert.equal(probe.study_out, 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\real-use-g023-compat-20261113');
  assert.equal(main.study_out, 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\real-use-g024-workflows-20261113');
  assert.notEqual(probe.study_out, main.study_out);
  assert.equal(probe.protocol.max_cost_usd + main.protocol.max_cost_usd, 1);
  for (const profile of [probe, main]) {
    assert.equal(profileForRole(profile.role), profile);
    assert.equal(profileRole(profile.profile_id), profile.role);
    assert.equal(Object.isFrozen(profile), true);
    for (const key of ['live_model', 'live_repeats', 'timeout_ms', 'concurrency', 'retries', 'resume', 'provider_fallback', 'prompt_suffix']) {
      assert.equal(profile.protocol[key], PROTOCOL[key]);
    }
    assert.match(profile.protocol.cost_limit, /no borrowing.*not a billing cap/);
    const manifest = profileManifest(profile.profile_id, original, created_at);
    assert.equal(manifest.seed, 'real-use-v1'); assert.equal(manifest.repeats, 1);
    assert.equal(budgetStop([{ usage: { cost_usd: profile.protocol.max_cost_usd } }], manifest.budgets), 'soft_cost_limit');
  }
  for (const role of ['main', '', undefined, '__proto__']) assert.throws(() => profileForRole(role), /invalid_fresh_profile_role/);
  assert.throws(() => { probe.protocol.max_cost_usd = 1; }, TypeError);
  assert.match(main.protocol.cost_limit, /no borrowing.*not a billing cap/);
});
test('all eighteen retired profiles are immutable disclosure only; exact old registration bytes and rehashed references cannot execute', async t => {
  const f = freezeFixture(t);
  assert.deepEqual(Object.keys(RETIRED_PROFILES), ['g005-compat', 'g006-workflows', 'g007-compat', 'g008-workflows', 'g009-compat', 'g010-workflows', 'g011-compat', 'g012-workflows', 'g013-compat', 'g014-workflows', 'g015-compat', 'g016-workflows', 'g017-compat', 'g018-workflows', 'g019-compat', 'g020-workflows', 'g021-compat', 'g022-workflows']);
  assert.equal(RETIRED_PROFILES['g005-compat'].disposition, 'Stopped safety_failure after one ON attempt (finalization failure; cause not then attributable).');
  assert.equal(RETIRED_PROFILES['g006-workflows'].disposition, 'Never started.');
  assert.equal(RETIRED_PROFILES['g007-compat'].disposition, 'Stopped safety_failure after one ON attempt with confirmed native_message_cursor_rejected (pager defect).');
  assert.equal(RETIRED_PROFILES['g008-workflows'].disposition, 'Never started.');
  assert.equal(RETIRED_PROFILES['g009-compat'].disposition, 'Stopped safety_failure after one ON attempt with confirmed native_child_scope_rejected (cursor-presence defect).');
  assert.equal(RETIRED_PROFILES['g010-workflows'].disposition, 'Never started.');
  assert.equal(RETIRED_PROFILES['g011-compat'].disposition, 'Stopped safety_failure after one ON attempt (observer event rejection, downstream finalization deadline).');
  assert.equal(RETIRED_PROFILES['g012-workflows'].disposition, 'Never started.');
  assert.equal(RETIRED_PROFILES['g013-compat'].disposition, 'Stopped safety_failure after one ON attempt (corroboration succeeded, rejected by an admission artifact row-shape assumption now fixed).');
  assert.equal(RETIRED_PROFILES['g014-workflows'].disposition, 'Never started.');
  assert.equal(RETIRED_PROFILES['g015-compat'].disposition, 'Stopped safety_failure after one ON attempt (observer event-timestamp hygiene rejection, now bounded).');
  assert.equal(RETIRED_PROFILES['g016-workflows'].disposition, 'Never started.');
  assert.equal(RETIRED_PROFILES['g017-compat'].disposition, 'Probe passed both conditions with validated receipts and a passing checkpoint.');
  assert.equal(RETIRED_PROFILES['g018-workflows'].disposition, 'Partial main study: 10/20 delivered, 1 operational failure; stopped because argv transport rejected negative-number prompt fragments.');
  assert.equal(RETIRED_PROFILES['g019-compat'].disposition, 'One ON attempt aborted before spawn: launcher rejected the new stdin digest as an unknown option; fixed and re-controlled.');
  assert.equal(RETIRED_PROFILES['g020-workflows'].disposition, 'Never started.');
  assert.equal(RETIRED_PROFILES['g021-compat'].disposition, 'Probe passed both conditions over stdin with validated receipts and a passing checkpoint.');
  assert.equal(RETIRED_PROFILES['g022-workflows'].disposition, 'Partial main study over stdin: 4/20 delivered, 1 operational failure; stopped on a recovery/auxiliary event gate.');
  const oldFreezes = ['g005_two_registration_freeze', 'g007_two_registration_freeze', 'g009_two_registration_freeze', 'g011_two_registration_freeze', 'g013_two_registration_freeze', 'g015_two_registration_freeze', 'g017_two_registration_freeze', 'g019_two_registration_freeze', 'g021_two_registration_freeze'].map(key =>
    JSON.parse(readFileSync(FRESH_HISTORICAL_EVIDENCE[key].path)));
  for (const [index, retired] of Object.values(RETIRED_PROFILES).entries()) {
    assert.equal(Object.isFrozen(retired), true);
    assert.equal(Object.hasOwn(FRESH_PROFILES, retired.profile_id), false);
    assert.equal(retired.run_id, `real-use-${retired.profile_id}-${index < 2 ? '20261112' : '20261113'}`);
    assert.equal(retired.study_out, `C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\${retired.run_id}`);
    assert.throws(() => { retired.disposition = 'ready'; }, TypeError);
    assert.throws(() => profileRole(retired.profile_id), /unknown_fresh_profile/);
    assert.throws(() => profileManifest(retired.profile_id, original, created_at), /unknown_fresh_profile/);
    assert.throws(() => registration(retired.profile_id), /unknown_fresh_profile/);
    const oldRef = oldFreezes[Math.floor(index / 2)].registrations[index % 2], oldBytes = readFileSync(oldRef.path);
    assert.equal(oldRef.profile_id, retired.profile_id); assert.equal(sha256(oldBytes), oldRef.sha256);
    const file = path.join(f.root, `${retired.profile_id}.json`); writeFileSync(file, oldBytes);
    const rehashed = sha256(readFileSync(file)), value = JSON.parse(oldBytes);
    assert.throws(() => validateFreshRegistration(value), /invalid_fresh_profile_identity/);
    const options = { ...f.options, registration: file, registrationSha256: rehashed, out: retired.study_out };
    assert.throws(() => loadRegisteredArtifacts(options), /invalid_fresh_profile_identity/);
    await assert.rejects(executeStudy({ ...options, execute: true }, { REAL_USE_ALLOW_EXECUTE: '1' }), /invalid_fresh_profile_identity/);
    const ref = f.put('retired-freeze.json', mutate(f.record, r => { r.registrations[index % 2] = { profile_id: retired.profile_id, path: file, sha256: rehashed }; }));
    assert.throws(() => validateTwoRegistrationFreeze({ freezeRecord: ref.path, freezeSha256: ref.sha256 }), /invalid_frozen_registration_reference/);
  }
});
test('compat task matches actual public schema, ASCII quotes and unchanged suffix', () => {
  assert.equal(validatePublic([COMPAT_TASK])[0], COMPAT_TASK);
  assert.equal(COMPAT_TASK.prompt, 'Call approved_list. Then call approved_read with path "preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md", offset 5 and limit 1. Report the returned date line and its source path.');
  for (const key of ['g005_two_registration_freeze', 'g007_two_registration_freeze', 'g009_two_registration_freeze', 'g011_two_registration_freeze', 'g013_two_registration_freeze', 'g015_two_registration_freeze', 'g017_two_registration_freeze', 'g019_two_registration_freeze', 'g021_two_registration_freeze']) {
    const oldFreeze = JSON.parse(readFileSync(FRESH_HISTORICAL_EVIDENCE[key].path));
    const retired = JSON.parse(readFileSync(oldFreeze.registrations[0].path));
    assert.equal(JSON.stringify([COMPAT_TASK]), JSON.stringify(retired.manifest.tasks));
    assert.equal(PROTOCOL.prompt_suffix, retired.manifest.protocol.prompt_suffix);
  }
  const prompt = promptFor(COMPAT_TASK);
  assert.ok(prompt.endsWith(`\n\n${PROTOCOL.prompt_suffix}`));
  assert.ok(nativePromptTransportMatch({ args: ['run', '--server', 'http://127.0.0.1:1234', '--session', 'ses_probe', '--model',
    `${PROTOCOL.live_model}#default`, '--agent', 'math-eval', '--format', 'json'], stdin: Buffer.from(prompt), stdin_sha256: sha256(prompt) }, prompt));
});
test('probe schedule uses the unchanged seeded ON/OFF scheduler', () => {
  const manifest = profileManifest('g023-compat', original, created_at);
  assert.deepEqual(manifest.schedule, makeSchedule([COMPAT_TASK], manifest));
  assert.equal(manifest.schedule.length, 2);
  assert.deepEqual(new Set(manifest.schedule.map(item => item.condition)), new Set(['plugin-on', 'plugin-off']));
  assert.equal(manifest.protocol_hash, sha256(manifest.protocol));
  assert.notEqual(manifest.protocol_hash, PROTOCOL_HASH);
});
test('main preserves all original task bytes and frozen twenty-item projected order', () => {
  const manifest = profileManifest('g024-workflows', original, created_at);
  const project = schedule => schedule.map(({ task_id, condition, model, repeat }) => ({ task_id, condition, model, repeat }));
  assert.equal(JSON.stringify(manifest.tasks), JSON.stringify(original.tasks));
  assert.equal(manifest.tasks.length, 10);
  assert.equal(sha256(manifest.tasks), 'eb0a0bcc1c8451dba11293c52e97e923640c005d9ef51107984a2bd2ad260d22');
  assert.deepEqual(project(manifest.schedule), project(original.schedule));
  assert.equal(manifest.schedule[0].task_id, 'hanner-released-pdf');
  assert.ok(manifest.schedule.every(item => item.episode_id.startsWith(manifest.run_id)));
  assert.equal(manifest.effective_variant, 'default');
  for (const key of ['timeout_ms', 'concurrency', 'retries', 'resume', 'provider_fallback', 'prompt_suffix']) {
    assert.equal(manifest.protocol[key], PROTOCOL[key]);
  }
});
test('unknown profiles, historical run and altered baseline data cannot define a profile', () => {
  for (const profile of ['g004', 'real-use-g004-20261112', '__proto__', 'arbitrary']) {
    assert.throws(() => profileManifest(profile, original, created_at), /unknown_fresh_profile/);
  }
  for (const change of [m => { m.tasks[0].prompt += '!'; }, m => m.schedule.reverse(), m => { m.protocol.max_cost_usd = 2; }]) {
    assert.throws(() => profileManifest('g024-workflows', mutate(original, change), created_at), /historical_manifest_mismatch/);
  }
});
test('next-day canonical registration time preserves closed profile identities and every non-time field', () => {
  const nextDay = '2026-11-13T02:00:00.000Z';
  const pair = ['g023-compat', 'g024-workflows'].map(profile_id => {
    const previous = registration(profile_id);
    const next = createFreshRegistration({ profile_id, created_at: nextDay, source_version, verification });
    assert.equal(validateFreshRegistration(next), true);
    assert.equal(next.created_at, nextDay); assert.equal(next.manifest.created_at, nextDay);
    assert.deepEqual(next, { ...previous, created_at: nextDay, manifest: { ...previous.manifest, created_at: nextDay } });
    assert.match(next.run_id, /20261113/);
    return next;
  });
  assert.equal(pair[0].created_at, pair[1].created_at);
  assert.equal(PROTOCOL_HASH, 'ba564a83403eb4e8baa33984ed3eea31c4e6633e7f53d8f7012c150f8f1552cb');
});
test('registration timestamps require canonical ISO at or after the deterministic lower bound', () => {
  for (const profile of ['g023-compat', 'g024-workflows']) {
    assert.equal(profileManifest(profile, original, '2026-11-12T00:00:00.000Z').created_at, '2026-11-12T00:00:00.000Z');
    for (const time of [undefined, null, 1794528000000, '', 'invalid', 'November 13, 2026', '2026-11-13',
      '2026-11-13T02:00:00Z', '2026-11-13T02:00:00.000+00:00', '2026-11-13t02:00:00.000z',
      '2026-11-31T02:00:00.000Z', '2026-11-13T25:00:00.000Z', '2026-11-11T23:59:59.999Z']) {
      assert.throws(() => profileManifest(profile, original, time), /invalid_registration_time/);
    }
  }
});
test('registrations bind exact identities, paths, evidence, exposure and separate prerequisite', () => {
  const probe = registration('g023-compat'), main = registration('g024-workflows');
  assert.equal(validateFreshRegistration(probe), true);
  assert.equal(validateFreshRegistration(main), true);
  assert.equal(probe.prerequisite_probe, null);
  assert.equal(main.prerequisite_probe.profile_id, probe.profile_id);
  assert.equal(main.prerequisite_probe.run_id, probe.run_id);
  assert.equal(main.prerequisite_probe.study_out, probe.study_out);
  assert.equal(main.prerequisite_probe.checkpoint_path, `${probe.study_out}\\first-pair-checkpoint.json`);
  assert.equal(main.prerequisite_probe.answer_correctness_is_pipeline_gate, false);
  assert.deepEqual(main.prerequisite_probe.blocking, ['unknown_usage', 'safety_failure', 'reported_cost_at_or_above_0.10']);
  assert.equal(main.exposure.classification, 'exploratory_not_confirmatory');
  assert.deepEqual(probe.source_version, main.source_version);
  assert.equal(main.created_at, probe.created_at);
  assert.equal(Object.hasOwn(main.prerequisite_probe, 'passed'), false);
  assert.equal(Object.hasOwn(main.prerequisite_probe, 'sha256'), false, 'future evidence digests do not rewrite the frozen registration');
});
test('new registrations require exact source-pinned historical disclosure paths and digests', () => {
  const expected = {
    g005_parent_approval: ['real-use-g005-freeze-handoff-W9Ub4y/parent-approval.json', '0b237304035e589156f19bf9376dc7197ecd42dfc0da1fa03f0512cc2bbe6358'],
    g005_two_registration_freeze: ['real-use-g005-freeze-handoff-W9Ub4y/two-registration-freeze.json', 'cc8913cf44bb57ab5236d8901ba1e812075243fc98e8150712f599409470f726'],
    g005_probe_report: ['real-use-g005-compat-20261112/evaluation/report.json', 'abd8c290ee5bb2186779c7ccac89009d8d1e7f92d3aec953d359d4d98435d0c5'],
    g007_parent_approval: ['real-use-g007-freeze-handoff-0InhYu/parent-approval.json', '1422ab16f69ae0087395ac60251e26b0bf32adae733e0d4c16082caa65a78c00'],
    g007_two_registration_freeze: ['real-use-g007-freeze-handoff-0InhYu/two-registration-freeze.json', 'c5cbba4e3f2229a2cf42a6a83c282dcc086f3c2cb41874d15e40d9fa16b708a0'],
    g007_execution_stop: ['real-use-g007-compat-20261113/execution-stop.json', 'd793fd72984675e741bef79e9236e281c741910931aae4101eda6a9b267c4ae0'],
    g009_parent_approval: ['real-use-g007-freeze-handoff-FpGezI/parent-approval.json', '60bc657e2f3e0e27719e6f6efd37c97f79f74dd34ac41762e62ccbc61edcd3d8'],
    g009_two_registration_freeze: ['real-use-g007-freeze-handoff-FpGezI/two-registration-freeze.json', '9714970c79f8ef51cf076db88fb50927eca1b0cb211f2173db865d92c0c91b59'],
    g009_execution_stop: ['real-use-g009-compat-20261113/execution-stop.json', '1e6c6b0878717352f1544ed3b53d15806f764a76a5b9f930f8b8744ba0a92901'],
    g011_parent_approval: ['real-use-g007-freeze-handoff-t484QK/parent-approval.json', '8766484230095e566c0cf46a8d4aecb13a10eb5deb394b3d0d0db0270909dda4'],
    g011_two_registration_freeze: ['real-use-g007-freeze-handoff-t484QK/two-registration-freeze.json', '9a69a2a90b83d70782d8366c250d23b86a5ad1136323e1c2548ace64db796e22'],
    g011_execution_stop: ['real-use-g011-compat-20261113/execution-stop.json', 'b4738ddd4db4d6fc186218eff6742d2c45197c6575f4b0e2f5bc6686c7448e2b'],
    g013_parent_approval: ['real-use-g007-freeze-handoff-E4xkA2/parent-approval.json', '8a6ed36853a911f67036e9ff17e13518f734cca4627855e342c2b216c888b1ac'],
    g013_two_registration_freeze: ['real-use-g007-freeze-handoff-E4xkA2/two-registration-freeze.json', '5766927cbe00901b90bf6a9ca2fd2d430c59ec3bb019bcf570d4e46a2cd15e88'],
    g013_execution_stop: ['real-use-g013-compat-20261113/execution-stop.json', 'a0a722f21ca1627a08ac3772be8a6032c77443663c302982536c5dd3280cddd9'],
    g013_native_completion_evidence: ['real-use-bridge-g013-s1XUTH/private/native-completion-evidence.json', 'bf9edf6fca9016ce45c30464e8e1fe49a75d4e4d70afe56c41672c8ab6eb2f54'],
    g015_parent_approval: ['real-use-g007-freeze-handoff-lE6XTf/parent-approval.json', 'e0d21170720a2daae6bb622cd71ac27394a0b28bffbf3e324241bb032f12665a'],
    g015_two_registration_freeze: ['real-use-g007-freeze-handoff-lE6XTf/two-registration-freeze.json', 'd0ea28d4cfd681c04c1bb57a719590a2aae0841c6fd647b9fe736ce99a7cc324'],
    g015_execution_stop: ['real-use-g015-compat-20261113/execution-stop.json', '5c74acae97a5de611bf04c10ea51ebbfb0bb9149545aad986631a9ccdbd47a07'],
    g017_parent_approval: ['real-use-g007-freeze-handoff-rfAoV3/parent-approval.json', 'bb879b4d9587cfb5d8ff446038521e05a07ce863ac25b8a67708b2605cf7b314'],
    g017_two_registration_freeze: ['real-use-g007-freeze-handoff-rfAoV3/two-registration-freeze.json', 'b1f0e664c7dda0453384e5c2d3d25c8da338f8a9b206e9a4d941e2bc12efd895'],
    g017_first_pair_checkpoint: ['real-use-g017-compat-20261113/first-pair-checkpoint.json', 'e8dcff9126a9f59188775186271111a8e29bcba48124b1dbc3dd6d8fc5227c33'],
    g018_execution_stop: ['real-use-g018-workflows-20261113/execution-stop.json', '1ad80492feacbc275fb2ceec90e08cbf63e0bd866e20cc9209a4fccd125ba15e'],
    g018_report: ['real-use-g018-workflows-20261113/evaluation/report.json', 'df1e7f3716e2308aa7e12110628c76b8f1aa04a5036c15864d0952f114f83283'],
    g019_parent_approval: ['real-use-g007-freeze-handoff-XpAQu4/parent-approval.json', '46ee72be9ede7b69b9591f1882688473849df59af89ec063193496ece1ebddd3'],
    g019_two_registration_freeze: ['real-use-g007-freeze-handoff-XpAQu4/two-registration-freeze.json', '8dc47b89b9ab9f505f58e1310b0cb73b3445d553977e72957c3e84df6ee399ec'],
    g019_execution_stop: ['real-use-g019-compat-20261113/execution-stop.json', 'f06760e32e480141ce6d9f8f63e81e4f317f5d3a12c033046896b8d93bdd5cf4'],
    g021_parent_approval: ['real-use-g007-freeze-handoff-gdtaCW/parent-approval.json', '42d5a91d4b61a37cd15d6b5600741f5220196e4efbdf05a41b6124bb52fae59a'],
    g021_two_registration_freeze: ['real-use-g007-freeze-handoff-gdtaCW/two-registration-freeze.json', '417d88c1dd35f271614454b20d45a5cd0d73476e01a7f508511cd3e80d61e65d'],
    g021_first_pair_checkpoint: ['real-use-g021-compat-20261113/first-pair-checkpoint.json', '0a0bc87d8b5e10aa9fb3cc0329937717deee96fb6b960899a18999323ba6510c'],
    g022_execution_stop: ['real-use-g022-workflows-20261113/execution-stop.json', '86e903d6a20f0ad627e9c7dc7dda2302830ec48185d6f75803b9388bb53d147b'],
    g022_report: ['real-use-g022-workflows-20261113/evaluation/report.json', 'c30341a2442face31701040bc923f235de32f526837350a7e580966d1c93b8f4'],
  };
  for (const profile of Object.keys(FRESH_PROFILES)) {
    const value = registration(profile);
    for (const [key, [file, hash]] of Object.entries(expected)) {
      const ref = value.historical_evidence[key];
      assert.deepEqual(ref, { path: path.join('C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode', file), sha256: hash });
      assert.equal(path.isAbsolute(ref.path), true); assert.equal(sha256(readFileSync(ref.path)), hash);
      assert.equal(Object.isFrozen(FRESH_HISTORICAL_EVIDENCE[key]), true);
      for (const change of [r => { delete r.historical_evidence[key]; },
        r => { r.historical_evidence[key].sha256 = 'f'.repeat(64); },
        r => { r.historical_evidence[key].path += '.foreign.json'; }]) {
        assert.throws(() => validateFreshRegistration(mutate(value, change)), /fresh_registration_binding_mismatch/);
      }
    }
  }
});
for (const key of ['g007_execution_stop', 'g009_execution_stop', 'g011_execution_stop', 'g013_execution_stop', 'g015_execution_stop', 'g018_execution_stop', 'g018_report', 'g019_execution_stop', 'g022_execution_stop', 'g022_report']) test(`rehashed registration with a mismatched ${key} hash is rejected before output reservation`, t => {
  const f = freezeFixture(t), before = existsSync(f.options.out);
  const changed = mutate(f.registrations[0], r => { r.historical_evidence[key].sha256 = 'f'.repeat(64); });
  const ref = f.put('wrong-stop-hash.json', changed);
  assert.throws(() => loadRegisteredArtifacts({ registration: ref.path, registrationSha256: ref.sha256,
    out: changed.study_out }), /fresh_registration_binding_mismatch/);
  const frozen = f.put('wrong-stop-freeze.json', mutate(f.record, r => { r.registrations[0] = { profile_id: changed.profile_id, ...ref }; }));
  assert.throws(() => loadRegisteredArtifacts({ ...f.options, registration: ref.path, registrationSha256: ref.sha256,
    freezeRecord: frozen.path, freezeSha256: frozen.sha256, execute: true }), /fresh_registration_binding_mismatch/);
  assert.equal(existsSync(f.options.out), before);
});
test('main cannot use a missing or foreign checkpoint, including any retired output path; compat rejects a checkpoint argument', t => {
  const f = freezeFixture(t), main = f.registrations[1], requirement = main.prerequisite_probe;
  const options = { ...f.options, registration: f.refs[1].path, registrationSha256: f.refs[1].sha256, out: main.study_out, execute: true };
  const probeBefore = outputExists(requirement.study_out), mainBefore = outputExists(main.study_out);
  assertExecutableOutputState(options, /externally_bound_probe_checkpoint_required/);
  const foreign = f.put('foreign-checkpoint.json', { schema: 'real-use-first-pair-checkpoint/v1', profile_id: 'g005-compat', passed: true });
  const compatOptions = { ...f.options, probeCheckpointSha256: foreign.sha256 };
  assertExecutableOutputState(compatOptions, /unexpected_probe_checkpoint/);
  const redirects = new Map([[options.out, path.join(f.root, 'absent-output')],
    [requirement.study_out, f.root], [requirement.checkpoint_path, path.join(f.root, 'missing-checkpoint.json')]]);
  withFixturePaths(t, redirects, () => {
    assertExecutableOutputState(options, /externally_bound_probe_checkpoint_required/);
    assertExecutableOutputState({ ...options, probeCheckpointSha256: foreign.sha256 }, /ENOENT/);
    redirects.set(requirement.checkpoint_path, foreign.path);
    assertExecutableOutputState({ ...options, probeCheckpointSha256: foreign.sha256 }, /invalid_probe_checkpoint/);
  });
  withFixturePaths(t, new Map([[f.options.out, path.join(f.root, 'absent-output')]]), () =>
    assertExecutableOutputState(compatOptions, /unexpected_probe_checkpoint/));
  for (const change of [r => { r.prerequisite_probe.checkpoint_path = foreign.path; },
    ...Object.values(RETIRED_PROFILES).flatMap(retired => [
      r => { r.prerequisite_probe.checkpoint_path = path.win32.join(retired.study_out, 'first-pair-checkpoint.json'); },
      r => { Object.assign(r.prerequisite_probe, { profile_id: retired.profile_id, run_id: retired.run_id, study_out: retired.study_out,
        checkpoint_path: path.win32.join(retired.study_out, 'first-pair-checkpoint.json') }); },
    ]),
    r => { r.prerequisite_probe = null; }]) {
    const altered = mutate(main, change), ref = f.put('foreign-main.json', altered);
    assert.throws(() => validateFreshRegistration(altered), /fresh_registration_binding_mismatch/);
    assert.throws(() => loadRegisteredArtifacts({ registration: ref.path, registrationSha256: ref.sha256,
      out: main.study_out, probeCheckpointSha256: foreign.sha256 }), /fresh_registration_binding_mismatch/);
  }
  assert.equal(outputExists(requirement.study_out), probeBefore, 'probe output state is unchanged');
  assert.equal(outputExists(main.study_out), mainBefore, 'main output state is unchanged');
});
test('registration exact schema rejects additions and missing fields', () => {
  const value = registration('g023-compat');
  for (const key of Object.keys(value)) assert.throws(() => validateFreshRegistration(mutate(value, r => { delete r[key]; })), /invalid_registration_keys/);
  for (const key of ['ready', 'model', 'module', 'executable', 'operator', 'profile']) {
    assert.throws(() => validateFreshRegistration({ ...value, [key]: true }), /invalid_registration_keys/);
  }
});
test('rehashed modified tasks, schedule, protocol, model, variant and budgets are rejected', () => {
  const value = registration('g024-workflows');
  for (const change of [
    m => { m.tasks[0].prompt += '!'; m.public_tasks_hash = sha256(m.tasks); },
    m => m.schedule.reverse(), m => { m.model = 'other/model'; }, m => { m.effective_variant = 'fast'; },
    m => { m.budgets.max_cost_usd = 1; }, m => { m.budgets.max_episodes = 21; },
    m => { m.protocol.retries = 1; m.protocol_hash = sha256(m.protocol); },
    m => { m.prompts[0].prompt_sha256 = 'a'.repeat(64); m.assembled_prompts_hash = sha256(m.prompts); },
  ]) assert.throws(() => validateFreshRegistration(mutate(value, r => change(r.manifest))), /fresh_registration_binding_mismatch/);
});
test('wrong run, output and purported checkpoint success never validate', () => {
  const value = registration('g024-workflows');
  for (const change of [r => { r.run_id = original.run_id; }, r => { r.study_out += '-other'; },
    r => { r.prerequisite_probe.passed = true; }, r => { r.prerequisite_probe.sha256 = null; },
    r => { r.prerequisite_probe.run_id = 'some-passed-probe'; }, r => { r.exposure.classification = 'confirmatory'; }]) {
    assert.throws(() => validateFreshRegistration(mutate(value, change)), /invalid_fresh_profile_identity|fresh_registration_binding_mismatch/);
  }
});
test('control pins, historical pins and exact eight-source set cannot be extended or replaced', () => {
  const value = registration('g023-compat');
  for (const change of [r => { r.control_bindings.checker.sha256 = 'a'.repeat(64); },
    r => { r.historical_evidence.parent_approval.sha256 = 'a'.repeat(64); },
    r => { r.source_version.source_sha256['bench/v4/real-use/checker/CheckOnly.lean'] = 'a'.repeat(64); },
    r => { delete r.source_version.source_sha256[DRIVER_SOURCES[0]]; }, r => { r.source_version.dirty = 'true'; }]) {
    assert.throws(() => validateFreshRegistration(mutate(value, change)), /fresh_registration_binding_mismatch|invalid_driver_source_set|invalid_source_version/);
  }
});
test('lineage exactly classifies changed approved drivers, never checker or policy exceptions', () => {
  const value = registration('g023-compat');
  const old = JSON.parse(readFileSync(FRESH_HISTORICAL_EVIDENCE.parent_approval.path)).source_sha256;
  assert.deepEqual(value.source_lineage.changes, DRIVER_SOURCES.filter(source => old[source] !== source_version.source_sha256[source])
    .map(source => ({ source, before_sha256: old[source], after_sha256: source_version.source_sha256[source] })));
  for (const change of [r => { r.source_lineage.changes = []; },
    r => { r.source_lineage.changes[0].before_sha256 = 'b'.repeat(64); },
    r => { r.source_lineage.changes[0].after_sha256 = 'b'.repeat(64); },
    r => { r.source_lineage.changes[0].source = 'checker/policy'; },
    r => { r.source_lineage.verification.path = 'relative.json'; },
    r => { r.source_lineage.verification.ready = true; }]) assert.throws(() => validateFreshRegistration(mutate(value, change)));
});
test('serialized registration cannot mint authority and historical artifacts cannot be relabeled', async () => {
  const value = registration('g023-compat');
  assert.throws(() => bridgeOptions(value, value.manifest.schedule[0], COMPAT_TASK), /approved_artifacts_not_owned/);
  await assert.rejects(admitEpisode({ manifest: value.manifest, item: value.manifest.schedule[0], task: COMPAT_TASK,
    bridge: {}, approvedArtifacts: value }), /approved_artifacts_not_owned/);
  assert.throws(() => loadRegisteredArtifacts({ registration: FRESH_HISTORICAL_EVIDENCE.prereg.path,
    registrationSha256: PINS.prereg, out: value.study_out }), /invalid_registration_keys/);
  assert.throws(() => loadRegisteredArtifacts({ registration: FRESH_HISTORICAL_EVIDENCE.prereg.path,
    out: value.study_out }), /registration_digest_required/);
});
