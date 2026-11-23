// Regenerates src/data/cli-usage.generated.txt and
// src/data/cli-groups.generated.json from the real CLI. Run after any
// change to src/cli.mjs's usage text, then commit the output.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, usageLines, classify, groups, servedRoutes } from "./cli-reference.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../src/data");
mkdirSync(dataDir, { recursive: true });

const text = runCli();
writeFileSync(path.join(dataDir, "cli-usage.generated.txt"), text);

const lines = usageLines(text);
const { byGroup, unmatched, multi } = classify(lines);
if (unmatched.length || multi.length) {
  console.error("cli-reference grouping is incomplete:");
  for (const l of unmatched) console.error("  unmatched:", l);
  for (const m of multi) console.error("  ambiguous:", m.line, "->", m.groups);
  process.exit(1);
}

const out = groups.map((g) => ({
  id: g.id,
  number: g.number,
  title: g.title,
  summary: g.summary,
  lines: byGroup.get(g.id),
}));
out.push({ ...servedRoutes });

writeFileSync(
  path.join(dataDir, "cli-groups.generated.json"),
  JSON.stringify(out, null, 2) + "\n",
);

console.log(`wrote ${lines.length} usage lines across ${groups.length} groups + routes`);
