# Canon lockups for render-policy/2

render-policy/2 editions draw the Canon lockup in two brand slots:

- `lockup-ui.svg`: the UI lockup in the masthead (no rule);
- `lockup-display.svg`: the display lockup in the colophon, on the 2 px rule.

Both files are optional and are not shipped yet: they are to be generated as outlined
SVG from the Canon 2.1 design reference. While a file is absent its slot carries only
the visually hidden text "Canon"; nothing is drawn or typed in its place.

A present file is parsed by `src/render/lockup.mjs` and re-serialised from the parse.
Only `svg`, `g`, `rect`, `line`, `path`, `circle`, `polygon`, `polyline`, `ellipse`,
`text` and `tspan` with presentation and geometry attributes are accepted (no `style`,
`id`, `class`, `href`, event handlers, comments, entities other than the five XML ones,
or `url(...)`). Anything else fails the build with `unsafe-lockup`. The lockup bytes
become part of `index.html`, so adding or changing a file changes new content IDs.
