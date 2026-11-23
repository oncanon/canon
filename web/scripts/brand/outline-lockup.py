"""Outline the "canon" wordmark lockups into self-contained SVG artwork.

Identity rule 02: "The logo is artwork, never typed text. Ship the SVG
lockups." This turns Libron Bold's glyphs into plain <path> data placed at the
positions Chromium measured from the identity plate's own CSS (see
measure-lockup.mjs), so the shipped SVG has no <text> and no font dependency.

Run with fonttools + brotli from a venv outside the repo:

    python3 -m venv /tmp/canon-outline-venv
    /tmp/canon-outline-venv/bin/pip install fonttools brotli
    node scripts/brand/measure-lockup.mjs > /tmp/lockup-metrics.json
    /tmp/canon-outline-venv/bin/python -I scripts/brand/outline-lockup.py \
        /tmp/lockup-metrics.json src/components/brand/svg
"""
import json
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
FONT = HERE.parent.parent / "public/fonts/libron/Libron-Bold.woff2"

# Symbol paths, verbatim from the identity plate (viewBox 0 0 100 100).
SYMBOL = (
    '<path d="M12 24 L47 19 L47 81 L12 76 Z" fill="{leaf_l}" stroke="{leaf_l_stroke}" '
    'stroke-width="5" stroke-linejoin="round"/>'
    '<path d="M53 19 L88 24 L88 76 L53 81 Z" fill="{leaf_r}"/>'
    '<rect x="41" y="71" width="18" height="18" rx="3" fill="{chip}" stroke="{chip_stroke}" stroke-width="4"/>'
)

# Colourways, verbatim from the plate: light paper (Plate 1 A / UI lockup) and
# "On chrome" (the dark nav/hero band).
COLOURWAYS = {
    "paper": dict(leaf_l="#ffffff", leaf_l_stroke="#0f172a", leaf_r="#0f172a",
                  chip="#1d4ed8", chip_stroke="#ffffff", ink="#0f172a"),
    "chrome": dict(leaf_l="#0f172a", leaf_l_stroke="#f1f5f9", leaf_r="#f1f5f9",
                   chip="#60a5fa", chip_stroke="#0f172a", ink="#f1f5f9"),
}


def fmt(v):
    return f"{v:.3f}".rstrip("0").rstrip(".")


def word_path(font, m):
    upm = font["head"].unitsPerEm
    scale = m["spec"]["fs"] / upm
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    pen = SVGPathPen(glyphs, ntos=fmt)
    for c in m["chars"]:
        gname = cmap[ord(c["ch"])]
        # font units (y up) -> SVG px (y down), origin at the measured pen position
        tp = TransformPen(pen, (scale, 0, 0, -scale, c["x"], m["baseline"]))
        glyphs[gname].draw(tp)
    return pen.getCommands()


def build(name, m, colour, d):
    w, h = m["box"]["w"], m["box"]["h"]
    s = m["sym"]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" '
        f'width="{fmt(w)}" height="{fmt(h)}" role="img" aria-label="Canon">',
        f'<g transform="translate({fmt(s["x"])} {fmt(s["y"])}) scale({fmt(s["w"] / 100)})">'
        + SYMBOL.format(**colour) + "</g>",
        f'<path fill="{colour["ink"]}" d="{d}"/>',
    ]
    if m["rule"]:
        r = m["rule"]
        parts.append(f'<rect x="{fmt(r["x"])}" y="{fmt(r["y"])}" width="{fmt(r["w"])}" '
                     f'height="{fmt(r["h"])}" fill="{colour["ink"]}"/>')
    parts.append("</svg>")
    return "".join(parts) + "\n"


def main():
    metrics = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    font = TTFont(FONT)
    for name, m in metrics.items():
        d = word_path(font, m)
        for cw, colour in COLOURWAYS.items():
            f = out / f"lockup-{name}-{cw}.svg"
            f.write_text(build(name, m, colour, d))
            print(f"wrote {f} ({m['box']['w']:.2f}x{m['box']['h']:.2f})")


if __name__ == "__main__":
    main()
