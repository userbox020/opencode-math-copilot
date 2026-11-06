# Math plugin benchmark

This small, **indicative, not scientific** benchmark compares corpus retrieval and
one elementary computation with and without the project-local math toolkit.
It measures keyword hits and elapsed wall time, not proof correctness or actual
tool use. The retrieval answers are based on corpus family 003 and its Lean docs.

From the repository root (Node.js and an authenticated OpenCode CLI required):

```sh
node bench/run.mjs --dry-run
node bench/run.mjs --json --md
node bench/run.mjs --model opencode-go/deepseek-v4.1-flash --repeats 2 --timeout 180
node bench/run.mjs --standalone --problems bench/problems.json
```

The default model is `opencode-go/deepseek-v4.1-flash`, with one repeat and a
180-second timeout per invocation. Nested runs omit `--standalone` by default;
add it for isolation. Each run uses `--agent build --format default`.
Custom problem paths are relative to the calling directory; the default resolves
relative to the repository. `--dry-run` prints commands without executing OpenCode
or writing files. Real runs may incur model charges.

The **with plugin** working directory is the repository root. The **without
plugin** project is `os.tmpdir()/opencode-math-bench-no-plugin`, with this config
written to `.opencode/opencode.json` on each real benchmark:

```json
{ "$schema": "https://opencode.ai/config.json", "plugins": [] }
```

The without project still has global plugins, but not this project's
math-toolkit. Do not globally install math-toolkit for this comparison. Global
configuration, inherited environment, and permissions are not reset. The temp
project is reused, not cleaned; avoid putting other files or plugins there.

On Windows the harness locates `opencode.cmd` on PATH and resolves its native
executable or standard npm JavaScript entry point, because Node cannot execute
a `.cmd` file directly with `shell:false`. Unsupported custom shims are recorded
as run errors. Other systems execute `opencode` directly. Prompts are passed as
single arguments, never interpolated into a shell. Timeout termination applies
to the directly spawned process, not a guaranteed cleanup of all descendants.

## Scoring and output

Each JSON problem has `id`, `prompt`, and `keywords`, plus optional `anyKeywords`.
All `keywords` must occur case-insensitively in combined stdout and stderr. If
`anyKeywords` is present, at least one of those must also occur (use an empty
`keywords` array for an any-only check). A process error or nonzero exit always
fails; the harness records the error and continues with remaining runs.

Example output shape (illustrative, not measured):

```text
problem        condition       repeat seconds exit score
quasi-riemann  with plugin     1      12.34   0    PASS
quasi-riemann  without plugin  1       8.76   0    FAIL
...
with plugin: 3/3 passed, 0 errors, 10.00s mean
without plugin: 1/3 passed, 0 errors, 8.00s mean
```

`--json` overwrites `bench/results/latest.json` with prompts, configuration,
stdout, stderr, combined output, durations, exit codes, errors, and boolean
scores. `--md` overwrites `bench/results/latest.md` with the table and summary.
Neither report is written by default. Review captured output before sharing it.

Keyword checks can give false positives (including “not formalized”, echoed
prompts, tool traces, and incidental digits) and false negatives from alternate
wording. They do not validate citations or prove a tool was called. The with
condition also has corpus files, repository instructions, and other local
configuration unavailable in the without project, so this does not isolate the
plugin alone. Small sample size, fixed condition order, caching, network latency,
and model variability further limit comparisons. Lean status here is catalog
metadata, not a new Lean verification run.
