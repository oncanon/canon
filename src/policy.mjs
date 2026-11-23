// Versioned Phase 1 policy constants. Every value here is part of the contract in
// docs/decisions/phase1-contract.md and is bound by tests; changing one is a
// deliberate policy change, not a tuning knob.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Every security policy a packet may name (render-policy-2.md R11 build metadata). Today only
// security-policy/1; a new one is added here, and the verifier's own copy is held equal to
// this list by test/unit/rp2-verify.test.mjs.
export const SECURITY_POLICIES = Object.freeze(['security-policy/1']);

export const TOOL = Object.freeze({
  name: 'canon',
  version: pkg.version,
  renderPolicy: 'render-policy/1',
  securityPolicy: SECURITY_POLICIES[0],
});

// Render policies a report/v1 build may select (docs/decisions/render-policy-2.md R1).
// TOOL.renderPolicy is the value the frozen render-policy/1 renderer and site-bundle/v1
// print; it is not the build default and never moves.
export const RENDER_POLICY_1 = 'render-policy/1';
export const RENDER_POLICY_2 = 'render-policy/2';
export const RENDER_POLICIES = Object.freeze([RENDER_POLICY_1, RENDER_POLICY_2]);

// The one switch for the policy/2 cutover (render-policy-2.md R1 and R12). It is the
// default render policy of `canon build`, `canon brief`, buildPacket and assemblePacket,
// and it arms the store admission gate (src/publish/admission.mjs): while it is
// render-policy/1 the gate is dormant; once R10 acceptance moves it to render-policy/2,
// publishing a render-policy/1 packet into a store needs --allow-render-policy-1.
export const DEFAULT_RENDER_POLICY = RENDER_POLICY_1;

export const REPORT_SCHEMA = 'report/v1';
export const PACKET_SCHEMA = 'packet/v1';
// report.md is the coequal agent entry point; its block anchors are CommonMark link
// reference definitions under headings (docs/decisions/phase1-contract.md D10).
export const AGENT_ENTRY = Object.freeze({ path: 'report.md', anchors: 'reference-definitions/1' });
export const CHECKSUMS_SCHEMA = 'checksums/v1';
export const ALIAS_SCHEMA = 'alias/v1';
export const RECEIPT_SCHEMA = 'receipt/v1';

// D4: resource limits (source side).
export const LIMITS = Object.freeze({
  reportBytes: 1024 * 1024,
  jsonDepth: 16,
  stringChars: 20_000,
  sections: 64,
  blocksTotal: 1000,
  listItems: 200,
  codeBytesPerBlock: 200 * 1024,
  codeLinesPerBlock: 4000,
  codeLineChars: 2000,
  codeBytesTotal: 1024 * 1024,
  tableRows: 400,
  tableColumns: 12,
  chartSeries: 40,
  diagramNodes: 24,
  evidenceFiles: 32,
  evidenceFileBytes: 4 * 1024 * 1024,
  evidenceTotalBytes: 16 * 1024 * 1024,
  urlChars: 2048,
  renderedHtmlBytes: 8 * 1024 * 1024,
  renderedMarkdownBytes: 8 * 1024 * 1024,
});

// D4: resource limits (packet side, enforced by the verifier).
export const PACKET_LIMITS = Object.freeze({
  files: 64,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
});

// D2: evidence media allowlist. SVG, HTML, and anything scriptable are not allowed.
export const EVIDENCE_MEDIA = Object.freeze({
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
});

// Media types a packet file may carry, by extension.
export const PACKET_MEDIA = Object.freeze({
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
});

// D6: packet Content Security Policy. No script execution, no external origins.
export const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "script-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// frame-ancestors is ignored in <meta>; the meta copy exists for file:// and archive use.
export const CSP_META = CSP.split('; ').filter((d) => !d.startsWith('frame-ancestors')).join('; ');
