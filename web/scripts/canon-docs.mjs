// Canon-built docs pages (doc/v1; see the integration brief in
// docs/core/doc-v1.md). The site build calls this four times:
//
//   input   --from <dir>  Write .canon/input/: the doc-set/v1 manifest from
//                         content/canon/docs.doc-set.json, with every external
//                         page's `anchors` filled from the ids actually rendered
//                         in that page's <main> under <dir> (a first Astro pass).
//                         The committed manifest must keep `anchors: []`: they
//                         are generated here, never typed.
//   build                 canon build-docs → .canon/docs/, then canon verify-docs.
//   publish --dist <dir>  Copy the sealed Markdown twins and the published
//                         manifest into the site, plus their _headers lines.
//   check   --dist <dir>  Prove the site carries Canon's output unchanged:
//                         each page's fragment bytes sit verbatim inside the
//                         built HTML, each served .md equals the sealed one,
//                         the externals' anchors haven't drifted, and
//                         verify-docs still passes.
//
// The Canon CLI is $CANON_CLI, else the repository's own src/cli.mjs. Until
// core/doc-v1 is merged to main, the repository CLI has no build-docs and the
// build stops with a message saying so.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(WEB, "content/canon");
const SOURCE_SET = join(SOURCE_DIR, "docs.doc-set.json");
const STAGE = join(WEB, ".canon");
const INPUT_DIR = join(STAGE, "input");
const INPUT_SET = join(INPUT_DIR, "docs.doc-set.json");
export const OUT_DIR = join(STAGE, "docs");
const MANIFEST = ".well-known/canon/manifest.json";
const CLI = resolve(process.env.CANON_CLI ?? join(WEB, "../src/cli.mjs"));

const [cmd, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])));
const fail = (msg) => { console.error(`canon-docs ${cmd}: ${msg}`); process.exit(1); };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const pageHtml = (dir, path) => join(dir, path.replace(/^\/|\/$/g, ""), "index.html");

/** Every id attribute inside the page's <main>, in document order, once each. */
export function mainIds(html) {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0];
  if (!main) throw new Error("no <main>");
  return [...new Set([...main.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))];
}

function canon(...argv) {
  if (!existsSync(CLI)) fail(`no Canon CLI at ${CLI}; set CANON_CLI`);
  if (!readFileSync(CLI, "utf8").includes("build-docs")) {
    fail(`${CLI} has no build-docs (core/doc-v1 isn't merged here); set CANON_CLI to a CLI that has it`);
  }
  return execFileSync(process.execPath, [CLI, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function input() {
  const from = args.from ? resolve(args.from) : fail("--from <first-pass dist> is required");
  const set = readJson(SOURCE_SET);
  rmSync(INPUT_DIR, { recursive: true, force: true });
  mkdirSync(INPUT_DIR, { recursive: true });
  for (const ext of set.external ?? []) {
    if (ext.anchors.length) fail(`${SOURCE_SET}: external "${ext.id}" lists anchors by hand; leave [] and let the build generate them`);
    const file = pageHtml(from, ext.path);
    if (!existsSync(file)) fail(`external "${ext.id}" (${ext.path}) wasn't rendered at ${file}`);
    ext.anchors = mainIds(readFileSync(file, "utf8"));
    console.log(`external ${ext.id} ${ext.path}: ${ext.anchors.length} anchors from rendered <main>: ${ext.anchors.join(" ")}`);
  }
  for (const p of set.pages) copyFileSync(join(SOURCE_DIR, p.source), join(INPUT_DIR, p.source));
  writeFileSync(INPUT_SET, JSON.stringify(set, null, 2) + "\n");
}

function verifyDocs() {
  let out;
  try { out = canon("verify-docs", OUT_DIR, "--json"); } catch (e) { fail(`verify-docs failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`); }
  const r = JSON.parse(out);
  if (!r.ok) fail(`verify-docs: ${JSON.stringify(r.errors)}`);
  console.log(`verify-docs: ok ${r.contentId}`);
  return r;
}

function build() {
  if (!existsSync(INPUT_SET)) fail(`${INPUT_SET} is missing; run "input" first`);
  // build-docs writes its receipt once and refuses to overwrite one; the stage
  // is rebuilt from scratch every time, so the previous build's goes first.
  const receipt = join(STAGE, "build-receipt.json");
  rmSync(OUT_DIR, { recursive: true, force: true });
  rmSync(receipt, { force: true });
  mkdirSync(STAGE, { recursive: true }); // build-docs wants --out's parent to exist
  let out;
  try { out = canon("build-docs", INPUT_SET, "--out", OUT_DIR, "--receipt", receipt); }
  catch (e) { fail(`build-docs failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`); }
  const r = JSON.parse(out);
  console.log(`build-docs: ${r.contentId} · ${r.fileCount} files · ${r.totalBytes} B`);
  verifyDocs();
}

function publish() {
  const dist = resolve(args.dist ?? "dist");
  const manifest = readJson(join(OUT_DIR, MANIFEST));
  mkdirSync(dirname(join(dist, MANIFEST)), { recursive: true });
  copyFileSync(join(OUT_DIR, MANIFEST), join(dist, MANIFEST));
  const headers = ["", "# Canon's sealed Markdown twins and manifest (scripts/canon-docs.mjs publish)"];
  for (const p of manifest.pages) {
    mkdirSync(dirname(join(dist, p.files.markdown)), { recursive: true });
    copyFileSync(join(OUT_DIR, p.files.markdown), join(dist, p.files.markdown));
    headers.push(`/${p.files.markdown}`, "  Content-Type: text/markdown; charset=utf-8");
  }
  headers.push(`/${MANIFEST}`, "  Content-Type: application/json; charset=utf-8");
  appendFileSync(join(dist, "_headers"), headers.join("\n") + "\n");
  console.log(`published ${MANIFEST} and ${manifest.pages.length} Markdown twins (edition ${manifest.edition})`);
}

function check() {
  const dist = resolve(args.dist ?? "dist");
  const manifest = readJson(join(OUT_DIR, MANIFEST));
  const problems = [];
  if (sha256(readFileSync(join(dist, MANIFEST))) !== sha256(readFileSync(join(OUT_DIR, MANIFEST)))) problems.push(`served ${MANIFEST} differs from Canon's`);
  for (const p of manifest.pages) {
    // 1. The fragment, byte for byte, inside the built page.
    const frag = readFileSync(join(OUT_DIR, p.files.html));
    const page = readFileSync(pageHtml(dist, p.path));
    if (sha256(frag) !== p.sha256.html) problems.push(`${p.id}: fragment hash isn't the manifest's`);
    const open = Buffer.from(`data-canon-fragment="${p.id}">`);
    const at = page.indexOf(open);
    if (at < 0 || page.indexOf(open, at + 1) >= 0) { problems.push(`${p.id}: expected exactly one data-canon-fragment wrapper`); continue; }
    const start = at + open.length;
    const embedded = page.subarray(start, start + frag.length);
    const after = page.subarray(start + frag.length, start + frag.length + 6).toString();
    const same = embedded.equals(frag) && after === "</div>";
    console.log(`${p.id}: fragment ${frag.length} B sha256 ${sha256(frag).slice(0, 16)}… ${same ? "==" : "!="} ${p.path}index.html bytes [${start}, ${start + frag.length}) sha256 ${sha256(embedded).slice(0, 16)}…, followed by "${after}"`);
    if (!same) problems.push(`${p.id}: built page doesn't carry the fragment unchanged`);
    // 2. The served Markdown twin is the sealed one.
    const md = readFileSync(join(OUT_DIR, p.files.markdown));
    const served = readFileSync(join(dist, p.files.markdown));
    const mdOk = served.equals(md) && sha256(md) === p.sha256.markdown;
    console.log(`${p.id}: /${p.files.markdown} ${md.length} B ${mdOk ? "==" : "!="} sealed (sha256 ${p.sha256.markdown.slice(0, 16)}…)`);
    if (!mdOk) problems.push(`${p.id}: served Markdown isn't the sealed bytes`);
  }
  // 3. The anchors Canon resolved refs against are still the ones the site renders.
  for (const ext of readJson(INPUT_SET).external ?? []) {
    const now = mainIds(readFileSync(pageHtml(dist, ext.path), "utf8"));
    const same = now.length === ext.anchors.length && now.every((a, i) => a === ext.anchors[i]);
    console.log(`external ${ext.id}: ${now.length} anchors in final build ${same ? "==" : "!="} the ${ext.anchors.length} Canon resolved against`);
    if (!same) problems.push(`external ${ext.id}: anchors drifted between passes`);
  }
  // 4. Canon's own verifier on the output used.
  verifyDocs();
  if (problems.length) fail(problems.join("\n"));
  console.log(`canon-docs check: ${manifest.pages.length} pages carry edition ${manifest.edition} unchanged`);
}

const commands = { input, build, publish, check };
if (!commands[cmd]) fail(`usage: canon-docs.mjs ${Object.keys(commands).join("|")} [--from dir] [--dist dir]`);
commands[cmd]();
