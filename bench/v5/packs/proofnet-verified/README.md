# ProofNet-Verified proving pack

367 Lean proving tasks from the latest
[ProofNet-Verified](https://github.com/marcusm117/ProofNet-Verified) JSONL
(upstream license: Apache-2.0). No model inference or Lean checking is performed
by this pack. Its benchmark name is not a claim of local proof verification.

## Files and boundary

- `tasks.json`: array of `math-bench-lean-task/v1` tasks, sorted by numeric index,
  with three-digit IDs. Prompts contain only the informal statement, the proving
  instruction, header, helper definitions, and formal statement.
- `pilot.json`: array of 20 complete task objects. Sort textbooks by population
  descending, then name ascending; take up to five from each in that order until
  20 are selected. Within each textbook sort by numeric index and choose positions
  `round(i * (n - 1) / (k - 1))`, including endpoints. This selects five each from
  Dummit Foote, Munkres, Rudin, and Herstein; smaller textbooks are not represented.
- `controls.json`: evaluator-only contract. `entries` maps task IDs to ZIP entry
  names, null individual proof hashes, and `verified: false`. `inputs` records the
  JSONL, toolchain, and ZIP paths relative to the source clone and their byte-level
  SHA-256 hashes. Only ZIP central-directory names are inspected; no proof is
  decompressed, extracted, copied, or exposed to prompts.
- `baselines.json`: no published exact-model baseline; use the paired plugin-off
  arm. This is supplied baseline metadata, not a new literature-search result.

**Source normalization:** JSONL row 35 unexpectedly includes a complete proof in
`formal_stmt`. The builder preserves its declaration/type and replaces the entire
proof body with `by sorry`. All other formal statements are retained verbatim.
This exception is recorded in `controls.json`; no answer from that row is shipped.

## Grading contract (not yet bound)

Tasks request Lean **4.34.0**, `Mathlib`, and the allowed axiom set `propext`,
`Quot.sound`, `Classical.choice`. A later isolated evaluator must check the
complete candidate file against independently trusted task statements and
definitions and enforce the axiom allowlist; compilation alone is insufficient.
Treat candidate Lean as executable, untrusted code. Do not give the candidate
runtime evaluator-only proofs.

The gold archive is the **4.28** snapshot, while these statements target **4.34.0**.
ZIP membership does not establish proof compatibility or statement equivalence.
The workspace checker is **4.34.1**, is not bound to this pack, and has not
produced a positive result. All controls remain unverified and individual gold
proof hashes remain null until a separate evaluator lane supplies evidence.

## Rebuild and test (offline; Node only)

From the repository root:

```powershell
node bench/v5/packs/proofnet-verified/build.mjs
node --test bench/v5/packs/proofnet-verified/tests/proofnet-pack.test.mjs
node --check bench/v5/packs/proofnet-verified/build.mjs
```

The default read-only source clone is
`C:/Users/MiPC/AppData/Local/Temp/opencode/math-benchmarks-20261117/proofnet-verified`.
Pass another clone directory as the builder's sole argument; set
`PROOFNET_SOURCE_DIR` for tests using that clone. The builder only writes the four
JSON artifacts beside itself. Serialization is deterministic, with two-space
indentation, LF newlines, and a trailing newline; no timestamps or absolute source
paths appear in generated JSON. Tests rebuild artifacts in memory without writes.
