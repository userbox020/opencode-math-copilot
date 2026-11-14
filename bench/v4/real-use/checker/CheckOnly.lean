/- Data-only checker. Comparator portions adapted from d03acab154d269c06e60e4de7e4cc85deebff94b
   Main.lean (Apache-2.0, Copyright 2025 Lean FRO, Henrik Böving).
   No submitted modules are imported. Export.Parse only reconstructs declaration data;
   the empty kernel replays that data independently of the hostile exporter. -/
import Lean
import Comparator
import Export.Parse

namespace CheckOnly

def primitiveTargets : Array Lean.Name := #[
    -- ``Nat.zero,
    -- ``Nat.succ,
    ``Nat.add,
    ``Nat.sub,
    ``Nat.mul,
    ``Nat.pow,
    ``Nat.gcd,
    ``Nat.div,
    ``Nat.mod,
    ``Nat.beq,
    ``Nat.ble,
    ``Nat.land,
    ``Nat.lor,
    ``Nat.xor,
    ``Nat.shiftLeft,
    ``Nat.shiftRight,
    ``String.ofList,
    ``Char.ofNat,
    ``List,
    ``eagerReduce,
    ``Nat,
    ``String,
    ``String.mk,
    ``Char,
    ``optParam,
    ``autoParam,
    ``semiOutParam,
    ``outParam
  ]

def legalAxioms : Array Lean.Name := #[``propext, ``Quot.sound, ``Classical.choice]

def stringStream (s : String) : BaseIO IO.FS.Stream := do
  let ref ← IO.mkRef { data := s.toByteArray }
  return IO.FS.Stream.ofBuffer ref

def replayChecked (solution : Export.ExportedEnv) : IO Lean.Kernel.Environment := do
  let env ← Lean.mkEmptyEnvironment
  let origConstMap := solution.constMap
  let quotTargets := [`Quot.mk, `Quot.lift, `Quot.ind]
  let kernelConstMap := quotTargets.foldl (init := origConstMap) (·.erase ·)
  let kernelEnv ← env.toKernelEnv.replay kernelConstMap
  let verifyTargets := `Quot :: quotTargets
  for quotTarget in verifyTargets do
    if let some info := origConstMap[quotTarget]? then
      let some info' := kernelEnv.find? quotTarget |
        throw <| .userError s!"Could not find quotient constant in final kernel env: {quotTarget}"
      if info != info' then
        throw <| .userError s!"Quotient constant mismatch on: {quotTarget}"
  return kernelEnv

-- The upstream parser overwrites repeated index keys. Reject those before parsing.
-- In particular name/level zero are reserved, and cannot be rebound.
def validateIndices (text : String) : IO Unit := do
  let mut names : Std.HashSet Nat := {0}
  let mut levels : Std.HashSet Nat := {0}
  let mut exprs : Std.HashSet Nat := {}
  let lines := text.splitOn "\n"
  if lines.length < 2 then throw <| .userError "missing export header"
  for line in lines.drop 1 do
    if !line.isEmpty then
      let json ← IO.ofExcept <| Lean.Json.parse line
      for key in ["in", "il", "ie"] do
        if let .ok value := json.getObjVal? key then
          let n ← IO.ofExcept value.getNat?
          let seen := if key == "in" then names else if key == "il" then levels else exprs
          if seen.contains n then throw <| .userError "duplicate export index"
          if key == "in" then names := names.insert n
          else if key == "il" then levels := levels.insert n
          else exprs := exprs.insert n

def validateDeclarations (env : Export.ExportedEnv) (candidate : Bool) : IO Unit := do
  for (key, info) in env.constMap do
    if key != info.name || key.isAnonymous then
      throw <| .userError "constant name association mismatch"
    let unsafeDecl : Bool := match info with
      | .axiomInfo v => v.isUnsafe
      | .defnInfo v => v.safety != Lean.DefinitionSafety.safe
      | .opaqueInfo v => v.isUnsafe
      | .inductInfo v => v.isUnsafe
      | .ctorInfo v => v.isUnsafe
      | .recInfo v => v.isUnsafe
      | _ => false
    if unsafeDecl then throw <| .userError "unsafe or partial declaration"
    if candidate then
      if let .axiomInfo _ := info then
        if !legalAxioms.contains key then throw <| .userError s!"unpermitted axiom: {key}"

def check (task : String) (candidate : String) : IO Unit := do
  let target ← match task with
    | "lean-cancellation-repair" => pure `real_use_cancel
    | "lean-rational-odd-sum" => pure `real_use_odd_sum
    | _ => throw <| .userError "unknown task"
  let trusted ← IO.FS.readFile s!"/opt/challenges/{task}.export"
  validateIndices trusted
  validateIndices candidate
  let challenge ← Export.parseStream (← stringStream trusted)
  let solution ← Export.parseStream (← stringStream candidate)
  validateDeclarations challenge false
  validateDeclarations solution true
  let theoremNames := #[target]
  IO.ofExcept <| Comparator.compareAt challenge solution (theoremNames ++ legalAxioms) #[] primitiveTargets
  IO.ofExcept <| Comparator.checkAxioms solution theoremNames #[] legalAxioms
  let replayed ← replayChecked solution
  let some (.thmInfo _) := replayed.find? target |
    throw <| .userError "requested theorem absent from replayed kernel"

def boundedInput : IO String := do
  let input ← IO.getStdin
  let mut bytes := ByteArray.empty
  repeat
    let chunk ← input.read 65536
    if chunk.isEmpty then break
    if bytes.size + chunk.size > 67108864 then throw <| .userError "input limit"
    bytes := bytes ++ chunk
  let some text := String.fromUTF8? bytes | throw <| .userError "invalid UTF-8"
  return text

end CheckOnly

def main (args : List String) : IO UInt32 := do
  let task := args.headD ""
  let accepted ← try
    if args.length != 1 then throw <| IO.userError "one task selector required"
    CheckOnly.check task (← CheckOnly.boundedInput)
    pure true
  catch e =>
    -- Diagnostics are never a protocol or acceptance channel.
    IO.eprintln (e.toString.take 4096).toString
    pure false
  IO.println <| Lean.Json.compress <| Lean.Json.mkObj [
    ("schema", .str "comparator-check-only/v1"), ("task_id", .str task),
    ("status", .str (if accepted then "accepted" else "rejected"))]
  return if accepted then 0 else 1
