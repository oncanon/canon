// The dry run of publish, promote and rollback. A dry run makes the operation's local checks,
// returns the writes the operation would send, and sends nothing. It is shown here against the
// fs target and the in-process Cloudflare mock: nothing reaches the target during a dry run, and
// the real operation then sends exactly what was planned. The retry helper's rule for a call
// whose outcome is unknown is checked here too, because the dry run and the real run share it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { CODES, PublicationError } from '../../src/publication/errors.mjs';
import { promote, publish, rollback, withRetry } from '../../src/publication/protocol.mjs';
import { receiptId, receiptIdPattern } from '../../src/publication/receipts.mjs';
import { CLI, REPO, tempDir } from '../helpers.mjs';
import { allReceipts, harness, KINDS, syntheticPacket } from '../v2/harness.mjs';

// Records every adapter write in the terms a dry run states them, and counts every call.
function recording(adapter) {
  const log = [];
  const wrapped = { ...adapter };
  for (const [name, fn] of Object.entries(adapter)) {
    if (typeof fn !== 'function' || ['describe', 'liveSecrets', 'requestCount'].includes(name)) continue;
    wrapped[name] = (...args) => { log.push({ name, args }); return fn(...args); };
  }
  return {
    adapter: wrapped,
    calls: () => log.length,
    puts: () => log.filter((c) => c.name === 'putIfAbsent').map(({ args: [req, bytes] }) => ({ key: req.key, sha256: req.sha256, bytes: bytes.length, contentType: req.contentType, cacheControl: req.cacheControl })),
    reads: () => log.filter((c) => c.name === 'getObject').map((c) => c.args[0]),
    moves: () => log.filter((c) => c.name === 'casAlias' || c.name === 'appendHistory').map((c) => c.name),
  };
}

async function live(kind, t) {
  const h = await harness(kind, t);
  const rec = recording(h.adapter);
  const opts = (extra = {}) => h.opts({ adapter: rec.adapter, ...extra });
  return { h, rec, opts };
}

const matchesOne = (patterns, id) => patterns.filter((p) => new RegExp(p).test(id)).length;

for (const kind of KINDS) {
  test(`[DRY-RUN] ${kind}: a dry run of publish sends nothing, and the publish then sends exactly the puts it listed, in order`, async (t) => {
    const { h, rec, opts } = await live(kind, t);
    const a = await syntheticPacket(h.dir, 'a');
    const startRequests = h.adapter.requestCount();
    const plan = await publish({ ...opts(), packetDir: a.dir, dryRun: true });
    assert.equal(rec.calls(), 0, 'no adapter call was made');
    assert.equal(h.adapter.requestCount(), startRequests, 'and no request reached the target');
    assert.deepEqual(await allReceipts(h), [], 'nothing was stored, a receipt included');
    assert.deepEqual([plan.state, plan.dryRun, plan.operation, plan.contentId, plan.receipts], ['PLANNED', true, 'publish', a.contentId, 1]);
    assert.ok(plan.requests.length >= 4 && plan.requests.every((r) => r.op === 'putIfAbsent' && r.key.startsWith(`p/${a.contentId}/`)), 'every planned write is a put-if-absent under the packet prefix');
    assert.equal(plan.requests.at(-1).key, `p/${a.contentId}/manifest.json`, 'manifest.json last');

    const done = await publish({ ...opts(), packetDir: a.dir });
    assert.deepEqual(rec.puts(), plan.requests.map(({ op, ...r }) => r), 'the puts sent are the puts planned: key, SHA-256, size, content type and cache header, in order');
    assert.deepEqual([...new Set(rec.reads())].sort(), [...plan.readBack].sort(), 'and the read-back reads the keys planned');
    // The receipt ID is time-stamped, so the plan names its pattern: the one receipt the publish
    // wrote matches the one planned pattern.
    assert.equal(plan.receiptPatterns.length, plan.receipts);
    assert.ok(plan.receiptPatterns.every((p) => p.startsWith('^') && p.endsWith('$')), 'anchored patterns over the receipt ID');
    const ids = (await allReceipts(h)).map((r) => r.receiptId);
    assert.deepEqual(ids.map((id) => matchesOne(plan.receiptPatterns, id)), [1]);
    assert.equal(done.receipt.receiptId, ids[0]);
    const grantLines = plan.checkedOnlyAtRun.filter((c) => /grant/.test(c));
    assert.deepEqual(grantLines.length, kind === 'fs' ? 0 : 1, 'the plan names the grant only when the real publish asks for one');
    if (kind !== 'fs') assert.match(grantLines[0], /grant upload/, 'the plan says the upload grant is checked only by the real publish');
  });

  test(`[DRY-RUN] ${kind}: a dry run of promote and of rollback sends nothing, and the move then writes exactly the alias record and history entry it named`, async (t) => {
    const { h, rec, opts } = await live(kind, t);
    const a = await syntheticPacket(h.dir, 'a');
    const b = await syntheticPacket(h.dir, 'b');
    await publish({ ...opts(), packetDir: a.dir });
    await publish({ ...opts(), packetDir: b.dir });

    let sent = rec.calls();
    const first = await promote({ ...opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0, dryRun: true });
    assert.equal(rec.calls(), sent, 'the promote dry run sent nothing');
    assert.deepEqual(first.requests, [
      { op: 'casAlias', alias: 'review', expectGeneration: 0, contentId: a.contentId, toGeneration: 1 },
      { op: 'appendHistory', alias: 'review', generation: 1, contentId: a.contentId },
    ]);
    assert.deepEqual([first.state, first.dryRun, first.operation, first.receipts], ['PLANNED', true, 'promote', 2]);
    assert.ok(first.checkedOnlyAtRun.some((c) => /grant promote/.test(c)), 'the plan says the promote grant is checked only by the real move');
    const before = rec.moves().length;
    const moved = await promote({ ...opts(), alias: 'review', contentId: a.contentId, expectGeneration: 0 });
    assert.equal(moved.record.generation, first.toGeneration);
    assert.deepEqual(rec.moves().slice(before), first.requests.map((r) => r.op), 'the move made the two writes planned, and no other');
    await promote({ ...opts(), alias: 'review', contentId: b.contentId, expectGeneration: 1 });

    sent = rec.calls();
    const receiptsBefore = new Set((await allReceipts(h)).map((r) => r.receiptId));
    const back = await rollback({ ...opts(), alias: 'review', to: a.contentId, expectGeneration: 2, dryRun: true });
    assert.equal(rec.calls(), sent, 'the rollback dry run sent nothing');
    assert.deepEqual(back.requests.map((r) => [r.op, r.toGeneration ?? r.generation]), [['casAlias', 3], ['appendHistory', 3]]);
    assert.equal(back.toGeneration, 3, 'a rollback is planned as a new generation');
    assert.ok(back.checkedOnlyAtRun.some((c) => /earlier generation/.test(c)), 'what only the target can answer is named, not assumed');
    assert.ok(back.checkedOnlyAtRun.some((c) => /grant promote/.test(c)));
    const done = await rollback({ ...opts(), alias: 'review', to: a.contentId, expectGeneration: 2 });
    assert.equal(done.record.generation, back.toGeneration);
    const written = (await allReceipts(h)).map((r) => r.receiptId).filter((id) => !receiptsBefore.has(id)).sort();
    assert.equal(written.length, back.receipts, 'an intent and a result receipt, as planned');
    // Their IDs match the planned patterns one to one: the intent receipt, then the result.
    assert.deepEqual(written.map((id) => back.receiptPatterns.findIndex((p) => new RegExp(p).test(id))).sort(), [0, 1]);
    assert.deepEqual(written.map((id) => matchesOne(back.receiptPatterns, id)), [1, 1], 'each ID matches exactly one pattern');
  });
}

test('[DRY-RUN] a dry run needs no adapter, grant or credential, and still refuses what the operation refuses before it sends', async (t) => {
  const dir = await tempDir(t, 'canon-dry-local');
  // A real Cloudflare target: a dry run against it builds no transport, so nothing leaves the machine.
  const tgt = { name: 'cf-real', kind: 'cloudflare', endpoint: 'https://canon-test.example.workers.dev', accessMode: 'access-private', costCeilingUsdPerMonth: 5, credentialEnv: 'RP_CF_DRY', ledgerDir: join(dir, 'ledger') };
  const a = await syntheticPacket(dir, 'a');
  const plan = await publish({ target: tgt, packetDir: a.dir, dryRun: true });
  assert.equal(plan.contentId, a.contentId, 'planned with no adapter and no grant');
  const bare = await promote({ target: tgt, alias: 'review', contentId: a.contentId, expectGeneration: 0, dryRun: true });
  assert.ok(bare.receiptPatterns.every((p) => /-promote-/.test(p)), 'its receipts are named by the pattern of their IDs');
  // A target whose publish needs no grant is not told that one will be asked for.
  const local = await publish({ target: { name: 'local', kind: 'fs', accessMode: 'local', costCeilingUsdPerMonth: 0, root: join(dir, 'store') }, packetDir: a.dir, dryRun: true });
  assert.deepEqual(local.checkedOnlyAtRun.filter((c) => /grant/.test(c)), []);
  // The same calls for real are refused for want of a grant: the dry run is not a way round it.
  await assert.rejects(publish({ target: tgt, packetDir: a.dir }), (e) => e.code === CODES.GRANT_MISSING);
  await assert.rejects(promote({ target: tgt, alias: 'review', contentId: a.contentId, expectGeneration: 0 }), (e) => e.code === CODES.GRANT_MISSING);

  const production = await syntheticPacket(dir, 'prod', { classification: 'private-review', dataOrigin: 'production' });
  await assert.rejects(publish({ target: tgt, packetDir: production.dir, dryRun: true }), (e) => e.code === CODES.SYNTHETIC_ONLY, 'a packet that is not synthetic is refused in the plan');
  const tampered = join(dir, 'tampered');
  await cp(a.dir, tampered, { recursive: true });
  await writeFile(join(tampered, 'report.md'), `${await readFile(join(tampered, 'report.md'), 'utf8')}x`);
  await assert.rejects(publish({ target: tgt, packetDir: tampered, dryRun: true }), (e) => e.code === CODES.INVALID, 'a packet that does not verify is refused in the plan');
  await assert.rejects(publish({ target: { ...tgt, costCeilingUsdPerMonth: 0 }, packetDir: a.dir, dryRun: true }), (e) => e.code === CODES.COST_CEILING);
  await assert.rejects(publish({ target: { ...tgt, endpoint: undefined }, packetDir: a.dir, dryRun: true }), (e) => e.code === CODES.NOT_AVAILABLE);
  await assert.rejects(promote({ target: tgt, alias: 'review', contentId: a.contentId, expectGeneration: -1, dryRun: true }), (e) => e.code === CODES.INVALID);
  await assert.rejects(promote({ target: tgt, alias: 'Not An Alias', contentId: a.contentId, expectGeneration: 0, dryRun: true }), (e) => e.code === CODES.INVALID, 'a malformed alias name is refused in the plan');
  await assert.rejects(promote({ target: tgt, alias: 'review', contentId: 'not-a-content-id', expectGeneration: 0, dryRun: true }), (e) => e.code === CODES.INVALID);

  // The CLI: --dry-run prints the plan with no credential variable set, and builds no transport.
  const file = join(dir, 'targets.json');
  const { ledgerDir, ...fileTarget } = tgt;
  await writeFile(file, JSON.stringify({ schema: 'publication-targets/v1', targets: [{ ...fileTarget, ledgerDir: 'ledger' }] }));
  const env = { ...process.env, CANON_LOOPBACK_ONLY: '1' };
  delete env.RP_CF_DRY;
  const canon = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--target', 'cf-real', '--targets', file], { cwd: dir, env, encoding: 'utf8' });
    return { status: r.status, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };
  let r = canon('publish', a.dir, '--dry-run');
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.json.requests, plan.requests, 'canon publish --dry-run prints the same plan');
  r = canon('rollback', '--alias', 'review', '--to', a.contentId, '--expect-generation', '2', '--dry-run');
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.json.requests.map((x) => x.op), ['casAlias', 'appendHistory'], 'canon rollback --dry-run prints the two writes of the move');
  assert.equal(r.json.toGeneration, 3);
  r = canon('publish', a.dir, '--grant', 'upload');
  assert.equal(r.status, 1);
  assert.equal(r.json.error, 'credential-missing', 'without --dry-run the same command stops for its credential');
  r = canon('reconcile', '--dry-run', '--grant', 'promote');
  assert.equal(r.status, 2);
  assert.match(r.err, /reconcile has no dry run/);
});

test('[DRY-RUN] the receipt pattern a plan names follows the receipt ID\'s own definition: every operation\'s ID matches its pattern, and only its own', () => {
  const clock = () => '2026-10-05T12:34:56.789Z';
  const operations = ['publish', 'promote', 'rollback', 'reconcile'];
  assert.match(receiptId('publish', clock), /^2026-10-05T12-34-56-789Z-publish-[0-9a-f]{8}$/, 'the ID: the time with its colons and dot as hyphens, the operation, eight hex digits');
  for (const made of operations) {
    const id = receiptId(made, clock);
    assert.deepEqual(operations.filter((named) => new RegExp(`^${receiptIdPattern(named)}$`).test(id)), [made], `a ${made} receipt ID`);
    for (const drifted of [`${id}0`, id.slice(0, -1), id.replace('T12-', 'T12:'), id.replace('2026', '202X')]) {
      assert.ok(!new RegExp(`^${receiptIdPattern(made)}$`).test(drifted), `${drifted} is not a ${made} receipt ID`);
    }
  }
  assert.match(receiptId('publish', () => new Date().toISOString()), new RegExp(`^${receiptIdPattern('publish')}$`), 'and with the real clock');
});

async function mjsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await mjsFiles(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('[RETRY] the retry helper never repeats a call whose outcome is unknown unless the call is declared idempotent, and no call in the source is declared so', async () => {
  // A write that timed out may have been carried out, so sending it again is not safe by default.
  const run = async (error, opts = {}) => {
    let calls = 0;
    const err = await withRetry(async () => { calls += 1; throw error; }, { attempts: 3, sleep: async () => {}, ...opts }).then(() => null, (e) => e);
    return { calls, same: err === error };
  };
  const failed = {};
  const check = async (name, fn) => { try { await fn(); } catch (e) { failed[name] = e.message; } };
  for (const code of [CODES.THROTTLED, CODES.TIMEOUT]) {
    const unknown = new PublicationError(code, 'the answer was lost', { outcomeUnknown: true });
    await check(`${code}: an outcome-unknown error is thrown at once`, async () => assert.deepEqual(await run(unknown), { calls: 1, same: true }));
    await check(`${code}: a truthy value that is not true does not declare the call idempotent`, async () => assert.deepEqual(await run(unknown, { idempotent: 'yes' }), { calls: 1, same: true }));
    await check(`${code}: a call declared idempotent is retried (control)`, async () => assert.deepEqual(await run(unknown, { idempotent: true }), { calls: 3, same: true }));
    await check(`${code}: an unmarked error is retried as before (control)`, async () => assert.deepEqual(await run(new PublicationError(code, 'stated by the service')), { calls: 3, same: true }));
    await check(`${code}: an error marked false is retried as before (control)`, async () => assert.deepEqual(await run(new PublicationError(code, 'stated', { outcomeUnknown: false })), { calls: 3, same: true }));
  }
  await check('no call in src/ declares idempotence (a reviewed change when one does)', async () => {
    const files = await mjsFiles(join(REPO, 'src'));
    const declared = [];
    for (const f of files) if (/\bidempotent\s*:/.test((await readFile(f, 'utf8')).replace(/^\s*\/\/.*$/gm, ''))) declared.push(relative(REPO, f));
    assert.deepEqual(declared, []);
  });
  assert.deepEqual(failed, {}, 'every case, each named with why it failed');
});
