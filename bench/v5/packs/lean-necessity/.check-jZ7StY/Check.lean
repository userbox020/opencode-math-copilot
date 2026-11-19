import Mathlib
set_option autoImplicit false
def GoldExpected : Prop := ∀ xs : List Nat, xs.reverse.reverse = xs

namespace Submission
theorem claim : ∀ xs : List Nat, xs.reverse.reverse = xs := by
  intro xs
  simp
end Submission
#print axioms Submission.claim
theorem GoldWitness : GoldExpected := Submission.claim
#print axioms GoldWitness
