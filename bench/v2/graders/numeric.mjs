import { sameSet, verdict } from './shared.mjs';

export default function numeric(answer, spec) {
  const value = answer.value;
  const metadata = answer.domain === spec.domain && answer.units === spec.units && sameSet(answer.conditions, spec.conditions);
  const tolerance = Math.max(spec.tolerance.absolute, spec.tolerance.relative * Math.abs(spec.value));
  return verdict(typeof value === 'number' && Number.isFinite(value) && metadata && Math.abs(value - spec.value) <= tolerance, 'numeric value, preregistered tolerance, domain, units and conditions');
}
