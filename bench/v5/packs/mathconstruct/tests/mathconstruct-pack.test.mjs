import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildPack, extract, choosePilot, packDir, defaultSource, suffix } from '../build.mjs';

const load = name => JSON.parse(readFileSync(join(packDir, name + '.json'), 'utf8'));
const tasks = load('tasks'), pilot = load('pilot'), validators = load('validators');
const source = resolve(process.env.MATHCONSTRUCT_SOURCE || defaultSource);
const extracted = extract(source);
const rows = new Map(extracted.rows.map(r => [r.id, r]));
const sha = x => createHash('sha256').update(x).digest('hex');
const serialize = x => JSON.stringify(x, null, 2) + '\n';

test('exact task schema, unique sorted ids, and current-module coverage', () => {
  const ids = tasks.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(ids, extracted.rows.map(r => r.id));
  for (const task of tasks) {
    assert.deepEqual(Object.keys(task).sort(), ['answer', 'benchmark', 'grading', 'id', 'metadata', 'prompt', 'schema']);
    assert.equal(task.schema, 'math-bench-task/v1');
    assert.equal(task.benchmark, 'mathconstruct');
    assert.equal(task.answer, null);
    assert.equal(task.grading.type, 'validator');
    assert.equal(task.metadata.license, 'MIT (code); source rights apply');
    assert.equal(typeof task.prompt, 'string');
    assert.equal(typeof task.grading.answer_format, 'string');
  }
});

test('prompt is exactly the AST-resolved statement plus suffix, never answer/config/checker code', () => {
  for (const task of tasks) {
    const row = rows.get(task.id);
    assert.equal(task.prompt, row.statement.trim() + '\n\n' + suffix, task.id);
    assert.doesNotMatch(task.prompt, /https?:\/\/|original_solution|ProblemConfig\s*\(|def\s+(?:check|verify|get_solution)\s*\(/);
    // Provenance equality above is essential: code and formatting examples are
    // never concatenated into prompts. The extractor also rejects function bodies.
    assert.ok(!Object.hasOwn(task, 'original_solution'));
    assert.ok(!Object.hasOwn(task.metadata, 'original_solution'));
  }
});

test('original metadata is preserved; unresolved prompts are explicit and pilot-ineligible', () => {
  for (const task of tasks) {
    const row = rows.get(task.id);
    assert.deepEqual(task.metadata.parameters, row.parameters);
    assert.deepEqual(task.metadata.original_parameters, row.original_parameters);
    assert.deepEqual(task.metadata.tags, row.tags);
    assert.equal(task.metadata.source, row.source);
    if (task.metadata.needs_parameters) {
      assert.ok(task.metadata.resolution_errors.length);
      assert.equal(task.metadata.pilot_eligible, false);
      assert.ok(!pilot.some(p => p.id === task.id));
    }
  }
  // Upstream declares k but supplies only n; k is safely derived by __init__.
  const bxmo = tasks.find(t => t.id === 'bxmo-2019-2');
  assert.deepEqual(bxmo.metadata.original_parameters, { n: 9 });
  assert.equal(bxmo.metadata.needs_parameters, false);
  assert.equal(bxmo.metadata.pilot_eligible, false);
});

test('pilot has 20 resolved tasks, sorted ids, tag stratification, and no answer/example overlap', () => {
  assert.equal(pilot.length, 20);
  assert.equal(new Set(pilot.map(t => t.id)).size, 20);
  assert.deepEqual(pilot.map(t => t.id), pilot.map(t => t.id).sort());
  assert.deepEqual(pilot, choosePilot(tasks));
  for (const task of pilot) {
    assert.deepEqual(task, tasks.find(t => t.id === task.id));
    assert.equal(task.metadata.needs_parameters, false);
    assert.equal(task.metadata.pilot_eligible, true);
    assert.ok(task.metadata.parameters.every(p => Object.hasOwn(task.metadata.original_parameters, p)));
    assert.equal(rows.get(task.id).literal_solution_overlap, false);
    assert.doesNotMatch(rows.get(task.id).statement, /\b(example|instance|e\.g\.)\b/i);
  }
  for (const tag of new Set(tasks.flatMap(t => t.metadata.tags))) {
    assert.ok(pilot.some(t => t.metadata.tags.includes(tag)), `pilot does not cover ${tag}`);
  }
});

test('validator map is closed and commands identify the actual checker without copying solutions', () => {
  assert.deepEqual(Object.keys(validators).sort(), tasks.map(t => t.id).sort());
  for (const task of tasks) {
    const entry = validators[task.id], row = rows.get(task.id);
    assert.equal(entry.entry_point, task.grading.validator);
    assert.equal(entry.entry_point, `${row.module}:${row.class_name}.${row.method}`);
    assert.deepEqual(entry.command, ['node', 'build.mjs', '--validate', task.id, '--answer', '<response.txt>']);
    assert.equal(entry.timeout_seconds, 60);
    assert.ok(!Object.hasOwn(entry, 'original_solution'));
    assert.ok(!Object.hasOwn(entry, 'validator_body'));
  }
});

test('executed/verified require separate real checker receipts, not import or extraction', () => {
  let smokeCount = 0;
  for (const entry of Object.values(validators)) {
    assert.equal(entry.executed, entry.runs.some(r => r.checker_executed === true));
    assert.equal(entry.verified, entry.runs.some(r => r.status === 'accepted' && r.checker_executed === true));
    for (const run of entry.runs) {
      assert.equal(run.source_bundle_sha256, entry.source_bundle_sha256);
      if (run.kind === 'original_solution_smoke') smokeCount++;
      if (run.status === 'accepted') assert.equal(run.checker_executed, true);
    }
    if (entry.smoke.status === 'not_run') assert.ok(entry.smoke.reason);
  }
  assert.ok(smokeCount <= 2);
});

test('backups and helper modules are excluded, including all currently inactive problems', () => {
  const activeFiles = new Set(tasks.map(t => t.metadata.source_file));
  for (const file of activeFiles) {
    assert.doesNotMatch(file, /\/backups\/|\/__init__\.py$|\/(?:templates|problem)\.py$/);
  }
  const backups = readdirSync(join(source, 'src/math_construct/problems/backups')).filter(f => f.endsWith('.py'));
  for (const file of backups) assert.ok(!activeFiles.has(`src/math_construct/problems/backups/${file}`));
  const readme = readFileSync(join(source, 'README.md'), 'utf8');
  assert.match(readme, /removed 5 problems/);
  // README does not name those five. Current module coverage (first test) and
  // exclusion of every backup are the reproducible available evidence.
});

test('the five September removals by historical id', {
  skip: 'README names no removed ids, current source supplies no removal manifest, and the supplied checkout has only its shallow tip. No identities invented.',
}, () => {});

test('source SHA-256 records cover every task and all extraction/checker helper sources', () => {
  const manifest = {};
  for (const task of tasks) {
    assert.equal(task.metadata.source_sha256, sha(readFileSync(join(source, task.metadata.source_file))));
    const entry = validators[task.id];
    assert.equal(entry.source_sha256, task.metadata.source_sha256);
    for (const [path, digest] of Object.entries(entry.source_hashes)) {
      assert.equal(digest, sha(readFileSync(join(source, path))), path);
      manifest[path] = digest;
    }
  }
  assert.deepEqual(Object.fromEntries(Object.entries(manifest).sort()), extracted.source_hashes);
  for (const task of tasks) assert.equal(task.metadata.source_bundle_sha256, sha(serialize(extracted.source_hashes)));
});

test('deterministic rebuild is byte-identical and preserves separately recorded smoke evidence', () => {
  const first = buildPack({ source, previous: validators });
  const second = buildPack({ source, previous: first.validators });
  for (const key of ['tasks', 'pilot', 'validators', 'baselines']) {
    assert.equal(serialize(first[key]), serialize(second[key]), key);
    assert.equal(serialize(first[key]), readFileSync(join(packDir, key + '.json'), 'utf8'), key);
  }
});

test('baseline is the required empty exact-model record', () => {
  assert.deepEqual(load('baselines'), {
    schema: 'math-bench-baselines/v1', benchmark: 'mathconstruct',
    model: 'opencode-go/deepseek-v4.1-flash', external: [],
    note: 'No published score for this exact model/version was found; use the paired plugin-off arm.',
  });
});
