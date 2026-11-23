// Every JSON example the site shows must be accepted by the real Canon CLI.
// Runs each one through build + verify (report/v1) or build-site +
// verify-site (site-input/v1) in a temp folder, and fails the site build on
// any non-zero exit. The CLI is the repository's own src/cli.mjs: the pages
// describe the validators on this branch.
//
//   content/examples/report.json       Schemas page, report/v1
//   content/examples/site-input.json   Schemas page, site-input/v1
//   content/canon/guide-quick-start.doc.json, first json code block
//                                       Quick start's report.json
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(WEB, "../src/cli.mjs");
const EXAMPLES = join(WEB, "content/examples");

const quickStart = JSON.parse(readFileSync(join(WEB, "content/canon/guide-quick-start.doc.json"), "utf8"))
  .sections.flatMap((s) => s.blocks)
  .find((b) => b.type === "code" && b.language === "json").source;

const cases = [
  { name: "schemas report/v1", kind: "report", text: readFileSync(join(EXAMPLES, "report.json"), "utf8"), evidence: true },
  { name: "schemas site-input/v1", kind: "site", text: readFileSync(join(EXAMPLES, "site-input.json"), "utf8") },
  { name: "quick-start report.json", kind: "report", text: quickStart + "\n" },
];

const run = (cwd, ...argv) => execFileSync(process.execPath, [CLI, ...argv], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let failed = false;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), "canon-example-"));
  try {
    const src = c.kind === "report" ? "report.json" : "site-input.json";
    writeFileSync(join(dir, src), c.text);
    if (c.evidence) cpSync(join(EXAMPLES, "evidence"), join(dir, "evidence"), { recursive: true });
    mkdirSync(join(dir, "out")); // the CLI wants --out's parent to exist
    const [build, verify] = c.kind === "report" ? ["build", "verify"] : ["build-site", "verify-site"];
    const id = JSON.parse(run(dir, build, src, "--out", "out/x")).contentId;
    run(dir, verify, "out/x");
    console.log(`check-examples: ${c.name}: ${build} + ${verify} exit 0 (${id})`);
  } catch (e) {
    failed = true;
    console.error(`check-examples: ${c.name} FAILED\n${e.stdout ?? ""}${e.stderr ?? e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (failed) process.exit(1);
