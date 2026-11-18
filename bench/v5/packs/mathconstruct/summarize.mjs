import fs from 'node:fs';
import path from 'node:path';
import {
  CONDITIONS, REPO, assertFreshOutput, claimOutput, isMain, parseOptions, sha256, writeJSON,
} from '../../external/schema.mjs';

const STATUSES = ['accepted', 'rejected', 'unparseable', 'unavailable', 'missing'];
const OUTCOMES = ['both_accepted', 'on_only_accepted', 'off_only_accepted', 'neither', 'ungraded'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unique = values => [...new Set(values)].sort(compare);
const sorted = counts => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compare(a, b)));
const increment = (counts, name, n = 1) => { counts[name] = (counts[name] ?? 0) + n; };
const key = row => JSON.stringify([row.task_id, row.repeat]);
const order = (a, b) => compare(a.task_id, b.task_id) || a.repeat - b.repeat;
const category = rows => ({
  count: rows.length,
  task_ids: unique(rows.map(row => row.task_id)),
  slots: rows.map(({ task_id, repeat }) => ({ task_id, repeat })),
});

// Read only tool event inputs, never answer text, prompts, reasoning, or outputs.
// This intentionally shares the extraction idea, not imports, with analyze.mjs.
export function parseToolEvents(raw) {
  const events = [];
  let malformedLines = 0;
  try {
    const parsed = JSON.parse(raw);
    events.push(...(Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [parsed]));
  } catch {
    for (const line of String(raw).split(/\r?\n/).filter(line => line.trim())) {
      try { events.push(JSON.parse(line)); } catch { malformedLines++; }
    }
  }
  const calls = new Map();
  for (const event of events) {
    if (!event || (event.role && event.role !== 'assistant')) continue;
    for (const part of Array.isArray(event.parts) ? event.parts : [event.part ?? event]) {
      if (!part || typeof part.tool !== 'string' || ['text', 'reasoning'].includes(part.type ?? event.type)) continue;
      const id = part.callID ?? part.id;
      const identity = id === undefined ? Symbol() : JSON.stringify([part.sessionID ?? event.sessionID, part.tool, id]);
      calls.set(identity, { tool: part.tool, code: part.state?.input?.code ?? calls.get(identity)?.code });
    }
  }
  const direct = Object.create(null), nested = Object.create(null);
  for (const { tool, code } of calls.values()) {
    increment(direct, tool);
    if (tool !== 'execute' || typeof code !== 'string') continue;
    const stripped = code.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
      match => ' '.repeat(match.length),
    );
    for (const match of stripped.matchAll(/\btools\s*\.\s*(math_[A-Za-z0-9_]+)\s*\(/g)) increment(nested, match[1]);
  }
  const counts = Object.assign(Object.create(null), direct);
  for (const [name, n] of Object.entries(nested)) increment(counts, name, n);
  return {
    call_sites: sorted(counts), direct_tool_events: sorted(direct),
    nested_math_call_sites: sorted(nested), malformed_lines: malformedLines,
  };
}

function readOptional(io, file) {
  try { return io.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function loadRun(run, tasks, hash, io) {
  const manifestText = readOptional(io, path.join(run, 'manifest.json'));
  const source = manifestText === null ? 'plan.json' : 'manifest.json';
  const manifest = JSON.parse(manifestText ?? io.readFileSync(path.join(run, source), 'utf8'));
  if (manifest.schema !== 'mathconstruct-validator-manifest/v1' || manifest.task_file_sha256 !== hash ||
      !CONDITIONS.includes(manifest.condition) || !Array.isArray(manifest.schedule) ||
      typeof manifest.model !== 'string') throw new Error('task/manifest mismatch');
  const ids = new Set(), slots = new Set();
  const rows = manifest.schedule.map(scheduled => {
    const task = tasks.get(scheduled.task_id);
    if (!task || scheduled.benchmark !== 'mathconstruct' || scheduled.prompt_sha256 !== sha256(task.prompt) ||
        !/^t\d+-r\d+$/.test(scheduled.episode_id) || ids.has(scheduled.episode_id) || slots.has(key(scheduled)) ||
        !Number.isSafeInteger(scheduled.repeat) || scheduled.repeat < 1) throw new Error('invalid schedule identity');
    ids.add(scheduled.episode_id);
    slots.add(key(scheduled));
    const episodeText = readOptional(io, path.join(run, 'episodes', `${scheduled.episode_id}.json`));
    const episode = episodeText === null ? null : JSON.parse(episodeText);
    if (episode && (episode.schema !== 'mathconstruct-validator-episode/v1' ||
        ['episode_id', 'benchmark', 'task_id', 'repeat', 'prompt_sha256'].some(field => episode[field] !== scheduled[field]) ||
        episode.model !== manifest.model || episode.condition !== manifest.condition)) throw new Error('episode identity mismatch');
    const status = episode?.validation_status ?? 'missing';
    if (!STATUSES.includes(status)) throw new Error('unknown validation status');
    const timeout = episode?.status === 'timeout' || episode?.failure === 'timeout' || episode?.error_code === 'ETIMEDOUT';
    const captureFailed = Boolean(episode && (timeout || episode.status === 'failed' || episode.failure ||
      episode.error || episode.error_code || episode.signal || episode.exit_code !== 0));
    const completed = episode?.status === 'completed' && !captureFailed;
    if (!completed && status !== 'missing') throw new Error('capture/validation mismatch');
    const receipt = episode?.validator_receipt;
    if (['accepted', 'rejected', 'unavailable'].includes(status) &&
        (!receipt || receipt.schema !== 'mathconstruct-validator/v1' || receipt.task_id !== scheduled.task_id ||
          receipt.status !== status || typeof receipt.tag !== 'string' || !receipt.tag ||
          typeof receipt.reason !== 'string')) {
      // INVALID_JSON/INVALID_REQUEST are recorded as unavailable by the runner.
      if (!(status === 'unavailable' && receipt?.schema === 'mathconstruct-validator/v1' &&
          receipt.task_id === scheduled.task_id && receipt.status === 'rejected' &&
          ['INVALID_JSON', 'INVALID_REQUEST'].includes(receipt.tag) && typeof receipt.reason === 'string')) {
        throw new Error('validation/receipt mismatch');
      }
    }
    const rawName = episode?.raw_file ?? `${scheduled.episode_id}.raw.json`;
    if (rawName !== `${scheduled.episode_id}.raw.json`) throw new Error('invalid raw file identity');
    const raw = readOptional(io, path.join(run, 'episodes', rawName));
    return {
      task_id: scheduled.task_id, repeat: scheduled.repeat, episode_id: scheduled.episode_id,
      recorded: episode !== null, attempted: episode?.attempted === true, completed,
      validation_status: status,
      parsed_value_present: Boolean(episode && Object.hasOwn(episode, 'parsed_value') && episode.parsed_value !== null),
      answer_parseable: episode?.parse?.status === 'parsed' ? true : episode?.parse?.status === 'unparseable' ? false : null,
      duration_ms: Number.isFinite(episode?.duration_ms) ? episode.duration_ms : null,
      capture_failed: captureFailed, timeout, capture_failure: episode?.failure ?? null,
      raw_present: raw !== null, tools: raw === null ? null : parseToolEvents(raw),
    };
  }).sort(order);
  return { manifest, source, rows };
}

function toolSummary(rows) {
  const present = rows.filter(row => row.raw_present);
  const result = {
    evidence: 'call sites, not verified execution',
    raw_logs_present: present.length, raw_logs_missing: rows.length - present.length,
    malformed_lines: present.reduce((sum, row) => sum + row.tools.malformed_lines, 0),
  };
  for (const field of ['call_sites', 'direct_tool_events', 'nested_math_call_sites']) {
    const counts = Object.create(null);
    for (const row of present) for (const [name, n] of Object.entries(row.tools[field])) increment(counts, name, n);
    result[field] = present.length ? sorted(counts) : null;
  }
  return result;
}

export function summarize({ runs, tasksFile, out }, { io = fs, repo = REPO } = {}) {
  assertFreshOutput(out, { io, repo });
  if (runs?.length !== 2) throw new Error('exactly two --run required');
  const bytes = io.readFileSync(tasksFile);
  const tasks = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('nonempty task array required');
  const byTask = new Map();
  for (const task of tasks) {
    if (task?.schema !== 'math-bench-task/v1' || task.benchmark !== 'mathconstruct' ||
        typeof task.id !== 'string' || !/^[\w-]+$/.test(task.id) || typeof task.prompt !== 'string' ||
        !task.prompt.trim() || byTask.has(task.id)) throw new Error('invalid or duplicate task');
    byTask.set(task.id, task);
  }
  const hash = sha256(bytes);
  const loaded = runs.map(run => loadRun(run, byTask, hash, io));
  const byCondition = Object.fromEntries(loaded.map(run => [run.manifest.condition, run]));
  if (!CONDITIONS.every(condition => byCondition[condition])) throw new Error('one plugin-on and one plugin-off run required');
  for (const field of ['model', 'workspace', 'timeout_ms', 'validator_timeout_ms']) {
    if (byCondition['plugin-on'].manifest[field] !== byCondition['plugin-off'].manifest[field]) {
      throw new Error(`paired protocol mismatch: ${field}`);
    }
  }
  const repeats = [...new Set(loaded.flatMap(run => run.rows.map(row => row.repeat)))].sort((a, b) => a - b);
  const result = {
    schema: 'mathconstruct-validator-summary/v1', benchmark: 'mathconstruct',
    exploratory: true, not_confirmatory: true,
    model: byCondition['plugin-on'].manifest.model, task_file_sha256: hash, repeat_values: repeats,
    tasks: [...byTask.values()].sort((a, b) => compare(a.id, b.id)).map(task => ({
      task_id: task.id, validator_configured: task.grading?.type === 'validator' && Boolean(task.grading.validator),
    })),
    conditions: {}, pairs: {},
    caveats: [
      'Exploratory descriptive pilot, not confirmatory evidence of a plugin effect.',
      'Validators check constructions only, not informal proof quality.',
      'The pilot is designed for one repeat; observed repeat indices are reported explicitly. No repeated-run uncertainty is estimated.',
      'Validator coverage is only the tasks with a validator, not the full benchmark or all mathematical claims.',
      'Unparseable is not incorrect. Unparseable, unavailable, missing, or unscheduled pair members are ungraded, never condition wins.',
      'answer_parseable reports the recorded JSON parser outcome; a parsed value can still have an unsupported validator representation and be unparseable.',
      'Offline summary of recorded classifications only; no answers are generated, reconstructed from task metadata, or re-graded.',
      'Tool counts are call sites, not verified execution or success. Direct snapshots are deduplicated when a call ID is present; nested math calls are static execute-input sites.',
      'Static extraction does not resolve branches, loops, aliases, templates, regex literals, or dynamic calls. Missing/malformed raw logs mean unknown tool coverage, not no tool use.',
      'Plan-only runs can be incomplete snapshots. Missing episode files are not evidence that a scheduled model call was attempted.',
    ],
  };
  for (const condition of CONDITIONS) {
    const { rows, source } = byCondition[condition];
    result.conditions[condition] = {
      source, scheduled: rows.length, attempted: rows.filter(row => row.attempted).length,
      completed: rows.filter(row => row.completed).length,
      validation_counts: Object.fromEntries(STATUSES.map(status => [status, rows.filter(row => row.validation_status === status).length])),
      status_task_ids: Object.fromEntries(STATUSES.map(status => [status, unique(rows.filter(row => row.validation_status === status).map(row => row.task_id))])),
      capture: {
        failures: category(rows.filter(row => row.capture_failed)),
        timeouts: category(rows.filter(row => row.timeout)),
        failures_excluding_timeouts: category(rows.filter(row => row.capture_failed && !row.timeout)),
      },
      tool_use: toolSummary(rows), rows,
    };
  }
  const allPairs = new Map();
  for (const condition of CONDITIONS) for (const row of byCondition[condition].rows) {
    if (!allPairs.has(key(row))) allPairs.set(key(row), { task_id: row.task_id, repeat: row.repeat });
    allPairs.get(key(row))[condition] = row;
  }
  const pairs = [...allPairs.values()].sort(order).map(pair => {
    const on = pair['plugin-on'], off = pair['plugin-off'];
    const graded = [on, off].every(row => row && ['accepted', 'rejected'].includes(row.validation_status));
    const outcome = !graded ? 'ungraded' : on.validation_status === 'accepted'
      ? (off.validation_status === 'accepted' ? 'both_accepted' : 'on_only_accepted')
      : (off.validation_status === 'accepted' ? 'off_only_accepted' : 'neither');
    return {
      task_id: pair.task_id, repeat: pair.repeat, outcome,
      on_scheduled: Boolean(on), off_scheduled: Boolean(off),
      on_status: on?.validation_status ?? 'missing', off_status: off?.validation_status ?? 'missing',
    };
  });
  result.pairs = {
    total_slots: pairs.length, matched_slots: pairs.filter(pair => pair.on_scheduled && pair.off_scheduled).length,
    graded_slots: pairs.filter(pair => pair.outcome !== 'ungraded').length,
    ...Object.fromEntries(OUTCOMES.map(outcome => [outcome, category(pairs.filter(pair => pair.outcome === outcome))])),
    rows: pairs,
  };
  const output = claimOutput(out, { io, repo });
  writeJSON(io, path.join(output, 'summary.json'), result);
  io.writeFileSync(path.join(output, 'summary.md'), markdown(result), { encoding: 'utf8', flag: 'wx' });
  return result;
}

const cell = value => String(value ?? 'unknown').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const tableRow = values => `| ${values.map(cell).join(' | ')} |`;
const names = values => values.join(', ') || 'none';

export function markdown(result) {
  const lines = ['# MathConstruct validator summary — descriptive only', '',
    `Model: ${cell(result.model)}; observed repeats: ${names(result.repeat_values)}`, '',
    '## Conditions', '',
    '| Condition | Scheduled | Attempted | Completed | Accepted | Rejected | Unparseable | Unavailable | Missing | Capture failures (including timeouts) | Timeouts |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const condition of CONDITIONS) {
    const row = result.conditions[condition];
    lines.push(tableRow([condition, row.scheduled, row.attempted, row.completed,
      ...STATUSES.map(status => row.validation_counts[status]), row.capture.failures.count, row.capture.timeouts.count]));
  }
  lines.push('', '## Task IDs by status', '', '| Condition | Status | Task IDs |', '|---|---|---|');
  for (const condition of CONDITIONS) {
    const row = result.conditions[condition];
    for (const status of STATUSES) lines.push(tableRow([condition, status, names(row.status_task_ids[status])]));
    lines.push(tableRow([condition, 'capture failures', names(row.capture.failures.task_ids)]),
      tableRow([condition, 'timeouts', names(row.capture.timeouts.task_ids)]));
  }
  lines.push('', '## Per-task/repeat records', '',
    '| Condition | Task | Repeat | Validator status | Parsed value present | Answer parseable (JSON) | Duration ms | Capture failure |',
    '|---|---|---:|---|---|---|---:|---|');
  for (const condition of CONDITIONS) for (const row of result.conditions[condition].rows) {
    lines.push(tableRow([condition, row.task_id, row.repeat, row.validation_status, row.parsed_value_present,
      row.answer_parseable, row.duration_ms, row.capture_failure ?? (row.capture_failed ? 'unspecified' : 'none')]));
  }
  lines.push('', '## Paired outcomes by task/repeat', '',
    '`neither` means both rejected; ungraded pairs cannot yield condition wins.', '',
    '| Outcome | Slots | Task IDs |', '|---|---:|---|');
  for (const outcome of OUTCOMES) {
    const row = result.pairs[outcome];
    lines.push(tableRow([outcome, row.count, names(row.task_ids)]));
  }
  lines.push('', '## Tool-use evidence', '', 'Counts are call sites, not verified execution.', '',
    '| Condition | Raw logs present | Raw logs missing | Malformed lines | Call sites (direct + nested) |',
    '|---|---:|---:|---:|---|');
  for (const condition of CONDITIONS) {
    const row = result.conditions[condition].tool_use;
    const counts = row.call_sites === null ? 'unknown' :
      Object.entries(row.call_sites).map(([name, n]) => `${name}: ${n}`).join(', ') || 'none observed';
    lines.push(tableRow([condition, row.raw_logs_present, row.raw_logs_missing, row.malformed_lines, counts]));
  }
  lines.push('', '## Caveats', '', ...result.caveats.map(text => `- ${text}`));
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2), dependencies) {
  const args = parseOptions(argv, ['--run', '--tasks', '--out'], ['--run']);
  if (!args['--tasks'] || !args['--out']) throw new Error('--tasks and --out required');
  return summarize({ runs: args['--run'], tasksFile: args['--tasks'], out: args['--out'] }, dependencies);
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
