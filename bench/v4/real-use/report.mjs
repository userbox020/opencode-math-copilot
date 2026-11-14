import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { canonical, COMPAT_TASK, FRESH_PROFILES, knownNumber, loadEpisodes, makeSchedule, parseArgs, profileForRole, profileRole, promptBindings, readJSON, sha256, validatePublic } from './lib.mjs';
import { reviewCorrectness, unblindReviews, validateReviews } from './grade.mjs';

function usageCoverage(episodes, metric) {
  const values = episodes.map(episode => episode.usage?.[metric]);
  return {
    known_subtotal: episodes.reduce((sum, episode) => {
      const full = episode.usage?.[metric], partial = episode.usage?.known_subtotal?.[metric];
      return sum + (knownNumber(full) ? full : knownNumber(partial) ? partial : 0);
    }, 0),
    complete_episodes: values.filter(knownNumber).length,
    unknown_or_partial_episodes: values.filter(value => !knownNumber(value)).length,
    observed_episodes: episodes.length,
    total: values.length && values.every(knownNumber) ? values.reduce((a, b) => a + b, 0) : null,
  };
}

export function report(manifest, episodes, reviews = [], records = [], context = {}) {
  // Explicit opt-in only. The historical implementation below is unchanged.
  if (Object.hasOwn(manifest, 'profile_id')) return freshReport(manifest, episodes, reviews, records, context);
  validateReviews(reviews.map(({ episode_id, ...review }) => review), reviews.map(review => ({ blind_id: review.blind_id })));
  const scheduled = new Map(manifest.schedule.map(item => [item.episode_id, item]));
  const recordsById = new Map(records.map(record => [record.blind_id, record]));
  const byId = new Map(), reviewById = new Map();
  for (const episode of episodes) {
    if (!scheduled.has(episode.episode_id) || byId.has(episode.episode_id)) throw new Error('unknown/duplicate episode');
    byId.set(episode.episode_id, episode);
  }
  for (const review of reviews) {
    if (!byId.has(review.episode_id) || reviewById.has(review.episode_id) || byId.get(review.episode_id).status !== 'completed') throw new Error('unknown/duplicate/noncompleted review');
    if (!['pass', 'fail', 'unscorable'].includes(review.correctness)) throw new Error('invalid correctness');
    const item = scheduled.get(review.episode_id), record = recordsById.get(review.blind_id);
    if (record && record.task?.id !== item.task_id) throw new Error('review task binding mismatch');
    reviewById.set(review.episode_id, { ...review, correctness: reviewCorrectness(review, record, item) });
  }
  function summarize(schedule) {
    const observed = schedule.flatMap(item => byId.has(item.episode_id) ? [byId.get(item.episode_id)] : []);
    const pairs = new Map();
    for (const item of schedule) {
      const pair = pairs.get(item.pair_id) ?? { pair_id: item.pair_id, task_id: item.task_id, repeat: item.repeat, members: {} };
      if (pair.members[item.condition]) throw new Error('duplicate pair condition');
      const episode = byId.get(item.episode_id);
      pair.members[item.condition] = {
        episode_id: item.episode_id, status: episode?.status ?? 'not_started',
        correctness: reviewById.get(item.episode_id)?.correctness ?? null,
      };
      pairs.set(item.pair_id, pair);
    }
    const counts = { 'ON-only': 0, 'OFF-only': 0, both: 0, neither: 0, ungraded: 0 };
    for (const pair of pairs.values()) {
      const on = pair.members['plugin-on'], off = pair.members['plugin-off'];
      const graded = [on, off].every(value => value?.status === 'completed' && ['pass', 'fail'].includes(value.correctness));
      pair.outcome = !graded ? 'ungraded' : on.correctness === 'pass' ? off.correctness === 'pass' ? 'both' : 'ON-only' : off.correctness === 'pass' ? 'OFF-only' : 'neither';
      pair.incomplete = [on, off].some(value => !value || value.status === 'not_started' || value.status === 'started');
      counts[pair.outcome]++;
    }
    return {
      counts, pairs: [...pairs.values()], scheduled_episodes: schedule.length,
      operational_failures: observed.filter(episode => !['completed', 'started'].includes(episode.status)).length,
      missingness: {
        not_started: schedule.length - observed.length,
        started_without_completion: observed.filter(episode => episode.status === 'started').length,
        completed: observed.filter(episode => episode.status === 'completed').length,
        missing_review: observed.filter(episode => episode.status === 'completed' && !reviewById.has(episode.episode_id)).length,
        unscorable: observed.filter(episode => reviewById.get(episode.episode_id)?.correctness === 'unscorable').length,
        incomplete_pairs: [...pairs.values()].filter(pair => pair.incomplete).length,
      },
      review_kinds: Object.fromEntries(['human', 'model'].map(kind => [kind, observed.filter(episode => reviewById.get(episode.episode_id)?.reviewer_kind === kind).length])),
      evidence: Object.fromEntries(['adequate', 'inadequate', 'not_applicable'].map(label => [label, observed.filter(episode => reviewById.get(episode.episode_id)?.evidence === label).length])),
      usage: Object.fromEntries(['input_tokens', 'output_tokens', 'cost_usd'].map(metric => [metric, usageCoverage(observed, metric)])),
    };
  }
  const tracks = [...new Set(manifest.schedule.map(item => item.category))];
  return {
    schema: 'real-use-report/v1', run_id: manifest.run_id,
    interpretation: 'Descriptive paired counts only; not evidence of superiority. Missing/unscorable is not mathematical failure.',
    overall: summarize(manifest.schedule),
    tracks: Object.fromEntries(tracks.map(track => [track, summarize(manifest.schedule.filter(item => item.category === track))])),
  };
}

const same = (a, b) => canonical(a) === canonical(b);
const BASE_METRICS = ['input_tokens', 'output_tokens', 'cost_usd'];
const OPTIONAL_METRICS = ['cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'];
const TIMINGS = ['setup_ms', 'solver_ms', 'cleanup_ms', 'end_to_end_ms'];
function validateFreshManifest(manifest) {
  const profile = Object.hasOwn(FRESH_PROFILES, manifest.profile_id) && FRESH_PROFILES[manifest.profile_id];
  if (!profile || manifest.schema !== 'real-use-manifest/v1' || manifest.run_id !== profile.run_id ||
      manifest.model !== profile.protocol.live_model || manifest.effective_variant !== 'default' ||
      manifest.seed !== 'real-use-v1' || manifest.repeats !== 1) throw new Error('invalid fresh report profile');
  validatePublic(manifest.tasks);
  const tasksHash = profileRole(profile.profile_id) === 'compat' ? sha256([COMPAT_TASK]) : 'eb0a0bcc1c8451dba11293c52e97e923640c005d9ef51107984a2bd2ad260d22';
  if (manifest.tasks.length !== profile.task_count || sha256(manifest.tasks) !== tasksHash || manifest.public_tasks_hash !== tasksHash ||
      !same(manifest.protocol, profile.protocol) || manifest.protocol_hash !== sha256(profile.protocol) ||
      !same(manifest.prompts, promptBindings(manifest.tasks)) || manifest.assembled_prompts_hash !== sha256(manifest.prompts) ||
      !same(manifest.schedule, makeSchedule(manifest.tasks, manifest)) ||
      !same(manifest.budgets, { timeout_ms: 300000, max_episodes: profile.protocol.max_episodes,
        max_cost_usd: profile.protocol.max_cost_usd, cost_limit_kind: 'soft', unknown_cost_policy: profile.protocol.unknown_cost_policy })) {
    throw new Error('fresh report manifest binding mismatch');
  }
  return profile;
}
// Existing capture/finalization fields only. This projection reports recorded
// evidence; it neither authenticates receipts nor replaces admission/checkpoints.
function delivered(episode) {
  return episode.status === 'completed' && episode.operational_classification === 'completed_answer' &&
    episode.safety_failure !== true && episode.model_mismatch !== true && episode.cleanup?.confirmed === true &&
    (episode.cleanup.active_processes === undefined || episode.cleanup.active_processes === 0) &&
    episode.cleanup.files_removed !== false && episode.finalization?.status === 'validated_owned_receipt' &&
    episode.identity_validation?.status === 'validated' && episode.identity_validation.model === episode.model &&
    episode.identity_validation.variant === 'default' && episode.guard?.status === 'passed';
}
const rate = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const safeSum = values => { const total = values.reduce((sum, value) => sum + value, 0); return values.length && knownNumber(total) ? total : null; };
function recordedUsage(episodes, metric) {
  const observations = episodes.map(episode => {
    const usage = episode.usage, value = usage?.[metric], partial = usage?.known_subtotal?.[metric];
    const metadata = [usage?.completeness, episode.usage_completeness].filter(value => value !== undefined && value !== null);
    const nativeBound = usage?.completeness?.status !== 'platform_recorded_total' ||
      (episode.finalization?.status === 'validated_owned_receipt' && episode.completion_evidence?.policy === 'native-platform-v1' &&
        episode.completion_evidence.native_usage_sha256 === sha256(usage));
    const complete = nativeBound && metadata.length > 0 && metadata.every(value => value.episode_complete === true) && knownNumber(value);
    return { complete, value, subtotal: knownNumber(value) ? value : knownNumber(partial) ? partial : null };
  });
  const complete = observations.filter(value => value.complete);
  return { total: complete.length === episodes.length ? safeSum(complete.map(value => value.value)) : null,
    known_subtotal: safeSum(observations.map(value => value.subtotal).filter(knownNumber)),
    attempted_episodes: episodes.length, complete_episodes: complete.length,
    unknown_or_partial_episodes: episodes.length - complete.length,
    observed_value_episodes: observations.filter(value => knownNumber(value.value)).length,
    subtotal_covered_episodes: observations.filter(value => knownNumber(value.subtotal)).length,
    invalid_value_episodes: observations.filter(value => value.value !== undefined && value.value !== null && !knownNumber(value.value)).length };
}
function timingSummary(episodes, metric) {
  const values = episodes.map(episode => episode.timings?.[metric]).filter(knownNumber).sort((a, b) => a - b);
  const n = values.length, middle = Math.floor(n / 2);
  return { observed_count: n, missing_count: episodes.length - n,
    mean_ms: n ? safeSum(values.map(value => value / n)) : null,
    median_ms: n ? n % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2 : null,
    range_ms: n ? { min: values[0], max: values[n - 1] } : null };
}
const text = (value, maximum = 256) => typeof value === 'string' ? value.slice(0, maximum) : null;
function accountingMetadata(episode) {
  const project = value => value && typeof value === 'object' ? {
    status: text(value.status), episode_complete: typeof value.episode_complete === 'boolean' ? value.episode_complete : null,
    scope: text(value.scope, 512), reasons: Array.isArray(value.reasons) ? value.reasons.filter(item => typeof item === 'string').slice(0, 16).map(item => text(item)) : null,
  } : null;
  const source = episode.usage?.source;
  const capture = episode.capture_usage;
  return { episode_id: episode.episode_id, source: typeof source === 'string' ? text(source) : source && typeof source === 'object' ?
    Object.fromEntries(['kind', 'name', 'scope', ...BASE_METRICS, ...OPTIONAL_METRICS].filter(key => typeof source[key] === 'string').map(key => [key, text(source[key])])) : null,
  completeness: project(episode.usage?.completeness), episode_completeness: project(episode.usage_completeness),
  completion_basis: text(episode.completion_basis ?? episode.completion_evidence?.basis),
  capture_usage: capture && typeof capture === 'object' ? {
    metrics: Object.fromEntries([...BASE_METRICS, ...OPTIONAL_METRICS].filter(key => Object.hasOwn(capture, key)).map(key => [key, knownNumber(capture[key]) ? capture[key] : null])),
    known_subtotal: Object.fromEntries([...BASE_METRICS, ...OPTIONAL_METRICS].filter(key => Object.hasOwn(capture.known_subtotal ?? {}, key))
      .map(key => [key, knownNumber(capture.known_subtotal[key]) ? capture.known_subtotal[key] : null])),
    coverage: Object.fromEntries([...BASE_METRICS, ...OPTIONAL_METRICS].filter(key => Object.hasOwn(capture.coverage ?? {}, key))
      .map(key => [key, Number.isSafeInteger(capture.coverage[key]) && capture.coverage[key] >= 0 ? capture.coverage[key] : null])),
    steps: Number.isSafeInteger(capture.steps) && capture.steps >= 0 ? capture.steps : null,
    completeness: project(capture.completeness), source: text(capture.source),
  } : null, capture_classification: text(episode.capture_operational_classification ?? episode.capture_classification),
  upstream_usage_complete: 'unknown', billed_usd: null };
}
function reportReferences(context, profile) {
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.keys(context).some(key => !['source_lineage', 'checkpoint_references'].includes(key))) throw new Error('invalid report context');
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const reference = value => {
    if (!value || typeof value.path !== 'string' || !value.path.length || value.path.length > 2048 || !hash(value.sha256)) throw new Error('invalid report reference');
    return { path: value.path, sha256: value.sha256 };
  };
  let source_lineage = null;
  if (context.source_lineage !== undefined) {
    const value = context.source_lineage;
    if (!value || !Array.isArray(value.changes) || value.changes.length > 8) throw new Error('invalid report lineage');
    source_lineage = { changes: value.changes.map(change => {
      if (!change || typeof change.source !== 'string' || change.source.length > 256 || !hash(change.before_sha256) || !hash(change.after_sha256)) throw new Error('invalid report lineage');
      return { source: change.source, before_sha256: change.before_sha256, after_sha256: change.after_sha256 };
    }), verification: reference(value.verification) };
  }
  const refs = context.checkpoint_references ?? [];
  if (!Array.isArray(refs) || refs.length > 8) throw new Error('invalid checkpoint references');
  return { source_lineage, source_lineage_status: source_lineage ? 'reported_reference_only' : 'not_supplied',
    checkpoint_references: refs.map(ref => {
      if (![profile.run_id, profileForRole('compat').run_id].includes(ref?.run_id)) throw new Error('checkpoint run mismatch');
      return { run_id: ref.run_id, ...reference(ref) };
    }), checkpoint_status: 'not_evaluated_by_report' };
}

// Optional fifth argument: data-only source_lineage and checkpoint_references.
// No file named by these references is opened or treated as a passed checkpoint.
function freshReport(manifest, episodes, reviews, records, context) {
  const profile = validateFreshManifest(manifest), role = profileRole(profile.profile_id), probe = role === 'compat';
  const scheduled = new Map(manifest.schedule.map(item => [item.episode_id, item]));
  const byId = new Map(), byReview = new Map(), byRecord = new Map();
  for (const episode of episodes) {
    const item = scheduled.get(episode.episode_id);
    if (!item || byId.has(episode.episode_id) || !Object.keys(item).every(key => episode[key] === item[key]) ||
        ('run_id' in episode && episode.run_id !== manifest.run_id) || !['started', 'completed', 'failed', 'incomplete'].includes(episode.status)) {
      throw new Error('fresh report episode binding mismatch');
    }
    byId.set(episode.episode_id, episode);
  }
  for (const record of records) {
    if (!record?.blind_id || byRecord.has(record.blind_id)) throw new Error('duplicate/invalid blind record');
    byRecord.set(record.blind_id, record);
  }
  validateReviews(reviews.map(({ episode_id, ...review }) => review), reviews.map(review => ({ blind_id: review.blind_id })));
  for (const review of reviews) {
    if (!byId.has(review.episode_id) || byReview.has(review.episode_id)) throw new Error('unknown/duplicate review');
    const item = scheduled.get(review.episode_id), record = byRecord.get(review.blind_id);
    if (record && (record.task?.id !== item.task_id || record.task?.category !== item.category || record.task?.family !== item.family)) throw new Error('review task binding mismatch');
    byReview.set(review.episode_id, { ...review, correctness: reviewCorrectness(review, record, item) });
  }
  function summarize(schedule, includePairs = true) {
    const observed = schedule.flatMap(item => byId.has(item.episode_id) ? [byId.get(item.episode_id)] : []);
    const completed = observed.filter(delivered), failed = observed.filter(episode => !delivered(episode));
    const started = observed.filter(episode => episode.status === 'started' || (typeof episode.started_at === 'string' && Number.isFinite(Date.parse(episode.started_at)))).length;
    const reviewed = completed.filter(episode => byReview.has(episode.episode_id));
    const count = label => reviewed.filter(episode => byReview.get(episode.episode_id).correctness === label).length;
    const pass = count('pass'), fail = count('fail'), pairs = new Map();
    for (const item of schedule) {
      const pair = pairs.get(item.pair_id) ?? { pair_id: item.pair_id, task_id: item.task_id, members: {} };
      const episode = byId.get(item.episode_id), eligible = episode ? delivered(episode) : false;
      pair.members[item.condition] = { episode_id: item.episode_id, status: episode?.status ?? 'not_started', delivered: eligible,
        correctness: !probe && eligible ? byReview.get(item.episode_id)?.correctness ?? null : null };
      pairs.set(item.pair_id, pair);
    }
    const counts = { 'ON-only': 0, 'OFF-only': 0, both: 0, neither: 0, ungraded: 0 };
    for (const pair of pairs.values()) {
      const on = pair.members['plugin-on'], off = pair.members['plugin-off'];
      const scoreable = !probe && [on, off].every(member => member?.delivered && ['pass', 'fail'].includes(member.correctness));
      pair.outcome = !scoreable ? 'ungraded' : on.correctness === 'pass' ? off.correctness === 'pass' ? 'both' : 'ON-only' : off.correctness === 'pass' ? 'OFF-only' : 'neither';
      pair.incomplete = [on, off].some(member => !member || ['not_started', 'started', 'incomplete'].includes(member.status));
      counts[pair.outcome]++;
    }
    const metrics = [...BASE_METRICS, ...OPTIONAL_METRICS.filter(metric => observed.some(episode =>
      Object.hasOwn(episode.usage ?? {}, metric) || Object.hasOwn(episode.usage?.known_subtotal ?? {}, metric)))];
    return {
      delivery: { scheduled: schedule.length, attempted: observed.length,
        started, attempted_without_recorded_start: observed.length - started,
        completed: completed.length, operational_failures: failed.length, not_started: schedule.length - observed.length,
        recorded_status_completed: observed.filter(episode => episode.status === 'completed').length,
        started_without_terminal: observed.filter(episode => episode.status === 'started').length,
        end_to_end_delivery_rate: rate(completed.length, schedule.length), attempted_delivery_rate: rate(completed.length, observed.length) },
      correctness: probe ? { status: 'not_adjudicated', scope: 'operational_probe_not_mathematical_accuracy',
        optional_reviews_received: observed.filter(episode => byReview.has(episode.episode_id)).length, answer_correctness_gates_pipeline: false } : {
        eligible: completed.length, completed: completed.length, reviewed: reviewed.length, pass, fail,
        unscorable: count('unscorable'), missing_review: completed.length - reviewed.length,
        ineligible_reviews: failed.filter(episode => byReview.has(episode.episode_id)).length,
        scored_denominator: pass + fail, pass_rate: rate(pass, pass + fail),
        reviewer_kinds: Object.fromEntries(['human', 'model'].map(kind => [kind, reviewed.filter(episode => byReview.get(episode.episode_id).reviewer_kind === kind).length])) },
      ...(includePairs ? { paired_correctness: probe ? null : { counts, scoreable_pairs: pairs.size - counts.ungraded },
        pairs: [...pairs.values()], missingness: { ungraded_pairs: counts.ungraded, incomplete_pairs: [...pairs.values()].filter(pair => pair.incomplete).length } } : {}),
      usage: { scope: 'OpenCode/native-recorded observations; configured-rate CLI cost is not a provider bill',
        provider_usage_complete: 'unknown', provider_billed_usd: null,
        metrics: Object.fromEntries(metrics.map(metric => [metric, recordedUsage(observed, metric)])),
        accounting_provenance: observed.map(accountingMetadata), token_scope: 'Separate recorded metrics; no inferred billable-token sum or upstream field presence' },
      latency: { unit: 'ms', scope: 'Conditional on observed timings; missing is not zero; no performance or savings inference',
        ...Object.fromEntries([['all_attempts', observed], ['completed', completed], ['operational_failed', failed]].map(([group, values]) =>
          [group, Object.fromEntries(TIMINGS.map(metric => [metric, timingSummary(values, metric)]))])) },
    };
  }
  return { schema: 'real-use-report/v2', profile_id: profile.profile_id, role, run_id: manifest.run_id,
    implementation: { version: 'closed-profile-report/v1', source: 'bench/v4/real-use/report.mjs', sha256: sha256(readFileSync(fileURLToPath(import.meta.url))) },
    kind: probe ? 'operational_compatibility_probe' : 'exploratory_workflows',
    recovery_scope: manifest.protocol.recovery_scope,
    interpretation: probe ? 'Operational delivery only; answer correctness is not a pipeline gate or mathematical accuracy benchmark.' :
      'Exploratory descriptive results, not confirmatory superiority evidence. Operational failures are not mathematical failures.',
    exposure: { classification: 'exploratory_not_confirmatory', historical_run_id: 'real-use-g004-20261112',
      original_hanner: 'Original Hanner ON/OFF exposure retained; no post-outcome selection',
      compat_source: 'Compatibility-source exposure planned; completion established only by separate checkpoint evidence',
      pooling: 'No pooling of historical, compatibility-probe and main episodes' },
    provenance: reportReferences(context, profile),
    definitions: { attempted: 'One supplied capture/attempt record per scheduled episode; setup-only attempts must be supplied by the controller',
      started: 'Recorded start timestamp or started status; not inferred from missing timings',
      completed: 'Recorded completed-answer delivery with owned-finalization, identity, guard and cleanup evidence; not independently reauthenticated here',
      operational_failures: 'All attempted but not delivered episodes, including unresolved started records at report time',
      not_started: 'Scheduled episodes without an attempt record', review_authenticity: 'Identified reviewer kind as recorded; no inferred human or model authenticity',
      formal: 'Unchanged evaluator-owned code/policy-bound checker rules; model-printed receipts confer no authority' },
    overall: summarize(manifest.schedule),
    tracks: Object.fromEntries([...new Set(manifest.schedule.map(item => item.category))].map(track =>
      [track, summarize(manifest.schedule.filter(item => item.category === track))])),
    conditions: Object.fromEntries(['plugin-on', 'plugin-off'].map(condition =>
      [condition, summarize(manifest.schedule.filter(item => item.condition === condition), false)])),
  };
}

// Fresh-only disk adapter. Setup records establish attempts explicitly; neither
// missing capture files nor absent timing values are silently counted as zero.
export function loadFreshReportInputs(out, manifest) {
  const profile = validateFreshManifest(manifest);
  const regular = (file, optional = false) => {
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      let stat; try { stat = lstatSync(parent); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe fresh report directory');
      if (parent === path.dirname(parent)) break;
    }
    let stat; try { stat = lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('unsafe fresh report artifact');
    return readFileSync(file);
  };
  const registrationRaw = regular(path.join(out, 'registration.json')), registration = JSON.parse(registrationRaw);
  const bindings = JSON.parse(regular(path.join(out, 'execution-bindings.json')));
  if (registration.schema !== 'real-use-fresh-registration/v1' || !same(registration.manifest, manifest) ||
      registration.profile_id !== manifest.profile_id || registration.run_id !== manifest.run_id || registration.study_out !== out ||
      bindings.schema !== 'real-use-registered-execution/v1' || bindings.registration_sha256 !== sha256(registrationRaw) ||
      bindings.profile_id !== manifest.profile_id || bindings.run_id !== manifest.run_id ||
      !same(bindings.source_version, registration.source_version) || !same(bindings.source_lineage, registration.source_lineage)) throw new Error('fresh report registration binding mismatch');
  const captured = loadEpisodes(out, manifest), byId = new Map(captured.map(episode => [episode.episode_id, episode]));
  const allowed = new Set(manifest.schedule.flatMap((_, index) => ['start', 'admitted', 'failure', 'cleanup'].map(kind => `${String(index).padStart(2, '0')}.${kind}.json`)));
  const setupDir = path.join(out, 'setup'), setupStat = lstatSync(setupDir);
  if (!setupStat.isDirectory() || setupStat.isSymbolicLink() || readdirSync(setupDir).some(name => !allowed.has(name))) throw new Error('unexpected fresh setup artifact');
  for (const [index, item] of manifest.schedule.entries()) {
    const prefix = path.join(setupDir, String(index).padStart(2, '0'));
    const data = Object.fromEntries(['start', 'admitted', 'failure', 'cleanup'].map(kind => {
      const raw = regular(`${prefix}.${kind}.json`, true); return [kind, raw ? JSON.parse(raw) : null];
    }));
    if (!data.start) {
      if (data.admitted || data.failure || data.cleanup || byId.has(item.episode_id)) throw new Error('fresh setup start missing');
      continue;
    }
    for (const key of ['start', 'admitted', 'failure']) {
      if (data[key] && !Object.keys(item).every(field => data[key][field] === item[field])) throw new Error('fresh setup identity mismatch');
    }
    if (!Number.isFinite(Date.parse(data.start.started_at)) || (data.cleanup && data.cleanup.episode_id !== item.episode_id)) throw new Error('fresh setup identity mismatch');
    const episode = byId.get(item.episode_id), failed = Boolean(data.failure || !data.cleanup || data.cleanup.cleanup?.confirmed !== true);
    if (episode) byId.set(item.episode_id, { ...episode, safety_failure: episode.safety_failure === true || failed,
      report_setup_failure: failed });
    else byId.set(item.episode_id, { ...item, status: data.failure || data.cleanup ? 'failed' : 'incomplete',
      operational_classification: 'setup_without_capture', safety_failure: true, cleanup: data.cleanup?.cleanup ?? null,
      timings: { ...(knownNumber(data.admitted?.setup_ms) ? { setup_ms: data.admitted.setup_ms } : {}),
        ...(knownNumber(data.cleanup?.end_to_end_ms) ? { end_to_end_ms: data.cleanup.end_to_end_ms } : {}) } });
  }
  const checkpoint_references = [];
  const checkpointFile = path.join(out, 'first-pair-checkpoint.json'), checkpointBytes = regular(checkpointFile, true);
  if (checkpointBytes) {
    const value = JSON.parse(checkpointBytes);
    if (value.schema !== 'real-use-first-pair-checkpoint/v1' || value.run_id !== manifest.run_id || value.profile_id !== manifest.profile_id ||
        value.registration_sha256 !== bindings.registration_sha256) throw new Error('fresh report checkpoint binding mismatch');
    checkpoint_references.push({ run_id: manifest.run_id, path: checkpointFile, sha256: sha256(checkpointBytes) });
  }
  if (profileRole(profile.profile_id) === 'workflows') {
    const expected = profileForRole('compat'), file = path.win32.join(expected.study_out, 'first-pair-checkpoint.json');
    if (registration.prerequisite_probe?.checkpoint_path !== file || !/^[a-f0-9]{64}$/.test(bindings.probe_checkpoint_sha256 ?? '')) throw new Error('fresh report prerequisite binding missing');
    const raw = regular(file), value = JSON.parse(raw);
    if (sha256(raw) !== bindings.probe_checkpoint_sha256 || value.run_id !== expected.run_id || value.profile_id !== expected.profile_id) throw new Error('fresh report prerequisite binding mismatch');
    checkpoint_references.push({ run_id: expected.run_id, path: file, sha256: sha256(raw) });
  }
  return { episodes: manifest.schedule.flatMap(item => byId.has(item.episode_id) ? [byId.get(item.episode_id)] : []),
    context: { source_lineage: registration.source_lineage, checkpoint_references } };
}

export function main(argv) {
  const args = parseArgs(argv, ['--out', '--reviews']);
  if (!args['--out']) throw new Error('--out required');
  const out = path.resolve(args['--out']);
  const manifest = readJSON(path.join(out, 'manifest.json'));
  const fresh = Object.hasOwn(manifest, 'profile_id') ? loadFreshReportInputs(out, manifest) : null;
  const episodes = fresh?.episodes ?? loadEpisodes(out, manifest);
  const records = args['--reviews'] ? readJSON(path.join(out, 'evaluation/blind.json')) : [];
  const reviews = args['--reviews'] ? unblindReviews(
    readJSON(args['--reviews']), records,
    readJSON(path.join(out, 'evaluation/private/unblind.json')),
  ) : [];
  return report(manifest, episodes, reviews, records, fresh?.context);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
