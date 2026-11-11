# Normal-use evaluation

This track measures plugin behavior in a **normal OpenCode session**, not the
strict A/B/F benchmark contract.

- Workspace: `C:\_Work\__OPENAI_MATH` (the actual math workspace with `math/`)
- Conditions: `plugin-on` and `plugin-off`
- Plugin off: `MATH_TOOLKIT_DISABLE=1` makes the math-toolkit plugin load but
  register no tools.
- Output: free-form final text; no typed-JSON answer contract.
- Primary metric: **human rubric score** in `review.csv`; the runner does not
  assign mathematical correctness automatically.
- Secondary metrics: latency, tokens, reported cost, total tool calls, and
  math-tool calls.

## Run

```powershell
$env:NORMAL_USE_ALLOW_EXECUTE='1'
npm run normal:run -- --model opencode-go/deepseek-v4.1-flash --limit 4
```

Use a fresh `--out` directory for each study. The runner writes:

- `manifest.json`
- `episodes.jsonl`
- `summary.json`
- `review.md`
- `review.csv`

`review.csv` starts with blank `score` and `notes` columns. A human reviewer
scores each response 0/1. The automated summary is not a correctness result.
After filling the review, run:

```powershell
npm run normal:report -- --out C:\Users\MiPC\AppData\Local\Temp\opencode\normal-use-v1
```

It writes `report.json` and `report.md`, separating mechanical metrics from the
human score.

## Dry run

```powershell
npm run normal:run -- --dry-run --limit 2
```

## Scope

This is a user-facing evaluation track. It complements, rather than replaces,
the controlled A/B/F benchmark. Do not compare its scores directly with
`pilot-v1` contract success.
