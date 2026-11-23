// report/v1 source -> immutable packet/v1 directory.
//
// Identity inputs are exactly: the canonical report, the bytes of referenced
// evidence files, the stylesheet bytes, and the tool/policy versions. Nothing
// else (cwd, absolute paths, wall-clock time, environment, temp names, provider
// URLs) is read into the output. See docs/decisions/phase1-contract.md D1-D3.
import { constants as FS, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalBytes } from '../canonical-json.mjs';
import { contentIdFromIdentityBytes, sha256Hex } from '../hash.mjs';
import { AGENT_ENTRY, CHECKSUMS_SCHEMA, EVIDENCE_MEDIA, LIMITS, PACKET_MEDIA, PACKET_SCHEMA, DEFAULT_RENDER_POLICY, RENDER_POLICIES, RENDER_POLICY_2, SECURITY_POLICIES, TOOL } from '../policy.mjs';
import { lintReport } from '../report/lint.mjs';
import { parseReportText, validateReport } from '../report/validate.mjs';
import { renderIndexHtml } from '../render/html.mjs';
import { renderIndexHtmlV2 } from '../render/html-v2.mjs';
import { DEFAULT_MARKS_DIR, LOCKUP_FILES, LockupError, sanitizeLockupSvg } from '../render/lockup.mjs';
import { renderReportMarkdown } from '../render/markdown.mjs';
import { BUILD_VERSION_RE_2, reissueRelationFindings } from './verify.mjs';

export const DEFAULT_STYLESHEET = new URL('../presentation/variant-a.css', import.meta.url);
export const DEFAULT_FONT_DIR = new URL('../presentation/fonts/libron/', import.meta.url);
const DEFAULT_FONT_FILES = Object.freeze([
  { file: 'Libron-Regular.woff2', family: 'Libron', style: 'normal', weight: '400' },
  { file: 'Libron-Italic.woff2', family: 'Libron', style: 'italic', weight: '400' },
  { file: 'Libron-Bold.woff2', family: 'Libron', style: 'normal', weight: '700' },
  { file: 'Libron-BoldItalic.woff2', family: 'Libron', style: 'italic', weight: '700' },
]);
// render-policy/2 (R2, R6): its own stylesheet, and JetBrains Mono 400/700 embedded
// beside the four Libron faces. Policy/1 inputs above are unchanged.
export const EDITION_21_STYLESHEET = new URL('../presentation/edition-2.1.css', import.meta.url);
export const MONO_FONT_DIR = new URL('../presentation/fonts/jetbrains-mono/', import.meta.url);
const MONO_FONT_FILES = Object.freeze([
  { file: 'JetBrainsMono-400.woff2', family: 'JetBrains Mono', style: 'normal', weight: '400' },
  { file: 'JetBrainsMono-700.woff2', family: 'JetBrains Mono', style: 'normal', weight: '700' },
]);

export class BuildError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'BuildError';
    this.code = code;
  }
}

async function readRegularFile(absPath, maxBytes, label) {
  const st = await lstat(absPath).catch((err) => {
    throw new BuildError('evidence-missing', `${label}: ${err.code ?? err.message}`);
  });
  if (st.isSymbolicLink()) throw new BuildError('unsafe-evidence', `${label}: symbolic links are not followed`);
  if (!st.isFile()) throw new BuildError('unsafe-evidence', `${label}: not a regular file (device, FIFO, socket, or directory)`);
  if (st.size > maxBytes) throw new BuildError('limit', `${label}: ${st.size} bytes exceeds ${maxBytes}`);
  // O_NOFOLLOW and O_NONBLOCK close the lstat->open race: a symlink or FIFO swapped
  // in after lstat fails to open or cannot block the build.
  const handle = await open(absPath, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK).catch((err) => {
    throw new BuildError('unsafe-evidence', `${label}: ${err.code ?? err.message}`);
  });
  try {
    const fst = await handle.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new BuildError('unsafe-evidence', `${label}: file changed during read`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new BuildError('limit', `${label}: exceeds ${maxBytes} bytes`);
    return bytes;
  } finally {
    await handle.close();
  }
}

// Walk each path segment with lstat so a symlinked directory anywhere in the
// chain is rejected, then confirm the resolved path stays under the base.
async function resolveEvidencePath(baseDir, relPath) {
  let current = baseDir;
  const segments = relPath.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]);
    const st = await lstat(current).catch(() => null);
    if (!st) throw new BuildError('evidence-missing', `${relPath}: directory ${segments.slice(0, i + 1).join('/')} not found`);
    if (st.isSymbolicLink()) throw new BuildError('unsafe-evidence', `${relPath}: symbolic link in path`);
    if (!st.isDirectory()) throw new BuildError('unsafe-evidence', `${relPath}: ${segments.slice(0, i + 1).join('/')} is not a directory`);
  }
  const target = join(current, segments[segments.length - 1]);
  if (!target.startsWith(`${baseDir}/`)) throw new BuildError('unsafe-evidence', `${relPath}: escapes the report directory`);
  return target;
}

function checkEvidenceContent(bytes, mediaType, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new BuildError('unsafe-evidence', `${label}: ${mediaType} evidence must be valid UTF-8`);
  }
  if (text.includes('\0')) throw new BuildError('unsafe-evidence', `${label}: NUL byte in text evidence`);
  if (mediaType === 'application/json') {
    try {
      parseReportText(text);
    } catch (err) {
      throw new BuildError('unsafe-evidence', `${label}: invalid or too deeply nested JSON (${err.errors?.[0]?.message ?? err.message})`);
    }
  }
}

// Evidence id -> list of anchors that cite it, derived from report structure.
export function collectCitations(report) {
  const cited = new Map();
  const add = (id, anchor) => {
    const list = cited.get(id) ?? [];
    if (!list.includes(anchor)) list.push(anchor);
    cited.set(id, list);
  };
  const walkInline = (value, anchor) => {
    if (Array.isArray(value)) for (const seg of value) if (seg && typeof seg === 'object' && Object.hasOwn(seg, 'cite')) add(seg.cite, anchor);
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
      case 'decision': {
        const a = `d-${block.id}`;
        if (block.context) walkInline(block.context, a);
        walkInline(block.recommendation, a);
        block.alternatives.forEach((alt) => walkInline(alt.summary, a));
        (block.consequences ?? []).forEach((c) => walkInline(c, a));
        break;
      }
      case 'risk': walkInline(block.mitigation, `r-${block.id}`); break;
      case 'code': case 'diff': if (block.caption) walkInline(block.caption, anchor); break;
      case 'table': block.rows.forEach((row) => block.columns.forEach((c) => walkInline(row[c.key], anchor))); break;
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
  walkInline(report.summary.verdict.text, 'summary');
  report.summary.paragraphs.forEach((p) => walkInline(p, 'summary'));
  if (report.summary.metrics) walkBlock({ type: 'metrics', ...report.summary.metrics }, 'summary');
  report.sections.forEach((s) => s.blocks.forEach((b) => walkBlock(b, `sec-${s.id}`)));
  (report.appendices ?? []).forEach((s) => s.blocks.forEach((b) => walkBlock(b, `app-${s.id}`)));
  if (report.provenance.notes) walkInline(report.provenance.notes, 'provenance');
  for (const list of cited.values()) list.sort();
  return cited;
}

function mediaTypeFor(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const type = PACKET_MEDIA[ext];
  if (!type) throw new BuildError('internal', `no media type for ${path}`);
  return type;
}

// Pure: validated report + loaded bytes -> packet file map and manifest.
// `tool` is this build's TOOL; reproduction passes a packet's recorded manifest.build
// values (render-policy/2 only) so it can rebuild that packet byte for byte.
export function assemblePacket(report, { evidenceBytes, stylesheetBytes, fontAssets = [], renderPolicy = DEFAULT_RENDER_POLICY, lockups = { ui: null, display: null }, reissueOf = null, tool = TOOL }) {
  if (tool !== TOOL && renderPolicy !== RENDER_POLICY_2) throw new BuildError('internal', 'a recorded tool applies only to render-policy/2 reproduction');
  // R11 build metadata: a policy/2 packet is sealed only by canon, under a known security
  // policy, at a strict semver version (the verifier refuses anything else).
  if (renderPolicy === RENDER_POLICY_2) {
    if (tool?.name !== TOOL.name) throw new BuildError('build-metadata', `tool must be ${JSON.stringify(TOOL.name)}, got ${JSON.stringify(tool?.name)}`);
    if (!SECURITY_POLICIES.includes(tool?.securityPolicy)) throw new BuildError('build-metadata', `securityPolicy must be one of ${SECURITY_POLICIES.join(', ')}, got ${JSON.stringify(tool?.securityPolicy)}`);
    if (typeof tool?.version !== 'string' || !BUILD_VERSION_RE_2.test(tool.version)) throw new BuildError('build-metadata', `version must be strict semver major.minor.patch with no leading zeros, got ${JSON.stringify(tool?.version)}`);
    // R11: verify rebuilds a policy/2 packet from reproductionRenderInputs(), so a packet
    // sealed from any other renderer input (a stylesheet override, another marks directory,
    // different fonts) would fail its own verify. Refuse every input whose value differs
    // from what reproduction uses; the set compared is that object's own keys.
    // The comparison is strict, so a few honest library calls are refused although they
    // would render the same bytes: a Uint8Array stylesheet, the shipped fonts in another
    // order, a font or lockups object with an extra key. That is accepted (review 4): the CLI
    // and buildPacket never build them, and refusing changes no valid output.
    const differs = renderInputDifferences({ stylesheetBytes, fontAssets, lockups }, reproductionRenderInputs());
    if (differs.length) {
      throw new BuildError('render-inputs', `${RENDER_POLICY_2} seals only the shipped renderer inputs, which verify rebuilds it from; this build's ${differs.join(', ')} differ (a stylesheet override or a marks directory other than the shipped one cannot be reproduced)`);
    }
  }
  if (!RENDER_POLICIES.includes(renderPolicy)) throw new BuildError('render-policy', `unknown render policy ${JSON.stringify(renderPolicy)}; expected one of ${RENDER_POLICIES.join(', ')}`);
  if (reissueOf !== null && renderPolicy !== RENDER_POLICY_2) throw new BuildError('reissue-of', `reissueOf is a ${RENDER_POLICY_2} field; this build is ${renderPolicy}`);
  if (reissueOf !== null && !/^sha256-[0-9a-f]{64}$/.test(reissueOf)) throw new BuildError('reissue-of', `reissueOf must be a content ID, got ${JSON.stringify(reissueOf)}`);
  // Evidence bytes are Buffers, as loadEvidence and reproduction read them (review 4 MINOR 2).
  // Anything else (a Uint8Array renders its preview as comma-separated numbers) is refused, not
  // converted, under both policies: refusing changes no valid output, so render-policy/1
  // output stays byte-identical.
  for (const item of report.evidence) {
    if (item.kind !== 'file') continue;
    const bytes = typeof evidenceBytes?.get === 'function' ? evidenceBytes.get(item.id) : undefined;
    if (!Buffer.isBuffer(bytes)) throw new BuildError('evidence-bytes', `evidence ${JSON.stringify(item.id)}: bytes must be a Buffer, got ${bytes === null ? 'null' : bytes?.constructor?.name ?? typeof bytes}`);
  }
  const sourceBytes = canonicalBytes(report);
  const sourceSha256 = sha256Hex(sourceBytes);
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
  const packetStylesheet = Buffer.concat([
    Buffer.from(fontFaces.length ? `${fontFaces.join('\n')}\n` : '', 'utf8'),
    stylesheetBytes,
  ]);
  const cssSha = sha256Hex(packetStylesheet);
  const stylesheetHref = `assets/${cssSha}.css`;
  addFile(stylesheetHref, packetStylesheet, 'asset');

  const evidenceIndex = new Map();
  const evidenceRelations = [];
  const citations = collectCitations(report);
  report.evidence.forEach((item, i) => {
    const label = `E${i + 1}`;
    const relation = { id: item.id, kind: item.kind, label, citedBy: citations.get(item.id) ?? [] };
    if (item.kind === 'file') {
      const bytes = evidenceBytes.get(item.id);
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
      });
      Object.assign(relation, { path: href, sha256: sha, mediaType: item.mediaType });
    } else {
      evidenceIndex.set(item.id, { label, title: item.title, kind: item.kind });
    }
    evidenceRelations.push(relation);
  });

  const html = renderPolicy === RENDER_POLICY_2
    ? renderIndexHtmlV2(report, { evidenceIndex, stylesheetHref, sourceSha256, lockups, tool })
    : renderIndexHtml(report, { evidenceIndex, stylesheetHref, sourceSha256 });
  const htmlBytes = Buffer.from(html, 'utf8');
  if (htmlBytes.length > LIMITS.renderedHtmlBytes) throw new BuildError('limit', `rendered HTML is ${htmlBytes.length} bytes; limit ${LIMITS.renderedHtmlBytes}`);
  addFile('index.html', htmlBytes, 'entry');

  const markdownBytes = Buffer.from(renderReportMarkdown(report, { evidenceIndex, sourceSha256 }), 'utf8');
  if (markdownBytes.length > LIMITS.renderedMarkdownBytes) throw new BuildError('limit', `rendered Markdown is ${markdownBytes.length} bytes; limit ${LIMITS.renderedMarkdownBytes}`);
  addFile('report.md', markdownBytes, 'report');
  // R2: a policy/2 packet carries its canonical report/v1 source bytes, whose SHA-256 is
  // manifest.report.sourceSha256 by construction.
  if (renderPolicy === RENDER_POLICY_2) addFile('report.json', sourceBytes, 'source');

  const inventory = [...files.values()]
    .sort((a, b) => (Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))))
    .map((f) => ({ path: f.path, role: f.role, mediaType: mediaTypeFor(f.path), bytes: f.bytes.length, sha256: sha256Hex(f.bytes) }));

  const identity = {
    schema: PACKET_SCHEMA,
    entry: 'index.html',
    // The coequal agent entry point and its anchor convention (D2, D10).
    agentEntry: AGENT_ENTRY,
    report: {
      schema: report.schema,
      id: report.id,
      title: report.title,
      status: report.metadata.status,
      classification: report.metadata.classification,
      reviewDate: report.metadata.reviewDate,
      sourceSha256,
      // Only when the report declares it, so V1 packets keep their exact bytes.
      ...(report.publication ? { publication: report.publication } : {}),
      // R8: only on a reissue, so every other packet keeps its exact bytes.
      ...(reissueOf ? { reissueOf } : {}),
    },
    files: inventory,
    evidence: evidenceRelations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    build: { tool: tool.name, version: tool.version, renderPolicy, securityPolicy: tool.securityPolicy },
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

export async function loadReport(reportPath) {
  const abs = resolve(reportPath);
  const bytes = await readRegularFile(abs, LIMITS.reportBytes, 'report');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BuildError('report-encoding', 'report must be valid UTF-8');
  }
  const report = validateReport(parseReportText(text));
  return { report, baseDir: await realpath(dirname(abs)) };
}

export async function loadEvidence(report, baseDir) {
  const evidenceBytes = new Map();
  let total = 0;
  for (const item of report.evidence) {
    if (item.kind !== 'file') continue;
    const abs = await resolveEvidencePath(baseDir, item.path);
    const bytes = await readRegularFile(abs, LIMITS.evidenceFileBytes, `evidence ${item.id} (${item.path})`);
    checkEvidenceContent(bytes, item.mediaType, `evidence ${item.id}`);
    total += bytes.length;
    if (total > LIMITS.evidenceTotalBytes) throw new BuildError('limit', `aggregate evidence exceeds ${LIMITS.evidenceTotalBytes} bytes`);
    evidenceBytes.set(item.id, bytes);
  }
  return evidenceBytes;
}

// Writes the packet to a sibling staging directory and renames it into place, so
// outDir either does not exist or holds a complete packet. Refuses to overwrite.
export async function writePacketDirectory(output, outDir) {
  const target = resolve(outDir);
  if (await lstat(target).catch(() => null)) throw new BuildError('output-exists', `${target} already exists; packets are never overwritten`);
  const staging = `${target}.staging-${process.pid}`;
  await mkdir(staging, { recursive: false });
  for (const [path, bytes] of output) {
    const abs = join(staging, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes, { flag: 'wx', mode: 0o644 });
  }
  await rename(staging, target);
  return target;
}

// R8: a reissue re-typesets an existing edition from the same source. The old packet must
// verify, and the new packet must hold its relations to it; the new manifest then records
// the old content ID as manifest.report.reissueOf. Before anything is written, the
// assembled packet must also hold every relation `canon verify --reissue-of` checks
// (checkReissueRelation), so a sealed reissueOf never fails its own verify.
async function resolveReissueOf(packetDir) {
  // The old packet passes its full verify: the independent rules and, for a policy/2
  // packet, reproduction (loaded lazily: reproduce.mjs imports this module).
  const { verifyPacketFull } = await import('./reproduce.mjs');
  const verified = await verifyPacketFull(resolve(packetDir));
  if (!verified.ok) {
    const first = verified.errors[0];
    throw new BuildError('reissue-of', `--reissue-of packet does not verify (${verified.errors.length} error(s); first: ${first.code} ${first.path}: ${first.message})`);
  }
  // The source digest, report.md and evidence comparisons all run once, on the assembled
  // packet, in checkReissueRelation.
  const manifest = JSON.parse(await readFile(join(resolve(packetDir), 'manifest.json'), 'utf8'));
  return { contentId: verified.contentId, manifest, reportMd: await readFile(join(resolve(packetDir), 'report.md')) };
}

function checkReissueRelation(packet, old) {
  const problems = reissueRelationFindings({ manifest: packet.manifest, reportMd: packet.output.get('report.md') }, old);
  if (problems.length) {
    throw new BuildError('reissue-of', `not a reissue: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  }
}

// The renderer inputs that are not in report.json: the shipped stylesheet, the embedded
// fonts and (policy/2) the brand lockups. Shared with reproduction, which rebuilds a
// policy/2 packet from these defaults.
export function renderInputFiles(renderPolicy, { marksDir = DEFAULT_MARKS_DIR } = {}) {
  const v2 = renderPolicy === RENDER_POLICY_2;
  return {
    stylesheet: v2 ? EDITION_21_STYLESHEET : DEFAULT_STYLESHEET,
    fonts: [
      ...DEFAULT_FONT_FILES.map((font) => ({ ...font, url: new URL(font.file, DEFAULT_FONT_DIR) })),
      ...(v2 ? MONO_FONT_FILES.map((font) => ({ ...font, url: new URL(font.file, MONO_FONT_DIR) })) : []),
    ],
    optionalLockups: v2 && marksDir instanceof URL ? Object.values(LOCKUP_FILES).map((file) => new URL(file, marksDir)) : [],
  };
}

// The renderer inputs, read. One synchronous reader serves builds, reproduction and the
// policy/2 input check in assemblePacket, so the three cannot read differently.
function readRenderInputs(renderPolicy, { marksDir = DEFAULT_MARKS_DIR } = {}) {
  const v2 = renderPolicy === RENDER_POLICY_2;
  const files = renderInputFiles(renderPolicy, { marksDir });
  const stylesheetBytes = readFileSync(files.stylesheet);
  const fontAssets = files.fonts.map(({ url, ...font }) => ({ ...font, bytes: readFileSync(url) }));
  let lockups = { ui: null, display: null };
  if (v2) {
    try {
      lockups = readLockups(marksDir);
    } catch (err) {
      if (err instanceof LockupError) throw new BuildError(err.code, err.message);
      throw err;
    }
  }
  return { stylesheetBytes, fontAssets, lockups };
}

// The brand lockups in marksDir: a missing file is no lockup; a present one is sanitized
// (src/render/lockup.mjs) or refused.
function readLockups(marksDir) {
  const result = { ui: null, display: null };
  for (const [kind, file] of Object.entries(LOCKUP_FILES)) {
    let text;
    try {
      text = readFileSync(marksDir instanceof URL ? new URL(file, marksDir) : join(marksDir, file), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new LockupError(`${file}: ${err.code ?? err.message}`);
    }
    result[kind] = sanitizeLockupSvg(text, kind, file);
  }
  return result;
}

export async function loadRenderInputs(renderPolicy, { marksDir = DEFAULT_MARKS_DIR } = {}) {
  return readRenderInputs(renderPolicy, { marksDir });
}

// Exactly the renderer inputs reproduction rebuilds a render-policy/2 packet from: the
// shipped stylesheet, fonts and marks directory.
export function reproductionRenderInputs() {
  return readRenderInputs(RENDER_POLICY_2, { marksDir: DEFAULT_MARKS_DIR });
}

// The keys of `want` whose values `have` does not equal (bytes, arrays and plain objects
// compared by value).
function renderInputDifferences(have, want) {
  return Object.keys(want).filter((key) => !sameValue(have[key], want[key]));
}

function sameValue(a, b) {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue(a[k], b[k]));
  }
  return a === b;
}

export async function buildPacket({ reportPath, outDir, stylesheetBytes, renderPolicy = DEFAULT_RENDER_POLICY, marksDir = DEFAULT_MARKS_DIR, reissueOfDir = null }) {
  if (!RENDER_POLICIES.includes(renderPolicy)) throw new BuildError('render-policy', `unknown render policy ${JSON.stringify(renderPolicy)}; expected one of ${RENDER_POLICIES.join(', ')}`);
  if (reissueOfDir !== null && renderPolicy !== RENDER_POLICY_2) throw new BuildError('reissue-of', `--reissue-of needs --render-policy 2: reissueOf is a ${RENDER_POLICY_2} field`);
  const { report, baseDir } = await loadReport(reportPath);
  const old = reissueOfDir === null ? null : await resolveReissueOf(reissueOfDir);
  const evidenceBytes = await loadEvidence(report, baseDir);
  const inputs = await loadRenderInputs(renderPolicy, { marksDir });
  const css = stylesheetBytes ?? inputs.stylesheetBytes;
  const { fontAssets, lockups } = inputs;
  // R7: compile-time lint. Warnings are returned, never thrown, and never enter the packet.
  const warnings = lintReport(report);
  const packet = assemblePacket(report, { evidenceBytes, stylesheetBytes: css, fontAssets, renderPolicy, lockups, reissueOf: old?.contentId ?? null });
  if (old) checkReissueRelation(packet, old);
  const written = outDir ? await writePacketDirectory(packet.output, outDir) : null;
  return { ...packet, warnings, outDir: written };
}

export { DEFAULT_FONT_FILES, MONO_FONT_FILES, readRegularFile };
