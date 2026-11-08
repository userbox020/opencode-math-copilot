import { sha256 } from '../lib.mjs';
import { verdict } from './shared.mjs';

export default function explanation(answer, spec) {
  // Grader input has no model/condition identity. Unknown prose is unscorable,
  // not keyword-matched or sent to a model judge.
  const label = typeof answer.text === 'string' ? spec.labels[sha256(answer.text)] : undefined;
  return verdict(label && spec.rubric.every(criterion => label[criterion] === true), label ? 'blind pre-scored explanation rubric' : 'explanation not in pre-scored fixture labels');
}
