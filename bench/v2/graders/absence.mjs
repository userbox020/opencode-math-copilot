import { sameSet, verdict } from './shared.mjs';

// Deliberately conservative English fixture checks, not semantic adjudication.
// See CONTRACTS.md for accepted scope phrases and false-positive limitations.
const excerptScope = /\bexcerpts?\b[^.;]{0,60}\bconsult|\bconsult\w*\b[^.;]{0,60}\bexcerpts?\b/;
// A denial of a global claim ("does not establish corpus-wide nonexistence")
// must not be confused with an assertion of one ("no such result exists anywhere").
const denial = /\b(?:does not|do not|did not|doesn't|don't|didn't|cannot|can't|fails? to)\s+(?:establish|prove|show|imply|demonstrate|mean|suffice|support)\b|\bno\b[^.;]{0,40}\b(?:conclusion|claim|evidence)\b|\bnot (?:evidence|proof)\b/;
const globalAssertion = [
  /\b(?:entire|whole|full) corpus\b/,
  /\bcorpus wide\b/,
  /\b(?:anywhere|nowhere)\b/,
  /\b(?:nonexistent|non existent)\b/,
  /\b(?:there (?:is|are) )?no\b[^.;]{0,80}\b(?:anywhere|in (?:the )?corpus|exists?|existence)\b/,
  /\b(?:does not|do not|doesn't|don't) exist\b/,
  /\b(?:exists?|found|occurs?)\s+nowhere\b/,
  /\b(?:has|have|contains?)\s+no\b[^.;]{0,60}\b(?:anywhere|in (?:the )?corpus)\b/,
  /\bcorpus\b[^.;]{0,30}\b(?:contains?|has|have)\s+no\b/,
  /\bnothing\b[^.;]{0,40}\bin (?:the )?corpus\b/,
  /\bno (?:matches?|results?)\b[^.;]{0,30}\bin (?:the )?corpus\b/,
  /\bno (?:such )?(?:documents?|manuscripts?|papers?|results?|theorems?|proofs?)\b[^.;]{0,60}\b(?:exists?|in (?:the )?corpus)\b/,
];
function assertsGlobal(text) {
  return text.split(/[.;]\s*|\b(?:but|however|yet)\b/).some(clause => {
    if (denial.test(clause)) return false;
    return globalAssertion.some(pattern => pattern.test(clause));
  });
}

export default function absence(answer, spec, context = {}) {
  const scope = answer.status === spec.status && sameSet(answer.consulted, spec.consulted);
  const prose = typeof answer.prose === 'string'
    ? answer.prose.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[-\u2010-\u2015]/g, ' ').replace(/\s+/g, ' ')
    : '';
  const proseValid = prose.length > 0 && excerptScope.test(prose)
    && (spec.exhaustive_inventory === true || !assertsGlobal(prose));
  const evidence = spec.status === 'not_found_in_consulted_excerpts'
    ? sameSet(context.consulted, spec.consulted)
    : spec.status === 'corpus_unavailable' ? context.corpus_available === false : spec.exhaustive_inventory === true && context.exhaustive_inventory === true;
  return verdict(scope && evidence && proseValid, 'status and consulted evidence with required excerpt-scoped prose and no unsupported global absence claim');
}
