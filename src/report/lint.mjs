// Compile-time lint for report/v1 sources (render-policy/2 R7). Lint never fails a
// build and never changes packet bytes: it returns structured warnings that the CLI
// prints to stderr and records in the build receipt.
//
// Reserved display prefixes: the renderer numbers findings F1.., decisions D1..,
// risks R1.., evidence E1.. and blocks b-01... Authored prose that uses
// <prefix><digits> as its own identifier reads as a collision with those indexes.
// Every authored prose string is scanned; {cite} segments, ids, enums, code and
// patch sources, link targets, paths and digests are not prose and are skipped.
// Authored IDs are never renamed.

export const RESERVED_PREFIXES = Object.freeze([
  { prefix: 'F', reservedFor: 'findings', re: /(?<![A-Za-z0-9_])F(\d+)(?![A-Za-z0-9_])/g },
  { prefix: 'D', reservedFor: 'decisions', re: /(?<![A-Za-z0-9_])D(\d+)(?![A-Za-z0-9_])/g },
  { prefix: 'R', reservedFor: 'risks', re: /(?<![A-Za-z0-9_])R(\d+)(?![A-Za-z0-9_])/g },
  { prefix: 'E', reservedFor: 'evidence', re: /(?<![A-Za-z0-9_])E(\d+)(?![A-Za-z0-9_])/g },
  { prefix: 'b-', reservedFor: 'blocks', re: /(?<![A-Za-z0-9_-])b-(\d+)(?![A-Za-z0-9_])/g },
]);

const MAX_LISTED = 5;

// Yields [jsonPointer, text] for every authored prose string in a validated report.
function* proseStrings(report) {
  function* inline(value, path) {
    if (typeof value === 'string') {
      yield [path, value];
      return;
    }
    for (let i = 0; i < value.length; i += 1) {
      const seg = value[i];
      const p = `${path}/${i}`;
      if (typeof seg === 'string') yield [p, seg];
      else if (Object.hasOwn(seg, 'text')) yield [`${p}/text`, seg.text];
      else if (Object.hasOwn(seg, 'code')) yield [`${p}/code`, seg.code];
      else if (Object.hasOwn(seg, 'em')) yield [`${p}/em`, seg.em];
      else if (Object.hasOwn(seg, 'strong')) yield [`${p}/strong`, seg.strong];
      else if (Object.hasOwn(seg, 'link')) yield [`${p}/link/text`, seg.link.text];
      // cite segments are references to evidence, not prose: excluded.
    }
  }
  function* opt(obj, key, path) {
    if (obj && Object.hasOwn(obj, key) && typeof obj[key] === 'string') yield [`${path}/${key}`, obj[key]];
  }
  function* block(b, path) {
    switch (b.type) {
      case 'paragraph': yield* inline(b.text, `${path}/text`); break;
      case 'list': for (let i = 0; i < b.items.length; i += 1) yield* inline(b.items[i], `${path}/items/${i}`); break;
      case 'finding':
        yield [`${path}/title`, b.title];
        yield* inline(b.claim, `${path}/claim`);
        if (b.verification) yield* opt(b.verification, 'detail', `${path}/verification`);
        for (let i = 0; i < (b.detail ?? []).length; i += 1) yield* block(b.detail[i], `${path}/detail/${i}`);
        break;
      case 'decision':
        yield [`${path}/question`, b.question];
        yield* opt(b, 'owner', path);
        if (b.context) yield* inline(b.context, `${path}/context`);
        yield* inline(b.recommendation, `${path}/recommendation`);
        for (let i = 0; i < b.alternatives.length; i += 1) {
          yield [`${path}/alternatives/${i}/label`, b.alternatives[i].label];
          yield* inline(b.alternatives[i].summary, `${path}/alternatives/${i}/summary`);
        }
        for (let i = 0; i < (b.consequences ?? []).length; i += 1) yield* inline(b.consequences[i], `${path}/consequences/${i}`);
        break;
      case 'risk':
        yield [`${path}/title`, b.title];
        yield* inline(b.mitigation, `${path}/mitigation`);
        break;
      case 'requirement':
        yield [`${path}/title`, b.title];
        yield* inline(b.statement, `${path}/statement`);
        yield* opt(b.verification, 'detail', `${path}/verification`);
        for (let i = 0; i < (b.scenarios ?? []).length; i += 1) {
          for (const k of ['name', 'given', 'when', 'then']) yield [`${path}/scenarios/${i}/${k}`, b.scenarios[i][k]];
        }
        break;
      case 'code': case 'diff':
        yield [`${path}/title`, b.title];
        if (b.caption) yield* inline(b.caption, `${path}/caption`);
        break;
      case 'table':
        yield [`${path}/caption`, b.caption];
        for (let i = 0; i < b.columns.length; i += 1) yield [`${path}/columns/${i}/label`, b.columns[i].label];
        for (let r = 0; r < b.rows.length; r += 1) {
          for (const c of b.columns) yield* inline(b.rows[r][c.key], `${path}/rows/${r}/${c.key}`);
        }
        break;
      case 'chart':
        yield [`${path}/title`, b.title];
        yield* inline(b.caption, `${path}/caption`);
        yield [`${path}/unit`, b.unit];
        yield* opt(b, 'baselineLabel', path);
        yield* opt(b, 'candidateLabel', path);
        for (let i = 0; i < b.series.length; i += 1) yield [`${path}/series/${i}/label`, b.series[i].label];
        break;
      case 'diagram':
        yield [`${path}/title`, b.title];
        yield* inline(b.caption, `${path}/caption`);
        for (let i = 0; i < (b.steps ?? []).length; i += 1) {
          yield [`${path}/steps/${i}/label`, b.steps[i].label];
          yield [`${path}/steps/${i}/detail`, b.steps[i].detail];
        }
        for (let g = 0; g < (b.groups ?? []).length; g += 1) {
          yield [`${path}/groups/${g}/label`, b.groups[g].label];
          for (let n = 0; n < b.groups[g].nodes.length; n += 1) {
            yield [`${path}/groups/${g}/nodes/${n}/label`, b.groups[g].nodes[n].label];
            yield* opt(b.groups[g].nodes[n], 'sublabel', `${path}/groups/${g}/nodes/${n}`);
          }
        }
        for (let i = 0; i < (b.edges ?? []).length; i += 1) yield* opt(b.edges[i], 'label', `${path}/edges/${i}`);
        for (let i = 0; i < (b.actors ?? []).length; i += 1) yield [`${path}/actors/${i}/label`, b.actors[i].label];
        for (let i = 0; i < (b.messages ?? []).length; i += 1) {
          yield [`${path}/messages/${i}/label`, b.messages[i].label];
          yield* opt(b.messages[i], 'note', `${path}/messages/${i}`);
        }
        break;
      case 'comparison':
        yield [`${path}/title`, b.title];
        if (b.caption) yield* inline(b.caption, `${path}/caption`);
        for (const side of ['left', 'right']) {
          yield [`${path}/${side}/label`, b[side].label];
          yield* inline(b[side].summary, `${path}/${side}/summary`);
          for (let i = 0; i < (b[side].items ?? []).length; i += 1) yield* inline(b[side].items[i], `${path}/${side}/items/${i}`);
        }
        break;
      case 'metrics':
        for (let i = 0; i < b.items.length; i += 1) {
          for (const k of ['label', 'value', 'unit']) yield* opt(b.items[i], k, `${path}/items/${i}`);
        }
        break;
      default: break;
    }
  }

  yield ['/title', report.title];
  yield* opt(report, 'subtitle', '');
  const meta = report.metadata;
  yield ['/metadata/classification', meta.classification];
  yield ['/metadata/reviewRequest', meta.reviewRequest];
  for (let i = 0; i < meta.authors.length; i += 1) yield [`/metadata/authors/${i}`, meta.authors[i]];
  yield* inline(report.summary.verdict.text, '/summary/verdict/text');
  for (let i = 0; i < report.summary.paragraphs.length; i += 1) yield* inline(report.summary.paragraphs[i], `/summary/paragraphs/${i}`);
  if (report.summary.metrics) yield* block({ type: 'metrics', ...report.summary.metrics }, '/summary/metrics');
  for (const [key, list] of [['sections', report.sections], ['appendices', report.appendices ?? []]]) {
    for (let s = 0; s < list.length; s += 1) {
      yield [`/${key}/${s}/title`, list[s].title];
      yield* opt(list[s], 'lede', `/${key}/${s}`);
      for (let b = 0; b < list[s].blocks.length; b += 1) yield* block(list[s].blocks[b], `/${key}/${s}/blocks/${b}`);
    }
  }
  for (let i = 0; i < report.evidence.length; i += 1) {
    yield [`/evidence/${i}/title`, report.evidence[i].title];
    yield* opt(report.evidence[i], 'reason', `/evidence/${i}`);
  }
  for (let i = 0; i < report.provenance.sources.length; i += 1) {
    yield [`/provenance/sources/${i}/label`, report.provenance.sources[i].label];
    yield [`/provenance/sources/${i}/reference`, report.provenance.sources[i].reference];
  }
  if (report.provenance.notes) yield* inline(report.provenance.notes, '/provenance/notes');
}

// Returns one warning per reserved prefix that authored prose collides with, in the
// order of RESERVED_PREFIXES. Each lists the total count and the first few occurrences
// (token and JSON pointer), all derived from the report itself.
export function lintReport(report) {
  const found = new Map(RESERVED_PREFIXES.map((r) => [r.prefix, []]));
  for (const [path, text] of proseStrings(report)) {
    for (const r of RESERVED_PREFIXES) {
      for (const m of text.matchAll(r.re)) found.get(r.prefix).push({ token: m[0], path });
    }
  }
  const warnings = [];
  for (const r of RESERVED_PREFIXES) {
    const hits = found.get(r.prefix);
    if (!hits.length) continue;
    warnings.push({
      code: 'reserved-prefix',
      prefix: r.prefix,
      reservedFor: r.reservedFor,
      count: hits.length,
      occurrences: hits.slice(0, MAX_LISTED),
    });
  }
  return warnings;
}

export function formatWarning(w) {
  if (w.code !== 'reserved-prefix') return `warning: ${w.code}`;
  const listed = w.occurrences.map((o) => `${o.token} (${o.path})`).join(', ');
  const more = w.count > w.occurrences.length ? ` and ${w.count - w.occurrences.length} more` : '';
  return `warning: reserved-prefix ${w.prefix}: authored prose uses ${w.prefix}<digits> as its own identifier ${w.count} time${w.count === 1 ? '' : 's'}: ${listed}${more}. Canon reserves ${w.prefix} for ${w.reservedFor}; authored IDs are not renamed.`;
}
