// Fidelity check for the three surfaces that sit outside the page layouts:
// the logo tile, the social card and the 404 page. Each is compared against
// the design-v2 export it derives from, and the script exits 1 on any miss.
//
//   npm run build
//   npm run fidelity:plates -- --identity "<Canon — Identity.html>" \
//                              --surfaces "<Canon — Identity & Surfaces.html>"
//
// What each check compares:
// - Logo tile (public/og/canon-tile-512.png) against Identity Plate 2, the
//   128 px tile, rendered from the plate's own markup at deviceScaleFactor 4.
//   The export does not embed Libron (the C falls back to a system serif), so
//   the plate markup is rendered a second time with the vendored Libron Bold
//   supplied; that render is the pixel reference. The built tile is laid on
//   the plate's #eaedf2 ground and diffed pixel by pixel.
// - Social card (public/og/canon.png) against page05's hero, the hero the maintainer
//   chose for the site on 2026-11-18. No plate draws a 1200×630 card, so the
//   check compares computed styles (colours, fonts, ratios) element by
//   element, and requires the committed PNG to equal a fresh render byte for
//   byte, so a stale image fails.
// - 404 page against page05's hero, by computed styles at 1280, served from
//   dist/ with Cloudflare Pages' rules on an unknown path, which must answer
//   HTTP 404.
// - og:image and twitter:image on every built HTML page.
//
// It writes side-by-side composites to .fidelity/plates/. Nothing here talks
// to the network: the plates are local files and the preview is on 127.0.0.1.
import { existsSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { render as renderOg } from "./og-image.mjs";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    identity: { type: "string" },
    surfaces: { type: "string" },
    out: { type: "string", default: join(WEB, ".fidelity/plates") },
    port: { type: "string", default: "4399" },
  },
});
for (const k of ["identity", "surfaces"]) {
  if (!args[k] || !existsSync(args[k])) {
    console.error(`--${k} <design-v2 export> is required and must exist`);
    process.exit(2);
  }
}
const DIST = join(WEB, "dist");
if (!existsSync(join(DIST, "404.html"))) {
  console.error("dist/404.html is missing: run npm run build first");
  process.exit(2);
}
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });

const failures = [];
const report = (ok, line) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  if (!ok) failures.push(line);
};
const b64 = (file) => readFileSync(file).toString("base64");
const libron = "data:font/woff2;base64," + b64(join(WEB, "public/fonts/libron/Libron-Bold.woff2"));

// Computed styles, read in each page; norm() turns line-height and
// letter-spacing into ratios of font-size so they compare across scales.
const PROPS = ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
  "borderTop", "borderBottom", "borderRadius", "height", "padding", "paddingTop", "paddingBottom", "gap"];
function norm(p, s) {
  const fs = parseFloat(s.fontSize);
  switch (p) {
    case "fontFamily": return s.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    case "lineHeight": return s.lineHeight === "normal" ? "normal" : (parseFloat(s.lineHeight) / fs).toFixed(3);
    case "letterSpacing": return s.letterSpacing === "normal" ? "0.000" : (parseFloat(s.letterSpacing) / fs).toFixed(3);
    default: return s[p];
  }
}
function compare(label, plate, built, props) {
  const misses = props.filter((p) => norm(p, plate) !== norm(p, built))
    .map((p) => `${p}: plate ${norm(p, plate)} | built ${norm(p, built)}`);
  report(misses.length === 0, `${label}${misses.length ? "\n       " + misses.join("\n       ") : ""}`);
}

// page05 hero, read from the plate's own frame.
async function page05Hero(page) {
  for (const fr of page.frames()) {
    const got = await fr.evaluate(({ PROPS }) => {
      const read = (el) => { const cs = getComputedStyle(el); const o = {}; for (const p of PROPS) o[p] = cs[p]; return o; };
      const h1 = [...document.querySelectorAll("h1")].find((e) => /^Sealed editions/.test(e.textContent.trim()));
      if (!h1) return null;
      const copy = h1.parentElement, row = copy.parentElement, band = row.parentElement;
      const [primary, ghost] = copy.querySelectorAll("a");
      const zsh = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.trim() === "zsh");
      let term = zsh; while (term && !(getComputedStyle(term).borderTopStyle === "solid" && getComputedStyle(term).borderRadius !== "0px")) term = term.parentElement;
      const nav = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.trim() === "Guide");
      let bar = nav; while (bar && getComputedStyle(bar).backgroundColor === "rgba(0, 0, 0, 0)") bar = bar.parentElement;
      return {
        band: read(band), row: read(row), copy: read(copy), eyebrow: read(copy.children[0]), title: read(h1),
        pitch: read(copy.querySelector("p")), primary: read(primary), ghost: read(ghost),
        term: term && read(term), termBody: term && read(term.children[1]), bar: bar && read(bar),
      };
    }, { PROPS }).catch(() => null);
    if (got) return got;
  }
  throw new Error("page05 hero not found in --surfaces");
}

function findFrame(page, test) {
  return (async () => {
    for (const fr of page.frames()) if (await fr.evaluate(test).catch(() => false)) return fr;
    return null;
  })();
}

const browser = await chromium.launch();
let preview;
const tmp = mkdtempSync(join(tmpdir(), "canon-plates-"));
try {
  // ---------- plates ----------
  const surf = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await surf.goto(pathToFileURL(resolve(args.surfaces)).href);
  await surf.waitForFunction(() => document.querySelectorAll("iframe").length > 0);
  await surf.waitForTimeout(3000);
  const hero = await page05Hero(surf);

  // ---------- 1. logo tile ----------
  const isTile = () => [...document.querySelectorAll("div")].some((d) => d.textContent === "C" && d.style.width === "128px");
  const idPage = await browser.newPage({ viewport: { width: 1800, height: 2600 } });
  await idPage.goto(pathToFileURL(resolve(args.identity)).href);
  await idPage.waitForTimeout(3000);
  const tileFrame = await findFrame(idPage, isTile);
  if (!tileFrame) throw new Error("Plate 2 128px tile not found in --identity");
  // The plate's tile sits at a fractional offset, so an element screenshot is
  // 129 CSS px wide. Its markup is all inline style: take it verbatim from the
  // plate DOM and render it at 0,0, at ×4, once as exported and once with
  // Libron supplied.
  const tileHtml = await tileFrame.evaluate(() =>
    [...document.querySelectorAll("div")].find((d) => d.textContent === "C" && d.style.width === "128px").outerHTML);
  const plateFont = await tileFrame.evaluate(() => [...document.fonts].some((f) => f.family === "Libron" && f.status === "loaded"));
  console.log(`info Plate 2 export ships Libron: ${plateFont}`);
  const exported = join(OUT, "tile-plate-exported.png");
  const reference = join(OUT, "tile-plate-libron.png");
  for (const [file, face] of [[exported, ""], [reference, `@font-face{font-family:Libron;font-weight:700;src:url("${libron}") format("woff2")}`]]) {
    const tp = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 4 });
    await tp.setContent(`<!doctype html><style>${face} html,body{margin:0;background:transparent}</style>${tileHtml}`);
    await tp.evaluate(async () => { await document.fonts.load("700 87px Libron"); await document.fonts.ready; });
    await tp.screenshot({ path: file, omitBackground: true });
    await tp.close();
  }

  // ---------- 2. social card: fresh render, styles ----------
  const fresh = join(tmp, "og");
  const card = {};
  await renderOg(browser, fresh, async (name, page) => {
    if (name !== "canon.png") return;
    Object.assign(card, await page.evaluate(({ PROPS }) => {
      const read = (el) => { const cs = getComputedStyle(el); const o = {}; for (const p of PROPS) o[p] = cs[p]; return o; };
      return { band: read(document.body), bar: read(document.querySelector(".bar")), eyebrow: read(document.querySelector(".eyebrow")),
        title: read(document.querySelector("h1")), term: read(document.querySelector(".term")) };
    }, { PROPS }));
  });
  for (const name of ["canon.png", "canon-tile-512.png"]) {
    const same = readFileSync(join(fresh, name)).equals(readFileSync(join(WEB, "public/og", name)));
    report(same, `public/og/${name} equals a fresh render of scripts/og-image.mjs byte for byte`);
  }

  // Tile pixel diff, in the browser: built tile on the plate's ground vs the plate render.
  const diffPage = await browser.newPage({ viewport: { width: 2200, height: 620 } });
  const tileStats = await diffPage.evaluate(async ({ ref, built, exp }) => {
    const load = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
    const [r, b, e] = await Promise.all([load(ref), load(built), load(exp)]);
    const W = r.width, H = r.height;
    const ctx = (img, ground) => { const c = new OffscreenCanvas(W, H); const x = c.getContext("2d");
      if (ground) { x.fillStyle = ground; x.fillRect(0, 0, W, H); } x.drawImage(img, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
    const R = ctx(r, "#eaedf2"), B = ctx(b, "#eaedf2");
    let over = 0, sum = 0, max = 0;
    const d = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < R.length; i += 4) {
      const m = Math.max(Math.abs(R[i] - B[i]), Math.abs(R[i + 1] - B[i + 1]), Math.abs(R[i + 2] - B[i + 2]));
      sum += m; if (m > max) max = m; if (m > 32) over++;
      d[i] = 255; d[i + 1] = d[i + 2] = 255 - Math.min(255, m * 4); d[i + 3] = 255;
    }
    // Composite: exported plate | plate with Libron | built on ground | diff ×4.
    const pad = 40, lab = 34, cw = (W + pad) * 4 + pad;
    const c = document.createElement("canvas"); c.width = cw; c.height = H + lab + pad * 2;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#0f172a"; x.font = "600 18px system-ui";
    const labels = ["Plate 2 · 128 tile ×4 (export, no Libron)", "Plate 2 markup + Libron (reference)", "Built canon-tile-512.png on #eaedf2", "Diff (×4)"];
    const tiles = [e, r, null, null];
    x.fillStyle = "#eaedf2"; for (let k = 0; k < 3; k++) x.fillRect(pad + k * (W + pad), pad + lab, W, H); x.fillStyle = "#0f172a";
    for (let k = 0; k < 4; k++) {
      const X = pad + k * (W + pad);
      x.fillText(labels[k], X, pad + 18);
      if (k === 2) { x.fillStyle = "#eaedf2"; x.fillRect(X, pad + lab, W, H); x.drawImage(b, X, pad + lab); x.fillStyle = "#0f172a"; }
      else if (k === 3) x.putImageData(new ImageData(d, W, H), X, pad + lab);
      else x.drawImage(tiles[k], X, pad + lab);
    }
    return { W, H, BW: b.width, BH: b.height, over, mean: sum / (W * H), max, png: c.toDataURL("image/png") };
  }, {
    ref: "data:image/png;base64," + b64(reference),
    built: "data:image/png;base64," + b64(join(WEB, "public/og/canon-tile-512.png")),
    exp: "data:image/png;base64," + b64(exported),
  });
  writeFileSync(join(OUT, "tile-sbs.png"), Buffer.from(tileStats.png.split(",")[1], "base64"));
  const ratio = tileStats.over / (tileStats.W * tileStats.H);
  report(tileStats.W === tileStats.BW && tileStats.H === tileStats.BH, `tile size: plate ×4 ${tileStats.W}×${tileStats.H} | built ${tileStats.BW}×${tileStats.BH}`);
  report(ratio <= 0.005 && tileStats.mean <= 1.0,
    `tile pixels vs Plate 2: ${tileStats.over} px (${(ratio * 100).toFixed(3)}%) differ by >32/255; mean ${tileStats.mean.toFixed(3)}, max ${tileStats.max} (limit 0.5%, mean ≤ 1)`);

  // Social card styles vs page05 hero.
  const T = ["color", "fontFamily", "fontWeight", "lineHeight", "letterSpacing"];
  compare("card band    vs page05 hero band", hero.band, card.band, ["backgroundColor", "color"]);
  compare("card bar     vs page05 nav bar", hero.bar, card.bar, ["backgroundColor"]);
  compare("card eyebrow vs page05 eyebrow", hero.eyebrow, card.eyebrow, T);
  compare("card title   vs page05 h1", hero.title, card.title, T);
  compare("card term    vs page05 terminal frame", hero.term, card.term, ["borderTop", "borderRadius", "fontFamily"]);
  compare("card term    vs page05 terminal body", hero.termBody, card.term, ["backgroundColor", "color"]);

  // ---------- 3. 404 through a local Pages-rule server ----------
  // `astro preview` runs one instance per project, and the maintainer's preview holds
  // it, so dist/ is served here with Cloudflare Pages' rules for a static
  // site: /x/ → x/index.html, /x → x.html or x/index.html, anything else →
  // the top-level 404.html with status 404.
  const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
    ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain", ".md": "text/markdown" };
  const { createServer } = await import("node:http");
  const { extname, normalize } = await import("node:path");
  preview = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const tries = path.endsWith("/") ? [join(path, "index.html")] : [path, path + ".html", join(path, "index.html")];
    for (const t of tries) {
      const f = join(DIST, t);
      if (f.startsWith(DIST + "/") && existsSync(f) && statSync(f).isFile()) {
        try { const body = readFileSync(f); res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" }); res.end(body); return; } catch {}
      }
    }
    res.writeHead(404, { "content-type": TYPES[".html"] }); res.end(readFileSync(join(DIST, "404.html")));
  });
  await new Promise((ok) => preview.listen(Number(args.port), "127.0.0.1", ok));
  const base = `http://127.0.0.1:${args.port}`;
  const missing = `/no-such-page-${process.pid}/`;
  const res = await fetch(base + missing);
  const body = await res.text();
  report(res.status === 404, `GET ${missing} → HTTP ${res.status} (want 404)`);
  report(body === readFileSync(join(DIST, "404.html"), "utf8"), `GET ${missing} body equals dist/404.html`);

  for (const width of [1280, 390]) {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    const offsite = [];
    p.on("request", (r) => { const u = new URL(r.url()); if (!(u.hostname === "127.0.0.1" || u.protocol === "data:")) offsite.push(r.url()); });
    await p.goto(base + missing);
    await p.evaluate(() => document.fonts.ready);
    report(offsite.length === 0, `404 @ ${width}: no off-host requests${offsite.length ? " — " + offsite.join(", ") : ""}`);
    await p.screenshot({ path: join(OUT, `404-${width}.png`), fullPage: true });
    const built = await p.evaluate(({ PROPS }) => {
      const read = (el) => { const cs = getComputedStyle(el); const o = {}; for (const p of PROPS) o[p] = cs[p]; return o; };
      const q = (s) => document.querySelector(s);
      return { band: read(q(".nf")), row: read(q(".nf__row")), eyebrow: read(q(".nf__eyebrow")), title: read(q(".nf__title")),
        pitch: read(q(".nf__body")), primary: read(q(".nf__btn--primary")), ghost: read(q(".nf__btn--ghost")) };
    }, { PROPS });
    if (width === 1280) {
      compare("404 band     vs page05 hero band", hero.band, built.band, ["backgroundColor", "color", "borderBottom"]);
      compare("404 row      vs page05 hero row", { ...hero.row, gap: hero.copy.gap }, built.row,
        ["paddingTop", "paddingBottom", "gap"]);
      compare("404 eyebrow  vs page05 eyebrow", hero.eyebrow, built.eyebrow, ["color", "fontFamily", "fontSize", "fontWeight"]);
      compare("404 title    vs page05 h1", hero.title, built.title, T);
      compare("404 body     vs page05 pitch", hero.pitch, built.pitch, ["color", "fontFamily", "fontSize", "fontWeight", "lineHeight"]);
      compare("404 primary  vs page05 primary button", hero.primary, built.primary,
        ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "height", "padding", "borderRadius"]);
      compare("404 ghost    vs page05 ghost button", hero.ghost, built.ghost,
        ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "height", "padding", "borderRadius", "borderTop"]);
      // The 404 title follows the built home hero title's size rule (the maintainer, 2026-11-18: Libron at 77/84 of page05).
      const home = await browser.newPage({ viewport: { width, height: 900 } });
      await home.goto(base + "/");
      const homeTitle = await home.evaluate(() => getComputedStyle(document.querySelector(".hero__title")).fontSize);
      report(homeTitle === built.title.fontSize, `404 title size ${built.title.fontSize} equals home hero title ${homeTitle} @ ${width}`);
      await home.close();
    }
    await p.close();
  }

  // page05 hero crops for the composites (1280 is the plate's own width).
  // The plate frame never reports the hero "stable" for an element
  // screenshot, and a full-page clip ~7800 px down paints blank. The plate's
  // iframe is 1280 wide at x=48, so widen the viewport to hold it, scroll the
  // hero into view and clip in viewport coordinates.
  await surf.setViewportSize({ width: 1400, height: 900 });
  let heroEl;
  for (const fr of surf.frames()) {
    const h = await fr.$("h1").catch(() => null);
    if (h && /^Sealed editions/.test(await h.textContent())) {
      heroEl = (await h.evaluateHandle((e) => e.parentElement.parentElement.parentElement)).asElement();
      break;
    }
  }
  if (!heroEl) throw new Error("page05 hero not found for the crop");
  // The plate animates, so Playwright never reports the hero "stable" for
  // scrollIntoView either: scroll the outer page to the hero's box by hand.
  const before = await heroEl.boundingBox();
  await surf.evaluate((y) => window.scrollBy(0, y), before.y - 20);
  await surf.waitForTimeout(800);
  const heroClip = await heroEl.boundingBox();
  await surf.screenshot({ path: join(OUT, "page05-hero-1280.png"), clip: heroClip });
  // A blank crop proves nothing: require the hero band's dark ground in it.
  const cropStats = await surf.evaluate(async (src) => {
    const i = new Image(); await new Promise((ok) => { i.onload = ok; i.src = src; });
    const c = new OffscreenCanvas(i.width, i.height); const x = c.getContext("2d"); x.drawImage(i, 0, 0);
    const d = x.getImageData(0, 0, i.width, i.height).data; let dark = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] + d[k + 1] + d[k + 2] < 200) dark++;
    return dark / (d.length / 4);
  }, "data:image/png;base64," + b64(join(OUT, "page05-hero-1280.png")));
  report(cropStats > 0.5, `page05 hero crop is not blank: ${(cropStats * 100).toFixed(1)}% dark pixels (want > 50%)`);

  // ---------- 4. og:image / twitter:image on every page ----------
  const site = readFileSync(join(WEB, "src/lib/site.ts"), "utf8");
  const origin = site.match(/origin:\s*"([^"]+)"/)[1].replace(/\/$/, "");
  const want = `${origin}/og/canon.png`;
  const pages = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".html")) pages.push(f); } };
  walk(DIST);
  const bad = pages.filter((f) => {
    const h = readFileSync(f, "utf8");
    return !h.includes(`<meta property="og:image" content="${want}">`) || !h.includes(`<meta name="twitter:image" content="${want}">`);
  });
  report(bad.length === 0, `og:image and twitter:image = ${want} on ${pages.length - bad.length}/${pages.length} built pages${bad.length ? ": missing in " + bad.map((f) => relative(DIST, f)).join(", ") : ""}`);
  report(readFileSync(join(DIST, "og/canon.png")).equals(readFileSync(join(WEB, "public/og/canon.png"))), "dist/og/canon.png equals public/og/canon.png");

  // Side-by-side composites: page05 hero | card, page05 hero | 404 @ 1280.
  const sbs = await browser.newPage({ viewport: { width: 2600, height: 1200 } });
  for (const [name, left, right, labels] of [
    ["card-sbs.png", "page05-hero-1280.png", null, ["Design: page05 hero @ 1280 (design-v2 surfaces)", "Built: public/og/canon.png (1200×630)"]],
    ["404-sbs.png", "page05-hero-1280.png", "404-1280.png", ["Design: page05 hero @ 1280 (design-v2 surfaces)", "Built: /404 via local Pages-rule server @ 1280"]],
  ]) {
    const rightFile = right ? join(OUT, right) : join(WEB, "public/og/canon.png");
    const png = await sbs.evaluate(async ({ l, r, labels }) => {
      const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
      const [a, b] = await Promise.all([load(l), load(r)]);
      const pad = 32, lab = 32, c = document.createElement("canvas");
      c.width = a.width + b.width + pad * 3; c.height = Math.max(a.height, b.height) + lab + pad * 2;
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = "#0f172a"; x.font = "600 18px system-ui";
      x.fillText(labels[0], pad, pad + 18); x.fillText(labels[1], pad * 2 + a.width, pad + 18);
      x.drawImage(a, pad, pad + lab); x.drawImage(b, pad * 2 + a.width, pad + lab);
      return c.toDataURL("image/png");
    }, { l: "data:image/png;base64," + b64(join(OUT, left)), r: "data:image/png;base64," + b64(rightFile), labels });
    writeFileSync(join(OUT, name), Buffer.from(png.split(",")[1], "base64"));
  }
} finally {
  await browser.close();
  if (preview) preview.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`composites: ${relative(WEB, OUT)}/{tile-sbs,card-sbs,404-sbs,404-1280,404-390}.png`);
if (failures.length) {
  console.error(`fidelity:plates: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("fidelity:plates: all checks passed");
