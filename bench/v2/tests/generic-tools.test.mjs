import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGenericExecutors, leanSource } from '../adapters/generic-runtime.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'generic-tools-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['corpus', 'tmp', 'home', '.opencode/plugins/generic']) mkdirSync(path.join(directory, name), { recursive: true });
  const worker = path.join(directory, '.opencode/plugins/generic/compute.py');
  writeFileSync(worker, '# fixed worker placeholder: subprocess calls are mocked\n');
  writeFileSync(path.join(directory, 'grader.json'), 'PRIVATE_GRADER_SENTINEL');
  writeFileSync(path.join(directory, 'answers.json'), 'PRIVATE_ANSWER_SENTINEL');
  const excerpts = options.excerpts ?? [
    { document: 'public-doc', locator: 'section-1', text: 'A triangle has three sides.' },
    { document: 'public-long', locator: 'section-2', text: 'Triangle '.repeat(2000) },
  ];
  writeFileSync(path.join(directory, 'corpus/excerpts.json'), JSON.stringify(excerpts));
  return { directory, worker, tools: createGenericExecutors({ directory, worker, environment: { PATH: '', PRIVATE_TOKEN: 'secret' },
    invoke: () => assert.fail('Unexpected subprocess call'), ...options }) };
}

test('[generic B] public-only literal bounded search/read cannot access evaluator files', t => {
  const { tools, directory } = fixture(t);
  const result = tools.corpus_search({ query: 'TRIANGLE', limit: 1 });
  assert.equal(result.total_matches, 2);
  assert.equal(result.excerpts.length, 1);
  assert.equal(result.exhaustive_inventory, false);
  assert.equal(tools.corpus_search({ query: '.*' }).total_matches, 0, 'not a regex evaluator');
  assert.equal(tools.corpus_search({ query: 'PRIVATE' }).total_matches, 0);
  assert.equal(tools.read_excerpt({ document: 'public-long', locator: 'section-2', maxChars: 10 }).text.length, 10);
  assert.equal(tools.read_excerpt({ document: 'public-long', locator: 'section-2' }).truncated, true);
  for (const document of ['../grader.json', 'answers.json', 'C:\\private\\file', '/etc/passwd']) {
    assert.throws(() => tools.read_excerpt({ document, locator: 'section-1' }), /forbidden/);
  }
  assert.throws(() => tools.read_excerpt({ document: 'unknown', locator: 'section-1' }), /not found/);
  assert.throws(() => tools.corpus_search({ query: 'triangle', path: '../grader.json' }), /Unknown argument/);
  assert.throws(() => tools.corpus_search({ query: 'triangle', limit: 11 }), /Expected integer/);
  // The plugin snapshots only public entries; later file mutation does not expose new data.
  writeFileSync(path.join(directory, 'corpus/excerpts.json'), '[{"text":"PRIVATE_GRADER_SENTINEL"}]');
  assert.equal(tools.corpus_search({ query: 'PRIVATE' }).total_matches, 0);
});

test('[generic B] private-marked/malformed corpus is rejected before registration', t => {
  for (const extra of [{ private: true }, { grading: 'secret' }, { visibility: 'private' }]) {
    assert.throws(() => fixture(t, { excerpts: [{ document: 'doc', locator: 'section', text: 'secret', ...extra }] }), /Unknown argument/);
  }
  assert.throws(() => fixture(t, { excerpts: [{ document: '../answers.json', locator: 'section', text: 'secret' }] }), /forbidden/);
});

test('[generic B] compute only spawns fixed allowlist worker with bounded JSON, no shell', t => {
  const calls = [];
  const { tools, worker } = fixture(t, { find: name => name === 'python3' ? '/trusted/python3' : null,
    invoke: (executable, args, options) => { calls.push({ executable, args, options }); return { status: 0, stdout: '{"ok":true,"result":"3"}' }; } });
  assert.deepEqual(tools.compute({ operation: 'simplify', expression: '6/2' }), { status: 'completed', result: '3' });
  tools.compute({ operation: 'factor', expression: 'x^2-1' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].executable, '/trusted/python3');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-I', '-B', worker]);
  assert.deepEqual(JSON.parse(calls[0].args[3]), { operation: 'simplify', expression: '6/2' });
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.PRIVATE_TOKEN, undefined);
  assert.equal(calls[0].options.timeout, 5000);
  assert.throws(() => tools.compute({ operation: 'eval', expression: 'code' }), /Unsupported/);
  assert.throws(() => tools.compute({ operation: 'simplify', expression: '1', file: '../answers.json' }), /Unknown argument/);
  assert.throws(() => tools.compute({ operation: 'simplify', expression: '1', timeoutMs: 10001 }), /Expected integer/);
  assert.equal(calls.length, 2);
});

test('[generic B] missing tools, compute rejection, timeout and malformed output fail explicitly', t => {
  const missing = fixture(t, { find: () => null }).tools;
  assert.equal(missing.compute({ operation: 'simplify', expression: '1' }).status, 'missing-tool');
  assert.equal(missing.lean_check({ code: 'example : True := by trivial' }).status, 'missing-tool');
  for (const [result, status] of [
    [{ status: 0, stdout: '{"ok":false,"error":"Forbidden expression syntax."}' }, 'rejected'],
    [{ status: 0, stdout: 'not json' }, 'error'],
    [{ status: null, error: { code: 'ETIMEDOUT' } }, 'timeout'],
    [{ status: 1 }, 'failed'],
  ]) {
    const { tools } = fixture(t, { find: () => '/trusted/python', invoke: () => result });
    assert.equal(tools.compute({ operation: 'simplify', expression: '__import__("os")' }).status, status);
  }
});

test('[generic B] Lean check uses bounded native compiler/temp source, never a trusted receipt', t => {
  const calls = [];
  const { tools, directory } = fixture(t, { find: name => name === 'lean' ? '/trusted/lean' : null,
    invoke: (executable, args, options) => {
      calls.push({ executable, args, options, source: readFileSync(args.at(-1), 'utf8') });
      return { status: 0, stdout: '', stderr: '' };
    } });
  const result = tools.lean_check({ code: 'theorem reflexive : ∀ n : Nat, n = n := by\n intro n\n rfl', imports: ['Init'] });
  assert.equal(result.compilation, 'compiled');
  assert.equal(result.scope, 'compiler-check-only');
  assert.equal(result.verification, 'not-performed');
  assert.equal(result.receipt, null);
  assert.equal(calls[0].executable, '/trusted/lean');
  assert.deepEqual(calls[0].args.slice(0, 2), ['--threads=1', '--memory=256']);
  assert.match(calls[0].source, /^import Init\n/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.LEAN_PATH, undefined);
  assert.deepEqual(readdirSync(path.join(directory, 'tmp')), []);
});

test('[generic B] executable Lean, arbitrary imports/paths and unbounded inputs are refused', () => {
  for (const code of [
    '#eval IO.println "secret"',
    'example : True := by\n run_tac do pure ()',
    'example : True := by\n trivial\n#eval IO.FS.readFile "../answers.json"',
    'example : (by run_tac do pure ()) := by trivial',
    'example : True := by\n exact IO.println',
    'example : True := by\n simp [unsafeFunction]',
    'example : True := by\n/- comment -/ trivial',
  ]) assert.throws(() => leanSource({ code }), /Expected|Unsupported/);
  assert.throws(() => leanSource({ code: 'example : True := by trivial', imports: ['Mathlib'] }), /allowlisted/);
  assert.throws(() => leanSource({ code: 'example : True := by trivial', imports: ['../grader'] }), /allowlisted/);
  assert.throws(() => leanSource({ code: 'example : True := by trivial', file: '../answers.json' }), /Unknown argument/);
  assert.throws(() => leanSource({ code: ' '.repeat(8001) }), /1-8000/);
});

test('[generic B] failed and timed-out compiler checks clean up and cannot verify a proof', t => {
  for (const result of [{ status: 1, stdout: 'error: type mismatch' }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    const { tools, directory } = fixture(t, { find: () => '/trusted/lean', invoke: () => result });
    const checked = tools.lean_check({ code: 'example : False := by trivial' });
    assert.equal(checked.compilation, 'failed');
    assert.equal(checked.receipt, null);
    assert.equal(checked.verification, 'not-performed');
    assert.deepEqual(readdirSync(path.join(directory, 'tmp')), []);
  }
});
