import { sameSet, verdict } from './shared.mjs';

export default function absence(answer, spec, context = {}) {
  const scope = answer.status === spec.status && sameSet(answer.consulted, spec.consulted);
  const evidence = spec.status === 'not_found_in_consulted_excerpts'
    ? sameSet(context.consulted, spec.consulted)
    : spec.status === 'corpus_unavailable' ? context.corpus_available === false : spec.exhaustive_inventory === true && context.exhaustive_inventory === true;
  return verdict(scope && evidence, 'bounded excerpt absence, exhaustive nonexistence or corpus-unavailability evidence');
}
