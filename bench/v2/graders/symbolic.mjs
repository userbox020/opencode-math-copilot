import { sameSet, verdict } from './shared.mjs';

// Bounded exact integer-coefficient polynomial arithmetic, low-to-high powers.
// No eval, numeric sampling or unrestricted symbolic parser.
const polynomial = p => Array.isArray(p) && p.length > 0 && p.length <= 8 && p.every(c => Number.isInteger(c) && Math.abs(c) <= 10000);
const trim = p => { const result = [...p]; while (result.length > 1 && result.at(-1) === 0) result.pop(); return result; };
const equal = (a, b) => JSON.stringify(trim(a)) === JSON.stringify(trim(b));
function multiply(a, b) {
  const result = Array(a.length + b.length - 1).fill(0);
  a.forEach((x, i) => b.forEach((y, j) => { result[i + j] += x * y; }));
  return result;
}
function proportional(a, b) {
  a = trim(a); b = trim(b);
  return a.length === b.length && a.some(Boolean) && b.some(Boolean) && a.every((value, i) => value * b.at(-1) === b[i] * a.at(-1));
}
export default function symbolic(answer, spec) {
  // Units are exact metadata when registered; omitted spec.units leaves units
  // unconstrained, preserving the original unit-free fixture behavior.
  const units = !Object.hasOwn(spec, 'units') || (Object.hasOwn(answer, 'units') && answer.units === spec.units);
  const metadata = units && answer.domain === spec.domain && sameSet(answer.conditions, spec.conditions) && sameSet(answer.assumptions, spec.assumptions);
  if (spec.kind === 'solution-set') {
    return verdict(metadata && Array.isArray(answer.solutions) && answer.solutions.every(Number.isFinite) && sameSet(answer.solutions, spec.solutions), 'exact complete solution set under explicit assumptions and registered units');
  }
  const numerator = answer.numerator, denominator = answer.denominator;
  const valid = polynomial(numerator) && polynomial(denominator) && denominator.some(Boolean);
  // Registered denominator classes rule out extra poles, including those canceled
  // in the submitted numerator. This deliberately supports only bounded fixtures.
  const denominatorAllowed = valid && spec.allowed_denominators.some(p => proportional(denominator, p));
  return verdict(metadata && denominatorAllowed && equal(multiply(numerator, spec.denominator), multiply(spec.numerator, denominator)), 'exact rational-polynomial equivalence, registered units and domain restrictions');
}
