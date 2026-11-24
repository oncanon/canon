// Facts about the site that every page's <head> and JSON-LD use. Everything
// here is sourced: the name and pitch from page05 (the maintainer's chosen hero), the
// requirement from the Install page (repo package.json "engines": ">=22"),
// the repository from the footer link, the licence from the maintainer's decision of
// 2026-11-18 (Apache-2.0, as the root LICENSE states). Nothing here is a
// rating, price or version: package.json is version 0.1.0, so none is claimed.
export const SITE = {
  name: "Canon",
  origin: "https://oncanon.dev",
  pitch:
    "Canon compiles structured JSON and bundled evidence into an immutable pair: a calm HTML publication for people and a byte-verified Markdown file for agents — fingerprinted, content-addressed, re-hashed on every read.",
  repository: "https://github.com/oncanon/canon",
  requirements: "Node.js 22 or newer",
  /** SPDX Apache-2.0, as the canonical licence URL schema.org expects. */
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  /** 1200×630, rendered by scripts/og-image.mjs from page05's hero. */
  ogImage: { path: "/og/canon.png", width: 1200, height: 630, alt: "Canon: sealed editions for agent work." },
  /** 512×512 PNG of Identity Plate 2's 128 px tile at ×4, for Organization.logo. */
  logo: "/og/canon-tile-512.png",
} as const;

export const abs = (path: string): string => new URL(path, SITE.origin).href;
