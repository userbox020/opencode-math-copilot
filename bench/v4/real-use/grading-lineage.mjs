import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { parseArgs, sha256 } from './lib.mjs';
import { gradingSummary, main as reportMain } from './report.mjs';

export function main(argv) {
  const args = parseArgs(argv, ['--out', '--label', '--note', '--reviews']);
  for (const key of ['--out', '--label', '--reviews']) {
    if (!args[key]?.trim()) throw new Error(`${key} required`);
  }
  const out = path.resolve(args['--out']), reviewsPath = path.resolve(args['--reviews']);
  const lineagePath = path.join(out, 'grading-lineage.json');
  let prior = null;
  try { prior = readFileSync(lineagePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = prior ? JSON.parse(prior) : [];
  if (!Array.isArray(entries)) throw new Error('grading lineage must be an array');
  if (entries.some(entry => entry.label === args['--label'])) throw new Error('duplicate grading lineage label');

  const blindPath = path.join(out, 'evaluation/blind.json'), reportPath = path.join(out, 'evaluation/report.json');
  const blind = readFileSync(blindPath), reviews = readFileSync(reviewsPath), savedReport = readFileSync(reportPath);
  const result = reportMain(['--out', out, '--reviews', reviewsPath]);
  if (!savedReport.equals(Buffer.from(JSON.stringify(result, null, 2) + '\n'))) {
    throw new Error('report.json does not match current blind.json and reviews');
  }
  // Hash exactly the inputs checked above; fail rather than record a moving input.
  for (const [file, bytes] of [[blindPath, blind], [reviewsPath, reviews], [reportPath, savedReport]]) {
    if (!readFileSync(file).equals(bytes)) throw new Error('grading input changed during recording');
  }
  const checkerStatuses = new Map();
  for (const record of JSON.parse(blind)) {
    const status = record.checker?.status ?? 'not_supplied';
    checkerStatuses.set(status, (checkerStatuses.get(status) ?? 0) + 1);
  }
  const entry = {
    schema: 'real-use-grading-lineage/v1', label: args['--label'], note: args['--note'] ?? null,
    recorded_at: new Date().toISOString(), blind_sha256: sha256(blind),
    reviews_path: path.relative(out, reviewsPath).split(path.sep).join('/'),
    reviews_sha256: sha256(reviews), report_sha256: sha256(savedReport),
    ...gradingSummary(result), checker_statuses: Object.fromEntries(checkerStatuses),
  };
  // Retain every prior entry byte, including its formatting. Only the closing
  // array delimiter is replaced; existing entries are never reserialized.
  const end = prior ? prior.lastIndexOf(0x5d) : 0;
  const suffix = Buffer.concat([
    Buffer.from(`${prior ? entries.length ? ',' : '' : '['}\n${JSON.stringify(entry, null, 2)}\n]`),
    prior ? prior.subarray(end + 1) : Buffer.from('\n'),
  ]);
  const fd = openSync(lineagePath, prior ? 'r+' : 'wx');
  try {
    if (prior && !readFileSync(fd).equals(prior)) throw new Error('grading lineage changed during recording');
    let written = 0;
    while (written < suffix.length) written += writeSync(fd, suffix, written, suffix.length - written, end + written);
  } finally { closeSync(fd); }
  return entry;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
