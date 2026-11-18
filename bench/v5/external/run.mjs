import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONDITIONS, REPO, claimOutput, deepFreeze, isMain, parseOptions,
  positiveInteger, readTasks, sha256, writeJSON,
} from './schema.mjs';

export function pluginEnvironment(condition, inherited = process.env) {
  if (!CONDITIONS.includes(condition)) throw new Error('unknown condition');
  const env = { ...inherited };
  // Windows environment keys are case-insensitive.
  for (const key of Object.keys(env)) {
    if (['MATH_TOOLKIT_DISABLE', 'MATH_TOOLKIT_TOOLSET'].includes(key.toUpperCase())) delete env[key];
  }
  if (condition === 'plugin-off') env.MATH_TOOLKIT_DISABLE = '1';
  return env;
}

export function resolveExecutable(env = process.env) {
  for (const directory of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const base = directory.replace(/^"|"$/g, '');
    for (const candidate of [
      path.join(base, 'opencode.exe'),
      path.join(base, 'node_modules/@opencode/cli/bin/opencode.exe'),
      path.join(base, 'opencode'),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'opencode';
}

const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const total = values => values.length && values.every(known) ? values.reduce((a, b) => a + b, 0) : null;

export function extractOutput(stdout) {
  const source = String(stdout ?? '').trim();
  let parsed;
  try { parsed = JSON.parse(source); }
  catch {
    try { parsed = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { return { text: '', usage: null, usage_records: [], parse_error: true, cli_error: false }; }
  }
  const events = Array.isArray(parsed) ? parsed : (parsed?.events ?? [parsed]);
  if (!Array.isArray(events)) return { text: '', usage: null, usage_records: [], parse_error: true, cli_error: false };
  const texts = [], steps = [], usages = [];
  let cliError = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'error') cliError = true;
    if (event.role && event.role !== 'assistant') continue;
    const part = event.part ?? event;
    if (event.type === 'step_finish') steps.push(part);
    if (event.usage && typeof event.usage === 'object') usages.push(event.usage);
    if (part !== event && part.usage && typeof part.usage === 'object') usages.push(part.usage);
    // Never recurse into tool input/output/state or reasoning text.
    if (event.type === 'text' && typeof part.text === 'string') {
      texts.push({ text: part.text, message: part.messageID ?? event.messageID });
    } else if (event.role === 'assistant' && Array.isArray(event.parts)) {
      texts.push({
        text: event.parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join(''),
        message: event.id ?? event.messageID,
      });
    }
  }
  const last = texts.at(-1);
  const text = !last ? '' : last.message
    ? texts.filter(item => item.message === last.message).map(item => item.text).join('')
    : last.text;
  let usage = null;
  if (steps.length) {
    usage = {
      input_tokens: total(steps.map(step => step.tokens?.input)),
      output_tokens: total(steps.map(step => step.tokens?.output)),
      reasoning_tokens: total(steps.map(step => step.tokens?.reasoning)),
      cache_read_tokens: total(steps.map(step => step.tokens?.cache?.read)),
      cache_write_tokens: total(steps.map(step => step.tokens?.cache?.write)),
      cost: total(steps.map(step => step.cost)),
      source: 'step_finish',
    };
  } else if (usages.length === 1) {
    const value = usages[0];
    usage = {
      input_tokens: value.input_tokens ?? value.prompt_tokens ?? value.tokens?.input ?? null,
      output_tokens: value.output_tokens ?? value.completion_tokens ?? value.tokens?.output ?? null,
      cost: value.cost ?? null,
      source: 'single_usage_record',
    };
    for (const key of ['input_tokens', 'output_tokens', 'cost']) if (!known(usage[key])) usage[key] = null;
  }
  // Multiple generic usage records may be cumulative or incremental: do not guess.
  return { text, usage, usage_records: [...steps.map(step => ({ type: 'step_finish', ...step })), ...usages],
    parse_error: false, cli_error: cliError };
}

export function runStudy(options, dependencies = {}) {
  const { io = fs, runner = spawnSync, now = Date.now, inheritedEnv = process.env, repo = REPO } = dependencies;
  const { tasksFile, model, condition } = options;
  if (typeof model !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error('explicit provider/model required');
  const env = pluginEnvironment(condition, inheritedEnv);
  const timeoutMs = positiveInteger(options.timeoutMs ?? 300000, 'timeout-ms');
  const repeat = positiveInteger(options.repeat ?? 1, 'repeat');
  const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, 'limit');
  const { tasks: allTasks, hash } = readTasks(tasksFile, io);
  const tasks = limit === undefined ? allTasks : allTasks.slice(0, limit);
  const workspace = path.resolve(options.workspace ?? inheritedEnv.EXTERNAL_BENCH_WORKSPACE ?? 'C:/_Work/__OPENAI_MATH');
  const executable = dependencies.executable ?? resolveExecutable(env);
  const out = claimOutput(options.out, { io, repo });
  io.mkdirSync(path.join(out, 'episodes'));
  const started = now();
  const schedule = tasks.flatMap((task, index) => Array.from({ length: repeat }, (_, r) => ({
    episode_id: `t${index + 1}-r${r + 1}`, benchmark: task.benchmark, task_id: task.id, repeat: r + 1,
    prompt_sha256: sha256(task.prompt),
  })));
  const plan = deepFreeze({
    schema: 'math-bench-manifest/v1', exploratory: true, not_confirmatory: true,
    model, condition, workspace, executable, task_file: path.resolve(tasksFile), task_file_sha256: hash,
    task_ids: tasks.map(task => ({ benchmark: task.benchmark, id: task.id })), repeat,
    timeout_ms: timeoutMs, started_at: new Date(started).toISOString(),
    plugin_env: { MATH_TOOLKIT_DISABLE: env.MATH_TOOLKIT_DISABLE ?? null, MATH_TOOLKIT_TOOLSET: env.MATH_TOOLKIT_TOOLSET ?? null },
    protocol: { retries: 0, fallback: false, resume: false, prompt: 'exact task.prompt', transport: 'single argv after --' },
    schedule,
  });
  // Immutable pre-dispatch plan survives interruption. Final manifest is written once.
  writeJSON(io, path.join(out, 'plan.json'), plan);
  const episodes = [];
  for (const row of schedule) {
    const task = tasks.find(task => task.benchmark === row.benchmark && task.id === row.task_id);
    const begin = now();
    let result;
    try {
      result = runner(executable, ['run', '--model', model, '--format', 'json', '--standalone', '--', task.prompt], {
        cwd: workspace, env: { ...env }, shell: false, windowsHide: true,
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) { result = { error, status: null }; }
    const duration = now() - begin;
    const stdout = String(result.stdout ?? '');
    const parsed = extractOutput(stdout);
    const timeout = result.error?.code === 'ETIMEDOUT';
    const failure = timeout ? 'timeout' : result.error ? 'spawn_error' : result.signal ? 'signal'
      : result.status !== 0 ? 'nonzero_exit' : parsed.parse_error ? 'invalid_json'
        : parsed.cli_error ? 'cli_error' : !parsed.text.trim() ? 'empty_answer' : null;
    const episode = {
      schema: 'math-bench-episode/v1', ...row, model, condition, attempted: true,
      started_at: new Date(begin).toISOString(), duration_ms: duration,
      status: failure ? (timeout ? 'timeout' : 'failed') : 'completed',
      failure, exit_code: result.status ?? null, signal: result.signal ?? null, error_code: result.error?.code ?? null,
      error: result.error?.message ?? null, text: parsed.text, usage: parsed.usage, usage_records: parsed.usage_records,
      raw_file: `${row.episode_id}.raw.json`, stderr: String(result.stderr ?? ''),
    };
    // Raw stdout remains byte-for-byte text even if CLI JSON is malformed/partial.
    io.writeFileSync(path.join(out, 'episodes', episode.raw_file), stdout, { encoding: 'utf8', flag: 'wx' });
    writeJSON(io, path.join(out, 'episodes', `${row.episode_id}.json`), episode);
    episodes.push(episode);
  }
  const manifest = deepFreeze({ ...plan, ended_at: new Date(now()).toISOString(),
    episodes: episodes.map(({ episode_id, status, failure }) => ({ episode_id, status, failure })) });
  writeJSON(io, path.join(out, 'manifest.json'), manifest);
  return { manifest, episodes };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseOptions(argv, ['--tasks', '--model', '--condition', '--out', '--limit', '--timeout-ms', '--repeat']);
  for (const name of ['--tasks', '--model', '--condition', '--out']) if (!args[name]) throw new Error(`${name} required`);
  const result = runStudy({
    tasksFile: args['--tasks'], model: args['--model'], condition: args['--condition'], out: args['--out'],
    limit: args['--limit'], timeoutMs: args['--timeout-ms'], repeat: args['--repeat'],
  });
  console.log(`Captured ${result.episodes.length} episodes; exploratory, not confirmatory.`);
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
