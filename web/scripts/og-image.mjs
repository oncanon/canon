// Renders the site's social card and logo tile into public/og/:
//   canon.png           1200×630 Open Graph / Twitter image, from page05's hero
//   canon-tile-512.png  512×512 Identity Plate 2 tile at ×4, serif C (Organization.logo)
//
// Only page05 hero tokens and fonts already vendored in public/fonts; the
// wordmark is the shipped UI lockup SVG, never typed text. Runs offline:
// any request that isn't file: or data: fails the script.
//
// Usage: npm run og   (Playwright's Chromium, a devDependency already)
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const font = (p) => pathToFileURL(join(WEB, "public/fonts", p)).href;
const lockup = readFileSync(join(WEB, "src/components/brand/svg/lockup-ui-chrome.svg"), "utf8")
  .replace(/ width="[\d.]+" height="[\d.]+"/, ' height="44"');

const card = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Libron; font-weight: 700; src: url("${font("libron/Libron-Bold.woff2")}") format("woff2"); }
@font-face { font-family: Inter; font-weight: 400 700; src: url("${font("inter/Inter-latin-wght.woff2")}") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("${font("jetbrains-mono/JetBrainsMono-400.woff2")}") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 700; src: url("${font("jetbrains-mono/JetBrainsMono-700.woff2")}") format("woff2"); }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; }
/* page05 hero band: #1b2434, text #f1f5f9; the nav bar's #0f172a on top, its #293548 hairline. */
body { background: #1b2434; color: #f1f5f9; font-family: Inter, sans-serif; display: flex; flex-direction: column; }
.bar { height: 96px; padding: 0 72px; background: #0f172a; border-bottom: 1px solid #293548;
  display: flex; align-items: center; justify-content: space-between; }
.bar svg { display: block; }
.host { font-family: "JetBrains Mono", monospace; font-size: 22px; color: #93c5fd; }
.copy { flex: 1; padding: 0 72px; display: flex; flex-direction: column; justify-content: center; gap: 26px; }
/* page05 eyebrow 14px/600 #93c5fd and h1 Libron 700, lh .98, -0.02em; scaled for 1200px. */
.eyebrow { font-size: 26px; font-weight: 600; color: #93c5fd; }
h1 { font-family: Libron, serif; font-weight: 700; font-size: 104px; line-height: 0.98; letter-spacing: -0.02em; }
/* page05 terminal palette: #0b0f17 body, #475569 border, #9ca3af muted, #a7f3d0 proven. */
.term { margin: 0 72px 56px; padding: 16px 22px; background: #0b0f17; border: 1px solid #475569; border-radius: 6.4px;
  font-family: "JetBrains Mono", monospace; font-size: 22px; white-space: pre; color: #f1f5f9; }
.m { color: #9ca3af; } .p { color: #a7f3d0; font-weight: 700; }
</style>
<div class="bar">${lockup}<span class="host">oncanon.com</span></div>
<div class="copy">
  <span class="eyebrow">Deterministic · offline-first · fail-closed</span>
  <h1>Sealed editions<br>for agent work.</h1>
</div>
<div class="term"><span class="p">verified</span>  sha256 · md parity · anchors 1:1   <span class="m">exit</span> <span class="p">0</span></div>`;

// Plate 2 "Tile", the 128 px tile in Identity Plate 2, with the plate's own
// inline values (128 px, radius 23px, Libron 700 C at 87px, padding-bottom
// 5px, #0f172a / #ffffff), rendered at deviceScaleFactor 4 for 512×512.
// Rendering the 128 px markup at ×4, not 4× values at ×1, is what puts the C
// on the plate's pixel grid. No status dot: that belongs to the menu-bar
// template, not the logo. (The 16px one-stroke drawing in favicon.svg is for
// 16px only; Plate 2 sets the C in Libron at large sizes.)
// scripts/fidelity-plates.mjs diffs this against the plate pixel by pixel.
const tilePage = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Libron; font-weight: 700; src: url("${font("libron/Libron-Bold.woff2")}") format("woff2"); }
html,body{margin:0;background:transparent}
.t{width:128px;height:128px;border-radius:23px;background:#0f172a;color:#ffffff;display:flex;align-items:center;justify-content:center;
  font-family:Libron,serif;font-weight:700;font-size:87px;line-height:1;padding-bottom:5px;box-sizing:border-box}
</style><div class="t" aria-hidden="true">C</div>`;

// Renders each asset into outDir. inspect(name, page), when given, runs on the
// live page before it closes, so a check can read the card's computed styles.
// [file, html, CSS width, CSS height, transparent, deviceScaleFactor]
export const ASSETS = [["canon.png", card, 1200, 630, false, 1], ["canon-tile-512.png", tilePage, 128, 128, true, 4]];
export async function render(browser, outDir, inspect) {
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "canon-og-"));
  try {
    for (const [name, html, w, h, transparent, scale] of ASSETS) {
      const file = join(tmp, `${name}.html`);
      writeFileSync(file, html);
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
      const offsite = [];
      page.on("request", (r) => { if (!/^(file|data):/.test(r.url())) offsite.push(r.url()); });
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => document.fonts.ready);
      const missing = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "error").map((f) => f.family));
      if (missing.length) throw new Error(`fonts not loaded: ${missing.join(", ")}`);
      if (offsite.length) throw new Error(`off-host requests: ${offsite.join(", ")}`);
      await page.screenshot({ path: join(outDir, name), omitBackground: transparent });
      if (inspect) await inspect(name, page);
      await page.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const browser = await chromium.launch();
  try {
    await render(browser, join(WEB, "public/og"));
    for (const [name, , w, h, , scale] of ASSETS) console.log(`wrote public/og/${name} (${w * scale}×${h * scale})`);
  } finally {
    await browser.close();
  }
}
