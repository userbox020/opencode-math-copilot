import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONDITIONS = ['plugin-on', 'plugin-on-minimal', 'plugin-off', 'plugin-on-verify'];

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

function pluginEnvironment(condition, mathRoot = '') {
  throw new Error('legacy_toolkit_bootstrap_disabled: historical conditions are archive metadata only');
}

function promptFor(task) {
  return `Prove or disprove the following conjecture in Lean 4.34.1 with mathlib.
The frozen definition arxivleanConjecture is the original conjecture P.
Do not infer that it is true or false from the task or the initial template.

Submit exactly one complete Lean code block, including the unchanged supplied
definitions and all your helper lemmas. Choose EXACTLY ONE of these endings:
  theorem arxivlean_proof : arxivleanConjecture := by
    <proof of P>
OR
  theorem arxivlean_disproof : Not arxivleanConjecture := by
    <proof of the negation of the entire P>

The theorem name is your explicit prove/disprove verdict. A Boolean answer,
an informal counterexample, or a proof of the disjunction Or P (Not P) is not a
solution.
Preserve all definitions and hypotheses. No sorry, admit, new axioms,
native_decide, additional assumptions, or weakened statements are allowed.
The comparator checks your theorem and its dependencies against a separate
frozen challenge. It does NOT replace or repair your theorem header.
You may use verify_submission to check the complete code with this grader.

Conjecture:
${task.problem}

Frozen definitions:
\`\`\`lean
${task.formal_statement}
\`\`\``;
}

function parseJSONOutput(stdout) {
  const text = String(stdout ?? '').trim();
  try { return JSON.parse(text); } catch {}
  // OpenCode normally emits NDJSON; retain all events for tool/usage accounting.
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  try { return lines.map(line => JSON.parse(line)); } catch {}
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  for (const match of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) {
    try { return JSON.parse(match[1]); } catch {}
  }
  return null;
}

function extractOutput(stdout) {
  const parsed = parseJSONOutput(stdout);
  const tools = [];
  const mathTools = [];
  const toolEvents = [];
  const steps = [];
  let usage = null;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value.tool === 'string') {
      tools.push(value.tool);
      if (value.tool.startsWith('math_')) mathTools.push(value.tool);
      const code = value.state?.input?.code ?? value.input?.code;
      if (typeof code === 'string') {
        for (const match of code.matchAll(/tools\.(math_[a-z_]+)/g)) mathTools.push(match[1]);
      }
      const input = value.state?.input ?? value.input ?? null;
      const output = value.state?.output ?? value.output ?? null;
      toolEvents.push({
        tool: value.tool,
        status: value.state?.status ?? value.status ?? null,
        input: truncate(JSON.stringify(input), 1500),
        output: truncate(typeof output === 'string' ? output : JSON.stringify(output), 3000),
      });
    }
    if (value.usage && typeof value.usage === 'object') usage = value.usage;
    if (value.type === 'step_finish') steps.push(value.part ?? value);
    for (const [key, child] of Object.entries(value)) {
      // Do not mistake tool results or input payloads for assistant events.
      if (!['state', 'input', 'output', 'usage'].includes(key)) visit(child);
    }
  }
  visit(parsed);
  if (usage === null && steps.length) {
    const costs = steps.map(step => step.cost).filter(value => typeof value === 'number' && Number.isFinite(value));
    usage = {
      tokens: steps.reduce((sum, step) => sum + (Number(step.tokens?.input) || 0) + (Number(step.tokens?.output) || 0), 0),
      cost: costs.length === steps.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    };
  }
  function assistantText(value) {
    if (!value || typeof value !== 'object' || (value.role && value.role !== 'assistant')) return '';
    if (typeof value.text === 'string' && (!value.type || value.type === 'text')) return value.text;
    if (Array.isArray(value.parts)) return value.parts.map(assistantText).join('');
    if (value.type === 'text') return assistantText(value.part);
    return '';
  }
  const events = Array.isArray(parsed) ? parsed : (parsed?.events ?? [parsed]);
  const texts = events.filter(event => assistantText(event));
  const lastMessage = texts.at(-1)?.part?.messageID ?? texts.at(-1)?.messageID;
  const finalEvents = lastMessage
    ? texts.filter(event => (event.part?.messageID ?? event.messageID) === lastMessage)
    : texts;
  return { text: finalEvents.map(assistantText).join(''), tools, math_tools: mathTools, usage, tool_events: toolEvents };
}

function truncate(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

function writeJSON(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  // Check both gates before resolving executables, reading tasks, or creating output.
  if (!args.includes('--execute') || process.env.NORMAL_USE_ALLOW_EXECUTE !== '1') {
    throw new Error('execution_not_authorized: pass --execute and set NORMAL_USE_ALLOW_EXECUTE=1');
  }
  // No readiness file can unlock this historical implementation. Keep the archive
  // parsing/output code below as legacy information, not an executable backend.
  throw new Error('legacy_runner_deprecated: admission_blocked; validated backend and independent checker are not integrated. Use preflight-arxivlean.mjs or the v4 real-use dry-run. --readiness cannot authorize this runner.');
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
    return args[index + 1];
  };
  const outOption = option('--out', null);
  if (!outOption) throw new Error('--out is required');
  const out = path.resolve(outOption);
  const model = option('--model', 'opencode-go/deepseek-v4.1-flash');
  const tasksFile = path.resolve(option('--tasks', path.join(HERE, 'tasks/arxivlean-smoke5.json')));
  const only = option('--condition', 'all');
  if (only !== 'all' && !CONDITIONS.includes(only)) throw new Error(`Unknown condition: ${only}`);
  const conditions = CONDITIONS.filter(condition => only === 'all' || only === condition);
  const limit = Number(option('--limit', '0'));
  const timeoutMs = Number(option('--timeout-ms', '900000'));
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('--limit must be a nonnegative integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  const workspace = process.env.ARXIVLEAN_WORKSPACE || 'C:/_Work/__OPENAI_MATH';
  const mathRoot = option('--math-root', process.env.MATH_TOOLKIT_MATH_ROOT || '');
  const allTasks = JSON.parse(readFileSync(tasksFile, 'utf8'));
  const tasks = limit ? allTasks.slice(0, limit) : allTasks;
  const executable = resolveExecutable();
  mkdirSync(path.join(out, 'episodes'), { recursive: true });
  mkdirSync(path.join(out, 'submissions'), { recursive: true });
  const manifest = {
    schema: 'arxivlean-manifest/v1', generated_at: new Date().toISOString(),
    model, workspace, math_root: mathRoot, task_file: tasksFile, conditions, timeout_ms: timeoutMs,
    tasks: tasks.map(task => ({ id: task.id, problem_idx: task.problem_idx, arxiv_id: task.arxiv_id })),
    protocol: 'Model output only; separate Comparator grading required.',
    episodes: [],
  };
  const manifestFile = path.join(out, 'manifest.json');
  writeJSON(manifestFile, manifest);
  for (const condition of conditions) {
    for (const task of tasks) {
      const name = `${task.id}.${condition}`;
      const episodeFile = path.join(out, 'episodes', `${name}.json`);
      let episode;
      const skipped = existsSync(episodeFile) && !args.includes('--force');
      if (skipped) {
        episode = JSON.parse(readFileSync(episodeFile, 'utf8'));
      } else {
        const started = Date.now();
        const result = spawnSync(executable, ['run', '--model', model, '--format', 'json', '--standalone', '--', promptFor(task)], {
          cwd: workspace, env: pluginEnvironment(condition, mathRoot), shell: false, windowsHide: true,
          encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
        });
        const parsed = extractOutput(result.stdout);
        const match = /```lean\s*\n([\s\S]*?)```/i.exec(parsed.text);
        const submissionPath = path.join(out, 'submissions', `${name}.lean`);
        writeFileSync(submissionPath, (match ? match[1] : parsed.text).replace(/\r\n?/g, '\n'), 'utf8');
        const timedOut = result.error?.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(result.error?.message ?? ''));
        episode = {
          task_id: task.id, problem_idx: task.problem_idx, arxiv_id: task.arxiv_id,
          condition, model, workspace, math_root: mathRoot,
          status: !result.error && result.status === 0 && parsed.text.trim() ? 'completed' : (timedOut ? 'timeout' : 'failed'),
          duration_ms: Date.now() - started, exit_code: result.status,
          error_code: result.error?.code ?? null,
          tools: parsed.tools, math_tools: parsed.math_tools, tool_events: parsed.tool_events,
          text: parsed.text, usage: parsed.usage,
          stderr: [result.stderr, result.error?.message].filter(Boolean).join('\n').slice(0, 4000),
          raw_stdout: String(result.stdout ?? '').slice(0, 200000),
          lean_block_found: Boolean(match), submission_path: submissionPath,
        };
        writeJSON(episodeFile, episode);
      }
      manifest.episodes.push({ task_id: task.id, condition, status: episode.status, episode_path: episodeFile, skipped });
      writeJSON(manifestFile, manifest);
      console.log(`[${condition}] ${task.id} -> ${episode.status} (${episode.tools.length} tools, ${Math.round(episode.duration_ms / 1000)}s, leanBlock=${episode.lean_block_found ? 'yes' : 'no'})`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
