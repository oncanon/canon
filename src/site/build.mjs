// site-input/v1 -> immutable site-bundle/v1 directory (docs/projects/interactive-sitrep-contract.md, revision 4).
//
// Identity inputs are: canonical site-input/v1 JSON, referenced evidence file bytes,
// stylesheet and font bytes, and tool/policy versions. Nothing else (cwd, absolute paths,
// wall-clock time, environment, temp names, hostnames) enters the output.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalBytes } from '../canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../hash.mjs';
import {
  BuildError,
  DEFAULT_FONT_DIR,
  DEFAULT_FONT_FILES,
  loadEvidence,
  readRegularFile,
  writePacketDirectory,
} from '../packet/build.mjs';
import { CHECKSUMS_SCHEMA, EVIDENCE_MEDIA, LIMITS, PACKET_MEDIA, TOOL } from '../policy.mjs';
import { siteAnchor } from '../render/anchors.mjs';
import { SITE_BUNDLE_SCHEMA, siteManifestParts } from './manifest.mjs';
import { renderSiteHtmlPages } from './pages-html.mjs';
import { renderSiteMarkdownPages } from './pages-md.mjs';
import { SITE_LIMITS, parseSiteInputText, validateSiteInput } from './validate.mjs';

export const DEFAULT_SITE_STYLESHEET = new URL('../presentation/site-variant-a.css', import.meta.url);

export const SITE_AGENT_ENTRY = Object.freeze({
  path: 'index.md',
  anchors: 'reference-definitions/1',
});

function mediaTypeFor(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const type = PACKET_MEDIA[ext];
  if (!type) throw new BuildError('internal', `no media type for ${path}`);
  return type;
}

// Evidence id -> sorted list of anchors that cite it across items and decisions.
export function collectSiteCitations(input) {
  const cited = new Map();
  const add = (id, anchor) => {
    const list = cited.get(id) ?? [];
    if (!list.includes(anchor)) list.push(anchor);
    cited.set(id, list);
  };
  const walkInline = (value, anchor) => {
    if (Array.isArray(value)) {
      for (const seg of value) {
        if (seg && typeof seg === 'object' && Object.hasOwn(seg, 'cite')) add(seg.cite, anchor);
      }
    }
  };
  const walkBlock = (block, anchor) => {
    switch (block.type) {
      case 'paragraph': walkInline(block.text, anchor); break;
      case 'list': block.items.forEach((i) => walkInline(i, anchor)); break;
      case 'finding': {
        const a = `f-${block.id}`;
        block.evidence.forEach((id) => add(id, a));
        walkInline(block.claim, a);
        (block.detail ?? []).forEach((b) => walkBlock(b, a));
        break;
      }
      case 'risk': walkInline(block.mitigation, `r-${block.id}`); break;
      case 'code':
      case 'diff':
        if (block.caption) walkInline(block.caption, anchor);
        break;
      case 'table':
        block.rows.forEach((row) => block.columns.forEach((c) => walkInline(row[c.key], anchor)));
        break;
      case 'chart': {
        const a = `chart-${block.id}`;
        (block.evidence ?? []).forEach((id) => add(id, a));
        walkInline(block.caption, a);
        break;
      }
      case 'diagram': {
        const a = `diagram-${block.id}`;
        (block.evidence ?? []).forEach((id) => add(id, a));
        walkInline(block.caption, a);
        break;
      }
      case 'comparison': {
        const a = `cmp-${block.id}`;
        (block.evidence ?? []).forEach((id) => add(id, a));
        if (block.caption) walkInline(block.caption, a);
        for (const side of [block.left, block.right]) {
          walkInline(side.summary, a);
          (side.items ?? []).forEach((item) => walkInline(item, a));
        }
        break;
      }
      case 'requirement': {
        const a = `req-${block.id}`;
        (block.evidence ?? []).forEach((id) => add(id, a));
        walkInline(block.statement, a);
        break;
      }
      case 'metrics': block.items.forEach((m) => (m.evidence ?? []).forEach((id) => add(id, anchor))); break;
      default: break;
    }
  };

  for (const item of input.items) {
    const itemAnchor = siteAnchor.item(item.itemRef);
    for (const block of item.blocks) walkBlock(block, itemAnchor);
  }
  for (const decision of input.decisions) {
    for (const question of decision.questions) {
      const qAnchor = siteAnchor.question(question.questionRef);
      for (const option of question.options) walkInline(option.summary, qAnchor);
      walkInline(question.recommendation.text, qAnchor);
      for (const id of question.evidence ?? []) add(id, qAnchor);
    }
  }
  for (const list of cited.values()) list.sort();
  return cited;
}

// Pure: validated site-input/v1 + loaded bytes -> site-bundle/v1 file map and manifest.
export function assembleSiteBundle(input, { evidenceBytes, stylesheetBytes, fontAssets = [] }) {
  const sourceSha256 = sha256Hex(canonicalBytes(input));
  const files = new Map();
  const addFile = (path, bytes, role) => {
    const existing = files.get(path);
    if (existing && !existing.bytes.equals(bytes)) throw new BuildError('internal', `conflicting bytes for ${path}`);
    files.set(path, { path, bytes, role });
  };

  const fontFaces = [];
  for (const font of fontAssets) {
    const sha = sha256Hex(font.bytes);
    const href = `assets/${sha}.woff2`;
    addFile(href, font.bytes, 'asset');
    fontFaces.push(`@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(`./${sha}.woff2`)}) format("woff2");font-style:${font.style};font-weight:${font.weight};font-display:swap}`);
  }
  const bundleStylesheet = Buffer.concat([
    Buffer.from(fontFaces.length ? `${fontFaces.join('\n')}\n` : '', 'utf8'),
    stylesheetBytes,
  ]);
  const cssSha = sha256Hex(bundleStylesheet);
  const stylesheetHref = `assets/${cssSha}.css`;
  addFile(stylesheetHref, bundleStylesheet, 'asset');

  const evidenceIndex = new Map();
  const evidenceRelations = [];
  const citations = collectSiteCitations(input);
  input.evidence.forEach((item, i) => {
    const label = `E${i + 1}`;
    const relation = { id: item.id, kind: item.kind, label, citedBy: citations.get(item.id) ?? [] };
    if (item.kind === 'file') {
      const bytes = evidenceBytes.get(item.id);
      if (!bytes) throw new BuildError('evidence-missing', `missing bytes for evidence ${item.id}`);
      const sha = sha256Hex(bytes);
      const href = `evidence/${sha}.${EVIDENCE_MEDIA[item.mediaType]}`;
      addFile(href, bytes, 'evidence');
      evidenceIndex.set(item.id, {
        label,
        title: item.title,
        kind: item.kind,
        href,
        sha256: sha,
        bytes: bytes.length,
        mediaType: item.mediaType,
        previewText: bytes.toString('utf8'),
        citedBy: relation.citedBy,
      });
      Object.assign(relation, { path: href, sha256: sha, mediaType: item.mediaType });
    } else {
      evidenceIndex.set(item.id, { label, title: item.title, kind: item.kind, citedBy: relation.citedBy });
    }
    evidenceRelations.push(relation);
  });

  const htmlPages = renderSiteHtmlPages(input, { evidenceIndex, stylesheetHref, sourceSha256 });
  for (const [path, html] of htmlPages) {
    const bytes = Buffer.from(html, 'utf8');
    if (bytes.length > LIMITS.renderedHtmlBytes) throw new BuildError('limit', `rendered HTML ${path} is ${bytes.length} bytes; limit ${LIMITS.renderedHtmlBytes}`);
    addFile(path, bytes, path === 'index.html' ? 'entry' : 'page');
  }

  const mdPages = renderSiteMarkdownPages(input, { evidenceIndex, sourceSha256 });
  for (const [path, md] of mdPages) {
    const bytes = Buffer.from(md, 'utf8');
    if (bytes.length > LIMITS.renderedMarkdownBytes) throw new BuildError('limit', `rendered Markdown ${path} is ${bytes.length} bytes; limit ${LIMITS.renderedMarkdownBytes}`);
    addFile(path, bytes, 'report');
  }

  const inventory = [...files.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((f) => ({ path: f.path, role: f.role, mediaType: mediaTypeFor(f.path), bytes: f.bytes.length, sha256: sha256Hex(f.bytes) }));

  const parts = siteManifestParts(input);
  const identity = {
    schema: SITE_BUNDLE_SCHEMA,
    entry: 'index.html',
    agentEntry: SITE_AGENT_ENTRY,
    site: {
      schema: input.schema,
      title: input.title,
      edition: parts.edition,
      registry: { version: input.registry.version, sha256: input.registry.sha256 },
      sourceSha256,
      // Only when the input declares it, so V1 sites keep their exact bytes.
      ...(input.publication ? { publication: input.publication } : {}),
    },
    pages: parts.pages,
    anchors: parts.anchors,
    decisions: parts.decisions,
    files: inventory,
    evidence: evidenceRelations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    build: { tool: TOOL.name, version: TOOL.version, renderPolicy: TOOL.renderPolicy, securityPolicy: TOOL.securityPolicy },
  };
  const contentId = contentIdFromIdentityBytes(canonicalBytes(identity));
  const manifest = { ...identity, contentId };
  const manifestBytes = canonicalBytes(manifest);
  const checksums = {
    schema: CHECKSUMS_SCHEMA,
    algorithm: 'sha256',
    contentId,
    manifestSha256: sha256Hex(manifestBytes),
    files: Object.fromEntries(inventory.map((f) => [f.path, f.sha256])),
  };
  const checksumsBytes = canonicalBytes(checksums);

  const output = new Map([...files.values()].map((f) => [f.path, f.bytes]));
  output.set('manifest.json', manifestBytes);
  output.set('checksums.json', checksumsBytes);
  return { contentId, manifest, manifestBytes, checksums, output };
}

export async function loadSiteInput(sitePath) {
  const abs = resolve(sitePath);
  const bytes = await readRegularFile(abs, SITE_LIMITS.inputBytes, 'site-input');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BuildError('report-encoding', 'site-input must be valid UTF-8');
  }
  const site = validateSiteInput(parseSiteInputText(text));
  return { site, baseDir: await realpath(dirname(abs)) };
}

export async function buildSiteBundle({ sitePath, outDir, stylesheetBytes }) {
  const { site, baseDir } = await loadSiteInput(sitePath);
  const evidenceBytes = await loadEvidence(site, baseDir);
  const css = stylesheetBytes ?? (await readFile(DEFAULT_SITE_STYLESHEET));
  const fontAssets = [];
  for (const font of DEFAULT_FONT_FILES) {
    fontAssets.push({ ...font, bytes: await readFile(new URL(font.file, DEFAULT_FONT_DIR)) });
  }
  const bundle = assembleSiteBundle(site, { evidenceBytes, stylesheetBytes: css, fontAssets });
  const written = outDir ? await writePacketDirectory(bundle.output, outDir) : null;
  return { ...bundle, outDir: written };
}
