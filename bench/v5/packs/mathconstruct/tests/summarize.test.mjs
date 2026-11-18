import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { main, parseToolEvents, summarize } from '../summarize.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const root = path.resolve(path.parse(process.cwd()).root, 'hermetic-mathconstruct-summary');
const repo = path.join(root, 'repo');
const external = path.join(root, 'external');
const conditions = ['plugin-on', 'plugin-off'];

// No real filesystem writes, subprocesses, validators, models, or network.
function fixture() {
  const files = new Map(), dirs = new Set([root, repo, external]), aliases = new Map();
  const error = code => Object.assign(new Error(code), { code });
  const io = {
    readFileSync(file, encoding) {
      const value = files.get(path.resolve(file));
      if (value === undefined) throw error('ENOENT');
      return encoding ? value : Buffer.from(value);
    },
    lstatSync(file) {
      file = path.resolve(file);
      if (!files.has(file) && !dirs.has(file) && !aliases.has(file)) throw error('ENOENT');
      return {};
    },
    realpathSync(file) {
      file = path.resolve(file);
      if (aliases.has(file)) return aliases.get(file);
      if (!dirs.has(file)) throw error('ENOENT');
      return file;
    },
    mkdirSync(file) {
      file = path.resolve(file);
      if (dirs.has(file) || files.has(file)) throw error('EEXIST');
      if (!dirs.has(path.dirname(file))) throw error('ENOENT');
      dirs.add(file);
    },
    writeFileSync(file, value, options) {
      file = path.resolve(file);
      if (options?.flag === 'wx' && files.has(file)) throw error('EEXIST');
      if (!dirs.has(path.dirname(file))) throw error('ENOENT');
      files.set(file, String(value));
    },
  };
  const put = (file, value) => files.set(file, JSON.stringify(value));
  const taskIds = ['both', 'on-win', 'off-win', 'neither', 'unparseable', 'unavailable', 'missing',
    'timeout', 'failure', 'absent', 'only-on'];
  const tasks = taskIds.map(id => ({
    schema: 'math-bench-task/v1', benchmark: 'mathconstruct', id, prompt: `Construct ${id}`,
    grading: { type: 'validator', validator: 'local', answer_format: 'FINAL: [SECRET_REFERENCE]' },
    answer: 'SECRET_REFERENCE', metadata: { original_solution: ['SECRET_REFERENCE'] },
  }));
  const tasksFile = path.join(external, 'pilot.json');
  put(tasksFile, tasks);
  const runs = conditions.map(condition => path.join(external, condition));
  const schedules = {};
  for (const [index, condition] of conditions.entries()) {
    dirs.add(runs[index]);
    dirs.add(path.join(runs[index], 'episodes'));
    const selected = tasks.filter(task => condition === 'plugin-on' || task.id !== 'only-on');
    const schedule = selected.map((task, i) => ({
      episode_id: `t${i + 1}-r1`, benchmark: 'mathconstruct', task_id: task.id, repeat: 1,
      prompt_sha256: hash(task.prompt + '\n\nRequired answer format:\n' + task.grading.answer_format),
    }));
    schedules[condition] = schedule;
    const manifest = {
      schema: 'mathconstruct-validator-manifest/v1', condition, model: 'fake/model',
      task_file_sha256: hash(files.get(tasksFile)), workspace: external,
      timeout_ms: 1000, validator_timeout_ms: 100, schedule,
    };
    put(path.join(runs[index], 'manifest.json'), manifest);
    put(path.join(runs[index], 'plan.json'), manifest);
    for (const slot of schedule) {
      if (slot.task_id === 'absent') continue;
      const status = {
        both: 'accepted', 'on-win': index === 0 ? 'accepted' : 'rejected',
        'off-win': index === 0 ? 'rejected' : 'accepted', neither: 'rejected',
        unparseable: index === 0 ? 'unparseable' : 'accepted',
        unavailable: index === 0 ? 'accepted' : 'unavailable',
        missing: index === 0 ? 'missing' : 'accepted',
        timeout: 'missing', failure: 'missing', 'only-on': 'accepted',
      }[slot.task_id];
      const failure = slot.task_id === 'timeout' ? 'timeout' : slot.task_id === 'failure' ? 'spawn_error' : null;
      const parsed = ['accepted', 'rejected', 'unavailable'].includes(status);
      const episode = {
        schema: 'mathconstruct-validator-episode/v1', ...slot, model: manifest.model, condition,
        attempted: true, status: failure ? (failure === 'timeout' ? 'timeout' : 'failed') : 'completed',
        failure, exit_code: failure ? null : 0, duration_ms: 123,
        text: 'ANSWER_SENTINEL tools.math_fake()', parsed_value: parsed ? [42] : null,
        parse: { status: parsed ? 'parsed' : 'unparseable', value: parsed ? [42] : null },
        validation_status: status,
        validator_receipt: parsed ? {
          schema: 'mathconstruct-validator/v1', task_id: slot.task_id, status,
          tag: status === 'accepted' ? 'CORRECT' : status === 'rejected' ? 'INCORRECT_LENGTH' : 'LOAD_ERROR', reason: 'test',
        } : null,
        raw_file: `${slot.episode_id}.raw.json`,
      };
      put(path.join(runs[index], 'episodes', `${slot.episode_id}.json`), episode);
    }
  }
  const episodePath = (condition, task) => path.join(runs[conditions.indexOf(condition)], 'episodes',
    `${schedules[condition].find(slot => slot.task_id === task).episode_id}.json`);
  const mutate = (file, change) => { const value = JSON.parse(files.get(file)); change(value); put(file, value); };
  const options = { runs, tasksFile, out: path.join(external, 'output') };
  return { io, files, dirs, aliases, put, mutate, episodePath, options, dependencies: { io, repo } };
}

test('separate classifications, completion, capture failures, parseability, and status task IDs', () => {
  const f = fixture();
  const result = summarize(f.options, f.dependencies);
  const on = result.conditions['plugin-on'], off = result.conditions['plugin-off'];
  assert.equal(result.schema, 'mathconstruct-validator-summary/v1');
  assert.deepEqual([on.scheduled, on.attempted, on.completed], [11, 10, 8]);
  assert.deepEqual([off.scheduled, off.attempted, off.completed], [10, 9, 7]);
  assert.deepEqual(on.validation_counts, { accepted: 4, rejected: 2, unparseable: 1, unavailable: 0, missing: 4 });
  assert.deepEqual(off.validation_counts, { accepted: 4, rejected: 2, unparseable: 0, unavailable: 1, missing: 3 });
  assert.deepEqual(on.status_task_ids.unparseable, ['unparseable']);
  assert.deepEqual(off.status_task_ids.unavailable, ['unavailable']);
  assert.deepEqual(on.status_task_ids.missing, ['absent', 'failure', 'missing', 'timeout']);
  assert.equal(on.capture.failures.count, 2);
  assert.deepEqual(on.capture.timeouts.task_ids, ['timeout']);
  assert.deepEqual(on.capture.failures_excluding_timeouts.task_ids, ['failure']);
  const row = id => on.rows.find(item => item.task_id === id);
  assert.equal(row('both').parsed_value_present, true);
  assert.equal(row('both').answer_parseable, true);
  assert.equal(row('both').duration_ms, 123);
  assert.equal(row('unparseable').answer_parseable, false);
  assert.equal(row('unparseable').parsed_value_present, false);
  assert.equal(row('absent').answer_parseable, null);
  assert.equal(row('absent').duration_ms, null);
  assert.equal(row('absent').attempted, false);
});

test('rejects a bare-prompt hash when answer_format is present', () => {
  const f = fixture();
  f.mutate(path.join(f.options.runs[0], 'manifest.json'), manifest => {
    manifest.schedule[0].prompt_sha256 = hash('Construct both');
  });
  assert.throws(() => summarize(f.options, f.dependencies), /invalid schedule identity/);
});

test('pairs require accepted/rejected on both sides; absent and unparseable are never wins', () => {
  const f = fixture();
  const pairs = summarize(f.options, f.dependencies).pairs;
  assert.deepEqual([pairs.total_slots, pairs.matched_slots, pairs.graded_slots], [11, 10, 4]);
  for (const outcome of ['both_accepted', 'on_only_accepted', 'off_only_accepted', 'neither']) assert.equal(pairs[outcome].count, 1);
  assert.equal(pairs.ungraded.count, 7);
  assert.deepEqual(pairs.on_only_accepted.task_ids, ['on-win']);
  assert.deepEqual(pairs.off_only_accepted.task_ids, ['off-win']);
  assert.deepEqual(pairs.neither.task_ids, ['neither']);
  const single = pairs.rows.find(row => row.task_id === 'only-on');
  assert.equal(single.outcome, 'ungraded');
  assert.equal(single.off_scheduled, false);
  assert.equal(single.off_status, 'missing');
});

test('plan-only snapshots and missing validation remain missing without answer fabrication', () => {
  const f = fixture();
  f.files.delete(path.join(f.options.runs[0], 'manifest.json'));
  f.mutate(f.episodePath('plugin-on', 'both'), episode => {
    delete episode.validation_status;
    delete episode.validator_receipt;
    delete episode.parse;
    delete episode.parsed_value;
  });
  const result = summarize(f.options, f.dependencies);
  const on = result.conditions['plugin-on'];
  assert.equal(on.source, 'plan.json');
  assert.equal(on.rows.find(row => row.task_id === 'both').validation_status, 'missing');
  assert.equal(on.rows.find(row => row.task_id === 'both').answer_parseable, null);
  assert.equal(result.pairs.both_accepted.count, 0);
  const json = f.files.get(path.join(f.options.out, 'summary.json'));
  for (const forbidden of ['SECRET_REFERENCE', 'ANSWER_SENTINEL', 'math_fake', '"parsed_value":', '"text":']) {
    assert.equal(json.includes(forbidden), false);
  }
  assert.equal(on.tool_use.call_sites, null);
  assert.equal(on.rows.every(row => row.tools === null), true);
});

test('parsed malformed representation stays unparseable; bridge protocol errors stay unavailable', () => {
  const f = fixture();
  f.mutate(f.episodePath('plugin-on', 'unparseable'), episode => {
    episode.parse = { status: 'parsed', value: {} };
    episode.parsed_value = {};
    episode.validator_receipt = {
      schema: 'mathconstruct-validator/v1', task_id: 'unparseable', status: 'rejected',
      tag: 'MALFORMED_ANSWER', reason: 'unsupported representation',
    };
  });
  f.mutate(f.episodePath('plugin-off', 'unavailable'), episode => {
    episode.validator_receipt.status = 'rejected';
    episode.validator_receipt.tag = 'INVALID_REQUEST';
  });
  const result = summarize(f.options, f.dependencies);
  const row = result.conditions['plugin-on'].rows.find(row => row.task_id === 'unparseable');
  assert.equal(row.answer_parseable, true);
  assert.equal(row.parsed_value_present, true);
  assert.equal(row.validation_status, 'unparseable');
  assert.equal(result.pairs.ungraded.count, 7);
});

test('tool extraction deduplicates snapshots and ignores answers, comments, strings, and output', () => {
  const events = [
    { role: 'user', parts: [{ tool: 'math_user' }] },
    { type: 'text', part: { tool: 'math_text', text: 'tools.math_answer()' } },
    { parts: [{ type: 'reasoning', tool: 'math_reasoning' }] },
    { part: { tool: 'math_compute', callID: 'a', state: { output: 'tools.math_output()' } } },
    { part: { tool: 'math_compute', callID: 'a' } },
    { part: { tool: 'execute', callID: 'b', state: { input: {
      code: 'await tools.math_compute({}); /* tools.math_comment() */\n"tools.math_string()";\n// tools.math_line()\nawait tools.math_status();',
    } } } },
    { part: { tool: 'execute', callID: 'b' } },
  ];
  const expected = {
    call_sites: { execute: 1, math_compute: 2, math_status: 1 },
    direct_tool_events: { execute: 1, math_compute: 1 },
    nested_math_call_sites: { math_compute: 1, math_status: 1 }, malformed_lines: 0,
  };
  assert.deepEqual(parseToolEvents(JSON.stringify({ events })), expected);
  assert.deepEqual(parseToolEvents(events.map(event => JSON.stringify(event)).join('\n')), expected);
  assert.equal(parseToolEvents('not-json\nnull\n').malformed_lines, 1);
  const f = fixture();
  const raw = f.episodePath('plugin-on', 'both').replace(/\.json$/, '.raw.json');
  f.files.set(raw, `${events.map(event => JSON.stringify(event)).join('\n')}\nbroken`);
  const tools = summarize(f.options, f.dependencies).conditions['plugin-on'].tool_use;
  assert.deepEqual(tools.call_sites, expected.call_sites);
  assert.equal(tools.raw_logs_present, 1);
  assert.equal(tools.raw_logs_missing, 10);
  assert.equal(tools.malformed_lines, 1);
  assert.match(tools.evidence, /not verified execution/);
});

test('refuse relative, repo-contained, existing empty/nonempty/file, and linked output paths', () => {
  const f = fixture();
  const empty = path.join(external, 'empty'), nonempty = path.join(external, 'nonempty');
  f.dirs.add(empty);
  f.dirs.add(nonempty);
  f.files.set(path.join(nonempty, 'keep'), 'KEEP');
  const file = path.join(external, 'file');
  f.files.set(file, 'KEEP');
  const alias = path.join(external, 'repo-link');
  f.aliases.set(alias, repo);
  const cases = [
    ['relative', /absolute/], [path.join(repo, 'output'), /inside repo/],
    [empty, /exists/], [nonempty, /exists/], [file, /exists/],
    [path.join(alias, 'output'), /inside repo/],
  ];
  const before = [...f.files];
  for (const [out, pattern] of cases) assert.throws(() => summarize({ ...f.options, out }, f.dependencies), pattern);
  assert.deepEqual([...f.files], before);
});

test('JSON and Markdown are byte-deterministic, including reversed run/schedule order', () => {
  const f = fixture();
  main(['--run', f.options.runs[0], '--run', f.options.runs[1], '--tasks', f.options.tasksFile, '--out', f.options.out], f.dependencies);
  for (const run of f.options.runs) f.mutate(path.join(run, 'manifest.json'), manifest => manifest.schedule.reverse());
  const second = path.join(external, 'second');
  summarize({ ...f.options, runs: [...f.options.runs].reverse(), out: second }, f.dependencies);
  for (const name of ['summary.json', 'summary.md']) {
    assert.equal(f.files.get(path.join(f.options.out, name)), f.files.get(path.join(second, name)));
  }
  const markdown = f.files.get(path.join(second, 'summary.md'));
  for (const phrase of ['constructions only', 'not informal proof quality', 'one repeat',
    'only the tasks with a validator', 'Unparseable is not incorrect', 'not verified execution']) {
    assert.ok(markdown.includes(phrase), phrase);
  }
  assert.throws(() => summarize(f.options, f.dependencies), /exists/);
});

test('reject mismatched identity, task hashes, duplicate slots, and accepted failed captures before writing', () => {
  for (const mutate of [
    f => f.mutate(path.join(f.options.runs[0], 'manifest.json'), manifest => { manifest.task_file_sha256 = 'wrong'; }),
    f => f.mutate(f.episodePath('plugin-on', 'both'), episode => { episode.task_id = 'other'; }),
    f => f.mutate(path.join(f.options.runs[0], 'manifest.json'), manifest => { manifest.schedule.push(manifest.schedule[0]); }),
    f => f.mutate(f.episodePath('plugin-on', 'both'), episode => { episode.status = 'failed'; episode.failure = 'spawn_error'; }),
    f => f.mutate(f.episodePath('plugin-on', 'both'), episode => { episode.validator_receipt = null; }),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => summarize(f.options, f.dependencies), /mismatch|identity/);
    assert.equal(f.dirs.has(f.options.out), false);
  }
});
