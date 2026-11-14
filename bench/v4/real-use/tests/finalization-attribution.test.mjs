import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridge from '../bridge.mjs';
import { AGENT, TITLE, MODEL_REF, hash } from '../runtime-plugin.js';
import { isFinalizationReceipt, consumeFinalizationReceipt, validateNativeCompletionData } from '../admission.mjs';
import { captureEpisode } from '../run.mjs';
import { FRESH_PROFILES, RETIRED_PROFILES, sha256 } from '../lib.mjs';

const compatProfileId = Object.keys(FRESH_PROFILES).find(id => FRESH_PROFILES[id].role === 'compat');
const workflowsProfileId = Object.keys(FRESH_PROFILES).find(id => FRESH_PROFILES[id].role === 'workflows');

test('closed executable profiles contain exactly one compat and one workflows entry', () => {
  assert.equal(Object.keys(FRESH_PROFILES).length, 2);
  assert.deepEqual(Object.values(FRESH_PROFILES).map(profile => profile.role).sort(), ['compat', 'workflows']);
  for (const id of [compatProfileId, workflowsProfileId]) {
    assert.equal(Object.hasOwn(FRESH_PROFILES, id), true);
    assert.equal(FRESH_PROFILES[id].profile_id, id);
  }
  assert.notEqual(compatProfileId, workflowsProfileId);
  assert.ok(Object.keys(RETIRED_PROFILES).length > 0);
});

// Offline data only. Never call startAuditBridge/admitEpisode or write an artifact.
// The injected persistence writer below captures bytes in memory, not on disk.
test('retired capture profiles reject with invalid_capture_profile before launch or finalization', async () => {
  const protocolHash = sha256(FRESH_PROFILES[compatProfileId].protocol);
  let launches = 0, finalizations = 0;
  for (const profileId of Object.keys(RETIRED_PROFILES)) {
    await assert.rejects(captureEpisode({ profileId, protocolHash,
      launcherFactory() { launches++; assert.fail('retired profile must not launch'); },
      finalize() { finalizations++; assert.fail('retired profile must not finalize'); },
    }), { message: 'invalid_capture_profile' });
    assert.equal(launches, 0); assert.equal(finalizations, 0);
  }
});

const mid = n => `msg_0123456789ab${String(n).padStart(14, '0')}`;
const sid = 'ses_attribution_fixture';
const amounts = (input = 10, cost = 0.001) => ({ cost,
  tokens: { input, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });
const zero = () => ({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
const pricing = () => bridge.projectNativePricing({ ...MODEL_REF,
  cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] });
const tool = (id = 'list1') => ({ type: 'tool', name: 'approved_list', id,
  state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'README.md' }] },
  time: { created: 1000, completed: 1000 } });

function fixture(t, { witness = true, bind = true, ack = true, seal = true } = {}) {
  t.mock.method(Date, 'now', () => 1000);
  const template = { sessionID: sid, messageID: mid(1), prompt_sha256: hash('prompt'),
    messages: [{ content: [{ type: 'text', text: 'prompt' }] }] };
  const c = bridge.createNativeCorrespondence({ sessionID: sid, incarnation: 'fixture-incarnation',
    promptSha256: template.prompt_sha256, createdAt: 900, condition: 'plugin-off' });
  c.accept({ type: 'server.connected' }); c.beginRelease(1, hash('release'));
  const event = (type, seq, data = {}, created = 1000 + seq) => ({ id: `evt_${seq}`, created, type,
    durable: { aggregateID: sid, seq, version: 1 }, data: { sessionID: sid, ...data } });
  c.accept(event('session.step.started', 1, { assistantMessageID: mid(2), agent: AGENT, model: MODEL_REF, started: 1000 }), 1001);
  const assistant = { id: mid(2), type: 'assistant', agent: AGENT, model: MODEL_REF,
    content: [{ type: 'text', text: 'α' }, { type: 'text', text: '\nanswer ' }], finish: 'stop',
    time: { created: 1000, completed: 1002 }, ...amounts() };
  if (ack) c.acknowledge(1);
  if (bind) c.bindAssistant(assistant);
  if (witness) c.accept(event('session.execution.succeeded', 2, {}, 1003), 1004);
  if (seal) c.seal(1005);
  const snapshot = { session: { id: sid, agent: AGENT, model: MODEL_REF, title: TITLE,
    location: { directory: 'fixture' }, outcome: 'succeeded', time: { created: 900, idle: 1003 }, ...amounts() },
  rows: [{ id: mid(1), type: 'user', text: 'prompt', files: [], time: { created: 901 } }, assistant,
    { id: mid(3), type: 'idle', outcome: 'succeeded', time: { created: 1003 } }], inbox: [], children: [] };
  const options = { template, condition: 'plugin-off', cwd: 'fixture', correspondence: c.snapshot(),
    finalText: 'α\nanswer ', capturedAssistantIDs: [mid(2)], captureToolEvidence: [],
    baseline: { ...zero(), time: { created: 900 } }, pricing: pricing(), cliComplete: false };
  return { c, event, assistant, snapshot, options };
}

function toolFixture(t) {
  const f = fixture(t, { witness: false, seal: false });
  f.assistant.finish = 'tool-calls'; f.assistant.time.completed = 1000;
  f.assistant.content = [tool('list1'), tool('list2')];
  f.c.settleContinuation(f.assistant); f.c.beginRelease(2, hash('release2')); f.c.acknowledge(2);
  f.c.accept(f.event('session.step.started', 2,
    { assistantMessageID: mid(4), agent: AGENT, model: MODEL_REF, started: 1000 }, 1002), 1002);
  const final = { ...structuredClone(f.assistant), id: mid(4), finish: 'stop',
    content: [{ type: 'text', text: f.options.finalText }], time: { created: 1002, completed: 1003 } };
  f.c.bindAssistant(final); f.c.accept(f.event('session.execution.succeeded', 3, {}, 1004), 1005); f.c.seal(1006);
  f.snapshot.rows.splice(2, 0, final); f.snapshot.rows.at(-1).time.created = 1004;
  f.snapshot.session.time.idle = 1004; f.snapshot.session.cost *= 2;
  f.snapshot.session.tokens.input *= 2; f.snapshot.session.tokens.output *= 2;
  f.options.correspondence = f.c.snapshot(); f.options.capturedAssistantIDs = [mid(2), mid(4)];
  f.options.captureToolEvidence = f.assistant.content.map(part => ({ name: part.name, call_id: part.id,
    native_assistant_id: mid(2), input_sha256: hash(part.state.input), output_sha256: hash(part.state.content[0].text), status: 'completed' }));
  return f;
}

function nonAuthorizing(value) {
  assert.equal(bridge.isOwnedBridge(value), false);
  assert.equal(isFinalizationReceipt(value), false);
  assert.equal(consumeFinalizationReceipt(value, { episode_id: 'fixture' }, hash('prompt')), false);
}

async function persisted(error, state, code) {
  assert.equal(bridge.diagnosticReason(error), code);
  const projected = bridge.projectFinalizationDiagnostics(error, state);
  let writes = 0, saved;
  assert.equal(await bridge.persistFinalizationDiagnostics('in-memory-only', projected, (file, bytes, options) => {
    writes++;
    assert.equal(file, 'in-memory-only'); assert.deepEqual(options, { flag: 'wx', mode: 0o600 });
    assert.ok(Buffer.byteLength(bytes) <= 4096);
    saved = JSON.parse(bytes);
  }), 'written');
  assert.equal(writes, 1); assert.deepEqual(saved, projected);
  assert.equal(saved.rejection_code, code); assert.equal(saved.authority, 'none');
  assert.ok(saved.ledger === null || saved.ledger.length <= 16);
  assert.ok(Object.hasOwn(saved, 'ledger_truncated'));
  nonAuthorizing(projected); nonAuthorizing(saved);
  return saved;
}

async function rejected(action, code, state = {}, projectedCode = code) {
  let caught;
  await assert.rejects(async () => action(), error => {
    assert.equal(error.message, code); caught = error; return true;
  });
  return persisted(caught, state, projectedCode);
}

async function rejectInspection(f, code, read = async () => f.snapshot, position = 1, stage = 'validation', deadline = 2000) {
  const state = { correspondence: f.options.correspondence, cliComplete: false, evidenceWritten: false };
  const result = await rejected(() => bridge.inspectNativeCompletion(read, f.options, deadline, undefined,
    progress => Object.assign(state, progress)), code, state);
  assert.equal(result.stage, stage); assert.equal(result.snapshot_read_number, position);
  assert.equal(result.native_completion_evidence_written, false);
  return result;
}

test('valid local fixtures pass both reads but cannot mint any production authority', async t => {
  for (const make of [fixture, toolFixture]) {
    const f = make(t); let reads = 0;
    const data = await bridge.inspectNativeCompletion(async () => { reads++; return f.snapshot; }, f.options, 2000);
    assert.equal(reads, 2); assert.equal(data.native_snapshot_sha256[0], data.native_snapshot_sha256[1]);
    for (const value of [f.c, f.c.snapshot(), data]) nonAuthorizing(value);
  }
});

for (const [name, setup] of [['unbound', { bind: false }], ['unacknowledged/unbound', { ack: false, bind: false }]]) {
  test(`eligibility: absent preclose witness and ${name} ledger`, async t => {
    const f = fixture(t, { witness: false, ...setup });
    const p = await rejected(() => f.c.eligibleAtClosure(false), 'native_preclosure_witness_or_binding_missing',
      { stage: 'eligibility', correspondence: f.c.snapshot(), cliComplete: false });
    assert.equal(p.witness.present, false); assert.equal(p.witness.preclose, false);
    assert.equal(p.ledger[0].assistant_bound, false); assert.equal(p.ledger[0].continuation_settled, false);
  });
}

// Earlier history/session guards intentionally win; do not mislabel them as interval failures.
const snapshotCases = [
  ['session outcome not succeeded', 'native_session_completion_rejected', f => { f.snapshot.session.outcome = 'running'; }],
  ['session idle missing with witness', 'native_session_completion_rejected', f => { delete f.snapshot.session.time.idle; }],
  ['idle later than closure with witness', 'native_session_completion_rejected', f => { f.snapshot.session.time.idle = 1006; f.snapshot.rows.at(-1).time.created = 1006; }],
  ['idle record missing with witness', 'native_complete_interval_rejected', f => { f.snapshot.rows.pop(); }],
  ['assistant settlement later than idle', 'native_complete_interval_rejected', f => { f.assistant.time.completed = 1004; }],
  ['assistant settlement missing (history guard)', 'native_history_rejected', f => { delete f.assistant.time.completed; }],
  ['extra assistant', 'native_complete_interval_rejected', f => { f.snapshot.rows.splice(2, 0, { ...structuredClone(f.assistant), id: mid(5) }); }],
  ['missing assistant', 'native_complete_interval_rejected', f => { f.snapshot.rows.splice(1, 1); }],
  ['final finish not stop', 'native_final_answer_mismatch', f => { f.assistant.finish = 'length'; }],
  ['tool part in final content', 'native_final_answer_mismatch', f => { f.assistant.content.push(tool()); }],
  ['concatenated native text byte mismatch', 'native_final_answer_mismatch', f => { f.options.finalText = 'α\nanswer'; }],
  ['native text part order mismatch', 'native_final_answer_mismatch', f => { f.assistant.content.reverse(); }],
  ['inbox nonempty', 'native_session_completion_rejected', f => { f.snapshot.inbox.push({}); }],
  ['child nonempty', 'native_session_completion_rejected', f => { f.snapshot.children.push({}); }],
  ['recorded cost missing', 'native_recorded_usage_missing', f => { delete f.assistant.cost; }],
  ['token component missing (history guard)', 'native_history_rejected', f => { delete f.assistant.tokens.reasoning; }],
  ['aggregate token mismatch', 'native_usage_aggregate_mismatch', f => { f.snapshot.session.tokens.input++; }],
  ['aggregate cost mismatch', 'native_usage_aggregate_mismatch', f => { f.snapshot.session.cost *= 2; }],
  ['pricing projection missing', 'native_usage_baseline_or_pricing_rejected', f => { f.options.pricing = null; }],
];
for (const [name, code, mutate] of snapshotCases) test(`${name} -> ${code}`, async t => {
  const f = fixture(t); mutate(f);
  const p = await rejectInspection(f, code);
  assert.equal(p.witness.present, true); assert.equal(p.witness.preclose, true);
  assert.equal(p.witness.created_relative_to_closure_ms, -2);
  assert.equal(p.witness.received_relative_to_closure_ms, -1);
  assert.deepEqual(p.ledger, [{ ordinal: 1, acknowledged: true, step_start_received: true,
    assistant_bound: true, continuation_settled: false }]);
});

const toolCases = [
  ['input hash mismatch', f => { f.options.captureToolEvidence[0].input_sha256 = hash({ other: true }); }],
  ['result hash mismatch', f => { f.options.captureToolEvidence[0].output_sha256 = hash('other result'); }],
  ['duplicate captured call id', f => { f.options.captureToolEvidence[1] = { ...f.options.captureToolEvidence[0] }; }],
  ['missing captured tool record', f => { f.options.captureToolEvidence.pop(); }],
  ['extra captured tool record', f => { f.options.captureToolEvidence.push({ ...f.options.captureToolEvidence[0], call_id: 'extra' }); }],
];
for (const [name, mutate] of toolCases) test(`tool correspondence: ${name}`, async t => {
  const f = toolFixture(t); mutate(f); await rejectInspection(f, 'native_cli_tool_correspondence_rejected');
});
test('duplicate native call id is rejected earlier by history, not tool correspondence', async t => {
  const f = toolFixture(t); f.assistant.content[1].id = f.assistant.content[0].id;
  await rejectInspection(f, 'native_history_rejected');
});
test('unsettled prior ledger cannot be rescued by timestamped completion', async t => {
  const f = toolFixture(t); f.options.correspondence = structuredClone(f.options.correspondence);
  f.options.correspondence.witness = null; f.options.correspondence.ledger[0].settled = false;
  await rejectInspection(f, 'native_completion_correspondence_missing');
});

const components = [['input'], ['output'], ['reasoning'], ['cache', 'read'], ['cache', 'write']];
for (const keys of components) for (const [name, value] of [['missing', undefined], ['negative', -1], ['fractional', 0.5]]) {
  test(`accounting ${keys.join('.')}: ${name} -> native_recorded_usage_missing`, async () => {
    const row = amounts(), parent = keys.length === 2 ? row.tokens.cache : row.tokens;
    if (value === undefined) delete parent[keys.at(-1)]; else parent[keys.at(-1)] = value;
    await rejected(() => bridge.nativeRecordedUsage([row], amounts(), zero(), pricing()), 'native_recorded_usage_missing', { stage: 'validation' });
  });
}
test('all token components zero -> native_zero_usage_ambiguous', async () => {
  await rejected(() => bridge.nativeRecordedUsage([zero()], zero(), zero(), pricing()), 'native_zero_usage_ambiguous', { stage: 'validation' });
});
test('individual zero components are explicit valid usage, not missing values', () => {
  for (const keys of components) {
    const row = amounts(); (keys.length === 2 ? row.tokens.cache : row.tokens)[keys.at(-1)] = 0;
    assert.equal(bridge.nativeRecordedUsage([row], row, zero(), pricing()).steps, 1);
  }
});
test('zero cost at positive rates -> native_zero_cost_ambiguous', async () => {
  const row = amounts(10, 0);
  await rejected(() => bridge.nativeRecordedUsage([row], row, zero(), pricing()), 'native_zero_cost_ambiguous', { stage: 'validation' });
});
test('nonzero fresh baseline -> native_usage_baseline_or_pricing_rejected', async () => {
  await rejected(() => bridge.nativeRecordedUsage([amounts()], amounts(), amounts(), pricing()),
    'native_usage_baseline_or_pricing_rejected', { stage: 'validation' });
});
test('missing positive-token rate -> native_missing_rate_or_zero_ambiguous', async () => {
  const price = structuredClone(pricing()); delete price.rates.input;
  await rejected(() => bridge.nativeRecordedUsage([amounts()], amounts(), zero(), price),
    'native_missing_rate_or_zero_ambiguous', { stage: 'validation' });
});
for (const [name, cost, code] of [
  ['missing explicit cache rates', [{ input: 1, output: 1 }], 'native_pricing_missing'],
  ['ambiguous multiple tiers', [{ input: 1 }, { input: 2 }], 'native_pricing_ambiguous'],
  ['unsupported tier selector', [{ input: 1, output: 1, tier: { type: 'context', size: 1 } }], 'native_pricing_ambiguous'],
]) test(`pricing: ${name} -> ${code}`, async () => {
  await rejected(() => bridge.projectNativePricing({ ...MODEL_REF, cost }), code);
});

test('two individually valid but changed snapshots -> native_snapshots_changed', async t => {
  const f = fixture(t); let reads = 0;
  await rejectInspection(f, 'native_snapshots_changed', async () => {
    const value = structuredClone(f.snapshot); if (++reads === 2) value.rows[1].rawFinish = 'changed'; return value;
  }, 2);
  assert.equal(reads, 2);
});
test('first invalid snapshot fails without reading the available valid second snapshot', async t => {
  const f = fixture(t, { witness: false }), bad = structuredClone(f.snapshot); let reads = 0;
  delete bad.session.time.idle;
  await rejectInspection(f, 'native_session_completion_rejected', async () => ++reads === 1 ? bad : f.snapshot);
  assert.equal(reads, 1);
});
test('expired inspection deadline rejects before any snapshot read', async t => {
  const f = fixture(t); let reads = 0;
  await rejectInspection(f, 'native_inspection_deadline', async () => { reads++; return f.snapshot; }, null, 'unknown', 999);
  assert.equal(reads, 0);
});
test('deadline expires during second snapshot without relying on a sleep', async t => {
  const f = fixture(t); let reads = 0;
  await rejectInspection(f, 'native_inspection_deadline', async () => {
    if (++reads === 2) t.mock.method(Date, 'now', () => 2000);
    return f.snapshot;
  }, 2);
  assert.equal(reads, 2);
});

for (const [name, code, page] of [
  ['nonarray data', 'native_message_page_rejected', () => ({ data: {}, cursor: {} })],
  ['missing cursor', 'native_message_page_rejected', () => ({ data: [] })],
  ['unknown cursor field', 'native_message_page_rejected', () => ({ data: [], cursor: { other: 'x' } })],
  ['duplicate message id', 'native_message_interval_rejected', () => ({ data: [{ id: mid(1) }, { id: mid(1) }], cursor: {} })],
  ['nonstring next cursor', 'native_message_cursor_rejected', () => ({ data: [{ id: mid(1) }], cursor: { next: 1 } })],
  ['repeated next cursor', 'native_message_cursor_rejected', n => ({ data: [{ id: mid(n) }], cursor: { next: 'same' } })],
  ['fifth page required', 'native_message_page_cap', n => ({ data: [{ id: mid(n) }], cursor: { next: `page${n}` } })],
]) test(`pagination: ${name} -> ${code}`, async () => {
  let reads = 0;
  await rejected(() => bridge.readNativeMessagePages(async () => page(++reads)), code, { stage: 'snapshot', snapshotReadNumber: 1 });
});

// These branches live inside the genuine bridge's private launch/finish closures.
// Synthetic errors below exercise attribution/persistence ONLY, not those guards.
const privateBranches = [
  ['seal evidence rejected', 'native_seal_evidence_rejected', 'seal'],
  ['seal changed between reads', 'native_seal_changed', 'seal'],
  ['serialized completion evidence cap exceeded', 'native_evidence_cap', 'evidence_write'],
  ['child cursor indicates more children', 'native_child_scope_rejected', 'snapshot'],
];
for (const [name, code, stage] of privateBranches) {
  test(`private branch attribution ONLY: ${name} -> ${code}`, async () => {
    assert.equal(Object.hasOwn(bridge, 'finish'), false);
    assert.equal(Object.hasOwn(bridge, 'nativeSeal'), false);
    assert.equal(Object.hasOwn(bridge, 'readSnapshot'), false);
    nonAuthorizing({ finish() {} });
    const p = await persisted(new Error(code), { stage, evidenceWritten: false }, code);
    assert.equal(p.stage, stage);
  });
  test(`UNREACHABLE offline branch: ${name}`, { skip:
    'Private owned bridge closure; exercising it requires forbidden production startup/RPC. No copied guard or fake authority.' }, () => {});
}

const hostile = 'unrecognized hostile text C:\\fixture-private\\trace Authorization: Bearer sk-fixture-only-secret https://private.invalid';
for (const [name, make] of [
  ['hostile unknown string', () => hostile],
  ['unknown Error with stack', () => new Error(hostile)],
  ['throwing toString', () => ({ message: { toString() { throw new Error(hostile); } }, toString() { throw new Error(hostile); } })],
  ['non-string error', () => 42],
  ['non-string message', () => ({ message: 42, stack: hostile })],
  ['throwing message getter', () => ({ get message() { throw new Error(hostile); } })],
]) test(`unknown sanitization: ${name}`, async () => {
  const p = await persisted(make(), { stage: hostile, stack: hostile, path: hostile, secret: hostile,
    cliComplete: hostile, seal: { secret: hostile }, correspondence: { witness: { text: hostile }, ledger: [{ text: hostile }] } }, 'unknown_failure');
  const bytes = JSON.stringify(p);
  assert.doesNotMatch(bytes, /unrecognized|hostile|fixture-private|trace|Authorization|Bearer|sk-fixture|private\.invalid|stack|path|secret|toString/);
  assert.equal(p.cli_complete, null); assert.equal(p.witness.preclose, null);
  assert.deepEqual(p.ledger[0], { ordinal: null, acknowledged: null, step_start_received: null, assistant_bound: null, continuation_settled: null });
});
test('unavailable diagnostics are null, not invented negative observations', async () => {
  const p = await persisted(null, {}, 'unknown_failure');
  assert.equal(p.stage, 'unknown'); assert.equal(p.cli_closed_at_ms, null); assert.equal(p.cli_complete, null);
  assert.deepEqual(p.witness, { present: null, preclose: null, created_relative_to_closure_ms: null, received_relative_to_closure_ms: null });
  for (const key of ['ledger_count', 'ledger', 'ledger_truncated', 'snapshot_read_number', 'native_completion_evidence_written']) assert.equal(p[key], null);
  for (const [key, value] of Object.entries(p.seal)) assert.equal(value, key === 'phase' ? 'unknown' : null);
});
test('persisted projection is <=4 KiB, last <=16 ledger records, with explicit truncation', async () => {
  const state = { stage: 'seal', correspondence: { closed_at_ms: 1005, witness: null,
    ledger: Array.from({ length: 200 }, (_, i) => ({ ordinal: i + 1, text: hostile.repeat(100) })) },
  seal: { phase: 'sealed', ordinal: 200, released: 200, model_requests: 200, violations: 0, tool_calls: 200, active_tools: 0, stack: hostile } };
  const p = await persisted(new Error('native_seal_changed'), state, 'native_seal_changed');
  assert.equal(p.ledger_count, 200); assert.equal(p.ledger_truncated, true);
  assert.ok(p.ledger.length <= 16); assert.equal(p.ledger.at(-1).ordinal, 200);
  assert.equal(p.max_bytes, 4096); assert.equal(p.max_ledger_records, 16);
  assert.ok(Buffer.byteLength(JSON.stringify(p) + '\n') <= 4096);
  assert.doesNotMatch(JSON.stringify(p), /hostile|Authorization|secret|stack|fixture-private/);
  const short = bridge.projectFinalizationDiagnostics(null, { correspondence: { ledger: [] } });
  assert.equal(short.ledger_truncated, false);
});
test('first classified failure survives later generic cleanup failure', () => {
  const telemetry = bridge.createProductionDiagnostics({});
  telemetry.finalizationFailure(new Error('native_final_answer_mismatch'), { stage: 'validation' });
  telemetry.finalizationFailure(new Error(hostile), { stage: 'cleanup' });
  assert.equal(telemetry.snapshot().finalization.rejection_code, 'native_final_answer_mismatch');
});

function timestampedData(f) {
  const validated = bridge.validateNativeCompletionSnapshot(f.snapshot, f.options), h = hash('fixture-data');
  const facts = { cli_closed_at: 1005, native_closure_clean: false, final_text_sha256: hash(f.options.finalText),
    captured_assistant_message_ids: [mid(2)] };
  const data = { completion_evidence: { schema: 'real-use-completion-evidence/v1', policy: 'native-platform-v1',
    basis: 'native_corroborated', kind: 'native_timestamped_snapshot', cli_complete: false,
    timestamp_basis: { closed_at_ms: 1005, idle_at_ms: f.snapshot.session.time.idle, witness_present: false },
    witness_sha256: null, post_release_bindings_sha256: h, native_snapshot_sha256: [h, h],
    final_text_sha256: facts.final_text_sha256, native_message_id: mid(2), pricing_sha256: h,
    native_usage_sha256: hash(validated.native_recorded_usage), evidence_path: 'fixture-data-only', evidence_sha256: h },
  native_recorded_usage: validated.native_recorded_usage, tool_evidence: [], upstream_usage_complete: 'unknown', billed_usd: null };
  return { data, facts };
}
for (const idle of [1003, 1005]) test(`timestamped no-witness path accepts idle ${idle} <= C=1005`, async t => {
  const f = fixture(t, { witness: false });
  f.snapshot.session.time.idle = idle; f.snapshot.rows.at(-1).time.created = idle;
  assert.equal(f.c.eligibleAtClosure(false), true);
  nonAuthorizing(await bridge.inspectNativeCompletion(async () => f.snapshot, f.options, 2000));
  const { data, facts } = timestampedData(f);
  nonAuthorizing(data); nonAuthorizing(validateNativeCompletionData(data, facts));
});
test('timestamped snapshot rejects idle > C even if caller offers a later CLI closure', async t => {
  const f = fixture(t, { witness: false });
  f.snapshot.session.time.idle = 1006; f.snapshot.rows.at(-1).time.created = 1006;
  f.options.cli_closed_at = 9000;
  await rejectInspection(f, 'native_session_completion_rejected');
});
for (const sealed of [false, true]) test(`new durable step follows success (${sealed ? 'after seal' : 'before seal'})`, async t => {
  const f = fixture(t, { witness: false, seal: sealed });
  f.c.accept(f.event('session.execution.succeeded', 2, {}, 1003), sealed ? 1010 : 1004);
  const code = sealed ? 'native_activity_after_seal' : 'native_activity_after_success';
  await rejected(() => f.c.accept(f.event('session.step.started', 3,
    { assistantMessageID: mid(4), agent: AGENT, model: MODEL_REF, started: 1004 }, 1004), 1011),
  code, { stage: 'validation', correspondence: f.c.snapshot() });
  assert.throws(() => f.c.check(), { message: code });
});

// Admission throws specific codes, but CURRENT bridge diagnostics do not allowlist
// these two codes. Assert/report that gap rather than pretending attribution passes.
for (const [name, code, mutate] of [
  ['idle > C', 'native_timestamp_basis_mismatch', data => { data.completion_evidence.timestamp_basis.idle_at_ms = 1006; }],
  ['timestamped kind with cli_complete true', 'native_completion_kind_mismatch', (data, facts) => {
    data.completion_evidence.cli_complete = true; data.completion_evidence.basis = 'cli_terminal'; facts.native_closure_clean = true;
  }],
]) test(`admission ${name} -> ${code}; projection gap is unknown_failure`, async t => {
  const f = fixture(t, { witness: false }), { data, facts } = timestampedData(f); mutate(data, facts);
  await rejected(() => validateNativeCompletionData(data, facts), code, { stage: 'validation' }, 'unknown_failure');
  nonAuthorizing(data);
});
