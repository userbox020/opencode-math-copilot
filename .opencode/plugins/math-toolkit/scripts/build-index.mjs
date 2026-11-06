#!/usr/bin/env node
/**
 * Build the Math Toolkit corpus index.
 *
 * Sources of truth:
 *   math/CONTENTS.md            manuscript families, abstracts, PDF links, Lean links
 *   math/preprints/<dir>/README.md  citation metadata
 *   math/lean/formalization.yaml formalized paper catalogue
 *   math/lean/lakefile.lean     Lake library targets
 *   math/preprints/*/build/*    LaTeX section outline
 *
 * Usage:
 *   node .opencode/plugins/math-toolkit/scripts/build-index.mjs
 *   node .opencode/plugins/math-toolkit/scripts/build-index.mjs --math-root C:\path\to\math
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const defaultWorkspace = path.resolve(pluginRoot, "..", "..", "..");
const dataFile = path.join(pluginRoot, "data", "math-index.json");

function parseArgs(argv) {
  const args = { mathRoot: path.join(defaultWorkspace, "math") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--math-root" && argv[i + 1]) args.mathRoot = path.resolve(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) args.out = path.resolve(argv[++i]);
  }
  return args;
}

function decodeEntities(value) {
  return value
    .replace(/&emsp;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(parseInt(number, 10)));
}

/** Strip real HTML tags only; preserve comparison operators such as `1 <= q < 4`. */
function stripHtml(value) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[a-zA-Z/!][^>]*>/g, "");
}

function clean(value) {
  return decodeEntities(stripHtml(value))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownLinkText(value) {
  const match = value.match(/^\s*\[([^\]]+)\]\([^)]*\)\s*$/);
  return match ? match[1].trim() : value.trim();
}

function balancedLink(value) {
  const match = value.match(/^\s*\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)\s*([\s\S]*)$/);
  if (!match) return null;
  return { title: match[1].trim(), target: match[2].trim(), rest: match[3].trim() };
}

function extractLeanDocs(value) {
  return [...value.matchAll(/\[Lean\]\(([^)]+)\)/g)].map((match) => match[1].trim());
}

function unique(values) {
  return [...new Set(values)];
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseContents(mathRoot) {
  const file = path.join(mathRoot, "CONTENTS.md");
  const text = readText(file);
  if (!text) throw new Error(`Missing ${file}`);

  const families = [];
  const manuscripts = [];
  let current = null;

  const tdRe = /<td>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = tdRe.exec(text))) {
    const body = clean(match[1]);
    if (!body) continue;

    const familyMatch = body.match(/^\*\*(\d{3})\.\s*([\s\S]*?)\*\*\s*([\s\S]*)$/);
    if (familyMatch) {
      current = {
        number: familyMatch[1],
        title: familyMatch[2].trim(),
        description: familyMatch[3].trim(),
        leanDocs: unique(extractLeanDocs(body)),
      };
      families.push(current);
      continue;
    }

    const link = balancedLink(body);
    if (link && current && link.target.includes("preprints/")) {
      manuscripts.push({
        family: current.number,
        familyTitle: current.title,
        familyDescription: current.description,
        title: link.title,
        pdf: link.target.replace(/\\/g, "/"),
        abstract: link.rest,
        leanDocs: unique([...current.leanDocs, ...extractLeanDocs(body)]),
      });
    }
  }

  return { families, manuscripts };
}

function parseReadme(mathRoot, dir) {
  const file = path.join(mathRoot, dir, "README.md");
  const text = readText(file);
  if (!text) return {};
  const heading = text.match(/^#\s+(.+)$/m);
  const author = text.match(/\*\*Author:\*\*\s*(.+)$/m);
  const date = text.match(/\*\*Date:\*\*\s*(.+)$/m);
  return {
    readme: `${dir}/README.md`,
    title: heading ? markdownLinkText(heading[1]) : undefined,
    author: author ? author[1].trim() : undefined,
    date: date ? date[1].trim() : undefined,
  };
}

function parseFormalization(mathRoot) {
  const file = path.join(mathRoot, "lean", "formalization.yaml");
  const text = readText(file);
  const result = {
    formalizedByPdf: new Map(),
    formalizedTitles: new Map(),
    sourceCount: 0,
  };
  if (!text) return result;

  const beforeRelated = text.split(/^related_formalizations:/m)[0];
  const lines = beforeRelated.split(/\r?\n/);
  let pendingTitle = null;
  for (const line of lines) {
    const titleMatch = line.match(/^\s*-\s+title:\s*"?(.*?)"?\s*$/);
    if (titleMatch) {
      pendingTitle = titleMatch[1].trim();
      continue;
    }
    const idMatch = line.match(/^\s+id:\s*(.+?)\s*$/);
    if (idMatch && pendingTitle) {
      let id = idMatch[1].trim().replace(/^["']|["']$/g, "");
      id = id.replace(/\\/g, "/");
      if (id.startsWith("../")) id = id.slice(3);
      if (id.startsWith("./")) id = id.slice(2);
      if (id.startsWith("preprints/")) {
        result.formalizedByPdf.set(id, pendingTitle);
        result.formalizedTitles.set(pendingTitle, id);
        result.sourceCount++;
      }
      pendingTitle = null;
    }
  }
  return result;
}

function parseLeanMeta(mathRoot) {
  const toolchainFile = path.join(mathRoot, "lean", "lean-toolchain");
  const toolchain = (readText(toolchainFile) || "").trim() || null;
  const lakefile = readText(path.join(mathRoot, "lean", "lakefile.lean")) || "";
  const libraries = unique([
    ...[...lakefile.matchAll(/^lean_lib\s+([A-Za-z0-9_.]+)/gm)].map((match) => match[1]),
    ...[...lakefile.matchAll(/^@\[default_target\]\s+lean_lib\s+([A-Za-z0-9_.]+)/gm)].map((match) => match[1]),
  ]).sort();

  const docs = [];
  const docsDir = path.join(mathRoot, "lean", "docs");
  try {
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      docs.push({ family: entry.name.replace(/\.md$/, ""), path: `lean/docs/${entry.name}` });
    }
  } catch {
    // Optional directory.
  }
  docs.sort((a, b) => a.family.localeCompare(b.family));
  return { toolchain, libraries, docs };
}

function walkTexFiles(absDir, relDir, depth = 0) {
  if (depth > 6) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (["tools", "figures", "vendor", "node_modules", "images"].includes(entry.name)) continue;
      files.push(...walkTexFiles(abs, rel, depth + 1));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".tex")) continue;
    try {
      if (fs.statSync(abs).size > 1024 * 1024) continue;
    } catch {
      continue;
    }
    files.push(rel);
  }
  return files;
}

function bracedValue(line, openIndex) {
  let depth = 0;
  let value = "";
  for (let i = openIndex; i < line.length; i++) {
    const char = line[i];
    if (char === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return value;
    }
    if (depth > 0) value += char;
  }
  return value;
}

function parseSections(mathRoot, dir) {
  const buildDir = path.join(mathRoot, dir, "build");
  const texFiles = walkTexFiles(buildDir, "").sort();
  if (texFiles.length === 0) return { file: null, sections: [] };

  const preferred = ["main.tex", "paper.tex", "manuscript.tex", "article.tex", "final.tex"];
  const main = preferred.find((name) => texFiles.includes(name)) || texFiles[0];
  const sections = [];
  for (const texFile of texFiles) {
    const relative = `${dir}/build/${texFile}`;
    const text = readText(path.join(mathRoot, relative)) || "";
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^\s*\\(section|subsection|subsubsection)\*?\s*\{/);
      if (!match) continue;
      const openIndex = line.indexOf("{", match.index + match[0].length - 1);
      const rawTitle = clean(bracedValue(line, openIndex))
        .replace(/\\texorpdfstring\{([^{}]*)\}\{([^{}]*)\}/g, "$1")
        .replace(/\\(?:emph|textbf|textit|texttt|mathrm|mathbf|mathit)\{([^{}]*)\}/g, "$1")
        .replace(/\\[a-zA-Z]+\*?/g, "")
        .replace(/[{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!rawTitle) continue;
      sections.push({
        title: rawTitle,
        level: match[1],
        file: relative,
        line: i + 1,
      });
    }
  }
  return { file: `${dir}/build/${main}`, sections };
}

function build(mathRoot) {
  const contents = parseContents(mathRoot);
  const formalization = parseFormalization(mathRoot);
  const lean = parseLeanMeta(mathRoot);

  const manuscripts = contents.manuscripts.map((manuscript) => {
    const dir = path.posix.dirname(manuscript.pdf);
    const readme = parseReadme(mathRoot, dir);
    const sectionInfo = parseSections(mathRoot, dir);
    const formalizedTitle = formalization.formalizedByPdf.get(manuscript.pdf) || null;
    const isFormalized = Boolean(formalizedTitle);
    return {
      id: manuscript.pdf,
      title: readme.title || manuscript.title,
      family: manuscript.family,
      familyTitle: manuscript.familyTitle,
      familyDescription: manuscript.familyDescription,
      abstract: manuscript.abstract,
      pdf: manuscript.pdf,
      dir,
      readme: readme.readme || null,
      author: readme.author || "OpenAI",
      date: readme.date || null,
      leanDocs: unique(manuscript.leanDocs),
      formalized: isFormalized,
      leanTitle: formalizedTitle,
      texFile: sectionInfo.file,
      sections: sectionInfo.sections,
      searchText: [
        readme.title || manuscript.title,
        manuscript.familyTitle,
        manuscript.abstract,
        ...sectionInfo.sections.map((section) => section.title),
        formalizedTitle || "",
      ].join("\n"),
    };
  });

  const byPdf = new Set(manuscripts.map((manuscript) => manuscript.pdf));
  const formalizedPdfs = [...formalization.formalizedByPdf.keys()].filter((pdf) => byPdf.has(pdf));
  const missingFormalized = [...formalization.formalizedByPdf.keys()].filter((pdf) => !byPdf.has(pdf));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mathRoot: "math",
    counts: {
      families: contents.families.length,
      manuscripts: manuscripts.length,
      formalized: formalizedPdfs.length,
      sections: manuscripts.reduce((total, manuscript) => total + manuscript.sections.length, 0),
      leanDocs: lean.docs.length,
    },
    families: contents.families,
    manuscripts,
    lean: {
      toolchain: lean.toolchain,
      libraries: lean.libraries,
      docs: lean.docs,
      formalizedPdfs,
      missingFormalized,
    },
  };
}

const args = parseArgs(process.argv.slice(2));
const outputFile = args.out || dataFile;
const index = build(args.mathRoot);

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");

const bytes = fs.statSync(outputFile).size;
console.log(`Wrote ${outputFile}`);
console.log(`Families: ${index.counts.families}`);
console.log(`Manuscripts: ${index.counts.manuscripts}`);
console.log(`Formalized: ${index.counts.formalized}`);
console.log(`Sections: ${index.counts.sections}`);
console.log(`Lean docs: ${index.counts.leanDocs}`);
console.log(`Size: ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
