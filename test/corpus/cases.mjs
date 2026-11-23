// Malicious-content corpus (P8). Each case either must be rejected with a named
// error code, or must build into a packet that verifies and renders the hostile
// string as inert, escaped text. Cases that need filesystem objects (symlinks,
// FIFOs, oversize files) create them in the case's own temporary source tree.
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const MiB = 1024 * 1024;

export const XSS_STRINGS = [
  '<script>window.__xss=1</script>',
  '"><svg onload="window.__xss=1">',
  "'><img src=x onerror=window.__xss=1>",
  '</code></pre><script>window.__xss=1</script>',
  '<a href="javascript:window.__xss=1">click</a>',
  '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
  '<style>body{display:none}</style>',
  '<!-- --><script>window.__xss=1</script>',
  '{{constructor.constructor("window.__xss=1")()}}',
  '${globalThis.process?.exit?.(9)}',
  '<math><mi xlink:href="javascript:window.__xss=1">x</mi></math>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
];

const evidenceFile = (id, path, mediaType = 'text/plain') => ({ id, title: `Evidence ${id}`, kind: 'file', path, mediaType });

// report: mutate(report, srcDir) -> void (may create files); expect: { reject: code } | { render: [strings that must appear escaped] }
export const CASES = [
  // --- escaped XSS / inline handlers: safe rendering ---
  {
    name: 'xss strings in every text field render escaped',
    category: 'escaped-xss',
    mutate(r) {
      r.title = XSS_STRINGS[0];
      r.subtitle = XSS_STRINGS[1];
      r.metadata.classification = XSS_STRINGS[2];
      r.summary.paragraphs = XSS_STRINGS.map((s) => [{ text: s }, { code: s }, { em: s }, { strong: s }]);
      const findings = r.sections[0].blocks;
      findings[0].title = XSS_STRINGS[3];
      findings[0].claim = XSS_STRINGS[4];
      r.sections[1].blocks.find((b) => b.type === 'table').rows[0].role = XSS_STRINGS[5];
      r.sections[1].blocks.find((b) => b.type === 'code').source = XSS_STRINGS.join('\n');
      r.sections[1].blocks.find((b) => b.type === 'diff').patch = XSS_STRINGS.map((s) => `+${s}`).join('\n');
      r.sections[2].blocks.find((b) => b.type === 'chart').series[0].label = XSS_STRINGS[6];
      r.sections[1].blocks.find((b) => b.type === 'diagram').steps[0].detail = XSS_STRINGS[7];
      r.evidence[0].title = XSS_STRINGS[8];
      r.provenance.sources[0].label = XSS_STRINGS[9];
      r.sections[0].lede = XSS_STRINGS[10];
      r.metadata.authors = [XSS_STRINGS[11]];
    },
    expect: { render: XSS_STRINGS },
  },
  {
    name: 'attribute breakout via evidence id or alias-like fields is impossible (ids are pattern-checked)',
    category: 'inline-handler',
    mutate(r) { r.sections[0].blocks[0].id = 'F-1" onmouseover="alert(1)'; },
    expect: { reject: 'pattern' },
  },
  {
    name: 'link href attribute breakout is rejected',
    category: 'inline-handler',
    mutate(r) { r.summary.paragraphs[0] = [{ link: { href: 'https://example.com/" onmouseover="alert(1)', text: 'x' } }]; },
    expect: { reject: 'unsafe-url' },
  },
  // --- unsafe URLs ---
  ...[
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>', 'data:image/svg+xml,<svg onload=alert(1)>', 'http://example.com/',
    'https://user:pass@example.com/', '//evil.example/x', 'file:///etc/passwd', 'blob:https://example.com/x',
  ].map((href) => ({
    name: `unsafe link ${JSON.stringify(href)} is rejected`,
    category: 'unsafe-url',
    mutate(r) { r.summary.paragraphs[0] = [{ link: { href, text: 'x' } }]; },
    expect: { reject: href.includes('\t') ? 'forbidden-character' : 'unsafe-url' },
  })),
  // --- scriptable SVG ---
  {
    name: 'SVG evidence media type is rejected',
    category: 'scriptable-svg',
    async mutate(r, src) {
      await writeFile(join(src, 'evidence/diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
      r.evidence.push(evidenceFile('ev-svg', 'evidence/diagram.svg', 'image/svg+xml'));
    },
    expect: { reject: 'unsupported-media' },
  },
  {
    name: 'inline SVG block is an escape hatch',
    category: 'scriptable-svg',
    mutate(r) { r.sections[0].blocks.push({ type: 'svg', svg: '<svg onload=alert(1)/>' }); },
    expect: { reject: 'escape-hatch' },
  },
  {
    name: 'SVG bytes declared as text/plain are stored as .txt and never interpreted',
    category: 'scriptable-svg',
    async mutate(r, src) {
      await writeFile(join(src, 'evidence/sneaky.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=1"/>');
      r.evidence.push(evidenceFile('ev-sneaky', 'evidence/sneaky.svg', 'text/plain'));
      r.sections[0].blocks[0].evidence.push('ev-sneaky');
    },
    expect: { render: [], evidenceExtension: 'txt' },
  },
  // --- traversal / absolute / symlink / device ---
  ...['../outside.txt', 'evidence/../../outside.txt', '/etc/passwd', 'C:/Windows/win.ini', 'evidence\\x.txt', './evidence/build-determinism.txt', 'evidence//x.txt'].map((path) => ({
    name: `unsafe evidence path ${JSON.stringify(path)} is rejected`,
    category: 'path-traversal',
    mutate(r) { r.evidence[0].path = path; },
    expect: { reject: 'unsafe-path' },
  })),
  {
    name: 'symlinked evidence file is rejected',
    category: 'symlink',
    async mutate(r, src) {
      await symlink('/etc/hosts', join(src, 'evidence/hosts.txt'));
      r.evidence[0].path = 'evidence/hosts.txt';
    },
    expect: { reject: 'unsafe-evidence' },
  },
  {
    name: 'symlinked evidence directory is rejected',
    category: 'symlink',
    async mutate(r, src) {
      await mkdir(join(src, 'outside'));
      await writeFile(join(src, 'outside/secret.txt'), 'secret');
      await symlink(join(src, 'outside'), join(src, 'evidence/linkdir'));
      r.evidence[0].path = 'evidence/linkdir/secret.txt';
    },
    expect: { reject: 'unsafe-evidence' },
  },
  {
    name: 'symlink to a device file is rejected',
    category: 'device-file',
    async mutate(r, src) {
      await symlink('/dev/zero', join(src, 'evidence/zero.txt'));
      r.evidence[0].path = 'evidence/zero.txt';
    },
    expect: { reject: 'unsafe-evidence' },
  },
  {
    name: 'FIFO (special file) evidence is rejected without blocking',
    category: 'device-file',
    async mutate(r, src) {
      const made = spawnSync('mkfifo', [join(src, 'evidence/pipe.txt')]);
      if (made.status !== 0) throw new Error('mkfifo unavailable');
      r.evidence[0].path = 'evidence/pipe.txt';
    },
    expect: { reject: 'unsafe-evidence' },
  },
  {
    name: 'directory named as evidence is rejected',
    category: 'device-file',
    mutate(r) { r.evidence[0].path = 'evidence/runs'; },
    expect: { reject: 'unsafe-evidence' },
  },
  // --- Unicode / case collisions ---
  {
    name: 'NFC/NFD evidence path collision is rejected',
    category: 'unicode-collision',
    mutate(r) {
      r.evidence.push(evidenceFile('ev-nfc', 'evidence/caf\u00e9.txt'), evidenceFile('ev-nfd', 'evidence/cafe\u0301.txt'));
    },
    expect: { reject: 'path-collision' },
  },
  {
    name: 'case-folding evidence path collision is rejected',
    category: 'unicode-collision',
    mutate(r) { r.evidence.push(evidenceFile('ev-case', 'Evidence/Build-Determinism.txt')); },
    expect: { reject: 'path-collision' },
  },
  {
    name: 'fullwidth/compatibility-form path collision is rejected',
    category: 'unicode-collision',
    mutate(r) { r.evidence.push(evidenceFile('ev-wide', 'evidence/latency.csv'), evidenceFile('ev-wide2', 'evidence/ｌatency.csv')); },
    expect: { reject: 'path-collision' },
  },
  {
    name: 'bidi override (Trojan Source) in code is rejected',
    category: 'unicode-collision',
    mutate(r) { r.sections[1].blocks.find((b) => b.type === 'code').source = 'const isAdmin = false; /*\u202E } if (isAdmin) \u2066*/'; },
    expect: { reject: 'forbidden-character' },
  },
  {
    name: 'duplicate ids are rejected',
    category: 'unicode-collision',
    mutate(r) { r.sections[0].blocks[1].id = r.sections[0].blocks[0].id; },
    expect: { reject: 'duplicate-id' },
  },
  // --- oversize / count / depth / work limits ---
  {
    name: 'report larger than 1 MiB is rejected before parsing',
    category: 'limits',
    rawText: () => `{"schema":"report/v1","pad":"${'x'.repeat(MiB + 10)}"}`,
    expect: { reject: 'limit' },
  },
  {
    name: 'JSON nested deeper than 16 is rejected before parsing',
    category: 'limits',
    rawText: () => `${'['.repeat(5000)}${']'.repeat(5000)}`,
    expect: { reject: 'limit' },
  },
  {
    name: 'more than 32 evidence entries is rejected',
    category: 'limits',
    mutate(r) { for (let i = 0; i < 33; i += 1) r.evidence.push({ id: `ev-x${i}`, title: 'x', kind: 'unavailable', reason: 'x' }); },
    expect: { reject: 'limit' },
  },
  {
    name: 'evidence file larger than 4 MiB is rejected',
    category: 'limits',
    async mutate(r, src) {
      await writeFile(join(src, 'evidence/big.txt'), Buffer.alloc(4 * MiB + 1, 0x61));
      r.evidence[0].path = 'evidence/big.txt';
    },
    expect: { reject: 'limit' },
  },
  {
    name: 'aggregate evidence over 16 MiB is rejected',
    category: 'limits',
    async mutate(r, src) {
      for (let i = 0; i < 5; i += 1) {
        await writeFile(join(src, `evidence/agg${i}.txt`), Buffer.alloc(Math.floor(3.5 * MiB), 0x61 + i));
        r.evidence.push(evidenceFile(`ev-agg${i}`, `evidence/agg${i}.txt`));
      }
    },
    expect: { reject: 'limit' },
  },
  {
    name: 'code block over 4000 lines is rejected',
    category: 'limits',
    mutate(r) { r.sections[1].blocks.find((b) => b.type === 'code').source = 'x\n'.repeat(4001); },
    expect: { reject: 'limit' },
  },
  {
    name: 'code line over 2000 characters is rejected',
    category: 'limits',
    mutate(r) { r.sections[1].blocks.find((b) => b.type === 'code').source = 'y'.repeat(2001); },
    expect: { reject: 'limit' },
  },
  {
    name: 'table over 400 rows is rejected',
    category: 'limits',
    mutate(r) {
      const t = r.sections[1].blocks.find((b) => b.type === 'table');
      t.rows = Array.from({ length: 401 }, () => ({ ...t.rows[0] }));
    },
    expect: { reject: 'limit' },
  },
  {
    name: 'pathological highlighter input renders in bounded time',
    category: 'work-limit',
    mutate(r) {
      const code = r.sections[1].blocks.find((b) => b.type === 'code');
      // Unterminated comment/strings and long quote runs: linear lexing must stay fast.
      code.source = Array.from({ length: 90 }, (_, i) => (i % 3 === 0 ? `/*${'*'.repeat(1900)}` : i % 3 === 1 ? `'${"\\'".repeat(950)}` : `\`${'${'.repeat(900)}`)).join('\n');
      delete code.highlight;
    },
    expect: { render: [], maxMs: 2000 },
  },
  // --- report-provided code execution attempts ---
  {
    name: 'code and template payloads are never executed at build time',
    category: 'code-execution',
    mutate(r, src) {
      const marker = join(src, 'PWNED');
      const code = r.sections[1].blocks.find((b) => b.type === 'code');
      code.source = [
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
        `import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(marker)}, 'x'))`,
        `\${require('child_process').execSync('touch ${marker}')}`,
        `{{ range.constructor("return process")().mainModule.require('fs').writeFileSync('${marker}','x') }}`,
      ].join('\n');
      delete code.highlight;
      r.summary.paragraphs[0] = `\${process.exit(3)} {{7*7}} <%= system('touch ${marker}') %>`;
    },
    expect: { render: [], markerAbsent: 'PWNED' },
  },
  {
    name: '__proto__ member is rejected and does not pollute prototypes',
    category: 'code-execution',
    rawText: (base) => base.replace('{\n  "schema"', '{\n  "__proto__": { "polluted": true },\n  "schema"'),
    expect: { reject: 'unknown-member', notPolluted: true },
  },
  {
    name: 'invalid UTF-8 evidence is rejected',
    category: 'code-execution',
    async mutate(r, src) {
      await writeFile(join(src, 'evidence/bad.txt'), Buffer.from([0x68, 0x69, 0xff, 0xfe]));
      r.evidence[0].path = 'evidence/bad.txt';
    },
    expect: { reject: 'unsafe-evidence' },
  },
  {
    name: 'JSON evidence nested too deeply is rejected',
    category: 'limits',
    async mutate(r, src) {
      await writeFile(join(src, 'evidence/deep.json'), `${'['.repeat(100)}${']'.repeat(100)}`);
      r.evidence[1].path = 'evidence/deep.json';
    },
    expect: { reject: 'unsafe-evidence' },
  },
];
