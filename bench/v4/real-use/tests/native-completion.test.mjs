import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativeCorrespondence, nativeChildrenRows, readNativeMessagePages, projectNativePricing, nativeRecordedUsage,
  validateNativeCompletionSnapshot, inspectNativeCompletion, observeNativeEvents, createOwnedCLIObservation, createProductionDiagnostics,
  diagnosticReason, projectFinalizationDiagnostics, persistFinalizationDiagnostics, cleanupOwnedCLI, projectNativeCompletionKind } from '../bridge.mjs';
import { AGENT, TITLE, MODEL_REF, hash, isNativeCompletionProfile } from '../runtime-plugin.js';
import { consumeFinalizationReceipt, isFinalizationReceipt } from '../admission.mjs';
import { RETIRED_PROFILES } from '../lib.mjs';

test('native completion profile predicate admits only the executable pair with the unchanged hash format', () => {
  for (const id of ['g023-compat', 'g024-workflows']) {
    const protocolHash = hash({ completion_policy: 'native-platform-v1', fixture: 'profile-predicate' });
    assert.equal(isNativeCompletionProfile(id, protocolHash), true);
    for (const rejected of [...Object.keys(RETIRED_PROFILES), 'unknown', '', null, undefined])
      assert.equal(isNativeCompletionProfile(rejected, protocolHash), false);
    // This predicate intentionally checks syntax, not registered-hash equality.
    for (const malformed of [undefined, null, 123, '', protocolHash.slice(1), protocolHash + '0', 'A'.repeat(64), 'g'.repeat(64)])
      assert.equal(isNativeCompletionProfile(id, malformed), false);
  }
});

const mid = n => `msg_0123456789ab${String(n).padStart(14, '0')}`;
const sid = 'ses_fixture';
const amounts = (input = 10, cost = 0.001) => ({ cost, tokens: { input, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });
const zero = () => ({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
const pricing = () => projectNativePricing({ ...MODEL_REF, cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] });
function fixture({ witness = true, seal = true, ack = true, bind = true } = {}) {
  const base = Date.now() - 100;
  const template = { sessionID: sid, messageID: mid(1), prompt_sha256: hash('prompt'), messages: [{ content: [{ type: 'text', text: 'prompt' }] }] };
  const c = createNativeCorrespondence({ sessionID: sid, incarnation: 'fixture-incarnation', promptSha256: template.prompt_sha256, createdAt: base, condition: 'plugin-off' });
  c.accept({ type: 'server.connected' }); c.beginRelease(1, hash('release'));
  const sent = c.snapshot().ledger[0].sent_at_ms;
  const event = (type, seq, data = {}, created = sent + seq) => ({ id: `evt_${seq}`, created, type,
    durable: { aggregateID: sid, seq, version: 1 }, data: { sessionID: sid, ...data } });
  const start = event('session.step.started', 1, { assistantMessageID: mid(2), agent: AGENT, model: MODEL_REF, started: sent });
  c.accept(start, sent + 1);
  const assistant = { id: mid(2), type: 'assistant', agent: AGENT, model: MODEL_REF,
    content: [{ type: 'text', text: 'α' }, { type: 'text', text: '\nanswer ' }], finish: 'stop',
    time: { created: sent, completed: sent + 2 }, ...amounts() };
  if (ack) c.acknowledge(1);
  if (bind) c.bindAssistant(assistant);
  if (witness) c.accept(event('session.execution.succeeded', 2, {}, sent + 3), sent + 4);
  if (seal) c.seal(sent + 5);
  const session = { id: sid, agent: AGENT, model: MODEL_REF, title: TITLE, location: { directory: 'fixture' },
    outcome: 'succeeded', time: { created: base, idle: sent + 3 }, ...amounts() };
  const snapshot = { session, rows: [
    { id: mid(1), type: 'user', text: 'prompt', files: [], time: { created: base + 1 } }, assistant,
    { id: mid(3), type: 'idle', outcome: 'succeeded', time: { created: sent + 3 } },
  ], inbox: [], children: [] };
  const options = { template, condition: 'plugin-off', cwd: 'fixture', correspondence: c.snapshot(), finalText: 'α\nanswer ',
    capturedAssistantIDs: [mid(2)], captureToolEvidence: [], baseline: { ...zero(), time: { created: base } }, pricing: pricing(), cliComplete: false };
  return { c, sent, event, start, assistant, snapshot, options };
}

test('native event-before-ack binds the exact already-nonempty/completed assistant only after acknowledgement', () => {
  const f = fixture({ ack: false, bind: false, witness: false, seal: false });
  assert.equal(f.c.pendingLookup(), null);
  f.c.acknowledge(1); assert.equal(f.c.pendingLookup().assistant_message_id, mid(2));
  f.c.bindAssistant(f.assistant);
  assert.equal(f.c.snapshot().bindings[0].basis, 'post_context_release_step_start');
  assert.equal(f.c.pendingLookup(), null);
  assert.equal(Object.isFrozen(f.c.snapshot().bindings[0]), true);
});

test('native missing/duplicate/reordered starts and additional release ambiguity fail closed', () => {
  for (const mutate of [f => f.c.accept(f.start, f.sent + 2),
    f => f.c.accept({ ...f.start, id: 'evt_other' }, f.sent + 2),
    f => f.c.beginRelease(2, hash('next'))]) {
    const f = fixture({ witness: false, seal: false }); assert.throws(() => mutate(f), /native_/);
  }
  const c = createNativeCorrespondence({ sessionID: sid, incarnation: 'i', promptSha256: hash('p'), createdAt: Date.now() - 10, condition: 'plugin-off' });
  c.accept({ type: 'server.connected' }); c.beginRelease(1, hash('one')); c.acknowledge(1); c.seal();
  assert.throws(() => c.eligibleAtClosure(true), /binding_missing/);
  const f = fixture({ bind: false, witness: false, seal: false });
  assert.throws(() => f.c.beginRelease(2, hash('two')), /unresolved/);
});

test('RecoverFull assistant ID reuse is rejected without relying on retry events', () => {
  const f = fixture({ witness: false, seal: false });
  f.c.settleContinuation({ ...f.assistant, finish: 'tool-calls', content: [{ type: 'tool', name: 'approved_list', state: { status: 'completed' }, time: { completed: f.sent + 2 } }] });
  f.c.beginRelease(2, hash('next')); f.c.acknowledge(2);
  const sent = f.c.snapshot().ledger[1].sent_at_ms;
  assert.throws(() => f.c.accept(f.event('session.step.started', 2,
    { assistantMessageID: mid(2), agent: AGENT, model: MODEL_REF, started: sent }, sent), sent), /mapping_rejected/);
});

test('host seal authorizes only inspection without a witness; unsettled execution still fails', () => {
  const f = fixture({ witness: false });
  assert.equal(f.c.eligibleAtClosure(false), true);
  delete f.snapshot.session.time.idle;
  assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, f.options), /native_session_completion_rejected/);
  assert.throws(() => f.c.accept(f.event('session.execution.succeeded', 2, {}, f.sent + 6), f.sent + 10), /native_/);
  const clean = fixture({ witness: false }); assert.equal(clean.c.eligibleAtClosure(true), true);
  const valid = fixture(); assert.equal(valid.c.eligibleAtClosure(false), true);
});

test('raw owned CLI closure alone supplies CLI terminal kind; diagnostic booleans never supply authority', () => {
  const launch = Object.freeze({ owner: 'owned-launch' });
  const result = { exit_code: 0, timeout: false, spawn_error: null,
    ownership: { owner: launch.owner, job_assigned: true, kill_on_close: true } };
  const start = { type: 'step_start', sessionID: sid, part: { messageID: mid(2) } };
  const text = { type: 'text', sessionID: sid, part: { messageID: mid(2), text: 'raw answer' } };
  const finish = { type: 'step_finish', sessionID: sid, part: { messageID: mid(2), reason: 'stop' } };
  const wire = events => Buffer.from(events.map(JSON.stringify).join('\n') + '\n');
  for (const scenario of ['clean', 'missing', 'other-session', 'malformed', 'truncated', 'other-launch', 'other-owner', 'error', 'pending', 'cap']) {
    const observer = createOwnedCLIObservation({ launch, sessionID: sid, promptSha256: hash('prompt'), sourceSha256: hash('source') });
    let bytes = wire([start, text, ...(scenario === 'missing' ? [] : [finish])]);
    if (scenario === 'other-session') bytes = wire([start, text, { ...finish, sessionID: 'ses_foreign' }]);
    if (scenario === 'malformed') bytes = Buffer.concat([bytes, Buffer.from('{bad}\n')]);
    if (scenario === 'truncated') bytes = bytes.subarray(0, -1);
    if (scenario === 'error') bytes = Buffer.concat([bytes, wire([{ type: 'error', sessionID: sid }])]);
    if (scenario === 'pending') bytes = wire([start, start, text, finish]);
    if (scenario === 'cap') bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    // Chunk boundaries are not line boundaries, and text must be byte-preserved.
    observer.push(bytes.subarray(0, 19)); observer.push(bytes.subarray(19));
    const diagnostic = createProductionDiagnostics({});
    diagnostic.capture({ schema: 'real-use-capture-diagnostics/v1', terminal_step_finish_observed: true,
      native_closure_clean: true, pending_steps: 0, provider_errors: 0, extraction_failures: 0 });
    const observed = observer.close(scenario === 'other-launch' ? { ...launch } : launch,
      scenario === 'other-owner' ? { ...result, ownership: { ...result.ownership, owner: 'foreign' } } : result);
    assert.equal(observed.cli_complete, scenario === 'clean', scenario);
    assert.equal(isFinalizationReceipt(observed), false, 'data-only parser cannot mint a receipt');
    const f = fixture({ witness: false });
    if (scenario === 'clean') {
      assert.equal(f.c.eligibleAtClosure(observed.cli_complete), true);
      assert.equal(observed.final_text_sha256, hash('raw answer'));
    } else assert.equal(f.c.eligibleAtClosure(observed.cli_complete), true, 'inspection is not completion');
    if (scenario === 'missing') assert.equal(observed.valid, true, 'timestamp-bounded native snapshots must independently corroborate');
  }
});

test('genuine bridge wiring keeps raw observation private and crosschecks finish facts, not observeCapture JSON', () => {
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /createOwnedLauncher\(launch, rawCLI \? \{ \.\.\.callbacks, onStdout: bytes => \{\s*rawCLI\.push\(bytes\); callbacks\.onStdout\(bytes\);/);
  assert.match(source, /observeCapture: value => diagnostics\.capture\(value\)/);
  assert.match(source, /freshPolicy \? \{ closed: child\.closed, status: child\.status, cleanupOwned: child\.cleanupOwned \} : child/);
  assert.match(source, /ownedCLIObservation = rawCLI\.close\(launch, result\)/);
  assert.match(source, /native_closure_clean !== ownedCLIObservation\.cli_complete/);
  assert.match(source, /correspondence\.eligibleAtClosure\(ownedCLIObservation\.cli_complete\)/);
  assert.doesNotMatch(source, /eligibleAtClosure\(native_closure_clean\)|eligibleAtClosure\(cliCandidate\)|captureState\?/);
});

test('source-defined ephemeral SSE shapes omit durable and never advance identity, usage or durable sequence', () => {
  const f = fixture({ witness: false, seal: false }), before = f.c.snapshot();
  const observations = [
    ['session.text.delta', { assistantMessageID: mid(2), ordinal: 0, delta: 'not retained' }],
    ['session.reasoning.delta', { assistantMessageID: mid(2), ordinal: 0, delta: 'private reasoning not retained' }],
    ['session.tool.input.delta', { assistantMessageID: mid(2), id: 'call1', delta: '{}' }],
    ['session.tool.progress', { assistantMessageID: mid(2), id: 'call1', metadata: { title: 'progress' } }],
    ['session.usage.updated', { ...amounts() }],
    ['session.status', { status: { type: 'busy' } }], ['session.idle', {}],
  ];
  for (const [type, data] of observations) f.c.accept({ id: 'evt_ephemeral', created: f.sent + 1, type,
    data: { sessionID: sid, ...data } }, f.sent + 1);
  f.c.accept({ type: 'session.step.started', durable: { aggregateID: sid }, data: { sessionID: 'ses_other', secret: 'foreign' } });
  assert.deepEqual(f.c.snapshot(), before, 'ephemeral payloads/IDs and other-session data are not retained');
  f.c.accept(f.event('session.execution.succeeded', 7, {}, f.sent + 3), f.sent + 4);
  assert.equal(f.c.snapshot().last_sequence, 7, 'observed durable order allows known gaps, not global contiguous coverage');
  f.c.seal(f.sent + 5); assert.equal(f.c.eligibleAtClosure(false), true);
});

test('exact idle observations after success and seal leave completion authority unchanged', () => {
  const f = fixture({ seal: false }), succeeded = f.c.snapshot();
  const idle = (type, created) => ({ id: 'evt_idle', created, type,
    data: { sessionID: sid, ...(type === 'session.status' ? { status: { type: 'idle' } } : {}) } });
  for (const type of ['session.status', 'session.idle']) f.c.accept(idle(type, f.sent + 4), f.sent + 4);
  assert.deepEqual(f.c.snapshot(), succeeded);
  const sealed = f.c.seal(f.sent + 5);
  for (const type of ['session.status', 'session.idle']) f.c.accept(idle(type, f.sent + 6), f.sent + 7);
  assert.deepEqual(f.c.snapshot(), sealed, 'later timestamps do not backdate seal, witness, bindings or durable sequence');
  assert.equal(f.c.eligibleAtClosure(false), true);
  const completed = validateNativeCompletionSnapshot(f.snapshot, { ...f.options, correspondence: f.c.snapshot() });
  assert.deepEqual(completed, validateNativeCompletionSnapshot(f.snapshot, { ...f.options, correspondence: sealed }));
  assert.equal(isFinalizationReceipt(completed), false);
  assert.equal(consumeFinalizationReceipt(completed, { episode_id: 'fixture' }, f.options.template.prompt_sha256), false);
});

test('post-success and post-seal activity or malformed idle shapes still fail closed', () => {
  const events = [
    { type: 'session.step.started', durable: { aggregateID: sid, seq: 3, version: 1 },
      data: { assistantMessageID: mid(4), agent: AGENT, model: MODEL_REF, started: 0 } },
    { type: 'session.status', data: { status: { type: 'busy' } } },
    { type: 'session.status', data: { status: { type: 'retry', attempt: 1, next: 1, message: 'retry' } } },
    { type: 'session.text.delta', data: { assistantMessageID: mid(2), ordinal: 0, delta: 'late' } },
    { type: 'session.reasoning.delta', data: { assistantMessageID: mid(2), ordinal: 0, delta: 'late' } },
    { type: 'session.tool.input.delta', data: { assistantMessageID: mid(2), id: 'call1', delta: '{}' } },
    { type: 'session.tool.progress', data: { assistantMessageID: mid(2), id: 'call1', metadata: {} } },
    { type: 'session.usage.updated', data: amounts() },
    { type: 'session.tool.success', durable: { aggregateID: sid, seq: 3, version: 2 }, data: {} },
    { type: 'session.execution.succeeded', data: {} },
    { type: 'session.status', data: {} },
    { type: 'session.status', data: { status: null } },
    { type: 'session.status', data: { status: { type: 'idle', delta: 'hidden activity' } } },
    { type: 'session.status', data: { status: { type: 'idle' }, delta: 'hidden activity' } },
    { type: 'session.idle', data: { delta: 'hidden activity' } },
    { type: 'session.idle', delta: 'hidden activity', data: {} },
    { type: 'session.idle', durable: { aggregateID: sid, seq: 3, version: 1 }, data: {} },
    { type: 'session.status', durable: { aggregateID: sid, seq: 3, version: 1 }, data: { status: { type: 'idle' } } },
    { type: 'session.idle', id: 'bad-id', data: {} },
    { type: 'session.idle', created: NaN, data: {} },
    { type: 'session.idle', created: 0, data: {} },
    { type: 'session.idle', created: Number.MAX_SAFE_INTEGER, data: {} },
  ];
  for (const seal of [false, true]) for (const event of events) {
    const f = fixture({ seal });
    assert.throws(() => f.c.accept({ id: 'evt_late', created: f.sent + 6, ...event,
      data: { sessionID: sid, ...event.data } }, f.sent + 7), /native_/, `${seal ? 'sealed' : 'succeeded'} ${event.type}`);
    assert.throws(() => f.c.check(), /native_/);
  }
});

test('idle observations still require connection and cannot supply a missing success witness', () => {
  for (const type of ['session.status', 'session.idle']) {
    const f = fixture({ witness: false }), before = f.c.snapshot();
    const event = { id: 'evt_idle', created: f.sent + 6, type,
      data: { sessionID: sid, ...(type === 'session.status' ? { status: { type: 'idle' } } : {}) } };
    f.c.accept(event, f.sent + 7);
    assert.deepEqual(f.c.snapshot(), before);
    assert.equal(f.c.eligibleAtClosure(false), true);
    delete f.snapshot.session.time.idle;
    assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, f.options), /native_session_completion_rejected/);
    const disconnected = createNativeCorrespondence({ sessionID: sid, incarnation: 'i', promptSha256: hash('p'),
      createdAt: f.sent, condition: 'plugin-off' });
    assert.throws(() => disconnected.accept(event, f.sent + 7), /native_/);
  }
});

test('trailing idle remains bounded while foreign-session events are filtered before inspection', () => {
  for (const seal of [false, true]) {
    const f = fixture({ seal }), before = f.c.snapshot();
    const foreign = { type: 'session.step.started', data: { sessionID: 'ses_other' },
      toJSON() { throw new Error('foreign data must not be inspected'); } };
    for (let i = 0; i < 10001; i++) f.c.accept(foreign);
    for (let i = 0; i < 9998; i++) f.c.accept({ id: 'evt_idle', created: f.sent + 6,
      type: i % 2 ? 'session.idle' : 'session.status',
      data: { sessionID: sid, ...(i % 2 ? {} : { status: { type: 'idle' } }) } }, f.sent + 7);
    assert.deepEqual(f.c.snapshot(), before, 'observation counts are not completion authority');
    assert.throws(() => f.c.accept({ id: 'evt_over_cap', created: f.sent + 6, type: 'session.idle',
      data: { sessionID: sid } }, f.sent + 7), /correspondence_rejected/);
  }
});

test('malformed critical durable, ephemeral compaction and retry status remain fatal', () => {
  for (const event of [
    { type: 'session.execution.succeeded', data: {} },
    { type: 'session.step.started', data: { assistantMessageID: mid(4), agent: AGENT, model: MODEL_REF, started: 0 } },
    { type: 'session.compaction.delta', data: { text: 'must reject' } },
    { type: 'session.status', data: { status: { type: 'retry', attempt: 1, next: 1, message: 'retry' } } },
    { type: 'session.tool.failed', data: {} },
    { type: 'session.text.delta', durable: { aggregateID: sid, seq: 2, version: 1 }, data: { assistantMessageID: mid(2), ordinal: 0, delta: 'unexpected durable' } },
  ]) {
    const f = fixture({ witness: false, seal: false });
    assert.throws(() => f.c.accept({ ...event, id: 'evt_bad', created: f.sent + 1,
      data: { sessionID: sid, ...event.data } }, f.sent + 1), /native_/, event.type);
  }
  const f = fixture({ witness: false, seal: false }), event = f.event('session.execution.succeeded', 2);
  event.durable.aggregateID = 'ses_other';
  assert.throws(() => f.c.accept(event, f.sent + 3), /correspondence_rejected/);
});

test('unknown non-durable observations retain only bounded diagnostics, never completion authority', () => {
  const f = fixture({ witness: false, seal: false }), before = f.c.snapshot();
  const event = { type: 'session.future-observation', data: { sessionID: sid, payload: 'not retained', ...amounts() } };
  f.c.accept(event);
  f.c.accept({ ...event, id: 'not-an-event-id', created: -1 });
  const after = f.c.snapshot();
  assert.deepEqual(after, { ...before, ignored_unknown_events: 2, unknown_event_types: [event.type] });
  assert.doesNotMatch(JSON.stringify(after), /not retained|not-an-event-id|payload/);
  f.c.accept({ ...event, durable: {}, data: { sessionID: 'ses_foreign' } });
  assert.deepEqual(f.c.snapshot(), after, 'foreign events remain filtered before classification');
  f.c.accept(f.event('session.execution.succeeded', 2, {}, f.sent + 3), f.sent + 4);
  assert.equal(f.c.snapshot().last_sequence, 2);
  assert.equal(f.c.snapshot().witness.seq, 2);
});

test('unknown observation identifiers and counts are bounded and sanitized', () => {
  const f = fixture({ witness: false, seal: false });
  const types = ['unsafe type', 'A'.repeat(65), 'https://private.invalid', '', null, 42,
    ...Array.from({ length: 10 }, (_, i) => `Future.${i}_-`)];
  for (const type of types) f.c.accept({ type, data: { sessionID: sid } });
  assert.deepEqual(f.c.snapshot().unknown_event_types, types.slice(6, 14));
  for (let i = types.length; i < 9999; i++) f.c.accept({ type: 'Future.0_-', data: { sessionID: sid } });
  const before = f.c.snapshot();
  assert.equal(before.ignored_unknown_events, 9999, 'the existing start used one observation');
  assert.throws(() => f.c.accept({ type: 'Future.0_-', data: { sessionID: sid } }),
    { message: 'native_event_correspondence_rejected' });
  assert.equal(f.c.snapshot().ignored_unknown_events, 9999);
  assert.equal(f.c.snapshot().observer_reason, 'native_observation_cap');
  assert.deepEqual(f.c.snapshot().ledger, before.ledger);
});

test('any durable field on an unknown owned type rejects with distinct projected attribution', () => {
  for (const durable of [undefined, null, false, {}, { aggregateID: sid, seq: 2, version: 1 }]) {
    const f = fixture({ witness: false, seal: false }), before = f.c.snapshot();
    assert.throws(() => f.c.accept({ type: 'session.unknown-critical', durable,
      data: { sessionID: sid, secret: 'not retained' } }), error => {
      assert.equal(error.message, 'native_unknown_durable_event');
      const snapshot = f.c.snapshot();
      const projected = projectFinalizationDiagnostics(error, { correspondence: snapshot });
      assert.equal(projected.rejection_code, 'native_unknown_durable_event');
      assert.equal(projected.observer_reason, 'native_unknown_durable_event');
      assert.deepEqual(projected.unknown_event_types, ['session.unknown-critical']);
      assert.equal(projected.ignored_unknown_events, 0);
      for (const key of ['ledger', 'bindings', 'last_sequence', 'witness']) assert.deepEqual(snapshot[key], before[key]);
      assert.ok(Buffer.byteLength(JSON.stringify(projected) + '\n') < 4096);
      assert.doesNotMatch(JSON.stringify(projected), /secret|not retained|aggregateID/);
      return true;
    });
    assert.throws(() => f.c.fail('native_observer_failed'), /native_observer_failed/);
    assert.equal(f.c.snapshot().observer_reason, 'native_unknown_durable_event', 'first attribution survives cleanup');
    assert.throws(() => f.c.seal(), /native_unknown_durable_event/);
  }
  const f = fixture({ witness: false, seal: false });
  assert.throws(() => f.c.accept({ type: 'unsafe '.repeat(20), durable: {}, data: { sessionID: sid } }),
    { message: 'native_unknown_durable_event' });
  assert.deepEqual(f.c.snapshot().unknown_event_types, []);
});

test('strict event rejections preserve their codes and attribute the failing sub-condition', () => {
  const cases = [
    ['native_event_correspondence_rejected', 'native_duplicate_event_id', f => f.start],
    ['native_event_correspondence_rejected', 'native_durable_sequence_rejected', f => ({ ...f.event('session.step.ended', 1), id: 'evt_reordered' })],
    ['native_event_correspondence_rejected', 'native_durable_version_rejected', f => ({ ...f.event('session.step.ended', 2), durable: { aggregateID: sid, seq: 2, version: 2 } })],
    ['native_event_correspondence_rejected', 'native_durable_session_rejected', f => ({ ...f.event('session.step.ended', 2), durable: { aggregateID: 'ses_foreign', seq: 2, version: 1 } })],
    ['native_event_correspondence_rejected', 'native_durable_session_rejected', f => ({ ...f.event('session.execution.succeeded', 2), durable: undefined })],
    ['native_event_correspondence_rejected', 'native_event_id_rejected', f => ({ ...f.event('session.step.ended', 2), id: 'bad' })],
    ['native_event_correspondence_rejected', 'native_event_timestamp_before_creation', f => ({ ...f.event('session.step.ended', 2), created: 0 })],
    ['native_recovery_or_auxiliary_observed', 'native_recovery_or_auxiliary_observed', f => f.event('session.compaction.delta', 2)],
    ['native_recovery_or_auxiliary_observed', 'native_recovery_or_auxiliary_observed', f => f.event('session.status', 2, { status: { type: 'retry' } })],
    ['native_ephemeral_shape_rejected', 'native_ephemeral_shape_rejected', f => f.event('session.text.delta', 2)],
  ];
  for (const [code, reason, event] of cases) {
    const f = fixture({ witness: false, seal: false });
    assert.throws(() => f.c.accept(event(f), f.sent + 4), error => {
      assert.equal(error.message, code);
      assert.equal(f.c.snapshot().observer_reason, reason);
      assert.equal(projectFinalizationDiagnostics(error, { correspondence: f.c.snapshot() }).observer_reason, reason);
      return true;
    });
  }
  for (const [options, code] of [[{ seal: false }, 'native_activity_after_success'], [{}, 'native_activity_after_seal']]) {
    const f = fixture(options);
    assert.throws(() => f.c.accept({ type: 'session.future', data: { sessionID: sid } }), { message: code });
    assert.equal(f.c.snapshot().observer_reason, code);
    assert.equal(f.c.snapshot().ignored_unknown_events, 0);
  }
  const f = fixture({ witness: false, seal: false });
  assert.throws(() => f.c.accept({ type: 'session.retry.future', data: { sessionID: sid } }),
    { message: 'native_recovery_or_auxiliary_observed' });
});

test('recovery and auxiliary failures retain only their exact safe type and preserve the failure fence', () => {
  for (const type of ['session.compaction.started', 'session.retry.started', 'session.shell.started', 'session.skill.started',
    'session.synthetic', 'session.forked', 'session.model.selected', 'session.location.changed', 'session.execution.failed',
    'session.execution.interrupted', 'session.step.failed', 'session.tool.failed', 'session.status']) {
    const f = fixture({ witness: false, seal: false }), before = f.c.snapshot();
    assert.equal(before.observer_event_type, null); assert.equal(before.observer_event_types, null);
    const event = { type, id: 'evt_auxiliary', created: f.sent + 2,
      data: { sessionID: sid, payload: 'not retained', status: { type: 'retry', message: 'not retained' } } };
    const code = 'native_recovery_or_auxiliary_observed';
    assert.throws(() => f.c.accept(event, f.sent + 3), { message: code });
    const snapshot = f.c.snapshot(), projection = projectFinalizationDiagnostics(new Error(code), { correspondence: snapshot });
    for (const value of [snapshot, projection]) {
      assert.equal(value.observer_reason, code);
      assert.equal(value.observer_event_type, type);
      assert.deepEqual(value.observer_event_types, [type]);
      assert.equal(value.timestamp_delta_ms, null);
      assert.equal(value.ignored_unknown_events, 0);
      assert.doesNotMatch(JSON.stringify(value), /evt_auxiliary|payload|not retained/);
    }
    assert.equal(projection.rejection_code, code);
    assert.ok(Buffer.byteLength(JSON.stringify(projection) + '\n') < 4096);
    for (const key of ['ledger', 'bindings', 'last_sequence', 'witness']) assert.deepEqual(snapshot[key], before[key]);
    for (const action of [() => f.c.check(), () => f.c.seal(), () => f.c.beginRelease(2, hash('next')),
      () => f.c.eligibleAtClosure(true), () => f.c.accept(f.start)]) assert.throws(action, { message: code });
    assert.throws(() => f.c.fail('native_observer_failed'), { message: 'native_observer_failed' });
    assert.deepEqual(f.c.snapshot(), snapshot, 'cleanup cannot replace the first event attribution');
  }
});

test('unsafe or oversized recovery types remain fatal without retaining their names', () => {
  for (const type of ['session.retry.unsafe value', 'session.compaction.' + 'x'.repeat(64), 'session.shell.unsafe\nvalue']) {
    const f = fixture({ witness: false, seal: false });
    assert.throws(() => f.c.accept({ type, data: { sessionID: sid } }), { message: 'native_recovery_or_auxiliary_observed' });
    const snapshot = f.c.snapshot();
    for (const value of [snapshot, projectFinalizationDiagnostics(null, { correspondence: snapshot })]) {
      assert.equal(value.observer_event_type, null); assert.equal(value.observer_event_types, null);
      assert.deepEqual(value.unknown_event_types, []);
    }
  }
});

test('observer type projection is nullable, sanitized, sorted, unique and bounded within 4 KiB', () => {
  const reason = 'native_recovery_or_auxiliary_observed';
  for (const type of [undefined, null, 42, {}, '', 'unsafe value', 'x'.repeat(65)]) {
    const value = projectFinalizationDiagnostics(null, { correspondence: {
      observer_reason: reason, observer_event_type: type, observer_event_types: [type] } });
    assert.equal(value.observer_event_type, null); assert.equal(value.observer_event_types, null);
  }
  const names = Array.from({ length: 10 }, (_, i) => `Session.${9 - i}_-`);
  const correspondence = { observer_reason: reason, observer_event_type: names[0], observer_event_types: names,
    unknown_event_types: Array.from({ length: 8 }, (_, i) => `X${i}` + 'x'.repeat(62)),
    ledger: Array.from({ length: 200 }, (_, i) => ({ ordinal: i + 1 })) };
  let value = projectFinalizationDiagnostics(null, { correspondence });
  assert.deepEqual(value.observer_event_types, names.slice(0, 8).sort());
  correspondence.observer_event_types = ['Z', 'A', 'Z', 'unsafe value'];
  assert.deepEqual(projectFinalizationDiagnostics(null, { correspondence }).observer_event_types, ['A', 'Z']);
  correspondence.observer_event_types = correspondence.unknown_event_types;
  correspondence.observer_event_type = correspondence.unknown_event_types[0];
  value = projectFinalizationDiagnostics(null, { correspondence });
  assert.ok(Buffer.byteLength(JSON.stringify(value) + '\n') <= 4096);
  for (const state of [{}, { correspondence: { ...correspondence, observer_reason: 'native_activity_after_seal' } }]) {
    value = projectFinalizationDiagnostics(null, state);
    assert.equal(value.observer_event_type, null); assert.equal(value.observer_event_types, null);
  }
});

test('SSE recovery rejection still invokes the failure fence and preserves event attribution', async () => {
  const c = createNativeCorrespondence({ sessionID: sid, incarnation: 'i', promptSha256: hash('p'),
    createdAt: Date.now() - 10, condition: 'plugin-off' });
  let stream, failures = 0, resolveFailure;
  const failed = new Promise(resolve => { resolveFailure = resolve; });
  const observer = await observeNativeEvents(async () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(Buffer.from('data: {"type":"server.connected"}\n\n'));
  } }), { headers: { 'Content-Type': 'text/event-stream' } }), c, () => { failures++; resolveFailure(); });
  try {
    stream.enqueue(Buffer.from(`data: ${JSON.stringify({ type: 'session.retry.started', data: { sessionID: sid } })}\n\n`));
    await failed;
    assert.equal(failures, 1);
    assert.throws(() => c.check(), { message: 'native_recovery_or_auxiliary_observed' });
    assert.equal(c.snapshot().observer_event_type, 'session.retry.started');
    assert.deepEqual(c.snapshot().observer_event_types, ['session.retry.started']);
  } finally { await observer.close(); }
});

test('observer timestamp hygiene accepts 500 ms skew and inclusive 2000 ms limits only', () => {
  const createdAt = 1000000, receivedAt = createdAt + 10000;
  for (const type of ['session.step.ended', 'session.status']) for (const created of [createdAt - 500, createdAt - 2000, receivedAt + 500, receivedAt + 2000]) {
    const c = createNativeCorrespondence({ sessionID: sid, incarnation: 'i', promptSha256: hash('p'), createdAt, condition: 'plugin-off' });
    c.accept({ type: 'server.connected' });
    const before = c.snapshot(), durable = type === 'session.step.ended';
    c.accept({ type, id: 'evt_skew', created, ...(durable ? { durable: { aggregateID: sid, seq: 1, version: 1 } } : {}),
      data: { sessionID: sid, ...(durable ? {} : { status: { type: 'busy' } }) } }, receivedAt);
    assert.deepEqual(c.snapshot(), { ...before, last_sequence: durable ? 1 : -1 });
    assert.equal(c.snapshot().timestamp_delta_ms, null);
  }
});

test('timestamp bound failures retain signed clamped deltas and first-cause attribution', () => {
  const createdAt = 1000000, receivedAt = createdAt + 10000;
  for (const side of ['before_creation', 'after_receipt']) for (const magnitude of [2001, 3000, 3000.75, 600001, 10000000]) {
    const c = createNativeCorrespondence({ sessionID: sid, incarnation: 'i', promptSha256: hash('p'), createdAt, condition: 'plugin-off' });
    c.accept({ type: 'server.connected' });
    const before = side === 'before_creation', reason = `native_event_timestamp_${side}`;
    const delta = (before ? -1 : 1) * magnitude, expected = Math.trunc(Math.max(-600000, Math.min(600000, delta)));
    const created = (before ? createdAt : receivedAt) + delta;
    assert.throws(() => c.accept({ type: 'session.step.ended', id: 'evt_skew', created,
      durable: { aggregateID: sid, seq: 1, version: 1 }, data: { sessionID: sid } }, receivedAt), error => {
      assert.equal(error.message, 'native_event_correspondence_rejected');
      const snapshot = c.snapshot(), projection = projectFinalizationDiagnostics(error, { correspondence: snapshot });
      for (const value of [snapshot, projection]) {
        assert.equal(value.observer_reason, reason);
        assert.equal(value.timestamp_delta_ms, expected);
        assert.equal(Number.isInteger(value.timestamp_delta_ms), true);
      }
      assert.equal(snapshot.last_sequence, -1); assert.equal(snapshot.witness, null);
      assert.ok(Buffer.byteLength(JSON.stringify(projection) + '\n') < 4096);
      return true;
    });
    const first = c.snapshot();
    assert.throws(() => c.fail('native_observer_failed'), /native_observer_failed/);
    assert.deepEqual(c.snapshot(), first);
  }
  const f = fixture({ witness: false, seal: false });
  assert.throws(() => f.c.accept({ ...f.event('session.step.ended', 2), created: NaN }, f.sent + 4),
    { message: 'native_event_correspondence_rejected' });
  assert.equal(f.c.snapshot().observer_reason, 'native_event_timestamp_rejected');
  assert.equal(f.c.snapshot().timestamp_delta_ms, null);
});

test('timestamp delta projection is nullable, signed, integer and bounded independently of supplied data', () => {
  for (const [delta, expected] of [[-900000, -600000], [900000, 600000], [-3000.75, -3000], [3000.75, 3000],
    [undefined, null], [null, null], ['3000', null], [NaN, null], [Infinity, null], [-Infinity, null]]) {
    const correspondence = { observer_reason: 'native_event_timestamp_before_creation', timestamp_delta_ms: delta };
    const projected = projectFinalizationDiagnostics(new Error('native_event_correspondence_rejected'), { correspondence });
    assert.equal(projected.timestamp_delta_ms, expected);
  }
  for (const observer_reason of [null, 'native_durable_sequence_rejected', 'native_event_timestamp_rejected', 'unsafe reason'])
    assert.equal(projectFinalizationDiagnostics(null, { correspondence: { observer_reason, timestamp_delta_ms: 3000 } }).timestamp_delta_ms, null);
  assert.equal(projectFinalizationDiagnostics(null).timestamp_delta_ms, null);
});

test('delivery tolerance never relaxes exact witness, idle, completion or durable ordering bounds', () => {
  const late = fixture({ witness: false });
  assert.throws(() => late.c.accept(late.event('session.execution.succeeded', 2, {}, late.sent + 6), late.sent + 5),
    { message: 'native_activity_after_seal' });
  assert.equal(late.c.snapshot().timestamp_delta_ms, null);
  const early = fixture({ witness: false, seal: false });
  early.c.accept(early.event('session.execution.succeeded', 2, {}, early.sent + 6), early.sent + 4);
  early.c.seal(early.sent + 5);
  assert.throws(() => validateNativeCompletionSnapshot(early.snapshot, { ...early.options, correspondence: early.c.snapshot() }),
    { message: 'native_completion_correspondence_missing' });
  for (const mutate of [
    f => { f.snapshot.session.time.idle = f.sent + 6; f.snapshot.rows.at(-1).time.created = f.sent + 6; },
    f => { f.snapshot.rows[1].time.completed = f.sent + 6; },
  ]) {
    const f = fixture({ witness: false }); mutate(f);
    assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, f.options), /native_/);
  }
  for (const [type, seq, reason] of [['session.step.ended', 1, 'native_durable_sequence_rejected'],
    ['session.retry.scheduled', 2, 'native_recovery_or_auxiliary_observed']]) {
    const f = fixture({ witness: false, seal: false });
    assert.throws(() => f.c.accept({ ...f.event(type, seq, {}, f.sent + 500), id: 'evt_skew_strict' }, f.sent),
      { message: reason === 'native_durable_sequence_rejected' ? 'native_event_correspondence_rejected' : reason });
    assert.equal(f.c.snapshot().observer_reason, reason);
    assert.equal(f.c.snapshot().timestamp_delta_ms, null);
  }
});

test('native exact postrelease snapshot corroborates ordered multi-text bytes, not normalized text', () => {
  const f = fixture(), good = validateNativeCompletionSnapshot(f.snapshot, f.options);
  assert.equal(good.native_message_id, mid(2)); assert.equal(good.native_recorded_usage.cost_usd, 0.001);
  for (const finalText of ['α\nanswer', 'α\n\nanswer ', 'αanswer '])
    assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, { ...f.options, finalText }), /answer_mismatch/);
  assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, { ...f.options, capturedAssistantIDs: [mid(4)] }), /answer_mismatch/);
  assert.equal(isFinalizationReceipt(good), false);
  assert.equal(consumeFinalizationReceipt(good, { episode_id: 'fixture' }, f.options.template.prompt_sha256), false);
});

test('stale witness, changed baseline, unfinished/extra assistants, retry, auxiliary, inbox and child reject', () => {
  for (const mutate of [
    f => { f.options.correspondence = structuredClone(f.options.correspondence); f.options.correspondence.witness.created = f.sent; },
    f => { f.snapshot.session.time.created--; },
    f => { delete f.snapshot.rows[1].time.completed; },
    f => { f.snapshot.rows[1].retry = {}; },
    f => { f.snapshot.rows.splice(2, 0, { ...structuredClone(f.assistant), id: mid(5) }); },
    f => { f.snapshot.rows.splice(2, 0, { id: mid(5), type: 'compaction', time: { created: f.sent + 2 } }); },
    f => { f.snapshot.inbox.push({}); }, f => { f.snapshot.children.push({}); },
    f => { f.snapshot.session.outcome = 'failed'; },
  ]) {
    const f = fixture(); mutate(f); assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, f.options), /native_/);
  }
});

test('settled native list/read evidence binds exact CLI IDs, input hashes, output hashes and assistant scope', () => {
  const f = fixture({ witness: false, seal: false });
  const tools = [
    { name: 'approved_list', id: 'list1', input: {}, output: 'README.md' },
    { name: 'approved_read', id: 'read1', input: { path: 'README.md', offset: 5, limit: 1 }, output: 'exact fifth line\n' },
  ];
  f.assistant.finish = 'tool-calls';
  f.assistant.time.completed = f.sent;
  f.assistant.content = tools.map(row => ({ type: 'tool', name: row.name, id: row.id,
    state: { status: 'completed', input: row.input, content: [{ type: 'text', text: row.output }] },
    time: { created: f.sent, completed: f.sent } }));
  f.c.settleContinuation(f.assistant); f.c.beginRelease(2, hash('release2')); f.c.acknowledge(2);
  const nextSent = f.c.snapshot().ledger[1].sent_at_ms;
  f.c.accept(f.event('session.step.started', 2, { assistantMessageID: mid(4), agent: AGENT, model: MODEL_REF, started: nextSent }, nextSent + 2), nextSent + 2);
  const final = { ...structuredClone(f.assistant), id: mid(4), finish: 'stop', content: [{ type: 'text', text: f.options.finalText }],
    time: { created: nextSent + 2, completed: nextSent + 3 } };
  f.c.bindAssistant(final); f.c.accept(f.event('session.execution.succeeded', 3, {}, nextSent + 4), nextSent + 5); f.c.seal(nextSent + 6);
  f.snapshot.rows.splice(2, 0, final); f.snapshot.rows.at(-1).time.created = nextSent + 4;
  f.snapshot.session.time.idle = nextSent + 4; f.snapshot.session.cost *= 2;
  f.snapshot.session.tokens.input *= 2; f.snapshot.session.tokens.output *= 2;
  f.options.correspondence = f.c.snapshot(); f.options.capturedAssistantIDs = [mid(2), mid(4)];
  f.options.captureToolEvidence = tools.map(row => ({ name: row.name, call_id: row.id, native_assistant_id: mid(2),
    input_sha256: hash(row.input), output_sha256: hash(row.output), status: 'completed' }));
  assert.deepEqual(validateNativeCompletionSnapshot(f.snapshot, f.options).tool_evidence, f.options.captureToolEvidence);
  const timestamped = structuredClone(f.options); timestamped.correspondence.witness = null;
  assert.deepEqual(validateNativeCompletionSnapshot(f.snapshot, timestamped).tool_evidence, f.options.captureToolEvidence);
  timestamped.correspondence.ledger[0].settled = false;
  assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, timestamped), /native_completion_correspondence_missing/);
  const nativeOrder = structuredClone(f.options.captureToolEvidence);
  const reverse = { ...f.options, captureToolEvidence: [...nativeOrder].reverse() };
  assert.deepEqual(validateNativeCompletionSnapshot(f.snapshot, reverse).tool_evidence, nativeOrder,
    'parallel reverse CLI completion order must preserve canonical native invocation order');
  for (const captured of [[nativeOrder[0], nativeOrder[0]], nativeOrder.slice(1),
    [...nativeOrder, { ...nativeOrder[1], call_id: 'extraneous' }]]) {
    assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, { ...f.options, captureToolEvidence: captured }), /tool_correspondence/);
  }
  for (const change of [{ call_id: 'printed_fake' }, { native_assistant_id: mid(4) },
    { input_sha256: hash({ path: 'README.md', offset: 1, limit: 5 }) }, { output_sha256: hash('claimed fifth line') }]) {
    const options = structuredClone(f.options); Object.assign(options.captureToolEvidence[1], change);
    assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, options), /tool_correspondence/);
  }
});

test('empty native children page with next proceeds through both completion snapshots', async () => {
  const f = fixture(); let reads = 0;
  const result = await inspectNativeCompletion(async () => {
    reads++;
    return { ...f.snapshot, children: nativeChildrenRows({ data: [], cursor: { next: 'x' } }) };
  }, f.options, Date.now() + 1000);
  assert.equal(reads, 2);
  assert.equal(result.snapshot.child_count, 0);
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /const children = await owned\.json\(base, `\/api\/session\?parentID=\$\{encodeURIComponent\(sessionID\)\}&limit=1`/);
  assert.match(source, /const childRows = nativeChildrenRows\(children\)/);
  assert.match(source, /return \{ session: session\?\.data, rows, inbox: inbox\?\.data, children: childRows \}/);
});

test('populated native children page with next rejects at the unchanged non-empty children check', async () => {
  const f = fixture(), children = nativeChildrenRows({ data: [{ id: 'ses_child' }], cursor: { next: 'x' } });
  let reads = 0;
  assert.deepEqual(children, [{ id: 'ses_child' }]);
  await assert.rejects(inspectNativeCompletion(async () => {
    reads++; return { ...f.snapshot, children };
  }, f.options, Date.now() + 1000), { message: 'native_session_completion_rejected' });
  assert.equal(reads, 1);
});

test('malformed native children envelopes retain their own rejection code', () => {
  for (const value of [undefined, null, true, 1, 'children', [], Object.assign([], { data: [] }),
    {}, { cursor: { next: 'x' } }, { data: null }, { data: {} }, { data: 'rows' }])
    assert.throws(() => nativeChildrenRows(value), { message: 'native_child_scope_rejected' });
});

test('unfiltered pagination follows next without order and rejects duplicate IDs/cursors/caps', async () => {
  const queries = [];
  const rows = await readNativeMessagePages(async query => {
    queries.push(query); return queries.length === 1 ? { data: [{ id: mid(1) }], cursor: { next: 'a b' } } : { data: [{ id: mid(2) }], cursor: {} };
  });
  assert.equal(rows.length, 2); assert.deepEqual(queries, ['?order=asc&limit=200', '?limit=200&cursor=a%20b']);
  for (const mode of ['duplicate', 'cursor', 'cap']) {
    let page = 0;
    await assert.rejects(readNativeMessagePages(async () => ({ data: [{ id: mid(mode === 'duplicate' ? 1 : ++page) }],
      cursor: { next: mode === 'cap' ? `page${page}` : 'same' } })), /native_message_/);
  }
});

test('native terminal empty pages return accumulated rows without inspecting or following next', async () => {
  for (const next of ['same', '', null, 123, 'x'.repeat(4097)]) {
    let calls = 0;
    assert.deepEqual(await readNativeMessagePages(async () => {
      calls++; return { data: [], cursor: { next, previous: 'same' } };
    }), []);
    assert.equal(calls, 1);
  }
  const populated = [{ id: mid(1) }, { id: mid(2) }], queries = [];
  const rows = await readNativeMessagePages(async query => {
    queries.push(query);
    if (queries.length === 1) return { data: populated, cursor: { next: 'same' } };
    if (queries.length === 2) return { data: [], cursor: { next: 'same', previous: 'same' } };
    assert.fail('terminal empty cursor must not be followed');
  });
  assert.deepEqual(rows, populated);
  assert.deepEqual(queries, ['?order=asc&limit=200', '?limit=200&cursor=same']);
});

test('native pagination retains malformed envelope, populated cursor, duplicate ID, byte and page caps', async () => {
  for (const data of [null, {}, 'rows', Array.from({ length: 201 }, (_, i) => ({ id: mid(i + 1) }))])
    await assert.rejects(readNativeMessagePages(async () => ({ data, cursor: {} })), { message: 'native_message_page_rejected' });
  for (const data of [[], [{ id: mid(1) }]]) for (const cursor of [undefined, null, true, 1, 'cursor', [], { unexpected: 'x' }])
    await assert.rejects(readNativeMessagePages(async () => ({ data, cursor })), { message: 'native_message_page_rejected' });
  for (const next of [null, true, 1, '', 'x'.repeat(4097)])
    await assert.rejects(readNativeMessagePages(async () => ({ data: [{ id: mid(1) }], cursor: { next } })), { message: 'native_message_cursor_rejected' });
  let calls = 0;
  await assert.rejects(readNativeMessagePages(async () => ({ data: [{ id: mid(++calls) }], cursor: { next: 'same' } })),
    { message: 'native_message_cursor_rejected' });
  assert.equal(calls, 2);
  await assert.rejects(readNativeMessagePages(async () => ({ data: [{ id: mid(1) }, { id: mid(1) }], cursor: {} })),
    { message: 'native_message_interval_rejected' });
  await assert.rejects(readNativeMessagePages(async () => ({ data: [], cursor: { next: 'x'.repeat(4 * 1024 * 1024) } })),
    { message: 'native_message_page_rejected' });
  calls = 0;
  await assert.rejects(readNativeMessagePages(async () => ({ data: [{ id: mid(++calls), text: 'x'.repeat(2 * 1024 * 1024) }], cursor: { next: `page${calls}` } })),
    { message: 'native_message_page_rejected' });
  assert.equal(calls, 2, 'byte limit is cumulative');
  calls = 0;
  await assert.rejects(readNativeMessagePages(async () => ({ data: [{ id: mid(++calls) }], cursor: { next: `page${calls}` } })),
    { message: 'native_message_page_cap' });
  assert.equal(calls, 4, 'no fifth request on loop exhaustion');
  calls = 0;
  await assert.rejects(readNativeMessagePages(async () => {
    const start = calls++ * 200;
    return { data: Array.from({ length: 200 }, (_, i) => ({ id: mid(start + i + 1) })), cursor: { next: `page${calls}` } };
  }), { message: 'native_message_interval_rejected' });
});

test('a short paginated interval fails completion validation on the first snapshot, not cursor handling', async () => {
  for (const initial of [[], 'user-only']) {
    const f = fixture(); let snapshots = 0, pages = 0;
    const rows = await readNativeMessagePages(async () => {
      pages++;
      return { data: initial === 'user-only' && pages === 1 ? [f.snapshot.rows[0]] : [], cursor: { next: 'same' } };
    });
    assert.equal(pages, initial === 'user-only' ? 2 : 1);
    await assert.rejects(inspectNativeCompletion(async () => {
      snapshots++; return { ...f.snapshot, rows };
    }, f.options, Date.now() + 1000), error => {
      assert.match(error.message, /^native_(?:history_rejected|complete_interval_rejected)$/); return true;
    });
    assert.equal(snapshots, 1, 'no later populated interval can rescue incomplete first evidence');
  }
});

test('exactly two equal snapshots required; changes are rejected without sampling until stable', async () => {
  const f = fixture(); let calls = 0;
  const good = await inspectNativeCompletion(async () => { calls++; return f.snapshot; }, f.options, Date.now() + 1000);
  assert.equal(calls, 2); assert.equal(good.native_snapshot_sha256[0], good.native_snapshot_sha256[1]);
  calls = 0;
  await assert.rejects(inspectNativeCompletion(async () => {
    const next = structuredClone(f.snapshot); if (++calls === 2) next.rows[1].rawFinish = 'changed'; return next;
  }, f.options, Date.now() + 1000), /snapshots_changed/);
  assert.equal(calls, 2);
});

test('inspection retains original deadline and aborts hung reads, never waiting for future completion', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(inspectNativeCompletion(async () => { calls++; return f.snapshot; }, f.options, Date.now() - 1), /deadline/);
  assert.equal(calls, 0);
  await assert.rejects(inspectNativeCompletion(() => new Promise(() => {}), f.options, Date.now() + 10), /deadline/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectNativeCompletion(async () => f.snapshot, f.options, Date.now() + 1000, controller.signal), /deadline/);
});

test('native recorded accounting requires explicit components and aggregate agreement; zero rates need explicit pricing', () => {
  const row = amounts(), price = pricing();
  assert.equal(nativeRecordedUsage([row], row, zero(), price).steps, 1);
  for (const changed of [{ ...row, cost: undefined }, { ...row, tokens: { input: 10, output: 2 } }, zero(),
    { ...row, cost: 0 }, { ...row, cost: -1 }, { ...row, tokens: { ...row.tokens, input: 1.5 } }])
    assert.throws(() => nativeRecordedUsage([changed], row, zero(), price), /native_/);
  assert.throws(() => nativeRecordedUsage([row], amounts(11), zero(), price), /aggregate_mismatch/);
  assert.throws(() => nativeRecordedUsage([row], amounts(10, 0.002), zero(), price), /aggregate_mismatch/);
  assert.throws(() => nativeRecordedUsage([row], row, row, price), /baseline/);
  const free = projectNativePricing({ ...MODEL_REF, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] });
  const freeRow = amounts(10, 0); assert.equal(nativeRecordedUsage([freeRow], freeRow, zero(), free).cost_usd, 0);
  assert.throws(() => projectNativePricing({ ...MODEL_REF, cost: [{ input: 0, output: 0 }] }), /pricing_missing/);
  assert.throws(() => projectNativePricing({ ...MODEL_REF, cost: [{ input: 1, output: 1, tier: { type: 'context', size: 1 } }] }), /pricing_ambiguous/);
});

test('direct native SSE is scoped immediately; disconnect and reconnect cannot silently lose correspondence', async () => {
  const f = fixture({ witness: false, seal: false });
  // Use a new observer state: readiness is supplied by the real direct wire parser.
  const c = createNativeCorrespondence({ sessionID: sid, incarnation: 'i', promptSha256: hash('p'), createdAt: Date.now() - 10, condition: 'plugin-off' });
  let stream, failures = 0;
  const observer = await observeNativeEvents(async () => new Response(new ReadableStream({ start(controller) {
    stream = controller; controller.enqueue(Buffer.from('data: {"type":"server.connected"}\n\n'));
    controller.enqueue(Buffer.from('data: {"type":"unknown","data":{"sessionID":"ses_other","secret":"not retained"}}\n\n'));
  } }), { headers: { 'Content-Type': 'text/event-stream' } }), c, () => { failures++; });
  assert.equal(c.snapshot().connected, true); assert.doesNotMatch(JSON.stringify(c.snapshot()), /secret|not retained/);
  stream.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures, 1); assert.throws(() => c.check(), /observer_failed/); await observer.close();
  assert.throws(() => f.c.accept({ type: 'server.connected' }), /reconnected/);
});

test('finalization preserves exact rejection codes for missing binding versus missing idle/settlement', async () => {
  const missing = fixture({ witness: false, bind: false });
  assert.throws(() => missing.c.eligibleAtClosure(false), error => {
    const diagnostic = projectFinalizationDiagnostics(error, { stage: 'eligibility', correspondence: missing.c.snapshot(), cliComplete: false });
    assert.equal(diagnostic.rejection_code, 'native_preclosure_witness_or_binding_missing');
    assert.equal(diagnostic.witness.present, false); assert.equal(diagnostic.witness.preclose, false);
    return true;
  });
  for (const [code, mutate] of [
    ['native_session_completion_rejected', f => { delete f.snapshot.session.time.idle; }],
    ['native_complete_interval_rejected', f => { f.snapshot.rows.pop(); }],
    ['native_final_answer_mismatch', f => { f.options.finalText = 'α\nanswer'; }],
    ['native_recorded_usage_missing', f => { delete f.snapshot.rows[1].cost; }],
    ['native_usage_aggregate_mismatch', f => { f.snapshot.session.cost = 0.002; }],
    ['native_usage_baseline_or_pricing_rejected', f => { f.options.pricing = null; }],
  ]) {
    const f = fixture(), state = { correspondence: f.c.snapshot(), cliComplete: false, evidenceWritten: false };
    mutate(f);
    await assert.rejects(inspectNativeCompletion(async () => f.snapshot, f.options, Date.now() + 1000, undefined,
      progress => Object.assign(state, progress)), error => {
      const diagnostic = projectFinalizationDiagnostics(error, state);
      assert.equal(diagnostic.rejection_code, code);
      assert.equal(diagnostic.stage, 'validation'); assert.equal(diagnostic.snapshot_read_number, 1);
      assert.equal(diagnostic.witness.present, true); assert.equal(diagnostic.witness.preclose, true);
      assert.equal(diagnostic.witness.created_relative_to_closure_ms, -2);
      assert.equal(diagnostic.witness.received_relative_to_closure_ms, -1);
      assert.deepEqual(diagnostic.ledger, [{ ordinal: 1, acknowledged: true, step_start_received: true,
        assistant_bound: true, continuation_settled: false }]);
      assert.equal(diagnostic.native_completion_evidence_written, false);
      assert.equal(isFinalizationReceipt(diagnostic), false);
      return true;
    });
  }
  for (const [cost, code] of [
    [[{ input: 0, output: 0 }], 'native_pricing_missing'],
    [[{ input: 1, output: 1, tier: { type: 'context', size: 1 } }], 'native_pricing_ambiguous'],
  ]) assert.throws(() => projectNativePricing({ ...MODEL_REF, cost }), error => diagnosticReason(error) === code);
});

test('changed snapshot and hung second read retain their own code and inspection position', async () => {
  for (const hung of [false, true]) {
    const f = fixture(), state = { correspondence: f.c.snapshot() }; let reads = 0;
    await assert.rejects(inspectNativeCompletion(async () => {
      if (++reads === 1) return f.snapshot;
      if (hung) return new Promise(() => {});
      const changed = structuredClone(f.snapshot); changed.rows[1].rawFinish = 'changed'; return changed;
    }, f.options, Date.now() + (hung ? 30 : 1000), undefined, progress => Object.assign(state, progress)), error => {
      const diagnostic = projectFinalizationDiagnostics(error, state);
      assert.equal(diagnostic.rejection_code, hung ? 'native_inspection_deadline' : 'native_snapshots_changed');
      assert.equal(diagnostic.stage, hung ? 'snapshot' : 'validation');
      assert.equal(diagnostic.snapshot_read_number, 2); return true;
    });
    assert.equal(reads, 2);
  }
});

test('finalization diagnostic projection is fixed-field, capped, unknown-aware and non-authorizing', () => {
  const hostile = 'native_invented_secret_endpoint https://private.invalid Authorization: secret';
  const missing = projectFinalizationDiagnostics(new Error(hostile));
  assert.equal(diagnosticReason({ get message() { throw new Error(hostile); } }), 'unknown_failure');
  assert.equal(missing.rejection_code, 'unknown_failure'); assert.equal(missing.stage, 'unknown');
  assert.equal(missing.cli_complete, null); assert.equal(missing.cli_closed_at_ms, null);
  assert.deepEqual(missing.witness, { present: null, preclose: null, created_relative_to_closure_ms: null, received_relative_to_closure_ms: null });
  assert.equal(missing.ledger, null); assert.equal(missing.snapshot_read_number, null);
  assert.equal(missing.native_completion_evidence_written, null);
  const f = fixture(), state = { stage: hostile, cliComplete: hostile, evidenceWritten: true, snapshotReadNumber: 200,
    correspondence: { ...f.c.snapshot(), ledger: Array.from({ length: 200 }, (_, i) => ({ ordinal: i + 1, secret: hostile })) },
    seal: { phase: 'sealed', ordinal: 200, released: 200, model_requests: 200, violations: 0, tool_calls: 2, active_tools: 0, secret: hostile },
    headers: hostile, stack: hostile };
  const diagnostic = projectFinalizationDiagnostics(new Error(hostile), state);
  assert.deepEqual(Object.keys(diagnostic), ['schema', 'authority', 'unknown_values', 'rejection_code',
    'observer_reason', 'observer_event_type', 'observer_event_types', 'timestamp_delta_ms', 'unknown_event_types', 'ignored_unknown_events', 'stage', 'cli_closed_at_ms',
    'cli_complete', 'witness', 'ledger_count', 'ledger', 'ledger_truncated', 'snapshot_read_number', 'seal',
    'native_completion_evidence_written', 'max_bytes', 'max_ledger_records']);
  assert.equal(diagnostic.ledger_count, 200); assert.equal(diagnostic.ledger_truncated, true);
  assert.ok(diagnostic.ledger.length <= 16); assert.equal(diagnostic.ledger.at(-1).ordinal, 200);
  assert.deepEqual(diagnostic.ledger.at(-1), { ordinal: 200, acknowledged: null, step_start_received: null,
    assistant_bound: null, continuation_settled: null });
  assert.deepEqual(diagnostic.seal, { phase: 'sealed', ordinal: 200, released: 200, model_requests: 200,
    violations: 0, tool_calls: 2, active_tools: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic) + '\n') <= 4096);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|Authorization|private\.invalid|headers|stack/);
  assert.equal(isFinalizationReceipt(diagnostic), false);
  assert.equal(consumeFinalizationReceipt(diagnostic, { episode_id: 'fixture' }, f.options.template.prompt_sha256), false);
  const telemetry = createProductionDiagnostics({});
  telemetry.finalizationFailure(new Error('native_seal_changed'), state);
  telemetry.finalizationFailure(new Error('live_finish_identity_rejected'), {});
  assert.equal(telemetry.snapshot().finalization.rejection_code, 'native_seal_changed', 'first cause survives follow-on rejection');
});

test('observer attribution projection sanitizes forged fields and stays below 4 KiB at every cap', () => {
  const f = fixture(), correspondence = { ...f.c.snapshot(), observer_reason: 'secret unlisted reason',
    ignored_unknown_events: 10001, unknown_event_types: ['unsafe value', 'A'.repeat(65), null, 1, 'Safe', 'Safe'],
    ledger: Array.from({ length: 200 }, (_, i) => ({ ordinal: i + 1 })) };
  let diagnostic = projectFinalizationDiagnostics(new Error('native_event_correspondence_rejected'), { correspondence });
  assert.equal(diagnostic.observer_reason, 'unknown_failure');
  assert.equal(diagnostic.ignored_unknown_events, null);
  assert.deepEqual(diagnostic.unknown_event_types, ['Safe']);
  correspondence.unknown_event_types = Array.from({ length: 10 }, (_, i) => `T${i}${'x'.repeat(62)}`);
  correspondence.observer_reason = 'native_durable_sequence_rejected';
  correspondence.ignored_unknown_events = 10000;
  diagnostic = projectFinalizationDiagnostics(new Error('native_event_correspondence_rejected'), { correspondence });
  assert.equal(diagnostic.unknown_event_types.length, 8);
  assert.equal(diagnostic.ignored_unknown_events, 10000);
  assert.equal(diagnostic.observer_reason, 'native_durable_sequence_rejected');
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic) + '\n') < 4096);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|unsafe value/);
  assert.equal(isFinalizationReceipt(diagnostic), false);
});

test('diagnostic writes start before cleanup but rejection, throws and hangs cannot block it or mint authority', async () => {
  for (const mode of ['written', 'rejected', 'throws', 'hung']) {
    const order = [], diagnostic = projectFinalizationDiagnostics(new Error('native_preclosure_witness_or_binding_missing'));
    const writing = persistFinalizationDiagnostics('fixture-only-no-file', diagnostic, (_file, bytes, options) => {
      order.push('write'); assert.ok(Buffer.byteLength(bytes) <= 4096); assert.equal(options.flag, 'wx');
      assert.equal(JSON.parse(bytes).authority, 'none');
      if (mode === 'throws') throw new Error('hostile secret');
      if (mode === 'rejected') return Promise.reject(new Error('hostile secret'));
      if (mode === 'hung') return new Promise(() => {});
      return Promise.resolve();
    });
    const cleaned = await cleanupOwnedCLI({ cleanupOwned() {
      order.push('cleanup'); return { cleanup: { confirmed: true, active_processes: 0 }, ownership: { job_assigned: true, kill_on_close: true } };
    } }, true);
    assert.deepEqual(order, ['write', 'cleanup']); assert.equal(cleaned.confirmed, true);
    assert.equal(isFinalizationReceipt(diagnostic), false); assert.equal(isFinalizationReceipt(cleaned), false);
    assert.equal(await writing, mode === 'written' ? 'written' : mode === 'hung' ? 'write_timeout' : 'write_failed');
  }
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /nativeSeal\.catch\(error => \{ finalizationState\.stage = 'seal'; recordNativeFailure\(error\); monitorFailure = true; void handle\.cleanup\(\)/);
  assert.match(source, /catch \(error\) \{ recordNativeFailure\(error\); monitorFailure = true; void handle\.cleanup\(\)/);
  assert.match(source, /catch \(error\) \{ recordNativeFailure\(error\); diagnostics\.event\('finish'[\s\S]*?finally \{ await handle\.cleanup\(\); \}/);
  assert.doesNotMatch(source, /await (?:finalizationWrite|persistFinalizationDiagnostics\()/);
});

test('inspection diagnostic callback failure cannot change completion checks', async () => {
  const f = fixture(); let reads = 0;
  const result = await inspectNativeCompletion(async () => { reads++; return f.snapshot; }, f.options, Date.now() + 1000, undefined,
    () => { throw new Error('diagnostic failure'); });
  assert.equal(reads, 2); assert.equal(isFinalizationReceipt(result), false);
  await assert.rejects(inspectNativeCompletion(async () => f.snapshot, { ...f.options, finalText: 'wrong' }, Date.now() + 1000, undefined,
    () => { throw new Error('diagnostic failure'); }), { message: 'native_final_answer_mismatch' });
});

test('prospective no-witness snapshots require completed native timestamps at or before immutable host closure', async () => {
  const f = fixture({ witness: false }); let reads = 0;
  assert.equal(f.c.eligibleAtClosure(false), true);
  const good = await inspectNativeCompletion(async () => { reads++; return f.snapshot; }, f.options, Date.now() + 1000);
  assert.equal(reads, 2); assert.equal(good.snapshot.idle_at_ms, f.sent + 3);
  assert.equal(f.options.correspondence.witness, null);
  assert.equal(isFinalizationReceipt(good), false);
  for (const mutate of [
    x => { x.snapshot.session.time.idle = x.sent + 6; x.snapshot.rows.at(-1).time.created = x.sent + 6; },
    x => { delete x.snapshot.session.time.idle; },
    x => { x.snapshot.session.outcome = 'running'; },
    x => { x.snapshot.rows.pop(); },
    x => { x.snapshot.rows[1].time.completed = x.sent + 6; },
    x => { delete x.snapshot.rows[1].time.completed; },
    x => { x.snapshot.rows[1].time.completed = x.sent - 1; },
    x => { x.snapshot.rows[1].finish = 'tool-calls'; },
    x => { x.snapshot.rows[1].retry = {}; },
    x => { x.options.finalText = x.options.finalText.trim(); },
    x => { x.snapshot.rows.at(-1).error = {}; },
    x => { x.snapshot.rows.push(structuredClone(x.snapshot.rows.at(-1))); },
  ]) {
    const changed = fixture({ witness: false }); mutate(changed);
    assert.throws(() => validateNativeCompletionSnapshot(changed.snapshot, { ...changed.options,
      cli_closed_at: changed.sent + 1000 }), /native_/);
  }
  // Equality at C is allowed, with no allowance beyond it.
  f.snapshot.session.time.idle = f.sent + 5; f.snapshot.rows.at(-1).time.created = f.sent + 5;
  assert.doesNotThrow(() => validateNativeCompletionSnapshot(f.snapshot, f.options));
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /projectNativeCompletionKind\(correspondenceSnapshot, cliComplete, inspected\.snapshot\.idle_at_ms\)/);
  assert.match(source, /completion_evidence: completion, post_release_bindings: correspondenceSnapshot\.bindings, witness: evidenceWitness/);
  assert.doesNotMatch(source, /timestamp_basis: \{ closed_at_ms: cli_closed_at/);
});

test('an incomplete first snapshot is fatal even if the unrequested next read would pass', async () => {
  const f = fixture({ witness: false }); let reads = 0;
  const incomplete = structuredClone(f.snapshot); delete incomplete.session.time.idle;
  await assert.rejects(inspectNativeCompletion(async () => ++reads === 1 ? incomplete : f.snapshot,
    f.options, Date.now() + 1000), /native_session_completion_rejected/);
  assert.equal(reads, 1, 'no second/third read, polling or future-settlement rescue');
});

test('late success must be bound, timestamped no later than C, and never permit subsequent activity', () => {
  for (const delta of [3, 5]) {
    const f = fixture({ witness: false });
    f.c.accept(f.event('session.execution.succeeded', 2, {}, f.sent + delta), f.sent + 10);
    const correspondence = f.c.snapshot();
    assert.equal(correspondence.closed_at_ms, f.sent + 5);
    assert.equal(correspondence.witness.received_after_closure, true);
    assert.equal(correspondence.witness.received_at_ms, f.sent + 10);
    assert.equal(f.c.eligibleAtClosure(false), true);
    assert.doesNotThrow(() => validateNativeCompletionSnapshot(f.snapshot, { ...f.options, correspondence }));
    assert.throws(() => f.c.beginRelease(2, hash('new')), /native_/);
  }
  for (const variant of ['future', 'unbound', 'missing-ack', 'malformed', 'duplicate', 'new-step', 'durable-after-success', 'durable-after-C']) {
    const f = fixture({ witness: false, bind: variant !== 'unbound' && variant !== 'missing-ack', ack: variant !== 'missing-ack' });
    if (['duplicate', 'new-step', 'durable-after-success', 'durable-after-C'].includes(variant))
      f.c.accept(f.event('session.execution.succeeded', 2, {}, f.sent + 3), f.sent + 10);
    const event = variant === 'new-step'
      ? f.event('session.step.started', 3, { assistantMessageID: mid(4), agent: AGENT, model: MODEL_REF, started: f.sent + 4 }, f.sent + 4)
      : variant === 'durable-after-success' ? f.event('session.step.ended', 3, {}, f.sent + 4)
      : variant === 'durable-after-C' ? f.event('session.step.ended', 3, {}, f.sent + 6)
      : f.event('session.execution.succeeded', variant === 'duplicate' ? 3 : 2, {}, f.sent + (variant === 'future' ? 6 : 3));
    if (variant === 'malformed') delete event.durable;
    assert.throws(() => f.c.accept(event, f.sent + 11), /native_/, variant);
    assert.throws(() => f.c.check(), /native_/);
    assert.throws(() => validateNativeCompletionSnapshot(f.snapshot, { ...f.options, correspondence: f.c.snapshot() }), /native_/);
  }
  const preclose = fixture();
  assert.equal(preclose.c.snapshot().witness.received_after_closure, false);
  assert.doesNotThrow(() => validateNativeCompletionSnapshot(preclose.snapshot, preclose.options));
  const future = structuredClone(preclose.options); future.correspondence.witness.created = preclose.sent + 6;
  assert.throws(() => validateNativeCompletionSnapshot(preclose.snapshot, future), /native_completion_correspondence_missing/);
});

test('only receipt at or before C selects preclose kind; late-only and absent witnesses select timestamped evidence', async () => {
  for (const mode of ['absent', 'late', 'at-C', 'before-C']) {
    const f = fixture({ witness: false, seal: false });
    if (mode === 'before-C' || mode === 'at-C')
      f.c.accept(f.event('session.execution.succeeded', 2, {}, f.sent + 3), f.sent + (mode === 'at-C' ? 5 : 4));
    f.c.seal(f.sent + 5);
    let reads = 0;
    const inspected = await inspectNativeCompletion(async () => {
      if (++reads === 2 && mode === 'late')
        f.c.accept(f.event('session.execution.succeeded', 2, {}, f.sent + 3), f.sent + 10);
      return f.snapshot;
    }, { ...f.options, correspondence: f.c.snapshot() }, Date.now() + 1000);
    assert.equal(reads, 2);
    const before = f.c.snapshot(), projected = projectNativeCompletionKind(before, false, inspected.snapshot.idle_at_ms);
    const preclose = mode === 'before-C' || mode === 'at-C';
    assert.equal(projected.kind, preclose ? 'native_preclose_witness' : 'native_timestamped_snapshot');
    assert.deepEqual(projected.timestamp_basis, { closed_at_ms: f.sent + 5, idle_at_ms: f.sent + 3, witness_present: preclose });
    assert.equal(projected.witness_sha256, preclose ? hash(before.witness) : null);
    assert.deepEqual(projected.witness, preclose ? before.witness : null);
    assert.equal(isFinalizationReceipt(projected), false);
    assert.deepEqual(f.c.snapshot(), before, 'attribution cannot remove internal contradiction evidence');
    if (mode === 'late') assert.equal(f.c.snapshot().witness.received_after_closure, true);
  }
});
