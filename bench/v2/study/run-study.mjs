import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  ROOT, VERSION, COMMON_PROMPT, assert, json, serialize, sha256, loadProfiles,
  expectedEpisodes, readJsonl, indexUnique, episodeKey, parseArgs, publicTask,
} from '../lib.mjs';
import { protocolHash, validateManifest, underBudget, loadStudy } from '../run.mjs';
import { prepareEpisode, executeEpisode, assertPreparedWorkspace } from '../adapters/opencode.mjs';
import { auditInventory } from '../adapters/inventory-audit.mjs';
import { gradeFinal } from '../graders/index.mjs';
import formal from '../graders/formal.mjs';
import { verifyLeanSubmission, normalizeLeanSolution, leanTargetHash } from '../verifiers/lean.mjs';
import { analyzeStudy } from '../analyze.mjs';

const REPO = path.resolve(ROOT, '../..');
const TYPES = new Set(['numeric', 'symbolic', 'citation', 'formal', 'explanation', 'absence']);
const EXECUTE_ENV = 'MATH_BENCH_ALLOW_EXECUTE';

function number(value, name, fallback, { min = 0, integer = false } = {}) {
  const resolved = value === undefined ? fallback : Number(value);
  assert(Number.isFinite(resolved) && resolved >= min && (!integer || Number.isInteger(resolved)), `Invalid ${name}`);
  return resolved;
}
function readTasks(file) {
  const value = json(path.resolve(file));
  const tasks = Array.isArray(value) ? value : value.tasks;
  assert(Array.isArray(tasks) && tasks.length > 0, 'Task file must contain a nonempty array');
  const ids = new Set();
  for (const task of tasks) {
    assert(task && typeof task.id === 'string' && /^[\w.-]+$/.test(task.id), 'Invalid task id');
    assert(!ids.has(task.id), `Duplicate task id ${task.id}`); ids.add(task.id);
    assert(TYPES.has(task.type), `Unsupported task type ${task.type}`);
    assert(typeof task.prompt === 'string' && typeof task.answer_contract === 'string', `${task.id}: public prompt/contract required`);
    assert(typeof task.family === 'string' && typeof task.domain === 'string', `${task.id}: family/domain required`);
    assert(typeof task.negative === 'boolean', `${task.id}: negative required`);
    assert(task.grading && typeof task.grading === 'object', `${task.id}: grading required`);
    assert(task.correct_final && typeof task.correct_final === 'object', `${task.id}: correct_final required`);
    assert(typeof task.provisional === 'boolean', `${task.id}: explicit provisional flag required`);
    if (task.type === 'formal') {
      const f = task.formal;
      assert(f && typeof f.theorem === 'string' && typeof f.expected_type === 'string'
        && Array.isArray(f.imports) && Array.isArray(f.allowed_axioms) && typeof f.solution_code === 'string',
      `${task.id}: incomplete formal target`);
    }
  }
  return { tasks, file: path.resolve(file) };
}
function gitHead() {
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
function hashFile(relative) { return sha256(readFileSync(path.join(REPO, relative))); }
function sourceHashes(tasksFile) {
  return {
    tasks: sha256(readFileSync(tasksFile)),
    'graders/index': hashFile('bench/v2/graders/index.mjs'),
    'graders/formal': hashFile('bench/v2/graders/formal.mjs'),
    'graders/absence': hashFile('bench/v2/graders/absence.mjs'),
    verifier: hashFile('bench/v2/verifiers/lean.mjs'),
    adapter: hashFile('bench/v2/adapters/opencode.mjs'),
    inventory_audit: hashFile('bench/v2/adapters/inventory-audit.mjs'),
    protocol: hashFile('research/protocol.md'),
  };
}
export function buildManifest({ tasks, tasksFile, model, profiles = loadProfiles(), repeats = [1], attempts = [1], budgets, seed, resamples, studyId, leanToolchain }) {
  assert(typeof model === 'string' && /^[^\s/]+\/[^\s]+$/.test(model), 'Model must be provider/model');
  const provisional = tasks.some(task => task.provisional === true);
  const manifest = {
    schema_version: VERSION,
    study_id: studyId ?? `real-${model.replace(/[^\w.-]/g, '-')}-${new Date().toISOString().slice(0, 10)}`,
    simulated: false,
    clock: { kind: 'wall-clock', epoch: new Date().toISOString() },
    versions: { harness: VERSION, adapter: 'opencode-adapter-v1', grader: '2.1.0', receipt_schema: '2.1.0', node: process.version },
    commits: { repository: gitHead(), corpus: null },
    hashes: sourceHashes(tasksFile),
    protocol_hash: '0'.repeat(64),
    profiles,
    prompts: { common: COMMON_PROMPT, tasks: Object.fromEntries(tasks.map(task => [task.id, { prompt: task.prompt, answer_contract: task.answer_contract }])) },
    budgets,
    cache_state: { episode: 'cold', shared: 'disabled' },
    environment: {
      platform: process.platform, arch: process.arch, config: 'not-loaded', network: 'provider-only', execution: 'isolated-adapter',
      runtime_inventory: 'unverified', provisional_tasks: provisional, paper_evidence: !provisional, lean_toolchain: leanToolchain,
    },
    models: [model],
    tasks: tasks.map(({ id, family, domain, type, negative }) => ({ id, family, domain, type, negative })),
    repeats, attempts,
    analysis: { primary: 'correct-under-budget/all-started', contrast: 'F-B', seed, resamples, cluster: 'task-family' },
    expected_episode_count: tasks.length * profiles.length * repeats.length * attempts.length,
  };
  manifest.protocol_hash = protocolHash(manifest);
  validateManifest(manifest);
  return manifest;
}
function summaryAudit(audit) {
  return {
    profile: audit.profile, status: audit.status, guarantee: audit.guarantee,
    runtime_verified: audit.runtime_verified === true, observed_tools: audit.observed_tools,
    execution_blocker: audit.execution_blocker ?? null, error: audit.error ?? null, cleanup: audit.cleanup === true,
  };
}
async function preflight({ manifest, tasks, model, deps }) {
  const audits = [];
  for (const profile of manifest.profiles) {
    let plan;
    try {
      plan = deps.prepareEpisode({ task: tasks[0], profile, model });
      audits.push(summaryAudit(await deps.auditInventory(plan, { checkWorkspace: deps.assertPreparedWorkspace })));
    } catch (error) {
      audits.push({ profile: profile.id, status: 'failed', guarantee: null, runtime_verified: false, observed_tools: null, execution_blocker: null, error: error.message, cleanup: false });
    } finally { if (plan) rmSync(plan.workspace, { recursive: true, force: true }); }
  }
  const ready = audits.every(audit => audit.status === 'passed' && audit.runtime_verified === true && audit.guarantee === 'runtime-verified' && audit.cleanup === true);
  return { audits, ready };
}
export async function dryRun({ manifest, tasks, tasksFile, out, model }, deps = {}) {
  const resolved = { prepareEpisode, auditInventory, assertPreparedWorkspace, ...deps };
  const gate = await preflight({ manifest, tasks, model, deps: resolved });
  const plan = {
    schema: 'math-study-plan/v1', dry_run: true, generated_at: new Date().toISOString(),
    study_id: manifest.study_id, model_id: model, task_file: tasksFile, tasks: tasks.length,
    profiles: manifest.profiles.map(profile => profile.id), repeats: manifest.repeats, attempts: manifest.attempts,
    episode_count: manifest.expected_episode_count, budgets: manifest.budgets,
    max_usd_if_every_episode_uses_its_budget: manifest.budgets.usd * manifest.expected_episode_count,
    audits: gate.audits, execution_ready: gate.ready,
    blockers: gate.ready ? [] : gate.audits.filter(audit => !audit.runtime_verified).map(audit => audit.execution_blocker ?? audit.error ?? `runtime audit failed for ${audit.profile}`),
    provisional_tasks: manifest.environment.provisional_tasks,
    note: 'Dry-run only. No model call, session, Docker verification, or pilot execution. A real run requires a runtime-verified tool inventory.',
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'plan.json'), serialize(plan));
  return plan;
}
function appendDurable(file, row) {
  const fd = openSync(file, 'a');
  try { appendFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
function writeArtifact(out, ids, kind, value) {
  const content = serialize(value), hash = sha256(content);
  const relative = `artifacts/${sha256(ids.key)}/${kind}.${hash}.json`;
  const file = path.join(out, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) assert(readFileSync(file, 'utf8') === content, 'Existing immutable artifact differs');
  else writeFileSync(file, content, { flag: 'wx' });
  return { kind, path: relative, sha256: hash };
}
function usageOf(candidate) {
  if (!Array.isArray(candidate.usage) || candidate.usage.length === 0) return null;
  let tokens = 0;
  for (const step of candidate.usage) {
    const value = step?.tokens;
    if (!value || typeof value !== 'object') return null;
    tokens += (value.input ?? 0) + (value.output ?? 0) + (value.reasoning ?? 0);
  }
  return { tokens, tool_calls: 0 };
}
function costOf(candidate) {
  const steps = candidate.usage;
  const costs = Array.isArray(steps) ? steps.map(step => step?.cost) : [];
  if (!costs.length || costs.some(cost => typeof cost !== 'number' || !Number.isFinite(cost))) {
    return { observed_usd: null, estimated_usd: null, source: 'opencode step_finish (missing or non-numeric cost)', date: new Date().toISOString().slice(0, 10) };
  }
  return { observed_usd: costs.reduce((sum, cost) => sum + cost, 0), estimated_usd: null, source: 'opencode step_finish cost', date: new Date().toISOString().slice(0, 10) };
}
function eventsOf(candidate, profile) {
  const events = Array.isArray(candidate.events) ? candidate.events.filter(event => event?.type === 'tool_use') : [];
  return events.map((event, index) => ({
    seq: index + 1, kind: 'tool_call', tool: String(event.part?.tool ?? 'unknown'),
    arguments: event.part?.state?.input && typeof event.part.state.input === 'object' ? event.part.state.input : {},
    result: {
      status: event.part?.state?.status ?? 'unknown',
      output: typeof event.part?.state?.output === 'string' ? event.part.state.output : null,
      error: typeof event.part?.state?.error === 'string' ? event.part.state.error : null,
    },
    duration_ms: 0, simulated: false,
  }));
}
function contextFor(task) {
  if (task.type !== 'absence') return {};
  return task.grading.status === 'corpus_unavailable'
    ? { corpus_available: false, consulted: task.grading.consulted }
    : { corpus_available: true, consulted: task.grading.consulted };
}
async function evaluate({ task, candidate, leanToolchain, deps }) {
  if (candidate.status === 'extraction_failure') {
    return { status: 'extraction_failure', final: null, grade: { correct: false, reason: candidate.error ?? 'extraction_failure' }, error: { category: 'extraction_failure', message: candidate.error ?? 'extraction_failure' }, receipt: null };
  }
  if (candidate.status !== 'candidate_ready' || !candidate.final) {
    return { status: 'operational_failure', final: null, grade: { correct: false, reason: candidate.error ?? candidate.status ?? 'adapter_failure' }, error: { category: 'adapter_failure', message: candidate.error ?? candidate.status ?? 'adapter_failure' }, receipt: null };
  }
  const final = candidate.final;
  if (task.type === 'formal') {
    if (typeof final.solution !== 'string' || !final.solution.trim()) {
      return { status: 'extraction_failure', final: null, grade: { correct: false, reason: 'formal final missing solution' }, error: { category: 'extraction_failure', message: 'formal final missing solution' }, receipt: null };
    }
    const target = { theorem: task.formal.theorem, expectedType: task.formal.expected_type, imports: task.formal.imports, allowedAxioms: task.formal.allowed_axioms, toolchain: leanToolchain };
    let receipt;
    try { receipt = await deps.verifyLeanSubmission({ ...target, code: final.solution }); }
    catch (error) { return { status: 'operational_failure', final: null, grade: { correct: false, reason: `verifier failure: ${error.message}` }, error: { category: 'tool_unavailable', message: error.message }, receipt: null }; }
    const spec = { theorem: target.theorem, expected_type: target.expectedType, target_sha256: leanTargetHash(target), policy: { allowed_axioms: target.allowedAxioms }, toolchain: leanToolchain };
    const answer = { type: 'formal', solution: normalizeLeanSolution(final.solution), target_sha256: spec.target_sha256, receipt_sha256: receipt.receipt_sha256 };
    const graded = formal(answer, spec, { trusted_receipts: { [receipt.receipt_sha256]: receipt } });
    return { status: 'completed', final, grade: graded, error: null, receipt };
  }
  const graded = gradeFinal(task, final, contextFor(task));
  if (graded.status === 'extraction_failure') {
    return { status: 'extraction_failure', final: null, grade: graded.grade, error: { category: 'extraction_failure', message: graded.grade.reason }, receipt: null };
  }
  return { status: 'completed', final, grade: graded.grade, error: null, receipt: null };
}
async function executeOne({ ids, task, profile, plan, start, manifest, model, leanToolchain, out, deps }) {
  let audit;
  try {
    assert(plan.hashes.public_payload === start.agent_payload_sha256, 'isolation_failure: start payload mismatch');
    audit = await deps.auditInventory(plan, { checkWorkspace: deps.assertPreparedWorkspace });
    if (!(audit.status === 'passed' && audit.runtime_verified === true && audit.guarantee === 'runtime-verified'
      && audit.workspace === plan.workspace && audit.workspace_tree === plan.hashes.workspace_tree && audit.cleanup === true)) {
      throw new Error(`isolation_failure: runtime inventory audit ${audit.status}: ${audit.execution_blocker ?? audit.error ?? 'unsupported'}`);
    }
    const candidate = deps.executeEpisode(plan, { allowExecution: true, audit, timeoutMs: manifest.budgets.duration_ms });
    const events = eventsOf(candidate, profile);
    const allowed = new Set([
      ...profile.effective_tools,
      ...(profile.id === 'F' ? ['read', 'glob', 'grep', 'shell'] : []),
      ...(profile.id === 'A' ? [] : ['execute']),
    ]);
    const unexpected = events.find(event => !allowed.has(event.tool));
    if (unexpected) throw new Error(`isolation_failure: unexpected tool ${unexpected.tool}`);
    const usage = usageOf(candidate);
    let evaluated = await evaluate({ task, candidate, leanToolchain, deps });
    if (evaluated.status === 'completed' && !usage) {
      evaluated = { status: 'operational_failure', final: null, grade: { correct: false, reason: 'adapter_failure: missing usage' }, error: { category: 'adapter_failure', message: 'missing usage' }, receipt: null };
    }
    const episode = {
      schema_version: VERSION, ...ids, key: ids.key, simulated: false,
      family: task.family, domain: task.domain, negative: Boolean(task.negative),
      status: evaluated.status, error: evaluated.error, final: evaluated.final, events,
      grade: evaluated.grade,
      usage: usage ? { ...usage, tool_calls: events.length } : { tokens: 0, tool_calls: events.length },
      under_budget: false, duration_ms: Number(candidate.duration_ms) || 0,
      duration_source: 'monotonic-clock', cost: costOf(candidate), artifacts: [],
      workspace: { fresh: true, config_loaded: false, agent_payload_sha256: start.agent_payload_sha256, removed: true },
      started_at: start.started_at,
    };
    episode.under_budget = underBudget(episode, manifest.budgets);
    if (evaluated.receipt) {
      const receiptDir = path.join(out, 'receipts');
      mkdirSync(receiptDir, { recursive: true });
      const receiptFile = path.join(receiptDir, `${sha256(ids.key)}.${evaluated.receipt.receipt_sha256}.json`);
      const content = serialize(evaluated.receipt);
      if (existsSync(receiptFile)) assert(readFileSync(receiptFile, 'utf8') === content, 'Existing receipt differs');
      else writeFileSync(receiptFile, content, { flag: 'wx' });
    }
    return episode;
  } catch (error) {
    const category = error.message.startsWith('isolation_failure') ? 'isolation_failure' : 'adapter_failure';
    const events = [];
    return {
      schema_version: VERSION, ...ids, key: ids.key, simulated: false,
      family: task.family, domain: task.domain, negative: Boolean(task.negative),
      status: 'operational_failure', error: { category, message: error.message }, final: null, events,
      grade: { correct: false, reason: category }, usage: { tokens: 0, tool_calls: 0 }, under_budget: false,
      duration_ms: 0, duration_source: 'monotonic-clock',
      cost: { observed_usd: null, estimated_usd: null, source: 'not measured', date: new Date().toISOString().slice(0, 10) },
      artifacts: [], workspace: { fresh: true, config_loaded: false, agent_payload_sha256: start.agent_payload_sha256, removed: true },
      started_at: start.started_at,
    };
  } finally { if (plan) rmSync(plan.workspace, { recursive: true, force: true }); }
}
function caveats({ manifest, out }) {
  const lines = [
    '# Study caveats', '',
    `Study: ${manifest.study_id}`,
    `Model: ${manifest.models.join(', ')}`,
    `Lean toolchain label: ${manifest.environment.lean_toolchain ?? 'not supplied'}`,
    `Provisional tasks: ${manifest.environment.provisional_tasks}`,
    `Paper evidence: ${manifest.environment.paper_evidence}`,
    '',
    '- This is a real-adapter study, not a simulated fixture run.',
    '- The evaluator bridge is not an independent kernel check, a signature, or an OS sandbox.',
    '- Absence and explanation prose are heuristic/fixture checks, not blinded human adjudication.',
    '- The adapter inventory was static-equivalent unless the manifest records runtime verification.',
    '- Unknown monetary cost cannot count as under budget; all-started denominators include failures.',
    '- Family-level intervals are exploratory, especially with six thematic families.',
    '',
  ];
  if (manifest.environment.provisional_tasks) lines.push('- Provisional tasks were allowed for development. Do not present this study as confirmatory paper evidence.', '');
  writeFileSync(path.join(out, 'study-caveats.md'), lines.join('\n'));
}
export async function executeStudy({ manifest, tasks, tasksFile, out, model, leanToolchain, allowProvisional = false, limit = Infinity, spendCap }, deps = {}) {
  const resolved = { prepareEpisode, executeEpisode, auditInventory, assertPreparedWorkspace, verifyLeanSubmission, ...deps };
  if (process.env[EXECUTE_ENV] !== '1') throw new Error(`execution_not_authorized: set ${EXECUTE_ENV}=1 only after the audit and budget are approved`);
  if (manifest.environment.provisional_tasks && !allowProvisional) throw new Error('provisional_tasks: pass --allow-provisional only for development/engineering data; it is not paper evidence');
  assert(Number.isFinite(spendCap) && spendCap > 0, 'A positive spend cap is required for execution');
  const gate = await preflight({ manifest, tasks, model, deps: resolved });
  if (!gate.ready) {
    const blockers = gate.audits.filter(audit => !audit.runtime_verified).map(audit => `${audit.profile}: ${audit.execution_blocker ?? audit.error ?? 'runtime audit failed'}`);
    throw new Error(`runtime_inventory_unverified: ${blockers.join(' | ')}`);
  }
  manifest.environment.runtime_inventory = 'runtime-verified';
  manifest.protocol_hash = protocolHash(manifest);
  validateManifest(manifest);
  mkdirSync(out, { recursive: true });
  const lock = path.join(out, '.run-lock');
  try { mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('Study is locked; inspect stale lock after a crash before removal.'); throw error; }
  try {
    const manifestFile = path.join(out, 'manifest.json');
    if (existsSync(manifestFile)) {
      const existing = json(manifestFile);
      validateManifest(existing);
      assert(existing.protocol_hash === manifest.protocol_hash, 'Resume protocol mismatch: use a new study directory');
    } else {
      assert(!existsSync(path.join(out, 'episodes.jsonl')) && !existsSync(path.join(out, 'starts.jsonl')), 'Ledger exists without manifest');
      writeFileSync(manifestFile, serialize(manifest), { flag: 'wx' });
    }
    const { manifest: loaded, ledger } = loadStudy(out);
    const taskById = new Map(tasks.map(task => [task.id, task]));
    let appended = 0, stop = null;
    let currentSpent = [...ledger.completed.values()].reduce((sum, episode) => sum + (episode.cost.observed_usd ?? 0), 0);
    for (const ids of expectedEpisodes(loaded)) {
      if (ledger.completed.has(ids.key)) continue;
      if (appended >= limit) break;
      const task = taskById.get(ids.task_id);
      const profile = loaded.profiles.find(item => item.id === ids.condition_id);
      const start = ledger.started.get(ids.key);
      if (start) {
        const interrupted = {
          schema_version: VERSION, ...ids, key: ids.key, simulated: false, family: task.family, domain: task.domain, negative: Boolean(task.negative),
          status: 'operational_failure', error: { category: 'interrupted', message: 'previously started episode had no terminal record' },
          final: null, events: [], grade: { correct: false, reason: 'interrupted' }, usage: { tokens: 0, tool_calls: 0 }, under_budget: false,
          duration_ms: 0, duration_source: 'monotonic-clock',
          cost: { observed_usd: null, estimated_usd: null, source: 'not measured', date: new Date().toISOString().slice(0, 10) },
          artifacts: [], workspace: { fresh: true, config_loaded: false, agent_payload_sha256: start.agent_payload_sha256, removed: true },
          started_at: start.started_at,
        };
        interrupted.artifacts = ['final', 'events'].map(kind => writeArtifact(out, ids, kind, interrupted[kind]));
        appendDurable(path.join(out, 'episodes.jsonl'), interrupted);
        appended++;
        continue;
      }
      if (currentSpent + loaded.budgets.usd > spendCap) {
        stop = { reason: 'spend_cap', spent_usd: currentSpent, cap_usd: spendCap };
        break;
      }
      const plan = resolved.prepareEpisode({ task, profile, model });
      const record = { ...ids, started_at: new Date().toISOString(), agent_payload_sha256: plan.hashes.public_payload };
      appendDurable(path.join(out, 'starts.jsonl'), record);
      const episode = await executeOne({ ids, task, profile, plan, start: record, manifest: loaded, model, leanToolchain, out, deps: resolved });
      episode.artifacts = ['final', 'events'].map(kind => writeArtifact(out, ids, kind, episode[kind]));
      appendDurable(path.join(out, 'episodes.jsonl'), episode);
      currentSpent += episode.cost.observed_usd ?? 0;
      appended++;
      if (episode.cost.observed_usd === null) {
        stop = { reason: 'cost_unavailable', spent_usd: currentSpent, note: 'Unknown cost cannot be bounded; study stopped before another dispatch.' };
        break;
      }
    }
    if (stop) writeFileSync(path.join(out, 'stop.json'), serialize(stop));
    caveats({ manifest: loaded, out });
    try { analyzeStudy(out); } catch (error) { writeFileSync(path.join(out, 'report-error.txt'), `${error.message}\n`); }
    const finished = loadStudy(out);
    return { study_id: loaded.study_id, appended, episodes: finished.episodes.length, expected: loaded.expected_episode_count, missing: finished.ledger.missing.length, output: path.resolve(out), stop };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
export async function main(argv = process.argv.slice(2)) {
  const allowProvisional = argv.includes('--allow-provisional');
  const options = parseArgs(argv.filter(arg => arg !== '--allow-provisional'), ['--tasks', '--model', '--out', '--profiles', '--repeats', '--attempts', '--limit', '--dry-run', '--execute', '--lean-toolchain', '--budget-tokens', '--budget-tool-calls', '--budget-duration-ms', '--budget-usd', '--spend-cap-usd', '--seed', '--resamples', '--study-id']);
  assert(!(options['--dry-run'] && options['--execute']), 'Choose --dry-run or --execute');
  assert(options['--tasks'] && options['--model'] && options['--out'], '--tasks, --model and --out are required');
  const { tasks, file } = readTasks(options['--tasks']);
  const profiles = options['--profiles'] ? options['--profiles'].split(',').map(id => id.trim()) : ['A', 'B', 'F'];
  assert(profiles.length === 3 && ['A', 'B', 'F'].every(id => profiles.includes(id)), 'Profiles must be A,B,F');
  const repeats = options['--repeats'] ? options['--repeats'].split(',').map(value => Number(value)) : [1];
  const attempts = options['--attempts'] ? options['--attempts'].split(',').map(value => Number(value)) : [1];
  assert(repeats.every(value => Number.isInteger(value) && value > 0) && attempts.every(value => Number.isInteger(value) && value > 0), 'Invalid repeats/attempts');
  const budgets = {
    tokens: number(options['--budget-tokens'], '--budget-tokens', 200000, { integer: true, min: 1 }),
    tool_calls: number(options['--budget-tool-calls'], '--budget-tool-calls', 40, { integer: true }),
    duration_ms: number(options['--budget-duration-ms'], '--budget-duration-ms', 600000, { min: 1 }),
    usd: number(options['--budget-usd'], '--budget-usd', 1),
  };
  const spendCap = number(options['--spend-cap-usd'], '--spend-cap-usd', budgets.usd * tasks.length * profiles.length * repeats.length * attempts.length);
  assert(spendCap > 0, 'A positive spend cap is required');
  const leanToolchain = options['--lean-toolchain'] ?? 'leanprover/lean4:v4.34.1';
  const manifest = buildManifest({
    tasks, tasksFile: file, model: options['--model'], profiles: loadProfiles(),
    repeats, attempts, budgets, leanToolchain,
    seed: number(options['--seed'], '--seed', 20261108, { integer: true }),
    resamples: number(options['--resamples'], '--resamples', 10000, { integer: true, min: 1 }),
    studyId: options['--study-id'],
  });
  const out = path.resolve(options['--out']);
  if (options['--execute']) {
    const limit = options['--limit'] ? number(options['--limit'], '--limit', 1, { integer: true, min: 0 }) : Infinity;
    const result = await executeStudy({ manifest, tasks, tasksFile: file, out, model: options['--model'], leanToolchain, allowProvisional, limit, spendCap });
    console.log(serialize(result));
  } else {
    const plan = await dryRun({ manifest, tasks, tasksFile: file, out, model: options['--model'] });
    console.log(serialize(plan));
    if (!plan.execution_ready) process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
