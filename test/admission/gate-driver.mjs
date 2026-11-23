// Store admission gate driver (docs/decisions/render-policy-2.md R12). It exercises every
// admission point and every exempt path against the tree it sits in, and prints what it
// observed as JSON. test/unit/rp2-admission.test.mjs runs it twice: in this tree, where
// DEFAULT_RENDER_POLICY is render-policy/1 (the gate must be dormant), and in a copy whose one
// constant is flipped to render-policy/2 (the gate must be live). Its imports are relative, so
// in the copy they reach the copy's src/.
//
// usage: node gate-driver.mjs <work-dir> <synthetic-report.json> <site-input.json>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAlias } from '../../src/alias/alias.mjs';
import { assemblePacket, buildPacket, loadEvidence, loadRenderInputs, loadReport } from '../../src/packet/build.mjs';
import { DEFAULT_RENDER_POLICY, RENDER_POLICY_1 } from '../../src/policy.mjs';
import { fsAdapter } from '../../src/publication/adapters/fs.mjs';
import { createCloudflareWorker } from '../../src/publication/mocks/cloudflare-worker.mjs';
import { promote, publish, rollback } from '../../src/publication/protocol.mjs';
import { adapterFor } from '../../src/publication/targets.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { createPacketServer } from '../../src/server/server.mjs';
import { buildSiteBundle } from '../../src/site/build.mjs';

const CLI = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));
const [work, report, siteInput] = process.argv.slice(2).map((p) => resolve(p));
const exists = (p) => lstat(p).then(() => true, () => false);
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const env = { ...process.env, CANON_HOME: join(work, 'no-home'), CANON_LOOPBACK_ONLY: '1' };
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stderr: r.stderr, json };
};
const codeOf = (promise) => promise.then(() => null, (e) => e.code ?? e.message);
// Every receipt a store holds (v1 receipts at receipts/*.json), oldest first.
async function receipts(root) {
  const dir = join(root, 'receipts');
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
  return Promise.all(names.map((n) => readJson(join(dir, n))));
}
const publishReceipts = async (root) => (await receipts(root)).filter((r) => r.operation === 'publish');

const out = { defaultRenderPolicy: DEFAULT_RENDER_POLICY };
await mkdir(work, { recursive: true });

// Packets: one built as render-policy/1 explicitly, one with the build default.
const p1 = join(work, 'p1');
const pd = join(work, 'pd');
const id1 = (await buildPacket({ reportPath: report, outDir: p1, renderPolicy: RENDER_POLICY_1 })).contentId;
const idd = (await buildPacket({ reportPath: report, outDir: pd })).contentId;
out.builtDefaultPolicy = (await readJson(join(pd, 'manifest.json'))).build.renderPolicy;
{
  const { report: source, baseDir } = await loadReport(report);
  const assembled = assemblePacket(source, { evidenceBytes: await loadEvidence(source, baseDir), ...(await loadRenderInputs(DEFAULT_RENDER_POLICY)) });
  out.assembledDefaultPolicy = JSON.parse(assembled.output.get('manifest.json').toString('utf8')).build.renderPolicy;
}
out.cliBuildDefaultPolicy = (() => {
  const r = cli('build', report, '--out', join(work, 'cli-build'));
  return r.status === 0 ? null : `exit ${r.status}`;
})() ?? (await readJson(join(work, 'cli-build', 'manifest.json'))).build.renderPolicy;

// 1. publishPacket (library).
const s1 = join(work, 's1');
out.publishPacket = {
  refusedCode: await codeOf(publishPacket({ packetDir: p1, root: s1 })),
  storedAfterRefusal: await exists(join(s1, 'packets', id1)),
};
// Only the boolean true is the override: a truthy stand-in ('yes', 1) is not the flag.
out.publishPacket.truthyCodes = [
  await codeOf(publishPacket({ packetDir: p1, root: join(work, 's-truthy'), allowRenderPolicy1: 'yes' })),
  await codeOf(publishPacket({ packetDir: p1, root: join(work, 's-truthy'), allowRenderPolicy1: 1 })),
];
const allowed = await publishPacket({ packetDir: p1, root: s1, allowRenderPolicy1: true });
out.publishPacket.allowedOutcome = allowed.outcome;
out.publishPacket.allowedOverride = allowed.admissionOverride ?? null;
const dflt = await publishPacket({ packetDir: pd, root: s1 });
out.publishPacket.defaultOutcome = dflt.outcome;
out.publishPacket.defaultOverride = dflt.admissionOverride ?? null;

// 2. Exempt: alias set to the admitted policy/1 packet, then away and back (a rollback by CAS).
const g1 = await setAlias({ root: s1, name: 'old', contentId: id1, expectGeneration: 0 });
const g2 = await setAlias({ root: s1, name: 'old', contentId: idd, expectGeneration: 1 });
const g3 = await setAlias({ root: s1, name: 'old', contentId: id1, expectGeneration: 2 });
out.aliasSet = [g1, g2, g3].map((r) => `${r.generation}:${r.contentId === id1 ? 'p1' : 'default'}`);
const cliAlias = cli('alias', 'set', 'old-cli', id1, '--root', s1, '--expect-generation', '0');
out.cliAliasSet = cliAlias.status;

// 3. Exempt: the server serves the admitted policy/1 packet and the alias that names it.
const srv = createPacketServer({ root: s1, names: [] });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const get = async (path) => (await fetch(`http://127.0.0.1:${srv.address().port}${path}`)).status;
out.served = { packet: await get(`/p/${id1}/index.html`), alias: await get('/a/old/') };
await new Promise((r) => srv.close(r));

// 4. Not gated: a site-bundle/v1 bundle (its manifest also names render-policy/1).
const site = join(work, 'site');
await buildSiteBundle({ sitePath: siteInput, outDir: site });
const sitePub = await publishPacket({ packetDir: site, root: s1 });
out.siteBundle = { outcome: sitePub.outcome, override: sitePub.admissionOverride ?? null };

// 5. canon publish (V1 CLI): refusal, failure receipt, override receipt, default packet.
const s2 = join(work, 's2');
const refused = cli('publish', p1, '--root', s2);
const afterRefusal = await publishReceipts(s2);
const storedAfterCliRefusal = await exists(join(s2, 'packets', id1));
const ok = cli('publish', p1, '--root', s2, '--allow-render-policy-1');
const afterOk = await publishReceipts(s2);
const okDefault = cli('publish', pd, '--root', s2);
const afterDefault = await publishReceipts(s2);
const pick = (r) => (r ? { result: r.result, errorClass: r.errorClass, admissionOverride: r.admissionOverride ?? null, keys: Object.keys(r).sort() } : null);
out.cliPublish = {
  refusedStatus: refused.status,
  refusedStderr: /render-policy-refused/.test(refused.stderr),
  refusedReceipt: pick(afterRefusal[0] ?? null),
  storedAfterRefusal: storedAfterCliRefusal,
  refusedReceipts: afterRefusal.length,
  allowedStatus: ok.status,
  allowedReceipt: pick(afterOk.find((r) => r.result === 'success') ?? null),
  defaultStatus: okDefault.status,
  defaultReceipt: pick(afterDefault.filter((r) => r.result === 'success').find((r) => r.contentId === idd) ?? null),
};

// 6. canon brief: --render-policy 1 refused without the flag, admitted with it; the default builds.
const s3 = join(work, 's3');
const b1 = cli('brief', report, '--store', s3, '--alias', 'b1', '--render-policy', '1', '--out', join(work, 'b1'));
const b1Receipts = await publishReceipts(s3);
const b2 = cli('brief', report, '--store', s3, '--alias', 'b2', '--render-policy', '1', '--out', join(work, 'b2'), '--allow-render-policy-1');
const b2Receipts = await publishReceipts(s3);
const b3 = cli('brief', report, '--store', s3, '--alias', 'b3', '--out', join(work, 'b3'));
const b3Receipts = await publishReceipts(s3);
out.brief = {
  refusedStatus: b1.status,
  refusedStderr: /render-policy-refused/.test(b1.stderr),
  refusedPublishReceipts: b1Receipts.length,
  refusedAliased: await exists(join(s3, 'aliases', 'b1.json')),
  allowedStatus: b2.status,
  allowedOverride: b2Receipts.at(-1)?.admissionOverride ?? null,
  defaultStatus: b3.status,
  defaultPolicy: b3.status === 0 ? (await readJson(join(work, 'b3', 'manifest.json'))).build.renderPolicy : null,
  defaultOverride: b3Receipts.length > b2Receipts.length ? b3Receipts.at(-1).admissionOverride ?? null : 'no receipt',
};

// 7. Publication protocol + fs adapter (library).
const fsTarget = (name) => ({ name, kind: 'fs', root: join(work, name), accessMode: 'local', costCeilingUsdPerMonth: 0 });
const grants = new Set(['upload', 'promote']);
const t4 = fsTarget('s4');
const plain = adapterFor(t4);
out.protocol = {
  refusedCode: await codeOf(publish({ adapter: plain, target: t4, packetDir: p1, grants })),
  requestsAfterRefusal: plain.requestCount(),
  dryRunCode: await codeOf(publish({ target: t4, packetDir: p1, grants, dryRun: true })),
  // The protocol was told to allow, the store was not: the store's own gate refuses.
  adapterRefusedCode: await codeOf(publish({ adapter: adapterFor(t4), target: t4, packetDir: p1, grants, allowRenderPolicy1: true })),
  committedAfterAdapterRefusal: await exists(join(t4.root, 'packets', id1)),
};
const pr = await publish({ adapter: adapterFor(t4, { allowRenderPolicy1: true }), target: t4, packetDir: p1, grants, allowRenderPolicy1: true });
out.protocol.allowedState = pr.state;
out.protocol.allowedOverride = pr.receipt.admissionOverride ?? null;
const prd = await publish({ adapter: plain, target: t4, packetDir: pd, grants });
out.protocol.defaultState = prd.state;
out.protocol.defaultOverride = prd.receipt.admissionOverride ?? null;
// Exempt: promote to the admitted policy/1 packet, promote away, roll back to it.
const m1 = await promote({ adapter: plain, target: t4, alias: 'old', contentId: id1, expectGeneration: 0, grants });
const m2 = await promote({ adapter: plain, target: t4, alias: 'old', contentId: idd, expectGeneration: 1, grants });
const m3 = await rollback({ adapter: plain, target: t4, alias: 'old', to: id1, expectGeneration: 2, grants });
out.protocol.aliasMoves = [m1, m2, m3].map((m) => m.state);

// 8. The fs adapter alone: the manifest put (the commit) is the store's gate.
const t5 = fsTarget('s5');
const direct = fsAdapter({ root: t5.root });
const manifestBytes = await readFile(join(p1, 'manifest.json'));
const put = (ad, path, bytes) => ad.putIfAbsent({ key: `p/${id1}/${path}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' }, bytes);
const m = await readJson(join(p1, 'manifest.json'));
for (const f of [...m.files.map((x) => x.path), 'checksums.json']) await put(direct, f, await readFile(join(p1, f)));
out.adapter = {
  refusedCode: await codeOf(put(direct, 'manifest.json', manifestBytes)),
  committedAfterRefusal: await exists(join(t5.root, 'packets', id1)),
  stagedManifestAfterRefusal: await exists(join(t5.root, '.uploads', id1, 'manifest.json')),
};
out.adapter.truthyCode = await codeOf(put(fsAdapter({ root: t5.root, allowRenderPolicy1: 'yes' }), 'manifest.json', manifestBytes));
out.adapter.allowedOutcome = (await put(fsAdapter({ root: t5.root, allowRenderPolicy1: true }), 'manifest.json', manifestBytes)).outcome;
out.adapter.committedAfterAllow = await exists(join(t5.root, 'packets', id1));

// 9. canon publish --target (V2 CLI): the one flag reaches the protocol and the fs store.
const v2dir = join(work, 'v2');
await mkdir(v2dir, { recursive: true });
await writeFile(join(v2dir, 'targets.json'), JSON.stringify({ schema: 'publication-targets/v1', targets: [{ name: 'local', kind: 'fs', root: 'store', accessMode: 'local', costCeilingUsdPerMonth: 0 }] }));
const T = ['--target', 'local', '--targets', join(v2dir, 'targets.json')];
const v2Refused = cli('publish', p1, ...T);
const v2Ok = cli('publish', p1, ...T, '--allow-render-policy-1');
out.cliPublishTarget = { refusedStatus: v2Refused.status, refusedError: v2Refused.json?.error ?? null, allowedStatus: v2Ok.status, allowedState: v2Ok.json?.state ?? null };
const v2Receipts = (await readdir(join(v2dir, 'store', 'receipts', 'v2')).catch(() => [])).filter((n) => n.endsWith('.json'));
const v2Bodies = await Promise.all(v2Receipts.map((n) => readJson(join(v2dir, 'store', 'receipts', 'v2', n))));
out.cliPublishTarget.overrides = v2Bodies.filter((r) => r.admissionOverride).length;

// 10. A provider target: the protocol's gate refuses before any provider request.
const cf = createCloudflareWorker({});
const cfTarget = { name: 'cf-test', kind: 'mock-cloudflare', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_T', ledgerDir: join(work, 'ledger') };
const cfAdapter = adapterFor(cfTarget, { env: { RP_T: JSON.stringify(cf.credentials()) }, endpoint: cf });
out.provider = {
  refusedCode: await codeOf(publish({ adapter: cfAdapter, target: cfTarget, packetDir: p1, grants })),
  requestsAfterRefusal: cfAdapter.requestCount(),
};
const cfOk = await publish({ adapter: cfAdapter, target: cfTarget, packetDir: p1, grants, allowRenderPolicy1: true });
out.provider.allowedState = cfOk.state;
out.provider.allowedOverride = cfOk.receipt.admissionOverride ?? null;

console.log(JSON.stringify(out));
