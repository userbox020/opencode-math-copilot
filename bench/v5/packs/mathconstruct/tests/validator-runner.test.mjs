import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseFinalAnswer } from '../parse-answer.mjs';
import { exactJSON, gradeAnswer, pluginEnvironment, runStudy, main } from '../run-validator.mjs';
import { assertFreshOutput, sha256 } from '../../../external/schema.mjs';

const longAnswer = String.raw`FINAL: $\boxed{10000003, -10000002, 100000050000007, 10000010000003800000650000043}$`;
const longValues = [10000003, -10000002, 100000050000007, 10000010000003800000650000043n];
const longJSON = '[10000003,-10000002,100000050000007,10000010000003800000650000043]';

const cases = [
  ['FINAL list', 'Proof\nFINAL: [1,2,3]', [1, 2, 3]],
  ['nested list', 'FINAL: [[1,2],[[3,4]]]', [[1, 2], [[3, 4]]]],
  ['number', 'FINAL: 42', 42],
  ['string', 'FINAL: "1/2"', '1/2'],
  ['object', 'FINAL: {"vertices":[1,2]}', { vertices: [1, 2] }],
  ['JSON fence', 'Explanation\n```json\n[1,2]\n```\nDone.', [1, 2]],
  ['unlabelled fence', '```\n{"a":[1]}\n```', { a: [1] }],
  ['CRLF fence', '```json\r\n[[1]]\r\n```\r\n', [[1]]],
  ['last fence', '```json\n[1]\n```\n```json\n[2]\n```', [2]],
  ['plain array', 'Explanation\n[1,2]\n\n', [1, 2]],
  ['multiline object', 'Explanation\n{\n "a": [[1,2]]\n}\n', { a: [[1, 2]] }],
  ['dollar boxed', String.raw`FINAL: $\boxed{[1,2]}$`, [1, 2]],
  ['display boxed', String.raw`FINAL: \[\boxed{[[1],[2]]}\]`, [[1], [2]]],
  ['double dollar', String.raw`FINAL: $$\boxed{3}$$`, 3],
  ['inline wrapper', String.raw`FINAL: \("1/3"\)`, '1/3'],
  ['boxed graph', String.raw`FINAL: \boxed{[[1,2,3], [[1,2],[1,3]]]}`, [[1, 2, 3], [[1, 2], [1, 3]]]],
  ['display style and sizing', String.raw`FINAL: $\displaystyle \boxed{\left[1,\left[2\right]\right]}$`, [1, [2]]],
  ['text wrapper', String.raw`FINAL: \(\text{\boxed{[1,2]}}\)`, [1, 2]],
  ['boxed object with quoted braces', String.raw`FINAL: \boxed{{"a":[1],"label":"} { \" end"}}`, { a: [1], label: '} { " end' }],
  ['sizing string preserved', String.raw`FINAL: \boxed{["\\left[", "\\right]"]}`, [String.raw`\left[`, String.raw`\right]`]],
  ['string wrappers preserved', String.raw`FINAL: "$\\boxed{literal}$"`, String.raw`$\boxed{literal}$`],
  ['empty FINAL followed by JSON fence', 'FINAL:\n```json\n[1]\n```', [1]],
  ['last FINAL', 'FINAL: [1]\nCorrection\nFINAL: [2]', [2]],
  ['flat boxed list', String.raw`FINAL: \boxed{1, 2, 3}`, [1, 2, 3]],
  ['long exact boxed list', longAnswer, longValues],
  ['flat decimals and strings', String.raw`FINAL: \boxed{1.25, -.5, 2e-3, x, 1/2}`, [1.25, -0.5, 0.002, 'x', '1/2']],
  ['nested scalar commas stay intact', 'FINAL: 1, f(2,3), g[4,5], h{6,7}', [1, 'f(2,3)', 'g[4,5]', 'h{6,7}']],
  ['integer precision boundaries', 'FINAL: 9007199254740991, 9007199254740992, -9007199254740992',
    [9007199254740991, 9007199254740992n, -9007199254740992n]],
  ['quoted commas stay intact', 'FINAL: 1, "a,b"', [1, '"a,b"']],
];
for (const [name, text, value] of cases) {
  test(`parse: ${name}`, () => {
    assert.deepEqual(parseFinalAnswer(text, { answerFormat: 'Never use example [999]' }),
      { status: 'parsed', value, reason: null });
  });
}
for (const [name, text] of [
  ['prose', 'The desired graph exists.'],
  ['prose construction', 'FINAL: Take three vertices and join vertex 1 to vertices 2 and 3.'],
  ['boxed prose', String.raw`FINAL: \boxed{\text{Take a star graph}}`],
  ['unbalanced box', String.raw`FINAL: \boxed{[[1],[2]]`],
  ['extra closing brace', String.raw`FINAL: \boxed{[1]}}`],
  ['multiple boxes', String.raw`FINAL: \boxed{[1]}\boxed{[2]}`],
  ['text cannot concatenate numbers', String.raw`FINAL: [1\text{2}]`],
  ['malformed', 'FINAL: [1,]'],
  ['tuple', String.raw`FINAL: $\boxed{(1,2)}$`],
  ['comma prose', 'FINAL: Take three vertices, then join them.'],
  ['empty scalar', 'FINAL: 1,,2'],
  ['trailing comma', 'FINAL: 1,2,'],
  ['unbalanced scalar', 'FINAL: 1, f(2,3'],
  ['nested collections are not flat scalars', 'FINAL: 1, [2,3]'],
  ['malformed JSON not salvaged', 'FINAL: [1,2], 3'],
  ['nonfinite decimal list', 'FINAL: 1, 1e999'],
  ['fences remain JSON only', '```json\n1,2,3\n```'],
  ['fraction expression', 'FINAL: [1/2]'],
  ['unsafe integer', 'FINAL: [9007199254740993]'],
  ['nonfinite', 'FINAL: [1e999]'],
  ['null', 'FINAL: null'],
  ['boolean', 'FINAL: true'],
  ['explicit malformed takes precedence', '```json\n[1]\n```\nFINAL: not JSON'],
  ['do not salvage nested array', '[\n [1]\n'],
  ['trailing prose', '[1]\nThis is not a trailing JSON payload.'],
  ['no answer', ''],
]) {
  test(`unparseable: ${name}`, () => {
    const parsed = parseFinalAnswer(text, { answerFormat: 'Example [999]' });
    assert.equal(parsed.status, 'unparseable');
    assert.equal(parsed.value, null);
    assert.equal(typeof parsed.reason, 'string');
  });
}

test('exactJSON preserves integer digits, nesting, property order, and JSON scalars', () => {
  assert.equal(exactJSON(longValues), longJSON);
  assert.equal(exactJSON({ answer: longValues, nested: { negative: -9007199254740992n },
    label: 'a"b', decimal: 1.25, ok: true, empty: null }),
  `{"answer":${longJSON},"nested":{"negative":-9007199254740992},"label":"a\\"b","decimal":1.25,"ok":true,"empty":null}`);
});

const repo = path.resolve('/virtual-repo');
const outside = path.resolve('/virtual-results');
const workspace = path.resolve('/clean-workspace');
const tasksFile = path.join(repo, 'pilot.json');
const fixture = (id = 'fixture') => ({
  schema: 'math-bench-task/v1', benchmark: 'mathconstruct', id,
  prompt: 'Construct an example.\nFINAL: <answer>',
  answer: 'SECRET_REFERENCE_ANSWER',
  grading: { type: 'validator', validator: 'SECRET_VALIDATOR',
    answer_format: String.raw`Last line: FINAL: <answer>. Format the final output as $\boxed{[vertices, edges]}$. For example, $\boxed{[[1,2,3], [[1, 2], [1, 3]]]}$.` },
  validation: { expected: 'SECRET_VALIDATION' },
  metadata: { parameters: ['n'], original_parameters: { n: 3 }, hidden: 'SECRET_METADATA' },
});
const receipt = (status = 'accepted', tag = 'CORRECT', taskId = 'fixture') => ({
  schema: 'mathconstruct-validator/v1', task_id: taskId, status, tag, reason: 'fake receipt',
});
const capture = text => ({
  status: 0, stdout: JSON.stringify({ role: 'assistant', id: 'final', parts: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 } }), stderr: '',
});

// All filesystem effects remain in memory, including output claiming. No model,
// Python, temporary directory, or installed executable is needed by this suite.
function memoryIO(tasks = [fixture()]) {
  const files = new Map([[tasksFile, Buffer.from(JSON.stringify(tasks))]]);
  const directories = new Set([repo, outside, workspace]);
  const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
  return {
    files, directories,
    readFileSync(file) { if (!files.has(file)) throw missing(); return files.get(file); },
    lstatSync(file) { if (!files.has(file) && !directories.has(file)) throw missing(); return {}; },
    realpathSync(file) { if (!directories.has(file)) throw missing(); return file; },
    mkdirSync(file) {
      assert.ok(!files.has(file) && !directories.has(file), 'no overwrite');
      assert.ok(directories.has(path.dirname(file)), 'parent exists');
      directories.add(file);
    },
    writeFileSync(file, data, options) {
      assert.equal(options.flag, 'wx');
      assert.ok(!files.has(file), 'no overwrite');
      assert.ok(directories.has(path.dirname(file)), 'parent exists');
      files.set(file, data);
    },
  };
}
function study(overrides = {}, dependencies = {}) {
  const io = dependencies.io ?? memoryIO();
  const result = runStudy({
    tasksFile, model: 'provider/model', condition: 'plugin-on', out: path.join(outside, 'fresh'),
    ...overrides,
  }, {
    io, repo, executable: 'fake-opencode', python: 'fake-python',
    inheritedEnv: { EXTERNAL_BENCH_WORKSPACE: workspace },
    runner: () => capture('FINAL: [1]'),
    bridgeRunner: () => ({ status: 0, stdout: JSON.stringify(receipt()) }),
    now: () => 1000, ...dependencies,
  });
  return { ...result, io };
}

test('output refuses relative paths, repo paths, existing empty/nonempty dirs, and symlink aliases', () => {
  const io = memoryIO();
  assert.throws(() => assertFreshOutput('relative', { io, repo }), /absolute/);
  assert.throws(() => assertFreshOutput(path.join(repo, 'new'), { io, repo }), /inside repo/);
  for (const name of ['empty', 'nonempty']) {
    const out = path.join(outside, name);
    io.directories.add(out);
    if (name === 'nonempty') io.files.set(path.join(out, 'existing'), 'keep');
    assert.throws(() => study({ out }, { io, runner: () => assert.fail('must not run') }), /exists/);
  }
  const alias = path.resolve('/alias');
  const linked = { ...io, realpathSync: file => file === alias ? repo : io.realpathSync(file) };
  assert.throws(() => assertFreshOutput(path.join(alias, 'fresh'), { io: linked, repo }), /inside repo/);
});

test('condition mapping clears inherited switches case-insensitively without mutation', () => {
  const inherited = { Math_Toolkit_Disable: '1', math_toolkit_toolset: 'minimal', KEEP: 'yes' };
  assert.deepEqual(pluginEnvironment('plugin-on', inherited), { KEEP: 'yes' });
  assert.deepEqual(pluginEnvironment('plugin-off', inherited), { KEEP: 'yes', MATH_TOOLKIT_DISABLE: '1' });
  assert.equal(inherited.Math_Toolkit_Disable, '1');
  assert.throws(() => pluginEnvironment('other', inherited), /condition/);
});

test('both conditions append the required format exactly once and never leak evaluator fields', () => {
  const calls = [];
  const expectedPrompt = `${fixture().prompt}\n\nRequired answer format:\n${fixture().grading.answer_format}`;
  for (const condition of ['plugin-on', 'plugin-off']) {
    const result = study({ condition }, {
      runner(executable, args, options) {
        calls.push({ executable, args, options });
        return capture('FINAL: [1]');
      },
      bridgeRunner(executable, args, options) {
        assert.equal(executable, 'fake-python');
        assert.equal(args[0], '-B');
        assert.ok(args[1].endsWith('validate.py'));
        assert.equal(options.timeout, 10000);
        assert.equal(options.shell, false);
        assert.deepEqual(JSON.parse(options.input), { task_id: 'fixture', answer: [1] });
        return { status: 0, stdout: JSON.stringify(receipt()) };
      },
    });
    const episode = result.episodes[0];
    assert.equal(episode.prompt_sha256, sha256(expectedPrompt));
    assert.equal(result.manifest.schedule[0].prompt_sha256, sha256(expectedPrompt));
    const plan = JSON.parse(result.io.files.get(path.join(outside, 'fresh', 'plan.json')));
    assert.equal(plan.schedule[0].prompt_sha256, sha256(expectedPrompt));
    assert.equal(episode.exploratory, true);
    assert.equal(episode.status, 'completed');
    assert.equal(episode.validation_status, 'accepted');
    assert.deepEqual(episode.parsed_value, [1]);
    assert.equal(episode.usage.input_tokens, 10);
    assert.equal(episode.duration_ms, 0);
    assert.equal(episode.text, 'FINAL: [1]');
    assert.deepEqual(episode.validator_receipt, receipt());
    assert.equal(result.manifest.validation_counts.accepted, 1);
    for (const file of ['manifest.json', 'plan.json', 'episodes/t1-r1.json', 'episodes/t1-r1.raw.json']) {
      assert.ok(result.io.files.has(path.join(outside, 'fresh', file)));
    }
  }
  assert.deepEqual(calls[0].args, ['run', '--model', 'provider/model', '--format', 'json', '--standalone', '--', expectedPrompt]);
  assert.deepEqual(calls[0].args, calls[1].args);
  for (const call of calls) {
    assert.equal(call.args.at(-1).split(fixture().grading.answer_format).length - 1, 1);
    assert.equal(call.args.at(-1).split('Required answer format:\n').length - 1, 1);
    assert.equal(call.options.cwd, workspace);
    assert.equal(call.options.timeout, 300000);
    assert.equal(call.options.shell, false);
    assert.ok(!JSON.stringify(call).includes('SECRET_'));
  }
  assert.equal(calls[0].options.env.MATH_TOOLKIT_DISABLE, undefined);
  assert.equal(calls[1].options.env.MATH_TOOLKIT_DISABLE, '1');
});

test('empty answer format leaves the task prompt unchanged', () => {
  const task = fixture();
  task.grading.answer_format = '';
  const result = study({}, {
    io: memoryIO([task]),
    runner: (_executable, args) => {
      assert.equal(args.at(-1), task.prompt);
      return capture('FINAL: [1]');
    },
  });
  assert.equal(result.episodes[0].prompt_sha256, sha256(task.prompt));
});

test('bridge stdin contains exact unquoted integers while episode logs use decimal strings', () => {
  let calls = 0;
  const result = study({}, {
    runner: () => capture(longAnswer),
    bridgeRunner: (_executable, _args, options) => {
      calls++;
      assert.equal(options.input, `{"task_id":"fixture","answer":${longJSON}}`);
      assert.ok(!options.input.includes('"10000010000003800000650000043"'));
      return { status: 0, stdout: JSON.stringify(receipt()) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.episodes[0].validation_status, 'accepted');
  const expected = [10000003, -10000002, 100000050000007, '10000010000003800000650000043'];
  assert.deepEqual(result.episodes[0].parsed_value, expected);
  const logged = JSON.parse(result.io.files.get(path.join(outside, 'fresh', 'episodes', 't1-r1.json')));
  assert.deepEqual(logged.parsed_value, expected);
  assert.deepEqual(logged.parse.value, expected);
});

for (const status of ['accepted', 'rejected', 'unavailable']) {
  test(`fake bridge classifies ${status}`, () => {
    const result = study({}, {
      bridgeRunner: () => ({ status: 0, stdout: JSON.stringify(receipt(status, status === 'unavailable' ? 'LOAD_ERROR' : 'UNKNOWN')) }),
    });
    assert.equal(result.episodes[0].validation_status, status);
    assert.equal(result.manifest.validation_counts[status], 1);
  });
}
for (const [name, result] of [
  ['invalid JSON', { status: 0, stdout: 'import failed' }],
  ['invalid schema', { status: 0, stdout: JSON.stringify({ ...receipt(), schema: 'wrong' }) }],
  ['wrong task', { status: 0, stdout: JSON.stringify(receipt('accepted', 'CORRECT', 'other')) }],
  ['missing tag', { status: 0, stdout: JSON.stringify({ ...receipt(), tag: null }) }],
  ['nonzero exit despite accepted text', { status: 1, stdout: JSON.stringify(receipt()) }],
  ['timeout', { error: { code: 'ETIMEDOUT' }, status: null }],
  ['missing Python', { error: { code: 'ENOENT' }, status: null }],
]) {
  test(`bridge failure is unavailable: ${name}`, () => {
    const resultStudy = study({}, { bridgeRunner: () => result });
    assert.equal(resultStudy.episodes[0].validation_status, 'unavailable');
    assert.equal(resultStudy.manifest.validation_counts.accepted, 0);
  });
}

test('thrown validator and invalid injected receipts fail closed', () => {
  for (const validator of [() => { throw new Error('broken'); }, () => ({ status: 'accepted' })]) {
    assert.equal(study({}, { validator }).episodes[0].validation_status, 'unavailable');
  }
});

test('unparseable and missing stay distinct and never invoke bridge', () => {
  for (const [text, expected] of [['FINAL: (1,2)', 'unparseable'], ['', 'missing']]) {
    const result = study({}, { runner: () => capture(text), bridgeRunner: () => assert.fail('must not validate') });
    assert.equal(result.episodes[0].validation_status, expected);
    assert.equal(result.episodes[0].validator_receipt, null);
    assert.equal(result.manifest.validation_counts.rejected, 0);
  }
  assert.equal(gradeAnswer(fixture(), '').status, 'missing');
});

test('bridge representation failure is unparseable, not mathematical rejection', () => {
  const result = study({}, { bridgeRunner: () => ({
    status: 0, stdout: JSON.stringify(receipt('rejected', 'MALFORMED_ANSWER')),
  }) });
  assert.equal(result.episodes[0].validation_status, 'unparseable');
  assert.equal(result.episodes[0].validator_receipt.status, 'rejected');
  assert.equal(result.manifest.validation_counts.rejected, 0);
});

test('bridge request parse failure is unavailable', () => {
  assert.equal(study({}, { validator: () => receipt('rejected', 'INVALID_JSON') })
    .episodes[0].validation_status, 'unavailable');
});

test('capture failures never validate partial text or become accepted', () => {
  for (const result of [
    { ...capture('FINAL: [1]'), status: 1 },
    { ...capture('FINAL: [1]'), error: { code: 'ETIMEDOUT' } },
    { status: 0, stdout: 'invalid event JSON' },
    { status: 0, stdout: JSON.stringify({ type: 'error' }) },
  ]) {
    const output = study({}, { runner: () => result, bridgeRunner: () => assert.fail('must not validate') });
    assert.equal(output.episodes[0].validation_status, 'missing');
    assert.notEqual(output.episodes[0].status, 'completed');
  }
});

test('limit and timeout are honored; missing workspace and invalid CLI/options refuse dispatch', () => {
  const output = study({ limit: '1', timeoutMs: '1234' }, {
    io: memoryIO([fixture(), fixture('second')]),
    runner: (_executable, _args, options) => {
      assert.equal(options.timeout, 1234);
      return capture('FINAL: [1]');
    },
  });
  assert.equal(output.episodes.length, 1);
  assert.throws(() => study({}, { inheritedEnv: {} }), /EXTERNAL_BENCH_WORKSPACE/);
  for (const options of [{ limit: 0 }, { timeoutMs: -1 }, { model: 'no-provider' }, { condition: 'other' }]) {
    assert.throws(() => study(options, { runner: () => assert.fail('must not run') }));
  }
  assert.throws(() => main([]), /--tasks required/);
  assert.throws(() => main(['--unexpected', 'x']), /invalid option/);
});
