// Reads Canon's doc/v1 build output (.canon/docs/, written by
// scripts/canon-docs.mjs build) for the pages Canon renders, and the edition
// for the footer. The fragment is returned as the raw file string: callers
// interpolate it with set:html and nothing else (no Markdown/HTML pass), so
// the built page carries Canon's bytes unchanged (checked by canon-docs check).
//
// CANON_DOCS_STAGE=anchors is the build's first Astro pass, which only exists
// to render the Astro-only pages whose heading ids become doc-set `external`
// anchors. Canon hasn't built yet then, so Canon pages render empty and the
// footer has no edition; that pass's output is thrown away.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CanonPage {
  id: string;
  path: string;
  title: string;
  description: string;
  files: { html: string; markdown: string };
  sha256: { html: string; markdown: string };
}
export interface CanonManifest {
  schema: "canon-doc-manifest/v1";
  edition: string;
  pages: CanonPage[];
}

export const ANCHOR_PASS = process.env.CANON_DOCS_STAGE === "anchors";
const OUT = resolve(process.cwd(), ".canon/docs");
const MANIFEST = join(OUT, ".well-known/canon/manifest.json");
export const MANIFEST_URL = "/.well-known/canon/manifest.json";

let cached: CanonManifest | null = null;
export function canonManifest(): CanonManifest | null {
  if (ANCHOR_PASS) return null;
  if (cached) return cached;
  if (!existsSync(MANIFEST)) throw new Error(`${MANIFEST} is missing: build Canon's pages first (npm run build does)`);
  cached = JSON.parse(readFileSync(MANIFEST, "utf8")) as CanonManifest;
  if (cached.schema !== "canon-doc-manifest/v1") throw new Error(`unexpected manifest schema ${cached.schema}`);
  return cached;
}

export function canonPage(id: string): { page: CanonPage | null; html: string } {
  const m = canonManifest();
  if (!m) return { page: null, html: "" };
  const page = m.pages.find((p) => p.id === id);
  if (!page) throw new Error(`Canon manifest has no page "${id}"`);
  return { page, html: readFileSync(join(OUT, page.files.html), "utf8") };
}
