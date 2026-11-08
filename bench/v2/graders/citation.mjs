import { verdict } from './shared.mjs';

export default function citation(answer, spec) {
  return verdict(answer.document === spec.document && answer.locator === spec.locator && answer.claim === spec.supported_claim && answer.supported === true, 'exact document, locator and fixture-supported affirmative claim');
}
