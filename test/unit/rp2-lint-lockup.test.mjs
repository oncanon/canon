// render-policy/2 compile-time lint (R7) and the lockup brand slot (lockup allowlist).
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BuildError, buildPacket } from '../../src/packet/build.mjs';
import { LOCKUP_FILES, LockupError, sanitizeLockupSvg } from '../../src/render/lockup.mjs';
import { formatWarning, lintReport } from '../../src/report/lint.mjs';
import { validateReport } from '../../src/report/validate.mjs';
import { FIXTURE, REPO, runCli, tempDir } from '../helpers.mjs';
import { buildInTree, treeWithMarks } from '../tree/shipped-tree.mjs';

const P2 = 'render-policy/2';

async function fixtureWith(t, mutate) {
  const dir = await tempDir(t, 'canon-rp2-lint');
  await cp(join(REPO, 'fixtures/report'), dir, { recursive: true });
  const r = JSON.parse(await readFile(FIXTURE, 'utf8'));
  mutate(r);
  const path = join(dir, 'phase1-review.report.json');
  await writeFile(path, `${JSON.stringify(r, null, 2)}\n`);
  return { dir, path };
}

const fixtureReport = async () => validateReport(JSON.parse(await readFile(FIXTURE, 'utf8')));

test('[R7-LINT] reserved prefixes F, D, R, E and b- in authored prose warn with prefix, count and first occurrences', async () => {
  const r = await fixtureReport();
  r.summary.paragraphs.push(['Engine change E1 lands before F2, D3 and R4; see b-05 too, and E12.', { cite: r.evidence[0].id }]);
  const warnings = lintReport(r);
  assert.deepEqual(warnings.map((w) => w.prefix), ['F', 'D', 'R', 'E', 'b-']);
  const e = warnings.find((w) => w.prefix === 'E');
  assert.equal(e.code, 'reserved-prefix');
  assert.equal(e.reservedFor, 'evidence');
  assert.equal(e.count, 2);
  assert.deepEqual(e.occurrences.map((o) => o.token), ['E1', 'E12']);
  assert.equal(e.occurrences[0].path, `/summary/paragraphs/${r.summary.paragraphs.length - 1}/0`);
  assert.match(formatWarning(e), /^warning: reserved-prefix E: .*E1 \(\/summary\/paragraphs\/\d+\/0\).*Canon reserves E for evidence; authored IDs are not renamed\.$/);
});

test('[R7-LINT] cites, identifiers inside words and code sources are not prose collisions', async () => {
  const r = await fixtureReport();
  r.summary.paragraphs.push(['A1b, AE1, E1x, x_F2, sha256 and lowercase e1 or f2 are not collisions; nor is a cite ', { cite: r.evidence[0].id }]);
  assert.deepEqual(lintReport(r), []);
  const clean = await fixtureReport();
  assert.deepEqual(lintReport(clean), [], 'the golden fixture uses no reserved prefix');
});

test('[R7-LINT] warnings never fail the build, reach stderr, and are listed in the build receipt', async (t) => {
  const { dir, path } = await fixtureWith(t, (r) => { r.summary.paragraphs.push('Changes E1 to E7 and F1.'); });
  for (const policy of ['1', '2']) {
    const out = join(dir, `pkt${policy}`);
    const res = runCli(['build', path, '--out', out, '--receipt', `${out}.json`, '--render-policy', policy]);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stderr.trim().split('\n');
    assert.equal(lines.length, 2, res.stderr);
    assert.match(lines[0], /^warning: reserved-prefix F: /);
    assert.match(lines[1], /^warning: reserved-prefix E: .* 2 times: E1 \(.*\), E7 \(.*\)\./);
    const receipt = JSON.parse(await readFile(`${out}.json`, 'utf8'));
    assert.deepEqual(receipt.warnings.map((w) => [w.prefix, w.count]), [['F', 1], ['E', 2]]);
  }
  const clean = runCli(['build', FIXTURE, '--out', join(dir, 'clean'), '--receipt', join(dir, 'clean.json')]);
  assert.equal(clean.stderr, '');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'clean.json'), 'utf8')).warnings, []);
});


const GOOD = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24" width="120" height="24"><g fill="currentColor"><rect x="0" y="0" width="10" height="24" rx="2"/><path d="M14 2 L30 2 L30 22 Z" fill-rule="evenodd"/><text x="40" y="18" font-size="16">c &amp; n</text></g></svg>\n';

test('[G-LOCKUP] a valid outlined lockup is re-serialised from its parse: aria-hidden, no namespace URL, allowlisted markup only', () => {
  const out = sanitizeLockupSvg(GOOD, 'ui');
  assert.equal(out, '<svg class="lockup lockup--ui" aria-hidden="true" focusable="false" viewBox="0 0 120 24" width="120" height="24"><g fill="currentColor"><rect x="0" y="0" width="10" height="24" rx="2"></rect><path d="M14 2 L30 2 L30 22 Z" fill-rule="evenodd"></path><text x="40" y="18" font-size="16">c &amp; n</text></g></svg>');
});

test('[G-LOCKUP] anything outside the allowlist fails', () => {
  const bad = [
    ['style attribute', '<svg viewBox="0 0 1 1"><rect style="fill:red" width="1" height="1"/></svg>'],
    ['script element', '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'],
    ['event handler', '<svg viewBox="0 0 1 1" onload="alert(1)"><rect width="1" height="1"/></svg>'],
    ['href', '<svg viewBox="0 0 1 1"><a href="https://example.com"><rect width="1" height="1"/></a></svg>'],
    ['use element', '<svg viewBox="0 0 1 1"><use x="0"/></svg>'],
    ['id attribute', '<svg viewBox="0 0 1 1"><rect id="x" width="1" height="1"/></svg>'],
    ['class attribute', '<svg viewBox="0 0 1 1"><rect class="x" width="1" height="1"/></svg>'],
    ['url() paint', '<svg viewBox="0 0 1 1"><rect fill="url(#g)" width="1" height="1"/></svg>'],
    ['comment', '<svg viewBox="0 0 1 1"><!-- x --><rect width="1" height="1"/></svg>'],
    ['doctype', '<!DOCTYPE svg><svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'],
    ['entity', '<svg viewBox="0 0 1 1"><text>&xxe;</text></svg>'],
    ['foreign namespace', '<svg xmlns="http://example.com/ns" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'],
    ['xlink attribute', '<svg viewBox="0 0 1 1"><rect xlink:href="#a" width="1" height="1"/></svg>'],
    ['text outside text', '<svg viewBox="0 0 1 1">hello<rect width="1" height="1"/></svg>'],
    ['two roots', '<svg viewBox="0 0 1 1"></svg><svg viewBox="0 0 1 1"></svg>'],
    ['nested svg', '<svg viewBox="0 0 1 1"><svg viewBox="0 0 1 1"></svg></svg>'],
    ['unclosed', '<svg viewBox="0 0 1 1"><g>'],
    ['javascript in value', '<svg viewBox="0 0 1 1"><rect fill="javascript:alert(1)" width="1" height="1"/></svg>'],
  ];
  for (const [label, text] of bad) {
    assert.throws(() => sanitizeLockupSvg(text, 'ui'), LockupError, label);
  }
});

test('[G-LOCKUP] with no lockup files the brand slots carry only the visually hidden text "Canon"; with files they carry the sanitized SVG; a bad file fails the build', async (t) => {
  const dir = await tempDir(t, 'canon-rp2-marks');
  const empty = join(dir, 'empty');
  await mkdir(empty);
  const none = (await buildPacket({ reportPath: FIXTURE, renderPolicy: P2, marksDir: empty })).output.get('index.html').toString('utf8');
  assert.ok(none.includes('<span class="masthead__brand"><span class="visually-hidden">Canon</span></span>'));
  assert.ok(none.includes('<p class="colophon__mark"><span class="visually-hidden">Canon</span></p>'));
  assert.ok(!/class="lockup/.test(none));
  // The shipped tree has no lockups yet: the default build is the same.
  const dflt = (await buildPacket({ reportPath: FIXTURE, renderPolicy: P2 })).output.get('index.html').toString('utf8');
  assert.equal(dflt, none);

  const good = join(dir, 'good');
  await mkdir(good);
  await writeFile(join(good, LOCKUP_FILES.ui), GOOD);
  await writeFile(join(good, LOCKUP_FILES.display), GOOD);
  // R11: a policy/2 build seals only the shipped renderer inputs, so marks from another
  // directory are refused; a tree that ships them renders them, and its packet verifies.
  await assert.rejects(buildPacket({ reportPath: FIXTURE, renderPolicy: P2, marksDir: good }), (err) => err instanceof BuildError && err.code === 'render-inputs');
  const tree = await treeWithMarks(t, { [LOCKUP_FILES.ui]: GOOD, [LOCKUP_FILES.display]: GOOD });
  const built = buildInTree(tree, { reportPath: FIXTURE, outDir: join(dir, 'shipped') });
  assert.equal(built.full?.ok, true, JSON.stringify(built));
  const withMarks = await readFile(join(dir, 'shipped', 'index.html'), 'utf8');
  assert.match(withMarks, /<span class="masthead__brand"><svg class="lockup lockup--ui" aria-hidden="true" focusable="false"[\s\S]*?<\/svg><span class="visually-hidden">Canon<\/span><\/span>/);
  assert.match(withMarks, /<p class="colophon__mark colophon__mark--ruled"><svg class="lockup lockup--display" aria-hidden="true"/);
  assert.ok(!withMarks.includes('http://www.w3.org/2000/svg'));

  const bad = join(dir, 'bad');
  await mkdir(bad);
  await writeFile(join(bad, LOCKUP_FILES.display), '<svg viewBox="0 0 1 1" style="x"></svg>');
  await assert.rejects(buildPacket({ reportPath: FIXTURE, renderPolicy: P2, marksDir: bad }), (err) => err instanceof BuildError && err.code === 'unsafe-lockup');
  // Policy/1 never reads lockups.
  await buildPacket({ reportPath: FIXTURE, marksDir: bad });
});
