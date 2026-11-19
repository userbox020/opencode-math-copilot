import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, sha256, validateTasks } from '../../external/schema.mjs';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ALLOWED_AXIOMS = ['propext', 'Quot.sound', 'Classical.choice'];
export const FINAL_QUESTION = 'Is this a valid proof of the stated theorem under Mathlib and the allowed axioms? Answer exactly VALID or INVALID on the final line.';
const accepted = 'The file compiles, the declaration proves the independently stated target, and its transitive axioms are all allowed.';
const fixture = (id, expectedType, body, verdict, reasonCode, reason) => ({
  id, imports: ['Mathlib'], theorem: 'Submission.claim', expectedType,
  code: `import Mathlib\n\nnamespace Submission\n${body}\nend Submission\n`,
  verdict, reasonCode, reason,
});

// Evaluator-only specifications. Never pass this module or grading fields to a model.
export const FIXTURES = [
  fixture('lean-valid-01', '(1 : Nat) + 1 = 2',
    'theorem claim : (1 : Nat) + 1 = 2 := by\n  norm_num',
    'VALID', 'accepted', accepted),
  fixture('lean-valid-02', '∀ n : Nat, n + 0 = n',
    'theorem claim : ∀ n : Nat, n + 0 = n := by\n  intro n\n  simp',
    'VALID', 'accepted', accepted),
  fixture('lean-valid-03', '∀ xs : List Nat, xs.reverse.reverse = xs',
    'theorem claim : ∀ xs : List Nat, xs.reverse.reverse = xs := by\n  intro xs\n  simp',
    'VALID', 'accepted', accepted),
  fixture('lean-valid-04', '∀ s : Set Nat, s ∩ s = s',
    'theorem claim : ∀ s : Set Nat, s ∩ s = s := by\n  intro s\n  ext x\n  simp',
    'VALID', 'accepted', accepted),
  fixture('lean-valid-05', '∀ P Q : Prop, P ∧ Q → Q ∧ P',
    'theorem claim : ∀ P Q : Prop, P ∧ Q → Q ∧ P := by\n  intro P Q h\n  exact ⟨h.2, h.1⟩',
    'VALID', 'accepted', accepted),
  fixture('lean-invalid-01', '∀ n : Nat, n + 0 = n',
    'lemma addition_identity : ∀ n : Nat, n + 0 = n := by\n  sorry\n\ntheorem claim : ∀ n : Nat, n + 0 = n := addition_identity',
    'INVALID', 'sorry-axiom',
    'The helper addition_identity uses sorry; Submission.claim transitively depends on the forbidden axiom sorryAx despite compiling and matching the target.'),
  fixture('lean-invalid-02', '∀ n : Nat, n + 0 = n',
    'axiom addition_identity : ∀ n : Nat, n + 0 = n\n\ntheorem claim : ∀ n : Nat, n + 0 = n := addition_identity',
    'INVALID', 'extra-axiom',
    'Submission.claim depends on the explicitly declared Submission.addition_identity axiom, which is outside the allowlist.'),
  fixture('lean-invalid-03', '∀ n : Nat, n + 1 > n',
    'theorem claim : ∃ n : Nat, n + 1 > n := by\n  exact ⟨0, by decide⟩',
    'INVALID', 'target-mismatch',
    'The declaration proves only an existential statement, not the requested universal statement; the independently typed target witness fails.'),
  fixture('lean-invalid-04', '_root_.Monotone (fun n : Nat => 10 - n)',
    'def Monotone (f : Nat → Nat) : Prop := ∀ n, f n = f n\n\ntheorem claim : Monotone (fun n : Nat => 10 - n) := by\n  intro n\n  rfl',
    'INVALID', 'shadowed-definition',
    'Submission.Monotone shadows Mathlib Monotone with a reflexive identity; the declaration does not prove the independently stated _root_.Monotone target.'),
  fixture('lean-invalid-05', '∀ n : Nat, n + 1 ≤ n',
    'theorem claim : ∀ n : Nat, n + 1 ≤ n := by\n  intro n\n  omega',
    'INVALID', 'compilation-failure',
    'The reversed inequality is impossible for natural numbers; omega fails in the submitted declaration, so the file does not compile.'),
];

export function makeTasks() {
  return validateTasks(FIXTURES.map(f => ({
    schema: 'math-bench-task/v1',
    benchmark: 'lean-necessity',
    id: f.id,
    prompt: [
      'Evaluate the supplied Lean file, not whether the stated theorem has some other proof.',
      'Imports: Mathlib.',
      `Allowed axioms (transitive dependencies): ${ALLOWED_AXIOMS.join(', ')}.`,
      `Theorem declaration to evaluate: ${f.theorem}.`,
      'Stated theorem (interpreted in a fresh Mathlib environment, before the supplied file):',
      `\`\`\`lean\n${f.expectedType}\n\`\`\``,
      'Full Lean file:',
      `\`\`\`lean\n${f.code}\`\`\``,
      FINAL_QUESTION,
    ].join('\n\n'),
    answer: f.verdict,
    grading: { type: 'exact', answer: f.verdict, note: f.reason },
    metadata: {
      source: 'Original synthetic Lean fixtures for lean-necessity.',
      license: 'CC0-1.0',
      kind: 'lean',
      review_note: 'Evaluate the specified declaration against the separately stated target and transitive axiom allowlist.',
    },
  })));
}

export const PILOT_IDS = [
  'lean-valid-01', 'lean-invalid-01', 'lean-valid-04',
  'lean-invalid-03', 'lean-invalid-04',
];
export const serialize = value => `${JSON.stringify(value, null, 2)}\n`;

export function assertCanonicalTasks(tasks) {
  validateTasks(tasks);
  if (serialize(tasks) !== serialize(makeTasks())) {
    throw new Error('Task content/verdict differs from the evaluator-owned fixtures; refusing verification.');
  }
}

export function build() {
  const tasks = makeTasks();
  const pilot = PILOT_IDS.map(id => tasks.find(t => t.id === id));
  const outputs = {
    'tasks.json': tasks,
    'pilot.json': pilot,
    'baselines.json': {
      schema: 'math-bench-baselines/v1',
      benchmark: 'lean-necessity',
      external: [],
      note: 'No external baseline or model run is included.',
    },
  };
  for (const [name, value] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(DIR, name), serialize(value));
  }
  return {
    tasks: tasks.length, valid: 5, invalid: 5, pilot: pilot.length,
    tasks_sha256: sha256(serialize(tasks)), pilot_sha256: sha256(serialize(pilot)),
    gold: 'Run node verify.mjs to obtain independent Docker Lean evidence; build alone does not verify proofs.',
  };
}

if (isMain(import.meta.url)) console.log(JSON.stringify(build(), null, 2));
