import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'C:/_Work/opencode-math-copilot';
const SAFE = 'C:/Users/MiPC/AppData/Local/Temp/opencode/safe-home';
const MATH = 'C:/_Work/__OPENAI_MATH/math';
const OUT_DEFAULT = 'C:/Users/MiPC/AppData/Local/Temp/opencode/free-matrix';
const STATE_FILE_DEFAULT = OUT_DEFAULT + '/state.json';
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const mode = option('--mode', 'all');
const waitMinutes = Number(option('--wait-minutes', '30'));
const maxPasses = Number(option('--max-passes', '0'));
const screenLimit = Number(option('--screen-limit', '3'));
const only = option('--only', null);
const reset = option('--reset', null);
const noWait = args.includes('--no-wait');
const dry = args.includes('--dry');
const OUT = option('--out', OUT_DEFAULT);
const MODELS_FILE = option('--models', path.join(REPO, 'bench/v2/free-models/models.json'));
const label = path.basename(MODELS_FILE, '.json');
const STATE_FILE = path.join(OUT, 'state.json');
const REPORT_JSON = path.join(OUT, 'matrix-report.json');
const REPORT_MD = path.join(OUT, 'matrix-report.md');
const totalCap = Number(option('--total-cap-usd', '25'));
mkdirSync(OUT, { recursive: true });
const allModels = JSON.parse(readFileSync(MODELS_FILE, 'utf8')).models.filter(model => !only || new RegExp(only).test(model));
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { created_at: new Date().toISOString(), source: MODELS_FILE, models: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
const safeName = model => model.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').slice(0, 110);
const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tail = (value, max = 4000) => String(value ?? '').slice(-max);
const spent = () => {
  let sum = 0;
  for (const model of allModels) {
    const entry = state.models[model];
    for (const group of ['screen', 'full']) {
      for (const episode of entry?.[group]?.episodes ?? []) {
        if (typeof episode.cost === 'number') sum += episode.cost;
      }
    }
  }
  return sum;
};

const providerWaitMinutes = {
  openai: 15,
  'opencode-go': 60,
  openrouter: 360,
  google: 720,
  zai: 360,
  'ollama-cloud': 360,
  'cloudflare-workers-ai': 60,
  'free-openrouter': 360,
  'free-gemini': 720,
  'free-ollama-cloud': 360,
  'free-kilo': 60,
  'free-groq': 30,
  'free-cloudflare': 60,
  'free-zai': 360,
  opencode: 60,
};
const terminal = new Set(['full_complete', 'not_in_plan', 'unavailable', 'config_error', 'tool_protocol_failure']);
const providerOf = model => model.split('/')[0];
const waitMinutesFor = model => providerWaitMinutes[providerOf(model)] ?? waitMinutes;
const retryAt = (model, status, providerError) => {
  if (status === 'quota_wait' && providerError?.retry_after_ms) {
    const timestamp = Number(providerError.retry_after_ms);
    if (Number.isFinite(timestamp) && timestamp > Date.now()) return new Date(timestamp).toISOString();
  }
  return new Date(Date.now() + waitMinutesFor(model) * 60 * 1000).toISOString();
};

if (reset) {
  const pattern = new RegExp(reset);
  let count = 0;
  for (const [model, entry] of Object.entries(state.models)) {
    if (!pattern.test(model) || entry.status === 'full_complete') continue;
    entry.status = 'pending';
    entry.next_attempt_at = null;
    entry.last_error = null;
    entry.updated_at = now();
    count++;
  }
  save();
  console.log(`[reset] ${count} models matched ${reset}`);
}

function episodes(out) {
  const file = path.join(out, 'episodes.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function summarize(eps) {
  return eps.map(episode => ({
    task: episode.task_id, condition: episode.condition_id, status: episode.status,
    correct: episode.grade?.correct === true, error: episode.error?.message ?? null,
    category: episode.error?.category ?? null,
    provider_error: episode.diagnostics?.provider_error ?? null,
    cost: episode.cost?.observed_usd ?? null, tokens: episode.usage?.tokens ?? null,
    tool_calls: episode.usage?.tool_calls ?? null,
  }));
}
function classify(eps, run) {
  const text = `${run.stdout}\n${run.stderr}\n${JSON.stringify(eps)}`;
  const categories = new Set(eps.map(episode => episode.error?.category).filter(Boolean));
  const providerError = eps.map(episode => episode.diagnostics?.provider_error).find(Boolean) ?? null;
  if (/model not listed|provider_route_missing|provider\.no-route|Unknown model/i.test(text)) return { status: 'unavailable', providerError };
  if (run.status !== 0 && !providerError) return { status: 'error', providerError };
  if (/not included in your free|not available on the .*plan/i.test(text)) return { status: 'not_in_plan', providerError };
  if (categories.has('quota') || /provider\.quota|FreeUsageLimit|free usage limit|"status"\s*:\s*429|status.?429/i.test(text)) return { status: 'quota_wait', providerError };
  if (categories.has('auth') || /provider\.auth|Integration\.Authorization/i.test(text)) return { status: 'auth_error', providerError };
  if (categories.has('retired') || /no longer available|NOT_FOUND/i.test(text)) return { status: 'unavailable', providerError };
  if (categories.has('context')) return { status: 'config_error', providerError };
  if (categories.has('provider_output')) return { status: 'provider_output', providerError };
  if (!eps.length) return { status: 'error', providerError };
  if (eps.every(episode => episode.status === 'completed')) return { status: 'screen_passed', providerError: null };
  if (eps.some(episode => episode.status === 'extraction_failure')) return { status: 'tool_protocol_failure', providerError };
  if (eps.some(episode => episode.status === 'operational_failure')) return { status: 'error', providerError };
  return { status: 'error', providerError };
}
function runStudy(model, out, limit) {
  const studyArgs = [
    path.join(REPO, 'bench/v2/study/run-study.mjs'),
    '--tasks', path.join(REPO, 'bench/v2/tasks/pilot-v1.json'),
    '--model', model, '--out', out, '--execute', '--allow-provisional',
    '--lean-toolchain', 'leanprover/lean4:v4.34.1', '--budget-usd', '1', '--spend-cap-usd', String(Math.max(0.01, totalCap - spent())),
  ];
  if (limit) studyArgs.push('--limit', String(limit));
  const env = {
    ...process.env,
    MATH_BENCH_ALLOW_EXECUTE: '1',
    MATH_BENCH_SAFE_HOME: SAFE,
    MATH_BENCH_STAGE_INDEXES: '1',
    MATH_BENCH_MATH_ROOT: MATH,
  };
  for (const key of ['MATH_BENCH_PROVIDER_PLUGIN', 'MATH_BENCH_PROVIDER_OPTIONS', 'MATH_BENCH_AUTH_FILE']) delete env[key];
  const started = Date.now();
  const result = spawnSync(process.execPath, studyArgs, {
    cwd: REPO, env, shell: false, encoding: 'utf8', windowsHide: true,
    timeout: 0, maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status, error: result.error?.message ?? null,
    duration_ms: Date.now() - started,
    stdout: tail(result.stdout), stderr: tail(result.stderr),
  };
}
function screen(model) {
  const entry = state.models[model] ??= { status: 'pending', attempts: 0, screen: null, full: null };
  if (terminal.has(entry.status)) return false;
  if (entry.next_attempt_at && Date.parse(entry.next_attempt_at) > Date.now()) return false;
  if (mode === 'full') return false;
  const attemptNumber = (entry.attempts ?? 0) + 1;
  const out = path.join(OUT, 'screen', safeName(model), `attempt-${attemptNumber}`);
  if (!dry) {
    entry.status = 'screening'; entry.last_error = null; entry.updated_at = now(); save();
  }
  const run = dry ? { status: 0, error: null, duration_ms: 0, stdout: '', stderr: '' } : runStudy(model, out, screenLimit);
  const eps = dry ? [] : episodes(out);
  const classification = dry ? { status: 'pending', providerError: null } : classify(eps, run);
  if (dry) { console.log(`[dry] screen ${model}`); return true; }
  entry.attempts = (entry.attempts ?? 0) + 1;
  entry.screen = { out, run, classification: classification.status, episodes: summarize(eps) };
  entry.status = classification.status;
  entry.next_attempt_at = ['quota_wait', 'auth_error', 'provider_output', 'error'].includes(classification.status)
    ? retryAt(model, classification.status, classification.providerError)
    : null;
  entry.last_error = run.error ?? classification.providerError?.message
    ?? (classification.status === 'error' ? run.stderr || run.stdout : null);
  entry.updated_at = now();
  save();
  console.log(`[screen] ${model} -> ${classification.status} (${eps.length} episodes, ${Math.round(run.duration_ms / 1000)}s)`);
  return ['quota_wait', 'auth_error', 'provider_output', 'error'].includes(classification.status);
}
function full(model) {
  const entry = state.models[model];
  if (!entry || !['screen_passed', 'full_incomplete', 'fulling'].includes(entry.status)) return false;
  if (mode === 'screen') return false;
  entry.full_attempts = (entry.full_attempts ?? 0) + 1;
  const out = path.join(OUT, 'full', safeName(model), `attempt-${entry.full_attempts}`);
  if (!dry) { entry.status = 'fulling'; entry.updated_at = now(); save(); }
  const run = dry ? { status: 0, error: null, duration_ms: 0, stdout: '', stderr: '' } : runStudy(model, out, null);
  const eps = dry ? [] : episodes(out);
  if (dry) { console.log(`[dry] full ${model}`); return true; }
  entry.full = { out, run, classification: eps.length === 90 ? 'full_complete' : 'full_incomplete', episodes: summarize(eps) };
  entry.status = eps.length === 90 ? 'full_complete' : 'full_incomplete';
  entry.last_error = run.error ?? (eps.length === 90 ? null : `full episodes ${eps.length}/90`);
  entry.updated_at = now();
  save();
  console.log(`[full] ${model} -> ${entry.status} (${eps.length}/90, ${Math.round(run.duration_ms / 1000)}s)`);
  return entry.status !== 'full_complete';
}
function report() {
  const entries = allModels.map(model => ({ model, ...(state.models[model] ?? { status: 'pending' }) }));
  writeFileSync(REPORT_JSON, JSON.stringify({ generated_at: now(), mode, wait_minutes: waitMinutes, max_passes: maxPasses, total_cap_usd: totalCap, total_spent_usd: spent(), models: entries }, null, 2) + '\n');
  const counts = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const lines = [
    `# ${label} screening matrix`, '',
    `Generated: ${now()}`,
    `Models: ${entries.length}`,
    `Total cap: $${totalCap}; observed spend: $${spent().toFixed(4)}`,
    `Status counts: ${JSON.stringify(counts)}`, '',
    '| Model | Status | Screen | Full | Next retry |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    const screen = entry.screen?.episodes?.map(e => `${e.condition}:${e.status}${e.correct ? ':correct' : ''}`).join(' ') ?? '';
    const full = entry.status === 'full_complete' ? '90/90' : entry.full ? `${entry.full.episodes?.length ?? 0}/90` : '';
    lines.push(`| \`${entry.model}\` | ${entry.status} | ${screen} | ${full} | ${entry.next_attempt_at ?? ''} |`);
  }
  writeFileSync(REPORT_MD, lines.join('\n') + '\n');
}

let pass = 0;
for (;;) {
  if (spent() >= totalCap) { console.log(`[cap] observed spend $${spent().toFixed(4)} >= cap $${totalCap}`); break; }
  let pending = false;
  for (const model of allModels) {
    const entry = state.models[model] ??= { status: 'pending', attempts: 0, screen: null, full: null };
    if (terminal.has(entry.status) || entry.status === 'full_complete') continue;
    if (entry.next_attempt_at && Date.parse(entry.next_attempt_at) > Date.now()) continue;
    if (mode !== 'full' && ['pending', 'quota_wait', 'auth_error', 'error', 'screening', 'provider_output'].includes(entry.status)) {
      if (screen(model)) pending = true;
    }
    if ((mode === 'all' || mode === 'full') && entry.status === 'screen_passed') {
      if (full(model)) pending = true;
    }
    if (['full_incomplete', 'fulling'].includes(entry.status) && (mode === 'all' || mode === 'full')) {
      if (full(model)) pending = true;
    }
  }
  report();
  pass++;
  if (dry) break;
  if (!pending) break;
  const nextAt = allModels
    .map(model => state.models[model]?.next_attempt_at)
    .filter(Boolean)
    .map(Date.parse)
    .filter(timestamp => Number.isFinite(timestamp) && timestamp > Date.now())
    .sort((a, b) => a - b)[0];
  if (!nextAt) break;
  if (noWait) break;
  if (maxPasses > 0 && pass >= maxPasses) break;
  const milliseconds = Math.max(1000, Math.min(waitMinutes * 60 * 1000, nextAt - Date.now()));
  console.log(`[wait] ${Math.ceil(milliseconds / 60000)} minutes; next retry ${new Date(nextAt).toISOString()} (pass ${pass})`);
  await sleep(milliseconds);
}
report();
console.log(`done: ${REPORT_MD}`);
