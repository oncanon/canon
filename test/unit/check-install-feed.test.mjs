// web/scripts/check-install-feed.mjs: the appcast well-formedness check.
// Each broken copy below is one that xmllint rejects; the checker must reject
// it too (exit 1). The fixture test/fixtures/appcast/two-items.xml is the
// output of scripts/release/appcast.mjs (branch ci-release) run twice on
// web/public/appcast.xml, so the checker must accept it (exit 0).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CASK, FORMULA, checkAppcast } from '../../web/scripts/check-install-feed.mjs';
import { tempDir } from '../helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(ROOT, 'web/scripts/check-install-feed.mjs');
const GOOD = readFileSync(join(ROOT, 'test/fixtures/appcast/two-items.xml'), 'utf8');

const HEADERS = '/appcast.xml\n  Content-Type: application/rss+xml; charset=utf-8\n  Cache-Control: public, max-age=300\n';
const INSTALL = `<html><body><main><pre>${CASK}</pre><pre>${FORMULA}</pre><pre>git clone https://github.com/oncanon/canon</pre></main></body></html>`;

/** Runs the checker's command line on a dist folder holding this appcast. */
async function runChecker(t, xml) {
  const dist = await tempDir(t, 'check-install-feed');
  mkdirSync(join(dist, 'guide/install'), { recursive: true });
  writeFileSync(join(dist, 'appcast.xml'), xml);
  writeFileSync(join(dist, '_headers'), HEADERS);
  writeFileSync(join(dist, 'guide/install/index.html'), INSTALL);
  return spawnSync(process.execPath, [CHECKER, '--dist', dist], { encoding: 'utf8' });
}

function replaceOnce(src, from, to) {
  assert.equal(src.split(from).length, 2, `fixture must contain ${JSON.stringify(from)} exactly once`);
  return src.replace(from, to);
}

const BROKEN = [
  ['"]]>" in text', replaceOnce(GOOD, 'Canon.app updates.', 'Canon.app ]]> updates.'), /"\]\]>" in text/],
  ['character reference &#0;', replaceOnce(GOOD, '<title>Canon 0.2.0</title>', '<title>Canon 0.2.0&#0;</title>'), /character reference/],
  ['character reference &#x1;', replaceOnce(GOOD, '<title>Canon 0.2.0</title>', '<title>Canon&#x1;</title>'), /character reference/],
  ['character reference &#xD800; (surrogate)', replaceOnce(GOOD, '<title>Canon 0.2.0</title>', '<title>&#xD800;</title>'), /character reference/],
  ['character reference &#xFFFE;', replaceOnce(GOOD, '<language>en</language>', '<language>&#xFFFE;</language>'), /character reference/],
  ['character reference &#x110000;', replaceOnce(GOOD, '<language>en</language>', '<language>&#x110000;</language>'), /character reference/],
  ['character reference &#1; in an attribute', replaceOnce(GOOD, 'length="1048576"', 'length="1&#1;"'), /character reference/],
  ['comment ending "--->"', replaceOnce(GOOD, '<language>en</language>', '<language>en</language><!-- note --->'), /comment/],
  ['whitespace before <?xml', `\n ${GOOD}`, /XML declaration/],
  ['raw U+0001 in text', replaceOnce(GOOD, 'Canon.app updates.', 'Canon.app\u0001 updates.'), /U\+0001/],
  ['raw U+0001 in an attribute', replaceOnce(GOOD, 'length="1048576"', 'length="1048576\u0001"'), /U\+0001/],
  ['raw U+FFFF in a comment', replaceOnce(GOOD, '<language>en</language>', '<language>en</language><!-- ￿ -->'), /U\+FFFF/],
  ['space after "</"', replaceOnce(GOOD, '</language>', '</ language>'), /end tag/],
  ['a DOCTYPE (deliberately not supported)', replaceOnce(GOOD, '<rss ', '<!DOCTYPE rss>\n<rss '), /DOCTYPE/],
];

test('the release feed fixture is what appcast.mjs writes: two items, one escaped URL', () => {
  assert.equal(GOOD.match(/<item>/g).length, 2);
  assert.match(GOOD, /\?a=1&amp;b=2"/);
});

test('check-install-feed accepts a two-item feed from appcast.mjs (exit 0)', async (t) => {
  assert.deepEqual(checkAppcast(GOOD), []);
  const r = await runChecker(t, GOOD);
  assert.equal(r.status, 0, r.stderr);
});

test('check-install-feed accepts a BOM, comments, a PI and CDATA where XML allows them', async () => {
  const xml = `﻿${GOOD}`
    .replace('<language>en</language>', '<language>en</language><!-- a - b --><?canon note?>')
    .replace('Canon.app updates.', '<![CDATA[Canon.app updates & <news>.]]>')
    .replace('<title>Canon 0.2.0</title>', '<title>Canon&#x20;0.2.0&#10;&#x1F600;</title>');
  assert.deepEqual(checkAppcast(xml), []);
});

for (const [name, xml, message] of BROKEN) {
  test(`check-install-feed rejects ${name} (exit 1)`, async (t) => {
    const errors = checkAppcast(xml);
    assert.equal(errors.length, 1, `want one error, got ${JSON.stringify(errors)}`);
    assert.match(errors[0], message);
    const r = await runChecker(t, xml);
    assert.equal(r.status, 1, `exit ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stderr, message);
  });
}
