// provisional: true; review_status: owner-review-pending
// Task-local smoke-test grader, not wired into the runner or a semantic judge.
import { createHash } from 'node:crypto';
import { sameSet, verdict } from '../graders/shared.mjs';

export default function gradeAbsence(answer, spec, context = {}) {
  if (!answer || answer.type !== 'absence' || typeof answer.prose !== 'string'
      || !answer.prose.trim() || !Array.isArray(answer.consulted)
      || !answer.consulted.every(id => typeof id === 'string')) {
    return verdict(false, 'required typed absence prose and consulted identifiers');
  }
  // Keep status and evaluator evidence checks separate from prose scoring.
  // Global-claim keyword filters can reject a denial of nonexistence itself;
  // these smoke fixtures instead use their frozen exact-text rubric below.
  const scope = answer.status === spec.status && sameSet(answer.consulted, spec.consulted);
  const evidence = spec.status === 'not_found_in_consulted_excerpts'
    ? sameSet(context.consulted, spec.consulted)
    : spec.status === 'corpus_unavailable' && context.corpus_available === false;
  if (!scope || !evidence) return verdict(false, 'status, consulted identifiers and evaluator evidence');
  const key = createHash('sha256').update(answer.prose).digest('hex');
  const label = spec.labels?.[key];
  return verdict(label && Array.isArray(spec.rubric) && spec.rubric.length > 0
    && spec.rubric.every(criterion => label[criterion] === true),
  'provisional exact-prose rubric (unregistered prose is not semantically graded)');
}
