# Tool-necessity: manuscript sentence retrieval

Twenty hand-selected explanatory sentences from twenty distinct local
`openai/math` manuscripts, covering CONTENTS families **101–120**. The pilot is
the first ten tasks, `tool-text-01` through `tool-text-10` (families 101–110).
Each prompt names the README title, a TeX section, and a semantic clue without
disclosing eight consecutive answer words. No theorem/abstract sentences are
selected. The answers are exact raw TeX-source substrings, not rendered prose.

This is a **text-retrieval benchmark, not a mathematical-reasoning benchmark**.
Distinctive manuscript wording makes unaided reconstruction unlikely, but does
not prove a model has never seen the corpus or cannot memorize the answer.
The pack does not itself establish a plugin advantage. Plugin-off tools might
also retrieve these files; a comparison must document both arms' access.

## Build and verify (no models, Docker, or network)

From the repository root:

```powershell
node bench/v5/packs/tool-necessity/build.mjs
node --check bench/v5/packs/tool-necessity/build.mjs
node --check bench/v5/packs/tool-necessity/verify.mjs
node --test bench/v5/packs/tool-necessity/tests/tool-necessity.test.mjs
node bench/v5/packs/tool-necessity/verify.mjs
```

The default corpus is `C:\_Work\__OPENAI_MATH\math`. To use another checkout,
set `TOOL_NECESSITY_CORPUS_ROOT`. It must have identical source bytes, including
CRLF line endings. No recursive corpus scan occurs. The builder reads CONTENTS
and only the selected README/TeX files. It pins the CONTENTS and TeX hashes,
refusing changed inputs rather than silently adopting different questions.
It writes only `tasks.json`, `pilot.json`, and `baselines.json` beside itself,
using deterministic two-space JSON with a trailing newline.

The required task schema is kept unchanged. Pack-level provenance lives in
`baselines.json.metadata`: the raw CONTENTS hash, each TeX and README hash,
family mapping, and a SHA-256 of the ordered source-record JSON. This is a
manifest/selected-source fingerprint, **not a hash of the whole 3+ GB corpus**.
No source cache is used by verification: every invocation reopens the actual
corpus files, checks byte hashes, exact substring uniqueness, start line,
section, title, quote hash, encoding, and prompt leakage. A quote can begin
mid-line; its locator records the line containing its first character.
The verifier rejects all abstract/theorem-environment quotes, a stricter
restriction than excluding only the abstract's first sentence.

`node verify.mjs --stdin` accepts a complete `{tasks,pilot,baselines}` JSON pack
for negative tests and still reads the actual corpus. The tests do not create
temporary files; the determinism test rebuilds the three generated JSON files.

## Scoring and limitations

`answer` and `grading.answer` contain just the exact sentence, including source
line endings. A runner must extract the quoted span before exact comparison;
the separately requested path and starting line are locator-audit fields.
Do not compare the entire response (quote plus locator) to the answer string.
No runner or grader outside this directory is changed by this pack. A grader
that normalizes line endings would be a different, explicitly documented
metric. Keep answers/provenance out of the evaluated model's prompt.

The baseline model label and empty external list follow the neighboring packs.
The inherited no-published-score note is not the result of a new external
literature search. No model calls or external baseline measurements were made.
Source manuscript licensing was not independently verified; source rights
apply. This pack makes no claim that the manuscripts' mathematical results
are correct.
