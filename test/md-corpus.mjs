// Builds the realistic-prose corpus (fixtures/corpus/realistic-prose.json) into a
// report/v1 document: every string as a paragraph, a list item, a table cell and a
// finding title, and wrapped in authored emphasis, strong, code and links, appended
// to the fixture report as one extra section.
import { readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPacket } from '../src/packet/build.mjs';
import { renderStrictMarkdown } from '../src/render/markdown.mjs';
import { REPO } from './helpers.mjs';

export async function corpusStrings() {
  return JSON.parse(await readFile(join(REPO, 'fixtures/corpus/realistic-prose.json'), 'utf8')).strings;
}

export async function buildCorpusPacket(dir) {
  const strings = await corpusStrings();
  await cp(join(REPO, 'fixtures/report'), join(dir, 'src'), { recursive: true });
  const path = join(dir, 'src/phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.sections.push({
    id: 'corpus',
    title: 'Realistic prose corpus',
    blocks: [
      ...strings.map((s) => ({ type: 'paragraph', text: s })),
      // Authored inline structure around the same strings: emphasis, strong, code,
      // citations and links, so the structure gate sees authored em/strong nodes.
      ...strings.map((s, i) => ({ type: 'paragraph', text: [i % 2 ? { em: s } : { strong: s }, ' and ', { code: s.split(' ')[0] }, ' see ', { cite: 'ev-latency' }, ' or ', { link: { text: s, href: 'https://example.com/docs' } }, '.'] })),
      { type: 'list', ordered: false, items: strings },
      { type: 'table', id: 'corpus-cells', caption: 'Corpus in table cells', columns: [{ key: 'n', label: 'N', numeric: true }, { key: 's', label: 'Text' }], rows: strings.map((s, i) => ({ n: String(i + 1), s })) },
      ...strings.map((s, i) => ({ type: 'finding', id: `C-${i + 1}`, title: s, severity: 'info', confidence: 'open', claim: 'Corpus heading.', evidence: ['ev-determinism'] })),
    ],
  });
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(dir, 'packet') });
  return { built, report, markdown: await readFile(join(built.outDir, 'report.md'), 'utf8'), strings };
}

// The strict serialization (before escape relaxation) of a built report, with the
// evidence index rebuilt from the packet manifest exactly as the builder made it.
export async function strictMarkdownFor(outDir, report) {
  const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
  const bytes = new Map(manifest.files.map((f) => [f.path, f.bytes]));
  const evidenceIndex = new Map(report.evidence.map((item, i) => {
    const rel = manifest.evidence.find((e) => e.id === item.id);
    return [item.id, item.kind === 'file'
      ? { label: `E${i + 1}`, title: item.title, kind: item.kind, href: rel.path, sha256: rel.sha256, bytes: bytes.get(rel.path) }
      : { label: `E${i + 1}`, title: item.title, kind: item.kind }];
  }));
  return renderStrictMarkdown(report, { evidenceIndex, sourceSha256: manifest.report.sourceSha256 });
}

// Context for the structure and anchor gates, from the packet manifest.
export async function gateContext(outDir) {
  const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
  const bytes = new Map(manifest.files.map((f) => [f.path, f.bytes]));
  return {
    manifest,
    labels: new Map(manifest.evidence.map((e) => [e.id, e.label])),
    evidence: new Map(manifest.evidence.filter((e) => e.path).map((e) => [e.id, { href: e.path, sha256: e.sha256, bytes: bytes.get(e.path) }])),
    sourceSha256: manifest.report.sourceSha256,
  };
}
