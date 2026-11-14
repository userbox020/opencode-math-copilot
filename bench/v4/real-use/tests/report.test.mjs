import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_PROFILES, loadEpisodes, profileForRole, profileManifest, RETIRED_PROFILES, sha256 } from '../lib.mjs';
import { unblindReviews } from '../grade.mjs';
import { loadFreshReportInputs, report } from '../report.mjs';

const TEMP = 'C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode';
const oldRoot = path.join(TEMP, 'real-use-study-g004-20261112');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const baseline = json(path.join(TEMP, 'real-use-prereg-g004.json')).manifest;
const compatProfile = profileForRole('compat'), workflowsProfile = profileForRole('workflows');
const manifest = (profile_id = workflowsProfile.profile_id) => ({
  ...profileManifest(profile_id, baseline, '2026-11-12T23:00:00.000Z'), profile_id,
});
// Pure reporting data fixtures; no production handles, receipts or provider calls.
const episode = (item, overrides = {}) => ({ ...item, status: 'completed', started_at: '2026-11-12T23:01:00.000Z',
  operational_classification: 'completed_answer', safety_failure: false, model_mismatch: false,
  cleanup: { confirmed: true, active_processes: 0, files_removed: true },
  finalization: { status: 'validated_owned_receipt' }, identity_validation: { status: 'validated', model: item.model, variant: 'default' },
  guard: { status: 'passed' }, ...overrides });
const review = (item, overrides = {}) => ({ schema: 'real-use-review/v1', blind_id: item.episode_id, episode_id: item.episode_id,
  correctness: 'pass', evidence: 'adequate', reviewer_kind: 'model', reviewer_identity: 'named-report-test-model',
  notes: 'Pure fixture; no actual adjudication.', ...overrides });
const usage = (values = {}) => ({ input_tokens: 10, output_tokens: 5, cost_usd: 0.01,
  completeness: { episode_complete: true, status: 'observed_episode_total', scope: 'observed stream only; not bill reconciliation', reasons: [] }, ...values });
const copy = (value, change) => { const clone = structuredClone(value); change(clone); return clone; };

test('legacy saved g004 report recomputes byte-for-byte without rewriting artifacts', () => {
  const m = json(path.join(oldRoot, 'manifest.json')), episodes = loadEpisodes(oldRoot, m);
  const records = json(path.join(oldRoot, 'evaluation/blind.json'));
  const reviews = unblindReviews(json(path.join(oldRoot, 'evaluation/reviews.json')), records,
    json(path.join(oldRoot, 'evaluation/private/unblind.json')));
  const result = report(m, episodes, reviews, records);
  const saved = readFileSync(path.join(oldRoot, 'evaluation/report.json'), 'utf8');
  assert.equal(JSON.stringify(result, null, 2) + '\n', saved);
  assert.equal(result.schema, 'real-use-report/v1');
  assert.equal(result.overall.operational_failures, 1);
  assert.equal(result.overall.missingness.not_started, 18);
});
test('historical implementation body remains identical to archived source', () => {
  const archived = readFileSync(path.join(TEMP, 'real-use-g004-report-source-y0a1yE/report.mjs'), 'utf8');
  assert.equal(sha256(archived), 'f2429f159f5d46e37bd6805ae312dac60caa279f7ae832f7148ae21901dd9b6b');
  const current = readFileSync(new URL('../report.mjs', import.meta.url), 'utf8');
  assert.equal(current.slice(current.indexOf('  validateReviews('), current.indexOf('\nconst same =')),
    archived.slice(archived.indexOf('  validateReviews('), archived.indexOf('\nexport function main(')));
});
test('fresh reporting requires an explicit valid profile, never a run prefix', () => {
  const m = manifest();
  assert.equal(report(m, []).schema, 'real-use-report/v2');
  const { profile_id, ...withoutProfile } = m;
  assert.equal(report(withoutProfile, []).schema, 'real-use-report/v1');
  for (const change of [m => { m.profile_id = 'g008-other'; }, m => { m.run_id = baseline.run_id; },
    m => { m.model = 'other/model'; }, m => { m.effective_variant = 'fast'; }, m => m.schedule.reverse(),
    m => { m.tasks[0].prompt += '!'; m.public_tasks_hash = sha256(m.tasks); }, m => { m.budgets.max_cost_usd = 1; }]) {
    assert.throws(() => report(copy(m, change), []), /fresh report/);
  }
});
test('executable profiles contain exactly the derived compat and workflows pair', () => {
  assert.equal(Object.keys(FRESH_PROFILES).length, 2);
  assert.ok(Object.hasOwn(FRESH_PROFILES, compatProfile.profile_id));
  assert.ok(Object.hasOwn(FRESH_PROFILES, workflowsProfile.profile_id));
});
test('fresh reporting rejects every retired profile rather than reporting them as executable roles', () => {
  for (const id of Object.keys(RETIRED_PROFILES)) {
    const m = { ...manifest(), profile_id: id, run_id: RETIRED_PROFILES[id].run_id };
    assert.throws(() => report(m, []), /invalid fresh report profile/);
    assert.throws(() => loadFreshReportInputs('unused-report-path', m), /invalid fresh report profile/);
  }
});
test('profile role cannot be selected by run-id prefix or extra manifest fields', () => {
  for (const role of ['compat', 'workflows']) {
    const profile = profileForRole(role), other = profileForRole(role === 'compat' ? 'workflows' : 'compat');
    const m = manifest(profile.profile_id), expected = report(m, []);
    assert.equal(expected.role, profile.role);
    assert.deepEqual(report({ ...m, role: other.role, profile_role: other.role }, []), expected);
    assert.throws(() => report({ ...m, run_id: other.run_id }, []), /invalid fresh report profile/);
    assert.throws(() => report({ ...m, run_id: `${other.run_id}-spoofed` }, []), /invalid fresh report profile/);
    const { profile_id, ...withoutProfile } = m;
    assert.equal(report({ ...withoutProfile, role, profile_role: role }, []).schema, 'real-use-report/v1');
  }
});
test('delivery retains failed, unfinished and not-started denominators', () => {
  const m = manifest(), episodes = [episode(m.schedule[0]), episode(m.schedule[1], { status: 'failed' }),
    episode(m.schedule[2], { status: 'started', finalization: null })];
  const result = report(m, episodes, [review(m.schedule[0])]);
  const delivery = result.overall.delivery;
  assert.equal(delivery.scheduled, 20);
  assert.equal(delivery.attempted, 3);
  assert.equal(delivery.started, 3);
  assert.equal(delivery.completed, 1);
  assert.equal(delivery.operational_failures, 2);
  assert.equal(delivery.not_started, 17);
  assert.equal(delivery.started_without_terminal, 1);
  assert.deepEqual(delivery.end_to_end_delivery_rate, { numerator: 1, denominator: 20, value: 0.05 });
  assert.deepEqual(delivery.attempted_delivery_rate, { numerator: 1, denominator: 3, value: 1 / 3 });
  assert.equal(result.overall.correctness.pass, 1);
  assert.equal(result.overall.correctness.fail, 0);
  assert.equal(result.overall.paired_correctness.scoreable_pairs, 0);
  assert.equal(result.overall.paired_correctness.counts.ungraded, 10);
  assert.equal(result.overall.missingness.incomplete_pairs, 9);
});
test('answer/review correctness cannot turn a wrong operational state into delivery or pass', () => {
  const m = manifest(), item = m.schedule[0];
  for (const overrides of [{ status: 'failed', final_text: 'Correct answer' }, { safety_failure: true },
    { model_mismatch: true }, { operational_classification: 'finalization_failure' }, { finalization: { status: 'unconfirmed' } },
    { cleanup: { confirmed: false } }, { cleanup: { confirmed: true, active_processes: 1 } },
    { guard: { status: 'failed' } }, { identity_validation: { status: 'validated', model: 'wrong/model', variant: 'default' } }]) {
    const result = report(m, [episode(item, overrides)], [review(item)]).overall;
    assert.equal(result.delivery.completed, 0);
    assert.equal(result.delivery.operational_failures, 1);
    assert.equal(result.correctness.pass, 0);
    assert.equal(result.correctness.ineligible_reviews, 1);
    assert.equal(result.correctness.pass_rate.value, null);
  }
});
test('correctness separates missing, unscorable, pass and fail; only scoreable pairs count', () => {
  const m = manifest(), episodes = m.schedule.slice(0, 4).map(item => episode(item));
  const reviews = [review(episodes[0]), review(episodes[1], { correctness: 'fail', reviewer_kind: 'human' }),
    review(episodes[2], { correctness: 'unscorable' })];
  const result = report(m, episodes, reviews).overall;
  assert.deepEqual(result.correctness, { eligible: 4, completed: 4, reviewed: 3, pass: 1, fail: 1, unscorable: 1,
    missing_review: 1, ineligible_reviews: 0, scored_denominator: 2, pass_rate: { numerator: 1, denominator: 2, value: 0.5 },
    reviewer_kinds: { human: 1, model: 2 } });
  assert.equal(result.paired_correctness.scoreable_pairs, 1);
  assert.equal(result.paired_correctness.counts.ungraded, 9);
  assert.equal(result.paired_correctness.counts['ON-only'] + result.paired_correctness.counts['OFF-only'], 1);
});
test('condition summaries keep delivery denominators without inventing one-sided incomplete pairs', () => {
  const m = manifest(), episodes = m.schedule.slice(0, 2).map(item => episode(item));
  const result = report(m, episodes);
  for (const condition of ['plugin-on', 'plugin-off']) {
    const summary = result.conditions[condition];
    assert.equal(summary.delivery.scheduled, 10);
    assert.equal(summary.delivery.attempted, 1);
    assert.equal(summary.delivery.completed, 1);
    assert.equal(Object.hasOwn(summary, 'paired_correctness'), false);
    assert.equal(Object.hasOwn(summary, 'missingness'), false);
  }
  const noStart = report(m, [episode(m.schedule[0], { status: 'failed', started_at: undefined })]).overall.delivery;
  assert.equal(noStart.attempted, 1);
  assert.equal(noStart.started, 0);
  assert.equal(noStart.attempted_without_recorded_start, 1);
  assert.equal(noStart.not_started, 19);
});
test('formal review without accepted bound checker stays unscorable under unchanged rules', () => {
  const m = manifest(), item = m.schedule.find(item => ['formal', 'lean'].includes(item.category));
  assert.ok(item);
  const input = episode(item), decision = review(item);
  assert.equal(report(m, [input], [decision]).overall.correctness.unscorable, 1);
  const binding = { code_sha256: 'a'.repeat(64), policy_sha256: 'b'.repeat(64) };
  const record = { blind_id: decision.blind_id, task: m.tasks.find(task => task.id === item.task_id), checker_required: true,
    checker_binding: binding, checker: { status: 'accepted', ...binding } };
  assert.equal(report(m, [input], [decision], [record]).overall.correctness.pass, 1);
  for (const change of [r => { r.checker.status = 'grader_unavailable'; }, r => { r.checker.status = 'rejected'; },
    r => { r.checker.code_sha256 = 'c'.repeat(64); }]) {
    const result = report(m, [input], [decision], [copy(record, change)]).overall.correctness;
    assert.equal(result.pass, 0);
    assert.equal(result.unscorable, 1);
    assert.equal(result.scored_denominator, 0);
  }
});
test('usage totals require complete finite observations from every attempted episode', () => {
  const m = manifest(), episodes = [episode(m.schedule[0], { usage: usage() }),
    episode(m.schedule[1], { status: 'failed', usage: usage({ cost_usd: null, known_subtotal: { cost_usd: 0.004 },
      completeness: { episode_complete: false, status: 'incomplete' } }) })];
  const result = report(m, episodes).overall.usage;
  assert.equal(result.metrics.cost_usd.total, null);
  assert.equal(result.metrics.cost_usd.known_subtotal, 0.014);
  assert.equal(result.metrics.cost_usd.complete_episodes, 1);
  assert.equal(result.metrics.cost_usd.unknown_or_partial_episodes, 1);
  assert.equal(result.metrics.input_tokens.total, null, 'a plausible number alone is not completion evidence');
  assert.equal(result.metrics.input_tokens.known_subtotal, 20);
  assert.equal(result.provider_usage_complete, 'unknown');
  assert.equal(result.provider_billed_usd, null);
});
test('reported zero differs from absence; no observation is not a zero subtotal', () => {
  const m = manifest();
  const zero = report(m, [episode(m.schedule[0], { usage: usage({ cost_usd: 0, source: 'OpenCode configured-rate cost' }) })]).overall.usage;
  assert.equal(zero.metrics.cost_usd.total, 0);
  assert.equal(zero.metrics.cost_usd.known_subtotal, 0);
  assert.equal(zero.accounting_provenance[0].source, 'OpenCode configured-rate cost');
  const absent = report(m, [episode(m.schedule[0])]).overall.usage.metrics.cost_usd;
  assert.equal(absent.total, null);
  assert.equal(absent.known_subtotal, null);
  assert.equal(absent.observed_value_episodes, 0);
  const empty = report(m, []).overall;
  assert.equal(empty.usage.metrics.cost_usd.total, null);
  assert.equal(empty.usage.metrics.cost_usd.known_subtotal, null);
  assert.equal(empty.delivery.attempted_delivery_rate.value, null);
});
test('full finite totals remain recorded totals, including completely observed failed attempts', () => {
  const m = manifest(), episodes = m.schedule.slice(0, 2).map((item, index) => episode(item, {
    status: index ? 'failed' : 'completed', usage: usage({ cost_usd: index ? 0.02 : 0.01 }) }));
  const result = report(m, episodes).overall;
  assert.equal(result.usage.metrics.cost_usd.total, 0.03);
  assert.equal(result.usage.metrics.input_tokens.total, 20);
  assert.equal(result.usage.metrics.output_tokens.total, 10);
  assert.equal(result.usage.metrics.cost_usd.complete_episodes, 2);
  assert.equal(result.usage.provider_billed_usd, null);
  assert.equal(result.delivery.operational_failures, 1);
});
test('NaN, negative, infinity, acceptance text and contradictory completeness never establish totals', () => {
  const m = manifest(), item = m.schedule[0];
  for (const value of [NaN, Infinity, -1, '0']) {
    const metric = report(m, [episode(item, { usage: usage({ cost_usd: value }) })]).overall.usage.metrics.cost_usd;
    assert.equal(metric.total, null);
    assert.equal(metric.known_subtotal, null);
    assert.equal(metric.invalid_value_episodes, 1);
  }
  for (const overrides of [{ usage: { cost_usd: 0, source: 'accepted' } },
    { usage: usage(), usage_completeness: { episode_complete: false } }]) {
    assert.equal(report(m, [episode(item, overrides)]).overall.usage.metrics.cost_usd.total, null);
  }
});
test('cache and reasoning metrics have separate coverage without inferred token or billing sums', () => {
  const m = manifest(), episodes = [episode(m.schedule[0], { usage: usage({ cache_read_tokens: 8, reasoning_tokens: 2 }) }),
    episode(m.schedule[1], { usage: usage({ reasoning_tokens: 0 }) })];
  const metrics = report(m, episodes).overall.usage.metrics;
  assert.equal(metrics.cache_read_tokens.total, null);
  assert.equal(metrics.cache_read_tokens.known_subtotal, 8);
  assert.equal(metrics.cache_read_tokens.complete_episodes, 1);
  assert.equal(metrics.reasoning_tokens.total, 2);
  assert.equal(metrics.input_tokens.total, 20);
  assert.equal(Object.hasOwn(metrics, 'cache_write_tokens'), false);
  assert.equal(Object.hasOwn(metrics, 'total_tokens'), false);
});
test('accounting provenance is bounded and preserves only known source/completeness fields', () => {
  const m = manifest(), value = usage({ source: { kind: 'platform-observed', cost_usd: 'configured-rates', arbitrary: 'not-exported' } });
  value.completeness.extra = 'not-exported';
  const provenance = report(m, [episode(m.schedule[0], { usage: value })]).overall.usage.accounting_provenance[0];
  assert.deepEqual(provenance.source, { kind: 'platform-observed', cost_usd: 'configured-rates' });
  assert.equal(provenance.completeness.episode_complete, true);
  assert.equal(Object.hasOwn(provenance.completeness, 'extra'), false);
  assert.equal(provenance.episode_completeness, null);
});
test('latency includes failed timings, exposes all four stages and never imputes missing zero', () => {
  const m = manifest(), episodes = [episode(m.schedule[0], { timings: { setup_ms: 1, solver_ms: 10, cleanup_ms: 2, end_to_end_ms: 13 } }),
    episode(m.schedule[1], { status: 'failed', timings: { setup_ms: 3, solver_ms: 30, cleanup_ms: 4, end_to_end_ms: 37 } }),
    episode(m.schedule[2], { status: 'started', timings: { solver_ms: -1 }, duration_ms: 999 })];
  const result = report(m, episodes).overall.latency;
  assert.deepEqual(result.all_attempts.solver_ms, { observed_count: 2, missing_count: 1, mean_ms: 20, median_ms: 20, range_ms: { min: 10, max: 30 } });
  assert.equal(result.completed.solver_ms.mean_ms, 10);
  assert.equal(result.operational_failed.solver_ms.mean_ms, 30);
  assert.equal(result.operational_failed.solver_ms.missing_count, 1);
  assert.deepEqual(Object.keys(result.all_attempts), ['setup_ms', 'solver_ms', 'cleanup_ms', 'end_to_end_ms']);
  const absent = report(m, []).overall.latency.all_attempts.end_to_end_ms;
  assert.equal(absent.mean_ms, null);
  assert.equal(absent.median_ms, null);
  assert.equal(absent.range_ms, null);
  assert.equal(absent.observed_count, 0);
  assert.equal(absent.missing_count, 0, 'not-started episodes are not duration samples');
});
test('compatibility probe reports delivery and references, not accuracy 0/2', () => {
  const m = manifest(compatProfile.profile_id), episodes = m.schedule.map(item => episode(item));
  const result = report(m, episodes);
  assert.equal(result.profile_id, compatProfile.profile_id);
  assert.equal(result.role, compatProfile.role);
  assert.equal(result.kind, 'operational_compatibility_probe');
  assert.match(result.interpretation, /not a pipeline gate or mathematical accuracy benchmark/);
  assert.equal(result.overall.correctness.scope, 'operational_probe_not_mathematical_accuracy');
  assert.equal(result.overall.delivery.scheduled, 2);
  assert.equal(result.overall.delivery.completed, 2);
  assert.equal(result.overall.correctness.status, 'not_adjudicated');
  assert.equal(result.overall.correctness.answer_correctness_gates_pipeline, false);
  assert.equal(Object.hasOwn(result.overall.correctness, 'pass_rate'), false);
  assert.equal(Object.hasOwn(result.overall.correctness, 'fail'), false);
  assert.equal(result.overall.paired_correctness, null);
  const optional = report(m, episodes, [review(episodes[0], { correctness: 'fail' })]);
  assert.equal(optional.overall.correctness.optional_reviews_received, 1);
  assert.equal(optional.overall.delivery.completed, 2);
  assert.equal(optional.provenance.checkpoint_status, 'not_evaluated_by_report');
});
test('fresh reports preserve exploratory lineage references without passing a checkpoint', () => {
  const m = manifest(), source_lineage = { changes: [{ source: 'bench/v4/real-use/run.mjs', before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) }],
    verification: { path: 'focused-verification.json', sha256: 'c'.repeat(64) } };
  const checkpoint_references = [{ run_id: profileForRole('compat').run_id, path: 'operational-checkpoint.json', sha256: 'd'.repeat(64) }];
  const result = report(m, [], [], [], { source_lineage, checkpoint_references });
  assert.equal(result.profile_id, workflowsProfile.profile_id);
  assert.equal(result.role, workflowsProfile.role);
  assert.equal(result.kind, 'exploratory_workflows');
  assert.match(result.interpretation, /Exploratory descriptive results, not confirmatory/);
  assert.deepEqual(result.provenance.source_lineage, source_lineage);
  assert.deepEqual(result.provenance.checkpoint_references, checkpoint_references);
  assert.equal(result.provenance.checkpoint_status, 'not_evaluated_by_report');
  assert.equal(result.exposure.classification, 'exploratory_not_confirmatory');
  assert.match(result.exposure.pooling, /No pooling/);
  assert.equal(result.implementation.sha256, sha256(readFileSync(fileURLToPath(new URL('../report.mjs', import.meta.url)))));
  assert.throws(() => report(m, [], [], [], { passed: true }), /invalid report context/);
  for (const retired of Object.values(RETIRED_PROFILES)) {
    assert.throws(() => report(m, [], [], [], { checkpoint_references: [{ ...checkpoint_references[0], run_id: retired.run_id }] }), /checkpoint run mismatch/);
  }
});
test('foreign episodes, category/task mismatches and duplicate IDs cannot contaminate a fresh report', () => {
  const m = manifest(), item = m.schedule[0];
  for (const overrides of [{ episode_id: baseline.schedule[0].episode_id }, { run_id: baseline.run_id },
    { task_id: 'other-task' }, { category: 'other-category' }, { family: 'other-family' }, { model: 'other/model' }]) {
    assert.throws(() => report(m, [episode(item, overrides)]), /episode binding mismatch/);
  }
  assert.throws(() => report(m, [episode(item), episode(item)]), /episode binding mismatch/);
  assert.throws(() => report(m, [episode(item)], [review(item, { reviewer_kind: 'automated' })]), /invalid typed review/);
  assert.throws(() => report(m, [episode(item)], [review(item, { reviewer_identity: '' })]), /invalid typed review/);
});

test('canonical native-platform totals retain incomplete raw CLI accounting separately and never imply upstream billing', () => {
  const m = manifest(), native = usage({ reasoning_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 0,
    completeness: { status: 'platform_recorded_total', episode_complete: true, scope: 'OpenCode-recorded not billing' } });
  const input = episode(m.schedule[0], { usage: native, usage_completeness: native.completeness,
    completion_evidence: { policy: 'native-platform-v1', basis: 'native_corroborated', native_usage_sha256: sha256(native) },
    capture_usage: { cost_usd: null, input_tokens: null, known_subtotal: { cost_usd: 0.004 },
      completeness: { status: 'incomplete', episode_complete: false, reasons: ['terminal_step_finish_missing'] } },
    capture_operational_classification: 'finalization_unconfirmed' });
  const result = report(m, [input]).overall.usage;
  assert.equal(result.metrics.cost_usd.total, 0.01);
  assert.equal(result.metrics.cost_usd.known_subtotal, 0.01, 'never add overlapping raw/native sums');
  assert.equal(result.accounting_provenance[0].capture_usage.metrics.cost_usd, null);
  assert.equal(result.accounting_provenance[0].capture_usage.known_subtotal.cost_usd, 0.004);
  assert.equal(result.accounting_provenance[0].capture_usage.completeness.episode_complete, false);
  assert.equal(result.provider_usage_complete, 'unknown'); assert.equal(result.provider_billed_usd, null);
  const wrong = copy(input, e => { e.completion_evidence.native_usage_sha256 = 'a'.repeat(64); });
  assert.equal(report(m, [wrong]).overall.usage.metrics.cost_usd.total, null);
});

function setupOnlyReportFixture(t) {
  const out = mkdtempSync(path.join(tmpdir(), 'fresh-report-data-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const m = manifest(compatProfile.profile_id), item = m.schedule[0];
  mkdirSync(path.join(out, 'setup')); mkdirSync(path.join(out, 'episodes'));
  const write = (relative, value) => writeFileSync(path.join(out, relative), JSON.stringify(value));
  // Reporting inputs only: this deliberately cannot pass admission or mint any
  // capability, parent approval, native receipt, or operational checkpoint.
  const registration = { schema: 'real-use-fresh-registration/v1', profile_id: m.profile_id, run_id: m.run_id, study_out: out, manifest: m,
    source_version: { fixture_only: true }, source_lineage: { changes: [], verification: { path: 'fixture-report-only.json', sha256: 'a'.repeat(64) } } };
  write('registration.json', registration);
  write('execution-bindings.json', { schema: 'real-use-registered-execution/v1', profile_id: m.profile_id, run_id: m.run_id,
    registration_sha256: sha256(JSON.stringify(registration)), source_version: registration.source_version, source_lineage: registration.source_lineage });
  write('setup/00.start.json', { ...item, started_at: '2026-11-12T23:01:00.000Z', status: 'started' });
  write('setup/00.failure.json', { ...item, failure: 'setup_failed', elapsed_ms: 37 });
  write('setup/00.cleanup.json', { episode_id: item.episode_id, cleanup: { confirmed: true }, end_to_end_ms: 40 });
  return { out, m, item, write };
}

test('fresh report disk adapter accounts for explicit setup-only attempts without inventing solver start or timing', t => {
  const { out, m } = setupOnlyReportFixture(t), input = loadFreshReportInputs(out, m);
  assert.equal(input.episodes.length, 1);
  const result = report(m, input.episodes, [], [], input.context).overall;
  assert.equal(result.delivery.attempted, 1); assert.equal(result.delivery.started, 0);
  assert.equal(result.delivery.not_started, 1); assert.equal(result.delivery.operational_failures, 1);
  assert.equal(result.latency.operational_failed.end_to_end_ms.mean_ms, 40);
  assert.equal(result.latency.operational_failed.solver_ms.mean_ms, null);
  assert.equal(result.usage.metrics.cost_usd.total, null);
});

test('fresh report disk adapter rejects wrong setup identity, orphan setup files and forged provenance binding', t => {
  const { out, m, item, write } = setupOnlyReportFixture(t);
  write('setup/00.failure.json', { ...item, task_id: 'other-task' });
  assert.throws(() => loadFreshReportInputs(out, m), /fresh setup identity mismatch/);
  write('setup/00.failure.json', { ...item, failure: 'setup_failed' });
  write('setup/99.start.json', item);
  assert.throws(() => loadFreshReportInputs(out, m), /unexpected fresh setup artifact/);
  rmSync(path.join(out, 'setup/99.start.json'));
  write('execution-bindings.json', { schema: 'real-use-registered-execution/v1', registration_sha256: 'a'.repeat(64) });
  assert.throws(() => loadFreshReportInputs(out, m), /fresh report registration binding mismatch/);
});
