import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'C:/_Work/opencode-math-copilot';
const OUT = path.join(REPO, 'bench/v2/free-models');
const SOURCES = {
  free: {
    label: 'Free providers',
    models: path.join(REPO, 'bench/v2/free-models/models.json'),
    state: 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix/state.json',
    report: 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix/matrix-report.json',
  },
  other: {
    label: 'Direct providers',
    models: path.join(REPO, 'bench/v2/free-models/models-other.json'),
    state: 'C:/Users/MiPC/AppData/Local/Temp/opencode/other-matrix/state.json',
    report: 'C:/Users/MiPC/AppData/Local/Temp/opencode/other-matrix/matrix-report.json',
  },
};

const readJson = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const dateOnly = value => typeof value === 'string' ? value : null;
const countBy = (items, key) => {
  const result = {};
  for (const item of items) {
    const value = typeof key === 'function' ? key(item) : item[key];
    if (value === undefined || value === null || value === '') continue;
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
};
const providerOf = model => model.split('/')[0];
const statusOrder = ['full_complete', 'screen_passed', 'screening', 'fulling', 'quota_wait', 'auth_error', 'provider_output', 'error', 'not_in_plan', 'unavailable', 'config_error', 'tool_protocol_failure', 'pending', 'skipped'];

function fullSummary(full) {
  const episodes = Array.isArray(full?.episodes) ? full.episodes : [];
  const conditions = {};
  for (const episode of episodes) {
    const c = conditions[episode.condition] ??= { episodes: 0, completed: 0, correct: 0, extraction: 0, operational: 0 };
    c.episodes++;
    if (episode.status === 'completed') c.completed++;
    if (episode.correct === true) c.correct++;
    if (episode.status === 'extraction_failure') c.extraction++;
    if (episode.status === 'operational_failure') c.operational++;
  }
  return {
    episodes: episodes.length,
    completed: Object.values(conditions).reduce((sum, c) => sum + c.completed, 0),
    correct: Object.values(conditions).reduce((sum, c) => sum + c.correct, 0),
    cost_usd: Number(episodes.reduce((sum, episode) => sum + (typeof episode.cost === 'number' ? episode.cost : 0), 0).toFixed(6)),
    conditions,
  };
}

function matrixData(source) {
  const models = readJson(source.models, { models: [] }).models ?? [];
  const state = readJson(source.state, { models: {} });
  const rows = models.map(model => {
    const entry = state.models[model] ?? { status: 'pending' };
    const screenEpisodes = Array.isArray(entry.screen?.episodes) ? entry.screen.episodes : [];
    const categories = [...new Set(screenEpisodes.map(episode => episode.category).filter(Boolean))];
    const providerErrors = screenEpisodes.map(episode => episode.provider_error).filter(Boolean);
    const providerError = providerErrors[0] ?? null;
    return {
      model,
      provider: providerOf(model),
      status: entry.status ?? 'pending',
      attempts: Number(entry.attempts) || 0,
      screening: entry.screen?.classification ?? null,
      next_attempt_at: entry.next_attempt_at ?? null,
      updated_at: entry.updated_at ?? null,
      last_error: clean(entry.last_error, 700) || null,
      categories,
      provider_error: providerError ? {
        type: clean(providerError.type, 120) || null,
        message: clean(providerError.message, 500) || null,
        status: providerError.status ?? null,
      } : null,
      screen: screenEpisodes.map(episode => ({
        condition: episode.condition ?? null,
        status: episode.status ?? null,
        correct: episode.correct === true,
        category: episode.category ?? null,
        error: clean(episode.error, 400) || null,
        cost: typeof episode.cost === 'number' ? episode.cost : null,
        tokens: episode.tokens ?? null,
        tool_calls: episode.tool_calls ?? null,
      })),
      full: fullSummary(entry.full),
    };
  });
  const counts = countBy(rows, 'status');
  const providers = {};
  for (const row of rows) {
    const p = providers[row.provider] ??= { provider: row.provider, total: 0, counts: {} };
    p.total++;
    p.counts[row.status] = (p.counts[row.status] ?? 0) + 1;
  }
  const categories = {};
  for (const row of rows) for (const category of row.categories) categories[category] = (categories[category] ?? 0) + 1;
  const retries = rows
    .filter(row => row.next_attempt_at)
    .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
    .slice(0, 80)
    .map(row => ({ model: row.model, provider: row.provider, status: row.status, next_attempt_at: row.next_attempt_at }));
  const spend = rows.reduce((sum, row) => sum + row.screen.reduce((s, e) => s + (typeof e.cost === 'number' ? e.cost : 0), 0), 0);
  return {
    label: source.label,
    total_models: models.length,
    scanned_models: rows.filter(row => row.status !== 'pending').length,
    counts,
    providers: Object.values(providers).sort((a, b) => b.total - a.total),
    categories,
    retries,
    spend_usd: Number(spend.toFixed(6)),
    models: rows,
  };
}

const tasks = readJson(path.join(REPO, 'bench/v2/tasks/pilot-v1.json'), []);
const taskTypes = countBy(tasks, 'type');
const taskTracks = countBy(tasks, 'track');
const taskFamilies = countBy(tasks, 'family');
const taskNegatives = tasks.filter(task => task.negative).length;
let git = { branch: null, commit: null, message: null, dirty: null };
try {
  git = {
    branch: execFileSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
    commit: execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    message: execFileSync('git', ['-C', REPO, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  };
} catch { /* git is optional */ }

const data = {
  schema: 'math-copilot-dashboard/v1',
  generated_at: new Date().toISOString(),
  project: {
    name: 'OpenCode Math Copilot',
    repo: REPO,
    branch: git.branch,
    commit: git.commit,
    commit_message: git.message,
    dirty: git.dirty,
    ci: 'last known: green for e91cddc (Test + Security)',
    conditions: ['A', 'B', 'F'],
    task_count: tasks.length,
    task_types: taskTypes,
    task_tracks: taskTracks,
    task_families: taskFamilies,
    negative_tasks: taskNegatives,
    episode_budget: { duration_ms: 600000, tool_calls: 40, tokens: 200000, usd_per_episode: 1, global_cap_usd: 25 },
    caveats: [
      'The $25 configured study threshold is not a guaranteed cap. Strict spending-cap enforcement has not been validated.',
      'Protocol completion is not mathematical correctness.',
      'full_complete currently counts 90 rows; clean completion requires all 90 completed.',
      'Provider quota/auth/context failures are operational results, not model quality.',
      'Legacy tool_protocol_failure rows predate provider-error capture; they are not all auth errors.',
      'The free matrix is exploratory, not confirmatory paper evidence.',
      'OpenAI is skipped because standalone OAuth returns Integration.Authorization: Request failed: 400.',
    ],
    sources: [
      'bench/v2/free-models/models.json',
      'bench/v2/free-models/models-other.json',
      'bench/v2/tasks/pilot-v1.json',
      'temp free-matrix/state.json',
      'temp other-matrix/state.json',
    ],
  },
  matrices: {
    free: matrixData(SOURCES.free),
    other: matrixData(SOURCES.other),
  },
  status_order: statusOrder,
};

const json = JSON.stringify(data, null, 2) + '\n';
writeFileSync(path.join(OUT, 'dashboard-data.json'), json);
writeFileSync(path.join(OUT, 'dashboard-data.js'), `window.DASHBOARD_DATA = ${JSON.stringify(data)};\n`);
console.log(JSON.stringify({
  generated_at: data.generated_at,
  free: { total: data.matrices.free.total_models, counts: data.matrices.free.counts },
  other: { total: data.matrices.other.total_models, counts: data.matrices.other.counts },
  bytes: json.length,
}, null, 2));
