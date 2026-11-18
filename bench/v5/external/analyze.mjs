import fs from 'node:fs';
import path from 'node:path';
import {
  CONDITIONS, assertFreshOutput, claimOutput, episodeKey, isMain,
  parseOptions, readTasks, sha256, taskKey, writeJSON,
} from './schema.mjs';
import { CAVEATS, validateBaselines } from './report.mjs';

const STATUSES = ['correct', 'incorrect', 'unparseable', 'missing'];
const unique = values => [...new Set(values)].sort();
const increment = (counts, name, amount = 1) => { counts[name] = (counts[name] ?? 0) + amount; };
const sorted = counts => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const slot = row => ({ benchmark: row.benchmark, task_id: row.task_id, repeat: row.repeat });
const category = rows => ({ count: rows.length, task_ids: unique(rows.map(row => row.task_id)), slots: rows.map(slot) });
const ratio = (n, d) => d ? n / d : null;

// Static evidence only: ignore ordinary string literals/comments, require a call,
// and never inspect prompts, answer text, tool output, or reasoning.
export function nestedMathCalls(code) {
  if (typeof code !== 'string') return [];
  const stripped = code.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    match => ' '.repeat(match.length),
  );
  return [...stripped.matchAll(/\btools\s*\.\s*(math_[A-Za-z0-9_]+)\s*\(/g)].map(match => match[1]);
}

export function parseToolEvents(raw) {
  const events = [];
  let malformedLines = 0;
  // JSONL is the normal format; also accept the runner's single JSON envelope.
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
    const parts = Array.isArray(event.parts) ? event.parts : [event.part ?? event];
    for (const part of parts) {
      if (!part || typeof part.tool !== 'string' ||
          ['text', 'reasoning'].includes(part.type ?? event.type)) continue;
      const id = part.callID ?? part.id;
      const key = id === undefined ? Symbol() : JSON.stringify([part.sessionID ?? event.sessionID, part.tool, id]);
      const previous = calls.get(key);
      // CLI snapshots of the same call are not additional invocations.
      calls.set(key, { tool: part.tool, code: part.state?.input?.code ?? previous?.code });
    }
  }
  const direct = {}, nested = {};
  for (const call of calls.values()) {
    increment(direct, call.tool);
    if (call.tool === 'execute') for (const name of nestedMathCalls(call.code)) increment(nested, name);
  }
  const counts = { ...direct };
  for (const [name, count] of Object.entries(nested)) increment(counts, name, count);
  return {
    tool_call_counts: sorted(counts), direct_tool_events: sorted(direct),
    nested_math_call_sites: sorted(nested),
    math_tool_names: Object.keys(counts).filter(name => /^math_/.test(name)).sort(),
    malformed_lines: malformedLines,
  };
}

function randomGenerator(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const percentile = (values, p) => {
  const index = (values.length - 1) * p, lower = Math.floor(index);
  return values[lower] + (values[Math.ceil(index)] - values[lower]) * (index - lower);
};

export function clusteredBootstrap(rows) {
  const clusters = new Map();
  for (const row of rows) {
    const key = taskKey(row);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(row.difference);
  }
  const groups = [...clusters.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, differences]) => ({ sum: differences.reduce((a, b) => a + b, 0), n: differences.length }));
  const result = {
    method: 'task-clustered paired percentile bootstrap', seed: 20261117, resamples: 10000,
    confidence: 0.95, estimand: 'ON minus OFF correctness among pairs graded correct/incorrect in both conditions',
    task_clusters: groups.length, paired_slots: rows.length,
    estimate: ratio(groups.reduce((sum, group) => sum + group.sum, 0), rows.length),
    interval: null,
  };
  if (!groups.length) return result;
  const random = randomGenerator(result.seed), samples = [];
  for (let i = 0; i < result.resamples; i++) {
    let sum = 0, n = 0;
    for (let j = 0; j < groups.length; j++) {
      const group = groups[Math.floor(random() * groups.length)];
      sum += group.sum;
      n += group.n;
    }
    samples.push(sum / n);
  }
  samples.sort((a, b) => a - b);
  result.interval = [percentile(samples, 0.025), percentile(samples, 0.975)];
  return result;
}

// Clopper-Pearson inversion using log-space binomial probabilities.
function binomialProbability(n, p, first, last) {
  if (p === 0) return first === 0 ? 1 : 0;
  if (p === 1) return last === n ? 1 : 0;
  let logChoose = 0, sum = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= first && k <= last) sum += Math.exp(logChoose + k * Math.log(p) + (n - k) * Math.log1p(-p));
    logChoose += Math.log(n - k) - Math.log(k + 1);
  }
  return sum;
}

export function discordantInterval(onOnly, offOnly) {
  const n = onOnly + offOnly;
  const invert = (first, last, increasing) => {
    let low = 0, high = 1;
    for (let i = 0; i < 70; i++) {
      const mid = (low + high) / 2;
      if ((binomialProbability(n, mid, first, last) < 0.025) === increasing) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  };
  return {
    method: 'Clopper-Pearson exact binomial', confidence: 0.95, discordant_pairs: n,
    on_only: onOnly, off_only: offOnly, on_share: ratio(onOnly, n),
    interval: n ? [onOnly ? invert(onOnly, n, true) : 0, offOnly ? invert(0, onOnly, false) : 1] : null,
    caveat: 'Descriptive ON share among discordant graded slots, not the overall accuracy difference; binomial independence is not warranted for repeated tasks.',
  };
}

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function loadRun(run, gradesFile, tasks, hash) {
  const manifestBytes = fs.readFileSync(path.join(run, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const grades = JSON.parse(fs.readFileSync(gradesFile, 'utf8'));
  if (manifest.schema !== 'math-bench-manifest/v1' || manifest.task_file_sha256 !== hash ||
      !CONDITIONS.includes(manifest.condition) || !Array.isArray(manifest.schedule) ||
      grades.schema !== 'math-bench-grades/v1' || grades.manifest_sha256 !== sha256(manifestBytes) ||
      JSON.stringify(grades.manifest) !== JSON.stringify(manifest) || !Array.isArray(grades.rows)) {
    throw new Error('task/manifest/grades mismatch');
  }
  const byTask = new Map(tasks.map(task => [taskKey(task), task]));
  const gradeRows = new Map(grades.rows.map(row => [episodeKey(row), row]));
  if (gradeRows.size !== grades.rows.length || gradeRows.size !== manifest.schedule.length) throw new Error('duplicate or missing grade rows');
  const ids = new Set();
  const rows = manifest.schedule.map(scheduled => {
    const task = byTask.get(taskKey(scheduled)), row = gradeRows.get(episodeKey(scheduled));
    if (!task || scheduled.prompt_sha256 !== sha256(task.prompt) ||
        !/^t\d+-r\d+$/.test(scheduled.episode_id) || ids.has(scheduled.episode_id) ||
        !Number.isSafeInteger(scheduled.repeat) || scheduled.repeat < 1 ||
        !row || row.episode_id !== scheduled.episode_id || row.prompt_sha256 !== scheduled.prompt_sha256 ||
        row.model !== manifest.model || row.condition !== manifest.condition || !STATUSES.includes(row.grade?.status)) {
      throw new Error('invalid schedule/grade identity');
    }
    ids.add(scheduled.episode_id);
    gradeRows.delete(episodeKey(scheduled));
    const episodeText = readOptional(path.join(run, 'episodes', `${scheduled.episode_id}.json`));
    const episode = episodeText === null ? null : JSON.parse(episodeText);
    if (episode && (episodeKey(episode) !== episodeKey(scheduled) || episode.episode_id !== scheduled.episode_id ||
        episode.prompt_sha256 !== scheduled.prompt_sha256 || episode.model !== manifest.model ||
        episode.condition !== manifest.condition)) throw new Error('episode identity mismatch');
    const timeout = episode?.status === 'timeout' || episode?.failure === 'timeout' || episode?.error_code === 'ETIMEDOUT';
    const completed = !timeout && episode?.status === 'completed' && episode.exit_code === 0 &&
      !episode.error && !episode.error_code && !episode.signal && Boolean(String(episode.text ?? '').trim());
    if ((!completed && row.grade.status !== 'missing') || (completed && row.grade.status === 'missing')) {
      throw new Error('completion/grade mismatch; re-grade captured inputs offline');
    }
    const raw = readOptional(path.join(run, 'episodes', `${scheduled.episode_id}.raw.json`));
    return {
      ...slot(row), episode_id: row.episode_id, grade: row.grade.status,
      attempted: episode?.attempted === true, completed, timeout, recorded: episode !== null,
      raw_present: raw !== null, tools: parseToolEvents(raw ?? ''),
    };
  });
  return { manifest, grading_rules: grades.grading_rules, rows };
}

export function analyze({ runs, tasksFile, gradesFiles, baseline, out }) {
  assertFreshOutput(out);
  if (runs?.length !== 2 || (gradesFiles && gradesFiles.length !== 2)) throw new Error('exactly two --run (and, if supplied, two --grades) required');
  const { tasks, hash } = readTasks(tasksFile);
  const loaded = runs.map((run, i) => loadRun(run, gradesFiles?.[i] ?? path.join(run, 'grades.json'), tasks, hash));
  const byCondition = Object.fromEntries(loaded.map(run => [run.manifest.condition, run]));
  if (!CONDITIONS.every(name => byCondition[name])) throw new Error('one plugin-on and one plugin-off run required');
  const on = byCondition['plugin-on'], off = byCondition['plugin-off'];
  for (const field of ['model', 'workspace', 'timeout_ms', 'repeat']) {
    if (on.manifest[field] !== off.manifest[field]) throw new Error(`paired protocol mismatch: ${field}`);
  }
  if (on.grading_rules !== off.grading_rules) throw new Error('paired protocol mismatch: grading_rules');
  const benchmarks = unique(loaded.flatMap(run => run.rows.map(row => row.benchmark)));
  const result = {
    schema: 'math-bench-analysis/v1', benchmark: benchmarks.length === 1 ? benchmarks[0] : benchmarks,
    model: on.manifest.model, tasks: tasks.map(task => ({ benchmark: task.benchmark, id: task.id })),
    conditions: {}, pairs: {}, tool_use: {}, timeouts: {}, bootstrap: null,
    caveats: [...CAVEATS,
      'Offline analysis of captured data and supplied grades only; no answers are generated or re-graded.',
      'Tool counts combine direct tool events with static math call sites in execute input. Nested sites are evidence of submitted code, not proof of execution or success; branches, loops, aliases, templates, regex literals, and dynamic calls are not resolved.',
      'Missing/malformed raw logs mean unknown tool coverage, not evidence of no tool use. Repeated snapshots are deduplicated when a call ID is available.',
      'Pairs with missing, unparseable, or unscheduled members are ungraded, never condition wins. Bootstrap excludes these pairs and may have completion-selection bias.',
      'Bootstrap resamples tasks with all eligible repeats together; intervals are descriptive, can degenerate on tiny samples, and are not confirmatory. No p-values are calculated.',
    ],
  };
  for (const condition of CONDITIONS) {
    const { rows } = byCondition[condition];
    const counts = Object.fromEntries(STATUSES.map(status => [status, rows.filter(row => row.grade === status).length]));
    const completed = rows.filter(row => row.completed).length;
    result.conditions[condition] = {
      scheduled: rows.length, attempted: rows.filter(row => row.attempted).length, completed, ...counts,
      correct_among_completed: ratio(counts.correct, completed),
      correct_among_scheduled: ratio(counts.correct, rows.length),
      correct_among_graded: ratio(counts.correct, counts.correct + counts.incorrect),
    };
    const toolCounts = {}, direct = {}, nested = {};
    const perTask = new Map();
    for (const row of rows) {
      for (const [target, source] of [[toolCounts, row.tools.tool_call_counts], [direct, row.tools.direct_tool_events], [nested, row.tools.nested_math_call_sites]]) {
        for (const [name, count] of Object.entries(source)) increment(target, name, count);
      }
      const key = taskKey(row);
      if (!perTask.has(key)) perTask.set(key, { benchmark: row.benchmark, task_id: row.task_id, tool_names: [], math_tool_names: [], episodes: [] });
      const task = perTask.get(key);
      task.tool_names = unique([...task.tool_names, ...Object.keys(row.tools.tool_call_counts)]);
      task.math_tool_names = unique([...task.math_tool_names, ...row.tools.math_tool_names]);
      task.episodes.push({ repeat: row.repeat, episode_id: row.episode_id, raw_present: row.raw_present, ...row.tools });
    }
    result.tool_use[condition] = {
      total_episodes: rows.length, recorded_episodes: rows.filter(row => row.recorded).length,
      raw_logs_present: rows.filter(row => row.raw_present).length,
      raw_logs_missing: category(rows.filter(row => !row.raw_present)),
      malformed_lines: rows.reduce((sum, row) => sum + row.tools.malformed_lines, 0),
      episodes_with_math_use: rows.filter(row => row.tools.math_tool_names.length).length,
      tool_call_counts: sorted(toolCounts), direct_tool_events: sorted(direct), nested_math_call_sites: sorted(nested),
      per_task: [...perTask.values()],
    };
    result.timeouts[condition] = {
      timeout: category(rows.filter(row => row.timeout)),
      missing: category(rows.filter(row => row.grade === 'missing')),
      missing_not_timeout: category(rows.filter(row => row.grade === 'missing' && !row.timeout)),
      completed_unparseable: category(rows.filter(row => row.completed && row.grade === 'unparseable')),
    };
  }
  const allPairs = new Map();
  for (const condition of CONDITIONS) for (const row of byCondition[condition].rows) {
    const key = episodeKey(row);
    if (!allPairs.has(key)) allPairs.set(key, {});
    allPairs.get(key)[condition] = row;
  }
  const paired = Object.fromEntries(['both', 'on_only', 'off_only', 'neither', 'ungraded'].map(name => [name, []]));
  const completion = Object.fromEntries(['both', 'on_only', 'off_only', 'neither', 'unpaired'].map(name => [name, []]));
  const eligible = [], timeoutOverlap = [], missingOverlap = [];
  for (const [, pair] of [...allPairs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const a = pair['plugin-on'], b = pair['plugin-off'], row = a ?? b;
    const graded = [a, b].every(member => member && ['correct', 'incorrect'].includes(member.grade));
    const outcome = !graded ? 'ungraded' : a.grade === 'correct'
      ? (b.grade === 'correct' ? 'both' : 'on_only') : (b.grade === 'correct' ? 'off_only' : 'neither');
    paired[outcome].push(row);
    if (graded) eligible.push({ ...slot(row), difference: Number(a.grade === 'correct') - Number(b.grade === 'correct') });
    const completionOutcome = !a || !b ? 'unpaired' : a.completed
      ? (b.completed ? 'both' : 'on_only') : (b.completed ? 'off_only' : 'neither');
    completion[completionOutcome].push(row);
    if (a?.timeout && b?.timeout) timeoutOverlap.push(row);
    if (a?.grade === 'missing' && b?.grade === 'missing') missingOverlap.push(row);
  }
  result.pairs = {
    total_slots: allPairs.size, matched_slots: allPairs.size - completion.unpaired.length,
    graded_slots: eligible.length, ...Object.fromEntries(Object.entries(paired).map(([name, rows]) => [name, category(rows)])),
    correctness_difference: ratio(paired.on_only.length - paired.off_only.length, eligible.length),
    discordant_interval: discordantInterval(paired.on_only.length, paired.off_only.length),
  };
  result.timeouts.overlap = { timeout: category(timeoutOverlap), missing: category(missingOverlap) };
  result.timeouts.completion = {
    ...Object.fromEntries(Object.entries(completion).map(([name, rows]) => [name, category(rows)])),
    on_minus_off_count: completion.on_only.length - completion.off_only.length,
    on_minus_off_rate: ratio(completion.on_only.length - completion.off_only.length, result.pairs.matched_slots),
  };
  result.bootstrap = clusteredBootstrap(eligible);
  // No implicit baseline discovery, and never include baseline rows in estimates.
  if (baseline) result.external_baseline = validateBaselines(JSON.parse(fs.readFileSync(baseline, 'utf8')));
  const output = claimOutput(out);
  writeJSON(fs, path.join(output, 'analysis.json'), result);
  fs.writeFileSync(path.join(output, 'analysis.md'), markdown(result), { encoding: 'utf8', flag: 'wx' });
  return result;
}

const cell = value => String(value ?? 'unknown').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const percent = value => value === null ? 'unknown' : `${(100 * value).toFixed(2)}%`;
const interval = value => value ? value.map(percent).join(' to ') : 'unknown';
const names = values => values.join(', ') || 'none observed';
const tableRow = values => `| ${values.map(cell).join(' | ')} |`;

export function markdown(result) {
  const lines = ['# Captured math benchmark analysis — descriptive only', '',
    `Benchmark: ${cell(result.benchmark)}; model: ${cell(result.model)}`, '',
    '## Correctness and completion', '',
    '| Condition | Scheduled | Attempted | Completed | Correct | Incorrect | Unparseable | Missing | Correct / completed | Correct / scheduled |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const condition of CONDITIONS) {
    const row = result.conditions[condition];
    lines.push(tableRow([condition, ...['scheduled', 'attempted', 'completed', 'correct', 'incorrect', 'unparseable', 'missing'].map(key => row[key]),
      percent(row.correct_among_completed), percent(row.correct_among_scheduled)]));
  }
  lines.push('', '## Tool-use evidence', '',
    'Nested counts are static call sites submitted to execute, not verified successful invocations.', '',
    '| Condition | Scheduled episodes | Raw logs present | Episodes with math use | Tool counts (direct + nested sites) |',
    '|---|---:|---:|---:|---|');
  for (const condition of CONDITIONS) {
    const row = result.tool_use[condition];
    lines.push(tableRow([condition, row.total_episodes, row.raw_logs_present, row.episodes_with_math_use,
      Object.entries(row.tool_call_counts).map(([name, count]) => `${name}: ${count}`).join(', ') || 'none observed']));
  }
  lines.push('', '| Condition | Task | Tool names | Math tool names |', '|---|---|---|---|');
  for (const condition of CONDITIONS) for (const row of result.tool_use[condition].per_task) {
    lines.push(tableRow([condition, `${row.benchmark}/${row.task_id}`, names(row.tool_names), names(row.math_tool_names)]));
  }
  lines.push('', '## Paired correctness (task/repeat slots)', '',
    '| Outcome | Slots | Task IDs |', '|---|---:|---|');
  for (const name of ['both', 'on_only', 'off_only', 'neither', 'ungraded']) {
    const row = result.pairs[name];
    lines.push(tableRow([name, row.count, row.task_ids.join(', ') || 'none']));
  }
  lines.push('', `Graded-pair ON − OFF correctness: ${percent(result.pairs.correctness_difference)}.`,
    `Task-clustered bootstrap: ${result.bootstrap.resamples} resamples, seed ${result.bootstrap.seed}, ${result.bootstrap.task_clusters} tasks; 95% interval ${interval(result.bootstrap.interval)}.`,
    `Discordant-pair ON share: ${percent(result.pairs.discordant_interval.on_share)}; exact 95% binomial interval ${interval(result.pairs.discordant_interval.interval)}.`,
    result.pairs.discordant_interval.caveat, '',
    '## Timeouts and completion', '',
    '| Condition | Timeout task IDs | Missing task IDs (including timeout) | Other missing task IDs | Completed but unparseable |',
    '|---|---|---|---|---|');
  for (const condition of CONDITIONS) {
    const row = result.timeouts[condition];
    lines.push(tableRow([condition, ...['timeout', 'missing', 'missing_not_timeout', 'completed_unparseable']
      .map(key => row[key].task_ids.join(', ') || 'none')]));
  }
  lines.push('', `Timeout overlap: ${result.timeouts.overlap.timeout.task_ids.join(', ') || 'none'}.`,
    `Missing overlap: ${result.timeouts.overlap.missing.task_ids.join(', ') || 'none'}.`, '',
    '| Completion outcome | Slots | Task IDs |', '|---|---:|---|');
  for (const name of ['both', 'on_only', 'off_only', 'neither', 'unpaired']) {
    const row = result.timeouts.completion[name];
    lines.push(tableRow([name, row.count, row.task_ids.join(', ') || 'none']));
  }
  lines.push('', `Matched-slot ON − OFF completion: ${result.timeouts.completion.on_minus_off_count} slots (${percent(result.timeouts.completion.on_minus_off_rate)}).`,
    'Completion gaps are not correctness wins; unparseable completed answers are not timeouts.', '',
    '## External baseline — separate, never pooled', '');
  if (!result.external_baseline) lines.push('Not requested; no baseline file read.');
  else {
    lines.push('| Benchmark | Model | Supplied score | Source | Notes |', '|---|---|---|---|---|');
    for (const row of result.external_baseline) lines.push(tableRow([row.benchmark, row.model, row.score, row.source, row.notes ?? '']));
    if (!result.external_baseline.length) lines.push('No baseline rows supplied.');
  }
  lines.push('', '## Caveats', '', ...result.caveats.map(text => `- ${text}`));
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseOptions(argv, ['--run', '--grades', '--tasks', '--out', '--baseline'], ['--run', '--grades']);
  if (!args['--tasks'] || !args['--out']) throw new Error('--tasks and --out required');
  return analyze({ runs: args['--run'], gradesFiles: args['--grades'], tasksFile: args['--tasks'],
    out: args['--out'], baseline: args['--baseline'] });
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
