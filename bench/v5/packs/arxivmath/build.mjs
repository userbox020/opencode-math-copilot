import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateTasks } from '../../external/schema.mjs';

export const DEFAULT_INPUT = 'C:/Users/MiPC/AppData/Local/Temp/opencode/math-benchmarks-20261117/matharena/arxivmath.rows.json';
export const INPUT_SHA256 = 'c2e38ed7e0be498d9d48df4f0a4fd17360322251eb5bd95a3085a23bdff2b22e';
export const INSTRUCTION = 'Solve the problem. Put the final answer on its own last line in the form: FINAL: <answer>.';
export const GRADING_NOTE = 'normalized exact/symbolic; unparseable if not confidently comparable';
export const REVIEW_NOTE = 'Normalized answer occurs in the problem text; retained for review, not treated as explicit answer disclosure.';
export const BASELINES = {
  schema: 'math-bench-baselines/v1',
  benchmark: 'arxivmath',
  model: 'opencode-go/deepseek-v4.1-flash',
  external: [],
  note: 'No published score for this exact model/version was found; use the paired plugin-off arm. Source papers are not supplied; this is a declared closed-book run, not a retrieval-assisted run.',
};
export const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// Text normalization only, not a mathematical equivalence checker.
export function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/\\(?:left|right)\b/g, '')
    .replace(/\\[()[\]]|\$|\\[,;! ]|\s+/g, '');
}

function containsFullAnswer(text, answer) {
  const haystack = normalize(text), needle = normalize(answer);
  if (!needle) return false;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = haystack[index - 1] ?? '', after = haystack[index + needle.length] ?? '';
    if (!(/[a-z0-9]/.test(needle[0]) && /[a-z0-9]/.test(before)) &&
        !(/[a-z0-9]/.test(needle.at(-1)) && /[a-z0-9]/.test(after))) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

export function explicitDisclosure(problem, answer) {
  if (/^\s*(?:#{1,6}\s*)?(?:\*\*)?FINAL\s*:/im.test(problem)) return true;
  for (const match of problem.matchAll(/\bthe\s+answer\s+is\s*:?\s*/gi)) {
    const tail = problem.slice(match.index + match[0].length);
    if (normalize(tail).startsWith(normalize(answer)) && containsFullAnswer(tail, answer)) return true;
  }
  const heading = /(?:^\s*(?:#{1,6}\s*)?(?:\*\*)?solution(?:\*\*)?\s*(?::|$)|\\(?:sub)*section\*?\{solution\})/im.exec(problem);
  const tail = heading ? normalize(problem.slice(heading.index + heading[0].length)) : '';
  return Boolean(heading && normalize(answer) && tail.includes(normalize(answer)));
}

export function gradingType(answer) {
  return /\\frac|\\sqrt|\^|,/.test(answer) || (answer.match(/=/g)?.length ?? 0) > 1
    ? 'symbolic' : 'exact';
}

export function buildTasks(rows) {
  const tasks = rows.map(row => {
    const competition = /^arxiv\/(january|february|march|december)$/.exec(row.competition);
    if (!competition || !Number.isSafeInteger(row.problem_idx) || row.problem_idx < 1 ||
        typeof row.problem !== 'string' || !row.problem.trim() || row.answer == null) {
      throw new Error('Invalid source row');
    }
    const answer = String(row.answer).trim();
    if (!answer || explicitDisclosure(row.problem, answer)) {
      throw new Error(`Empty answer or explicit disclosure: ${row.competition}/${row.problem_idx}`);
    }
    const types = Array.isArray(row.problem_type)
      ? row.problem_type.filter(value => typeof value === 'string' && value.trim()) : [];
    const metadata = {
      source: String(row.source),
      license: 'unspecified in supplied snapshot',
      contest: row.competition,
      problem_number: row.problem_idx,
      problem_type: types.length ? types : ['unspecified'],
      arxiv_id: String(row.source),
      retrieval_assisted: false,
    };
    const normalized = normalize(answer);
    if ((normalized.length >= 8 && normalize(row.problem).includes(normalized)) ||
        (answer.length >= 8 && row.problem.toLowerCase().includes(answer.toLowerCase()))) {
      metadata.answer_in_prompt = true;
      metadata.review_note = REVIEW_NOTE;
    }
    return {
      schema: 'math-bench-task/v1',
      benchmark: 'arxivmath',
      id: `arxivmath-${competition[1]}-${String(row.problem_idx).padStart(3, '0')}`,
      prompt: `${row.problem}\n\n${INSTRUCTION}`,
      answer,
      grading: { type: gradingType(answer), answer, note: GRADING_NOTE },
      metadata,
    };
  });
  return validateTasks(tasks);
}

export function selectPilot(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task.metadata.contest;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const ordered = [...groups].sort(([a, aa], [b, bb]) =>
    bb.length - aa.length || (a < b ? -1 : a > b ? 1 : 0));
  const pilot = [];
  for (const [, group] of ordered) {
    const sorted = [...group].sort((a, b) => a.metadata.problem_number - b.metadata.problem_number);
    const count = Math.min(5, sorted.length, 20 - pilot.length);
    for (let i = 0; i < count; i++) {
      pilot.push(sorted[count === 1 ? 0 : Math.round(i * (sorted.length - 1) / (count - 1))]);
    }
    if (pilot.length === 20) break;
  }
  if (pilot.length !== 20) throw new Error('Expected a 20-task stratified pilot');
  return pilot;
}

export function buildPack(bytes) {
  const inputSha256 = sha256(bytes);
  if (inputSha256 !== INPUT_SHA256) throw new Error('Input SHA-256 differs from the pinned snapshot');
  const input = JSON.parse(bytes.toString('utf8'));
  if (input.schema !== 'matharena-arxivmath-rows/v1' || input.total !== 103 || input.rows.length !== 103 ||
      input.rows.some(entry => entry.truncated_cells?.length)) throw new Error('Invalid or truncated snapshot');
  const tasks = buildTasks(input.rows.map(entry => entry.row));
  const pilot = selectPilot(tasks);
  const review = {
    schema: 'math-bench-pack-review/v1',
    benchmark: 'arxivmath',
    input_file: 'arxivmath.rows.json',
    input_sha256: inputSha256,
    track: 'declared-closed-book',
    retrieval_assisted: false,
    task_count: tasks.length,
    pilot_count: pilot.length,
    grading_distribution: tasks.reduce((counts, task) => {
      counts[task.grading.type]++;
      return counts;
    }, { exact: 0, symbolic: 0 }),
    flagged: tasks.filter(task => task.metadata.answer_in_prompt).map(task => ({
      id: task.id,
      review_note: task.metadata.review_note,
    })),
    tasks_sha256: sha256(serialize(tasks)),
    pilot_sha256: sha256(serialize(pilot)),
  };
  return { 'tasks.json': tasks, 'pilot.json': pilot, 'baselines.json': BASELINES, 'review.json': review };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node build.mjs [snapshot.json]');
  const pack = buildPack(fs.readFileSync(process.argv[2] ?? DEFAULT_INPUT));
  const directory = path.dirname(fileURLToPath(import.meta.url));
  for (const [name, value] of Object.entries(pack)) fs.writeFileSync(path.join(directory, name), serialize(value));
  console.log(serialize(pack['review.json']));
}
