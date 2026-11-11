import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'C:/_Work/opencode-math-copilot';
const ROOT = path.join(REPO, 'bench/v3/normal-use');
const OUT = 'C:/Users/MiPC/AppData/Local/Temp/opencode';
const sources = [
  ['v1', 'DeepSeek full vs off', path.join(OUT, 'normal-use-v1/report.json')],
  ['v2', 'DeepSeek full / minimal / off', path.join(OUT, 'normal-use-v2-minimal/report.json')],
  ['v3', 'GLM full / minimal / off', path.join(OUT, 'normal-use-v3-glm/report.json')],
  ['v4', 'DeepSeek hard PDF/Lean tasks', path.join(OUT, 'normal-use-v4-hard/report.json')],
];
const studies = [];
for (const [id, label, file] of sources) {
  if (!existsSync(file)) continue;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  studies.push({ id, label, model: report.model, generated_at: report.generated_at, conditions: report.conditions, tasks: report.tasks });
}
const data = {
  schema: 'normal-use-page/v1',
  generated_at: new Date().toISOString(),
  studies,
  caveats: [
    'Normal-use CLI runs use `opencode run --standalone`; Desktop/TUI behavior may differ.',
    'Six tasks, one repeat per condition, one or two models. This is exploratory.',
    'Human scores are reference-based and not blind.',
    'Plugin-off disables the math toolkit but keeps built-in tools and other plugins.',
    'Lean correctness was assessed by inspection, not always by fresh compilation.',
    'Do not compare these scores directly with the controlled A/B/F benchmark.',
  ],
};
writeFileSync(path.join(ROOT, 'normal-use-data.json'), JSON.stringify(data, null, 2) + '\n');
writeFileSync(path.join(ROOT, 'normal-use-data.js'), `window.NORMAL_USE_DATA = ${JSON.stringify(data)};\n`);
console.log(JSON.stringify({ generated_at: data.generated_at, studies: studies.map(study => ({ id: study.id, model: study.model, conditions: Object.fromEntries(Object.entries(study.conditions).map(([condition, metrics]) => [condition, `${metrics.human_correct}/${metrics.human_scored}`])) })) }, null, 2));
console.log(`data ${path.join(ROOT, 'normal-use-data.js')}`);
