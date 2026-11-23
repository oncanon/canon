#!/usr/bin/env node
// Adds one Canon.app release to the Sparkle 2 appcast (web/public/appcast.xml).
// The release workflow runs this after notarization; see docs/operations/release.md.
//
//   node scripts/release/appcast.mjs --file web/public/appcast.xml --version 0.2.0 \
//     --url https://github.com/oncanon/canon/releases/download/v0.2.0/Canon-0.2.0.zip \
//     --sign-update 'sparkle:edSignature="..." length="..."' [--check]
// --check computes the change and fails on a conflicting item, without writing.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MINIMUM_SYSTEM_VERSION = '14.0';
const RELEASE_NOTES = (version) => `https://github.com/oncanon/canon/releases/tag/v${version}`;

/** Parses the one line that Sparkle's `sign_update` prints. */
export function parseSignUpdate(output) {
  const match = /sparkle:edSignature="([^"]+)"\s+length="(\d+)"/.exec(output);
  if (!match) throw new Error(`sign_update output not recognised: ${JSON.stringify(output)}`);
  return { edSignature: match[1], length: Number(match[2]) };
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderItem({ version, url, length, edSignature, pubDate }) {
  return [
    '    <item>',
    `      <title>Canon ${escapeXml(version)}</title>`,
    `      <pubDate>${pubDate.toUTCString()}</pubDate>`,
    `      <sparkle:version>${escapeXml(version)}</sparkle:version>`,
    `      <sparkle:shortVersionString>${escapeXml(version)}</sparkle:shortVersionString>`,
    `      <sparkle:minimumSystemVersion>${MINIMUM_SYSTEM_VERSION}</sparkle:minimumSystemVersion>`,
    `      <sparkle:fullReleaseNotesLink>${escapeXml(RELEASE_NOTES(version))}</sparkle:fullReleaseNotesLink>`,
    `      <enclosure url="${escapeXml(url)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${edSignature}"/>`,
    '    </item>',
  ].join('\n');
}

function itemsFor(xml, version) {
  const items = xml.match(/    <item>[\s\S]*?<\/item>/g) ?? [];
  return items.filter((it) => it.includes(`<sparkle:version>${escapeXml(version)}</sparkle:version>`));
}

/**
 * Returns the appcast with the release added as the first item.
 * Re-adding the identical release returns the input unchanged, so a re-run workflow is safe.
 * A different item for a version that is already listed is an error: a shipped release is never rewritten.
 */
export function addAppcastItem(xml, release) {
  const { version, url, length, edSignature } = release;
  const pubDate = release.pubDate ?? new Date();
  if (!SEMVER.test(version)) throw new Error(`version is not SemVer: ${version}`);
  if (!/^https:\/\//.test(url)) throw new Error(`url must be https: ${url}`);
  if (!Number.isInteger(length) || length <= 0) throw new Error(`length must be a positive integer: ${length}`);
  if (typeof edSignature !== 'string' || !BASE64.test(edSignature)) throw new Error('edSignature must be base64');
  if (!(pubDate instanceof Date) || Number.isNaN(pubDate.getTime())) throw new Error('pubDate must be a valid Date');

  const existing = itemsFor(xml, version);
  if (existing.length > 0) {
    const sameRelease = existing.length === 1
      && existing[0].includes(`url="${escapeXml(url)}"`)
      && existing[0].includes(`length="${length}"`)
      && existing[0].includes(`sparkle:edSignature="${edSignature}"`);
    if (sameRelease) return xml;
    throw new Error(`appcast already has ${version} with different contents`);
  }

  const item = renderItem({ version, url, length, edSignature, pubDate });
  const firstItem = xml.indexOf('    <item>');
  if (firstItem !== -1) return `${xml.slice(0, firstItem)}${item}\n${xml.slice(firstItem)}`;
  const close = xml.indexOf('  </channel>');
  if (close === -1) throw new Error('appcast has no <channel> to add to');
  return `${xml.slice(0, close)}${item}\n${xml.slice(close)}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      version: { type: 'string' },
      url: { type: 'string' },
      'sign-update': { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  for (const key of ['file', 'version', 'url', 'sign-update']) {
    if (!values[key]) throw new Error(`missing --${key}`);
  }
  const { edSignature, length } = parseSignUpdate(values['sign-update']);
  const before = await readFile(values.file, 'utf8');
  const after = addAppcastItem(before, { version: values.version, url: values.url, length, edSignature });
  if (after !== before && !values.check) await writeFile(values.file, after);
  const did = values.check ? 'would add' : 'added';
  process.stdout.write(after === before ? `appcast already has ${values.version}\n` : `appcast: ${did} ${values.version}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
