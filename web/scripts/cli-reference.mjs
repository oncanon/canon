// Shared source of truth for the CLI reference page.
// Runs the real CLI (../src/cli.mjs, repo root) and classifies every
// "canon ..." usage line into the six doc groups from the page05 design
// (2.1 Author & inspect ... 2.5 Remote targets). "canon service clean"
// is intentionally excluded from the 2.3 regex and is matched by the
// Workstation server rule below.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
export const cliEntry = path.join(repoRoot, "src/cli.mjs");

export function runCli() {
  // No subcommand prints the bare usage block (non-zero exit, usage-error
  // convention) — the cleanest, driest text the CLI produces, with no
  // "unknown command" prefix line to strip.
  const result = spawnSync(process.execPath, [cliEntry], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result.stdout + result.stderr;
}

export function usageLines(text) {
  return text
    .split("\n")
    .filter((l) => /^\s{2}canon /.test(l))
    .map((l) => l.trim());
}

// Order matters: first matching rule wins. Each rule is tried against
// every usage line, so the whole set must partition the lines exactly
// once each (checked by scripts/check-cli.mjs).
export const groups = [
  {
    id: "author",
    number: "2.1",
    title: "Author & inspect",
    summary: "Compile, verify, store, point an alias.",
    test: (l) =>
      l.startsWith("canon brief ") ||
      l.startsWith("canon sitrep ") ||
      l.startsWith("canon status ") ||
      l.startsWith("canon --version ") ||
      l.startsWith("canon --help "),
  },
  {
    id: "build",
    number: "2.2",
    title: "Build, verify & archive",
    summary: "Low-level steps, each checkable alone.",
    test: (l) =>
      l.startsWith("canon build ") ||
      l.startsWith("canon verify ") ||
      l.startsWith("canon build-site ") ||
      l.startsWith("canon verify-site ") ||
      l.startsWith("canon build-docs ") ||
      l.startsWith("canon verify-docs ") ||
      l.startsWith("canon archive "),
  },
  {
    id: "store",
    number: "2.3",
    title: "Store & aliases",
    summary: "Compare-and-swap prevents lost updates.",
    test: (l) =>
      (l.startsWith("canon publish ") && !l.includes("--target")) ||
      l.startsWith("canon alias "),
  },
  {
    id: "serve",
    number: "2.4",
    title: "Workstation server",
    summary: "Loopback by default; backs Canon.app.",
    test: (l) => l.startsWith("canon serve ") || l.startsWith("canon service "),
  },
  {
    id: "remote",
    number: "2.5",
    title: "Remote targets",
    summary: "Gated: explicit grants, dry-run, zero delete.",
    test: (l) =>
      (l.startsWith("canon publish ") && l.includes("--target")) ||
      l.startsWith("canon promote ") ||
      l.startsWith("canon rollback ") ||
      l.startsWith("canon reconcile ") ||
      l.startsWith("canon key "),
  },
];

// Not CLI commands: HTTP routes served over the aliases above. Sourced
// from README.md's Output contract table, which is the public contract.
export const servedRoutes = {
  id: "routes",
  number: "2.6",
  title: "Served routes",
  summary: "Mutable aliases → immutable editions.",
  lines: [
    "/a/<alias>/  ·  /a/<alias>/report.md  ·  /a/<alias>.json",
    "/p/sha256-<hex>/  ·  manifest.json",
    "/healthz",
  ],
};

export function classify(lines) {
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  const unmatched = [];
  const multi = [];
  for (const line of lines) {
    const hits = groups.filter((g) => g.test(line));
    if (hits.length === 0) unmatched.push(line);
    else if (hits.length > 1) multi.push({ line, groups: hits.map((h) => h.id) });
    else byGroup.get(hits[0].id).push(line);
  }
  return { byGroup, unmatched, multi };
}
