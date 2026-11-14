import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CONDITIONS = Object.freeze(['plugin-on', 'plugin-off']);
export const PROTOCOL = Object.freeze({
  schema: 'real-use-protocol/v1', conditions: CONDITIONS, timeout_ms: 300000,
  concurrency: 1, retries: 0, resume: false, provider_fallback: false,
  ordering: 'seeded shuffled task/repeat pairs; alternating balanced first condition',
  live_model: 'opencode-go/deepseek-v4.1-flash', live_workflows: 10, live_repeats: 1,
  max_episodes: 20, max_cost_usd: 1,
  cost_limit: 'USD 1 soft reported spend; known subtotals stop immediately at cap; unknown billing is not free',
  unknown_cost_policy: 'first-pair-counterpart-only',
  unknown_cost_scope: 'only the first episode may dispatch its frozen adjacent counterpart despite missing cost; no pair 2 with any missing cost',
  isolation: 'authenticated isolation/parity adapter required; unavailable in preparation track',
  checker: 'independent fixed target; authenticated code/policy-bound receipt only',
  prompt_suffix: 'Answer naturally, cite evidence where relevant, distinguish proposed work from actual verification, and do not modify the repository.',
  prompt_assembly: 'public task prompt + two LF characters + prompt_suffix',
});

export const promptFor = task => `${task.prompt}\n\n${PROTOCOL.prompt_suffix}`;
export const promptBindings = tasks => tasks.map(task => ({ task_id: task.id, prompt_sha256: sha256(promptFor(task)) }));

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const PROTOCOL_HASH = sha256(PROTOCOL);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const knownNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label}: unexpected keys`);
  }
}

export function validatePublic(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('public_tasks: nonempty array required');
  const ids = new Set();
  for (const task of tasks) {
    exactKeys(task, ['schema', 'id', 'category', 'family', 'prompt'], 'public_tasks');
    if (task.schema !== 'real-use-task/v1' || !isText(task.id) || !/^[a-zA-Z0-9_-]+$/.test(task.id) ||
        !['category', 'family', 'prompt'].every(key => isText(task[key])) || ids.has(task.id)) {
      throw new Error('public_tasks: invalid or duplicate task');
    }
    ids.add(task.id);
  }
  return tasks;
}

export function validateGold(gold, tasks) {
  validatePublic(tasks);
  if (!Array.isArray(gold) || gold.length !== tasks.length) throw new Error('gold: one record per public task required');
  const remaining = new Set(tasks.map(task => task.id));
  for (const entry of gold) {
    exactKeys(entry, ['schema', 'task_id', 'rubric', 'reference_sources', 'expected_result', 'lean'], 'gold');
    if (entry.schema !== 'real-use-gold/v1' || !remaining.delete(entry.task_id) ||
        entry.rubric == null || !Array.isArray(entry.reference_sources)) throw new Error('gold: invalid record');
    for (const ref of entry.reference_sources) {
      exactKeys(ref, ['path', 'sha256', 'locator', 'quote'], 'reference');
      if (![ref.path, ref.locator, ref.quote].every(isText) || !isHash(ref.sha256)) throw new Error('gold: invalid reference');
    }
    if (entry.lean) {
      exactKeys(entry.lean, ['theorem', 'expected_type', 'imports', 'allowed_axioms', 'positive_control'], 'lean');
      const lean = entry.lean;
      if (![lean.theorem, lean.expected_type, lean.positive_control].every(isText) ||
          !Array.isArray(lean.imports) || !lean.imports.every(isText) ||
          !Array.isArray(lean.allowed_axioms) || !lean.allowed_axioms.every(isText)) throw new Error('gold: invalid Lean policy');
    }
  }
  return gold;
}

export function shuffled(values, seed) {
  const result = [...values];
  let counter = 0;
  for (let i = result.length - 1; i > 0; i--) {
    const j = Number.parseInt(sha256(`${seed}:${counter++}`).slice(0, 12), 16) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function makeSchedule(tasks, { seed, repeats = 1, model, run_id }) {
  validatePublic(tasks);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || !isText(model) || !isText(run_id)) throw new Error('invalid schedule options');
  const pairs = shuffled(tasks.flatMap(task => Array.from({ length: repeats }, (_, i) => ({ task, repeat: i + 1 }))), seed);
  const flip = Number.parseInt(sha256(String(seed)).slice(0, 2), 16) % 2;
  return pairs.flatMap(({ task, repeat }, index) => {
    const pair_id = `${run_id}.${task.id}.r${repeat}.m${sha256(model).slice(0, 16)}`;
    const order = (index + flip) % 2 ? [...CONDITIONS].reverse() : CONDITIONS;
    return order.map(condition => ({
      episode_id: `${pair_id}.${condition}`, pair_id, task_id: task.id,
      category: task.category, family: task.family, repeat, model, condition,
    }));
  });
}

export function environmentFingerprint({ workspace, model }) {
  // Configuration binding, NOT isolation evidence. No host environment values are exported.
  return sha256({ platform: process.platform, arch: process.arch, node: process.version,
    workspace: path.resolve(workspace), model, protocol_hash: PROTOCOL_HASH,
    boundary: 'adapter-unavailable' });
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function makeManifest(tasks, options) {
  validatePublic(tasks);
  const { model, workspace, seed = 'real-use-v1', repeats = 1, max_episodes = PROTOCOL.max_episodes, max_cost_usd = PROTOCOL.max_cost_usd } = options;
  if (!isText(model) || !model.includes('/') || !isText(workspace)) throw new Error('explicit model and workspace required');
  const run_id = options.run_id ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(run_id)) throw new Error('unsafe run_id');
  return freeze({
    schema: 'real-use-manifest/v1', run_id, created_at: options.created_at ?? new Date().toISOString(),
    seed: String(seed), model, repeats, workspace: path.resolve(workspace),
    public_tasks_hash: sha256(tasks), protocol_hash: PROTOCOL_HASH,
    prompts: promptBindings(tasks), assembled_prompts_hash: sha256(promptBindings(tasks)),
    environment_fingerprint: environmentFingerprint({ workspace, model }),
    budgets: { timeout_ms: PROTOCOL.timeout_ms, max_episodes, max_cost_usd, cost_limit_kind: 'soft', unknown_cost_policy: PROTOCOL.unknown_cost_policy },
    protocol: PROTOCOL, tasks: structuredClone(tasks),
    schedule: makeSchedule(tasks, { seed, repeats, model, run_id }),
  });
}

export function assertFreshOutput(out) {
  // lstat also refuses dangling symlinks; never mutate or resume an existing output.
  try { lstatSync(out); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('output_exists: fresh output required; no force or resume');
}

// Closed, preselected profiles. These are data, never execution authority.
export const FRESH_PROFILES = freeze(Object.fromEntries([
  ['g023-compat', 'compat', 'real-use-g023-compat-20261113', 1, 2, 0.10],
  ['g024-workflows', 'workflows', 'real-use-g024-workflows-20261113', 10, 20, 0.90],
].map(([profile_id, role, run_id, tasks, episodes, cost]) => [profile_id, {
  profile_id, role, run_id, study_out: `C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\${run_id}`,
  task_count: tasks, protocol: { ...PROTOCOL, live_workflows: tasks, max_episodes: episodes, max_cost_usd: cost,
    cost_limit: `USD ${cost.toFixed(2)} soft reported spend; no borrowing between profiles; combined USD 1 is not a billing cap`,
    completion_policy: 'native-platform-v1',
    recovery_scope: 'No harness retry/resume/model fallback. Observed native recovery, reused assistant IDs, extra attempts or unresolved correspondence stops eligibility; unobservable native/provider recovery is not asserted prevented.',
    accounting_scope: 'OpenCode-recorded/calculated usage only; upstream completeness unknown; provider billing unreconciled',
    first_pair_checkpoint: 'Owned artifact-bound first-pair checkpoint after settlement and saved cleanup, before any third setup; no answer-correctness gate',
  },
}])));
// Disclosure only: historical profiles, never retries/relabels or executable aliases.
export const RETIRED_PROFILES = freeze(Object.fromEntries([
  ['g005-compat', 'real-use-g005-compat-20261112', 'Stopped safety_failure after one ON attempt (finalization failure; cause not then attributable).'],
  ['g006-workflows', 'real-use-g006-workflows-20261112', 'Never started.'],
  ['g007-compat', 'real-use-g007-compat-20261113', 'Stopped safety_failure after one ON attempt with confirmed native_message_cursor_rejected (pager defect).'],
  ['g008-workflows', 'real-use-g008-workflows-20261113', 'Never started.'],
  ['g009-compat', 'real-use-g009-compat-20261113', 'Stopped safety_failure after one ON attempt with confirmed native_child_scope_rejected (cursor-presence defect).'],
  ['g010-workflows', 'real-use-g010-workflows-20261113', 'Never started.'],
  ['g011-compat', 'real-use-g011-compat-20261113', 'Stopped safety_failure after one ON attempt (observer event rejection, downstream finalization deadline).'],
  ['g012-workflows', 'real-use-g012-workflows-20261113', 'Never started.'],
  ['g013-compat', 'real-use-g013-compat-20261113', 'Stopped safety_failure after one ON attempt (corroboration succeeded, rejected by an admission artifact row-shape assumption now fixed).'],
  ['g014-workflows', 'real-use-g014-workflows-20261113', 'Never started.'],
  ['g015-compat', 'real-use-g015-compat-20261113', 'Stopped safety_failure after one ON attempt (observer event-timestamp hygiene rejection, now bounded).'],
  ['g016-workflows', 'real-use-g016-workflows-20261113', 'Never started.'],
  ['g017-compat', 'real-use-g017-compat-20261113', 'Probe passed both conditions with validated receipts and a passing checkpoint.'],
  ['g018-workflows', 'real-use-g018-workflows-20261113', 'Partial main study: 10/20 delivered, 1 operational failure; stopped because argv transport rejected negative-number prompt fragments.'],
  ['g019-compat', 'real-use-g019-compat-20261113', 'One ON attempt aborted before spawn: launcher rejected the new stdin digest as an unknown option; fixed and re-controlled.'],
  ['g020-workflows', 'real-use-g020-workflows-20261113', 'Never started.'],
  ['g021-compat', 'real-use-g021-compat-20261113', 'Probe passed both conditions over stdin with validated receipts and a passing checkpoint.'],
  ['g022-workflows', 'real-use-g022-workflows-20261113', 'Partial main study over stdin: 4/20 delivered, 1 operational failure; stopped on a recovery/auxiliary event gate.'],
].map(([profile_id, run_id, disposition]) => [profile_id, {
  profile_id, run_id, study_out: `C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\${run_id}`, disposition,
}])));
export function profileForRole(role) {
  const matches = Object.values(FRESH_PROFILES).filter(profile => profile.role === role);
  if (!['compat', 'workflows'].includes(role) || matches.length !== 1) throw new Error('invalid_fresh_profile_role');
  return matches[0];
}
export function profileRole(profile_id) {
  const profile = Object.hasOwn(FRESH_PROFILES, profile_id) && FRESH_PROFILES[profile_id];
  if (!profile) throw new Error('unknown_fresh_profile');
  if (profileForRole(profile.role) !== profile) throw new Error('invalid_fresh_profile_role');
  return profile.role;
}
export const COMPAT_TASK = freeze({ schema: 'real-use-task/v1', id: 'compat-approved-read', category: 'retrieval', family: 'metadata',
  prompt: 'Call approved_list. Then call approved_read with path "preprints/A-Counterexample-to-Kaplanskys-Direct-Finiteness-Conjecture-in-Characteristic-Two-September-23-2026/README.md", offset 5 and limit 1. Report the returned date line and its source path.' });
export function profileManifest(profile_id, original, created_at) {
  const role = profileRole(profile_id), profile = FRESH_PROFILES[profile_id];
  if (typeof created_at !== 'string' || !Number.isFinite(Date.parse(created_at)) ||
      new Date(created_at).toISOString() !== created_at || Date.parse(created_at) < Date.parse('2026-11-12T00:00:00.000Z')) throw new Error('invalid_registration_time');
  if (original?.run_id !== 'real-use-g004-20261112' || original.protocol_hash !== PROTOCOL_HASH ||
      sha256(original.protocol) !== PROTOCOL_HASH || original.seed !== 'real-use-v1' || original.repeats !== 1 ||
      original.model !== PROTOCOL.live_model || sha256(original.tasks) !== 'eb0a0bcc1c8451dba11293c52e97e923640c005d9ef51107984a2bd2ad260d22' ||
      canonical(original.schedule) !== canonical(makeSchedule(original.tasks, original))) throw new Error('historical_manifest_mismatch');
  const tasks = role === 'compat' ? [COMPAT_TASK] : original.tasks;
  const protocol = profile.protocol, protocol_hash = sha256(protocol), workspace = `${profile.study_out}-staging`;
  const options = { run_id: profile.run_id, seed: 'real-use-v1', repeats: 1, model: PROTOCOL.live_model };
  const schedule = makeSchedule(tasks, options);
  const projection = rows => rows.map(({ task_id, condition, model, repeat }) => ({ task_id, condition, model, repeat }));
  if (role === 'workflows' && canonical(projection(schedule)) !== canonical(projection(original.schedule))) throw new Error('historical_order_mismatch');
  return freeze({ schema: 'real-use-manifest/v1', profile_id, ...options, created_at, workspace, effective_variant: 'default',
    public_tasks_hash: sha256(tasks), protocol_hash, protocol, tasks: structuredClone(tasks), schedule,
    prompts: promptBindings(tasks), assembled_prompts_hash: sha256(promptBindings(tasks)),
    environment_fingerprint: sha256({ workspace, model: options.model, protocol_hash, boundary: 'owned-bridge-required' }),
    budgets: { timeout_ms: 300000, max_episodes: protocol.max_episodes, max_cost_usd: protocol.max_cost_usd,
      cost_limit_kind: 'soft', unknown_cost_policy: PROTOCOL.unknown_cost_policy } });
}

export function writeManifest(out, manifest) {
  assertFreshOutput(out);
  mkdirSync(out); // Atomic reservation; parent directory must already exist.
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function validateReadiness(readiness, manifest, now = Date.now()) {
  const fail = reason => { throw new Error(`readiness_blocked: ${reason}`); };
  if (!readiness || readiness.schema !== 'real-use-readiness/v1' || readiness.status !== 'ready') fail('ready attestation required');
  for (const key of ['isolation', 'checker_positive', 'checker_negative', 'tool_parity', 'gold_separation']) {
    if (readiness.checks?.[key] !== true) fail(`${key} must be true`);
  }
  if (manifest.protocol_hash !== PROTOCOL_HASH || manifest.assembled_prompts_hash !== sha256(promptBindings(manifest.tasks)) ||
      sha256(manifest.prompts) !== manifest.assembled_prompts_hash) fail('current protocol/prompt mismatch');
  for (const key of ['protocol_hash', 'public_tasks_hash', 'assembled_prompts_hash', 'environment_fingerprint']) {
    if (readiness[key] !== manifest[key]) fail(`${key} mismatch`);
  }
  const issued = Date.parse(readiness.issued_at);
  const expires = Date.parse(readiness.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now ||
      expires <= issued || now - issued > 3600000 || expires - issued > 3600000) fail('freshness: maximum lifetime/age is one hour');
  return true; // Structural validation only; an authenticated adapter is still mandatory.
}

export function executionGate({ execute, environment = process.env, workspace, max_episodes, max_cost_usd, readiness }, manifest) {
  if (!execute || environment.REAL_USE_ALLOW_EXECUTE !== '1') throw new Error('execution_not_authorized: --execute and REAL_USE_ALLOW_EXECUTE=1 required');
  const normalizedWorkspace = workspace && path.win32.normalize(workspace).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  if (!workspace || normalizedWorkspace === 'c:/_work/__openai_math') {
    throw new Error('workspace_blocked: explicit isolated workspace required, not default host workspace');
  }
  if (!Number.isSafeInteger(max_episodes) || max_episodes <= 0 || !knownNumber(max_cost_usd) || max_cost_usd <= 0) {
    throw new Error('budget_blocked: explicit positive --max-episodes and --max-cost-usd required');
  }
  validateReadiness(readiness, manifest);
  throw new Error('sandbox_adapter_unavailable: readiness JSON is not authenticated isolation/parity evidence; no host credentials, global plugins, or process launch permitted');
}

export function budgetStop(episodes, budgets, { schedule, unknownCostPolicy } = {}) {
  if (episodes.some(episode => episode.safety_failure || episode.model_mismatch || episode.cleanup === 'unconfirmed' ||
      (episode.cleanup && typeof episode.cleanup === 'object' && (episode.cleanup.confirmed !== true ||
        (episode.cleanup.active_processes !== undefined && episode.cleanup.active_processes !== 0) || episode.cleanup.files_removed === false)))) return 'safety_failure';
  if (episodes.length >= Math.min(budgets.max_episodes ?? PROTOCOL.max_episodes, PROTOCOL.max_episodes)) return 'max_episodes';
  const knownSpend = episodes.reduce((sum, episode) => {
    const full = episode.usage?.cost_usd, partial = episode.usage?.known_subtotal?.cost_usd;
    return sum + (knownNumber(full) ? full : knownNumber(partial) ? partial : 0);
  }, 0); // A subtotal for stopping only; missing bills never become a known total.
  if (knownSpend >= Math.min(budgets.max_cost_usd ?? PROTOCOL.max_cost_usd, PROTOCOL.max_cost_usd)) return 'soft_cost_limit';
  if (schedule && (!Array.isArray(schedule) || new Set(schedule.map(item => item.episode_id)).size !== schedule.length ||
      episodes.some((episode, i) => ['episode_id', 'pair_id', 'task_id', 'model', 'repeat', 'condition'].some(key => episode[key] !== schedule[i]?.[key])))) return 'schedule_mismatch';
  if (episodes.some(episode => !knownNumber(episode.usage?.cost_usd))) {
    const [first, counterpart] = schedule ?? [];
    const permitted = unknownCostPolicy === PROTOCOL.unknown_cost_policy && episodes.length === 1 &&
      ['completed', 'failed'].includes(episodes[0].status) && first && counterpart &&
      ['pair_id', 'task_id', 'model', 'repeat'].every(key => first[key] !== undefined && first[key] === counterpart[key]) &&
      first.episode_id !== counterpart.episode_id && CONDITIONS.includes(first.condition) && CONDITIONS.includes(counterpart.condition) && first.condition !== counterpart.condition;
    if (!permitted) return 'unknown_cost';
  }
  return null;
}

export function redactText(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:)\s*.*$/gim, '$1 [REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

export function sanitize(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /(?:secret|password|credential|authorization|cookie|header|api.?key|access.?token|refresh.?token|^token$|^env$|environment)/i.test(key)
      ? '[REDACTED]' : sanitize(child)]));
}

export function usageFromSteps(steps, { complete = false, reasons = ['episode_completion_unestablished'] } = {}) {
  const sum = get => {
    const values = steps.map(get);
    return complete && values.length && values.every(knownNumber) ? values.reduce((a, b) => a + b, 0) : null;
  };
  const subtotal = get => steps.map(get).filter(knownNumber).reduce((a, b) => a + b, 0);
  const usage = {
    input_tokens: sum(step => step.tokens?.input), output_tokens: sum(step => step.tokens?.output),
    cost_usd: sum(step => step.cost), steps: steps.length,
    known_subtotal: { input_tokens: subtotal(step => step.tokens?.input), output_tokens: subtotal(step => step.tokens?.output), cost_usd: subtotal(step => step.cost) },
    coverage: { input_tokens: steps.filter(step => knownNumber(step.tokens?.input)).length,
      output_tokens: steps.filter(step => knownNumber(step.tokens?.output)).length,
      cost_usd: steps.filter(step => knownNumber(step.cost)).length },
  };
  const missing = ['input_tokens', 'output_tokens', 'cost_usd'].filter(key => usage[key] === null);
  usage.completeness = {
    status: complete && !missing.length ? 'observed_episode_total' : steps.length ? 'incomplete' : 'unknown',
    episode_complete: complete,
    reasons: complete ? missing.map(key => `missing_${key}`) : [...new Set(reasons.length ? reasons : ['episode_completion_unestablished'])],
    scope: 'observed stream only; not bill reconciliation',
  };
  return usage;
}

// Each malformed line is reported independently. No log line can discard valid events.
export function parseEventLine(line, lineNumber = 1) {
  if (!line.trim()) return { event: null, failure: null };
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw new Error('not an event');
    return { event: sanitize(value), failure: null };
  } catch {
    return { event: null, failure: { line: lineNumber, reason: 'invalid_event_json', bytes: Buffer.byteLength(line) } };
  }
}

export function textPart(event) {
  if (event.type !== 'text' || (event.role && event.role !== 'assistant') || (event.part?.role && event.part.role !== 'assistant')) return null;
  const part = event.part ?? event;
  return typeof part.text === 'string' ? { text: part.text, message_id: part.messageID ?? event.messageID ?? null } : null;
}

export function parseEvents(stdout) {
  const events = [], failures = [], steps = [], tools = [], providerErrors = [];
  let text = '', message = null;
  for (const [i, line] of String(stdout).split(/\r?\n/).entries()) {
    const parsed = parseEventLine(line, i + 1);
    if (parsed.failure) failures.push(parsed.failure);
    if (!parsed.event) continue;
    const event = parsed.event;
    events.push(event);
    const part = textPart(event);
    if (part) {
      if (part.message_id !== null && message !== null && part.message_id !== message) text = '';
      message = part.message_id ?? message;
      text += part.text;
    }
    if (event.type === 'step_finish') steps.push(event.part ?? event);
    if (event.type === 'tool_use' && typeof event.part?.tool === 'string') tools.push(event.part.tool);
    if (event.type === 'error') providerErrors.push(event.error ?? { message: 'provider_error' });
  }
  return { text, events, extraction_failures: failures, provider_errors: providerErrors, tools, usage: usageFromSteps(steps) };
}

export function parseArgs(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new Error(`unknown/duplicate option: ${key}`);
    if (['--execute', '--dry-run'].includes(key)) result[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing value: ${key}`);
      result[key] = argv[++i];
    }
  }
  return result;
}

export const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
export function loadEpisodes(out, manifest) {
  const directory = path.join(out, 'episodes'), ids = new Set();
  for (const item of manifest.schedule) {
    if (typeof item.episode_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(item.episode_id)) throw new Error('unsafe episode_id');
    if (ids.has(item.episode_id)) throw new Error('duplicate episode_id');
    ids.add(item.episode_id);
  }
  const regular = file => {
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('artifact_error: unsafe episode artifact');
    return true;
  };
  for (const dir of [out, directory]) {
    if (!existsSync(dir)) return [];
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('artifact_error: unsafe episode directory');
  }
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const id = name.endsWith('.start.json') ? name.slice(0, -11) : name.slice(0, -5);
    if (!ids.has(id)) throw new Error('artifact_error: orphan episode artifact');
  }
  return manifest.schedule.flatMap(item => {
    const file = path.join(directory, `${item.episode_id}.json`), startFile = path.join(directory, `${item.episode_id}.start.json`);
    let start = null;
    if (regular(startFile)) {
      try { start = readJSON(startFile); } catch { throw new Error('artifact_error: invalid start JSON'); }
      if (!start || start.episode_id !== item.episode_id || typeof start.started_at !== 'string' || !Number.isFinite(Date.parse(start.started_at))) throw new Error('artifact_error: start binding mismatch');
      for (const key of ['task_id', 'condition', 'model', 'repeat', 'pair_id']) {
        if (Object.hasOwn(start, key) && start[key] !== item[key]) throw new Error(`artifact_error: start ${key} binding mismatch`);
      }
    }
    const incomplete = reason => {
      const usage = usageFromSteps([], { reasons: [reason] });
      return [{ ...item, status: reason === 'terminal_missing' ? 'started' : 'incomplete', started_at: start.started_at,
        operational_classification: 'artifact_failure', artifact_failure: reason, usage, usage_completeness: usage.completeness,
        cleanup: { confirmed: false, error: 'terminal_evidence_unavailable' }, safety_failure: true }];
    };
    if (!regular(file)) return start ? incomplete('terminal_missing') : [];
    const source = readFileSync(file, 'utf8');
    let episode;
    try { episode = JSON.parse(source); }
    catch (error) {
      // Recover only empty/truncated JSON with independently valid matching start
      // evidence. Never alter the corrupt file or infer an answer/usage from it.
      const truncated = !source.trim() || /unexpected end|unterminated string/i.test(error.message) ||
        (error instanceof SyntaxError && error.message.includes(`position ${source.length} `));
      if (!start || !truncated) throw new Error('artifact_error: invalid terminal JSON without recoverable matching start');
      return incomplete('terminal_json_truncated');
    }
    if (!episode || typeof episode !== 'object' || Array.isArray(episode) || episode.episode_id !== item.episode_id) throw new Error('artifact_error: episode binding mismatch');
    for (const key of ['task_id', 'condition', 'model', 'repeat', 'pair_id']) {
      if (episode[key] !== item[key]) throw new Error(`episode ${key} binding mismatch`);
    }
    return [episode];
  });
}
