import { clip, leanLabel } from "./format.js";

const FIELDS = [["title", 5], ["familyTitle", 3], ["abstract", 1], ["sections", 2], ["leanTitle", 2]];
export const tokenize = text => String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

export function createSearch(index) {
  const count = index.manuscripts.length;
  const fields = FIELDS.map(([name, weight]) => {
    const frequency = new Map();
    let totalLength = 0;
    const documents = index.manuscripts.map(manuscript => {
      const text = name === "sections" ? manuscript.sections.map(s => s.title).join(" ") : manuscript[name];
      const tokens = tokenize(text);
      const terms = new Map();
      for (const token of tokens) terms.set(token, (terms.get(token) || 0) + 1);
      for (const token of terms.keys()) frequency.set(token, (frequency.get(token) || 0) + 1);
      totalLength += tokens.length;
      return { terms, length: tokens.length };
    });
    return { weight, frequency, documents, average: totalLength / Math.max(1, count) || 1 };
  });

  return ({ query, limit = 8, family, leanOnly = false }) => {
    const families = family ? [family] : [];
    const text = query.replace(/(?:^|\s)(family:([^\s]+)|lean:true|has:lean)(?=\s|$)/gi, (_, filter, number) => {
      if (number) families.push(number);
      else leanOnly = true;
      return " ";
    }).trim().toLowerCase();
    const tokens = [...new Set(tokenize(text))];
    const results = [];
    for (let i = 0; i < count; i++) {
      const manuscript = index.manuscripts[i];
      if (leanOnly && !manuscript.formalized) continue;
      if (!families.every(value => {
        const filter = value.toLowerCase();
        return /^\d+$/.test(filter) ? manuscript.family === filter.padStart(3, "0") : manuscript.familyTitle.toLowerCase().includes(filter);
      })) continue;
      let score = tokens.length ? 0 : 1;
      for (const field of fields) {
        const document = field.documents[i];
        for (const token of tokens) {
          const tf = document.terms.get(token) || 0;
          if (!tf) continue;
          const df = field.frequency.get(token);
          const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
          score += field.weight * idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * document.length / field.average));
        }
      }
      if (text) {
        for (const [field, bonus] of [["title", 12], ["familyTitle", 8], ["abstract", 3]]) {
          if ((manuscript[field] || "").toLowerCase().includes(text)) score += bonus;
        }
      }
      if (score > 0) results.push({ manuscript, score });
    }
    return results.sort((a, b) => b.score - a.score || a.manuscript.id.localeCompare(b.manuscript.id)).slice(0, limit);
  };
}

export function formatSearch(results) {
  if (!results.length) return "No manuscripts found. Try broader terms or remove the family/Lean filters.";
  return results.map(({ manuscript: m }, i) => `### ${i + 1}. ${m.title}\n- Family: ${m.family} — ${m.familyTitle}\n- Formalized: ${leanLabel(m)}\n- PDF: \`${m.pdf}\`\n\n${clip(m.abstract || "No abstract indexed.", 400)}`).join("\n\n");
}
