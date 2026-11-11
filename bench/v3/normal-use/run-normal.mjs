import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'C:/_Work/opencode-math-copilot';
const WORKSPACE = 'C:/_Work/__OPENAI_MATH';
const OUT_DEFAULT = 'C:/Users/MiPC/AppData/Local/Temp/opencode/normal-use';
const TASKS_DEFAULT = path.join(HERE, 'tasks/normal-v1.json');
const EXECUTE_ENV = 'NORMAL_USE_ALLOW_EXECUTE';
const CONDITIONS = ['plugin-on', 'plugin-on-minimal', 'plugin-off'];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const hasFlag = name => args.includes(name);
const model = option('--model', 'opencode-go/deepseek-v4.1-flash');
const out = path.resolve(option('--out', OUT_DEFAULT));
const tasksFile = path.resolve(option('--tasks', TASKS_DEFAULT));
const limit = Math.max(0, Number(option('--limit', '0')) || 0);
const repeat = Math.max(1, Number(option('--repeat', '1')) || 1);
const timeoutMs = Math.max(1000, Number(option('--timeout-ms', '600000')) || 600000);
const only = option('--condition', null);
const dryRun = hasFlag('--dry-run');
const execute = hasFlag('--execute');
const conditions = only ? [only] : CONDITIONS;
for (const condition of conditions) {
  if (!CONDITIONS.includes(condition)) throw new Error(`Unknown condition: ${condition}`);
}
if (execute && process.env[EXECUTE_ENV] !== '1') throw new Error(`execution_not_authorized: set ${EXECUTE_ENV}=1`);

function resolveExecutable(env = process.env) {
  for (const directory of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const base = directory.replace(/^"|"$/g, '');
    for (const candidate of [
      path.join(base, 'opencode.exe'),
      path.join(base, 'node_modules/@opencode/cli/bin/opencode.exe'),
      path.join(base, 'opencode'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'opencode';
}

export function pluginEnvironment(condition, environment = process.env) {
  const env = { ...environment };
  delete env.MATH_TOOLKIT_DISABLE;
  delete env.MATH_TOOLKIT_TOOLSET;
  if (condition === 'plugin-off') env.MATH_TOOLKIT_DISABLE = '1';
  else if (condition === 'plugin-on-minimal') env.MATH_TOOLKIT_TOOLSET = 'minimal';
  return env;
}

export function normalPrompt(task) {
  return `${task.prompt}\n\nAnswer naturally in prose. Do not wrap the whole answer in a JSON object unless the request explicitly requires it. If you use the corpus, cite the document and locator where relevant. Do not modify repository files.`;
}

export function parseNormalEvents(stdout) {
  const events = [];
  try {
    for (const line of String(stdout ?? '').split(/\r?\n/).filter(line => line.trim())) {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && typeof event.type === 'string') events.push(event);
    }
  } catch (error) {
    return { status: 'extraction_failure', final_text: null, events, error: `NDJSON parse failed: ${error.message}`, session_id: null, usage: null, tools: [] };
  }
  const sessionID = events.find(event => typeof event.sessionID === 'string')?.sessionID ?? null;
  const errorEvent = events.findLast(event => event.type === 'error' && event.error);
  if (errorEvent) {
    return {
      status: 'operational_failure', final_text: null, events,
      error: errorEvent.error.message ?? errorEvent.error.type ?? 'provider_error',
      session_id: sessionID, usage: null, tools: [],
    };
  }
  const texts = events.filter(event => event.type === 'text' && typeof event.part?.text === 'string');
  const lastMessage = texts[texts.length - 1]?.part?.messageID;
  const finalText = lastMessage
    ? texts.filter(event => event.part?.messageID === lastMessage).map(event => event.part.text).join('')
    : texts.map(event => event.part.text).join('');
  const toolEvents = events.filter(event => event.type === 'tool_use');
  const tools = toolEvents.map(event => String(event.part?.tool ?? 'unknown'));
  const mathTools = [];
  for (const event of toolEvents) {
    const tool = String(event.part?.tool ?? '');
    if (tool.startsWith('math_')) mathTools.push(tool);
    const code = event.part?.state?.input?.code;
    if (typeof code === 'string') {
      for (const match of code.matchAll(/tools\.(math_[a-z_]+)/g)) mathTools.push(match[1]);
    }
  }
  const steps = events.filter(event => event.type === 'step_finish');
  const costs = steps.map(event => event.part?.cost).filter(value => typeof value === 'number' && Number.isFinite(value));
  const tokens = steps.reduce((sum, event) => sum + (Number(event.part?.tokens?.input) || 0) + (Number(event.part?.tokens?.output) || 0), 0);
  return {
    status: finalText.trim() ? 'completed' : 'extraction_failure',
    final_text: finalText,
    events,
    error: finalText.trim() ? null : 'No final assistant text',
    session_id: sessionID,
    usage: steps.length ? { tokens, cost: costs.length === steps.length ? costs.reduce((sum, cost) => sum + cost, 0) : null } : null,
    tools,
    math_tools: mathTools,
  };
}

function taskList() {
  const tasks = JSON.parse(readFileSync(tasksFile, 'utf8'));
  const selected = limit ? tasks.slice(0, limit) : tasks;
  return selected.map(task => ({ ...task, normal_prompt: normalPrompt(task) }));
}

function writeReview(episodes, tasks) {
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const grouped = new Map();
  for (const episode of episodes) {
    const list = grouped.get(episode.task_id) ?? [];
    list.push(episode);
    grouped.set(episode.task_id, list);
  }
  const md = ['# Normal-use review', '', 'Score each response 0/1 in `review.csv`; add notes. The automated runner does not assign correctness.', ''];
  const csv = ['task_id,condition,status,score,notes'];
  for (const [taskID, list] of grouped) {
    const task = byTask.get(taskID);
    md.push(`## ${taskID}`, '', `**Task:** ${clean(task?.prompt ?? '')}`, '', `**Reference:** ${clean(task?.correct_final ? JSON.stringify(task.correct_final) : 'No reference supplied')}`, '');
    for (const episode of list) {
      md.push(`### ${episode.condition} — ${episode.status}`, '', '```text', clean(episode.final_text ?? episode.error ?? '(no text)', 12000), '```', '');
    }
    for (const episode of list) csv.push(`${csvCell(taskID)},${csvCell(episode.condition)},${csvCell(episode.status)},,`);
  }
  writeFileSync(path.join(out, 'review.md'), md.join('\n') + '\n');
  writeFileSync(path.join(out, 'review.csv'), csv.join('\n') + '\n');
}

function clean(value, max = 4000) {
  return String(value ?? '').replace(/\r/g, '').slice(0, max);
}
function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}
function summarize(episodes) {
  const groups = {};
  for (const condition of conditions) {
    const list = episodes.filter(episode => episode.condition === condition);
    groups[condition] = {
      episodes: list.length,
      completed: list.filter(episode => episode.status === 'completed').length,
      operational_failures: list.filter(episode => episode.status === 'operational_failure').length,
      extraction_failures: list.filter(episode => episode.status === 'extraction_failure').length,
      mean_duration_ms: list.length ? Math.round(list.reduce((sum, episode) => sum + episode.duration_ms, 0) / list.length) : null,
      tokens: list.reduce((sum, episode) => sum + (Number(episode.usage?.tokens) || 0), 0),
      cost_usd: Number(list.reduce((sum, episode) => sum + (Number(episode.usage?.cost) || 0), 0).toFixed(6)),
      tool_calls: list.reduce((sum, episode) => sum + episode.tools.length, 0),
      math_tool_calls: list.reduce((sum, episode) => sum + (episode.math_tools?.length ?? 0), 0),
    };
  }
  return groups;
}

function main() {
  const tasks = taskList();
  const executable = resolveExecutable();
  const studyId = `normal-use-${new Date().toISOString().replace(/[:.]/g, '-')}-${model.replace(/[^a-z0-9._-]+/gi, '-')}`;
  if (dryRun) {
    for (const task of tasks) for (const condition of conditions) {
      console.log(JSON.stringify({ study_id: studyId, task: task.id, condition, model, command: [executable, 'run', '--model', model, '--format', 'json', '--standalone', '--', task.normal_prompt], workspace: WORKSPACE, plugin: condition }, null, 2));
    }
    return;
  }
  mkdirSync(out, { recursive: true });
  const manifest = {
    schema: 'normal-use-manifest/v1', study_id: studyId, generated_at: new Date().toISOString(),
    model, workspace: WORKSPACE, task_file: tasksFile, conditions, repeat,
    protocol: 'normal OpenCode run; free-form final text; no typed answer contract; human review required',
    tasks: tasks.map(task => ({ id: task.id, type: task.type, family: task.family, prompt: task.normal_prompt })),
  };
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const episodeFile = path.join(out, 'episodes.jsonl');
  const episodes = [];
  for (const task of tasks) {
    for (const condition of conditions) {
      for (let repeatId = 1; repeatId <= repeat; repeatId++) {
        const prompt = task.normal_prompt;
        const command = [executable, 'run', '--model', model, '--format', 'json', '--standalone', '--', prompt];
        const env = pluginEnvironment(condition);
        const started = Date.now();
        const result = spawnSync(executable, command.slice(1), {
          cwd: WORKSPACE, env, shell: false, encoding: 'utf8', windowsHide: true,
          timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
        });
        const parsed = parseNormalEvents(result.stdout);
        const episode = {
          schema: 'normal-use-episode/v1', study_id: studyId, model, task_id: task.id, task_type: task.type,
          family: task.family, condition, repeat_id: repeatId, plugin_enabled: condition !== 'plugin-off',
          toolset: condition === 'plugin-on-minimal' ? 'minimal' : condition === 'plugin-on' ? 'full' : null,
          status: result.error ? 'operational_failure' : parsed.status,
          final_text: clean(parsed.final_text, 20000),
          error: result.error?.message ?? parsed.error,
          tools: parsed.tools,
          math_tools: parsed.math_tools ?? [],
          usage: parsed.usage,
          duration_ms: Date.now() - started,
          started_at: new Date().toISOString(),
          exit_code: result.status,
          session_id: parsed.session_id,
        };
        episodes.push(episode);
        writeFileSync(episodeFile, JSON.stringify(episode) + '\n', { flag: 'a' });
        console.log(`[${condition}] ${task.id} -> ${episode.status} (${episode.tools.length} tools, ${Math.round(episode.duration_ms / 1000)}s)`);
      }
    }
  }
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ generated_at: new Date().toISOString(), study_id: studyId, model, conditions: summarize(episodes), review_required: true }, null, 2) + '\n');
  writeReview(episodes, tasks);
  console.log(`done ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (execute || dryRun) main();
  else console.log('Dry plan only. Pass --execute with NORMAL_USE_ALLOW_EXECUTE=1 to run, or --dry-run to print commands.');
}
