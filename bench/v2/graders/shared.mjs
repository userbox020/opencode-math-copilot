export const verdict = (correct, rule) => ({ correct: Boolean(correct), reason: `${correct ? 'pass' : 'fail'}: ${rule}` });
export function sameSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && new Set(left).size === left.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
