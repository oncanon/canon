// Measures the wordmark lockups exactly as the "Canon — Identity" plate lays
// them out (Plate 1: "A · Display lockup, on the rule" and "UI lockup, no
// rule"), using the bundled Libron Bold. The CSS below is copied verbatim
// from the plate's inline styles. Output feeds outline-lockup.py, which turns
// the glyphs into SVG paths at these positions.
//
//   node scripts/brand/measure-lockup.mjs > /tmp/lockup-metrics.json
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

// Inlined as a data URL: about:blank pages may not load file:// fonts.
const font = "data:font/woff2;base64," +
  readFileSync(new URL("../../public/fonts/libron/Libron-Bold.woff2", import.meta.url)).toString("base64");

// [name, symbol px, gap px, font px, padding-bottom px, rule {mt, h} | null]
const SPECS = {
  // Plate 1 A: svg 86, gap 20, 84px, pb 7; rule height 3px, margin-top 13px.
  display: { sym: 86, gap: 20, fs: 84, pb: 7, rule: { mt: 13, h: 3 } },
  // Plate 1 "UI lockup, no rule": svg 35, gap 8, 34px, pb 3.
  ui: { sym: 35, gap: 8, fs: 34, pb: 3, rule: null },
};

const html = (s) => `<!doctype html><html><head><style>
@font-face{font-family:Libron;src:url("${font}") format("woff2");font-weight:700}
body{margin:0;padding:20px}
</style></head><body>
<div id="lk" style="display:inline-flex;flex-direction:column;align-items:stretch">
  <div style="display:flex;align-items:center;gap:${s.gap}px">
    <svg id="sym" width="${s.sym}" height="${s.sym}" viewBox="0 0 100 100"></svg>
    <span id="w" style="font-family:Libron;font-weight:700;font-size:${s.fs}px;line-height:0.9;letter-spacing:-0.01em;padding-bottom:${s.pb}px">canon<span id="bl" style="display:inline-block;width:0;height:0;vertical-align:baseline"></span></span>
  </div>
  ${s.rule ? `<span id="rule" style="display:block;height:${s.rule.h}px;margin-top:${s.rule.mt}px"></span>` : ""}
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const out = {};
for (const [name, s] of Object.entries(SPECS)) {
  await page.setContent(html(s));
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => document.fonts.check('700 20px Libron'));
  if (!loaded) throw new Error("Libron Bold did not load");
  out[name] = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const lk = r(document.getElementById("lk"));
    const rel = (b) => ({ ...b, x: b.x - lk.x, y: b.y - lk.y });
    const w = document.getElementById("w");
    const text = w.firstChild;
    const chars = [];
    for (let i = 0; i < text.length; i++) {
      const range = document.createRange();
      range.setStart(text, i); range.setEnd(text, i + 1);
      const b = range.getBoundingClientRect();
      chars.push({ ch: text.data[i], x: b.x - lk.x });
    }
    const rule = document.getElementById("rule");
    return {
      box: { w: lk.w, h: lk.h },
      sym: rel(r(document.getElementById("sym"))),
      word: rel(r(w)),
      baseline: document.getElementById("bl").getBoundingClientRect().y - lk.y,
      chars,
      rule: rule ? rel(r(rule)) : null,
    };
  });
  out[name].spec = s;
}
await browser.close();
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
