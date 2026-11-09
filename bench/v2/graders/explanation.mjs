import { sha256 } from '../lib.mjs';
import { verdict } from './shared.mjs';

export default function explanation(answer, spec) {
  // Exact-text hash fixture validation only, including error-detection fixtures.
  // Even a correct paraphrase without a registered hash fails; this is not
  // general free-form explanation adjudication or a model judge.
  const label = typeof answer.text === 'string' ? spec.labels[sha256(answer.text)] : undefined;
  return verdict(label && spec.rubric.every(criterion => label[criterion] === true), label ? 'exact-text hash fixture rubric validation (not free-form adjudication)' : 'explanation not in exact-text hash fixture labels (not free-form adjudication)');
}
