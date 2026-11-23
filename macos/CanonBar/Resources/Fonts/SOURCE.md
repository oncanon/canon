# Canon.app bundled fonts

All OFL-1.1. Registered for the app process only (`FontRegistrar`, `.process` scope); nothing
is installed into the user's Font Book and nothing is fetched at runtime.

The design plates (`Canon — Identity & Surfaces`, pages 06/07/10) name three families:
`font-family: Inter, …` for UI text, `'JetBrains Mono', monospace` for paths/IDs/shortcuts, and
`Libron, 'Iowan Old Style', …` (weight 700) for serif headings. Weights used by the CSS:
Inter 400/500/600/700, JetBrains Mono 400/700, Libron 700.

| File | Source | Archive SHA-256 |
|---|---|---|
| `Inter-{Regular,Medium,SemiBold,Bold}.ttf` | https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip → `extras/ttf/` (Inter 4.001, text optical size) | `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e` |
| `JetBrainsMono-{Regular,Bold}.ttf` | https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip → `fonts/ttf/` | `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf` |
| `Libron-*.otf` | decompressed from `src/presentation/fonts/libron/*.woff2` (Libron v0.25, see that folder's `SOURCE.md`) | — |

Licenses: `Inter-OFL.txt`, `JetBrainsMono-OFL.txt`, `src/presentation/fonts/libron/OFL-1.1.txt`.
