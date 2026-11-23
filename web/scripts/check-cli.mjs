// Fails if the committed CLI reference data has drifted from the real
// CLI. Run in CI / before build so the docs can't silently go stale.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, usageLines, classify, groups } from "./cli-reference.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../src/data");

let failed = false;
function fail(msg) {
  console.error("FAIL:", msg);
  failed = true;
}

const live = runCli();
let committed;
try {
  committed = readFileSync(path.join(dataDir, "cli-usage.generated.txt"), "utf8");
} catch {
  fail("src/data/cli-usage.generated.txt is missing — run `node scripts/gen-cli.mjs`.");
  process.exit(1);
}

if (live !== committed) {
  fail(
    "the real CLI's usage text no longer matches src/data/cli-usage.generated.txt.\n" +
      "Run `node scripts/gen-cli.mjs` and review/commit the diff.",
  );
}

const lines = usageLines(live);
const { byGroup, unmatched, multi } = classify(lines);
if (unmatched.length) {
  fail(`${unmatched.length} usage line(s) matched no doc group:\n  ${unmatched.join("\n  ")}`);
}
if (multi.length) {
  fail(
    `${multi.length} usage line(s) matched more than one doc group:\n  ` +
      multi.map((m) => `${m.line} -> ${m.groups.join(", ")}`).join("\n  "),
  );
}

let committedGroups;
try {
  committedGroups = JSON.parse(
    readFileSync(path.join(dataDir, "cli-groups.generated.json"), "utf8"),
  );
} catch {
  fail("src/data/cli-groups.generated.json is missing — run `node scripts/gen-cli.mjs`.");
}
if (committedGroups) {
  for (const g of groups) {
    const committedLines = committedGroups.find((c) => c.id === g.id)?.lines ?? [];
    const liveLines = byGroup.get(g.id);
    const a = JSON.stringify(committedLines);
    const b = JSON.stringify(liveLines);
    if (a !== b) fail(`group "${g.id}" lines differ from the committed JSON.`);
  }
}

if (failed) process.exit(1);
console.log(`OK: ${lines.length} CLI usage lines verified against the real CLI, fully grouped.`);
