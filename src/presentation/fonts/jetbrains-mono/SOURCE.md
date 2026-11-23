# JetBrains Mono font source

- Project: https://github.com/JetBrains/JetBrainsMono
- Distribution: the `@fontsource/jetbrains-mono` npm package, latin subset, as exported
  in the Canon 2.1 design reference (`folio-2.1-design-reference/assets/fonts/`).
- Faces: 400 normal (`JetBrainsMono-400.woff2`) and 700 normal (`JetBrainsMono-700.woff2`).
- SHA-256:
  - `JetBrainsMono-400.woff2`: `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb`
  - `JetBrainsMono-700.woff2`: `d0d4e818808f2a0ba39b2b09d1989366f63494e295f003c7ef436697378507e8`
- License: SIL Open Font License 1.1; see `LICENSE-jetbrains-mono.txt`.

The two WOFF2 files are vendored unchanged. Only render-policy/2 packets embed them,
as content-addressed packet assets loaded from the packet's own origin; no runtime
network request leaves the review surface.
