// render-policy-2.md R11 (review 3 MINOR 2): the builder never seals a render-policy/2
// packet that its own full verify rejects. Every option combination below is tried; each
// one buildPacket or assemblePacket accepts is written out and must pass verifyPacketFull,
// and each one refused must be refused with a BuildError. The options are crossed
// exhaustively, so a new way to change a renderer input shows up as a sealed packet that
// does not reproduce.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assemblePacket, BuildError, buildPacket, EDITION_21_STYLESHEET, DEFAULT_STYLESHEET, loadEvidence, loadReport, reproductionRenderInputs, writePacketDirectory } from '../../src/packet/build.mjs';
import { verifyPacketFull } from '../../src/packet/reproduce.mjs';
import { TOOL } from '../../src/policy.mjs';
import { LOCKUP_FILES } from '../../src/render/lockup.mjs';
import { FIXTURE, REPO, tempDir } from '../helpers.mjs';

const P1 = 'render-policy/1';
const P2 = 'render-policy/2';
const SPECIMEN = join(REPO, 'fixtures/specimen-v2/canon-specimen-v2.report.json');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24" width="120" height="24"><g fill="currentColor"><path d="M14 2 L30 2 L30 22 Z"/></g></svg>';

const fmt = (errors) => errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('\n');

// Seal or refuse; an accepted packet must pass the full verify.
async function sealsOnlyWhatVerifies(label, seal, dir) {
  let output;
  try {
    output = await seal();
  } catch (err) {
    assert.ok(err instanceof BuildError, `${label}: refused with ${err}, not a BuildError`);
    return { label, refused: err.code };
  }
  await writePacketDirectory(output, dir);
  const full = await verifyPacketFull(dir);
  assert.equal(full.ok, true, `${label}: the build sealed a packet its own verify rejects:\n${fmt(full.errors)}`);
  return { label, refused: null };
}

test('[RV-R11] buildPacket: every policy/2 option combination it accepts passes verifyPacketFull', async (t) => {
  const dir = await tempDir(t, 'canon-fuzz-build');
  const shipped = await readFile(EDITION_21_STYLESHEET);
  const stylesheets = {
    none: undefined,
    shipped,
    'shipped + comment': Buffer.concat([shipped, Buffer.from('\n/* sealed but never reproduced */\n')]),
    'policy/1 stylesheet': await readFile(DEFAULT_STYLESHEET),
    empty: Buffer.alloc(0),
  };
  const marks = { none: undefined };
  for (const [name, files] of Object.entries({ empty: {}, 'both lockups': { [LOCKUP_FILES.ui]: SVG, [LOCKUP_FILES.display]: SVG }, 'ui lockup': { [LOCKUP_FILES.ui]: SVG }, 'unsafe lockup': { [LOCKUP_FILES.display]: '<svg viewBox="0 0 1 1" style="x"></svg>' } })) {
    marks[name] = join(dir, 'marks', name.replace(/\W+/g, '-'));
    await mkdir(marks[name], { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(join(marks[name], file), text);
  }
  marks.missing = join(dir, 'marks', 'does-not-exist');
  const old = join(dir, 'old');
  await buildPacket({ reportPath: FIXTURE, outDir: old, renderPolicy: P1 });
  const sources = [[FIXTURE, null], [FIXTURE, old], [SPECIMEN, null]];

  const results = [];
  let n = 0;
  for (const [report, reissueOfDir] of sources) {
    for (const [sName, stylesheetBytes] of Object.entries(stylesheets)) {
      for (const [mName, marksDir] of Object.entries(marks)) {
        const label = `${report === FIXTURE ? 'fixture' : 'specimen'}${reissueOfDir ? ' reissue' : ''} | stylesheet ${sName} | marks ${mName}`;
        const options = { reportPath: report, renderPolicy: P2, reissueOfDir, ...(stylesheetBytes !== undefined ? { stylesheetBytes } : {}), ...(marksDir !== undefined ? { marksDir } : {}) };
        results.push(await sealsOnlyWhatVerifies(label, async () => (await buildPacket(options)).output, join(dir, `b${n++}`)));
      }
    }
  }
  // The instrument: both outcomes occur, and the known cases land where they must.
  const by = Object.fromEntries(results.map((r) => [r.label, r.refused]));
  assert.equal(by['fixture | stylesheet none | marks none'], null, 'the default build seals');
  assert.equal(by['fixture | stylesheet shipped | marks empty'], null, 'inputs equal to the shipped ones seal');
  assert.equal(by['fixture reissue | stylesheet none | marks none'], null, 'a reissue seals');
  assert.equal(by['fixture | stylesheet shipped + comment | marks none'], 'render-inputs', 'review 3 MINOR 2: a stylesheet override is refused');
  assert.equal(by['specimen | stylesheet none | marks both lockups'], 'render-inputs', 'marks from another directory are refused');
  assert.equal(by['fixture | stylesheet none | marks unsafe lockup'], 'unsafe-lockup');
  assert.ok(results.filter((r) => r.refused === null).length >= 9 && results.filter((r) => r.refused !== null).length >= 30, JSON.stringify(results));
});

test('[RV-R11] assemblePacket: every policy/2 input combination it accepts passes verifyPacketFull', async (t) => {
  const dir = await tempDir(t, 'canon-fuzz-assemble');
  const { report, baseDir } = await loadReport(FIXTURE);
  const evidenceBytes = await loadEvidence(report, baseDir);
  const shipped = reproductionRenderInputs();
  const fonts = shipped.fontAssets;
  const variants = {
    evidenceBytes: {
      shipped: evidenceBytes,
      'as Uint8Array': new Map([...evidenceBytes].map(([k, v]) => [k, new Uint8Array(v)])),
      'one missing': new Map([...evidenceBytes].slice(1)),
      'a plain object': Object.fromEntries(evidenceBytes),
    },
    stylesheetBytes: { shipped: shipped.stylesheetBytes, 'one byte more': Buffer.concat([shipped.stylesheetBytes, Buffer.from(' ')]), missing: undefined },
    fontAssets: {
      shipped: fonts,
      'one fewer': fonts.slice(1),
      reordered: [fonts[1], fonts[0], ...fonts.slice(2)],
      'a changed byte': fonts.map((f, i) => (i === 0 ? { ...f, bytes: Buffer.concat([f.bytes.subarray(0, -1), Buffer.from([f.bytes.at(-1) ^ 1])]) } : f)),
      'a renamed family': fonts.map((f, i) => (i === 0 ? { ...f, family: 'Libron Pro' } : f)),
      none: [],
    },
    lockups: { shipped: shipped.lockups, 'a ui lockup': { ui: SVG, display: null }, missing: undefined },
    tool: {
      this: TOOL,
      'an older release': { name: TOOL.name, version: '0.0.1', securityPolicy: TOOL.securityPolicy },
      'a later release': { name: TOOL.name, version: '10.20.300', securityPolicy: TOOL.securityPolicy },
      'leading zeros': { name: TOOL.name, version: '00.01.000', securityPolicy: TOOL.securityPolicy },
      'a pre-release': { name: TOOL.name, version: '1.0.0-rc.1', securityPolicy: TOOL.securityPolicy },
      'another tool': { name: 'Canon Certified', version: TOOL.version, securityPolicy: TOOL.securityPolicy },
    },
    reissueOf: { none: null, 'a content ID': `sha256-${'a'.repeat(64)}` },
  };
  const keys = Object.keys(variants);
  const combos = keys.reduce((acc, key) => acc.flatMap((c) => Object.keys(variants[key]).map((name) => ({ ...c, [key]: name }))), [{}]);
  const results = [];
  let n = 0;
  for (const combo of combos) {
    const label = keys.map((k) => `${k} ${combo[k]}`).join(' | ');
    const options = { renderPolicy: P2 };
    for (const k of keys) if (variants[k][combo[k]] !== undefined) options[k] = variants[k][combo[k]];
    results.push(await sealsOnlyWhatVerifies(label, async () => assemblePacket(report, options).output, join(dir, `a${n++}`)));
  }
  const accepted = results.filter((r) => r.refused === null).map((r) => r.label).sort();
  // Only the shipped renderer inputs seal (a missing lockups option means none, which is the
  // shipped value while the tree ships no lockups); tool and reissueOf vary only within what
  // verify accepts.
  const noShippedLockups = shipped.lockups.ui === null && shipped.lockups.display === null;
  const expected = combos.filter((c) => c.evidenceBytes === 'shipped' && c.stylesheetBytes === 'shipped' && c.fontAssets === 'shipped'
    && (c.lockups === 'shipped' || (c.lockups === 'missing' && noShippedLockups))
    && ['this', 'an older release', 'a later release'].includes(c.tool)).map((c) => keys.map((k) => `${k} ${c[k]}`).join(' | ')).sort();
  assert.ok(expected.length >= 6, 'the instrument: some combinations must seal');
  assert.deepEqual(accepted, expected);
});

test('[RV-R11] assemblePacket refuses evidence bytes that are not Buffers, under both policies (review 4 MINOR 2)', async () => {
  const { report, baseDir } = await loadReport(FIXTURE);
  const evidenceBytes = await loadEvidence(report, baseDir);
  const asArrays = new Map([...evidenceBytes].map(([k, v]) => [k, new Uint8Array(v)]));
  const p1 = { stylesheetBytes: await readFile(DEFAULT_STYLESHEET), renderPolicy: P1 };
  const p2 = { ...reproductionRenderInputs(), renderPolicy: P2 };
  for (const [name, options] of [['policy/1', p1], ['policy/2', p2]]) {
    assert.throws(() => assemblePacket(report, { ...options, evidenceBytes: asArrays }), (e) => e instanceof BuildError && e.code === 'evidence-bytes', `${name}: a Uint8Array`);
    assert.throws(() => assemblePacket(report, { ...options, evidenceBytes: new Map() }), (e) => e instanceof BuildError && e.code === 'evidence-bytes', `${name}: missing bytes`);
    assert.doesNotThrow(() => assemblePacket(report, { ...options, evidenceBytes }), `${name}: Buffers assemble`);
  }
});
