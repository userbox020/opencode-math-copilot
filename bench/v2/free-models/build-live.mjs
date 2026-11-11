import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'C:/_Work/opencode-math-copilot';
const OUT = path.join(REPO, 'bench/v2/free-models');
const SOURCES = {
  free: {
    label: 'Free providers',
    models: path.join(REPO, 'bench/v2/free-models/models.json'),
    state: 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix/state.json',
    root: 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix',
    log: 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix/retry-classify.log',
  },
  other: {
    label: 'Direct providers',
    models: path.join(REPO, 'bench/v2/free-models/models-other.json'),
    state: 'C:/Users/MiPC/AppData/Local/Temp/opencode/other-matrix/state.json',
    root: 'C:/Users/MiPC/AppData/Local/Temp/opencode/other-matrix',
    log: 'C:/Users/MiPC/AppData/Local/Temp/opencode/other-matrix/opencode-go-retry.log',
  },
};

const readJson = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const safeName = model => model.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').slice(0, 110);
const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const tail = (file, lines = 12) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).map(line => clean(line, 500));
};
const statusOrder = ['full_complete', 'screen_passed', 'screening', 'fulling', 'quota_wait', 'auth_error', 'provider_output', 'error', 'not_in_plan', 'unavailable', 'config_error', 'tool_protocol_failure', 'pending', 'skipped'];
const countBy = (items, key) => {
  const result = {};
  for (const item of items) {
    const value = typeof key === 'function' ? key(item) : item[key];
    if (value === undefined || value === null || value === '') continue;
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
};
const latestAttempt = (root, phase, model, attempts) => {
  const base = path.join(root, phase === 'full' ? 'full' : 'screen', safeName(model));
  if (!existsSync(base)) return null;
  const candidates = [];
  for (let number = Math.max(1, attempts + 1); number >= 1; number--) {
    const directory = path.join(base, `attempt-${number}`);
    if (existsSync(directory)) candidates.push({ number, directory, mtime: statSync(directory).mtimeMs });
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)[0] ?? null;
};
const episodeFile = directory => {
  const file = path.join(directory, 'episodes.jsonl');
  if (!existsSync(file)) return { file, episodes: [], mtime: null };
  const episodes = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return { file, episodes, mtime: statSync(file).mtimeMs };
};
const startFile = directory => {
  const file = path.join(directory, 'starts.jsonl');
  if (!existsSync(file)) return { file, starts: [], mtime: null };
  const starts = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return { file, starts, mtime: statSync(file).mtimeMs };
};

function liveQueue(key, source) {
  const models = readJson(source.models, { models: [] }).models ?? [];
  const state = readJson(source.state, { models: {} });
  const rows = Object.entries(state.models).map(([model, entry]) => ({ model, ...entry }));
  const counts = countBy(rows, 'status');
  const active = rows.filter(row => ['screening', 'fulling'].includes(row.status)).map(row => {
    const phase = row.status === 'fulling' ? 'full' : 'screen';
    const attemptSeed = phase === 'full' ? Number(row.full_attempts) || 0 : Number(row.attempts) || 0;
    const attempt = latestAttempt(source.root, phase, row.model, attemptSeed);
    const episodes = attempt ? episodeFile(attempt.directory) : { episodes: [], mtime: null };
    const starts = attempt ? startFile(attempt.directory) : { starts: [], mtime: null };
    const expected = phase === 'full' ? 90 : 3;
    const completed = episodes.episodes.length;
    const last = episodes.episodes[episodes.episodes.length - 1] ?? null;
    const lastStart = starts.starts[starts.starts.length - 1] ?? null;
    const lastActivityMs = Math.max(episodes.mtime ?? 0, starts.mtime ?? 0, attempt?.mtime ?? 0, Date.parse(row.updated_at) || 0);
    const startedAt = last?.started_at ?? lastStart?.started_at ?? row.updated_at ?? null;
    const elapsedMs = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : null;
    const stalled = lastActivityMs > 0 && Date.now() - lastActivityMs > 10 * 60 * 1000;
    return {
      model: row.model,
      provider: row.model.split('/')[0],
      phase,
      status: row.status,
      attempt: attempt?.number ?? null,
      expected,
      completed,
      remaining: Math.max(0, expected - completed),
      progress: expected ? Math.min(1, completed / expected) : 0,
      started_at: startedAt,
      elapsed_ms: elapsedMs,
      last_activity_at: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
      stalled,
      current_task: last ? {
        task_id: last.task_id ?? null,
        family: last.family ?? null,
        condition: last.condition_id ?? null,
        status: last.status ?? null,
        correct: last.grade?.correct === true,
        error: clean(last.error?.message, 300) || null,
        tokens: last.usage?.tokens ?? null,
        tool_calls: last.usage?.tool_calls ?? null,
      } : null,
      last_error: clean(row.last_error, 500) || clean(last?.error?.message, 500) || null,
      next_attempt_at: row.next_attempt_at ?? null,
    };
  });
  const retries = rows
    .filter(row => row.next_attempt_at)
    .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
    .slice(0, 30)
    .map(row => ({ model: row.model, provider: row.model.split('/')[0], status: row.status, next_attempt_at: row.next_attempt_at }));
  const recent = rows
    .filter(row => row.updated_at)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, 12)
    .map(row => ({ model: row.model, provider: row.model.split('/')[0], status: row.status, attempts: row.attempts ?? 0, updated_at: row.updated_at, last_error: clean(row.last_error, 300) || null }));
  const nonterminal = rows.filter(row => !['full_complete', 'not_in_plan', 'unavailable', 'config_error', 'tool_protocol_failure'].includes(row.status)).length;
  return {
    label: source.label,
    total_models: models.length,
    state_models: rows.length,
    counts,
    active,
    retries,
    recent,
    nonterminal,
    log_tail: tail(source.log),
  };
}

let git = { branch: null, commit: null, message: null, dirty: null };
try {
  git = {
    branch: execFileSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
    commit: execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    message: execFileSync('git', ['-C', REPO, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  };
} catch { /* optional */ }

const queues = { free: liveQueue('free', SOURCES.free), other: liveQueue('other', SOURCES.other) };
const allActive = Object.entries(queues).flatMap(([key, queue]) => queue.active.map(run => ({ ...run, matrix: key })));
const data = {
  schema: 'math-copilot-live/v1',
  generated_at: new Date().toISOString(),
  project: {
    name: 'OpenCode Math Copilot',
    repo: REPO,
    branch: git.branch,
    commit: git.commit,
    commit_message: git.message,
    dirty: git.dirty,
    ci: 'last known: green for e91cddc (Test + Security)',
    refresh_command: 'node bench/v2/free-models/build-live.mjs',
    caveats: [
      'Snapshot, not a live stream; regenerate and reload to update.',
      'Progress is derived from the current attempt directory and episodes.jsonl.',
      'A stalled badge means no file activity for more than 10 minutes.',
      'Protocol progress is not mathematical correctness.',
    ],
  },
  summary: {
    active: allActive.length,
    stalled: allActive.filter(run => run.stalled).length,
    free_active: queues.free.active.length,
    other_active: queues.other.active.length,
    free_nonterminal: queues.free.nonterminal,
    other_nonterminal: queues.other.nonterminal,
    total_models: queues.free.total_models + queues.other.total_models,
  },
  active: allActive,
  queues,
  status_order: statusOrder,
};
writeFileSync(path.join(OUT, 'running-data.json'), JSON.stringify(data, null, 2) + '\n');
writeFileSync(path.join(OUT, 'running-data.js'), `window.RUNNING_DATA = ${JSON.stringify(data)};\n`);
console.log(JSON.stringify({ generated_at: data.generated_at, summary: data.summary, active: allActive.map(run => ({ model: run.model, phase: run.phase, completed: run.completed, expected: run.expected, task: run.current_task?.task_id, condition: run.current_task?.condition, stalled: run.stalled })) }, null, 2));
