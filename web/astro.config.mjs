// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // oncanon.com is the one host and the docs are the site: they live at the
  // root (the maintainer, 2026-11-18). The old /docs/ paths 301 to the root through
  // public/_redirects. `site` makes canonical, Open Graph and JSON-LD URLs
  // absolute.
  site: "https://oncanon.com",
  base: "/",
  // Off on purpose: Astro 7.4's HTML compressor drops whitespace that contains a
  // newline between text and an inline element, so "See\n  <a>Install</a>"
  // rendered as "SeeInstall" (~20 places across the guide, schemas, install,
  // quick-start, open-source, cli and canon-app pages). Uncompressed output keeps
  // the space; the size cost is a few KB of indentation on 8 static pages.
  compressHTML: false,
});
