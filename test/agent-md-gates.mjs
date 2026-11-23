// Executable gates for report.md as the coequal agent artifact (agent-Markdown
// requirement items 1-5). Each gate re-derives its expectation independently of the
// renderer: structure and anchors from the report/v1 source, escape necessity from
// real parsers (commonmark 0.31.2 and pandoc -f gfm).
import { spawnSync } from 'node:child_process';
import * as commonmark from 'commonmark';
import { commonmarkTree, findEscapes, pandocTree, proseLength, SEP } from './md-escapes.mjs';

const SEVERITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const CONFIDENCE = { proven: 'Proven', recommended: 'Recommended', defect: 'Defect', open: 'Open' };
const VERIFICATION = { code: 'Code check', judgment: 'Judgment', review: 'Human review', 'needs-review': 'Needs review' };
const EARS = { ubiquitous: 'Ubiquitous', event: 'Event-driven', state: 'State-driven', unwanted: 'Unwanted behavior', optional: 'Optional feature' };
const LANGUAGE = { typescript: 'typescript', javascript: 'javascript', json: 'json', shell: 'shell', yaml: 'yaml', text: 'text' };

const clean = (s) => s.replace(/​/g, '').replace(/\s+/g, ' ').trim();

// ---- item 1: structure derived from the source --------------------------------------
// ctx: { labels: Map(evidence id -> "E1"), evidence: Map(id -> { href, sha256, bytes, mediaType }), sourceSha256 }
function inlineText(value, ctx) {
  const segs = typeof value === 'string' ? [value] : value;
  return segs.map((s) => {
    if (typeof s === 'string') return s;
    if (Object.hasOwn(s, 'text')) return s.text;
    if (Object.hasOwn(s, 'code')) return s.code;
    if (Object.hasOwn(s, 'em')) return s.em;
    if (Object.hasOwn(s, 'strong')) return s.strong;
    if (Object.hasOwn(s, 'cite')) return `[${ctx.labels.get(s.cite)}]`;
    if (Object.hasOwn(s, 'link')) return s.link.text;
    throw new Error(`unknown segment ${JSON.stringify(s)}`);
  }).join('');
}

function inlineMarks(value) {
  const segs = typeof value === 'string' ? [] : value;
  return segs.flatMap((s) => (typeof s !== 'object' ? [] : Object.hasOwn(s, 'em') ? [{ em: clean(s.em) }] : Object.hasOwn(s, 'strong') ? [{ strong: clean(s.strong) }] : []));
}

// Expected document outline: top-level blocks in order, plus every emphasis/strong
// node in order. Paragraph and item texts are whitespace-collapsed plain text.
export function expectedOutline(report, ctx) {
  const blocks = [];
  const marks = [];
  const heading = (level, text) => blocks.push({ t: 'heading', level, text: clean(text) });
  const para = (text) => blocks.push({ t: 'paragraph', text: clean(text) });
  const list = (ordered, items) => blocks.push({ t: 'list', ordered, items: items.map(clean) });
  const strong = (text) => marks.push({ strong: clean(text) });
  const refs = (ids) => ids.map((id) => `[${ctx.labels.get(id)}]`).join(', ');
  const block = (b, depth) => {
    const h = '#'.repeat(depth).length;
    switch (b.type) {
      case 'paragraph': para(inlineText(b.text, ctx)); marks.push(...inlineMarks(b.text)); break;
      case 'list': list(Boolean(b.ordered), b.items.map((i) => inlineText(i, ctx))); b.items.forEach((i) => marks.push(...inlineMarks(i))); break;
      case 'finding': {
        heading(h, `Finding ${b.id}: ${b.title}`);
        const verifText = b.verification ? ` Verification. ${VERIFICATION[b.verification.band]}${b.verification.detail ? ` — ${b.verification.detail}` : ''}` : '';
        para(`Severity. ${SEVERITY[b.severity]} Confidence. ${CONFIDENCE[b.confidence]}${verifText} Claim. ${inlineText(b.claim, ctx)} Evidence. ${refs(b.evidence)}`);
        strong('Severity.'); strong('Confidence.'); if (b.verification) strong('Verification.'); strong('Claim.'); marks.push(...inlineMarks(b.claim)); strong('Evidence.');
        (b.detail ?? []).forEach((d) => block(d, depth + 1));
        break;
      }
      case 'decision': {
        heading(h, `Decision ${b.id}: ${b.question}`);
        const ctxPart = b.context ? ` Context. ${inlineText(b.context, ctx)}` : '';
        para(`Status. ${b.status === 'needed' ? 'Decision needed' : 'Decided'}${b.owner ? ` Owner. ${b.owner}` : ''}${ctxPart} Recommendation. ${inlineText(b.recommendation, ctx)}`);
        strong('Status.'); if (b.owner) strong('Owner.'); if (b.context) { strong('Context.'); marks.push(...inlineMarks(b.context)); } strong('Recommendation.'); marks.push(...inlineMarks(b.recommendation));
        para('Alternatives.'); strong('Alternatives.');
        list(false, b.alternatives.map((a) => `${a.chosen ? `Chosen — ${a.label}` : a.label}: ${inlineText(a.summary, ctx)}`));
        b.alternatives.forEach((a) => { if (a.chosen) strong(`Chosen — ${a.label}`); marks.push(...inlineMarks(a.summary)); });
        if (b.consequences?.length) {
          para('Consequences.'); strong('Consequences.');
          list(false, b.consequences.map((c) => inlineText(c, ctx)));
          b.consequences.forEach((c) => marks.push(...inlineMarks(c)));
        }
        break;
      }
      case 'risk':
        heading(h, `Risk ${b.id}: ${b.title}`);
        para(`Likelihood. ${b.likelihood} Impact. ${b.impact} Mitigation. ${inlineText(b.mitigation, ctx)}`);
        strong('Likelihood.'); strong('Impact.'); strong('Mitigation.'); marks.push(...inlineMarks(b.mitigation));
        break;
      case 'requirement': {
        heading(h, `Requirement ${b.id}: ${b.title}`);
        const verif = `${VERIFICATION[b.verification.band]}${b.verification.detail ? ` — ${b.verification.detail}` : ''}`;
        const evText = b.evidence ? ` Evidence. ${refs(b.evidence)}` : '';
        para(`Pattern. ${EARS[b.pattern]} Verification. ${verif} Specification. ${inlineText(b.statement, ctx)}${evText}`);
        strong('Pattern.'); strong('Verification.'); strong('Specification.'); marks.push(...inlineMarks(b.statement)); if (b.evidence) strong('Evidence.');
        if (b.scenarios?.length) {
          blocks.push({ t: 'table', rows: [['Scenario', 'Given', 'When', 'Then'], ...b.scenarios.map((sc) => [clean(sc.name), clean(sc.given), clean(sc.when), clean(sc.then)])] });
        }
        break;
      }
      case 'comparison': {
        heading(h, `Comparison: ${b.title}`);
        if (b.caption) { para(inlineText(b.caption, ctx)); marks.push(...inlineMarks(b.caption)); }
        for (const side of [b.left, b.right]) {
          heading(h + 1, side.label);
          para(inlineText(side.summary, ctx)); marks.push(...inlineMarks(side.summary));
          if (side.items?.length) {
            list(false, side.items.map((it) => inlineText(it, ctx)));
            side.items.forEach((it) => marks.push(...inlineMarks(it)));
          }
          if (side.code) blocks.push({ t: 'code', info: LANGUAGE[side.code.language], text: side.code.source });
        }
        if (b.evidence) { para(`Evidence. ${refs(b.evidence)}`); strong('Evidence.'); }
        break;
      }
      case 'code': case 'diff':
        heading(h, `${b.type === 'code' ? 'Code' : 'Diff'}: ${b.title}`);
        if (b.caption) { para(inlineText(b.caption, ctx)); marks.push(...inlineMarks(b.caption)); }
        blocks.push({ t: 'code', info: b.type === 'code' ? LANGUAGE[b.language] : 'diff', text: b.type === 'code' ? b.source : b.patch });
        break;
      case 'table':
        heading(h, `Table: ${b.caption}`);
        blocks.push({ t: 'table', rows: [b.columns.map((c) => clean(c.label)), ...b.rows.map((r) => b.columns.map((c) => clean(inlineText(r[c.key], ctx))))] });
        b.rows.forEach((r) => b.columns.forEach((c) => marks.push(...inlineMarks(r[c.key]))));
        break;
      case 'chart': {
        heading(h, `Chart: ${b.title}`);
        const budgetPart = b.kind === 'quantiles' && Object.hasOwn(b, 'budget') ? ` Budget: ${b.budget} ${b.unit}.` : '';
        para(`${inlineText(b.caption, ctx)}${budgetPart}${b.evidence ? ` Evidence: ${refs(b.evidence)}.` : ''}`); marks.push(...inlineMarks(b.caption));
        if (b.kind === 'comparison') {
          blocks.push({ t: 'table', rows: [['Series', clean(b.baselineLabel), clean(b.candidateLabel)], ...b.series.map((p) => [clean(p.label), clean(`${p.baseline} ${b.unit}`), clean(`${p.value} ${b.unit}`)])] });
        } else if (b.kind === 'quantiles') {
          blocks.push({ t: 'table', rows: [['Series', 'p50', 'p95', 'p99'], ...b.series.map((p) => [clean(p.label), clean(`${p.p50} ${b.unit}`), clean(`${p.p95} ${b.unit}`), clean(`${p.p99} ${b.unit}`)])] });
        } else {
          blocks.push({ t: 'table', rows: [['Series', 'Value'], ...b.series.map((p) => [clean(p.label), clean(`${p.value} ${b.unit}`)])] });
        }
        break;
      }
      case 'diagram': {
        heading(h, `Diagram: ${b.title}`);
        para(`${inlineText(b.caption, ctx)}${b.evidence ? ` Evidence: ${refs(b.evidence)}.` : ''}`); marks.push(...inlineMarks(b.caption));
        if (b.kind === 'topology') {
          const labelById = new Map(b.groups.flatMap((g) => g.nodes.map((n) => [n.id, n.label])));
          list(false, b.groups.map((g) => `${g.label.trim()}: ${g.nodes.map((n) => `${n.label}${n.sublabel ? ` (${n.sublabel})` : ''}`).join(', ')}`));
          b.groups.forEach((g) => strong(`${g.label.trim()}:`));
          list(true, b.edges.map((e) => `${labelById.get(e.from) ?? e.from} -> ${labelById.get(e.to) ?? e.to}${e.style === 'gate' ? ' (Gate)' : ''}${e.label ? ` — ${e.label}` : ''}`));
          b.edges.forEach((e) => strong(`${labelById.get(e.from) ?? e.from} -> ${labelById.get(e.to) ?? e.to}`));
        } else if (b.kind === 'sequence') {
          const labelById = new Map(b.actors.map((a) => [a.id, a.label]));
          list(true, b.messages.map((m) => `${labelById.get(m.from) ?? m.from} -> ${labelById.get(m.to) ?? m.to}${m.gate ? ' (Gate)' : ''}: ${m.label}${m.note ? ` — ${m.note}` : ''}`));
          b.messages.forEach((m) => strong(`${labelById.get(m.from) ?? m.from} -> ${labelById.get(m.to) ?? m.to}`));
        } else {
          list(true, b.steps.map((s) => `${s.label}${s.gate ? ' (Gate)' : ''} — ${s.detail}`));
          b.steps.forEach((s) => strong(s.label));
        }
        break;
      }
      case 'metrics': metrics(b); break;
      default: throw new Error(`unknown block ${b.type}`);
    }
  };
  const metrics = (m) => {
    list(false, m.items.map((i) => `${i.label.trim()}: ${i.value}${i.unit ? ` ${i.unit}` : ''}${i.evidence ? ` (${refs(i.evidence)})` : ''}`));
    m.items.forEach((i) => strong(`${i.label.trim()}:`));
  };
  const section = (s, label) => {
    heading(2, `${label} ${s.title}`);
    if (s.lede) para(s.lede);
    s.blocks.forEach((b) => block(b, 3));
  };
  const meta = report.metadata;
  heading(1, report.title);
  if (report.subtitle) para(report.subtitle);
  list(false, [`Report ID: ${report.id}`, `Status: ${meta.status}`, `Classification: ${meta.classification}`, `Review date: ${meta.reviewDate}`, `Review request: ${meta.reviewRequest}`, `Authors: ${meta.authors.join(', ')}`]);
  heading(2, 'Executive summary');
  para(`Verdict (${CONFIDENCE[report.summary.verdict.confidence]}). ${inlineText(report.summary.verdict.text, ctx)}`);
  strong(`Verdict (${CONFIDENCE[report.summary.verdict.confidence]}).`); marks.push(...inlineMarks(report.summary.verdict.text));
  report.summary.paragraphs.forEach((p) => { para(inlineText(p, ctx)); marks.push(...inlineMarks(p)); });
  if (report.summary.metrics) { heading(3, 'Metrics'); metrics(report.summary.metrics); }
  report.sections.forEach((s, i) => section(s, `${i + 1}.`));
  heading(2, 'Evidence');
  report.evidence.forEach((item) => {
    heading(3, `${ctx.labels.get(item.id)}: ${item.title}`);
    const e = ctx.evidence.get(item.id);
    list(false, item.kind === 'file'
      ? [`ID: ${item.id}`, `File: ${e.href}`, `Media type: ${item.mediaType}`, `Bytes: ${e.bytes}`, `SHA-256: ${e.sha256}`]
      : [`ID: ${item.id}`, `Status: ${item.kind}`, `Reason: ${item.reason}`]);
  });
  (report.appendices ?? []).forEach((s, i) => section(s, `Appendix ${String.fromCharCode(65 + i)}.`));
  heading(2, 'Provenance and packet verification');
  if (report.provenance.notes) { para(inlineText(report.provenance.notes, ctx)); marks.push(...inlineMarks(report.provenance.notes)); }
  heading(3, 'Sources');
  list(false, report.provenance.sources.map((s) => `${s.label.trim()}: ${s.reference}${s.revision ? `; revision ${s.revision}` : ''}${s.sha256 ? `; SHA-256 ${s.sha256}` : ''}`));
  report.provenance.sources.forEach((s) => strong(`${s.label.trim()}:`));
  heading(3, 'Verification');
  list(false, [
    'This Markdown file is generated from the validated report model, not scraped from HTML.',
    'Its bytes are listed in manifest.json and checksums.json and therefore contribute to the immutable content ID.',
    'Run canon verify <packet-directory> to recompute every digest and the content ID.',
    `Canonical source report SHA-256: ${ctx.sourceSha256}.`,
  ]);
  return { blocks, marks };
}

function cmText(node) {
  let out = '';
  const walker = node.walker();
  let e;
  while ((e = walker.next())) {
    if (!e.entering) continue;
    const n = e.node;
    if (n.type === 'text' || n.type === 'code') out += n.literal;
    else if (n.type === 'softbreak' || n.type === 'linebreak') out += ' ';
    else if (n.type === 'html_inline') out += `<<HTML:${n.literal}>>`;
    else if (n.type === 'image') out += '<<IMAGE>>';
  }
  return clean(out);
}

// Outline from commonmark: GFM tables are not CommonMark and parse as paragraphs of
// pipe rows; they are dropped here and compared under pandoc only.
export function commonmarkOutline(md) {
  const doc = new commonmark.Parser().parse(md);
  const blocks = [];
  for (let b = doc.firstChild; b; b = b.next) {
    if (b.type === 'heading') blocks.push({ t: 'heading', level: b.level, text: cmText(b) });
    else if (b.type === 'paragraph') { if (!/^\|/.test(cmText(b))) blocks.push({ t: 'paragraph', text: cmText(b) }); }
    else if (b.type === 'list') {
      const items = [];
      for (let i = b.firstChild; i; i = i.next) items.push(cmText(i));
      blocks.push({ t: 'list', ordered: b.listType === 'ordered', items });
    } else if (b.type === 'code_block') blocks.push({ t: 'code', info: b.info, text: b.literal.replace(/\n$/, '') });
    else blocks.push({ t: `UNEXPECTED:${b.type}` });
  }
  const marks = [];
  const walker = doc.walker();
  let e;
  while ((e = walker.next())) if (e.entering && (e.node.type === 'emph' || e.node.type === 'strong')) marks.push({ [e.node.type === 'emph' ? 'em' : 'strong']: cmText(e.node) });
  return { blocks, marks };
}

function pdText(inl) {
  return clean(inl.map((x) => {
    switch (x.t) {
      case 'Str': return x.c;
      case 'Space': case 'SoftBreak': case 'LineBreak': return ' ';
      case 'Code': return x.c[1];
      case 'Emph': case 'Strong': case 'Strikeout': return pdText(x.c);
      case 'Link': return pdText(x.c[1]);
      default: return `<<${x.t}>>`;
    }
  }).join(''));
}
const pdBlocksText = (blocks) => clean(blocks.map((b) => (b.t === 'Para' || b.t === 'Plain' ? pdText(b.c) : `<<${b.t}>>`)).join(' '));

export function pandocOutline(md, pandoc = 'pandoc') {
  const r = spawnSync(pandoc, ['-f', 'gfm', '-t', 'json', '--preserve-tabs'], { input: md, encoding: 'utf8', maxBuffer: 1 << 27 });
  if (r.status !== 0) throw new Error(r.stderr);
  const doc = JSON.parse(r.stdout).blocks;
  const blocks = doc.map((b) => {
    switch (b.t) {
      case 'Header': return { t: 'heading', level: b.c[0], text: pdText(b.c[2]) };
      case 'Para': case 'Plain': return { t: 'paragraph', text: pdText(b.c) };
      case 'BulletList': return { t: 'list', ordered: false, items: b.c.map(pdBlocksText) };
      case 'OrderedList': return { t: 'list', ordered: true, items: b.c[1].map(pdBlocksText) };
      case 'CodeBlock': return { t: 'code', info: b.c[0][1][0] ?? '', text: b.c[1] };
      case 'Table': {
        const row = (r2) => r2[1].map((cell) => pdBlocksText(cell[4]));
        return { t: 'table', rows: [...b.c[3][1].map(row), ...b.c[4].flatMap((body) => body[3].map(row))] };
      }
      default: return { t: `UNEXPECTED:${b.t}` };
    }
  });
  const marks = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (x.t === 'Emph' || x.t === 'Strong') marks.push({ [x.t === 'Emph' ? 'em' : 'strong']: pdText(x.c) });
    Object.values(x).forEach(walk);
  };
  walk(doc);
  return { blocks, marks };
}

// ---- item 2: anchors ------------------------------------------------------------------
// Expected anchors from the source, in document order, with the heading each one names.
export function expectedAnchors(report, ctx, anchor) {
  const out = [];
  const add = (id, headingText) => out.push({ id, heading: clean(headingText) });
  const block = (b) => {
    switch (b.type) {
      case 'finding': add(anchor.finding(b), `Finding ${b.id}: ${b.title}`); (b.detail ?? []).forEach(block); break;
      case 'decision': add(anchor.decision(b), `Decision ${b.id}: ${b.question}`); break;
      case 'risk': add(anchor.risk(b), `Risk ${b.id}: ${b.title}`); break;
      case 'code': add(anchor.code(b), `Code: ${b.title}`); break;
      case 'diff': add(anchor.code(b), `Diff: ${b.title}`); break;
      case 'table': add(anchor.table(b), `Table: ${b.caption}`); break;
      case 'chart': add(anchor.chart(b), `Chart: ${b.title}`); break;
      case 'diagram': add(anchor.diagram(b), `Diagram: ${b.title}`); break;
      case 'comparison': add(anchor.comparison(b), `Comparison: ${b.title}`); break;
      case 'requirement': add(anchor.requirement(b), `Requirement ${b.id}: ${b.title}`); break;
      default: break;
    }
  };
  add(anchor.summary(), 'Executive summary');
  report.sections.forEach((s, i) => { add(anchor.section(s), `${i + 1}. ${s.title}`); s.blocks.forEach(block); });
  add(anchor.evidence(), 'Evidence');
  report.evidence.forEach((item) => add(anchor.evidenceItem(item.id), `${ctx.labels.get(item.id)}: ${item.title}`));
  (report.appendices ?? []).forEach((s, i) => { add(anchor.section(s, true), `Appendix ${String.fromCharCode(65 + i)}. ${s.title}`); s.blocks.forEach(block); });
  add(anchor.provenance(), 'Provenance and packet verification');
  return out;
}

const DEFINITION = /^\[([^\]\n]+)\]: #(\S+)$/;

// Every problem found, empty when the anchor contract holds.
export function anchorProblems(md, html, expected) {
  const problems = [];
  const lines = md.split('\n');
  const defs = [];
  lines.forEach((line, n) => {
    const m = line.match(DEFINITION);
    if (!m) return;
    const headingLine = lines[n - 2] ?? '';
    const parsedHeading = new commonmark.Parser().parse(headingLine).firstChild;
    defs.push({ label: m[1], dest: m[2], line: n + 1, heading: parsedHeading?.type === 'heading' ? cmText(parsedHeading) : null, headingOk: /^#{1,6} /.test(headingLine) && lines[n - 1] === '' });
  });
  const expectedIds = expected.map((e) => e.id);
  if (JSON.stringify(defs.map((d) => d.label)) !== JSON.stringify(expectedIds)) problems.push(`definition labels ${JSON.stringify(defs.map((d) => d.label))} differ from expected anchors ${JSON.stringify(expectedIds)}`);
  const folded = new Map();
  for (const d of defs) {
    if (d.dest !== d.label) problems.push(`line ${d.line}: definition [${d.label}] points to #${d.dest}, not #${d.label}`);
    if (!d.headingOk) problems.push(`line ${d.line}: definition [${d.label}] is not directly under a heading (heading line, blank line, definition)`);
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(d.label)) problems.push(`line ${d.line}: unsafe anchor label ${JSON.stringify(d.label)}`);
    const key = d.label.toLowerCase();
    if (folded.has(key)) problems.push(`anchor ${d.label} collides with ${folded.get(key)} under case folding`);
    folded.set(key, d.label);
    const exp = expected.find((e) => e.id === d.label);
    if (exp && exp.heading !== d.heading) problems.push(`anchor ${d.label} sits under "${d.heading}", expected "${exp.heading}"`);
  }
  // HTML: the same ids on the block elements (section, article, figure, div.table,
  // li.ev), and no other block-level ids.
  const htmlIds = [...html.matchAll(/<(section|article|figure|div|li)\b([^>]*)>/g)]
    .map(([, tag, attrs]) => ({ tag, id: attrs.match(/\bid="([^"]+)"/)?.[1], cls: attrs.match(/\bclass="([^"]+)"/)?.[1] ?? '' }))
    .filter((e) => e.id && (e.tag !== 'div' || e.cls === 'table') && (e.tag !== 'li' || /^ev ev--/.test(e.cls)))
    .map((e) => e.id);
  const missing = expectedIds.filter((id) => !htmlIds.includes(id));
  const extra = htmlIds.filter((id) => !expectedIds.includes(id));
  if (missing.length) problems.push(`HTML lacks block ids ${JSON.stringify(missing)}`);
  if (extra.length) problems.push(`HTML block ids without a report.md anchor ${JSON.stringify(extra)}`);
  // Definitions are invisible: removing them leaves both parse trees unchanged.
  const withoutDefs = lines.filter((l) => !DEFINITION.test(l)).join('\n');
  if (commonmarkTree(withoutDefs.replace(/\n{3,}/g, '\n\n')) !== commonmarkTree(md)) problems.push('anchor definitions change the CommonMark tree');
  // Each label resolves as a reference to its own anchor.
  const probe = `${md}\n\n${defs.map((d) => `[${d.label}]`).join(' ')}\n`;
  const doc = new commonmark.Parser().parse(probe);
  const dests = [];
  const w = doc.walker();
  let e;
  while ((e = w.next())) if (e.entering && e.node.type === 'link') dests.push(e.node.destination);
  for (const d of defs) if (!dests.includes(`#${d.label}`)) problems.push(`[${d.label}] does not resolve to #${d.label}`);
  return { problems, definitions: defs.map(({ label, line, heading }) => ({ id: label, line, heading })), htmlIds };
}

export function anchorPandocProblems(md, pandoc = 'pandoc') {
  const lines = md.split('\n');
  const withoutDefs = lines.filter((l) => !DEFINITION.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
  return pandocTree(withoutDefs, pandoc) === pandocTree(md, pandoc) ? [] : ['anchor definitions change the pandoc GFM tree'];
}

// ---- item 5: escapes -------------------------------------------------------------------
// Conservative classes: escapes kept where a parser COULD read syntax but this
// document's other content happens not to complete it. Each is listed with the
// predicate the gate checks; any unnecessary escape outside them fails.
export const CONSERVATIVE_CLASSES = {
  'backtick': 'an authored backtick run can pair with a delimiter of a generated code span anywhere in the paragraph (QA D-E3); every authored backtick stays escaped',
  'delimiter-with-partner': 'a "*", "_" or "~" run that can open or close stays escaped when another run of the same character exists in the same line; pairing across a whole container is not modelled',
  'math-dollar': 'a "$" that can open or close pandoc inline math stays escaped when another "$" is in the same line (pandoc 3.5 scans across links and code spans)',
  'scheme-colon': 'a ":" after a scheme-shaped word stays a reference: pandoc\'s bare-URI scheme list is long and version-dependent',
  'autolink-domain': '"@" in an email-shaped token and "." after "www" stay references where pandoc or GFM could autolink',
  'line-start-marker': 'a block marker at the start of paragraph or list-item content ("#", ">", "-", "+", "*", "=", "N." / "N)", "[", "~~~")',
  'bracket': 'a "[" or "]" inside a generated link label, next to a generated bracket, in an inline-link shape, or matching an anchor label',
  'segment-boundary': '"!", "(", ":", "[", "&" escaped where a generated segment edge would otherwise form an image, link or character reference (QA D-F1)',
  'whitespace-or-separator': 'leading whitespace references at line starts and the zero-width separator between generated delimiters',
  'backslash': 'a backslash before ASCII punctuation or at the end of a line',
};

function containerText(md, index, cellOnly) {
  const lines = md.split('\n');
  const n = md.slice(0, index).split('\n').length - 1;
  const line = lines[n];
  if (line.startsWith('| ')) {
    if (cellOnly) {
      const col = index - (md.lastIndexOf('\n', index) + 1);
      const cells = line.split(/(?<!\\)\|/);
      let pos = 0;
      for (const cell of cells) { if (col <= pos + cell.length) return cell; pos += cell.length + 1; }
      return line;
    }
    let a = n; let b = n;
    while (a > 0 && lines[a - 1].startsWith('| ')) a -= 1;
    while (b + 1 < lines.length && lines[b + 1].startsWith('| ')) b += 1;
    return lines.slice(a, b + 1).join('\n');
  }
  if (/^(?:#{1,6} |[-+] |\d{1,9}[.)] )/.test(line) || line === '') return line;
  let a = n; let b = n;
  const para = (l) => l !== undefined && l !== '' && !/^(?:#{1,6} |[-+] |\d{1,9}[.)] |\| |```)/.test(l);
  while (para(lines[a - 1])) a -= 1;
  while (para(lines[b + 1])) b += 1;
  return lines.slice(a, b + 1).join('\n');
}

function classify(md, esc) {
  const lineStart = md.lastIndexOf('\n', esc.index) + 1;
  const line = md.slice(lineStart, md.indexOf('\n', esc.index) === -1 ? md.length : md.indexOf('\n', esc.index));
  const col = esc.index - lineStart;
  const prefix = line.match(/^(?:#{1,6} |[-+] |\d{1,9}[.)] |\| )?/)[0];
  const atContentStart = col === prefix.length && !prefix.startsWith('#') && !prefix.startsWith('|');
  const c = esc.stands;
  if (esc.kind === 'separator' || (esc.kind === 'reference' && /^[ \t]$/.test(c))) return 'whitespace-or-separator';
  if (esc.kind === 'reference' && c === ':') return 'scheme-colon';
  if (esc.kind === 'reference' && (c === '@' || c === '.')) return 'autolink-domain';
  if (c === '`') return 'backtick';
  if (c === '\\') return 'backslash';
  if (atContentStart && /[#>\-+*=[~]/.test(c)) return 'line-start-marker';
  if ((c === '.' || c === ')') && /^\d{1,9}$/.test(line.slice(prefix.length, col))) return 'line-start-marker';
  if ('!(:&'.includes(c)) return 'segment-boundary';
  if (c === '[' || c === ']') return 'bracket';
  // Partners are counted in the inline container: a GFM table cell for "~" and "$",
  // the whole table (one CommonMark paragraph) for "*" and "_", else the paragraph.
  const scope = containerText(md, esc.index, c === '~' || c === '$');
  if (c === '$') return (scope.split('$').length - 1) >= 2 ? 'math-dollar' : null;
  if ('*_~'.includes(c)) return (scope.split(c).length - 1) >= 2 ? 'delimiter-with-partner' : null;
  if (c === '#' && /^#{1,6} /.test(line)) return 'line-start-marker'; // ATX closing sequence
  if (c === '|' && line.startsWith('| ')) return 'bracket';
  return null;
}

// Per-character oracle (the lead's rule: an escape belongs only where the character
// would otherwise be parsed as syntax). Start from the document with EVERY escape
// replaced by what it stands for; an escape is REQUIRED when restoring it alone
// changes the commonmark or pandoc tree.
export function escapeInventory(md, { pandoc = 'pandoc' } = {}) {
  const escapes = findEscapes(md);
  let unescaped = '';
  let cursor = 0;
  const at = [];
  for (const e of escapes) {
    unescaped += md.slice(cursor, e.index);
    at.push(unescaped.length);
    unescaped += e.stands;
    cursor = e.index + e.source.length;
  }
  unescaped += md.slice(cursor);
  const base = { cm: commonmarkTree(unescaped), gfm: pandoc ? pandocTree(unescaped, pandoc) : null };
  const items = escapes.map((e, i) => {
    const variant = unescaped.slice(0, at[i]) + e.source + unescaped.slice(at[i] + e.stands.length);
    const cm = commonmarkTree(variant) !== base.cm;
    const gfm = pandoc ? pandocTree(variant, pandoc) !== base.gfm : false;
    const lineNo = md.slice(0, e.index).split('\n').length;
    const line = md.split('\n')[lineNo - 1];
    const required = cm || gfm;
    const cls = required ? null : classify(md, e);
    return { line: lineNo, source: e.source, stands: e.stands === '' ? '(nothing)' : e.stands, kind: e.kind, required, requiredBy: required ? [cm && 'commonmark', gfm && 'pandoc-gfm'].filter(Boolean) : [], conservativeClass: cls, reason: required ? `restoring it alone changes the ${[cm && 'CommonMark', gfm && 'GFM'].filter(Boolean).join(' and ')} parse` : cls ? CONSERVATIVE_CLASSES[cls] : 'NO CONTEXT REQUIRES THIS ESCAPE', context: line.length > 160 ? `${line.slice(0, 157)}…` : line };
  });
  const chars = proseLength(md);
  return {
    escapes: items.length,
    backslash: items.filter((x) => x.kind === 'backslash').length,
    references: items.filter((x) => x.kind === 'reference').length,
    separators: items.filter((x) => x.kind === 'separator').length,
    proseChars: chars,
    per1000: Math.round((100000 * items.length) / chars) / 100,
    required: items.filter((x) => x.required).length,
    conservative: items.filter((x) => !x.required && x.conservativeClass).length,
    unjustified: items.filter((x) => !x.required && !x.conservativeClass),
    items,
  };
}

// Code-span neutralizations are not escapes but are listed for transparency.
export function codeSpanLiterals(md) {
  return [...md.matchAll(/`(<(?:sha256|content-id|name|id|packet-directory)>|&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);)`/gi)].map((m) => m[1]);
}

export { SEP };
