import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseFinalAnswer } from '../parse-answer.mjs';
import { gradeAnswer, pluginEnvironment, runStudy, main } from '../run-validator.mjs';
import { assertFreshOutput, sha256 } from '../../../external/schema.mjs';

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
  ['string wrappers preserved', String.raw`FINAL: "$\\boxed{literal}$"`, String.raw`$\boxed{literal}$`],
  ['empty FINAL followed by JSON fence', 'FINAL:\n```json\n[1]\n```', [1]],
  ['last FINAL', 'FINAL: [1]\nCorrection\nFINAL: [2]', [2]],
];
for (const [name, text, value] of cases) {
  test(`parse: ${name}`, () => {
    assert.deepEqual(parseFinalAnswer(text, { answerFormat: 'Never use example [999]' }),
      { status: 'parsed', value, reason: null });
  });
}
for (const [name, text] of [
  ['prose', 'The desired graph exists.'],
  ['malformed', 'FINAL: [1,]'],
  ['tuple', String.raw`FINAL: $\boxed{(1,2)}$`],
  ['comma list', String.raw`FINAL: $\boxed{1,2,3}$`],
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

const repo = path.resolve('/virtual-repo');
const outside = path.resolve('/virtual-results');
const workspace = path.resolve('/clean-workspace');
const tasksFile = path.join(repo, 'pilot.json');
const fixture = (id = 'fixture') => ({
  schema: 'math-bench-task/v1', benchmark: 'mathconstruct', id,
  prompt: 'Construct an example.\nFINAL: <answer>',
  answer: 'SECRET_REFERENCE_ANSWER',
  grading: { type: 'validator', validator: 'SECRET_VALIDATOR', answer_format: 'SECRET_FORMAT_EXAMPLE' },
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

test('both conditions use identical exact prompt and never leak evaluator fields', () => {
  const calls = [];
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
    assert.equal(episode.prompt_sha256, sha256(fixture().prompt));
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
  assert.deepEqual(calls[0].args, ['run', '--model', 'provider/model', '--format', 'json', '--standalone', '--', fixture().prompt]);
  assert.deepEqual(calls[0].args, calls[1].args);
  for (const call of calls) {
    assert.equal(call.options.cwd, workspace);
    assert.equal(call.options.timeout, 300000);
    assert.equal(call.options.shell, false);
    assert.ok(!JSON.stringify(call).includes('SECRET_'));
  }
  assert.equal(calls[0].options.env.MATH_TOOLKIT_DISABLE, undefined);
  assert.equal(calls[1].options.env.MATH_TOOLKIT_DISABLE, '1');
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
