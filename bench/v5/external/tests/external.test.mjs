import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertFreshOutput, parseOptions, sha256, validateTasks,
} from '../schema.mjs';
import { extractOutput, pluginEnvironment, runStudy } from '../run.mjs';
import { extractFinal, gradeEpisode, gradeRun, normalizeSymbolic } from '../grade.mjs';
import { buildReport, markdown, validateBaselines, writeReport } from '../report.mjs';

const ROOT = path.resolve(path.parse(process.cwd()).root, 'external-bench-memory-only');
const REPO = path.join(ROOT, 'repo');
const WORKSPACE = path.join(ROOT, 'workspace');
const TASKS = path.join(ROOT, 'private-tasks.json');
const location = name => path.join(ROOT, name);
const task = (overrides = {}) => ({
  schema: 'math-bench-task/v1', benchmark: 'fixture', id: 'q1',
  prompt: 'Compute six times seven. Return the final answer.',
  answer: '42', grading: { type: 'integer' }, metadata: {}, ...overrides,
});
const completed = text => ({ status: 'completed', exit_code: 0, text });
const error = code => Object.assign(new Error(code), { code });

// No OS writes, subprocesses, network, model calls, or platform dependencies.
function memoryIO() {
  const files = new Map(), directories = new Set([ROOT, REPO, WORKSPACE]);
  const key = file => path.resolve(file);
  return {
    files, directories,
    existsSync(file) { return files.has(key(file)) || directories.has(key(file)); },
    lstatSync(file) { if (!this.existsSync(file)) throw error('ENOENT'); return {}; },
    realpathSync(file) { if (!this.existsSync(file)) throw error('ENOENT'); return key(file); },
    mkdirSync(file) {
      if (this.existsSync(file)) throw error('EEXIST');
      if (!directories.has(path.dirname(key(file)))) throw error('ENOENT');
      directories.add(key(file));
    },
    writeFileSync(file, data, options = {}) {
      if (options.flag === 'wx' && this.existsSync(file)) throw error('EEXIST');
      if (!directories.has(path.dirname(key(file)))) throw error('ENOENT');
      files.set(key(file), String(data));
    },
    readFileSync(file, encoding) {
      if (!files.has(key(file))) throw error('ENOENT');
      return encoding ? files.get(key(file)) : Buffer.from(files.get(key(file)));
    },
  };
}

function setup(tasks = [task()]) {
  const io = memoryIO();
  io.writeFileSync(TASKS, JSON.stringify(tasks));
  let clock = 0;
  const dependencies = { io, repo: REPO, inheritedEnv: {}, executable: 'fake-opencode', now: () => clock++ };
  return { io, dependencies };
}

const cliResult = (text, extras = {}) => ({
  status: 0, stdout: JSON.stringify({ type: 'text', part: { text, messageID: 'final' } }), stderr: '', ...extras,
});

function capture(dependencies, condition = 'plugin-on', runner = () => cliResult('42'), options = {}) {
  return runStudy({
    tasksFile: TASKS, model: 'provider/model', condition, out: location(condition),
    workspace: WORKSPACE, ...options,
  }, { ...dependencies, runner });
}

test('schema accepts closed public tasks with evaluator gold and metadata', () => {
  const tasks = [task({ metadata: { source: 'public', license: 'CC0', contest: 'fixture', year: 2026, problem_number: 1, url: 'https://example.invalid' } })];
  assert.equal(validateTasks(tasks), tasks);
  validateTasks([task({ answer: null, grading: { type: 'exact', answer: 'yes', tolerance: 0 } })]);
});

test('schema rejects unknown keys at every level and missing fields', () => {
  for (const invalid of [
    task({ extra: true }), task({ grading: { type: 'integer', flag: '--evil' } }),
    task({ metadata: { secret: 'not public' } }), task({ prompt: ' ' }),
    task({ answer: undefined }), task({ metadata: undefined }), task({ schema: 'wrong' }),
  ]) assert.throws(() => validateTasks([invalid]));
  assert.throws(() => validateTasks([]));
});

test('ids are unique within benchmark, not across benchmarks', () => {
  assert.throws(() => validateTasks([task(), task()]), /duplicate/);
  validateTasks([task(), task({ benchmark: 'other' })]);
});

test('answer-in-prompt check refuses case-insensitive long gold and grading override', () => {
  assert.throws(() => validateTasks([task({ answer: 'SecretAnswer', prompt: 'Copy SECRETANSWER' })]), /embedded/);
  assert.throws(() => validateTasks([task({ answer: null, grading: { type: 'exact', answer: 'abcdefgh' }, prompt: 'ABCDEFGH' })]), /embedded/);
  validateTasks([task({ answer: 'short', prompt: 'short' })]);
});

test('unknown grader, conflicting answers, invalid metadata and unsupported tolerance fail', () => {
  assert.throws(() => validateTasks([task({ grading: { type: 'model-judge' } })]), /unknown grading/);
  assert.throws(() => validateTasks([task({ grading: { type: 'integer', answer: '43' } })]), /conflicting/);
  assert.throws(() => validateTasks([task({ metadata: { year: '2026' } })]), /metadata/);
  for (const tolerance of [-1, 0.1, NaN, '1']) {
    assert.throws(() => validateTasks([task({ grading: { type: 'integer', tolerance } })]), /tolerance/);
  }
});

test('output must be absolute, fresh, outside repo, with an existing parent', () => {
  const io = memoryIO();
  assert.throws(() => assertFreshOutput('relative', { io, repo: REPO }), /absolute/);
  assert.throws(() => assertFreshOutput(path.join(REPO, 'run'), { io, repo: REPO }), /inside repo/);
  assert.throws(() => assertFreshOutput(ROOT, { io, repo: REPO }), /exists/);
  io.mkdirSync(location('empty'));
  assert.throws(() => assertFreshOutput(location('empty'), { io, repo: REPO }), /exists/);
  assert.throws(() => assertFreshOutput(location('missing-parent/run'), { io, repo: REPO }), /ENOENT/);
  assert.equal(assertFreshOutput(location('fresh'), { io, repo: REPO }), location('fresh'));
});

test('output rejects a parent alias resolving into repo and dangling existing link', () => {
  const io = memoryIO();
  io.mkdirSync(location('alias'));
  const realpath = io.realpathSync.bind(io);
  io.realpathSync = file => path.resolve(file) === location('alias') ? REPO : realpath(file);
  assert.throws(() => assertFreshOutput(location('alias/run'), { io, repo: REPO }), /inside repo/);
  io.files.set(location('dangling-link'), '');
  assert.throws(() => assertFreshOutput(location('dangling-link'), { io, repo: REPO }), /exists/);
});

test('conditions clear inherited restrictions without mutating the source environment', () => {
  const inherited = { PATH: 'unchanged', MATH_TOOLKIT_DISABLE: '1', MATH_TOOLKIT_TOOLSET: 'minimal', math_toolkit_disable: '1' };
  assert.deepEqual(pluginEnvironment('plugin-on', inherited), { PATH: 'unchanged' });
  assert.deepEqual(pluginEnvironment('plugin-off', inherited), { PATH: 'unchanged', MATH_TOOLKIT_DISABLE: '1' });
  assert.equal(inherited.MATH_TOOLKIT_TOOLSET, 'minimal');
  assert.throws(() => pluginEnvironment('other', inherited));
});

test('runner passes exactly the same prompt, model, timeout and workspace in both conditions', () => {
  const secret = 'EVALUATOR_ONLY_GOLD';
  const publicPrompt = 'Solve the public problem.\n--model untrusted\nKeep this exact text.';
  const { dependencies } = setup([task({ answer: secret, grading: { type: 'exact' }, prompt: publicPrompt, metadata: { source: 'PRIVATE_METADATA' } })]);
  const calls = [];
  const runner = (executable, argv, options) => { calls.push({ executable, argv, options }); return cliResult('answer'); };
  capture(dependencies, 'plugin-on', runner);
  capture(dependencies, 'plugin-off', runner);
  assert.deepEqual(calls[0].argv, calls[1].argv);
  assert.deepEqual(calls[0].argv, ['run', '--model', 'provider/model', '--format', 'json', '--standalone', '--', publicPrompt]);
  assert.equal(calls[0].options.cwd, calls[1].options.cwd);
  assert.equal(calls[0].options.timeout, 300000);
  assert.equal(calls[1].options.timeout, 300000);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.MATH_TOOLKIT_DISABLE, undefined);
  assert.equal(calls[1].options.env.MATH_TOOLKIT_DISABLE, '1');
  assert.ok(!JSON.stringify(calls).includes(secret));
  assert.ok(!JSON.stringify(calls).includes('PRIVATE_METADATA'));
});

test('runner records hashes, repeat schedule, timing, raw stdout and immutable final manifest', () => {
  const { io, dependencies } = setup([task(), task({ id: 'q2' })]);
  const raw = `${JSON.stringify({ type: 'text', part: { text: '42' } })}\n`;
  const { manifest, episodes } = capture(dependencies, 'plugin-on', () => cliResult('', { stdout: raw }), { repeat: 2, limit: 1 });
  assert.equal(manifest.schedule.length, 2);
  assert.equal(episodes.length, 2);
  assert.equal(manifest.task_file_sha256, sha256(io.readFileSync(TASKS)));
  assert.equal(manifest.schedule[0].prompt_sha256, sha256(task().prompt));
  assert.equal(manifest.exploratory, true);
  assert.equal(manifest.not_confirmatory, true);
  assert.ok(manifest.started_at < manifest.ended_at);
  assert.ok(episodes.every(row => row.duration_ms > 0 && row.status === 'completed'));
  assert.equal(io.readFileSync(location('plugin-on/episodes/t1-r1.raw.json'), 'utf8'), raw);
  assert.throws(() => { manifest.model = 'changed'; }, TypeError);
  assert.throws(() => { manifest.schedule[0].task_id = 'changed'; }, TypeError);
  assert.throws(() => io.writeFileSync(location('plugin-on/manifest.json'), '{}', { flag: 'wx' }), /EEXIST/);
  assert.throws(() => capture(dependencies), /exists/);
  assert.ok(!io.readFileSync(location('plugin-on/manifest.json'), 'utf8').includes('"answer"'));
});

test('invalid runner inputs fail before any dispatch', () => {
  for (const options of [{ repeat: 0 }, { limit: -1 }, { timeoutMs: 0 }, { model: 'unqualified' }, { out: 'relative' }]) {
    const { dependencies } = setup();
    assert.throws(() => capture(dependencies, 'plugin-on', () => assert.fail('must not dispatch'), options));
  }
});

test('runner records failure classes and never retries or falls back', () => {
  for (const [result, expected] of [
    [cliResult('42', { status: 2 }), 'nonzero_exit'],
    [cliResult('42', { error: error('ETIMEDOUT') }), 'timeout'],
    [cliResult('42', { error: error('ENOENT') }), 'spawn_error'],
    [cliResult('42', { signal: 'SIGTERM' }), 'signal'],
    [cliResult('42', { stdout: 'not json' }), 'invalid_json'],
    [cliResult(''), 'empty_answer'],
    [cliResult('', { stdout: JSON.stringify({ type: 'error', error: 'upstream failed' }) }), 'cli_error'],
  ]) {
    const { dependencies } = setup();
    let calls = 0;
    const captured = capture(dependencies, 'plugin-on', () => { calls++; return result; });
    assert.equal(calls, 1);
    assert.equal(captured.episodes[0].failure, expected);
    assert.notEqual(captured.episodes[0].status, 'completed');
  }
});

test('extractor keeps final assistant message only, not tools, user text or reasoning', () => {
  const events = [
    { type: 'text', part: { text: 'old reasoning answer', messageID: 'm1' } },
    { type: 'tool_use', part: { state: { output: { type: 'text', text: 'tool answer' } } } },
    { type: 'text', role: 'user', part: { text: 'user answer' } },
    { type: 'reasoning', part: { text: 'hidden reasoning' } },
    { type: 'text', part: { text: 'Final: ', messageID: 'm2' } },
    { type: 'text', part: { text: '42', messageID: 'm2' } },
  ];
  assert.equal(extractOutput(events.map(JSON.stringify).join('\n')).text, 'Final: 42');
  assert.equal(extractOutput(JSON.stringify([{ type: 'text', part: { text: 'old' } }, { type: 'text', part: { text: '42' } }])).text, '42');
});

test('usage preserves arbitrary fields and refuses unknown/cumulative accounting', () => {
  const events = [
    { type: 'step_finish', part: { cost: 0.1, tokens: { input: 10, output: 2, cache: { read: 4 } }, custom: 'kept' } },
    { type: 'step_finish', part: { cost: 0.2, tokens: { input: 20, output: 3 } } },
  ];
  const parsed = extractOutput(JSON.stringify(events));
  assert.equal(parsed.usage.input_tokens, 30);
  assert.equal(parsed.usage.output_tokens, 5);
  assert.equal(parsed.usage.cache_read_tokens, null);
  assert.ok(Math.abs(parsed.usage.cost - 0.3) < 1e-12);
  assert.equal(parsed.usage_records[0].custom, 'kept');
  assert.equal(extractOutput(JSON.stringify([{ usage: { cost: 1 } }, { usage: { cost: 2 } }])).usage, null);
  assert.equal(extractOutput(JSON.stringify({ usage: { input_tokens: 12, output_tokens: 3 } })).usage.cost, null);
});

test('final answer convention supports nested boxes, final labels, and last nonempty line', () => {
  assert.equal(extractFinal('Earlier: 9\n\\boxed{\\frac{1}{2}}'), '\\frac{1}{2}');
  assert.equal(extractFinal('\\boxed{9}\nFinal answer: 42'), '42');
  assert.equal(extractFinal('work\n\n42\n'), '42');
  assert.equal(extractFinal('\\boxed{42'), null);
});

test('integer grades last integer exactly, including signed huge integers', () => {
  assert.equal(gradeEpisode(completed('Tried 4\nFinal answer: 7 then 42'), task()).status, 'correct');
  assert.equal(gradeEpisode(completed('\\boxed{43}'), task()).status, 'incorrect');
  const big = '-900719925474099312345';
  assert.equal(gradeEpisode(completed(`Answer: ${big}`), task({ answer: big })).status, 'correct');
  assert.equal(gradeEpisode(completed('+0042'), task()).status, 'correct');
});

test('integer rejects decimals, fractions, scientific notation and absent integer', () => {
  for (const text of ['42.5', '42/1', '4e2', '\\frac{42}{1}', 'no result']) {
    assert.equal(gradeEpisode(completed(text), task()).status, 'unparseable', text);
  }
});

test('exact grades normalize case, whitespace and LaTeX delimiters, not solver claims', () => {
  const exact = task({ answer: 'Hello World', grading: { type: 'exact' } });
  assert.equal(gradeEpisode(completed('Final answer: \\( HELLO   world \\)'), exact).status, 'correct');
  assert.equal(gradeEpisode(completed('I am correct.'), exact).status, 'incorrect');
  assert.equal(gradeEpisode(completed('Answer: $$'), exact).status, 'unparseable');
});

test('symbolic normalization accepts bounded syntax and identical canonical strings', () => {
  const symbolic = task({ answer: '(x+1)', grading: { type: 'symbolic' } });
  assert.equal(gradeEpisode(completed('\\boxed{$\\left( x\\, + 1\\! \\right)$}'), symbolic).status, 'correct');
  assert.equal(normalizeSymbolic('\\frac{1}{\\sqrt{2}}'), '\\frac{1}{\\sqrt{2}}');
  assert.equal(gradeEpisode(completed('5'), task({ answer: '4', grading: { type: 'symbolic' } })).status, 'incorrect');
});

test('symbolic differences are unparseable, not guessed inequivalent', () => {
  const symbolic = task({ answer: 'x+x', grading: { type: 'symbolic' } });
  for (const text of ['2*x', 'x+1', '\\sin{x}', 'x++', '(x', 'probably correct', 'x'.repeat(513)]) {
    assert.equal(gradeEpisode(completed(text), symbolic).status, 'unparseable', text);
  }
});

test('missing and unparseable remain distinct; partial failed output never passes', () => {
  for (const episode of [null, completed(''), { ...completed('42'), status: 'timeout' }, { ...completed('42'), exit_code: 1 }]) {
    assert.equal(gradeEpisode(episode, task()).status, 'missing');
  }
  assert.equal(gradeEpisode(completed('42'), task({ answer: null })).status, 'unparseable');
});

test('grading uses frozen task hash and leaves every run artifact unchanged', () => {
  const { io, dependencies } = setup();
  capture(dependencies);
  const before = new Map(io.files);
  const summary = gradeRun({ run: location('plugin-on'), tasksFile: TASKS, out: location('grades-on') }, dependencies);
  assert.equal(summary.rows[0].grade.status, 'correct');
  for (const [file, content] of before) assert.equal(io.files.get(file), content);
  io.writeFileSync(TASKS, JSON.stringify([task({ answer: '43' })]));
  assert.throws(() => gradeRun({ run: location('plugin-on'), tasksFile: TASKS, out: location('changed') }, dependencies), /mismatch/);
});

test('interrupted plan records missing scheduled episodes; grader injection is hermetic', () => {
  const { io, dependencies } = setup();
  capture(dependencies);
  io.files.delete(location('plugin-on/manifest.json'));
  io.files.delete(location('plugin-on/episodes/t1-r1.json'));
  let calls = 0;
  const summary = gradeRun({ run: location('plugin-on'), tasksFile: TASKS, out: location('grades') }, {
    ...dependencies, grader: (episode, suppliedTask) => {
      calls++;
      assert.equal(episode, null);
      assert.equal(suppliedTask.answer, '42');
      return gradeEpisode(episode, suppliedTask);
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.rows[0].attempted, false);
  assert.equal(summary.rows[0].grade.status, 'missing');
});

function pairedFixture() {
  const tasks = Array.from({ length: 5 }, (_, index) => task({ id: `q${index}` }));
  const { io, dependencies } = setup(tasks);
  const answers = {
    'plugin-on': ['42', '42', '0', '0', 'not an integer'],
    'plugin-off': ['42', '0', '42', '0', null],
  };
  const summaries = [];
  for (const condition of ['plugin-on', 'plugin-off']) {
    let i = 0;
    capture(dependencies, condition, () => {
      const text = answers[condition][i++];
      if (text === null) return cliResult('', { error: error('ETIMEDOUT'), status: null });
      return cliResult('', { stdout: [
        JSON.stringify({ type: 'text', part: { text } }),
        JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 2 }, cost: 0.1 } }),
      ].join('\n') });
    });
    summaries.push(gradeRun({ run: location(condition), tasksFile: TASKS, out: location(`grades-${condition}`) }, dependencies));
  }
  return { io, dependencies, summaries };
}

test('report counts paired successes separately from ungraded and external baselines', () => {
  const { summaries } = pairedFixture();
  const baseline = [{ benchmark: 'fixture', model: 'different/model', score: '80%', source: 'registered table', notes: 'different tasks/version' }];
  const report = buildReport(summaries, baseline);
  const row = report.benchmarks[0];
  assert.deepEqual(row.paired, { matched: 5, both: 1, on_only: 1, off_only: 1, neither: 1, ungraded: 1, unmatched: 0 });
  const on = row.conditions['plugin-on'], off = row.conditions['plugin-off'];
  assert.equal(on.scheduled, 5);
  assert.equal(on.attempted, 5);
  assert.equal(on.completed, 5);
  assert.equal(on.correct, 2);
  assert.equal(on.incorrect, 2);
  assert.equal(on.unparseable, 1);
  assert.equal(on.missing, 0);
  assert.equal(off.completed, 4);
  assert.equal(off.missing, 1);
  assert.equal(on.accuracy_among_graded, 0.5);
  assert.equal(on.pass_rate_all_scheduled, 0.4);
  assert.equal(off.usage.cost.total, null);
  assert.equal(off.usage.cost.known_subtotal, 0.4);
  assert.equal(on.usage.input_tokens.total, 50);
  assert.equal(row.external_baseline[0].label, 'external_baseline');
  const md = markdown(report);
  for (const phrase of ['external_baseline', '80%', 'registered table', 'Exploratory', 'One repeat', 'drift', 'Retrieval-assisted']) assert.ok(md.includes(phrase), phrase);
});

test('report refuses protocol drift, duplicate conditions and malformed rows', () => {
  const { summaries } = pairedFixture();
  assert.throws(() => buildReport([summaries[0], summaries[0]]), /duplicate paired/);
  const changed = structuredClone(summaries);
  changed[1].manifest.timeout_ms++;
  assert.throws(() => buildReport(changed), /protocol mismatch/);
  const wrong = structuredClone(summaries);
  wrong[0].rows[0].model = 'other/model';
  assert.throws(() => buildReport(wrong), /invalid grade row/);
  assert.equal(buildReport([summaries[0]]).benchmarks[0].paired.unmatched, 5);
});

test('report CLI writer emits JSON and Markdown without altering runs or grades', () => {
  const { io, dependencies } = pairedFixture();
  const before = new Map(io.files);
  const report = writeReport({
    grades: [location('grades-plugin-on/grades.json'), location('grades-plugin-off/grades.json')], out: location('report'),
  }, dependencies);
  assert.equal(JSON.parse(io.readFileSync(location('report/report.json'), 'utf8')).schema, report.schema);
  assert.match(io.readFileSync(location('report/report.md'), 'utf8'), /ON-only/);
  for (const [file, content] of before) assert.equal(io.files.get(file), content);
  assert.throws(() => writeReport({ grades: [location('grades-plugin-on/grades.json')], out: location('report') }, dependencies), /exists/);
});

test('external baseline validation never interprets or pools score units', () => {
  assert.equal(validateBaselines([{ benchmark: 'b', model: 'm', score: 83, source: 's' }])[0].score, 83);
  assert.throws(() => validateBaselines([{ benchmark: 'b', model: 'm', score: 83, source: 's', correct: 83 }]), /closed keys/);
});

test('CLI parser rejects unknown/duplicate flags and permits repeated grade files', () => {
  assert.throws(() => parseOptions(['--force', 'true'], ['--out']), /invalid option/);
  assert.throws(() => parseOptions(['--out', 'a', '--out', 'b'], ['--out']), /duplicate/);
  assert.throws(() => parseOptions(['--out'], ['--out']), /invalid option/);
  assert.deepEqual(parseOptions(['--grades', 'a', '--grades', 'b'], ['--grades'], ['--grades']), { '--grades': ['a', 'b'] });
});
