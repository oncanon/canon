// Visual evidence for the docs site: real-viewport screenshots of every built
// page at 1280 and 390 px in light and dark, plus design | built composites
// for the home page and the CLI reference.
//
//   npm run build
//   npm run screenshot -- [--design <page05.html>] [--out <dir>] [--port <n>]
//
// Output goes to web/.fidelity/ (gitignored) unless --out says otherwise.
//
// It serves dist/ on 127.0.0.1 itself, finds every page in dist/, and shuts
// the server down when done. Composites put the design on the left and
// the build on the right at the same CSS-pixel scale (deviceScaleFactor 1).
//
// --design points at the Identity & Surfaces page05 export ("Canon docs v2.1 —
// home and CLI reference"), a self-unpacking HTML bundle that carries its own
// fonts. It is rendered as-is in Chromium, then cropped: the whole page for
// "home", the "02 · CLI surface" section for "cli". Without --design the
// script reuses the design renders already in <out>/design/.
//
// Nothing here talks to the network: the preview is on 127.0.0.1 and the
// design bundle is a local file. Any request a built page makes off
// 127.0.0.1 is reported and fails the run.
//
// It also fails when a built page hides text: the page itself scrolling
// sideways, or an element with overflow hidden/clip whose content is wider
// than its box. Elements that scroll sideways on purpose (overflow-x auto or
// scroll, e.g. a wide table on a phone) are listed, not failed.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
// Screenshots are evidence, not source: they go to a gitignored folder and
// docs/p5-fidelity.md is the committed record.
const OUT = resolve(WEB, args.out ?? ".fidelity");
const PORT = Number(args.port ?? 4329);
const BASE_PATH = "/";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WIDTHS = [1280, 390];
const SCHEMES = ["light", "dark"];
const COMPOSITES = ["home", "cli"];

// ---- pages ---------------------------------------------------------------
function findPages(dir, root = dir) {
  const pages = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "pagefind" || name === "_astro" || name === "fonts") continue;
      pages.push(...findPages(p, root));
    } else if (name === "index.html") {
      const rel = relative(root, dir).split("\\").join("/");
      pages.push({ name: rel === "" ? "home" : rel.replaceAll("/", "-"), path: rel === "" ? "" : `${rel}/` });
    }
  }
  return pages.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- static server -------------------------------------------------------
// Serves dist/ at the root the way Cloudflare Pages would (missing paths get
// dist/404.html with status 404). Deliberately not
// `astro preview`: Astro 7 detaches it into a background daemon when stdout
// isn't a TTY, which leaves a server running after the script exits.
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png",
  ".wasm": "application/wasm", ".pf_meta": "application/octet-stream" };
function startServer(dist) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (!url.pathname.startsWith(BASE_PATH)) { res.writeHead(404).end(); return; }
    let file = normalize(join(dist, decodeURIComponent(url.pathname.slice(BASE_PATH.length))));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      const nf = join(dist, "404.html");
      res.writeHead(404, { "content-type": TYPES[".html"] });
      res.end(existsSync(nf) ? readFileSync(nf) : "");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

// ---- captures ------------------------------------------------------------
async function capture(browser, url, file, { width, scheme, clip, police = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const offsite = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["127.0.0.1", ""].includes(u.hostname) && !["file:", "data:", "blob:", "about:"].includes(u.protocol)) offsite.push(r.url());
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const overflow = police ? await page.evaluate(() => {
    const out = { clipped: [], scrolls: [], page: document.documentElement.scrollWidth > window.innerWidth + 1 };
    const label = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : ""} "${e.textContent.trim().slice(0, 50)}"`;
    for (const e of document.body.querySelectorAll("*")) {
      if (e.scrollWidth <= e.clientWidth + 1 || e.clientWidth === 0) continue;
      const ox = getComputedStyle(e).overflowX;
      if (ox === "hidden" || ox === "clip") out.clipped.push(label(e));
      else if (ox === "auto" || ox === "scroll") out.scrolls.push(label(e));
    }
    return out;
  }) : null;
  let box;
  if (clip) {
    box = await page.evaluate(clip);
    if (!box) throw new Error(`clip target not found on ${url}`);
  }
  await page.screenshot({ path: file, fullPage: true, clip: box });
  await ctx.close();
  return { offsite, overflow };
}

// Crops page05 to its "02 · CLI surface" section (the <section> whose h2 says
// "CLI surface"), so the CLI composite compares like with like.
const cliSectionClip = () => {
  const h = [...document.querySelectorAll("h2")].find((e) => e.textContent.trim() === "CLI surface");
  const s = h && h.closest("section");
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { x: 0, y: r.top + window.scrollY, width: document.documentElement.clientWidth, height: r.height };
};

async function composite(browser, left, right, file, labels) {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  const src = (p) => pathToFileURL(p).href;
  await page.goto(pathToFileURL(join(OUT, "design")).href); // a file:// origin so <img> can load file:// URLs
  await page.setContent(`<!doctype html><style>
    body{margin:0;background:#64748b;font:600 14px -apple-system,sans-serif;color:#fff}
    .row{display:flex;gap:16px;padding:16px;align-items:flex-start;width:max-content}
    figure{margin:0} figcaption{padding:0 0 8px} img{display:block;background:#fff}
  </style><div class="row">
    <figure><figcaption>${labels[0]}</figcaption><img src="${src(left)}"></figure>
    <figure><figcaption>${labels[1]}</figcaption><img src="${src(right)}"></figure>
  </div>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await page.locator(".row").screenshot({ path: file });
  await page.close();
}

// ---- main ----------------------------------------------------------------
const dist = join(WEB, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");
// The 404 page is captured through a path that doesn't exist, as a visitor reaches it.
const pages = [...findPages(dist), { name: "404", path: "this-page-does-not-exist/" }];
for (const d of ["shots", "design", "composite"]) mkdirSync(join(OUT, d), { recursive: true });

const browser = await chromium.launch();
const server = await startServer(dist);
const offsite = [];
const hidden = [];
try {
  for (const p of pages) {
    for (const width of WIDTHS) {
      for (const scheme of SCHEMES) {
        const file = join(OUT, "shots", `${p.name}-${width}-${scheme}.png`);
        const r = await capture(browser, `${ORIGIN}${BASE_PATH}${p.path}`, file, { width, scheme, police: true });
        offsite.push(...r.offsite);
        const where = `${p.name} @ ${width} ${scheme}`;
        if (r.overflow.page) hidden.push(`${where}: the page scrolls sideways`);
        for (const c of r.overflow.clipped) hidden.push(`${where}: clipped ${c}`);
        for (const c of r.overflow.scrolls) console.log(`  note ${where}: scrolls sideways ${c}`);
        console.log(`wrote ${file}`);
      }
    }
  }

  if (args.design) {
    const url = pathToFileURL(resolve(args.design)).href;
    for (const width of WIDTHS) {
      for (const [name, clip] of [["home", undefined], ["cli", cliSectionClip]]) {
        const file = join(OUT, "design", `${name}-${width}.png`);
        await capture(browser, url, file, { width, scheme: "light", clip }); // the design's own requests aren't ours to police
        console.log(`wrote ${file}`);
      }
    }
  }

  for (const name of COMPOSITES) {
    for (const width of WIDTHS) {
      const design = join(OUT, "design", `${name}-${width}.png`);
      if (!existsSync(design)) {
        console.warn(`skip composite ${name}-${width}: no ${relative(WEB, design)} (pass --design)`);
        continue;
      }
      const built = join(OUT, "shots", `${name}-${width}-light.png`);
      const file = join(OUT, "composite", `${name}-${width}-light.png`);
      const what = name === "cli" ? "page05 · 02 CLI surface" : "page05";
      await composite(browser, design, built, file, [`Design: ${what} @ ${width}`, `Built: /${name === "home" ? "" : `${name}/`} @ ${width} light`]);
      console.log(`wrote ${file}`);
    }
  }
} finally {
  server.close();
  await browser.close();
}

let failed = false;
if (offsite.length) {
  console.error(`requests left 127.0.0.1:\n  ${[...new Set(offsite)].join("\n  ")}`);
  failed = true;
}
if (hidden.length) {
  console.error(`hidden text:\n  ${hidden.join("\n  ")}`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`${pages.length} pages × ${WIDTHS.length} widths × ${SCHEMES.length} schemes; no off-host requests; no clipped text`);
