import assert from 'node:assert/strict';
import test from 'node:test';
import { addAppcastItem, parseSignUpdate } from '../../scripts/release/appcast.mjs';
import { bumpCask, bumpFormula } from '../../scripts/release/tap-bump.mjs';

const EMPTY = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Canon</title>
    <link>https://oncanon.com/</link>
  </channel>
</rss>
`;
const SIG = 'pWbQf6x0T5pSv7mUrk0kNnq1b8pz1ZsZxw9m5mNn0X3m0bq1r0pJmJ0Yt9m5Q1q2kq3yYw==';
const item = (version, edSignature = SIG) => ({
  version,
  url: `https://github.com/oncanon/canon/releases/download/v${version}/Canon-${version}.zip`,
  length: 4242,
  edSignature,
  pubDate: new Date('2026-11-21T00:00:00Z'),
});

test('parseSignUpdate reads the sign_update output', () => {
  assert.deepEqual(parseSignUpdate(`sparkle:edSignature="${SIG}" length="4242"\n`), { edSignature: SIG, length: 4242 });
  assert.throws(() => parseSignUpdate('nothing here'), /sign_update/);
});

test('addAppcastItem adds one item with every field Sparkle needs', () => {
  const out = addAppcastItem(EMPTY, item('0.1.0'));
  assert.equal(out.match(/<item>/g).length, 1);
  for (const needle of [
    '<sparkle:version>0.1.0</sparkle:version>',
    '<sparkle:shortVersionString>0.1.0</sparkle:shortVersionString>',
    '<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>',
    `sparkle:edSignature="${SIG}"`,
    'length="4242"',
    'url="https://github.com/oncanon/canon/releases/download/v0.1.0/Canon-0.1.0.zip"',
    '<pubDate>Sat, 21 Nov 2026 00:00:00 GMT</pubDate>',
    '<sparkle:fullReleaseNotesLink>https://github.com/oncanon/canon/releases/tag/v0.1.0</sparkle:fullReleaseNotesLink>',
  ]) assert.ok(out.includes(needle), needle);
});

test('addAppcastItem puts the newest item first', () => {
  const out = addAppcastItem(addAppcastItem(EMPTY, item('0.1.0')), item('0.2.0'));
  assert.ok(out.indexOf('<sparkle:version>0.2.0<') < out.indexOf('<sparkle:version>0.1.0<'));
});

test('addAppcastItem is a no-op for the same release and refuses a conflicting one', () => {
  const once = addAppcastItem(EMPTY, item('0.1.0'));
  assert.equal(addAppcastItem(once, item('0.1.0')), once);
  assert.throws(() => addAppcastItem(once, item('0.1.0', SIG.replace('p', 'q'))), /already has 0\.1\.0/);
});

test('addAppcastItem rejects bad input', () => {
  assert.throws(() => addAppcastItem(EMPTY, item('v0.1')), /SemVer/);
  assert.throws(() => addAppcastItem(EMPTY, { ...item('0.1.0'), edSignature: 'a"b' }), /edSignature/);
  assert.throws(() => addAppcastItem(EMPTY, { ...item('0.1.0'), length: 0 }), /length/);
  assert.throws(() => addAppcastItem(EMPTY, { ...item('0.1.0'), url: 'http://x/Canon.zip' }), /https/);
  assert.throws(() => addAppcastItem('<rss></rss>', item('0.1.0')), /channel/);
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const FORMULA = `class Canon < Formula
  desc "x"
  url "https://github.com/oncanon/canon/releases/download/v0.1.0/canon-0.1.0.tgz"
  sha256 "${SHA_A}"
end
`;
const CASK = `cask "canon-app" do
  version "0.1.0"
  sha256 "${SHA_A}"
end
`;

test('bumpFormula rewrites url and sha256', () => {
  const out = bumpFormula(FORMULA, { version: '0.2.0', sha256: SHA_B });
  assert.ok(out.includes('url "https://github.com/oncanon/canon/releases/download/v0.2.0/canon-0.2.0.tgz"'));
  assert.ok(out.includes(`sha256 "${SHA_B}"`));
  assert.ok(!out.includes('0.1.0'));
});

test('bumpCask rewrites version and sha256', () => {
  const out = bumpCask(CASK, { version: '0.2.0', sha256: SHA_B });
  assert.ok(out.includes('version "0.2.0"'));
  assert.ok(out.includes(`sha256 "${SHA_B}"`));
});

test('tap bumps refuse bad input and unexpected files', () => {
  assert.throws(() => bumpCask(CASK, { version: '0.2.0', sha256: 'abc' }), /sha256/);
  assert.throws(() => bumpFormula(FORMULA, { version: '2', sha256: SHA_B }), /SemVer/);
  assert.throws(() => bumpCask('cask "x" do\nend\n', { version: '0.2.0', sha256: SHA_B }), /exactly one/);
  assert.throws(() => bumpFormula(FORMULA + FORMULA, { version: '0.2.0', sha256: SHA_B }), /exactly one/);
});

test('tap bumps refuse to move the tap to an older version, and allow the same one', () => {
  const at020 = bumpFormula(FORMULA, { version: '0.2.0', sha256: SHA_B });
  assert.throws(() => bumpFormula(at020, { version: '0.1.9', sha256: SHA_A }), /older/);
  assert.throws(() => bumpCask(bumpCask(CASK, { version: '0.10.0', sha256: SHA_B }), { version: '0.9.0', sha256: SHA_A }), /older/);
  assert.equal(bumpFormula(at020, { version: '0.2.0', sha256: SHA_B }), at020);
  assert.ok(bumpCask(CASK, { version: '1.0.0', sha256: SHA_B }).includes('version "1.0.0"'));
});
