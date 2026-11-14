# ArXivLean retrieval masking — decided design (not implemented)

**Status: design only. No ArXiv task has been run, and none should be until the
controls in §4 pass.**

## Why this is harder than the v4 ten-task study

The inspected ArXivLean adapter accepts either `arxivlean_proof : P` or
`arxivlean_disproof : ¬P`. So the answer is not "the proof" — it is **the truth
direction plus its proof or counterexample**. Anything that reveals which way a
conjecture resolves is answer-bearing: the paper's theorem statement, its
abstract, its title in some cases, a formal proof, a Comparator challenge file,
a prior transcript, or an index built over any of them.

Smoke task 4 is the concrete example: its title, "Counterexamples to two
conjectures…", discloses the direction on its own. **Metadata needs masking too.**

This control addresses accessible retrieval. It does not address model
memorisation or independent re-derivation, and it should never be described as
if it did.

## Decision: per-task excerpt snapshots, enforced at storage *and* tools

Both layers, not one:

1. **Storage.** For each task, build a physically answer-excluded snapshot from
   evaluator-reviewed spans. Emit only approved spans as standalone UTF-8
   excerpts, derive metadata and any index solely from those excerpts, and bind
   the whole set to one manifest hash.
2. **Tools.** Handlers serve only canonical logical paths that appear in that
   task's manifest, resolve only inside the snapshot, and never fall back to the
   original archive, a prebuilt corpus index, or a cached extraction.

The provable invariant is narrow and honest: **every source response comes from
approved snapshot bytes**. Whether those bytes disclose the answer is a human
review judgement; hashing does not establish it. A keyword ban is not a boundary.

## Building and serving

```text
build(task):
  verify each original source hash
  emit only explicitly approved spans into standalone excerpts
  derive metadata and index solely from emitted excerpts
  reject missing approval, unexpected artifacts, or hash mismatch

serve(task, path):
  require authenticated binding to this task's snapshot hash
  require canonical logical path ∈ snapshot.manifest.files
  return only verified snapshot bytes; never resolve original-source paths
```

Each approved span must be either already-public problem material, or
definitions/background/bibliography that does not disclose the resolution,
target-specific strategy, witness, or an equivalent/stronger resolving result.

**Do not auto-approve "front matter through the theorem."** For a
prove-or-disprove task the paper's assertion of that theorem is the answer.
Supply the conjecture as posed publicly and omit the paper's conclusion.
For a proof-only task whose target is already supplied, the statement may stay;
its proof may not.

Excluded: original target PDFs and TeX, target Lean modules and compiled
artifacts, Comparator files, other tasks' solutions, histories, caches, and any
index built over the full corpus. Supply reviewed text excerpts, not original
PDFs and not visually redacted PDFs. Keep original hashes and span provenance
evaluator-only. Use neutral snapshot filenames and reviewed metadata. When in
doubt, exclude.

## Controls that must pass before any smoke

Run through the actual staged handlers, not by inspection:

| Negative control | Required outcome |
|---|---|
| Direct read of an excluded proof or Comparator path, including traversal and linked aliases | Explicit rejection, no bytes or excerpts |
| Glob/archive discovery and literal/BM25 search for a private proof sentinel | Discovery unavailable; sentinel absent from results, snippets and metadata |
| PDF extraction request for the original proof page | Original path rejected; no archive fallback |
| Read/search an old prebuilt index, cached extraction, transcript or output | Artifact absent and inaccessible |
| Substitute an index or mutate an approved excerpt | Hash mismatch blocks service and admission |
| Lean/process attempt to read the corpus or import a cached target module | Corpus unavailable; target module absent |

Positive retrieval controls are required too, so a broken or empty toolset
cannot "pass" by returning nothing.

Reuse unchanged from v4: web/subagent/`execute` exclusion, gold/output
separation, generic-tool parity, isolated compiler, independent data-only
kernel replay. **Re-run and rebind that evidence** against the new snapshots —
historical passes do not authenticate new bytes.

## Wiring order and cost

1. **Task/gold adapter** — freeze the full task inventory and public inputs;
   answers, provenance and controls stay evaluator-only. The inspected v3
   directory holds only five tasks, which does not validate all 53; record any
   prompt/metadata adaptation explicitly.
2. **Mask policy and builder** — per-task span manifests, deterministic excerpts
   and index.
3. **Tool handlers** — replace the three-source assumptions with authenticated
   per-task manifests; keep the generic tools and ON-only navigation over
   identical bytes.
4. **Checker binding** — bind frozen definitions, imports and axioms, and accept
   either permitted declaration/type pair, with independent replay. Prevent
   submitted redefinitions from changing the trusted target. Reuse the checker
   machinery, not the archived v3 grader, which returns `unverified`.
5. **Admission** — bind task, prompt, mask, snapshot, tool and checker hashes;
   run controls, then parent review and freeze.

The cost is reviewing answer-bearing content and validating task/checker
contracts, not building new infrastructure.

## NO-GO

A five-task smoke is meaningful only when each selected task has reviewed
legitimate material, no unresolved answer-bearing metadata, passing
retrieval/isolation controls, and task-bound positive and negative checker
controls, all frozen by the parent first.

Unreviewed PDFs, indexes or imports; asymmetric source access; stale bindings;
unresolved interface failures; or treating compilation/stdout as proof all make
a completed smoke uninterpretable.

Any eventual result must be reported as **restricted-source ArXivLean**, not as
the unchanged official benchmark and not as evidence of contamination-free
reasoning.
