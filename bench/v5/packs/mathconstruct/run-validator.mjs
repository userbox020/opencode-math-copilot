import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractOutput, pluginEnvironment, resolveExecutable } from '../../external/run.mjs';
import {
  REPO, claimOutput, isMain, parseOptions, positiveInteger, sha256, writeJSON,
} from '../../external/schema.mjs';
import { validate } from './validator/bridge.mjs';
import { parseFinalAnswer } from './parse-answer.mjs';

export { pluginEnvironment };

function readValidatorTasks(file, io) {
  const bytes = io.readFileSync(file);
  const tasks = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('nonempty task array required');
  const seen = new Set();
  for (const task of tasks) {
    if (task?.schema !== 'math-bench-task/v1' || task.benchmark !== 'mathconstruct' ||
        typeof task.id !== 'string' || !/^[\w-]+$/.test(task.id) ||
        typeof task.prompt !== 'string' || !task.prompt.trim() ||
        task.grading?.type !== 'validator' ||
        typeof task.grading.validator !== 'string' || !task.grading.validator ||
        typeof task.grading.answer_format !== 'string' ||
        !task.metadata || typeof task.metadata !== 'object') throw new Error('invalid validator task');
    if (seen.has(task.id)) throw new Error('duplicate task id');
    seen.add(task.id);
  }
  return { tasks, hash: sha256(bytes) };
}

export function gradeAnswer(task, text, { validator = validate, python, bridgeRunner = spawnSync } = {}) {
  const parsed = parseFinalAnswer(text, { answerFormat: task.grading.answer_format });
  if (!text.trim()) return { status: 'missing', parsed, receipt: null };
  if (parsed.status !== 'parsed') return { status: 'unparseable', parsed, receipt: null };
  let receipt;
  try {
    receipt = validator({ task_id: task.id, answer: parsed.value }, {
      python,
      run: (executable, args, options) => bridgeRunner(executable, args, {
        ...options, timeout: 10000, windowsHide: true,
      }),
    });
    if (!receipt || receipt.schema !== 'mathconstruct-validator/v1' || receipt.task_id !== task.id ||
        !['accepted', 'rejected', 'unavailable'].includes(receipt.status) ||
        typeof receipt.tag !== 'string' || !receipt.tag || typeof receipt.reason !== 'string') {
      throw new Error('Invalid validator receipt');
    }
  } catch (error) {
    receipt = { schema: 'mathconstruct-validator/v1', task_id: task.id,
      status: 'unavailable', tag: 'BRIDGE_ERROR', reason: String(error.message ?? error) };
  }
  // Representation failures are not evidence of mathematical incorrectness.
  const status = receipt.tag === 'MALFORMED_ANSWER' ? 'unparseable'
    : ['INVALID_JSON', 'INVALID_REQUEST'].includes(receipt.tag) ? 'unavailable' : receipt.status;
  return { status, parsed, receipt };
}

export function runStudy(options, dependencies = {}) {
  const { io = fs, runner = spawnSync, now = Date.now, inheritedEnv = process.env, repo = REPO } = dependencies;
  const { tasksFile, model, condition } = options;
  if (typeof model !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error('explicit provider/model required');
  const env = pluginEnvironment(condition, inheritedEnv);
  const timeoutMs = positiveInteger(options.timeoutMs ?? 300000, 'timeout-ms');
  const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, 'limit');
  const workspace = inheritedEnv.EXTERNAL_BENCH_WORKSPACE;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
    throw new Error('EXTERNAL_BENCH_WORKSPACE must name an absolute clean workspace');
  }
  const { tasks: allTasks, hash } = readValidatorTasks(tasksFile, io);
  const tasks = limit === undefined ? allTasks : allTasks.slice(0, limit);
  const executable = dependencies.executable ?? resolveExecutable(env);
  const python = dependencies.python ?? inheritedEnv.MATHCONSTRUCT_PYTHON ?? 'python';
  const out = claimOutput(options.out, { io, repo });
  io.mkdirSync(path.join(out, 'episodes'));
  const started = now();
  const plan = {
    schema: 'mathconstruct-validator-manifest/v1', exploratory: true, not_confirmatory: true,
    model, condition, workspace, executable, python,
    task_file: path.resolve(tasksFile), task_file_sha256: hash,
    timeout_ms: timeoutMs, validator_timeout_ms: 10000,
    started_at: new Date(started).toISOString(),
    plugin_env: { MATH_TOOLKIT_DISABLE: env.MATH_TOOLKIT_DISABLE ?? null, MATH_TOOLKIT_TOOLSET: env.MATH_TOOLKIT_TOOLSET ?? null },
    protocol: { retries: 0, fallback: false, resume: false, prompt: 'exact task.prompt', transport: 'single argv after --' },
    schedule: tasks.map((task, index) => ({
      episode_id: `t${index + 1}-r1`, benchmark: task.benchmark, task_id: task.id, repeat: 1,
      prompt_sha256: sha256(task.prompt),
    })),
  };
  writeJSON(io, path.join(out, 'plan.json'), plan);
  const episodes = [];
  for (const [index, task] of tasks.entries()) {
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
    const captured = extractOutput(stdout);
    const timeout = result.error?.code === 'ETIMEDOUT';
    const failure = timeout ? 'timeout' : result.error ? 'spawn_error' : result.signal ? 'signal'
      : result.status !== 0 ? 'nonzero_exit' : captured.parse_error ? 'invalid_json'
        : captured.cli_error ? 'cli_error' : !captured.text.trim() ? 'empty_answer' : null;
    // Partial output from a failed capture must never become accepted.
    const validation = failure
      ? { status: 'missing', parsed: { status: 'unparseable', value: null, reason: `Capture failed: ${failure}` }, receipt: null }
      : gradeAnswer(task, captured.text, { ...dependencies, python });
    const episode = {
      schema: 'mathconstruct-validator-episode/v1', exploratory: true, not_confirmatory: true,
      ...plan.schedule[index], model, condition, attempted: true,
      started_at: new Date(begin).toISOString(), duration_ms: duration,
      status: failure ? (timeout ? 'timeout' : 'failed') : 'completed', failure,
      exit_code: result.status ?? null, signal: result.signal ?? null,
      error_code: result.error?.code ?? null, error: result.error?.message ?? null,
      text: captured.text, usage: captured.usage, usage_records: captured.usage_records,
      parse: validation.parsed, parsed_value: validation.parsed.value,
      validation_status: validation.status, validator_receipt: validation.receipt,
      raw_file: `${plan.schedule[index].episode_id}.raw.json`, stderr: String(result.stderr ?? ''),
    };
    io.writeFileSync(path.join(out, 'episodes', episode.raw_file), stdout, { encoding: 'utf8', flag: 'wx' });
    writeJSON(io, path.join(out, 'episodes', `${episode.episode_id}.json`), episode);
    episodes.push(episode);
  }
  const counts = Object.fromEntries(['accepted', 'rejected', 'unparseable', 'unavailable', 'missing']
    .map(status => [status, episodes.filter(episode => episode.validation_status === status).length]));
  const manifest = { ...plan, ended_at: new Date(now()).toISOString(), validation_counts: counts,
    episodes: episodes.map(({ episode_id, status, failure, validation_status }) => ({ episode_id, status, failure, validation_status })) };
  writeJSON(io, path.join(out, 'manifest.json'), manifest);
  return { manifest, episodes };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseOptions(argv, ['--tasks', '--model', '--condition', '--out', '--limit', '--timeout-ms']);
  for (const flag of ['--tasks', '--model', '--condition', '--out']) if (!args[flag]) throw new Error(`${flag} required`);
  const result = runStudy({
    tasksFile: args['--tasks'], model: args['--model'], condition: args['--condition'], out: args['--out'],
    limit: args['--limit'], timeoutMs: args['--timeout-ms'],
  });
  console.log(JSON.stringify({ exploratory: true, validation_counts: result.manifest.validation_counts }));
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
