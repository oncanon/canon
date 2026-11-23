// doc/v1 pages don't know about each other: a `ref` only names another page's id and,
// optionally, one of its anchors (src/doc/validate.mjs). This module is where "the other
// pages" exist — it loads every page a doc-set/v1 manifest lists, validates each one,
// and then resolves every collected ref against the whole set, so a page or anchor that
// doesn't exist fails the build here instead of shipping a dead link.
//
// It is also where a page id becomes the concrete href both renderers require
// (refHref), and where the two things Canon Web needs from a built edition come from:
// the published manifest at .well-known/canon/manifest.json (page list, titles,
// descriptions, per-file hashes, and the edition id for a footer line) and the sealed
// per-page Markdown Canon Web turns into llms.txt/llms-full.txt — concatenating that
// Markdown, in the manifest's reading order, is Canon Web's job, not this module's.
import { dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { canonicalBytes } from '../canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../hash.mjs';
import { BuildError, readRegularFile, writePacketDirectory } from '../packet/build.mjs';
import { CHECKSUMS_SCHEMA, TOOL } from '../policy.mjs';
import { checkArray, checkObject, checkString, isPlainObject, parseBoundedJsonText } from '../report/validate.mjs';
import { renderDocHtml } from './render-html.mjs';
import { renderDocMarkdown } from './render-markdown.mjs';
import { DOC_LIMITS, SLUG_PATTERN, DocValidationError, parseDocText, validateDocPage } from './validate.mjs';

export const DOC_SET_SCHEMA = 'doc-set/v1';
export const DOC_SET_MANIFEST_SCHEMA = 'canon-doc-manifest/v1';

export const DOC_SET_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  jsonDepth: 8,
  pages: 256,
  external: 64,
  anchorsPerExternal: 256,
});

// Flat filenames only (no "/", no ".."): a doc-set manifest's pages all live beside it,
// so resolving "source" is a plain join with nothing to escape.
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.doc\.json$/;
// One or more lowercase-kebab segments, each surrounded by slashes: "/cli/",
// "/guide/install/". No bare "/" (doc/v1 never names the site root — AGENTS.md keeps
// the home page Astro-only) and no trailing content after the final slash.
const PATH_PATTERN = /^\/(?:[a-z0-9][a-z0-9-]{0,63}\/){1,8}$/;

export class DocSetError extends Error {
  constructor(errors) {
    super(`doc-set/v1 build failed:\n${errors.map((e) => `  ${e.code} ${e.path}: ${e.message}`).join('\n')}`);
    this.name = 'DocSetError';
    this.errors = errors;
  }
}

function manifestCtx() {
  return { errors: [], schema: DOC_SET_SCHEMA, error(path, code, message) { this.errors.push({ path, code, message }); } };
}

function parseDocSetText(text) {
  return parseBoundedJsonText(text, {
    maxBytes: DOC_SET_LIMITS.manifestBytes, maxDepth: DOC_SET_LIMITS.jsonDepth,
    label: 'doc-set manifest', makeError: (errors) => new DocSetError(errors),
  });
}

// Shape only: schema tag, one well-formed, duplicate-free {id, path, source} per doc/v1
// page, and, optionally, one well-formed, duplicate-free {id, path, anchors} per
// external (non-doc/v1) page a ref may still legally name. A page id/path namespace is
// shared between `pages` and `external`: the same id or path claimed twice, in either
// list, is a duplicate. Whether a page's own id matches the manifest's claim, and
// whether refs resolve (including against `external`), needs the pages loaded —
// checked by loadDocSet, after this passes.
function validateDocSetManifest(value) {
  const ctx = manifestCtx();
  if (!checkObject(ctx, '', value, ['schema', 'pages'], ['external'])) {
    if (!isPlainObject(value)) throw new DocSetError(ctx.errors);
  }
  if (value.schema !== DOC_SET_SCHEMA) ctx.error('/schema', 'schema-version', `expected "${DOC_SET_SCHEMA}"`);

  const ids = new Set();
  const paths = new Set();
  const claimId = (p, id) => {
    if (ids.has(id)) ctx.error(`${p}/id`, 'duplicate-id', `page id "${id}" repeated`);
    ids.add(id);
  };
  const claimPath = (p, path) => {
    if (paths.has(path)) ctx.error(`${p}/path`, 'duplicate-path', `path "${path}" repeated`);
    paths.add(path);
  };

  if (checkArray(ctx, '/pages', value.pages, { min: 1, max: DOC_SET_LIMITS.pages })) {
    value.pages.forEach((entry, i) => {
      const p = `/pages/${i}`;
      if (!checkObject(ctx, p, entry, ['id', 'path', 'source'])) return;
      if (checkString(ctx, `${p}/id`, entry.id, { pattern: SLUG_PATTERN, max: 64 })) claimId(p, entry.id);
      if (checkString(ctx, `${p}/path`, entry.path, { pattern: PATH_PATTERN, max: 200 })) claimPath(p, entry.path);
      checkString(ctx, `${p}/source`, entry.source, { pattern: SOURCE_PATTERN, max: 160 });
    });
  }

  if (Object.hasOwn(value, 'external') && checkArray(ctx, '/external', value.external, { max: DOC_SET_LIMITS.external })) {
    value.external.forEach((entry, i) => {
      const p = `/external/${i}`;
      if (!checkObject(ctx, p, entry, ['id', 'path', 'anchors'])) return;
      if (checkString(ctx, `${p}/id`, entry.id, { pattern: SLUG_PATTERN, max: 64 })) claimId(p, entry.id);
      if (checkString(ctx, `${p}/path`, entry.path, { pattern: PATH_PATTERN, max: 200 })) claimPath(p, entry.path);
      if (checkArray(ctx, `${p}/anchors`, entry.anchors, { max: DOC_SET_LIMITS.anchorsPerExternal })) {
        const anchors = new Set();
        entry.anchors.forEach((anchor, j) => {
          const ap = `${p}/anchors/${j}`;
          if (checkString(ctx, ap, anchor, { pattern: SLUG_PATTERN, max: 64 })) {
            if (anchors.has(anchor)) ctx.error(ap, 'duplicate-id', `anchor "${anchor}" repeated`);
            anchors.add(anchor);
          }
        });
      }
    });
  }

  if (ctx.errors.length > 0) throw new DocSetError(ctx.errors);
  return value;
}

async function readUtf8(absPath, maxBytes, label) {
  const bytes = await readRegularFile(absPath, maxBytes, label);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BuildError('doc-encoding', `${label} must be valid UTF-8`);
  }
}

// Loads and validates every page a doc-set/v1 manifest lists, then resolves every ref
// collected across them (nav.next, seeAlso, and inline refs) against the whole set —
// its doc/v1 pages, plus any `external` pages the manifest declares (non-doc/v1 pages,
// such as the Astro-only CLI reference, that a ref may still legally name: see the
// "external" comment below). Returns the resolved pages and the refHref(ref) callback
// both renderers require. Throws DocSetError with every problem found, not just the first.
export async function loadDocSet(manifestPath) {
  const abs = resolve(manifestPath);
  const manifestText = await readUtf8(abs, DOC_SET_LIMITS.manifestBytes, 'doc-set manifest');
  const manifest = validateDocSetManifest(parseDocSetText(manifestText));
  const baseDir = await realpath(dirname(abs));

  // `external`: pages this doc set links to but does not build (src/doc/docset.mjs
  // never reads or renders them). Its `anchors` list is the full set of in-page ids a
  // ref may target on that page — the same role ctx.ids plays for a doc/v1 page, just
  // supplied instead of derived, because this module has no way to parse a page it
  // doesn't own. The manifest's producer (Canon Web) is expected to generate this list
  // mechanically from its own build (the heading/anchor ids actually present in that
  // page's rendered HTML), not transcribe it by hand: a hand-typed list silently goes
  // stale the moment the external page's headings change, which is exactly the class of
  // dead link this whole mechanism exists to catch.
  const external = new Map(
    (manifest.external ?? []).map((entry) => [entry.id, { path: entry.path, anchors: new Set(entry.anchors.map((a) => a.toLowerCase())) }]),
  );

  const pages = new Map();
  const errors = [];
  for (const entry of manifest.pages) {
    const srcAbs = join(baseDir, entry.source);
    try {
      const srcText = await readUtf8(srcAbs, DOC_LIMITS.docBytes, `doc-set page ${entry.id}`);
      const { doc, ctx } = validateDocPage(parseDocText(srcText, { label: entry.id }));
      if (doc.id !== entry.id) {
        errors.push({ path: `/pages/${entry.id}`, code: 'id-mismatch', message: `${entry.source} declares id "${doc.id}", but the manifest lists it as "${entry.id}"` });
        continue;
      }
      pages.set(entry.id, { doc, ctx, path: entry.path });
    } catch (err) {
      if (err instanceof DocValidationError) {
        errors.push(...err.errors.map((e) => ({ ...e, path: `${entry.id}${e.path}` })));
        continue;
      }
      throw err;
    }
  }
  if (errors.length > 0) throw new DocSetError(errors);

  for (const [id, page] of pages) {
    for (const ref of page.ctx.pageRefs) {
      const target = pages.get(ref.page);
      if (target) {
        if (ref.anchor && !target.ctx.ids.has(ref.anchor.toLowerCase())) {
          errors.push({ path: `${id}${ref.path}`, code: 'unknown-anchor', message: `ref names anchor "${ref.anchor}" on page "${ref.page}", which has no such id` });
        }
        continue;
      }
      const ext = external.get(ref.page);
      if (!ext) {
        errors.push({ path: `${id}${ref.path}`, code: 'unknown-page', message: `ref names page "${ref.page}", which is not in this doc set (and not declared external)` });
        continue;
      }
      if (ref.anchor && !ext.anchors.has(ref.anchor.toLowerCase())) {
        errors.push({ path: `${id}${ref.path}`, code: 'unknown-anchor', message: `ref names anchor "${ref.anchor}" on external page "${ref.page}", which declares no such anchor` });
      }
    }
  }
  if (errors.length > 0) throw new DocSetError(errors);

  const refHref = (ref) => {
    const target = pages.get(ref.page) ?? external.get(ref.page);
    return `${target.path}${ref.anchor ? `#${ref.anchor}` : ''}`;
  };
  return { manifest, pages, external, refHref };
}

function trimSlashes(path) {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

// Renders every page (HTML fragment + its Markdown twin) and assembles the published
// manifest Canon Web serves at .well-known/canon/manifest.json: the page list in the
// manifest's own reading order, each page's title and description (everything Canon Web
// needs to build llms.txt without re-parsing the sealed Markdown), per-file hashes, and
// an edition id — the content id of this identity itself, so the same doc set always
// reduces to the same edition, and a footer line can show it without a database.
// checksums.json sits beside it, in the same shape every other Canon build writes
// (CHECKSUMS_SCHEMA), so src/doc/verify.mjs can re-derive and check it independently.
export function assembleDocSet({ pages, refHref }) {
  const output = new Map();
  const pageList = [];
  for (const [id, { doc, path }] of pages) {
    const htmlBytes = Buffer.from(renderDocHtml(doc, { refHref }), 'utf8');
    const mdBytes = Buffer.from(renderDocMarkdown(doc, { refHref, pagePath: path }), 'utf8');
    const dir = trimSlashes(path);
    output.set(`${dir}/index.html`, htmlBytes);
    output.set(`${dir}/index.md`, mdBytes);
    pageList.push({
      id, path, title: doc.title, description: doc.description,
      files: { html: `${dir}/index.html`, markdown: `${dir}/index.md` },
      sha256: { html: sha256Hex(htmlBytes), markdown: sha256Hex(mdBytes) },
    });
  }

  const identity = { schema: DOC_SET_MANIFEST_SCHEMA, build: { tool: TOOL.name, version: TOOL.version }, pages: pageList };
  const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
  const manifest = { ...identity, edition: contentId };
  const manifestBytes = canonicalBytes(manifest);
  const checksums = {
    schema: CHECKSUMS_SCHEMA,
    algorithm: 'sha256',
    contentId,
    manifestSha256: sha256Hex(manifestBytes),
    files: Object.fromEntries(pageList.flatMap((p) => [[p.files.html, p.sha256.html], [p.files.markdown, p.sha256.markdown]])),
  };
  output.set('.well-known/canon/manifest.json', manifestBytes);
  output.set('.well-known/canon/checksums.json', canonicalBytes(checksums));

  return { contentId, edition: contentId, manifest, checksums, output };
}

export async function buildDocSet({ manifestPath, outDir }) {
  const { pages, refHref } = await loadDocSet(manifestPath);
  const assembled = assembleDocSet({ pages, refHref });
  const written = outDir ? await writePacketDirectory(assembled.output, outDir) : null;
  return { ...assembled, outDir: written };
}
