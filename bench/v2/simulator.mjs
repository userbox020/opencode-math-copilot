import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assert, assertWorkspace, validateProfile } from './lib.mjs';

export function createDispatcher(profile, workspace) {
  validateProfile(profile);
  assertWorkspace(workspace.directory, workspace.files);
  const events = [];
  const context = { consulted: [], corpus_available: profile.corpus_access };
  function call(tool, args) {
    assert(profile.effective_tools.includes(tool), `tool_unavailable: ${tool}`);
    assertWorkspace(workspace.directory, workspace.files);
    const task = JSON.parse(workspace.files['task.json']);
    assert(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 1 && args.task_id === task.id,
      'tool_unavailable: simulated endpoints accept only the public task_id, never file paths or evaluator data');
    let result;
    if (['corpus_search', 'read_excerpt', 'math_search', 'math_manuscript', 'math_grep', 'math_pdf_text', 'math_pdf_search', 'math_pdf_corpus_search', 'math_pdf_index_search'].includes(tool)) {
      const excerpts = JSON.parse(readFileSync(path.join(workspace.directory, 'corpus', 'excerpts.json'), 'utf8'));
      result = { excerpts, complete_corpus: false };
      context.consulted = [...new Set([...context.consulted, ...excerpts.map(item => `${item.document}#${item.locator}`)])];
    } else if (['compute', 'math_compute'].includes(tool)) result = { fixture: true, text: '3; x/x = 1 when x != 0. These are tool logs, not a submitted answer.' };
    else result = { simulated: true, available: true, executed: false, note: 'Manifest-registered simulated endpoint; no external execution.' };
    events.push({ seq: events.length + 1, kind: 'tool_call', tool, arguments: args, result, duration_ms: 5, simulated: true });
    return result;
  }
  return { call, events, context };
}

// Trusted fixture controller, NOT a real model. Reference finals stay in the
// controller and never enter the disposable agent workspace. Each call is
// stateless; all condition-dependent behavior is explicit and preregistered.
export function simulate({ task, ids, profile, workspace, dispatcher }) {
  assertWorkspace(workspace.directory, workspace.files);
  const taskInput = JSON.parse(readFileSync(path.join(workspace.directory, 'task.json'), 'utf8'));
  assert(taskInput.id === task.id, 'Task payload mismatch');
  const condition = profile.id, modelB = ids.model_id === 'simulated-model-b';
  if (condition !== 'A') {
    const retrieval = ['citation', 'absence'].includes(task.type);
    dispatcher.call(condition === 'B' ? (retrieval ? 'corpus_search' : 'compute') : (retrieval ? 'math_search' : 'math_compute'), { task_id: task.id });
  }
  if (modelB && condition === 'F' && task.type === 'absence' && ids.repeat_id === 2) throw new Error('adapter_failure: simulated corpus transport failure');
  let final = structuredClone(task.correct_final);
  if (condition === 'A' && task.type === 'numeric' && modelB) final.value = -3;
  if (task.type === 'symbolic' && (condition === 'A' || (condition === 'B' && modelB))) final.conditions = [];
  if (task.type === 'citation' && condition === 'A') final.document = 'toy-other';
  if (task.type === 'citation' && condition === 'B' && modelB) final = null; // correct claim only in tool logs
  if (task.type === 'absence' && condition === 'A') final.status = 'nonexistent';
  const tokens = modelB && condition === 'F' && task.type === 'numeric' && ids.repeat_id === 2 ? 1200 : 100;
  return { final, usage: { tokens, tool_calls: dispatcher.events.length }, duration_ms: 20 + dispatcher.events.length * 5 };
}
