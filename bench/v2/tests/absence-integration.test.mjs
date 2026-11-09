import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gradeFinal } from '../graders/index.mjs';

const tasks = JSON.parse(readFileSync(fileURLToPath(new URL('../tasks/pilot-v1.json', import.meta.url)), 'utf8'));
const absenceTasks = (Array.isArray(tasks) ? tasks : tasks.tasks).filter(task => task.type === 'absence');

function contextFor(task) {
  return task.grading.status === 'corpus_unavailable'
    ? { corpus_available: false, consulted: task.grading.consulted }
    : { consulted: task.grading.consulted, corpus_available: true };
}

test('all six provisional absence reference prose values pass the runner grader', () => {
  assert.equal(absenceTasks.length, 6);
  for (const task of absenceTasks) {
    const result = gradeFinal(task, task.correct_final, contextFor(task));
    assert.equal(result.status, 'completed', task.id);
    assert.equal(result.grade.correct, true, `${task.id}: ${result.grade.reason}`);
  }
});

test('same-status wrong-prose controls are rejected for a scope overclaim', () => {
  for (const task of absenceTasks) {
    const control = task.prose_variants?.same_status_wrong_prose;
    assert.ok(control, `${task.id} has a wrong-prose control`);
    assert.equal(control.status, task.correct_final.status, task.id);
    assert.deepEqual(control.consulted, task.correct_final.consulted, task.id);
    const result = gradeFinal(task, control, contextFor(task));
    assert.equal(result.grade.correct, false, task.id);
  }
});

test('a denial of corpus-wide nonexistence is not mistaken for an assertion', () => {
  const task = absenceTasks[0];
  const denial = {
    ...task.correct_final,
    prose: 'The requested classification was not found in consulted excerpts. This limited inventory does not establish corpus-wide nonexistence.'
  };
  assert.equal(gradeFinal(task, denial, contextFor(task)).grade.correct, true);
});
