// Independent packet/v1 verifier.
//
// Deliberately does not import the builder, renderer, or shared canonical-JSON
// module: it re-derives canonical bytes, digests, and the content ID from the
// packet alone, so a builder defect cannot be masked by shared code. It reports
// every mismatch it finds and never writes to the packet.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const LIMITS = { files: 64, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, manifestBytes: 1024 * 1024 };
const MEDIA = { html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json' };
const PATH_RULES = [
  { re: /^index\.html$/, role: 'entry' },
  { re: /^report\.md$/, role: 'report' },
  { re: /^assets\/([0-9a-f]{64})\.css$/, role: 'asset' },
  { re: /^assets\/([0-9a-f]{64})\.woff2$/, role: 'asset' },
  { re: /^evidence\/([0-9a-f]{64})\.(txt|csv|json)$/, role: 'evidence' },
];
// render-policy/2 (docs/decisions/render-policy-2.md R2): a policy/2 packet also carries
// its canonical report/v1 source as report.json. The inventory rules are per policy, so a
// policy/1 packet that has report.json still fails on PATH_RULES.
const RENDER_POLICY_1 = 'render-policy/1';
const RENDER_POLICY_2 = 'render-policy/2';
// render-policy/2 build metadata (review 2 MAJOR A, Captain's ruling): the tool is exactly
// canon, the security policy is a known one, the version is a strict semver 2.0.0 core
// MAJOR.MINOR.PATCH: decimal numbers with no leading zero (a lone 0 is allowed), and no
// pre-release or build suffix. Any release is accepted, so packets from older releases keep
// verifying; the builder imports this pattern rather than keeping its own. Kept here, with
// no import, like the policy names above; test/unit/rp2-verify.test.mjs holds them equal to src/policy.mjs (TOOL.name,
// SECURITY_POLICIES), and the builder refuses the same values. Policy/1 manifests are frozen
// and keep their laxity (a recorded limit, render-policy-2.md R11).
export const BUILD_TOOL_2 = 'canon';
export const SECURITY_POLICIES_2 = Object.freeze(['security-policy/1']);
export const BUILD_VERSION_RE_2 = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PATH_RULES_2 = [...PATH_RULES, { re: /^report\.json$/, role: 'source' }];
const CONTROL_FILES = new Set(['manifest.json', 'checksums.json']);
const ALLOWED_DIRS = new Set(['assets', 'evidence']);
const HEX64 = /^[0-9a-f]{64}$/;
const CONTENT_ID = /^sha256-[0-9a-f]{64}$/;

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

// Walk the packet with lstat. Symlinks and special files are reported, never followed.
async function walk(root, findings) {
  const found = new Map();
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
        findings.add('symlink', relPath, 'symbolic links are not allowed in a packet');
      } else if (st.isDirectory()) {
        if (depth > 0 || !ALLOWED_DIRS.has(name)) findings.add('unexpected-directory', relPath, 'packets contain only assets/ and evidence/ directories');
        else await visit(abs, relPath, depth + 1);
      } else if (!st.isFile()) {
        findings.add('special-file', relPath, 'device, FIFO, or socket in packet');
      } else {
        total += st.size;
        found.set(relPath, { abs, size: st.size });
      }
    }
  }
  await visit(root, '', 0);
  return { found, total };
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
  // Canonical form is checked on bytes: duplicate keys, reordering, whitespace,
  // or number reformatting all make the stored bytes differ from canonical(value).
  if (canonical(value) !== bytes.toString('utf8')) findings.add('not-canonical', name, 'bytes are not the canonical JSON serialization (duplicate keys, ordering, or whitespace)');
  return { value, bytes };
}

// R1: the verifier selects its rules from manifest.build.renderPolicy. Any other value is
// an error, checked against the policy/1 rules so the report still lists every mismatch.
function manifestRenderPolicy(m) {
  const value = m?.build?.renderPolicy;
  return value === RENDER_POLICY_2 ? RENDER_POLICY_2 : RENDER_POLICY_1;
}

function checkManifestShape(m, findings) {
  const policy = manifestRenderPolicy(m);
  const v2 = policy === RENDER_POLICY_2;
  const pathRules = v2 ? PATH_RULES_2 : PATH_RULES;
  // agentEntry is optional so packets built before it was introduced still verify;
  // when present it must name report.md and the anchor convention exactly.
  const keys = ['schema', 'entry', 'report', 'files', 'evidence', 'build', 'contentId', ...(Object.hasOwn(m ?? {}, 'agentEntry') ? ['agentEntry'] : [])];
  if (!exactKeys(m, keys)) {
    findings.add('schema', 'manifest.json', 'manifest must have exactly schema, entry, report, files, evidence, build, contentId, and optionally agentEntry');
  }
  if (Object.hasOwn(m ?? {}, 'agentEntry') && (!exactKeys(m.agentEntry, ['path', 'anchors']) || m.agentEntry.path !== 'report.md' || m.agentEntry.anchors !== 'reference-definitions/1')) {
    findings.add('agent-entry', 'manifest.json#/agentEntry', 'agentEntry must be {"path":"report.md","anchors":"reference-definitions/1"}');
  }
  if (m.schema !== 'packet/v1') findings.add('schema-version', 'manifest.json#/schema', `expected packet/v1, found ${JSON.stringify(m.schema)}`);
  if (m.entry !== 'index.html') findings.add('entry', 'manifest.json#/entry', 'entry point must be index.html');
  if (!CONTENT_ID.test(m.contentId ?? '')) findings.add('content-id', 'manifest.json#/contentId', 'malformed content ID');
  // R8: reissueOf is a policy/2 field. Under policy/1 it is not an allowed key, so a
  // policy/1 manifest that carries it fails exactly as any unknown key does.
  const hasReissueOf = v2 && Object.hasOwn(m.report ?? {}, 'reissueOf');
  const reportKeys = ['schema', 'id', 'title', 'status', 'classification', 'reviewDate', 'sourceSha256', ...(Object.hasOwn(m.report ?? {}, 'publication') ? ['publication'] : []), ...(hasReissueOf ? ['reissueOf'] : [])];
  const pub = m.report?.publication;
  const pubOk = pub === undefined || (pub !== null && typeof pub === 'object' && !Array.isArray(pub)
    && Object.keys(pub).every((k) => ['classification', 'dataOrigin'].includes(k))
    && (pub.classification === undefined || ['public', 'private-review', 'confidential'].includes(pub.classification))
    && (pub.dataOrigin === undefined || ['synthetic', 'production'].includes(pub.dataOrigin)));
  if (!exactKeys(m.report, reportKeys) || !pubOk || m.report.schema !== 'report/v1' || !HEX64.test(m.report.sourceSha256 ?? '')) {
    findings.add('schema', 'manifest.json#/report', 'report metadata is malformed');
  }
  if (hasReissueOf && (!CONTENT_ID.test(m.report.reissueOf ?? '') || m.report.reissueOf === m.contentId)) {
    findings.add('reissue-of', 'manifest.json#/report/reissueOf', 'reissueOf must be the content ID of another packet');
  }
  if (!exactKeys(m.build, ['tool', 'version', 'renderPolicy', 'securityPolicy'])) findings.add('schema', 'manifest.json#/build', 'build metadata is malformed');
  if (m.build?.renderPolicy !== RENDER_POLICY_1 && m.build?.renderPolicy !== RENDER_POLICY_2) {
    findings.add('render-policy', 'manifest.json#/build/renderPolicy', `expected ${RENDER_POLICY_1} or ${RENDER_POLICY_2}, found ${JSON.stringify(m.build?.renderPolicy)}`);
  }
  if (v2) {
    if (m.build?.tool !== BUILD_TOOL_2) findings.add('build', 'manifest.json#/build/tool', `expected ${JSON.stringify(BUILD_TOOL_2)}, found ${JSON.stringify(m.build?.tool)}`);
    if (!SECURITY_POLICIES_2.includes(m.build?.securityPolicy)) findings.add('build', 'manifest.json#/build/securityPolicy', `expected one of ${SECURITY_POLICIES_2.join(', ')}, found ${JSON.stringify(m.build?.securityPolicy)}`);
    if (typeof m.build?.version !== 'string' || !BUILD_VERSION_RE_2.test(m.build.version)) findings.add('build', 'manifest.json#/build/version', `expected a semver version (major.minor.patch), found ${JSON.stringify(m.build?.version)}`);
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
    const rule = pathRules.find((r) => r.re.test(f.path));
    if (!rule) findings.add('unsafe-path', where, `path ${JSON.stringify(f.path)} is not a canonical packet path`);
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
  if (!files.some((f) => f.path === 'index.html')) findings.add('entry', 'manifest.json#/files', 'entry point is not in the inventory');
  if (!files.some((f) => f.path === 'report.md')) findings.add('report', 'manifest.json#/files', 'agent-readable report.md is not in the inventory');
  if (v2 && !files.some((f) => f.path === 'report.json')) findings.add('source', 'manifest.json#/files', 'render-policy/2 packet has no report.json source in the inventory');
  const byPath = new Map(files.map((f) => [f.path, f]));
  if (!Array.isArray(m.evidence)) {
    findings.add('schema', 'manifest.json#/evidence', 'evidence must be an array');
  } else {
    const referenced = new Set();
    m.evidence.forEach((ev, i) => {
      const where = `manifest.json#/evidence/${i}`;
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
      if (!Array.isArray(ev?.citedBy)) findings.add('schema', where, 'citedBy must be an array');
    });
    for (const f of files) if (f.role === 'evidence' && !referenced.has(f.path)) findings.add('evidence-relation', f.path, 'evidence file has no evidence relation');
  }
  return files;
}

// Defense in depth: the builder never emits these, so their presence means the
// packet was not produced by the policy-conforming renderer.
// Only markup is scanned: in renderer output every authored "<" is escaped, so
// escaped text such as "&lt;img onerror=...&gt;" is content, not a tag.
const FORBIDDEN_ELEMENTS = /^(?:script|style|iframe|object|embed|frame|frameset|base|form|input|button|select|textarea|template|xmp|plaintext|noembed|noframes|noscript|audio|video|source|track|portal|link|meta|img|picture|math|foreignobject|use|image|animate|set)$/i;
const ALLOWED_LINK = /^link$/i;
const ALLOWED_META = /^meta$/i;
const HTML_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;

const HEAD_VOID_ELEMENTS = new Set(['meta', 'link']);
const BODY_VOID_ELEMENTS = new Set(['br', 'hr', 'wbr']);
const BODY_ELEMENTS = new Set([
  'header', 'nav', 'main', 'footer', 'section', 'article', 'aside', 'div', 'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'figure', 'figcaption', 'pre', 'code', 'blockquote', 'details', 'summary',
  'a', 'span', 'strong', 'em', 'small', 'b', 'i', 'u', 's', 'sub', 'sup',
  'kbd', 'samp', 'var', 'mark', 'del', 'ins', 'abbr', 'dfn', 'time', 'q', 'cite',
]);
const SVG_SHAPE_ELEMENTS = new Set(['rect', 'line', 'path', 'circle', 'polygon', 'polyline', 'ellipse']);
const SVG_CONTAINER_ELEMENTS = new Set(['g', 'text', 'tspan']);
const P_IMPLICIT_CLOSE_ELEMENTS = new Set([
  'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
const HEADING_ELEMENTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const NO_ID_ELEMENTS = new Set(['html', 'head', 'meta', 'title', 'link']);
const WHITESPACE_ONLY_CONTAINERS = new Set(['html', 'head', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'dl']);

const TEXT_LABEL_ATTRS = new Set(['content', 'title', 'aria-label']);
const URL_SINK_ATTRS = new Set(['href', 'src', 'srcset', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'ping', 'attributionsrc']);
const ALLOWED_HTML_ATTRS = new Set([
  'id', 'class', 'href', 'rel', 'target', 'referrerpolicy', 'title', 'lang', 'dir', 'role', 'tabindex',
  'open', 'scope', 'colspan', 'rowspan', 'headers', 'charset', 'name', 'http-equiv', 'content', 'type',
  'aria-current', 'aria-hidden', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-expanded', 'aria-controls',
]);
const ALLOWED_SVG_ATTRS = new Set([
  'id', 'class', 'role', 'focusable', 'aria-hidden', 'aria-label', 'aria-labelledby', 'aria-describedby',
  'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'fill-opacity', 'stroke-opacity', 'text-anchor', 'dominant-baseline', 'transform', 'dx', 'dy',
]);
const DATA_ATTR_RE = /^data-[a-z0-9-]+$/;

function decodeNumericEntity(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '\uFFFD';
  return String.fromCodePoint(cp);
}

export function decodeHtmlAttr(raw) {
  return raw
    .replace(/&#x0*([0-9a-f]{1,6}|0);?/gi, (_, hex) => decodeNumericEntity(parseInt(hex, 16)))
    .replace(/&#0*([0-9]{1,7}|0);?/g, (_, dec) => decodeNumericEntity(parseInt(dec, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

// WHATWG HTML5 (§13.2.5) and WHATWG DOM (§6.1) define ASCII whitespace strictly
// as U+0009 TAB, U+000A LF, U+000C FF, U+000D CR, and U+0020 SPACE — never JS \s.
function tokenizeTagAttributes(attrs, tagName, problems) {
  const parsed = [];
  const tokenRe = /[\t\n\f\r ]+([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:="([^">]*)"|(?=[\t\n\f\r ]|\/|$))/y;
  let pos = 0;
  let isSelfClosing = false;
  let malformed = false;
  while (pos < attrs.length) {
    const tail = /^[\t\n\f\r ]*(\/?)[\t\n\f\r ]*$/.exec(attrs.slice(pos));
    if (tail) {
      isSelfClosing = tail[1] === '/';
      break;
    }
    tokenRe.lastIndex = pos;
    const m = tokenRe.exec(attrs);
    if (!m) {
      malformed = true;
      const rest = attrs.slice(pos);
      if (/^[\t\n\f\r /]*(?:href|src|srcset|xlink:href|action|formaction|poster|background|ping|attributionsrc)[\t\n\f\r ]*=/i.test(rest)) {
        problems.push(`unquoted or single-quoted URL attribute on <${tagName}>`);
      } else if (/^[\t\n\f\r /]*on[a-z]+[\t\n\f\r ]*=/i.test(rest)) {
        problems.push(`inline event handler attribute on <${tagName}>`);
      } else if (/^[\t\n\f\r /]*style[\t\n\f\r ]*=/i.test(rest)) {
        problems.push(`inline style attribute on <${tagName}>`);
      } else {
        problems.push(`malformed or non-double-quoted attribute on <${tagName}>`);
      }
      // Also scan the unparsed tail conservatively so hidden trailing handlers/styles are reported
      if (/(?:^|[\s/"'])on[a-z]+\s*=/i.test(rest)) problems.push(`inline event handler attribute on <${tagName}>`);
      if (/(?:^|[\s/"'])style\s*=/i.test(rest)) problems.push(`inline style attribute on <${tagName}>`);
      break;
    }
    parsed.push({ name: m[1], lower: m[1].toLowerCase(), hasValue: m[2] !== undefined, rawValue: m[2] ?? '' });
    pos = tokenRe.lastIndex;
  }
  return { parsed, isSelfClosing, malformed };
}

function checkDlTermContext(stack) {
  let dlIdx = -1;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].tag === 'dl') {
      dlIdx = i;
      break;
    }
  }
  if (dlIdx < 0) return false;
  for (let i = dlIdx + 1; i < stack.length; i += 1) {
    if (stack[i].tag !== 'div') return false;
  }
  return true;
}

// lockupSvgAttrs (render-policy/2 only): the extra presentation attributes the Canon
// lockup artwork may carry. They are accepted only inside an <svg class="lockup ...">,
// never on plate or chart SVG, so the plate attribute rules stay exactly policy/1's.
export function inspectHtmlDocument(html, { alternateHref = 'report.md', lockupSvgAttrs = null } = {}) {
  const problems = [];
  const idProblems = [];
  const ids = new Set();
  const elements = [];
  const stylesheetHrefs = [];
  const hrefChecks = [];

  if (html.includes('\u0000')) problems.push('NUL character in HTML');

  const doctypeMatch = /^[\t\n\f\r ]*<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/i.exec(html);
  let cursor = 0;
  if (!doctypeMatch) {
    problems.push('missing <!doctype html> declaration');
  } else {
    cursor = doctypeMatch[0].length;
  }

  const stack = [];
  let svgDepth = 0;
  let inLockupSvg = false;
  let seenHtml = false;
  let seenHead = false;
  let headClosed = false;
  let seenBody = false;
  let bodyClosed = false;
  let htmlClosed = false;
  let seenTitle = false;
  let cspMetaCount = 0;
  let referrerMetaCount = 0;

  const exactCspRe = /^[\t\n\f\r ]+http-equiv="Content-Security-Policy"[\t\n\f\r ]+content="default-src &#39;none&#39;; style-src &#39;self&#39;; img-src &#39;self&#39;; font-src &#39;(?:self|none)&#39;; script-src &#39;none&#39;; connect-src &#39;none&#39;; media-src &#39;none&#39;; object-src &#39;none&#39;; frame-src &#39;none&#39;; worker-src &#39;none&#39;; manifest-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"$/;
  const closeRe = /<\/([a-zA-Z][a-zA-Z0-9-]*)[\t\n\f\r ]*>/y;
  const openRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/y;
  const altRe = new RegExp(`^[\\t\\n\\f\\r ]+rel="alternate"[\\t\\n\\f\\r ]+type="text\\/markdown"[\\t\\n\\f\\r ]+href="${alternateHref.replace('.', '\\.')}"[\\t\\n\\f\\r ]+title="Agent-readable report"$`);

  while (cursor < html.length) {
    const lt = html.indexOf('<', cursor);
    const textChunk = lt < 0 ? html.slice(cursor) : html.slice(cursor, lt);
    const topFrame = stack.length > 0 ? stack[stack.length - 1] : null;
    const topTag = topFrame ? topFrame.tag : null;
    if (textChunk.length > 0 && topFrame?.element) {
      topFrame.element.ownText += textChunk;
      topFrame.element.nodes.push({ kind: 'text', value: textChunk });
    }
    if (textChunk.length > 0 && (topTag === null || WHITESPACE_ONLY_CONTAINERS.has(topTag))) {
      if (!/^[\t\n\f\r ]*$/.test(textChunk)) {
        problems.push(`unexpected non-whitespace text directly inside ${topTag ? `<${topTag}>` : 'document root'}`);
      }
    }
    if (lt < 0) break;

    closeRe.lastIndex = lt;
    const closeMatch = closeRe.exec(html);
    if (closeMatch) {
      const rawClose = closeMatch[1];
      const lowerClose = rawClose.toLowerCase();
      if (rawClose !== lowerClose) problems.push(`non-lowercase closing tag </${rawClose}>`);
      if (!topFrame || topFrame.tag !== lowerClose) {
        problems.push(`unexpected closing tag </${rawClose}>`);
      } else {
        const popped = stack.pop();
        if (popped.element) popped.element.closeIndex = closeRe.lastIndex;
        if (lowerClose === 'svg') {
          svgDepth -= 1;
          if (svgDepth === 0) inLockupSvg = false;
        }
        else if (lowerClose === 'head') headClosed = true;
        else if (lowerClose === 'body') bodyClosed = true;
        else if (lowerClose === 'html') htmlClosed = true;
      }
      cursor = closeRe.lastIndex;
      continue;
    }

    openRe.lastIndex = lt;
    const openMatch = openRe.exec(html);
    if (!openMatch) {
      problems.push('unescaped "<" or malformed HTML tag');
      break;
    }

    const [, rawName, attrs] = openMatch;
    const lowerName = rawName.toLowerCase();
    cursor = openRe.lastIndex;

    if (ALLOWED_LINK.test(rawName)) {
      const mCss = /^[\t\n\f\r ]+rel="stylesheet"[\t\n\f\r ]+href="([^"]+)"$/.exec(attrs);
      if (mCss) {
        stylesheetHrefs.push(mCss[1]);
      } else if (!altRe.test(attrs)) {
        problems.push(`link element other than a fingerprinted stylesheet or ${alternateHref} alternate`);
      }
    } else if (ALLOWED_META.test(rawName)) {
      if (/http-equiv="refresh"/i.test(attrs)) problems.push('meta refresh');
      if (/^[\t\n\f\r ]+charset="utf-8"$/.test(attrs)) {
        // valid charset meta
      } else if (exactCspRe.test(attrs)) {
        if (topTag === 'head') cspMetaCount += 1;
      } else if (/^[\t\n\f\r ]+name="referrer"[\t\n\f\r ]+content="no-referrer"$/.test(attrs)) {
        if (topTag === 'head') referrerMetaCount += 1;
      } else if (/^[\t\n\f\r ]+name="(?:viewport|color-scheme|generator)"[\t\n\f\r ]+content="[^"]*"$/.test(attrs)) {
        // valid document metadata
      } else {
        problems.push('unexpected meta element');
      }
    } else if (FORBIDDEN_ELEMENTS.test(rawName)) {
      problems.push(`<${rawName}> element`);
    }

    if (rawName !== lowerName) problems.push(`non-lowercase tag <${rawName}>`);

    const { parsed: parsedAttrs, isSelfClosing, malformed } = tokenizeTagAttributes(attrs, rawName, problems);

    let structurallyValid = true;
    const inSvgElement = svgDepth > 0 || lowerName === 'svg';
    const stackDepthBefore = stack.length;

    if (lowerName === 'html') {
      if (stack.length !== 0 || seenHtml || isSelfClosing) {
        problems.push('unexpected or duplicate <html> element');
        structurallyValid = false;
      } else {
        seenHtml = true;
        stack.push({ tag: 'html' });
      }
    } else if (lowerName === 'head') {
      if (stack.length !== 1 || topTag !== 'html' || seenHead || seenBody || isSelfClosing) {
        problems.push('unexpected or duplicate <head> element');
        structurallyValid = false;
      } else {
        seenHead = true;
        stack.push({ tag: 'head' });
      }
    } else if (lowerName === 'body') {
      if (stack.length !== 1 || topTag !== 'html' || !headClosed || seenBody || isSelfClosing) {
        problems.push('unexpected or duplicate <body> element');
        structurallyValid = false;
      } else {
        seenBody = true;
        stack.push({ tag: 'body' });
      }
    } else if (HEAD_VOID_ELEMENTS.has(lowerName)) {
      if (topTag !== 'head' || isSelfClosing) {
        problems.push(`<${rawName}> element outside <head> or self-closing`);
        structurallyValid = false;
      }
    } else if (lowerName === 'title') {
      if (topTag !== 'head' || seenTitle || isSelfClosing) {
        problems.push('unexpected, duplicate, or self-closing <title> element');
        structurallyValid = false;
      }
      seenTitle = true;
      const titleCloseRe = /<\/title([\t\n\f\r ]*)>/gi;
      titleCloseRe.lastIndex = cursor;
      const tc = titleCloseRe.exec(html);
      if (!tc) {
        problems.push('unclosed <title> element');
        break;
      }
      const titleBody = html.slice(cursor, tc.index);
      if (titleBody.includes('<')) problems.push('raw "<" inside <title> RCDATA');
      if (html.slice(tc.index, tc.index + 7) !== '</title') problems.push('non-lowercase </title> tag');
      cursor = titleCloseRe.lastIndex;
    } else if (svgDepth > 0) {
      if (SVG_SHAPE_ELEMENTS.has(lowerName) || SVG_CONTAINER_ELEMENTS.has(lowerName)) {
        if (!isSelfClosing) stack.push({ tag: lowerName });
      } else {
        problems.push(`disallowed element <${rawName}> inside <svg>`);
        structurallyValid = false;
      }
    } else {
      if (!seenBody || bodyClosed || !stack.some((f) => f.tag === 'body')) {
        problems.push(`<${rawName}> outside <body>`);
        structurallyValid = false;
      } else if (isSelfClosing) {
        problems.push(`self-closing syntax on HTML element <${rawName}>`);
        structurallyValid = false;
      } else if (topTag === 'table') {
        if (lowerName === 'caption') {
          if (topFrame.seenCaption || topFrame.seenTableSection) {
            problems.push('unexpected <caption> ordering inside <table>');
            structurallyValid = false;
          } else {
            topFrame.seenCaption = true;
            stack.push({ tag: 'caption' });
          }
        } else if (lowerName === 'thead' || lowerName === 'tbody' || lowerName === 'tfoot' || lowerName === 'tr') {
          topFrame.seenTableSection = true;
          stack.push({ tag: lowerName });
        } else {
          problems.push(`disallowed element <${rawName}> directly inside <table>`);
          structurallyValid = false;
        }
      } else if (topTag === 'thead' || topTag === 'tbody' || topTag === 'tfoot') {
        if (lowerName === 'tr') {
          stack.push({ tag: 'tr' });
        } else {
          problems.push(`disallowed element <${rawName}> directly inside <${topTag}>`);
          structurallyValid = false;
        }
      } else if (topTag === 'tr') {
        if (lowerName === 'td' || lowerName === 'th') {
          stack.push({ tag: lowerName });
        } else {
          problems.push(`disallowed element <${rawName}> directly inside <tr>`);
          structurallyValid = false;
        }
      } else if (topTag === 'ul' || topTag === 'ol') {
        if (lowerName === 'li') {
          stack.push({ tag: 'li' });
        } else {
          problems.push(`disallowed element <${rawName}> directly inside <${topTag}>`);
          structurallyValid = false;
        }
      } else if (lowerName === 'caption' || lowerName === 'thead' || lowerName === 'tbody' || lowerName === 'tfoot' || lowerName === 'tr' || lowerName === 'td' || lowerName === 'th') {
        problems.push(`<${rawName}> outside required <table> context`);
        structurallyValid = false;
      } else if (lowerName === 'li') {
        problems.push('<li> outside <ul> or <ol>');
        structurallyValid = false;
      } else if (lowerName === 'svg') {
        stack.push({ tag: 'svg' });
        svgDepth += 1;
      } else if (BODY_VOID_ELEMENTS.has(lowerName)) {
        if (lowerName === 'hr' && stack.some((f) => f.tag === 'p')) {
          problems.push('<hr> inside <p> implicitly closes <p>');
          structurallyValid = false;
        }
      } else if (lowerName === 'table') {
        if (stack.some((f) => f.tag === 'p' || f.tag === 'a' || f.tag === 'caption')) {
          problems.push('<table> inside <p>, <a>, or <caption>');
          structurallyValid = false;
        } else {
          stack.push({ tag: 'table', seenCaption: false, seenTableSection: false });
        }
      } else if (BODY_ELEMENTS.has(lowerName)) {
        if (lowerName === 'a' && stack.some((f) => f.tag === 'a')) {
          problems.push('nested <a> inside <a>');
          structurallyValid = false;
        } else if (P_IMPLICIT_CLOSE_ELEMENTS.has(lowerName) && stack.some((f) => f.tag === 'p')) {
          problems.push(`<${rawName}> inside <p> implicitly closes <p>`);
          structurallyValid = false;
        } else if (HEADING_ELEMENTS.has(lowerName) && stack.some((f) => HEADING_ELEMENTS.has(f.tag))) {
          problems.push(`nested heading <${rawName}>`);
          structurallyValid = false;
        } else if ((lowerName === 'dt' || lowerName === 'dd') && !checkDlTermContext(stack)) {
          problems.push(`<${rawName}> outside <dl> context`);
          structurallyValid = false;
        } else {
          stack.push({ tag: lowerName });
        }
      } else {
        if (!FORBIDDEN_ELEMENTS.test(rawName)) problems.push(`disallowed element <${rawName}>`);
        structurallyValid = false;
      }
    }

    const parentElement = stackDepthBefore > 0 ? stack[stackDepthBefore - 1].element ?? null : null;
    const elRecord = {
      tag: lowerName,
      id: null,
      href: null,
      classes: new Set(),
      attrs: new Map(),
      ariaHidden: null,
      ariaLabel: null,
      dataRec: null,
      ownText: '',
      nodes: [],
      parent: parentElement,
      children: [],
      openIndex: lt,
      closeIndex: cursor,
    };
    if (stack.length > stackDepthBefore) {
      stack[stack.length - 1].element = elRecord;
    }

    const seenAttrNames = new Set();
    let idAttrCount = 0;
    for (const attr of parsedAttrs) {
      if (attr.lower === 'id') idAttrCount += 1;
      if (seenAttrNames.has(attr.lower)) {
        problems.push(`duplicate attribute ${attr.name} on <${rawName}>`);
      }
      seenAttrNames.add(attr.lower);
      elRecord.attrs.set(attr.lower, attr.hasValue ? decodeHtmlAttr(attr.rawValue) : '');
    }
    if (idAttrCount > 1) {
      const msg = `multiple id attributes on <${rawName}>`;
      problems.push(msg);
      idProblems.push(msg);
    }

    const classAttr = parsedAttrs.find((a) => a.lower === 'class');
    if (classAttr?.hasValue) {
      for (const tok of decodeHtmlAttr(classAttr.rawValue).split(/[\t\n\f\r ]+/).filter(Boolean)) {
        elRecord.classes.add(tok);
      }
    }

    // Lockup attributes only inside the two brand slots html-v2 fills (masthead brand,
    // colophon mark), never on an svg.lockup placed anywhere else.
    const inBrandSlot = parentElement !== null && ((parentElement.tag === 'span' && parentElement.classes.has('masthead__brand')) || (parentElement.tag === 'p' && parentElement.classes.has('colophon__mark')));
    if (lockupSvgAttrs && lowerName === 'svg' && svgDepth === 1 && stack.length > stackDepthBefore && elRecord.classes.has('lockup') && inBrandSlot) {
      inLockupSvg = true;
    }

    const relAttr = parsedAttrs.find((a) => a.lower === 'rel');
    const relRaw = relAttr?.hasValue && !relAttr.rawValue.includes('&') ? relAttr.rawValue : '';
    const relTokens = new Set(relRaw.toLowerCase().split(/[\t\n\f\r ]+/).filter(Boolean));

    for (const attr of parsedAttrs) {
      if (/^on[a-z]+$/i.test(attr.lower)) {
        problems.push(`inline event handler attribute on <${rawName}>`);
        continue;
      }
      if (attr.lower === 'style') {
        problems.push(`inline style attribute on <${rawName}>`);
        continue;
      }

      const decoded = decodeHtmlAttr(attr.rawValue);
      if (attr.rawValue.includes('\u0000') || decoded.includes('\u0000')) {
        problems.push(`NUL character in attribute ${attr.name} on <${rawName}>`);
      }
      const compact = decoded.replace(/[\u0000-\u0020]+/g, '');
      const hasDangerousScheme = attr.lower === 'srcset'
        ? compact.split(',').some((c) => /^(?:javascript|vbscript|data):/i.test(c))
        : /^(?:javascript|vbscript|data):/i.test(compact);
      if (!TEXT_LABEL_ATTRS.has(attr.lower) && hasDangerousScheme) {
        problems.push(`javascript:, vbscript:, or data: URL on <${rawName}>`);
      }

      if (URL_SINK_ATTRS.has(attr.lower)) {
        if (!attr.hasValue) {
          problems.push(`unquoted or single-quoted URL attribute on <${rawName}>`);
        } else if (attr.lower !== 'href') {
          problems.push(`${attr.name} attribute on <${rawName}>`);
        } else if (inSvgElement || (lowerName !== 'a' && lowerName !== 'link')) {
          problems.push(`href attribute on <${rawName}>`);
        } else {
          elRecord.href = decoded;
          hrefChecks.push({ tagName: rawName, lowerName, value: decoded, relTokens });
        }
      }

      const expectedExact = lowerName === 'svg' && attr.lower === 'viewbox'
        ? 'viewBox'
        : (lowerName === 'svg' && attr.lower === 'preserveaspectratio' ? 'preserveAspectRatio' : attr.lower);
      if (attr.name !== expectedExact) {
        if (attr.lower === 'id') {
          const msg = `non-lowercase ${attr.name} attribute on <${rawName}>`;
          problems.push(msg);
          idProblems.push(msg);
        } else {
          problems.push(`non-canonical attribute case ${attr.name} on <${rawName}>`);
        }
      }

      const allowedAttr = inSvgElement
        ? (ALLOWED_SVG_ATTRS.has(expectedExact) || DATA_ATTR_RE.test(attr.name) || (inLockupSvg && lockupSvgAttrs.has(attr.name)))
        : ((ALLOWED_HTML_ATTRS.has(attr.lower) && ((attr.lower !== 'charset' && attr.lower !== 'http-equiv' && attr.lower !== 'content') || lowerName === 'meta'))
          || DATA_ATTR_RE.test(attr.name));
      if (!allowedAttr && !URL_SINK_ATTRS.has(attr.lower)) {
        problems.push(`disallowed attribute ${attr.name} on <${rawName}>`);
      }

      if (inSvgElement && !TEXT_LABEL_ATTRS.has(attr.lower) && /url[\t\n\f\r ]*\(/i.test(decoded)) {
        problems.push(`CSS url() reference in SVG attribute ${attr.name} on <${rawName}>`);
      }

      if (attr.lower === 'id') {
        if (NO_ID_ELEMENTS.has(lowerName)) {
          const msg = `id attribute not allowed on <${rawName}>`;
          problems.push(msg);
          idProblems.push(msg);
        } else if (!attr.hasValue || attr.rawValue.includes('&') || !HTML_ID_PATTERN.test(decoded)) {
          const msg = `invalid or entity-encoded id=${JSON.stringify(attr.rawValue)} on <${rawName}>`;
          problems.push(msg);
          idProblems.push(msg);
        } else if (ids.has(decoded)) {
          const msg = `duplicate HTML id="${decoded}"`;
          problems.push(msg);
          idProblems.push(msg);
        } else if (structurallyValid && !malformed && attr.name === 'id' && idAttrCount === 1) {
          ids.add(decoded);
          elRecord.id = decoded;
        }
      }
    }

    const ariaHiddenAttr = parsedAttrs.find((a) => a.lower === 'aria-hidden');
    if (ariaHiddenAttr?.hasValue) {
      elRecord.ariaHidden = decodeHtmlAttr(ariaHiddenAttr.rawValue).trim().toLowerCase();
    }
    const ariaLabelAttr = parsedAttrs.find((a) => a.lower === 'aria-label');
    if (ariaLabelAttr?.hasValue) {
      elRecord.ariaLabel = decodeHtmlAttr(ariaLabelAttr.rawValue);
    }
    const dataRecAttr = parsedAttrs.find((a) => a.lower === 'data-rec');
    if (dataRecAttr?.hasValue) {
      elRecord.dataRec = decodeHtmlAttr(dataRecAttr.rawValue);
    }

    if (structurallyValid && !malformed) {
      if (parentElement) {
        parentElement.children.push(elRecord);
        parentElement.nodes.push({ kind: 'el', el: elRecord });
      }
      elements.push(elRecord);
    }
  }

  if (!seenHtml || !seenHead || !seenBody || !htmlClosed || stack.length !== 0) {
    problems.push(`incomplete or unclosed HTML document structure (open: ${stack.map((f) => f.tag).join(' > ') || 'none'})`);
  }
  if (cspMetaCount !== 1) problems.push('missing script-src none CSP meta');
  if (referrerMetaCount !== 1) problems.push('missing or duplicate no-referrer meta');

  return { problems, idProblems, ids, elements, stylesheetHrefs, hrefChecks };
}

function pktRawText(el, skipEl = null) {
  if (!el || el === skipEl) return '';
  let out = '';
  for (const nd of el.nodes) {
    if (nd.kind === 'text') out += decodeHtmlAttr(nd.value);
    else out += pktRawText(nd.el, skipEl);
  }
  return out;
}

function navSubtreeText(el) {
  if (!el || el.ariaHidden === 'true' || el.classes.has('visually-hidden') || el.attrs?.has('hidden')) return '';
  let out = decodeHtmlAttr(el.ownText);
  for (const ch of el.children) out += navSubtreeText(ch);
  return out;
}

function isNavNodeHidden(el, stopAt) {
  let cur = el;
  while (cur) {
    if (cur.ariaHidden === 'true' || cur.classes.has('visually-hidden') || cur.attrs?.has('hidden')) return true;
    if (cur === stopAt) break;
    cur = cur.parent;
  }
  return false;
}

function isWsOnlyPkt(str) {
  return /^[\s]*$/.test(decodeHtmlAttr(str ?? ''));
}

function collectNavLinks(olEl, navEl) {
  if (!olEl || olEl.tag !== 'ol' || isNavNodeHidden(olEl, navEl) || !isWsOnlyPkt(olEl.ownText) || olEl.children.length === 0) {
    return null;
  }
  const entries = [];
  for (const li of olEl.children) {
    if (li.tag !== 'li' || isNavNodeHidden(li, navEl) || !isWsOnlyPkt(li.ownText) || li.children.length !== 1) return null;
    const a = li.children[0];
    if (a.tag !== 'a' || isNavNodeHidden(a, navEl) || a.ariaLabel !== null || typeof a.href !== 'string' || !a.href) return null;
    let badge = '';
    let label = '';
    if (a.children.length === 2 && isWsOnlyPkt(a.ownText)) {
      const [bSpan, lSpan] = a.children;
      if (bSpan.tag !== 'span' || bSpan.ariaHidden !== 'true' || bSpan.children.length !== 0) return null;
      if (lSpan.tag !== 'span' || isNavNodeHidden(lSpan, a) || lSpan.children.length !== 0) return null;
      badge = pktRawText(bSpan).trim();
      label = pktRawText(lSpan).trim();
    } else if (a.children.length === 1) {
      const bSpan = a.children[0];
      if (bSpan.tag !== 'span' || bSpan.ariaHidden !== 'true' || bSpan.children.length !== 0 || a.nodes[0]?.kind !== 'el' || a.nodes[0].el !== bSpan) {
        return null;
      }
      badge = pktRawText(bSpan).trim();
      label = decodeHtmlAttr(a.ownText).trim();
    } else {
      return null;
    }
    if (!badge || !label) return null;
    entries.push({ href: a.href, badge, label });
  }
  return entries;
}

function matchesPacketSectionNavEntry(navEntry, secEl, idx) {
  if (!secEl || navEntry.href !== `#${secEl.id}`) return false;
  const h2El = secEl.children.find((c) => c.tag === 'h2' && !isNavNodeHidden(c, secEl));
  if (!h2El) return false;
  const secNumEl = h2El.children.find((c) => c.classes.has('sec-num')) ?? null;
  const secNumText = secNumEl ? pktRawText(secNumEl).trim() : '';
  const h2RawRest = pktRawText(h2El, secNumEl);
  const h2AfterSingleSep = h2RawRest.replace(/^ /, '').trimEnd();
  const h2Title = h2RawRest.trim();
  if (!h2Title) return false;
  const v1Idx = String(idx + 1).padStart(2, '0');
  const { badge, label } = navEntry;
  if (secEl.id === 'summary') {
    return h2Title === 'Executive summary'
      && (label === 'Executive summary' || label === 'Summary')
      && (badge === '§' || badge === v1Idx);
  }
  if (secEl.id === 'evidence') {
    return h2Title === 'Evidence'
      && label === 'Evidence'
      && (badge === 'Ev' || badge === v1Idx);
  }
  if (secEl.id === 'provenance') {
    return h2Title === 'Provenance and packet verification'
      && (label === 'Provenance & verification' || label === 'Provenance and verification')
      && (badge === 'Pr' || badge === v1Idx);
  }
  if (secEl.id.startsWith('app-')) {
    const appM = /^Appendix ([A-Z])$/.exec(secNumText);
    if (!appM) return false;
    const letter = appM[1];
    return (label === `Appendix ${letter}: ${h2AfterSingleSep}`.trim() || label === `Appendix ${letter}: ${h2Title}`)
      && (badge === letter || badge === v1Idx);
  }
  if (secEl.id.startsWith('sec-')) {
    const secNumTrim = secNumText.replace(/^0+/, '') || '0';
    return label === h2Title && (badge === secNumTrim || badge === v1Idx);
  }
  return false;
}

// options.renderPolicy selects the rules (R1); render-policy/2 also needs options.edition
// = { manifest, report } (report = the parsed report.json, or null when unusable).
export function scanHtmlPolicy(html, inventoryPaths, options = {}) {
  const v2 = options.renderPolicy === RENDER_POLICY_2;
  const inspected = inspectHtmlDocument(html, { alternateHref: 'report.md', ...(v2 ? { lockupSvgAttrs: LOCKUP_SVG_ATTRS_2 } : {}) });
  const problems = [...inspected.problems];
  let stylesheetLinks = 0;
  for (const cssHref of inspected.stylesheetHrefs) {
    if (/^assets\/[0-9a-f]{64}\.css$/.test(cssHref)) {
      stylesheetLinks += 1;
    } else {
      problems.push('link element other than a fingerprinted stylesheet or report.md alternate');
    }
  }
  for (const h of inspected.hrefChecks) {
    const { tagName, lowerName, value, relTokens } = h;
    if (value.startsWith('#')) {
      const frag = value.slice(1);
      if (!frag || !inspected.ids.has(frag)) {
        problems.push(`fragment ${JSON.stringify(value)} does not match any id on index.html`);
      }
    } else if (/^https:\/\//.test(value)) {
      if (lowerName !== 'a' || !relTokens.has('noopener') || !relTokens.has('noreferrer')) {
        problems.push(`external href without rel="noopener noreferrer" on <${tagName}>`);
      }
    } else if (!(inventoryPaths.has(value) || CONTROL_FILES.has(value))) {
      problems.push(`href ${JSON.stringify(value)} does not resolve to a packet file`);
    }
  }
  if (stylesheetLinks !== 1) problems.push(`expected exactly one fingerprinted stylesheet link, found ${stylesheetLinks}`);
  if (v2) {
    checkEditionStructureV2(html, inspected, options.edition ?? { manifest: {}, report: null }, problems);
    return problems;
  }

  const bodyEl = inspected.elements.find((e) => e.tag === 'body');
  if (bodyEl) {
    const tocNavs = bodyEl.children.filter((c) => c.tag === 'nav' && c.classes.has('toc'));
    const layoutDivs = bodyEl.children.filter((c) => c.tag === 'div' && c.classes.has('layout'));
    const layoutEl = layoutDivs.length === 1 ? layoutDivs[0] : null;
    const railNav = layoutEl && !isNavNodeHidden(layoutEl, bodyEl) && layoutEl.children[0]?.tag === 'nav' && layoutEl.children[0].classes.has('rail')
      ? layoutEl.children[0]
      : null;
    const mainEl = layoutEl ? layoutEl.children.find((c) => c.tag === 'main') : null;
    const expectedSecs = mainEl && !isNavNodeHidden(mainEl, bodyEl)
      ? mainEl.children.filter((c) => c.tag === 'section' && typeof c.id === 'string' && c.id && !isNavNodeHidden(c, bodyEl))
      : null;
    const tocNav = tocNavs.length === 1 && !isNavNodeHidden(tocNavs[0], bodyEl) && isWsOnlyPkt(tocNavs[0].ownText) && tocNavs[0].children.length === 1
      ? tocNavs[0]
      : null;
    const tocDet = tocNav && tocNav.children[0].tag === 'details' && !isNavNodeHidden(tocNav.children[0], tocNav) && isWsOnlyPkt(tocNav.children[0].ownText) && tocNav.children[0].children.length === 2
      ? tocNav.children[0]
      : null;
    const tocSum = tocDet ? tocDet.children[0] : null;
    const tocSumOk = Boolean(tocSum && tocSum.tag === 'summary' && !isNavNodeHidden(tocSum, tocNav) && /^Contents(?:\s+\d+\s+sections)?$/.test(navSubtreeText(tocSum).trim()));
    const tocLinks = tocDet && tocSumOk ? collectNavLinks(tocDet.children[1], tocNav) : null;

    let railOl = null;
    if (railNav && !isNavNodeHidden(railNav, bodyEl) && isWsOnlyPkt(railNav.ownText)) {
      if (railNav.children.length === 2 && railNav.children[0].tag === 'p' && railNav.children[0].classes.has('overline')
        && railNav.children[0].children.length === 0 && pktRawText(railNav.children[0]).trim() === 'Contents') {
        railOl = railNav.children[1];
      } else if (railNav.children.length === 1 && railNav.children[0].tag === 'ol') {
        railOl = railNav.children[0];
      }
    }
    const railLinks = railOl ? collectNavLinks(railOl, railNav) : null;
    if (!tocLinks || !railLinks || !expectedSecs || expectedSecs.length === 0) {
      problems.push('missing or hidden <nav class="toc"> or <nav class="rail"> section navigation in HTML');
    } else if (tocLinks.length !== railLinks.length
      || !tocLinks.every((l, idx) => l.href === railLinks[idx].href && l.badge === railLinks[idx].badge && l.label === railLinks[idx].label)) {
      problems.push('<nav class="toc"> and <nav class="rail"> link targets or labels disagree in HTML');
    } else if (tocLinks.length !== expectedSecs.length || !tocLinks.every((l, idx) => matchesPacketSectionNavEntry(l, expectedSecs[idx], idx))) {
      problems.push('<nav class="toc"> and <nav class="rail"> fail to cover top-level <main> sections in order');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// render-policy/2 page structure (render-policy-2.md R3, R5, R6 bands, R9), checked
// against the packet's own report.json, which the verifier parses and counts itself.
const LOCKUP_SVG_ATTRS_2 = new Set([
  'fill-rule', 'clip-rule', 'stroke-miterlimit', 'stroke-dashoffset',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
]);
// Inside the masthead and colophon bands only these classes may appear: each has a band
// colour (or inherits one), so no component with its own surface or ink (a stamp, a
// confidence chip) can land on the slate band below 4.5:1 (R6). The colophon also carries
// the authored provenance notes, whose RFC 2119 chips and cites are given band colours by
// the stylesheet rules REQUIRED_TOP_DECLARATIONS_2 demands.
const BAND_CLASS_RE_2 = /^(?:masthead__(?:brand|slug)|formats|colophon__(?:inner|seal|title|label|digest|text|provenance|sources|ref|notes|verify|cmd|foot|mark|mark--ruled|gen)|visually-hidden|lockup|lockup--(?:ui|display)|digest|ext|cite-run)$/;
const COLOPHON_NOTE_CLASS_RE_2 = /^(?:rfc2119|cite)$/;
const BAND_OWNED_CLASS_RE_2 = /^(?:masthead|formats|colophon)(?:__|$)/;
const B_ID_RE = /^b-[0-9]+$/;
const ALLOWED_ENTITY_RE_2 = /&(?!(?:amp|lt|gt|quot|#39);)/;

// R5/R6: the elements and contexts html-v2 (and the chart, diagram, evidence-preview and
// lockup renderers it calls) put each hiding marker on. A marker anywhere else could hide
// report content from readers or from assistive technology, so it is refused. `cls` is the
// element's exact class list, sorted; `in` tests its parent.
const parentIs = (tag, re) => (p) => Boolean(p) && p.tag === tag && [...p.classes].some((c) => re.test(c));
const HIDING_PLACEMENT_2 = {
  'aria-hidden': [
    { tag: 'p', cls: /^rail__label$/, in: parentIs('nav', /^rail__toc$/) },
    { tag: 'span', cls: /^rail__num$/, in: (p) => Boolean(p) && p.tag === 'a' && p.classes.size === 0 && parentIs('nav', /^rail__toc$/)(p.parent?.parent?.parent) },
    { tag: 'span', cls: /^sec-num$/, in: parentIs('h2', /^section__head$/) },
    { tag: 'span', cls: /^conf__glyph$/, in: parentIs('span', /^conf$/) },
    { tag: 'span', cls: /^flow__num$/, in: parentIs('div', /^flow-ledger__head$/) },
    { tag: 'span', cls: /^option__key$/, in: parentIs('li', /^option$/) },
    { tag: 'span', cls: /^option__arrow$/, in: parentIs('p', /^option__label$/) },
    { tag: 'span', cls: /^pips$/, in: (p) => parentIs('span', /^lvl$/)(p) || parentIs('span', /^sev$/)(p) },
    { tag: 'svg', cls: /^bar$/, in: parentIs('td', /^chart__bar$/) },
    { tag: 'svg', cls: /^svg-graphic svg-graphic--(?:chart|flow|quantiles|sequence|topology)$/, in: parentIs('div', /^diagram-canvas$/) },
    { tag: 'svg', cls: /^lockup lockup--ui$/, in: parentIs('span', /^masthead__brand$/) },
    { tag: 'svg', cls: /^lockup lockup--display$/, in: parentIs('p', /^colophon__mark$/) },
  ],
  'visually-hidden': [
    { tag: 'caption', cls: /^visually-hidden$/, in: (p) => parentIs('table', /^(?:chart-table|ev-preview__table|scenario-table)$/)(p) },
    { tag: 'p', cls: /^visually-hidden$/, in: parentIs('div', /^cmp-side$/) },
    { tag: 'span', cls: /^visually-hidden$/, in: (p) => parentIs('span', /^masthead__brand$/)(p) || parentIs('p', /^colophon__mark$/)(p) || parentIs('p', /^option__label$/)(p) },
  ],
  'skip-link': [
    { tag: 'a', cls: /^skip-link$/, in: (p) => Boolean(p) && p.tag === 'body' },
  ],
  stamp: [
    { tag: 'span', cls: /^stamp$/, in: (p) => parentIs('p', /^kicker$/)(p) || parentIs('p', /^decision__status$/)(p) || parentIs('p', /^option__label$/)(p) },
  ],
  lockup: [
    { tag: 'svg', cls: /^lockup lockup--ui$/, in: parentIs('span', /^masthead__brand$/) },
    { tag: 'svg', cls: /^lockup lockup--display$/, in: parentIs('p', /^colophon__mark$/) },
  ],
};

function checkHidingPlacementV2(els, fail) {
  for (const el of els) {
    const markers = [];
    if (el.ariaHidden !== null) markers.push('aria-hidden');
    for (const c of ['visually-hidden', 'skip-link', 'stamp']) if (el.classes.has(c)) markers.push(c);
    if ([...el.classes].some((c) => /^lockup(?:--|$)/.test(c))) markers.push('lockup');
    for (const marker of markers) {
      if (marker === 'aria-hidden' && el.ariaHidden !== 'true') {
        fail(`aria-hidden="${el.ariaHidden}" on <${el.tag}> is not emitted by render-policy/2 (only "true")`);
        continue;
      }
      const cls = [...el.classes].sort().join(' ');
      if (!HIDING_PLACEMENT_2[marker].some((r) => r.tag === el.tag && r.cls.test(cls) && r.in(el.parent))) {
        const where = el.parent ? `<${el.parent.tag}${[...el.parent.classes].sort().map((c) => `.${c}`).join('')}>` : 'the document';
        fail(`${marker} on <${el.tag}${cls ? ` class="${cls}"` : ''}> inside ${where} is not a place render-policy/2 puts it`);
      }
    }
  }
}

const v2Text = (el) => pktRawText(el);
const v2Classes = (el) => [...el.classes].sort().join(' ');
const v2Is = (el, tag, classes) => Boolean(el) && el.tag === tag && v2Classes(el) === [...classes].sort().join(' ');
const v2Descendants = (el) => el.children.flatMap((c) => [c, ...v2Descendants(c)]);

function bNumberLabel(n) {
  return `b-${String(n).padStart(2, '0')}`;
}

// R3: the verifier's own count of numbered blocks, from report.json alone.
function countReportBlocks(report) {
  return {
    summary: report.summary.paragraphs.length,
    sections: report.sections.map((s) => s.blocks.length),
    appendices: (report.appendices ?? []).map((s) => s.blocks.length),
  };
}

function checkLockupSlot(el, kind, fail, where) {
  const kids = el.children;
  const svg = kids.length === 2 ? kids[0] : null;
  const hidden = kids[kids.length - 1];
  if (kids.length < 1 || kids.length > 2 || !v2Is(hidden, 'span', ['visually-hidden']) || v2Text(hidden) !== 'Canon' || hidden.children.length) {
    fail(`${where} must hold the optional lockup and the visually hidden text "Canon"`);
  }
  if (svg && (!v2Is(svg, 'svg', ['lockup', `lockup--${kind}`]) || svg.ariaHidden !== 'true')) {
    fail(`${where} lockup must be <svg class="lockup lockup--${kind}" aria-hidden="true">`);
  }
  if (!isWsOnlyPkt(el.ownText)) fail(`${where} has stray text`);
  return Boolean(svg);
}

function checkEditionStructureV2(html, inspected, edition, problems) {
  const fail = (msg) => problems.push(`render-policy/2 structure: ${msg}`);
  const { manifest, report } = edition;
  if (ALLOWED_ENTITY_RE_2.test(html)) fail('character references other than &amp; &lt; &gt; &quot; &#39; are not emitted by render-policy/2');
  if (!report) {
    fail('report.json is missing or unreadable, so the page cannot be checked against it');
    return;
  }
  const els = inspected.elements;
  const body = els.find((e) => e.tag === 'body');
  if (!body) return;

  // R9 (Captain's ruling on review MAJOR 4): http(s) URLs may appear as text (code, prose,
  // tables), as in policy/1. In an attribute, an http(s) URL is accepted only as the https
  // href of an authored ext link whose rel holds noopener and noreferrer; any other
  // attribute carrying one is refused. Attribute values are checked decoded, and only the
  // five character references above are emitted at all. The page cannot carry its own
  // content ID: that ID digests the manifest, which digests index.html, so no check is
  // needed (or could ever fail) for it.
  for (const el of els) {
    for (const [name, value] of el.attrs) {
      if (!/https?:\/\//i.test(value)) continue;
      const rel = new Set((el.attrs.get('rel') ?? '').toLowerCase().split(/[\t\n\f\r ]+/));
      const extHref = el.tag === 'a' && el.classes.has('ext') && name === 'href' && /^https:\/\//.test(value) && rel.has('noopener') && rel.has('noreferrer');
      if (!extHref) fail(`http(s) URL in the ${name} attribute of <${el.tag}>: only an authored ext link's https href may carry one`);
    }
  }

  // R5 body order: skip link, masthead, layout, colophon, and nothing else. The parts are
  // found by what they are, so one misplaced part is reported once, not as a cascade.
  const only = (tag, classes) => {
    const hits = body.children.filter((c) => v2Is(c, tag, classes));
    return hits.length === 1 ? hits[0] : null;
  };
  const skip = only('a', ['skip-link']);
  const masthead = only('header', ['masthead']);
  const layout = only('div', ['layout']);
  const colophon = only('footer', ['colophon']);
  const order = [skip, masthead, layout, colophon];
  if (!skip || skip.href !== '#content') fail('body must open with one a.skip-link to #content');
  if (!masthead || !layout || !colophon) fail('body must hold exactly one header.masthead, div.layout and footer.colophon');
  if (body.children.length !== 4 || !order.every((el, i) => el && body.children[i] === el)) {
    fail('body must hold exactly a.skip-link, header.masthead, div.layout and footer.colophon, in that order');
  }
  if (!isWsOnlyPkt(body.ownText)) fail('body has stray text');

  // R5/R6: hiding markers (aria-hidden, visually-hidden, skip-link, stamp, lockup) only
  // where html-v2 emits them.
  checkHidingPlacementV2(els, fail);

  // R5: the generator meta names exactly this build (html-v2 emits
  // `<tool> <version>; render-policy/2; <securityPolicy>` from manifest.build).
  const build = manifest.build ?? {};
  const generatorWant = `${build.tool} ${build.version}; ${RENDER_POLICY_2}; ${build.securityPolicy}`;
  const generators = [...html.matchAll(/<meta name="generator" content="([^"]*)">/g)].map((m) => decodeHtmlAttr(m[1]));
  if (generators.length !== 1 || generators[0] !== generatorWant) {
    fail(`<meta name="generator"> must read ${JSON.stringify(generatorWant)}, found ${JSON.stringify(generators)}`);
  }

  // R6 bands: band classes only inside their band, and only band classes inside a band.
  for (const band of [masthead, colophon]) {
    if (!band) continue;
    for (const d of v2Descendants(band)) {
      for (const c of d.classes) if (!BAND_CLASS_RE_2.test(c) && !(band === colophon && COLOPHON_NOTE_CLASS_RE_2.test(c))) fail(`class "${c}" inside the ${band.tag === 'header' ? 'masthead' : 'colophon'} band has no band colour`);
    }
  }
  const bandRoots = new Set([masthead, colophon].filter(Boolean));
  for (const e of els) {
    if (![...e.classes].some((c) => BAND_OWNED_CLASS_RE_2.test(c)) || bandRoots.has(e)) continue;
    let cur = e.parent;
    while (cur && !bandRoots.has(cur)) cur = cur.parent;
    const want = [...e.classes].some((c) => c.startsWith('colophon')) ? colophon : masthead;
    if (!cur || cur !== want) fail(`.${[...e.classes].join('.')} is outside its band`);
  }

  // R5 masthead: lockup slot, report id, exactly three format links.
  if (masthead && masthead.tag === 'header') {
    const [brand, slug, formats, ...mx] = masthead.children;
    if (!v2Is(brand, 'span', ['masthead__brand'])) fail('masthead must start with span.masthead__brand');
    else checkLockupSlot(brand, 'ui', fail, 'span.masthead__brand');
    if (!v2Is(slug, 'span', ['masthead__slug']) || slug.children.length || v2Text(slug) !== manifest.report?.id) fail('span.masthead__slug must carry exactly the report id');
    const wanted = ['index.html', 'report.md', 'manifest.json'];
    if (!v2Is(formats, 'nav', ['formats']) || formats.ariaLabel !== 'Edition formats' || !isWsOnlyPkt(formats.ownText)
      || formats.children.length !== 3
      || !formats.children.every((a, i) => a.tag === 'a' && a.classes.size === 0 && a.href === wanted[i] && !a.children.length && v2Text(a) === wanted[i]
        && (i === 0 ? a.attrs.get('aria-current') === 'page' : !a.attrs.has('aria-current')))) {
      fail('nav.formats[aria-label="Edition formats"] must hold exactly the index.html (aria-current="page"), report.md and manifest.json links');
    }
    if (mx.length || !isWsOnlyPkt(masthead.ownText)) fail('masthead holds only the brand, slug and formats');
  }

  // R5 layout: main#content.document then aside.rail, nothing else.
  const [main, rail, ...lx] = layout?.children ?? [];
  if (!v2Is(main, 'main', ['document']) || main.id !== 'content') fail('div.layout must hold main#content.document first');
  if (!v2Is(rail, 'aside', ['rail']) || rail.ariaLabel !== 'On this page') fail('aside.rail[aria-label="On this page"] must follow main');
  if (lx.length) fail('div.layout holds only main and the rail');
  if (els.some((e) => e.tag === 'section' && e.id === 'provenance')) fail('render-policy/2 has no section#provenance');

  // R5 main: title block, meta strip, then the sections in report order.
  const sections = [];
  if (main?.tag === 'main') {
    const [titleBlock, metaStrip, ...secs] = main.children;
    if (!v2Is(titleBlock, 'header', ['title-block'])) fail('main must open with header.title-block');
    if (!v2Is(metaStrip, 'dl', ['meta-strip'])) fail('dl.meta-strip must follow the title block');
    const expected = [
      { id: 'summary', classes: ['section', 'section--summary'], num: '§', title: 'Summary', blocks: report.summary.paragraphs.length },
      ...report.sections.map((s, i) => ({ id: `sec-${s.id}`, classes: ['section'], num: String(i + 1).padStart(2, '0'), title: s.title, blocks: s.blocks.length })),
      { id: 'evidence', classes: ['section', 'section--evidence'], num: 'Ev', title: 'Evidence', blocks: 0 },
      ...(report.appendices ?? []).map((s, i) => {
        const letter = String.fromCharCode(65 + i);
        return { id: `app-${s.id}`, classes: ['section', 'section--appendix'], num: letter, title: `Appendix ${letter}: ${s.title}`, blocks: s.blocks.length };
      }),
    ];
    if (secs.length !== expected.length) fail(`main holds ${secs.length} sections; report.json has ${expected.length}`);
    expected.forEach((exp, i) => {
      const sec = secs[i];
      if (!sec) return;
      const h2 = sec.children[0];
      const num = h2?.children[0];
      const title = h2?.children[1];
      if (!v2Is(sec, 'section', exp.classes) || sec.id !== exp.id) {
        fail(`section ${i + 1} must be section#${exp.id}.${exp.classes.join('.')}`);
      } else if (!v2Is(h2, 'h2', ['section__head']) || h2.children.length !== 2 || !v2Is(num, 'span', ['sec-num']) || num.ariaHidden !== 'true'
        || v2Text(num) !== exp.num || !v2Is(title, 'span', ['section__title']) || v2Text(title) !== exp.title) {
        fail(`section#${exp.id} must open with h2.section__head "${exp.num}" "${exp.title}"`);
      }
      sections.push({ el: sec, exp });
    });
  }

  // R3: one b-anchor per counted block, b-01 … b-N in document order, per section as
  // report.json orders them; no other element has a b-nn id.
  const total = countReportBlocks(report);
  const n = total.summary + total.sections.reduce((a, b) => a + b, 0) + total.appendices.reduce((a, b) => a + b, 0);
  const bIds = els.filter((e) => typeof e.id === 'string' && B_ID_RE.test(e.id));
  const anchors = els.filter((e) => e.tag === 'a' && e.classes.has('b-anchor'));
  if (bIds.length !== n || anchors.length !== n) fail(`report.json counts ${n} numbered blocks; the page has ${bIds.length} b-nn ids and ${anchors.length} b-anchor links`);
  bIds.forEach((e, i) => {
    const label = bNumberLabel(i + 1);
    if (e.id !== label || !v2Is(e, 'a', ['b-anchor']) || e.href !== `#${label}` || e.ariaLabel !== `Block ${label}` || e.children.length || v2Text(e) !== label) {
      fail(`b-nn anchor ${i + 1} must be <a class="b-anchor" id="${label}" href="#${label}" aria-label="Block ${label}">${label}</a>, found id ${JSON.stringify(e.id)}`);
    }
  });
  for (const { el, exp } of sections) {
    const inside = v2Descendants(el).filter((e) => e.tag === 'a' && e.classes.has('b-anchor')).length;
    if (inside !== exp.blocks) fail(`section#${exp.id} has ${inside} b-anchors; report.json has ${exp.blocks} numbered blocks there`);
  }

  // Findings: one article per report finding, in order, with its severity and exactly one
  // confidence chip naming its confidence.
  const reportFindings = [...report.sections, ...(report.appendices ?? [])].flatMap((s) => s.blocks).filter((b) => b?.type === 'finding');
  const articles = els.filter((e) => e.tag === 'article' && e.classes.has('finding'));
  if (articles.length !== reportFindings.length) fail(`page has ${articles.length} findings; report.json has ${reportFindings.length}`);
  const confWord = { proven: 'Proven', recommended: 'Recommended', defect: 'Defect', open: 'Open' };
  articles.forEach((art, i) => {
    const f = reportFindings[i];
    if (!f) return;
    const chips = v2Descendants(art).filter((e) => e.classes.has('conf'));
    if (art.id !== `f-${f.id}` || !art.classes.has(`finding--${f.severity}`)) fail(`finding ${i + 1} must be article#f-${f.id}.finding--${f.severity}`);
    if (chips.length !== 1 || !v2Is(chips[0], 'span', ['conf', `conf--${f.confidence}`]) || !v2Text(chips[0]).endsWith(` ${confWord[f.confidence]}`)) {
      fail(`finding f-${f.id} must carry exactly one ${confWord[f.confidence] ?? '?'} confidence chip`);
    }
  });

  // R5 rail: the toc mirrors every main > section[id] in order; the evidence list mirrors
  // the evidence entries.
  if (rail?.tag === 'aside') {
    const [toc, evBox, ...rx] = rail.children;
    const tocOl = toc?.children[1];
    if (!v2Is(toc, 'nav', ['rail__toc']) || toc.ariaLabel !== 'Sections' || toc.children.length !== 2
      || !v2Is(toc.children[0], 'p', ['rail__label']) || v2Text(toc.children[0]) !== 'On this page' || tocOl?.tag !== 'ol' || tocOl.classes.size) {
      fail('aside.rail must open with nav.rail__toc[aria-label="Sections"] holding its label and an ol');
    } else if (tocOl.children.length !== sections.length || !tocOl.children.every((li, i) => {
      const a = li.children[0];
      const [num, label] = a?.children ?? [];
      return li.children.length === 1 && a.tag === 'a' && a.href === `#${sections[i].exp.id}` && a.children.length === 2
        && v2Is(num, 'span', ['rail__num']) && num.ariaHidden === 'true' && v2Text(num) === sections[i].exp.num
        && label.tag === 'span' && label.classes.size === 0 && v2Text(label) === sections[i].exp.title;
    })) {
      fail('nav.rail__toc entries must mirror every main > section[id] in order');
    }
    const evOl = evBox?.children[1];
    const evIds = report.evidence.map((e) => `ev-${e.id}`);
    const evList = sections.find((s) => s.exp.id === 'evidence')?.el.children.find((c) => c.tag === 'ol');
    if (!v2Is(evList, 'ol', ['evidence-list']) || evList.children.length !== evIds.length || !evList.children.every((li, i) => li.tag === 'li' && li.id === evIds[i])) {
      fail('section#evidence must list every report.json evidence entry in order');
    }
    if (!v2Is(evBox, 'div', ['rail__evidence']) || evBox.children.length !== 2 || !v2Is(evBox.children[0], 'p', ['rail__label']) || evOl?.tag !== 'ol'
      || evOl.children.length !== evIds.length
      || !evOl.children.every((li, i) => li.children.length === 2 && li.children[0].tag === 'a' && li.children[0].href === `#${evIds[i]}` && v2Is(li.children[1], 'span', ['rail__size']))) {
      fail('div.rail__evidence must list every evidence entry in order');
    }
    if (rx.length) fail('aside.rail holds only the toc and the evidence list');
  }

  // R5 colophon: seal, full source digest, the three control links, provenance, verify
  // command, display lockup on its rule, generator line.
  if (colophon?.tag === 'footer') {
    const all = v2Descendants(colophon);
    const sha = manifest.report?.sourceSha256 ?? '';
    const one = (pred, what) => {
      const hit = all.filter(pred);
      if (hit.length !== 1) fail(`colophon must hold exactly one ${what}`);
      return hit[0];
    };
    const title = one((e) => v2Is(e, 'p', ['colophon__title']), 'p.colophon__title');
    if (title && v2Text(title) !== 'Sealed by Canon') fail('colophon title must read "Sealed by Canon"');
    const digest = one((e) => e.id === 'source-digest', '#source-digest');
    const code = digest?.children[0];
    if (!v2Is(digest, 'p', ['colophon__digest']) || digest.children.length !== 1 || code?.tag !== 'code' || code.children.length !== 1
      || code.children[0].tag !== 'b' || v2Text(code.children[0]) !== sha.slice(0, 8) || v2Text(code) !== sha || !sha) {
      fail('p#source-digest must show the full report source digest with its first 8 hex digits in <b>');
    }
    const hrefs = all.filter((e) => e.tag === 'a').map((e) => e.href);
    for (const h of ['report.md', 'manifest.json', 'checksums.json']) if (!hrefs.includes(h)) fail(`colophon must link ${h}`);
    const prov = one((e) => e.id === 'provenance', '#provenance');
    const sources = prov?.children.find((c) => c.tag === 'ul');
    if (!v2Is(prov, 'div', ['colophon__provenance']) || !v2Is(sources, 'ul', ['colophon__sources']) || sources.children.length !== report.provenance.sources.length) {
      fail('div#provenance.colophon__provenance must list every report.json provenance source');
    }
    const cmd = one((e) => v2Is(e, 'p', ['colophon__cmd']), 'p.colophon__cmd');
    if (cmd && v2Text(cmd) !== 'canon verify <packet-dir>') fail('colophon must show `canon verify <packet-dir>`');
    const mark = one((e) => e.tag === 'p' && e.classes.has('colophon__mark'), 'p.colophon__mark');
    if (mark) {
      const drawn = checkLockupSlot(mark, 'display', fail, 'p.colophon__mark');
      if (v2Classes(mark) !== (drawn ? 'colophon__mark colophon__mark--ruled' : 'colophon__mark')) fail('the display lockup, and only it, sits on the colophon__mark--ruled rule');
    }
    const gen = one((e) => v2Is(e, 'p', ['colophon__gen']), 'p.colophon__gen');
    const b = manifest.build ?? {};
    const genLine = `${b.tool} ${b.version} · ${RENDER_POLICY_2} · ${b.securityPolicy} · zero scripts, zero external requests`;
    if (gen && v2Text(gen) !== genLine) fail(`colophon generator line must read ${JSON.stringify(genLine)}`);
  }
}

const ALLOWED_CSS_AT_RULES = new Set(['layer', 'media', 'page', 'font-face']);
const ALLOWED_MEDIA_PRELUDES = new Set([
  '@media (max-width: 1024px)',
  '@media (max-width: 720px)',
  '@media (max-width: 760px)',
  '@media (min-width: 721px)',
  '@media (prefers-color-scheme: dark)',
  '@media (prefers-reduced-motion: reduce)',
  '@media print',
]);
const ALLOWED_LAYER_PRELUDES = new Set([
  '@layer base', '@layer code', '@layer components', '@layer graphics',
  '@layer layout', '@layer print', '@layer reset', '@layer responsive', '@layer tokens',
]);

function stripCssCommentsPreservingStrings(css, problems) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = css.indexOf(ch, i + 1);
      if (end < 0) {
        problems.push('unclosed string literal in stylesheet');
        return out + css.slice(i);
      }
      const literal = css.slice(i, end + 1);
      if (literal.includes('\n') || literal.includes('\r') || literal.includes('\f')) {
        problems.push('unescaped newline in stylesheet string literal');
      }
      out += literal;
      i = end + 1;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) {
        problems.push('unclosed comment in stylesheet');
        return out;
      }
      out += ' ';
      i = end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const ALLOWED_CSS_SELECTOR_PARTS = new Set([
  '*', '*::after', '*::before',
  '.age-pill--blocked', '.age-pill--moved', '.age-pill--waiting',
  '.alt', '.alt--chosen', '.alt--chosen .alt__summary', '.alt__body', '.alt__head',
  '.alt__head .chosen', '.alt__head .opt-key', '.alt__head strong', '.alt__summary',
  '.alternatives', '.alternatives li', '.alternatives:empty',
  '.area-card > .support', '.area-card--complete', '.area-card--partial', '.area-card--unavailable',
  '.badge--gate', '.bar', '.bar__baseline', '.bar__candidate', '.bar__fill', '.bar__track',
  '.brand', '.brand > div', '.brand small', '.brand strong', '.brand strong a', '.brand strong a:hover', '.brand__mark',
  '.breadcrumb', '.breadcrumb a', '.breadcrumb a:hover', '.breadcrumb span',
  '.chart-table', '.chart__bar', '.chart__table svg', '.chart__table td.bar',
  '.chosen', '.cite', '.cite:hover',
  '.claim', '.claim .field-label', '.claim > .field-label', '.classification',
  '.cmp-side', '.cmp-side--legacy', '.cmp-side--legacy .cmp-side__tag',
  '.cmp-side--proposed', '.cmp-side--proposed .cmp-side__tag',
  '.cmp-side__code', '.cmp-side__list', '.cmp-side__list li + li', '.cmp-side__summary', '.cmp-side__tag',
  '.code', '.code pre', '.code pre code', '.code__caption', '.code__head', '.code__head strong',
  '.code__lang', '.code__lines', '.code__scroll', '.code__scroll:focus-visible',
  '.comparison > .cmp-grid',
  '.conf', '.conf-defect', '.conf-open', '.conf-proven', '.conf-recommended',
  '.conf.conf-defect', '.conf.conf-open', '.conf.conf-proven', '.conf.conf-recommended',
  '.consequences', '.consequences li + li',
  '.cov-pill', '.cov-pill--complete', '.cov-pill--partial', '.cov-pill--unavailable',
  '.dec', '.dec-decided', '.dec-needed',
  '.decision', '.decision .item__head', '.decision .item__head .labels', '.decision .item__head h3',
  '.decision > p', '.decision--close', '.decision--decided', '.decision--needed', '.decision:target',
  '.delta-pill', '.delta-pill--good', '.delta-pill--warn',
  '.diagram-canvas', '.digest', '.digest-cell code', '.document', '.ears-pill',
  '.ev', '.ev p', '.ev p + p', '.ev--redacted', '.ev--unavailable', '.ev-label',
  '.ev-preview', '.ev-preview .table__scroll', '.ev-preview__bar',
  '.ev-preview__table', '.ev-preview__table td', '.ev-preview__table th',
  '.ev-refs', '.ev-refs a', '.ev-refs a:hover', '.ev-refs li', '.ev-refs li + li::before',
  '.ev:target', '.ev__cited', '.ev__digest', '.ev__digest code',
  '.ev__file', '.ev__file a', '.ev__head', '.ev__meta', '.ev__meta-row',
  '.ev__title', '.ev__title strong', '.ev__withheld', '.evidence-list',
  '.field-label', '.figure', '.figure > figcaption', '.figure > figcaption span', '.figure > figcaption strong',
  '.finding', '.finding + .finding', '.finding .list li', '.finding .list li > a', '.finding .list li > a:hover',
  '.finding > .claim', '.finding > .claim strong', '.finding > h3', '.finding > h3 > span',
  '.finding > h3 a', '.finding > h3 a:hover', '.finding > p',
  '.finding.sev-critical', '.finding.sev-high', '.finding.sev-info', '.finding.sev-low', '.finding.sev-medium',
  '.finding:target', '.finding__detail', '.finding__detail > * + *',
  '.flow', '.flow-ledger', '.flow-ledger__head', '.flow-ledger__head strong',
  '.flow-ledger__item', '.flow-ledger__item p', '.flow-ledger__item--gate',
  '.flow__index', '.flow__num', '.flow__step', '.flow__step + .flow__step',
  '.flow__step + .flow__step--gate', '.flow__step small', '.flow__step strong',
  '.flow__step--gate', '.flow__step--gate + .flow__step', '.gate-label',
  '.item__head', '.item__head h3', '.item__id', '.item__meta', '.item__title-row',
  '.labels', '.layout', '.lede',
  '.legend', '.legend .list li', '.legend .list li > a', '.legend .list li > a:hover',
  '.legend .list li > span > a', '.legend .list li > span > a:hover',
  '.legend > .list.item-links', '.legend > .list.item-links li', '.legend > .list.item-links li:last-child',
  '.legend > p', '.legend dl', '.legend dl > div', '.legend dl div', '.legend p',
  '.legend summary', '.legend summary::-webkit-details-marker', '.legend summary::after',
  '.legend::details-content', '.legend[open]', '.legend[open] > summary',
  '.legend[open] > summary::after', '.legend[open] summary',
  '.list', '.list li', '.list li + li', '.list li::marker',
  '.list.item-links', '.list.item-links li', '.list.item-links li > .item__id',
  '.list.item-links li > a', '.list.item-links li > a:hover',
  '.list.item-links li > span', '.list.item-links li > span > a', '.list.item-links li > span > a:hover',
  '.ln', '.ln.add', '.ln.add .t-mark', '.ln.add::after', '.ln.del', '.ln.del .t-mark', '.ln.del::after',
  '.ln.hdr', '.ln.hl', '.ln.hl::after', '.ln.hunk', '.ln.meta', '.ln::before', '.ln:target',
  '.lvl', '.lvl-high', '.lvl-low', '.lvl-medium', '.lvl.lvl-high', '.lvl.lvl-low', '.lvl.lvl-medium',
  '.masthead', '.masthead .classification', '.masthead__date', '.masthead__status', '.masthead__status .classification',
  '.meta-kv', '.meta-kv a', '.meta-kv a:hover', '.meta-kv code', '.meta-kv dd', '.meta-kv span',
  '.metric-card', '.metric-card dd', '.metric-card dt',
  '.metric__cites', '.metric__qualifier', '.metric__unit',
  '.metric__value', '.metric__value--null', '.metric__value--partial',
  '.metrics', '.metrics div', '.metrics div:last-child:nth-child(odd)', '.metrics dt', '.muted',
  '.nav-badge', '.nav-item--area', '.nav-item--area > a', '.nav-item--item > a',
  '.nav-item--item:has(+ .nav-item--area)', '.nav-item--portfolio > a',
  '.nav-item--project > a', '.nav-item--project > a[aria-current="page"]',
  '.nav-item--project:has(+ .nav-item--area)',
  '.num', '.overline', '.prose-para',
  '.prose-sheet', '.prose-sheet__body', '.prose-sheet__body .list', '.prose-sheet__body .list li',
  '.prose-sheet__body > *:first-child', '.prose-sheet__body > p:first-child',
  '.prose-sheet__body > p:first-child strong', '.prose-sheet__body > p:last-child',
  '.prose-sheet__body > p:not(.claim)', '.prose-sheet__body p',
  '.prose-sheet__body p > code:only-child', '.prose-sheet__meta',
  '.question + .question', '.question__bar', '.question__evidence', '.question__footer',
  '.question__freetext', '.question__options', '.question__options > .field-label',
  '.question__prompt', '.question__recommendation', '.question__recommendation[data-rec="none"]', '.question__ref',
  '.rail', '.rail > .overline', '.rail a', '.rail a span', '.rail a:hover',
  '.rail a:hover .nav-badge', '.rail a[aria-current="page"]', '.rail ol',
  '.requirement', '.requirement > .table__scroll', '.rfc2119',
  '.risk', '.risk dt', '.risk-grid', '.risk-grid > .risk', '.scenario-table',
  '.sec-num', '.section', '.section > .list', '.section > .prose-para + .prose-para',
  '.section > h2', '.section > h3', '.section > p', '.section > p:not(.lede):not(.claim)',
  '.section h3', '.section h4', '.section__bar', '.section__bar > h2',
  '.seq-ledger', '.seq-ledger li + li',
  '.sev', '.sev-critical', '.sev-critical .sev', '.sev-high', '.sev-info', '.sev-low', '.sev-medium',
  '.sev.sev-critical', '.sev.sev-high', '.sev.sev-info', '.sev.sev-low', '.sev.sev-medium',
  '.site-footer', '.site-footer > *', '.site-footer a',
  '.sitrep-pulse', '.sitrep-pulse__cell', '.sitrep-pulse__label', '.sitrep-pulse__sub', '.sitrep-pulse__value',
  '.skip-link', '.skip-link:focus',
  '.status', '.status--draft', '.status--final', '.status--proposed', '.subtitle',
  '.summary-prose', '.summary-prose > .prose-para + .prose-para', '.support', '.support .field-label',
  '.svg-actor', '.svg-actor-label', '.svg-area-unavail', '.svg-arrow', '.svg-arrow--gate',
  '.svg-axis-label', '.svg-budget-label', '.svg-budget-line',
  '.svg-delta', '.svg-delta--good', '.svg-delta--warn',
  '.svg-edge', '.svg-edge--dashed', '.svg-edge--gate', '.svg-edge-label',
  '.svg-edge-pill', '.svg-edge-pill--gate', '.svg-gate-pill', '.svg-graphic', '.svg-grid',
  '.svg-group', '.svg-group-title', '.svg-group__frame', '.svg-group__label',
  '.svg-lifeline', '.svg-msg__origin',
  '.svg-node', '.svg-node--external', '.svg-node--gate',
  '.svg-node--gate .svg-node__accent', '.svg-node--gate .svg-node__box',
  '.svg-node--gate .svg-node__num', '.svg-node--gate .svg-node__pill',
  '.svg-node--role-entry .svg-node__accent', '.svg-node--role-external .svg-node__accent',
  '.svg-node--role-gate .svg-node__accent', '.svg-node--role-gate .svg-node__box',
  '.svg-node--role-store .svg-node__accent', '.svg-node--store',
  '.svg-node-sub', '.svg-node-title',
  '.svg-node__accent', '.svg-node__box', '.svg-node__num', '.svg-node__pill', '.svg-node__sub', '.svg-node__title',
  '.svg-note-box', '.svg-note-text',
  '.svg-quant-band', '.svg-quant-iqr', '.svg-quant-p50', '.svg-quant-p95', '.svg-quant-p99',
  '.svg-quant-track', '.svg-quant-whisker', '.svg-row-label',
  '.svg-seg-blocked', '.svg-seg-moved', '.svg-seq-num', '.svg-step-index',
  '.t-attr', '.t-com', '.t-fn', '.t-kw', '.t-mark', '.t-num', '.t-prop', '.t-str', '.t-ty', '.t-var',
  '.table', '.table table', '.table--counts tbody th', '.table--triage tbody th', '.table--triage td.num',
  '.table__scroll', '.table__scroll:focus-visible',
  '.title-block', '.title-block h1', '.title-meta', '.title-meta > div',
  '.title-meta dd', '.title-meta div', '.title-meta dt', '.title-meta dt::after',
  '.title-meta--compact', '.title-meta--compact > div', '.title-meta--compact dd',
  '.title-meta--compact dt', '.title-meta--compact dt::after',
  '.toc', '.toc a', '.toc a span', '.toc a:hover', '.toc a:hover .nav-badge',
  '.toc a[aria-current="page"]', '.toc details[open] > summary::after',
  '.toc details[open] ol', '.toc ol', '.toc summary',
  '.toc summary::-webkit-details-marker', '.toc summary::after', '.toc__count',
  '.topo-group-card', '.topo-group-card ul', '.topo-ledger',
  '.topo-ledger__edges', '.topo-ledger__edges li + li', '.topo-ledger__groups',
  '.triage-pager', '.triage-pager > *', '.triage-pager__link', '.triage-pager__link:hover',
  '.triage-pager__muted', '.triage-pager__pos', '.triage-pager__pos a', '.triage-scope',
  '.unit', '.vband', '.vband--code', '.vband--judgment', '.vband--needs-review', '.vband--review',
  '.verdict', '.verdict .field-label', '.verdict.conf-defect', '.verdict.conf-open',
  '.verdict.conf-proven', '.verdict.conf-recommended', '.verdict__bar', '.verdict__text',
  '.visually-hidden', ':focus-visible', ':root', '[class^="t-"]',
  'a', 'a.ext::after', 'a.ext[href^="http"]::after', 'a:hover', 'a[href^="http"]::after',
  'blockquote', 'body', 'caption', 'code', 'code.opt-key', 'dd', 'dl', 'figure',
  'h1', 'h2', 'h3', 'h4', 'html', 'img', 'ol', 'p', 'pre', 'pre code', 'svg',
  'table', 'tbody th', 'tbody th a', 'tbody th a:focus-visible', 'tbody th a:hover',
  'tbody th[scope="row"]', 'tbody tr:hover', 'tbody tr:last-child td', 'tbody tr:last-child th',
  'td', 'th', 'thead', 'thead th', 'tr', 'ul',
]);

const ALLOWED_ROOT_CUSTOM_PROPS = new Set([
  '--accent', '--accent-border', '--accent-ink', '--accent-wash',
  '--card', '--code-add', '--code-add-strong', '--code-border', '--code-canvas', '--code-chrome',
  '--code-font-size', '--code-highlight', '--code-ink', '--code-inline-bg', '--code-inline-border',
  '--code-inline-ink', '--code-line-height', '--code-muted', '--code-remove', '--code-remove-strong',
  '--copy', '--defect', '--defect-bar', '--defect-bd', '--defect-bg', '--defect-ink',
  '--ink', '--ink-secondary', '--keycap-bg', '--keycap-border', '--keycap-ink',
  '--line', '--line-strong', '--line-subtle', '--measure', '--mono', '--muted',
  '--open', '--open-bar', '--open-bd', '--open-bg', '--open-ink',
  '--page', '--paper', '--prose-measure',
  '--proven', '--proven-bar', '--proven-bd', '--proven-bg', '--proven-ink',
  '--rec-bar', '--rec-bd', '--rec-bg', '--rec-ink', '--recommended',
  '--rfc-bg', '--rfc-border', '--rfc-ink', '--sans', '--serif',
  '--sev-crit-bar', '--sev-crit-bd', '--sev-crit-bg', '--sev-crit-ink',
  '--sev-high-bar', '--sev-high-bd', '--sev-high-bg', '--sev-high-ink',
  '--sev-info-bar', '--sev-info-bd', '--sev-info-bg', '--sev-info-ink',
  '--sev-low-bar', '--sev-low-bd', '--sev-low-bg', '--sev-low-ink',
  '--sev-med-bar', '--sev-med-bd', '--sev-med-bg', '--sev-med-ink',
  '--surface', '--surface-subtle',
  '--svg-baseline', '--svg-budget', '--svg-candidate', '--svg-canvas', '--svg-edge',
  '--svg-gate', '--svg-gate-bg', '--svg-group-bg', '--svg-group-stroke', '--svg-node-bg', '--svg-node-stroke',
  '--svg-quant-band', '--svg-quant-iqr',
  '--t-attr', '--t-com', '--t-fn', '--t-kw', '--t-num', '--t-prop', '--t-str', '--t-ty', '--t-var',
  '--touch', '--vband-review-bd', '--vband-review-bg', '--vband-review-ink',
]);

const ALLOWED_CSS_PROPERTIES = new Set([
  '-webkit-overflow-scrolling', '-webkit-text-size-adjust', '-webkit-user-select',
  'align-content', 'align-items', 'align-self', 'background',
  'border', 'border-block', 'border-bottom', 'border-bottom-color', 'border-collapse', 'border-color',
  'border-inline-start', 'border-inline-start-color', 'border-left', 'border-left-color', 'border-radius',
  'border-style', 'border-top', 'border-top-color', 'box-shadow', 'box-sizing', 'break-after', 'break-inside',
  'clip-path', 'color', 'color-scheme', 'content', 'content-visibility', 'counter-increment', 'counter-reset',
  'cursor', 'display', 'fill', 'flex', 'flex-direction', 'flex-shrink', 'flex-wrap',
  'font', 'font-display', 'font-family', 'font-feature-settings', 'font-kerning', 'font-size',
  'font-style', 'font-variant-numeric', 'font-weight', 'gap',
  'grid-column', 'grid-row', 'grid-template-columns', 'height', 'justify-content', 'justify-items',
  'left', 'letter-spacing', 'line-height', 'list-style',
  'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height', 'max-width',
  'min-height', 'min-width', 'opacity', 'order', 'outline', 'outline-offset',
  'overflow', 'overflow-wrap', 'overflow-x', 'overflow-y', 'overscroll-behavior-inline',
  'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top', 'place-items', 'position',
  'scroll-behavior', 'scroll-margin-top', 'scroll-padding-top', 'scrollbar-gutter', 'src',
  'stroke', 'stroke-dasharray', 'stroke-width', 'tab-size', 'text-align', 'text-decoration',
  'text-decoration-color', 'text-decoration-thickness', 'text-size-adjust', 'text-transform',
  'text-underline-offset', 'top', 'transform', 'transition', 'user-select', 'vertical-align',
  'white-space', 'width', 'word-break', 'z-index',
]);

const ALLOWED_ABS_POS_SELECTORS = new Set([
  '.skip-link', '.visually-hidden', '.sec-num', '.question__options > .field-label', '.ln::before',
]);
const ALLOWED_TRANSFORM_SELECTORS = new Set([
  '.skip-link', '.skip-link:focus', '.legend[open] > summary::after', '.toc details[open] > summary::after', '.sec-num',
]);
const ALLOWED_DISPLAY_NONE_SELECTORS = new Set([
  '.alternatives:empty', '.brand small', '.legend summary::-webkit-details-marker', '.toc summary::-webkit-details-marker',
  '.masthead .classification', '.masthead__status .classification', '.rail', '.toc', '.skip-link', '.triage-pager',
  '.site-footer a', '.legend summary::after',
]);
const PRINT_ONLY_DISPLAY_NONE_SELECTORS = new Set([
  '.skip-link', '.triage-pager', '.site-footer a', '.legend summary::after',
]);
const NARROW_MEDIA_DISPLAY_NONE_SELECTORS = new Set([
  '.brand small', '.masthead .classification', '.masthead__status .classification', '.rail',
]);
const ALLOWED_FLEX_SELECTORS = new Set([
  '.alt__head', '.badge--gate', '.brand', '.chosen', '.cmp-side', '.code__head',
  '.conf', '.cov-pill', '.dec', '.delta-pill', '.ears-pill', '.ev-refs', '.ev-refs a',
  '.ev__head', '.ev__meta-row', '.ev__title', '.figure > figcaption', '.finding > h3',
  '.flow', '.flow-ledger__head', '.item__head', '.item__title-row', '.labels',
  '.legend dl > div', '.legend summary', '.list.item-links li', '.lvl',
  '.masthead', '.masthead__status', '.meta-kv', '.metric-card', '.metric-card dt',
  '.prose-sheet__meta', '.question__bar', '.rail a', '.section > h2', '.section__bar',
  '.sev', '.site-footer', '.site-footer a', '.sitrep-pulse__cell', '.status',
  '.title-meta', '.title-meta > div', '.title-meta--compact', '.title-meta--compact > div',
  '.toc a', '.toc summary', '.triage-pager', '.vband', '.verdict__bar',
]);
const ALLOWED_GRID_SELECTORS = new Set([
  '.alternatives', '.brand__mark', '.comparison > .cmp-grid', '.evidence-list',
  '.figure > figcaption', '.flow', '.flow-ledger', '.flow__step', '.layout',
  '.legend dl', '.legend summary::after', '.meta-kv', '.metrics', '.nav-badge',
  '.prose-sheet', '.prose-sheet__meta', '.question__footer', '.rail a', '.risk-grid',
  '.sitrep-pulse', '.title-meta', '.toc a', '.toc summary::after', '.topo-ledger',
  '.topo-ledger__groups', '.triage-pager',
]);
const ALLOWED_INLINE_SELECTORS = new Set([
  '.ev-refs', '.ev-refs a', '.ev-refs li',
]);
const ALLOWED_INLINE_BLOCK_SELECTORS = new Set([
  '.chosen', '.cite', '.claim > .field-label', '.conf', '.dec', '.ev-refs a', '.gate-label',
  '.item__id', '.ln', '.lvl', '.metric__unit', '.sec-num', '.sev', '.status',
  '.t-mark', '.triage-scope', 'code.opt-key',
]);
const ALLOWED_FLEX_SHRINK_SELECTORS = new Set([
  '.brand__mark', '.legend summary::after', '.list.item-links li > .item__id',
  '.masthead__status', '.metric__cites', '.metrics dt', '.question__ref',
  '.risk dt', '.title-meta dt', '.title-meta--compact dt', '.toc summary::after',
]);
const ALLOWED_PCT_WIDTH_SELECTORS = new Set([
  '.bar', '.chart__bar', '.chart__table svg', '.chart__table td.bar', '.claim',
  '.code__lines', '.decision', '.decision > p', '.document', '.finding', '.finding > p',
  '.layout', '.lede', '.legend', '.list', '.ln', '.masthead', '.metrics', '.prose-sheet',
  '.requirement', '.risk', '.section > p', '.site-footer', '.support', '.svg-graphic',
  '.table--counts tbody th', '.table--triage tbody th', '.verdict', 'table', 'tbody th',
]);
const ALLOWED_NOWRAP_SELECTORS = new Set([
  '.badge--gate', '.chosen', '.cite', '.conf', '.cov-pill', '.dec', '.delta-pill', '.ears-pill',
  '.item__id', '.list.item-links li > .item__id', '.lvl', '.masthead__status', '.metrics dt',
  '.num', '.question__options > .field-label', '.question__ref', '.risk dt', '.sec-num',
  '.sev', '.status', '.title-meta dt', '.title-meta--compact dt', '.triage-scope',
  '.vband', '.visually-hidden', 'thead th',
]);
const ALLOWED_PRE_WRAP_SELECTORS = new Set([
  '.code pre code', '.ln', '.prose-sheet__body p > code:only-child', 'pre',
]);
const ALLOWED_GRID_TEMPLATE_SELECTORS = new Set([
  '.alternatives', '.comparison > .cmp-grid', '.evidence-list', '.flow', '.flow-ledger',
  '.flow__step', '.layout', '.legend dl', '.metrics', '.prose-sheet', '.prose-sheet__meta',
  '.rail a', '.risk-grid', '.sitrep-pulse', '.title-meta', '.toc a',
  '.topo-ledger', '.topo-ledger__groups', '.triage-pager',
]);
const ALLOWED_CLIP_PATH_SELECTORS = new Set([
  '.visually-hidden', '.sec-num', '.question__options > .field-label',
]);
const ALLOWED_CONTENT_SELECTORS = new Set([
  '.ev-refs li + li::before', '.legend summary::after', '.toc summary::after', '.legend[open] > summary::after',
  '.toc details[open] > summary::after', '.ln.add::after', '.ln.del::after', '.ln.hl::after', '.ln::before',
  '.title-meta dt::after', '.title-meta--compact dt::after', 'a.ext::after', 'a.ext[href^="http"]::after', 'a[href^="http"]::after',
]);
const ALLOWED_HEIGHT_SELECTORS = new Set([
  '.bar', '.brand__mark', '.chart__table svg', '.legend summary::after', '.toc summary::after', '.nav-badge',
  '.question__options > .field-label', '.sec-num', '.svg-graphic', '.visually-hidden',
]);
const ALLOWED_MAX_HEIGHT_SELECTORS = new Set(['.rail', '.toc details[open] ol']);
const ALLOWED_OVERFLOW_HIDDEN_SELECTORS = new Set([
  '.code', '.ev-preview', '.legend', '.metrics', '.prose-sheet', '.question__options > .field-label', '.sec-num', '.visually-hidden',
]);
const ALLOWED_FONT_SHORTHAND_SELECTORS = new Set([
  'pre', '.code__head strong', '.flow__index', '.sec-num', '.ln.add::after', '.ln.del::after',
]);
const ALLOWED_SURFACE_COLOR_SELECTORS = new Set([
  '.skip-link', '.brand__mark', '.breadcrumb span', '.sev-critical .sev', '.sev.sev-critical',
]);
const ALLOWED_INK_BACKGROUND_SELECTORS = new Set([
  '.skip-link', '.brand__mark', '.sev-critical .sev', '.sev.sev-critical',
]);
const SURFACE_COLOR_VARS = new Set([
  'var(--card)', 'var(--paper)', 'var(--line)', 'var(--line-strong)',
]);
const DOCUMENT_INK_PROPS = [
  '--accent', '--accent-ink', '--code-inline-ink', '--defect', '--defect-ink',
  '--ink', '--ink-secondary', '--keycap-ink', '--muted', '--open', '--open-ink',
  '--proven', '--proven-ink', '--rec-ink', '--recommended', '--rfc-ink',
  '--sev-crit-ink', '--sev-high-ink', '--sev-info-ink', '--sev-low-ink', '--sev-med-ink',
  '--vband-review-ink',
];
const ALLOWED_DOCUMENT_INK_VARS = new Set(DOCUMENT_INK_PROPS.map((p) => `var(${p})`));
const CODE_TERMINAL_INK_PROPS = [
  '--code-add-strong', '--code-ink', '--code-muted', '--code-remove-strong',
  '--t-attr', '--t-com', '--t-fn', '--t-kw', '--t-num', '--t-prop',
  '--t-str', '--t-ty', '--t-var',
];
const ALLOWED_CODE_TERMINAL_INK_VARS = new Set(CODE_TERMINAL_INK_PROPS.map((p) => `var(${p})`));
const ALLOWED_CODE_TERMINAL_COLOR_SELECTORS = new Set([
  '.code pre', '.code__caption', '.code__head strong', '.code__lang', '.code__lines', '.ev-preview__bar',
  '.ln.add .t-mark', '.ln.del .t-mark', '.ln.hdr', '.ln.hunk', '.ln.meta', '.ln::before',
  '.t-attr', '.t-com', '.t-fn', '.t-kw', '.t-num', '.t-prop', '.t-str', '.t-ty', '.t-var', 'pre',
]);
const DOCUMENT_BG_PROPS = [
  '--paper', '--card', '--surface', '--surface-subtle', '--svg-canvas',
  '--code-inline-bg', '--keycap-bg', '--accent-wash', '--proven-bg',
  '--rec-bg', '--open-bg', '--defect-bg', '--rfc-bg', '--sev-crit-bg',
  '--sev-high-bg', '--sev-info-bg', '--sev-low-bg', '--sev-med-bg', '--vband-review-bg',
];
const ALLOWED_DOCUMENT_BG_VARS = new Set(DOCUMENT_BG_PROPS.map((p) => `var(${p})`));
const CODE_TERMINAL_BG_PROPS = [
  '--code-canvas', '--code-chrome', '--code-add', '--code-remove', '--code-highlight',
];
const ALLOWED_CODE_TERMINAL_BG_VARS = new Set(CODE_TERMINAL_BG_PROPS.map((p) => `var(${p})`));
const ALLOWED_CODE_TERMINAL_BG_SELECTORS = new Set([
  '.cmp-side__code', '.code', '.code__head', '.ev-preview', '.ev-preview__bar',
  '.ln.add', '.ln.del', '.ln.hdr', '.ln.hl', '.ln.hunk', '.ln.meta',
]);
const STRICT_CODE_DOMAIN_SELECTORS = new Set([
  '.cmp-side__code', '.code', '.code pre', '.code pre code', '.code__caption',
  '.code__head', '.code__head strong', '.code__lines', '.code__scroll',
  '.ln', '.ln.add', '.ln.add .t-mark', '.ln.del', '.ln.del .t-mark',
  '.ln.hdr', '.ln.hl', '.ln.hunk', '.ln.meta', '.ln::before',
  '.t-attr', '.t-com', '.t-fn', '.t-kw', '.t-mark', '.t-num', '.t-prop',
  '.t-str', '.t-ty', '.t-var', '[class^="t-"]', 'pre', 'pre code',
]);
const ALLOWED_COLOR_INHERIT_SELECTORS = new Set(['a', 'pre code', '.code pre code']);
const CRIT_SEV_GROUP = ['.sev-critical', '.sev.sev-critical', '.sev-critical .sev'];
const FORBIDDEN_COLOR_BG_SELECTORS = new Set(['.sev', '.skip-link:focus', '.finding.sev-critical']);
const SVG_SURFACE_PROPS = ['--svg-node-bg', '--svg-group-bg', '--svg-gate-bg'];
const ALLOWED_SVG_SURFACE_FILL_VARS = new Set([...DOCUMENT_BG_PROPS, ...SVG_SURFACE_PROPS].map((p) => `var(${p})`));
const SVG_TEXT_FILL_SELECTORS = new Set([
  '.svg-actor-label', '.svg-axis-label', '.svg-budget-label', '.svg-delta',
  '.svg-delta--good', '.svg-delta--warn', '.svg-edge-label', '.svg-gate-pill',
  '.svg-group-title', '.svg-group__label', '.svg-node--gate .svg-node__num',
  '.svg-node-sub', '.svg-node-title', '.svg-node__num', '.svg-node__sub',
  '.svg-node__title', '.svg-note-text', '.svg-row-label', '.svg-seq-num', '.svg-step-index',
]);
const SVG_SURFACE_FILL_SELECTORS = new Set([
  '.svg-actor', '.svg-area-unavail', '.svg-edge-pill', '.svg-edge-pill--gate',
  '.svg-group', '.svg-group__frame', '.svg-node', '.svg-node--gate',
  '.svg-node--gate .svg-node__box', '.svg-node--gate .svg-node__pill',
  '.svg-node--role-gate .svg-node__box', '.svg-node--store', '.svg-node__box',
  '.svg-node__pill', '.svg-note-box',
]);
const SVG_MARK_FILL_SELECTORS = new Set([
  '.bar__baseline', '.bar__candidate', '.bar__fill', '.bar__track',
  '.svg-arrow', '.svg-arrow--gate', '.svg-edge', '.svg-msg__origin',
  '.svg-node--gate .svg-node__accent', '.svg-node--role-entry .svg-node__accent',
  '.svg-node--role-external .svg-node__accent', '.svg-node--role-gate .svg-node__accent',
  '.svg-node--role-store .svg-node__accent', '.svg-node__accent',
  '.svg-quant-band', '.svg-quant-iqr', '.svg-quant-p50', '.svg-quant-p99',
  '.svg-seg-blocked', '.svg-seg-moved',
]);
const ALLOWED_SVG_MARK_FILL_VARS = new Set([
  'none', 'var(--svg-baseline)', 'var(--svg-candidate)', 'var(--recommended)',
  'var(--surface)', 'var(--svg-edge)', 'var(--svg-gate)', 'var(--accent)',
  'var(--proven-bar)', 'var(--sev-low-bar)', 'var(--open-bar)',
  'var(--svg-quant-band)', 'var(--svg-quant-iqr)', 'var(--card)',
  'var(--sev-high-bar)', 'var(--sev-crit-bar)',
]);
const NON_HEX_ROOT_CUSTOM_PROPS = new Set([
  '--code-font-size', '--code-line-height', '--copy', '--measure', '--prose-measure',
  '--page', '--mono', '--sans', '--serif', '--touch',
]);
const REQUIRED_CORE_ROOT_PROPS = [
  '--paper', '--ink', '--muted', '--line', '--surface', '--accent', '--accent-ink',
  '--serif', '--sans', '--mono', '--page', '--touch',
];
const ALLOWED_TRANSPARENT_BG_SELECTORS = new Set([
  '.code pre code', 'pre code', '.ln.add', '.ln.del', '.ln.hl', '.title-meta--compact',
]);
const ALLOWED_PAGE_WIDTH_SELECTORS = new Set([
  '.layout', '.masthead', '.site-footer', '.toc',
]);
const ALLOWED_RIGHT_ALIGN_SELECTORS = new Set([
  '.ln::before', '.masthead__status', '.num',
]);
const ALLOWED_GRID_TEMPLATE_VALUES = new Set([
  '1fr', '1fr auto', 'max-content 1fr', 'minmax(0, 1fr)',
  '1.65rem 1fr', '1.65rem minmax(0, 1fr)', '2.2rem 1fr',
  '14.5rem minmax(0, 1fr)', 'minmax(0, 1fr) 16.5rem', 'minmax(0, 1fr) 17rem',
  'minmax(11rem, 15rem) minmax(0, 1fr)', 'minmax(13rem, 16.5rem) minmax(0, 1fr)',
  'minmax(13.5rem, 15.25rem) minmax(0, 1fr)', 'minmax(13.5rem, 15.5rem) minmax(0, 1fr)',
  'minmax(13.5rem, 16rem) minmax(0, 1fr)',
  'repeat(2, minmax(0, 1fr))', 'repeat(4, minmax(0, 1fr))',
  'repeat(4, minmax(0, 1fr)) minmax(11.5rem, 1.35fr)',
  'repeat(4, minmax(0, 1fr)) minmax(12rem, 1.35fr)',
  'repeat(auto-fit, minmax(10rem, 1fr))', 'repeat(auto-fit, minmax(12rem, 1fr))',
  'repeat(auto-fit, minmax(13rem, 1fr))', 'repeat(auto-fit, minmax(14rem, 1fr))',
  'repeat(auto-fit, minmax(min(11.5rem, 100%), 1fr))',
  'repeat(auto-fit, minmax(min(13rem, 100%), 1fr))',
  'repeat(auto-fit, minmax(min(13.5rem, 100%), 1fr))',
  'repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
  'repeat(auto-fit, minmax(min(15rem, 100%), 1fr))',
  'repeat(auto-fit, minmax(min(16rem, 100%), 1fr))',
  'repeat(auto-fit, minmax(min(18rem, 1fr))',
  'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))',
]);

// ---------------------------------------------------------------------------------------
// Rulebooks. The stylesheet and markup rules are selected by manifest.build.renderPolicy
// (render-policy-2.md R1). RULES_1 is exactly the constants above: render-policy/1 is
// frozen, and SitRep site bundles (src/site/verify.mjs) always get it by default.
// RULES_2 is the render-policy/2 allowlist, derived from what html-v2.mjs and
// edition-2.1.css emit for every block type. It reuses every policy/1 value grammar; the
// rules R6 names (tokens, dark bands, contrast, amber, plate palette, flex layout) are
// its own, and the few declarations the shared grammar cannot express are pinned below
// by exact media context, selector and value.
const RULES_1 = Object.freeze({
  policy: RENDER_POLICY_1,
  ALLOWED_CSS_AT_RULES, ALLOWED_MEDIA_PRELUDES, ALLOWED_LAYER_PRELUDES,
  ALLOWED_CSS_SELECTOR_PARTS, ALLOWED_ROOT_CUSTOM_PROPS, ALLOWED_CSS_PROPERTIES,
  ALLOWED_ABS_POS_SELECTORS, ALLOWED_TRANSFORM_SELECTORS, ALLOWED_DISPLAY_NONE_SELECTORS,
  PRINT_ONLY_DISPLAY_NONE_SELECTORS, NARROW_MEDIA_DISPLAY_NONE_SELECTORS,
  ALLOWED_FLEX_SELECTORS, ALLOWED_GRID_SELECTORS, ALLOWED_INLINE_SELECTORS, ALLOWED_INLINE_BLOCK_SELECTORS,
  ALLOWED_FLEX_SHRINK_SELECTORS, ALLOWED_PCT_WIDTH_SELECTORS, ALLOWED_NOWRAP_SELECTORS, ALLOWED_PRE_WRAP_SELECTORS,
  ALLOWED_GRID_TEMPLATE_SELECTORS, ALLOWED_CLIP_PATH_SELECTORS, ALLOWED_CONTENT_SELECTORS, ALLOWED_HEIGHT_SELECTORS,
  ALLOWED_OVERFLOW_HIDDEN_SELECTORS, ALLOWED_FONT_SHORTHAND_SELECTORS, ALLOWED_PAGE_WIDTH_SELECTORS,
  ALLOWED_RIGHT_ALIGN_SELECTORS, ALLOWED_GRID_TEMPLATE_VALUES, ALLOWED_TRANSPARENT_BG_SELECTORS,
  NON_HEX_ROOT_CUSTOM_PROPS, REQUIRED_CORE_ROOT_PROPS,
});

const ALLOWED_CSS_SELECTOR_PARTS_2 = new Set([
  '*', '*::after', '*::before', ':focus-visible', ':root',
  'a', 'a.cite', 'a.cite:hover', 'a.ext::after', 'a:hover', 'b', 'blockquote', 'body', 'caption', 'code',
  'dd', 'dl', 'figure', 'h1', 'h2', 'h3', 'h4', 'html', 'ol', 'p', 'pre', 'pre code', 'strong', 'table',
  'tbody .col-id', 'tbody th', 'tbody tr:last-child > *', 'td', 'th', 'thead th', 'tr', 'ul',
  '.b-anchor', '.b-anchor:hover', '.b-anchor:target', '.b-anchors', '.b-anchors .b-anchor',
  '.badge--gate', '.bar', '.bar__baseline', '.bar__candidate', '.bar__fill', '.bar__track',
  '.block', '.block > *', '.block > .b-anchor', '.block > .b-anchors', '.block > .figures',
  '.block--decision + .block--decision', '.block--decision + .block--decision .decision',
  '.block--list > :not(.b-anchor)', '.block--paragraph > :not(.b-anchor)',
  '.block:not(.block--paragraph):not(.block--list) > .b-anchor',
  '.block:not(.block--paragraph):not(.block--list) > :not(.b-anchor):not(.b-anchors)',
  '.chart-table', '.chart__bar', '.cite-run', '.table__scroll .cite-run', '.cmp-grid', '.cmp-side', '.cmp-side--proposed',
  '.cmp-side--proposed .cmp-side__tag', '.cmp-side__code', '.cmp-side__list', '.cmp-side__list li',
  '.cmp-side__summary', '.cmp-side__tag',
  '.code', '.code__caption', '.code__caption strong', '.code__frame', '.code__head', '.code__lines a', '.code__scroll',
  '.colophon', '.colophon :focus-visible', '.colophon .rfc2119', '.colophon a', '.colophon a.cite', '.colophon code', '.colophon__cmd', '.colophon__cmd::before',
  '.colophon__digest', '.colophon__digest b', '.colophon__foot', '.colophon__gen', '.colophon__inner', '.colophon__label',
  '.colophon__mark', '.colophon__mark .lockup', '.colophon__mark--ruled', '.colophon__notes', '.colophon__ref',
  '.colophon__seal', '.colophon__sources', '.colophon__text', '.colophon__title', '.colophon__verify',
  '.colophon__verify .colophon__label', '.colophon__verify .colophon__text',
  '.comparison__head', '.comparison__head strong',
  '.conf', '.conf--defect', '.conf--open', '.conf--proven', '.conf--recommended', '.conf__glyph',
  '.consequences', '.decision', '.decision__context', '.decision__label', '.decision__options .decision__label',
  '.decision__question', '.decision__question .idx', '.decision__rec', '.decision__rec .conf', '.decision__status',
  '.delta-pill', '.delta-pill--good', '.delta-pill--warn', '.diagram-canvas', '.document', '.ears-kw', '.ears-tag',
  '.ev', '.ev-preview', '.ev-preview__bar', '.ev-preview__table', '.ev-preview__table td', '.ev-preview__table th',
  '.ev__body', '.ev__cited', '.ev__digest', '.ev__digest code', '.ev__excerpt', '.ev__excerpt > summary',
  '.ev__excerpt::details-content', '.ev__file', '.ev__file a', '.ev__id', '.ev__label', '.ev__meta', '.ev__title',
  '.ev__withheld', '.evidence-list',
  '.figures', '.figures dd', '.figures dt', '.figures__cell', '.figures__cell:not(:nth-child(3n + 1))',
  '.figures__cell:nth-child(2n + 1)', '.figures__cell:nth-child(2n)', '.figures__cell:nth-child(3n + 1)',
  '.figures__unit', '.figures__value',
  '.finding', '.finding--critical', '.finding--high', '.finding--low', '.finding--medium', '.finding__claim',
  '.finding__detail', '.finding__detail > * + *', '.finding__head', '.finding__title', '.finding__title .idx',
  '.flow-ledger', '.flow-ledger__head', '.flow-ledger__item', '.flow-ledger__item p', '.flow-ledger__item--gate', '.flow__num',
  '.formats', '.formats a', '.formats a + a', '.formats a:hover', '.formats a[aria-current="page"]',
  '.idx', '.kicker', '.layout', '.lede', '.list', '.list > li', '.list > li + li', '.list--ordered',
  '.list--ordered > li', '.list--ordered > li::before',
  '.ln', '.ln.add', '.ln.add::after', '.ln.del', '.ln.del::after', '.ln.hdr', '.ln.hl', '.ln.hl::after', '.ln::before', '.lvl',
  '.masthead', '.masthead :focus-visible', '.masthead__brand', '.masthead__brand .lockup', '.masthead__slug',
  '.meta-line', '.meta-strip', '.meta-strip > div', '.meta-strip > div + div', '.meta-strip > div:first-child',
  '.meta-strip dd', '.meta-strip dt', '.meta-strip__cell', '.meta-strip__cell:first-child', '.meta-strip__count',
  '.meta-strip__count + .meta-strip__count', '.meta-strip__count dd', '.meta-strip__count:nth-child(4)',
  '.mono', '.muted', '.num', '.open-tag',
  '.option', '.option__arrow', '.option__key', '.option__label', '.option__label .stamp', '.option__label strong',
  '.option__summary', '.options', '.pip', '.pip--critical', '.pip--on', '.pips',
  '.plate', '.plate--chart .plate__ledger', '.plate__caption', '.plate__caption strong', '.plate__frame',
  '.plate__frame .diagram-canvas::after', '.plate__frame .diagram-canvas::before', '.plate__frame::after',
  '.plate__frame::before', '.plate__ledger', '.plate__ref', '.plate__text', '.plate__title', '.prose-para',
  '.rail', '.rail li', '.rail ol', '.rail__ev-title', '.rail__evidence', '.rail__evidence a', '.rail__evidence li',
  '.rail__label', '.rail__num', '.rail__size', '.rail__toc', '.rail__toc a', '.rail__toc a:hover',
  '.requirement', '.requirement .table__scroll', '.requirement__head', '.requirement__spec', '.requirement__title', '.rfc2119',
  '.risk-table td:nth-child(2)', '.risk-table td:nth-child(3)', '.risk-table th[scope="row"]', '.risk-table th[scope="row"] .idx',
  '.sec-num', '.section', '.section--summary', '.section__head', '.section__title',
  '.seq-ledger', '.seq-ledger li', '.seq-ledger li::before', '.sev', '.signals', '.skip-link', '.skip-link:focus',
  '.stamp', '.subtitle',
  '.svg-arrow', '.svg-arrow--gate', '.svg-axis-label', '.svg-budget-label', '.svg-budget-line',
  '.svg-delta', '.svg-delta--good', '.svg-delta--warn', '.svg-edge', '.svg-edge--dashed', '.svg-edge--gate',
  '.svg-edge-label', '.svg-edge-pill', '.svg-edge-pill--gate', '.svg-graphic', '.svg-grid',
  '.svg-group__frame', '.svg-group__label', '.svg-lifeline', '.svg-msg__origin',
  '.svg-node--gate .svg-node__accent', '.svg-node--gate .svg-node__box', '.svg-node--gate .svg-node__num',
  '.svg-node--gate .svg-node__pill', '.svg-node--role-entry .svg-node__accent', '.svg-node--role-external .svg-node__accent',
  '.svg-node--role-gate .svg-node__accent', '.svg-node--role-gate .svg-node__box', '.svg-node--role-store .svg-node__accent',
  '.svg-node__accent', '.svg-node__box', '.svg-node__num', '.svg-node__pill', '.svg-node__sub', '.svg-node__title',
  '.svg-note-box', '.svg-note-text',
  '.svg-quant-band', '.svg-quant-iqr', '.svg-quant-p50', '.svg-quant-p95', '.svg-quant-p99', '.svg-quant-track',
  '.svg-quant-whisker', '.svg-row-label',
  '.t-attr', '.t-com', '.t-fn', '.t-kw', '.t-mark', '.t-num', '.t-prop', '.t-str', '.t-ty', '.t-var',
  '.table', '.table table', '.table__scroll', '.title-block',
  '.topo-group-card', '.topo-group-card .field-label', '.topo-group-card li', '.topo-group-card strong', '.topo-group-card ul',
  '.topo-ledger', '.topo-ledger__edges', '.topo-ledger__edges li', '.topo-ledger__edges li::before', '.topo-ledger__groups',
  '.unit', '.verdict', '.verdict__ask', '.verdict__ask-label', '.verdict__label', '.verdict__text', '.visually-hidden',
]);

// R6 tokens: the v2 base tokens plus BRIEF §4 and canon-2.1-signals.css. The retired
// policy/1 tokens are simply absent (and are also rejected by name, see RETIRED_*).
const ALLOWED_ROOT_CUSTOM_PROPS_2 = new Set([
  '--paper', '--card', '--surface', '--surface-subtle', '--ink', '--ink-secondary', '--muted',
  '--line', '--line-strong', '--line-subtle',
  '--accent', '--accent-ink', '--accent-wash', '--accent-border',
  '--proven-ink', '--proven-bg', '--proven-bd', '--rec-ink', '--rec-bg', '--rec-bd',
  '--defect-ink', '--defect-bg', '--defect-bd',
  '--sev-bar-critical', '--sev-bar-high', '--sev-bar-medium', '--sev-bar-low',
  '--pip-on', '--pip-off', '--pip-critical', '--stamp-bg', '--stamp-ink', '--rule-chip-bd', '--open-bd-style',
  '--chrome-band', '--chrome-band-ink', '--chrome-band-line', '--chrome-band-muted', '--chrome-band-accent', '--chrome-band-current',
  '--code-inline-ink', '--code-inline-bg', '--code-inline-border',
  '--svg-canvas', '--svg-node-bg', '--svg-node-stroke', '--svg-group-bg', '--svg-group-stroke', '--svg-edge',
  '--svg-gate', '--svg-gate-bg', '--svg-baseline', '--svg-candidate', '--svg-quant-band', '--svg-quant-iqr', '--svg-budget',
  '--serif', '--sans', '--mono', '--page', '--margin-col', '--measure', '--touch',
  '--code-font-size', '--code-line-height', '--code-canvas', '--code-chrome', '--code-border', '--code-ink', '--code-muted',
  '--code-highlight', '--code-add', '--code-add-strong', '--code-remove', '--code-remove-strong',
  '--t-kw', '--t-str', '--t-num', '--t-com', '--t-ty', '--t-fn', '--t-prop', '--t-var', '--t-attr',
]);
// R6: these tokens follow a token that flips instead of restating a dark value. They are
// the only :root tokens whose value may be var(<another token>).
const ALIAS_ROOT_PROPS_2 = new Set([
  '--sev-bar-high', '--pip-on', '--pip-off', '--pip-critical', '--stamp-bg', '--stamp-ink', '--rule-chip-bd',
]);
// R6 retired tokens and hex values: absent from the policy/2 stylesheet, comments included.
// "--open-*" is the policy/1 open-question family; --open-bd-style is the BRIEF §4 /
// canon-2.1-signals.css token that replaces it and is not retired.
const RETIRED_TOKEN_RE_2 = /(?<![a-z0-9_-])--(?:sev-high-|sev-med-|sev-info-bar|vband-review-|rfc-|open(?![a-z0-9-])|open-(?!bd-style(?![a-z0-9-])))/i;
const RETIRED_HEX_2 = ['#c2410c', '#ca8a04', '#9a3412', '#854d0e', '#7e22ce', '#6b21a8', '#3730a3'];

const ALLOWED_CSS_PROPERTIES_2 = new Set([
  ...ALLOWED_CSS_PROPERTIES,
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'right', 'bottom', 'justify-self', 'outline-color',
]);
const ALLOWED_MEDIA_PRELUDES_2 = new Set([
  '@media (max-width: 1100px)', '@media (max-width: 720px)',
  '@media (prefers-color-scheme: dark)', '@media (prefers-reduced-motion: reduce)', '@media print',
]);

// R6 dark bands: --chrome-band-* only on the masthead and colophon and their descendants.
// .formats is the masthead's nav (R5; the structure check confines it to header.masthead).
const BAND_PART_RE_2 = /^(?:\.masthead(?![a-z0-9_-])|\.masthead__[a-z0-9_-]+|\.colophon(?![a-z0-9_-])|\.colophon__[a-z0-9_-]+|\.formats(?![a-z0-9_-]))/;
// R6 amber: --svg-gate / --svg-gate-bg only on gate selectors: role-gate nodes, the
// --gate node, edge, arrow, pill and ledger-item modifiers, and .badge--gate.
const GATE_PART_RE_2 = /\.(?:svg-node--role-gate|svg-node--gate|svg-edge--gate|svg-arrow--gate|svg-edge-pill--gate|flow-ledger__item--gate|badge--gate)(?![a-z0-9_-])/;
// Token families whose use is scoped to particular selectors (checked on every
// declaration value, whatever the property).
const TOKEN_SCOPES_2 = [
  { re: /^--chrome-band/, ok: (part) => BAND_PART_RE_2.test(part), what: 'the masthead or colophon band' },
  { re: /^--svg-gate(?:-bg)?$/, ok: (part) => GATE_PART_RE_2.test(part), what: 'a gate selector' },
  { re: /^--stamp-/, ok: (part) => part === '.stamp', what: '.stamp' },
  { re: /^--pip-/, ok: (part) => /^\.pip(?:--on|--critical)?$/.test(part), what: '.pip' },
  { re: /^--sev-bar-/, ok: (part) => /^\.finding--(?:critical|high|medium|low)$/.test(part), what: '.finding--<severity>' },
  { re: /^--rule-chip-bd$/, ok: (part) => part === '.rfc2119', what: '.rfc2119' },
  { re: /^--open-bd-style$/, ok: (part) => part === '.open-tag' || part === '.conf--open', what: '.open-tag or .conf--open' },
];
// R6 contrast. Text inks reach 4.5:1 against every document and code surface; band inks
// against the band surfaces; the gate ink against the gate surface; the stamp ink
// against the stamp; in the light, dark and print schemes.
const TEXT_INK_PROPS_2 = [
  '--ink', '--ink-secondary', '--muted', '--accent-ink', '--proven-ink', '--rec-ink', '--defect-ink',
  '--code-inline-ink', '--code-ink', '--code-muted',
  '--t-kw', '--t-str', '--t-num', '--t-com', '--t-ty', '--t-fn', '--t-prop', '--t-var', '--t-attr',
];
const SURFACE_BG_PROPS_2 = [
  '--paper', '--card', '--surface', '--surface-subtle', '--accent-wash', '--proven-bg', '--rec-bg', '--defect-bg',
  '--code-inline-bg', '--svg-canvas', '--svg-node-bg', '--svg-group-bg',
  '--code-canvas', '--code-chrome', '--code-highlight', '--code-add', '--code-remove',
];
const CONTRAST_PAIRS_2 = [
  { inks: TEXT_INK_PROPS_2, bgs: SURFACE_BG_PROPS_2, what: 'document text' },
  { inks: ['--chrome-band-ink', '--chrome-band-muted', '--chrome-band-accent'], bgs: ['--chrome-band', '--chrome-band-current'], what: 'band text' },
  { inks: ['--svg-gate'], bgs: ['--svg-gate-bg'], what: 'gate text' },
  { inks: ['--stamp-ink'], bgs: ['--stamp-bg'], what: 'stamp text' },
];
// R6 (WCAG 1.4.11 non-text contrast, 3:1): the pips and severity bars carry the rating
// graphically, so blanking them (say --pip-on: var(--line)) must fail. --sev-bar-low is
// exempt by Captain's ruling: the brief makes the low bar a deliberate hairline, and the
// meaning is carried by the severity word and the pips, which these pairs do enforce
// (a sealed packet's stylesheet is also byte-compared by the reproduction step).
const NONTEXT_PAIRS_2 = [
  { marks: ['--pip-on', '--pip-critical'], bgs: ['--pip-off', '--card'], what: 'pip' },
  { marks: ['--sev-bar-critical', '--sev-bar-high', '--sev-bar-medium'], bgs: ['--card'], what: 'severity bar' },
];
const TEXT_INK_VARS_2 = new Set(TEXT_INK_PROPS_2.map((p) => `var(${p})`));
const SURFACE_BG_VARS_2 = new Set(SURFACE_BG_PROPS_2.map((p) => `var(${p})`));
const SVG_TEXT_FILL_SELECTORS_2 = new Set([
  '.svg-group__label', '.svg-node__num', '.svg-node--gate .svg-node__num', '.svg-node__title', '.svg-node__sub',
  '.svg-edge-label', '.svg-note-text', '.svg-axis-label', '.svg-row-label', '.svg-delta--good', '.svg-delta--warn',
  '.svg-budget-label',
]);
const SVG_SURFACE_FILL_SELECTORS_2 = new Set([
  '.svg-group__frame', '.svg-node__box', '.svg-node--gate .svg-node__box', '.svg-node--role-gate .svg-node__box',
  '.svg-node__pill', '.svg-node--gate .svg-node__pill', '.svg-edge-pill', '.svg-edge-pill--gate', '.svg-note-box',
]);
const SVG_MARK_FILL_SELECTORS_2 = new Set([
  '.svg-node__accent', '.svg-node--gate .svg-node__accent', '.svg-node--role-gate .svg-node__accent',
  '.svg-node--role-entry .svg-node__accent', '.svg-node--role-store .svg-node__accent', '.svg-node--role-external .svg-node__accent',
  '.svg-arrow', '.svg-arrow--gate', '.svg-msg__origin', '.bar__track', '.bar__fill', '.bar__baseline', '.bar__candidate',
  '.svg-quant-band', '.svg-quant-iqr', '.svg-quant-p50', '.svg-quant-p99',
]);
const SVG_MARK_FILL_VARS_2 = new Set([
  'var(--svg-edge)', 'var(--svg-gate)', 'var(--accent)', 'var(--ink)', 'var(--svg-candidate)', 'var(--svg-baseline)',
  'var(--surface)', 'var(--card)', 'var(--svg-quant-band)', 'var(--svg-quant-iqr)',
]);
// R6 plate palette: the entry, store and external layer accents are ink, never purple.
const INK_ONLY_ACCENT_SELECTORS_2_LIST = [
  '.svg-node--role-entry .svg-node__accent', '.svg-node--role-store .svg-node__accent', '.svg-node--role-external .svg-node__accent',
];
const INK_ONLY_ACCENT_SELECTORS_2 = new Set(INK_ONLY_ACCENT_SELECTORS_2_LIST);
const ALLOWED_TRANSPARENT_BG_SELECTORS_2 = new Set(['.conf--open', '.colophon code', 'pre code']);
// Declarations the shared policy/1 grammar has no form for, pinned exactly:
// "<media prelude or empty>|<selector>" -> "prop: value" (value as the checker normalises it).
const PINNED_DECLARATIONS_2 = new Map(Object.entries({
  '|.masthead': ['padding: 0.85rem max(1.25rem, calc((100% - 80rem) / 2))'],
  '|.colophon': ['padding: 2.5rem max(1.25rem, calc((100% - 80rem) / 2)) 1.75rem', 'margin-top: 5rem'],
  '|.section': ['margin-top: 3.5rem'],
  '|.cmp-side--proposed': ['padding-top: calc(0.55rem - 1px)'],
  '|.layout': ['gap: 2.5rem 3rem'],
  '|.colophon__inner': ['gap: 2rem 3rem'],
  '|.pips': ['gap: 2px'],
  '|.pip': ['width: 7px', 'height: 7px', 'border-radius: 1.5px'],
  '|.plate__frame::before, .plate__frame::after, .plate__frame .diagram-canvas::before, .plate__frame .diagram-canvas::after': ['width: 14px', 'height: 14px'],
  // R6 layout: .document { flex: 999 1 600px } and .rail { flex: 1 1 250px }.
  '|.document': ['flex: 999 1 600px'],
  '|.rail': ['flex: 1 1 250px'],
  '|.colophon__seal': ['flex: 1 1 32rem'],
  '|.colophon__verify': ['flex: 0 1 20rem'],
  '|.colophon__foot': ['align-items: flex-end'],
  '|.risk-table th[scope="row"]': ['min-width: 12rem'],
  '|h1': ['font-size: clamp(2.5rem, 6vw, 4.75rem)'],
  '|.verdict__text': ['font-size: clamp(1.3rem, 2.4vw, 1.7rem)'],
  '|.ev__excerpt > summary': ['display: list-item', 'line-height: 2rem'],
  '|a:hover': ['text-decoration-thickness: 2px'],
  '|.rfc2119': ['vertical-align: 0.08em'],
  '|a.cite, .idx': ['vertical-align: 0.08em'],
  '|.rail__ev-title': ['text-overflow: ellipsis'],
  '@media (prefers-reduced-motion: reduce)|*, *::before, *::after': ['animation: none !important'],
  '@media print|.b-anchor': ['color: #334155'],
  // Backgrounds do not print: the stamp becomes ruled #000 ink on the page.
  '@media print|.stamp': ['background: none'],
  '@media print|.pip, .pip--on, .pip--critical': ['print-color-adjust: exact', '-webkit-print-color-adjust: exact'],
}).map(([k, v]) => [k, new Set(v)]));
// Classes whose every rule is pinned exactly (review 4 MINOR 1): a rule whose selector names
// one of these classes must be one of the keys below, inside no other at-rule, and may set
// only the declarations listed for it. Nothing else may be widened: no other selector, no
// other property, no other value. The phone-width overflow fix: a cite run moves to the
// next line as one box and wraps inside only when it alone is wider than the line, and it
// stays unbreakable only inside a scrolling data table.
// "<media prelude or empty>|<selector>" -> "prop: value" (value as the checker normalises it).
const EXACT_DECLARATIONS_2 = Object.freeze({
  classes: Object.freeze(['cite-run']),
  rules: new Map(Object.entries({
    '|.cite-run': ['display: inline-block', 'max-width: 100%'],
    '|.table__scroll .cite-run': ['white-space: nowrap'],
  }).map(([k, v]) => [k, new Set(v)])),
});
const namesExactClass = (selector, classes) => classes.some((c) => new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(selector));

// Generated content, pinned per selector part (policy/1 checks only where content may
// appear; policy/2 also fixes what it says, so no text can be injected through CSS).
const CONTENT_VALUES_2 = new Map(Object.entries({
  '.list--ordered > li::before': ['counter(item)'],
  '.plate__frame::before': ['""'], '.plate__frame::after': ['""'],
  '.plate__frame .diagram-canvas::before': ['""'], '.plate__frame .diagram-canvas::after': ['""'],
  '.colophon__cmd::before': ['"$ "'],
  '.topo-ledger__edges li::before': ['counter(edge)'], '.seq-ledger li::before': ['counter(edge)'],
  '.ln::before': ['counter(ln)'],
  '.ln.add::after': ['" [added]"'], '.ln.del::after': ['" [removed]"'], '.ln.hl::after': ['" [highlighted]"'],
  'a.ext::after': ['" <" attr(href) ">"'],
}).map(([k, v]) => [k, new Set(v)]));
// Top-level declarations a policy/2 stylesheet must make (the canvas and code surfaces).
const REQUIRED_TOP_DECLARATIONS_2 = [
  { selector: 'body', prop: 'background', value: 'var(--paper)' },
  { selector: 'body', prop: 'color', value: 'var(--ink)' },
  { selector: '.code__frame', prop: 'background', value: 'var(--code-canvas)' },
  { selector: '.code__head', prop: 'background', value: 'var(--code-chrome)' },
  { selector: 'pre', prop: 'color', value: 'var(--code-ink)' },
  // Authored provenance notes sit on the colophon band, so the keyword chips and cites
  // they may carry (BAND_CLASS_RE_2) must take band colours there.
  { selector: '.colophon .rfc2119', prop: 'color', value: 'var(--chrome-band-ink)' },
  { selector: '.colophon .rfc2119', prop: 'border-color', value: 'var(--chrome-band-ink)' },
  { selector: '.colophon a.cite', prop: 'color', value: 'var(--chrome-band-accent)' },
  { selector: '.colophon a.cite', prop: 'background', value: 'var(--chrome-band-current)' },
  // R6 plate palette: the layer accents are explicitly ink.
  ...[...INK_ONLY_ACCENT_SELECTORS_2_LIST].map((selector) => ({ selector, prop: 'fill', value: 'var(--ink)' })),
];

const RULES_2 = Object.freeze({
  ...RULES_1,
  policy: RENDER_POLICY_2,
  ALLOWED_MEDIA_PRELUDES: ALLOWED_MEDIA_PRELUDES_2,
  ALLOWED_CSS_SELECTOR_PARTS: ALLOWED_CSS_SELECTOR_PARTS_2,
  ALLOWED_ROOT_CUSTOM_PROPS: ALLOWED_ROOT_CUSTOM_PROPS_2,
  ALLOWED_CSS_PROPERTIES: ALLOWED_CSS_PROPERTIES_2,
  ALLOWED_ABS_POS_SELECTORS: new Set([
    '.skip-link', '.visually-hidden', '.list--ordered > li::before', '.ln::before',
    '.plate__frame::before', '.plate__frame::after', '.plate__frame .diagram-canvas::before', '.plate__frame .diagram-canvas::after',
    '.topo-ledger__edges li::before', '.seq-ledger li::before',
  ]),
  ALLOWED_TRANSFORM_SELECTORS: new Set(['.skip-link', '.skip-link:focus']),
  ALLOWED_DISPLAY_NONE_SELECTORS: new Set(['.skip-link', '.rail', '.formats']),
  PRINT_ONLY_DISPLAY_NONE_SELECTORS: new Set(['.skip-link', '.rail', '.formats']),
  NARROW_MEDIA_DISPLAY_NONE_SELECTORS: new Set(),
  ALLOWED_FLEX_SELECTORS: new Set([
    '.masthead', '.masthead__brand', '.formats', '.formats a', '.layout', '.kicker', '.b-anchors', '.signals',
    '.sev', '.lvl', '.pips', '.conf', '.verdict__label', '.figures__cell', '.finding__head', '.requirement__head',
    '.rail__evidence li', '.rail__evidence a', '.colophon__inner', '.colophon__foot', '.plate__caption',
    '.flow-ledger__head', '.code__head',
  ]),
  ALLOWED_GRID_SELECTORS: new Set([
    '.meta-strip', '.section__head', '.block', '.figures', '.decision', '.option', '.cmp-grid', '.ev',
    '.rail__toc a', '.flow-ledger', '.topo-ledger__groups',
  ]),
  ALLOWED_INLINE_SELECTORS: new Set(),
  ALLOWED_INLINE_BLOCK_SELECTORS: new Set([
    '.rfc2119', 'a.cite', '.idx', '.stamp', '.open-tag', '.badge--gate', '.delta-pill', '.ears-tag', '.ln', '.t-mark', '.block > .b-anchor',
  ]),
  ALLOWED_FLEX_SHRINK_SELECTORS: new Set(['.rail__size']),
  ALLOWED_PCT_WIDTH_SELECTORS: new Set(['.svg-graphic', '.bar', '.chart__bar', 'table', '.table table', '.ln', '.layout']),
  ALLOWED_NOWRAP_SELECTORS: new Set([
    '.visually-hidden', 'a.cite', '.idx', '.stamp', '.sev', '.lvl', '.conf', '.ears-tag', 'tbody .col-id',
    '.risk-table td:nth-child(2)', '.risk-table td:nth-child(3)', '.rail__ev-title',
  ]),
  ALLOWED_PRE_WRAP_SELECTORS: new Set(['pre', '.ln']),
  ALLOWED_GRID_TEMPLATE_SELECTORS: new Set([
    '.meta-strip', '.section__head', '.block', '.figures', '.decision', '.option', '.cmp-grid', '.ev',
    '.rail__toc a', '.flow-ledger', '.topo-ledger__groups',
  ]),
  ALLOWED_GRID_TEMPLATE_VALUES: new Set([
    'minmax(0, 1fr)', 'var(--margin-col) minmax(0, 1fr)', 'minmax(9rem, 1.4fr) auto auto repeat(4, auto)',
    'repeat(2, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))', 'repeat(4, minmax(0, 1fr))',
    'minmax(0, 1.25fr) minmax(0, 1fr)', '1.6rem minmax(0, 1fr)', '2.25rem minmax(0, 1fr)',
    'repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
  ]),
  ALLOWED_CLIP_PATH_SELECTORS: new Set(['.visually-hidden']),
  ALLOWED_CONTENT_SELECTORS: new Set(CONTENT_VALUES_2.keys()),
  ALLOWED_HEIGHT_SELECTORS: new Set([
    '.masthead__brand .lockup', '.colophon__mark .lockup', '.visually-hidden', '.svg-graphic', '.bar', '.pip',
    '.plate__frame::before', '.plate__frame::after', '.plate__frame .diagram-canvas::before', '.plate__frame .diagram-canvas::after',
  ]),
  ALLOWED_OVERFLOW_HIDDEN_SELECTORS: new Set(['.visually-hidden', '.formats', '.code__frame', '.ev-preview', '.rail__ev-title']),
  ALLOWED_FONT_SHORTHAND_SELECTORS: new Set(['pre']),
  ALLOWED_PAGE_WIDTH_SELECTORS: new Set(['.layout']),
  ALLOWED_RIGHT_ALIGN_SELECTORS: new Set(['.num', '.ln::before']),
  ALLOWED_TRANSPARENT_BG_SELECTORS: ALLOWED_TRANSPARENT_BG_SELECTORS_2,
  NON_HEX_ROOT_CUSTOM_PROPS: new Set([...NON_HEX_ROOT_CUSTOM_PROPS, '--margin-col', '--open-bd-style']),
  // policy/2-only rules
  ALIAS_ROOT_PROPS: ALIAS_ROOT_PROPS_2,
  LAYOUT_VAR_TOKENS: new Set(['--margin-col']),
  FLEX_DIRECTION_REVERSE_SELECTORS: new Set(['.figures__cell']),
  JUSTIFY_END_SELECTORS: new Set(['.signals', '.figures__cell']),
  GRID_ROW: { selectors: new Set(['.block > .b-anchor', '.block > .b-anchors', '.block--paragraph > :not(.b-anchor)', '.block--list > :not(.b-anchor)', '.block:not(.block--paragraph):not(.block--list) > :not(.b-anchor):not(.b-anchors)']), values: new Set(['1', 'auto']) },
  GRID_COLUMN: { selectors: new Set(['.block > *', '.block > .b-anchor', '.block > .b-anchors', '.block--paragraph > :not(.b-anchor)', '.block--list > :not(.b-anchor)', '.meta-strip__cell', '.meta-strip__cell:first-child']), values: new Set(['1', '2', '1 / -1', 'span 2']) },
  OFFSET_SELECTORS: {
    top: new Set(['.skip-link', '.list--ordered > li::before', '.plate__frame::before', '.plate__frame .diagram-canvas::before', '.topo-ledger__edges li::before', '.seq-ledger li::before']),
    left: new Set(['.skip-link', '.ln::before', '.list--ordered > li::before', '.plate__frame::before', '.plate__frame .diagram-canvas::after', '.topo-ledger__edges li::before', '.seq-ledger li::before']),
    right: new Set(['.plate__frame::after', '.plate__frame .diagram-canvas::before']),
    bottom: new Set(['.plate__frame::after', '.plate__frame .diagram-canvas::after']),
  },
  WIDTH_AUTO_SELECTORS: new Set(['.masthead__brand .lockup', '.colophon__mark .lockup']),
  COUNTER_NAMES: new Set(['ln', 'item', 'edge']),
  CONTENT_VISIBILITY_SELECTORS: new Set(['.ev__excerpt::details-content']),
  UNIVERSAL_PROPS: new Set(['box-sizing', 'scroll-behavior', 'transition']),
  PINNED_DECLARATIONS: PINNED_DECLARATIONS_2,
  EXACT_DECLARATIONS: EXACT_DECLARATIONS_2,
  CONTENT_VALUES: CONTENT_VALUES_2,
  TOKEN_SCOPES: TOKEN_SCOPES_2,
  REQUIRED_TOP_DECLARATIONS: REQUIRED_TOP_DECLARATIONS_2,
});

function srgbLuminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const rgb = [0, 2, 4].map((idx) => {
    const s = parseInt(h.slice(idx, idx + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function wcagContrast(hexA, hexB) {
  const l1 = srgbLuminance(hexA);
  const l2 = srgbLuminance(hexB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function checkRootPaletteContrast(rootVars, label, problems, cssState = null) {
  for (const fg of DOCUMENT_INK_PROPS) {
    const fv = rootVars.get(fg);
    if (!fv) continue;
    for (const bg of [...DOCUMENT_BG_PROPS, ...SVG_SURFACE_PROPS]) {
      const bv = rootVars.get(bg);
      if (bv && wcagContrast(fv, bv) < 3.0) {
        problems.push(`CSS ${label} ${fg} (${fv}) vs ${bg} (${bv}) fails minimum legibility contrast`);
      }
    }
  }
  for (const fg of CODE_TERMINAL_INK_PROPS) {
    const fv = rootVars.get(fg);
    if (!fv) continue;
    for (const bg of CODE_TERMINAL_BG_PROPS) {
      const bv = rootVars.get(bg);
      if (bv && wcagContrast(fv, bv) < 3.0) {
        problems.push(`CSS ${label} ${fg} (${fv}) vs ${bg} (${bv}) fails minimum code legibility contrast`);
      }
    }
    if (cssState) {
      for (const docBg of cssState.codeContainerDocBgs) {
        const bv = rootVars.get(docBg);
        if (bv && wcagContrast(fv, bv) < 3.0) {
          problems.push(`CSS ${label} ${fg} (${fv}) vs ${docBg} (${bv}) fails cross-domain code preview contrast`);
        }
      }
    }
  }
  if (cssState) {
    for (const [sel, fgSet] of cssState.codeChromeDocInks.entries()) {
      const pureDocBg = cssState.codeChromeHasDocBg.has(sel) && !cssState.codeChromeHasCodeBg.has(sel);
      if (pureDocBg) continue;
      for (const fg of fgSet) {
        const fv = rootVars.get(fg);
        if (!fv) continue;
        for (const bg of ['--code-chrome', '--code-canvas']) {
          const bv = rootVars.get(bg);
          if (bv && wcagContrast(fv, bv) < 3.0) {
            problems.push(`CSS ${label} ${fg} (${fv}) vs ${bg} (${bv}) on ${sel} fails cross-domain code chrome contrast`);
          }
        }
      }
    }
    for (const [sel, fgSet] of cssState.codeChromeCodeInks.entries()) {
      if (!cssState.codeChromeHasDocBg.has(sel)) continue;
      for (const fg of fgSet) {
        const fv = rootVars.get(fg);
        if (!fv) continue;
        for (const bg of DOCUMENT_BG_PROPS) {
          const bv = rootVars.get(bg);
          if (bv && wcagContrast(fv, bv) < 3.0) {
            problems.push(`CSS ${label} ${fg} (${fv}) vs ${bg} (${bv}) on ${sel} fails cross-domain document chrome contrast`);
          }
        }
      }
    }
  }
}

function isValidCssFontSize(val, selector) {
  if (val === 'inherit') return true;
  if (val === 'var(--code-font-size)') return selector === 'pre' || selector === '.code pre';
  const clamp = /^clamp\(([0-9]*\.?[0-9]+)rem, [0-9]*\.?[0-9]+rem \+ [0-9]*\.?[0-9]+vw, ([0-9]*\.?[0-9]+)rem\)$/.exec(val);
  if (clamp) {
    const min = Number(clamp[1]);
    const max = Number(clamp[2]);
    return min >= 0.75 && max >= min && max <= 4;
  }
  const unit = /^([0-9]*\.?[0-9]+)(rem|em|px|pt)$/.exec(val);
  if (!unit) return false;
  const n = Number(unit[1]);
  const u = unit[2];
  if (u === 'rem' || u === 'em') return n >= 0.55 && n <= 4;
  if (u === 'px') return n >= 9 && n <= 64;
  if (u === 'pt') return n >= 6.5 && n <= 48;
  return false;
}

function isValidCssLineHeight(val, selector) {
  if (val === 'var(--code-line-height)') return selector === 'pre' || selector === '.code pre';
  const m = /^([0-9]*\.?[0-9]+)$/.exec(val);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 1 && n <= 2.5;
}

function splitCssTopLevel(str, sep) {
  const out = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '"' || ch === "'") {
      const end = str.indexOf(ch, i + 1);
      i = end < 0 ? str.length : end;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')' && paren > 0) paren -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']' && bracket > 0) bracket -= 1;
    else if (ch === sep && paren === 0 && bracket === 0) {
      out.push(str.slice(start, i));
      start = i + 1;
    }
  }
  out.push(str.slice(start));
  return out;
}

// render-policy/2 colour model (R6). Every colour is a token: text inks from the document
// set (contrast-checked against every surface), band inks only in the bands, the gate ink
// only on gate selectors, the stamp ink only on .stamp (TOKEN_SCOPES enforces the
// scoping). Surfaces likewise; plate fills keep policy/1's text/surface/mark split.
const BAND_INK_VARS_2 = new Set(['var(--chrome-band-ink)', 'var(--chrome-band-muted)', 'var(--chrome-band-accent)']);
const BAND_BG_VARS_2 = new Set(['var(--chrome-band)', 'var(--chrome-band-current)']);
const PIP_BG_VARS_2 = new Set(['var(--pip-on)', 'var(--pip-off)', 'var(--pip-critical)']);

function checkColorDeclarationV2(prop, bare, valRaw, isImp, selectorParts, selector, mediaPrelude, layerRank, cssState, problems, rules) {
  const inPrintMedia = mediaPrelude === '@media print';
  const some = (set) => selectorParts.some((s) => set.has(s));
  const all = (set) => selectorParts.length > 0 && selectorParts.every((s) => set.has(s));
  if (isImp) {
    problems.push(`CSS !important ${prop} ${valRaw} not allowed on ${selector}`);
    return;
  }
  if (prop === 'color' || prop === 'background') {
    if (!inPrintMedia) {
      const [maxMap, minMap] = prop === 'color'
        ? [cssState.selectorColorMaxLayer, cssState.selectorColorMinLayer]
        : [cssState.selectorBgMaxLayer, cssState.selectorBgMinLayer];
      for (const s of selectorParts) {
        maxMap.set(s, Math.max(layerRank, maxMap.get(s) ?? -1));
        minMap.set(s, Math.min(layerRank, minMap.get(s) ?? Infinity));
      }
    }
  }
  // R6: on the masthead and colophon bands, text takes a band ink and surfaces a band
  // surface (or none), so every text colour there is one CONTRAST_PAIRS_2 checks against
  // --chrome-band. Print prints the bands as ink on paper, with the print hex inks.
  const onBand = selectorParts.some((s) => BAND_PART_RE_2.test(s));
  if (onBand && !inPrintMedia && prop === 'color' && !BAND_INK_VARS_2.has(bare)) {
    problems.push(`CSS color ${valRaw} on the band selector ${selector} must be a band ink (--chrome-band-ink, -muted or -accent)`);
    return;
  }
  if (onBand && !inPrintMedia && prop === 'background' && !BAND_BG_VARS_2.has(bare) && bare !== 'transparent' && bare !== 'none') {
    problems.push(`CSS background ${valRaw} on the band selector ${selector} must be a band surface`);
    return;
  }
  if (prop === 'color') {
    const ok = TEXT_INK_VARS_2.has(bare)
      || BAND_INK_VARS_2.has(bare)
      || bare === 'var(--svg-gate)'
      || bare === 'var(--stamp-ink)'
      || (bare === 'inherit' && all(new Set(['pre code'])))
      || (inPrintMedia && (bare === '#000' || bare === '#000000' || bare === '#333'));
    if (!ok) problems.push(`CSS color ${valRaw} not allowed on ${selector}`);
  } else if (prop === 'background') {
    const ok = SURFACE_BG_VARS_2.has(bare)
      || BAND_BG_VARS_2.has(bare)
      || bare === 'var(--svg-gate-bg)'
      || bare === 'var(--stamp-bg)'
      || PIP_BG_VARS_2.has(bare)
      || ((bare === 'transparent' || bare === 'none') && all(rules.ALLOWED_TRANSPARENT_BG_SELECTORS));
    if (!ok) problems.push(`CSS background ${valRaw} not allowed on ${selector}`);
  } else if (all(SVG_TEXT_FILL_SELECTORS_2)) {
    if (!TEXT_INK_VARS_2.has(bare) && bare !== 'var(--svg-gate)') problems.push(`CSS SVG text fill ${valRaw} must use an approved document ink variable on ${selector}`);
  } else if (all(SVG_SURFACE_FILL_SELECTORS_2)) {
    if (!SURFACE_BG_VARS_2.has(bare) && bare !== 'var(--svg-gate-bg)') problems.push(`CSS SVG surface fill ${valRaw} must use an approved surface variable on ${selector}`);
  } else if (all(SVG_MARK_FILL_SELECTORS_2)) {
    if (!SVG_MARK_FILL_VARS_2.has(bare)) {
      problems.push(`CSS SVG mark fill ${valRaw} not allowed on ${selector}`);
    } else if (some(INK_ONLY_ACCENT_SELECTORS_2) && bare !== 'var(--ink)') {
      problems.push(`CSS plate layer accent ${valRaw} must be var(--ink) on ${selector} (only gates are amber)`);
    }
  } else {
    problems.push(`CSS SVG fill ${valRaw} not allowed on ${selector}`);
  }
}

function checkCssRuleDeclarations(selector, body, problems, mediaPrelude, layerRank, cssState, rules = RULES_1) {
  const {
    ALLOWED_CSS_SELECTOR_PARTS, ALLOWED_ROOT_CUSTOM_PROPS, ALLOWED_CSS_PROPERTIES, NON_HEX_ROOT_CUSTOM_PROPS,
    ALLOWED_ABS_POS_SELECTORS, ALLOWED_TRANSFORM_SELECTORS, ALLOWED_DISPLAY_NONE_SELECTORS,
    PRINT_ONLY_DISPLAY_NONE_SELECTORS, NARROW_MEDIA_DISPLAY_NONE_SELECTORS,
    ALLOWED_FLEX_SELECTORS, ALLOWED_GRID_SELECTORS, ALLOWED_INLINE_SELECTORS, ALLOWED_INLINE_BLOCK_SELECTORS,
    ALLOWED_FLEX_SHRINK_SELECTORS, ALLOWED_PCT_WIDTH_SELECTORS, ALLOWED_NOWRAP_SELECTORS, ALLOWED_PRE_WRAP_SELECTORS,
    ALLOWED_GRID_TEMPLATE_SELECTORS, ALLOWED_CLIP_PATH_SELECTORS, ALLOWED_CONTENT_SELECTORS, ALLOWED_HEIGHT_SELECTORS,
    ALLOWED_OVERFLOW_HIDDEN_SELECTORS, ALLOWED_FONT_SHORTHAND_SELECTORS, ALLOWED_PAGE_WIDTH_SELECTORS,
    ALLOWED_RIGHT_ALIGN_SELECTORS, ALLOWED_GRID_TEMPLATE_VALUES, ALLOWED_TRANSPARENT_BG_SELECTORS,
  } = rules;
  const P2 = rules.policy === RENDER_POLICY_2;
  const allIn = (set) => selectorParts.length > 0 && selectorParts.every((s) => set.has(s));
  const isAtFontFace = /^@font-face\b/i.test(selector);
  const isAtPage = /^@page\b/i.test(selector);
  const inPrintMedia = mediaPrelude === '@media print';
  const selectorParts = splitCssTopLevel(selector, ',').map((s) => s.trim().replace(/[\t\n\f\r ]+/g, ' ')).filter(Boolean);

  if (isAtFontFace && selector !== '@font-face') {
    problems.push(`malformed @font-face prelude: ${selector}`);
    return;
  }
  if (isAtPage && selector !== '@page') {
    problems.push(`malformed @page prelude: ${selector}`);
    return;
  }
  if (!isAtFontFace && !isAtPage) {
    for (const part of selectorParts) {
      if (!ALLOWED_CSS_SELECTOR_PARTS.has(part)) {
        problems.push(`CSS selector ${JSON.stringify(part)} not allowed in stylesheet`);
      }
      if (part.startsWith('.cmp-side') || part.startsWith('.comparison')) cssState.seenCmpSideSelector = true;
      if (part.startsWith('.ev-preview')) cssState.seenEvPreviewSelector = true;
      if (part === '.code__caption') cssState.seenCodeCaptionSelector = true;
    }
  }

  for (const rawDecl of splitCssTopLevel(body, ';')) {
    const trimmed = rawDecl.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      problems.push(`malformed CSS declaration in ${selector}`);
      continue;
    }
    const rawProp = trimmed.slice(0, colon).trim();
    if (rawProp.startsWith('--') && /[A-Z]/.test(rawProp)) {
      problems.push(`CSS custom property ${rawProp} must be lowercase`);
      continue;
    }
    const prop = rawProp.toLowerCase();
    const valRaw = trimmed.slice(colon + 1).trim();
    if (/var\(\s*--[^)]*[A-Z]/.test(valRaw)) {
      problems.push(`CSS var() custom property reference in ${prop} on ${selector} must be lowercase`);
      continue;
    }
    const val = valRaw.toLowerCase().replace(/[\t\n\f\r ]+/g, ' ');

    if (/var\(\s*--[a-z0-9-]+\s*,/.test(val)) {
      problems.push(`CSS var() fallback value not allowed in ${prop} on ${selector}`);
      continue;
    }
    for (const vm of val.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
      cssState.usedCustomProps.add(vm[1]);
    }

    if (P2 && namesExactClass(selector, rules.EXACT_DECLARATIONS.classes)) {
      const exact = rules.EXACT_DECLARATIONS.rules.get(`${mediaPrelude ?? ''}|${selector}`);
      if (!exact) problems.push(`CSS rule ${mediaPrelude ? `${mediaPrelude} ` : ''}${selector} not allowed: a rule naming ${rules.EXACT_DECLARATIONS.classes.map((c) => `.${c}`).join(', ')} must be exactly one of ${[...rules.EXACT_DECLARATIONS.rules.keys()].map((k) => k.replace(/^\|/, '')).join(', ')}`);
      else if (!exact.has(`${prop}: ${val}`)) problems.push(`CSS ${prop}: ${valRaw} not allowed on ${selector}; only ${[...exact].join('; ')}`);
      continue;
    }
    if (P2 && rules.PINNED_DECLARATIONS.get(`${mediaPrelude ?? ''}|${selector}`)?.has(`${prop}: ${val}`)) continue;
    if (P2 && !prop.startsWith('--')) {
      let outOfScope = false;
      for (const vm of val.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
        for (const scope of rules.TOKEN_SCOPES) {
          if (scope.re.test(vm[1]) && !(selectorParts.length > 0 && selectorParts.every(scope.ok))) {
            problems.push(`CSS var(${vm[1]}) is only allowed on ${scope.what}, found in ${prop} on ${selector}`);
            outOfScope = true;
          }
        }
      }
      if (outOfScope) continue;
      if (!mediaPrelude) for (const s of selectorParts) cssState.topDeclarations.add(`${s}|${prop}|${val}`);
    }

    if (prop.startsWith('--')) {
      if (selector !== ':root') {
        problems.push(`CSS custom property ${prop} is only allowed on :root, found on ${selector}`);
        continue;
      }
      if (!ALLOWED_ROOT_CUSTOM_PROPS.has(prop)) {
        problems.push(`CSS custom property ${prop} is not in the allowed Canon token set`);
        continue;
      }
      if (/\s*!important$/i.test(valRaw)) {
        problems.push(`CSS !important not allowed on :root custom property ${prop}`);
        continue;
      }
      const bareCustom = val;
      if (NON_HEX_ROOT_CUSTOM_PROPS.has(prop)) {
        if (prop === '--code-font-size' && !isValidCssFontSize(bareCustom, 'pre')) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if (prop === '--code-line-height' && !isValidCssLineHeight(bareCustom, 'pre')) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if (prop === '--margin-col' && !/^(?:0|[0-7](?:\.[0-9]+)?rem)$/.test(bareCustom)) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if (prop === '--open-bd-style' && bareCustom !== 'dashed' && bareCustom !== 'solid') {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if ((prop === '--measure' || prop === '--prose-measure') && (!/^([0-9]+)ch$/.test(bareCustom) || Number(bareCustom.slice(0, -2)) < 40 || Number(bareCustom.slice(0, -2)) > 90)) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if (prop === '--copy' && bareCustom !== '100%' && (!/^([0-9]+)rem$/.test(bareCustom) || Number(bareCustom.slice(0, -3)) < 30 || Number(bareCustom.slice(0, -3)) > 96)) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if (prop === '--page'
          && !/^min\([6-9][0-9]rem, (?:calc\()?100% - [1-4](?:\.[0-9]+)?rem\)?\)$/.test(bareCustom)
          && !/^calc\(100(?:%|vw) - [1-4](?:\.[0-9]+)?rem\)$/.test(bareCustom)
          && !/^[4-9][0-9]rem$/.test(bareCustom)) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if (prop === '--touch' && !/^(?:4[0-8]px|2\.[5-9]rem|3rem)$/.test(bareCustom)) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if ((prop === '--sans' || prop === '--serif' || prop === '--mono')
          && (/\b0(?:px|rem|em|pt)?\b/.test(bareCustom)
            || !(prop === '--mono' ? /\bmonospace\b/.test(bareCustom) : prop === '--serif' ? /\bserif\b/.test(bareCustom) : /\bsans-serif\b/.test(bareCustom)))) {
          problems.push(`invalid :root ${prop}: ${valRaw}`);
        } else if (/\b(?:transparent|rgba|hsla|oklch|color-mix|var)\b/.test(bareCustom)) {
          problems.push(`disallowed value in :root ${prop}: ${valRaw}`);
        } else if (!mediaPrelude) {
          cssState.definedTopRootProps.add(prop);
        }
      } else if (mediaPrelude && mediaPrelude !== '@media (prefers-color-scheme: dark)' && mediaPrelude !== '@media print') {
        problems.push(`CSS :root color override ${prop} not allowed inside ${mediaPrelude}`);
      } else if (P2 && rules.ALIAS_ROOT_PROPS.has(prop) && /^var\(--[a-z0-9-]+\)$/.test(bareCustom)) {
        const target = bareCustom.slice(4, -1);
        if (!ALLOWED_ROOT_CUSTOM_PROPS.has(target) || NON_HEX_ROOT_CUSTOM_PROPS.has(target) || rules.ALIAS_ROOT_PROPS.has(target)) {
          problems.push(`CSS :root alias ${prop} must follow a colour token, got ${valRaw}`);
        } else {
          if (!mediaPrelude) cssState.definedTopRootProps.add(prop);
          cssState.seq += 1;
          cssState.rootColorDecls.push({ prop, alias: target, mediaPrelude, layerRank, seq: cssState.seq });
        }
      } else if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(bareCustom)) {
        if (!mediaPrelude) cssState.definedTopRootProps.add(prop);
        cssState.seq += 1;
        cssState.rootColorDecls.push({ prop, hex: bareCustom, mediaPrelude, layerRank, seq: cssState.seq });
      } else {
        problems.push(`CSS :root color custom property ${prop} must be opaque #RGB or #RRGGBB, got ${valRaw}`);
      }
      continue;
    }

    if (!ALLOWED_CSS_PROPERTIES.has(prop)) {
      problems.push(`CSS property ${prop} not allowed in stylesheet`);
      continue;
    }

    if ((prop === 'src' || prop === 'font-display') && !isAtFontFace) {
      problems.push(`CSS ${prop} only allowed inside @font-face`);
      continue;
    }
    if (isAtFontFace && prop !== 'src' && prop !== 'font-display' && prop !== 'font-family' && prop !== 'font-style' && prop !== 'font-weight') {
      problems.push(`CSS ${prop} not allowed inside @font-face`);
      continue;
    }
    if (isAtPage && prop !== 'margin') {
      problems.push(`CSS ${prop} not allowed inside @page`);
      continue;
    }
    if (selectorParts.some((s) => s === '*' || s === '*::before' || s === '*::after')
      && prop !== 'box-sizing' && prop !== 'scroll-behavior' && prop !== 'transition') {
      problems.push(`CSS ${prop} not allowed on universal selector (${selector})`);
      continue;
    }
    if (selectorParts.includes(':focus-visible') && prop !== 'outline' && prop !== 'outline-offset') {
      problems.push(`CSS ${prop} not allowed on bare :focus-visible (${selector})`);
      continue;
    }

    if ((P2 ? val.replace(/var\(--margin-col\)/g, '') : val).includes('var(') && /^(?:display|position|flex|flex-direction|flex-wrap|flex-shrink|grid-template-columns|grid-row|grid-column|order|opacity|content-visibility|transform|clip-path|top|left|z-index|margin(?:-top|-right|-bottom|-left)?|padding(?:-top|-right|-bottom|-left)?|gap|height|max-height|overflow(?:-[xy])?|letter-spacing|text-align|justify-content|justify-items|align-items|align-content|align-self|place-items|text-decoration|text-decoration-thickness|text-underline-offset|stroke-width|tab-size)$/.test(prop)) {
      problems.push(`CSS var() indirection not allowed in layout/visibility property ${prop}`);
      continue;
    }

    const isImp = /\s*!important$/.test(val);
    const bare = val.replace(/\s*!important$/, '');

    if (prop === 'color-scheme') {
      if (selector !== ':root' || mediaPrelude || bare !== 'light dark') {
        problems.push(`CSS color-scheme ${valRaw} only allowed as "light dark" on top-level :root`);
      }
    } else if (prop === 'order') {
      if (selector !== '.triage-pager__pos' || bare !== '-1') problems.push(`CSS order property not allowed on ${selector}`);
    } else if (prop === 'flex-direction') {
      if (val === 'column-reverse') {
        if (P2 ? !allIn(rules.FLEX_DIRECTION_REVERSE_SELECTORS) : selector !== '.question__bar') problems.push(`CSS flex-direction: column-reverse not allowed on ${selector}`);
      } else if (val === 'row') {
        if (P2 || selector !== '.prose-sheet__meta') problems.push(`CSS flex-direction: row not allowed on ${selector}`);
      } else if (val !== 'column') {
        problems.push(`CSS flex-direction: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'flex-wrap') {
      if (val !== 'wrap') {
        problems.push(`CSS flex-wrap: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'flex-shrink') {
      if (bare !== '0' || !selectorParts.length || !selectorParts.every((s) => ALLOWED_FLEX_SHRINK_SELECTORS.has(s))) {
        problems.push(`CSS flex-shrink: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'flex') {
      const okFlex = val === '1 1 0'
        || /^1 1 (?:1[0-9]|2[0-9])rem$/.test(val)
        || (val === '0 0 1.4rem' && selectorParts.every((s) => s === '.rail a span' || s === '.toc a span'));
      if (!okFlex) {
        problems.push(`CSS flex shorthand ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'grid-template-columns') {
      if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_GRID_TEMPLATE_SELECTORS.has(s)) || !ALLOWED_GRID_TEMPLATE_VALUES.has(val)) {
        problems.push(`CSS grid-template-columns ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'grid-row') {
      if (P2 ? (!allIn(rules.GRID_ROW.selectors) || !rules.GRID_ROW.values.has(bare)) : selector !== '.flow__index') problems.push(`CSS grid-row placement not allowed on ${selector}`);
    } else if (prop === 'grid-column') {
      if (P2) {
        if (!allIn(rules.GRID_COLUMN.selectors) || !rules.GRID_COLUMN.values.has(bare)) problems.push(`CSS grid-column placement not allowed on ${selector}`);
      } else if (selector !== '.metrics div:last-child:nth-child(odd)' && selector !== '.triage-pager__pos') {
        problems.push(`CSS grid-column placement not allowed on ${selector}`);
      }
    } else if (prop === 'text-align') {
      if (bare !== 'left' && !(bare === 'right' && selectorParts.length > 0 && selectorParts.every((s) => ALLOWED_RIGHT_ALIGN_SELECTORS.has(s)))) {
        problems.push(`CSS text-align: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'justify-content') {
      if (bare !== 'space-between' && bare !== 'flex-start' && !(bare === 'flex-end' && (P2 ? allIn(rules.JUSTIFY_END_SELECTORS) : selector === '.masthead__status'))) {
        problems.push(`CSS justify-content: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'justify-items') {
      if (!(bare === 'start' && selector === '.meta-kv')) {
        problems.push(`CSS justify-items: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'align-items') {
      if (bare !== 'baseline' && bare !== 'center' && bare !== 'flex-start' && bare !== 'start') {
        problems.push(`CSS align-items: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'justify-self') {
      if (bare !== 'start') problems.push(`CSS justify-self: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'align-content') {
      if (bare !== 'center') problems.push(`CSS align-content: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'align-self') {
      if (bare !== 'start') problems.push(`CSS align-self: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'place-items') {
      if (bare !== 'center') problems.push(`CSS place-items: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'position') {
      if (bare === 'fixed') {
        problems.push(`CSS position: fixed not allowed on ${selector}`);
      } else if (bare === 'absolute') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_ABS_POS_SELECTORS.has(s))) {
          problems.push(`CSS position: absolute not allowed on ${selector}`);
        }
      } else if (bare === 'sticky') {
        if (!selectorParts.length || !selectorParts.every((s) => s === '.rail')) {
          problems.push(`CSS position: sticky not allowed on ${selector}`);
        }
      } else if (bare !== 'relative' && bare !== 'static') {
        problems.push(`CSS position: ${valRaw} not allowed on ${selector}`);
      }
    } else if (P2 && (prop === 'top' || prop === 'left' || prop === 'right' || prop === 'bottom')) {
      if (!allIn(rules.OFFSET_SELECTORS[prop]) || /(?:^|[\t\n\f\r (,])-/.test(val)) {
        problems.push(`CSS ${prop} offset not allowed on ${selector}`);
      }
    } else if (prop === 'top') {
      if (!selectorParts.length || !selectorParts.every((s) => s === '.skip-link' || s === '.rail') || /(?:^|[\t\n\f\r (,])-/.test(val)) {
        problems.push(`CSS top offset not allowed on ${selector}`);
      }
    } else if (prop === 'left') {
      if (!selectorParts.length || !selectorParts.every((s) => s === '.skip-link' || s === '.ln::before') || /(?:^|[\t\n\f\r (,])-/.test(val)) {
        problems.push(`CSS left offset not allowed on ${selector}`);
      }
    } else if (prop === 'z-index') {
      if (selector !== '.skip-link' || val !== '99') {
        problems.push(`CSS z-index not allowed on ${selector}`);
      }
    } else if (prop === 'transform') {
      if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_TRANSFORM_SELECTORS.has(s))) {
        problems.push(`CSS transform not allowed on ${selector}`);
      }
    } else if (prop === 'margin' || prop.startsWith('margin-')) {
      const tokens = val.split(' ').filter(Boolean);
      const okMargin = tokens.length >= 1 && tokens.length <= 4 && tokens.every((tok) => {
        if (isAtPage) {
          const pm = /^([0-9]*\.?[0-9]+)(cm|mm)$/.exec(tok);
          return pm ? (pm[2] === 'cm' ? Number(pm[1]) <= 3 : Number(pm[1]) <= 30) : false;
        }
        if (tok === '0' || tok === 'auto') return true;
        if (P2 && tok === 'var(--margin-col)') return true;
        const m = /^(-?[0-9]*\.?[0-9]+)rem$/.exec(tok);
        if (!m) return false;
        const n = Number(m[1]);
        if (n < 0 && selector !== '.triage-pager') return false;
        return Math.abs(n) <= 2.5;
      });
      if (!okMargin) {
        problems.push(`CSS ${prop}: ${valRaw} out of bounds or not allowed on ${selector}`);
      }
    } else if (prop === 'padding' || prop.startsWith('padding-')) {
      const tokens = val.split(' ').filter(Boolean);
      const okPad = tokens.length >= 1 && tokens.length <= 4 && tokens.every((tok) => {
        if (tok === '0') return true;
        const m = /^([0-9]*\.?[0-9]+)(rem|em)$/.exec(tok);
        return Boolean(m && Number(m[1]) <= 4);
      });
      if (!okPad) {
        problems.push(`CSS ${prop}: ${valRaw} out of bounds on ${selector}`);
      }
    } else if (prop === 'gap') {
      const okGap = val === '0'
        || val === '1px'
        || /^clamp\(1\.5rem, [0-9]*\.?[0-9]+vw, [2-4](?:\.[0-9]+)?rem\)$/.test(val)
        || (val.split(' ').length <= 2 && val.split(' ').every((tok) => {
          const m = /^([0-9]*\.?[0-9]+)rem$/.exec(tok);
          return Boolean(m && Number(m[1]) <= 2.5);
        }));
      if (!okGap) {
        problems.push(`CSS gap: ${valRaw} out of bounds on ${selector}`);
      }
    } else if ((prop.startsWith('border') && !prop.endsWith('color') && prop !== 'border-radius' && prop !== 'border-collapse' && prop !== 'border-style')
      || prop === 'outline' || prop === 'outline-offset') {
      const withoutHex = bare.replace(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/g, 'HEX');
      if (/(?:rem|em|ch|%|vw|vh)\b/.test(withoutHex)) {
        problems.push(`CSS ${prop}: ${valRaw} relative/viewport length not allowed on ${selector}`);
      } else {
        for (const numMatch of withoutHex.matchAll(/(-?[0-9]*\.?[0-9]+)(px|pt)?/g)) {
          if (!numMatch[0]) continue;
          const n = Math.abs(Number(numMatch[1]));
          if (n > 6) {
            problems.push(`CSS ${prop}: ${valRaw} thickness > 6px not allowed on ${selector}`);
            break;
          }
        }
      }
    } else if (prop === 'border-radius') {
      const rToks = bare.split(' ').filter(Boolean);
      if (rToks.length < 1 || rToks.length > 4 || !rToks.every((tok) => tok === '0' || tok === '50%' || /^0?\.[0-5][0-9]*rem$/.test(tok))) {
        problems.push(`CSS border-radius: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'border-collapse') {
      if (bare !== 'collapse') problems.push(`CSS border-collapse: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'border-style') {
      if (bare !== 'solid' && bare !== 'dashed') problems.push(`CSS border-style: ${valRaw} not allowed on ${selector}`);
    } else if (prop.startsWith('border') && prop.endsWith('color')) {
      const okBorderColor = /^var\(--[a-z0-9-]+\)$/.test(bare)
        || /^color-mix\(in srgb, var\(--proven\) 3[0-9]%, var\(--line\)\)$/.test(bare)
        || ((bare === '#000' || bare === '#a56a00') && (inPrintMedia || selectorParts.every((s) => ALLOWED_CODE_TERMINAL_BG_SELECTORS.has(s))));
      if (!okBorderColor) {
        problems.push(`CSS ${prop}: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'box-sizing') {
      if (bare !== 'border-box') problems.push(`CSS box-sizing: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'box-shadow') {
      const okShadow = val === 'none'
        || (val === 'inset 0 0 0 2px var(--accent)' && selector === '.flow__step--gate')
        || (val === '0 1px 2px rgba(15, 23, 42, 0.04)' && selector === '.verdict')
        || (val === '0 1px 0 var(--line)' && selector === 'code.opt-key');
      if (!okShadow) {
        problems.push(`CSS box-shadow: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'display') {
      if (isImp && !inPrintMedia) {
        problems.push(`CSS !important display: ${valRaw} not allowed outside @media print on ${selector}`);
        continue;
      }
      const isNarrowMaxWidth = Boolean(mediaPrelude && /^@media \(max-width: (?:720|760|1024)px\)$/.test(mediaPrelude));
      if (bare === 'none') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_DISPLAY_NONE_SELECTORS.has(s))) {
          problems.push(`CSS display: none not allowed on ${selector}`);
        } else if (!inPrintMedia) {
          for (const s of selectorParts) {
            if (PRINT_ONLY_DISPLAY_NONE_SELECTORS.has(s)) {
              problems.push(`CSS display: none on ${s} is only allowed inside @media print`);
            } else if (NARROW_MEDIA_DISPLAY_NONE_SELECTORS.has(s)) {
              if (!isNarrowMaxWidth) {
                problems.push(`CSS display: none on ${s} outside @media print requires a narrow @media (max-width) rule`);
              } else if (s === '.rail') {
                cssState.railHideBreakpoints.add(mediaPrelude);
              }
            } else if (s === '.toc') {
              if (mediaPrelude !== null) {
                problems.push(`CSS display: none on .toc outside @media print is only allowed at base scope, found in ${mediaPrelude}`);
              } else {
                cssState.seq += 1;
                cssState.tocHideRules.push({ layerRank, seq: cssState.seq });
              }
            }
          }
        }
      } else if (bare === 'contents') {
        if (selector !== '.legend dl div') problems.push(`CSS display: contents not allowed on ${selector}`);
      } else if (bare === 'table-header-group') {
        if (selector !== 'thead') problems.push(`CSS display: table-header-group not allowed on ${selector}`);
      } else if (bare === 'flex' || bare === 'inline-flex') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_FLEX_SELECTORS.has(s))) {
          problems.push(`CSS display: ${bare} not allowed on ${selector}`);
        }
      } else if (bare === 'grid' || bare === 'inline-grid') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_GRID_SELECTORS.has(s))) {
          problems.push(`CSS display: ${bare} not allowed on ${selector}`);
        }
      } else if (bare === 'inline') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_INLINE_SELECTORS.has(s))) {
          problems.push(`CSS display: inline not allowed on ${selector}`);
        }
      } else if (bare === 'inline-block') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_INLINE_BLOCK_SELECTORS.has(s))) {
          problems.push(`CSS display: inline-block not allowed on ${selector}`);
        }
      } else if (bare === 'block') {
        if (!inPrintMedia && isNarrowMaxWidth && selectorParts.includes('.toc')) {
          cssState.seq += 1;
          cssState.tocShowRules.push({ mediaPrelude, layerRank, seq: cssState.seq });
        }
      } else {
        problems.push(`CSS display: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'content-visibility') {
      if ((P2 ? !allIn(rules.CONTENT_VISIBILITY_SELECTORS) : selector !== '.legend::details-content') || val !== 'visible') {
        problems.push(`CSS content-visibility: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'overflow' || prop === 'overflow-x' || prop === 'overflow-y') {
      if (/\b(?:hidden|clip)\b/.test(val)) {
        if (prop !== 'overflow' || !selectorParts.length || !selectorParts.every((s) => ALLOWED_OVERFLOW_HIDDEN_SELECTORS.has(s))) {
          problems.push(`CSS ${prop}: ${valRaw} clipping not allowed on ${selector}`);
        }
      } else if (val !== 'visible' && val !== 'auto') {
        problems.push(`CSS ${prop}: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'opacity') {
      if (selector !== '.triage-pager__muted' || !/^(?:0?\.65)(?:\s*!important)?$/.test(val)) {
        problems.push(`CSS opacity not allowed on ${selector}`);
      }
    } else if (prop === 'clip-path') {
      if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_CLIP_PATH_SELECTORS.has(s))) {
        problems.push(`CSS clip-path not allowed on ${selector}`);
      }
    } else if (prop === 'height') {
      if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_HEIGHT_SELECTORS.has(s))) {
        problems.push(`CSS height constraint not allowed on ${selector}`);
      } else if (bare === '1px') {
        if (!selectorParts.every((s) => ALLOWED_CLIP_PATH_SELECTORS.has(s))) {
          problems.push(`CSS height: 1px collapse not allowed on ${selector}`);
        }
      } else if (bare === 'auto') {
        if (!selectorParts.every((s) => s === '.svg-graphic')) {
          problems.push(`CSS height: auto not allowed on ${selector}`);
        }
      } else {
        const hm = /^([0-9]*\.?[0-9]+)rem$/.exec(bare);
        const hn = hm ? Number(hm[1]) : -1;
        if (!hm || hn < 0.5 || hn > 4 || selectorParts.some((s) => ALLOWED_CLIP_PATH_SELECTORS.has(s) || s === '.svg-graphic')) {
          problems.push(`CSS height: ${valRaw} out of bounds or not allowed on ${selector}`);
        }
      }
    } else if (prop === 'max-height') {
      if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_MAX_HEIGHT_SELECTORS.has(s))) {
        problems.push(`CSS max-height constraint not allowed on ${selector}`);
      } else {
        const okMaxH = (bare === 'none' && inPrintMedia)
          || (bare === 'calc(100vh - 2rem)' && selector === '.rail')
          || (/^[4-8][0-9]vh$/.test(bare) && selector === '.toc details[open] ol');
        if (!okMaxH) {
          problems.push(`CSS max-height: ${valRaw} out of bounds or not allowed on ${selector}`);
        }
      }
    } else if (prop === 'min-width') {
      const okMinW = bare === '0'
        || (bare === 'max-content' && selectorParts.length > 0 && selectorParts.every((s) => s === 'pre code' || s === '.code pre code'))
        || ((bare === 'min(16rem, 100%)' || bare === 'min(18rem, 100%)') && selector === '.item__title-row')
        || (bare === '6rem' && selector === '.chart__table td.bar')
        || (bare === '34rem' && selectorParts.length > 0 && selectorParts.every((s) => s === '.table table' || s === '.scenario-table'));
      if (!okMinW) {
        problems.push(`CSS min-width: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'min-height') {
      const okMinH = val === 'var(--touch)'
        || val === 'calc(1em * var(--code-line-height))'
        || val === '24px'
        || (/^([0-9]*\.?[0-9]+)rem$/.test(val) && Number(val.slice(0, -3)) >= 1 && Number(val.slice(0, -3)) <= 6);
      if (!okMinH) {
        problems.push(`CSS min-height: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'width') {
      if (bare === '1px') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_CLIP_PATH_SELECTORS.has(s))) {
          problems.push(`CSS width: 1px collapse not allowed on ${selector}`);
        }
      } else if (bare === 'var(--page)') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_PAGE_WIDTH_SELECTORS.has(s))) {
          problems.push(`CSS width: var(--page) not allowed on ${selector}`);
        }
      } else if (bare === 'auto') {
        if (P2 ? !allIn(rules.WIDTH_AUTO_SELECTORS) : (!selectorParts.length || !selectorParts.every((s) => s === '.layout' || s === '.masthead'))) {
          problems.push(`CSS width: auto not allowed on ${selector}`);
        }
      } else {
        const w = /^([0-9]*\.?[0-9]+)(%|rem|ch)$/.exec(bare);
        const n = w ? Number(w[1]) : -1;
        const okW = Boolean(w) && selectorParts.length > 0 && (
          (w[2] === '%' && n >= 25 && n <= 100 && selectorParts.every((s) => ALLOWED_PCT_WIDTH_SELECTORS.has(s) && (s !== '.svg-graphic' || n === 100)))
          || (w[2] === 'ch' && n >= 1 && n <= 2 && selectorParts.every((s) => s === '.t-mark'))
          || (w[2] === 'rem' && selectorParts.every((s) => (
            (s === '.brand__mark' && n >= 1.5 && n <= 2.5)
            || ((s === '.legend summary::after' || s === '.toc summary::after') && n >= 0.75 && n <= 1.5)
            || (s === '.ln::before' && n >= 2 && n <= 3.5)
            || (s === '.table--triage td.num' && n >= 7 && n <= 12)
          )))
        );
        if (!okW) {
          problems.push(`CSS width: ${valRaw} not allowed on ${selector}`);
        }
      }
    } else if (prop === 'max-width') {
      if (val !== 'none' && val !== '100%' && val !== 'var(--copy)' && val !== 'var(--measure)' && val !== 'var(--prose-measure)') {
        const mw = /^([0-9]*\.?[0-9]+)(rem|ch)$/.exec(val);
        const n = mw ? Number(mw[1]) : -1;
        const okMw = Boolean(mw) && (
          (mw[2] === 'rem' && n >= 40 && n <= 96)
          || (mw[2] === 'ch' && n >= 40 && n <= 85)
        );
        if (!okMw) {
          problems.push(`CSS max-width: ${valRaw} not allowed on ${selector}`);
        }
      }
    } else if (prop === 'font-size') {
      if (!isValidCssFontSize(val, selector)) {
        problems.push(`CSS font-size ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'line-height') {
      if (!isValidCssLineHeight(val, selector)) {
        problems.push(`CSS line-height ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'font') {
      const okFont = ALLOWED_FONT_SHORTHAND_SELECTORS.has(selector)
        && (val === 'var(--code-font-size)/var(--code-line-height) var(--mono)'
          || val === '700 7pt var(--sans)'
          || /^[67]00 0?\.(?:68|7|72|83|84)rem\/1(?:\.1|\.35)? var\(--mono\)$/.test(val));
      if (!okFont) {
        problems.push(`CSS font shorthand ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'font-family') {
      const okFam = isAtFontFace
        ? /^"[a-z0-9 -]{1,40}"$/.test(bare)
        : (bare === 'var(--sans)' || bare === 'var(--mono)' || bare === 'var(--serif)');
      if (!okFam) problems.push(`CSS font-family ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'font-weight') {
      if (!/^(?:[4-8]00|650)$/.test(bare)) problems.push(`CSS font-weight ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'font-style') {
      if (bare !== 'normal' && bare !== 'italic') problems.push(`CSS font-style ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'font-display') {
      if (bare !== 'swap') problems.push(`CSS font-display ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'font-kerning') {
      if (bare !== 'normal') problems.push(`CSS font-kerning ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'font-variant-numeric') {
      if (bare !== 'tabular-nums') problems.push(`CSS font-variant-numeric ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'font-feature-settings') {
      if (bare !== '"kern" 1, "liga" 1, "calt" 1') problems.push(`CSS font-feature-settings ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'letter-spacing') {
      if (val !== '0') {
        const ls = /^(-?[0-9]*\.?[0-9]+)em$/.exec(val);
        if (!ls || Number(ls[1]) < -0.05 || Number(ls[1]) > 0.25) {
          problems.push(`CSS letter-spacing ${valRaw} not allowed on ${selector}`);
        }
      }
    } else if (prop === 'text-transform') {
      if (bare !== 'none' && bare !== 'uppercase' && bare !== 'capitalize') {
        problems.push(`CSS text-transform: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'text-decoration') {
      if (bare !== 'none' && bare !== 'underline') {
        problems.push(`CSS text-decoration: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'text-decoration-thickness') {
      if (!['1px', '1.5px', '.075em', '0.075em', '.08em', '0.08em'].includes(bare)) {
        problems.push(`CSS text-decoration-thickness: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'text-underline-offset') {
      if (!['.18em', '0.18em', '.2em', '0.2em', '.22em', '0.22em'].includes(bare)) {
        problems.push(`CSS text-underline-offset: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'text-decoration-color') {
      if (bare !== 'currentcolor' && bare !== 'var(--line)' && bare !== 'var(--accent-ink)'
        && !/^color-mix\(in srgb, (?:currentcolor|var\(--accent-ink\)) 4[0-9]%, transparent\)$/.test(bare)) {
        problems.push(`CSS text-decoration-color: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'vertical-align') {
      if (!['baseline', 'middle', 'top', '.2em', '0.2em', '.25em', '0.25em'].includes(bare)) {
        problems.push(`CSS vertical-align: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'list-style') {
      if (bare !== 'none') problems.push(`CSS list-style: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'text-size-adjust' || prop === '-webkit-text-size-adjust') {
      if (selector !== 'html' || bare !== '100%') problems.push(`CSS ${prop}: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'white-space') {
      const okWs = bare === 'normal'
        || (bare === 'nowrap' && selectorParts.length > 0 && selectorParts.every((s) => ALLOWED_NOWRAP_SELECTORS.has(s)))
        || (bare === 'pre' && selector === '.ln')
        || (bare === 'pre-wrap' && selectorParts.length > 0 && selectorParts.every((s) => ALLOWED_PRE_WRAP_SELECTORS.has(s)));
      if (!okWs) {
        problems.push(`CSS white-space: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'overflow-wrap') {
      if (bare !== 'anywhere' && bare !== 'break-word' && bare !== 'normal') {
        problems.push(`CSS overflow-wrap: ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'word-break') {
      if (bare !== 'break-all') problems.push(`CSS word-break: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'tab-size') {
      if (bare !== '2') problems.push(`CSS tab-size: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'user-select' || prop === '-webkit-user-select') {
      if (selector !== '.ln::before' || bare !== 'none') problems.push(`CSS ${prop}: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'counter-reset' || prop === 'counter-increment') {
      if (P2 ? !rules.COUNTER_NAMES.has(bare) : bare !== 'ln') problems.push(`CSS ${prop}: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'scroll-margin-top' || prop === 'scroll-padding-top') {
      if (!/^[0-2](?:\.[0-9]+)?rem$/.test(bare)) problems.push(`CSS ${prop}: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'scroll-behavior') {
      if (bare !== 'auto') problems.push(`CSS scroll-behavior: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'scrollbar-gutter') {
      if (bare !== 'stable') problems.push(`CSS scrollbar-gutter: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'overscroll-behavior-inline') {
      if (bare !== 'contain') problems.push(`CSS overscroll-behavior-inline: ${valRaw} not allowed on ${selector}`);
    } else if (prop === '-webkit-overflow-scrolling') {
      if (bare !== 'touch') problems.push(`CSS -webkit-overflow-scrolling: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'break-after') {
      if (bare !== 'avoid') problems.push(`CSS break-after: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'break-inside') {
      if (bare !== 'avoid' && bare !== 'auto') problems.push(`CSS break-inside: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'cursor') {
      if (bare !== 'pointer') problems.push(`CSS cursor: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'transition') {
      if (bare !== 'none' && val !== 'transform 120ms ease') problems.push(`CSS transition: ${valRaw} not allowed on ${selector}`);
    } else if (P2 && (prop === 'color' || prop === 'background' || prop === 'fill')) {
      checkColorDeclarationV2(prop, bare, valRaw, isImp, selectorParts, selector, mediaPrelude, layerRank, cssState, problems, rules);
    } else if (P2 && prop === 'outline-color') {
      if (!/^var\(--[a-z0-9-]+\)$/.test(bare)) problems.push(`CSS outline-color: ${valRaw} not allowed on ${selector}`);
    } else if (prop === 'color') {
      if (selectorParts.some((s) => FORBIDDEN_COLOR_BG_SELECTORS.has(s))) {
        problems.push(`CSS color ${valRaw} not allowed on co-matching base selector (${selector})`);
        continue;
      }
      if (isImp && !inPrintMedia) {
        problems.push(`CSS !important color ${valRaw} not allowed outside @media print on ${selector}`);
        continue;
      }
      if (!inPrintMedia) {
        for (const s of selectorParts) {
          cssState.selectorColorMaxLayer.set(s, Math.max(layerRank, cssState.selectorColorMaxLayer.get(s) ?? -1));
          cssState.selectorColorMinLayer.set(s, Math.min(layerRank, cssState.selectorColorMinLayer.get(s) ?? Infinity));
        }
      }
      if (!mediaPrelude && bare === 'var(--ink)' && selectorParts.length > 0 && selectorParts.every((s) => s === 'html' || s === 'body')) {
        cssState.hasTopLevelCanvasColor = true;
      }
      if (bare === 'inherit') {
        if (isImp || !selectorParts.length || !selectorParts.every((s) => ALLOWED_COLOR_INHERIT_SELECTORS.has(s))) {
          problems.push(`CSS color: ${valRaw} not allowed on ${selector}`);
        }
      } else if ((bare === '#000' || bare === '#000000' || bare === '#333') && inPrintMedia) {
        // allowed print ink
      } else if (ALLOWED_DOCUMENT_INK_VARS.has(bare)) {
        if (selectorParts.some((s) => STRICT_CODE_DOMAIN_SELECTORS.has(s) || s === '.ev-preview')) {
          problems.push(`CSS document ink ${valRaw} not allowed on code-terminal surface (${selector})`);
        } else {
          const fgProp = bare.slice(4, -1);
          for (const s of selectorParts) {
            if (s === '.ev-preview__bar' || s === '.code__lang') {
              if (!cssState.codeChromeDocInks.has(s)) cssState.codeChromeDocInks.set(s, new Set());
              cssState.codeChromeDocInks.get(s).add(fgProp);
              if (!inPrintMedia) cssState.codeChromeExplicitDocColor.add(s);
            }
            if (!inPrintMedia && ALLOWED_INK_BACKGROUND_SELECTORS.has(s)) {
              cssState.inkSelectorHasDocColor.add(s);
            }
            if (!inPrintMedia && CRIT_SEV_GROUP.includes(s)) {
              cssState.critSevHasDocColor = true;
            }
          }
        }
      } else if (ALLOWED_CODE_TERMINAL_INK_VARS.has(bare)) {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_CODE_TERMINAL_COLOR_SELECTORS.has(s))) {
          problems.push(`CSS code-terminal color ${valRaw} not allowed outside dark code surfaces (${selector})`);
        } else {
          if (!mediaPrelude) {
            if (selectorParts.some((s) => s === 'pre' || s === '.code pre')) cssState.hasTopLevelPreCodeColor = true;
            if (selectorParts.includes('pre')) cssState.hasTopLevelBarePreCodeColor = true;
          }
          const fgProp = bare.slice(4, -1);
          for (const s of selectorParts) {
            if (s === '.ev-preview' || s === '.ev-preview__bar' || s === '.code__lang' || s === '.code__head strong' || s === '.code__lines' || s === '.code__caption') {
              if (!cssState.codeChromeCodeInks.has(s)) cssState.codeChromeCodeInks.set(s, new Set());
              cssState.codeChromeCodeInks.get(s).add(fgProp);
              if (!inPrintMedia) cssState.codeChromeExplicitCodeColor.add(s);
            }
          }
        }
      } else if (SURFACE_COLOR_VARS.has(bare)) {
        if (bare === 'var(--line)' || bare === 'var(--line-strong)') {
          if (selector !== '.breadcrumb span') {
            problems.push(`CSS hairline color ${valRaw} only allowed on .breadcrumb span, found on ${selector}`);
          }
        } else if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_INK_BACKGROUND_SELECTORS.has(s))) {
          problems.push(`CSS surface color ${valRaw} not allowed as foreground text color on ${selector}`);
        } else if (!inPrintMedia) {
          for (const s of selectorParts) cssState.inkSelectorHasSurfaceColor.add(s);
        }
      } else {
        problems.push(`CSS color ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'background') {
      if (selectorParts.some((s) => FORBIDDEN_COLOR_BG_SELECTORS.has(s))) {
        problems.push(`CSS background ${valRaw} not allowed on co-matching base selector (${selector})`);
        continue;
      }
      if (isImp && !inPrintMedia && (!selectorParts.length || !selectorParts.every((s) => s === '.alt--chosen'))) {
        problems.push(`CSS !important background ${valRaw} not allowed on ${selector}`);
        continue;
      }
      if (!inPrintMedia) {
        for (const s of selectorParts) {
          cssState.selectorBgMaxLayer.set(s, Math.max(layerRank, cssState.selectorBgMaxLayer.get(s) ?? -1));
          cssState.selectorBgMinLayer.set(s, Math.min(layerRank, cssState.selectorBgMinLayer.get(s) ?? Infinity));
        }
      }
      if (!mediaPrelude && bare === 'var(--paper)' && selectorParts.length > 0 && selectorParts.every((s) => s === 'html' || s === 'body')) {
        cssState.hasTopLevelCanvasBg = true;
      }
      if (bare === 'transparent' || bare === 'none') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_TRANSPARENT_BG_SELECTORS.has(s))) {
          problems.push(`CSS transparent background not allowed on ${selector}`);
        }
      } else if (/^color-mix\(in srgb, var\(--(?:proven|accent)\) (?:[1-9]|1[0-2])%, (?:transparent|var\(--card\))\)$/.test(bare)
        || /^color-mix\(in srgb, var\(--surface\) (?:[1-9]|[1-5][0-9]|6[0-5])%, (?:transparent|var\(--card\))\)$/.test(bare)) {
        if (selectorParts.some((s) => STRICT_CODE_DOMAIN_SELECTORS.has(s) || s === '.ev-preview' || s === '.ev-preview__bar' || s === '.code__lang' || ALLOWED_INK_BACKGROUND_SELECTORS.has(s) || CRIT_SEV_GROUP.includes(s))) {
          problems.push(`CSS color-mix background ${valRaw} not allowed on ${selector}`);
        }
      } else if (inPrintMedia
        && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(bare)
        && selectorParts.length > 0
        && selectorParts.every((s) => s === 'html' || s === 'body')
        && srgbLuminance(bare) >= 0.8) {
        cssState.printHexBgs.push(bare);
      } else if (ALLOWED_DOCUMENT_BG_VARS.has(bare)) {
        if (selectorParts.some((s) => STRICT_CODE_DOMAIN_SELECTORS.has(s))) {
          problems.push(`CSS document surface ${valRaw} not allowed on code-terminal surface (${selector})`);
        } else if (selectorParts.includes('.ev-preview') && bare !== 'var(--surface-subtle)') {
          problems.push(`CSS document surface ${valRaw} not allowed on .ev-preview`);
        } else {
          if (selectorParts.includes('.ev-preview')) {
            if (!mediaPrelude) cssState.hasTopLevelEvPreviewBg = true;
            cssState.codeContainerDocBgs.add(bare.slice(4, -1));
            cssState.codeChromeHasDocBg.add('.ev-preview');
          }
          for (const s of selectorParts) {
            if (s === '.ev-preview__bar' || s === '.code__lang') {
              cssState.codeChromeHasDocBg.add(s);
            }
            if (!inPrintMedia && ALLOWED_INK_BACKGROUND_SELECTORS.has(s)) {
              cssState.inkSelectorHasDocBg.add(s);
            }
            if (!inPrintMedia && CRIT_SEV_GROUP.includes(s)) {
              cssState.critSevHasDocBg = true;
            }
          }
        }
      } else if (bare === 'var(--line)') {
        if (!selectorParts.length || !selectorParts.every((s) => s === '.flow' || s === '.metrics')) {
          problems.push(`CSS hairline background var(--line) not allowed on ${selector}`);
        }
      } else if (ALLOWED_CODE_TERMINAL_BG_VARS.has(bare)) {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_CODE_TERMINAL_BG_SELECTORS.has(s))) {
          problems.push(`CSS dark code surface ${valRaw} not allowed on ${selector}`);
        } else {
          if (!mediaPrelude) {
            if (selectorParts.includes('.code')) cssState.hasTopLevelCodeBg = true;
            if (selectorParts.includes('.code__head')) cssState.hasTopLevelCodeHeadBg = true;
            if (selectorParts.includes('.cmp-side__code')) cssState.hasTopLevelCmpSideCodeBg = true;
            if (selectorParts.includes('.ev-preview')) cssState.hasTopLevelEvPreviewBg = true;
          }
          for (const s of selectorParts) {
            if (s === '.ev-preview' || s === '.ev-preview__bar' || s === '.code__lang') {
              cssState.codeChromeHasCodeBg.add(s);
            }
          }
        }
      } else if (bare === 'var(--accent-border)' && selector === '.cite:hover') {
        // allowed hover highlight on citation pill
      } else if (bare === 'var(--ink)' || bare === 'var(--defect)') {
        if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_INK_BACKGROUND_SELECTORS.has(s))) {
          problems.push(`CSS dark foreground variable ${valRaw} not allowed as background on ${selector}`);
        } else if (!inPrintMedia) {
          for (const s of selectorParts) cssState.inkSelectorHasDarkBg.add(s);
        }
      } else {
        problems.push(`CSS background ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'fill') {
      if (selectorParts.length > 0 && selectorParts.every((s) => SVG_TEXT_FILL_SELECTORS.has(s))) {
        if (!ALLOWED_DOCUMENT_INK_VARS.has(bare) && !((bare === '#000' || bare === '#333') && inPrintMedia)) {
          problems.push(`CSS SVG text fill ${valRaw} must use an approved document ink variable on ${selector}`);
        }
      } else if (selectorParts.length > 0 && selectorParts.every((s) => SVG_SURFACE_FILL_SELECTORS.has(s))) {
        if (!ALLOWED_SVG_SURFACE_FILL_VARS.has(bare)) {
          problems.push(`CSS SVG surface fill ${valRaw} must use an approved light/surface variable on ${selector}`);
        }
      } else if (selectorParts.length > 0 && selectorParts.every((s) => SVG_MARK_FILL_SELECTORS.has(s))) {
        if (!ALLOWED_SVG_MARK_FILL_VARS.has(bare) && !((bare === '#444' || bare === '#ddd') && inPrintMedia)) {
          problems.push(`CSS SVG mark fill ${valRaw} not allowed on ${selector}`);
        }
      } else {
        problems.push(`CSS SVG fill ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'stroke') {
      if (selectorParts.some((s) => /(?:label|title|sub|num|text|delta|step-index)/.test(s))
        || (bare !== 'none' && !/^var\(--[a-z0-9-]+\)$/.test(bare))) {
        problems.push(`CSS stroke ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'stroke-width') {
      const sw = /^([0-9]*\.?[0-9]+)(?:px)?$/.exec(bare);
      if (!sw || Number(sw[1]) < 0.5 || Number(sw[1]) > 3) {
        problems.push(`CSS stroke-width ${valRaw} out of bounds on ${selector}`);
      }
    } else if (prop === 'stroke-dasharray') {
      if (!/^[1-8] [1-8]$/.test(bare)) {
        problems.push(`CSS stroke-dasharray ${valRaw} not allowed on ${selector}`);
      }
    } else if (prop === 'content') {
      if (!selectorParts.length || !selectorParts.every((s) => ALLOWED_CONTENT_SELECTORS.has(s))) {
        problems.push(`CSS pseudo-element content property not allowed on ${selector}`);
      } else if (P2 && !selectorParts.every((s) => rules.CONTENT_VALUES.get(s)?.has(bare))) {
        problems.push(`CSS generated content ${valRaw} not allowed on ${selector}`);
      }
    }
  }
}

function resolveCascadeRootColors(decls, pred) {
  const best = new Map();
  for (const d of decls) {
    if (!pred(d)) continue;
    const prev = best.get(d.prop);
    if (!prev || d.layerRank > prev.layerRank || (d.layerRank === prev.layerRank && d.seq >= prev.seq)) {
      best.set(d.prop, d);
    }
  }
  const out = new Map();
  for (const [k, v] of best.entries()) out.set(k, v.hex);
  return out;
}

// Root colour tokens as the cascade resolves them for one scheme, with R6 aliases
// (var(--token)) followed to the value their target has in that same scheme.
function resolveRootColorsV2(decls, pred) {
  const best = new Map();
  for (const d of decls) {
    if (!pred(d)) continue;
    const prev = best.get(d.prop);
    if (!prev || d.layerRank > prev.layerRank || (d.layerRank === prev.layerRank && d.seq >= prev.seq)) best.set(d.prop, d);
  }
  const out = new Map();
  for (const [k, d] of best.entries()) {
    const hex = d.alias ? best.get(d.alias)?.hex : d.hex;
    if (hex) out.set(k, hex);
  }
  return out;
}

function finishCssPolicyV2(cssState, problems, rules) {
  for (const req of rules.REQUIRED_TOP_DECLARATIONS) {
    if (!cssState.topDeclarations.has(`${req.selector}|${req.prop}|${req.value}`)) {
      problems.push(`CSS stylesheet must set top-level ${req.prop}: ${req.value} on ${req.selector}`);
    }
  }
  for (const baseAnchor of ['a', 'a:hover']) {
    if (cssState.selectorColorMaxLayer.has(baseAnchor)
      && cssState.selectorColorMinLayer.has('.skip-link')
      && cssState.selectorColorMaxLayer.get(baseAnchor) > cssState.selectorColorMinLayer.get('.skip-link')) {
      problems.push(`CSS ${baseAnchor} color layer overrides .skip-link color`);
    }
  }
  if (cssState.selectorColorMaxLayer.has('code') && cssState.selectorColorMinLayer.has('pre code')
    && cssState.selectorColorMaxLayer.get('code') > cssState.selectorColorMinLayer.get('pre code')) {
    problems.push('CSS bare code color layer overrides pre code');
  }
  if (cssState.selectorBgMaxLayer.has('code') && cssState.selectorBgMinLayer.has('pre code')
    && cssState.selectorBgMaxLayer.get('code') > cssState.selectorBgMinLayer.get('pre code')) {
    problems.push('CSS bare code background layer overrides pre code');
  }
  // R6: every colour token has a dark value, or follows (aliases) a token that flips.
  const darkProps = new Set(cssState.rootColorDecls.filter((d) => d.mediaPrelude === '@media (prefers-color-scheme: dark)').map((d) => d.prop));
  for (const d of cssState.rootColorDecls) {
    if (d.mediaPrelude === null && d.hex && !darkProps.has(d.prop)) {
      problems.push(`CSS colour token ${d.prop} has no @media (prefers-color-scheme: dark) value and follows no token`);
    }
  }
  const schemes = [
    [':root', (d) => d.mediaPrelude === null],
    ['@media (prefers-color-scheme: dark) :root', (d) => d.mediaPrelude === null || d.mediaPrelude === '@media (prefers-color-scheme: dark)'],
    ['@media print :root', (d) => d.mediaPrelude === null || d.mediaPrelude === '@media print'],
  ];
  for (const [label, pred] of schemes) {
    const vars = resolveRootColorsV2(cssState.rootColorDecls, pred);
    for (const pair of CONTRAST_PAIRS_2) {
      for (const fg of pair.inks) {
        for (const bg of pair.bgs) {
          const fv = vars.get(fg);
          const bv = vars.get(bg);
          if (!fv || !bv) {
            problems.push(`CSS ${label} ${pair.what} contrast pair ${fg} / ${bg} is not defined`);
          } else if (wcagContrast(fv, bv) < 4.5) {
            problems.push(`CSS ${label} ${pair.what} ${fg} (${fv}) vs ${bg} (${bv}) is below 4.5:1`);
          }
        }
      }
    }
    for (const pair of NONTEXT_PAIRS_2) {
      for (const fg of pair.marks) {
        for (const bg of pair.bgs) {
          const fv = vars.get(fg);
          const bv = vars.get(bg);
          if (!fv || !bv) {
            problems.push(`CSS ${label} ${pair.what} non-text contrast pair ${fg} / ${bg} is not defined`);
          } else if (wcagContrast(fv, bv) < 3) {
            problems.push(`CSS ${label} ${pair.what} ${fg} (${fv}) vs ${bg} (${bv}) is below 3:1 non-text contrast`);
          }
        }
      }
    }
  }
}

function checkCssLayoutIntegrity(clean, problems, options = {}) {
  const rules = options.rules ?? RULES_1;
  const { ALLOWED_MEDIA_PRELUDES, ALLOWED_LAYER_PRELUDES, REQUIRED_CORE_ROOT_PROPS } = rules;
  const P2 = rules.policy === RENDER_POLICY_2;
  const layerOrder = [];
  const getLayerRank = (layerName) => {
    if (!layerName) return 1_000_000;
    let idx = layerOrder.indexOf(layerName);
    if (idx < 0) {
      layerOrder.push(layerName);
      idx = layerOrder.length - 1;
    }
    return idx;
  };
  const cssState = {
    definedTopRootProps: new Set(),
    usedCustomProps: new Set(),
    hasTopLevelCanvasBg: false,
    hasTopLevelCanvasColor: false,
    hasTopLevelCodeBg: false,
    hasTopLevelCodeHeadBg: false,
    hasTopLevelPreCodeColor: false,
    hasTopLevelBarePreCodeColor: false,
    hasTopLevelCmpSideCodeBg: false,
    hasTopLevelEvPreviewBg: false,
    seenCmpSideSelector: false,
    seenEvPreviewSelector: false,
    seenCodeCaptionSelector: false,
    printHexBgs: [],
    rootColorDecls: [],
    codeContainerDocBgs: new Set(),
    codeChromeDocInks: new Map(),
    codeChromeCodeInks: new Map(),
    codeChromeExplicitDocColor: new Set(),
    codeChromeExplicitCodeColor: new Set(),
    codeChromeHasDocBg: new Set(),
    codeChromeHasCodeBg: new Set(),
    tocHideRules: [],
    tocShowRules: [],
    railHideBreakpoints: new Set(),
    inkSelectorHasSurfaceColor: new Set(),
    inkSelectorHasDarkBg: new Set(),
    inkSelectorHasDocColor: new Set(),
    inkSelectorHasDocBg: new Set(),
    critSevHasDocColor: false,
    critSevHasDocBg: false,
    selectorColorMaxLayer: new Map(),
    selectorColorMinLayer: new Map(),
    selectorBgMaxLayer: new Map(),
    selectorBgMinLayer: new Map(),
    topDeclarations: new Set(),
    seq: 0,
  };
  const stack = [];
  let buf = '';
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '"' || ch === "'") {
      const end = clean.indexOf(ch, i + 1);
      if (end < 0) {
        buf += clean.slice(i);
        break;
      }
      buf += clean.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '{') {
      const prelude = buf.trim().replace(/[\t\n\f\r ]+/g, ' ');
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      if (!prelude) problems.push('CSS block with empty selector/prelude');
      if (parent && (!parent.prelude.startsWith('@') || /^@(?:page|font-face)\b/i.test(parent.prelude))) {
        problems.push(`nested style rule block inside ${parent.prelude}`);
      }
      if (prelude.startsWith('@')) {
        const lowerPrelude = prelude.toLowerCase();
        if (lowerPrelude.startsWith('@media')) {
          if (!ALLOWED_MEDIA_PRELUDES.has(lowerPrelude)) {
            problems.push(`CSS @media prelude ${JSON.stringify(prelude)} not allowed in stylesheet`);
          }
          if (parent && parent.mediaPrelude) {
            problems.push(`nested @media block ${JSON.stringify(prelude)} inside ${parent.mediaPrelude}`);
          }
        } else if (lowerPrelude.startsWith('@layer')) {
          if (!ALLOWED_LAYER_PRELUDES.has(lowerPrelude)) {
            problems.push(`CSS @layer block prelude ${JSON.stringify(prelude)} not allowed in stylesheet`);
          }
          if (parent && parent.layerName) {
            problems.push(`nested @layer block ${JSON.stringify(prelude)} inside @layer ${parent.layerName}`);
          }
        }
      }
      if (parent) parent.hasChildBlocks = true;
      const mediaPrelude = /^@media\b/i.test(prelude)
        ? prelude.toLowerCase()
        : (parent ? parent.mediaPrelude : null);
      const layerName = /^@layer\b/i.test(prelude)
        ? prelude.toLowerCase().slice('@layer'.length).trim()
        : (parent ? parent.layerName : null);
      if (layerName) getLayerRank(layerName);
      stack.push({ prelude, body: '', hasChildBlocks: false, mediaPrelude, layerName });
      buf = '';
    } else if (ch === '}') {
      if (stack.length === 0) {
        problems.push('unbalanced closing brace in stylesheet');
        buf = '';
        continue;
      }
      const frame = stack.pop();
      frame.body += buf;
      buf = '';
      if (!frame.prelude.startsWith('@') || /^@(?:page|font-face)\b/i.test(frame.prelude)) {
        if (frame.hasChildBlocks) {
          problems.push(`child block not allowed inside ${frame.prelude}`);
        }
        checkCssRuleDeclarations(frame.prelude, frame.body, problems, frame.mediaPrelude, getLayerRank(frame.layerName), cssState, rules);
      } else if (!frame.hasChildBlocks || frame.body.trim()) {
        problems.push(`empty or stray-declaration container block ${frame.prelude}`);
      }
    } else if (ch === ';' && (stack.length === 0 || (stack[stack.length - 1].prelude.startsWith('@') && /^@(?:media|layer)\b/i.test(stack[stack.length - 1].prelude)))) {
      const stmt = buf.trim().replace(/[\t\n\f\r ]+/g, ' ');
      if (stmt) {
        if (!/^@layer [a-z]+(?:, [a-z]+)*$/i.test(stmt)) {
          problems.push(`stray statement in stylesheet: ${stmt.slice(0, 60)}`);
        } else {
          for (const ln of stmt.slice('@layer'.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
            if (!ALLOWED_LAYER_PRELUDES.has(`@layer ${ln}`)) {
              problems.push(`CSS @layer statement name ${JSON.stringify(ln)} not allowed in stylesheet`);
            } else {
              getLayerRank(ln);
            }
          }
        }
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (stack.length !== 0) problems.push('unclosed brace block in stylesheet');
  if (buf.trim()) problems.push('trailing unclosed statement in stylesheet');

  for (const reqProp of REQUIRED_CORE_ROOT_PROPS) {
    if (!cssState.definedTopRootProps.has(reqProp)) {
      problems.push(`CSS top-level :root is missing required Canon token ${reqProp}`);
    }
  }
  for (const usedProp of cssState.usedCustomProps) {
    if (!cssState.definedTopRootProps.has(usedProp)) {
      problems.push(`CSS var(${usedProp}) references a custom property not defined on top-level :root`);
    }
  }
  if (P2) {
    finishCssPolicyV2(cssState, problems, rules);
    return;
  }
  if (!cssState.hasTopLevelCanvasBg || !cssState.hasTopLevelCanvasColor) {
    problems.push('CSS stylesheet must set top-level html/body background: var(--paper) and color: var(--ink)');
  }
  if (!cssState.hasTopLevelCodeBg || !cssState.hasTopLevelCodeHeadBg) {
    problems.push('CSS stylesheet must set top-level code-terminal background on .code and .code__head');
  }
  if (!cssState.hasTopLevelPreCodeColor) {
    problems.push('CSS stylesheet must set top-level code-terminal color on pre or .code pre');
  }
  if (!cssState.codeChromeExplicitDocColor.has('.code__lang') && !cssState.codeChromeExplicitCodeColor.has('.code__lang')) {
    problems.push('CSS stylesheet must set explicit foreground color on .code__lang');
  }
  if (cssState.seenCmpSideSelector || options.hasCmpSideCode) {
    if (!cssState.hasTopLevelCmpSideCodeBg) {
      problems.push('CSS stylesheet must set top-level code-terminal background on .cmp-side__code');
    }
    if (!cssState.hasTopLevelBarePreCodeColor) {
      problems.push('CSS stylesheet must set top-level code-terminal color on bare pre when .cmp-side__code is used');
    }
  }
  if (cssState.seenEvPreviewSelector || options.hasEvPreview) {
    if (!cssState.hasTopLevelEvPreviewBg) {
      problems.push('CSS stylesheet must set top-level background on .ev-preview');
    }
    if (!cssState.hasTopLevelBarePreCodeColor) {
      problems.push('CSS stylesheet must set top-level code-terminal color on bare pre when .ev-preview is used');
    }
  }
  if (!cssState.codeChromeHasDocBg.has('.code__lang') && !cssState.codeChromeHasCodeBg.has('.code__lang')) {
    cssState.codeChromeHasCodeBg.add('.code__lang');
  }
  if (!cssState.codeChromeHasDocBg.has('.ev-preview__bar') && !cssState.codeChromeHasCodeBg.has('.ev-preview__bar')) {
    if (cssState.codeChromeHasCodeBg.has('.ev-preview')) cssState.codeChromeHasCodeBg.add('.ev-preview__bar');
    if (cssState.codeChromeHasDocBg.has('.ev-preview')) cssState.codeChromeHasDocBg.add('.ev-preview__bar');
  }
  const codeHeaderChildren = ['.code__head strong', '.code__lines'];
  if (cssState.seenCodeCaptionSelector || options.hasCodeCaption) codeHeaderChildren.push('.code__caption');
  for (const s of codeHeaderChildren) cssState.codeChromeHasCodeBg.add(s);

  for (const s of ['.ev-preview', '.ev-preview__bar', '.code__lang', ...codeHeaderChildren]) {
    if (cssState.codeChromeHasDocBg.has(s) && cssState.codeChromeHasCodeBg.has(s)) {
      problems.push(`CSS code chrome selector ${s} mixes document and code-terminal backgrounds across rules`);
    }
    if (cssState.codeChromeDocInks.has(s) && cssState.codeChromeCodeInks.has(s)) {
      problems.push(`CSS code chrome selector ${s} mixes document and code-terminal foreground colors across rules`);
    }
    if (cssState.codeChromeHasDocBg.has(s) && cssState.codeChromeCodeInks.has(s)) {
      problems.push(`CSS code chrome selector ${s} pairs code-terminal ink with a document surface background`);
    }
    if (cssState.codeChromeHasCodeBg.has(s) && !cssState.codeChromeExplicitCodeColor.has(s)) {
      if (!cssState.codeChromeDocInks.has(s)) cssState.codeChromeDocInks.set(s, new Set());
      cssState.codeChromeDocInks.get(s).add('--ink');
    }
  }
  let winningTocHide = null;
  for (const r of cssState.tocHideRules) {
    if (!winningTocHide || r.layerRank > winningTocHide.layerRank || (r.layerRank === winningTocHide.layerRank && r.seq > winningTocHide.seq)) {
      winningTocHide = r;
    }
  }
  const overridesTocHide = (r) => !winningTocHide
    || r.layerRank > winningTocHide.layerRank
    || (r.layerRank === winningTocHide.layerRank && r.seq > winningTocHide.seq);
  if (winningTocHide && !cssState.tocShowRules.some(overridesTocHide)) {
    problems.push('CSS .toc { display: none } is not restored by a higher-cascade narrow @media (max-width) .toc { display: block } rule');
  }
  for (const bp of cssState.railHideBreakpoints) {
    if (!cssState.tocShowRules.some((r) => r.mediaPrelude === bp && overridesTocHide(r))) {
      problems.push(`CSS .rail { display: none } in ${bp} must pair with an effective .toc { display: block } handoff`);
    }
  }
  for (const s of ALLOWED_INK_BACKGROUND_SELECTORS) {
    const hasSurfFg = cssState.inkSelectorHasSurfaceColor.has(s);
    const hasDarkBg = cssState.inkSelectorHasDarkBg.has(s);
    const hasDocFg = cssState.inkSelectorHasDocColor.has(s);
    const hasDocBg = cssState.inkSelectorHasDocBg.has(s);
    if (hasSurfFg !== hasDarkBg || ((hasSurfFg || hasDarkBg) && (hasDocBg || hasDocFg))) {
      problems.push(`CSS inverted badge/chrome selector ${s} pairs mismatched foreground/background contrast polarity`);
    }
  }
  const anyCritInverted = CRIT_SEV_GROUP.some((s) => cssState.inkSelectorHasSurfaceColor.has(s) || cssState.inkSelectorHasDarkBg.has(s));
  if (anyCritInverted && (cssState.critSevHasDocColor || cssState.critSevHasDocBg)) {
    problems.push(`CSS critical severity selectors (${CRIT_SEV_GROUP.join(', ')}) mix inverted and document contrast polarities across co-matching rules`);
  }
  for (const baseAnchor of ['a', 'a:hover']) {
    if (cssState.selectorColorMaxLayer.has(baseAnchor)
      && cssState.selectorColorMinLayer.has('.skip-link')
      && cssState.selectorColorMaxLayer.get(baseAnchor) > cssState.selectorColorMinLayer.get('.skip-link')) {
      problems.push(`CSS ${baseAnchor} color layer overrides .skip-link color`);
    }
  }
  for (const preCodeSel of ['pre code', '.code pre code']) {
    if (cssState.selectorColorMaxLayer.has('code')
      && cssState.selectorColorMinLayer.has(preCodeSel)
      && cssState.selectorColorMaxLayer.get('code') > cssState.selectorColorMinLayer.get(preCodeSel)) {
      problems.push(`CSS bare code color layer overrides ${preCodeSel}`);
    }
    if (cssState.selectorBgMaxLayer.has('code')
      && cssState.selectorBgMinLayer.has(preCodeSel)
      && cssState.selectorBgMaxLayer.get('code') > cssState.selectorBgMinLayer.get(preCodeSel)) {
      problems.push(`CSS bare code background layer overrides ${preCodeSel}`);
    }
  }

  const topRootVars = resolveCascadeRootColors(cssState.rootColorDecls, (d) => d.mediaPrelude === null);
  checkRootPaletteContrast(topRootVars, ':root', problems, cssState);
  if (cssState.rootColorDecls.some((d) => d.mediaPrelude === '@media (prefers-color-scheme: dark)')) {
    const darkRootVars = resolveCascadeRootColors(
      cssState.rootColorDecls,
      (d) => d.mediaPrelude === null || d.mediaPrelude === '@media (prefers-color-scheme: dark)',
    );
    checkRootPaletteContrast(darkRootVars, '@media (prefers-color-scheme: dark) :root', problems, cssState);
  }
  const mergedPrintVars = resolveCascadeRootColors(
    cssState.rootColorDecls,
    (d) => d.mediaPrelude === null || d.mediaPrelude === '@media print',
  );
  if (cssState.rootColorDecls.some((d) => d.mediaPrelude === '@media print')) {
    checkRootPaletteContrast(mergedPrintVars, '@media print :root', problems, cssState);
  }
  for (const hexBg of cssState.printHexBgs) {
    for (const fg of DOCUMENT_INK_PROPS) {
      const fv = mergedPrintVars.get(fg);
      if (fv && wcagContrast(fv, hexBg) < 3.0) {
        problems.push(`CSS @media print ${fg} (${fv}) vs print canvas (${hexBg}) fails minimum legibility contrast`);
      }
    }
  }
}
export function scanCssPolicy(css, inventoryPaths = new Set(), options = {}) {
  const rules = options.rules ?? (options.renderPolicy === RENDER_POLICY_2 ? RULES_2 : RULES_1);
  const { ALLOWED_CSS_AT_RULES } = rules;
  const problems = [];
  if (rules.policy === RENDER_POLICY_2) {
    // R6: retired tokens and hex values are absent, comments included.
    const retired = RETIRED_TOKEN_RE_2.exec(css);
    if (retired) problems.push(`CSS retired render-policy/1 token ${/^--[a-z0-9-]*/i.exec(css.slice(retired.index))[0]} in a render-policy/2 stylesheet`);
    for (const hex of RETIRED_HEX_2) {
      if (new RegExp(`${hex}(?![0-9a-f])`, 'i').test(css)) problems.push(`CSS retired colour ${hex} in a render-policy/2 stylesheet`);
    }
  }
  if (css.includes('\u0000')) problems.push('NUL character in stylesheet');
  if (css.includes('\\')) problems.push('backslash escape in stylesheet');

  const clean = stripCssCommentsPreservingStrings(css, problems);
  checkCssLayoutIntegrity(clean, problems, { ...options, rules });

  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '"' || ch === "'") {
      const end = clean.indexOf(ch, i + 1);
      i = end < 0 ? clean.length : end + 1;
      continue;
    }
    if (ch === '@') {
      const m = /^@([a-zA-Z_-][a-zA-Z0-9_-]*)/.exec(clean.slice(i));
      if (!m) {
        problems.push('malformed @-rule in stylesheet');
        i += 1;
        continue;
      }
      const ruleName = m[1].toLowerCase();
      if (ruleName === 'import') {
        problems.push('@import in stylesheet');
      } else if (!ALLOWED_CSS_AT_RULES.has(ruleName)) {
        problems.push(`disallowed @${m[1]} rule in stylesheet`);
      }
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_-]/.test(ch)) {
      const identMatch = /^[a-zA-Z_-][a-zA-Z0-9_-]*/.exec(clean.slice(i));
      const ident = identMatch[0];
      const lowerIdent = ident.toLowerCase();
      const afterIdent = i + ident.length;
      const parenMatch = /^[\t\n\f\r ]*\(/.exec(clean.slice(afterIdent));
      if (parenMatch) {
        if (lowerIdent === 'expression') {
          problems.push('CSS expression()');
        } else if (lowerIdent === 'image-set' || lowerIdent === '-webkit-image-set') {
          problems.push(`CSS ${ident}() external-capable image function`);
        } else if (lowerIdent === 'url' || lowerIdent === 'src') {
          const openParen = afterIdent + parenMatch[0].length - 1;
          const closeParen = clean.indexOf(')', openParen + 1);
          if (closeParen < 0) {
            problems.push(`unclosed ${ident}() in stylesheet`);
            break;
          }
          const rawArg = clean.slice(openParen + 1, closeParen).trim();
          const unquoted = (rawArg.startsWith('"') && rawArg.endsWith('"') && rawArg.length >= 2)
            || (rawArg.startsWith("'") && rawArg.endsWith("'") && rawArg.length >= 2)
            ? rawArg.slice(1, -1)
            : rawArg;
          const font = lowerIdent === 'url' ? /^\.\/([0-9a-f]{64}\.woff2)$/.exec(unquoted) : null;
          if (!font || !inventoryPaths.has(`assets/${font[1]}`)) {
            problems.push(`url(${JSON.stringify(unquoted)}) is not an inventoried fingerprinted WOFF2 font`);
          }
          i = closeParen + 1;
          continue;
        }
      } else if (lowerIdent === '-moz-binding') {
        problems.push('CSS -moz-binding');
      }
      i = afterIdent;
      continue;
    }
    i += 1;
  }

  return problems;
}

// R2: report.json is the canonical report/v1 source. Its bytes are their own canonical
// re-serialisation, digest to manifest.report.sourceSha256, and agree with the manifest's
// report metadata. Returns the parsed report when its shape is usable for the R3/R5
// checks, else null (and the packet already has a finding).
const canonicalOrNull = (v) => { try { return canonical(v); } catch { return null; } };
function checkReportSourceV2(bytes, manifest, findings) {
  if (!bytes) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    findings.add('source', 'report.json', `report.json is not UTF-8 JSON: ${err.message}`);
    return null;
  }
  let canonicalText = null;
  try {
    canonicalText = canonical(value);
  } catch (err) {
    findings.add('source', 'report.json', err.message);
  }
  if (canonicalText !== bytes.toString('utf8')) findings.add('source', 'report.json', 'bytes are not the canonical JSON serialization of their own parse');
  if (sha256(bytes) !== manifest.report?.sourceSha256) findings.add('source', 'report.json', 'SHA-256 does not equal manifest.report.sourceSha256');
  const r = manifest.report ?? {};
  const meta = value?.metadata ?? {};
  if (value?.schema !== r.schema || value?.id !== r.id || value?.title !== r.title || meta.status !== r.status
    || meta.classification !== r.classification || meta.reviewDate !== r.reviewDate
    || canonicalOrNull(value?.publication ?? null) !== canonicalOrNull(r.publication ?? null)) {
    findings.add('source', 'report.json', 'report metadata disagrees with manifest.report');
  }
  // Review 2 MINOR C: every value the structure check (checkEditionStructureV2,
  // countReportBlocks) later reads from this report is type-checked here, so a malformed
  // report.json is a finding, never an exception. Strings it interpolates must be strings: a
  // JSON object such as {"toString":1} throws when converted to text.
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = (v) => typeof v === 'string';
  const blockOk = (b) => isObj(b) && (b.type !== 'finding' || (isStr(b.id) && isStr(b.severity) && isStr(b.confidence)));
  const sectionsOk = (list) => Array.isArray(list) && list.every((x) => isObj(x) && isStr(x.id) && isStr(x.title) && Array.isArray(x.blocks) && x.blocks.every(blockOk));
  if (!isObj(value) || !isObj(value.summary) || !Array.isArray(value.summary.paragraphs) || !sectionsOk(value.sections)
    || (value.appendices !== undefined && !sectionsOk(value.appendices))
    || !Array.isArray(value.evidence) || !value.evidence.every((e) => isObj(e) && isStr(e.id))
    || !isObj(value.provenance) || !Array.isArray(value.provenance.sources)) {
    findings.add('source', 'report.json', 'report.json lacks the report/v1 summary, sections, evidence or provenance shape');
    return null;
  }
  return value;
}

// R2: fonts are embedded only, and policy/2 embeds exactly six faces, each from an
// inventoried fingerprinted WOFF2 that no other face shares.
const FONT_FACES_2 = ['libron|normal|400', 'libron|italic|400', 'libron|normal|700', 'libron|italic|700', 'jetbrains mono|normal|400', 'jetbrains mono|normal|700'];
function checkFontFacesV2(sheet, files, findings) {
  const faces = [];
  for (const m of sheet.text.matchAll(/@font-face[\t\n\f\r ]*\{([^}]*)\}/gi)) {
    const get = (prop) => new RegExp(`(?:^|;)[\\t\\n\\f\\r ]*${prop}[\\t\\n\\f\\r ]*:([^;]*)`, 'i').exec(m[1])?.[1].trim() ?? '';
    const url = /url\("\.\/([0-9a-f]{64}\.woff2)"\)/.exec(get('src'))?.[1] ?? null;
    faces.push({ key: `${get('font-family').replace(/^"|"$/g, '').toLowerCase()}|${get('font-style').toLowerCase()}|${get('font-weight')}`, url });
  }
  const keys = faces.map((f) => f.key).sort();
  if (keys.join(',') !== [...FONT_FACES_2].sort().join(',')) {
    findings.add('fonts', sheet.path, `render-policy/2 embeds exactly Libron 400/400i/700/700i and JetBrains Mono 400/700; found ${JSON.stringify(keys)}`);
  }
  const woff2 = files.filter((f) => f.path.endsWith('.woff2')).map((f) => f.path.slice('assets/'.length)).sort();
  const urls = faces.map((f) => f.url).sort();
  if (urls.includes(null) || urls.join(',') !== woff2.join(',')) {
    findings.add('fonts', sheet.path, 'every embedded WOFF2 must back exactly one @font-face, and every @font-face must use one');
  }
}

export async function verifyPacket(packetDir) {
  const findings = new Findings();
  const rootStat = await lstat(packetDir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    findings.add('not-a-packet', packetDir, 'packet directory is missing, not a directory, or a symlink');
    return { ok: false, errors: findings.errors };
  }
  const { found, total } = await walk(packetDir, findings);
  checkPathCollisions([...found.keys()], findings, 'on-disk');
  if (found.size > LIMITS.files + 2) findings.add('limit', '.', `more than ${LIMITS.files} files on disk`);
  if (total > LIMITS.totalBytes) findings.add('limit', '.', `packet is ${total} bytes; limit ${LIMITS.totalBytes}`);

  const manifestFile = await readJsonFile(join(packetDir, 'manifest.json'), 'manifest.json', findings);
  const checksumsFile = await readJsonFile(join(packetDir, 'checksums.json'), 'checksums.json', findings);
  if (!manifestFile) return { ok: false, errors: findings.errors };
  const manifest = manifestFile.value;
  const manifestSha256 = sha256(manifestFile.bytes);
  const files = checkManifestShape(manifest, findings);
  const renderPolicy = manifestRenderPolicy(manifest);

  // Content ID: digest of the canonical manifest without its contentId member.
  const { contentId: declaredId, ...identity } = manifest;
  let recomputedId = null;
  try {
    recomputedId = `sha256-${sha256(Buffer.from(canonical(identity), 'utf8'))}`;
  } catch (err) {
    findings.add('content-id', 'manifest.json', err.message);
  }
  if (recomputedId && recomputedId !== declaredId) findings.add('content-id', 'manifest.json#/contentId', `declared ${declaredId} but manifest digests to ${recomputedId}`);

  const declared = new Set(files.map((f) => f.path));
  for (const path of found.keys()) {
    if (!declared.has(path) && !CONTROL_FILES.has(path)) findings.add('extra-file', path, 'file on disk is not in the manifest inventory');
  }
  let entryHtml = null;
  let sourceBytes = null;
  let stylesheets = [];
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
    if (f.path === 'index.html') entryHtml = bytes.toString('utf8');
    if (f.path === 'report.json' && f.role === 'source') sourceBytes = bytes;
    if (f.role === 'asset' && f.path.endsWith('.css')) stylesheets.push({ path: f.path, text: bytes.toString('utf8') });
  }

  if (checksumsFile) {
    const c = checksumsFile.value;
    if (!exactKeys(c, ['schema', 'algorithm', 'contentId', 'manifestSha256', 'files'])) findings.add('schema', 'checksums.json', 'checksums must have exactly schema, algorithm, contentId, manifestSha256, files');
    if (c.schema !== 'checksums/v1' || c.algorithm !== 'sha256') findings.add('schema-version', 'checksums.json', 'expected checksums/v1 with sha256');
    if (c.contentId !== declaredId) findings.add('checksums-disagree', 'checksums.json#/contentId', 'content ID disagrees with manifest');
    if (c.manifestSha256 !== manifestSha256) findings.add('checksums-disagree', 'checksums.json#/manifestSha256', 'manifest digest disagrees with manifest.json bytes');
    const listed = c.files && typeof c.files === 'object' ? c.files : {};
    const manifestMap = new Map(files.map((f) => [f.path, f.sha256]));
    for (const [path, digest] of Object.entries(listed)) {
      if (!manifestMap.has(path)) findings.add('checksums-disagree', `checksums.json#/files/${path}`, 'path not in manifest');
      else if (manifestMap.get(path) !== digest) findings.add('checksums-disagree', `checksums.json#/files/${path}`, 'digest disagrees with manifest');
    }
    for (const path of manifestMap.keys()) if (!Object.hasOwn(listed, path)) findings.add('checksums-disagree', `checksums.json#/files/${path}`, 'manifest path missing from checksums');
  }

  const report = renderPolicy === RENDER_POLICY_2 ? checkReportSourceV2(sourceBytes, manifest, findings) : null;
  const cssHtmlOptions = { hasCmpSideCode: false, hasEvPreview: false, hasCodeCaption: false };
  if (entryHtml !== null) {
    const htmlOptions = renderPolicy === RENDER_POLICY_2 ? { renderPolicy, edition: { manifest, report } } : {};
    for (const problem of scanHtmlPolicy(entryHtml, declared, htmlOptions)) findings.add('unsafe-content', 'index.html', problem);
    const inspectedEntry = inspectHtmlDocument(entryHtml, { alternateHref: 'report.md' });
    for (const el of inspectedEntry.elements) {
      if (el.classes.has('cmp-side__code')) cssHtmlOptions.hasCmpSideCode = true;
      if (el.classes.has('ev-preview')) cssHtmlOptions.hasEvPreview = true;
      if (el.classes.has('code__caption')) cssHtmlOptions.hasCodeCaption = true;
    }
  }
  for (const sheet of stylesheets) {
    const cssOptions = renderPolicy === RENDER_POLICY_2 ? { ...cssHtmlOptions, renderPolicy } : cssHtmlOptions;
    for (const problem of scanCssPolicy(sheet.text, declared, cssOptions)) findings.add('unsafe-content', sheet.path, problem);
    if (renderPolicy === RENDER_POLICY_2) checkFontFacesV2(sheet, files, findings);
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

// R8: `canon verify <new> --reissue-of <old>`. A reissue is the same words in new type:
// both packets verify on their own, the new one names the old content ID in
// manifest.report.reissueOf, the source digests are equal, report.md is byte-identical,
// and the evidence inventory (paths and digests) is the same. Every mismatch is reported.
// R8: the relation a reissue must hold to the edition it re-typesets. Pure, so the builder
// runs exactly these checks before it seals a reissueOf (a sealed reissueOf never fails its
// own `verify --reissue-of`). A reissue's own content ID cannot equal the old one: that
// would make reissueOf its own content ID, which checkManifestShape already rejects.
export function reissueRelationFindings(next, prev) {
  const out = [];
  const add = (path, message) => out.push({ code: 'reissue', path, message });
  const nm = next.manifest;
  const om = prev.manifest;
  if (nm.report?.reissueOf !== om.contentId) {
    add('new:manifest.json#/report/reissueOf', `expected ${JSON.stringify(om.contentId)}, found ${JSON.stringify(nm.report?.reissueOf)}`);
  }
  if (!HEX64.test(nm.report?.sourceSha256 ?? '') || nm.report?.sourceSha256 !== om.report?.sourceSha256) {
    add('manifest.json#/report/sourceSha256', 'source digests differ: this is not the same report');
  }
  const nmd = next.reportMd;
  const omd = prev.reportMd;
  if (!nmd || !omd || !Buffer.from(nmd).equals(Buffer.from(omd))) add('report.md', 'report.md is not byte-identical');
  const evidenceOf = (m) => (Array.isArray(m.files) ? m.files : []).filter((f) => f?.role === 'evidence').map((f) => `${f.path} ${f.sha256}`).sort();
  const [ne, oe] = [evidenceOf(nm), evidenceOf(om)];
  if (ne.length !== oe.length || ne.some((v, i) => v !== oe[i])) add('manifest.json#/files', 'evidence inventories (paths and digests) differ');
  return out;
}
