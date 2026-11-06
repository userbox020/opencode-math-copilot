export function clip(value, max = 60000) {
  const text = String(value ?? "");
  const note = "\n… [truncated]";
  return text.length > max ? text.slice(0, Math.max(0, max - note.length)) + note : text;
}

export function fence(text, language = "text") {
  const runs = String(text).match(/`+/g) || [];
  const delimiter = "`".repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${delimiter}${language}\n${text}\n${delimiter}`;
}

export function leanLabel(manuscript) {
  const docs = (manuscript.leanDocs || []).join(", ");
  return `${manuscript.formalized ? "yes" : "no"}${docs ? `; family Lean docs: ${docs}` : ""}`;
}
