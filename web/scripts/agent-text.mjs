// Post-build: writes the crawler- and agent-facing files into dist/ from the
// built pages themselves, so they can never drift from what the site shows.
//
//   dist/sitemap.xml    every indexable page (canonical URL; noindex pages skipped)
//   dist/llms.txt       llmstxt.org index: one line per page, title + one-sentence answer
//   dist/llms-full.txt  every page's main content as Markdown, in reading order
//
// Usage: node scripts/agent-text.mjs [--dist dist] [--source html]
//
// The Markdown comes from a *source*:
//   canon (default)  Pages Canon builds (doc/v1) come from its published
//                    manifest (dist/.well-known/canon/manifest.json): title,
//                    description and reading order from the manifest, and the
//                    sealed Markdown twin, unmodified, from dist/<path>/index.md.
//                    llms.txt links those pages to their .md twin. Every other
//                    page falls back to "html".
//   html             each built page's <main>, converted with
//                    scripts/lib/html-to-md.mjs.
// A source has one signature (page record in, Markdown out).
//
// Generic apart from the CONFIG block (site name, page order, the
// site-specific conversion rules), so it's reusable for any static site.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { decode, htmlToMarkdown, parse, helpers } from "./lib/html-to-md.mjs";

// ---- CONFIG (Canon-specific) ------------------------------------------------
const CONFIG = {
  name: "Canon",
  origin: "https://oncanon.dev",
  // Reading order for llms.txt / llms-full.txt; pages not listed go last, by path.
  order: ["/", "/guide/", "/guide/install/", "/guide/quick-start/", "/schemas/", "/cli/", "/canon-app/", "/open-source/"],
  sections: { "/canon-app/": "Optional", "/open-source/": "Optional" },
  intro:
    "Canon is offline-first tooling that runs on Node.js 22 or newer and is going public as open source. These are its docs; the whole set is also available as one Markdown file at https://oncanon.dev/llms-full.txt.",
  // What the HTML source leaves out or reshapes. Decorative copy is already
  // marked data-pagefind-ignore for search; the same marks apply here, except
  // table headers (ignored for search excerpts, but a Markdown table needs them).
  html: {
    ignore: (el) => el.attrs["data-pagefind-ignore"] != null && el.tag !== "thead",
    // CLI usage lines are <code> elements styled as a block; emit them as one fenced block per group.
    codeBlock: (el) => el.tag === "code" && helpers.hasClass(el, "group-card__line"),
    transform(root, h) {
      // Section numbers ("02", "2.5") sit beside their headings; fold them in.
      for (const num of h.findAll(root, (e) => h.hasClass(e, "sh__num") || h.hasClass(e, "group-card__number"))) {
        const scope = num.parent;
        const heading = h.find(scope, (e) => /^h[1-6]$/.test(e.tag));
        if (heading) heading.children.unshift({ text: `${h.text(num).trim()} `, parent: heading });
        h.remove(num);
      }
    },
  },
};

// ---- sources ----------------------------------------------------------------
const MANIFEST = ".well-known/canon/manifest.json";
const SOURCES = {
  /** @param {Page} page */
  html(page) {
    const main = helpers.find(parse(page.html), (e) => e.tag === "main");
    if (!main) throw new Error(`no <main> in ${page.file}`);
    return htmlToMarkdown(main, { ...CONFIG.html, baseUrl: page.url });
  },
  /** @param {Page} page */
  canon(page) {
    return page.sealed ? readFileSync(join(dist, page.sealed.files.markdown), "utf8") : SOURCES.html(page);
  },
};

/** Attach Canon's manifest entry to the pages it built, and take their title and description from it. */
function applyManifest(pages) {
  const manifest = JSON.parse(readFileSync(join(dist, MANIFEST), "utf8"));
  if (manifest.schema !== "canon-doc-manifest/v1") throw new Error(`${MANIFEST}: schema ${manifest.schema}`);
  for (const entry of manifest.pages) {
    const page = pages.find((p) => p.path === entry.path);
    if (!page) throw new Error(`${MANIFEST} lists ${entry.path}, which the site didn't build`);
    Object.assign(page, { sealed: entry, title: entry.title, description: entry.description });
  }
  // Canon's reading order is the manifest's; the site order must agree with it.
  const built = pages.filter((p) => p.sealed).map((p) => p.path);
  const wanted = manifest.pages.map((p) => p.path);
  if (built.join() !== wanted.join()) throw new Error(`site order ${built.join(" ")} disagrees with the manifest's ${wanted.join(" ")}`);
  return manifest;
}

// ---- read the built site -----------------------------------------------------
/** @typedef {{ file: string, path: string, url: string, title: string, description: string, html: string, sealed?: { files: { markdown: string } } }} Page */
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return ["pagefind", "_astro", "fonts", "og"].includes(n) ? [] : walk(p);
    return n.endsWith(".html") ? [p] : [];
  });
}

function meta(html, re) {
  const m = re.exec(html);
  return m ? decode(m[1]).trim() : null;
}

function readPages(dist) {
  const pages = [];
  for (const file of walk(dist)) {
    const html = readFileSync(file, "utf8");
    if (/<meta name="robots" content="[^"]*noindex/i.test(html)) continue;
    const canonical = meta(html, /<link rel="canonical" href="([^"]+)"/i);
    if (!canonical) throw new Error(`${relative(dist, file)} has no canonical URL and isn't noindex`);
    const url = new URL(canonical);
    if (url.origin !== CONFIG.origin) throw new Error(`${relative(dist, file)}: canonical ${canonical} is off ${CONFIG.origin}`);
    const title = meta(html, /<title>([^<]*)<\/title>/i);
    const description = meta(html, /<meta name="description" content="([^"]*)"/i);
    if (!title || !description) throw new Error(`${relative(dist, file)} is missing a title or description`);
    pages.push({ file, path: url.pathname, url: url.href, title, description, html });
  }
  const rank = (p) => { const i = CONFIG.order.indexOf(p.path); return i < 0 ? CONFIG.order.length : i; };
  return pages.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

// ---- writers ----------------------------------------------------------------
const xml = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const shortTitle = (t) => t.replace(new RegExp(`\\s+·\\s+${CONFIG.name}$`), "");
const indexUrl = (p) => (p.sealed ? new URL(p.sealed.files.markdown, `${CONFIG.origin}/`).href : p.url);

function sitemap(pages) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map((p) => `  <url><loc>${xml(p.url)}</loc></url>`).join("\n")}\n</urlset>\n`;
}

function llmsIndex(pages) {
  const groups = new Map();
  for (const p of pages) {
    const s = CONFIG.sections[p.path] ?? "Docs";
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(`- [${shortTitle(p.title)}](${indexUrl(p)}): ${p.description}`);
  }
  const home = pages.find((p) => p.path === "/");
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "Optional") - (b === "Optional"));
  return [
    `# ${CONFIG.name}`, "",
    `> ${home?.description ?? ""}`, "",
    CONFIG.intro, "",
    ...ordered.flatMap(([s, lines]) => [`## ${s}`, "", ...lines, ""]),
  ].join("\n");
}

function llmsFull(pages, markdown) {
  const home = pages.find((p) => p.path === "/");
  const head = [`# ${CONFIG.name} documentation`, "", `> ${home?.description ?? ""}`, "", CONFIG.intro, ""];
  // Sealed Markdown goes in byte for byte (no trim); converted Markdown is tidied.
  const body = pages.flatMap((p) => ["---", "", `Source: ${p.url}`, "", p.sealed ? markdown.get(p.url) : markdown.get(p.url).trim() + "\n"]);
  return [...head, ...body].join("\n");
}

// ---- main -------------------------------------------------------------------
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const dist = resolve(args.dist ?? "dist");
const source = SOURCES[args.source ?? "canon"];
if (!source) throw new Error(`unknown --source ${args.source}; have ${Object.keys(SOURCES).join(", ")}`);

const pages = readPages(dist);
const manifest = source === SOURCES.canon ? applyManifest(pages) : null;
const markdown = new Map(pages.map((p) => [p.url, source(p)]));
const files = {
  "sitemap.xml": sitemap(pages),
  "llms.txt": llmsIndex(pages),
  "llms-full.txt": llmsFull(pages, markdown),
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(dist, name), body);
// Prove the sealed Markdown went in unmodified.
for (const p of pages.filter((x) => x.sealed)) {
  if (!files["llms-full.txt"].includes(markdown.get(p.url))) throw new Error(`llms-full.txt doesn't carry ${p.sealed.files.markdown} verbatim`);
}
if (manifest) console.log(`agent-text: ${manifest.pages.length} pages from Canon edition ${manifest.edition} (sealed Markdown, verbatim), ${pages.length - manifest.pages.length} converted from HTML`);
console.log(`agent-text: ${pages.length} pages → ${Object.entries(files).map(([n, b]) => `${n} (${Buffer.byteLength(b)} B)`).join(", ")}`);
