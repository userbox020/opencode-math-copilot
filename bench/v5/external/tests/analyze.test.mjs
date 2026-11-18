import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, clusteredBootstrap, discordantInterval, main, nestedMathCalls, parseToolEvents } from '../analyze.mjs';
import { REPO, sha256 } from '../schema.mjs';

const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const tool = (name, code, id) => ({ type: 'tool_use', part: {
  type: 'tool', tool: name, ...(id ? { callID: id } : {}),
  state: { status: 'completed', input: code === undefined ? {} : { code } },
} });
const rawLines = events => events.map(event => JSON.stringify(event)).join('\n');

function fixture(t) {
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'v5-analysis-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tasks = Array.from({ length: 9 }, (_, i) => ({
    schema: 'math-bench-task/v1', benchmark: 'synthetic', id: `task-${i + 1}`,
    prompt: `Problem ${i + 1}. Mention math_lean_verify without calling it.`,
    answer: 'GOLD_SENTINEL_NOT_FOR_OUTPUT', grading: { type: 'exact' }, metadata: {},
  }));
  const tasksFile = path.join(root, 'pilot.json');
  write(tasksFile, tasks);
  // A nearby invalid baseline must not be read without explicit opt-in.
  fs.writeFileSync(path.join(root, 'baselines.json'), 'not JSON');
  const hash = sha256(fs.readFileSync(tasksFile));
  const specs = {
    'plugin-on': ['correct', 'correct', 'incorrect', 'incorrect', 'missing', 'unparseable', 'correct', 'missing', 'missing'],
    'plugin-off': ['correct', 'incorrect', 'correct', 'incorrect', 'correct', 'incorrect', null, 'missing', 'missing'],
  };
  const runs = [], gradesFiles = [];
  for (const [condition, statuses] of Object.entries(specs)) {
    const run = path.join(root, condition);
    fs.mkdirSync(path.join(run, 'episodes'), { recursive: true });
    runs.push(run);
    const schedule = statuses.flatMap((status, i) => status === null ? [] : [{
      benchmark: 'synthetic', task_id: tasks[i].id, episode_id: `t${i + 1}-r1`,
      repeat: 1, prompt_sha256: sha256(tasks[i].prompt),
    }]);
    const manifest = {
      schema: 'math-bench-manifest/v1', condition, model: 'synthetic/offline',
      workspace: root, timeout_ms: 1000, repeat: 1, task_file_sha256: hash, schedule,
    };
    write(path.join(run, 'manifest.json'), manifest);
    const rows = schedule.map(scheduled => {
      const i = Number(scheduled.task_id.split('-')[1]) - 1;
      const status = statuses[i], notRecorded = i === 8;
      const episode = {
        schema: 'math-bench-episode/v1', ...scheduled, model: manifest.model, condition,
        attempted: true, status: status === 'missing' ? 'timeout' : 'completed',
        failure: status === 'missing' ? 'timeout' : null,
        exit_code: status === 'missing' ? null : 0,
        error_code: status === 'missing' ? 'ETIMEDOUT' : null,
        text: 'ANSWER_SENTINEL_DO_NOT_INFER_CORRECTNESS math_pdf_text',
      };
      if (!notRecorded) {
        write(path.join(run, 'episodes', `${scheduled.episode_id}.json`), episode);
        const events = [{ type: 'text', part: { text: 'tools.math_doctor({}) math_status' } }];
        if (condition === 'plugin-on' && i === 0) events.push(tool('math_compute', undefined, 'direct-1'));
        if (condition === 'plugin-on' && i === 1) events.push(tool('execute',
          'await tools.math_search({query: "x"}); // tools.math_doctor({})\nconst text = "tools.math_status({})";',
          'nested-1'));
        if (condition === 'plugin-on' && i === 4) events.push(tool('math_grep'));
        // Attribution follows evidence even in OFF, never the condition label.
        if (condition === 'plugin-off' && i === 2) events.push(tool('math_status'));
        fs.writeFileSync(path.join(run, 'episodes', `${scheduled.episode_id}.raw.json`), rawLines(events));
      }
      return { ...scheduled, model: manifest.model, condition, attempted: !notRecorded,
        completed: status !== 'missing', run_status: notRecorded ? 'not_recorded' : episode.status,
        grade: { status, extracted: 'GRADE_ANSWER_SENTINEL_NOT_FOR_OUTPUT' } };
    });
    const grades = {
      schema: 'math-bench-grades/v1', manifest, manifest_sha256: sha256(fs.readFileSync(path.join(run, 'manifest.json'))),
      grading_rules: 'bounded-final-answer/v1', rows,
    };
    const gradesFile = path.join(run, 'grades.json');
    write(gradesFile, grades);
    gradesFiles.push(gradesFile);
  }
  return { root, runs, tasksFile, gradesFiles, out: path.join(root, 'analysis') };
}

test('offline counts separate correctness, completion, missing, unparseable, and tool evidence', t => {
  const f = fixture(t);
  const result = main(['--run', f.runs[0], '--run', f.runs[1], '--tasks', f.tasksFile, '--out', f.out]);
  assert.equal(result.schema, 'math-bench-analysis/v1');
  assert.equal(result.benchmark, 'synthetic');
  assert.equal(result.tasks.length, 9);
  assert.deepEqual(result.conditions['plugin-on'], {
    scheduled: 9, attempted: 8, completed: 6, correct: 3, incorrect: 2, unparseable: 1, missing: 3,
    correct_among_completed: 0.5, correct_among_scheduled: 1 / 3, correct_among_graded: 3 / 5,
  });
  assert.deepEqual(result.conditions['plugin-off'], {
    scheduled: 8, attempted: 7, completed: 6, correct: 3, incorrect: 3, unparseable: 0, missing: 2,
    correct_among_completed: 0.5, correct_among_scheduled: 3 / 8, correct_among_graded: 0.5,
  });
  const on = result.tool_use['plugin-on'], off = result.tool_use['plugin-off'];
  assert.equal(on.total_episodes, 9);
  assert.equal(on.episodes_with_math_use, 3);
  assert.equal(on.raw_logs_present, 8);
  assert.deepEqual(on.raw_logs_missing.task_ids, ['task-9']);
  assert.deepEqual(on.tool_call_counts, { execute: 1, math_compute: 1, math_grep: 1, math_search: 1 });
  assert.deepEqual(on.nested_math_call_sites, { math_search: 1 });
  assert.deepEqual(on.per_task.find(row => row.task_id === 'task-2').math_tool_names, ['math_search']);
  assert.deepEqual(on.per_task.find(row => row.task_id === 'task-3').tool_names, []);
  assert.equal(off.episodes_with_math_use, 1);
  assert.deepEqual(off.tool_call_counts, { math_status: 1 });
  assert.deepEqual(result.pairs.both.task_ids, ['task-1']);
  assert.deepEqual(result.pairs.on_only.task_ids, ['task-2']);
  assert.deepEqual(result.pairs.off_only.task_ids, ['task-3']);
  assert.deepEqual(result.pairs.neither.task_ids, ['task-4']);
  assert.deepEqual(result.pairs.ungraded.task_ids, ['task-5', 'task-6', 'task-7', 'task-8', 'task-9']);
  assert.equal(result.pairs.ungraded.count, 5);
  assert.equal(result.pairs.total_slots, 9);
  assert.equal(result.pairs.matched_slots, 8);
  assert.equal(result.pairs.graded_slots, 4);
  assert.deepEqual(result.timeouts['plugin-on'].timeout.task_ids, ['task-5', 'task-8']);
  assert.deepEqual(result.timeouts['plugin-on'].missing.task_ids, ['task-5', 'task-8', 'task-9']);
  assert.deepEqual(result.timeouts['plugin-on'].missing_not_timeout.task_ids, ['task-9']);
  assert.deepEqual(result.timeouts['plugin-on'].completed_unparseable.task_ids, ['task-6']);
  assert.deepEqual(result.timeouts.overlap.timeout.task_ids, ['task-8']);
  assert.deepEqual(result.timeouts.overlap.missing.task_ids, ['task-8', 'task-9']);
  assert.deepEqual(result.timeouts.completion.off_only.task_ids, ['task-5']);
  assert.deepEqual(result.timeouts.completion.unpaired.task_ids, ['task-7']);
  assert.equal(result.timeouts.completion.on_minus_off_count, -1);
  assert.equal(result.timeouts.completion.on_minus_off_rate, -1 / 8);
  assert.equal(result.bootstrap.seed, 20261117);
  assert.equal(result.bootstrap.resamples, 10000);
  assert.equal(result.bootstrap.task_clusters, 4);
  assert.equal(result.bootstrap.estimate, 0);
  assert.equal(Object.hasOwn(result, 'external_baseline'), false);
  const json = fs.readFileSync(path.join(f.out, 'analysis.json'), 'utf8');
  const md = fs.readFileSync(path.join(f.out, 'analysis.md'), 'utf8');
  assert.deepEqual(JSON.parse(json), result);
  assert.match(md, /\| Condition \| Scheduled episodes \|/);
  assert.match(md, /\| Outcome \| Slots \| Task IDs \|/);
  assert.match(md, /Completed but unparseable/);
  assert.doesNotMatch(json + md, /SENTINEL|math_lean_verify|math_pdf_text|math_doctor/);
  const again = analyze({ ...f, out: path.join(f.root, 'second') });
  assert.deepEqual(again, result);
});

test('tool parser handles snapshots, direct/nested calls, malformed tails, and non-tool mentions', () => {
  const raw = rawLines([
    tool('math_compute', undefined, 'one'), tool('math_compute', undefined, 'one'),
    tool('execute', 'await tools.math_search({}); await tools.math_search({});', 'two'),
    { type: 'tool_use', part: { tool: 'execute', callID: 'two', state: { status: 'completed' } } },
    { role: 'user', part: { tool: 'math_doctor' } },
    { type: 'text', part: { tool: 'math_status', text: 'tools.math_status({})' } },
    { type: 'tool_use', part: { tool: 'read', state: { output: 'tools.math_doctor({})', input: {} } } },
  ]) + '\n{"partial":';
  const result = parseToolEvents(raw);
  assert.deepEqual(result.tool_call_counts, { execute: 1, math_compute: 1, math_search: 2, read: 1 });
  assert.equal(result.malformed_lines, 1);
  assert.deepEqual(nestedMathCalls(`
    // tools.math_doctor({})
    /* tools.math_compute({}) */
    const a = "tools.math_status({})", b = 'tools.math_grep({})';
    const c = \`tools.math_pdf_text({})\`;
    const reference = tools.math_lean_check;
    await tools.math_search({});
  `), ['math_search']);
  assert.deepEqual(parseToolEvents('').tool_call_counts, {});
  assert.deepEqual(parseToolEvents(JSON.stringify({ events: [tool('math_compute')] })).math_tool_names, ['math_compute']);
});

test('bootstrap is deterministic, task-clustered, order-stable, and honest for empty data', () => {
  const rows = [
    { benchmark: 'b', task_id: 'a', repeat: 1, difference: 1 },
    { benchmark: 'b', task_id: 'a', repeat: 2, difference: 1 },
    { benchmark: 'b', task_id: 'b', repeat: 1, difference: -1 },
  ];
  const result = clusteredBootstrap(rows);
  assert.equal(result.task_clusters, 2);
  assert.equal(result.paired_slots, 3);
  assert.equal(result.estimate, 1 / 3);
  assert.deepEqual(result.interval, [-1, 1]);
  assert.deepEqual(clusteredBootstrap(rows), result);
  assert.deepEqual(clusteredBootstrap([...rows].reverse()), result);
  assert.equal(clusteredBootstrap([]).interval, null);
  assert.equal(clusteredBootstrap([]).estimate, null);
  assert.deepEqual(clusteredBootstrap(rows.slice(0, 2)).interval, [1, 1]);
});

test('exact discordant binomial interval has known endpoints and no fabricated empty estimate', () => {
  assert.deepEqual(discordantInterval(0, 0).interval, null);
  assert.equal(discordantInterval(0, 0).on_share, null);
  const single = discordantInterval(1, 0);
  assert.ok(Math.abs(single.interval[0] - 0.025) < 1e-12);
  assert.equal(single.interval[1], 1);
  assert.ok(Math.abs(discordantInterval(0, 1).interval[1] - 0.975) < 1e-12);
  const symmetric = discordantInterval(1, 1);
  assert.ok(Math.abs(symmetric.interval[0] - (1 - Math.sqrt(0.975))) < 1e-12);
  assert.ok(Math.abs(symmetric.interval[0] + symmetric.interval[1] - 1) < 1e-12);
});

test('fresh-output guard refuses empty/nonempty dirs, files, relative paths, and repo paths', t => {
  const f = fixture(t);
  const empty = path.join(f.root, 'empty'), full = path.join(f.root, 'full');
  fs.mkdirSync(empty);
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'keep.txt'), 'preserved');
  for (const out of [empty, full, f.tasksFile]) assert.throws(() => analyze({ ...f, out }), /output exists/);
  assert.throws(() => analyze({ ...f, out: 'relative-analysis' }), /absolute/);
  assert.throws(() => analyze({ ...f, out: path.join(REPO, 'analysis-must-not-be-created') }), /inside repo/);
  assert.equal(fs.readFileSync(path.join(full, 'keep.txt'), 'utf8'), 'preserved');
  assert.deepEqual(fs.readdirSync(empty), []);
});

test('CLI accepts separately located grades and explicit external baseline without pooling', t => {
  const f = fixture(t);
  const gradesFiles = f.gradesFiles.map((file, i) => {
    const destination = path.join(f.root, `grades-${i}.json`);
    fs.renameSync(file, destination);
    return destination;
  });
  const baseline = path.join(f.root, 'baselines.json');
  write(baseline, { schema: 'pack', external: [
    { benchmark: 'synthetic', model: 'external/other', score: '12/20 as supplied', source: 'fixture', notes: 'not comparable' },
  ] });
  const args = ['--run', f.runs[0], '--run', f.runs[1], '--tasks', f.tasksFile,
    '--grades', gradesFiles[0], '--grades', gradesFiles[1], '--out', f.out];
  const result = main([...args, '--baseline', baseline]);
  assert.equal(result.external_baseline[0].score, '12/20 as supplied');
  assert.equal(result.external_baseline[0].label, 'external_baseline');
  const noBaseline = analyze({ ...f, gradesFiles, out: path.join(f.root, 'without-baseline') });
  for (const key of ['pairs', 'conditions', 'bootstrap', 'tool_use', 'timeouts']) assert.deepEqual(result[key], noBaseline[key]);
  assert.throws(() => main(['--run', f.runs[0], '--tasks', f.tasksFile, '--out', path.join(f.root, 'bad')]), /exactly two/);
});

test('rejects stale grades and never converts a timeout to an incorrect answer', t => {
  const f = fixture(t);
  const file = f.gradesFiles[0], grades = JSON.parse(fs.readFileSync(file, 'utf8'));
  grades.rows.find(row => row.task_id === 'task-5').grade.status = 'incorrect';
  write(file, grades);
  assert.throws(() => analyze(f), /completion\/grade mismatch/);
  assert.equal(fs.existsSync(f.out), false);
  grades.rows.find(row => row.task_id === 'task-5').grade.status = 'missing';
  grades.manifest_sha256 = 'stale';
  write(file, grades);
  assert.throws(() => analyze(f), /manifest\/grades mismatch/);
});
