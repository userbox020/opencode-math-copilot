import fs from "node:fs";

try {
  const { pattern, lines } = JSON.parse(fs.readFileSync(0, "utf8"));
  const regex = new RegExp(pattern, "i");
  const matches = lines.map(line => regex.test(line));
  process.stdout.write(JSON.stringify({ matches }));
} catch {
  process.exitCode = 1;
}
