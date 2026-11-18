// Strip only whole-payload wrappers. Never rewrite tuples, fractions, sets,
// expressions, or string contents into a different mathematical construction.
function unwrap(source) {
  let text = source.trim(), previous;
  do {
    previous = text;
    for (const [open, close] of [
      ['$$', '$$'], ['$', '$'], ['\\[', '\\]'], ['\\(', '\\)'],
      ['\\boxed{', '}'], ['\\fbox{', '}'],
    ]) {
      if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
        text = text.slice(open.length, -close.length).trim();
        break;
      }
    }
  } while (text !== previous);
  return text;
}

const failure = reason => ({ status: 'unparseable', value: null, reason });

function parsePayload(source) {
  try {
    const value = JSON.parse(unwrap(source), (_key, item) => {
      // JSON.parse can silently round large integers. Refuse rather than
      // validate a mathematically different answer.
      if (typeof item === 'number' &&
          (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
        throw new Error('Number cannot be represented safely');
      }
      return item;
    });
    if (value === null || typeof value === 'boolean') return failure('Expected a JSON construction, not null/boolean');
    return { status: 'parsed', value, reason: null };
  } catch {
    return failure('Payload is not supported, lossless JSON');
  }
}

export function parseFinalAnswer(text, { answerFormat } = {}) {
  // Format metadata may contain worked examples. It is never an answer source
  // and does not authorize coercing a non-JSON structure.
  void answerFormat;
  if (typeof text !== 'string' || !text.trim()) return failure('No answer text');
  const lines = text.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const final = /^\s*FINAL:\s*(.*)$/.exec(lines[i]);
    if (final) {
      const payload = final[1] || lines.slice(i + 1).join('\n');
      const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(payload);
      // An explicit malformed FINAL takes precedence over earlier examples.
      return parsePayload(fenced ? fenced[1] : payload);
    }
  }
  const fences = [...text.matchAll(/^[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gim)];
  if (fences.length) return parsePayload(fences.at(-1)[1]);
  // Only parse a complete trailing JSON array/object. Do not salvage an inner
  // list from a malformed outer construction.
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[\[{]/.test(lines[i])) return parsePayload(lines.slice(i).join('\n'));
  }
  return failure('No FINAL JSON, JSON fence, or trailing JSON array/object');
}
