import numeric from './numeric.mjs';
import symbolic from './symbolic.mjs';
import citation from './citation.mjs';
import formal from './formal.mjs';
import explanation from './explanation.mjs';
import absence from './absence.mjs';

const graders = { numeric, symbolic, citation, formal, explanation, absence };
const string = value => typeof value === 'string';
const strings = value => Array.isArray(value) && value.every(string);
export function extractFinal(final, type) {
  if (!final || typeof final !== 'object' || Array.isArray(final) || final.type !== type) return null;
  const valid = {
    numeric: () => typeof final.value === 'number' && Number.isFinite(final.value) && string(final.domain) && string(final.units) && strings(final.conditions),
    symbolic: () => string(final.domain) && strings(final.conditions) && strings(final.assumptions) && (Array.isArray(final.solutions) || (Array.isArray(final.numerator) && Array.isArray(final.denominator))),
    citation: () => string(final.document) && string(final.locator) && string(final.claim) && typeof final.supported === 'boolean',
    formal: () => string(final.solution) && string(final.target_sha256) && string(final.receipt_sha256),
    explanation: () => string(final.text),
    absence: () => ['not_found_in_consulted_excerpts', 'nonexistent', 'corpus_unavailable'].includes(final.status) && strings(final.consulted) && string(final.prose) && final.prose.trim().length > 0
  }[type];
  return valid?.() ? final : null;
}
export function gradeFinal(task, rawFinal, context = {}) {
  const final = extractFinal(rawFinal, task.type);
  if (!final) return { final: null, status: 'extraction_failure', grade: { correct: false, reason: 'extraction_failure: no evaluable typed final answer; logs are never scored' } };
  return { final, status: 'completed', grade: graders[task.type](final, task.grading, context) };
}
