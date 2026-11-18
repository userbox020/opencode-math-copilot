import test from 'node:test';

// Explicit accounting only: do not import or execute the v4 suite.
test('compilation success is not Comparator acceptance', {
  skip: 'Already covered: bench/v4/real-use/tests/checker.test.mjs:159-176 compiles/exports negative controls, then requires checker rejection. Real Docker/Lean controls remain opt-in there.',
}, () => {});
test('a valid issued receipt cannot be reused', {
  skip: 'Already covered: bench/v4/real-use/tests/checker.test.mjs:136-148 verifies issued_receipt_verified then replay_denied. No duplicate Docker/Lean run.',
}, () => {});
