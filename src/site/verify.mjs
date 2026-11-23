// Independent site-bundle/v1 verifier (docs/projects/interactive-sitrep-contract.md, revision 4).
//
// Deliberately does not import the builder, renderer, or shared canonical-JSON
// module: it re-derives canonical bytes, digests, and the content ID from the
// bundle alone, checks P2 (no scripts/forms/controls/inline styles/unsafe URLs),
// P7 (HTML/Markdown/manifest anchor parity per page), P9 (digest/inventory/canonical
// JSON integrity), and P14 (question -> options -> recommendation -> evidence order
// in both HTML and Markdown).
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { decodeHtmlAttr, inspectHtmlDocument, scanCssPolicy, verifyPacket } from '../packet/verify.mjs';

const LIMITS = { files: 1024, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, manifestBytes: 1024 * 1024, maxChars: 10000 };
const MEDIA = {
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
};

const REF = '[A-Za-z][A-Za-z0-9-]{0,63}';
const REF_RE = new RegExp(`^${REF}$`);
const KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;
const PATH_RULES = [
  { re: /^index\.html$/, role: 'entry' },
  { re: /^index\.md$/, role: 'report' },
  { re: new RegExp(`^area/${REF}/index\\.html$`), role: 'page' },
  { re: new RegExp(`^area/${REF}/index\\.md$`), role: 'report' },
  { re: new RegExp(`^area/${REF}/project/${REF}/index\\.html$`), role: 'page' },
  { re: new RegExp(`^area/${REF}/project/${REF}/index\\.md$`), role: 'report' },
  { re: new RegExp(`^item/${REF}/index\\.html$`), role: 'page' },
  { re: new RegExp(`^item/${REF}/index\\.md$`), role: 'report' },
  { re: /^assets\/([0-9a-f]{64})\.css$/, role: 'asset' },
  { re: /^assets\/([0-9a-f]{64})\.woff2$/, role: 'asset' },
  { re: /^evidence\/([0-9a-f]{64})\.(txt|csv|json)$/, role: 'evidence' },
];
const CONTROL_FILES = new Set(['manifest.json', 'checksums.json']);
const ALLOWED_TOP_DIRS = new Set(['area', 'item', 'assets', 'evidence']);
const HEX64 = /^[0-9a-f]{64}$/;
const CONTENT_ID = /^sha256-[0-9a-f]{64}$/;
const ANCHOR_ID = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
// Element anchor prefixes that belong to siteAnchors(input).
const ELEMENT_ANCHOR_RE = /^(?:a-|i-|d-|q-|g-|ev-|f-|r-|req-|cmp-|tbl-|chart-|diagram-|code-|cap-|pv-)/i;

function isAllowedBlockSubId(id, expectedSet) {
  let m;
  if ((m = id.match(/^((?:f|diagram|cmp|req)-.+)-(?:t|ev)$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^(chart-.+)-(?:t|ev|cap)$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^cap-(chart-.+)$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^(cmp-.+)-(?:left|right)-code$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^(req-.+)-sc$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^(r-.+)-t$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^(tbl-.+)-cap$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^(code-.+)-(?:title|L\d+)$/))) return expectedSet.has(m[1]);
  if ((m = id.match(/^pv-(.+)$/))) return expectedSet.has(`ev-${m[1]}`);
  return false;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new Error(`unsupported ${typeof value}`);
}

const foldKey = (p) => p.normalize('NFKC').toLowerCase().normalize('NFKC');

function exactKeys(obj, keys) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

class Findings {
  constructor() { this.errors = []; }
  add(code, path, message) { this.errors.push({ code, path, message }); }
}

async function walk(root, findings) {
  const found = new Map();
  const dirs = new Set();
  let total = 0;
  async function visit(dirAbs, rel, depth) {
    let entries;
    try {
      entries = await readdir(dirAbs);
    } catch (err) {
      findings.add('unreadable', rel || '.', err.code ?? err.message);
      return;
    }
    for (const name of entries.sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      const abs = join(dirAbs, name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        findings.add('symlink', relPath, 'symbolic links are not allowed in a site bundle');
      } else if (st.isDirectory()) {
        dirs.add(relPath);
        if (depth === 0 && !ALLOWED_TOP_DIRS.has(name)) {
          findings.add('unexpected-directory', relPath, 'site bundles contain only area/, item/, assets/, and evidence/ directories');
        } else if (depth > 3) {
          findings.add('unexpected-directory', relPath, 'directory nesting exceeds site-bundle/v1 depth');
        } else {
          await visit(abs, relPath, depth + 1);
        }
      } else if (!st.isFile()) {
        findings.add('special-file', relPath, 'device, FIFO, or socket in site bundle');
      } else {
        total += st.size;
        found.set(relPath, { abs, size: st.size });
      }
    }
  }
  await visit(root, '', 0);
  return { found, dirs, total };
}

function checkPathCollisions(paths, findings, where) {
  const seen = new Map();
  for (const p of paths) {
    if (p.normalize('NFC') !== p) findings.add('unicode-normalization', p, `${where} path is not NFC`);
    const key = foldKey(p);
    if (seen.has(key)) findings.add('path-collision', p, `${where} path collides with ${JSON.stringify(seen.get(key))} under case/Unicode folding`);
    else seen.set(key, p);
  }
}

async function readJsonFile(abs, name, findings) {
  let bytes;
  try {
    bytes = await readFile(abs);
  } catch {
    findings.add('missing-file', name, 'required control file is missing');
    return null;
  }
  if (bytes.length > LIMITS.manifestBytes) {
    findings.add('limit', name, `${bytes.length} bytes exceeds ${LIMITS.manifestBytes}`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    findings.add('malformed-json', name, err.message);
    return null;
  }
  if (canonical(value) !== bytes.toString('utf8')) {
    findings.add('not-canonical', name, 'bytes are not the canonical JSON serialization (duplicate keys, ordering, or whitespace)');
  }
  return { value, bytes };
}

function checkManifestShape(m, findings) {
  const keys = ['schema', 'entry', 'agentEntry', 'site', 'pages', 'anchors', 'decisions', 'files', 'evidence', 'build', 'contentId'];
  if (!exactKeys(m, keys)) {
    findings.add('schema', 'manifest.json', `manifest must have exactly ${keys.join(', ')}`);
  }
  if (m.schema !== 'site-bundle/v1') findings.add('schema-version', 'manifest.json#/schema', `expected site-bundle/v1, found ${JSON.stringify(m.schema)}`);
  if (m.entry !== 'index.html') findings.add('entry', 'manifest.json#/entry', 'entry point must be index.html');
  if (!exactKeys(m.agentEntry, ['path', 'anchors']) || m.agentEntry.path !== 'index.md' || m.agentEntry.anchors !== 'reference-definitions/1') {
    findings.add('agent-entry', 'manifest.json#/agentEntry', 'agentEntry must be {"path":"index.md","anchors":"reference-definitions/1"}');
  }
  if (!CONTENT_ID.test(m.contentId ?? '')) findings.add('content-id', 'manifest.json#/contentId', 'malformed content ID');

  const siteKeys = ['schema', 'title', 'edition', 'registry', 'sourceSha256', ...(Object.hasOwn(m.site ?? {}, 'publication') ? ['publication'] : [])];
  const pub = m.site?.publication;
  const pubOk = pub === undefined || (pub !== null && typeof pub === 'object' && !Array.isArray(pub)
    && Object.keys(pub).every((k) => ['classification', 'dataOrigin'].includes(k))
    && (pub.classification === undefined || ['public', 'private-review', 'confidential'].includes(pub.classification))
    && (pub.dataOrigin === undefined || ['synthetic', 'production'].includes(pub.dataOrigin)));
  if (!exactKeys(m.site, siteKeys)
    || !pubOk
    || m.site.schema !== 'site-input/v1'
    || typeof m.site.title !== 'string' || !m.site.title
    || !HEX64.test(m.site.sourceSha256 ?? '')
    || !exactKeys(m.site.edition, ['editionId', 'editionDigest', 'observedAt', 'coverage'])
    || !HEX64.test(m.site.edition.editionDigest ?? '')
    || !exactKeys(m.site.edition.coverage, ['from', 'to'])
    || !exactKeys(m.site.registry, ['version', 'sha256'])
    || !HEX64.test(m.site.registry.sha256 ?? '')) {
    findings.add('schema', 'manifest.json#/site', 'site metadata is malformed');
  }
  if (!exactKeys(m.build, ['tool', 'version', 'renderPolicy', 'securityPolicy'])) {
    findings.add('schema', 'manifest.json#/build', 'build metadata is malformed');
  }

  if (!Array.isArray(m.files)) {
    findings.add('schema', 'manifest.json#/files', 'files must be an array');
    return [];
  }
  if (m.files.length > LIMITS.files) findings.add('limit', 'manifest.json#/files', `more than ${LIMITS.files} files`);

  const files = [];
  let previous = null;
  m.files.forEach((f, i) => {
    const where = `manifest.json#/files/${i}`;
    if (!exactKeys(f, ['path', 'role', 'mediaType', 'bytes', 'sha256']) || typeof f.path !== 'string') {
      findings.add('schema', where, 'file entry must have exactly path, role, mediaType, bytes, sha256');
      return;
    }
    const rule = PATH_RULES.find((r) => r.re.test(f.path));
    if (!rule) findings.add('unsafe-path', where, `path ${JSON.stringify(f.path)} is not a canonical site-bundle/v1 path`);
    else if (rule.role !== f.role) findings.add('schema', where, `role ${JSON.stringify(f.role)} does not match path`);
    const ext = f.path.slice(f.path.lastIndexOf('.') + 1);
    if (MEDIA[ext] !== f.mediaType) findings.add('media-type', where, `media type ${JSON.stringify(f.mediaType)} does not match .${ext}`);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > LIMITS.fileBytes) findings.add('schema', where, 'bytes must be a non-negative integer within limits');
    if (!HEX64.test(f.sha256)) findings.add('schema', where, 'sha256 must be 64 lowercase hex digits');
    const m2 = rule && f.path.match(rule.re);
    if (m2 && m2[1] && m2[1] !== f.sha256) findings.add('fingerprint', where, 'fingerprinted file name does not match its declared digest');
    if (previous !== null) {
      const order = Buffer.compare(Buffer.from(previous), Buffer.from(f.path));
      if (order === 0) findings.add('duplicate-path', where, `duplicate canonical path ${JSON.stringify(f.path)}`);
      else if (order > 0) findings.add('inventory-order', where, 'inventory is not sorted by path bytes');
    }
    previous = f.path;
    files.push(f);
  });
  checkPathCollisions(files.map((f) => f.path), findings, 'manifest');
  const byPath = new Map(files.map((f) => [f.path, f]));

  const pageIds = new Set();
  const pageHtmlPaths = new Set();
  const pageMdPaths = new Set();
  if (!Array.isArray(m.pages) || m.pages.length === 0) {
    findings.add('schema', 'manifest.json#/pages', 'pages must be a non-empty array');
  } else {
    m.pages.forEach((p, i) => {
      const where = `manifest.json#/pages/${i}`;
      if (!exactKeys(p, ['id', 'html', 'markdown', 'title', 'parent']) || typeof p.id !== 'string' || typeof p.title !== 'string' || !p.title) {
        findings.add('schema', where, 'page entry is malformed');
        return;
      }
      if (pageIds.has(p.id)) findings.add('duplicate-page', where, `duplicate page id ${JSON.stringify(p.id)}`);
      const expectedHtml = p.id === '' ? 'index.html' : `${p.id}/index.html`;
      const expectedMd = p.id === '' ? 'index.md' : `${p.id}/index.md`;
      if (p.html !== expectedHtml || p.markdown !== expectedMd) findings.add('schema', where, 'page html/markdown paths do not match page id');
      if (!byPath.has(p.html)) findings.add('missing-file', where, `page HTML ${p.html} is not in files inventory`);
      if (!byPath.has(p.markdown)) findings.add('missing-file', where, `page Markdown ${p.markdown} is not in files inventory`);
      pageIds.add(p.id);
      pageHtmlPaths.add(p.html);
      pageMdPaths.add(p.markdown);
    });
    for (const p of m.pages) {
      if (p.id === '' && p.parent !== null) findings.add('schema', 'manifest.json#/pages', 'portfolio page must have parent null');
      if (p.id !== '' && !pageIds.has(p.parent)) findings.add('schema', 'manifest.json#/pages', `page ${JSON.stringify(p.id)} has unknown parent ${JSON.stringify(p.parent)}`);
    }
  }
  // Every entry/page/report file in manifest.files must belong to a declared page in manifest.pages (F6).
  for (const f of files) {
    if ((f.role === 'entry' || f.role === 'page') && !pageHtmlPaths.has(f.path)) {
      findings.add('unlisted-page', f.path, `HTML file ${JSON.stringify(f.path)} in manifest.files is not listed in manifest.pages`);
    }
    if (f.role === 'report' && !pageMdPaths.has(f.path)) {
      findings.add('unlisted-page', f.path, `Markdown file ${JSON.stringify(f.path)} in manifest.files is not listed in manifest.pages`);
    }
  }

  const seenAnchors = new Map(); // lowercase -> { anchor, page, kind }
  if (!Array.isArray(m.anchors)) {
    findings.add('schema', 'manifest.json#/anchors', 'anchors must be an array');
  } else {
    m.anchors.forEach((a, i) => {
      const where = `manifest.json#/anchors/${i}`;
      if (!exactKeys(a, ['anchor', 'page', 'kind']) || !ANCHOR_ID.test(a.anchor ?? '') || !pageIds.has(a.page) || typeof a.kind !== 'string') {
        findings.add('schema', where, 'anchor entry is malformed or names an unknown page');
        return;
      }
      const key = a.anchor.toLowerCase();
      if (seenAnchors.has(key)) findings.add('duplicate-anchor', where, `duplicate anchor ${JSON.stringify(a.anchor)}`);
      seenAnchors.set(key, a);
    });
  }

  if (!Array.isArray(m.decisions)) {
    findings.add('schema', 'manifest.json#/decisions', 'decisions must be an array');
  } else {
    const seenDecRefs = new Set();
    const seenQRefs = new Set();
    const expectedDecAnchors = new Set(
      (Array.isArray(m.anchors) ? m.anchors : []).filter((a) => a.kind === 'decision').map((a) => a.anchor),
    );
    const expectedQAnchors = new Set(
      (Array.isArray(m.anchors) ? m.anchors : []).filter((a) => a.kind === 'question').map((a) => a.anchor),
    );
    const declaredDecAnchors = new Set();
    const declaredQAnchors = new Set();

    m.decisions.forEach((d, i) => {
      const where = `manifest.json#/decisions/${i}`;
      if (!exactKeys(d, ['decisionRef', 'kind', 'page', 'anchor', 'questions'])
        || !REF_RE.test(d.decisionRef ?? '')
        || !KIND_RE.test(d.kind ?? '')
        || !pageIds.has(d.page) || !d.page.startsWith('item/')
        || d.anchor !== `d-${d.decisionRef}`
        || !Array.isArray(d.questions) || d.questions.length === 0) {
        findings.add('schema', where, 'decision entry is malformed');
        return;
      }
      const dKey = d.decisionRef.toLowerCase();
      if (seenDecRefs.has(dKey)) findings.add('schema', where, `duplicate decisionRef ${JSON.stringify(d.decisionRef)}`);
      seenDecRefs.add(dKey);
      const aEntry = seenAnchors.get(d.anchor.toLowerCase());
      if (!aEntry || aEntry.anchor !== d.anchor || aEntry.page !== d.page || aEntry.kind !== 'decision') {
        findings.add('schema', where, `decision anchor ${JSON.stringify(d.anchor)} does not match manifest.anchors on ${d.page}`);
      }
      declaredDecAnchors.add(d.anchor);

      d.questions.forEach((q, qi) => {
        const qWhere = `${where}/questions/${qi}`;
        if (!exactKeys(q, ['questionRef', 'anchor', 'optionRefs', 'freeText'])
          || !REF_RE.test(q.questionRef ?? '')
          || q.anchor !== `q-${q.questionRef}`
          || !Array.isArray(q.optionRefs)
          || !q.optionRefs.every((o) => typeof o === 'string' && REF_RE.test(o))
          || new Set(q.optionRefs.map((o) => o.toLowerCase())).size !== q.optionRefs.length
          || !exactKeys(q.freeText, ['allowed', 'maxChars'])
          || typeof q.freeText.allowed !== 'boolean'
          || (q.freeText.allowed
            ? (!Number.isSafeInteger(q.freeText.maxChars) || q.freeText.maxChars < 1 || q.freeText.maxChars > LIMITS.maxChars)
            : q.freeText.maxChars !== null)
          || (q.optionRefs.length < 2 && !q.freeText.allowed)) {
          findings.add('schema', qWhere, 'question entry is malformed');
          return;
        }
        const qKey = q.questionRef.toLowerCase();
        if (seenQRefs.has(qKey)) findings.add('schema', qWhere, `duplicate questionRef ${JSON.stringify(q.questionRef)}`);
        seenQRefs.add(qKey);
        const qaEntry = seenAnchors.get(q.anchor.toLowerCase());
        if (!qaEntry || qaEntry.anchor !== q.anchor || qaEntry.page !== d.page || qaEntry.kind !== 'question') {
          findings.add('schema', qWhere, `question anchor ${JSON.stringify(q.anchor)} does not match manifest.anchors on ${d.page}`);
        }
        declaredQAnchors.add(q.anchor);
      });
    });

    // Every decision/question anchor in manifest.anchors must have its corresponding entry in manifest.decisions (F8B).
    for (const a of expectedDecAnchors) {
      if (!declaredDecAnchors.has(a)) findings.add('schema', 'manifest.json#/decisions', `decision anchor ${a} missing from manifest.decisions`);
    }
    for (const a of expectedQAnchors) {
      if (!declaredQAnchors.has(a)) findings.add('schema', 'manifest.json#/decisions', `question anchor ${a} missing from manifest.decisions`);
    }
  }

  if (!Array.isArray(m.evidence)) {
    findings.add('schema', 'manifest.json#/evidence', 'evidence must be an array');
  } else {
    const referenced = new Set();
    let prevEvId = null;
    m.evidence.forEach((ev, i) => {
      const where = `manifest.json#/evidence/${i}`;
      if (!REF_RE.test(ev?.id ?? '')) findings.add('schema', where, 'evidence id is malformed');
      if (prevEvId !== null && !(prevEvId < ev?.id)) {
        findings.add('schema', where, 'evidence array must be strictly sorted by id without duplicates');
      }
      prevEvId = ev?.id ?? prevEvId;
      if (ev?.kind === 'file') {
        if (!exactKeys(ev, ['id', 'kind', 'label', 'citedBy', 'path', 'sha256', 'mediaType'])) findings.add('schema', where, 'file evidence relation is malformed');
        const f = byPath.get(ev.path);
        if (!f || f.role !== 'evidence') findings.add('evidence-relation', where, `evidence path ${JSON.stringify(ev.path)} is not an evidence file in the inventory`);
        else if (f.sha256 !== ev.sha256) findings.add('evidence-relation', where, 'evidence digest disagrees with inventory');
        referenced.add(ev.path);
      } else if (ev?.kind === 'redacted' || ev?.kind === 'unavailable') {
        if (!exactKeys(ev, ['id', 'kind', 'label', 'citedBy'])) findings.add('schema', where, 'withheld evidence relation is malformed');
      } else {
        findings.add('schema', where, 'unknown evidence kind');
      }
      if (!Array.isArray(ev?.citedBy) || !ev.citedBy.every((c) => typeof c === 'string' && seenAnchors.has(c.toLowerCase()))) {
        findings.add('schema', where, 'citedBy must be an array of declared anchors');
      }
    });
    for (const f of files) if (f.role === 'evidence' && !referenced.has(f.path)) findings.add('evidence-relation', f.path, 'evidence file has no evidence relation');
  }
  return files;
}

const SIBLING_HISTORY_HREF = /^\.\.\/sha256-[0-9a-f]{64}\/index\.html$/;

// Pure lexical relative path resolver within the bundle root. Rejects schemes,
// leading slashes, query strings, empty segments, and any ".." that would step
// above the bundle root (F7).
function resolveRelativePath(fromFile, relHref) {
  if (!relHref || relHref.startsWith('/') || relHref.includes('\\') || relHref.includes('?') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relHref)) {
    return null;
  }
  const baseParts = fromFile.split('/').slice(0, -1);
  for (const seg of relHref.split('/')) {
    if (!seg || seg === '.') return null;
    if (seg === '..') {
      if (baseParts.length === 0) return null; // stepped above bundle root!
      baseParts.pop();
    } else {
      baseParts.push(seg);
    }
  }
  return baseParts.length ? baseParts.join('/') : null;
}

function scanSitePageHtml(inspected, pagePath, inventoryPaths, htmlIdsByPage) {
  const problems = [...inspected.problems];
  let stylesheetLinks = 0;
  for (const cssHref of inspected.stylesheetHrefs) {
    const resolvedCss = resolveRelativePath(pagePath, cssHref);
    if (resolvedCss && /^assets\/[0-9a-f]{64}\.css$/.test(resolvedCss) && inventoryPaths.has(resolvedCss)) {
      stylesheetLinks += 1;
    } else {
      problems.push(`stylesheet href ${JSON.stringify(cssHref)} does not resolve to an inventoried fingerprinted stylesheet`);
    }
  }
  for (const h of inspected.hrefChecks) {
    const { tagName, lowerName, value, relTokens } = h;
    if (value.startsWith('#')) {
      const frag = value.slice(1);
      if (!frag || !htmlIdsByPage.get(pagePath)?.has(frag)) {
        problems.push(`fragment ${JSON.stringify(value)} does not match any id on ${pagePath}`);
      }
    } else if (/^https:\/\//.test(value)) {
      if (lowerName !== 'a' || !relTokens.has('noopener') || !relTokens.has('noreferrer')) {
        problems.push(`external href without rel="noopener noreferrer" on <${tagName}>`);
      }
    } else if (pagePath === 'index.html' && SIBLING_HISTORY_HREF.test(value)) {
      // Valid sibling edition history link on portfolio page
    } else {
      const parts = value.split('#');
      if (parts.length > 2) {
        problems.push(`malformed fragment in href ${JSON.stringify(value)}`);
        continue;
      }
      const [relPart, frag] = parts;
      const resolved = resolveRelativePath(pagePath, relPart);
      if (!resolved || !(inventoryPaths.has(resolved) || CONTROL_FILES.has(resolved))) {
        problems.push(`href ${JSON.stringify(value)} does not resolve to a bundle file`);
      } else if (frag !== undefined) {
        if (!frag || !htmlIdsByPage.has(resolved) || !htmlIdsByPage.get(resolved).has(frag)) {
          problems.push(`href ${JSON.stringify(value)} targets missing or non-HTML anchor #${frag} on ${resolved}`);
        }
      }
    }
  }
  if (stylesheetLinks !== 1) problems.push(`expected exactly one fingerprinted stylesheet link, found ${stylesheetLinks}`);
  for (const el of inspected.elements) {
    if (el.classes.has('verdict')) {
      problems.push('report verdict block (.verdict) is not permitted in site-bundle/v1 HTML');
      break;
    }
  }
  return problems;
}

function isWhitespaceOnly(str) {
  return /^[\t\n\f\r ]*$/.test(str);
}

const ALLOWED_DECISION_ANCESTOR_SIGS = new Set([
  'html:',
  'body:',
  'div:layout',
  'main:document',
  'section:section',
]);

const ALLOWED_DECISION_SUBTREE_SIGS = new Set([
  'article:decision',
  'article:decision,decision--close',
  'article:decision,decision--needed',
  'header:item__head',
  'p:labels',
  'span:conf-open,dec',
  'span:dec,dec-needed',
  'span:item__id',
  'span:item__id,question__ref',
  'h3:',
  'section:question',
  'div:question__bar',
  'h4:question__prompt',
  'div:question__options,support',
  'span:field-label',
  'ul:alternatives',
  'li:alt',
  'li:alt,alt--chosen',
  'div:alt__head',
  'div:alt__body',
  'code:',
  'code:opt-key',
  'span:chosen',
  'p:claim',
  'p:claim,question__freetext',
  'div:question__footer',
  'p:claim,question__recommendation',
  'div:question__evidence,support',
  'ul:ev-refs',
  'li:',
  'a:',
  'a:cite',
  'a:ext',
  'span:ev-label',
  'span:ev-ref__title',
  'span:rfc2119',
  'strong:',
  'em:',
]);

function elSignature(el) {
  return `${el.tag}:${[...el.classes].sort().join(',')}`;
}

function isHiddenEl(el) {
  return el.classes.has('visually-hidden')
    || el.classes.has('skip-link')
    || el.classes.has('rail')
    || el.classes.has('toc')
    || el.ariaHidden === 'true';
}

function hasValidDecisionSubtree(decEl) {
  let anc = decEl.parent;
  while (anc) {
    if (isHiddenEl(anc) || !ALLOWED_DECISION_ANCESTOR_SIGS.has(elSignature(anc))) return false;
    anc = anc.parent;
  }
  function checkNode(el) {
    if (el.ariaHidden === 'true') return false;
    const sig = elSignature(el);
    if (sig === 'h3:visually-hidden') {
      if (el.parent?.tag !== 'header' || !el.parent.classes.has('item__head')) return false;
    } else if (sig === 'span:visually-hidden') {
      if (el.parent?.tag !== 'h4' || !el.parent.classes.has('question__prompt')) return false;
    } else if (!ALLOWED_DECISION_SUBTREE_SIGS.has(sig)) {
      return false;
    }
    for (const ch of el.children) {
      if (!checkNode(ch)) return false;
    }
    return true;
  }
  return checkNode(decEl);
}

function hasDescendantTag(el, tag) {
  for (const ch of el.children) {
    if (ch.tag === tag || hasDescendantTag(ch, tag)) return true;
  }
  return false;
}

const UNICODE_BLANK_FILLER_RE = /[\u115F\u1160\u180E\u2800\u3164\uFFA0]/g;

function visibleChars(el, skipFn = null) {
  if (isHiddenEl(el) || (skipFn && skipFn(el))) return 0;
  let count = decodeHtmlAttr(el.ownText)
    .replace(UNICODE_BLANK_FILLER_RE, '')
    .replace(/[\s\p{Z}\p{Default_Ignorable_Code_Point}\p{Cf}]+/gu, '')
    .length;
  for (const ch of el.children) count += visibleChars(ch, skipFn);
  return count;
}

const AUTHORED_CODE_SPAN_RE = /^(?:<(?:sha256|content-id|name|id|packet-directory)>|&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);)+$/i;
const NON_CALLOUT_PROSE_SRC = '[!"#%&\'*,/?@\\\\¡¿§¶†‡‰‱′″‴\\u02BC([{\\u2018\\u201C\\u2019\\u201D\\])}«‹+$£€¥¢°±×÷]';
const CALLOUT_STRICT_SEP_SRC = `(?!${NON_CALLOUT_PROSE_SRC})[\\p{P}\\p{S}\\p{M}\\p{Lm}]`;
const CALLOUT_TAIL_SRC = `(?:\\s+${CALLOUT_STRICT_SEP_SRC}|(?![-_\\u2010\\u2011](?![\\p{Lm}])[\\p{L}\\p{N}])${CALLOUT_STRICT_SEP_SRC})`;
const CALLOUT_PAREN_TAIL_SRC = `(?:\\s*\\([^)]*\\)\\s*${CALLOUT_STRICT_SEP_SRC}|${CALLOUT_TAIL_SRC})`;
const STANDALONE_CALLOUT_STRONG_RE = new RegExp(
  `^(?:recommendation${CALLOUT_PAREN_TAIL_SRC}|recommended\\s+(?:call|option|verdict)(?:${CALLOUT_TAIL_SRC}|$)|verdict${CALLOUT_PAREN_TAIL_SRC}|options${CALLOUT_TAIL_SRC}|free-text response${CALLOUT_TAIL_SRC}|supporting evidence${CALLOUT_TAIL_SRC})`,
  'iu',
);
const CALLOUT_BARE_LABEL_RE = /^(?:recommendation(?:\s*\([^)]*\))?|recommended\s+(?:call|option|verdict)|verdict(?:\s*\([^)]*\))?|options|free-text response|supporting evidence)$/iu;
const CALLOUT_LEAD_SEP_RE = new RegExp(`^[\\s\\p{Z}]*${CALLOUT_STRICT_SEP_SRC}`, 'u');
const INLINE_WRAPPER_TAGS = new Set([
  'a', 'span', 'strong', 'em', 'small', 'b', 'i', 'u', 's', 'sub', 'sup',
  'kbd', 'samp', 'var', 'mark', 'del', 'ins', 'abbr', 'dfn', 'time', 'q', 'cite', 'code', 'wbr',
]);
const ALLOWED_MD_PROSE_ENTITIES = new Set(['&#58;', '&#64;', '&#46;', '&#32;', '&#9;', '&#8203;']);
const MD_NAMED_ENTITIES = Object.freeze({
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: '\'',
  Tab: '\t', NewLine: '\n',
  nbsp: '\u00A0', NonBreakingSpace: '\u00A0',
  ensp: '\u2002', emsp: '\u2003', emsp13: '\u2004', emsp14: '\u2005',
  numsp: '\u2007', puncsp: '\u2008', thinsp: '\u2009', ThinSpace: '\u2009',
  hairsp: '\u200A', HairSpace: '\u200A', VeryThinSpace: '\u200A',
  MediumSpace: '\u205F', ThickSpace: '\u205F\u200A',
  ZeroWidthSpace: '\u200B', NegativeVeryThinSpace: '\u200B', NegativeThinSpace: '\u200B',
  NegativeMediumSpace: '\u200B', NegativeThickSpace: '\u200B',
  NoBreak: '\u2060', WJ: '\u2060',
  shy: '\u00AD', zwnj: '\u200C', zwj: '\u200D', lrm: '\u200E', rlm: '\u200F',
  af: '\u2061', ApplyFunction: '\u2061', it: '\u2062', InvisibleTimes: '\u2062', ic: '\u2063', InvisibleComma: '\u2063',
  colon: ':', Colon: '∷', colone: '≔', coloneq: '≔', ecolon: '≕', period: '.', comma: ',', semi: ';', excl: '!', quest: '?',
  equals: '=', tilde: '~', raquo: '»', lsaquo: '‹', rsaquo: '›', rarr: '→', rArr: '⇒', xrarr: '⟶', rtrif: '▸', rtri: '▹',
  lpar: '(', rpar: ')', lsqb: '[', lbrack: '[', rsqb: ']', rbrack: ']', lcub: '{', lbrace: '{', rcub: '}', rbrace: '}',
  ast: '*', midast: '*', lowbar: '_', UnderBar: '_',
  hyphen: '-', dash: '-', ndash: '–', enDash: '–', mdash: '—', emDash: '—', horbar: '―', minus: '−',
  sol: '/', bsol: '\\', vert: '|', verbar: '|', VerticalLine: '|',
});
const ITEM_BLOCK_H3_RE = /^### (?:Finding|Risk|Requirement|Comparison|Code|Diff|Table|Chart|Diagram)\b/;
const ITEM_BLOCK_H4_RE = /^#### (?:Finding|Risk|Requirement|Comparison|Code|Diff|Table|Chart|Diagram)\b/;

function stripIgnorableChars(str) {
  return String(str ?? '')
    .replace(UNICODE_BLANK_FILLER_RE, ' ')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '');
}

function normCalloutLabel(str) {
  return stripIgnorableChars(str).normalize('NFKC').replace(/[\s\p{Z}]+/gu, ' ').trim();
}

function isCalloutWsOnly(str) {
  return /^[\s\p{Z}]*$/u.test(stripIgnorableChars(str));
}

function hasLeadingCalloutSep(str) {
  return CALLOUT_LEAD_SEP_RE.test(stripIgnorableChars(str).normalize('NFKC'));
}

function hasDisallowedHtmlTextEntity(raw) {
  if (!raw || !raw.includes('&')) return false;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '&') {
      i += 1;
      continue;
    }
    if (raw.startsWith('&amp;', i)) { i += 5; continue; }
    if (raw.startsWith('&lt;', i)) { i += 4; continue; }
    if (raw.startsWith('&gt;', i)) { i += 4; continue; }
    if (raw.startsWith('&quot;', i)) { i += 6; continue; }
    if (raw.startsWith('&#39;', i)) { i += 5; continue; }
    return true;
  }
  return false;
}

function decodeCalloutHtmlText(raw) {
  const withNamed = String(raw ?? '')
    .replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (full, name) => (Object.hasOwn(MD_NAMED_ENTITIES, name) ? MD_NAMED_ENTITIES[name] : full))
    .replace(/&(nbsp|shy)(?![A-Za-z0-9])/gi, (_, name) => (name.toLowerCase() === 'nbsp' ? '\u00A0' : '\u00AD'));
  return stripIgnorableChars(decodeHtmlAttr(withNamed));
}

function decodeCalloutHtmlTextFromEl(el) {
  if (Array.isArray(el.nodes)) {
    let out = '';
    for (const nd of el.nodes) {
      out += nd.kind === 'text' ? decodeCalloutHtmlText(nd.value) : decodeCalloutHtmlTextFromEl(nd.el);
    }
    return out;
  }
  let out = decodeCalloutHtmlText(el.ownText);
  for (const ch of el.children) out += decodeCalloutHtmlTextFromEl(ch);
  return out;
}

const MD_ESCAPABLE_RE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const MD_SPEC_WS_RE = /^[ \t\n\x0b\x0c\x0d\p{Zs}]/u;
const MD_CMJS_WS_RE = /^[\s\p{Zs}]/u;
const MD_SPEC_PUNCT_RE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\p{P}\p{S}]/u;
const MD_PANDOC_PUNCT_RE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\p{P}\p{S}\p{C}\p{Zl}\p{Zp}]/u;
const MD_FLANK_PROFILES = Object.freeze({
  spec: { useCodePoints: true, wsRe: MD_SPEC_WS_RE, punctRe: MD_SPEC_PUNCT_RE },
  pandoc: { useCodePoints: true, wsRe: MD_SPEC_WS_RE, punctRe: MD_PANDOC_PUNCT_RE },
  cmjs: { useCodePoints: false, wsRe: MD_CMJS_WS_RE, punctRe: MD_SPEC_PUNCT_RE },
});

function firstCodePointStr(str) {
  if (!str) return null;
  return String.fromCodePoint(str.codePointAt(0));
}

function lastCodePointStr(str) {
  if (!str) return null;
  const low = str.charCodeAt(str.length - 1);
  if (low >= 0xDC00 && low <= 0xDFFF && str.length >= 2) {
    const high = str.charCodeAt(str.length - 2);
    if (high >= 0xD800 && high <= 0xDBFF) return str.slice(-2);
  }
  return str.charAt(str.length - 1);
}

const MD_ASCII_WS_RE = /^[ \t\n\x0b\x0c\x0d]/;
const MD_LINK_DEST_BRACES_RE = /^<(?:[^<>\n\\\x00]|\\.)*>/;
const MD_LINK_TITLE_RE = /^(?:"(?:\\[!-/:-@[-`{-~]|\\[^\\]|[^\\"\x00])*"|'(?:\\[!-/:-@[-`{-~]|\\[^\\]|[^\\'\x00])*'|\((?:\\[!-/:-@[-`{-~]|\\[^\\]|[^\\()\x00])*\))/;
const MD_EMAIL_AUTOLINK_RE = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const MD_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/i;
// Exact 1:1 match with src/render/relax.mjs:215 and CommonMark §4.6 / §6.4 / §6.5 / §6.6:
// every raw HTML construct (<tag, </tag, <!--, <!DOCTYPE, <![CDATA[, <?) and URI autolink
// starts with "<" + [A-Za-z/!?], and every CommonMark email autolink starts with "<" +
// [A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@. Non-HTML/non-autolink prose like "<(min)@node>" or "<= 2ms"
// is unescaped by relax.mjs and parses as literal text in CommonMark.
const RAW_MD_HTML_OR_AUTOLINK = /^<(?:[A-Za-z/!?]|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@)/;

// CommonMark 0.31.2 §4.7 caps link labels at 999 interior characters (total slice <= 1001).
// commonmark.js measures UTF-16 code units (m.length <= 1001), whereas cmark-gfm / pandoc
// measure Unicode code points (cpInterior <= 999). Both treat "\X" as 2 characters.
function scanMdFollowingLinkLabel(str, pos) {
  if (str[pos] !== '[') return null;
  let j = pos + 1;
  let cpInterior = 0;
  while (j < str.length) {
    const ch = str[j];
    if (ch === ']') {
      const raw = str.slice(pos, j + 1);
      return {
        raw,
        utf16Len: raw.length,
        cpLen: cpInterior + 2,
        cmjsValid: raw.length <= 1001,
        specValid: cpInterior <= 999,
      };
    }
    if (ch === '[') return null;
    if (ch === '\\') {
      if (j + 1 >= str.length) return null;
      const nextCp = String.fromCodePoint(str.codePointAt(j + 1));
      cpInterior += 2;
      if (cpInterior > 999) return null;
      j += 1 + nextCp.length;
      continue;
    }
    const cp = String.fromCodePoint(str.codePointAt(j));
    cpInterior += 1;
    if (cpInterior > 999) return null;
    j += cp.length;
  }
  return null;
}

function findBacktickRun(str, from, n) {
  let j = from;
  while (j < str.length) {
    if (str[j] === '`') {
      let m = 1;
      while (str[j + m] === '`') m += 1;
      if (m === n) return j;
      j += m;
    } else {
      j += 1;
    }
  }
  return -1;
}

function skipMdSpnl(str, pos, profileName = 'spec') {
  const wsRe = profileName === 'cmjs' ? /^ *(?:\r?\n *)?/ : /^[ \t]*(?:\r?\n[ \t]*)?/;
  const m = wsRe.exec(str.slice(pos));
  return pos + (m ? m[0].length : 0);
}

function parseMdInlineLinkTail(str, parenIdx, profileName = 'spec') {
  if (str[parenIdx] !== '(') return -1;
  let p = skipMdSpnl(str, parenIdx + 1, profileName);
  const braceM = MD_LINK_DEST_BRACES_RE.exec(str.slice(p));
  if (braceM) {
    p += braceM[0].length;
  } else {
    if (str[p] === '<') return -1;
    const saveDest = p;
    let openParens = 0;
    while (p < str.length) {
      const ch = str[p];
      if (ch === '\\' && p + 1 < str.length && MD_ESCAPABLE_RE.test(str[p + 1])) {
        p += 2;
      } else if (ch === '(') {
        p += 1;
        openParens += 1;
        if (profileName !== 'cmjs' && openParens > 32) return -1;
      } else if (ch === ')') {
        if (openParens < 1) break;
        p += 1;
        openParens -= 1;
      } else if (MD_ASCII_WS_RE.test(ch)) {
        break;
      } else {
        p += 1;
      }
    }
    if (p === saveDest && str[p] !== ')') return -1;
    if (openParens !== 0) return -1;
  }
  const afterDest = p;
  p = skipMdSpnl(str, p, profileName);
  if (p > afterDest && p < str.length && str[p] !== ')') {
    const titleM = MD_LINK_TITLE_RE.exec(str.slice(p));
    if (titleM && !/\r?\n[ \t]*\r?\n/.test(titleM[0])) {
      p += titleM[0].length;
      p = skipMdSpnl(str, p, profileName);
    }
  }
  return str[p] === ')' ? p + 1 : -1;
}

function encodeCanonicalHttpsLinkDest(href, table = false) {
  const dest = String(href)
    .replace(/&(?=#(?:[xX][0-9A-Fa-f]{1,6}|[0-9]{1,7});|[A-Za-z][A-Za-z0-9]{1,31};)/g, '&amp;')
    .replace(/([()\\])/g, '\\$1');
  return table ? dest.replace(/\|/g, '\\|') : dest;
}

function scanCanonicalMdLinkDest(str, parenIdx, allowTablePipeEscape = true) {
  if (str[parenIdx] !== '(') return -1;
  const allowedEsc = allowTablePipeEscape ? '()\\|' : '()\\';
  for (let j = parenIdx + 1; j < str.length; j += 1) {
    const ch = str[j];
    if (ch === '\\') {
      if (j + 1 >= str.length || !allowedEsc.includes(str[j + 1])) return -1;
      j += 1;
      continue;
    }
    if (ch === '(' || ch === '<' || ch === '>' || /^[\s\p{Zs}]$/u.test(ch)) return -1;
    if (ch === ')') return j > parenIdx + 1 ? j + 1 : -1;
  }
  return -1;
}

function assertValidMdLinkDestMode(mode) {
  if (mode !== 'non-table' && mode !== 'raw-table' && mode !== 'unesc-cell') {
    throw new Error(`invalid Markdown link destination mode: ${JSON.stringify(mode)}`);
  }
}

function decodeCanonicalHttpsLinkDest(str, parenIdx, mode) {
  assertValidMdLinkDestMode(mode);
  const afterDest = scanCanonicalMdLinkDest(str, parenIdx, mode !== 'non-table');
  if (afterDest < 0) return null;
  const rawDest = str.slice(parenIdx + 1, afterDest - 1);
  let href = '';
  let p = parenIdx + 1;
  const end = afterDest - 1;
  while (p < end) {
    if (str[p] === '\\') {
      href += str[p + 1];
      p += 2;
      continue;
    }
    if (str[p] === '&') {
      const entM = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(str.slice(p, end));
      if (entM) {
        if (entM[0] !== '&amp;') return null;
        href += '&';
        p += 5;
        continue;
      }
    }
    const cp = String.fromCodePoint(str.codePointAt(p));
    href += cp;
    p += cp.length;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(href);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.href !== href) {
    return null;
  }
  const expectedTable = encodeCanonicalHttpsLinkDest(href, true);
  const expectedRaw = mode === 'non-table'
    ? encodeCanonicalHttpsLinkDest(href, false)
    : mode === 'raw-table'
      ? expectedTable
      : expectedTable.replace(/\\\|/g, '|');
  if (rawDest !== expectedRaw) return null;
  return { href, afterDest };
}

const CANONICAL_SITREP_REL_DEST_RE = /^\((?:#[A-Za-z][A-Za-z0-9-]{0,127}|(?:\.\.\/)*(?:sha256-[0-9a-f]{64}\/|(?:area|item)\/[A-Za-z0-9/_-]+\/)?index\.md(?:#[A-Za-z][A-Za-z0-9-]{0,127})?)\)$/;

function isCanonicalMdInlineLinkDest(str, parenIdx, afterTail, mode) {
  assertValidMdLinkDestMode(mode);
  return scanCanonicalMdLinkDest(str, parenIdx, mode !== 'non-table') === afterTail
    && (decodeCanonicalHttpsLinkDest(str, parenIdx, mode) !== null
      || CANONICAL_SITREP_REL_DEST_RE.test(str.slice(parenIdx, afterTail)));
}

function normalizeMdRefLabel(rawWithBrackets) {
  return rawWithBrackets
    .slice(1, -1)
    .trim()
    .replace(/[ \t\r\n]+/g, ' ')
    .toLowerCase()
    .toUpperCase();
}

function hasDisallowedMdEntityOutsideCodeAndDest(line, seenLabels, destMode) {
  assertValidMdLinkDestMode(destMode);
  if (!line || !line.includes('&')) return false;
  const brackets = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length && MD_ESCAPABLE_RE.test(line[i + 1])) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (line[i + run] === '`') run += 1;
      const close = findBacktickRun(line, i + run, run);
      i = close >= 0 ? close + run : i + run;
      continue;
    }
    if (ch === '!' && line[i + 1] === '[') {
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ isImage: true, active: true, index: i + 1, bracketAfter: false });
      i += 2;
      continue;
    }
    if (ch === '[') {
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ isImage: false, active: true, index: i, bracketAfter: false });
      i += 1;
      continue;
    }
    if (ch === ']') {
      const opener = brackets.pop();
      if (opener && opener.active) {
        const afterTailSpec = parseMdInlineLinkTail(line, i + 1, 'spec');
        const afterTailCmjs = parseMdInlineLinkTail(line, i + 1, 'cmjs');
        if (afterTailSpec > 0 || afterTailCmjs > 0) {
          if (!opener.isImage && afterTailSpec === afterTailCmjs && isCanonicalMdInlineLinkDest(line, i + 1, afterTailSpec, destMode)) {
            for (const b of brackets) {
              if (!b.isImage) b.active = false;
            }
            i = afterTailSpec;
            continue;
          }
          i += 1;
          continue;
        }
        if (seenLabels) {
          const rawLbl = scanMdFollowingLinkLabel(line, i + 1);
          const lbl = rawLbl?.cmjsValid ? rawLbl : null;
          let refRaw = null;
          if (lbl && lbl.utf16Len > 2) {
            refRaw = lbl.raw;
          } else if (!opener.bracketAfter) {
            refRaw = line.slice(opener.index, i + 1);
          }
          if (refRaw && seenLabels.has(normalizeMdRefLabel(refRaw))) {
            if (!opener.isImage) {
              for (const b of brackets) {
                if (!b.isImage) b.active = false;
              }
            }
            i = lbl ? i + 1 + lbl.utf16Len : i + 1;
            continue;
          }
        }
      }
      i += 1;
      continue;
    }
    if (ch === '&') {
      const m = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(line.slice(i));
      if (m && !ALLOWED_MD_PROSE_ENTITIES.has(m[0])) return true;
    }
    i += 1;
  }
  return false;
}

function splitMdUnescapedPipes(line) {
  const cells = [];
  let start = 0;
  let sawPipe = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '|' && (i === 0 || line[i - 1] !== '\\')) {
      sawPipe = true;
      cells.push(line.slice(start, i));
      start = i + 1;
    }
  }
  if (!sawPipe) return null;
  cells.push(line.slice(start));
  return cells;
}

function stripMdBlockPrefixes(rawLine) {
  let s = rawLine;
  while (true) {
    const bq = /^ {0,3}>[ \t]?/.exec(s);
    if (bq) {
      s = s.slice(bq[0].length);
      continue;
    }
    const li = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(s);
    if (li) {
      s = s.slice(li[0].length);
      continue;
    }
    break;
  }
  const atx = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(s);
  if (atx) {
    s = s.slice(atx[0].length).replace(/(?:^|[ \t]+)#+[ \t]*$/, '');
  }
  const fieldLabel = /^\*\*(?:Claim|Mitigation|Specification|Gaps)\.\*\* /.exec(s);
  if (fieldLabel) {
    s = s.slice(fieldLabel[0].length);
  }
  return s;
}

function parseMdInlineAst(rawSeg, seenLabels = null, profileName = 'spec') {
  const prof = MD_FLANK_PROFILES[profileName] ?? MD_FLANK_PROFILES.spec;
  const { useCodePoints } = prof;
  const mkNode = (kind, text = '') => ({
    kind,
    text,
    firstChild: null,
    lastChild: null,
    prev: null,
    next: null,
    parent: null,
  });
  const unlinkNode = (nd) => {
    const p = nd.parent;
    if (!p) return;
    if (nd.prev) nd.prev.next = nd.next;
    else p.firstChild = nd.next;
    if (nd.next) nd.next.prev = nd.prev;
    else p.lastChild = nd.prev;
    nd.prev = null;
    nd.next = null;
    nd.parent = null;
  };
  const appendChild = (parent, child) => {
    unlinkNode(child);
    child.parent = parent;
    if (parent.lastChild) {
      parent.lastChild.next = child;
      child.prev = parent.lastChild;
      parent.lastChild = child;
    } else {
      parent.firstChild = child;
      parent.lastChild = child;
    }
  };
  const insertAfter = (ref, child) => {
    unlinkNode(child);
    const p = ref.parent;
    child.parent = p;
    child.prev = ref;
    child.next = ref.next;
    if (ref.next) ref.next.prev = child;
    else if (p) p.lastChild = child;
    ref.next = child;
  };

  const root = mkNode('root');
  let delimiters = null;
  let brackets = null;

  const removeDelimiter = (delim) => {
    if (delim.previous !== null) delim.previous.next = delim.next;
    if (delim.next === null) delimiters = delim.previous;
    else delim.next.previous = delim.previous;
  };
  const removeDelimitersBetween = (bottom, top) => {
    if (bottom.next !== top) {
      bottom.next = top;
      top.previous = bottom;
    }
  };
  const processEmphasis = (stackBottom) => {
    const openersBottom = new Array(12).fill(stackBottom);
    let closer = delimiters;
    while (closer !== null && closer.previous !== stackBottom) {
      closer = closer.previous;
    }
    while (closer !== null) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const bottomIdx = (closer.ch === '_' ? 0 : 6) + (closer.canOpen ? 3 : 0) + (closer.origDelims % 3);
      let opener = closer.previous;
      let openerFound = false;
      while (opener !== null && opener !== stackBottom && opener !== openersBottom[bottomIdx]) {
        const oddMatch = (closer.canOpen || opener.canClose)
          && closer.origDelims % 3 !== 0
          && (opener.origDelims + closer.origDelims) % 3 === 0;
        if (opener.ch === closer.ch && opener.canOpen && !oddMatch) {
          openerFound = true;
          break;
        }
        opener = opener.previous;
      }
      const oldCloser = closer;
      if (!openerFound) {
        closer = closer.next;
        openersBottom[bottomIdx] = oldCloser.previous;
        if (!oldCloser.canOpen) removeDelimiter(oldCloser);
      } else {
        const useDelims = closer.numDelims >= 2 && opener.numDelims >= 2 ? 2 : 1;
        opener.numDelims -= useDelims;
        closer.numDelims -= useDelims;
        opener.node.text = opener.node.text.slice(0, opener.node.text.length - useDelims);
        closer.node.text = closer.node.text.slice(0, closer.node.text.length - useDelims);

        const emph = mkNode(useDelims === 2 ? 'strong' : 'emph');
        let tmp = opener.node.next;
        while (tmp && tmp !== closer.node) {
          const nxt = tmp.next;
          appendChild(emph, tmp);
          tmp = nxt;
        }
        insertAfter(opener.node, emph);
        removeDelimitersBetween(opener, closer);

        if (opener.numDelims === 0) {
          unlinkNode(opener.node);
          removeDelimiter(opener);
        }
        if (closer.numDelims === 0) {
          const nxtDelim = closer.next;
          unlinkNode(closer.node);
          removeDelimiter(closer);
          closer = nxtDelim;
        }
      }
    }
    while (delimiters !== null && delimiters !== stackBottom) {
      removeDelimiter(delimiters);
    }
  };

  const prevAdjacentChar = (pos) => {
    if (pos <= 0) return '\n';
    if (!useCodePoints) return rawSeg.charAt(pos - 1);
    const low = rawSeg.charCodeAt(pos - 1);
    if (low >= 0xDC00 && low <= 0xDFFF && pos >= 2) {
      const high = rawSeg.charCodeAt(pos - 2);
      if (high >= 0xD800 && high <= 0xDBFF) return rawSeg.slice(pos - 2, pos);
    }
    return rawSeg.charAt(pos - 1);
  };
  const nextAdjacentChar = (pos) => {
    if (pos >= rawSeg.length) return '\n';
    if (!useCodePoints) return rawSeg.charAt(pos);
    return String.fromCodePoint(rawSeg.codePointAt(pos));
  };

  let i = 0;
  while (i < rawSeg.length) {
    const ch = rawSeg[i];
    if (ch === '\\') {
      if (i + 1 < rawSeg.length && MD_ESCAPABLE_RE.test(rawSeg[i + 1])) {
        appendChild(root, mkNode('text', stripIgnorableChars(rawSeg[i + 1])));
        i += 2;
      } else {
        appendChild(root, mkNode('text', '\\'));
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (rawSeg[i + run] === '`') run += 1;
      const close = findBacktickRun(rawSeg, i + run, run);
      if (close >= 0) {
        let codeSpan = rawSeg.slice(i + run, close).replace(/\n/g, ' ');
        if (codeSpan.length >= 2 && codeSpan.startsWith(' ') && codeSpan.endsWith(' ') && /[^ ]/.test(codeSpan)) {
          codeSpan = codeSpan.slice(1, -1);
        }
        appendChild(root, mkNode('code', stripIgnorableChars(codeSpan)));
        i = close + run;
      } else {
        appendChild(root, mkNode('text', '`'.repeat(run)));
        i += run;
      }
      continue;
    }
    if (ch === '&') {
      const decM = /^&#(\d{1,7});/.exec(rawSeg.slice(i));
      if (decM) {
        const cp = Number.parseInt(decM[1], 10);
        const decoded = cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '\uFFFD';
        appendChild(root, mkNode('text', stripIgnorableChars(decoded)));
        i += decM[0].length;
        continue;
      }
      const hexM = /^&#[xX]([0-9A-Fa-f]{1,6});/.exec(rawSeg.slice(i));
      if (hexM) {
        const cp = Number.parseInt(hexM[1], 16);
        const decoded = cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '\uFFFD';
        appendChild(root, mkNode('text', stripIgnorableChars(decoded)));
        i += hexM[0].length;
        continue;
      }
      const namedM = /^&([A-Za-z][A-Za-z0-9]{1,31});/.exec(rawSeg.slice(i));
      if (namedM && Object.hasOwn(MD_NAMED_ENTITIES, namedM[1])) {
        appendChild(root, mkNode('text', stripIgnorableChars(MD_NAMED_ENTITIES[namedM[1]])));
        i += namedM[0].length;
        continue;
      }
    }
    if (ch === '<') {
      const autoM = MD_EMAIL_AUTOLINK_RE.exec(rawSeg.slice(i)) ?? MD_AUTOLINK_RE.exec(rawSeg.slice(i));
      if (autoM) {
        const linkNode = mkNode('link');
        appendChild(linkNode, mkNode('text', stripIgnorableChars(autoM[1])));
        appendChild(root, linkNode);
        i += autoM[0].length;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const startPos = i;
      let run = 0;
      while (rawSeg[i + run] === ch) run += 1;
      const beforeCh = prevAdjacentChar(startPos);
      const afterCh = nextAdjacentChar(startPos + run);
      const beforeWs = prof.wsRe.test(beforeCh);
      const afterWs = prof.wsRe.test(afterCh);
      const beforePunct = prof.punctRe.test(beforeCh);
      const afterPunct = prof.punctRe.test(afterCh);
      const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
      const canOpen = ch === '_' ? (leftFlank && (!rightFlank || beforePunct)) : leftFlank;
      const canClose = ch === '_' ? (rightFlank && (!leftFlank || afterPunct)) : rightFlank;
      const dNode = mkNode('text', ch.repeat(run));
      appendChild(root, dNode);
      if (canOpen || canClose) {
        const entry = {
          ch,
          numDelims: run,
          origDelims: run,
          node: dNode,
          previous: delimiters,
          next: null,
          canOpen,
          canClose,
        };
        if (delimiters !== null) delimiters.next = entry;
        delimiters = entry;
      }
      i += run;
      continue;
    }
    if (ch === '!' && rawSeg[i + 1] === '[') {
      const bNode = mkNode('text', '![');
      appendChild(root, bNode);
      if (brackets !== null) brackets.bracketAfter = true;
      brackets = {
        node: bNode,
        previous: brackets,
        previousDelimiter: delimiters,
        index: i + 1,
        isImage: true,
        active: true,
        bracketAfter: false,
      };
      i += 2;
      continue;
    }
    if (ch === '[') {
      const bNode = mkNode('text', '[');
      appendChild(root, bNode);
      if (brackets !== null) brackets.bracketAfter = true;
      brackets = {
        node: bNode,
        previous: brackets,
        previousDelimiter: delimiters,
        index: i,
        isImage: false,
        active: true,
        bracketAfter: false,
      };
      i += 1;
      continue;
    }
    if (ch === ']') {
      const startAfterClose = i + 1;
      const opener = brackets;
      if (opener === null) {
        appendChild(root, mkNode('text', ']'));
        i += 1;
        continue;
      }
      if (!opener.active) {
        brackets = opener.previous;
        appendChild(root, mkNode('text', ']'));
        i += 1;
        continue;
      }
      let matchedEnd = parseMdInlineLinkTail(rawSeg, startAfterClose, profileName);
      if (matchedEnd < 0 && seenLabels) {
        const rawLbl = scanMdFollowingLinkLabel(rawSeg, startAfterClose);
        const lbl = rawLbl && (profileName === 'cmjs' ? rawLbl.cmjsValid : rawLbl.specValid) ? rawLbl : null;
        let refRaw = null;
        let candEnd = startAfterClose;
        if (lbl && lbl.utf16Len > 2) {
          refRaw = lbl.raw;
          candEnd = startAfterClose + lbl.utf16Len;
        } else if (!opener.bracketAfter) {
          refRaw = rawSeg.slice(opener.index, startAfterClose);
          candEnd = lbl ? startAfterClose + lbl.utf16Len : startAfterClose;
        }
        if (refRaw && seenLabels.has(normalizeMdRefLabel(refRaw))) {
          matchedEnd = candEnd;
        }
      }
      if (matchedEnd >= 0) {
        const wrap = mkNode(opener.isImage ? 'image' : 'link');
        wrap.destRaw = rawSeg.slice(startAfterClose, matchedEnd);
        let tmp = opener.node.next;
        while (tmp) {
          const nxt = tmp.next;
          appendChild(wrap, tmp);
          tmp = nxt;
        }
        appendChild(root, wrap);
        processEmphasis(opener.previousDelimiter);
        brackets = opener.previous;
        unlinkNode(opener.node);
        if (!opener.isImage) {
          for (let b = brackets; b !== null; b = b.previous) {
            if (!b.isImage) b.active = false;
          }
        }
        i = matchedEnd;
        continue;
      }
      brackets = opener.previous;
      appendChild(root, mkNode('text', ']'));
      i = startAfterClose;
      continue;
    }
    const rawCp = String.fromCodePoint(rawSeg.codePointAt(i));
    appendChild(root, mkNode('text', stripIgnorableChars(rawCp)));
    i += rawCp.length;
  }

  processEmphasis(null);
  return root;
}

function parseMdInlineCalloutLeaves(rawSeg, seenLabels = null, profileName = 'spec') {
  const root = parseMdInlineAst(rawSeg, seenLabels, profileName);
  const rawLeaves = [];
  const collectLeaves = (nd, strongOwner) => {
    if (nd.kind === 'text' || nd.kind === 'code') {
      if (!nd.text) return;
      const bold = strongOwner !== null;
      const prev = rawLeaves.length > 0 ? rawLeaves[rawLeaves.length - 1] : null;
      if (prev && prev.bold === bold && prev.owner === strongOwner) {
        prev.text += nd.text;
      } else {
        rawLeaves.push({ text: nd.text, bold, owner: strongOwner });
      }
      return;
    }
    if (nd.kind === 'image') {
      // CommonMark HTML renders image children as plain alt="" attribute text (never <strong>).
      for (let c = nd.firstChild; c !== null; c = c.next) collectLeaves(c, null);
      return;
    }
    const nextOwner = strongOwner ?? (nd.kind === 'strong' ? nd : null);
    for (let c = nd.firstChild; c !== null; c = c.next) collectLeaves(c, nextOwner);
  };
  for (let c = root.firstChild; c !== null; c = c.next) collectLeaves(c, null);
  return rawLeaves;
}

function leavesHaveCallout(leaves) {
  for (let s = 0; s < leaves.length; s += 1) {
    if (!leaves[s].bold || isCalloutWsOnly(leaves[s].text)) continue;
    let chainRaw = '';
    for (let k = s; k < leaves.length; k += 1) {
      if (leaves[k].bold) {
        chainRaw += leaves[k].text;
        if (STANDALONE_CALLOUT_STRONG_RE.test(normCalloutLabel(chainRaw))) return true;
      } else if (isCalloutWsOnly(leaves[k].text)) {
        chainRaw += leaves[k].text;
      } else {
        break;
      }
    }
  }

  let firstIdx = -1;
  for (let i = 0; i < leaves.length; i += 1) {
    if (!isCalloutWsOnly(leaves[i].text)) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx < 0 || !leaves[firstIdx].bold) return false;
  let leadRaw = '';
  for (let k = firstIdx; k < leaves.length; k += 1) {
    if (leaves[k].bold) {
      leadRaw += leaves[k].text;
      const leadNorm = normCalloutLabel(leadRaw);
      if (STANDALONE_CALLOUT_STRONG_RE.test(leadNorm)) return true;
      if (CALLOUT_BARE_LABEL_RE.test(leadNorm)) {
        let restRaw = '';
        for (let r = k + 1; r < leaves.length; r += 1) restRaw += leaves[r].text;
        if (hasLeadingCalloutSep(restRaw)) return true;
      }
    } else if (isCalloutWsOnly(leaves[k].text)) {
      leadRaw += leaves[k].text;
    } else {
      break;
    }
  }
  return false;
}

function isMdCalloutSegment(rawSeg, seenLabels = null, isTableCell = false) {
  const seg = isTableCell
    ? rawSeg.replace(/\\\|/g, '|')
    : stripMdBlockPrefixes(rawSeg);
  if (leavesHaveCallout(parseMdInlineCalloutLeaves(seg, seenLabels, 'spec'))) return true;
  if (/[^\x20-\x7E\t]/.test(seg)) {
    if (leavesHaveCallout(parseMdInlineCalloutLeaves(seg, seenLabels, 'pandoc'))) return true;
    if (leavesHaveCallout(parseMdInlineCalloutLeaves(seg, seenLabels, 'cmjs'))) return true;
  }
  return false;
}

function splitGfmTableCells(rawLine) {
  if (typeof rawLine !== 'string') return null;
  const afterQuote = rawLine.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, '');
  if (/^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/.test(afterQuote)) return null;
  const trimmed = afterQuote.trim();
  const pipes = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '|' && (i === 0 || trimmed[i - 1] !== '\\')) pipes.push(i);
  }
  if (pipes.length === 0) return null;
  const parts = [];
  let start = 0;
  for (const p of pipes) {
    parts.push(trimmed.slice(start, p));
    start = p + 1;
  }
  parts.push(trimmed.slice(start));
  if (pipes[0] === 0) parts.shift();
  if (pipes[pipes.length - 1] === trimmed.length - 1) parts.pop();
  return parts.length >= 1 ? parts : null;
}

function isGfmTableDelimiterLine(rawLine) {
  const cells = splitGfmTableCells(rawLine);
  return Boolean(cells && cells.every((c) => /^[ \t]*:?-+:?[ \t]*$/.test(c)));
}

function isGfmTablePair(hdrLine, delimLine) {
  const hCells = splitGfmTableCells(hdrLine);
  const dCells = splitGfmTableCells(delimLine);
  return Boolean(hCells && dCells && hCells.length === dCells.length && dCells.every((c) => /^[ \t]*:?-+:?[ \t]*$/.test(c)));
}

function hasStandaloneMdCalloutInLine(line, seenLabels = null, splitPipes = false) {
  if (!line) return false;
  if (isMdCalloutSegment(line, seenLabels, false)) return true;
  if (!splitPipes || /^[\s|:-]+$/.test(line)) return false;
  const cells = splitMdUnescapedPipes(line);
  if (cells) {
    for (const cell of cells) {
      if (cell.trim() && isMdCalloutSegment(cell, seenLabels, true)) return true;
    }
  }
  return false;
}

function isMetricsCardDtHtml(el) {
  if (el.tag !== 'dt') return false;
  const card = el.parent;
  const dl = card?.parent;
  if (!card || card.tag !== 'div' || card.children.length !== 2 || card.children[0] !== el) return false;
  const dd = card.children[1];
  if (!dd || dd.tag !== 'dd' || !dd.children.some((c) => c.classes.has('metric__value'))) return false;
  if (!dl || dl.tag !== 'dl' || !dl.classes.has('metrics')) return false;
  for (let anc = dl.parent; anc; anc = anc.parent) {
    if (anc.tag === 'section' && anc.id?.startsWith('i-')) return true;
  }
  return false;
}

function isTopoGroupFieldLabelHtml(el) {
  if (el.tag !== 'p' || !el.classes.has('field-label')) return false;
  const card = el.parent;
  const groups = card?.parent;
  const ledger = groups?.parent;
  const fig = ledger?.parent;
  if (!card || card.tag !== 'div' || !card.classes.has('topo-group-card') || card.children[0] !== el) return false;
  if (!groups?.classes.has('topo-ledger__groups') || !ledger?.classes.has('topo-ledger')) return false;
  if (!fig || fig.tag !== 'figure' || !fig.classes.has('diagram--topology')) return false;
  for (let anc = fig.parent; anc; anc = anc.parent) {
    if (anc.tag === 'section' && anc.id?.startsWith('i-')) return true;
  }
  return false;
}

function isFlowStepStrongHtml(el) {
  if (el.tag !== 'strong') return false;
  const head = el.parent;
  const li = head?.parent;
  const ol = li?.parent;
  const fig = ol?.parent;
  if (!head?.classes.has('flow-ledger__head') || !li?.classes.has('flow-ledger__item') || !ol?.classes.has('flow-ledger')) return false;
  if (!fig || fig.tag !== 'figure' || !fig.classes.has('diagram--flow')) return false;
  for (let anc = fig.parent; anc; anc = anc.parent) {
    if (anc.tag === 'section' && anc.id?.startsWith('i-')) return true;
  }
  return false;
}

function isTopoNodeStrongHtml(el) {
  if (el.tag !== 'strong') return false;
  const li = el.parent;
  const ul = li?.parent;
  const card = ul?.parent;
  const groups = card?.parent;
  const ledger = groups?.parent;
  const fig = ledger?.parent;
  if (li?.tag !== 'li' || ul?.tag !== 'ul' || !card?.classes.has('topo-group-card')) return false;
  if (!groups?.classes.has('topo-ledger__groups') || !ledger?.classes.has('topo-ledger')) return false;
  if (!fig || fig.tag !== 'figure' || !fig.classes.has('diagram--topology')) return false;
  for (let anc = fig.parent; anc; anc = anc.parent) {
    if (anc.tag === 'section' && anc.id?.startsWith('i-')) return true;
  }
  return false;
}

function isSeqMessageStrongHtml(el) {
  if (el.tag !== 'strong') return false;
  const li = el.parent;
  const ol = li?.parent;
  const fig = ol?.parent;
  if (li?.tag !== 'li' || li.children[0] !== el || !ol?.classes.has('seq-ledger')) return false;
  if (!fig || fig.tag !== 'figure' || !fig.classes.has('diagram--sequence')) return false;
  if (!fullElementText(el).includes(' → ')) return false;
  for (let anc = fig.parent; anc; anc = anc.parent) {
    if (anc.tag === 'section' && anc.id?.startsWith('i-')) return true;
  }
  return false;
}

function isExemptCanonicalTableThHtml(el) {
  if (el.tag !== 'th') return false;
  let tbl = null;
  let inItemSec = false;
  for (let anc = el.parent; anc; anc = anc.parent) {
    if (!tbl && anc.tag === 'table') tbl = anc;
    if (anc.tag === 'section' && anc.id?.startsWith('i-')) inItemSec = true;
  }
  if (!tbl) return false;
  if (tbl.classes.has('ev-preview__table') && !inItemSec) {
    const scroll = tbl.parent;
    const prev = scroll?.parent;
    const li = prev?.parent;
    const ol = li?.parent;
    const sec = ol?.parent;
    return Boolean(scroll?.classes.has('table__scroll')
      && prev?.classes.has('ev-preview')
      && li?.tag === 'li' && li.classes.has('ev') && li.id?.startsWith('ev-')
      && ol?.classes.has('evidence-list')
      && sec?.tag === 'section' && sec.ariaLabel === 'Evidence');
  }
  if (inItemSec) return false;
  const thead = tbl.children.find((ch) => ch.tag === 'thead');
  const tr = thead?.children[0];
  if (!tr || tr.tag !== 'tr') return false;
  const cols = tr.children.map((th) => fullElementText(th).trim()).join('|');
  return cols === 'Decision|Recommended call|Age'
    || cols === 'Project|Active|Aged close|Total'
    || cols === 'Project|Active|Aged close|Total items';
}

function hasLeadingCalloutInHtmlContainer(containerEl) {
  const lines = [[]];
  const isClaimP = containerEl.tag === 'p' && containerEl.classes.has('claim');
  const splitNewlines = containerEl.tag === 'pre';
  let sawVisibleRootNode = false;

  const appendLeaf = (arr, val, owner) => {
    if (!val) return;
    const bold = owner !== null;
    const prev = arr.length > 0 ? arr[arr.length - 1] : null;
    if (prev && prev.bold === bold && prev.owner === owner) {
      prev.text += val;
    } else {
      arr.push({ text: val, bold, owner });
    }
  };

  const pushLeafText = (val, owner) => {
    if (!splitNewlines || !val.includes('\n')) {
      appendLeaf(lines[lines.length - 1], val, owner);
      return;
    }
    const parts = val.split('\n');
    for (let pi = 0; pi < parts.length; pi += 1) {
      if (pi > 0) lines.push([]);
      if (parts[pi]) appendLeaf(lines[lines.length - 1], parts[pi], owner);
    }
  };

  const walk = (nodeEl, strongOwner, isRootLevel) => {
    for (const nd of nodeEl.nodes) {
      if (nd.kind === 'text') {
        const val = decodeCalloutHtmlText(nd.value);
        if (isRootLevel && !isCalloutWsOnly(val)) sawVisibleRootNode = true;
        pushLeafText(val, strongOwner);
        continue;
      }
      const ch = nd.el;
      if (isHiddenEl(ch)) continue;
      if (ch.tag === 'br') {
        sawVisibleRootNode = true;
        lines.push([]);
        continue;
      }
      if (isRootLevel && !sawVisibleRootNode && isClaimP && ch.tag === 'span' && ch.classes.has('field-label')
        && /^(?:Claim|Mitigation|Specification|Gaps)$/.test(normCalloutLabel(decodeCalloutHtmlTextFromEl(ch)))) {
        sawVisibleRootNode = true;
        continue;
      }
      sawVisibleRootNode = true;
      if (isFlowStepStrongHtml(ch) || isTopoNodeStrongHtml(ch) || isSeqMessageStrongHtml(ch)) {
        pushLeafText(decodeCalloutHtmlTextFromEl(ch), null);
        continue;
      }
      const nextOwner = strongOwner ?? ((ch.tag === 'strong' || ch.tag === 'b') ? ch : null);
      if (INLINE_WRAPPER_TAGS.has(ch.tag)) {
        walk(ch, nextOwner, false);
      } else if (lines[lines.length - 1].length > 0) {
        lines.push([]);
      }
    }
  };

  walk(containerEl, null, true);

  for (const leaves of lines) {
    // 1. Check multi-bold chains starting at ANY bold leaf for standalone callouts (e.g. "<strong>Recommended</strong> <strong>option</strong>")
    for (let s = 0; s < leaves.length; s += 1) {
      if (!leaves[s].bold || isCalloutWsOnly(leaves[s].text)) continue;
      let chainRaw = '';
      for (let k = s; k < leaves.length; k += 1) {
        if (leaves[k].bold) {
          chainRaw += leaves[k].text;
          if (STANDALONE_CALLOUT_STRONG_RE.test(normCalloutLabel(chainRaw))) return true;
        } else if (isCalloutWsOnly(leaves[k].text)) {
          chainRaw += leaves[k].text;
        } else {
          break;
        }
      }
    }

    // 2. Check leading bold chain at the start of the line for bare callout labels + separator
    let firstIdx = -1;
    for (let i = 0; i < leaves.length; i += 1) {
      if (!isCalloutWsOnly(leaves[i].text)) {
        firstIdx = i;
        break;
      }
    }
    if (firstIdx < 0 || !leaves[firstIdx].bold) continue;
    let leadRaw = '';
    for (let k = firstIdx; k < leaves.length; k += 1) {
      if (leaves[k].bold) {
        leadRaw += leaves[k].text;
        const leadNorm = normCalloutLabel(leadRaw);
        if (STANDALONE_CALLOUT_STRONG_RE.test(leadNorm)) return true;
        if (CALLOUT_BARE_LABEL_RE.test(leadNorm)) {
          let restRaw = '';
          for (let r = k + 1; r < leaves.length; r += 1) restRaw += leaves[r].text;
          if (hasLeadingCalloutSep(restRaw)) return true;
        }
      } else if (isCalloutWsOnly(leaves[k].text)) {
        leadRaw += leaves[k].text;
      } else {
        break;
      }
    }
  }
  return false;
}

function isStandaloneCalloutStrongHtml(el) {
  if (el.tag === 'dt') {
    if (isMetricsCardDtHtml(el)) {
      return STANDALONE_CALLOUT_STRONG_RE.test(normCalloutLabel(decodeCalloutHtmlText(el.ownText)));
    }
    const dtTxt = normCalloutLabel(decodeCalloutHtmlTextFromEl(el));
    return STANDALONE_CALLOUT_STRONG_RE.test(dtTxt) || CALLOUT_BARE_LABEL_RE.test(dtTxt);
  }
  if (el.tag === 'summary') {
    const sumTxt = normCalloutLabel(decodeCalloutHtmlTextFromEl(el));
    return STANDALONE_CALLOUT_STRONG_RE.test(sumTxt) || CALLOUT_BARE_LABEL_RE.test(sumTxt);
  }
  if (el.tag === 'th') {
    if (isExemptCanonicalTableThHtml(el)) return false;
    const thTxt = normCalloutLabel(decodeCalloutHtmlTextFromEl(el));
    return STANDALONE_CALLOUT_STRONG_RE.test(thTxt) || CALLOUT_BARE_LABEL_RE.test(thTxt);
  }
  if (el.tag !== 'strong' && el.tag !== 'b') return false;
  if (el.tag === 'strong' && (isFlowStepStrongHtml(el) || isTopoNodeStrongHtml(el) || isSeqMessageStrongHtml(el))) {
    return STANDALONE_CALLOUT_STRONG_RE.test(normCalloutLabel(decodeCalloutHtmlTextFromEl(el)));
  }
  const txt = normCalloutLabel(decodeCalloutHtmlTextFromEl(el));
  if (STANDALONE_CALLOUT_STRONG_RE.test(txt)) return true;

  let cur = el;
  while (cur.parent && INLINE_WRAPPER_TAGS.has(cur.parent.tag)) {
    if (cur.parent.tag === 'span' && cur.parent.parent?.tag === 'figcaption') {
      if (hasLeadingCalloutInHtmlContainer(cur.parent)) return true;
    }
    cur = cur.parent;
  }
  const blockEl = cur.parent;
  if (blockEl && hasLeadingCalloutInHtmlContainer(blockEl)) return true;
  return false;
}

function normalizeInlineText(str) {
  return String(str ?? '').replace(/[\u200B\s]+/g, ' ').trim();
}

function isRedundantOptionSummaryText(label, summaryText) {
  const s = normalizeInlineText(summaryText);
  if (!s) return true;
  if (/^response code:\s*\S+$/i.test(s)) return true;
  if (s.toLowerCase() === normalizeInlineText(label).toLowerCase()) return true;
  return false;
}

function collectHtmlInlineArtifacts(el, { skipEl = null, startNodeIdx = 0 } = {}) {
  let rawText = '';
  const hrefs = [];
  const cites = [];
  function walkEl(nodeEl) {
    if (nodeEl === skipEl) return;
    if (nodeEl.tag === 'a' && nodeEl.classes.has('ext') && typeof nodeEl.href === 'string') {
      hrefs.push(nodeEl.href);
    } else if (nodeEl.tag === 'a' && nodeEl.classes.has('cite')) {
      cites.push(fullElementText(nodeEl).trim());
    }
    if (Array.isArray(nodeEl.nodes)) {
      for (const nd of nodeEl.nodes) {
        if (nd.kind === 'text') rawText += decodeHtmlAttr(nd.value);
        else walkEl(nd.el);
      }
      return;
    }
    rawText += decodeHtmlAttr(nodeEl.ownText);
    for (const ch of nodeEl.children) walkEl(ch);
  }
  if (Array.isArray(el.nodes)) {
    for (let i = startNodeIdx; i < el.nodes.length; i += 1) {
      const nd = el.nodes[i];
      if (nd.kind === 'text') rawText += decodeHtmlAttr(nd.value);
      else walkEl(nd.el);
    }
  } else {
    walkEl(el);
  }
  return { rawText, text: normalizeInlineText(rawText), hrefs, cites };
}

function validateOptionsBlock(opts, q, recOptRef, isV2Question = false, requireSpaceAfterOptKey = false) {
  if (opts.tag !== 'div' || !opts.classes.has('question__options') || !opts.classes.has('support') || isHiddenEl(opts) || !isWhitespaceOnly(opts.ownText)) {
    return null;
  }
  if (opts.children.length !== 3) return null;
  const [labelEl, listEl, ftEl] = opts.children;
  if (labelEl.tag !== 'span' || !labelEl.classes.has('field-label') || isHiddenEl(labelEl) || labelEl.children.length !== 0) return null;
  if (!/^Options\.?$/.test(fullElementText(labelEl).trim())) return null;
  if (listEl.tag !== 'ul' || !listEl.classes.has('alternatives') || isHiddenEl(listEl) || !isWhitespaceOnly(listEl.ownText)) return null;
  if (!Array.isArray(q?.optionRefs) || listEl.children.length !== q.optionRefs.length) return null;
  if (hasForbiddenClassInSubtree(listEl, new Set(['field-label']))) return null;
  const optLabels = [];
  const optSummaries = [];
  for (let oi = 0; oi < listEl.children.length; oi += 1) {
    const li = listEl.children[oi];
    const expectedRef = q.optionRefs[oi];
    const shouldBeChosen = recOptRef !== null && expectedRef === recOptRef;
    if (li.tag !== 'li' || !li.classes.has('alt') || isHiddenEl(li) || visibleChars(li) === 0) return null;
    if (li.classes.has('alt--chosen') !== shouldBeChosen) return null;
    if (li.children[0]?.tag === 'div' && li.children[0].classes.has('alt__head')) {
      if (!isWhitespaceOnly(li.ownText)) return null;
      const ah = li.children[0];
      const bodyEl = li.children[1];
      const bodyOk = li.children.length === 1
        || (li.children.length === 2 && bodyEl.tag === 'div' && bodyEl.classes.has('alt__body') && !isHiddenEl(bodyEl) && visibleChars(bodyEl) > 0
          && !bodyEl.classes.has('chosen') && !hasForbiddenClassInSubtree(bodyEl, new Set(['chosen']))
          && isValidInlineSubtreeHtml(bodyEl) && !hasLeadingCalloutInHtmlContainer(bodyEl));
      const expectedHeadLen = shouldBeChosen ? 3 : 2;
      const headSlicesOk = verifyExactInterChildTextSlices(ah, shouldBeChosen ? ['', ' ', ' ', ''] : ['', ' ', ''])
        || (!requireSpaceAfterOptKey && verifyExactInterChildTextSlices(ah, shouldBeChosen ? ['', '', ' ', ''] : ['', '', '']));
      if (!bodyOk || isHiddenEl(ah) || !isWhitespaceOnly(ah.ownText) || ah.children.length !== expectedHeadLen
        || !headSlicesOk) {
        return null;
      }
      const [codeEl, strongEl, chosenEl] = ah.children;
      if (codeEl.tag !== 'code' || !codeEl.classes.has('opt-key') || isHiddenEl(codeEl) || codeEl.children.length !== 0 || fullElementText(codeEl) !== expectedRef) return null;
      if (strongEl.tag !== 'strong' || isHiddenEl(strongEl) || strongEl.children.length !== 0 || visibleChars(strongEl) === 0) return null;
      const normV2OptLbl = normCalloutLabel(decodeCalloutHtmlTextFromEl(strongEl));
      if (STANDALONE_CALLOUT_STRONG_RE.test(normV2OptLbl) || CALLOUT_BARE_LABEL_RE.test(normV2OptLbl)) return null;
      if (shouldBeChosen && (!chosenEl || chosenEl.tag !== 'span' || !chosenEl.classes.has('chosen') || isHiddenEl(chosenEl) || chosenEl.children.length !== 0 || fullElementText(chosenEl).trim() !== 'Recommended')) {
        return null;
      }
      optLabels.push(fullElementText(strongEl));
      if (li.children.length === 1) {
        optSummaries.push({ omitted: true, text: '', hrefs: [], cites: [] });
      } else {
        const bodyInfo = collectHtmlInlineArtifacts(bodyEl);
        optSummaries.push({ omitted: false, text: bodyInfo.text, hrefs: bodyInfo.hrefs, cites: bodyInfo.cites });
      }
    } else if (!isV2Question && Array.isArray(li.nodes)) {
      const [strongEl, codeEl, thirdEl] = li.children;
      if (!strongEl || strongEl.tag !== 'strong' || isHiddenEl(strongEl) || strongEl.children.length !== 0 || visibleChars(strongEl) === 0) return null;
      const normV1OptLbl = normCalloutLabel(decodeCalloutHtmlTextFromEl(strongEl));
      if (STANDALONE_CALLOUT_STRONG_RE.test(normV1OptLbl) || CALLOUT_BARE_LABEL_RE.test(normV1OptLbl)) return null;
      if (!codeEl || codeEl.tag !== 'code' || isHiddenEl(codeEl) || codeEl.children.length !== 0 || fullElementText(codeEl) !== expectedRef) return null;
      const chosenChildren = li.children.filter((ch) => ch.classes.has('chosen') || hasForbiddenClassInSubtree(ch, new Set(['chosen'])));
      if (shouldBeChosen) {
        if (chosenChildren.length > 1 || (chosenChildren.length === 1 && (thirdEl !== chosenChildren[0] || thirdEl.tag !== 'span' || !thirdEl.classes.has('chosen') || isHiddenEl(thirdEl) || thirdEl.children.length !== 0 || fullElementText(thirdEl).trim() !== 'Recommended'))) {
          return null;
        }
      } else if (chosenChildren.length !== 0) {
        return null;
      }
      const strongIdx = li.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === strongEl);
      const codeIdx = li.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === codeEl);
      if (strongIdx < 0 || codeIdx <= strongIdx
        || !isWhitespaceOnly(extractNodeTextSlice(li, 0, strongIdx) ?? 'x')
        || !isWhitespaceOnly(extractNodeTextSlice(li, strongIdx + 1, codeIdx) ?? 'x')) {
        return null;
      }
      let startNodeIdx = codeIdx + 1;
      if (shouldBeChosen && chosenChildren.length === 1) {
        const thirdIdx = li.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === thirdEl);
        if (thirdIdx <= codeIdx || !isWhitespaceOnly(extractNodeTextSlice(li, codeIdx + 1, thirdIdx) ?? 'x')) {
          return null;
        }
        startNodeIdx = thirdIdx + 1;
      }
      const firstAfter = li.nodes[startNodeIdx];
      if (!firstAfter || firstAfter.kind !== 'text' || !/^\s*—\s*/.test(decodeHtmlAttr(firstAfter.value))) {
        return null;
      }
      optLabels.push(fullElementText(strongEl));
      const v1SummaryNodes = li.nodes.slice(startNodeIdx).map((nd, idx) => (idx === 0 && nd.kind === 'text' ? { kind: 'text', value: nd.value.replace(/^\s*—\s*/, '') } : nd));
      const v1SummaryWrap = {
        tag: 'div',
        classes: new Set(),
        hasHiddenAttr: false,
        ariaHidden: null,
        children: v1SummaryNodes.filter((nd) => nd.kind === 'el').map((nd) => nd.el),
        nodes: v1SummaryNodes,
      };
      if (!isValidInlineSubtreeHtml(v1SummaryWrap) || hasLeadingCalloutInHtmlContainer(v1SummaryWrap)) return null;
      const v1Info = collectHtmlInlineArtifacts(li, { startNodeIdx });
      optSummaries.push({
        omitted: false,
        text: normalizeInlineText(v1Info.rawText.replace(/^\s*—\s*/, '')),
        hrefs: v1Info.hrefs,
        cites: v1Info.cites,
      });
    } else {
      return null;
    }
  }
  if (ftEl.tag !== 'p' || !ftEl.classes.has('claim') || isHiddenEl(ftEl) || hasDescendantTag(ftEl, 'a') || ftEl.children.length !== 1) return null;
  const ftLabel = ftEl.children[0];
  if (ftLabel.tag !== 'span' || !ftLabel.classes.has('field-label') || isHiddenEl(ftLabel) || ftLabel.children.length !== 0) return null;
  if (!/^Free-text response\.?$/.test(fullElementText(ftLabel).trim())) return null;
  const ftLabelIdx = Array.isArray(ftEl.nodes) ? ftEl.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === ftLabel) : -1;
  if (ftLabelIdx < 0 || !isWhitespaceOnly(extractNodeTextSlice(ftEl, 0, ftLabelIdx) ?? 'x')) return null;
  const ftAfter = extractNodeTextSlice(ftEl, ftLabelIdx + 1, ftEl.nodes.length);
  if (ftAfter === null || !/^\s+\S/.test(ftAfter)) return null;
  const ftBody = ftAfter.trim();
  const ftBodyOk = q?.freeText?.allowed
    ? ftBody === `Allowed (up to ${q.freeText.maxChars} characters).`
    : (ftBody === 'Not allowed.' || ftBody === 'Not allowed (select one of the named options).');
  return ftBodyOk ? { optLabels, optSummaries } : null;
}

function extractRecommendationOptRef(rec, q, isV2Question = false) {
  if (!rec || rec.tag !== 'p' || !rec.classes.has('claim') || !rec.classes.has('question__recommendation') || isHiddenEl(rec) || rec.children.length < 1) {
    return { ok: false, recOptRef: null, recInfo: null };
  }
  const recLabel = rec.children[0];
  if (recLabel.tag !== 'span' || !recLabel.classes.has('field-label') || isHiddenEl(recLabel)) {
    return { ok: false, recOptRef: null, recInfo: null };
  }
  const recLabelIdx = Array.isArray(rec.nodes) ? rec.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === recLabel) : -1;
  if (recLabelIdx < 0 || !isWhitespaceOnly(extractNodeTextSlice(rec, 0, recLabelIdx) ?? 'x') || !isValidInlineSubtreeHtml(rec, { skipEl: recLabel })) {
    return { ok: false, recOptRef: null, recInfo: null };
  }
  for (let i = 1; i < rec.children.length; i += 1) {
    if (rec.children[i].classes.has('field-label') || hasForbiddenClassInSubtree(rec.children[i], new Set(['field-label']))) {
      return { ok: false, recOptRef: null, recInfo: null };
    }
  }
  const recBodyWrap = {
    tag: 'div',
    classes: new Set(),
    hasHiddenAttr: false,
    ariaHidden: null,
    children: rec.children.slice(1),
    nodes: rec.nodes.slice(recLabelIdx + 1),
  };
  if (hasLeadingCalloutInHtmlContainer(recBodyWrap)) {
    return { ok: false, recOptRef: null, recInfo: null };
  }
  const recLabelText = fullElementText(recLabel).trim();
  let labelOk = false;
  let recOptRef = null;
  if (recLabel.children.length === 0) {
    labelOk = /^Recommendation\.?$/.test(recLabelText);
  } else if (recLabel.children.length === 1 && recLabel.children[0].tag === 'code' && !isHiddenEl(recLabel.children[0]) && recLabel.children[0].children.length === 0) {
    const optRef = fullElementText(recLabel.children[0]);
    labelOk = Array.isArray(q?.optionRefs) && q.optionRefs.includes(optRef)
      && (recLabelText === `Recommendation (${optRef})` || recLabelText === `Recommendation (${optRef}).` || recLabelText === `Recommendation (option ${optRef}).` || recLabelText === `Recommendation (option ${optRef})`);
    if (labelOk) recOptRef = optRef;
  }
  const recInfo = collectHtmlInlineArtifacts(rec, { skipEl: recLabel, startNodeIdx: recLabelIdx + 1 });
  const isNoExplicit = recOptRef === null && /^no explicit recommendation/i.test(recInfo.text);
  if (rec.dataRec !== null && !(rec.dataRec === 'none' && isNoExplicit)) {
    return { ok: false, recOptRef: null, recInfo: null };
  }
  return {
    ok: labelOk && visibleChars(rec, (e) => e === recLabel) > 0,
    recOptRef,
    recInfo,
  };
}

function parseEvRefsListHtml(ulEl, page, pagePath, manifest, { requireTitleSpan = false } = {}) {
  if (!ulEl || ulEl.tag !== 'ul' || !ulEl.classes.has('ev-refs') || isHiddenEl(ulEl) || !isWhitespaceOnly(ulEl.ownText) || ulEl.children.length === 0) {
    return null;
  }
  const pageById = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((p) => [p.id, p]));
  const evOwnerByAnchor = new Map(
    (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
      .filter((a) => a.kind === 'evidence')
      .map((a) => [a.anchor, a.page]),
  );
  const evById = new Map((Array.isArray(manifest?.evidence) ? manifest.evidence : []).map((e) => [e.id, e]));
  const cites = [];
  const items = [];
  for (const li of ulEl.children) {
    if (li.tag !== 'li' || li.classes.size !== 0 || isHiddenEl(li) || !isWhitespaceOnly(li.ownText) || li.children.length !== 1) {
      return null;
    }
    const a = li.children[0];
    if (a.tag !== 'a' || a.classes.size !== 0 || isHiddenEl(a) || typeof a.href !== 'string') return null;
    let evLabelTxt = '';
    let evTitleTxt = '';
    if (a.children.length === 2) {
      const [evLbl, evTitle] = a.children;
      const rawTitle = fullElementText(evTitle);
      if (elSignature(evLbl) !== 'span:ev-label' || isHiddenEl(evLbl) || evLbl.children.length !== 0
        || elSignature(evTitle) !== 'span:ev-ref__title' || isHiddenEl(evTitle) || evTitle.children.length !== 0
        || !rawTitle.trim() || /[\r\n\t]/.test(rawTitle)
        || !verifyExactInterChildTextSlices(a, ['', ' ', ''])) {
        return null;
      }
      evLabelTxt = fullElementText(evLbl);
      evTitleTxt = rawTitle;
    } else if (!requireTitleSpan && a.children.length === 1 && Array.isArray(a.nodes)) {
      const evLbl = a.children[0];
      const lblIdx = a.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === evLbl);
      const beforeSlice = lblIdx >= 0 ? extractNodeTextSlice(a, 0, lblIdx) : null;
      const afterSlice = lblIdx >= 0 ? extractNodeTextSlice(a, lblIdx + 1, a.nodes.length) : null;
      if (elSignature(evLbl) !== 'span:ev-label' || isHiddenEl(evLbl) || evLbl.children.length !== 0
        || beforeSlice !== '' || afterSlice === null || !afterSlice.startsWith(' ')) {
        return null;
      }
      const rawTitle = afterSlice.slice(1);
      if (!rawTitle.trim() || /[\r\n\t]/.test(rawTitle)) return null;
      evLabelTxt = fullElementText(evLbl);
      evTitleTxt = rawTitle;
    } else {
      return null;
    }
    const hi = a.href.indexOf('#');
    if (hi < 0 || !a.href.slice(hi + 1).startsWith('ev-')) return null;
    const evAnchor = a.href.slice(hi + 1);
    const evId = evAnchor.slice(3);
    const evRel = evById.get(evId);
    const ownerPageId = evOwnerByAnchor.get(evAnchor);
    if (!evRel || evRel.label !== evLabelTxt || !resolveAnchorHrefOk(a.href, evAnchor, ownerPageId, page.id, pagePath, pageById)) {
      return null;
    }
    cites.push(`[${evLabelTxt}]`);
    items.push({ id: evId, title: evTitleTxt });
  }
  return { cites, items };
}

function extractQuestionEvRefsHtml(ev, page, pagePath, manifest, parityState = null, qRef = '') {
  if (!ev || ev.tag !== 'div' || !ev.classes.has('support') || !ev.classes.has('question__evidence')
    || isHiddenEl(ev) || !isWhitespaceOnly(ev.ownText)) {
    return null;
  }
  if (ev.children.length !== 2) return null;
  const [labelEl, ulEl] = ev.children;
  if (labelEl.tag !== 'span' || !labelEl.classes.has('field-label') || isHiddenEl(labelEl) || labelEl.children.length !== 0) return null;
  if (!/^Supporting evidence\.?$/.test(fullElementText(labelEl).trim())) return null;
  const parsed = parseEvRefsListHtml(ulEl, page, pagePath, manifest, {
    requireTitleSpan: Boolean(parityState?.hasEvRefTitleCss),
  });
  if (!parsed) return null;
  if (parityState?.evRefTitleChecks) {
    for (const it of parsed.items) {
      parityState.evRefTitleChecks.push({
        pagePath,
        message: `question ${qRef} supporting evidence title disagrees with Evidence section in HTML`,
        id: it.id,
        title: it.title,
      });
    }
  }
  return parsed;
}

const DECISION_ONLY_CLASSES = [
  'question', 'question__bar', 'question__prompt', 'question__options', 'question__freetext',
  'question__footer', 'question__recommendation', 'question__evidence', 'alternatives',
  'alt', 'alt--chosen', 'chosen', 'dec', 'dec-needed',
];
const SHELL_CHROME_FORBIDDEN_CLASSES = new Set(['claim', 'field-label', 'decision', 'verdict', 'support']);

function hasForbiddenClassInSubtree(root, clsSet) {
  for (const ch of root.children) {
    for (const c of ch.classes) {
      if (clsSet.has(c)) return true;
    }
    if (hasForbiddenClassInSubtree(ch, clsSet)) return true;
  }
  return false;
}

function fullElementText(el) {
  if (Array.isArray(el.nodes)) {
    let out = '';
    for (const node of el.nodes) {
      out += node.kind === 'text' ? decodeHtmlAttr(node.value) : fullElementText(node.el);
    }
    return out;
  }
  let out = decodeHtmlAttr(el.ownText);
  for (const ch of el.children) out += fullElementText(ch);
  return out;
}

function mdInlineCode(value) {
  const source = String(value ?? '').replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((m) => m[0].length));
  const delimiter = '`'.repeat(longest + 1);
  const padded = source.startsWith('`') || source.endsWith('`') || (source.startsWith(' ') && source.endsWith(' ') && source.trim())
    ? ` ${source} `
    : source;
  return `${delimiter}${padded}${delimiter}`;
}

function decodeGeneratedMdProse(md, seenLabels = null) {
  if (typeof md !== 'string') return null;
  const tokens = [];
  let out = '';
  let i = 0;
  while (i < md.length) {
    if (md[i] === '\\' && i + 1 < md.length && /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/.test(md[i + 1])) {
      tokens.push({ type: 'esc', src: md.slice(i, i + 2), ch: md[i + 1], outText: md[i + 1] });
      out += md[i + 1];
      i += 2;
      continue;
    }
    if (md[i] === '`') {
      let run = 0;
      while (md[i + run] === '`') run += 1;
      if (run !== 1) return null;
      const close = md.indexOf('`', i + 1);
      if (close < 0 || md[close + 1] === '`') return null;
      const span = md.slice(i + 1, close);
      if (!AUTHORED_CODE_SPAN_RE.test(span)) return null;
      tokens.push({ type: 'code', src: md.slice(i, close + 1), outText: span });
      out += span;
      i = close + 1;
      continue;
    }
    const refMatch = /^&#(58|64|46|32|9);/.exec(md.slice(i));
    if (refMatch) {
      const ch = String.fromCodePoint(Number(refMatch[1]));
      tokens.push({ type: 'ref', src: refMatch[0], ch, outText: ch });
      out += ch;
      i += refMatch[0].length;
      continue;
    }
    if (/^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.test(md.slice(i))) {
      return null;
    }
    if (md[i] === '<' && RAW_MD_HTML_OR_AUTOLINK.test(md.slice(i))) {
      return null;
    }
    const rawCp = String.fromCodePoint(md.codePointAt(i));
    tokens.push({ type: 'raw', src: rawCp, ch: rawCp, outText: rawCp });
    out += rawCp;
    i += rawCp.length;
  }

  // Reject unescaped CommonMark/Pandoc emphasis/link constructs that prose()/heading() + relaxEscapes never emit.
  const openBrackets = [];
  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    if (tok.type !== 'raw') continue;
    if (tok.ch === '[') {
      openBrackets.push(t);
      continue;
    }
    if (tok.ch === ']' && openBrackets.length > 0) {
      const openIdx = openBrackets.pop();
      if (tokens[t + 1]?.type === 'raw' && tokens[t + 1].ch === '(') {
        return null;
      }
      if (seenLabels) {
        const norm = tokens
          .slice(openIdx + 1, t)
          .map((tk) => tk.outText)
          .join('')
          .trim()
          .replace(/[ \t\r\n]+/g, ' ')
          .toLowerCase()
          .toUpperCase();
        if (seenLabels.has(norm)) return null;
      }
    }
  }

  const proseProfiles = /[^\x20-\x7E\t]/.test(md)
    ? [MD_FLANK_PROFILES.spec, MD_FLANK_PROFILES.pandoc, MD_FLANK_PROFILES.cmjs]
    : [MD_FLANK_PROFILES.spec];
  for (const prof of proseProfiles) {
    const isSpaceCh = (c) => c === null || prof.wsRe.test(c);
    const isPunctCh = (c) => c !== null && prof.punctRe.test(c);
    let sawStarOpen = false;
    let sawUnderscoreOpen = false;
    for (let t = 0; t < tokens.length; t += 1) {
      const tok = tokens[t];
      if (tok.type !== 'raw' || (tok.ch !== '*' && tok.ch !== '_')) continue;
      let end = t;
      while (end + 1 < tokens.length && tokens[end + 1].type === 'raw' && tokens[end + 1].ch === tok.ch) end += 1;
      const before = t > 0
        ? (prof.useCodePoints ? lastCodePointStr(tokens[t - 1].src) : tokens[t - 1].src.at(-1))
        : null;
      const after = end + 1 < tokens.length
        ? (prof.useCodePoints ? firstCodePointStr(tokens[end + 1].src) : tokens[end + 1].src[0])
        : null;
      const leftFlank = !isSpaceCh(after) && (!isPunctCh(after) || isSpaceCh(before) || isPunctCh(before));
      const rightFlank = !isSpaceCh(before) && (!isPunctCh(before) || isSpaceCh(after) || isPunctCh(after));
      if (tok.ch === '*') {
        if (rightFlank && sawStarOpen) return null;
        if (leftFlank) sawStarOpen = true;
      } else {
        const canOpen = leftFlank && (!rightFlank || isPunctCh(before));
        const canClose = rightFlank && (!leftFlank || isPunctCh(after));
        if (canClose && sawUnderscoreOpen) return null;
        if (canOpen) sawUnderscoreOpen = true;
      }
      t = end;
    }
  }
  return out;
}

function decodeGeneratedMdLinkLabel(md, seenLabels = null) {
  if (typeof md !== 'string') return null;
  let i = 0;
  while (i < md.length) {
    if (md[i] === '\\' && i + 1 < md.length && MD_ESCAPABLE_RE.test(md[i + 1])) {
      i += 2;
      continue;
    }
    if (md[i] === '`') {
      let run = 0;
      while (md[i + run] === '`') run += 1;
      const close = findBacktickRun(md, i + run, run);
      if (close < 0) return null;
      i = close + run;
      continue;
    }
    if (md[i] === '[' || md[i] === ']') return null;
    i += 1;
  }
  return decodeGeneratedMdProse(md, seenLabels);
}

function splitLeadingGeneratedStrongMd(md, seenLabels = null, destMode = 'non-table') {
  assertValidMdLinkDestMode(destMode);
  if (typeof md !== 'string') return null;
  const leadMatch = /^((?:&#(?:32|9);|\s)*)/.exec(md);
  const leadRaw = leadMatch ? leadMatch[1] : '';
  const leadWs = decodeGeneratedMdProse(leadRaw, seenLabels);
  if (leadWs === null) return null;
  let afterLeadPos = leadRaw.length;
  if (leadRaw.length > 0 && md.startsWith('&#8203;', afterLeadPos)) {
    afterLeadPos += 7;
  }
  const beforePrefix = md.slice(0, afterLeadPos);
  const rem = md.slice(afterLeadPos);

  const tokens = [];
  const brackets = [];
  let i = 0;
  while (i < rem.length) {
    if (rem[i] === '\\' && i + 1 < rem.length && MD_ESCAPABLE_RE.test(rem[i + 1])) {
      tokens.push({ type: 'esc', src: rem.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (rem[i] === '`') {
      let run = 1;
      while (rem[i + run] === '`') run += 1;
      const close = findBacktickRun(rem, i + run, run);
      if (close < 0) return null;
      tokens.push({ type: 'code', src: rem.slice(i, close + run) });
      i = close + run;
      continue;
    }
    const entMatch = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(rem.slice(i));
    if (entMatch) {
      tokens.push({ type: 'ref', src: entMatch[0] });
      i += entMatch[0].length;
      continue;
    }
    if (rem[i] === '[') {
      const prevTok = tokens.at(-1);
      const isImg = prevTok?.type === 'raw' && prevTok.ch === '!';
      tokens.push({ type: 'raw', src: '[', ch: '[' });
      brackets.push({ tokIdx: tokens.length - 1, strPos: i, isImage: isImg, active: true });
      i += 1;
      continue;
    }
    if (rem[i] === ']') {
      const opener = brackets.pop();
      if (opener && opener.active) {
        const afterTailSpec = parseMdInlineLinkTail(rem, i + 1, 'spec');
        const afterTailCmjs = parseMdInlineLinkTail(rem, i + 1, 'cmjs');
        if (afterTailSpec > 0 || afterTailCmjs > 0) {
          if (opener.isImage || afterTailSpec !== afterTailCmjs || !isCanonicalMdInlineLinkDest(rem, i + 1, afterTailSpec, destMode)) return null;
          tokens.length = opener.tokIdx;
          tokens.push({ type: 'link', src: rem.slice(opener.strPos, afterTailSpec) });
          for (const b of brackets) {
            if (!b.isImage) b.active = false;
          }
          i = afterTailSpec;
          continue;
        }
      }
      tokens.push({ type: 'raw', src: ']', ch: ']' });
      i += 1;
      continue;
    }
    const rawCp = String.fromCodePoint(rem.codePointAt(i));
    tokens.push({ type: 'raw', src: rawCp, ch: rawCp });
    i += rawCp.length;
  }

  if (tokens[0]?.type !== 'raw' || tokens[0].ch !== '*'
    || tokens[1]?.type !== 'raw' || tokens[1].ch !== '*'
    || (tokens[2]?.type === 'raw' && tokens[2].ch === '*')) {
    return null;
  }

  const findCloseUnderProfile = (prof) => {
    const isSpaceCh = (c) => c === null || prof.wsRe.test(c);
    const isPunctCh = (c) => c !== null && prof.punctRe.test(c);
    const prevAdj = (idx) => {
      if (idx > 0) {
        return prof.useCodePoints ? lastCodePointStr(tokens[idx - 1].src) : tokens[idx - 1].src.at(-1);
      }
      if (beforePrefix.length > 0) {
        return prof.useCodePoints ? lastCodePointStr(beforePrefix) : beforePrefix.at(-1);
      }
      return null;
    };
    const nextAdj = (idx) => (idx + 1 < tokens.length
      ? (prof.useCodePoints ? firstCodePointStr(tokens[idx + 1].src) : tokens[idx + 1].src[0])
      : null);
    const starRuns = [];
    for (let t = 0; t < tokens.length; t += 1) {
      if (tokens[t].type !== 'raw' || tokens[t].ch !== '*') continue;
      let end = t;
      while (end + 1 < tokens.length && tokens[end + 1].type === 'raw' && tokens[end + 1].ch === '*') end += 1;
      const before = prevAdj(t);
      const after = nextAdj(end);
      const leftFlank = !isSpaceCh(after) && (!isPunctCh(after) || isSpaceCh(before) || isPunctCh(before));
      const rightFlank = !isSpaceCh(before) && (!isPunctCh(before) || isSpaceCh(after) || isPunctCh(after));
      starRuns.push({ start: t, end, len: end - t + 1, leftFlank, rightFlank });
      t = end;
    }
    if (starRuns.length < 2 || starRuns[0].start !== 0 || starRuns[0].len !== 2 || !starRuns[0].leftFlank) {
      return -1;
    }
    for (let ri = 1; ri < starRuns.length; ri += 1) {
      const run = starRuns[ri];
      if (!run.leftFlank && !run.rightFlank) continue;
      return (run.rightFlank && run.len === 2) ? run.start : -1;
    }
    return -1;
  };

  const closeStart = findCloseUnderProfile(MD_FLANK_PROFILES.spec);
  if (closeStart < 2) return null;
  if (/[^\x20-\x7E\t]/.test(md)) {
    if (findCloseUnderProfile(MD_FLANK_PROFILES.pandoc) !== closeStart
      || findCloseUnderProfile(MD_FLANK_PROFILES.cmjs) !== closeStart) {
      return null;
    }
  }

  const innerRaw = tokens.slice(2, closeStart).map((tk) => tk.src).join('');
  const rawRest = tokens.slice(closeStart + 2).map((tk) => tk.src).join('');
  const restRaw = (rawRest.startsWith('&#8203;') && /^\s/.test(rawRest.slice(7)))
    ? rawRest.slice(7)
    : rawRest;
  const coreText = decodeGeneratedMdProse(innerRaw, seenLabels);
  if (coreText === null) return null;

  const expectedAstLead = stripIgnorableChars(leadWs);
  const expectedAstCore = stripIgnorableChars(coreText);
  const activeProfileNames = /[^\x20-\x7E\t]/.test(md) ? ['spec', 'pandoc', 'cmjs'] : ['spec'];
  for (const pName of activeProfileNames) {
    const astRoot = parseMdInlineAst(md, seenLabels, pName);
    let cur = astRoot.firstChild;
    let astLead = '';
    while (cur && cur.kind === 'text') {
      astLead += cur.text;
      cur = cur.next;
    }
    if (astLead !== expectedAstLead || !cur || cur.kind !== 'strong') return null;
    let astCore = '';
    for (let sc = cur.firstChild; sc !== null; sc = sc.next) {
      if (sc.kind !== 'text' && sc.kind !== 'code') return null;
      astCore += sc.text;
    }
    if (astCore !== expectedAstCore) return null;
  }

  return { leadWs, coreText, restRaw };
}

function decodeGeneratedMdInline(md, seenLabels = null, destMode = 'non-table') {
  assertValidMdLinkDestMode(destMode);
  if (typeof md !== 'string') return null;
  const tokens = [];
  const brackets = [];
  let i = 0;
  while (i < md.length) {
    if (md[i] === '\\' && i + 1 < md.length && /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/.test(md[i + 1])) {
      tokens.push({ type: 'esc', src: md.slice(i, i + 2), ch: md[i + 1], outText: md[i + 1] });
      i += 2;
      continue;
    }
    if (md[i] === '`') {
      let run = 1;
      while (md[i + run] === '`') run += 1;
      const close = findBacktickRun(md, i + run, run);
      if (close < 0) return null;
      const rawSpan = md.slice(i + run, close);
      const codeText = rawSpan.length >= 2 && rawSpan.startsWith(' ') && rawSpan.endsWith(' ') && rawSpan.trim().length > 0
        ? rawSpan.slice(1, -1)
        : rawSpan;
      tokens.push({ type: 'code', src: md.slice(i, close + run), outText: codeText });
      i = close + run;
      continue;
    }
    if (md.startsWith('&#8203;', i)) {
      tokens.push({ type: 'sep', src: '&#8203;', outText: '' });
      i += 7;
      continue;
    }
    const refMatch = /^&#(58|64|46|32|9);/.exec(md.slice(i));
    if (refMatch) {
      const ch = String.fromCodePoint(Number(refMatch[1]));
      tokens.push({ type: 'ref', src: refMatch[0], ch, outText: ch });
      i += refMatch[0].length;
      continue;
    }
    const entMatch = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(md.slice(i));
    if (entMatch) {
      tokens.push({ type: 'entity', src: entMatch[0], outText: entMatch[0] });
      i += entMatch[0].length;
      continue;
    }
    if (md[i] === '[') {
      const prevTok = tokens.at(-1);
      const isImg = prevTok?.type === 'raw' && prevTok.ch === '!';
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      tokens.push({ type: 'raw', src: '[', ch: '[', outText: '[' });
      brackets.push({ tokIdx: tokens.length - 1, strPos: i, isImage: isImg, active: true, bracketAfter: false });
      i += 1;
      continue;
    }
    if (md[i] === ']') {
      const opener = brackets.pop();
      if (opener && opener.active) {
        if (md[i + 1] === '(') {
          if (opener.isImage) return null;
          const decodedDest = decodeCanonicalHttpsLinkDest(md, i + 1, destMode);
          if (!decodedDest) return null;
          const innerTokens = tokens.slice(opener.tokIdx + 1);
          const rawInnerSrc = innerTokens.map((tk) => tk.src).join('');
          const decodedLabel = decodeGeneratedMdLinkLabel(rawInnerSrc, seenLabels);
          if (decodedLabel === null) return null;
          tokens.length = opener.tokIdx;
          tokens.push({
            type: 'link',
            src: md.slice(opener.strPos, decodedDest.afterDest),
            outText: decodedLabel,
            href: decodedDest.href,
          });
          for (const b of brackets) {
            if (!b.isImage) b.active = false;
          }
          i = decodedDest.afterDest;
          continue;
        }
        const afterClose = i + 1;
        const lbl = scanMdFollowingLinkLabel(md, afterClose);
        if (lbl) {
          if (lbl.utf16Len > 2 && seenLabels?.has(normalizeMdRefLabel(lbl.raw))) return null;
          if (lbl.utf16Len === 2 && !opener.bracketAfter && seenLabels?.has(normalizeMdRefLabel(md.slice(opener.strPos, afterClose)))) return null;
          if (!lbl.cmjsValid && !opener.bracketAfter && seenLabels?.has(normalizeMdRefLabel(md.slice(opener.strPos, afterClose)))) return null;
        } else if (!opener.bracketAfter) {
          const rawSlice = md.slice(opener.strPos, afterClose);
          if (seenLabels?.has(normalizeMdRefLabel(rawSlice))) {
            if (opener.isImage || md[afterClose] === '[') return null;
            const innerTokens = tokens.slice(opener.tokIdx + 1);
            const innerText = innerTokens.map((tk) => tk.outText).join('');
            if (!innerTokens.every((tk) => tk.type === 'raw') || !/^E\d+$/.test(innerText) || rawSlice !== `[${innerText}]`) {
              return null;
            }
            const citeTok = `[${innerText}]`;
            tokens.length = opener.tokIdx;
            tokens.push({ type: 'cite', src: citeTok, outText: citeTok });
            for (const b of brackets) {
              if (!b.isImage) b.active = false;
            }
            i = afterClose;
            continue;
          }
        }
      }
      if (opener?.isImage && (parseMdInlineLinkTail(md, i + 1, 'spec') > 0 || parseMdInlineLinkTail(md, i + 1, 'cmjs') > 0)) return null;
      tokens.push({ type: 'raw', src: ']', ch: ']', outText: ']' });
      i += 1;
      continue;
    }
    if (md[i] === '<' && RAW_MD_HTML_OR_AUTOLINK.test(md.slice(i))) {
      return null;
    }
    const rawCp = String.fromCodePoint(md.codePointAt(i));
    tokens.push({ type: 'raw', src: rawCp, ch: rawCp, outText: rawCp });
    i += rawCp.length;
  }

  // Collect [label](https://...) hrefs and [E<n>] citations in reading order.
  const hrefs = [];
  const cites = [];
  const collapsed = [];
  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    if (tok.type === 'link') {
      hrefs.push(tok.href);
    } else if (tok.type === 'cite') {
      cites.push(tok.src);
    }
    collapsed.push(tok);
  }

  // Reject any remaining unescaped entity references outside link destinations.
  if (collapsed.some((tk) => tk.type === 'entity')) return null;

  // Evaluate underscore and "*"/"**" emphasis pairing under a flanking profile.
  const evalInlineEmphasisProfile = (prof) => {
    const isSpaceCh = (c) => c === null || prof.wsRe.test(c);
    const isPunctCh = (c) => c !== null && prof.punctRe.test(c);
    const prevAdj = (idx) => (idx > 0
      ? (prof.useCodePoints ? lastCodePointStr(collapsed[idx - 1].src) : collapsed[idx - 1].src.at(-1))
      : null);
    const nextAdj = (idx) => (idx + 1 < collapsed.length
      ? (prof.useCodePoints ? firstCodePointStr(collapsed[idx + 1].src) : collapsed[idx + 1].src[0])
      : null);

    // Reject any paired underscore emphasis outside link destinations (inlinePieces never emits "_" emphasis).
    let sawUnderscoreOpen = false;
    for (let t = 0; t < collapsed.length; t += 1) {
      if (collapsed[t].type !== 'raw' || collapsed[t].ch !== '_') continue;
      let end = t;
      while (end + 1 < collapsed.length && collapsed[end + 1].type === 'raw' && collapsed[end + 1].ch === '_') end += 1;
      const before = prevAdj(t);
      const after = nextAdj(end);
      const leftFlank = !isSpaceCh(after) && (!isPunctCh(after) || isSpaceCh(before) || isPunctCh(before));
      const rightFlank = !isSpaceCh(before) && (!isPunctCh(before) || isSpaceCh(after) || isPunctCh(after));
      const canOpen = leftFlank && (!rightFlank || isPunctCh(before));
      const canClose = rightFlank && (!leftFlank || isPunctCh(after));
      if (canClose && sawUnderscoreOpen) return null;
      if (canOpen) sawUnderscoreOpen = true;
      t = end;
    }

    // Pair generated "*" (em) and "**" (strong) delimiter runs; non-flanking or unpaired "*" stay literal.
    const starRuns = [];
    for (let t = 0; t < collapsed.length; t += 1) {
      if (collapsed[t].type !== 'raw' || collapsed[t].ch !== '*') continue;
      let end = t;
      while (end + 1 < collapsed.length && collapsed[end + 1].type === 'raw' && collapsed[end + 1].ch === '*') end += 1;
      const before = prevAdj(t);
      const after = nextAdj(end);
      const leftFlank = !isSpaceCh(after) && (!isPunctCh(after) || isSpaceCh(before) || isPunctCh(before));
      const rightFlank = !isSpaceCh(before) && (!isPunctCh(before) || isSpaceCh(after) || isPunctCh(after));
      starRuns.push({ start: t, end, len: end - t + 1, leftFlank, rightFlank });
      t = end;
    }

    const stripped = new Set();
    let openStarRun = null;
    for (let ri = 0; ri < starRuns.length; ri += 1) {
      const run = starRuns[ri];
      if (openStarRun === null) {
        const hasLaterCloser = starRuns.slice(ri + 1).some((r2) => r2.rightFlank);
        if (run.leftFlank && hasLaterCloser) {
          if (run.len !== 1 && run.len !== 2) return null;
          openStarRun = run;
          for (let k = run.start; k <= run.end; k += 1) stripped.add(k);
        }
      } else if (run.rightFlank && run.len === openStarRun.len) {
        for (let k = run.start; k <= run.end; k += 1) stripped.add(k);
        openStarRun = null;
      } else if (run.leftFlank || run.rightFlank) {
        return null;
      }
    }
    if (openStarRun !== null) return null;
    return stripped;
  };

  const strippedTokenIndices = evalInlineEmphasisProfile(MD_FLANK_PROFILES.spec);
  if (!strippedTokenIndices) return null;
  if (/[^\x20-\x7E\t]/.test(md)) {
    const pandocSet = evalInlineEmphasisProfile(MD_FLANK_PROFILES.pandoc);
    const cmjsSet = evalInlineEmphasisProfile(MD_FLANK_PROFILES.cmjs);
    if (!pandocSet || !cmjsSet || pandocSet.size !== strippedTokenIndices.size || cmjsSet.size !== strippedTokenIndices.size) {
      return null;
    }
    for (const idx of strippedTokenIndices) {
      if (!pandocSet.has(idx) || !cmjsSet.has(idx)) return null;
    }
  }

  let out = '';
  for (let t = 0; t < collapsed.length; t += 1) {
    if (!strippedTokenIndices.has(t)) out += collapsed[t].outText;
  }
  return { rawText: out, text: normalizeInlineText(out), hrefs, cites };
}

const CODE_LANG_BY_LABEL = Object.freeze({
  TypeScript: 'typescript',
  JavaScript: 'javascript',
  JSON: 'json',
  Shell: 'shell',
  YAML: 'yaml',
  Text: 'text',
});
const VERIF_BAND_LABELS = ['Code check', 'Judgment', 'Human review', 'Needs review'];
const EARS_LABELS_SET = new Set(['Ubiquitous', 'Event-driven', 'State-driven', 'Unwanted behavior', 'Optional feature']);

function isValidInlineSubtreeHtml(root, { skipEl = null } = {}) {
  if (!root || isHiddenEl(root)) return false;
  for (const ch of root.children) {
    if (ch === skipEl) continue;
    if (isHiddenEl(ch)) return false;
    if (ch.tag === 'span') {
      if (ch.classes.size !== 1 || !ch.classes.has('rfc2119') || ch.children.length !== 0) return false;
    } else if (ch.tag === 'code') {
      if (ch.classes.size !== 0 || ch.children.length !== 0) return false;
    } else if (ch.tag === 'em' || ch.tag === 'strong') {
      if (ch.classes.size !== 0 || !isValidInlineSubtreeHtml(ch)) return false;
    } else if (ch.tag === 'a') {
      const okCls = ch.classes.size === 1 && (ch.classes.has('cite') || ch.classes.has('ext'));
      if (!okCls || ch.children.length !== 0 || typeof ch.href !== 'string' || !ch.href) return false;
    } else {
      return false;
    }
  }
  return true;
}

function extractInlineInfoStrict(el, opts = {}) {
  if (!el || isHiddenEl(el) || !isValidInlineSubtreeHtml(el, opts)) return null;
  if (opts.skipEl) {
    const skipIdx = Array.isArray(el.nodes)
      ? el.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === opts.skipEl)
      : -1;
    if (skipIdx < 0 || !isWhitespaceOnly(extractNodeTextSlice(el, 0, skipIdx) ?? 'x')) return null;
    for (const ch of el.children) {
      if (ch !== opts.skipEl && (ch.classes.has('field-label') || hasForbiddenClassInSubtree(ch, new Set(['field-label'])))) {
        return null;
      }
    }
    const afterWrap = {
      tag: 'div',
      classes: new Set(),
      hasHiddenAttr: false,
      ariaHidden: null,
      ownText: '',
      children: el.children.filter((c) => c !== opts.skipEl),
      nodes: el.nodes.slice(skipIdx + 1),
    };
    if (hasLeadingCalloutInHtmlContainer(afterWrap)) return null;
    return collectHtmlInlineArtifacts(el, { ...opts, startNodeIdx: skipIdx + 1 });
  }
  return collectHtmlInlineArtifacts(el, opts);
}

function parseVerifChipHtml(chipEl) {
  if (!chipEl || chipEl.tag !== 'span' || !chipEl.classes.has('vband') || isHiddenEl(chipEl) || chipEl.children.length !== 0) return null;
  const txt = fullElementText(chipEl);
  for (const bandLabel of VERIF_BAND_LABELS) {
    if (txt === bandLabel) return { bandLabel, detail: null, mdExpected: bandLabel };
    if (txt.startsWith(`${bandLabel} · `)) {
      const detail = txt.slice(bandLabel.length + 3);
      if (!detail.trim() || /[\r\n\t]/.test(detail)) return null;
      return { bandLabel, detail, mdExpected: `${bandLabel} — ${detail}` };
    }
  }
  return null;
}

function resolveAnchorHrefOk(href, expectedAnchor, ownerPageId, currentPageId, currentPagePath, pageById) {
  if (typeof href !== 'string' || !href) return false;
  const ownerPage = ownerPageId !== undefined ? pageById.get(ownerPageId) : null;
  if (!ownerPage) return false;
  if (ownerPageId === currentPageId) {
    return href === `#${expectedAnchor}`;
  }
  const hi = href.indexOf('#');
  if (hi <= 0 || href.slice(hi + 1) !== expectedAnchor) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(currentPagePath), href.slice(0, hi)));
  return resolved === ownerPage.html;
}

function extractSupportEvRefsHtml(divEl, expectedIdPrefix, expectedFieldLabel, page, pagePath, manifest, parityState = null) {
  if (!divEl || elSignature(divEl) !== 'div:support' || isHiddenEl(divEl) || !isWhitespaceOnly(divEl.ownText) || divEl.children.length !== 2) {
    return null;
  }
  const [lbl, ul] = divEl.children;
  if (elSignature(lbl) !== 'span:field-label' || isHiddenEl(lbl) || lbl.children.length !== 0
    || fullElementText(lbl).trim() !== expectedFieldLabel) {
    return null;
  }
  if (expectedIdPrefix && lbl.id !== `${expectedIdPrefix}-ev`) return null;
  const parsed = parseEvRefsListHtml(ul, page, pagePath, manifest, {
    requireTitleSpan: Boolean(parityState?.hasEvRefTitleCss),
  });
  if (!parsed) return null;
  if (parityState?.evRefTitleChecks) {
    for (const it of parsed.items) {
      parityState.evRefTitleChecks.push({
        pagePath,
        message: `block ${expectedIdPrefix} supporting evidence title disagrees with Evidence section in HTML`,
        id: it.id,
        title: it.title,
      });
    }
  }
  return parsed.cites;
}

function extractCodeLinesFromScrollHtml(scrollEl, expectedCodeId = null) {
  if (!scrollEl || scrollEl.tag !== 'div' || !scrollEl.classes.has('code__scroll') || isHiddenEl(scrollEl)
    || !isWhitespaceOnly(scrollEl.ownText) || scrollEl.children.length !== 1) {
    return null;
  }
  const pre = scrollEl.children[0];
  if (pre.tag !== 'pre' || pre.classes.size !== 0 || isHiddenEl(pre) || !isWhitespaceOnly(pre.ownText) || pre.children.length !== 1) {
    return null;
  }
  const code = pre.children[0];
  if (code.tag !== 'code' || code.classes.size !== 0 || isHiddenEl(code) || code.children.length === 0) return null;
  if (decodeHtmlAttr(code.ownText).replace(/\n+/g, '') !== '') return null;
  const lines = [];
  for (let i = 0; i < code.children.length; i += 1) {
    const ln = code.children[i];
    if (ln.tag !== 'span' || !ln.classes.has('ln') || isHiddenEl(ln)) return null;
    if (expectedCodeId !== null && ln.id !== `${expectedCodeId}-L${i + 1}`) return null;
    if (ln.children.some((sp) => sp.tag !== 'span' || isHiddenEl(sp) || sp.children.length !== 0)) return null;
    lines.push(fullElementText(ln));
  }
  return lines;
}

function formatChartNumLocal(value) {
  if (Number.isInteger(value)) return String(value);
  return value >= 100 ? value.toFixed(1) : Number(value.toFixed(2)).toString();
}

const DIAGRAM_ROLES_SET = new Set(['entry', 'core', 'store', 'gate', 'external']);
const ACTOR_KINDS_SET = new Set(['actor', 'service', 'store', 'verifier']);

function verifyExactInterChildTextSlices(parentEl, expectedSeps) {
  if (!Array.isArray(parentEl?.nodes) || expectedSeps.length !== parentEl.children.length + 1) return false;
  const childNodeIndices = [];
  for (let ni = 0; ni < parentEl.nodes.length; ni += 1) {
    if (parentEl.nodes[ni].kind === 'el') childNodeIndices.push(ni);
  }
  if (childNodeIndices.length !== parentEl.children.length) return false;
  let prevEnd = 0;
  for (let ci = 0; ci < childNodeIndices.length; ci += 1) {
    const slice = extractNodeTextSlice(parentEl, prevEnd, childNodeIndices[ci]);
    if (slice !== expectedSeps[ci]) return false;
    prevEnd = childNodeIndices[ci] + 1;
  }
  const tail = extractNodeTextSlice(parentEl, prevEnd, parentEl.nodes.length);
  return tail === expectedSeps[childNodeIndices.length];
}

function isCanonicalChartNumStr(str) {
  if (typeof str !== 'string' || !str) return false;
  const n = Number(str);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 && String(n) === str;
}

function niceChartCeilingLocal(maxVal) {
  if (maxVal <= 0) return 1;
  const exp = Math.floor(Math.log10(maxVal));
  const base = 10 ** exp;
  const norm = maxVal / base;
  if (norm <= 1) return 1 * base;
  if (norm <= 2) return 2 * base;
  if (norm <= 2.5) return 2.5 * base;
  if (norm <= 5) return 5 * base;
  return 10 * base;
}

function computeComparisonDeltaLocal(baseline, value, higherIsBetter = false) {
  if (baseline <= 0 || value <= 0) {
    const diff = value - baseline;
    return { text: diff === 0 ? '0%' : `${diff > 0 ? '+' : ''}${formatChartNumLocal(diff)}`, favorable: higherIsBetter ? diff > 0 : diff < 0 };
  }
  if (!higherIsBetter) {
    if (value < baseline) {
      const ratio = baseline / value;
      const pct = ((value - baseline) / baseline) * 100;
      return {
        text: ratio >= 2 ? `${ratio.toFixed(1)}× faster (${pct.toFixed(1)}%)` : `${pct.toFixed(1)}%`,
        favorable: true,
      };
    }
    if (value > baseline) {
      const pct = ((value - baseline) / baseline) * 100;
      return { text: `+${pct.toFixed(1)}% slower`, favorable: false };
    }
    return { text: '0.0%', favorable: true };
  }
  if (value > baseline) {
    const ratio = value / baseline;
    const pct = ((value - baseline) / baseline) * 100;
    return {
      text: ratio >= 2 ? `${ratio.toFixed(1)}× (+${pct.toFixed(0)}%)` : `+${pct.toFixed(1)}%`,
      favorable: true,
    };
  }
  if (value < baseline) {
    const pct = ((value - baseline) / baseline) * 100;
    return { text: `${pct.toFixed(1)}%`, favorable: false };
  }
  return { text: '0.0%', favorable: true };
}

function wrapSvgPxLocal(text, maxWidthPx, maxLines = 2, fontSize = 12, mono = false) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  const restWords = [...words];
  while (restWords.length > 0 && lines.length < maxLines) {
    const isLastLine = lines.length === maxLines - 1;
    let current = restWords.shift();
    if (estSvgPxLocal(current, fontSize, mono) > maxWidthPx) {
      if (isLastLine) {
        lines.push(clampSvgLabelText([current, ...restWords].join(' '), maxWidthPx, fontSize, mono));
        return lines;
      }
      const chars = [...current];
      let cut = 1;
      while (cut < chars.length && estSvgPxLocal(chars.slice(0, cut + 1).join(''), fontSize, mono) <= maxWidthPx) {
        cut += 1;
      }
      lines.push(chars.slice(0, cut).join(''));
      restWords.unshift(chars.slice(cut).join(''));
      continue;
    }
    while (restWords.length > 0) {
      const candidate = `${current} ${restWords[0]}`;
      if (estSvgPxLocal(candidate, fontSize, mono) <= maxWidthPx) {
        current = candidate;
        restWords.shift();
      } else {
        break;
      }
    }
    if (isLastLine && restWords.length > 0) {
      lines.push(clampSvgLabelText(`${current} ${restWords.join(' ')}`, maxWidthPx, fontSize, mono));
      return lines;
    }
    lines.push(current);
  }
  return lines;
}

function arrowHeadPointsLocal(tipX, tipY, angleRad, size = 7) {
  const spread = Math.PI / 6.2;
  const x1 = tipX - size * Math.cos(angleRad - spread);
  const y1 = tipY - size * Math.sin(angleRad - spread);
  const x2 = tipX - size * Math.cos(angleRad + spread);
  const y2 = tipY - size * Math.sin(angleRad + spread);
  const fmt = (n) => Number(n.toFixed(1));
  return `${fmt(tipX)},${fmt(tipY)} ${fmt(x1)},${fmt(y1)} ${fmt(x2)},${fmt(y2)}`;
}

function isSvgRootEl(svgEl, expectedSig, expectedViewBox) {
  return Boolean(svgEl
    && elSignature(svgEl) === expectedSig
    && svgEl.ariaHidden === 'true'
    && svgEl.attrs.size === 4
    && svgEl.attrs.get('viewbox') === expectedViewBox
    && svgEl.attrs.get('aria-hidden') === 'true'
    && svgEl.attrs.get('focusable') === 'false'
    && isWhitespaceOnly(svgEl.ownText));
}

function isSvgGroupEl(gEl, expectedSig, childCount) {
  return Boolean(gEl
    && elSignature(gEl) === expectedSig
    && gEl.ariaHidden === null
    && gEl.attrs.size === (gEl.classes.size > 0 ? 1 : 0)
    && isWhitespaceOnly(gEl.ownText)
    && gEl.children.length === childCount);
}

function isLeafSvgEl(el, expectedSig, expectedAttrs, expectedText = null) {
  if (!el || elSignature(el) !== expectedSig || el.ariaHidden !== null || el.children.length !== 0) return false;
  const expAttrEntries = Object.entries(expectedAttrs);
  const expSize = expAttrEntries.length + (el.classes.size > 0 ? 1 : 0);
  if (el.attrs.size !== expSize) return false;
  for (const [k, v] of expAttrEntries) {
    if (el.attrs.get(k) !== String(v)) return false;
  }
  if (expectedText === null) return el.ownText === '';
  return fullElementText(el) === expectedText;
}

function verifyComparisonChartSvg(svgEl, { baselineLabel, candidateLabel, unit, series, higherIsBetter }) {
  const rawMax = Math.max(...series.flatMap((p) => [p.baseline, p.value]), 1);
  const scaleMax = niceChartCeilingLocal(rawMax);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Number((scaleMax * t).toFixed(2)));
  const leftPad = 190;
  const plotW = 420;
  const deltas = series.map((p) => computeComparisonDeltaLocal(p.baseline, p.value, higherIsBetter));
  const deltaLabels = deltas.map((d) => clampSvgLabelText(d.text, 220, 10.5, true));
  const maxDeltaW = Math.max(...deltaLabels.map((t) => estSvgPxLocal(t, 10.5, true)), 110);
  const rightPad = Math.max(148, maxDeltaW + 24);
  const rowH = 50;
  const width = leftPad + plotW + rightPad;
  const baseEstW = estSvgPxLocal(baselineLabel, 10, true);
  const candEstW = estSvgPxLocal(candidateLabel, 10, true);
  const singleRowFits = (18 + baseEstW + 26 + 18 + candEstW) <= (width - leftPad - 12);
  const topPad = singleRowFits ? 36 : 54;
  const inlineTickUnit = estSvgPxLocal(`${formatChartNumLocal(scaleMax)} ${unit}`, 10, true) <= (plotW / 4 - 16);
  const bottomPad = inlineTickUnit ? 26 : 42;
  const height = topPad + series.length * rowH + bottomPad;
  const gridBottomY = height - (inlineTickUnit ? 22 : 38);

  if (!isSvgRootEl(svgEl, 'svg:svg-graphic,svg-graphic--chart', `0 0 ${width} ${height}`)) return false;
  let idx = 0;
  const legendG = svgEl.children[idx++];
  if (!isSvgGroupEl(legendG, 'g:svg-legend', 4)) return false;
  if (singleRowFits) {
    const candSwatchX = Math.max(leftPad + 195, leftPad + 18 + baseEstW + 26);
    if (!isLeafSvgEl(legendG.children[0], 'rect:bar__baseline', { x: leftPad, y: 8, width: 12, height: 10, rx: 2 })
      || !isLeafSvgEl(legendG.children[1], 'text:svg-axis-label', { x: leftPad + 18, y: 17 }, baselineLabel)
      || !isLeafSvgEl(legendG.children[2], 'rect:bar__candidate', { x: candSwatchX, y: 8, width: 12, height: 10, rx: 2 })
      || !isLeafSvgEl(legendG.children[3], 'text:svg-axis-label', { x: candSwatchX + 18, y: 17 }, candidateLabel)) {
      return false;
    }
  } else {
    const maxRowTextW = width - 48;
    const baseSvgLabel = clampSvgLabelText(baselineLabel, maxRowTextW, 10, true);
    const candSvgLabel = clampSvgLabelText(candidateLabel, maxRowTextW, 10, true);
    if (!isLeafSvgEl(legendG.children[0], 'rect:bar__baseline', { x: 16, y: 8, width: 12, height: 10, rx: 2 })
      || !isLeafSvgEl(legendG.children[1], 'text:svg-axis-label', { x: 34, y: 17 }, baseSvgLabel)
      || !isLeafSvgEl(legendG.children[2], 'rect:bar__candidate', { x: 16, y: 26, width: 12, height: 10, rx: 2 })
      || !isLeafSvgEl(legendG.children[3], 'text:svg-axis-label', { x: 34, y: 35 }, candSvgLabel)) {
      return false;
    }
  }

  for (const val of ticks) {
    const x = leftPad + (val / scaleMax) * plotW;
    const tickLabel = inlineTickUnit ? `${formatChartNumLocal(val)} ${unit}` : formatChartNumLocal(val);
    if (!isLeafSvgEl(svgEl.children[idx++], 'line:svg-grid', { x1: x.toFixed(1), y1: topPad - 6, x2: x.toFixed(1), y2: gridBottomY })
      || !isLeafSvgEl(svgEl.children[idx++], 'text:svg-axis-label', { x: x.toFixed(1), y: gridBottomY + 15, 'text-anchor': 'middle' }, tickLabel)) {
      return false;
    }
  }
  if (!inlineTickUnit) {
    const unitTxt = `Unit: ${clampSvgLabelText(unit, plotW, 10, true)}`;
    if (!isLeafSvgEl(svgEl.children[idx++], 'text:svg-axis-label', { x: (leftPad + plotW / 2).toFixed(1), y: height - 7, 'text-anchor': 'middle' }, unitTxt)) {
      return false;
    }
  }
  for (let ri = 0; ri < series.length; ri += 1) {
    const point = series[ri];
    const y = topPad + ri * rowH;
    const baseW = Math.max(point.baseline === 0 ? 0 : 2, (point.baseline / scaleMax) * plotW);
    const candW = Math.max(point.value === 0 ? 0 : 2, (point.value / scaleMax) * plotW);
    const delta = deltas[ri];
    const labelStr = clampSvgLabelText(point.label, leftPad - 22, 11.5, false);
    const rowG = svgEl.children[idx++];
    if (!isSvgGroupEl(rowG, 'g:svg-cmp-row', 4)
      || !isLeafSvgEl(rowG.children[0], 'text:svg-row-label', { x: leftPad - 12, y: y + 20, 'text-anchor': 'end' }, labelStr)
      || !isLeafSvgEl(rowG.children[1], 'rect:bar__baseline', { x: leftPad, y: y + 4, width: baseW.toFixed(1), height: 12, rx: 3 })
      || !isLeafSvgEl(rowG.children[2], 'rect:bar__candidate', { x: leftPad, y: y + 20, width: candW.toFixed(1), height: 12, rx: 3 })
      || !isLeafSvgEl(rowG.children[3], `text:svg-delta,${delta.favorable ? 'svg-delta--good' : 'svg-delta--warn'}`, { x: leftPad + plotW + 12, y: y + 22 }, deltaLabels[ri])) {
      return false;
    }
  }
  return idx === svgEl.children.length;
}

function verifyQuantilesChartSvg(svgEl, { unit, series, hasBudget, budget }) {
  const leftPad = 195;
  const plotW = 460;
  const p99Callouts = series.map((p) => clampSvgLabelText(`p99 ${formatChartNumLocal(p.p99)} ${unit}`, 195, 10, true));
  const maxCalloutW = Math.max(...p99Callouts.map((t) => estSvgPxLocal(t, 10, true)), 75);
  const rightPad = Math.max(95, maxCalloutW + 22);
  const topPad = hasBudget ? 52 : 34;
  const rowH = 44;
  const width = leftPad + plotW + rightPad;

  // When budget is not yet provided (during HTML-only pass on a budgeted chart), verify budget-independent structure, legend, labels, and callouts.
  if (hasBudget && budget === undefined) {
    if (!svgEl || elSignature(svgEl) !== 'svg:svg-graphic,svg-graphic--quantiles' || svgEl.ariaHidden !== 'true'
      || svgEl.attrs.size !== 4 || svgEl.attrs.get('aria-hidden') !== 'true' || svgEl.attrs.get('focusable') !== 'false'
      || !isWhitespaceOnly(svgEl.ownText)) {
      return false;
    }
    const legendG = svgEl.children[0];
    if (!isSvgGroupEl(legendG, 'g:svg-legend', 6)
      || !isLeafSvgEl(legendG.children[0], 'circle:svg-quant-p50', { cx: leftPad + 5, cy: 13, r: 4 })
      || !isLeafSvgEl(legendG.children[1], 'text:svg-axis-label', { x: leftPad + 14, y: 17 }, 'p50 median')
      || !isLeafSvgEl(legendG.children[2], 'line:svg-quant-p95', { x1: leftPad + 105, y1: 7, x2: leftPad + 105, y2: 19 })
      || !isLeafSvgEl(legendG.children[3], 'text:svg-axis-label', { x: leftPad + 113, y: 17 }, 'p95')
      || !isLeafSvgEl(legendG.children[4], 'polygon:svg-quant-p99', { points: `${leftPad + 158},8 ${leftPad + 163},13 ${leftPad + 158},18 ${leftPad + 153},13` })
      || !isLeafSvgEl(legendG.children[5], 'text:svg-axis-label', { x: leftPad + 169, y: 17 }, 'p99 tail')) {
      return false;
    }
    const quantRows = svgEl.children.filter((ch) => ch.tag === 'g' && ch.classes.has('svg-quant-row'));
    if (quantRows.length !== series.length) return false;
    for (let ri = 0; ri < series.length; ri += 1) {
      const point = series[ri];
      const cy = topPad + ri * rowH + 16;
      const labelStr = clampSvgLabelText(point.label, leftPad - 22, 11.5, false);
      const hasRowMax = point.max !== undefined;
      const rowG = quantRows[ri];
      if (!isSvgGroupEl(rowG, 'g:svg-quant-row', hasRowMax ? 9 : 8)
        || !isLeafSvgEl(rowG.children[0], 'text:svg-row-label', { x: leftPad - 12, y: cy + 4, 'text-anchor': 'end' }, labelStr)
        || !isLeafSvgEl(rowG.children[1], 'line:svg-quant-track', { x1: leftPad, y1: cy, x2: leftPad + plotW, y2: cy })
        || !isLeafSvgEl(rowG.children[rowG.children.length - 1], 'text:svg-axis-label', { x: leftPad + plotW + 10, y: cy + 4 }, p99Callouts[ri])) {
        return false;
      }
    }
    return true;
  }

  const rawMax = Math.max(
    hasBudget ? budget : 0,
    ...series.map((p) => p.max ?? p.p99),
    1,
  );
  const scaleMax = niceChartCeilingLocal(rawMax * 1.05);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Number((scaleMax * t).toFixed(2)));
  const inlineTickUnit = estSvgPxLocal(`${formatChartNumLocal(scaleMax)} ${unit}`, 10, true) <= (plotW / 4 - 16);
  const bottomPad = inlineTickUnit ? 26 : 42;
  const height = topPad + series.length * rowH + bottomPad;
  const gridBottomY = height - (inlineTickUnit ? 22 : 38);

  if (!isSvgRootEl(svgEl, 'svg:svg-graphic,svg-graphic--quantiles', `0 0 ${width} ${height}`)) return false;
  let idx = 0;
  const legendG = svgEl.children[idx++];
  if (!isSvgGroupEl(legendG, 'g:svg-legend', 6)
    || !isLeafSvgEl(legendG.children[0], 'circle:svg-quant-p50', { cx: leftPad + 5, cy: 13, r: 4 })
    || !isLeafSvgEl(legendG.children[1], 'text:svg-axis-label', { x: leftPad + 14, y: 17 }, 'p50 median')
    || !isLeafSvgEl(legendG.children[2], 'line:svg-quant-p95', { x1: leftPad + 105, y1: 7, x2: leftPad + 105, y2: 19 })
    || !isLeafSvgEl(legendG.children[3], 'text:svg-axis-label', { x: leftPad + 113, y: 17 }, 'p95')
    || !isLeafSvgEl(legendG.children[4], 'polygon:svg-quant-p99', { points: `${leftPad + 158},8 ${leftPad + 163},13 ${leftPad + 158},18 ${leftPad + 153},13` })
    || !isLeafSvgEl(legendG.children[5], 'text:svg-axis-label', { x: leftPad + 169, y: 17 }, 'p99 tail')) {
    return false;
  }

  for (const val of ticks) {
    const x = leftPad + (val / scaleMax) * plotW;
    const tickLabel = inlineTickUnit ? `${formatChartNumLocal(val)} ${unit}` : formatChartNumLocal(val);
    if (!isLeafSvgEl(svgEl.children[idx++], 'line:svg-grid', { x1: x.toFixed(1), y1: topPad - 6, x2: x.toFixed(1), y2: gridBottomY })
      || !isLeafSvgEl(svgEl.children[idx++], 'text:svg-axis-label', { x: x.toFixed(1), y: gridBottomY + 15, 'text-anchor': 'middle' }, tickLabel)) {
      return false;
    }
  }
  if (!inlineTickUnit) {
    const unitTxt = `Unit: ${clampSvgLabelText(unit, plotW, 10, true)}`;
    if (!isLeafSvgEl(svgEl.children[idx++], 'text:svg-axis-label', { x: (leftPad + plotW / 2).toFixed(1), y: height - 7, 'text-anchor': 'middle' }, unitTxt)) {
      return false;
    }
  }
  if (hasBudget) {
    const bx = leftPad + (budget / scaleMax) * plotW;
    const slaText = clampSvgLabelText(`SLA ${formatChartNumLocal(budget)} ${unit}`, 260, 10, true);
    const slaHalfW = estSvgPxLocal(slaText, 10, true) / 2;
    const slaTextX = Math.max(slaHalfW + 8, Math.min(width - slaHalfW - 8, bx));
    if (!isLeafSvgEl(svgEl.children[idx++], 'line:svg-budget-line', { x1: bx.toFixed(1), y1: topPad - 10, x2: bx.toFixed(1), y2: gridBottomY })
      || !isLeafSvgEl(svgEl.children[idx++], 'text:svg-budget-label', { x: slaTextX.toFixed(1), y: topPad - 15, 'text-anchor': 'middle' }, slaText)) {
      return false;
    }
  }
  for (let ri = 0; ri < series.length; ri += 1) {
    const point = series[ri];
    const cy = topPad + ri * rowH + 16;
    const x50 = leftPad + (point.p50 / scaleMax) * plotW;
    const x95 = leftPad + (point.p95 / scaleMax) * plotW;
    const x99 = leftPad + (point.p99 / scaleMax) * plotW;
    const labelStr = clampSvgLabelText(point.label, leftPad - 22, 11.5, false);
    const hasRowMax = point.max !== undefined;
    const whiskerEnd = hasRowMax ? leftPad + (point.max / scaleMax) * plotW : x99;
    const rowG = svgEl.children[idx++];
    if (!isSvgGroupEl(rowG, 'g:svg-quant-row', hasRowMax ? 9 : 8)) return false;
    let ci = 0;
    if (!isLeafSvgEl(rowG.children[ci++], 'text:svg-row-label', { x: leftPad - 12, y: cy + 4, 'text-anchor': 'end' }, labelStr)
      || !isLeafSvgEl(rowG.children[ci++], 'line:svg-quant-track', { x1: leftPad, y1: cy, x2: leftPad + plotW, y2: cy })) {
      return false;
    }
    if (hasRowMax && !isLeafSvgEl(rowG.children[ci++], 'line:svg-quant-whisker', { x1: x99.toFixed(1), y1: cy, x2: whiskerEnd.toFixed(1), y2: cy })) {
      return false;
    }
    if (!isLeafSvgEl(rowG.children[ci++], 'rect:svg-quant-band', { x: x50.toFixed(1), y: cy - 6, width: Math.max(3, x99 - x50).toFixed(1), height: 12, rx: 3 })
      || !isLeafSvgEl(rowG.children[ci++], 'rect:svg-quant-iqr', { x: x50.toFixed(1), y: cy - 6, width: Math.max(2, x95 - x50).toFixed(1), height: 12, rx: 3 })
      || !isLeafSvgEl(rowG.children[ci++], 'circle:svg-quant-p50', { cx: x50.toFixed(1), cy, r: '4.5' })
      || !isLeafSvgEl(rowG.children[ci++], 'line:svg-quant-p95', { x1: x95.toFixed(1), y1: cy - 8, x2: x95.toFixed(1), y2: cy + 8 })
      || !isLeafSvgEl(rowG.children[ci++], 'polygon:svg-quant-p99', { points: `${x99.toFixed(1)},${cy - 5.5} ${(x99 + 5.5).toFixed(1)},${cy} ${x99.toFixed(1)},${cy + 5.5} ${(x99 - 5.5).toFixed(1)},${cy}` })
      || !isLeafSvgEl(rowG.children[ci++], 'text:svg-axis-label', { x: leftPad + plotW + 10, y: cy + 4 }, p99Callouts[ri])) {
      return false;
    }
  }
  return idx === svgEl.children.length;
}

function verifyFlowDiagramSvg(svgEl, steps) {
  if (steps.length < 2 || steps.length > 24) return false;
  const cols = steps.length <= 5 ? steps.length : Math.ceil(steps.length / Math.ceil(steps.length / 4));
  const rows = Math.ceil(steps.length / cols);
  const nodeW = cols === 5 ? 164 : 192;
  const nodeH = 68;
  const gapX = cols === 5 ? 30 : 38;
  const gapY = 34;
  const padX = 18;
  const padY = 18;
  const width = padX * 2 + cols * nodeW + (cols - 1) * gapX;
  const height = padY * 2 + rows * nodeH + (rows - 1) * gapY;
  if (!isSvgRootEl(svgEl, 'svg:svg-graphic,svg-graphic--flow', `0 0 ${width} ${height}`)) return false;

  const coords = steps.map((_, idx) => {
    const row = Math.floor(idx / cols);
    const colInRow = idx % cols;
    const col = row % 2 === 0 ? colInRow : cols - 1 - colInRow;
    return { x: padX + col * (nodeW + gapX), y: padY + row * (nodeH + gapY), row, col };
  });

  let idx = 0;
  for (let i = 0; i < steps.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    const isGate = Boolean(steps[i + 1].gate);
    const strokeSig = isGate ? 'line:svg-edge,svg-edge--gate' : 'line:svg-edge';
    const arrowSig = isGate ? 'polygon:svg-arrow,svg-arrow--gate' : 'polygon:svg-arrow';
    if (a.row === b.row) {
      const forward = b.x > a.x;
      const x1 = forward ? a.x + nodeW : a.x;
      const x2 = forward ? b.x - 2 : b.x + nodeW + 2;
      const y = a.y + nodeH / 2;
      if (!isLeafSvgEl(svgEl.children[idx++], strokeSig, { x1, y1: y, x2, y2: y })
        || !isLeafSvgEl(svgEl.children[idx++], arrowSig, { points: arrowHeadPointsLocal(forward ? b.x : b.x + nodeW, y, forward ? 0 : Math.PI) })) {
        return false;
      }
    } else {
      const cx = a.x + nodeW / 2;
      const y1 = a.y + nodeH;
      const y2 = b.y - 2;
      if (!isLeafSvgEl(svgEl.children[idx++], strokeSig, { x1: cx, y1, x2: cx, y2 })
        || !isLeafSvgEl(svgEl.children[idx++], arrowSig, { points: arrowHeadPointsLocal(cx, b.y, Math.PI / 2) })) {
        return false;
      }
    }
  }

  for (let si = 0; si < steps.length; si += 1) {
    const step = steps[si];
    const { x, y } = coords[si];
    const isGate = Boolean(step.gate);
    const lines = wrapSvgPxLocal(step.rawLabel, nodeW - 24, 2, 12, false);
    const nodeSig = isGate ? 'g:svg-node,svg-node--gate' : 'g:svg-node';
    const badgeW = isGate ? 58 : 28;
    const badgeText = isGate ? `${String(si + 1).padStart(2, '0')} GATE` : String(si + 1).padStart(2, '0');
    const textStartY = lines.length === 1 ? y + 46 : y + 39;
    const nodeG = svgEl.children[idx++];
    if (!isSvgGroupEl(nodeG, nodeSig, 4 + lines.length)
      || !isLeafSvgEl(nodeG.children[0], 'rect:svg-node__box', { x, y, width: nodeW, height: nodeH, rx: 7 })
      || !isLeafSvgEl(nodeG.children[1], 'rect:svg-node__accent', { x, y, width: nodeW, height: 4, rx: 2 })
      || !isLeafSvgEl(nodeG.children[2], 'rect:svg-node__pill', { x: x + 10, y: y + 10, width: badgeW, height: 16, rx: 4 })
      || !isLeafSvgEl(nodeG.children[3], 'text:svg-node__num', { x: x + 10 + badgeW / 2, y: y + 21, 'text-anchor': 'middle' }, badgeText)) {
      return false;
    }
    for (let li = 0; li < lines.length; li += 1) {
      if (!isLeafSvgEl(nodeG.children[4 + li], 'text:svg-node__title', { x: x + 12, y: textStartY + li * 15 }, lines[li])) {
        return false;
      }
    }
  }
  return idx === svgEl.children.length;
}

function computeTopologyEdgeGeometry(a, b, groupH, groupGapY) {
  if (a.gi === b.gi) {
    const forward = b.x >= a.x;
    const x1 = forward ? a.x + a.w : a.x;
    const x2 = forward ? b.x - 2 : b.x + b.w + 2;
    const y = a.y + a.h / 2;
    return {
      pathD: `M ${x1} ${y} L ${x2} ${y}`,
      tipX: forward ? b.x : b.x + b.w,
      tipY: y,
      angle: forward ? 0 : Math.PI,
      labelX: (x1 + (forward ? b.x : b.x + b.w)) / 2,
      labelY: a.y - 6,
    };
  }
  const down = b.y > a.y;
  const x1 = a.x + a.w / 2;
  const y1 = down ? a.y + a.h : a.y;
  const x2 = b.x + b.w / 2;
  const y2 = down ? b.y - 3 : b.y + b.h + 3;
  const channelMidY = down ? a.gy + groupH + groupGapY / 2 : a.gy - groupGapY / 2;
  return {
    pathD: `M ${x1} ${y1} C ${x1} ${channelMidY}, ${x2} ${channelMidY}, ${x2} ${y2}`,
    tipX: x2,
    tipY: down ? b.y : b.y + b.h,
    angle: down ? Math.PI / 2 : -Math.PI / 2,
    labelX: 0.125 * x1 + 0.375 * x1 + 0.375 * x2 + 0.125 * x2,
    labelY: 0.125 * y1 + 0.75 * channelMidY + 0.125 * y2 + 3,
  };
}

function verifyTopologyDiagramSvg(svgEl, groupsMeta, edgesMeta) {
  if (groupsMeta.length < 1 || groupsMeta.length > 8 || edgesMeta.length < 1 || edgesMeta.length > 48) return false;
  const totalNodes = groupsMeta.reduce((acc, g) => acc + g.nodes.length, 0);
  if (totalNodes > 24) return false;
  const maxNodesInGroup = Math.max(...groupsMeta.map((g) => g.nodes.length));
  const nodeW = 198;
  const nodeH = 62;
  const gapX = 56;
  const groupPadX = 24;
  const groupTopPad = 46;
  const groupBottomPad = 18;
  const groupGapY = 62;
  const outerPad = 18;
  const innerMaxW = maxNodesInGroup * nodeW + Math.max(0, maxNodesInGroup - 1) * gapX;
  const groupW = Math.max(520, innerMaxW + groupPadX * 2);
  const groupH = groupTopPad + nodeH + groupBottomPad;
  const width = outerPad * 2 + groupW;
  const height = outerPad * 2 + groupsMeta.length * groupH + (groupsMeta.length - 1) * groupGapY;

  if (!isSvgRootEl(svgEl, 'svg:svg-graphic,svg-graphic--topology', `0 0 ${width} ${height}`)) return false;

  const allNodes = [];
  let idx = 0;
  for (let gi = 0; gi < groupsMeta.length; gi += 1) {
    const group = groupsMeta[gi];
    if (group.nodes.length < 1 || group.nodes.length > 12) return false;
    const gx = outerPad;
    const gy = outerPad + gi * (groupH + groupGapY);
    const groupTitle = clampSvgLabelText(group.rawLabel, groupW - 28, 11, false);
    const grpG = svgEl.children[idx++];
    if (!isSvgGroupEl(grpG, 'g:svg-group', 2)
      || !isLeafSvgEl(grpG.children[0], 'rect:svg-group__frame', { x: gx, y: gy, width: groupW, height: groupH, rx: 8 })
      || !isLeafSvgEl(grpG.children[1], 'text:svg-group__label', { x: gx + 14, y: gy + 20 }, groupTitle)) {
      return false;
    }

    const rowW = group.nodes.length * nodeW + Math.max(0, group.nodes.length - 1) * gapX;
    const startX = gx + (groupW - rowW) / 2;
    const ny = gy + groupTopPad;

    for (let ni = 0; ni < group.nodes.length; ni += 1) {
      const node = group.nodes[ni];
      const nx = startX + ni * (nodeW + gapX);
      const titleLine = clampSvgLabelText(node.rawLabel, nodeW - 26, 12, false);
      const subLine = node.rawSublabel !== null ? clampSvgLabelText(node.rawSublabel, nodeW - 26, 10, true) : '';
      const nodeG = svgEl.children[idx++];
      if (!nodeG || nodeG.tag !== 'g' || nodeG.classes.size !== 2 || !nodeG.classes.has('svg-node')) return false;
      const roleCls = [...nodeG.classes].find((c) => c.startsWith('svg-node--role-'));
      const role = roleCls ? roleCls.slice('svg-node--role-'.length) : '';
      if (!DIAGRAM_ROLES_SET.has(role) || !isSvgGroupEl(nodeG, elSignature(nodeG), subLine ? 4 : 3)
        || !isLeafSvgEl(nodeG.children[0], 'rect:svg-node__box', { x: nx, y: ny, width: nodeW, height: nodeH, rx: 6 })
        || !isLeafSvgEl(nodeG.children[1], 'rect:svg-node__accent', { x: nx, y: ny, width: 5, height: nodeH, rx: 2 })
        || !isLeafSvgEl(nodeG.children[2], 'text:svg-node__title', { x: nx + 14, y: ny + (subLine ? 26 : 35) }, titleLine)) {
        return false;
      }
      if (subLine && !isLeafSvgEl(nodeG.children[3], 'text:svg-node__sub', { x: nx + 14, y: ny + 45 }, subLine)) {
        return false;
      }
      allNodes.push({ rawLabel: node.rawLabel, x: nx, y: ny, w: nodeW, h: nodeH, gi, ni, gy });
    }
  }

  const placedPills = [];
  const expectedPills = [];
  for (let ei = 0; ei < edgesMeta.length; ei += 1) {
    const edge = edgesMeta[ei];
    const edgeG = svgEl.children[idx++];
    if (!isSvgGroupEl(edgeG, 'g:svg-edge-group', 2)) return false;
    const allowedPathSigs = edge.gate
      ? ['path:svg-edge,svg-edge--gate']
      : ['path:svg-edge,svg-edge--solid', 'path:svg-edge,svg-edge--dashed'];
    const expArrowSig = edge.gate ? 'polygon:svg-arrow,svg-arrow--gate' : 'polygon:svg-arrow';
    let matchedGeom = null;
    for (const a of allNodes) {
      if (a.rawLabel !== edge.fromLbl) continue;
      for (const b of allNodes) {
        if (b.rawLabel !== edge.toLbl) continue;
        const geom = computeTopologyEdgeGeometry(a, b, groupH, groupGapY);
        const pathOk = allowedPathSigs.some((pSig) => isLeafSvgEl(edgeG.children[0], pSig, { d: geom.pathD, fill: 'none' }));
        const arrowOk = isLeafSvgEl(edgeG.children[1], expArrowSig, { points: arrowHeadPointsLocal(geom.tipX, geom.tipY, geom.angle) });
        if (pathOk && arrowOk) {
          matchedGeom = geom;
          break;
        }
      }
      if (matchedGeom) break;
    }
    if (!matchedGeom) return false;

    if (edge.edgeLabel !== null) {
      const text = clampSvgLabelText(edge.edgeLabel, 155, 10, true);
      const pw = Math.max(48, estSvgPxLocal(text, 10, true) + 16);
      const clampedLabelX = Math.max(pw / 2 + 8, Math.min(width - pw / 2 - 8, matchedGeom.labelX));
      let py = matchedGeom.labelY;
      while (placedPills.some((prev) => Math.abs(prev.y - py) < 17 && Math.abs(prev.x - clampedLabelX) < (prev.w + pw) / 2 + 6)) {
        py += 18;
      }
      placedPills.push({ x: clampedLabelX, y: py, w: pw });
      expectedPills.push({ isGate: edge.gate, clampedLabelX, py, pw, text });
    }
  }

  for (const pill of expectedPills) {
    const pillG = svgEl.children[idx++];
    const pillRectSig = pill.isGate ? 'rect:svg-edge-pill,svg-edge-pill--gate' : 'rect:svg-edge-pill';
    if (!isSvgGroupEl(pillG, 'g:svg-edge-label-group', 2)
      || !isLeafSvgEl(pillG.children[0], pillRectSig, { x: (pill.clampedLabelX - pill.pw / 2).toFixed(1), y: (pill.py - 11).toFixed(1), width: pill.pw.toFixed(1), height: 16, rx: 4 })
      || !isLeafSvgEl(pillG.children[1], 'text:svg-edge-label', { x: pill.clampedLabelX.toFixed(1), y: pill.py.toFixed(1), 'text-anchor': 'middle' }, pill.text)) {
      return false;
    }
  }
  return idx === svgEl.children.length;
}

function verifySequenceDiagramSvg(svgEl, rawMessages) {
  const M = rawMessages.length;
  if (!svgEl || M < 1 || M > 32) return null;
  const K = svgEl.children.length - M;
  if (K < 2 || K > 8) return null;

  const actorW = 140;
  const actorH = 42;
  const colSpan = 178;
  const padX = 24;
  const padY = 16;
  const hasNotes = rawMessages.some((m) => m.hasNote);
  const rightMostActorRight = padX + (K - 1) * colSpan + actorW;
  const noteLaneX = rightMostActorRight + 22;
  const noteBoxW = 196;
  const rowH = 50;
  const topLifelineY = padY + actorH;
  const firstMsgY = topLifelineY + 34;
  const bottomY = firstMsgY + M * rowH + 10;
  const width = hasNotes ? noteLaneX + noteBoxW + padX : rightMostActorRight + 80;
  const height = bottomY + 18;

  if (!isSvgRootEl(svgEl, 'svg:svg-graphic,svg-graphic--sequence', `0 0 ${width} ${height}`)) return null;

  const actorCxs = [];
  const actorSvgTitles = [];
  const cxToActorIdx = new Map();
  for (let ai = 0; ai < K; ai += 1) {
    const cx = padX + actorW / 2 + ai * colSpan;
    const x = cx - actorW / 2;
    const actG = svgEl.children[ai];
    if (!actG || actG.tag !== 'g' || actG.classes.size !== 2 || !actG.classes.has('svg-actor')) return null;
    const kindCls = [...actG.classes].find((c) => c.startsWith('svg-actor--'));
    const kind = kindCls ? kindCls.slice('svg-actor--'.length) : '';
    if (!ACTOR_KINDS_SET.has(kind) || !isSvgGroupEl(actG, elSignature(actG), 4)
      || !isLeafSvgEl(actG.children[0], 'line:svg-lifeline', { x1: cx, y1: topLifelineY, x2: cx, y2: bottomY })
      || !isLeafSvgEl(actG.children[1], 'rect:svg-node__box', { x, y: padY, width: actorW, height: actorH, rx: 6 })
      || !isLeafSvgEl(actG.children[2], 'rect:svg-node__accent', { x, y: padY, width: actorW, height: 4, rx: 2 })) {
      return null;
    }
    const tEl = actG.children[3];
    const tStr = tEl ? fullElementText(tEl) : '';
    if (!tStr.trim() || !isLeafSvgEl(tEl, 'text:svg-node__title', { x: cx, y: padY + 26, 'text-anchor': 'middle' }, tStr)) {
      return null;
    }
    actorCxs.push(cx);
    actorSvgTitles.push(tStr);
    cxToActorIdx.set(cx, ai);
  }

  const maxPillRight = hasNotes ? noteLaneX - 12 : width - padX;
  const msgEndpoints = [];
  for (let mi = 0; mi < M; mi += 1) {
    const msg = rawMessages[mi];
    const y = firstMsgY + mi * rowH;
    const msgG = svgEl.children[K + mi];
    if (!isSvgGroupEl(msgG, 'g:svg-msg', msg.hasNote ? 7 : 5)) return null;

    const originEl = msgG.children[0];
    const cxNum = Number(originEl?.attrs.get('cx'));
    const fromIdx = cxToActorIdx.get(cxNum);
    if (fromIdx === undefined) return null;
    const x1 = actorCxs[fromIdx];

    let toIdx = -1;
    const lineOrPath = msgG.children[1];
    const arrowEl = msgG.children[2];
    const expArrowSig = msg.gate ? 'polygon:svg-arrow,svg-arrow--gate' : 'polygon:svg-arrow';
    if (lineOrPath?.tag === 'path') {
      const allowedPathSigs = msg.gate ? ['path:svg-edge,svg-edge--gate'] : ['path:svg-edge', 'path:svg-edge,svg-edge--dashed'];
      const loopD = `M ${x1} ${y - 2} L ${x1 + 34} ${y - 2} L ${x1 + 34} ${y + 12} L ${x1 + 3} ${y + 12}`;
      if (!isLeafSvgEl(originEl, 'circle:svg-msg__origin', { cx: x1, cy: y - 2, r: 3 })
        || !allowedPathSigs.some((s) => isLeafSvgEl(lineOrPath, s, { d: loopD, fill: 'none' }))
        || !isLeafSvgEl(arrowEl, expArrowSig, { points: arrowHeadPointsLocal(x1, y + 12, Math.PI) })) {
        return null;
      }
      toIdx = fromIdx;
    } else if (lineOrPath?.tag === 'line') {
      const allowedLineSigs = msg.gate ? ['line:svg-edge,svg-edge--gate'] : ['line:svg-edge', 'line:svg-edge,svg-edge--dashed'];
      if (!isLeafSvgEl(originEl, 'circle:svg-msg__origin', { cx: x1, cy: y, r: 3 })) return null;
      for (let candTo = 0; candTo < K; candTo += 1) {
        if (candTo === fromIdx) continue;
        const x2 = actorCxs[candTo];
        const forward = x2 > x1;
        const targetX = forward ? x2 - 3 : x2 + 3;
        if (allowedLineSigs.some((s) => isLeafSvgEl(lineOrPath, s, { x1, y1: y, x2: targetX, y2: y }))
          && isLeafSvgEl(arrowEl, expArrowSig, { points: arrowHeadPointsLocal(x2, y, forward ? 0 : Math.PI) })) {
          toIdx = candTo;
          break;
        }
      }
      if (toIdx < 0) return null;
    } else {
      return null;
    }

    const x2 = actorCxs[toIdx];
    const rawCenterX = x1 === x2 ? x1 + 17 : (x1 + x2) / 2;
    const maxPillTextPx = Math.min(230, maxPillRight - padX - 20);
    const labelStr = clampSvgLabelText(`${mi + 1}. ${msg.codeLabel}`, maxPillTextPx, 10, true);
    const pillW = Math.max(58, Math.min(maxPillRight - padX, estSvgPxLocal(labelStr, 10, true) + 16));
    const pillX = Math.max(padX, Math.min(rawCenterX - pillW / 2, maxPillRight - pillW));
    const pillCenterX = pillX + pillW / 2;
    const pillRectSig = msg.gate ? 'rect:svg-edge-pill,svg-edge-pill--gate' : 'rect:svg-edge-pill';
    if (!isLeafSvgEl(msgG.children[3], pillRectSig, { x: pillX.toFixed(1), y: (y - 21).toFixed(1), width: pillW.toFixed(1), height: 16, rx: 3 })
      || !isLeafSvgEl(msgG.children[4], 'text:svg-edge-label', { x: pillCenterX.toFixed(1), y: (y - 9.5).toFixed(1), 'text-anchor': 'middle' }, labelStr)) {
      return null;
    }
    if (msg.hasNote) {
      const noteText = clampSvgLabelText(msg.note, noteBoxW - 18, 10, false);
      if (!isLeafSvgEl(msgG.children[5], 'rect:svg-note-box', { x: noteLaneX, y: y - 11, width: noteBoxW, height: 22, rx: 4 })
        || !isLeafSvgEl(msgG.children[6], 'text:svg-note-text', { x: noteLaneX + 9, y: y + 4 }, noteText)) {
        return null;
      }
    }
    msgEndpoints.push({ fromIdx, toIdx });
  }

  // Resolve consistent (fromLabel, toLabel) splits of ' → ' in strongTxt across all M messages
  const splitOptionsPerMsg = [];
  for (let mi = 0; mi < M; mi += 1) {
    const { strongTxt } = rawMessages[mi];
    const { fromIdx, toIdx } = msgEndpoints[mi];
    const opts = [];
    let searchFrom = 0;
    while (searchFrom < strongTxt.length) {
      const pos = strongTxt.indexOf(' → ', searchFrom);
      if (pos < 0) break;
      const candFrom = strongTxt.slice(0, pos);
      const candTo = strongTxt.slice(pos + 3);
      searchFrom = pos + 1;
      if (!candFrom.trim() || candFrom.length > 80 || !candTo.trim() || candTo.length > 80) continue;
      if (fromIdx === toIdx && candFrom !== candTo) continue;
      const normFrom = normCalloutLabel(candFrom);
      const normTo = normCalloutLabel(candTo);
      if (STANDALONE_CALLOUT_STRONG_RE.test(normFrom) || CALLOUT_BARE_LABEL_RE.test(normFrom)) continue;
      if (STANDALONE_CALLOUT_STRONG_RE.test(normTo) || CALLOUT_BARE_LABEL_RE.test(normTo)) continue;
      if (clampSvgLabelText(candFrom, actorW - 20, 12, false) !== actorSvgTitles[fromIdx]) continue;
      if (clampSvgLabelText(candTo, actorW - 20, 12, false) !== actorSvgTitles[toIdx]) continue;
      opts.push({ candFrom, candTo });
    }
    if (opts.length === 0) return null;
    splitOptionsPerMsg.push(opts);
  }

  const expectedMsgSeqCandidates = [];
  const bound = new Array(K).fill(null);
  const chosenPairs = new Array(M);
  const dfs = (mi) => {
    if (expectedMsgSeqCandidates.length >= 64) return;
    if (mi === M) {
      if (bound.some((b) => b === null)) return;
      expectedMsgSeqCandidates.push(
        rawMessages.map((m, idx) => ({
          pairText: `${chosenPairs[idx].candFrom} -> ${chosenPairs[idx].candTo}`,
          expectedText: normalizeInlineText(
            `${chosenPairs[idx].candFrom} -> ${chosenPairs[idx].candTo}${m.gate ? ' (Gate)' : ''}: ${m.codeLabel}${m.hasNote ? ` — ${m.note}` : ''}`,
          ),
        })),
      );
      return;
    }
    const { fromIdx, toIdx } = msgEndpoints[mi];
    for (const opt of splitOptionsPerMsg[mi]) {
      if (bound[fromIdx] !== null && bound[fromIdx] !== opt.candFrom) continue;
      if (bound[toIdx] !== null && bound[toIdx] !== opt.candTo) continue;
      const prevFrom = bound[fromIdx];
      const prevTo = bound[toIdx];
      bound[fromIdx] = opt.candFrom;
      bound[toIdx] = opt.candTo;
      chosenPairs[mi] = opt;
      dfs(mi + 1);
      bound[fromIdx] = prevFrom;
      bound[toIdx] = prevTo;
    }
  };
  dfs(0);
  return expectedMsgSeqCandidates.length > 0 ? expectedMsgSeqCandidates : null;
}

function extractItemBlockHtml(el, page, pagePath, manifest, strictParity, { detailOnly = false, parityState = null } = {}) {
  if (!el || isHiddenEl(el)) return null;

  // 1. paragraph
  if (el.tag === 'p' && (el.classes.has('prose-para') && el.classes.size === 1 || (!strictParity && el.classes.size === 0))) {
    const info = extractInlineInfoStrict(el);
    return info ? { type: 'paragraph', info } : null;
  }

  // 2. list
  if ((el.tag === 'ul' || el.tag === 'ol') && el.classes.size === 1 && el.classes.has('list')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length === 0) return null;
    const items = [];
    for (const li of el.children) {
      if (li.tag !== 'li' || li.classes.size !== 0) return null;
      const info = extractInlineInfoStrict(li);
      if (!info) return null;
      items.push(info);
    }
    return { type: 'list', ordered: el.tag === 'ol', items };
  }

  // 3. code / diff
  if (el.tag === 'figure' && el.classes.has('code') && (el.classes.has('code--code') || el.classes.has('code--diff'))) {
    const isDiff = el.classes.has('code--diff');
    if (detailOnly && isDiff) return null;
    if (typeof el.id !== 'string' || !el.id.startsWith('code-') || !isWhitespaceOnly(el.ownText)) return null;
    if (el.children.length !== 2 && el.children.length !== 3) return null;
    const head = el.children[0];
    if (elSignature(head) !== 'figcaption:code__head' || isHiddenEl(head) || !isWhitespaceOnly(head.ownText) || head.children.length !== 3) {
      return null;
    }
    const [langSp, strongEl, linesSp] = head.children;
    if (elSignature(langSp) !== 'span:code__lang' || isHiddenEl(langSp) || langSp.children.length !== 0
      || strongEl.tag !== 'strong' || strongEl.classes.size !== 0 || isHiddenEl(strongEl) || strongEl.children.length !== 0 || strongEl.id !== `${el.id}-title`
      || elSignature(linesSp) !== 'span:code__lines' || isHiddenEl(linesSp) || linesSp.children.length !== 0) {
      return null;
    }
    const rawLangTxt = fullElementText(langSp).trim();
    let fenceLang = null;
    if (isDiff) {
      if (!rawLangTxt.endsWith(' diff') || !Object.hasOwn(CODE_LANG_BY_LABEL, rawLangTxt.slice(0, -5))) return null;
      fenceLang = 'diff';
    } else {
      if (!Object.hasOwn(CODE_LANG_BY_LABEL, rawLangTxt)) return null;
      fenceLang = CODE_LANG_BY_LABEL[rawLangTxt];
    }
    let capInfo = null;
    let scrollEl = el.children[1];
    if (el.children.length === 3) {
      if (elSignature(el.children[1]) !== 'p:code__caption') return null;
      capInfo = extractInlineInfoStrict(el.children[1]);
      if (!capInfo) return null;
      scrollEl = el.children[2];
    }
    const lines = extractCodeLinesFromScrollHtml(scrollEl, el.id);
    if (!lines) return null;
    const expLinesLabelV2 = `${lines.length} line${lines.length === 1 ? '' : 's'} · #${el.id}-L1…`;
    const expLinesLabelV1 = `${lines.length} line${lines.length === 1 ? '' : 's'} · anchors #${el.id}-L1…`;
    const actualLinesLabel = fullElementText(linesSp).trim();
    if (actualLinesLabel !== expLinesLabelV2 && (strictParity || actualLinesLabel !== expLinesLabelV1)) return null;
    return {
      type: isDiff ? 'diff' : 'code',
      anchor: el.id,
      title: fullElementText(strongEl),
      fenceLang,
      capInfo,
      lines,
    };
  }

  if (detailOnly) return null;

  // 4. metrics
  if (el.tag === 'dl' && el.classes.size === 1 && el.classes.has('metrics')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length === 0) return null;
    const items = [];
    for (const card of el.children) {
      const cardClsOk = card.tag === 'div' && (card.classes.size === 0 || (card.classes.size === 1 && card.classes.has('metric-card')));
      if (!cardClsOk || isHiddenEl(card) || !isWhitespaceOnly(card.ownText) || card.children.length !== 2) return null;
      const [dt, dd] = card.children;
      if (dt.tag !== 'dt' || dt.classes.size !== 0 || isHiddenEl(dt)
        || dd.tag !== 'dd' || dd.classes.size !== 0 || isHiddenEl(dd)) {
        return null;
      }
      let cites = [];
      let rawLabel = '';
      if (dt.children.length === 1 && elSignature(dt.children[0]) === 'span:metric__cites' && Array.isArray(dt.nodes)) {
        const cw = dt.children[0];
        const cwIdx = dt.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === cw);
        if (cwIdx < 0 || !isWhitespaceOnly(extractNodeTextSlice(dt, cwIdx + 1, dt.nodes.length) ?? 'x')
          || isHiddenEl(cw) || !isWhitespaceOnly(cw.ownText) || cw.children.length === 0
          || cw.children.some((a) => a.tag !== 'a' || !a.classes.has('cite') || isHiddenEl(a) || a.children.length !== 0)) {
          return null;
        }
        cites = cw.children.map((a) => fullElementText(a).trim());
        rawLabel = normalizeInlineText(extractNodeTextSlice(dt, 0, cwIdx) ?? '');
      } else if (dt.children.length === 0) {
        rawLabel = normalizeInlineText(decodeHtmlAttr(dt.ownText));
      } else {
        return null;
      }
      const valEl = dd.children[0];
      if (!valEl || valEl.tag !== 'span' || !valEl.classes.has('metric__value') || isHiddenEl(valEl) || valEl.children.length !== 0) return null;
      const unitEl = dd.children[1]?.classes.has('metric__unit') ? dd.children[1] : null;
      if (unitEl && (unitEl.tag !== 'span' || isHiddenEl(unitEl) || unitEl.children.length !== 0)) return null;
      const ddCiteEls = dd.children.slice(unitEl ? 2 : 1);
      if (ddCiteEls.length > 0) {
        if (strictParity || cites.length > 0
          || ddCiteEls.some((a) => a.tag !== 'a' || !a.classes.has('cite') || isHiddenEl(a) || a.children.length !== 0)) {
          return null;
        }
        cites = ddCiteEls.map((a) => fullElementText(a).trim());
      }
      if (!isWhitespaceOnly(dd.ownText)) return null;
      const valText = fullElementText(valEl).trim();
      const unitText = unitEl ? fullElementText(unitEl).trim() : '';
      if (!rawLabel || !valText) return null;
      items.push({
        label: rawLabel,
        cites,
        expectedText: normalizeInlineText(`${rawLabel}: ${valText}${unitText ? ` ${unitText}` : ''}${cites.length ? ` (${cites.join(', ')})` : ''}`),
      });
    }
    return { type: 'metrics', items };
  }

  // 5. finding
  if (el.tag === 'article' && el.classes.has('finding') && typeof el.id === 'string' && el.id.startsWith('f-')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length < 3) return null;
    const blockId = el.id.slice(2);
    const head = el.children[0];
    if (elSignature(head) !== 'header:item__head' || isHiddenEl(head) || !isWhitespaceOnly(head.ownText) || head.children.length !== 2) {
      return null;
    }
    let title = null;
    let sevLabel = null;
    let confLabel = null;
    let verif = null;
    if (elSignature(head.children[0]) === 'div:item__title-row') {
      const [tRow, labelsP] = head.children;
      if (isHiddenEl(tRow) || !isWhitespaceOnly(tRow.ownText) || tRow.children.length !== 2
        || elSignature(labelsP) !== 'p:labels' || isHiddenEl(labelsP) || !isWhitespaceOnly(labelsP.ownText)
        || (labelsP.children.length !== 2 && labelsP.children.length !== 3)) {
        return null;
      }
      const [idSp, h3] = tRow.children;
      if (elSignature(idSp) !== 'span:item__id' || isHiddenEl(idSp) || idSp.children.length !== 0 || fullElementText(idSp).trim() !== `Finding ${blockId}`
        || h3.tag !== 'h3' || h3.classes.size !== 0 || isHiddenEl(h3) || h3.children.length !== 0 || h3.id !== `${el.id}-t`) {
        return null;
      }
      title = fullElementText(h3);
      const [sevSp, confSp, vChip] = labelsP.children;
      const sevM = /^(Critical|High|Medium|Low|Info) severity$/.exec(fullElementText(sevSp).trim());
      if (!sevM || !sevSp.classes.has('sev') || !sevSp.classes.has(`sev-${sevM[1].toLowerCase()}`) || !el.classes.has(`sev-${sevM[1].toLowerCase()}`) || isHiddenEl(sevSp) || sevSp.children.length !== 0) {
        return null;
      }
      const confTxt = fullElementText(confSp).trim();
      if (!['Proven', 'Recommended', 'Defect', 'Open'].includes(confTxt) || !confSp.classes.has('conf') || !confSp.classes.has(`conf-${confTxt.toLowerCase()}`) || isHiddenEl(confSp) || confSp.children.length !== 0) {
        return null;
      }
      if (vChip) {
        verif = parseVerifChipHtml(vChip);
        if (!verif) return null;
      }
      sevLabel = sevM[1];
      confLabel = confTxt;
    } else if (!strictParity && elSignature(head.children[0]) === 'p:labels') {
      const [labelsP, h3] = head.children;
      if (isHiddenEl(labelsP) || !isWhitespaceOnly(labelsP.ownText) || labelsP.children.length !== 3
        || h3.tag !== 'h3' || h3.classes.size !== 0 || isHiddenEl(h3) || h3.children.length !== 0 || h3.id !== `${el.id}-t`) {
        return null;
      }
      const [sevSp, confSp, idSp] = labelsP.children;
      const sevM = /^(Critical|High|Medium|Low|Info) severity$/.exec(fullElementText(sevSp).trim());
      const confTxt = fullElementText(confSp).trim();
      if (!sevM || !sevSp.classes.has(`sev-${sevM[1].toLowerCase()}`) || !el.classes.has(`sev-${sevM[1].toLowerCase()}`)
        || !['Proven', 'Recommended', 'Defect', 'Open'].includes(confTxt)
        || elSignature(idSp) !== 'span:item__id' || fullElementText(idSp).trim() !== `Finding ${blockId}`) {
        return null;
      }
      title = fullElementText(h3);
      sevLabel = sevM[1];
      confLabel = confTxt;
    } else {
      return null;
    }
    const claimP = el.children[1];
    if (elSignature(claimP) !== 'p:claim' || claimP.children.length < 1
      || elSignature(claimP.children[0]) !== 'span:field-label' || fullElementText(claimP.children[0]).trim() !== 'Claim') {
      return null;
    }
    const claimInfo = extractInlineInfoStrict(claimP, { skipEl: claimP.children[0] });
    const evLabels = extractSupportEvRefsHtml(el.children[2], el.id, 'Evidence', page, pagePath, manifest, parityState);
    if (!claimInfo || !evLabels) return null;
    const detailBlocks = [];
    if (el.children.length > 3) {
      let rawDetails = [];
      if (el.children.length === 4 && elSignature(el.children[3]) === 'div:finding__detail') {
        const detDiv = el.children[3];
        if (isHiddenEl(detDiv) || !isWhitespaceOnly(detDiv.ownText) || detDiv.children.length === 0) return null;
        rawDetails = detDiv.children;
      } else if (!strictParity) {
        rawDetails = el.children.slice(3);
      } else {
        return null;
      }
      for (const db of rawDetails) {
        const parsedDb = extractItemBlockHtml(db, page, pagePath, manifest, strictParity, { detailOnly: true, parityState });
        if (!parsedDb) return null;
        detailBlocks.push(parsedDb);
      }
    }
    return {
      type: 'finding',
      id: blockId,
      anchor: el.id,
      title,
      sevLabel,
      confLabel,
      verif,
      claimInfo,
      evLabels,
      detailBlocks,
    };
  }

  // 6. risk
  if (el.tag === 'article' && el.classes.size === 1 && el.classes.has('risk') && typeof el.id === 'string' && el.id.startsWith('r-')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length !== 2) return null;
    const blockId = el.id.slice(2);
    const head = el.children[0];
    if (elSignature(head) !== 'header:item__head' || isHiddenEl(head) || !isWhitespaceOnly(head.ownText) || head.children.length !== 2) {
      return null;
    }
    let title = null;
    let likelihood = null;
    let impact = null;
    if (elSignature(head.children[0]) === 'div:item__title-row') {
      const [tRow, labelsP] = head.children;
      if (isHiddenEl(tRow) || !isWhitespaceOnly(tRow.ownText) || tRow.children.length !== 2
        || elSignature(labelsP) !== 'p:labels' || isHiddenEl(labelsP) || !isWhitespaceOnly(labelsP.ownText) || labelsP.children.length !== 2) {
        return null;
      }
      const [idSp, h3] = tRow.children;
      if (elSignature(idSp) !== 'span:item__id' || isHiddenEl(idSp) || idSp.children.length !== 0 || fullElementText(idSp).trim() !== `Risk ${blockId}`
        || h3.tag !== 'h3' || h3.classes.size !== 0 || isHiddenEl(h3) || h3.children.length !== 0 || h3.id !== `${el.id}-t`) {
        return null;
      }
      title = fullElementText(h3);
      const likeM = /^Likelihood (low|medium|high)$/.exec(fullElementText(labelsP.children[0]).trim());
      const impM = /^Impact (low|medium|high)$/.exec(fullElementText(labelsP.children[1]).trim());
      if (!likeM || !labelsP.children[0].classes.has(`lvl-${likeM[1]}`) || !impM || !labelsP.children[1].classes.has(`lvl-${impM[1]}`)) return null;
      likelihood = likeM[1];
      impact = impM[1];
    } else if (!strictParity && elSignature(head.children[0]) === 'p:labels') {
      const [labelsP, h3] = head.children;
      if (isHiddenEl(labelsP) || !isWhitespaceOnly(labelsP.ownText) || labelsP.children.length !== 3
        || h3.tag !== 'h3' || h3.classes.size !== 0 || isHiddenEl(h3) || h3.children.length !== 0 || h3.id !== `${el.id}-t`) {
        return null;
      }
      const likeM = /^Likelihood (low|medium|high)$/.exec(fullElementText(labelsP.children[0]).trim());
      const impM = /^Impact (low|medium|high)$/.exec(fullElementText(labelsP.children[1]).trim());
      if (!likeM || !impM || elSignature(labelsP.children[2]) !== 'span:item__id' || fullElementText(labelsP.children[2]).trim() !== `Risk ${blockId}`) {
        return null;
      }
      title = fullElementText(h3);
      likelihood = likeM[1];
      impact = impM[1];
    } else {
      return null;
    }
    const mitP = el.children[1];
    if (elSignature(mitP) !== 'p:claim' || mitP.children.length < 1
      || elSignature(mitP.children[0]) !== 'span:field-label' || fullElementText(mitP.children[0]).trim() !== 'Mitigation') {
      return null;
    }
    const mitInfo = extractInlineInfoStrict(mitP, { skipEl: mitP.children[0] });
    if (!mitInfo) return null;
    return { type: 'risk', id: blockId, anchor: el.id, title, likelihood, impact, mitInfo };
  }

  // 7. requirement
  if (el.tag === 'article' && el.classes.size === 1 && el.classes.has('requirement') && typeof el.id === 'string' && el.id.startsWith('req-')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length < 2 || el.children.length > 4) return null;
    const blockId = el.id.slice(4);
    const head = el.children[0];
    if (elSignature(head) !== 'header:item__head' || isHiddenEl(head) || !isWhitespaceOnly(head.ownText) || head.children.length !== 2) return null;
    const [tRow, labelsP] = head.children;
    if (elSignature(tRow) !== 'div:item__title-row' || isHiddenEl(tRow) || !isWhitespaceOnly(tRow.ownText) || tRow.children.length !== 2
      || elSignature(labelsP) !== 'p:labels' || isHiddenEl(labelsP) || !isWhitespaceOnly(labelsP.ownText) || labelsP.children.length !== 2) {
      return null;
    }
    const [idSp, h3] = tRow.children;
    const [earsSp, vChip] = labelsP.children;
    const earsLabel = fullElementText(earsSp).trim();
    const verif = parseVerifChipHtml(vChip);
    if (elSignature(idSp) !== 'span:item__id' || isHiddenEl(idSp) || idSp.children.length !== 0 || fullElementText(idSp).trim() !== `Requirement ${blockId}`
      || h3.tag !== 'h3' || h3.classes.size !== 0 || isHiddenEl(h3) || h3.children.length !== 0 || h3.id !== `${el.id}-t`
      || elSignature(earsSp) !== 'span:ears-pill' || isHiddenEl(earsSp) || earsSp.children.length !== 0 || !EARS_LABELS_SET.has(earsLabel)
      || !verif) {
      return null;
    }
    const specP = el.children[1];
    if (elSignature(specP) !== 'p:claim' || specP.children.length < 1
      || elSignature(specP.children[0]) !== 'span:field-label' || fullElementText(specP.children[0]).trim() !== 'Specification') {
      return null;
    }
    const specInfo = extractInlineInfoStrict(specP, { skipEl: specP.children[0] });
    if (!specInfo) return null;
    let scenarios = [];
    let evLabels = null;
    let cIdx = 2;
    if (el.children[cIdx]?.classes.has('table__scroll')) {
      const scScroll = el.children[cIdx];
      if (scScroll.tag !== 'div' || isHiddenEl(scScroll) || !isWhitespaceOnly(scScroll.ownText) || scScroll.children.length !== 1) return null;
      const tbl = scScroll.children[0];
      if (elSignature(tbl) !== 'table:scenario-table' || isHiddenEl(tbl) || !isWhitespaceOnly(tbl.ownText) || tbl.children.length !== 3) return null;
      const [cap, thead, tbody] = tbl.children;
      if (cap.tag !== 'caption' || cap.id !== `${el.id}-sc` || thead.tag !== 'thead' || thead.children.length !== 1
        || thead.children[0].children.map((th) => fullElementText(th).trim()).join('|') !== 'Scenario|Given|When|Then'
        || tbody.tag !== 'tbody' || !isWhitespaceOnly(tbody.ownText) || tbody.children.length === 0) {
        return null;
      }
      scenarios = [];
      for (const tr of tbody.children) {
        if (tr.tag !== 'tr' || isHiddenEl(tr) || !isWhitespaceOnly(tr.ownText) || tr.children.length !== 4
          || tr.children[0].tag !== 'th' || tr.children.some((cell, ci) => (ci > 0 && cell.tag !== 'td') || isHiddenEl(cell) || cell.children.length !== 0)) {
          return null;
        }
        scenarios.push({
          name: fullElementText(tr.children[0]),
          given: fullElementText(tr.children[1]),
          when: fullElementText(tr.children[2]),
          then: fullElementText(tr.children[3]),
        });
      }
      cIdx += 1;
    }
    if (cIdx < el.children.length) {
      evLabels = extractSupportEvRefsHtml(el.children[cIdx], el.id, 'Evidence', page, pagePath, manifest, parityState);
      if (!evLabels) return null;
      cIdx += 1;
    }
    if (cIdx !== el.children.length) return null;
    return {
      type: 'requirement',
      id: blockId,
      anchor: el.id,
      title: fullElementText(h3),
      earsLabel,
      verif,
      specInfo,
      scenarios,
      evLabels,
    };
  }

  // 8. comparison
  if (el.tag === 'figure' && el.classes.has('figure') && el.classes.has('comparison') && typeof el.id === 'string' && el.id.startsWith('cmp-')) {
    if (!isWhitespaceOnly(el.ownText) || (el.children.length !== 2 && el.children.length !== 3)) return null;
    const [figcap, grid, evDiv] = el.children;
    if (figcap.tag !== 'figcaption' || figcap.classes.size !== 0 || isHiddenEl(figcap) || !isWhitespaceOnly(figcap.ownText)
      || (figcap.children.length !== 1 && figcap.children.length !== 2)) {
      return null;
    }
    const strongT = figcap.children[0];
    if (strongT.tag !== 'strong' || strongT.id !== `${el.id}-t` || isHiddenEl(strongT) || strongT.children.length !== 0) return null;
    let capInfo = null;
    if (figcap.children.length === 2) {
      if (figcap.children[1].tag !== 'span' || figcap.children[1].classes.size !== 0) return null;
      capInfo = extractInlineInfoStrict(figcap.children[1]);
      if (!capInfo) return null;
    }
    if (elSignature(grid) !== 'div:cmp-grid' || isHiddenEl(grid) || !isWhitespaceOnly(grid.ownText) || grid.children.length !== 2) return null;
    const sides = [];
    for (let si = 0; si < 2; si += 1) {
      const side = grid.children[si];
      const sideKey = si === 0 ? 'left' : 'right';
      if (side.tag !== 'div' || !side.classes.has('cmp-side') || isHiddenEl(side) || !isWhitespaceOnly(side.ownText) || side.children.length < 2) {
        return null;
      }
      const headP = side.children[0];
      const sumP = side.children[1];
      if (elSignature(headP) !== 'p:cmp-side__head' || isHiddenEl(headP) || !isWhitespaceOnly(headP.ownText) || headP.children.length !== 1
        || elSignature(headP.children[0]) !== 'span:cmp-side__tag' || isHiddenEl(headP.children[0]) || headP.children[0].children.length !== 0
        || elSignature(sumP) !== 'p:cmp-side__summary') {
        return null;
      }
      const sideLabel = fullElementText(headP.children[0]);
      const normSide = normCalloutLabel(sideLabel);
      if (STANDALONE_CALLOUT_STRONG_RE.test(normSide) || CALLOUT_BARE_LABEL_RE.test(normSide)) return null;
      const summaryInfo = extractInlineInfoStrict(sumP);
      if (!summaryInfo) return null;
      let sIdx = 2;
      let items = null;
      if (side.children[sIdx]?.tag === 'ul') {
        const ul = side.children[sIdx];
        if (elSignature(ul) !== 'ul:cmp-side__list' || isHiddenEl(ul) || !isWhitespaceOnly(ul.ownText) || ul.children.length === 0) return null;
        items = [];
        for (const li of ul.children) {
          if (li.tag !== 'li' || li.classes.size !== 0) return null;
          const itInfo = extractInlineInfoStrict(li);
          if (!itInfo) return null;
          items.push(itInfo);
        }
        sIdx += 1;
      }
      let code = null;
      if (sIdx < side.children.length) {
        if (sIdx + 2 !== side.children.length) return null;
        const vhP = side.children[sIdx];
        const cScroll = side.children[sIdx + 1];
        if (vhP.tag !== 'p' || !vhP.classes.has('visually-hidden') || vhP.id !== `${el.id}-${sideKey}-code` || vhP.children.length !== 0) return null;
        const vhTxt = fullElementText(vhP);
        if (!vhTxt.startsWith(`${sideLabel} (`) || !vhTxt.endsWith(')')) return null;
        const langLabel = vhTxt.slice(sideLabel.length + 2, -1);
        if (!Object.hasOwn(CODE_LANG_BY_LABEL, langLabel)) return null;
        const cLines = extractCodeLinesFromScrollHtml(cScroll, null);
        if (!cLines) return null;
        code = { fenceLang: CODE_LANG_BY_LABEL[langLabel], lines: cLines };
        sIdx += 2;
      }
      if (sIdx !== side.children.length) return null;
      sides.push({ label: sideLabel, summaryInfo, items, code });
    }
    let evLabels = null;
    if (evDiv) {
      evLabels = extractSupportEvRefsHtml(evDiv, el.id, 'Evidence', page, pagePath, manifest, parityState);
      if (!evLabels) return null;
    }
    return {
      type: 'comparison',
      anchor: el.id,
      title: fullElementText(strongT),
      capInfo,
      sides,
      evLabels,
    };
  }

  // 9. table
  if (el.tag === 'div' && el.classes.size === 1 && el.classes.has('table') && typeof el.id === 'string' && el.id.startsWith('tbl-')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length !== 1) return null;
    const scrollDiv = el.children[0];
    if (!scrollDiv || scrollDiv.tag !== 'div' || !scrollDiv.classes.has('table__scroll') || isHiddenEl(scrollDiv)
      || !isWhitespaceOnly(scrollDiv.ownText) || scrollDiv.children.length !== 1) {
      return null;
    }
    const tbl = scrollDiv.children[0];
    if (tbl.tag !== 'table' || tbl.classes.size !== 0 || isHiddenEl(tbl) || !isWhitespaceOnly(tbl.ownText) || tbl.children.length !== 3) {
      return null;
    }
    const [cap, thead, tbody] = tbl.children;
    if (cap.tag !== 'caption' || cap.id !== `${el.id}-cap` || isHiddenEl(cap) || cap.children.length !== 0
      || thead.tag !== 'thead' || isHiddenEl(thead) || !isWhitespaceOnly(thead.ownText) || thead.children.length !== 1
      || thead.children[0].tag !== 'tr' || thead.children[0].children.length === 0
      || tbody.tag !== 'tbody' || isHiddenEl(tbody) || !isWhitespaceOnly(tbody.ownText) || tbody.children.length === 0) {
      return null;
    }
    const columns = [];
    for (const th of thead.children[0].children) {
      if (th.tag !== 'th' || isHiddenEl(th) || th.children.length !== 0) return null;
      columns.push({ label: fullElementText(th), numeric: th.classes.has('num') });
    }
    const rows = [];
    for (const tr of tbody.children) {
      if (tr.tag !== 'tr' || isHiddenEl(tr) || !isWhitespaceOnly(tr.ownText) || tr.children.length !== columns.length) return null;
      const rowCells = [];
      for (let ci = 0; ci < tr.children.length; ci += 1) {
        const cell = tr.children[ci];
        if ((ci === 0 ? cell.tag !== 'th' : cell.tag !== 'td') || cell.classes.has('num') !== columns[ci].numeric) return null;
        const cInfo = extractInlineInfoStrict(cell);
        if (!cInfo) return null;
        rowCells.push(cInfo);
      }
      rows.push(rowCells);
    }
    return {
      type: 'table',
      anchor: el.id,
      caption: fullElementText(cap),
      columns,
      rows,
    };
  }

  // 10. chart
  if (el.tag === 'figure' && el.classes.has('figure') && el.classes.has('chart') && typeof el.id === 'string' && el.id.startsWith('chart-')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length < 2 || el.children.length > 4) return null;
    const figcap = el.children[0];
    if (figcap.tag !== 'figcaption' || figcap.classes.size !== 0 || isHiddenEl(figcap) || !isWhitespaceOnly(figcap.ownText) || figcap.children.length !== 2) {
      return null;
    }
    const [strongT, capSp] = figcap.children;
    if (strongT.tag !== 'strong' || strongT.id !== `${el.id}-t` || isHiddenEl(strongT) || strongT.children.length !== 0
      || capSp.tag !== 'span' || capSp.classes.size !== 0) {
      return null;
    }
    const capInfo = extractInlineInfoStrict(capSp);
    if (!capInfo) return null;
    const title = fullElementText(strongT);

    if (!strictParity && el.children[1]?.tag === 'table' && el.children[1].classes.has('chart__table')) {
      const tbl = el.children[1];
      const [thead, tbody] = tbl.children;
      if (tbl.children.length !== 2 || thead?.tag !== 'thead' || tbody?.tag !== 'tbody' || tbody.children.length === 0) return null;
      const unitM = /^Value \(([\s\S]+)\)$/.exec(fullElementText(thead.children[0]?.children[2] ?? '').trim());
      if (!unitM) return null;
      const unit = unitM[1];
      const series = [];
      for (const tr of tbody.children) {
        if (tr.children.length !== 3 || tr.children[0].tag !== 'th' || tr.children[0].children.length !== 0) return null;
        const vTxt = fullElementText(tr.children[2]).trim();
        if (!vTxt.endsWith(` ${unit}`)) return null;
        series.push({ label: fullElementText(tr.children[0]), valueStr: vTxt.slice(0, -(unit.length + 1)) });
      }
      let evLabels = null;
      if (el.children.length === 3) {
        evLabels = extractSupportEvRefsHtml(el.children[2], el.id, 'Measured in', page, pagePath, manifest, parityState);
        if (!evLabels) return null;
      } else if (el.children.length !== 2) {
        return null;
      }
      return { type: 'chart', kind: 'bar', anchor: el.id, title, capInfo, unit, series, evLabels };
    }

    const kind = el.classes.has('chart--comparison') ? 'comparison' : el.classes.has('chart--quantiles') ? 'quantiles' : el.classes.has('chart--bar') ? 'bar' : null;
    if (!kind) return null;
    let cIdx = 1;
    let svgEl = null;
    if (kind === 'comparison' || kind === 'quantiles') {
      const canvas = el.children[cIdx];
      if (elSignature(canvas) !== 'div:diagram-canvas' || isHiddenEl(canvas) || !isWhitespaceOnly(canvas.ownText) || canvas.children.length !== 1
        || canvas.children[0].tag !== 'svg') {
        return null;
      }
      svgEl = canvas.children[0];
      cIdx += 1;
    }
    const scrollDiv = el.children[cIdx];
    if (!scrollDiv || scrollDiv.tag !== 'div' || !scrollDiv.classes.has('table__scroll') || isHiddenEl(scrollDiv)
      || !isWhitespaceOnly(scrollDiv.ownText) || scrollDiv.children.length !== 1) {
      return null;
    }
    cIdx += 1;
    let evLabels = null;
    if (cIdx < el.children.length) {
      evLabels = extractSupportEvRefsHtml(el.children[cIdx], el.id, 'Measured in', page, pagePath, manifest, parityState);
      if (!evLabels) return null;
      cIdx += 1;
    }
    if (cIdx !== el.children.length) return null;

    const tbl = scrollDiv.children[0];
    if (elSignature(tbl) !== 'table:chart-table' || isHiddenEl(tbl) || !isWhitespaceOnly(tbl.ownText) || tbl.children.length !== 3) return null;
    const [cap, thead, tbody] = tbl.children;
    if (cap.tag !== 'caption' || cap.id !== `cap-${el.id}` || !cap.classes.has('visually-hidden') || cap.children.length !== 0
      || thead.tag !== 'thead' || isHiddenEl(thead) || !isWhitespaceOnly(thead.ownText) || thead.children.length !== 1
      || thead.children[0].tag !== 'tr' || isHiddenEl(thead.children[0]) || !isWhitespaceOnly(thead.children[0].ownText)
      || tbody.tag !== 'tbody' || isHiddenEl(tbody) || !isWhitespaceOnly(tbody.ownText) || tbody.children.length === 0) {
      return null;
    }
    const capTxt = fullElementText(cap);
    if (!capTxt.startsWith(`${title} (`) || !capTxt.endsWith(')')) return null;
    const unit = capTxt.slice(title.length + 2, -1);
    const ths = thead.children[0].children;
    if (ths.some((th) => th.tag !== 'th' || isHiddenEl(th) || th.children.length !== 0)) return null;

    const extractValUnitCell = (td, mode = 'plain') => {
      if (!td || elSignature(td) !== 'td:num' || isHiddenEl(td)) return null;
      const unitSp = td.children[td.children.length - 1];
      if (!unitSp || elSignature(unitSp) !== 'span:unit' || isHiddenEl(unitSp) || unitSp.children.length !== 0 || fullElementText(unitSp) !== unit) {
        return null;
      }
      if (mode === 'strong') {
        if (td.children.length !== 2 || !verifyExactInterChildTextSlices(td, ['', ' ', ''])) return null;
        const st = td.children[0];
        if (elSignature(st) !== 'strong:' || isHiddenEl(st) || st.children.length !== 0) return null;
        const numStr = fullElementText(st);
        return isCanonicalChartNumStr(numStr) ? numStr : null;
      }
      if (td.children.length !== 1 || !Array.isArray(td.nodes)) return null;
      const unitNodeIdx = td.nodes.findIndex((nd) => nd.kind === 'el');
      if (unitNodeIdx < 0 || extractNodeTextSlice(td, unitNodeIdx + 1, td.nodes.length) !== '') return null;
      const beforeSlice = extractNodeTextSlice(td, 0, unitNodeIdx);
      if (beforeSlice === null || !beforeSlice.endsWith(' ')) return null;
      const numStr = beforeSlice.slice(0, -1);
      return isCanonicalChartNumStr(numStr) ? numStr : null;
    };

    if (kind === 'bar') {
      if (ths.length !== 3
        || elSignature(ths[0]) !== 'th:' || elSignature(ths[1]) !== 'th:' || elSignature(ths[2]) !== 'th:num'
        || ths.map((th) => fullElementText(th).trim()).join('|') !== 'Series|Relative|Value') {
        return null;
      }
      const series = [];
      const barCells = [];
      for (const tr of tbody.children) {
        if (elSignature(tr) !== 'tr:' || isHiddenEl(tr) || !isWhitespaceOnly(tr.ownText) || tr.children.length !== 3
          || elSignature(tr.children[0]) !== 'th:' || isHiddenEl(tr.children[0]) || tr.children[0].children.length !== 0) {
          return null;
        }
        const valueStr = extractValUnitCell(tr.children[2], 'plain');
        if (valueStr === null) return null;
        series.push({ label: fullElementText(tr.children[0]), valueStr });
        barCells.push(tr.children[1]);
      }
      const maxBarVal = Math.max(...series.map((s) => Number(s.valueStr)), 1);
      for (let ri = 0; ri < series.length; ri += 1) {
        const barTd = barCells[ri];
        const barSvg = barTd?.children[0];
        const valNum = Number(series[ri].valueStr);
        const expW = Math.max(valNum === 0 ? 0 : 2, Math.round((valNum / maxBarVal) * 240));
        if (elSignature(barTd) !== 'td:chart__bar' || isHiddenEl(barTd) || !isWhitespaceOnly(barTd.ownText) || barTd.children.length !== 1
          || !isSvgRootEl(barSvg, 'svg:bar', '0 0 240 14') || barSvg.children.length !== 2
          || !isLeafSvgEl(barSvg.children[0], 'rect:bar__track', { width: 240, height: 14, rx: 3 })
          || !isLeafSvgEl(barSvg.children[1], 'rect:bar__fill', { width: expW, height: 14, rx: 3 })) {
          return null;
        }
      }
      return { type: 'chart', kind: 'bar', anchor: el.id, title, capInfo, unit, series, evLabels };
    }
    if (kind === 'comparison') {
      if (ths.length !== 4
        || elSignature(ths[0]) !== 'th:' || elSignature(ths[1]) !== 'th:num'
        || elSignature(ths[2]) !== 'th:num' || elSignature(ths[3]) !== 'th:num'
        || fullElementText(ths[0]).trim() !== 'Series' || fullElementText(ths[3]).trim() !== 'Delta') {
        return null;
      }
      const baselineLabel = fullElementText(ths[1]);
      const candidateLabel = fullElementText(ths[2]);
      const series = [];
      const deltaPills = [];
      for (const tr of tbody.children) {
        if (elSignature(tr) !== 'tr:' || isHiddenEl(tr) || !isWhitespaceOnly(tr.ownText) || tr.children.length !== 4
          || elSignature(tr.children[0]) !== 'th:' || isHiddenEl(tr.children[0]) || tr.children[0].children.length !== 0) {
          return null;
        }
        const baseStr = extractValUnitCell(tr.children[1], 'plain');
        const valStr = extractValUnitCell(tr.children[2], 'strong');
        const deltaTd = tr.children[3];
        if (baseStr === null || valStr === null
          || elSignature(deltaTd) !== 'td:num' || isHiddenEl(deltaTd) || !isWhitespaceOnly(deltaTd.ownText) || deltaTd.children.length !== 1) {
          return null;
        }
        const pillSp = deltaTd.children[0];
        if (isHiddenEl(pillSp) || pillSp.children.length !== 0) return null;
        series.push({ label: fullElementText(tr.children[0]), baseStr, valStr });
        deltaPills.push(pillSp);
      }
      const numericSeries = series.map((s) => ({ label: s.label, baseline: Number(s.baseStr), value: Number(s.valStr) }));
      const matchesParity = [false, true].some((higherIsBetter) => {
        for (let ri = 0; ri < numericSeries.length; ri += 1) {
          const d = computeComparisonDeltaLocal(numericSeries[ri].baseline, numericSeries[ri].value, higherIsBetter);
          const expPillSig = `span:delta-pill,${d.favorable ? 'delta-pill--good' : 'delta-pill--warn'}`;
          if (elSignature(deltaPills[ri]) !== expPillSig || fullElementText(deltaPills[ri]) !== d.text) return false;
        }
        return verifyComparisonChartSvg(svgEl, { baselineLabel, candidateLabel, unit, series: numericSeries, higherIsBetter });
      });
      if (!matchesParity) return null;
      return { type: 'chart', kind: 'comparison', anchor: el.id, title, capInfo, unit, baselineLabel, candidateLabel, series, evLabels };
    }
    // quantiles
    const thLabels = ths.map((th) => fullElementText(th).trim()).join('|');
    if ((thLabels !== 'Series|p50|p95|p99' && thLabels !== 'Series|p50|p95|p99|Max')
      || elSignature(ths[0]) !== 'th:' || ths.slice(1).some((th) => elSignature(th) !== 'th:num')) {
      return null;
    }
    const hasMaxCol = thLabels === 'Series|p50|p95|p99|Max';
    const budgetTextEl = svgEl.children.find((ch) => ch.tag === 'text' && ch.classes.has('svg-budget-label')) ?? null;
    const budgetLineEl = svgEl.children.find((ch) => ch.tag === 'line' && ch.classes.has('svg-budget-line')) ?? null;
    if (Boolean(budgetTextEl) !== Boolean(budgetLineEl)) return null;
    const hasBudget = Boolean(budgetTextEl);
    const series = [];
    const numericSeries = [];
    for (const tr of tbody.children) {
      if (elSignature(tr) !== 'tr:' || isHiddenEl(tr) || !isWhitespaceOnly(tr.ownText) || tr.children.length !== ths.length
        || elSignature(tr.children[0]) !== 'th:' || isHiddenEl(tr.children[0]) || tr.children[0].children.length !== 0) {
        return null;
      }
      const p50Str = extractValUnitCell(tr.children[1], 'plain');
      const p95Str = extractValUnitCell(tr.children[2], 'plain');
      const p99Str = extractValUnitCell(tr.children[3], 'strong');
      if (p50Str === null || p95Str === null || p99Str === null) return null;
      const p50 = Number(p50Str);
      const p95 = Number(p95Str);
      const p99 = Number(p99Str);
      if (p50 > p95 || p95 > p99) return null;
      let maxVal;
      if (hasMaxCol) {
        const maxTd = tr.children[4];
        if (!maxTd || elSignature(maxTd) !== 'td:num' || isHiddenEl(maxTd)) return null;
        if (maxTd.children.length === 0) {
          if (fullElementText(maxTd) !== '—') return null;
        } else {
          const maxStr = extractValUnitCell(maxTd, 'plain');
          if (maxStr === null || Number(maxStr) < p99) return null;
          maxVal = Number(maxStr);
        }
      }
      const label = fullElementText(tr.children[0]);
      series.push({ label, p50Str, p95Str, p99Str });
      numericSeries.push(maxVal !== undefined ? { label, p50, p95, p99, max: maxVal } : { label, p50, p95, p99 });
    }
    if (hasMaxCol && !numericSeries.some((s) => s.max !== undefined)) return null;
    if (!verifyQuantilesChartSvg(svgEl, { unit, series: numericSeries, hasBudget, budget: undefined })) return null;
    return {
      type: 'chart',
      kind: 'quantiles',
      anchor: el.id,
      title,
      capInfo,
      unit,
      hasBudget,
      budgetSvgLabel: budgetTextEl ? fullElementText(budgetTextEl) : null,
      verifyWithBudget: (bNum) => verifyQuantilesChartSvg(svgEl, { unit, series: numericSeries, hasBudget: true, budget: bNum }),
      series,
      evLabels,
    };
  }

  // 11. diagram
  if (el.tag === 'figure' && el.classes.has('figure') && el.classes.has('diagram') && typeof el.id === 'string' && el.id.startsWith('diagram-')) {
    if (!isWhitespaceOnly(el.ownText) || el.children.length < 2 || el.children.length > 4) return null;
    const figcap = el.children[0];
    if (figcap.tag !== 'figcaption' || figcap.classes.size !== 0 || isHiddenEl(figcap) || !isWhitespaceOnly(figcap.ownText) || figcap.children.length !== 2) {
      return null;
    }
    const [strongT, capSp] = figcap.children;
    if (strongT.tag !== 'strong' || strongT.id !== `${el.id}-t` || isHiddenEl(strongT) || strongT.children.length !== 0
      || capSp.tag !== 'span' || capSp.classes.size !== 0) {
      return null;
    }
    const capInfo = extractInlineInfoStrict(capSp);
    if (!capInfo) return null;
    const title = fullElementText(strongT);

    if (!strictParity && el.children.length === 2 && el.children[1].tag === 'ol' && el.children[1].classes.has('flow')) {
      const ol = el.children[1];
      if (!isWhitespaceOnly(ol.ownText) || ol.children.length === 0) return null;
      const steps = [];
      for (let si = 0; si < ol.children.length; si += 1) {
        const li = ol.children[si];
        const strong = li.children.find((c) => c.tag === 'strong');
        const gate = li.children.some((c) => c.classes.has('gate-label'));
        const small = li.children.find((c) => c.tag === 'small');
        if (!strong || !small) return null;
        const rawV1Label = fullElementText(strong);
        const rawV1Detail = fullElementText(small);
        const sLabel = normalizeInlineText(rawV1Label);
        const detail = normalizeInlineText(rawV1Detail);
        steps.push({
          rawLabel: rawV1Label,
          rawDetail: rawV1Detail,
          label: sLabel,
          gate,
          expectedText: normalizeInlineText(`${sLabel}${gate ? ' (Gate)' : ''} — ${detail}`),
        });
      }
      return { type: 'diagram', kind: 'flow', anchor: el.id, title, capInfo, steps, evLabels: null };
    }

    const kind = el.classes.has('diagram--topology') ? 'topology' : el.classes.has('diagram--sequence') ? 'sequence' : el.classes.has('diagram--flow') ? 'flow' : null;
    const canvas = el.children[1];
    const ledger = el.children[2];
    if (!kind || elSignature(canvas) !== 'div:diagram-canvas' || isHiddenEl(canvas) || !isWhitespaceOnly(canvas.ownText)
      || canvas.children.length !== 1 || canvas.children[0].tag !== 'svg' || !ledger || isHiddenEl(ledger)) {
      return null;
    }
    let evLabels = null;
    if (el.children.length === 4) {
      evLabels = extractSupportEvRefsHtml(el.children[3], el.id, 'Evidence', page, pagePath, manifest, parityState);
      if (!evLabels) return null;
    } else if (el.children.length !== 3) {
      return null;
    }

    if (kind === 'topology') {
      if (elSignature(ledger) !== 'div:topo-ledger' || !isWhitespaceOnly(ledger.ownText) || ledger.children.length !== 2) return null;
      const [groupsWrap, edgesOl] = ledger.children;
      if (elSignature(groupsWrap) !== 'div:topo-ledger__groups' || isHiddenEl(groupsWrap) || !isWhitespaceOnly(groupsWrap.ownText) || groupsWrap.children.length === 0
        || elSignature(edgesOl) !== 'ol:topo-ledger__edges' || isHiddenEl(edgesOl) || !isWhitespaceOnly(edgesOl.ownText) || edgesOl.children.length === 0) {
        return null;
      }
      const groups = [];
      const groupsMeta = [];
      for (const card of groupsWrap.children) {
        if (elSignature(card) !== 'div:topo-group-card' || isHiddenEl(card) || !isWhitespaceOnly(card.ownText) || card.children.length !== 2) return null;
        const [gLblEl, ul] = card.children;
        if (elSignature(gLblEl) !== 'p:field-label' || isHiddenEl(gLblEl) || gLblEl.children.length !== 0
          || ul.tag !== 'ul' || ul.classes.size !== 0 || isHiddenEl(ul) || !isWhitespaceOnly(ul.ownText) || ul.children.length === 0) {
          return null;
        }
        const rawGroupLabel = fullElementText(gLblEl);
        if (!rawGroupLabel.trim() || /[\r\n\t]/.test(rawGroupLabel)) return null;
        const gLabel = normalizeInlineText(rawGroupLabel);
        const nodeTexts = [];
        const nodesMeta = [];
        for (const li of ul.children) {
          if (li.tag !== 'li' || li.classes.size !== 0 || isHiddenEl(li) || (li.children.length !== 1 && li.children.length !== 2)) return null;
          const strong = li.children[0];
          if (elSignature(strong) !== 'strong:' || isHiddenEl(strong) || strong.children.length !== 0) return null;
          const rawNodeLabel = fullElementText(strong);
          if (!rawNodeLabel.trim() || /[\r\n\t]/.test(rawNodeLabel)) return null;
          let rawSublabel = null;
          if (li.children.length === 2) {
            const muted = li.children[1];
            if (elSignature(muted) !== 'span:muted' || isHiddenEl(muted) || muted.children.length !== 0
              || !fullElementText(muted).startsWith('— ') || !verifyExactInterChildTextSlices(li, ['', ' ', ''])) {
              return null;
            }
            rawSublabel = fullElementText(muted).slice(2);
            if (!rawSublabel.trim() || /[\r\n\t]/.test(rawSublabel)) return null;
          } else if (!verifyExactInterChildTextSlices(li, ['', ''])) {
            return null;
          }
          nodeTexts.push(rawSublabel !== null ? `${rawNodeLabel} (${rawSublabel})` : rawNodeLabel);
          nodesMeta.push({ rawLabel: rawNodeLabel, rawSublabel });
        }
        groups.push({ label: gLabel, expectedText: normalizeInlineText(`${gLabel}: ${nodeTexts.join(', ')}`) });
        groupsMeta.push({ rawLabel: rawGroupLabel, nodes: nodesMeta });
      }
      const edges = [];
      const edgesMeta = [];
      for (const li of edgesOl.children) {
        if (li.tag !== 'li' || li.classes.size !== 0 || isHiddenEl(li) || li.children.length < 2 || li.children.length > 4) return null;
        const [fromCode, toCode] = li.children;
        if (elSignature(fromCode) !== 'code:' || isHiddenEl(fromCode) || fromCode.children.length !== 0
          || elSignature(toCode) !== 'code:' || isHiddenEl(toCode) || toCode.children.length !== 0) {
          return null;
        }
        const fromLbl = fullElementText(fromCode);
        const toLbl = fullElementText(toCode);
        let edgeLabel = null;
        let gate = false;
        for (let ci = 2; ci < li.children.length; ci += 1) {
          const ch = li.children[ci];
          if (elSignature(ch) === 'span:' && !isHiddenEl(ch) && ch.children.length === 0 && edgeLabel === null && !gate) {
            edgeLabel = fullElementText(ch);
            if (!edgeLabel.trim() || /[\r\n\t]/.test(edgeLabel)) return null;
          } else if (elSignature(ch) === 'span:badge,badge--gate' && !isHiddenEl(ch) && ch.children.length === 0 && fullElementText(ch) === 'Gate' && !gate) {
            gate = true;
          } else {
            return null;
          }
        }
        const expEdgeSeps = ['', ' → ', ...(edgeLabel !== null ? [' — '] : []), ...(gate ? [' '] : []), ''];
        if (!verifyExactInterChildTextSlices(li, expEdgeSeps)) return null;
        edges.push({
          fromLbl,
          toLbl,
          edgeLabel,
          gate,
          expectedText: normalizeInlineText(`${fromLbl} -> ${toLbl}${gate ? ' (Gate)' : ''}${edgeLabel !== null ? ` — ${edgeLabel}` : ''}`),
        });
        edgesMeta.push({ fromLbl, toLbl, edgeLabel, gate });
      }
      if (!verifyTopologyDiagramSvg(canvas.children[0], groupsMeta, edgesMeta)) return null;
      return { type: 'diagram', kind: 'topology', anchor: el.id, title, capInfo, groups, edges, evLabels };
    }

    if (kind === 'sequence') {
      if (elSignature(ledger) !== 'ol:seq-ledger' || !isWhitespaceOnly(ledger.ownText) || ledger.children.length === 0) return null;
      const rawMessages = [];
      for (const li of ledger.children) {
        if (li.tag !== 'li' || li.classes.size !== 0 || isHiddenEl(li) || li.children.length < 2 || li.children.length > 4) return null;
        const [strong, code] = li.children;
        if (elSignature(strong) !== 'strong:' || isHiddenEl(strong) || strong.children.length !== 0 || !fullElementText(strong).includes(' → ')
          || elSignature(code) !== 'code:' || isHiddenEl(code) || code.children.length !== 0) {
          return null;
        }
        const strongTxt = fullElementText(strong);
        const msgLabel = fullElementText(code);
        if (!msgLabel.trim() || /[\r\n\t]/.test(msgLabel)) return null;
        let gate = false;
        let hasNote = false;
        let note = '';
        for (let ci = 2; ci < li.children.length; ci += 1) {
          const ch = li.children[ci];
          if (elSignature(ch) === 'span:badge,badge--gate' && !isHiddenEl(ch) && ch.children.length === 0 && fullElementText(ch) === 'Gate' && !gate && !hasNote) {
            gate = true;
          } else if (elSignature(ch) === 'span:muted' && !isHiddenEl(ch) && ch.children.length === 0 && fullElementText(ch).startsWith('— ') && !hasNote) {
            hasNote = true;
            note = fullElementText(ch).slice(2);
            if (!note.trim() || /[\r\n\t]/.test(note)) return null;
          } else {
            return null;
          }
        }
        const expMsgSeps = ['', ': ', ...(gate ? [' '] : []), ...(hasNote ? [' '] : []), ''];
        if (!verifyExactInterChildTextSlices(li, expMsgSeps)) return null;
        rawMessages.push({ strongTxt, codeLabel: msgLabel, gate, hasNote, note });
      }
      const expectedMsgSeqCandidates = verifySequenceDiagramSvg(canvas.children[0], rawMessages);
      if (!expectedMsgSeqCandidates) return null;
      return { type: 'diagram', kind: 'sequence', anchor: el.id, title, capInfo, messages: rawMessages, expectedMsgSeqCandidates, evLabels };
    }

    // flow
    if (elSignature(ledger) !== 'ol:flow-ledger' || !isWhitespaceOnly(ledger.ownText) || ledger.children.length === 0) return null;
    const steps = [];
    const stepsMeta = [];
    for (let si = 0; si < ledger.children.length; si += 1) {
      const li = ledger.children[si];
      if (!li.classes.has('flow-ledger__item') || isHiddenEl(li) || !isWhitespaceOnly(li.ownText) || li.children.length !== 2) return null;
      const [headDiv, detP] = li.children;
      if (elSignature(headDiv) !== 'div:flow-ledger__head' || isHiddenEl(headDiv) || !isWhitespaceOnly(headDiv.ownText)
        || (headDiv.children.length !== 2 && headDiv.children.length !== 3)
        || elSignature(detP) !== 'p:' || isHiddenEl(detP) || detP.children.length !== 0) {
        return null;
      }
      const [numSp, strong, gateSp] = headDiv.children;
      if (elSignature(numSp) !== 'span:flow__num' || numSp.ariaHidden !== 'true' || numSp.children.length !== 0
        || fullElementText(numSp) !== String(si + 1).padStart(2, '0')
        || elSignature(strong) !== 'strong:' || isHiddenEl(strong) || strong.children.length !== 0) {
        return null;
      }
      const gate = Boolean(gateSp);
      if (gate && (elSignature(gateSp) !== 'span:badge,badge--gate' || isHiddenEl(gateSp) || gateSp.children.length !== 0 || fullElementText(gateSp) !== 'Gate' || !li.classes.has('flow-ledger__item--gate'))) {
        return null;
      }
      if (!gate && li.classes.has('flow-ledger__item--gate')) return null;
      if (!verifyExactInterChildTextSlices(headDiv, gate ? ['', ' ', ' ', ''] : ['', ' ', ''])) return null;
      const rawStepLabel = fullElementText(strong);
      const rawDetail = fullElementText(detP);
      if (!rawStepLabel.trim() || /[\r\n\t]/.test(rawStepLabel) || !rawDetail.trim() || /[\r\n\t]/.test(rawDetail)) return null;
      const sLabel = normalizeInlineText(rawStepLabel);
      const detail = normalizeInlineText(rawDetail);
      steps.push({
        rawLabel: rawStepLabel,
        rawDetail,
        label: sLabel,
        gate,
        expectedText: normalizeInlineText(`${sLabel}${gate ? ' (Gate)' : ''} — ${detail}`),
      });
      stepsMeta.push({ rawLabel: rawStepLabel, gate });
    }
    if (!verifyFlowDiagramSvg(canvas.children[0], stepsMeta)) return null;
    return { type: 'diagram', kind: 'flow', anchor: el.id, title, capInfo, steps, evLabels };
  }

  return null;
}

function extractItemGapsClaimHtml(claimEl, page, pagePath, manifest) {
  if (!claimEl || elSignature(claimEl) !== 'p:claim' || isHiddenEl(claimEl) || claimEl.children.length < 2) return null;
  const lbl = claimEl.children[0];
  if (elSignature(lbl) !== 'span:field-label' || isHiddenEl(lbl) || lbl.children.length !== 0 || fullElementText(lbl).trim() !== 'Gaps') {
    return null;
  }
  const pageById = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((p) => [p.id, p]));
  const gapOwnerByAnchor = new Map(
    (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
      .filter((a) => a.kind === 'gap')
      .map((a) => [a.anchor, a.page]),
  );
  const gapRefs = [];
  for (let i = 1; i < claimEl.children.length; i += 1) {
    const a = claimEl.children[i];
    if (a.tag !== 'a' || a.classes.size !== 0 || isHiddenEl(a) || a.children.length !== 0) return null;
    const gapRef = fullElementText(a).trim();
    const gAnchor = `g-${gapRef}`;
    if (!REF_RE.test(gapRef) || !resolveAnchorHrefOk(a.href, gAnchor, gapOwnerByAnchor.get(gAnchor), page.id, pagePath, pageById)) {
      return null;
    }
    gapRefs.push(gapRef);
  }
  if (fullElementText(claimEl).replace(/\s+/g, ' ').trim() !== `Gaps ${gapRefs.join(', ')}`) return null;
  return gapRefs;
}

function extractItemSectionHtml(itemSec, page, manifest, parityState) {
  const pagePath = page.html;
  const itemRef = page.id.slice('item/'.length);
  const strictParity = Boolean(parityState?.strictParity);
  if (!itemSec || itemSec.tag !== 'section' || !itemSec.classes.has('section') || itemSec.id !== `i-${itemRef}`
    || isHiddenEl(itemSec) || !isWhitespaceOnly(itemSec.ownText) || itemSec.children.length < 2
    || String(itemSec.ariaLabel ?? '').trim() !== String(page.title ?? '').trim()) {
    return null;
  }
  const h2 = itemSec.children[0];
  const allowedH2s = strictParity
    ? ['Supporting context & item summary']
    : ['Supporting context & item summary', 'Item summary', String(page.title ?? '').trim()];
  if (!isValidCanonicalH2Html(h2, allowedH2s)) return null;

  let htmlItemAge = null;
  let gapRefs = [];
  let rawBlockEls = [];

  if (itemSec.children.length === 2 && elSignature(itemSec.children[1]) === 'article:prose-sheet') {
    const sheet = itemSec.children[1];
    if (isHiddenEl(sheet) || !isWhitespaceOnly(sheet.ownText) || sheet.children.length !== 2) return null;
    let bodyDiv = null;
    let metaEl = null;
    if (elSignature(sheet.children[0]) === 'div:prose-sheet__body' && elSignature(sheet.children[1]) === 'aside:prose-sheet__meta') {
      [bodyDiv, metaEl] = sheet.children;
      if (metaEl.ariaLabel !== 'Item dossier') return null;
    } else if (!strictParity && elSignature(sheet.children[0]) === 'header:prose-sheet__meta' && elSignature(sheet.children[1]) === 'div:prose-sheet__body') {
      [metaEl, bodyDiv] = sheet.children;
    } else {
      return null;
    }
    if (isHiddenEl(bodyDiv) || !isWhitespaceOnly(bodyDiv.ownText) || isHiddenEl(metaEl) || !isWhitespaceOnly(metaEl.ownText)) {
      return null;
    }
    const pageById = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((p) => [p.id, p]));
    const expectedPills = [{ label: 'Age' }];
    if (typeof page.parent === 'string' && page.parent.startsWith('area/') && page.parent !== 'area/unassigned') {
      if (page.parent.includes('/project/')) {
        const [aSeg, areaRef] = page.parent.split('/');
        const areaPage = pageById.get(`${aSeg}/${areaRef}`);
        const projPage = pageById.get(page.parent);
        if (!areaPage || !projPage) return null;
        expectedPills.push({ label: 'Area', page: areaPage }, { label: 'Project', page: projPage });
      } else {
        const areaPage = pageById.get(page.parent);
        if (!areaPage) return null;
        expectedPills.push({ label: 'Area', page: areaPage });
      }
    }
    expectedPills.push({ label: 'Item ref' });
    if (metaEl.children.length !== expectedPills.length) return null;
    for (let pi = 0; pi < expectedPills.length; pi += 1) {
      const kv = metaEl.children[pi];
      const exp = expectedPills[pi];
      if (elSignature(kv) !== 'span:meta-kv' || isHiddenEl(kv) || !isWhitespaceOnly(kv.ownText) || kv.children.length !== 2) return null;
      const [fLbl, valEl] = kv.children;
      if (elSignature(fLbl) !== 'span:field-label' || isHiddenEl(fLbl) || fLbl.children.length !== 0
        || fullElementText(fLbl).trim() !== exp.label || isHiddenEl(valEl) || valEl.children.length !== 0) {
        return null;
      }
      if (exp.label === 'Age') {
        const ageTagOk = (valEl.tag === 'span' && valEl.classes.has('item__id')) || (!strictParity && valEl.tag === 'strong');
        htmlItemAge = fullElementText(valEl).trim();
        if (!ageTagOk || !htmlItemAge) return null;
      } else if (exp.label === 'Item ref') {
        if (valEl.tag !== 'code' || valEl.classes.size !== 0 || fullElementText(valEl).trim() !== itemRef) return null;
      } else {
        if (valEl.tag !== 'a' || valEl.classes.size !== 0 || typeof valEl.href !== 'string' || valEl.href.includes('#')) return null;
        const resolved = posix.normalize(posix.join(posix.dirname(pagePath), valEl.href));
        if (resolved !== exp.page.html || fullElementText(valEl).trim() !== String(exp.page.title ?? '').trim()) return null;
      }
    }
    let bStart = 0;
    if (bodyDiv.children[0]?.tag === 'p' && bodyDiv.children[0].classes.has('claim')) {
      const parsedGaps = extractItemGapsClaimHtml(bodyDiv.children[0], page, pagePath, manifest);
      if (!parsedGaps) return null;
      gapRefs = parsedGaps;
      bStart = 1;
    }
    rawBlockEls = bodyDiv.children.slice(bStart);
  } else if (!strictParity && elSignature(itemSec.children[1]) === 'p:lede') {
    const lede = itemSec.children[1];
    if (isHiddenEl(lede) || lede.children.length !== 2 || lede.children[0].tag !== 'strong' || lede.children[1].tag !== 'code') return null;
    htmlItemAge = fullElementText(lede.children[0]).trim();
    if (!htmlItemAge || fullElementText(lede.children[1]).trim() !== itemRef
      || fullElementText(lede).replace(/\s+/g, ' ').trim() !== `Age: ${htmlItemAge} · Item ${itemRef}`) {
      return null;
    }
    let bStart = 2;
    if (itemSec.children[2]?.tag === 'p' && itemSec.children[2].classes.has('claim')) {
      const parsedGaps = extractItemGapsClaimHtml(itemSec.children[2], page, pagePath, manifest);
      if (!parsedGaps) return null;
      gapRefs = parsedGaps;
      bStart = 3;
    }
    rawBlockEls = itemSec.children.slice(bStart);
  } else {
    return null;
  }

  const blocks = [];
  for (const ch of rawBlockEls) {
    if (elSignature(ch) === 'div:risk-grid') {
      if (isHiddenEl(ch) || !isWhitespaceOnly(ch.ownText) || ch.children.length < 2) return null;
      for (const rEl of ch.children) {
        const rb = extractItemBlockHtml(rEl, page, pagePath, manifest, strictParity, { parityState });
        if (!rb || rb.type !== 'risk') return null;
        blocks.push(rb);
      }
    } else {
      const b = extractItemBlockHtml(ch, page, pagePath, manifest, strictParity, { parityState });
      if (!b) return null;
      blocks.push(b);
    }
  }

  return { htmlItemAge, gapRefs, blocks };
}

function isNavNodeHidden(el) {
  return el.classes.has('visually-hidden')
    || el.classes.has('skip-link')
    || el.ariaHidden === 'true';
}

function visibleSiteNavLinkText(el) {
  if (!el || isNavNodeHidden(el)) return '';
  if (Array.isArray(el.nodes)) {
    let out = '';
    for (const node of el.nodes) {
      out += node.kind === 'text' ? decodeHtmlAttr(node.value) : visibleSiteNavLinkText(node.el);
    }
    return out;
  }
  let out = decodeHtmlAttr(el.ownText);
  for (const ch of el.children) out += visibleSiteNavLinkText(ch);
  return out;
}

function isValidNavOrderedList(ol, allowedNavTitles) {
  if (!ol || ol.tag !== 'ol' || isNavNodeHidden(ol) || ol.ariaLabel !== null || !isWhitespaceOnly(ol.ownText) || ol.children.length === 0) return false;
  for (let liIdx = 0; liIdx < ol.children.length; liIdx += 1) {
    const li = ol.children[liIdx];
    if (li.tag !== 'li' || isNavNodeHidden(li) || li.ariaLabel !== null || !isWhitespaceOnly(li.ownText) || li.children.length !== 1) return false;
    const a = li.children[0];
    if (a.tag !== 'a' || isNavNodeHidden(a) || a.ariaLabel !== null || typeof a.href !== 'string' || !a.href) return false;
    if (a.children.length === 1) {
      const badge = a.children[0];
      const badgeTxt = fullElementText(badge).trim();
      const firstSigNode = Array.isArray(a.nodes)
        ? a.nodes.find((nd) => nd.kind === 'el' || !isWhitespaceOnly(nd.value))
        : null;
      const v1BadgeOk = badge.tag === 'span'
        && badge.ariaHidden === 'true'
        && badge.ariaLabel === null
        && badge.children.length === 0
        && /^\d{2,}$/.test(badgeTxt)
        && Number.parseInt(badgeTxt, 10) === liIdx + 1
        && firstSigNode?.kind === 'el'
        && firstSigNode.el === badge;
      if (!v1BadgeOk) return false;
    } else if (a.children.length !== 0) {
      return false;
    }
    if (!allowedNavTitles.has(visibleSiteNavLinkText(a).trim())) return false;
  }
  return true;
}

function validateSiteNavTargetCoverage(tocLinks, page, manifest) {
  if (!Array.isArray(tocLinks) || !Array.isArray(manifest?.pages)) return false;
  const pageByHtml = new Map(manifest.pages.map((p) => [p.html, p]));
  const structuralHtmls = manifest.pages.filter((p) => !p.id.startsWith('item/')).map((p) => p.html);
  const trimmedSiteTitle = String(manifest?.site?.title ?? '').trim();
  const rootTitles = new Set([
    'Portfolio overview',
    'Portfolio',
    ...(trimmedSiteTitle ? [`Portfolio: ${trimmedSiteTitle}`] : []),
  ]);
  const resolvedTargets = [];
  const seenTargets = new Set();
  let selfCount = 0;
  for (const link of tocLinks) {
    const { href, label } = link;
    if (typeof href !== 'string' || !href || typeof label !== 'string' || !label) return false;
    let resolved;
    if (href === '#content') {
      resolved = page.html;
      selfCount += 1;
    } else {
      if (href.startsWith('#') || /^https?:\/\//i.test(href) || href.includes('#')) return false;
      resolved = posix.normalize(posix.join(posix.dirname(page.html), href));
      if (resolved === page.html) return false;
    }
    const targetPage = pageByHtml.get(resolved);
    if (!targetPage || seenTargets.has(resolved)) return false;
    if (targetPage.id === '') {
      if (!rootTitles.has(label)) return false;
    } else if (label !== String(targetPage.title ?? '').trim()) {
      return false;
    }
    seenTargets.add(resolved);
    resolvedTargets.push(resolved);
  }
  if (selfCount !== 1) return false;
  let si = 0;
  for (const r of resolvedTargets) {
    if (si < structuralHtmls.length && r === structuralHtmls[si]) si += 1;
  }
  return si === structuralHtmls.length;
}

function estSvgPxLocal(text, fontSize = 11.5, mono = false) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7f) w += fontSize * 1.05;
    else if (mono) w += fontSize * 0.64;
    else if (ch === 'W' || ch === 'M' || ch === '@' || ch === '%') w += fontSize * 1.02;
    else if (/[A-Z&GHOQDU_]/.test(ch)) w += fontSize * 0.82;
    else if (ch === ' ') w += fontSize * 0.34;
    else w += fontSize * 0.62;
  }
  return Math.ceil(w);
}

function clampSvgLabelText(text, maxWidthPx, fontSize = 11.5, mono = false) {
  const raw = String(text);
  if (estSvgPxLocal(raw, fontSize, mono) <= maxWidthPx) return raw;
  const chars = [...raw];
  let end = chars.length;
  while (end > 2 && estSvgPxLocal(`${chars.slice(0, end).join('')}…`, fontSize, mono) > maxWidthPx) {
    end -= 1;
  }
  return `${chars.slice(0, end).join('')}…`;
}

function computeSitrepBarSegmentsLocal(m, w, b, maxTotal, plotW = 356) {
  const vals = [m, w, b];
  const raw = vals.map((v) => (v > 0 ? Number(((v / maxTotal) * plotW).toFixed(2)) : 0));
  const MIN_W = 2;
  if (vals.every((v, i) => v === 0 || raw[i] >= MIN_W)) {
    return raw;
  }
  const total = m + w + b;
  const targetBarW = Math.min(plotW, Math.max(
    vals.filter((v) => v > 0).length * MIN_W,
    Number(((total / maxTotal) * plotW).toFixed(2)),
  ));
  let fixedW = 0;
  let flexSum = 0;
  const clamped = [false, false, false];
  for (let pass = 0; pass < 3; pass += 1) {
    fixedW = 0;
    flexSum = 0;
    for (let i = 0; i < 3; i += 1) {
      if (vals[i] <= 0) continue;
      if (clamped[i]) fixedW += MIN_W;
      else flexSum += vals[i];
    }
    const remW = Math.max(0, targetBarW - fixedW);
    let changed = false;
    for (let i = 0; i < 3; i += 1) {
      if (vals[i] > 0 && !clamped[i] && flexSum > 0 && (vals[i] / flexSum) * remW < MIN_W) {
        clamped[i] = true;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const remW = Math.max(0, targetBarW - fixedW);
  return vals.map((v, i) => {
    if (v <= 0) return 0;
    if (clamped[i] || flexSum <= 0) return MIN_W;
    return Math.max(MIN_W, Number(((v / flexSum) * remW).toFixed(2)));
  });
}

function extractAreaDlMetricsHtml(dlEl) {
  if (!dlEl || dlEl.tag !== 'dl' || !dlEl.classes.has('metrics') || isHiddenEl(dlEl) || !isWhitespaceOnly(dlEl.ownText)) return null;
  const expectedLabels = ['Waiting', 'Moved', 'Blocked', 'Coverage', 'Unit'];
  if (dlEl.children.length !== expectedLabels.length) return null;
  const values = [];
  for (let i = 0; i < expectedLabels.length; i += 1) {
    const div = dlEl.children[i];
    if (!div || div.tag !== 'div' || isHiddenEl(div) || !isWhitespaceOnly(div.ownText) || div.children.length !== 2) return null;
    const [dt, dd] = div.children;
    if (dt.tag !== 'dt' || isHiddenEl(dt) || dt.children.length !== 0 || fullElementText(dt).trim() !== expectedLabels[i]) return null;
    if (dd.tag !== 'dd' || isHiddenEl(dd) || dd.children.some((c) => isHiddenEl(c))) return null;
    values.push(fullElementText(dd).trim());
  }
  return {
    waitingText: values[0],
    movedText: values[1],
    blockedText: values[2],
    coverageText: values[3],
    unitText: values[4],
  };
}

function extractAreaCoverageClaimHtml(claimEl, coverage, page, pagePath, manifest) {
  if (!claimEl || elSignature(claimEl) !== 'p:claim' || isHiddenEl(claimEl) || claimEl.children.length < 2) return null;
  const strongEl = claimEl.children[0];
  const expStrong = coverage === 'unavailable' ? 'Coverage unavailable.' : 'Partial coverage.';
  if (strongEl.tag !== 'strong' || strongEl.classes.size > 0 || isHiddenEl(strongEl) || strongEl.children.length !== 0
    || fullElementText(strongEl).trim() !== expStrong) {
    return null;
  }
  const pageById = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((p) => [p.id, p]));
  const gapOwnerByAnchor = new Map(
    (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
      .filter((a) => a.kind === 'gap')
      .map((a) => [a.anchor, a.page]),
  );
  const gapRefs = [];
  for (let i = 1; i < claimEl.children.length; i += 1) {
    const a = claimEl.children[i];
    if (a.tag !== 'a' || a.classes.size > 0 || isHiddenEl(a) || a.children.length !== 0 || typeof a.href !== 'string') {
      return null;
    }
    const gapRef = fullElementText(a).trim();
    if (!REF_RE.test(gapRef)) return null;
    const gAnchor = `g-${gapRef}`;
    const ownerPageId = gapOwnerByAnchor.get(gAnchor);
    const ownerPage = ownerPageId !== undefined ? pageById.get(ownerPageId) : null;
    if (!ownerPage) return null;
    if (ownerPageId === page.id) {
      if (a.href !== `#${gAnchor}`) return null;
    } else {
      const hi = a.href.indexOf('#');
      if (hi <= 0 || a.href.slice(hi + 1) !== gAnchor) return null;
      const resolvedHtml = posix.normalize(posix.join(posix.dirname(pagePath), a.href.slice(0, hi)));
      if (resolvedHtml !== ownerPage.html) return null;
    }
    gapRefs.push(gapRef);
  }
  const expFull = coverage === 'unavailable'
    ? `Coverage unavailable. Counts were not recorded for this area (${gapRefs.join(', ')}).`
    : `Partial coverage. Recorded numbers reflect only partial reading (${gapRefs.join(', ')}).`;
  if (fullElementText(claimEl).replace(/\s+/g, ' ').trim() !== expFull) return null;
  return gapRefs;
}

function isValidCanonicalH2Html(h2El, allowedTitles) {
  if (!h2El || h2El.tag !== 'h2' || h2El.classes.size > 0 || isHiddenEl(h2El) || hasDescendantTag(h2El, 'a')) return false;
  if (h2El.children.length === 0) {
    return allowedTitles.includes(decodeHtmlAttr(h2El.ownText).trim());
  }
  if (h2El.children.length === 1 && Array.isArray(h2El.nodes)) {
    const sn = h2El.children[0];
    if (elSignature(sn) !== 'span:sec-num' || sn.hasHiddenAttr || sn.children.length !== 0
      || !/^[A-Za-z0-9]{1,4}$/.test(fullElementText(sn).trim())) {
      return false;
    }
    const snIdx = h2El.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === sn);
    if (snIdx < 0 || !isWhitespaceOnly(extractNodeTextSlice(h2El, 0, snIdx) ?? 'x')) return false;
    const afterTitle = (extractNodeTextSlice(h2El, snIdx + 1, h2El.nodes.length) ?? '').trim();
    return allowedTitles.includes(afterTitle);
  }
  return false;
}

function isValidAreaCardH3Html(h3) {
  if (!h3 || h3.tag !== 'h3' || h3.classes.size > 0 || isHiddenEl(h3) || !isWhitespaceOnly(h3.ownText)) return false;
  if (h3.children.length === 1) {
    const a = h3.children[0];
    return a.tag === 'a' && !isHiddenEl(a) && a.children.length === 0;
  }
  if (h3.children.length === 2 && h3.children[0].tag === 'a') {
    const [a, idSp] = h3.children;
    return !isHiddenEl(a) && a.children.length === 0
      && elSignature(idSp) === 'span:item__id' && !isHiddenEl(idSp) && idSp.children.length === 0;
  }
  if (h3.children.length === 2 && h3.children[0].tag === 'span') {
    const [wrap, pill] = h3.children;
    if (wrap.classes.size > 0 || isHiddenEl(wrap) || !isWhitespaceOnly(wrap.ownText) || wrap.children.length !== 2) return false;
    const [a, idSp] = wrap.children;
    return a.tag === 'a' && !isHiddenEl(a) && a.children.length === 0
      && elSignature(idSp) === 'span:item__id' && !isHiddenEl(idSp) && idSp.children.length === 0
      && pill.tag === 'span' && pill.classes.has('cov-pill') && !isHiddenEl(pill) && pill.children.length === 0;
  }
  return false;
}

function isValidItemLinkLiHtml(li) {
  if (!li || li.tag !== 'li' || li.classes.size > 0 || isHiddenEl(li) || !isWhitespaceOnly(li.ownText) || li.children.length !== 2) return false;
  const [a, badge] = li.children;
  return a.tag === 'a' && a.classes.size === 0 && !isHiddenEl(a) && a.children.length === 0
    && typeof a.href === 'string' && a.href.length > 0 && !a.href.includes('#')
    && badge.tag === 'span' && badge.classes.has('item__id') && !isHiddenEl(badge) && badge.children.length === 0;
}

function isValidItemLinksChildHtml(el, allowedEmptyTexts) {
  if (!el || isHiddenEl(el)) return false;
  const sig = elSignature(el);
  if (sig === 'p:') {
    return el.children.length === 0 && allowedEmptyTexts.includes(fullElementText(el).trim());
  }
  if (el.tag === 'ul' && el.classes.has('list')) {
    return isWhitespaceOnly(el.ownText) && el.children.length >= 1 && el.children.every(isValidItemLinkLiHtml);
  }
  if (sig === 'div:support') {
    if (!isWhitespaceOnly(el.ownText) || el.children.length !== 2) return false;
    const [lbl, ul] = el.children;
    return elSignature(lbl) === 'p:field-label' && !isHiddenEl(lbl) && lbl.children.length === 0
      && /^(?:Active decisions & items|Aged close candidates) \(\d+\)$/.test(fullElementText(lbl).trim())
      && ul.tag === 'ul' && ul.classes.has('list') && !isHiddenEl(ul) && isWhitespaceOnly(ul.ownText)
      && ul.children.length >= 1 && ul.children.every(isValidItemLinkLiHtml);
  }
  if (sig === 'details:legend') {
    if (!isWhitespaceOnly(el.ownText) || el.children.length !== 2) return false;
    const [sum, ul] = el.children;
    return sum.tag === 'summary' && sum.classes.size === 0 && !isHiddenEl(sum) && sum.children.length === 0
      && /^Aged close candidates(?: & hygiene)? \(\d+\)$/.test(fullElementText(sum).trim())
      && ul.tag === 'ul' && ul.classes.has('list') && !isHiddenEl(ul) && isWhitespaceOnly(ul.ownText)
      && ul.children.length >= 1 && ul.children.every(isValidItemLinkLiHtml);
  }
  return false;
}

function isValidV1ProjectsUlHtml(ulEl, expectedProjs, pagePath) {
  if (!ulEl || ulEl.tag !== 'ul' || !ulEl.classes.has('list') || isHiddenEl(ulEl) || !isWhitespaceOnly(ulEl.ownText)
    || ulEl.children.length !== expectedProjs.length) {
    return false;
  }
  for (let i = 0; i < expectedProjs.length; i += 1) {
    const li = ulEl.children[i];
    const expProj = expectedProjs[i];
    if (!li || li.tag !== 'li' || isHiddenEl(li) || li.children.length < 1 || li.children.length > 2) return false;
    const a = li.children[0];
    if (!a || a.tag !== 'a' || isHiddenEl(a) || a.children.length !== 0 || typeof a.href !== 'string' || a.href.includes('#')) return false;
    const resolved = posix.normalize(posix.join(posix.dirname(pagePath), a.href));
    if (resolved !== expProj.html || fullElementText(a).trim() !== String(expProj.title ?? '').trim()) return false;
  }
  return true;
}

function extractNodeTextSlice(parentEl, startIdx, endIdx) {
  if (!Array.isArray(parentEl?.nodes)) return null;
  let out = '';
  for (let i = startIdx; i < endIdx; i += 1) {
    const nd = parentEl.nodes[i];
    if (!nd || nd.kind !== 'text') return null;
    out += decodeHtmlAttr(nd.value);
  }
  return out;
}

function extractPriorEditionsSectionHtml(secEl) {
  if (!secEl || secEl.tag !== 'section' || !secEl.classes.has('section') || secEl.ariaLabel !== 'Prior editions'
    || isHiddenEl(secEl) || !isWhitespaceOnly(secEl.ownText) || secEl.children.length !== 2) {
    return null;
  }
  const [h2, ul] = secEl.children;
  if (!isValidCanonicalH2Html(h2, ['Prior editions'])
    || ul.tag !== 'ul' || !ul.classes.has('list') || isHiddenEl(ul) || !isWhitespaceOnly(ul.ownText) || ul.children.length === 0) {
    return null;
  }
  const rows = [];
  for (const li of ul.children) {
    if (li.tag !== 'li' || li.classes.size > 0 || isHiddenEl(li) || li.children.length !== 2 || !Array.isArray(li.nodes)) return null;
    const [a, code] = li.children;
    if (a.tag !== 'a' || isHiddenEl(a) || a.children.length !== 0 || typeof a.href !== 'string'
      || code.tag !== 'code' || isHiddenEl(code) || code.children.length !== 0) {
      return null;
    }
    const aNodeIdx = li.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === a);
    const codeNodeIdx = li.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === code);
    if (aNodeIdx < 0 || codeNodeIdx <= aNodeIdx) return null;
    const beforeTxt = extractNodeTextSlice(li, 0, aNodeIdx);
    const betweenTxt = extractNodeTextSlice(li, aNodeIdx + 1, codeNodeIdx);
    const afterTxt = extractNodeTextSlice(li, codeNodeIdx + 1, li.nodes.length);
    if (beforeTxt !== '' || afterTxt !== '' || betweenTxt === null) return null;
    const contentId = fullElementText(code);
    const editionId = fullElementText(a);
    if (!CONTENT_ID.test(contentId) || a.href !== `../${contentId}/index.html`
      || !editionId || !editionId.trim() || /[\r\n\t]/.test(editionId)) {
      return null;
    }
    const midM = /^ · observed ([^\r\n\t]+) · $/.exec(betweenTxt);
    if (!midM || !midM[1].trim()) return null;
    rows.push({ editionId, observedAt: midM[1], contentId });
  }
  return rows;
}

function parseCsvRowsLocal(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= 8) break;
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

function verifyEvPreviewHtml(previewEl, evId, evRel, rawEvText) {
  const hasNonEmpty = typeof rawEvText === 'string' && rawEvText.trim().length > 0;
  if (evRel.mediaType === 'text/csv') {
    const parsed = hasNonEmpty ? parseCsvRowsLocal(rawEvText) : [];
    if (parsed.length < 2) return previewEl === null;
    if (!previewEl || elSignature(previewEl) !== 'div:ev-preview' || isHiddenEl(previewEl)
      || !isWhitespaceOnly(previewEl.ownText) || previewEl.children.length !== 2) {
      return false;
    }
    const [barP, tScroll] = previewEl.children;
    const header = parsed[0].slice(0, 7);
    const dataRows = parsed.slice(1, 7);
    const totalLines = rawEvText.trim().split(/\r?\n/).length - 1;
    const truncated = totalLines > dataRows.length ? ` · showing ${dataRows.length} of ${totalLines} rows` : '';
    if (elSignature(barP) !== 'p:ev-preview__bar' || isHiddenEl(barP) || barP.id !== `pv-${evId}` || barP.children.length !== 0
      || fullElementText(barP) !== `Inline CSV excerpt (${evRel.label})${truncated}`
      || !tScroll || tScroll.tag !== 'div' || !tScroll.classes.has('table__scroll') || isHiddenEl(tScroll)
      || !isWhitespaceOnly(tScroll.ownText) || tScroll.children.length !== 1) {
      return false;
    }
    const tbl = tScroll.children[0];
    if (elSignature(tbl) !== 'table:ev-preview__table' || isHiddenEl(tbl) || !isWhitespaceOnly(tbl.ownText) || tbl.children.length !== 3) {
      return false;
    }
    const [cap, thead, tbody] = tbl.children;
    if (cap.tag !== 'caption' || !cap.classes.has('visually-hidden') || cap.children.length !== 0
      || fullElementText(cap) !== `CSV preview for ${evRel.label}`
      || thead.tag !== 'thead' || isHiddenEl(thead) || !isWhitespaceOnly(thead.ownText) || thead.children.length !== 1
      || thead.children[0].tag !== 'tr' || thead.children[0].children.length !== header.length
      || thead.children[0].children.some((th, hi) => th.tag !== 'th' || isHiddenEl(th) || th.children.length !== 0 || fullElementText(th) !== header[hi])
      || tbody.tag !== 'tbody' || isHiddenEl(tbody) || !isWhitespaceOnly(tbody.ownText) || tbody.children.length !== dataRows.length) {
      return false;
    }
    for (let ri = 0; ri < dataRows.length; ri += 1) {
      const tr = tbody.children[ri];
      if (tr.tag !== 'tr' || isHiddenEl(tr) || !isWhitespaceOnly(tr.ownText) || tr.children.length !== header.length) return false;
      for (let ci = 0; ci < header.length; ci += 1) {
        const td = tr.children[ci];
        if (td.tag !== 'td' || isHiddenEl(td) || td.children.length !== 0 || fullElementText(td) !== (dataRows[ri][ci] ?? '')) {
          return false;
        }
      }
    }
    return true;
  }

  if (!hasNonEmpty) return previewEl === null;
  if (!previewEl || elSignature(previewEl) !== 'div:ev-preview' || isHiddenEl(previewEl)
    || !isWhitespaceOnly(previewEl.ownText) || previewEl.children.length !== 2) {
    return false;
  }
  const [barP, cScroll] = previewEl.children;
  const rawLines = rawEvText.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const slice = rawLines.slice(0, 10);
  const truncated = rawLines.length > slice.length ? ` · lines 1–${slice.length} of ${rawLines.length}` : '';
  const kindWord = evRel.mediaType === 'application/json' ? 'JSON' : 'text';
  if (elSignature(barP) !== 'p:ev-preview__bar' || isHiddenEl(barP) || barP.id !== `pv-${evId}` || barP.children.length !== 0
    || fullElementText(barP) !== `Inline ${kindWord} excerpt (${evRel.label})${truncated}`) {
    return false;
  }
  const actualLines = extractCodeLinesFromScrollHtml(cScroll, null);
  const expectedLines = slice.map((line) => {
    const cps = Array.from(line);
    return cps.length > 120 ? `${cps.slice(0, 119).join('')}…` : line;
  });
  return Boolean(actualLines && actualLines.length === expectedLines.length && actualLines.every((l, li) => l === expectedLines[li]));
}

function extractGapsTailSectionHtml(secEl, expectedAnchors) {
  if (!secEl || secEl.tag !== 'section' || secEl.classes.size !== 1 || !secEl.classes.has('section')
    || secEl.ariaLabel !== 'Explicit gaps' || isHiddenEl(secEl) || !isWhitespaceOnly(secEl.ownText) || secEl.children.length !== 2) {
    return null;
  }
  const [h2, ol] = secEl.children;
  if (!isValidCanonicalH2Html(h2, ['Explicit gaps'])
    || elSignature(ol) !== 'ol:evidence-list' || isHiddenEl(ol) || !isWhitespaceOnly(ol.ownText)
    || ol.children.length !== expectedAnchors.length) {
    return null;
  }
  const gaps = [];
  for (let i = 0; i < expectedAnchors.length; i += 1) {
    const li = ol.children[i];
    const expAnchor = expectedAnchors[i];
    const gapRef = expAnchor.slice(2);
    if (li.tag !== 'li' || li.classes.size !== 1 || !li.classes.has('ev') || isHiddenEl(li)
      || li.id !== expAnchor || !isWhitespaceOnly(li.ownText) || li.children.length !== 2) {
      return null;
    }
    const [titleP, bodyP] = li.children;
    if (elSignature(titleP) !== 'p:ev__title' || isHiddenEl(titleP) || !isWhitespaceOnly(titleP.ownText) || titleP.children.length !== 2
      || elSignature(bodyP) !== 'p:' || isHiddenEl(bodyP) || bodyP.children.length !== 0) {
      return null;
    }
    const [kindSp, refStrong] = titleP.children;
    if (elSignature(kindSp) !== 'span:ev-label' || isHiddenEl(kindSp) || kindSp.children.length !== 0
      || elSignature(refStrong) !== 'strong:' || isHiddenEl(refStrong) || refStrong.children.length !== 0
      || fullElementText(refStrong) !== gapRef) {
      return null;
    }
    const kind = fullElementText(kindSp);
    const text = fullElementText(bodyP);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(kind) || !text.trim() || /[\r\n\t]/.test(text)) return null;
    gaps.push({ gapRef, kind, text });
  }
  return gaps;
}

function extractEvidenceTailSectionHtml(secEl, expectedAnchors, page, manifest, parityState) {
  if (!secEl || secEl.tag !== 'section' || secEl.classes.size !== 1 || !secEl.classes.has('section')
    || secEl.ariaLabel !== 'Evidence' || isHiddenEl(secEl) || !isWhitespaceOnly(secEl.ownText) || secEl.children.length !== 2) {
    return null;
  }
  const [h2, ol] = secEl.children;
  if (!isValidCanonicalH2Html(h2, ['Evidence'])
    || elSignature(ol) !== 'ol:evidence-list' || isHiddenEl(ol) || !isWhitespaceOnly(ol.ownText)
    || ol.children.length !== expectedAnchors.length) {
    return null;
  }
  const strictParity = Boolean(parityState?.strictParity);
  const evById = new Map((Array.isArray(manifest?.evidence) ? manifest.evidence : []).map((e) => [e.id, e]));
  const fileByPath = new Map((Array.isArray(manifest?.files) ? manifest.files : []).map((f) => [f.path, f]));
  const pageById = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((p) => [p.id, p]));
  const anchorOwnerByAnchor = new Map((Array.isArray(manifest?.anchors) ? manifest.anchors : []).map((a) => [a.anchor, a.page]));

  const checkFileAndDigestEls = (fileP, digestP, evRel, fileMeta) => {
    if (!fileMeta || fileMeta.role !== 'evidence' || fileMeta.sha256 !== evRel.sha256) return false;
    if (elSignature(fileP) !== 'p:ev__file' || isHiddenEl(fileP) || !isWhitespaceOnly(fileP.ownText) || fileP.children.length !== 2
      || elSignature(digestP) !== 'p:ev__digest' || isHiddenEl(digestP) || !isWhitespaceOnly(digestP.ownText) || digestP.children.length !== 2) {
      return false;
    }
    const [aEl, metaSp] = fileP.children;
    const [dLbl, dCode] = digestP.children;
    if (elSignature(aEl) !== 'a:' || isHiddenEl(aEl) || aEl.children.length !== 0 || typeof aEl.href !== 'string'
      || aEl.attrs.get('type') !== evRel.mediaType || fullElementText(aEl) !== evRel.path) {
      return false;
    }
    const resolved = posix.normalize(posix.join(posix.dirname(page.html), aEl.href));
    if (resolved !== evRel.path) return false;
    if (elSignature(metaSp) !== 'span:ev__meta' || isHiddenEl(metaSp) || metaSp.children.length !== 0
      || fullElementText(metaSp) !== `${evRel.mediaType} · ${fileMeta.bytes} bytes`) {
      return false;
    }
    return elSignature(dLbl) === 'span:field-label' && !isHiddenEl(dLbl) && dLbl.children.length === 0
      && fullElementText(dLbl) === 'SHA-256'
      && elSignature(dCode) === 'code:' && !isHiddenEl(dCode) && dCode.children.length === 0
      && fullElementText(dCode) === evRel.sha256;
  };

  const extractCitedLinks = (citedP, evRel) => {
    if (!citedP || elSignature(citedP) !== 'p:ev__cited' || isHiddenEl(citedP) || citedP.children.length < 1 || !Array.isArray(citedP.nodes)) {
      return null;
    }
    const fLbl = citedP.children[0];
    if (elSignature(fLbl) !== 'span:field-label' || isHiddenEl(fLbl) || fLbl.children.length !== 0 || fullElementText(fLbl) !== 'Cited by') {
      return null;
    }
    const expectedCited = Array.isArray(evRel.citedBy) ? evRel.citedBy : [];
    const lblIdx = citedP.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === fLbl);
    if (lblIdx < 0 || extractNodeTextSlice(citedP, 0, lblIdx) !== '') return null;
    if (expectedCited.length === 0) {
      if (citedP.children.length !== 1) return null;
      return extractNodeTextSlice(citedP, lblIdx + 1, citedP.nodes.length) === ' not cited' ? [] : null;
    }
    if (citedP.children.length !== 1 + expectedCited.length) return null;
    const citedLinks = [];
    let prevNodeIdx = lblIdx;
    for (let ci = 0; ci < expectedCited.length; ci += 1) {
      const aEl = citedP.children[1 + ci];
      const targetAnchor = expectedCited[ci];
      const ownerPageId = anchorOwnerByAnchor.get(targetAnchor) ?? '';
      if (elSignature(aEl) !== 'a:' || isHiddenEl(aEl) || aEl.children.length !== 0
        || !resolveAnchorHrefOk(aEl.href, targetAnchor, ownerPageId, page.id, page.html, pageById)) {
        return null;
      }
      const curNodeIdx = citedP.nodes.findIndex((nd, idx) => idx > prevNodeIdx && nd.kind === 'el' && nd.el === aEl);
      if (curNodeIdx < 0) return null;
      const sepTxt = extractNodeTextSlice(citedP, prevNodeIdx + 1, curNodeIdx);
      if (sepTxt !== (ci === 0 ? ' ' : ' · ')) return null;
      prevNodeIdx = curNodeIdx;
      citedLinks.push({ anchor: targetAnchor, label: fullElementText(aEl) });
    }
    if (extractNodeTextSlice(citedP, prevNodeIdx + 1, citedP.nodes.length) !== '') return null;
    return citedLinks;
  };

  const evItems = [];
  for (let i = 0; i < expectedAnchors.length; i += 1) {
    const li = ol.children[i];
    const expAnchor = expectedAnchors[i];
    const evId = expAnchor.slice(3);
    const evRel = evById.get(evId);
    if (!evRel || li.tag !== 'li' || isHiddenEl(li) || li.id !== expAnchor || !isWhitespaceOnly(li.ownText)
      || li.classes.size !== 2 || !li.classes.has('ev') || !li.classes.has(`ev--${evRel.kind}`) || li.children.length < 2) {
      return null;
    }
    let title = null;
    let isV2EvItem = false;
    if (elSignature(li.children[0]) === 'div:ev__head') {
      const headDiv = li.children[0];
      if (isHiddenEl(headDiv) || !isWhitespaceOnly(headDiv.ownText) || headDiv.children.length !== 2) return null;
      const [titleP, idSp] = headDiv.children;
      if (elSignature(titleP) !== 'p:ev__title' || isHiddenEl(titleP) || !isWhitespaceOnly(titleP.ownText) || titleP.children.length !== 2
        || elSignature(idSp) !== 'span:item__id' || isHiddenEl(idSp) || idSp.children.length !== 0 || fullElementText(idSp) !== evId) {
        return null;
      }
      const [lblSp, strongEl] = titleP.children;
      if (elSignature(lblSp) !== 'span:ev-label' || isHiddenEl(lblSp) || lblSp.children.length !== 0 || fullElementText(lblSp) !== evRel.label
        || elSignature(strongEl) !== 'strong:' || isHiddenEl(strongEl) || strongEl.children.length !== 0) {
        return null;
      }
      title = fullElementText(strongEl);
      isV2EvItem = true;
    } else if (!strictParity && elSignature(li.children[0]) === 'p:ev__title') {
      const titleP = li.children[0];
      if (isHiddenEl(titleP) || !isWhitespaceOnly(titleP.ownText) || titleP.children.length !== 3) return null;
      const [lblSp, strongEl, idSp] = titleP.children;
      if (elSignature(lblSp) !== 'span:ev-label' || isHiddenEl(lblSp) || lblSp.children.length !== 0 || fullElementText(lblSp) !== evRel.label
        || elSignature(strongEl) !== 'strong:' || isHiddenEl(strongEl) || strongEl.children.length !== 0
        || elSignature(idSp) !== 'span:item__id' || isHiddenEl(idSp) || idSp.children.length !== 0 || fullElementText(idSp) !== evId) {
        return null;
      }
      title = fullElementText(strongEl);
    } else {
      return null;
    }
    if (!title || !title.trim() || /[\r\n\t]/.test(title)) return null;

    if (evRel.kind === 'file') {
      const fileMeta = fileByPath.get(evRel.path);
      if (isV2EvItem) {
        const metaRow = li.children[1];
        if (elSignature(metaRow) !== 'div:ev__meta-row' || isHiddenEl(metaRow) || !isWhitespaceOnly(metaRow.ownText) || metaRow.children.length !== 2
          || !checkFileAndDigestEls(metaRow.children[0], metaRow.children[1], evRel, fileMeta)) {
          return null;
        }
        const rawEvText = parityState?.textByPath?.get(evRel.path) ?? '';
        let previewEl = null;
        let citedP = null;
        if (li.children.length === 4) {
          previewEl = li.children[2];
          citedP = li.children[3];
        } else if (li.children.length === 3) {
          citedP = li.children[2];
        } else {
          return null;
        }
        if (!verifyEvPreviewHtml(previewEl, evId, evRel, rawEvText)) return null;
        const citedLinks = extractCitedLinks(citedP, evRel);
        if (!citedLinks) return null;
        evItems.push({ id: evId, label: evRel.label, title, kind: 'file', bytes: fileMeta.bytes, reason: null, citedLinks, pagePath: page.html });
      } else {
        if (li.children.length !== 3 || !checkFileAndDigestEls(li.children[1], li.children[2], evRel, fileMeta)) {
          return null;
        }
        evItems.push({ id: evId, label: evRel.label, title, kind: 'file', bytes: fileMeta.bytes, reason: null, citedLinks: null, pagePath: page.html });
      }
    } else {
      const withheldP = li.children[1];
      if (elSignature(withheldP) !== 'p:ev__withheld' || isHiddenEl(withheldP) || withheldP.children.length !== 1 || !Array.isArray(withheldP.nodes)) {
        return null;
      }
      const wStrong = withheldP.children[0];
      const expWord = evRel.kind === 'redacted' ? 'Redacted.' : 'Unavailable.';
      const stIdx = withheldP.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === wStrong);
      if (elSignature(wStrong) !== 'strong:' || isHiddenEl(wStrong) || wStrong.children.length !== 0
        || fullElementText(wStrong) !== expWord || stIdx < 0
        || extractNodeTextSlice(withheldP, 0, stIdx) !== '') {
        return null;
      }
      const afterTxt = extractNodeTextSlice(withheldP, stIdx + 1, withheldP.nodes.length);
      const trailer = ' No bytes are included in this bundle.';
      if (afterTxt === null || !afterTxt.startsWith(' ') || !afterTxt.endsWith(trailer)) return null;
      const reason = afterTxt.slice(1, -trailer.length);
      if (!reason.trim() || /[\r\n\t]/.test(reason)) return null;
      if (isV2EvItem) {
        if (li.children.length !== 3) return null;
        const citedLinks = extractCitedLinks(li.children[2], evRel);
        if (!citedLinks) return null;
        evItems.push({ id: evId, label: evRel.label, title, kind: evRel.kind, bytes: null, reason, citedLinks, pagePath: page.html });
      } else {
        if (li.children.length !== 2) return null;
        evItems.push({ id: evId, label: evRel.label, title, kind: evRel.kind, bytes: null, reason, citedLinks: null, pagePath: page.html });
      }
    }
  }
  return evItems;
}

function verifyPageTailSectionsHtml(tailSecs, page, manifest, allowPriorEditions, parityState) {
  const ownedGapAnchors = (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
    .filter((a) => a.page === page.id && a.kind === 'gap')
    .map((a) => a.anchor);
  const ownedEvAnchors = (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
    .filter((a) => a.page === page.id && a.kind === 'evidence')
    .map((a) => a.anchor);
  let idx = 0;
  if (allowPriorEditions) {
    if (tailSecs[idx]?.ariaLabel === 'Prior editions') {
      const priorRows = extractPriorEditionsSectionHtml(tailSecs[idx]);
      if (!priorRows) return false;
      if (parityState) parityState.portfolioHtmlPriorEditions = priorRows;
      idx += 1;
    } else if (parityState) {
      parityState.portfolioHtmlPriorEditions = [];
    }
  }
  if (ownedGapAnchors.length > 0) {
    const parsedGaps = extractGapsTailSectionHtml(tailSecs[idx], ownedGapAnchors);
    if (!parsedGaps) return false;
    if (parityState) parityState.htmlGapsByPage.set(page.id, parsedGaps);
    idx += 1;
  } else if (parityState) {
    parityState.htmlGapsByPage.set(page.id, []);
  }
  if (ownedEvAnchors.length > 0) {
    const parsedEvs = extractEvidenceTailSectionHtml(tailSecs[idx], ownedEvAnchors, page, manifest, parityState);
    if (!parsedEvs) return false;
    if (parityState) parityState.htmlEvByPage.set(page.id, parsedEvs);
    idx += 1;
  } else if (parityState) {
    parityState.htmlEvByPage.set(page.id, []);
  }
  return idx === tailSecs.length;
}

function checkItemSectionHeadingsHtml(inspected, itemSec, pagePath, findings) {
  for (const el of inspected.elements) {
    if (el === itemSec || el === itemSec.children[0]) continue;
    let inItemSec = false;
    let inBlockArticle = false;
    for (let anc = el.parent; anc; anc = anc.parent) {
      if (anc === itemSec) {
        inItemSec = true;
        break;
      }
      if (anc.tag === 'article' && (anc.classes.has('finding') || anc.classes.has('risk') || anc.classes.has('requirement'))) {
        inBlockArticle = true;
      }
    }
    if (inItemSec && /^h[1-6]$/.test(el.tag) && !(el.tag === 'h3' && inBlockArticle)) {
      findings.add('reading-order', pagePath, `unexpected heading <${el.tag}> inside item section in HTML`);
      return false;
    }
  }
  return true;
}

function checkPageDecisionsHtml(inspected, page, manifest, pageDecisions, findings, parityState) {
  const pagePath = page.html;
  const siteMeta = manifest?.site;
  const trimmedSiteTitle = String(siteMeta?.title ?? '').trim();
  const allowedNavTitles = new Set([
    'Portfolio overview',
    'Portfolio',
    ...(trimmedSiteTitle ? [`Portfolio: ${trimmedSiteTitle}`] : []),
    ...(Array.isArray(manifest?.pages) ? manifest.pages.map((p) => String(p.title ?? '').trim()) : []),
  ]);

  const bodyEl = inspected.elements.find((el) => el.tag === 'body');
  if (!bodyEl || !isWhitespaceOnly(bodyEl.ownText)) {
    findings.add('reading-order', pagePath, 'malformed or text-bearing <body> envelope in HTML');
    return;
  }
  const bSigs = bodyEl.children.map(elSignature);
  const bodyValid = (bSigs.length === 4 && bSigs[0] === 'a:skip-link' && bSigs[1] === 'header:masthead' && bSigs[2] === 'div:layout' && bSigs[3] === 'footer:site-footer')
    || (bSigs.length === 5 && bSigs[0] === 'a:skip-link' && bSigs[1] === 'header:masthead' && bSigs[2] === 'nav:toc' && bSigs[3] === 'div:layout' && bSigs[4] === 'footer:site-footer');
  if (!bodyValid) {
    findings.add('reading-order', pagePath, 'unexpected top-level <body> child structure in HTML');
    return;
  }

  const skipEl = bodyEl.children[0];
  if (skipEl.children.length !== 0 || fullElementText(skipEl).trim() !== 'Skip to content') {
    findings.add('reading-order', pagePath, 'malformed or modified skip-link chrome element in HTML');
    return;
  }

  const mastheadEl = bodyEl.children[1];
  if (!isWhitespaceOnly(mastheadEl.ownText) || mastheadEl.children.map(elSignature).join('|') !== 'p:brand|p:masthead__status') {
    findings.add('reading-order', pagePath, 'malformed <header class="masthead"> chrome structure in HTML');
    return;
  }
  const [brandEl, statusEl] = mastheadEl.children;
  const brandSpan = brandEl.children[1];
  const brandStrong = brandSpan?.children[0];
  const brandSmall = brandSpan?.children[1];
  const rawEdId = String(siteMeta?.edition?.editionId ?? '');
  const rawObs = String(siteMeta?.edition?.observedAt ?? '');
  const smallText = brandSmall ? fullElementText(brandSmall).trim() : '';
  const brandOk = isWhitespaceOnly(brandEl.ownText) && brandEl.children.length === 2
    && elSignature(brandEl.children[0]) === 'span:brand__mark' && brandEl.children[0].children.length === 0
    && elSignature(brandSpan) === 'span:' && isWhitespaceOnly(brandSpan.ownText) && brandSpan.children.length === 2
    && brandStrong?.tag === 'strong'
    && (brandStrong.children.length === 0 || (brandStrong.children.length === 1 && brandStrong.children[0].tag === 'a' && brandStrong.children[0].children.length === 0))
    && fullElementText(brandStrong).trim() === trimmedSiteTitle
    && brandSmall?.tag === 'small' && brandSmall.children.length === 0
    && (smallText === rawEdId.trim() || smallText === `${rawEdId} · ${rawObs}`.trim());
  const statusOk = decodeHtmlAttr(statusEl.ownText).replace(/[·\s]+/g, '') === ''
    && statusEl.children.length >= 1
    && statusEl.children.every((ch) => ch.children.length === 0 && (ch.tag === 'a' || (ch.tag === 'span' && ch.classes.has('classification'))));
  if (!brandOk || !statusOk || hasForbiddenClassInSubtree(mastheadEl, SHELL_CHROME_FORBIDDEN_CLASSES)) {
    findings.add('reading-order', pagePath, 'unexpected content inside <header class="masthead"> chrome in HTML');
    return;
  }
  // Strict v2 parity is the default. Only the v1 masthead mark "SR" selects the v1 rules, so
  // a changed or unknown mark can never make verification more lenient.
  if (parityState) parityState.strictParity = fullElementText(brandEl.children[0]).trim() !== 'SR';

  const tocEl = bodyEl.children.find((ch) => ch.tag === 'nav' && ch.classes.has('toc'));
  let tocLinks = null;
  if (tocEl) {
    const det = tocEl.children[0];
    const sum = det?.children[0];
    const ol = det?.children[1];
    const tocOk = !isNavNodeHidden(tocEl) && isWhitespaceOnly(tocEl.ownText) && tocEl.children.length === 1
      && det?.tag === 'details' && !isNavNodeHidden(det) && isWhitespaceOnly(det.ownText) && det.children.length === 2
      && sum?.tag === 'summary' && !isNavNodeHidden(sum)
      && (sum.children.length === 0 || (sum.children.length === 1 && sum.children[0].tag === 'span' && !isNavNodeHidden(sum.children[0]) && sum.children[0].children.length === 0))
      && /^(?:Navigation|Contents)(?:\s+\d+\s+(?:pages|sections))?$/.test(fullElementText(sum).trim())
      && isValidNavOrderedList(ol, allowedNavTitles)
      && !hasForbiddenClassInSubtree(tocEl, SHELL_CHROME_FORBIDDEN_CLASSES);
    if (!tocOk) {
      findings.add('reading-order', pagePath, 'unexpected content inside <nav class="toc"> chrome in HTML');
      return;
    }
    tocLinks = ol.children.map((li) => ({ href: li.children[0].href, label: visibleSiteNavLinkText(li.children[0]).trim() }));
  }

  const layoutEl = bodyEl.children.find((ch) => ch.tag === 'div' && ch.classes.has('layout'));
  if (!layoutEl || isHiddenEl(layoutEl) || !isWhitespaceOnly(layoutEl.ownText)) {
    findings.add('reading-order', pagePath, 'malformed <div class="layout"> container in HTML');
    return;
  }
  const lSigs = layoutEl.children.map(elSignature);
  const layoutValid = (lSigs.length === 2 && lSigs[0] === 'nav:rail' && lSigs[1] === 'main:document')
    || (lSigs.length === 1 && lSigs[0] === 'main:document');
  if (!layoutValid) {
    findings.add('reading-order', pagePath, 'unexpected <div class="layout"> child structure in HTML');
    return;
  }
  if (Boolean(tocEl) !== (lSigs.length === 2)) {
    findings.add('reading-order', pagePath, 'mismatched <nav class="toc"> and <nav class="rail"> navigation presence in HTML');
    return;
  }
  if (lSigs.length === 2) {
    const railEl = layoutEl.children[0];
    const railOv = railEl.children[0];
    const railOl = railEl.children[1];
    const railOk = !isNavNodeHidden(railEl) && isWhitespaceOnly(railEl.ownText) && railEl.children.length === 2
      && elSignature(railOv) === 'p:overline' && railOv.children.length === 0
      && /^(?:Navigation|Contents|Edition navigation)$/i.test(fullElementText(railOv).trim())
      && isValidNavOrderedList(railOl, allowedNavTitles)
      && !hasForbiddenClassInSubtree(railEl, SHELL_CHROME_FORBIDDEN_CLASSES);
    if (!railOk) {
      findings.add('reading-order', pagePath, 'unexpected content inside <nav class="rail"> chrome in HTML');
      return;
    }
    const railLinks = railOl.children.map((li) => ({ href: li.children[0].href, label: visibleSiteNavLinkText(li.children[0]).trim() }));
    if (!tocLinks || tocLinks.length !== railLinks.length || !tocLinks.every((l, idx) => l.href === railLinks[idx].href && l.label === railLinks[idx].label)) {
      findings.add('reading-order', pagePath, '<nav class="toc"> and <nav class="rail"> link targets or labels disagree in HTML');
      return;
    }
    if (!validateSiteNavTargetCoverage(tocLinks, page, manifest)) {
      findings.add('reading-order', pagePath, '<nav class="toc"> and <nav class="rail"> fail to cover structural site pages in manifest order');
      return;
    }
  }
  if (parityState) {
    parityState.pageHasNav.set(page.id, Boolean(tocEl));
  }

  const mainEl = layoutEl.children[layoutEl.children.length - 1];
  if (isHiddenEl(mainEl) || !isWhitespaceOnly(mainEl.ownText) || mainEl.children.length < 2) {
    findings.add('reading-order', pagePath, 'malformed <main class="document"> container in HTML');
    return;
  }
  const titleBlock = mainEl.children[0];
  if (titleBlock.tag !== 'header' || !titleBlock.classes.has('title-block') || isHiddenEl(titleBlock) || !isWhitespaceOnly(titleBlock.ownText)
    || hasForbiddenClassInSubtree(titleBlock, SHELL_CHROME_FORBIDDEN_CLASSES)) {
    findings.add('reading-order', pagePath, 'unexpected claim/decision content inside page chrome header in HTML');
    return;
  }
  let tbIdx = 0;
  if (titleBlock.children[0]?.tag === 'p') {
    const p0 = titleBlock.children[0];
    const p0Sig = elSignature(p0);
    const p0Ok = !isHiddenEl(p0) && (
      (p0Sig === 'p:overline' && p0.children.length === 0 && fullElementText(p0).trim() === `Edition ${rawEdId} · Observed ${rawObs}`.trim())
      || (p0Sig === 'p:breadcrumb' && decodeHtmlAttr(p0.ownText).trim() === '' && p0.children.length >= 1
        && p0.children.every((ch) => ch.children.length === 0
          && ((ch.tag === 'a' && !isHiddenEl(ch) && allowedNavTitles.has(fullElementText(ch).trim())) || (ch.tag === 'span' && fullElementText(ch).trim() === '/'))))
    );
    if (!p0Ok) {
      findings.add('reading-order', pagePath, 'unexpected content inside <header class="title-block"> overline/breadcrumb in HTML');
      return;
    }
    tbIdx = 1;
  }
  const h1El = titleBlock.children[tbIdx];
  const dlEl = titleBlock.children[tbIdx + 1];
  const expectedMetaLabels = ['Edition digest', 'Coverage window', 'Source digest'];
  const titleBlockOk = titleBlock.children.length === tbIdx + 2
    && h1El && elSignature(h1El) === 'h1:' && !isHiddenEl(h1El) && h1El.children.length === 0 && fullElementText(h1El).trim() === String(page.title ?? '').trim()
    && dlEl && dlEl.tag === 'dl' && dlEl.classes.has('title-meta') && !isHiddenEl(dlEl) && isWhitespaceOnly(dlEl.ownText)
    && dlEl.children.length === 3
    && dlEl.children.every((div, di) => div.tag === 'div' && !isHiddenEl(div) && isWhitespaceOnly(div.ownText)
      && div.children.length === 2
      && div.children[0].tag === 'dt' && !isHiddenEl(div.children[0]) && div.children[0].children.length === 0
      && fullElementText(div.children[0]).trim() === expectedMetaLabels[di]
      && div.children[1].tag === 'dd' && !isHiddenEl(div.children[1])
      && div.children[1].children.every((x) => !isHiddenEl(x) && x.children.length === 0 && (x.tag === 'code' || x.tag === 'a')));
  if (!titleBlockOk) {
    findings.add('reading-order', pagePath, 'unexpected element or modified title/metadata inside <header class="title-block"> in HTML');
    return;
  }

  const footerEl = bodyEl.children[bodyEl.children.length - 1];
  const regVer = String(siteMeta?.registry?.version ?? '');
  const regSha = String(siteMeta?.registry?.sha256 ?? '');
  const buildTool = String(manifest?.build?.tool ?? '');
  const buildVer = String(manifest?.build?.version ?? '');
  const rPol = String(manifest?.build?.renderPolicy ?? '');
  const sPol = String(manifest?.build?.securityPolicy ?? '');
  const fp0 = footerEl?.children[0];
  const fp1 = footerEl?.children[1];
  const fCode = fp0?.children[0];
  const fTopA = fp1?.children[0];
  const fCodeNodeIdx = Array.isArray(fp0?.nodes) ? fp0.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === fCode) : -1;
  const fCodeTxt = fCode ? fullElementText(fCode) : '';
  const fCodeDigestOk = regSha.length === 64 && (
    (fCodeTxt === regSha && !fCode.attrs.has('title'))
    || (fCodeTxt === `${regSha.slice(0, 12)}…` && fCode.attrs.get('title') === regSha)
  );
  const footerOk = footerEl && !isHiddenEl(footerEl) && isWhitespaceOnly(footerEl.ownText) && footerEl.children.length === 2
    && !hasForbiddenClassInSubtree(footerEl, SHELL_CHROME_FORBIDDEN_CLASSES)
    && fp0 && elSignature(fp0) === 'p:' && !isHiddenEl(fp0) && fp0.children.length === 1
    && fCode && elSignature(fCode) === 'code:' && !isHiddenEl(fCode) && fCode.children.length === 0 && fCodeDigestOk
    && fCodeNodeIdx >= 0
    && extractNodeTextSlice(fp0, 0, fCodeNodeIdx) === `Registry ${regVer} (`
    && extractNodeTextSlice(fp0, fCodeNodeIdx + 1, fp0.nodes.length) === `) · Built by ${buildTool} ${buildVer} · ${rPol} · ${sPol}. Static site-bundle/v1: no scripts, no forms, no external requests.`
    && fp1 && elSignature(fp1) === 'p:' && !isHiddenEl(fp1) && isWhitespaceOnly(fp1.ownText) && fp1.children.length === 1
    && fTopA && elSignature(fTopA) === 'a:' && !isHiddenEl(fTopA) && fTopA.children.length === 0
    && fTopA.href === '#content' && fullElementText(fTopA) === 'Back to top';
  if (!footerOk) {
    findings.add('reading-order', pagePath, 'unexpected or modified content inside <footer class="site-footer"> chrome in HTML');
    return;
  }

  for (const el of inspected.elements) {
    if (hasDisallowedHtmlTextEntity(el.ownText)) {
      findings.add('reading-order', pagePath, 'non-canonical character reference in HTML text content');
      return;
    }
    let inDec = false;
    for (let anc = el; anc; anc = anc.parent) {
      if (anc.tag === 'article' && anc.classes.has('decision')) {
        inDec = true;
        break;
      }
    }
    if (!inDec) {
      if (DECISION_ONLY_CLASSES.some((c) => el.classes.has(c))) {
        findings.add('reading-order', pagePath, 'decision/question structural element appears outside <article class="decision"> in HTML');
        return;
      }
      if (el.classes.has('field-label')) {
        const normLbl = normCalloutLabel(decodeCalloutHtmlTextFromEl(el));
        const badLbl = isTopoGroupFieldLabelHtml(el)
          ? STANDALONE_CALLOUT_STRONG_RE.test(normLbl)
          : (STANDALONE_CALLOUT_STRONG_RE.test(normLbl) || CALLOUT_BARE_LABEL_RE.test(normLbl));
        if (badLbl) {
          findings.add('reading-order', pagePath, `decision label ${JSON.stringify(fullElementText(el).trim())} appears outside <article class="decision"> in HTML`);
          return;
        }
      }
      if (isStandaloneCalloutStrongHtml(el)) {
        findings.add('reading-order', pagePath, `standalone callout label ${JSON.stringify(fullElementText(el).trim())} appears outside <article class="decision"> in HTML`);
        return;
      }
    }
  }

  const pulseEls = inspected.elements.filter((el) => el.classes.has('sitrep-pulse'));
  if (page.id !== '' && pulseEls.length > 0) {
    findings.add('reading-order', pagePath, 'unexpected .sitrep-pulse element on non-portfolio page in HTML');
    return;
  }
  const areaChartEls = inspected.elements.filter((el) => el.classes.has('sitrep-area-chart'));
  if (page.id !== '' && areaChartEls.length > 0) {
    findings.add('reading-order', pagePath, 'unexpected .sitrep-area-chart element on non-portfolio page in HTML');
    return;
  }

  if (!page.id.startsWith('item/') && parityState) {
    if (page.id === '' && pulseEls.length > 0) {
      if (pulseEls.length !== 1) {
        findings.add('reading-order', pagePath, 'duplicate .sitrep-pulse elements on portfolio page in HTML');
        return;
      }
      const pulseEl = pulseEls[0];
      const pulseOk = mainEl.children[1] === pulseEl
        && !isHiddenEl(pulseEl)
        && isWhitespaceOnly(pulseEl.ownText)
        && pulseEl.children.length === 4
        && pulseEl.children.every((cell) => cell.tag === 'div' && cell.classes.has('sitrep-pulse__cell')
          && !isHiddenEl(cell) && isWhitespaceOnly(cell.ownText) && cell.children.length === 3
          && cell.children[0].tag === 'span' && cell.children[0].classes.has('sitrep-pulse__label') && !isHiddenEl(cell.children[0]) && cell.children[0].children.length === 0
          && cell.children[1].tag === 'strong' && cell.children[1].classes.has('sitrep-pulse__value') && !isHiddenEl(cell.children[1]) && cell.children[1].children.length === 0
          && cell.children[2].tag === 'span' && cell.children[2].classes.has('sitrep-pulse__sub') && !isHiddenEl(cell.children[2]) && cell.children[2].children.length === 0);
      if (!pulseOk) {
        findings.add('reading-order', pagePath, 'malformed or misplaced .sitrep-pulse executive pulse strip on portfolio page in HTML');
        return;
      }
      parityState.portfolioPulseCells = pulseEl.children.map((cell) => ({
        label: fullElementText(cell.children[0]).trim(),
        value: fullElementText(cell.children[1]).trim(),
        sub: fullElementText(cell.children[2]).trim(),
      }));
    }
    if (page.id === '' && areaChartEls.length > 0) {
      if (areaChartEls.length !== 1 || isHiddenEl(areaChartEls[0])) {
        findings.add('reading-order', pagePath, 'duplicate or hidden .sitrep-area-chart figure on portfolio page in HTML');
        return;
      }
      const figEl = areaChartEls[0];
      const figCapEl = figEl.children[0];
      const canvasEl = figEl.children[1];
      const svgEl = canvasEl?.children[0];
      const figCapOk = figEl.children.length === 2 && isWhitespaceOnly(figEl.ownText)
        && figCapEl?.tag === 'figcaption' && !isHiddenEl(figCapEl) && isWhitespaceOnly(figCapEl.ownText)
        && figCapEl.children.length === 2
        && figCapEl.children[0].tag === 'strong' && !isHiddenEl(figCapEl.children[0]) && figCapEl.children[0].children.length === 0
        && fullElementText(figCapEl.children[0]).trim() === 'Cross-area workload & telemetry balance'
        && figCapEl.children[1].tag === 'span' && !isHiddenEl(figCapEl.children[1]) && figCapEl.children[1].children.length === 0
        && fullElementText(figCapEl.children[1]).trim() === 'Stacked workstream volume across areas (Moved, Waiting, Blocked) with explicit telemetry gaps.'
        && canvasEl?.tag === 'div' && canvasEl.classes.has('diagram-canvas') && !isHiddenEl(canvasEl)
        && isWhitespaceOnly(canvasEl.ownText) && canvasEl.children.length === 1
        && svgEl?.tag === 'svg' && !isHiddenEl(svgEl) && isWhitespaceOnly(svgEl.ownText);
      if (!figCapOk) {
        findings.add('reading-order', pagePath, 'malformed .sitrep-area-chart figure or caption structure on portfolio page in HTML');
        return;
      }
      const legendTexts = svgEl.children.filter((c) => c.tag === 'text');
      const legendRects = svgEl.children.filter((c) => c.tag === 'rect');
      const gRows = svgEl.children.filter((c) => c.tag === 'g');
      const legendOk = svgEl.children.length === 8 + gRows.length
        && legendTexts.length === 4 && legendRects.length === 4
        && legendTexts.every((t, ti) => !isHiddenEl(t) && t.children.length === 0
          && [...t.classes].sort().join('.') === 'svg-axis-label'
          && fullElementText(t).trim() === ['Moved', 'Waiting', 'Blocked', 'Unavailable'][ti])
        && legendRects.every((r, ri) => !isHiddenEl(r) && r.children.length === 0
          && [...r.classes].sort().join('.') === ['svg-seg-moved', 'bar__candidate', 'svg-seg-blocked', 'svg-area-unavail'][ri]);
      if (!legendOk || gRows.length === 0 || gRows.some((g) => isHiddenEl(g))) {
        findings.add('reading-order', pagePath, 'missing, hidden, or spoofed legend/<g> rows inside .sitrep-area-chart SVG in HTML');
        return;
      }
      const parseSvgNum = (v) => (typeof v === 'string' && /^\d+(?:\.\d{1,2})?$/.test(v) ? Number(v) : NaN);
      const parsedChartRows = [];
      for (const g of gRows) {
        const texts = g.children.filter((c) => c.tag === 'text');
        const rects = g.children.filter((c) => c.tag === 'rect');
        if (!isWhitespaceOnly(g.ownText)
          || g.children.length !== texts.length + rects.length
          || texts.length !== 2
          || texts.some((t) => isHiddenEl(t) || t.children.length !== 0)
          || rects.length === 0
          || rects.some((r) => isHiddenEl(r) || r.children.length !== 0)) {
          findings.add('reading-order', pagePath, 'malformed <g> row inside .sitrep-area-chart SVG in HTML');
          return;
        }
        parsedChartRows.push({
          label: fullElementText(texts[0]).trim(),
          labelCls: [...texts[0].classes].sort().join('.'),
          labelX: parseSvgNum(texts[0].attrs.get('x')),
          labelY: parseSvgNum(texts[0].attrs.get('y')),
          summary: fullElementText(texts[1]).trim(),
          summaryCls: [...texts[1].classes].sort().join('.'),
          summaryX: parseSvgNum(texts[1].attrs.get('x')),
          summaryY: parseSvgNum(texts[1].attrs.get('y')),
          rects: rects.map((r) => ({
            cls: [...r.classes].sort().join('.'),
            x: parseSvgNum(r.attrs.get('x')),
            y: parseSvgNum(r.attrs.get('y')),
            width: parseSvgNum(r.attrs.get('width')),
            height: parseSvgNum(r.attrs.get('height')),
          })),
        });
      }
      parityState.portfolioAreaChartRows = parsedChartRows;
    }
    const allowedScopeLabels = new Set([
      'Unassigned',
      ...(Array.isArray(manifest?.pages)
        ? manifest.pages.filter((p) => p.id !== '' && !p.id.startsWith('item/')).map((p) => String(p.title ?? '').trim())
        : []),
    ]);
    const isDescendantOf = (el, target) => {
      for (let anc = el.parent; anc; anc = anc.parent) {
        if (anc === target) return true;
      }
      return false;
    };
    const hasDecisionHrefInSubtree = (root) => {
      for (const ch of root.children) {
        if (ch.tag === 'a' && typeof ch.href === 'string' && ch.href.includes('#d-')) return true;
        if (hasDecisionHrefInSubtree(ch)) return true;
      }
      return false;
    };

    const triageTableAnchorLinks = new Set();
    const triageTablesByEl = new Map();
    const countsTablesByEl = new Map();

    for (const el of inspected.elements) {
      if (el.tag !== 'table') continue;
      if (isHiddenEl(el)) {
        findings.add('reading-order', pagePath, 'hidden <table> on non-item page in HTML');
        return;
      }
      const thead = el.children.find((ch) => ch.tag === 'thead');
      const tbody = el.children.find((ch) => ch.tag === 'tbody');
      if (!thead || !tbody || isHiddenEl(thead) || isHiddenEl(tbody) || thead.children.length !== 1 || thead.children[0].tag !== 'tr' || isHiddenEl(thead.children[0])) {
        findings.add('reading-order', pagePath, 'malformed <table> structure on non-item page in HTML');
        return;
      }
      const theadCols = thead.children[0].children.map((th) => fullElementText(th).trim()).join('|');
      if (theadCols === 'Project|Active|Aged close|Total' || theadCols === 'Project|Active|Aged close|Total items') {
        const rowsOk = tbody.children.length >= 1
          && !hasDecisionHrefInSubtree(el)
          && !hasForbiddenClassInSubtree(el, new Set(['opt-key', 'chosen']))
          && tbody.children.every((tr) => tr.tag === 'tr' && !isHiddenEl(tr) && isWhitespaceOnly(tr.ownText) && tr.children.length === 4
            && tr.children[0].tag === 'th' && !isHiddenEl(tr.children[0])
            && tr.children.slice(1).every((td) => td.tag === 'td' && !isHiddenEl(td) && td.children.length === 0 && /^\d+$/.test(fullElementText(td).trim())));
        if (!rowsOk) {
          findings.add('reading-order', pagePath, 'malformed project counts <table> on non-item page in HTML');
          return;
        }
        const parsedProjRows = [];
        for (const tr of tbody.children) {
          const th = tr.children[0];
          const a = th.children[0];
          const extra = th.children[1] ?? null;
          if (!isWhitespaceOnly(th.ownText) || (th.children.length !== 1 && th.children.length !== 2)
            || !a || a.tag !== 'a' || isHiddenEl(a) || a.children.length !== 0 || typeof a.href !== 'string' || !a.href || a.href.includes('#')) {
            findings.add('reading-order', pagePath, 'malformed project link inside project counts <table> in HTML');
            return;
          }
          const resolvedProjHtml = posix.normalize(posix.join(posix.dirname(pagePath), a.href));
          const pm = /^area\/([A-Za-z][A-Za-z0-9-]{0,63})\/project\/([A-Za-z][A-Za-z0-9-]{0,63})\/index\.html$/.exec(resolvedProjHtml);
          const extraOk = extra === null || (
            extra.tag === 'span' && extra.classes.has('item__id') && !isHiddenEl(extra) && extra.children.length === 0
            && pm !== null && fullElementText(extra).trim() === pm[2]
          );
          if (!pm || !extraOk) {
            findings.add('reading-order', pagePath, 'project counts <table> row does not resolve to a canonical project page in HTML');
            return;
          }
          parsedProjRows.push({
            projPageId: `area/${pm[1]}/project/${pm[2]}`,
            projTitle: fullElementText(a).trim(),
            active: Number.parseInt(fullElementText(tr.children[1]).trim(), 10),
            close: Number.parseInt(fullElementText(tr.children[2]).trim(), 10),
            total: Number.parseInt(fullElementText(tr.children[3]).trim(), 10),
          });
        }
        countsTablesByEl.set(el, parsedProjRows);
      } else if (theadCols === 'Decision|Recommended call|Age') {
        if (tbody.children.length === 0) {
          findings.add('reading-order', pagePath, 'empty triage <table> on non-item page in HTML');
          return;
        }
        const rowAnchors = [];
        for (const tr of tbody.children) {
          if (tr.tag !== 'tr' || isHiddenEl(tr) || !isWhitespaceOnly(tr.ownText) || tr.children.length !== 3) {
            findings.add('reading-order', pagePath, 'malformed row inside triage <table> in HTML');
            return;
          }
          const [th, td, ageTd] = tr.children;
          const a = th?.children[0];
          const thExtra = th?.children[1] ?? null;
          const dAnchor = a?.tag === 'a' && typeof a.href === 'string' && a.href.includes('#d-')
            ? a.href.slice(a.href.indexOf('#') + 1)
            : null;
          const thExtraOk = thExtra === null || (
            thExtra.tag === 'span' && !isHiddenEl(thExtra) && thExtra.children.length === 0
            && ((thExtra.classes.has('triage-scope') && allowedScopeLabels.has(fullElementText(thExtra).trim()))
              || (thExtra.classes.has('item__id') && dAnchor !== null && fullElementText(thExtra).trim() === dAnchor.slice(2)))
          );
          const ageOk = ageTd?.tag === 'td' && !isHiddenEl(ageTd) && isWhitespaceOnly(ageTd.ownText)
            && ageTd.children.length === 1 && ageTd.children[0].tag === 'span' && ageTd.children[0].classes.has('item__id')
            && !isHiddenEl(ageTd.children[0]) && ageTd.children[0].children.length === 0;
          if (!th || th.tag !== 'th' || isHiddenEl(th) || !isWhitespaceOnly(th.ownText) || (th.children.length !== 1 && th.children.length !== 2)
            || !a || isHiddenEl(a) || a.children.length !== 0 || !dAnchor || !thExtraOk
            || !td || td.tag !== 'td' || isHiddenEl(td) || !ageOk) {
            findings.add('reading-order', pagePath, 'malformed row inside triage <table> in HTML');
            return;
          }
          triageTableAnchorLinks.add(a);
          rowAnchors.push(dAnchor);
          parityState.triageTableRows.push({
            pageId: page.id,
            pagePath,
            dAnchor,
            td,
            ageText: fullElementText(ageTd.children[0]).trim(),
          });
        }
        triageTablesByEl.set(el, rowAnchors);
      } else {
        findings.add('reading-order', pagePath, `unexpected <table> header ${JSON.stringify(theadCols)} on non-item page in HTML`);
        return;
      }
    }

    for (const el of inspected.elements) {
      if (el.tag !== 'a' || typeof el.href !== 'string') continue;
      const hashIdx = el.href.indexOf('#');
      if (hashIdx < 0) continue;
      const frag = el.href.slice(hashIdx + 1);
      if (!frag.startsWith('d-')) continue;
      if (isHiddenEl(el)) {
        findings.add('reading-order', pagePath, `hidden link to decision #${frag} on non-item page in HTML`);
        return;
      }
      const list = parityState.nonItemHtmlDecisionLinks.get(frag) ?? [];
      list.push({ pageId: page.id, pagePath, text: fullElementText(el) });
      parityState.nonItemHtmlDecisionLinks.set(frag, list);

      if (!triageTableAnchorLinks.has(el)) {
        let li = null;
        let firstOk = false;
        if (el.parent?.tag === 'li') {
          li = el.parent;
          firstOk = el.children.length === 0 && li.children[0] === el;
        } else if (el.parent?.tag === 'span') {
          const sp = el.parent;
          li = sp.parent;
          const spExtra = sp.children[1] ?? null;
          const spExtraOk = spExtra === null || (
            spExtra.tag === 'span' && spExtra.classes.has('triage-scope') && !isHiddenEl(spExtra)
            && spExtra.children.length === 0 && allowedScopeLabels.has(fullElementText(spExtra).trim())
          );
          firstOk = el.children.length === 0 && !isHiddenEl(sp) && isWhitespaceOnly(sp.ownText)
            && li?.children[0] === sp && sp.children[0] === el && (sp.children.length === 1 || sp.children.length === 2) && spExtraOk;
        }
        const metaSpan = li?.children[1];
        const liOk = firstOk && li?.tag === 'li' && !isHiddenEl(li) && isWhitespaceOnly(li.ownText) && li.children.length === 2
          && li.parent?.tag === 'ul' && li.parent.classes.has('list') && !isHiddenEl(li.parent)
          && metaSpan?.tag === 'span' && metaSpan.classes.has('item__id') && !isHiddenEl(metaSpan) && metaSpan.children.length === 0;
        if (!liOk) {
          findings.add('reading-order', pagePath, `decision link #${frag} appears in malformed or text-bearing container on non-item page in HTML`);
          return;
        }
        parityState.triageListItems.push({
          pageId: page.id,
          pagePath,
          dAnchor: frag,
          metaSpanText: fullElementText(metaSpan).trim(),
        });
      }
    }

    const collectSubtreeDecisionAnchors = (root) => {
      const anchors = [];
      const walkSub = (node) => {
        for (const ch of node.children) {
          if (ch.tag === 'a' && typeof ch.href === 'string') {
            const hi = ch.href.indexOf('#');
            if (hi >= 0 && ch.href.slice(hi + 1).startsWith('d-')) anchors.push(ch.href.slice(hi + 1));
          }
          walkSub(ch);
        }
      };
      walkSub(root);
      return anchors;
    };
    const isValidCloseDetailsDrawer = (detEl) => {
      if (!detEl || elSignature(detEl) !== 'details:legend' || isHiddenEl(detEl) || !isWhitespaceOnly(detEl.ownText) || detEl.children.length !== 2) {
        return false;
      }
      const [sumEl, ulEl] = detEl.children;
      return sumEl.tag === 'summary' && !isHiddenEl(sumEl) && sumEl.children.length === 0 && visibleChars(sumEl) > 0
        && ulEl.tag === 'ul' && ulEl.classes.has('list') && !isHiddenEl(ulEl) && ulEl.children.length > 0;
    };

    if (page.id === '') {
      const totalDecs = Array.isArray(manifest?.decisions) ? manifest.decisions.length : 0;
      const openSecs = mainEl.children.filter((ch) => ch.tag === 'section' && ch.ariaLabel === 'Open decisions');
      const areasSecs = mainEl.children.filter((ch) => ch.tag === 'section' && ch.ariaLabel === 'Areas');
      if (areasSecs.length !== 1 || isHiddenEl(areasSecs[0]) || !isWhitespaceOnly(areasSecs[0].ownText)) {
        findings.add('reading-order', pagePath, 'missing, duplicated, or malformed Areas section on portfolio page in HTML');
        return;
      }
      const areasSec = areasSecs[0];
      if (totalDecs === 0 && openSecs.length > 0) {
        findings.add('reading-order', pagePath, 'unexpected Open decisions section on portfolio page with zero decisions in HTML');
        return;
      }
      const coreStart = 1 + (pulseEls.length === 1 ? 1 : 0);
      let tailStartIdx;
      if (totalDecs > 0) {
        if (openSecs.length !== 1 || isHiddenEl(openSecs[0]) || !isWhitespaceOnly(openSecs[0].ownText)) {
          findings.add('reading-order', pagePath, 'missing or malformed Open decisions section on portfolio page in HTML');
          return;
        }
        const openSec = openSecs[0];
        const pairOk = (mainEl.children[coreStart] === openSec && mainEl.children[coreStart + 1] === areasSec)
          || (mainEl.children[coreStart] === areasSec && mainEl.children[coreStart + 1] === openSec);
        if (!pairOk) {
          findings.add('reading-order', pagePath, 'unexpected pre-section or top-level section ordering on portfolio page in HTML');
          return;
        }
        tailStartIdx = coreStart + 2;
        const osc = openSec.children;
        const cSigs = osc.map(elSignature).join('|');
        const expectedActiveAnchors = manifest.decisions.filter((d) => d.kind !== 'close-candidate').map((d) => d.anchor);
        const expectedCloseAnchors = manifest.decisions.filter((d) => d.kind === 'close-candidate').map((d) => d.anchor);
        const sameArr = (a, b) => a.length === b.length && a.every((v, idx) => v === b[idx]);
        if (!isValidCanonicalH2Html(osc[0], ['Decision triage queue', 'Open decisions'])) {
          findings.add('reading-order', pagePath, 'malformed <h2> inside portfolio Open decisions section in HTML');
          return;
        }
        if (cSigs === 'h2:|ul:list') {
          const allAnchors = manifest.decisions.map((d) => d.anchor);
          if (isHiddenEl(osc[1]) || !sameArr(collectSubtreeDecisionAnchors(osc[1]), allAnchors)) {
            findings.add('reading-order', pagePath, 'portfolio Open decisions list is missing, hidden, or reorders decisions in HTML');
            return;
          }
          parityState.portfolioUsesLegacyFlatOpenList = true;
        } else if (cSigs === 'h2:|div:table') {
          const activeTbl = inspected.elements.find((e) => e.tag === 'table' && isDescendantOf(e, osc[1]));
          const rowAnchors = activeTbl ? triageTablesByEl.get(activeTbl) : null;
          if (isHiddenEl(osc[1]) || expectedActiveAnchors.length === 0 || expectedCloseAnchors.length > 0
            || !rowAnchors || !sameArr(rowAnchors, expectedActiveAnchors)) {
            findings.add('reading-order', pagePath, 'portfolio Open decisions table disagrees with active/close-candidate decision split in HTML');
            return;
          }
        } else if (cSigs === 'h2:|div:table|details:legend') {
          const activeTbl = inspected.elements.find((e) => e.tag === 'table' && isDescendantOf(e, osc[1]));
          const rowAnchors = activeTbl ? triageTablesByEl.get(activeTbl) : null;
          if (isHiddenEl(osc[1]) || !isValidCloseDetailsDrawer(osc[2])
            || expectedActiveAnchors.length === 0 || expectedCloseAnchors.length === 0
            || !rowAnchors || !sameArr(rowAnchors, expectedActiveAnchors)
            || !sameArr(collectSubtreeDecisionAnchors(osc[2]), expectedCloseAnchors)) {
            findings.add('reading-order', pagePath, 'portfolio Open decisions section mispartitions active vs close-candidate decisions in HTML');
            return;
          }
        } else if (cSigs === 'h2:|p:|details:legend') {
          if (isHiddenEl(osc[1]) || osc[1].children.length !== 0
            || fullElementText(osc[1]).trim() !== 'No active decisions waiting.'
            || !isValidCloseDetailsDrawer(osc[2])
            || expectedActiveAnchors.length > 0 || expectedCloseAnchors.length === 0
            || !sameArr(collectSubtreeDecisionAnchors(osc[2]), expectedCloseAnchors)) {
            findings.add('reading-order', pagePath, 'portfolio Open decisions section buries active decisions or misstates empty active queue in HTML');
            return;
          }
        } else {
          findings.add('reading-order', pagePath, 'unexpected child element inside portfolio Open decisions section in HTML');
          return;
        }
      } else {
        if (mainEl.children[coreStart] !== areasSec) {
          findings.add('reading-order', pagePath, 'unexpected pre-section or top-level section ordering on portfolio page in HTML');
          return;
        }
        tailStartIdx = coreStart + 1;
      }
      if (!verifyPageTailSectionsHtml(mainEl.children.slice(tailStartIdx), page, manifest, true, parityState)) {
        findings.add('reading-order', pagePath, 'unexpected, missing, or malformed tail section on portfolio page in HTML');
        return;
      }

      const expectedAreaPages = Array.isArray(manifest?.pages)
        ? manifest.pages.filter((p) => /^area\/[^/]+$/.test(p.id) && p.id !== 'area/unassigned')
        : [];
      const unassignedPage = Array.isArray(manifest?.pages)
        ? (manifest.pages.find((p) => p.id === 'area/unassigned') ?? null)
        : null;
      if (!isValidCanonicalH2Html(areasSec.children[0], ['Areas'])) {
        findings.add('reading-order', pagePath, 'malformed <h2> inside portfolio Areas section in HTML');
        return;
      }
      let aChildIdx = 1;
      if (areaChartEls.length === 1) {
        if (areasSec.children[1] !== areaChartEls[0]) {
          findings.add('reading-order', pagePath, '.sitrep-area-chart must be the first child after <h2> inside portfolio Areas section in HTML');
          return;
        }
        aChildIdx = 2;
      }
      const areaSecRest = areasSec.children.slice(aChildIdx);
      if (expectedAreaPages.length === 0 && !unassignedPage) {
        const emptyOk = areaSecRest.length === 0
          || (areaSecRest.length === 1 && elSignature(areaSecRest[0]) === 'p:' && !isHiddenEl(areaSecRest[0])
            && areaSecRest[0].children.length === 0 && fullElementText(areaSecRest[0]).trim() === 'No areas recorded.');
        if (!emptyOk) {
          findings.add('reading-order', pagePath, 'unexpected child inside empty portfolio Areas section in HTML');
          return;
        }
      } else if (areaSecRest.length !== expectedAreaPages.length + (unassignedPage ? 1 : 0)
        || areaSecRest.some((c) => c.tag !== 'article' || !c.classes.has('finding'))) {
        findings.add('reading-order', pagePath, 'unexpected child element or card count inside portfolio Areas section in HTML');
        return;
      }

      const allFindingArticles = inspected.elements.filter((el) => el.tag === 'article' && el.classes.has('finding') && isDescendantOf(el, mainEl));
      if (allFindingArticles.length !== expectedAreaPages.length + (unassignedPage ? 1 : 0)) {
        findings.add('reading-order', pagePath, 'unexpected <article class="finding"> outside portfolio Areas section in HTML');
        return;
      }
      const areaCardEls = [];
      for (let fi = 0; fi < expectedAreaPages.length; fi += 1) {
        const artEl = areaSecRest[fi];
        if (isHiddenEl(artEl) || !isWhitespaceOnly(artEl.ownText)) {
          findings.add('reading-order', pagePath, 'hidden or malformed area card <article class="finding"> on portfolio page in HTML');
          return;
        }
        const h3 = artEl.children[0];
        if (!isValidAreaCardH3Html(h3)) {
          findings.add('reading-order', pagePath, 'missing, hidden, or malformed <h3> inside area card on portfolio page in HTML');
          return;
        }
        const h3Links = [];
        const walkH3 = (node) => {
          for (const ch of node.children) {
            if (isHiddenEl(ch)) return false;
            if (ch.tag === 'a') h3Links.push(ch);
            if (!walkH3(ch)) return false;
          }
          return true;
        };
        if (!walkH3(h3) || h3Links.length !== 1 || typeof h3Links[0].href !== 'string') {
          findings.add('reading-order', pagePath, 'malformed or hidden link inside area card <h3> on portfolio page in HTML');
          return;
        }
        const resolvedHref = posix.normalize(posix.join(posix.dirname(pagePath), h3Links[0].href));
        areaCardEls.push({ artEl, h3, linkEl: h3Links[0], resolvedHref });
      }
      if (unassignedPage) {
        const uArt = areaSecRest[expectedAreaPages.length];
        const uH3 = uArt.children[0];
        const uLink = uH3?.children[0];
        const uRest = uArt.children.slice(1);
        const uResolved = uLink?.tag === 'a' && typeof uLink.href === 'string'
          ? posix.normalize(posix.join(posix.dirname(pagePath), uLink.href))
          : null;
        const uOk = !isHiddenEl(uArt) && isWhitespaceOnly(uArt.ownText)
          && isValidAreaCardH3Html(uH3) && uH3.children.length === 1
          && uResolved === 'area/unassigned/index.html'
          && fullElementText(uLink).trim() === String(unassignedPage.title ?? '').trim()
          && uRest.length >= 1 && uRest.length <= 2
          && uRest.every((ic) => isValidItemLinksChildHtml(ic, ['No unassigned items.']));
        if (!uOk) {
          findings.add('reading-order', pagePath, 'malformed unassigned area card on portfolio page in HTML');
          return;
        }
      }
      for (let ai = 0; ai < expectedAreaPages.length; ai += 1) {
        const ap = expectedAreaPages[ai];
        const { artEl, h3, linkEl, resolvedHref } = areaCardEls[ai];
        if (resolvedHref !== ap.html || fullElementText(linkEl).trim() !== String(ap.title ?? '').trim()) {
          findings.add('reading-order', pagePath, `portfolio area card ${ai + 1} disagrees with manifest area ${ap.id} in HTML`);
          return;
        }
        const dlMetrics = extractAreaDlMetricsHtml(artEl.children[1]);
        if (!dlMetrics) {
          findings.add('reading-order', pagePath, `missing or malformed <dl class="metrics"> inside portfolio area card for ${ap.id} in HTML`);
          return;
        }
        let cIdx = 2;
        let gapRefs = [];
        if (dlMetrics.coverageText === 'partial' || dlMetrics.coverageText === 'unavailable') {
          const parsedGaps = extractAreaCoverageClaimHtml(artEl.children[cIdx], dlMetrics.coverageText, page, pagePath, manifest);
          if (!parsedGaps) {
            findings.add('reading-order', pagePath, `missing or malformed coverage gap notice inside portfolio area card for ${ap.id} in HTML`);
            return;
          }
          gapRefs = parsedGaps;
          cIdx += 1;
        } else if (artEl.children[cIdx]?.tag === 'p' && artEl.children[cIdx].classes.has('claim')) {
          findings.add('reading-order', pagePath, `unexpected coverage notice inside complete portfolio area card for ${ap.id} in HTML`);
          return;
        }
        if (artEl.children[cIdx] && elSignature(artEl.children[cIdx]) === 'div:table') {
          const hasCountsTbl = [...countsTablesByEl.keys()].some((t) => isDescendantOf(t, artEl.children[cIdx]));
          if (!hasCountsTbl) {
            findings.add('reading-order', pagePath, `unexpected non-counts <table> inside portfolio area card for ${ap.id} in HTML`);
            return;
          }
          cIdx += 1;
        }
        const itemRest = artEl.children.slice(cIdx);
        if (itemRest.length < 1 || itemRest.length > 2 || !itemRest.every((ic) => isValidItemLinksChildHtml(ic, ['No items in this area.']))) {
          findings.add('reading-order', pagePath, `unexpected child element inside portfolio area card for ${ap.id} in HTML`);
          return;
        }
        const covPillEl = h3.children.find((c) => c.classes.has('cov-pill')) ?? null;
        if (covPillEl && isHiddenEl(covPillEl)) {
          findings.add('reading-order', pagePath, `hidden .cov-pill inside portfolio area card for ${ap.id} in HTML`);
          return;
        }
        parityState.portfolioAreaHtmlMetrics.set(ap.id, {
          metrics: dlMetrics,
          gapRefs,
          covPillText: covPillEl ? fullElementText(covPillEl).trim() : null,
          covPillClasses: covPillEl ? covPillEl.classes : null,
          cardClasses: artEl.classes,
        });
      }
      for (const [tblEl, projRows] of countsTablesByEl.entries()) {
        const ownerIdx = areaCardEls.findIndex((c) => isDescendantOf(tblEl, c.artEl));
        if (ownerIdx < 0) {
          findings.add('reading-order', pagePath, 'project counts <table> appears outside its owning area card on portfolio page in HTML');
          return;
        }
        const ownerAreaId = expectedAreaPages[ownerIdx].id;
        if (parityState.portfolioAreaCountsTables.has(ownerAreaId)) {
          findings.add('reading-order', pagePath, `duplicate project counts <table> inside portfolio area card for ${ownerAreaId} in HTML`);
          return;
        }
        parityState.portfolioAreaCountsTables.set(ownerAreaId, projRows);
        parityState.areaProjectTables.push({ pagePath, areaPageId: ownerAreaId, rows: projRows });
      }
    } else if (/^area\/[^/]+$/.test(page.id) && page.id !== 'area/unassigned') {
      const areaRef = page.id.slice(5);
      const expectedProjs = (Array.isArray(manifest?.pages) ? manifest.pages : [])
        .filter((p) => p.id.startsWith(`${page.id}/project/`));
      const areaSec = mainEl.children[1];
      if (!areaSec || areaSec.tag !== 'section' || !areaSec.classes.has('section') || areaSec.id !== `a-${areaRef}`
        || isHiddenEl(areaSec) || !isWhitespaceOnly(areaSec.ownText)
        || !isValidCanonicalH2Html(areaSec.children[0], ['Area summary', String(page.title ?? '').trim()])) {
        findings.add('reading-order', pagePath, `missing or malformed #a-${areaRef} summary section on area page ${page.id} in HTML`);
        return;
      }
      const dlMetrics = extractAreaDlMetricsHtml(areaSec.children[1]);
      if (!dlMetrics) {
        findings.add('reading-order', pagePath, `missing or malformed <dl class="metrics"> on area page ${page.id} in HTML`);
        return;
      }
      let gapRefs = [];
      if (dlMetrics.coverageText === 'partial' || dlMetrics.coverageText === 'unavailable') {
        const parsedGaps = areaSec.children.length === 3
          ? extractAreaCoverageClaimHtml(areaSec.children[2], dlMetrics.coverageText, page, pagePath, manifest)
          : null;
        if (!parsedGaps) {
          findings.add('reading-order', pagePath, `missing, malformed, or accompanied by extra elements coverage gap notice on area page ${page.id} in HTML`);
          return;
        }
        gapRefs = parsedGaps;
      } else if (areaSec.children.length !== 2) {
        findings.add('reading-order', pagePath, `unexpected extra child inside #a-${areaRef} summary section on area page ${page.id} in HTML`);
        return;
      }
      let secPos = 2;
      if (expectedProjs.length > 0) {
        const projListSec = mainEl.children[secPos];
        const projBodyEl = projListSec?.children[1];
        const projTblOk = projBodyEl && elSignature(projBodyEl) === 'div:table' && countsTablesByEl.size === 1
          && isDescendantOf([...countsTablesByEl.keys()][0], projBodyEl);
        const projUlOk = projBodyEl && isValidV1ProjectsUlHtml(projBodyEl, expectedProjs, pagePath);
        if (!projListSec || projListSec.tag !== 'section' || !projListSec.classes.has('section') || projListSec.ariaLabel !== 'Projects'
          || isHiddenEl(projListSec) || !isWhitespaceOnly(projListSec.ownText) || projListSec.children.length !== 2
          || !isValidCanonicalH2Html(projListSec.children[0], ['Projects'])
          || (!projTblOk && !projUlOk)) {
          findings.add('reading-order', pagePath, `missing or malformed Projects section on area page ${page.id} in HTML`);
          return;
        }
        secPos += 1;
      } else if (countsTablesByEl.size > 0) {
        findings.add('reading-order', pagePath, `unexpected project counts <table> on zero-project area page ${page.id} in HTML`);
        return;
      }
      const itemsSec = mainEl.children[secPos];
      const itemsRest = itemsSec ? itemsSec.children.slice(1) : [];
      if (!itemsSec || itemsSec.tag !== 'section' || !itemsSec.classes.has('section') || itemsSec.ariaLabel !== 'Items in this area'
        || isHiddenEl(itemsSec) || !isWhitespaceOnly(itemsSec.ownText)
        || !isValidCanonicalH2Html(itemsSec.children[0], ['Items in this area'])
        || itemsRest.length < 1 || itemsRest.length > 2
        || !itemsRest.every((ic) => isValidItemLinksChildHtml(ic, ['No items recorded in this area.', 'No items in this area.']))) {
        findings.add('reading-order', pagePath, `missing or malformed Items in this area section on area page ${page.id} in HTML`);
        return;
      }
      secPos += 1;
      if (!verifyPageTailSectionsHtml(mainEl.children.slice(secPos), page, manifest, false, parityState)) {
        findings.add('reading-order', pagePath, `unexpected, missing, or malformed top-level section on area page ${page.id} in HTML`);
        return;
      }
      parityState.areaHtmlMetricsByPage.set(page.id, { pagePath, metrics: dlMetrics, gapRefs });
      if (countsTablesByEl.size > 1) {
        findings.add('reading-order', pagePath, `duplicate project counts <table> on area page ${page.id} in HTML`);
        return;
      }
      for (const [, projRows] of countsTablesByEl.entries()) {
        parityState.areaPageCountsTables.set(page.id, projRows);
        parityState.areaProjectTables.push({ pagePath, areaPageId: page.id, rows: projRows });
      }
    } else if (page.id === 'area/unassigned') {
      if (countsTablesByEl.size > 0) {
        findings.add('reading-order', pagePath, `unexpected project counts <table> on ${page.id} in HTML`);
        return;
      }
      const unassSec = mainEl.children[1];
      const ledeEl = unassSec?.children[1];
      const unassRest = unassSec ? unassSec.children.slice(2) : [];
      const unassOk = unassSec && unassSec.tag === 'section' && unassSec.classes.has('section') && unassSec.id === 'a-unassigned'
        && !isHiddenEl(unassSec) && isWhitespaceOnly(unassSec.ownText)
        && isValidCanonicalH2Html(unassSec.children[0], ['Unassigned items', String(page.title ?? '').trim()])
        && ledeEl && elSignature(ledeEl) === 'p:lede' && !isHiddenEl(ledeEl) && ledeEl.children.length === 0
        && fullElementText(ledeEl).trim() === 'These items name no area in the registry and remain visible until mapped.'
        && unassRest.length >= 1 && unassRest.length <= 2
        && unassRest.every((ic) => isValidItemLinksChildHtml(ic, ['No unassigned items.']))
        && verifyPageTailSectionsHtml(mainEl.children.slice(2), page, manifest, false, parityState);
      if (!unassOk) {
        findings.add('reading-order', pagePath, 'unexpected or malformed section structure on area/unassigned page in HTML');
        return;
      }
    } else if (/^area\/[^/]+\/project\/[^/]+$/.test(page.id)) {
      if (countsTablesByEl.size > 0) {
        findings.add('reading-order', pagePath, `unexpected project counts <table> on ${page.id} in HTML`);
        return;
      }
      const projSec = mainEl.children[1];
      let pIdx = 1;
      let v1LedeOk = true;
      if (projSec?.children[1] && elSignature(projSec.children[1]) === 'p:lede') {
        const lede = projSec.children[1];
        v1LedeOk = !isHiddenEl(lede) && fullElementText(lede).trim().startsWith('Area: ')
          && lede.children.every((ch) => !isHiddenEl(ch) && ch.children.length === 0 && (ch.tag === 'a' || ch.tag === 'code'));
        pIdx = 2;
      }
      const projRest = projSec ? projSec.children.slice(pIdx) : [];
      const isValidProjChild = (ch) => {
        if (elSignature(ch) === 'div:table' && !isHiddenEl(ch)) {
          return [...triageTablesByEl.keys()].some((t) => isDescendantOf(t, ch));
        }
        return isValidCloseDetailsDrawer(ch) || isValidItemLinksChildHtml(ch, ['No items in this project.']);
      };
      const projOk = projSec && projSec.tag === 'section' && projSec.classes.has('section')
        && String(projSec.ariaLabel ?? '').trim() === String(page.title ?? '').trim()
        && !isHiddenEl(projSec) && isWhitespaceOnly(projSec.ownText)
        && isValidCanonicalH2Html(projSec.children[0], ['Project items', String(page.title ?? '').trim()])
        && v1LedeOk
        && projRest.length >= 1 && projRest.length <= 4
        && projRest.every(isValidProjChild)
        && verifyPageTailSectionsHtml(mainEl.children.slice(2), page, manifest, false, parityState);
      if (!projOk) {
        findings.add('reading-order', pagePath, `unexpected or malformed section structure on project page ${page.id} in HTML`);
        return;
      }
    } else if (countsTablesByEl.size > 0) {
      findings.add('reading-order', pagePath, `unexpected project counts <table> on ${page.id} in HTML`);
      return;
    }

    const excludedNonItemRoots = new Set(
      mainEl.children.filter((ch) => ch === titleBlock
        || (ch.tag === 'section' && (ch.ariaLabel === 'Evidence' || ch.ariaLabel === 'Explicit gaps' || ch.ariaLabel === 'Prior editions'))),
    );
    const bareItemAll = new Set();
    const bareItemVis = new Set();
    const visDecAnchors = [];
    const triageTableVisDecAnchors = [];
    const detDecAnchors = [];
    for (const el of inspected.elements) {
      if (el.tag !== 'a' || typeof el.href !== 'string') continue;
      let inMain = false;
      let inExcluded = false;
      let hasHiddenAnc = isHiddenEl(el);
      let detailsAnc = null;
      for (let anc = el.parent; anc; anc = anc.parent) {
        if (anc === mainEl) {
          inMain = true;
          break;
        }
        if (excludedNonItemRoots.has(anc)) {
          inExcluded = true;
          break;
        }
        if (isHiddenEl(anc)) hasHiddenAnc = true;
        if (anc.tag === 'details' && !detailsAnc) detailsAnc = anc;
      }
      if (!inMain || inExcluded) continue;
      const hi = el.href.indexOf('#');
      const rawPath = hi >= 0 ? el.href.slice(0, hi) : el.href;
      const frag = hi >= 0 ? el.href.slice(hi + 1) : null;
      if (!rawPath || /^https?:\/\//i.test(rawPath)) continue;
      const resolvedHtml = posix.normalize(posix.join(posix.dirname(page.html), rawPath));
      const itemMatch = /^item\/([A-Za-z][A-Za-z0-9-]{0,63})\/index\.html$/.exec(resolvedHtml);
      if (!itemMatch) continue;
      if (hasHiddenAnc) {
        findings.add('reading-order', pagePath, `hidden item or decision link ${JSON.stringify(el.href)} on non-item page in HTML`);
        return;
      }
      if (detailsAnc) {
        const detSum = detailsAnc.children[0];
        if (!detSum || detSum.tag !== 'summary' || isHiddenEl(detSum) || visibleChars(detSum) === 0) {
          findings.add('reading-order', pagePath, 'item or decision link inside <details> with missing or hidden <summary> in HTML');
          return;
        }
      }
      const targetItemPage = `item/${itemMatch[1]}`;
      if (frag === null) {
        bareItemAll.add(targetItemPage);
        if (!detailsAnc) bareItemVis.add(targetItemPage);
      } else if (frag.startsWith('d-')) {
        if (detailsAnc) {
          detDecAnchors.push(frag);
        } else {
          visDecAnchors.push(frag);
          if (triageTableAnchorLinks.has(el)) triageTableVisDecAnchors.push(frag);
        }
      }
    }
    parityState.nonItemHtmlItemsByPage.set(page.id, {
      pagePath,
      bareItemAll,
      bareItemVis,
      visDecAnchors,
      triageTableVisDecAnchors,
      detDecAnchors,
    });
  }

  const allDecEls = inspected.elements.filter((el) => el.classes.has('decision'));
  if (allDecEls.length !== pageDecisions.length) {
    findings.add('reading-order', pagePath, `expected ${pageDecisions.length} decision article(s) in HTML, found ${allDecEls.length}`);
    return;
  }
  if (pageDecisions.length === 0) {
    if (page.id.startsWith('item/')) {
      const itemRef = page.id.slice('item/'.length);
      const itemSec = mainEl.children[1];
      if (!itemSec || itemSec.tag !== 'section' || !itemSec.classes.has('section') || itemSec.id !== `i-${itemRef}`
        || isHiddenEl(itemSec) || !checkItemSectionHeadingsHtml(inspected, itemSec, pagePath, findings)
        || !verifyPageTailSectionsHtml(mainEl.children.slice(2), page, manifest, false, parityState)) {
        findings.add('reading-order', pagePath, 'unexpected or malformed top-level section structure on zero-decision item page in HTML');
        return;
      }
      const parsedItemSec = extractItemSectionHtml(itemSec, page, manifest, parityState);
      if (!parsedItemSec) {
        findings.add('reading-order', pagePath, 'malformed or unexpected content inside item section on zero-decision item page in HTML');
        return;
      }
      if (parityState) {
        parityState.itemHtmlBlockMeta.set(page.id, parsedItemSec);
        for (const b of parsedItemSec.blocks) {
          if (b.anchor && typeof b.title === 'string') parityState.blockTitleByAnchor.set(b.anchor, b.title);
        }
      }
    }
    return;
  }

  const decSec = allDecEls[0].parent;
  const secIdx = mainEl.children.indexOf(decSec);
  if (!decSec || decSec.tag !== 'section' || !decSec.classes.has('section') || isHiddenEl(decSec) || !isWhitespaceOnly(decSec.ownText) || (secIdx !== 1 && secIdx !== 2)) {
    findings.add('reading-order', pagePath, 'Decisions section missing or preceded by unexpected pre-decision section in HTML');
    return;
  }
  const itemRef = page.id.slice('item/'.length);
  let itemSec = null;
  if (secIdx === 2) {
    itemSec = mainEl.children[1];
    if (!itemSec || itemSec.tag !== 'section' || !itemSec.classes.has('section') || isHiddenEl(itemSec) || itemSec.id !== `i-${itemRef}`
      || parityState?.strictParity || itemSec.children.some((c) => c.classes.has('prose-sheet'))) {
      findings.add('reading-order', pagePath, 'section preceding Decisions in HTML is not permitted on item page');
      return;
    }
  } else {
    itemSec = mainEl.children[2];
    if (!itemSec || itemSec.tag !== 'section' || !itemSec.classes.has('section') || isHiddenEl(itemSec) || itemSec.id !== `i-${itemRef}`) {
      findings.add('reading-order', pagePath, 'item section missing after Decisions on item page in HTML');
      return;
    }
  }
  if (!checkItemSectionHeadingsHtml(inspected, itemSec, pagePath, findings)) return;
  const parsedItemSec = extractItemSectionHtml(itemSec, page, manifest, parityState);
  if (!parsedItemSec) {
    findings.add('reading-order', pagePath, 'malformed or unexpected content inside item section in HTML');
    return;
  }
  if (parityState) {
    parityState.itemHtmlBlockMeta.set(page.id, parsedItemSec);
    for (const b of parsedItemSec.blocks) {
      if (b.anchor && typeof b.title === 'string') parityState.blockTitleByAnchor.set(b.anchor, b.title);
    }
  }
  if (!verifyPageTailSectionsHtml(mainEl.children.slice(3), page, manifest, false, parityState)) {
    findings.add('reading-order', pagePath, 'unexpected, missing, or malformed tail section on item page in HTML');
    return;
  }

  const dc = decSec.children;
  const h2Sec = dc[0];
  const h2SecOk = isValidCanonicalH2Html(h2Sec, ['Decisions']);
  if (dc.length < 1 + pageDecisions.length || !h2SecOk) {
    findings.add('reading-order', pagePath, 'Decisions section header malformed in HTML');
    return;
  }
  let offset = 1;
  if (dc[1]?.tag === 'nav' && dc[1].classes.has('triage-pager')) {
    const pg = dc[1];
    const [pPrev, pPos, pNext] = pg.children;
    const pagerOk = !isHiddenEl(pg) && isWhitespaceOnly(pg.ownText) && pg.children.length === 3
      && !hasForbiddenClassInSubtree(pg, SHELL_CHROME_FORBIDDEN_CLASSES)
      && pPrev && !isHiddenEl(pPrev) && pPrev.children.length === 0
      && (elSignature(pPrev) === 'a:triage-pager__link' || elSignature(pPrev) === 'span:triage-pager__muted')
      && /^← (?:First in queue|Previous \([A-Za-z0-9-]{1,64}\))$/.test(fullElementText(pPrev).trim())
      && pPos && !isHiddenEl(pPos) && elSignature(pPos) === 'span:triage-pager__pos'
      && pPos.children.length === 1 && elSignature(pPos.children[0]) === 'a:' && !isHiddenEl(pPos.children[0]) && pPos.children[0].children.length === 0
      && /^(?:Active decision|Close candidate) \d+ of \d+ · Triage queue$/.test(fullElementText(pPos).trim())
      && pNext && !isHiddenEl(pNext) && pNext.children.length === 0
      && (elSignature(pNext) === 'a:triage-pager__link' || elSignature(pNext) === 'span:triage-pager__muted')
      && /^(?:Last in queue|Next \([A-Za-z0-9-]{1,64}\)) →$/.test(fullElementText(pNext).trim());
    if (!pagerOk) {
      findings.add('reading-order', pagePath, 'triage pager contains unexpected pre-decision elements or text in HTML');
      return;
    }
    offset = 2;
  }
  if (dc.length !== offset + pageDecisions.length) {
    findings.add('reading-order', pagePath, 'Decisions section contains unexpected pre-decision or inter-decision sibling elements in HTML');
    return;
  }
  for (let di = 0; di < pageDecisions.length; di += 1) {
    const child = dc[offset + di];
    if (!child || child.tag !== 'article' || !child.classes.has('decision') || child.id !== pageDecisions[di].anchor) {
      findings.add('reading-order', pagePath, `decision ${pageDecisions[di].decisionRef} missing or out of manifest order in HTML`);
      return;
    }
  }

  for (const d of pageDecisions) {
    checkQuestionReadingOrderHtml(inspected, page, pagePath, manifest, d, findings, parityState);
  }
}

function checkQuestionReadingOrderHtml(inspected, page, pagePath, manifest, decision, findings, parityState) {
  const decArticles = inspected.elements.filter((el) => el.tag === 'article' && el.id === decision.anchor && el.classes.has('decision'));
  if (decArticles.length !== 1) {
    findings.add('reading-order', pagePath, `decision ${decision.decisionRef} article missing or duplicated in HTML`);
    return;
  }
  const decEl = decArticles[0];
  if (isHiddenEl(decEl) || !hasValidDecisionSubtree(decEl) || !isWhitespaceOnly(decEl.ownText) || decEl.children.length !== decision.questions.length + 1) {
    findings.add('reading-order', pagePath, `decision ${decision.decisionRef} contains unexpected or hidden child elements in HTML`);
    return;
  }
  const headEl = decEl.children[0];
  const labelsEl = headEl?.children[0];
  const h3El = headEl?.children[1];
  const labelsOk = labelsEl?.tag === 'p' && labelsEl.classes.size === 1 && labelsEl.classes.has('labels')
    && !isHiddenEl(labelsEl) && isWhitespaceOnly(labelsEl.ownText) && labelsEl.children.length === 2
    && labelsEl.children[0].tag === 'span' && labelsEl.children[0].classes.has('dec')
    && (labelsEl.children[0].classes.has('dec-needed') || labelsEl.children[0].classes.has('conf-open'))
    && !isHiddenEl(labelsEl.children[0]) && labelsEl.children[0].children.length === 0
    && fullElementText(labelsEl.children[0]).trim() === decision.kind
    && labelsEl.children[1].tag === 'span' && labelsEl.children[1].classes.size === 1 && labelsEl.children[1].classes.has('item__id')
    && !isHiddenEl(labelsEl.children[1]) && labelsEl.children[1].children.length === 0
    && fullElementText(labelsEl.children[1]).trim() === `Decision ${decision.decisionRef}`;
  const h3Text = h3El ? fullElementText(h3El) : '';
  const h3ClassesOk = h3El && (h3El.classes.size === 0 || (h3El.classes.size === 1 && h3El.classes.has('visually-hidden')));
  const h3NotDisplayHidden = h3El && !h3El.hasHiddenAttr && h3El.ariaHidden !== 'true';
  const ariaLabelOk = typeof decEl.ariaLabel === 'string'
    && decEl.ariaLabel.trim().length > 0
    && decEl.ariaLabel.length <= 200
    && h3Text === decEl.ariaLabel;
  const headOk = headEl?.tag === 'header' && headEl.classes.has('item__head') && !isHiddenEl(headEl) && isWhitespaceOnly(headEl.ownText)
    && headEl.children.length === 2 && labelsOk
    && h3El?.tag === 'h3' && h3ClassesOk && h3NotDisplayHidden && h3El.children.length === 0
    && ariaLabelOk && !hasDescendantTag(headEl, 'a');
  if (!headOk) {
    findings.add('reading-order', pagePath, `decision ${decision.decisionRef} header violates P14 structure or aria-label parity in HTML`);
    return;
  }

  const questionsMap = new Map();
  let allQuestionsOk = true;

  for (let qi = 0; qi < decision.questions.length; qi += 1) {
    const q = decision.questions[qi];
    const sec = decEl.children[qi + 1];
    if (!sec || sec.tag !== 'section' || sec.id !== q.anchor || !sec.classes.has('question') || isHiddenEl(sec) || !isWhitespaceOnly(sec.ownText)
      || typeof sec.ariaLabel !== 'string' || sec.ariaLabel.trim().length === 0 || sec.ariaLabel.length > 500) {
      findings.add('reading-order', pagePath, `question ${q.questionRef} section missing, misordered, or malformed in HTML`);
      allQuestionsOk = false;
      continue;
    }
    let valid = false;
    let recOptRef = null;
    let recInfo = null;
    let optRes = null;
    let evRes = { cites: [], items: [] };

    if (sec.children.length === 3 && sec.children[0].tag === 'div' && sec.children[0].classes.has('question__bar')) {
      const [bar, opts, footer] = sec.children;
      const barPrompt = bar.children[0];
      const barId = bar.children[1];
      let promptParityOk = false;
      if (barPrompt?.children.length === 0) {
        promptParityOk = fullElementText(barPrompt) === sec.ariaLabel;
      } else if (barPrompt?.children.length === 1 && Array.isArray(barPrompt.nodes)
        && barPrompt.children[0].tag === 'span' && barPrompt.children[0].classes.size === 1
        && barPrompt.children[0].classes.has('visually-hidden') && !barPrompt.children[0].hasHiddenAttr && barPrompt.children[0].ariaHidden !== 'true'
        && barPrompt.children[0].children.length === 0) {
        const vhSp = barPrompt.children[0];
        const vhIdx = barPrompt.nodes.findIndex((nd) => nd.kind === 'el' && nd.el === vhSp);
        const beforeVh = vhIdx >= 0 ? extractNodeTextSlice(barPrompt, 0, vhIdx) : null;
        const afterVh = vhIdx >= 0 ? extractNodeTextSlice(barPrompt, vhIdx + 1, barPrompt.nodes.length) : null;
        const hiddenPrompt = fullElementText(vhSp);
        const visibleConfirm = afterVh !== null ? afterVh.trim() : '';
        promptParityOk = beforeVh === ''
          && (hiddenPrompt === `${sec.ariaLabel} ` || hiddenPrompt.trim() === sec.ariaLabel.trim())
          && (visibleConfirm === 'Confirm close disposition or override' || visibleConfirm === 'Confirm or override this item');
      }
      const barIdClassesOk = barId && barId.classes.has('item__id')
        && [...barId.classes].every((c) => c === 'item__id' || c === 'question__ref');
      const barIdText = barId ? fullElementText(barId).trim() : '';
      const barOk = !isHiddenEl(bar) && isWhitespaceOnly(bar.ownText) && bar.children.length === 2
        && barPrompt?.tag === 'h4' && barPrompt.classes.has('question__prompt')
        && !isHiddenEl(barPrompt) && visibleChars(barPrompt) > 0 && promptParityOk
        && barId?.tag === 'span' && barIdClassesOk
        && !isHiddenEl(barId) && barId.children.length === 0
        && (barIdText === q.questionRef || barIdText === `Question ${qi + 1} of ${decision.questions.length} · ${q.questionRef}`)
        && !hasDescendantTag(bar, 'a');
      const recCheck = footer.tag === 'div' && footer.classes.has('question__footer') && !isHiddenEl(footer) && isWhitespaceOnly(footer.ownText)
        && (footer.children.length === 1 || footer.children.length === 2)
        ? extractRecommendationOptRef(footer.children[0], q, true)
        : { ok: false, recOptRef: null, recInfo: null };
      if (recCheck.ok && footer.children.length === 2) {
        evRes = extractQuestionEvRefsHtml(footer.children[1], page, pagePath, manifest, parityState, q.questionRef);
      }
      const footerOk = recCheck.ok && (footer.children.length === 1 || evRes !== null);
      optRes = recCheck.ok ? validateOptionsBlock(opts, q, recCheck.recOptRef, true, Boolean(parityState?.hasEvRefTitleCss)) : null;
      recOptRef = recCheck.recOptRef;
      recInfo = recCheck.recInfo;
      valid = barOk && optRes !== null && footerOk;
    } else if (!parityState?.hasEvRefTitleCss && (sec.children.length === 3 || sec.children.length === 4)) {
      const [prompt, opts, rec, ev] = sec.children;
      const v1PromptChildrenOk = prompt.children.every((ch) => ch.children.length === 0 && !isHiddenEl(ch)
        && ((ch.tag === 'code' && ch.classes.size === 0 && !q.optionRefs.includes(fullElementText(ch).trim()))
          || (ch.tag === 'span' && ch.classes.size === 1 && ch.classes.has('item__id') && fullElementText(ch).trim() === q.questionRef)));
      let v1PromptText = '';
      if (Array.isArray(prompt.nodes)) {
        for (const node of prompt.nodes) {
          if (node.kind === 'text') v1PromptText += decodeHtmlAttr(node.value);
          else if (!(node.el.tag === 'span' && node.el.classes.has('item__id'))) v1PromptText += fullElementText(node.el);
        }
      }
      const promptOk = prompt.tag === 'h4' && prompt.classes.has('question__prompt') && !isHiddenEl(prompt)
        && visibleChars(prompt) > 0 && v1PromptChildrenOk
        && v1PromptText.trim() === sec.ariaLabel.trim()
        && !hasDescendantTag(prompt, 'a');
      const recCheck = extractRecommendationOptRef(rec, q, false);
      if (recCheck.ok && ev !== undefined) {
        evRes = extractQuestionEvRefsHtml(ev, page, pagePath, manifest, parityState, q.questionRef);
      }
      optRes = recCheck.ok ? validateOptionsBlock(opts, q, recCheck.recOptRef, false) : null;
      recOptRef = recCheck.recOptRef;
      recInfo = recCheck.recInfo;
      valid = promptOk && optRes !== null && recCheck.ok && (ev === undefined || evRes !== null);
    }

    if (!valid) {
      findings.add('reading-order', pagePath, `question ${q.questionRef} violates question -> options -> recommendation -> evidence order in HTML`);
      allQuestionsOk = false;
    } else {
      questionsMap.set(q.anchor, {
        prompt: sec.ariaLabel,
        recOptRef,
        recInfo,
        optLabels: optRes.optLabels,
        optSummaries: optRes.optSummaries,
        evCites: evRes.cites,
        evItems: evRes.items,
      });
    }
  }

  if (allQuestionsOk && parityState) {
    parityState.htmlDecisions.set(decision.anchor, {
      label: decEl.ariaLabel,
      pagePath,
      questions: questionsMap,
    });
  }
}

const SELF_REF_DEF_RE = /^\[([A-Za-z][A-Za-z0-9-]{0,127})\]: #\1$/;
const CITE_REF_DEF_RE = /^\[(E\d+)\]: (?:(?:\.\.\/)*(?:(?:area|item)\/[A-Za-z0-9/_-]+\/)?index\.md#ev-[A-Za-z0-9-]+|#ev-[A-Za-z0-9-]+)$/;
const CANONICAL_FENCE_OPEN_RE = /^(`{3,})(typescript|javascript|json|shell|yaml|text|diff)$/;

function scanMdInlineSpan(line, mdProblems, seenLabels = null, isCanonicalRefDef = false, unclosedBacktickIsLiteral = false, destMode = 'non-table') {
  assertValidMdLinkDestMode(destMode);
  const brackets = [];
  let pos = 0;
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (line[pos + run] === '`') run += 1;
      let j = pos + run;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '`') {
          let r2 = 0;
          while (line[j + r2] === '`') r2 += 1;
          if (r2 === run) {
            closed = true;
            pos = j + r2;
            break;
          }
          j += r2;
        } else {
          j += 1;
        }
      }
      if (!closed) {
        if (unclosedBacktickIsLiteral) {
          pos += run;
          continue;
        }
        mdProblems.push('unclosed or multiline inline code span in Markdown');
        return;
      }
      continue;
    }
    if (ch === '<' && RAW_MD_HTML_OR_AUTOLINK.test(line.slice(pos))) {
      mdProblems.push('raw HTML construct or angle-bracket autolink in Markdown');
      return;
    }
    if (ch === '!' && line[pos + 1] === '[') {
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ isImage: true, active: true, strPos: pos + 1, bracketAfter: false });
      pos += 2;
      continue;
    }
    if (ch === '[') {
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ isImage: false, active: true, strPos: pos, bracketAfter: false });
      pos += 1;
      continue;
    }
    if (ch === ']') {
      const opener = brackets.pop();
      if (opener && opener.active) {
        const afterTailSpec = parseMdInlineLinkTail(line, pos + 1, 'spec');
        const afterTailCmjs = parseMdInlineLinkTail(line, pos + 1, 'cmjs');
        if (afterTailSpec > 0 || afterTailCmjs > 0) {
          if (opener.isImage || afterTailSpec !== afterTailCmjs || !isCanonicalMdInlineLinkDest(line, pos + 1, afterTailSpec, destMode)) {
            mdProblems.push('non-canonical CommonMark inline link or image in Markdown');
            return;
          }
          for (const b of brackets) {
            if (!b.isImage) b.active = false;
          }
          pos = afterTailSpec;
          continue;
        }
        if (seenLabels && !(isCanonicalRefDef && pos === line.indexOf(']'))) {
          const lbl = scanMdFollowingLinkLabel(line, pos + 1);
          if (lbl) {
            if (lbl.utf16Len > 2 && seenLabels.has(normalizeMdRefLabel(lbl.raw))) {
              mdProblems.push('non-canonical CommonMark full reference link or image in Markdown');
              return;
            }
            if (lbl.utf16Len === 2 && !opener.bracketAfter && seenLabels.has(normalizeMdRefLabel(line.slice(opener.strPos, pos + 1)))) {
              mdProblems.push('non-canonical CommonMark collapsed reference link or image in Markdown');
              return;
            }
            if (!lbl.cmjsValid && !opener.bracketAfter && seenLabels.has(normalizeMdRefLabel(line.slice(opener.strPos, pos + 1)))) {
              mdProblems.push('non-canonical CommonMark shortcut reference link or image in Markdown');
              return;
            }
          } else if (!opener.bracketAfter) {
            const rawSlice = line.slice(opener.strPos, pos + 1);
            if (seenLabels.has(normalizeMdRefLabel(rawSlice))) {
              if (opener.isImage || !/^\[E\d+\]$/.test(rawSlice) || line[pos + 1] === '[') {
                mdProblems.push('non-canonical CommonMark shortcut reference link or image in Markdown');
                return;
              }
              for (const b of brackets) {
                if (!b.isImage) b.active = false;
              }
              pos += 1;
              continue;
            }
          }
        }
      }
      if (line[pos + 1] === ':' && !(isCanonicalRefDef && pos === line.indexOf(']'))) {
        mdProblems.push('non-canonical CommonMark link reference definition in Markdown');
        return;
      }
      pos += 1;
      continue;
    }
    pos += 1;
  }
}

function scanNonFencedMdLine(row, mdProblems, seenLabels = null) {
  const line = row.text;
  if (/^[ \t>]/.test(line)) {
    mdProblems.push('indented line or blockquote outside fenced code block in Markdown');
    return;
  }
  if (/^(?:[-+*]|\d{1,9}[.)])(?:\t| {2,}| *$)/.test(line)
    || /^(?:[-+*]|\d{1,9}[.)]) (?:`{3,}[^`]*$|~{3,}|>|#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|\[[^\]]+\]:)/.test(line)) {
    mdProblems.push('non-canonical list marker or nested container block inside list item in Markdown');
    return;
  }
  if (/^(?:[-+*]|\d{1,9}[.)]) \[[ xX]\](?:[ \t]|$)/.test(line)) {
    mdProblems.push('GFM task-list item marker in Markdown');
    return;
  }
  if (/^(?:-{2,}|(?:-[\t ]*){3,}|(?:\*[\t ]*){3,}|(?:_[\t ]*){3,})[\t ]*$/.test(line)
    || (row.stateBefore === 'para' && /^(?:=+|-+)[\t ]*$/.test(line))) {
    mdProblems.push('Setext heading underline or thematic break in Markdown');
    return;
  }
  const isCanonicalRefDef = SELF_REF_DEF_RE.test(line) || CITE_REF_DEF_RE.test(line);
  scanMdInlineSpan(line, mdProblems, seenLabels, isCanonicalRefDef, false, row.inGfmTable ? 'raw-table' : 'non-table');
}

const MD_REMOVABLE_REFS_MAP = new Map([['&#58;', ':'], ['&#64;', '@'], ['&#46;', '.']]);
const MD_ENTITY_TOKEN_RE = /^&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/;

function tokenizeMdRelaxSpan(span, seenLabels = null, unclosedBacktickIsLiteral = false, destMode = 'non-table') {
  assertValidMdLinkDestMode(destMode);
  const tokens = [];
  const brackets = [];
  let i = 0;
  while (i < span.length) {
    if (span[i] === '\\' && i + 1 < span.length && MD_ESCAPABLE_RE.test(span[i + 1])) {
      tokens.push({ type: 'esc', src: span.slice(i, i + 2), ch: span[i + 1], lit: span[i + 1] });
      i += 2;
      continue;
    }
    if (span[i] === '`') {
      let run = 1;
      while (span[i + run] === '`') run += 1;
      let j = i + run;
      let close = -1;
      while (j < span.length) {
        if (span[j] === '`') {
          let m = 1;
          while (span[j + m] === '`') m += 1;
          if (m === run) {
            close = j;
            break;
          }
          j += m;
        } else {
          j += 1;
        }
      }
      if (close >= 0) {
        tokens.push({ type: 'opaque', src: span.slice(i, close + run), lit: '\u0000' });
        i = close + run;
        continue;
      }
      if (unclosedBacktickIsLiteral) {
        tokens.push({ type: 'raw', src: '`'.repeat(run), ch: '`', lit: '`'.repeat(run) });
        i += run;
        continue;
      }
    }
    if (span[i] === '&') {
      const rm = MD_ENTITY_TOKEN_RE.exec(span.slice(i));
      if (rm) {
        const ch = MD_REMOVABLE_REFS_MAP.get(rm[0]) ?? null;
        tokens.push({ type: 'ref', src: rm[0], ch, lit: ch ?? ' ' });
        i += rm[0].length;
        continue;
      }
    }
    if (span[i] === '[') {
      const isImage = tokens.at(-1)?.type === 'raw' && tokens.at(-1).ch === '!';
      if (brackets.length > 0) brackets[brackets.length - 1].bracketAfter = true;
      brackets.push({ isImage, active: true, strPos: i, bracketAfter: false });
      tokens.push({ type: 'raw', src: '[', ch: '[', lit: '[' });
      i += 1;
      continue;
    }
    if (span[i] === ']') {
      const closeIdx = i;
      const opener = brackets.pop();
      tokens.push({ type: 'raw', src: ']', ch: ']', lit: ']' });
      i += 1;
      if (opener && opener.active) {
        const afterTailSpec = parseMdInlineLinkTail(span, i, 'spec');
        const afterTailCmjs = parseMdInlineLinkTail(span, i, 'cmjs');
        if (afterTailSpec > 0 || afterTailCmjs > 0) {
          if (!opener.isImage && afterTailSpec === afterTailCmjs && isCanonicalMdInlineLinkDest(span, i, afterTailSpec, destMode)) {
            for (const b of brackets) {
              if (!b.isImage) b.active = false;
            }
            tokens.push({ type: 'opaque', src: span.slice(i, afterTailSpec), lit: '\u0000' });
            i = afterTailSpec;
          }
          continue;
        }
        if (seenLabels) {
          const rawLbl = scanMdFollowingLinkLabel(span, i);
          let refMatched = false;
          if (rawLbl) {
            if (rawLbl.utf16Len > 2 && seenLabels.has(normalizeMdRefLabel(rawLbl.raw))) {
              refMatched = true;
            } else if (rawLbl.utf16Len === 2 && !opener.bracketAfter
              && seenLabels.has(normalizeMdRefLabel(span.slice(opener.strPos, closeIdx + 1)))) {
              refMatched = true;
            } else if (!rawLbl.cmjsValid && !opener.bracketAfter
              && seenLabels.has(normalizeMdRefLabel(span.slice(opener.strPos, closeIdx + 1)))) {
              refMatched = true;
            }
          } else if (!opener.bracketAfter && span[i] !== '['
            && seenLabels.has(normalizeMdRefLabel(span.slice(opener.strPos, closeIdx + 1)))) {
            refMatched = true;
          }
          if (refMatched && !opener.isImage) {
            for (const b of brackets) {
              if (!b.isImage) b.active = false;
            }
          }
        }
      }
      continue;
    }
    const cp = String.fromCodePoint(span.codePointAt(i));
    tokens.push({ type: 'raw', src: cp, ch: cp, lit: cp });
    i += cp.length;
  }
  return tokens;
}

const MD_GFM_EMOJI_SHORTCODE_NAME_RE = /^(?:100|1234|\+1|-1|[a-z][a-z0-9_+-]*|[0-9][a-z0-9_+-]*[a-z][a-z0-9_+-]*)$/;

function scanMdBareAutolinkTokens(tokens, mdProblems) {
  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    if (tok.type !== 'raw' || (tok.ch !== ':' && tok.ch !== '.' && tok.ch !== '@')) continue;
    const before = tokens.slice(0, t).map((k) => k.lit).join('');
    const after = tokens.slice(t + 1).map((k) => k.lit).join('');
    if (tok.ch === ':') {
      if (/[A-Za-z][A-Za-z0-9+.-]*[A-Za-z0-9]$/.test(before) && /^\/\/\S/.test(after)) {
        mdProblems.push('bare GFM or Pandoc URI autolink in Markdown');
        return;
      }
      let emojiName = '';
      for (let u = t + 1; u < tokens.length; u += 1) {
        const nk = tokens[u];
        if (nk.type !== 'raw') break;
        if (nk.ch === ':') {
          if (MD_GFM_EMOJI_SHORTCODE_NAME_RE.test(emojiName)) {
            mdProblems.push('bare GFM or Pandoc emoji shortcode in Markdown');
            return;
          }
          break;
        }
        if (!/^[a-z0-9_+-]$/.test(nk.ch)) break;
        emojiName += nk.ch;
      }
    } else if (tok.ch === '.') {
      const rawWww = t >= 3
        && tokens[t - 3].type === 'raw' && /^[wW]$/.test(tokens[t - 3].ch)
        && tokens[t - 2].type === 'raw' && /^[wW]$/.test(tokens[t - 2].ch)
        && tokens[t - 1].type === 'raw' && /^[wW]$/.test(tokens[t - 1].ch);
      if (rawWww && /(?<![A-Za-z0-9])www$/i.test(before) && /^\S/.test(after)) {
        mdProblems.push('bare GFM www. autolink in Markdown');
        return;
      }
    } else if (tok.ch === '@') {
      if (/[\p{L}\p{N}\p{M}._%+-]$/u.test(before)
        && /^[\p{L}\p{N}\p{M}_-]+(?:\.[\p{L}\p{N}\p{M}_-]+)*\.[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}]/u.test(after)) {
        mdProblems.push('bare GFM or Pandoc email autolink in Markdown');
        return;
      }
    }
  }
}

function tildeRunCapabilities(tokens, first, last) {
  let canOpen = false;
  let canClose = false;
  const beforeCp = first > 0 ? lastCodePointStr(tokens[first - 1].src) : null;
  const afterCp = last + 1 < tokens.length ? firstCodePointStr(tokens[last + 1].src) : null;
  const beforeU = first > 0 ? tokens[first - 1].src.at(-1) : null;
  const afterU = last + 1 < tokens.length ? tokens[last + 1].src[0] : null;
  for (const prof of [MD_FLANK_PROFILES.spec, MD_FLANK_PROFILES.pandoc, MD_FLANK_PROFILES.cmjs]) {
    const b = prof.useCodePoints ? beforeCp : beforeU;
    const a = prof.useCodePoints ? afterCp : afterU;
    const bWs = b === null || prof.wsRe.test(b);
    const aWs = a === null || prof.wsRe.test(a);
    const bPt = b !== null && prof.punctRe.test(b);
    const aPt = a !== null && prof.punctRe.test(a);
    if (!aWs && (!aPt || bWs || bPt)) canOpen = true;
    if (!bWs && (!bPt || aWs || aPt)) canClose = true;
  }
  return { canOpen, canClose };
}

function scanMdInlineContainerTokens(lineTokenLists, mdProblems) {
  const capableRawTildes = [];
  const dollarMembers = [];
  const isCmSpace = (c) => c === null || MD_SPEC_WS_RE.test(c);

  for (const tokens of lineTokenLists) {
    for (let t = 0; t < tokens.length; t += 1) {
      const k = tokens[t];
      if (k.type === 'raw' && k.ch === '~') {
        let end = t;
        while (end + 1 < tokens.length && tokens[end + 1].type === 'raw' && tokens[end + 1].ch === '~') end += 1;
        const d = tildeRunCapabilities(tokens, t, end);
        if (d.canOpen || d.canClose) capableRawTildes.push(d);
        t = end;
      }
    }
    for (let t = 0; t < tokens.length; t += 1) {
      const k = tokens[t];
      if (k.type === 'opaque') {
        if (k.src.includes('$')) dollarMembers.push({ raw: false, open: true, close: true });
      } else if ((k.type === 'raw' || k.type === 'esc') && k.ch === '$') {
        const beforeCp = t > 0 ? lastCodePointStr(tokens[t - 1].src) : null;
        const afterCp = t + 1 < tokens.length ? firstCodePointStr(tokens[t + 1].src) : null;
        dollarMembers.push({ raw: k.type === 'raw', open: !isCmSpace(afterCp), close: !isCmSpace(beforeCp) });
      }
    }
  }

  if (capableRawTildes.some((r, idx) => r.canOpen && capableRawTildes.slice(idx + 1).some((r2) => r2.canClose))) {
    mdProblems.push('GFM strikethrough construct in Markdown');
  }
  if (dollarMembers.some((dm, idx) => dm.raw && (
    (dm.open && dollarMembers.slice(idx + 1).some((m2) => m2.close))
    || (dm.close && dollarMembers.slice(0, idx).some((m2) => m2.open))
  ))) {
    mdProblems.push('Pandoc math construct in Markdown');
  }
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN_MD_CHARS_RE = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

// Closed-world CommonMark (§4.5, §4.6, §4.7, §5.1, §5.2, §6.1) structural scanner:
// fenced code blocks must be top-level column-0 backtick fences isolated by blank lines,
// and non-fenced lines cannot open indented blocks, blockquotes, or container-scoped fences.
function parseMarkdownOutsideFences(md) {
  const mdProblems = [];
  if (md.includes('\u0000')) mdProblems.push('NUL character in Markdown');
  if (md.includes('\r')) mdProblems.push('CR character in Markdown');
  if (FORBIDDEN_MD_CHARS_RE.test(md)) mdProblems.push('forbidden control, bidi, or BOM character in Markdown');

  const rawLines = md.split('\n');
  const nonFenced = [];
  let fenceLen = 0;
  let activeFenceRow = null;
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (fenceLen === 0) {
      const open = CANONICAL_FENCE_OPEN_RE.exec(line);
      if (open) {
        if (i > 0 && rawLines[i - 1] !== '') {
          mdProblems.push('fenced code block opener must be preceded by a blank line in Markdown');
        }
        activeFenceRow = { lineNo: i, text: '\u0000FENCE\u0000', isFence: true, fenceLang: open[2], fenceLines: [] };
        nonFenced.push(activeFenceRow);
        fenceLen = open[1].length;
        continue;
      }
      if (/^~{3,}/.test(line) || (/^`{3,}/.test(line) && !line.replace(/^`+/, '').includes('`'))) {
        mdProblems.push('malformed or non-canonical code fence opener in Markdown');
        continue;
      }
      nonFenced.push({ lineNo: i, text: line });
    } else if (line === '`'.repeat(fenceLen)) {
      if ((rawLines[i + 1] ?? '') !== '') {
        mdProblems.push('closing code fence must be followed by a blank line in Markdown');
      }
      fenceLen = 0;
      activeFenceRow = null;
    } else {
      const close = /^ {0,3}(`{3,})[\t ]*$/.exec(line);
      if (close && close[1].length >= fenceLen) {
        mdProblems.push('non-canonical closing code fence in Markdown');
        fenceLen = 0;
        activeFenceRow = null;
      } else if (activeFenceRow) {
        activeFenceRow.fenceLines.push(line);
      }
    }
  }

  const mdAnchors = [];
  const seenLabels = new Set();
  for (const row of nonFenced) {
    const selfM = SELF_REF_DEF_RE.exec(row.text);
    const citeM = selfM ? null : CITE_REF_DEF_RE.exec(row.text);
    if (selfM) {
      const id = selfM[1];
      const key = id.toLowerCase().toUpperCase();
      if (seenLabels.has(key)) {
        mdProblems.push(`duplicate or colliding Markdown reference label ${JSON.stringify(id)}`);
      }
      seenLabels.add(key);
      const validHeadingCtx = row.lineNo >= 2
        && rawLines[row.lineNo - 1] === ''
        && /^#{1,6} [^\n]+$/.test(rawLines[row.lineNo - 2])
        && (row.lineNo === 2 || rawLines[row.lineNo - 3] === '')
        && (rawLines[row.lineNo + 1] ?? '') === '';
      if (!validHeadingCtx) {
        mdProblems.push(`Markdown anchor [${id}]: #${id} is not an isolated D10 definition directly beneath a top-level ATX heading`);
      } else {
        mdAnchors.push(id);
      }
    } else if (citeM) {
      const label = citeM[1];
      const key = label.toLowerCase().toUpperCase();
      if (seenLabels.has(key)) {
        mdProblems.push(`duplicate or colliding Markdown citation label ${JSON.stringify(label)}`);
      }
      seenLabels.add(key);
      const validCiteCtx = row.lineNo >= 1
        && (rawLines[row.lineNo - 1] === '' || CITE_REF_DEF_RE.test(rawLines[row.lineNo - 1]))
        && ((rawLines[row.lineNo + 1] ?? '') === '' || CITE_REF_DEF_RE.test(rawLines[row.lineNo + 1]));
      if (!validCiteCtx) {
        mdProblems.push(`Markdown citation definition [${label}] is attached to an adjacent paragraph or block`);
      }
    } else if (/^ {0,3}\[[^\]]+\]:/.test(row.text)) {
      mdProblems.push(`non-canonical Markdown reference definition ${JSON.stringify(row.text.slice(0, 60))}`);
    }
  }

  const mdThematicBreakRe = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  const leadingMdIndentCols = (s) => {
    let cols = 0;
    for (let k = 0; k < s.length; k += 1) {
      if (s[k] === ' ') cols += 1;
      else if (s[k] === '\t') cols += 4 - (cols % 4);
      else break;
    }
    return cols;
  };
  const matchMdListMarkerForState = (lineText, state) => {
    if (mdThematicBreakRe.test(lineText)) return null;
    const m = /^ {0,3}(?:([-+*])|(\d{1,9})[.)])(?:[ \t]+|$)/.exec(lineText);
    if (!m) return null;
    if (state === 'para') {
      const rest = lineText.slice(m[0].length);
      if (rest.trim() === '') return null;
      if (!m[1] && Number.parseInt(m[2], 10) !== 1) return null;
    }
    return m[0];
  };
  let preBlockState = 'none';
  let emptyListIndent = -1;
  for (const row of nonFenced) {
    row.listMarker = null;
    row.isEmptyListItem = false;
    if (row.isFence) {
      row.stateBefore = 'none';
      preBlockState = 'none';
      emptyListIndent = -1;
      continue;
    }
    const lineText = row.text;
    if (emptyListIndent > 0) {
      if (lineText.trim() !== '' && leadingMdIndentCols(lineText) >= emptyListIndent) {
        preBlockState = 'list';
      }
      emptyListIndent = -1;
    }
    row.stateBefore = preBlockState;
    if (
      lineText.trim() === ''
      || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(lineText)
      || mdThematicBreakRe.test(lineText)
      || (preBlockState === 'para' && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lineText))
      || SELF_REF_DEF_RE.test(lineText)
      || CITE_REF_DEF_RE.test(lineText)
    ) {
      preBlockState = 'none';
      continue;
    }
    if (/^ {0,3}>/.test(lineText)) {
      preBlockState = 'bq';
      continue;
    }
    const lm = matchMdListMarkerForState(lineText, preBlockState);
    if (lm !== null) {
      row.listMarker = lm;
      if (lineText.slice(lm.length).trim() === '') {
        row.isEmptyListItem = true;
        emptyListIndent = leadingMdIndentCols(lm);
        preBlockState = 'none';
      } else {
        preBlockState = 'list';
      }
      continue;
    }
    if (preBlockState !== 'list' && preBlockState !== 'bq') {
      preBlockState = 'para';
    }
  }

  const isNonEmptyBlockRow = (row) => !row.isFence
    && row.text.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, '').trim() !== ''
    && !/^#{1,6}(?:[ \t]|$)/.test(row.text)
    && row.listMarker === null
    && !SELF_REF_DEF_RE.test(row.text)
    && !CITE_REF_DEF_RE.test(row.text);
  let runStart = -1;
  for (let idx = 0; idx <= nonFenced.length; idx += 1) {
    if (idx < nonFenced.length && isNonEmptyBlockRow(nonFenced[idx])) {
      if (runStart < 0) runStart = idx;
    } else if (runStart >= 0) {
      const runEnd = idx - 1;
      for (let d = runStart + 1; d <= runEnd; d += 1) {
        if (isGfmTablePair(nonFenced[d - 1].text, nonFenced[d].text)) {
          if (d > runStart + 1 || (runStart > 0 && nonFenced[runStart - 1].text.trim() !== '')) {
            mdProblems.push('GFM table interrupting paragraph or list without preceding blank line in Markdown');
          } else {
            for (let r = runStart; r <= runEnd; r += 1) nonFenced[r].inGfmTable = true;
          }
          break;
        }
      }
      runStart = -1;
    }
  }

  for (const row of nonFenced) {
    if (!row.isFence) {
      scanNonFencedMdLine(row, mdProblems, seenLabels);
    }
  }

  let paraContainer = [];
  let paraRawLines = [];
  const serializeInlineAstConstructs = (root) => {
    const out = [];
    const serNode = (nd) => {
      if (nd.kind === 'text') return `T:${JSON.stringify(nd.text)}`;
      if (nd.kind === 'code') return `C:${JSON.stringify(nd.text)}`;
      const kids = [];
      for (let c = nd.firstChild; c !== null; c = c.next) kids.push(serNode(c));
      const destMeta = nd.destRaw ? `[${JSON.stringify(nd.destRaw)}]` : '';
      return `${nd.kind}${destMeta}(${kids.join(',')})`;
    };
    for (let c = root.firstChild; c !== null; c = c.next) {
      if (c.kind !== 'text') out.push(serNode(c));
    }
    return out;
  };
  const sameStringArray = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };
  const flushParaContainer = () => {
    if (paraContainer.length > 0) {
      scanMdInlineContainerTokens(paraContainer, mdProblems);
      if (paraRawLines.length > 1) {
        const joinedPara = paraRawLines.join('\n');
        scanMdInlineSpan(joinedPara, mdProblems, seenLabels, false, false, 'non-table');
        if (hasDisallowedMdEntityOutsideCodeAndDest(joinedPara, seenLabels, 'non-table')) {
          mdProblems.push('non-canonical character reference outside code span or link destination in Markdown');
        }
        const joinedToks = tokenizeMdRelaxSpan(joinedPara, seenLabels, false, 'non-table');
        scanMdBareAutolinkTokens(joinedToks, mdProblems);
        for (const prof of ['spec', 'pandoc', 'cmjs']) {
          const joinedAst = serializeInlineAstConstructs(parseMdInlineAst(joinedPara, seenLabels, prof));
          const perLineAst = paraRawLines.flatMap((l) => serializeInlineAstConstructs(parseMdInlineAst(l, seenLabels, prof)));
          if (!sameStringArray(joinedAst, perLineAst)) {
            mdProblems.push('cross-line CommonMark inline construct in multi-line paragraph in Markdown');
            break;
          }
        }
      }
      paraContainer = [];
      paraRawLines = [];
    }
  };
  let tableRunRows = [];
  const flushTableRun = () => {
    if (tableRunRows.length === 0) return;
    const headerCells = splitGfmTableCells(tableRunRows[0].text);
    const rawNonDelimCells = [];
    let framingValid = headerCells !== null;
    if (!framingValid) {
      mdProblems.push('non-canonical GFM table header row in Markdown');
    }
    for (const tRow of tableRunRows) {
      const rawLine = tRow.text;
      const rawPipes = splitMdUnescapedPipes(rawLine);
      if (!rawPipes || rawPipes.length < 3 || rawPipes[0] !== '' || rawPipes[rawPipes.length - 1] !== '') {
        framingValid = false;
        mdProblems.push('non-canonical GFM table row framing in Markdown');
      } else if (headerCells && rawPipes.length - 2 !== headerCells.length) {
        framingValid = false;
        mdProblems.push('mismatched cell count in GFM table row in Markdown');
      } else if (!isGfmTableDelimiterLine(rawLine)) {
        for (let cIdx = 1; cIdx < rawPipes.length - 1; cIdx += 1) {
          rawNonDelimCells.push(rawPipes[cIdx]);
        }
      }
    }
    const wholeTable = tableRunRows.map((r) => r.text).join('\n');
    scanMdInlineSpan(wholeTable, mdProblems, seenLabels, false, false, 'raw-table');
    if (hasDisallowedMdEntityOutsideCodeAndDest(wholeTable, seenLabels, 'raw-table')) {
      mdProblems.push('non-canonical character reference outside code span or link destination in Markdown');
    }
    if (framingValid) {
      for (const prof of ['spec', 'pandoc', 'cmjs']) {
        const wholeAst = serializeInlineAstConstructs(parseMdInlineAst(wholeTable, seenLabels, prof));
        const perCellAst = rawNonDelimCells.flatMap((c) => serializeInlineAstConstructs(parseMdInlineAst(c, seenLabels, prof)));
        if (!sameStringArray(wholeAst, perCellAst)) {
          mdProblems.push('cross-cell or cross-row CommonMark inline construct in GFM table in Markdown');
          break;
        }
      }
    }
    tableRunRows = [];
  };
  for (const row of nonFenced) {
    if (row.isFence) {
      flushParaContainer();
      flushTableRun();
      continue;
    }
    const line = row.text;
    if (line.trim() === '' || SELF_REF_DEF_RE.test(line) || CITE_REF_DEF_RE.test(line)) {
      flushParaContainer();
      flushTableRun();
      continue;
    }
    if (row.inGfmTable) {
      flushParaContainer();
      tableRunRows.push(row);
      if (!isGfmTableDelimiterLine(line)) {
        const cells = splitMdUnescapedPipes(line);
        if (cells) {
          for (const cell of cells) {
            if (hasEvenBackslashPipeOutsideCodeSpanInCell(cell)) {
              mdProblems.push('non-canonical even-backslash pipe escape outside code span in GFM table in Markdown');
            }
            const unescCell = unescapeGfmTableCell(cell);
            scanMdInlineSpan(unescCell, mdProblems, seenLabels, false, true, 'unesc-cell');
            const cellToks = tokenizeMdRelaxSpan(unescCell, seenLabels, true, 'unesc-cell');
            scanMdBareAutolinkTokens(cellToks, mdProblems);
            scanMdInlineContainerTokens([cellToks], mdProblems);
          }
        } else {
          mdProblems.push('non-canonical GFM table row without unescaped pipe delimiters in Markdown');
          const rawRowToks = tokenizeMdRelaxSpan(line, seenLabels, false, 'non-table');
          scanMdBareAutolinkTokens(rawRowToks, mdProblems);
          scanMdInlineContainerTokens([rawRowToks], mdProblems);
          const unescLine = unescapeGfmTableCell(line);
          scanMdInlineSpan(unescLine, mdProblems, seenLabels, false, true, 'unesc-cell');
          const unescRowToks = tokenizeMdRelaxSpan(unescLine, seenLabels, true, 'unesc-cell');
          scanMdBareAutolinkTokens(unescRowToks, mdProblems);
          scanMdInlineContainerTokens([unescRowToks], mdProblems);
        }
      }
      continue;
    }
    flushTableRun();
    const headingMatch = /^#{1,6}(?:[ \t]|$)/.exec(line);
    if (headingMatch) {
      flushParaContainer();
      const headToks = tokenizeMdRelaxSpan(line.slice(headingMatch[0].length), seenLabels);
      scanMdBareAutolinkTokens(headToks, mdProblems);
      scanMdInlineContainerTokens([headToks], mdProblems);
      continue;
    }
    if (row.listMarker !== null) {
      flushParaContainer();
      if (row.isEmptyListItem) continue;
      const itemBody = line.slice(row.listMarker.length);
      const itemToks = tokenizeMdRelaxSpan(itemBody, seenLabels);
      scanMdBareAutolinkTokens(itemToks, mdProblems);
      paraContainer.push(itemToks);
      paraRawLines.push(itemBody);
      continue;
    }
    const paraToks = tokenizeMdRelaxSpan(line, seenLabels);
    scanMdBareAutolinkTokens(paraToks, mdProblems);
    paraContainer.push(paraToks);
    paraRawLines.push(line);
  }
  flushParaContainer();
  flushTableRun();

  return { rawLines, nonFenced, mdAnchors, seenLabels, mdProblems, unclosedFence: fenceLen !== 0 };
}

function hasEvenBackslashPipeOutsideCodeSpanInCell(rawCell) {
  const brackets = [];
  let i = 0;
  while (i < rawCell.length) {
    if (rawCell[i] === '\\') {
      let slashes = 0;
      while (rawCell[i + slashes] === '\\') slashes += 1;
      if (rawCell[i + slashes] === '|') {
        if (slashes % 2 === 0) return true;
        i += slashes + 1;
        continue;
      }
      if (slashes % 2 === 1 && i + slashes < rawCell.length && MD_ESCAPABLE_RE.test(rawCell[i + slashes])) {
        i += slashes + 1;
      } else {
        i += slashes;
      }
      continue;
    }
    if (rawCell[i] === '`') {
      let run = 1;
      while (rawCell[i + run] === '`') run += 1;
      const close = findBacktickRun(rawCell, i + run, run);
      if (close >= 0) {
        i = close + run;
        continue;
      }
      i += run;
      continue;
    }
    if (rawCell[i] === '!' && rawCell[i + 1] === '[') {
      brackets.push({ isImage: true, active: true });
      i += 2;
      continue;
    }
    if (rawCell[i] === '[') {
      brackets.push({ isImage: false, active: true });
      i += 1;
      continue;
    }
    if (rawCell[i] === ']') {
      const opener = brackets.pop();
      if (opener && opener.active && !opener.isImage) {
        const afterTail = parseMdInlineLinkTail(rawCell, i + 1, 'spec');
        if (afterTail > 0 && isCanonicalMdInlineLinkDest(rawCell, i + 1, afterTail, 'raw-table')) {
          for (const b of brackets) {
            if (!b.isImage) b.active = false;
          }
          i = afterTail;
          continue;
        }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

function splitGfmTableRow(line) {
  if (typeof line !== 'string' || !line.startsWith('| ') || !line.endsWith(' |')) return null;
  const pipes = [0];
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === '|' && line[i - 1] !== '\\') {
      if (line[i - 1] !== ' ' || (i < line.length - 1 && line[i + 1] !== ' ')) return null;
      pipes.push(i);
    }
  }
  if (pipes.length < 2 || pipes[pipes.length - 1] !== line.length - 1) return null;
  const cells = [];
  for (let k = 0; k < pipes.length - 1; k += 1) {
    if (pipes[k + 1] - 1 < pipes[k] + 2) return null;
    const cell = line.slice(pipes[k] + 2, pipes[k + 1] - 1);
    if (hasEvenBackslashPipeOutsideCodeSpanInCell(cell)) return null;
    cells.push(cell);
  }
  return cells;
}

const MD_STANDALONE_BLOCK_OPENER_RE = /^(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/;

function isStandaloneMdParagraphRow(row) {
  const line = row?.text;
  return Boolean(line && !row.isFence && line !== '\u0000FENCE\u0000' && !row.inGfmTable && !MD_STANDALONE_BLOCK_OPENER_RE.test(line));
}

function unescapeGfmTableCell(cellMd) {
  return String(cellMd).replace(/\\\|/g, '|');
}

function defaultMdListMarkerForBlock(block) {
  if (block.type !== 'list' && block.type !== 'metrics') return null;
  return block.type === 'list' && block.ordered ? '.' : '-';
}

function trailingMdListMarkerForBlock(block, alternate = false) {
  switch (block.type) {
    case 'list': return block.ordered ? (alternate ? ')' : '.') : (alternate ? '+' : '-');
    case 'metrics': return alternate ? '+' : '-';
    case 'diagram': return '.';
    case 'comparison':
      return (!block.evLabels && !block.sides[1]?.code && block.sides[1]?.items?.length) ? '-' : null;
    case 'finding': {
      if (!block.detailBlocks?.length) return null;
      let prev = null;
      for (const db of block.detailBlocks) {
        const def = defaultMdListMarkerForBlock(db);
        const alt = def !== null && prev === def;
        prev = trailingMdListMarkerForBlock(db, alt);
      }
      return prev;
    }
    default: return null;
  }
}

function verifyItemSectionMd(nonFenced, h2Row, itemEndIdx, page, manifest, seenLabels, itemMeta, mdPath, findings, parityState) {
  if (!itemMeta) {
    findings.add('reading-order', mdPath, 'missing verified HTML item metadata for item section parity check');
    return false;
  }
  const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, idx) => v === b[idx]);
  const matchesInline = (rawMd, htmlInfo, { isTableCell = false } = {}) => {
    if (typeof rawMd !== 'string' || !htmlInfo || isMdCalloutSegment(rawMd, seenLabels, isTableCell)) return false;
    const dec = decodeGeneratedMdInline(
      isTableCell ? unescapeGfmTableCell(rawMd) : rawMd,
      seenLabels,
      isTableCell ? 'unesc-cell' : 'non-table',
    );
    return Boolean(dec && dec.text === htmlInfo.text && sameArr(dec.hrefs, htmlInfo.hrefs) && sameArr(dec.cites, htmlInfo.cites));
  };
  const decodeGfmTableProseCell = (cellMd) => (typeof cellMd === 'string'
    ? decodeGeneratedMdProse(unescapeGfmTableCell(cellMd), seenLabels)
    : null);

  const itemRef = page.id.slice('item/'.length);
  const h2Text = h2Row?.text ?? '';
  if (!h2Text.startsWith('## Item: ') || decodeGeneratedMdProse(h2Text.slice(9), seenLabels) !== page.title) {
    findings.add('reading-order', mdPath, '## Item heading title disagrees with page title in Markdown');
    return false;
  }
  let cur = h2Row.idx + 1;
  const headerOk = nonFenced[cur]?.text === ''
    && nonFenced[cur + 1]?.text === `[i-${itemRef}]: #i-${itemRef}`
    && nonFenced[cur + 2]?.text === ''
    && nonFenced[cur + 3]?.text === `- **Item:** ${mdInlineCode(itemRef)}`
    && nonFenced[cur + 4]?.text?.startsWith('- **Age:** ');
  if (!headerOk) {
    findings.add('reading-order', mdPath, 'malformed ## Item metadata preamble in Markdown');
    return false;
  }
  const decodedAge = decodeGeneratedMdProse(nonFenced[cur + 4].text.slice(11), seenLabels);
  if (decodedAge === null || decodedAge.trim().length === 0 || decodedAge.length > 80) {
    findings.add('reading-order', mdPath, 'malformed item Age metadata in Markdown');
    return false;
  }
  const trimmedAge = decodedAge.trim();
  if (itemMeta.htmlItemAge !== trimmedAge) {
    findings.add('reading-order', mdPath, 'item Age disagrees between HTML and Markdown');
    return false;
  }
  if (parityState) parityState.itemAgeByPage.set(page.id, trimmedAge);
  cur += 5;

  const pageById = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((p) => [p.id, p]));
  const gapOwnerByAnchor = new Map(
    (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
      .filter((a) => a.kind === 'gap')
      .map((a) => [a.anchor, a.page]),
  );
  if (itemMeta.gapRefs.length > 0) {
    const gLine = nonFenced[cur]?.text ?? '';
    if (!gLine.startsWith('- **Gaps:** ')) {
      findings.add('reading-order', mdPath, 'missing or malformed - **Gaps:** line in ## Item section in Markdown');
      return false;
    }
    const rawGapParts = gLine.slice('- **Gaps:** '.length).split(', ');
    if (rawGapParts.length !== itemMeta.gapRefs.length) {
      findings.add('reading-order', mdPath, 'item Gaps list disagrees between HTML and Markdown');
      return false;
    }
    for (let gi = 0; gi < rawGapParts.length; gi += 1) {
      const gm = /^\[([A-Za-z][A-Za-z0-9-]{0,63})\]\(([^()\s]*#g-([A-Za-z][A-Za-z0-9-]{0,63}))\)$/.exec(rawGapParts[gi]);
      const expGapRef = itemMeta.gapRefs[gi];
      if (!gm || gm[1] !== expGapRef || gm[3] !== expGapRef) {
        findings.add('reading-order', mdPath, 'malformed or mismatched item gap link in Markdown');
        return false;
      }
      const gAnchor = `g-${expGapRef}`;
      const ownerPageId = gapOwnerByAnchor.get(gAnchor) ?? '';
      const ownerPage = pageById.get(ownerPageId);
      if (!ownerPage) {
        findings.add('reading-order', mdPath, 'item gap link references unknown owner page in Markdown');
        return false;
      }
      if (ownerPageId === page.id) {
        if (gm[2] !== `#${gAnchor}`) {
          findings.add('reading-order', mdPath, 'same-page item gap link malformed in Markdown');
          return false;
        }
      } else {
        const hi = gm[2].indexOf('#');
        if (hi <= 0 || gm[2].slice(hi + 1) !== gAnchor
          || posix.normalize(posix.join(posix.dirname(mdPath), gm[2].slice(0, hi))) !== ownerPage.markdown) {
          findings.add('reading-order', mdPath, 'cross-page item gap link target disagrees with manifest in Markdown');
          return false;
        }
      }
    }
    cur += 1;
  }

  const calloutTailByLineIdx = new Map();

  const verifyBlockSeq = (blocks, startIdx, depth, initialPrevMarker) => {
    let c = startIdx;
    let prevMarker = initialPrevMarker;
    for (let bi = 0; bi < blocks.length; bi += 1) {
      if (bi > 0) {
        if (nonFenced[c]?.text !== '') return -1;
        c += 1;
      }
      const block = blocks[bi];
      const defMarker = defaultMdListMarkerForBlock(block);
      const alternate = defMarker !== null && prevMarker === defMarker;
      prevMarker = trailingMdListMarkerForBlock(block, alternate);
      const nextC = verifySingleBlock(block, c, depth, alternate);
      if (nextC < 0) return -1;
      c = nextC;
    }
    return c;
  };

  const checkValUnitCellMd = (cellMd, expectedNumStr, expectedUnit) => {
    if (typeof cellMd !== 'string') return false;
    const unescaped = unescapeGfmTableCell(cellMd);
    if (!unescaped.startsWith(`${expectedNumStr} `)) return false;
    return decodeGeneratedMdProse(unescaped.slice(expectedNumStr.length + 1), seenLabels) === expectedUnit;
  };

  const verifySingleBlock = (block, startIdx, depth, alternate) => {
    let c = startIdx;
    const hHashes = '#'.repeat(depth);
    const subHashes = '#'.repeat(depth + 1);

    if (block.type === 'paragraph') {
      const line = nonFenced[c]?.text;
      if (!isStandaloneMdParagraphRow(nonFenced[c]) || !matchesInline(line, block.info)) {
        return -1;
      }
      return c + 1;
    }

    if (block.type === 'list') {
      for (let i = 0; i < block.items.length; i += 1) {
        const prefix = block.ordered ? `${i + 1}${alternate ? ')' : '.'} ` : `${alternate ? '+' : '-'} `;
        const line = nonFenced[c + i]?.text;
        if (!line || !line.startsWith(prefix) || !matchesInline(line.slice(prefix.length), block.items[i])) return -1;
      }
      return c + block.items.length;
    }

    if (block.type === 'metrics') {
      const prefix = `${alternate ? '+' : '-'} `;
      for (let i = 0; i < block.items.length; i += 1) {
        const mItem = block.items[i];
        const line = nonFenced[c + i]?.text;
        if (!line || !line.startsWith(prefix)) return -1;
        const bodyMd = line.slice(prefix.length);
        const dec = decodeGeneratedMdInline(bodyMd, seenLabels);
        if (!dec || dec.hrefs.length !== 0 || !sameArr(dec.cites, mItem.cites) || dec.text !== mItem.expectedText) return -1;
        const lead = splitLeadingGeneratedStrongMd(bodyMd, seenLabels);
        if (!lead || lead.leadWs !== '' || !lead.coreText.endsWith(':') || !lead.restRaw.startsWith(' ')) return -1;
        const mdLabel = normalizeInlineText(lead.coreText.slice(0, -1));
        if (mdLabel !== mItem.label || STANDALONE_CALLOUT_STRONG_RE.test(normCalloutLabel(mdLabel))) return -1;
        const afterLabelRaw = lead.restRaw.slice(1);
        calloutTailByLineIdx.set(c + i, afterLabelRaw);
        let valUnitRaw = afterLabelRaw;
        if (mItem.cites.length > 0) {
          const citeSuffix = ` (${mItem.cites.join(', ')})`;
          if (!afterLabelRaw.endsWith(citeSuffix)) return -1;
          valUnitRaw = afterLabelRaw.slice(0, -citeSuffix.length);
        }
        if (hasStandaloneMdCalloutInLine(valUnitRaw, seenLabels)) return -1;
        const valUnitProse = decodeGeneratedMdProse(valUnitRaw, seenLabels);
        if (valUnitProse === null
          || normalizeInlineText(`${mdLabel}: ${valUnitProse}${mItem.cites.length > 0 ? ` (${mItem.cites.join(', ')})` : ''}`) !== mItem.expectedText) {
          return -1;
        }
      }
      return c + block.items.length;
    }

    if (block.type === 'code' || block.type === 'diff') {
      const headPrefix = `${hHashes} ${block.type === 'diff' ? 'Diff' : 'Code'}: `;
      const hLine = nonFenced[c]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.title
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== '') {
        return -1;
      }
      c += 4;
      if (block.capInfo !== null) {
        if (!isStandaloneMdParagraphRow(nonFenced[c]) || !matchesInline(nonFenced[c]?.text, block.capInfo) || nonFenced[c + 1]?.text !== '') return -1;
        c += 2;
      }
      const fRow = nonFenced[c];
      if (!fRow?.isFence || fRow.fenceLang !== block.fenceLang || !sameArr(fRow.fenceLines, block.lines)) return -1;
      return c + 1;
    }

    if (block.type === 'finding') {
      const headPrefix = `${hHashes} Finding ${block.id}: `;
      const hLine = nonFenced[c]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.title
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== '') {
        return -1;
      }
      c += 4;
      if (nonFenced[c]?.text !== `**Severity.** ${block.sevLabel}  `
        || nonFenced[c + 1]?.text !== `**Confidence.** ${block.confLabel}  `) {
        return -1;
      }
      c += 2;
      if (block.verif !== null) {
        const vLine = nonFenced[c]?.text ?? '';
        if (!vLine.startsWith('**Verification.** ') || !vLine.endsWith('  ')
          || decodeGeneratedMdProse(vLine.slice('**Verification.** '.length, -2), seenLabels) !== block.verif.mdExpected) {
          return -1;
        }
        c += 1;
      }
      const clLine = nonFenced[c]?.text ?? '';
      if (!clLine.startsWith('**Claim.** ') || !clLine.endsWith('  ')
        || !matchesInline(clLine.slice('**Claim.** '.length, -2), block.claimInfo)
        || nonFenced[c + 1]?.text !== `**Evidence.** ${block.evLabels.join(', ')}`) {
        return -1;
      }
      c += 2;
      if (block.detailBlocks.length > 0) {
        if (nonFenced[c]?.text !== '') return -1;
        return verifyBlockSeq(block.detailBlocks, c + 1, depth + 1, null);
      }
      return c;
    }

    if (block.type === 'risk') {
      const headPrefix = `${hHashes} Risk ${block.id}: `;
      const hLine = nonFenced[c]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.title
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== ''
        || nonFenced[c + 4]?.text !== `**Likelihood.** ${block.likelihood}  `
        || nonFenced[c + 5]?.text !== `**Impact.** ${block.impact}  `) {
        return -1;
      }
      const mitLine = nonFenced[c + 6]?.text ?? '';
      if (!mitLine.startsWith('**Mitigation.** ') || !matchesInline(mitLine.slice('**Mitigation.** '.length), block.mitInfo)) {
        return -1;
      }
      return c + 7;
    }

    if (block.type === 'requirement') {
      const headPrefix = `${hHashes} Requirement ${block.id}: `;
      const hLine = nonFenced[c]?.text ?? '';
      const vLine = nonFenced[c + 5]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.title
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== ''
        || nonFenced[c + 4]?.text !== `**Pattern.** ${block.earsLabel}  `
        || !vLine.startsWith('**Verification.** ') || !vLine.endsWith('  ')
        || decodeGeneratedMdProse(vLine.slice('**Verification.** '.length, -2), seenLabels) !== block.verif.mdExpected) {
        return -1;
      }
      c += 6;
      const spLine = nonFenced[c]?.text ?? '';
      if (!spLine.startsWith('**Specification.** ')) return -1;
      if (block.evLabels !== null) {
        if (!spLine.endsWith('  ') || !matchesInline(spLine.slice('**Specification.** '.length, -2), block.specInfo)
          || nonFenced[c + 1]?.text !== `**Evidence.** ${block.evLabels.join(', ')}`) {
          return -1;
        }
        c += 2;
      } else {
        if (!matchesInline(spLine.slice('**Specification.** '.length), block.specInfo)) return -1;
        c += 1;
      }
      if (block.scenarios.length > 0) {
        if (nonFenced[c]?.text !== ''
          || nonFenced[c + 1]?.text !== '| Scenario | Given | When | Then |'
          || nonFenced[c + 2]?.text !== '| --- | --- | --- | --- |') {
          return -1;
        }
        c += 3;
        for (const sc of block.scenarios) {
          const cells = splitGfmTableRow(nonFenced[c]?.text);
          if (!cells || cells.length !== 4
            || decodeGfmTableProseCell(cells[0]) !== sc.name
            || decodeGfmTableProseCell(cells[1]) !== sc.given
            || decodeGfmTableProseCell(cells[2]) !== sc.when
            || decodeGfmTableProseCell(cells[3]) !== sc.then) {
            return -1;
          }
          c += 1;
        }
      }
      return c;
    }

    if (block.type === 'comparison') {
      const headPrefix = `${hHashes} Comparison: `;
      const hLine = nonFenced[c]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.title
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== '') {
        return -1;
      }
      c += 4;
      if (block.capInfo !== null) {
        if (!isStandaloneMdParagraphRow(nonFenced[c]) || !matchesInline(nonFenced[c]?.text, block.capInfo) || nonFenced[c + 1]?.text !== '') return -1;
        c += 2;
      }
      for (let si = 0; si < 2; si += 1) {
        if (si === 1) {
          if (nonFenced[c]?.text !== '') return -1;
          c += 1;
        }
        const side = block.sides[si];
        const sHead = nonFenced[c]?.text ?? '';
        const sPrefix = `${subHashes} `;
        if (!sHead.startsWith(sPrefix) || decodeGeneratedMdProse(sHead.slice(sPrefix.length), seenLabels) !== side.label
          || nonFenced[c + 1]?.text !== '' || !isStandaloneMdParagraphRow(nonFenced[c + 2]) || !matchesInline(nonFenced[c + 2]?.text, side.summaryInfo)) {
          return -1;
        }
        c += 3;
        if (side.items !== null) {
          if (nonFenced[c]?.text !== '') return -1;
          c += 1;
          for (const itInfo of side.items) {
            const itLine = nonFenced[c]?.text ?? '';
            if (!itLine.startsWith('- ') || !matchesInline(itLine.slice(2), itInfo)) return -1;
            c += 1;
          }
        }
        if (side.code !== null) {
          if (nonFenced[c]?.text !== '') return -1;
          c += 1;
          const fRow = nonFenced[c];
          if (!fRow?.isFence || fRow.fenceLang !== side.code.fenceLang || !sameArr(fRow.fenceLines, side.code.lines)) return -1;
          c += 1;
        }
      }
      if (block.evLabels !== null) {
        if (nonFenced[c]?.text !== '' || nonFenced[c + 1]?.text !== `**Evidence.** ${block.evLabels.join(', ')}`) return -1;
        c += 2;
      }
      return c;
    }

    if (block.type === 'table') {
      const headPrefix = `${hHashes} Table: `;
      const hLine = nonFenced[c]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.caption
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== '') {
        return -1;
      }
      c += 4;
      const headCells = splitGfmTableRow(nonFenced[c]?.text);
      const expDiv = `| ${block.columns.map((col) => (col.numeric ? '---:' : '---')).join(' | ')} |`;
      if (!headCells || headCells.length !== block.columns.length
        || headCells.some((hc, ci) => decodeGfmTableProseCell(hc) !== block.columns[ci].label)
        || nonFenced[c + 1]?.text !== expDiv) {
        return -1;
      }
      c += 2;
      for (const row of block.rows) {
        const rCells = splitGfmTableRow(nonFenced[c]?.text);
        if (!rCells || rCells.length !== block.columns.length) return -1;
        for (let ci = 0; ci < rCells.length; ci += 1) {
          if (!matchesInline(rCells[ci], row[ci], { isTableCell: true })) return -1;
        }
        c += 1;
      }
      return c;
    }

    if (block.type === 'chart') {
      const headPrefix = `${hHashes} Chart: `;
      const hLine = nonFenced[c]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.title
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== '' || !isStandaloneMdParagraphRow(nonFenced[c + 4]) || nonFenced[c + 5]?.text !== '') {
        return -1;
      }
      let capRem = nonFenced[c + 4]?.text ?? '';
      if (block.evLabels !== null) {
        const evSfx = ` Evidence: ${block.evLabels.join(', ')}.`;
        if (!capRem.endsWith(evSfx)) return -1;
        capRem = capRem.slice(0, -evSfx.length);
      }
      if (block.kind === 'quantiles' && block.hasBudget) {
        let matchedBudget = false;
        let searchEnd = capRem.length;
        while (searchEnd > 0) {
          const bIdx = capRem.lastIndexOf(' Budget: ', searchEnd - 1);
          if (bIdx < 0) break;
          const bm = /^ Budget: (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) ([\s\S]+)\.$/i.exec(capRem.slice(bIdx));
          if (bm && isCanonicalChartNumStr(bm[1])
            && decodeGeneratedMdProse(bm[2], seenLabels) === block.unit
            && clampSvgLabelText(`SLA ${formatChartNumLocal(Number(bm[1]))} ${block.unit}`, 260, 10, true) === block.budgetSvgLabel
            && block.verifyWithBudget(Number(bm[1]))
            && matchesInline(capRem.slice(0, bIdx), block.capInfo)) {
            matchedBudget = true;
            break;
          }
          searchEnd = bIdx;
        }
        if (!matchedBudget) return -1;
      } else if (!matchesInline(capRem, block.capInfo)) {
        return -1;
      }
      c += 6;
      if (block.kind === 'bar') {
        if (nonFenced[c]?.text !== '| Series | Value |' || nonFenced[c + 1]?.text !== '| --- | ---: |') return -1;
        c += 2;
        for (const pt of block.series) {
          const cells = splitGfmTableRow(nonFenced[c]?.text);
          if (!cells || cells.length !== 2
            || decodeGfmTableProseCell(cells[0]) !== pt.label
            || !checkValUnitCellMd(cells[1], pt.valueStr, block.unit)) {
            return -1;
          }
          c += 1;
        }
        return c;
      }
      if (block.kind === 'comparison') {
        const hCells = splitGfmTableRow(nonFenced[c]?.text);
        if (!hCells || hCells.length !== 3 || hCells[0] !== 'Series'
          || decodeGfmTableProseCell(hCells[1]) !== block.baselineLabel
          || decodeGfmTableProseCell(hCells[2]) !== block.candidateLabel
          || nonFenced[c + 1]?.text !== '| --- | ---: | ---: |') {
          return -1;
        }
        c += 2;
        for (const pt of block.series) {
          const cells = splitGfmTableRow(nonFenced[c]?.text);
          if (!cells || cells.length !== 3
            || decodeGfmTableProseCell(cells[0]) !== pt.label
            || !checkValUnitCellMd(cells[1], pt.baseStr, block.unit)
            || !checkValUnitCellMd(cells[2], pt.valStr, block.unit)) {
            return -1;
          }
          c += 1;
        }
        return c;
      }
      if (nonFenced[c]?.text !== '| Series | p50 | p95 | p99 |'
        || nonFenced[c + 1]?.text !== '| --- | ---: | ---: | ---: |') {
        return -1;
      }
      c += 2;
      for (const pt of block.series) {
        const cells = splitGfmTableRow(nonFenced[c]?.text);
        if (!cells || cells.length !== 4
          || decodeGfmTableProseCell(cells[0]) !== pt.label
          || !checkValUnitCellMd(cells[1], pt.p50Str, block.unit)
          || !checkValUnitCellMd(cells[2], pt.p95Str, block.unit)
          || !checkValUnitCellMd(cells[3], pt.p99Str, block.unit)) {
          return -1;
        }
        c += 1;
      }
      return c;
    }

    if (block.type === 'diagram') {
      const headPrefix = `${hHashes} Diagram: `;
      const hLine = nonFenced[c]?.text ?? '';
      if (!hLine.startsWith(headPrefix) || decodeGeneratedMdProse(hLine.slice(headPrefix.length), seenLabels) !== block.title
        || nonFenced[c + 1]?.text !== '' || nonFenced[c + 2]?.text !== `[${block.anchor}]: #${block.anchor}`
        || nonFenced[c + 3]?.text !== '' || !isStandaloneMdParagraphRow(nonFenced[c + 4]) || nonFenced[c + 5]?.text !== '') {
        return -1;
      }
      let capRem = nonFenced[c + 4]?.text ?? '';
      if (block.evLabels !== null) {
        const evSfx = ` Evidence: ${block.evLabels.join(', ')}.`;
        if (!capRem.endsWith(evSfx)) return -1;
        capRem = capRem.slice(0, -evSfx.length);
      }
      if (!matchesInline(capRem, block.capInfo)) return -1;
      c += 6;
      if (block.kind === 'topology') {
        for (const grp of block.groups) {
          const gLine = nonFenced[c]?.text ?? '';
          if (!gLine.startsWith('- ')) return -1;
          const gBody = gLine.slice(2);
          const dec = decodeGeneratedMdInline(gBody, seenLabels);
          if (!dec || dec.hrefs.length !== 0 || dec.cites.length !== 0 || dec.text !== grp.expectedText) return -1;
          const lead = splitLeadingGeneratedStrongMd(gBody, seenLabels);
          if (!lead || lead.leadWs !== '' || !lead.coreText.endsWith(':') || !lead.restRaw.startsWith(' ')) return -1;
          const mdGrpLabel = normalizeInlineText(lead.coreText.slice(0, -1));
          if (mdGrpLabel !== grp.label || STANDALONE_CALLOUT_STRONG_RE.test(normCalloutLabel(mdGrpLabel))) return -1;
          const nodesRaw = lead.restRaw.slice(1);
          calloutTailByLineIdx.set(c, nodesRaw);
          if (hasStandaloneMdCalloutInLine(nodesRaw, seenLabels)) return -1;
          const nodesProse = decodeGeneratedMdProse(nodesRaw, seenLabels);
          if (nodesProse === null || normalizeInlineText(`${mdGrpLabel}: ${nodesProse}`) !== grp.expectedText) return -1;
          c += 1;
        }
        if (nonFenced[c]?.text !== '') return -1;
        c += 1;
        for (let ei = 0; ei < block.edges.length; ei += 1) {
          const edge = block.edges[ei];
          const ePrefix = `${ei + 1}. `;
          const eLine = nonFenced[c]?.text ?? '';
          if (!eLine.startsWith(ePrefix)) return -1;
          const eBody = eLine.slice(ePrefix.length);
          const dec = decodeGeneratedMdInline(eBody, seenLabels);
          if (!dec || dec.hrefs.length !== 0 || dec.cites.length !== 0 || dec.text !== edge.expectedText) return -1;
          const expectedPair = `${edge.fromLbl} -> ${edge.toLbl}`;
          const expLead = expectedPair.slice(0, expectedPair.length - expectedPair.trimStart().length);
          const expTrail = expectedPair.slice(expectedPair.trimEnd().length);
          const lead = splitLeadingGeneratedStrongMd(eBody, seenLabels);
          if (!lead || lead.leadWs !== expLead || lead.coreText !== expectedPair.trim() || !lead.restRaw.startsWith(expTrail)) {
            return -1;
          }
          const normPair = normCalloutLabel(expectedPair);
          if (STANDALONE_CALLOUT_STRONG_RE.test(normPair) || CALLOUT_BARE_LABEL_RE.test(normPair)) return -1;
          let afterPair = lead.restRaw.slice(expTrail.length);
          if (edge.gate) {
            if (!afterPair.startsWith(' (Gate)')) return -1;
            afterPair = afterPair.slice(' (Gate)'.length);
          }
          if (edge.edgeLabel !== null) {
            if (!afterPair.startsWith(' — ')) return -1;
            const edgeLblRaw = afterPair.slice(3);
            if (hasStandaloneMdCalloutInLine(edgeLblRaw, seenLabels) || decodeGeneratedMdProse(edgeLblRaw, seenLabels) !== edge.edgeLabel) {
              return -1;
            }
          } else if (afterPair !== '') {
            return -1;
          }
          c += 1;
        }
        return c;
      }
      if (block.kind === 'sequence') {
        const parsedMsgs = [];
        for (let mi = 0; mi < block.messages.length; mi += 1) {
          const mPrefix = `${mi + 1}. `;
          const mLine = nonFenced[c]?.text ?? '';
          if (!mLine.startsWith(mPrefix)) return -1;
          const mBody = mLine.slice(mPrefix.length);
          const dec = decodeGeneratedMdInline(mBody, seenLabels);
          if (!dec || dec.hrefs.length !== 0 || dec.cites.length !== 0) return -1;
          const lead = splitLeadingGeneratedStrongMd(mBody, seenLabels);
          if (!lead || !lead.coreText.includes(' -> ')) return -1;
          const normPair = normCalloutLabel(`${lead.leadWs}${lead.coreText}`);
          if (STANDALONE_CALLOUT_STRONG_RE.test(normPair) || CALLOUT_BARE_LABEL_RE.test(normPair)) return -1;
          parsedMsgs.push({ dec, lead });
          c += 1;
        }
        const seqOk = block.expectedMsgSeqCandidates.some((candSeq) => candSeq.every((cand, mi) => {
          const msg = block.messages[mi];
          const { dec, lead } = parsedMsgs[mi];
          if (dec.text !== cand.expectedText) return false;
          const expLead = cand.pairText.slice(0, cand.pairText.length - cand.pairText.trimStart().length);
          const expTrail = cand.pairText.slice(cand.pairText.trimEnd().length);
          const expMid = `${msg.gate ? ' (Gate)' : ''}: `;
          const expCode = mdInlineCode(msg.codeLabel);
          if (lead.leadWs !== expLead || lead.coreText !== cand.pairText.trim()
            || !lead.restRaw.startsWith(`${expTrail}${expMid}${expCode}`)) {
            return false;
          }
          const remAfterCode = lead.restRaw.slice(expTrail.length + expMid.length + expCode.length);
          if (msg.hasNote) {
            if (!remAfterCode.startsWith(' — ')) return false;
            const noteRaw = remAfterCode.slice(3);
            return !hasStandaloneMdCalloutInLine(noteRaw, seenLabels)
              && decodeGeneratedMdProse(noteRaw, seenLabels) === msg.note;
          }
          return remAfterCode === '';
        }));
        if (!seqOk) return -1;
        return c;
      }
      for (let si = 0; si < block.steps.length; si += 1) {
        const step = block.steps[si];
        const sPrefix = `${si + 1}. `;
        const sLine = nonFenced[c]?.text ?? '';
        if (!sLine.startsWith(sPrefix)) return -1;
        const sBody = sLine.slice(sPrefix.length);
        const dec = decodeGeneratedMdInline(sBody, seenLabels);
        if (!dec || dec.hrefs.length !== 0 || dec.cites.length !== 0 || dec.text !== step.expectedText) return -1;
        const expLead = step.rawLabel.slice(0, step.rawLabel.length - step.rawLabel.trimStart().length);
        const expTrail = step.rawLabel.slice(step.rawLabel.trimEnd().length);
        const expMid = `${step.gate ? ' (Gate)' : ''} — `;
        const lead = splitLeadingGeneratedStrongMd(sBody, seenLabels);
        if (!lead || lead.leadWs !== expLead || lead.coreText !== step.rawLabel.trim()
          || STANDALONE_CALLOUT_STRONG_RE.test(normCalloutLabel(step.label))
          || !lead.restRaw.startsWith(`${expTrail}${expMid}`)) {
          return -1;
        }
        const detailRaw = lead.restRaw.slice(expTrail.length + expMid.length);
        calloutTailByLineIdx.set(c, detailRaw);
        if (hasStandaloneMdCalloutInLine(detailRaw, seenLabels)) return -1;
        const detailProse = decodeGeneratedMdProse(detailRaw, seenLabels);
        if (detailProse === null || normalizeInlineText(detailProse) !== normalizeInlineText(step.rawDetail)) return -1;
        c += 1;
      }
      return c;
    }

    return -1;
  };

  if (itemMeta.blocks.length > 0) {
    if (nonFenced[cur]?.text !== '') {
      findings.add('reading-order', mdPath, 'missing blank line before item blocks in Markdown');
      return false;
    }
    const afterBlocks = verifyBlockSeq(itemMeta.blocks, cur + 1, 3, '-');
    if (afterBlocks < 0) {
      for (let idx = h2Row.idx + 6; idx < itemEndIdx; idx += 1) {
        const sliceToCheck = calloutTailByLineIdx.has(idx) ? calloutTailByLineIdx.get(idx) : nonFenced[idx].text;
        if (hasStandaloneMdCalloutInLine(sliceToCheck, seenLabels, Boolean(nonFenced[idx]?.inGfmTable))) {
          findings.add('reading-order', mdPath, 'decision/verdict callout label appears inside ## Item section in Markdown');
          return false;
        }
      }
      findings.add('reading-order', mdPath, 'item section blocks in Markdown disagree with HTML or canonical block grammar');
      return false;
    }
    cur = afterBlocks;
  }

  if (nonFenced[cur]?.text !== '' || cur + 1 !== itemEndIdx) {
    findings.add('reading-order', mdPath, 'unexpected extra or trailing content inside ## Item section in Markdown');
    return false;
  }

  for (let idx = h2Row.idx + 6; idx < itemEndIdx; idx += 1) {
    const sliceToCheck = calloutTailByLineIdx.has(idx) ? calloutTailByLineIdx.get(idx) : nonFenced[idx].text;
    if (hasStandaloneMdCalloutInLine(sliceToCheck, seenLabels, Boolean(nonFenced[idx]?.inGfmTable))) {
      findings.add('reading-order', mdPath, 'decision/verdict callout label appears inside ## Item section in Markdown');
      return false;
    }
  }
  return true;
}

function parsePriorEditionBulletMd(line, seenLabels) {
  if (typeof line !== 'string' || !line.startsWith('- [')) return null;
  let closeIdx = -1;
  let pos = 3;
  while (pos < line.length) {
    if (line[pos] === '\\' && pos + 1 < line.length) { pos += 2; continue; }
    if (line[pos] === '`') {
      let run = 0;
      while (line[pos + run] === '`') run += 1;
      const closeCode = findBacktickRun(line, pos + run, run);
      if (closeCode < 0) return null;
      pos = closeCode + run;
      continue;
    }
    if (line[pos] === ']' && line[pos + 1] === '(') {
      closeIdx = pos;
      break;
    }
    pos += 1;
  }
  if (closeIdx < 0) return null;
  const editionId = decodeGeneratedMdLinkLabel(line.slice(3, closeIdx), seenLabels);
  const rest = line.slice(closeIdx + 2);
  const m = /^\.\.\/(sha256-[0-9a-f]{64})\/index\.md\) — observed (.+) \(`(sha256-[0-9a-f]{64})`\)$/.exec(rest);
  if (!m || m[1] !== m[3] || !editionId || !editionId.trim() || /[\r\n\t]/.test(editionId)) return null;
  const observedAt = decodeGeneratedMdProse(m[2], seenLabels);
  if (!observedAt || !observedAt.trim() || /[\r\n\t]/.test(observedAt)) return null;
  return { editionId, observedAt, contentId: m[1] };
}

function verifyMdTailSections(h2Rows, tailStartPos, firstCiteIdx, nonFenced, seenLabels, page, manifest, mdPath, findings, parityState) {
  const ownedGapAnchors = (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
    .filter((a) => a.page === page.id && a.kind === 'gap')
    .map((a) => a.anchor);
  const ownedEvAnchors = (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
    .filter((a) => a.page === page.id && a.kind === 'evidence')
    .map((a) => a.anchor);
  let pos = tailStartPos;

  if (page.id === '') {
    if (h2Rows[pos]?.text === '## Prior editions') {
      const hiStart = h2Rows[pos].idx + 1;
      const hiEnd = h2Rows[pos + 1]?.idx ?? firstCiteIdx;
      const slice = nonFenced.slice(hiStart, hiEnd).map((r) => r.text);
      while (slice.length > 0 && slice[0] === '') slice.shift();
      while (slice.length > 0 && slice[slice.length - 1] === '') slice.pop();
      if (slice.length === 0 || slice.includes('\u0000FENCE\u0000')) {
        findings.add('reading-order', mdPath, 'empty or fenced ## Prior editions section in Markdown');
        return false;
      }
      const priorRows = [];
      for (const line of slice) {
        const parsed = parsePriorEditionBulletMd(line, seenLabels);
        if (!parsed) {
          findings.add('reading-order', mdPath, 'malformed bullet inside ## Prior editions section in Markdown');
          return false;
        }
        priorRows.push(parsed);
      }
      if (parityState) parityState.portfolioMdPriorEditions = priorRows;
      pos += 1;
    } else if (parityState) {
      parityState.portfolioMdPriorEditions = [];
    }
  }

  if (ownedGapAnchors.length > 0) {
    if (h2Rows[pos]?.text !== '## Explicit gaps') {
      findings.add('reading-order', mdPath, 'missing or misordered ## Explicit gaps section in Markdown');
      return false;
    }
    const gpStart = h2Rows[pos].idx + 1;
    const gpEnd = h2Rows[pos + 1]?.idx ?? firstCiteIdx;
    if (nonFenced[gpStart]?.text !== '') {
      findings.add('reading-order', mdPath, 'missing blank line after ## Explicit gaps in Markdown');
      return false;
    }
    const mdGaps = [];
    let cur = gpStart + 1;
    for (let gi = 0; gi < ownedGapAnchors.length; gi += 1) {
      const ga = ownedGapAnchors[gi];
      const gapRef = ga.slice(2);
      const nextGa = gi + 1 < ownedGapAnchors.length ? ownedGapAnchors[gi + 1] : null;
      const headLine = nonFenced[cur]?.text ?? '';
      const gapHeadM = new RegExp(`^### Gap ${gapRef} \\(([a-z][a-z0-9-]{0,39})\\)$`).exec(headLine);
      if (!gapHeadM
        || nonFenced[cur + 1]?.text !== ''
        || nonFenced[cur + 2]?.text !== `[${ga}]: #${ga}`
        || nonFenced[cur + 3]?.text !== '') {
        findings.add('reading-order', mdPath, `malformed ### Gap ${gapRef} header or anchor in Markdown`);
        return false;
      }
      cur += 4;
      let textEnd = gpEnd;
      if (nextGa) {
        const nextHeadPrefix = `### Gap ${nextGa.slice(2)} (`;
        const foundNext = nonFenced.findIndex((r, idx) => idx >= cur && idx < gpEnd && r.text.startsWith(nextHeadPrefix));
        if (foundNext < 0) {
          findings.add('reading-order', mdPath, `missing ### Gap ${nextGa.slice(2)} heading in Markdown`);
          return false;
        }
        textEnd = foundNext;
      }
      const rawBodyRows = nonFenced.slice(cur, textEnd);
      while (rawBodyRows.length > 0 && rawBodyRows[rawBodyRows.length - 1].text === '') rawBodyRows.pop();
      const decGapText = rawBodyRows.length === 1 && isStandaloneMdParagraphRow(rawBodyRows[0])
        ? decodeGeneratedMdProse(rawBodyRows[0].text, seenLabels)
        : null;
      if (!decGapText || !decGapText.trim() || /[\r\n\t]/.test(decGapText)) {
        findings.add('reading-order', mdPath, `malformed body inside ### Gap ${gapRef} in Markdown`);
        return false;
      }
      mdGaps.push({ gapRef, kind: gapHeadM[1], text: decGapText });
      cur = textEnd;
    }
    if (cur !== gpEnd) {
      findings.add('reading-order', mdPath, 'unexpected trailing content inside ## Explicit gaps in Markdown');
      return false;
    }
    if (parityState) parityState.mdGapsByPage.set(page.id, mdGaps);
    pos += 1;
  } else if (parityState) {
    parityState.mdGapsByPage.set(page.id, []);
  }

  if (ownedEvAnchors.length > 0) {
    if (h2Rows[pos]?.text !== '## Evidence') {
      findings.add('reading-order', mdPath, 'missing or misordered ## Evidence section in Markdown');
      return false;
    }
    const evStart = h2Rows[pos].idx + 1;
    const evEnd = h2Rows[pos + 1]?.idx ?? firstCiteIdx;
    if (nonFenced[evStart]?.text !== '') {
      findings.add('reading-order', mdPath, 'missing blank line after ## Evidence in Markdown');
      return false;
    }
    const evById = new Map((Array.isArray(manifest?.evidence) ? manifest.evidence : []).map((e) => [e.id, e]));
    const fileByPath = new Map((Array.isArray(manifest?.files) ? manifest.files : []).map((f) => [f.path, f]));
    const mdEvs = [];
    let cur = evStart + 1;
    for (let ei = 0; ei < ownedEvAnchors.length; ei += 1) {
      const ea = ownedEvAnchors[ei];
      const evId = ea.slice(3);
      const evRel = evById.get(evId);
      const nextEa = ei + 1 < ownedEvAnchors.length ? ownedEvAnchors[ei + 1] : null;
      const nextEvRel = nextEa ? evById.get(nextEa.slice(3)) : null;
      const hPrefix = evRel ? `### ${evRel.label}: ` : null;
      const hLine = nonFenced[cur]?.text ?? '';
      const hTitle = hPrefix && hLine.startsWith(hPrefix) ? decodeGeneratedMdProse(hLine.slice(hPrefix.length), seenLabels) : null;
      if (!evRel || !hTitle || !hTitle.trim() || /[\r\n\t]/.test(hTitle)
        || nonFenced[cur + 1]?.text !== ''
        || nonFenced[cur + 2]?.text !== `[${ea}]: #${ea}`
        || nonFenced[cur + 3]?.text !== '') {
        findings.add('reading-order', mdPath, `malformed ### Evidence header for ${evId} in Markdown`);
        return false;
      }
      cur += 4;
      let itemEnd = evEnd;
      if (nextEvRel) {
        const nextPrefix = `### ${nextEvRel.label}: `;
        const foundNext = nonFenced.findIndex((r, idx) => idx >= cur && idx < evEnd && r.text.startsWith(nextPrefix));
        if (foundNext < 0) {
          findings.add('reading-order', mdPath, `missing ### ${nextEvRel.label} heading in Markdown`);
          return false;
        }
        itemEnd = foundNext;
      }
      if (evRel.kind === 'file') {
        const fileMeta = fileByPath.get(evRel.path);
        const fileOk = Boolean(fileMeta)
          && nonFenced[cur]?.text === `- ID: ${mdInlineCode(evId)}`
          && nonFenced[cur + 1]?.text === `- File: ${mdInlineCode(evRel.path)}`
          && nonFenced[cur + 2]?.text === `- Media type: ${mdInlineCode(evRel.mediaType)}`
          && nonFenced[cur + 3]?.text === `- Bytes: ${fileMeta.bytes}`
          && nonFenced[cur + 4]?.text === `- SHA-256: ${mdInlineCode(evRel.sha256)}`;
        if (!fileOk) {
          findings.add('reading-order', mdPath, `malformed file metadata for ${evId} inside ## Evidence in Markdown`);
          return false;
        }
        cur += 5;
        while (cur < itemEnd && nonFenced[cur].text === '') cur += 1;
        if (cur !== itemEnd) {
          findings.add('reading-order', mdPath, `unexpected extra content after file metadata for ${evId} inside ## Evidence in Markdown`);
          return false;
        }
        mdEvs.push({ id: evId, label: evRel.label, title: hTitle, kind: 'file', bytes: fileMeta.bytes, reason: null });
      } else {
        if (nonFenced[cur]?.text !== `- ID: ${mdInlineCode(evId)}`
          || nonFenced[cur + 1]?.text !== `- Status: ${evRel.kind}`
          || !(nonFenced[cur + 2]?.text ?? '').startsWith('- Reason: ')) {
          findings.add('reading-order', mdPath, `malformed withheld metadata for ${evId} inside ## Evidence in Markdown`);
          return false;
        }
        const reasonLines = [nonFenced[cur + 2].text.slice('- Reason: '.length), ...nonFenced.slice(cur + 3, itemEnd).map((r) => r.text)];
        while (reasonLines.length > 1 && reasonLines[reasonLines.length - 1] === '') reasonLines.pop();
        const decReason = reasonLines.length === 1 && reasonLines[0] !== '\u0000FENCE\u0000'
          ? decodeGeneratedMdProse(reasonLines[0], seenLabels)
          : null;
        if (!decReason || !decReason.trim() || /[\r\n\t]/.test(decReason)) {
          findings.add('reading-order', mdPath, `malformed withheld reason for ${evId} inside ## Evidence in Markdown`);
          return false;
        }
        mdEvs.push({ id: evId, label: evRel.label, title: hTitle, kind: evRel.kind, bytes: null, reason: decReason });
        cur = itemEnd;
      }
    }
    if (cur !== evEnd) {
      findings.add('reading-order', mdPath, 'unexpected trailing content inside ## Evidence in Markdown');
      return false;
    }
    if (parityState) parityState.mdEvByPage.set(page.id, mdEvs);
    pos += 1;
  } else if (parityState) {
    parityState.mdEvByPage.set(page.id, []);
  }

  if (pos !== h2Rows.length) {
    findings.add('reading-order', mdPath, `unexpected top-level section sequence ${JSON.stringify(h2Rows.map((h) => h.text))} in Markdown`);
    return false;
  }
  return true;
}

function parsePortfolioOpenDecisionBullet(line, d, seenLabels) {
  if (typeof line !== 'string' || !line.startsWith('- [')) return null;
  let closeIdx = -1;
  let pos = 3;
  while (pos < line.length) {
    if (line[pos] === '\\' && pos + 1 < line.length) {
      pos += 2;
      continue;
    }
    if (line[pos] === '`') {
      let run = 0;
      while (line[pos + run] === '`') run += 1;
      const closeCode = findBacktickRun(line, pos + run, run);
      if (closeCode < 0) return null;
      pos = closeCode + run;
      continue;
    }
    if (line[pos] === ']' && line[pos + 1] === '(') {
      closeIdx = pos;
      break;
    }
    pos += 1;
  }
  if (closeIdx < 0) return null;
  const labelMd = line.slice(3, closeIdx);
  const expectedMid = `](${d.page}/index.md#${d.anchor}) (${mdInlineCode(d.decisionRef)}, `;
  if (!line.slice(closeIdx).startsWith(expectedMid) || !line.endsWith(')')) return null;
  const kindMd = line.slice(closeIdx + expectedMid.length, -1);
  const decodedLabel = decodeGeneratedMdLinkLabel(labelMd, seenLabels);
  const decodedKind = decodeGeneratedMdProse(kindMd, seenLabels);
  if (decodedLabel === null || decodedLabel.trim().length === 0 || decodedLabel.length > 200 || decodedKind !== d.kind) {
    return null;
  }
  return decodedLabel;
}

function checkPageDecisionsMd(parsedMd, page, manifest, pageDecisions, findings, parityState) {
  const mdPath = page.markdown;
  const siteMeta = manifest?.site;
  const { rawLines, nonFenced, seenLabels, mdProblems, unclosedFence } = parsedMd;
  if (mdProblems.length > 0) {
    findings.add('reading-order', mdPath, mdProblems[0]);
  }
  if (unclosedFence) {
    findings.add('reading-order', mdPath, 'unclosed fenced code block in Markdown');
    return;
  }

  const h2Rows = [];
  const decHeadRows = [];
  for (let idx = 0; idx < nonFenced.length; idx += 1) {
    const t = nonFenced[idx].text;
    if (t !== '\u0000FENCE\u0000' && hasDisallowedMdEntityOutsideCodeAndDest(t, seenLabels, nonFenced[idx].inGfmTable ? 'raw-table' : 'non-table')) {
      findings.add('reading-order', mdPath, 'non-canonical character reference outside code span or link destination in Markdown');
      return;
    }
    if (t.startsWith('## ')) h2Rows.push({ idx, text: t });
    if (t.startsWith('### Decision ')) decHeadRows.push({ idx, text: t });
  }

  // Enforce exact 10-line header preamble before the first ## heading on every SitRep Markdown page.
  const regSuffix = siteMeta?.registry?.sha256 ? ` (${mdInlineCode(siteMeta.registry.sha256)})` : '';
  const headerValid = h2Rows.length >= 1
    && h2Rows[0].idx === 10
    && nonFenced[0].text.startsWith('# ')
    && decodeGeneratedMdProse(nonFenced[0].text.slice(2), seenLabels) === page.title
    && nonFenced[1].text === ''
    && nonFenced[2].text.startsWith('- **Site:** ')
    && decodeGeneratedMdProse(nonFenced[2].text.slice(12), seenLabels) === siteMeta?.title
    && nonFenced[3].text === `- **Edition:** ${mdInlineCode(siteMeta?.edition?.editionId)}`
    && nonFenced[4].text === `- **Edition digest:** ${mdInlineCode(siteMeta?.edition?.editionDigest)}`
    && nonFenced[5].text.startsWith('- **Observed at:** ')
    && decodeGeneratedMdProse(nonFenced[5].text.slice(19), seenLabels) === siteMeta?.edition?.observedAt
    && nonFenced[6].text.startsWith('- **Coverage window:** ')
    && decodeGeneratedMdProse(nonFenced[6].text.slice(23), seenLabels) === `${siteMeta?.edition?.coverage?.from} to ${siteMeta?.edition?.coverage?.to}`
    && nonFenced[7].text.startsWith('- **Registry:** ')
    && regSuffix.length > 0
    && nonFenced[7].text.endsWith(regSuffix)
    && decodeGeneratedMdProse(nonFenced[7].text.slice(16, -regSuffix.length), seenLabels) === siteMeta?.registry?.version
    && nonFenced[8].text === `- **Source digest:** ${mdInlineCode(siteMeta?.sourceSha256)}`
    && nonFenced[9].text === '';
  if (!headerValid) {
    findings.add('reading-order', mdPath, 'unexpected pre-section content or modified metadata header in Markdown');
    return;
  }

  const firstCiteIdxRaw = nonFenced.findIndex((r, i) => i > h2Rows[0].idx && CITE_REF_DEF_RE.test(r.text));
  const firstCiteIdx = firstCiteIdxRaw >= 0 ? firstCiteIdxRaw : nonFenced.length;
  for (let idx = firstCiteIdx; idx < nonFenced.length; idx += 1) {
    if (nonFenced[idx].text !== '' && !CITE_REF_DEF_RE.test(nonFenced[idx].text)) {
      findings.add('reading-order', mdPath, 'unexpected content after citation link definitions in Markdown');
      return;
    }
  }
  const itemMeta = page.id.startsWith('item/') ? (parityState?.itemHtmlBlockMeta.get(page.id) ?? null) : null;

  if (pageDecisions.length === 0) {
    if (h2Rows.some((h) => h.text === '## Decisions') || decHeadRows.length > 0) {
      findings.add('reading-order', mdPath, 'unexpected Decisions heading on page with zero manifest decisions in Markdown');
      return;
    }
    if (page.id.startsWith('item/')) {
      if (!h2Rows[0].text.startsWith('## Item: ')) {
        findings.add('reading-order', mdPath, 'zero-decision item page must start with ## Item: section in Markdown');
        return;
      }
      const itemEndIdx = h2Rows[1]?.idx ?? firstCiteIdx;
      if (!verifyItemSectionMd(nonFenced, h2Rows[0], itemEndIdx, page, manifest, seenLabels, itemMeta, mdPath, findings, parityState)) return;
      for (let idx = itemEndIdx; idx < firstCiteIdx; idx += 1) {
        if (hasStandaloneMdCalloutInLine(nonFenced[idx].text, seenLabels, Boolean(nonFenced[idx]?.inGfmTable))) {
          findings.add('reading-order', mdPath, 'decision/verdict callout label appears on zero-decision item page in Markdown');
          return;
        }
      }
      verifyMdTailSections(h2Rows, 1, firstCiteIdx, nonFenced, seenLabels, page, manifest, mdPath, findings, parityState);
      return;
    }

    for (let idx = h2Rows[0].idx; idx < firstCiteIdx; idx += 1) {
      if (hasStandaloneMdCalloutInLine(nonFenced[idx].text, seenLabels, Boolean(nonFenced[idx]?.inGfmTable))) {
        findings.add('reading-order', mdPath, 'decision/verdict callout label appears on non-decision page in Markdown');
        return;
      }
    }

    if (parityState) {
      const pageById = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((p) => [p.id, p]));
      const mdItemPages = new Set();

      const parseCanonicalItemBulletMd = (line, expectedTargetPrefix) => {
        if (typeof line !== 'string' || !line.startsWith('- [')) return null;
        let closeIdx = -1;
        let pos = 3;
        while (pos < line.length) {
          if (line[pos] === '\\' && pos + 1 < line.length) {
            pos += 2;
            continue;
          }
          if (line[pos] === '`') {
            let run = 0;
            while (line[pos + run] === '`') run += 1;
            const closeCode = findBacktickRun(line, pos + run, run);
            if (closeCode < 0) return null;
            pos = closeCode + run;
            continue;
          }
          if (line[pos] === ']' && line[pos + 1] === '(') {
            closeIdx = pos;
            break;
          }
          pos += 1;
        }
        if (closeIdx < 0) return null;
        const rest = line.slice(closeIdx + 2);
        if (!rest.startsWith(expectedTargetPrefix)) return null;
        const afterPrefix = rest.slice(expectedTargetPrefix.length);
        const m = /^item\/([A-Za-z][A-Za-z0-9-]{0,63})\/index\.md\) \((.+)\)$/.exec(afterPrefix);
        if (!m) return null;
        const itemPage = pageById.get(`item/${m[1]}`);
        if (!itemPage) return null;
        const decodedTitle = decodeGeneratedMdLinkLabel(line.slice(3, closeIdx), seenLabels);
        const decodedAge = decodeGeneratedMdProse(m[2], seenLabels);
        if (decodedTitle !== itemPage.title || decodedAge === null || decodedAge.trim().length === 0 || decodedAge.length > 80) {
          return null;
        }
        parityState.mdItemBulletRefs.push({ mdPath, itemPageId: itemPage.id, decodedAge: decodedAge.trim() });
        return itemPage.id;
      };

      const gapOwnerByAnchor = new Map(
        (Array.isArray(manifest?.anchors) ? manifest.anchors : [])
          .filter((a) => a.kind === 'gap')
          .map((a) => [a.anchor, a.page]),
      );

      const parseAreaCountsBlockMd = (bulletStartIdx) => {
        const wLine = nonFenced[bulletStartIdx]?.text ?? '';
        const mLine = nonFenced[bulletStartIdx + 1]?.text ?? '';
        const bLine = nonFenced[bulletStartIdx + 2]?.text ?? '';
        const cLine = nonFenced[bulletStartIdx + 3]?.text ?? '';
        const uLine = nonFenced[bulletStartIdx + 4]?.text ?? '';
        if (!wLine.startsWith('- **Waiting:** ')
          || !mLine.startsWith('- **Moved:** ')
          || !bLine.startsWith('- **Blocked:** ')
          || !cLine.startsWith('- **Coverage:** ')
          || !uLine.startsWith('- **Unit:** ')) {
          return null;
        }
        const coverage = decodeGeneratedMdProse(cLine.slice('- **Coverage:** '.length), seenLabels);
        if (coverage !== 'complete' && coverage !== 'partial' && coverage !== 'unavailable') return null;
        const parseAreaCountVal = (rawSlice) => {
          const dec = decodeGeneratedMdProse(rawSlice, seenLabels);
          if (dec === 'not recorded') return coverage === 'complete' ? null : { val: null, text: dec };
          if (coverage === 'unavailable') return null;
          if (coverage === 'partial') {
            return dec && /^\d+ \(partial\)$/.test(dec) ? { val: Number.parseInt(dec, 10), text: dec } : null;
          }
          return dec && /^\d+$/.test(dec) ? { val: Number.parseInt(dec, 10), text: dec } : null;
        };
        const wp = parseAreaCountVal(wLine.slice('- **Waiting:** '.length));
        const mp = parseAreaCountVal(mLine.slice('- **Moved:** '.length));
        const bp = parseAreaCountVal(bLine.slice('- **Blocked:** '.length));
        const uDec = decodeGeneratedMdProse(uLine.slice('- **Unit:** '.length), seenLabels);
        if (!wp || !mp || !bp || uDec === null || uDec.trim().length === 0 || uDec.length > 80) return null;
        if (nonFenced[bulletStartIdx + 5]?.text !== '') return null;
        let nextIdx = bulletStartIdx + 6;
        const gapRefs = [];
        if (coverage === 'unavailable' || coverage === 'partial') {
          const covNotice = nonFenced[nextIdx]?.text ?? '';
          const covPrefix = coverage === 'unavailable'
            ? '**Coverage unavailable.** Counts were not recorded for this area (gaps: '
            : '**Partial coverage.** Recorded numbers reflect only partial reading (gaps: ';
          if (!covNotice.startsWith(covPrefix) || !covNotice.endsWith(').') || nonFenced[nextIdx + 1]?.text !== '') {
            return null;
          }
          const rawGapEntries = covNotice.slice(covPrefix.length, -2).split(', ');
          if (rawGapEntries.length === 0) return null;
          for (const gEntry of rawGapEntries) {
            const gm = /^\[([A-Za-z][A-Za-z0-9-]{0,63})\]\(([^()\s]*#g-([A-Za-z][A-Za-z0-9-]{0,63}))\)$/.exec(gEntry);
            if (!gm || gm[1] !== gm[3]) return null;
            const gapRef = gm[1];
            const gAnchor = `g-${gapRef}`;
            const ownerPageId = gapOwnerByAnchor.get(gAnchor);
            const ownerPage = ownerPageId !== undefined ? pageById.get(ownerPageId) : null;
            if (!ownerPage) return null;
            if (ownerPageId === page.id) {
              if (gm[2] !== `#${gAnchor}`) return null;
            } else {
              const hi = gm[2].indexOf('#');
              if (hi <= 0 || gm[2].slice(hi + 1) !== gAnchor) return null;
              const resolvedMd = posix.normalize(posix.join(posix.dirname(mdPath), gm[2].slice(0, hi)));
              if (resolvedMd !== ownerPage.markdown) return null;
            }
            gapRefs.push(gapRef);
          }
          nextIdx += 2;
        }
        return {
          coverage,
          waiting: wp.val,
          moved: mp.val,
          blocked: bp.val,
          waitingText: wp.text,
          movedText: mp.text,
          blockedText: bp.text,
          unitText: uDec.trim(),
          gapRefs,
          nextIdx,
        };
      };

      const sectionEndIdx = h2Rows[1]?.idx ?? firstCiteIdx;

      if (page.id === '') {
        if (h2Rows[0].text !== '## Areas') {
          findings.add('reading-order', mdPath, 'portfolio Markdown must begin with ## Areas section');
          return;
        }
        const expectedAreas = (Array.isArray(manifest?.pages) ? manifest.pages : [])
          .filter((p) => /^area\/[^/]+$/.test(p.id) && p.id !== 'area/unassigned');
        const unassignedPage = pageById.get('area/unassigned') ?? null;
        let cur = h2Rows[0].idx + 1;
        while (cur < sectionEndIdx && nonFenced[cur].text === '') cur += 1;

        for (const ap of expectedAreas) {
          const areaRef = ap.id.slice('area/'.length);
          const expectedSuffix = `](area/${areaRef}/index.md) (${mdInlineCode(areaRef)})`;
          const hLine = nonFenced[cur]?.text ?? '';
          if (!hLine.startsWith('### [') || !hLine.endsWith(expectedSuffix)) {
            findings.add('reading-order', mdPath, `missing or malformed ### area heading for ${ap.id} in index.md`);
            return;
          }
          const titleSlice = hLine.slice(5, hLine.length - expectedSuffix.length);
          if (decodeGeneratedMdLinkLabel(titleSlice, seenLabels) !== ap.title || nonFenced[cur + 1]?.text !== '') {
            findings.add('reading-order', mdPath, `area heading title or spacing mismatch for ${ap.id} in index.md`);
            return;
          }
          const parsedAc = parseAreaCountsBlockMd(cur + 2);
          if (!parsedAc) {
            findings.add('reading-order', mdPath, `missing or malformed area telemetry counts for ${ap.id} in index.md`);
            return;
          }
          parityState.portfolioMdAreaCounts.set(ap.id, parsedAc);
          cur = parsedAc.nextIdx;
          if (cur < sectionEndIdx && nonFenced[cur].text === '- No items in this area.') {
            cur += 1;
          } else {
            let sawAreaItem = false;
            while (cur < sectionEndIdx && nonFenced[cur].text !== '') {
              const itemId = parseCanonicalItemBulletMd(nonFenced[cur].text, '');
              if (!itemId) {
                findings.add('reading-order', mdPath, `malformed or spoofed item entry under ${ap.id} in index.md`);
                return;
              }
              mdItemPages.add(itemId);
              sawAreaItem = true;
              cur += 1;
            }
            if (!sawAreaItem) {
              findings.add('reading-order', mdPath, `missing item entries under ${ap.id} in index.md`);
              return;
            }
          }
          if (cur < sectionEndIdx && nonFenced[cur].text !== '') {
            findings.add('reading-order', mdPath, `unexpected content after item list under ${ap.id} in index.md`);
            return;
          }
          while (cur < sectionEndIdx && nonFenced[cur].text === '') cur += 1;
        }

        if (unassignedPage) {
          const uSuffix = '](area/unassigned/index.md)';
          const uLine = nonFenced[cur]?.text ?? '';
          if (!uLine.startsWith('### [') || !uLine.endsWith(uSuffix)
            || decodeGeneratedMdLinkLabel(uLine.slice(5, uLine.length - uSuffix.length), seenLabels) !== unassignedPage.title
            || nonFenced[cur + 1]?.text !== '') {
            findings.add('reading-order', mdPath, 'missing or malformed ### Unassigned items heading in index.md');
            return;
          }
          cur += 2;
          let sawUnassignedItem = false;
          while (cur < sectionEndIdx && nonFenced[cur].text !== '') {
            const itemId = parseCanonicalItemBulletMd(nonFenced[cur].text, '');
            if (!itemId) {
              findings.add('reading-order', mdPath, 'malformed or spoofed unassigned item entry in index.md');
              return;
            }
            mdItemPages.add(itemId);
            sawUnassignedItem = true;
            cur += 1;
          }
          if (!sawUnassignedItem) {
            findings.add('reading-order', mdPath, 'empty ### Unassigned items section in index.md');
            return;
          }
          while (cur < sectionEndIdx && nonFenced[cur].text === '') cur += 1;
        }

        if (cur !== sectionEndIdx) {
          findings.add('reading-order', mdPath, 'unexpected extra content inside ## Areas section in index.md');
          return;
        }
        parityState.nonItemMdItemsByPage.set(page.id, mdItemPages);
      } else if (/^area\/[^/]+$/.test(page.id) && page.id !== 'area/unassigned') {
        const areaRef = page.id.slice('area/'.length);
        const h2Prefix = '## Area: ';
        if (!h2Rows[0].text.startsWith(h2Prefix)
          || decodeGeneratedMdProse(h2Rows[0].text.slice(h2Prefix.length), seenLabels) !== page.title
          || nonFenced[11]?.text !== ''
          || nonFenced[12]?.text !== `[a-${areaRef}]: #a-${areaRef}`
          || nonFenced[13]?.text !== '') {
          findings.add('reading-order', mdPath, `malformed ## Area header or anchor preamble on ${mdPath}`);
          return;
        }
        const parsedAc = parseAreaCountsBlockMd(14);
        if (!parsedAc) {
          findings.add('reading-order', mdPath, `missing or malformed area telemetry counts on ${mdPath}`);
          return;
        }
        parityState.areaCountsByPage.set(page.id, parsedAc);
        let cur = parsedAc.nextIdx;
        const expectedProjs = (Array.isArray(manifest?.pages) ? manifest.pages : [])
          .filter((p) => p.id.startsWith(`${page.id}/project/`));
        if (expectedProjs.length > 0) {
          if (nonFenced[cur]?.text !== '### Projects' || nonFenced[cur + 1]?.text !== '') {
            findings.add('reading-order', mdPath, `missing ### Projects section on ${mdPath}`);
            return;
          }
          cur += 2;
          for (const expProj of expectedProjs) {
            const pRef = expProj.id.slice(`${page.id}/project/`.length);
            const pSuffix = `](../../area/${areaRef}/project/${pRef}/index.md) (${mdInlineCode(pRef)})`;
            const pLine = nonFenced[cur]?.text ?? '';
            if (!pLine.startsWith('- [') || !pLine.endsWith(pSuffix)
              || decodeGeneratedMdLinkLabel(pLine.slice(3, pLine.length - pSuffix.length), seenLabels) !== expProj.title) {
              findings.add('reading-order', mdPath, `malformed or spoofed project entry for ${expProj.id} on ${mdPath}`);
              return;
            }
            cur += 1;
          }
          if (nonFenced[cur]?.text !== '') {
            findings.add('reading-order', mdPath, `unexpected content inside ### Projects section on ${mdPath}`);
            return;
          }
          cur += 1;
        }
        if (nonFenced[cur]?.text !== '### Items' || nonFenced[cur + 1]?.text !== '') {
          findings.add('reading-order', mdPath, `missing ### Items section on ${mdPath}`);
          return;
        }
        cur += 2;
        if (cur < sectionEndIdx && nonFenced[cur].text === 'No items recorded in this area.') {
          cur += 1;
        } else {
          let sawItem = false;
          while (cur < sectionEndIdx && nonFenced[cur].text !== '') {
            const itemId = parseCanonicalItemBulletMd(nonFenced[cur].text, '../../');
            if (!itemId) {
              findings.add('reading-order', mdPath, `malformed or spoofed item entry on ${mdPath}`);
              return;
            }
            mdItemPages.add(itemId);
            sawItem = true;
            cur += 1;
          }
          if (!sawItem) {
            findings.add('reading-order', mdPath, `empty ### Items section on ${mdPath}`);
            return;
          }
        }
        while (cur < sectionEndIdx && nonFenced[cur].text === '') cur += 1;
        if (cur !== sectionEndIdx) {
          findings.add('reading-order', mdPath, `unexpected extra content on ${mdPath}`);
          return;
        }
        parityState.nonItemMdItemsByPage.set(page.id, mdItemPages);
      } else if (page.id === 'area/unassigned') {
        if (!h2Rows[0].text.startsWith('## ')
          || decodeGeneratedMdProse(h2Rows[0].text.slice(3), seenLabels) !== page.title
          || nonFenced[11]?.text !== ''
          || nonFenced[12]?.text !== '[a-unassigned]: #a-unassigned'
          || nonFenced[13]?.text !== ''
          || nonFenced[14]?.text !== 'These items name no area in the registry and remain visible until mapped.'
          || nonFenced[15]?.text !== '') {
          findings.add('reading-order', mdPath, `malformed unassigned area preamble on ${mdPath}`);
          return;
        }
        let cur = 16;
        let sawItem = false;
        while (cur < sectionEndIdx && nonFenced[cur].text !== '') {
          const itemId = parseCanonicalItemBulletMd(nonFenced[cur].text, '../../');
          if (!itemId) {
            findings.add('reading-order', mdPath, `malformed or spoofed item entry on ${mdPath}`);
            return;
          }
          mdItemPages.add(itemId);
          sawItem = true;
          cur += 1;
        }
        while (cur < sectionEndIdx && nonFenced[cur].text === '') cur += 1;
        if (!sawItem || cur !== sectionEndIdx) {
          findings.add('reading-order', mdPath, `unexpected or empty item list on ${mdPath}`);
          return;
        }
        parityState.nonItemMdItemsByPage.set(page.id, mdItemPages);
      } else if (/^area\/[^/]+\/project\/[^/]+$/.test(page.id)) {
        const [, areaRef, , projRef] = page.id.split('/');
        const areaPage = pageById.get(`area/${areaRef}`);
        const areaLine = nonFenced[12]?.text ?? '';
        const areaSuffix = `](../../../../area/${areaRef}/index.md) (${mdInlineCode(areaRef)})`;
        if (!areaPage
          || !h2Rows[0].text.startsWith('## Project: ')
          || decodeGeneratedMdProse(h2Rows[0].text.slice('## Project: '.length), seenLabels) !== page.title
          || nonFenced[11]?.text !== ''
          || !areaLine.startsWith('- **Area:** [')
          || !areaLine.endsWith(areaSuffix)
          || decodeGeneratedMdLinkLabel(areaLine.slice('- **Area:** ['.length, areaLine.length - areaSuffix.length), seenLabels) !== areaPage.title
          || nonFenced[13]?.text !== `- **Project:** ${mdInlineCode(projRef)}`
          || nonFenced[14]?.text !== ''
          || nonFenced[15]?.text !== '### Items'
          || nonFenced[16]?.text !== '') {
          findings.add('reading-order', mdPath, `malformed project preamble on ${mdPath}`);
          return;
        }
        let cur = 17;
        if (cur < sectionEndIdx && nonFenced[cur].text === 'No items in this project.') {
          cur += 1;
        } else {
          let sawItem = false;
          while (cur < sectionEndIdx && nonFenced[cur].text !== '') {
            const itemId = parseCanonicalItemBulletMd(nonFenced[cur].text, '../../../../');
            if (!itemId) {
              findings.add('reading-order', mdPath, `malformed or spoofed item entry on ${mdPath}`);
              return;
            }
            mdItemPages.add(itemId);
            sawItem = true;
            cur += 1;
          }
          if (!sawItem) {
            findings.add('reading-order', mdPath, `empty ### Items section on ${mdPath}`);
            return;
          }
        }
        while (cur < sectionEndIdx && nonFenced[cur].text === '') cur += 1;
        if (cur !== sectionEndIdx) {
          findings.add('reading-order', mdPath, `unexpected extra content on ${mdPath}`);
          return;
        }
        parityState.nonItemMdItemsByPage.set(page.id, mdItemPages);
      }
    }

    if (page.id === '' && parityState) {
      const manifestDecs = Array.isArray(manifest?.decisions) ? manifest.decisions : [];
      const openRows = h2Rows.filter((h) => h.text === '## Open decisions');
      if (manifestDecs.length === 0) {
        if (openRows.length > 0) {
          findings.add('reading-order', mdPath, 'unexpected ## Open decisions section on portfolio page with zero decisions in Markdown');
          return;
        }
        parityState.portfolioMdOpenDecisions = new Map();
        verifyMdTailSections(h2Rows, 1, firstCiteIdx, nonFenced, seenLabels, page, manifest, mdPath, findings, parityState);
      } else {
        if (openRows.length !== 1 || h2Rows[1] !== openRows[0]) {
          findings.add('reading-order', mdPath, 'missing, duplicated, or misordered ## Open decisions section on portfolio page in Markdown');
          return;
        }
        const openEndIdx = h2Rows[2]?.idx ?? firstCiteIdx;
        const openSlice = nonFenced.slice(openRows[0].idx + 1, openEndIdx).map((r) => r.text);
        while (openSlice.length > 0 && openSlice[0] === '') openSlice.shift();
        while (openSlice.length > 0 && openSlice[openSlice.length - 1] === '') openSlice.pop();
        if (openSlice.includes('\u0000FENCE\u0000') || openSlice.length !== manifestDecs.length) {
          findings.add('reading-order', mdPath, 'malformed or extra content inside ## Open decisions section on portfolio page in Markdown');
          return;
        }
        const openMap = new Map();
        for (let di = 0; di < manifestDecs.length; di += 1) {
          const decodedLabel = parsePortfolioOpenDecisionBullet(openSlice[di], manifestDecs[di], seenLabels);
          if (decodedLabel === null) {
            findings.add('reading-order', mdPath, `malformed Open decisions entry for ${manifestDecs[di].decisionRef} on portfolio page in Markdown`);
            return;
          }
          openMap.set(manifestDecs[di].anchor, decodedLabel);
        }
        parityState.portfolioMdOpenDecisions = openMap;
        verifyMdTailSections(h2Rows, 2, firstCiteIdx, nonFenced, seenLabels, page, manifest, mdPath, findings, parityState);
      }
      return;
    }
    verifyMdTailSections(h2Rows, 1, firstCiteIdx, nonFenced, seenLabels, page, manifest, mdPath, findings, parityState);
    return;
  }

  if (h2Rows.length < 2 || !h2Rows[0].text.startsWith('## Item: ') || h2Rows[1].text !== '## Decisions') {
    findings.add('reading-order', mdPath, 'item page with decisions must have ## Item: followed by ## Decisions in Markdown');
    return;
  }
  if (!verifyMdTailSections(h2Rows, 2, firstCiteIdx, nonFenced, seenLabels, page, manifest, mdPath, findings, parityState)) {
    return;
  }
  if (decHeadRows.length !== pageDecisions.length) {
    findings.add('reading-order', mdPath, `expected ${pageDecisions.length} ### Decision heading(s) in Markdown, found ${decHeadRows.length}`);
    return;
  }

  if (!verifyItemSectionMd(nonFenced, h2Rows[0], h2Rows[1].idx, page, manifest, seenLabels, itemMeta, mdPath, findings, parityState)) {
    return;
  }

  const decDefIndices = [];
  for (let di = 0; di < pageDecisions.length; di += 1) {
    const dec = pageDecisions[di];
    const decDefToken = `[${dec.anchor}]: #${dec.anchor}`;
    const decIdx = nonFenced.findIndex((r) => r.text === decDefToken);
    if (decIdx < 0 || !(rawLines[nonFenced[decIdx].lineNo - 2] ?? '').startsWith(`### Decision ${dec.decisionRef}: `)) {
      findings.add('reading-order', mdPath, `decision ${dec.decisionRef} heading or anchor definition missing in Markdown`);
      return;
    }
    if (di > 0 && decIdx <= decDefIndices[di - 1]) {
      findings.add('reading-order', mdPath, `decision ${dec.decisionRef} appears out of manifest order in Markdown`);
      return;
    }
    decDefIndices.push(decIdx);
  }

  const firstDecHeadLineNo = nonFenced[decDefIndices[0]].lineNo - 2;
  const firstDecHeadPos = nonFenced.findIndex((r) => r.lineNo === firstDecHeadLineNo);
  const betweenDecisionsHeadingAndFirst = nonFenced
    .slice(h2Rows[1].idx + 1, firstDecHeadPos)
    .filter((r) => r.text !== '');
  if (firstDecHeadPos <= h2Rows[1].idx || betweenDecisionsHeadingAndFirst.length > 0) {
    findings.add('reading-order', mdPath, 'unexpected pre-decision content between ## Decisions and first ### Decision in Markdown');
    return;
  }

  for (let di = 0; di < pageDecisions.length; di += 1) {
    const nextDecHeadLineNo = di + 1 < pageDecisions.length
      ? nonFenced[decDefIndices[di + 1]].lineNo - 2
      : null;
    checkQuestionReadingOrderMd(parsedMd, mdPath, pageDecisions[di], nextDecHeadLineNo, findings, parityState);
  }

  const decTailStartIdx = h2Rows[2]?.idx ?? firstCiteIdx;
  for (let idx = decTailStartIdx; idx < firstCiteIdx; idx += 1) {
    if (hasStandaloneMdCalloutInLine(nonFenced[idx].text, seenLabels, Boolean(nonFenced[idx]?.inGfmTable))) {
      findings.add('reading-order', mdPath, 'decision/verdict callout label appears outside ## Decisions on item page in Markdown');
      return;
    }
  }
}

function checkQuestionReadingOrderMd(parsedMd, mdPath, decision, nextDecHeadLineNo, findings, parityState) {
  const { rawLines, nonFenced, seenLabels, mdProblems, unclosedFence } = parsedMd;
  if (mdProblems.length > 0) {
    findings.add('reading-order', mdPath, mdProblems[0]);
  }
  if (unclosedFence) {
    findings.add('reading-order', mdPath, 'unclosed fenced code block in Markdown');
    return;
  }

  const decDefToken = `[${decision.anchor}]: #${decision.anchor}`;
  const decIdx = nonFenced.findIndex((r) => r.text === decDefToken);
  const decHeadingPrefix = `### Decision ${decision.decisionRef}: `;
  const decHeadingLine = decIdx >= 0 ? (rawLines[nonFenced[decIdx].lineNo - 2] ?? '') : '';
  const decSuffixDecoded = decHeadingLine.startsWith(decHeadingPrefix)
    ? decodeGeneratedMdProse(decHeadingLine.slice(decHeadingPrefix.length), seenLabels)
    : null;
  if (decIdx < 0 || decSuffixDecoded === null || decSuffixDecoded.trim().length === 0 || decSuffixDecoded.length > 200) {
    findings.add('reading-order', mdPath, `decision ${decision.decisionRef} heading or anchor definition missing or malformed in Markdown`);
    return;
  }

  const firstQIdx = nonFenced.findIndex((r) => r.text === `[${decision.questions[0].anchor}]: #${decision.questions[0].anchor}`);
  if (firstQIdx <= decIdx) {
    findings.add('reading-order', mdPath, `question ${decision.questions[0].questionRef} anchor definition missing or before decision in Markdown`);
    return;
  }
  const firstQHeadingLineNo = nonFenced[firstQIdx].lineNo - 2;
  const firstQHeadPos = nonFenced.findIndex((r, idx) => idx > decIdx && r.lineNo === firstQHeadingLineNo);
  const preQuestionLines = firstQHeadPos > decIdx
    ? nonFenced.slice(decIdx + 1, firstQHeadPos).filter((r) => r.text !== '')
    : [];
  if (preQuestionLines.length !== 1 || preQuestionLines[0].text !== `- **Kind:** ${decision.kind}`) {
    findings.add('reading-order', mdPath, `decision ${decision.decisionRef} contains unexpected content before first question in Markdown`);
    return;
  }

  const questionsMap = new Map();
  let allQuestionsOk = true;
  let prevQPos = decIdx;
  for (let qi = 0; qi < decision.questions.length; qi += 1) {
    const q = decision.questions[qi];
    const defToken = `[${q.anchor}]: #${q.anchor}`;
    const defMatches = [];
    for (let idx = 0; idx < nonFenced.length; idx += 1) {
      if (nonFenced[idx].text === defToken) defMatches.push(idx);
    }
    if (defMatches.length !== 1 || defMatches[0] <= prevQPos) {
      findings.add('reading-order', mdPath, `question ${q.questionRef} anchor definition missing or misordered in Markdown`);
      allQuestionsOk = false;
      continue;
    }
    const qDefPos = defMatches[0];
    prevQPos = qDefPos;
    const qHeadingPrefix = `#### Question ${q.questionRef}: `;
    const qHeadingLine = rawLines[nonFenced[qDefPos].lineNo - 2] ?? '';
    const qSuffixDecoded = qHeadingLine.startsWith(qHeadingPrefix)
      ? decodeGeneratedMdProse(qHeadingLine.slice(qHeadingPrefix.length), seenLabels)
      : null;
    if (qSuffixDecoded === null || qSuffixDecoded.trim().length === 0 || qSuffixDecoded.length > 500) {
      findings.add('reading-order', mdPath, `question ${q.questionRef} heading malformed in Markdown`);
      allQuestionsOk = false;
      continue;
    }

    const startPos = qDefPos + 1;
    let endPos = nonFenced.length;
    for (let idx = startPos; idx < nonFenced.length; idx += 1) {
      const t = nonFenced[idx].text;
      if (/^#{1,6}(?:[ \t]|$)/.test(t) || CITE_REF_DEF_RE.test(t)) {
        endPos = idx;
        break;
      }
    }
    // Enforce exact boundary at the end of every question:
    // - non-final question: must end right at next question's #### Question heading
    // - final question with a following decision: must end right at next decision's ### Decision heading
    // - final question of final decision: must end at EOF, ## Explicit gaps, ## Evidence, or citation ref defs
    if (qi + 1 < decision.questions.length) {
      const nextQDefPos = nonFenced.findIndex((r) => r.text === `[${decision.questions[qi + 1].anchor}]: #${decision.questions[qi + 1].anchor}`);
      if (nextQDefPos < 0 || nonFenced[endPos]?.lineNo !== nonFenced[nextQDefPos].lineNo - 2) {
        findings.add('reading-order', mdPath, `question ${q.questionRef} contains unexpected section before next question in Markdown`);
        allQuestionsOk = false;
        continue;
      }
    } else if (nextDecHeadLineNo !== null) {
      if (nonFenced[endPos]?.lineNo !== nextDecHeadLineNo) {
        findings.add('reading-order', mdPath, `decision ${decision.decisionRef} contains unexpected inter-decision section before next decision in Markdown`);
        allQuestionsOk = false;
        continue;
      }
    } else if (endPos < nonFenced.length) {
      const endText = nonFenced[endPos].text;
      if (endText !== '## Explicit gaps' && endText !== '## Evidence' && !CITE_REF_DEF_RE.test(endText)) {
        findings.add('reading-order', mdPath, `decision ${decision.decisionRef} contains unexpected trailing heading inside ## Decisions in Markdown`);
        allQuestionsOk = false;
        continue;
      }
    }

    const slice = nonFenced.slice(startPos, endPos).map((r) => r.text);
    while (slice.length > 0 && slice[0] === '') slice.shift();
    while (slice.length > 0 && slice[slice.length - 1] === '') slice.pop();

    const ftExpected = q.freeText.allowed
      ? `**Free-text response.** Allowed (up to ${q.freeText.maxChars} characters).`
      : '**Free-text response.** Not allowed.';
    const ftIdx = slice.indexOf(ftExpected);
    let valid = !slice.includes('\u0000FENCE\u0000')
      && slice[0] === '**Options.**'
      && ftIdx >= 1
      && slice.lastIndexOf(ftExpected) === ftIdx
      && slice[ftIdx + 1] === '';

    let mdRecOptRef = null;
    let mdRecInfo = null;
    let mdEvCites = [];
    if (valid) {
      const afterFt = slice.slice(ftIdx + 2);
      const recMatch = /^\*\*Recommendation(?: \(`([A-Za-z][A-Za-z0-9-]{0,63})`\))?\.\*\* ([\s\S]+)$/.exec(afterFt[0] ?? '');
      const recDecoded = recMatch ? decodeGeneratedMdInline(recMatch[2], seenLabels) : null;
      const recLineOk = afterFt.length >= 1
        && recMatch !== null
        && (recMatch[1] === undefined || q.optionRefs.includes(recMatch[1]))
        && recDecoded !== null
        && recDecoded.text.length > 0
        && !hasStandaloneMdCalloutInLine(recMatch[2], seenLabels);
      if (!recLineOk) {
        valid = false;
      } else if (afterFt.length === 1) {
        mdRecOptRef = recMatch[1] ?? null;
        mdRecInfo = recDecoded;
      } else if (afterFt.length === 3 && afterFt[1] === '' && /^\*\*Supporting evidence\.\*\* \[E\d+\](?:, \[E\d+\])*$/.test(afterFt[2])) {
        const rawCites = afterFt[2].slice('**Supporting evidence.** '.length).split(', ');
        if (rawCites.some((ct) => !seenLabels?.has(normalizeMdRefLabel(ct)))) {
          valid = false;
        } else {
          mdRecOptRef = recMatch[1] ?? null;
          mdRecInfo = recDecoded;
          mdEvCites = rawCites;
        }
      } else {
        valid = false;
      }
    }

    const sameInlineArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, idx) => v === b[idx]);
    const mdOptLabels = [];
    const mdOptSummaries = [];
    if (valid) {
      const optRegion = slice.slice(1, ftIdx);
      if (q.optionRefs.length === 0) {
        valid = optRegion.every((l) => l === '');
      } else {
        valid = optRegion.length >= 2 && optRegion[optRegion.length - 1] === '';
        if (valid) {
          const optBody = optRegion.slice(0, -1);
          valid = optBody.length === q.optionRefs.length
            && optBody.every((l) => l.startsWith('- '));
          if (valid) {
            for (let oi = 0; oi < q.optionRefs.length; oi += 1) {
              const oRef = q.optionRefs[oi];
              const bullet = optBody[oi];
              const bulletBody = bullet.slice(2);
              const sep = ` (\`${oRef}\`): `;
              const shouldBeChosen = mdRecOptRef !== null && oRef === mdRecOptRef;
              let optLabel = null;
              let rawSummaryMd = null;
              if (shouldBeChosen) {
                const lead = splitLeadingGeneratedStrongMd(bulletBody, seenLabels);
                if (lead && lead.coreText.endsWith(' (recommended)') && lead.restRaw.startsWith(sep)) {
                  optLabel = `${lead.leadWs}${lead.coreText.slice(0, -' (recommended)'.length)}`;
                  rawSummaryMd = lead.restRaw.slice(sep.length);
                }
              } else {
                const sepIdx = bulletBody.indexOf(sep);
                if (sepIdx >= 1) {
                  optLabel = decodeGeneratedMdProse(bulletBody.slice(0, sepIdx), seenLabels);
                  rawSummaryMd = bulletBody.slice(sepIdx + sep.length);
                }
              }
              const summaryDecoded = rawSummaryMd !== null ? decodeGeneratedMdInline(rawSummaryMd, seenLabels) : null;
              const fullBulletDec = decodeGeneratedMdInline(bulletBody, seenLabels);
              const normOpt = optLabel !== null ? normCalloutLabel(optLabel) : '';
              if (optLabel === null || optLabel.trim().length === 0 || optLabel.length > 120
                || STANDALONE_CALLOUT_STRONG_RE.test(normOpt) || CALLOUT_BARE_LABEL_RE.test(normOpt)
                || summaryDecoded === null || summaryDecoded.text.length === 0
                || fullBulletDec === null
                || !sameInlineArr(fullBulletDec.hrefs, summaryDecoded.hrefs)
                || !sameInlineArr(fullBulletDec.cites, summaryDecoded.cites)
                || hasStandaloneMdCalloutInLine(bulletBody, seenLabels)
                || hasStandaloneMdCalloutInLine(rawSummaryMd, seenLabels)) {
                valid = false;
                break;
              }
              mdOptLabels.push(optLabel);
              mdOptSummaries.push(summaryDecoded);
            }
          }
        }
      }
    }

    if (!valid) {
      findings.add('reading-order', mdPath, `question ${q.questionRef} violates question -> options -> recommendation -> evidence order in Markdown`);
      allQuestionsOk = false;
    } else {
      questionsMap.set(q.anchor, {
        prompt: qSuffixDecoded,
        recOptRef: mdRecOptRef,
        recInfo: mdRecInfo,
        optLabels: mdOptLabels,
        optSummaries: mdOptSummaries,
        evCites: mdEvCites,
      });
    }
  }

  if (allQuestionsOk && parityState) {
    parityState.mdDecisions.set(decision.anchor, {
      label: decSuffixDecoded,
      mdPath,
      questions: questionsMap,
    });
  }
}

export async function verifySiteBundle(bundleDir) {
  const findings = new Findings();
  const rootStat = await lstat(bundleDir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    findings.add('not-a-packet', bundleDir, 'bundle directory is missing, not a directory, or a symlink');
    return { ok: false, errors: findings.errors };
  }
  const { found, dirs, total } = await walk(bundleDir, findings);
  checkPathCollisions([...found.keys()], findings, 'on-disk');
  if (found.size > LIMITS.files + 2) findings.add('limit', '.', `more than ${LIMITS.files} files on disk`);
  if (total > LIMITS.totalBytes) findings.add('limit', '.', `bundle is ${total} bytes; limit ${LIMITS.totalBytes}`);

  const manifestFile = await readJsonFile(join(bundleDir, 'manifest.json'), 'manifest.json', findings);
  const checksumsFile = await readJsonFile(join(bundleDir, 'checksums.json'), 'checksums.json', findings);
  if (!manifestFile) return { ok: false, errors: findings.errors };
  const manifest = manifestFile.value;
  const manifestSha256 = sha256(manifestFile.bytes);
  const files = checkManifestShape(manifest, findings);

  const { contentId: declaredId, ...identity } = manifest;
  let recomputedId = null;
  try {
    recomputedId = `sha256-${sha256(Buffer.from(canonical(identity), 'utf8'))}`;
  } catch (err) {
    findings.add('content-id', 'manifest.json', err.message);
  }
  if (recomputedId && recomputedId !== declaredId) {
    findings.add('content-id', 'manifest.json#/contentId', `declared ${declaredId} but manifest digests to ${recomputedId}`);
  }

  const declared = new Set(files.map((f) => f.path));
  for (const path of found.keys()) {
    if (!declared.has(path) && !CONTROL_FILES.has(path)) {
      findings.add('extra-file', path, 'file on disk is not in the manifest inventory');
    }
  }

  // Every directory on disk must be an ancestor of at least one declared file in the inventory (F11).
  const expectedDirs = new Set();
  for (const path of declared) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) expectedDirs.add(parts.slice(0, i).join('/'));
  }
  for (const dir of dirs) {
    if (!expectedDirs.has(dir)) {
      findings.add('unexpected-directory', dir, 'directory on disk does not contain any inventoried bundle file');
    }
  }

  const textByPath = new Map();
  const stylesheets = [];
  for (const f of files) {
    const disk = found.get(f.path);
    if (!disk) {
      findings.add('missing-file', f.path, 'inventory file is missing on disk');
      continue;
    }
    if (disk.size !== f.bytes) findings.add('byte-length', f.path, `manifest declares ${f.bytes} bytes; file has ${disk.size}`);
    const bytes = await readFile(disk.abs);
    const digest = sha256(bytes);
    if (digest !== f.sha256) findings.add('checksum', f.path, `manifest declares ${f.sha256}; file digests to ${digest}`);
    if (f.path.endsWith('.html') || f.path.endsWith('.md') || f.role === 'evidence') textByPath.set(f.path, bytes.toString('utf8'));
    if (f.role === 'asset' && f.path.endsWith('.css')) stylesheets.push({ path: f.path, text: bytes.toString('utf8') });
  }

  if (checksumsFile) {
    const c = checksumsFile.value;
    if (!exactKeys(c, ['schema', 'algorithm', 'contentId', 'manifestSha256', 'files'])) {
      findings.add('schema', 'checksums.json', 'checksums must have exactly schema, algorithm, contentId, manifestSha256, files');
    }
    if (c.schema !== 'checksums/v1' || c.algorithm !== 'sha256') findings.add('schema-version', 'checksums.json', 'expected checksums/v1 with sha256');
    if (c.contentId !== declaredId) findings.add('checksums-disagree', 'checksums.json#/contentId', 'content ID disagrees with manifest');
    if (c.manifestSha256 !== manifestSha256) findings.add('checksums-disagree', 'checksums.json#/manifestSha256', 'manifest digest disagrees with manifest.json bytes');
    const listed = c.files && typeof c.files === 'object' ? c.files : {};
    const manifestMap = new Map(files.map((f) => [f.path, f.sha256]));
    for (const [path, digest] of Object.entries(listed)) {
      if (!manifestMap.has(path)) findings.add('checksums-disagree', `checksums.json#/files/${path}`, 'path not in manifest');
      else if (manifestMap.get(path) !== digest) findings.add('checksums-disagree', `checksums.json#/files/${path}`, 'digest disagrees with manifest');
    }
    for (const path of manifestMap.keys()) {
      if (!Object.hasOwn(listed, path)) findings.add('checksums-disagree', `checksums.json#/files/${path}`, 'manifest path missing from checksums');
    }
  }

  // Parse each page once via the closed-world HTML5 + SVG structural automaton so only
  // structurally valid, non-malformed elements admit ids into htmlIdsByPage (F3, F9, R5, R6).
  const htmlIdsByPage = new Map();
  const inspectedByPage = new Map();
  if (Array.isArray(manifest.pages)) {
    for (const page of manifest.pages) {
      const html = textByPath.get(page.html);
      if (html !== undefined) {
        const inspected = inspectHtmlDocument(html, { alternateHref: 'index.md' });
        inspectedByPage.set(page.html, inspected);
        htmlIdsByPage.set(page.html, inspected.ids);
        for (const idProb of inspected.idProblems) {
          findings.add('anchor-parity', page.html, idProb);
        }
      }
    }
  }

  // P2 policy scan, P7 bidirectional anchor parity, and P14 decision reading order on every page.
  if (Array.isArray(manifest.pages) && Array.isArray(manifest.anchors)) {
    const parityState = {
      textByPath,
      blockTitleByAnchor: new Map(),
      htmlGapsByPage: new Map(),
      mdGapsByPage: new Map(),
      htmlEvByPage: new Map(),
      mdEvByPage: new Map(),
      htmlDecisions: new Map(),
      mdDecisions: new Map(),
      itemHtmlBlockMeta: new Map(),
      itemAgeByPage: new Map(),
      portfolioMdOpenDecisions: null,
      nonItemHtmlDecisionLinks: new Map(),
      triageTableRows: [],
      triageListItems: [],
      pageHasNav: new Map(),
      strictParity: false,
      portfolioUsesLegacyFlatOpenList: false,
      portfolioPulseCells: null,
      portfolioAreaChartRows: null,
      portfolioAreaHtmlMetrics: new Map(),
      areaHtmlMetricsByPage: new Map(),
      portfolioMdAreaCounts: new Map(),
      portfolioAreaCountsTables: new Map(),
      areaPageCountsTables: new Map(),
      areaProjectTables: [],
      nonItemHtmlItemsByPage: new Map(),
      nonItemMdItemsByPage: new Map(),
      mdItemBulletRefs: [],
      areaCountsByPage: new Map(),
      portfolioHtmlPriorEditions: null,
      portfolioMdPriorEditions: null,
      hasEvRefTitleCss: stylesheets.some((s) => /\.ev-ref__title\b/.test(s.text)),
      evRefTitleChecks: [],
    };
    for (const page of manifest.pages) {
      const html = textByPath.get(page.html);
      const md = textByPath.get(page.markdown);
      const expectedAnchors = manifest.anchors.filter((a) => a.page === page.id).map((a) => a.anchor);
      const expectedSet = new Set(expectedAnchors);
      const pageDecisions = Array.isArray(manifest.decisions)
        ? manifest.decisions.filter((dec) => dec.page === page.id)
        : [];

      if (html !== undefined) {
        const inspected = inspectedByPage.get(page.html);
        for (const problem of scanSitePageHtml(inspected, page.html, declared, htmlIdsByPage)) {
          findings.add('unsafe-content', page.html, problem);
        }
        const ids = htmlIdsByPage.get(page.html);
        for (const a of expectedAnchors) {
          if (!ids.has(a)) findings.add('anchor-parity', page.html, `expected anchor id="${a}" missing from HTML`);
        }
        // Reverse check: every element-anchor id in HTML must be declared in manifest.anchors for this page (F9, R2-F2).
        for (const id of ids) {
          if (ELEMENT_ANCHOR_RE.test(id) && !expectedSet.has(id) && !isAllowedBlockSubId(id, expectedSet)) {
            findings.add('anchor-parity', page.html, `HTML element anchor id="${id}" is missing from manifest.anchors and Markdown`);
          }
        }
        checkPageDecisionsHtml(inspected, page, manifest, pageDecisions, findings, parityState);
      }
      if (md !== undefined) {
        const parsedMd = parseMarkdownOutsideFences(md);
        if (parsedMd.unclosedFence) {
          findings.add('anchor-parity', page.markdown, 'unclosed fenced code block in Markdown');
        }
        for (const mdProb of parsedMd.mdProblems) {
          findings.add('anchor-parity', page.markdown, mdProb);
        }
        const { mdAnchors } = parsedMd;
        if (mdAnchors.length !== expectedAnchors.length || !mdAnchors.every((a, i) => a === expectedAnchors[i])) {
          findings.add('anchor-parity', page.markdown, `Markdown anchors ${JSON.stringify(mdAnchors)} disagree with manifest anchors ${JSON.stringify(expectedAnchors)}`);
        }
        checkPageDecisionsMd(parsedMd, page, manifest, pageDecisions, findings, parityState);
      }
    }

    if (parityState.evRefTitleChecks.length > 0) {
      const evTitleMap = new Map(
        [...parityState.htmlEvByPage.values()].flatMap((arr) => arr.map((e) => [e.id, e.title])),
      );
      const seenEvTitleErrs = new Set();
      for (const chk of parityState.evRefTitleChecks) {
        if (!evTitleMap.has(chk.id) || evTitleMap.get(chk.id) !== chk.title) {
          const key = `${chk.pagePath}\u0000${chk.message}`;
          if (!seenEvTitleErrs.has(key)) {
            seenEvTitleErrs.add(key);
            findings.add('reading-order', chk.pagePath, chk.message);
          }
        }
      }
    }

    if (Array.isArray(manifest.decisions)) {
      const sameStringArray = (a, b) => a.length === b.length && a.every((v, idx) => v === b[idx]);
      const decByAnchor = new Map(manifest.decisions.map((d) => [d.anchor, d]));

      for (const row of parityState.triageTableRows) {
        const d = decByAnchor.get(row.dAnchor);
        const htmlDec = parityState.htmlDecisions.get(row.dAnchor);
        if (!d || !htmlDec) {
          findings.add('reading-order', row.pagePath, `triage table row references unknown or invalid decision #${row.dAnchor}`);
          continue;
        }
        const itemAge = parityState.itemAgeByPage.get(d.page);
        if (itemAge !== undefined && row.ageText !== itemAge) {
          findings.add('reading-order', row.pagePath, `triage table Age cell for #${row.dAnchor} disagrees with item Age in HTML`);
        }
        const q0Meta = d.questions[0];
        const q0Html = q0Meta ? htmlDec.questions.get(q0Meta.anchor) : null;
        if (q0Html) {
          if (q0Html.recOptRef !== null) {
            const chosenIdx = q0Meta.optionRefs.indexOf(q0Html.recOptRef);
            const chosenLabel = chosenIdx >= 0 ? q0Html.optLabels[chosenIdx] : null;
            const codeEl = row.td.children[0];
            const codeClassOk = codeEl && (codeEl.classes.size === 0 || (codeEl.classes.size === 1 && codeEl.classes.has('opt-key')));
            const tdOk = chosenLabel !== null
              && row.td.children.length === 1
              && codeEl?.tag === 'code'
              && !isHiddenEl(codeEl)
              && codeEl.children.length === 0
              && codeClassOk
              && fullElementText(codeEl) === q0Html.recOptRef
              && fullElementText(row.td).trim() === `${q0Html.recOptRef} ${chosenLabel}`.trim();
            if (!tdOk) {
              findings.add('reading-order', row.pagePath, `triage table recommendation cell disagrees with item decision #${row.dAnchor} in HTML`);
            }
          } else {
            const recText = q0Html.recInfo.text;
            const recCps = Array.from(recText);
            const truncRec = recCps.length > 90 ? `${recCps.slice(0, 87).join('').trim()}…` : recText;
            const legacyTruncRec = recText.length > 90 ? `${recText.slice(0, 87).trim()}…` : recText;
            const isNoExplicit = /^no explicit recommendation/i.test(recText);
            const allowedQSuffixes = d.questions.length > 1
              ? [` (${d.questions.length} questions)`]
              : ['', ' (1 question)'];
            const tdTrim = fullElementText(row.td).trim();

            const plainOk = row.td.children.length === 0
              && (tdTrim === recText || tdTrim === truncRec || tdTrim === legacyTruncRec || (isNoExplicit && tdTrim === '—'));
            let choosePillOk = false;
            let freeTextPillOk = false;
            if (isNoExplicit && isWhitespaceOnly(row.td.ownText) && row.td.children.length === 1) {
              const sp = row.td.children[0];
              if (sp.tag === 'span' && sp.classes.size === 1 && sp.classes.has('item__id') && !isHiddenEl(sp)) {
                const spTrim = fullElementText(sp).trim();
                if (q0Meta.optionRefs.length >= 2) {
                  const refs = q0Meta.optionRefs.slice(0, 4);
                  choosePillOk = sp.children.length === refs.length
                    && sp.children.every((c, ci) => c.tag === 'code' && !isHiddenEl(c) && c.children.length === 0
                      && (c.classes.size === 0 || (c.classes.size === 1 && c.classes.has('opt-key')))
                      && fullElementText(c) === refs[ci])
                    && allowedQSuffixes.some((sfx) => spTrim === `Choose ${refs.join(' / ')}${sfx}`);
                } else if (q0Meta.freeText?.allowed) {
                  freeTextPillOk = sp.children.length === 0
                    && allowedQSuffixes.some((sfx) => spTrim === `Free-text reply${sfx}`);
                }
              }
            }
            if (!plainOk && !choosePillOk && !freeTextPillOk) {
              findings.add('reading-order', row.pagePath, `triage table recommendation cell disagrees with unrecommended item decision #${row.dAnchor} in HTML`);
            }
          }
        }
      }

      for (const liItem of parityState.triageListItems) {
        const d = decByAnchor.get(liItem.dAnchor);
        if (!d) {
          findings.add('reading-order', liItem.pagePath, `decision list item references unknown decision #${liItem.dAnchor} in HTML`);
          continue;
        }
        const itemAge = parityState.itemAgeByPage.get(d.page) ?? '';
        const metaOk = liItem.metaSpanText === itemAge
          || liItem.metaSpanText === d.decisionRef
          || liItem.metaSpanText === `${d.kind} · ${d.decisionRef}`
          || (itemAge !== '' && liItem.metaSpanText === `${d.kind} · ${d.decisionRef} · ${itemAge}`);
        if (!metaOk) {
          findings.add('reading-order', liItem.pagePath, `decision list item metadata for #${liItem.dAnchor} disagrees with item metadata in HTML`);
        }
      }

      for (const d of manifest.decisions) {
        const htmlDec = parityState.htmlDecisions.get(d.anchor);
        const mdDec = parityState.mdDecisions.get(d.anchor);
        if (!htmlDec || !mdDec) continue;
        if (htmlDec.label !== mdDec.label) {
          findings.add('reading-order', mdDec.mdPath, `decision ${d.decisionRef} label disagrees between HTML and Markdown`);
        }
        if (parityState.portfolioMdOpenDecisions && parityState.portfolioMdOpenDecisions.get(d.anchor) !== htmlDec.label) {
          findings.add('reading-order', 'index.md', `portfolio Open decisions label for ${d.decisionRef} disagrees with item decision label`);
        }
        const links = parityState.nonItemHtmlDecisionLinks.get(d.anchor) ?? [];
        if (!links.some((l) => l.pageId === '')) {
          findings.add('reading-order', 'index.html', `portfolio HTML is missing link to decision #${d.anchor}`);
        }
        for (const l of links) {
          if (l.text !== htmlDec.label) {
            findings.add('reading-order', l.pagePath, `decision link text for #${d.anchor} disagrees with item decision label`);
          }
        }
        for (const q of d.questions) {
          const hq = htmlDec.questions.get(q.anchor);
          const mq = mdDec.questions.get(q.anchor);
          if (!hq || !mq) continue;
          if (hq.prompt !== mq.prompt) {
            findings.add('reading-order', mdDec.mdPath, `question ${q.questionRef} prompt disagrees between HTML and Markdown`);
          }
          if (hq.recOptRef !== mq.recOptRef) {
            findings.add('reading-order', mdDec.mdPath, `question ${q.questionRef} recommended option disagrees between HTML and Markdown`);
          }
          if (!hq.recInfo || !mq.recInfo
            || hq.recInfo.text !== mq.recInfo.text
            || !sameStringArray(hq.recInfo.hrefs, mq.recInfo.hrefs)
            || !sameStringArray(hq.recInfo.cites, mq.recInfo.cites)) {
            findings.add('reading-order', mdDec.mdPath, `question ${q.questionRef} recommendation text disagrees between HTML and Markdown`);
          }
          if (hq.optLabels.length !== mq.optLabels.length || !hq.optLabels.every((lbl, oi) => lbl === mq.optLabels[oi])) {
            findings.add('reading-order', mdDec.mdPath, `question ${q.questionRef} option labels disagree between HTML and Markdown`);
          }
          const optSummariesOk = hq.optSummaries.length === mq.optSummaries.length
            && hq.optSummaries.every((hs, oi) => {
              const ms = mq.optSummaries[oi];
              if (hs.omitted) {
                return ms.hrefs.length === 0 && ms.cites.length === 0 && isRedundantOptionSummaryText(hq.optLabels[oi], ms.text);
              }
              return hs.text === ms.text && sameStringArray(hs.hrefs, ms.hrefs) && sameStringArray(hs.cites, ms.cites);
            });
          if (!optSummariesOk) {
            findings.add('reading-order', mdDec.mdPath, `question ${q.questionRef} option summaries disagree between HTML and Markdown`);
          }
          if (!sameStringArray(hq.evCites, mq.evCites)) {
            findings.add('reading-order', mdDec.mdPath, `question ${q.questionRef} supporting evidence disagrees between HTML and Markdown`);
          }
        }
      }

      const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));
      const hasV2SiteCss = stylesheets.some((s) => /\.(?:breadcrumb|sitrep-pulse|triage-pager|nav-item--portfolio|nav-badge)\b/.test(s.text));
      const hasTriageCss = stylesheets.some((s) => /\.table--triage\b|\.sitrep-pulse\b/.test(s.text));
      const hasPulseCss = stylesheets.some((s) => /\.sitrep-pulse\b/.test(s.text));
      const hasCountsTableCss = stylesheets.some((s) => /\.table--counts\b/.test(s.text));

      const navValues = [...parityState.pageHasNav.values()];
      if (new Set(navValues).size > 1) {
        findings.add('reading-order', 'index.html', 'inconsistent <nav class="toc">/<nav class="rail"> presence across site pages');
      }
      if ((parityState.strictParity || hasV2SiteCss) && (navValues.length !== manifest.pages.length || navValues.some((v) => !v))) {
        findings.add('reading-order', 'index.html', 'missing <nav class="toc"> and <nav class="rail"> navigation on Canon v2 site bundle');
      }
      if (parityState.portfolioUsesLegacyFlatOpenList && hasTriageCss) {
        findings.add('reading-order', 'index.html', 'legacy flat Open decisions list is not permitted with triage table CSS');
      }

      const closeCandidateItemPages = new Set(
        manifest.decisions.filter((d) => d.kind === 'close-candidate').map((d) => d.page),
      );
      for (const page of manifest.pages) {
        if (page.id.startsWith('item/')) continue;
        const htmlItems = parityState.nonItemHtmlItemsByPage.get(page.id);
        const mdItems = parityState.nonItemMdItemsByPage.get(page.id);
        if (!htmlItems || !mdItems) continue;
        if (/^area\/[^/]+\/project\/[^/]+$/.test(page.id)) {
          const projDecs = manifest.decisions.filter((d) => mdItems.has(d.page));
          const projAllAnchors = projDecs.map((d) => d.anchor);
          const projActiveAnchors = projDecs.filter((d) => d.kind !== 'close-candidate').map((d) => d.anchor);
          const projCloseAnchors = projDecs.filter((d) => d.kind === 'close-candidate').map((d) => d.anchor);
          const projDecItemPages = new Set(projDecs.map((d) => d.page));
          const projNonDecItems = new Set([...mdItems].filter((ip) => !projDecItemPages.has(ip)));
          const isV2ProjectSplit = sameStringArray(htmlItems.triageTableVisDecAnchors, projActiveAnchors)
            && sameStringArray(htmlItems.visDecAnchors, projActiveAnchors)
            && sameStringArray(htmlItems.detDecAnchors, projCloseAnchors)
            && sameSet(htmlItems.bareItemAll, projNonDecItems)
            && sameSet(htmlItems.bareItemVis, projNonDecItems);
          const isV1AllDecTableProject = !hasPulseCss && !parityState.strictParity
            && sameStringArray(htmlItems.triageTableVisDecAnchors, projAllAnchors)
            && sameStringArray(htmlItems.visDecAnchors, projAllAnchors)
            && htmlItems.detDecAnchors.length === 0
            && sameSet(htmlItems.bareItemAll, mdItems)
            && [...mdItems].every((ip) => closeCandidateItemPages.has(ip) || htmlItems.bareItemVis.has(ip));
          const isLegacyFlatProject = !hasTriageCss
            && htmlItems.visDecAnchors.length === 0
            && htmlItems.detDecAnchors.length === 0
            && sameSet(htmlItems.bareItemAll, mdItems)
            && sameSet(htmlItems.bareItemVis, mdItems);
          if (!isV2ProjectSplit && !isV1AllDecTableProject && !isLegacyFlatProject) {
            findings.add('reading-order', htmlItems.pagePath, 'project page HTML items or decision triage table disagree with Markdown and manifest decisions');
          }
        } else {
          if (!sameSet(htmlItems.bareItemAll, mdItems)) {
            findings.add('reading-order', htmlItems.pagePath, 'non-item page HTML item links disagree with Markdown item links');
          }
          for (const ip of mdItems) {
            if (!closeCandidateItemPages.has(ip) && !htmlItems.bareItemVis.has(ip)) {
              findings.add('reading-order', htmlItems.pagePath, `active item ${ip} is missing or buried inside <details> on ${htmlItems.pagePath}`);
            }
          }
          if (/^area\/[^/]+$/.test(page.id) && (htmlItems.visDecAnchors.length > 0 || htmlItems.detDecAnchors.length > 0)) {
            findings.add('reading-order', htmlItems.pagePath, 'unexpected decision anchor links on area summary page in HTML');
          }
        }
      }

      if (hasPulseCss && !parityState.portfolioPulseCells) {
        findings.add('reading-order', 'index.html', 'missing .sitrep-pulse executive pulse strip on portfolio page in HTML');
      }
      if (parityState.portfolioPulseCells) {
        const activeDecisions = manifest.decisions.filter((d) => d.kind !== 'close-candidate').length;
        const closeDecisions = manifest.decisions.filter((d) => d.kind === 'close-candidate').length;
        const areaPages = manifest.pages.filter((p) => /^area\/[^/]+$/.test(p.id) && p.id !== 'area/unassigned');
        const totalAreas = areaPages.length;
        const totalProjects = manifest.pages.filter((p) => /^area\/[^/]+\/project\/[^/]+$/.test(p.id)).length;
        const totalItems = manifest.pages.filter((p) => p.id.startsWith('item/')).length;
        const totalGaps = manifest.anchors.filter((a) => a.anchor.startsWith('g-')).length;
        const unassignedCount = parityState.nonItemMdItemsByPage.get('area/unassigned')?.size ?? 0;
        let moved = 0;
        let waiting = 0;
        let blocked = 0;
        let completeAreas = 0;
        let allAreaCountsPresent = true;
        for (const ap of areaPages) {
          const ac = parityState.areaCountsByPage.get(ap.id);
          if (!ac) {
            allAreaCountsPresent = false;
            break;
          }
          if (ac.coverage === 'complete') completeAreas += 1;
          if (typeof ac.moved === 'number') moved += ac.moved;
          if (typeof ac.waiting === 'number') waiting += ac.waiting;
          if (typeof ac.blocked === 'number') blocked += ac.blocked;
        }
        const expectedPulse = [
          {
            label: 'Active decisions',
            value: String(activeDecisions),
            sub: closeDecisions ? `${closeDecisions} aged close queued` : 'awaiting sign-off',
          },
          {
            label: 'Recorded velocity',
            value: `${moved} moved`,
            sub: `${waiting} waiting · ${blocked} blocked${completeAreas < totalAreas ? ' (partial)' : ''}`,
          },
          {
            label: 'Tracked surface',
            value: `${totalItems} items`,
            sub: `${totalAreas} areas · ${totalProjects} projects${unassignedCount ? ` · ${unassignedCount} unmapped` : ''}`,
          },
          {
            label: 'Telemetry & gaps',
            value: `${completeAreas}/${totalAreas} complete`,
            sub: `${totalGaps} explicit gap${totalGaps === 1 ? '' : 's'} surfaced`,
          },
        ];
        const pulseMatches = allAreaCountsPresent
          && parityState.portfolioPulseCells.length === 4
          && expectedPulse.every((exp, idx) => {
            const actual = parityState.portfolioPulseCells[idx];
            return actual.label === exp.label && actual.value === exp.value && actual.sub === exp.sub;
          });
        if (!pulseMatches) {
          findings.add('reading-order', 'index.html', '.sitrep-pulse executive summary disagrees with SitRep manifest and area telemetry');
        }
      }

      const allAreaPages = manifest.pages.filter((p) => /^area\/[^/]+$/.test(p.id) && p.id !== 'area/unassigned');
      const matchesAreaDl = (dlM, ac) => dlM
        && dlM.waitingText === ac.waitingText
        && dlM.movedText === ac.movedText
        && dlM.blockedText === ac.blockedText
        && dlM.coverageText === ac.coverage
        && dlM.unitText === ac.unitText;

      for (const ap of allAreaPages) {
        const ac = parityState.areaCountsByPage.get(ap.id);
        const idxMdAc = parityState.portfolioMdAreaCounts.get(ap.id);
        const areaHtmlEntry = parityState.areaHtmlMetricsByPage.get(ap.id);
        const portHtmlEntry = parityState.portfolioAreaHtmlMetrics.get(ap.id);
        if (!ac || !idxMdAc
          || idxMdAc.waitingText !== ac.waitingText
          || idxMdAc.movedText !== ac.movedText
          || idxMdAc.blockedText !== ac.blockedText
          || idxMdAc.coverage !== ac.coverage
          || idxMdAc.unitText !== ac.unitText
          || !sameStringArray(idxMdAc.gapRefs, ac.gapRefs)) {
          findings.add('reading-order', 'index.md', `portfolio Markdown area telemetry for ${ap.id} disagrees with ${ap.markdown}`);
          continue;
        }
        if (!areaHtmlEntry || !matchesAreaDl(areaHtmlEntry.metrics, ac) || !sameStringArray(areaHtmlEntry.gapRefs, ac.gapRefs)) {
          findings.add('reading-order', ap.html, `area page <dl class="metrics"> or coverage gap notice on ${ap.html} disagrees with ${ap.markdown}`);
        }
        const covPillOk = !portHtmlEntry?.covPillText
          || (portHtmlEntry.covPillText === ac.coverage && portHtmlEntry.covPillClasses?.has(`cov-pill--${ac.coverage}`));
        const cardToneOk = !portHtmlEntry?.cardClasses?.has('area-card')
          || portHtmlEntry.cardClasses.has(`area-card--${ac.coverage}`);
        if (!portHtmlEntry || !matchesAreaDl(portHtmlEntry.metrics, ac) || !sameStringArray(portHtmlEntry.gapRefs, ac.gapRefs) || !covPillOk || !cardToneOk) {
          findings.add('reading-order', 'index.html', `portfolio area card telemetry or coverage gap notice for ${ap.id} on index.html disagrees with ${ap.markdown}`);
        }
        const areaProjs = manifest.pages.filter((p) => p.id.startsWith(`${ap.id}/project/`));
        if (hasCountsTableCss && areaProjs.length > 0) {
          if (!parityState.portfolioAreaCountsTables.has(ap.id)) {
            findings.add('reading-order', 'index.html', `missing project breakdown <table class="table--counts"> for ${ap.id} on index.html`);
          }
          if (!parityState.areaPageCountsTables.has(ap.id)) {
            findings.add('reading-order', ap.html, `missing project breakdown <table class="table--counts"> on ${ap.html}`);
          }
        }
      }

      for (const tbl of parityState.areaProjectTables) {
        const expectedProjs = manifest.pages.filter((p) => p.id.startsWith(`${tbl.areaPageId}/project/`));
        const tblOk = tbl.rows.length === expectedProjs.length
          && tbl.rows.every((row, ri) => {
            const expProj = expectedProjs[ri];
            const projMdItems = parityState.nonItemMdItemsByPage.get(expProj.id) ?? new Set();
            const expActive = [...projMdItems].filter((ip) => !closeCandidateItemPages.has(ip)).length;
            const expClose = [...projMdItems].filter((ip) => closeCandidateItemPages.has(ip)).length;
            const expTotal = projMdItems.size;
            return row.projPageId === expProj.id
              && row.projTitle === String(expProj.title ?? '').trim()
              && row.active === expActive
              && row.close === expClose
              && row.total === expTotal;
          });
        if (!tblOk) {
          findings.add('reading-order', tbl.pagePath, `project breakdown <table> for ${tbl.areaPageId} on ${tbl.pagePath} disagrees with project items and close-candidate decisions`);
        }
      }

      for (const bRef of parityState.mdItemBulletRefs) {
        const expItemAge = parityState.itemAgeByPage.get(bRef.itemPageId);
        if (expItemAge !== undefined && bRef.decodedAge !== expItemAge) {
          findings.add('reading-order', bRef.mdPath, `item bullet age for ${bRef.itemPageId} on ${bRef.mdPath} disagrees with item metadata`);
        }
      }

      if (parityState.portfolioHtmlPriorEditions !== null
        && parityState.portfolioMdPriorEditions !== null
        && JSON.stringify(parityState.portfolioHtmlPriorEditions) !== JSON.stringify(parityState.portfolioMdPriorEditions)) {
        findings.add('reading-order', 'index.md', 'portfolio Prior editions section on index.md disagrees with index.html');
      }

      const pageByIdForParity = new Map(manifest.pages.map((p) => [p.id, p]));
      const qLabelByAnchor = new Map();
      for (const dec of manifest.decisions) {
        for (const q of dec.questions ?? []) {
          qLabelByAnchor.set(q.anchor, `${dec.decisionRef}/${q.questionRef}`);
        }
      }
      const expectedCitedLabel = (anchor) => {
        if (anchor.startsWith('i-')) return pageByIdForParity.get(`item/${anchor.slice(2)}`)?.title ?? anchor;
        if (anchor.startsWith('f-')) return `Finding ${anchor.slice(2)}`;
        if (anchor.startsWith('r-')) return `Risk ${anchor.slice(2)}`;
        if (anchor.startsWith('req-')) return `Requirement ${anchor.slice(4)}`;
        if (anchor.startsWith('d-')) return `Decision ${anchor.slice(2)}`;
        if (anchor.startsWith('q-')) return qLabelByAnchor.get(anchor) ?? anchor;
        return parityState.blockTitleByAnchor.get(anchor) ?? anchor;
      };
      for (const page of manifest.pages) {
        const hGaps = parityState.htmlGapsByPage.get(page.id);
        const mGaps = parityState.mdGapsByPage.get(page.id);
        if (hGaps && mGaps && JSON.stringify(hGaps) !== JSON.stringify(mGaps)) {
          findings.add('reading-order', page.markdown, `Explicit gaps section on ${page.markdown} disagrees with ${page.html}`);
        }
        const hEvs = parityState.htmlEvByPage.get(page.id);
        const mEvs = parityState.mdEvByPage.get(page.id);
        if (hEvs && mEvs) {
          const evSame = hEvs.length === mEvs.length
            && hEvs.every((he, idx) => {
              const me = mEvs[idx];
              return he.id === me.id
                && he.label === me.label
                && he.title === me.title
                && he.kind === me.kind
                && he.bytes === me.bytes
                && he.reason === me.reason;
            });
          if (!evSame) {
            findings.add('reading-order', page.markdown, `Evidence section on ${page.markdown} disagrees with ${page.html}`);
          }
        }
        if (hEvs) {
          for (const he of hEvs) {
            if (Array.isArray(he.citedLinks)) {
              for (const cl of he.citedLinks) {
                if (cl.label !== expectedCitedLabel(cl.anchor)) {
                  findings.add('reading-order', page.html, `Evidence Cited by label for #${cl.anchor} disagrees with target title on ${page.html}`);
                }
              }
            }
          }
        }
      }

      if (hasPulseCss && allAreaPages.length > 0 && !parityState.portfolioAreaChartRows) {
        findings.add('reading-order', 'index.html', 'missing .sitrep-area-chart workload chart on portfolio page in HTML');
      }
      if (allAreaPages.length === 0 && parityState.portfolioAreaChartRows) {
        findings.add('reading-order', 'index.html', 'unexpected .sitrep-area-chart on portfolio page with zero areas in HTML');
      }
      if (parityState.portfolioAreaChartRows) {
        const leftPad = 204;
        const plotW = 356;
        const topPad = 40;
        const rowH = 34;
        const barH = 14;
        const maxTotal = Math.max(1, ...allAreaPages.map((ap2) => {
          const ac2 = parityState.areaCountsByPage.get(ap2.id);
          if (!ac2 || ac2.coverage === 'unavailable') return 0;
          return (ac2.moved ?? 0) + (ac2.waiting ?? 0) + (ac2.blocked ?? 0);
        }));
        const sameRects = (actualRects, expRects) => actualRects.length === expRects.length
          && expRects.every((er, ri) => {
            const ar = actualRects[ri];
            return ar.cls === er.cls
              && ar.y === er.y
              && ar.height === er.height
              && Math.abs(ar.x - er.x) <= 0.015
              && Math.abs(ar.width - er.width) <= 0.015;
          });
        const chartOk = parityState.portfolioAreaChartRows.length === allAreaPages.length
          && allAreaPages.every((ap, idx) => {
            const ac = parityState.areaCountsByPage.get(ap.id);
            const row = parityState.portfolioAreaChartRows[idx];
            if (!ac || !row) return false;
            const y = topPad + idx * rowH;
            const barY = y + 7;
            const textY = y + 18;
            const expLabel = clampSvgLabelText(ap.title, 180, 11.5, false).trim();
            if (row.label !== expLabel || row.labelCls !== 'svg-row-label' || row.labelX !== 12 || row.labelY !== textY) {
              return false;
            }
            if (row.summaryX !== leftPad + plotW + 12 || row.summaryY !== textY) {
              return false;
            }
            if (ac.coverage === 'unavailable') {
              return row.summary === 'telemetry unavailable'
                && row.summaryCls === 'svg-axis-label'
                && sameRects(row.rects, [{ cls: 'svg-area-unavail', x: leftPad, y: barY, width: plotW, height: barH }]);
            }
            const m = ac.moved ?? 0;
            const w = ac.waiting ?? 0;
            const b = ac.blocked ?? 0;
            const bLabel = ac.blocked === null ? '—B' : `${b}B`;
            const qual = ac.coverage === 'partial' ? ' (partial)' : '';
            const expSummary = clampSvgLabelText(`${m}M · ${w}W · ${bLabel}${qual}`, 210, 10.5, true).trim();
            const expSummaryCls = b > 0 ? 'svg-delta.svg-delta--warn' : 'svg-delta.svg-delta--good';
            const [wMoved, wWait, wBlock] = computeSitrepBarSegmentsLocal(m, w, b, maxTotal, plotW);
            const xWait = Number((leftPad + wMoved).toFixed(2));
            const xBlock = Number((xWait + wWait).toFixed(2));
            const expRects = [
              { cls: 'bar__track', x: leftPad, y: barY, width: plotW, height: barH },
              ...(m > 0 ? [{ cls: 'svg-seg-moved', x: leftPad, y: barY, width: wMoved, height: barH }] : []),
              ...(w > 0 ? [{ cls: 'bar__candidate', x: xWait, y: barY, width: wWait, height: barH }] : []),
              ...(b > 0 ? [{ cls: 'svg-seg-blocked', x: xBlock, y: barY, width: wBlock, height: barH }] : []),
            ];
            return row.summary === expSummary
              && row.summaryCls === expSummaryCls
              && sameRects(row.rects, expRects);
          });
        if (!chartOk) {
          findings.add('reading-order', 'index.html', '.sitrep-area-chart workload chart disagrees with SitRep area telemetry on index.html');
        }
      }
    }
  }

  const cssHtmlOptions = { hasCmpSideCode: false, hasEvPreview: false, hasCodeCaption: false };
  for (const inspected of inspectedByPage.values()) {
    for (const el of inspected.elements) {
      if (el.classes.has('cmp-side__code')) cssHtmlOptions.hasCmpSideCode = true;
      if (el.classes.has('ev-preview')) cssHtmlOptions.hasEvPreview = true;
      if (el.classes.has('code__caption')) cssHtmlOptions.hasCodeCaption = true;
    }
  }
  for (const sheet of stylesheets) {
    for (const problem of scanCssPolicy(sheet.text, declared, cssHtmlOptions)) findings.add('unsafe-content', sheet.path, problem);
  }

  return {
    ok: findings.errors.length === 0,
    contentId: declaredId,
    recomputedContentId: recomputedId,
    manifestSha256,
    fileCount: files.length + 2,
    totalBytes: total,
    errors: findings.errors,
  };
}

// Dispatches site-bundle/v1 directories to verifySiteBundle and everything else to verifyPacket.
export async function verifyArtifact(dir) {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.schema === 'site-bundle/v1') {
      return verifySiteBundle(dir);
    }
  } catch {
    // Fall through to verifyPacket so missing/malformed manifest reporting is unchanged.
  }
  return verifyPacket(dir);
}
