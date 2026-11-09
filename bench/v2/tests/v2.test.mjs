import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { ROOT, sha256, json, loadProfiles, validateProfile, prepareWorkspace, assertWorkspace, validateNamed, expectedEpisodes, episodeKey, agentPayload, serialize } from '../lib.mjs';
import { gradeFinal } from '../graders/index.mjs';
import { formalTask, formalReceipt, formalFinal, formalContext, explanationTask, explanationText, negatedExplanation, solutionSetTask } from '../fixtures/adversarial.mjs';
import { receiptHash } from '../graders/formal.mjs';
import { createDispatcher } from '../simulator.mjs';
import { runStudy, makeManifest, loadStudy, inspectLedger, underBudget, protocolHash } from '../run.mjs';
import { analyzeStudy, pairedBootstrap } from '../analyze.mjs';
import { prepareRestricted, executeRestricted } from '../exec/restricted.mjs';

const tasks = json(path.join(ROOT, 'fixtures', 'tasks.json'));
const temporary = t => { const directory = mkdtempSync(path.join(os.tmpdir(), 'math-eval-v2-test-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };
const clone = value => structuredClone(value);
function sealReceipt(receipt) {
  receipt.provenance.source_receipt_sha256 = sha256(receipt.verifier);
  receipt.receipt_sha256 = receiptHash(receipt);
  return receipt;
}
function scoreReceipt(receipt) {
  return gradeFinal(formalTask, { ...formalFinal, receipt_sha256: receipt.receipt_sha256 }, { allow_simulated: true, trusted_receipts: { [receipt.receipt_sha256]: receipt } });
}

test('numeric grading uses typed value, tolerance, units, domain and conditions', () => {
  const task = tasks[0];
  assert.equal(gradeFinal(task, task.correct_final).grade.correct, true);
  assert.equal(gradeFinal(task, { ...task.correct_final, value: 3.0000005 }).grade.correct, true);
  for (const patch of [{ value: -3 }, { value: 3.1 }, { units: 'km/h' }, { domain: 'complex' }, { conditions: [] }]) assert.equal(gradeFinal(task, { ...task.correct_final, ...patch }).grade.correct, false);
  for (const value of ['3', NaN, Infinity]) assert.equal(gradeFinal(task, { ...task.correct_final, value }).status, 'extraction_failure');
});
test('tool log keywords cannot rescue missing or negated final answers', () => {
  assert.equal(gradeFinal(tasks[0], null, { stdout: 'Correct answer: 3 m/s', events: [{ result: 3 }] }).status, 'extraction_failure');
  assert.equal(gradeFinal(tasks[0], { stdout: '3 m/s' }).status, 'extraction_failure');
  assert.equal(gradeFinal(tasks[2], { ...tasks[2].correct_final, claim: 'A triangle does not have three sides.' }).grade.correct, false);
  assert.equal(gradeFinal(tasks[2], { ...tasks[2].correct_final, supported: false }).grade.correct, false);
});
test('symbolic equivalence rejects missing restrictions, extra poles and extra solutions', () => {
  const task = tasks[1];
  assert.equal(gradeFinal(task, task.correct_final).grade.correct, true);
  assert.equal(gradeFinal(task, { ...task.correct_final, numerator: [0, 2], denominator: [0, 2] }).grade.correct, true);
  for (const patch of [{ conditions: [] }, { assumptions: [] }, { numerator: [-2, 1], denominator: [-2, 1] }, { numerator: [2] }, { denominator: [0] }, { denominator: [0.5] }]) assert.equal(gradeFinal(task, { ...task.correct_final, ...patch }).grade.correct, false);
  const answer = { type: 'symbolic', solutions: [2], domain: 'real', assumptions: ['x is real'], conditions: ['x >= 0'] };
  assert.equal(gradeFinal(solutionSetTask, answer).grade.correct, true);
  for (const solutions of [[-2, 2], [], [2, 2]]) assert.equal(gradeFinal(solutionSetTask, { ...answer, solutions }).grade.correct, false);
});
test('citation requires exact document and locator as well as supported claim', () => {
  const task = tasks[2];
  assert.equal(gradeFinal(task, task.correct_final).grade.correct, true);
  for (const patch of [{ document: 'toy-other' }, { locator: 'section-2' }]) assert.equal(gradeFinal(task, { ...task.correct_final, ...patch }).grade.correct, false);
});
test('absence distinguishes limited search, nonexistence and unavailable corpus', () => {
  const task = tasks[3], context = { consulted: task.grading.consulted, corpus_available: true };
  assert.equal(gradeFinal(task, task.correct_final, context).grade.correct, true);
  assert.equal(gradeFinal(task, task.correct_final, {}).grade.correct, false);
  for (const status of ['nonexistent', 'corpus_unavailable']) assert.equal(gradeFinal(task, { ...task.correct_final, status }, context).grade.correct, false);
  const unavailable = { type: 'absence', grading: { status: 'corpus_unavailable', consulted: [] } };
  const unavailableAnswer = { type: 'absence', status: 'corpus_unavailable', consulted: [], prose: 'No consulted excerpts were available because the corpus is unavailable.' };
  assert.equal(gradeFinal(unavailable, unavailableAnswer, { corpus_available: false }).grade.correct, true);
  assert.equal(gradeFinal(unavailable, unavailableAnswer, { corpus_available: true }).grade.correct, false);
  const exhaustive = { type: 'absence', grading: { status: 'nonexistent', consulted: ['inventory'], exhaustive_inventory: true } };
  const exhaustiveAnswer = { type: 'absence', status: 'nonexistent', consulted: ['inventory'], prose: 'Not found in consulted excerpts; the exhaustive inventory establishes nonexistence.' };
  assert.equal(gradeFinal(exhaustive, exhaustiveAnswer, { exhaustive_inventory: true }).grade.correct, true);
  assert.equal(gradeFinal(exhaustive, exhaustiveAnswer).grade.correct, false);
});
test('explanation grading is blind fixture labeling, not word overlap', () => {
  assert.equal(gradeFinal(explanationTask, { type: 'explanation', text: explanationText }).grade.correct, true);
  for (const text of [negatedExplanation, 'x nonzero x/x equals 1', 'Unregistered otherwise plausible prose']) assert.equal(gradeFinal(explanationTask, { type: 'explanation', text }).grade.correct, false);
});
test('formal grading binds fixed target, solution, policy, compilation and trusted receipt', () => {
  assert.equal(gradeFinal(formalTask, formalFinal, formalContext).grade.correct, true);
  assert.equal(gradeFinal(formalTask, formalFinal, {}).grade.correct, false);
  assert.equal(gradeFinal(formalTask, { ...formalFinal, receipt: formalReceipt }, {}).grade.correct, false);
  assert.equal(gradeFinal(formalTask, formalFinal, { ...formalContext, allow_simulated: false }).grade.correct, false);
  assert.equal(gradeFinal(formalTask, { ...formalFinal, solution: 'by sorry' }, formalContext).grade.correct, false);
  assert.equal(gradeFinal(formalTask, { ...formalFinal, target_sha256: sha256('another target') }, formalContext).grade.correct, false);
  for (const patch of [{ policy_sha256: sha256('wrong') }, { target_sha256: sha256('wrong') }, { solution_sha256: sha256('wrong') }, { toolchain: 'wrong' }]) {
    const receipt = { ...formalReceipt, ...patch };
    receipt.receipt_sha256 = receiptHash(receipt);
    const final = { ...formalFinal, receipt_sha256: receipt.receipt_sha256 };
    assert.equal(gradeFinal(formalTask, final, { allow_simulated: true, trusted_receipts: { [receipt.receipt_sha256]: receipt } }).grade.correct, false);
  }
});
test('[RECEIPT-01] every v1 status is explicit; only the complete verified tuple passes', () => {
  const statuses = {
    execution: ['completed', 'timeout', 'missing-tool', 'error'],
    compilation: ['compiled', 'not-run', 'failed'],
    target: ['identified', 'not-requested', 'missing', 'mismatch'],
    proof: ['verified', 'not-requested', 'unverified', 'incomplete', 'rejected']
  };
  const schema = json(path.join(ROOT, 'schemas', 'verification-receipt.schema.json'));
  for (const [field, values] of Object.entries(statuses)) {
    assert.deepEqual([...schema.properties.verifier.properties[field].properties.status.enum].sort(), [...values].sort());
    for (const [index, status] of values.entries()) {
      const receipt = clone(formalReceipt);
      receipt.verifier[field].status = status;
      sealReceipt(receipt);
      validateNamed('verification-receipt', receipt); // Recognized failures are valid receipts, never passing proofs.
      assert.equal(scoreReceipt(receipt).grade.correct, index === 0, `${field}.${status}`);
    }
  }
  for (const [field, alias] of [['execution', 'tool_missing'], ['execution', 'success'], ['compilation', 'success'], ['target', 'absent'], ['proof', 'verified_under_policy'], ...Object.keys(statuses).map(field => [field, 'unknown'])]) {
    const receipt = clone(formalReceipt);
    receipt.verifier[field].status = alias;
    sealReceipt(receipt);
    assert.throws(() => validateNamed('verification-receipt', receipt), /invalid enum/);
    assert.equal(scoreReceipt(receipt).grade.correct, false);
  }
  for (const field of Object.keys(statuses)) {
    const receipt = clone(formalReceipt);
    delete receipt.verifier[field].status;
    sealReceipt(receipt);
    assert.equal(scoreReceipt(receipt).grade.correct, false);
  }
  const legacy = { schema_version: '2.0.0', simulated: true, issuer: 'simulated-verifier', compiled: true, exit_code: 0, axioms: [] };
  legacy.receipt_sha256 = receiptHash(legacy);
  assert.equal(scoreReceipt(legacy).grade.correct, false);
});
test('[RECEIPT-02] provenance, target correspondence and proof policy cannot be inferred from a success label', () => {
  const mutations = [
    receipt => { receipt.verifier.version = 'math-lean-verify/v2'; },
    receipt => { receipt.verifier.execution.exitCode = 1; },
    receipt => { receipt.verifier.proof.sorryAx = true; },
    receipt => { receipt.verifier.proof.axioms = ['sorryAx']; },
    receipt => { receipt.verifier.proof.allowedAxioms = ['unregisteredAxiom']; },
    receipt => { receipt.verifier.proof.unauthorizedAxioms = ['unregisteredAxiom']; },
    receipt => { receipt.verifier.target.theorem = 'different_target'; },
    receipt => { receipt.verifier.target.expectedType = 'True'; },
    receipt => { receipt.provenance.issuance = 'agent-controlled'; },
    receipt => { receipt.provenance.evidence = 'verifier-output'; },
    receipt => { receipt.provenance.independent_kernel_check = true; },
    receipt => { receipt.correspondence.status = 'verified'; },
    receipt => { receipt.correspondence.scope = 'informal-claim'; }
  ];
  for (const mutate of mutations) {
    const receipt = clone(formalReceipt); mutate(receipt); sealReceipt(receipt);
    assert.equal(scoreReceipt(receipt).grade.correct, false);
  }
  const sourceMismatch = clone(formalReceipt);
  sourceMismatch.provenance.source_receipt_sha256 = sha256('another verifier receipt');
  sourceMismatch.receipt_sha256 = receiptHash(sourceMismatch);
  assert.equal(scoreReceipt(sourceMismatch).grade.correct, false);
  assert.equal(formalReceipt.simulated, true);
  assert.equal(formalReceipt.provenance.independent_kernel_check, false);
  assert.equal(formalReceipt.correspondence.status, 'not-assessed');
});
test('profiles enumerate real availability and reject forbidden A/B tools before work', () => {
  const profiles = loadProfiles();
  assert.ok(profiles.find(profile => profile.id === 'F').effective_tools.includes('math_lean_verify'));
  for (const profile of profiles) assert.equal(validateProfile(profile), profile);
  for (const id of ['A', 'B']) {
    const profile = clone(profiles.find(p => p.id === id));
    profile.effective_tools.push('math_search');
    assert.throws(() => validateProfile(profile), /math_\*/);
  }
  assert.throws(() => validateProfile({ ...profiles[0], effective_tools: ['shell'] }), /manifest mismatch/);
  assert.throws(() => validateProfile({ ...profiles[2], effective_tools: ['math_search'] }), /manifest mismatch/);
});
test('each workspace is fresh, contains only public inputs, and rejects answer/report leaks', t => {
  const workspaces = loadProfiles().map(profile => prepareWorkspace(tasks[2], profile));
  t.after(() => workspaces.forEach(workspace => rmSync(workspace.directory, { recursive: true, force: true })));
  assert.equal(new Set(workspaces.map(w => w.directory)).size, 3);
  for (const workspace of workspaces) {
    const task = JSON.parse(readFileSync(path.join(workspace.directory, 'task.json')));
    assert.equal(Object.hasOwn(task, 'grading'), false);
    assert.equal(Object.hasOwn(task, 'correct_final'), false);
    assertWorkspace(workspace.directory, workspace.files);
    writeFileSync(path.join(workspace.directory, 'reference-report.json'), '{}');
    assert.throws(() => assertWorkspace(workspace.directory, workspace.files), /isolation_failure/);
    rmSync(path.join(workspace.directory, 'reference-report.json'));
    writeFileSync(path.join(workspace.directory, 'home', 'history.json'), '[]');
    assert.throws(() => assertWorkspace(workspace.directory, workspace.files), /isolation_failure/);
    rmSync(path.join(workspace.directory, 'home', 'history.json'));
  }
  assert.equal(existsSync(path.join(workspaces[0].directory, 'corpus')), false);
  const dispatcher = createDispatcher(loadProfiles()[0], workspaces[0]);
  assert.throws(() => dispatcher.call('math_search', {}), /tool_unavailable/);
  assert.equal(dispatcher.events.length, 0);
});
test('schema validation rejects malformed manifests, episodes and receipts', t => {
  const output = temporary(t);
  runStudy({ output, limit: 1 });
  const { manifest, episodes } = loadStudy(output);
  validateNamed('study-manifest', manifest);
  validateNamed('episode', episodes[0]);
  validateNamed('verification-receipt', formalReceipt);
  for (const [name, value, key] of [['study-manifest', manifest, 'budgets'], ['episode', episodes[0], 'final'], ['verification-receipt', formalReceipt, 'verifier']]) {
    const invalid = clone(value); delete invalid[key];
    assert.throws(() => validateNamed(name, invalid), /required/);
  }
  assert.throws(() => inspectLedger(manifest, [{ ...episodes[0], simulated: false }], readFileSync(path.join(output, 'starts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)), /simulation marker mismatch/);
  assert.throws(() => validateNamed('verification-receipt', { ...formalReceipt, target_sha256: 'bad' }), /pattern mismatch/);
});
test('[EVAL-01] dispatch denies evaluator files and content tampering before returning any evidence', t => {
  const privateMarker = 'EVALUATOR_ONLY_ANSWER_AND_GRADER_CANARY';
  const task = { ...clone(tasks[2]), grading: { privateMarker }, correct_final: { privateMarker }, reference_report: privateMarker };
  for (const profile of loadProfiles()) {
    const first = prepareWorkspace(task, profile), second = prepareWorkspace(task, profile);
    t.after(() => [first, second].forEach(workspace => rmSync(workspace.directory, { recursive: true, force: true })));
    assert.notEqual(first.directory, second.directory);
    assert.equal(Object.values(first.files).some(content => content.includes(privateMarker)), false);
    const dispatcher = createDispatcher(profile, first);
    for (const filename of ['answers.json', 'grader.mjs', 'reference-report.json']) {
      writeFileSync(path.join(first.directory, filename), privateMarker);
      assert.throws(() => createDispatcher(profile, first), /isolation_failure/);
      assertWorkspace(second.directory, second.files); // No session/file state shared.
      rmSync(path.join(first.directory, filename));
    }
    // A forbidden tool cannot access the evaluator, even with an absolute path.
    assert.throws(() => dispatcher.call('read_file', { file: path.join(ROOT, 'graders', 'formal.mjs') }), /tool_unavailable/);
    if (profile.id !== 'A') {
      const tool = profile.id === 'B' ? 'read_excerpt' : 'math_manuscript';
      for (const file of ['../answers.json', path.join(ROOT, 'fixtures', 'tasks.json'), path.join(ROOT, 'graders', 'formal.mjs')]) {
        assert.throws(() => dispatcher.call(tool, { task_id: task.id, file }), /only the public task_id/);
      }
      // Injection into an allowed filename after dispatcher creation is blocked.
      for (const filename of ['task.json', 'corpus/excerpts.json']) {
        writeFileSync(path.join(first.directory, filename), privateMarker);
        assert.throws(() => dispatcher.call(tool, { task_id: task.id }), /payload changed/);
        writeFileSync(path.join(first.directory, filename), first.files[filename]);
      }
      assert.equal(dispatcher.events.length, 0);
      assert.equal(JSON.stringify(dispatcher.call(tool, { task_id: task.id })).includes(privateMarker), false);
    } else assert.equal(dispatcher.events.length, 0);
  }
});
test('[EVAL-02] observed correct tool evidence cannot rescue absent, negated or wrong-document finals', t => {
  const task = tasks[2], profile = loadProfiles()[1], workspace = prepareWorkspace(task, profile);
  t.after(() => rmSync(workspace.directory, { recursive: true, force: true }));
  const dispatcher = createDispatcher(profile, workspace);
  const evidence = dispatcher.call('read_excerpt', { task_id: task.id });
  assert.ok(evidence.excerpts.some(excerpt => excerpt.text === task.correct_final.claim));
  const context = { ...dispatcher.context, events: dispatcher.events };
  for (const final of [null, { ...task.correct_final, claim: 'A triangle does not have three sides.' }, { ...task.correct_final, document: 'toy-other' }]) assert.equal(gradeFinal(task, final, context).grade.correct, false);
  assert.equal(gradeFinal(task, task.correct_final, context).grade.correct, true);
  for (const field of ['domain', 'units', 'conditions']) {
    const incomplete = clone(tasks[0].correct_final); delete incomplete[field];
    const result = gradeFinal(tasks[0], incomplete, { events: [{ result: tasks[0].correct_final }] });
    assert.equal(result.status, 'extraction_failure', field);
    assert.equal(result.grade.correct, false, field);
  }
});
test('48-episode pilot is deterministic including reports, with idempotent append-only resume', t => {
  const first = temporary(t), second = temporary(t);
  const partial = runStudy({ output: first, limit: 7 });
  assert.equal(partial.episodes, 7); assert.equal(partial.missing, 41);
  const prefix = readFileSync(path.join(first, 'episodes.jsonl'), 'utf8');
  const resumed = runStudy({ output: first });
  assert.equal(resumed.appended, 41); assert.equal(resumed.episodes, 48); assert.equal(resumed.missing, 0);
  assert.ok(readFileSync(path.join(first, 'episodes.jsonl'), 'utf8').startsWith(prefix));
  const bytes = readFileSync(path.join(first, 'episodes.jsonl'), 'utf8');
  assert.equal(runStudy({ output: first }).appended, 0);
  assert.equal(readFileSync(path.join(first, 'episodes.jsonl'), 'utf8'), bytes);
  runStudy({ output: second });
  assert.equal(readFileSync(path.join(second, 'episodes.jsonl'), 'utf8'), bytes);
  const report = analyzeStudy(first), otherReport = analyzeStudy(second);
  assert.deepEqual(report, otherReport);
  assert.equal(report.started, 48);
  assert.deepEqual(['A', 'B', 'F'].map(id => report.conditions[id].correct_under_budget), [2, 12, 14]);
  assert.equal(report.contrast.estimate, 0.125);
  assert.equal(report.contrast.families, 3);
  assert.equal(report.contrast.unique_tasks, 4);
  assert.equal(report.conditions.F.operational_failures, 1);
  assert.equal(report.conditions.B.extraction_failures, 2);
  assert.equal(report.conditions.F.over_budget, 1);
  assert.equal(report.conditions.A.negative_cases, 4);
});
test('duplicates, missing pairs, artifact tampering and protocol drift are detected', t => {
  const output = temporary(t);
  runStudy({ output, limit: 1 });
  const { manifest, episodes, starts } = loadStudy(output);
  assert.equal(inspectLedger(manifest, episodes, starts).missing.length, 47);
  assert.throws(() => inspectLedger(manifest, [...episodes, episodes[0]], starts), /duplicate key/);
  assert.throws(() => inspectLedger(manifest, episodes, [...starts, starts[0]]), /duplicate key/);
  assert.throws(() => inspectLedger(manifest, [{ ...episodes[0], key: 'bad' }], starts), /invalid composite key/);
  const drift = clone(manifest); drift.budgets.tokens++; drift.protocol_hash = protocolHash(drift);
  writeFileSync(path.join(output, 'manifest.json'), serialize(drift));
  assert.throws(() => runStudy({ output }), /Resume protocol mismatch/);
  writeFileSync(path.join(output, 'manifest.json'), serialize(manifest));
  writeFileSync(path.join(output, episodes[0].artifacts[0].path), 'null\n');
  assert.throws(() => loadStudy(output), /Artifact hash mismatch/);
});
test('started-but-interrupted episode remains failure and is not rerun on resume', t => {
  const output = temporary(t);
  runStudy({ output, limit: 0 });
  const manifest = makeManifest(), ids = expectedEpisodes(manifest)[0];
  const profile = manifest.profiles.find(p => p.id === ids.condition_id), task = tasks.find(task => task.id === ids.task_id);
  const start = { ...ids, started_at: manifest.clock.epoch, agent_payload_sha256: sha256(agentPayload(task, profile)) };
  appendFileSync(path.join(output, 'starts.jsonl'), JSON.stringify(start) + '\n');
  const pendingReport = analyzeStudy(output);
  assert.equal(pendingReport.started, 1);
  assert.equal(pendingReport.conditions.A.operational_failures, 1);
  assert.equal(pendingReport.pending_started_keys.length, 1);
  runStudy({ output, limit: 1 });
  const episode = loadStudy(output).episodes[0];
  assert.equal(episode.error.category, 'interrupted');
  assert.equal(episode.grade.correct, false);
  assert.equal(runStudy({ output, limit: 0 }).appended, 0);
});
test('truncated ledgers fail closed instead of rewriting history', t => {
  const output = temporary(t); runStudy({ output, limit: 1 });
  appendFileSync(path.join(output, 'episodes.jsonl'), '{"partial":');
  assert.throws(() => loadStudy(output), /Truncated append-only ledger/);
});
test('[EVAL-03/STAT-01] missing paired start completion remains an all-started failure through interrupted resume', t => {
  const output = temporary(t);
  runStudy({ output, limit: 3 }); // A repeats 1/2, B repeat 1 of first task.
  const { manifest, starts } = loadStudy(output);
  const ids = expectedEpisodes(manifest).find(row => row.model_id === 'simulated-model-a' && row.task_id === tasks[0].id && row.condition_id === 'F' && row.repeat_id === 1);
  const profile = manifest.profiles.find(profile => profile.id === 'F');
  const pending = { ...ids, started_at: manifest.clock.epoch, agent_payload_sha256: sha256(agentPayload(tasks[0], profile)) };
  appendFileSync(path.join(output, 'starts.jsonl'), JSON.stringify(pending) + '\n');
  const before = analyzeStudy(output);
  assert.equal(before.started, 4);
  assert.equal(before.conditions.B.rate, 1);
  assert.equal(before.conditions.F.started, 1);
  assert.equal(before.conditions.F.operational_failures, 1);
  assert.equal(before.conditions.F.rate, 0);
  assert.equal(before.contrast.estimate, -1);
  assert.equal(before.contrast.paired_episode_cells, 1);
  assert.ok(before.missing_expected_keys.includes(ids.key));
  assert.deepEqual(before.pending_started_keys, [ids.key]);
  runStudy({ output, limit: 2 }); // Complete B repeat 2, record F repeat 1 as interrupted (not rerun).
  const after = analyzeStudy(output), loaded = loadStudy(output);
  assert.equal(after.started, 5);
  assert.equal(after.conditions.F.rate, 0);
  assert.equal(after.conditions.F.operational_failures, 1);
  assert.equal(after.contrast.estimate, -1);
  assert.equal(after.contrast.unpaired_cells_excluded_from_contrast_only, 1); // B repeat 2 has no F start yet.
  assert.equal(after.pending_started_keys.length, 0);
  assert.equal(loaded.ledger.completed.get(ids.key).error.category, 'interrupted');
  const bytes = readFileSync(path.join(output, 'episodes.jsonl'), 'utf8');
  appendFileSync(path.join(output, 'starts.jsonl'), JSON.stringify(starts[0]) + '\n');
  assert.throws(() => runStudy({ output }), /duplicate key/);
  assert.equal(readFileSync(path.join(output, 'episodes.jsonl'), 'utf8'), bytes);
});
test('family bootstrap preserves repeats and uses paired cells, never independent repetitions', () => {
  const rows = [];
  const good = { status: 'completed', grade: { correct: true }, under_budget: true };
  const bad = { status: 'operational_failure', grade: { correct: false }, under_budget: true };
  for (const [family, fGood] of [['family-1', true], ['family-2', false]]) for (let repeat = 1; repeat <= 10; repeat++) for (const condition of ['B', 'F']) rows.push({ family, task_id: family, model_id: 'simulated-model-a', repeat_id: repeat, attempt_id: 1, condition_id: condition, episode: condition === 'F' && fGood ? good : bad });
  const settings = { seed: 7, resamples: 200 };
  const report = pairedBootstrap(rows, settings);
  assert.equal(report.estimate, 0.5); assert.equal(report.families, 2); assert.equal(report.unique_tasks, 2);
  assert.deepEqual(report.exploratory_ci_95, [0, 1]);
  assert.deepEqual(report, pairedBootstrap(rows, settings));
  assert.equal(pairedBootstrap(rows.slice(1), settings).unpaired_cells_excluded_from_contrast_only, 1);
});
test('[STAT-01] resampling preserves opposing tasks and models within one family, not independent repeats', () => {
  const good = { status: 'completed', grade: { correct: true }, under_budget: true };
  const bad = { status: 'completed', grade: { correct: false }, under_budget: true };
  function rows(repeats) {
    const result = [];
    for (const model_id of ['simulated-model-a', 'simulated-model-b']) for (const task_id of ['positive-contrast', 'negative-contrast']) for (let repeat_id = 1; repeat_id <= repeats; repeat_id++) for (const condition_id of ['B', 'F']) {
      const correct = (task_id === 'positive-contrast') === (condition_id === 'F');
      result.push({ family: 'shared-family', model_id, task_id, repeat_id, attempt_id: 1, condition_id, episode: correct ? good : bad });
    }
    return result;
  }
  const settings = { seed: 17, resamples: 200 };
  const one = pairedBootstrap(rows(1), settings), many = pairedBootstrap(rows(9), settings);
  assert.equal(many.estimate, 0);
  assert.deepEqual(many.exploratory_ci_95, [0, 0]); // Task/repeat resampling would break the within-family cancellation.
  assert.equal(many.families, 1);
  assert.equal(many.unique_tasks, 2);
  assert.equal(many.paired_episode_cells, 36);
  assert.deepEqual(many.exploratory_ci_95, one.exploratory_ci_95);
  assert.equal(many.estimate, one.estimate);
});
test('[EVAL-03] saved simulated artifacts and reports explicitly disclaim measured cost, duration and real-model inference', t => {
  const output = temporary(t); runStudy({ output });
  const { manifest, episodes } = loadStudy(output), report = analyzeStudy(output);
  assert.equal(manifest.simulated, true);
  assert.equal(manifest.clock.kind, 'simulated');
  assert.deepEqual(manifest.models, ['simulated-model-a', 'simulated-model-b']);
  assert.equal(manifest.versions.receipt_schema, '2.1.0');
  for (const episode of episodes) {
    assert.equal(episode.simulated, true);
    assert.equal(episode.duration_source, 'simulated-fixture');
    assert.equal(episode.cost.observed_usd, null);
    assert.equal(episode.cost.estimated_usd, 0);
    assert.match(episode.cost.source, /simulated fixture accounting; no model or Docker execution/);
    for (const event of episode.events) assert.equal(event.simulated, true);
  }
  assert.equal(report.simulated, true);
  assert.match(report.limitations.join('\n'), /not measured performance or price estimates/);
  assert.match(report.contrast.caveat, /No real-model or mathematical-validity inference/);
  assert.match(readFileSync(path.join(output, 'report.md'), 'utf8'), /^# SIMULATED pilot — no real-model results/);
  assert.equal(report.started, 48);
  assert.deepEqual(['A', 'B', 'F'].map(id => report.conditions[id].started), [16, 16, 16]);
  assert.equal(report.conditions.B.extraction_failures, 2);
  assert.equal(report.conditions.F.operational_failures, 1);
  assert.equal(report.conditions.F.over_budget, 1);
  assert.equal(report.conditions.F.negative_cases, 4);
});
test('all budget dimensions count and unknown cost cannot be a success under budget', () => {
  const budgets = { tokens: 10, tool_calls: 2, duration_ms: 30, usd: 1 };
  const episode = { usage: { tokens: 10, tool_calls: 2 }, duration_ms: 30, cost: { observed_usd: null, estimated_usd: 1 } };
  assert.equal(underBudget(episode, budgets), true);
  for (const patch of [{ usage: { tokens: 11, tool_calls: 2 } }, { usage: { tokens: 10, tool_calls: 3 } }, { duration_ms: 31 }, { cost: { observed_usd: 2, estimated_usd: 0 } }, { cost: { observed_usd: null, estimated_usd: null } }]) assert.equal(underBudget({ ...episode, ...patch }, budgets), false);
});
test('restricted preparation and CLI dry-run enforce Docker hardening without running Docker', t => {
  const directory = temporary(t); writeFileSync(path.join(directory, 'Main.lean'), 'example : (1 : Nat) = 1 := by rfl\n');
  const image = 'local/lean@sha256:' + 'a'.repeat(64), plan = prepareRestricted({ codeDirectory: directory, image });
  const args = plan.args, value = flag => args[args.indexOf(flag) + 1];
  for (const flag of ['--rm', '--read-only']) assert.ok(args.includes(flag));
  for (const [flag, expected] of [['--network', 'none'], ['--pull', 'never'], ['--user', '65532:65532'], ['--memory', '512m'], ['--memory-swap', '512m'], ['--cpus', '1'], ['--pids-limit', '64'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges:true']]) assert.equal(value(flag), expected);
  assert.match(value('--tmpfs'), /nosuid,nodev,noexec,size=64m/);
  assert.match(value('--mount'), /target=\/code,readonly$/);
  assert.equal(args.filter(arg => arg === '--mount').length, 1);
  assert.equal(args.some(arg => /docker\.sock|privileged|credentials|\.ssh|\.env/.test(arg)), false);
  const dry = spawnSync(process.execPath, [path.join(ROOT, 'exec', 'restricted.mjs'), '--dry-run', '--code-dir', directory, '--image', image], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dry_run, true);
  assert.deepEqual(JSON.parse(dry.stdout).args, args);
  assert.throws(() => prepareRestricted({ codeDirectory: directory, image: 'lean:latest' }), /immutable/);
  assert.throws(() => prepareRestricted({ codeDirectory: directory, image, entry: '../Main.lean' }), /plain Lean/);
  writeFileSync(path.join(directory, 'answers.json'), '{}');
  assert.throws(() => prepareRestricted({ codeDirectory: directory, image }), /only non-linked Lean files/);
});
test('restricted execution fails explicitly without Docker and never falls back to host', t => {
  const directory = temporary(t); writeFileSync(path.join(directory, 'Main.lean'), 'example : True := by trivial\n');
  const plan = prepareRestricted({ codeDirectory: directory, image: 'lean@sha256:' + 'a'.repeat(64) });
  const calls = [];
  const spawn = (...args) => { calls.push(args); return { status: null, error: new Error('ENOENT') }; };
  assert.throws(() => executeRestricted(plan, { spawn }), /Docker unavailable.*host fallback is forbidden/);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'docker'); assert.equal(calls[0][1][0], 'version');
  assert.equal(Object.hasOwn(calls[0][2].env, 'DOCKER_HOST'), false);
  assert.equal(calls[0][2].shell, false);
  assert.equal(existsSync(calls[0][2].env.DOCKER_CONFIG), false);
  const altered = { ...plan, args: [...plan.args, '--privileged'] };
  assert.throws(() => executeRestricted(altered, { spawn }), /modified/);
  assert.equal(calls.length, 1);
});
test('restricted Docker timeout cleans up only its uniquely named container (mocked)', t => {
  const directory = temporary(t); writeFileSync(path.join(directory, 'Main.lean'), 'example : True := by trivial\n');
  const plan = prepareRestricted({ codeDirectory: directory, image: 'lean@sha256:' + 'a'.repeat(64) });
  const calls = [];
  const spawn = (command, args) => { calls.push({ command, args }); return args[0] === 'run' ? { error: new Error('timed out') } : { status: 0 }; };
  assert.throws(() => executeRestricted(plan, { spawn }), /no host fallback/);
  assert.deepEqual(calls.map(call => call.args[0]), ['version', 'run', 'rm']);
  const name = calls[1].args[2];
  assert.match(name, /^math-eval-v2-/);
  assert.deepEqual(calls[2].args, ['rm', '--force', name]);
});
