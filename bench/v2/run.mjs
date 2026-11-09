import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, VERSION, EPOCH, COMMON_PROMPT, sha256, json, serialize, assert, validateNamed, loadProfiles, validateProfile, expectedEpisodes, readJsonl, indexUnique, prepareWorkspace, agentPayload, assertWorkspace, parseArgs } from './lib.mjs';
import { gradeFinal } from './graders/index.mjs';
import { createDispatcher, simulate } from './simulator.mjs';
import { RECEIPT_SCHEMA_VERSION } from './graders/formal.mjs';

export const DEFAULT_OUTPUT = path.join(ROOT, 'simulated', 'simulated-pilot-receipt-v2.1');
export function sourceHashes() {
  const hashes = {};
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory() && ['profiles', 'schemas', 'graders', 'fixtures', 'exec'].includes(relative)) visit(path.join(directory, entry.name), relative + '/');
      else if (entry.isFile() && /\.(mjs|json)$/.test(entry.name)) hashes[relative] = sha256(readFileSync(path.join(directory, entry.name)));
    }
  }
  visit(ROOT);
  return hashes;
}
export function makeManifest() {
  const tasks = json(path.join(ROOT, 'fixtures', 'tasks.json'));
  let commit = null;
  try { commit = execFileSync('git', ['-C', path.resolve(ROOT, '../..'), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source hashes remain authoritative outside Git. */ }
  const manifest = {
    schema_version: VERSION, study_id: 'simulated-pilot-v2-receipt-2.1', simulated: true,
    clock: { kind: 'simulated', epoch: EPOCH },
    versions: { harness: VERSION, adapter: 'simulated-fixtures-2', grader: RECEIPT_SCHEMA_VERSION, receipt_schema: RECEIPT_SCHEMA_VERSION, node: process.version },
    commits: { repository: commit, corpus: null }, hashes: sourceHashes(),
    profiles: loadProfiles(), prompts: { common: COMMON_PROMPT, tasks: Object.fromEntries(tasks.map(task => [task.id, { prompt: task.prompt, answer_contract: task.answer_contract }])) },
    budgets: { tokens: 1000, tool_calls: 4, duration_ms: 10000, usd: 1 },
    cache_state: { episode: 'cold', shared: 'disabled' },
    environment: { platform: process.platform, arch: process.arch, config: 'not-loaded', network: 'no-network-calls', execution: 'simulator-only' },
    models: ['simulated-model-a', 'simulated-model-b'],
    tasks: tasks.map(({ id, family, domain, type, negative }) => ({ id, family, domain, type, negative })),
    repeats: [1, 2], attempts: [1],
    analysis: { primary: 'correct-under-budget/all-started', contrast: 'F-B', seed: 20260101, resamples: 2000, cluster: 'task-family' },
    expected_episode_count: 48
  };
  manifest.protocol_hash = protocolHash(manifest);
  validateManifest(manifest);
  return manifest;
}
export function protocolHash(manifest) {
  const { protocol_hash, commits, environment, versions, ...protocol } = manifest;
  return sha256({ ...protocol, versions: { harness: versions.harness, adapter: versions.adapter, grader: versions.grader } });
}
export function validateManifest(manifest) {
  validateNamed('study-manifest', manifest);
  manifest.profiles.forEach(validateProfile);
  assert(new Set(manifest.profiles.map(p => p.id)).size === 3, 'Duplicate conditions');
  assert(new Set(manifest.tasks.map(t => t.id)).size === manifest.tasks.length, 'Duplicate tasks');
  if (manifest.simulated) {
    assert(manifest.models.every(model => /^simulated-model-[ab]$/.test(model)), 'Simulated studies must use simulated model IDs');
    assert(manifest.environment.execution === 'simulator-only' && manifest.clock.kind === 'simulated', 'Simulated provenance mismatch');
  } else {
    assert(manifest.environment.execution === 'isolated-adapter' && manifest.clock.kind === 'wall-clock', 'Real-adapter provenance mismatch');
  }
  assert(manifest.protocol_hash === protocolHash(manifest), 'Manifest protocol hash mismatch');
  assert(expectedEpisodes(manifest).length === manifest.expected_episode_count, 'Expected count mismatch');
  return manifest;
}
export function underBudget(episode, budgets) {
  const cost = episode.cost.observed_usd ?? episode.cost.estimated_usd;
  return episode.usage.tokens <= budgets.tokens && episode.usage.tool_calls <= budgets.tool_calls && episode.duration_ms <= budgets.duration_ms && cost !== null && cost <= budgets.usd;
}
export function inspectLedger(manifest, episodes, starts) {
  validateManifest(manifest);
  const expected = new Map(expectedEpisodes(manifest).map(ids => [ids.key, ids]));
  const completed = indexUnique(episodes, 'episodes'), started = indexUnique(starts, 'starts');
  for (const row of starts) {
    assert(expected.has(row.key), 'Unexpected started episode');
    assert(typeof row.started_at === 'string' && typeof row.agent_payload_sha256 === 'string', 'Invalid start record');
  }
  for (const episode of episodes) {
    validateNamed('episode', episode);
    assert(episode.simulated === manifest.simulated, 'Episode simulation marker mismatch');
    assert(episode.duration_source === (manifest.simulated ? 'simulated-fixture' : 'monotonic-clock'), 'Duration source mismatch');
    assert(expected.has(episode.key) && started.has(episode.key), 'Episode without expected start');
    const task = manifest.tasks.find(item => item.id === episode.task_id);
    assert(['family', 'domain', 'negative'].every(field => episode[field] === task[field]), 'Episode task metadata mismatch');
    const start = started.get(episode.key);
    assert(start.started_at === episode.started_at && start.agent_payload_sha256 === episode.workspace.agent_payload_sha256, 'Episode/start provenance mismatch');
    const profile = manifest.profiles.find(item => item.id === episode.condition_id);
    // Real adapters add audited core tools and the Code Mode `execute`
    // transport to the domain inventory. Simulated episodes use only the
    // profile's registered tools, so their allowlist is unchanged.
    const realExtras = manifest.simulated ? [] : profile.id === 'F'
      ? ['read', 'glob', 'grep', 'shell', 'execute']
      : profile.id === 'B' ? ['execute'] : [];
    const allowedTools = new Set([...profile.effective_tools, ...realExtras]);
    episode.events.forEach((event, index) => assert(event.seq === index + 1 && allowedTools.has(event.tool) && event.simulated === manifest.simulated, 'Event outside effective tools, provenance or sequence'));
    assert(episode.events.length === episode.usage.tool_calls, 'Tool count mismatch');
    assert(episode.under_budget === underBudget(episode, manifest.budgets), 'Budget mismatch');
    assert((episode.status === 'completed') === (episode.error === null), 'Status/error mismatch');
    if (episode.status !== 'completed') assert(!episode.grade.correct && episode.final === null, 'Failed episode cannot have correct/evaluable final');
    if (episode.status === 'completed') assert(episode.final !== null && episode.final.type === task.type, 'Missing typed final');
  }
  const missing = [...expected.keys()].filter(key => !completed.has(key));
  const pending = [...started.keys()].filter(key => !completed.has(key));
  return { expected, completed, started, missing, pending };
}
export function loadStudy(output) {
  const manifest = json(path.join(output, 'manifest.json'));
  const episodes = readJsonl(path.join(output, 'episodes.jsonl'));
  const starts = readJsonl(path.join(output, 'starts.jsonl'));
  const ledger = inspectLedger(manifest, episodes, starts);
  for (const episode of episodes) {
    assert(episode.artifacts.length === 2 && new Set(episode.artifacts.map(a => a.kind)).size === 2, 'Expected separate final and events artifacts');
    for (const artifact of episode.artifacts) {
      const file = path.resolve(output, artifact.path);
      const relative = path.relative(path.resolve(output), file);
      assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Artifact escapes study directory');
      const content = readFileSync(file);
      assert(sha256(content) === artifact.sha256, 'Artifact hash mismatch');
      assert(content.toString('utf8') === serialize(episode[artifact.kind]), 'Artifact/episode mismatch');
    }
  }
  return { manifest, episodes, starts, ledger };
}
function appendDurable(file, row) {
  const fd = openSync(file, 'a');
  try { appendFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
function artifact(output, ids, kind, value) {
  const content = serialize(value), hash = sha256(content);
  const relative = `artifacts/${sha256(ids.key)}/${kind}.${hash}.json`;
  const file = path.join(output, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) assert(readFileSync(file, 'utf8') === content, 'Existing immutable artifact differs');
  else writeFileSync(file, content, { flag: 'wx' });
  return { kind, path: relative, sha256: hash };
}
function executeEpisode({ ids, task, profile, start, manifest, interrupted }) {
  let workspace, dispatcher, result;
  let status = 'operational_failure', final = null, grade = { correct: false, reason: 'operational_failure' };
  let error = null;
  try {
    if (interrupted) throw new Error('interrupted: previously started episode had no terminal record');
    workspace = prepareWorkspace(task, profile);
    assert(workspace.payloadHash === start.agent_payload_sha256, 'isolation_failure: start payload mismatch');
    dispatcher = createDispatcher(profile, workspace);
    result = simulate({ task, ids, profile, workspace, dispatcher });
    assertWorkspace(workspace.directory, workspace.files);
    ({ status, final, grade } = gradeFinal(task, result.final, dispatcher.context));
    if (status === 'extraction_failure') error = { category: status, message: grade.reason };
  } catch (failure) {
    const category = ['interrupted', 'tool_unavailable', 'isolation_failure'].find(name => failure.message.startsWith(name + ':')) ?? 'adapter_failure';
    error = { category, message: failure.message };
    status = 'operational_failure'; final = null; grade = { correct: false, reason: category };
  } finally {
    if (workspace) rmSync(workspace.directory, { recursive: true, force: true });
  }
  const events = dispatcher?.events ?? [];
  const episode = {
    schema_version: VERSION, ...ids, simulated: true, family: task.family, domain: task.domain, negative: task.negative,
    status, error, final, events, grade,
    usage: result?.usage ?? { tokens: 0, tool_calls: events.length },
    duration_ms: result?.duration_ms ?? events.length * 5, duration_source: 'simulated-fixture',
    cost: { observed_usd: null, estimated_usd: 0, source: 'simulated fixture accounting; no model or Docker execution', date: '2026-01-01' },
    artifacts: [], workspace: { fresh: true, config_loaded: false, agent_payload_sha256: start.agent_payload_sha256, removed: true },
    started_at: start.started_at
  };
  episode.under_budget = underBudget(episode, manifest.budgets);
  return episode;
}
export function runStudy({ output = DEFAULT_OUTPUT, limit = Infinity } = {}) {
  assert(limit === Infinity || Number.isInteger(limit) && limit >= 0, 'Invalid episode limit');
  mkdirSync(output, { recursive: true });
  const lock = path.join(output, '.run-lock');
  try { mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('Study is locked; no concurrent writers. Inspect stale lock after a crash before manual removal.'); throw error; }
  try {
    const proposed = makeManifest();
    const manifestFile = path.join(output, 'manifest.json');
    if (existsSync(manifestFile)) {
      const existing = json(manifestFile);
      validateManifest(existing);
      assert(existing.protocol_hash === proposed.protocol_hash, 'Resume protocol mismatch: use a new study directory, never overwrite completed episodes');
    } else {
      assert(!existsSync(path.join(output, 'episodes.jsonl')) && !existsSync(path.join(output, 'starts.jsonl')), 'Ledger exists without manifest');
      writeFileSync(manifestFile, serialize(proposed), { flag: 'wx' });
    }
    const { manifest, ledger } = loadStudy(output);
    const tasks = json(path.join(ROOT, 'fixtures', 'tasks.json'));
    let appended = 0;
    for (const ids of expectedEpisodes(manifest)) {
      if (ledger.completed.has(ids.key)) continue;
      if (appended >= limit) break;
      const task = tasks.find(item => item.id === ids.task_id);
      const profile = manifest.profiles.find(item => item.id === ids.condition_id);
      const interrupted = ledger.started.has(ids.key);
      const start = ledger.started.get(ids.key) ?? { ...ids, started_at: EPOCH, agent_payload_sha256: sha256(agentPayload(task, profile)) };
      if (!interrupted) appendDurable(path.join(output, 'starts.jsonl'), start);
      const episode = executeEpisode({ ids, task, profile, start, manifest, interrupted });
      episode.artifacts = ['final', 'events'].map(kind => artifact(output, ids, kind, episode[kind]));
      validateNamed('episode', episode);
      appendDurable(path.join(output, 'episodes.jsonl'), episode);
      appended++;
    }
    const loaded = loadStudy(output);
    return { simulated: true, appended, episodes: loaded.episodes.length, expected: loaded.manifest.expected_episode_count, missing: loaded.ledger.missing.length, output: path.resolve(output) };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2), ['--out']);
    console.log(JSON.stringify(runStudy({ output: args['--out'] ? path.resolve(args['--out']) : DEFAULT_OUTPUT })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
