import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const conditions = ['with plugin', 'without plugin'];
const caveat = 'Keyword scoring, small samples, global plugin leakage; not a controlled latency benchmark.';

function validate(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.results) || !data.results.length) {
    throw new Error('Expected an object with a nonempty results array from bench/run.mjs.');
  }
  for (const [index, run] of data.results.entries()) {
    const fail = (message) => { throw new Error(`results[${index}]: ${message}`); };
    if (!run || typeof run !== 'object' || Array.isArray(run)) fail('expected an object');
    for (const field of ['model', 'problem']) {
      if (typeof run[field] !== 'string' || !run[field].trim()) fail(`${field} must be a nonempty string`);
    }
    if (!conditions.includes(run.condition)) fail('condition must be "with plugin" or "without plugin"');
    if (!Number.isInteger(run.repeat) || run.repeat < 1) fail('repeat must be a positive integer');
    if (typeof run.score !== 'boolean') fail('score must be boolean');
    if (!Number.isFinite(run.durationMs) || run.durationMs < 0) fail('durationMs must be a nonnegative finite number');
    if (!Number.isInteger(run.toolCalls) || run.toolCalls < 0) fail('toolCalls must be a nonnegative integer');
    if (run.exitCode !== null && !Number.isInteger(run.exitCode)) fail('exitCode must be an integer or null');
    if (run.error !== null && typeof run.error !== 'string') fail('error must be a string or null');
    if (run.score && (run.error || run.exitCode !== 0)) fail('a passing score cannot have a process error');
  }
  for (const condition of conditions) {
    if (!data.results.some((run) => run.condition === condition)) {
      throw new Error(`Missing results for "${condition}".`);
    }
  }
  return data.results;
}

function wilson95(passed, total) {
  const z = 1.959963984540054;
  const p = passed / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function summarize(runs) {
  const total = runs.length;
  const passed = runs.filter((run) => run.score).length;
  const durations = runs.map((run) => run.durationMs / 1000).sort((a, b) => a - b);
  const middle = Math.floor(total / 2);
  return {
    passed,
    total,
    passRate: passed / total,
    wilson95: wilson95(passed, total),
    errors: runs.filter((run) => run.error || run.exitCode !== 0).length,
    meanDurationSeconds: durations.reduce((sum, value) => sum + value, 0) / total,
    medianDurationSeconds: total % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2,
    p95DurationSeconds: durations[Math.ceil(0.95 * total) - 1],
    meanToolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0) / total,
  };
}

function analyze(runs) {
  const models = [...new Set(runs.map((run) => run.model))];
  const problems = [...new Set(runs.map((run) => run.problem))];
  const byModelCondition = [];
  const byProblemModelCondition = [];
  for (const model of models) {
    for (const condition of conditions) {
      const group = runs.filter((run) => run.model === model && run.condition === condition);
      if (group.length) byModelCondition.push({ model, condition, ...summarize(group) });
    }
  }
  for (const problem of problems) {
    for (const model of models) {
      for (const condition of conditions) {
        const group = runs.filter((run) => run.problem === problem && run.model === model && run.condition === condition);
        byProblemModelCondition.push({ problem, model, condition, passed: group.filter((run) => run.score).length, total: group.length });
      }
    }
  }
  const totals = conditions.map((condition) => ({ condition, ...summarize(runs.filter((run) => run.condition === condition)) }));
  return {
    caveat,
    methods: {
      passRate: 'Fraction from 0 to 1; Wilson 95% intervals use an independent Bernoulli approximation, not cluster adjustment.',
      durations: 'Seconds; all runs, including failures/errors. Median averages the middle pair; p95 uses nearest rank.',
      errors: 'Nonempty error or exitCode not equal to zero.',
      difference: 'Pooled with-plugin minus without-plugin pass rates in percentage points; descriptive, not a significance test.',
    },
    byModelCondition,
    totals,
    differencePercentagePoints: (totals[0].passRate - totals[1].passRate) * 100,
    byProblemModelCondition,
  };
}

const percent = (value) => `${(100 * value).toFixed(1)}%`;
const interval = (value) => `${percent(value.lower)}–${percent(value.upper)}`;
const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

function markdown(report) {
  const lines = [
    '# Benchmark analysis',
    '',
    `Caveat: ${report.caveat}`,
    '',
    '| Model | Condition | Passed | Rate | Wilson 95% CI | Errors | Mean s | Median s | p95 s | Mean tool calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of report.byModelCondition) {
    lines.push(`| ${cell(row.model)} | ${row.condition} | ${row.passed}/${row.total} | ${percent(row.passRate)} | ${interval(row.wilson95)} | ${row.errors} | ${row.meanDurationSeconds.toFixed(2)} | ${row.medianDurationSeconds.toFixed(2)} | ${row.p95DurationSeconds.toFixed(2)} | ${row.meanToolCalls.toFixed(2)} |`);
  }
  lines.push('', '## Pooled totals', '', '| Condition | Passed | Rate | Wilson 95% CI | Errors |', '| --- | --- | --- | --- | --- |');
  for (const row of report.totals) {
    lines.push(`| ${row.condition} | ${row.passed}/${row.total} | ${percent(row.passRate)} | ${interval(row.wilson95)} | ${row.errors} |`);
  }
  const difference = report.differencePercentagePoints;
  lines.push('', `With minus without plugin: **${difference >= 0 ? '+' : ''}${difference.toFixed(2)} percentage points** (descriptive).`, '',
    'Durations include failures/errors; p95 is nearest rank. Wilson intervals assume independent trials; repeated problems/models are not independent evidence. No significance test or interval for the difference is implied.',
    '', '## Per-problem passes', '', '| Problem | Model | With plugin | Without plugin |', '| --- | --- | --- | --- |');
  for (let i = 0; i < report.byProblemModelCondition.length; i += 2) {
    const withPlugin = report.byProblemModelCondition[i];
    const withoutPlugin = report.byProblemModelCondition[i + 1];
    lines.push(`| ${cell(withPlugin.problem)} | ${cell(withPlugin.model)} | ${withPlugin.passed}/${withPlugin.total} | ${withoutPlugin.passed}/${withoutPlugin.total} |`);
  }
  return lines.join('\n');
}

function main() {
  let input;
  let format;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--json' || arg === '--md') {
      if (format && format !== arg) throw new Error('Choose either --json or --md, not both.');
      format = arg;
    } else if (arg.startsWith('-') || input !== undefined) {
      throw new Error('Usage: node bench/analyze.mjs [json path] [--json | --md]');
    } else {
      input = arg;
    }
  }
  input ??= fileURLToPath(new URL('./results/latest.json', import.meta.url));
  let data;
  try {
    data = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read benchmark JSON "${input}": ${error.message}`);
  }
  const report = analyze(validate(data));
  console.log(format === '--json' ? JSON.stringify(report, null, 2) : markdown(report));
}

try {
  main();
} catch (error) {
  console.error(`Benchmark analysis error: ${error.message}`);
  process.exitCode = 1;
}
