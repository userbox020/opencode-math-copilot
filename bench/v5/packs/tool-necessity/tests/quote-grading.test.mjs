import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeEpisode } from '../../../external/grade.mjs';

const quote = 'The elementary tail estimate below supplies a common integrable bound for\r\nthe approximation, including its entropy integrand.';
const task = {
  schema: 'math-bench-task/v1', benchmark: 'tool-necessity', id: 'tool-text-01',
  prompt: 'Retrieve the sentence.', answer: quote,
  grading: { type: 'quote', answer: quote, note: 'verbatim quote' },
  metadata: {},
};
const episode = text => ({ status: 'completed', exit_code: 0, text });

test('quote grader: verbatim quote across whitespace changes is correct', () => {
  const result = gradeEpisode(episode(`Quote:\n${quote}\n\nPath: preprints/x.tex\nLine: 14`), task);
  assert.equal(result.status, 'correct');
  assert.equal(result.reason, 'Whitespace-normalized quote present');
});

test('quote grader: line breaks and repeated spaces do not change the quote', () => {
  const spaced = quote.replace(/\r\n/g, '\n').replace(/\s+/g, '   ');
  const result = gradeEpisode(episode(`Here it is: ${spaced}`), task);
  assert.equal(result.status, 'correct');
});

test('quote grader: a paraphrase is incorrect, not unparseable', () => {
  const result = gradeEpisode(episode('The tail estimate gives a bound for the approximation and its entropy.'), task);
  assert.equal(result.status, 'incorrect');
});

test('quote grader: a missing quote is incorrect', () => {
  const result = gradeEpisode(episode('I could not retrieve the sentence from the manuscript.'), task);
  assert.equal(result.status, 'incorrect');
});

test('quote grader: locator presence is not required for correctness', () => {
  const result = gradeEpisode(episode(quote), task);
  assert.equal(result.status, 'correct');
});

test('quote grader: empty gold is unparseable', () => {
  const result = gradeEpisode(episode(quote), { ...task, grading: { type: 'quote', answer: '' }, answer: '' });
  assert.equal(result.status, 'unparseable');
});

test('quote grader: empty answer is missing', () => {
  const result = gradeEpisode(episode(''), task);
  assert.equal(result.status, 'missing');
});
