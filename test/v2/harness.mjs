// Contract-suite harness: one fresh target per adapter kind, the same fault
// vocabulary for both, and synthetic packets. Mocks take faults at their
// in-process provider endpoint; the fs adapter takes them through a wrapper at the
// adapter boundary (it has no provider to fault). Faults with no fs analogue
// (credential expiry) report NOT_APPLICABLE for fs.
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPacket } from '../../src/packet/build.mjs';
import { CODES, PublicationError } from '../../src/publication/errors.mjs';
import { createCloudflareWorker } from '../../src/publication/mocks/cloudflare-worker.mjs';
import { adapterFor } from '../../src/publication/targets.mjs';
import { REPO } from '../helpers.mjs';

export const KINDS = ['fs', 'mock-cloudflare'];
export const GRANTS = new Set(['upload', 'promote']);

// Build a synthetic packet; `variant` changes the title so content IDs differ.
export async function syntheticPacket(dir, variant = 'a', publication = { classification: 'private-review', dataOrigin: 'synthetic' }) {
  const src = join(dir, `src-${variant}`);
  await cp(join(REPO, 'fixtures/report'), src, { recursive: true });
  const path = join(src, 'phase1-review.report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.title = `${report.title} (synthetic ${variant})`;
  if (publication) report.publication = publication;
  else delete report.publication;
  await writeFile(path, JSON.stringify(report));
  const built = await buildPacket({ reportPath: path, outDir: join(dir, `packet-${variant}`) });
  return { dir: built.outDir, contentId: built.contentId };
}

// A fault-injecting wrapper for the fs adapter, with the mocks' fault names. Two faults
// are real filesystem failures, made with permissions for the length of one call:
//   failHistoryAppend: the alias history log is read-only, so V1's append fails after
//     its rename committed the record (and a repair append fails too);
//   failAliasWrite: the aliases directory is read-only, so the write fails before any
//     commit.
function faultyFs(inner, root) {
  const f = {};
  let lastPrevious = null;
  const take = (name) => { if (!f[name]) return false; f[name] -= 1; return true; };
  const wrapped = {
    ...inner,
    async putIfAbsent(req, bytes) {
      if (take('throttle')) throw new PublicationError(CODES.THROTTLED, 'injected');
      if (take('timeout')) throw new PublicationError(CODES.TIMEOUT, 'injected');
      if (f.failPutsAfter !== undefined) {
        if (f.failPutsAfter === 0) { delete f.failPutsAfter; throw new PublicationError(CODES.PROTOCOL, 'injected partial upload'); }
        f.failPutsAfter -= 1;
      }
      return inner.putIfAbsent(req, bytes);
    },
    async getObject(key) {
      const bytes = await inner.getObject(key);
      return bytes && take('corruptReads') ? Buffer.concat([bytes, Buffer.from('x')]) : bytes;
    },
    async readAlias(name) {
      if (take('staleAliasReads') && lastPrevious) return lastPrevious;
      return inner.readAlias(name);
    },
    async casAlias(name, g, id, opts) {
      if (take('failHistoryAppend')) return withMode(join(root, 'aliases', `${name}.history.jsonl`), 0o444, () => wrapped.casAliasInner(name, g, id, opts));
      if (take('failAliasWrite')) return withMode(join(root, 'aliases'), 0o555, () => wrapped.casAliasInner(name, g, id, opts));
      return wrapped.casAliasInner(name, g, id, opts);
    },
    async appendHistory(name, record) {
      if (take('failHistoryAppend')) return withMode(join(root, 'aliases', `${name}.history.jsonl`), 0o444, () => inner.appendHistory(name, record));
      return inner.appendHistory(name, record);
    },
    async casAliasInner(name, g, id) {
      // Fault raceAliasWrite: another promoter commits first (re-promoting the current
      // content at the next generation), so this CAS must lose.
      if (take('raceAliasWrite')) {
        const cur = await inner.readAlias(name);
        if (cur) await inner.casAlias(name, cur.generation, cur.contentId);
      }
      const before = await inner.readAlias(name);
      const r = await inner.casAlias(name, g, id);
      if (r.ok && before) lastPrevious = before;
      return r;
    },
    async writeReceipt(receipt) {
      if (take('failReceipts')) throw new PublicationError(CODES.RECEIPT_FAILED, 'injected');
      return inner.writeReceipt(receipt);
    },
  };
  return { adapter: wrapped, inject: (faults) => Object.assign(f, faults) };
}

async function withMode(path, mode, fn) {
  await chmod(path, mode);
  try {
    return await fn();
  } finally {
    await chmod(path, path.endsWith('.jsonl') ? 0o644 : 0o755);
  }
}

export async function harness(kind, t, { ceiling = 100, accessMode } = {}) {
  const dir = await mkdtemp(join(tmpdir(), `canon-v2-${kind}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clockMs = Date.parse('2026-09-26T12:00:00Z');
  const now = () => clockMs;
  const base = { name: kind === 'mock-cloudflare' ? 'cf-test' : 'local', kind, costCeilingUsdPerMonth: ceiling, ledgerDir: join(dir, 'ledger') };
  const h = { dir, kind, now, advance: (ms) => { clockMs += ms; }, clock: () => new Date(clockMs).toISOString() };
  if (kind === 'fs') {
    h.target = { ...base, root: join(dir, 'store'), accessMode: accessMode ?? 'local' };
    const { adapter, inject } = faultyFs(adapterFor(h.target), h.target.root);
    Object.assign(h, { adapter, inject, expireCredential: null, renewCredential: null, endpoint: null });
  } else if (kind === 'mock-cloudflare') {
    const endpoint = createCloudflareWorker({ now });
    h.target = { ...base, accessMode: accessMode ?? 'access-private', credentialEnv: 'RP_TEST_CF' };
    h.env = { RP_TEST_CF: JSON.stringify(endpoint.credentials()) };
    h.adapter = adapterFor(h.target, { env: h.env, endpoint });
    Object.assign(h, { endpoint, inject: (x) => endpoint.inject(x), expireCredential: () => endpoint.expireToken(), renewCredential: () => endpoint.renewToken(), secret: endpoint.credentials().clientSecret });
  } else {
    throw new Error(`no harness for target kind ${kind}`);
  }
  h.opts = (extra = {}) => ({ adapter: h.adapter, target: h.target, grants: GRANTS, clock: h.clock, retry: { sleep: async () => {} }, ...extra });
  return h;
}

// Every receipt a target holds, for schema and secret checks.
export async function allReceipts(h) {
  if (h.kind === 'fs') {
    const { readdir } = await import('node:fs/promises');
    const dir = join(h.target.root, 'receipts', 'v2');
    const names = await readdir(dir).catch(() => []);
    return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8'))));
  }
  if (h.kind === 'mock-cloudflare') return Object.values(h.endpoint.state.receipts).map((r) => JSON.parse(r));
  throw new Error(`allReceipts: no reader for kind ${h.kind}`);
}

// Every immutable or append-only thing a target holds, as key -> fingerprint: packet
// objects, receipts, and each alias-history entry. Mutable alias records are left out.
// Comparing two snapshots shows any overwrite (a key whose fingerprint changed) or
// deletion (a key that disappeared); new keys are allowed.
export async function storedObjects(h) {
  const { createHash } = await import('node:crypto');
  const { readdir } = await import('node:fs/promises');
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const out = new Map();
  if (h.kind === 'fs') {
    const walk = async (dir, prefix) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, `${prefix}${e.name}/`);
        else out.set(`${prefix}${e.name}`, sha(await readFile(p)));
      }
    };
    await walk(join(h.target.root, 'packets'), 'p/');
    await walk(join(h.target.root, 'receipts', 'v2'), 'receipts/');
    for (const n of await readdir(join(h.target.root, 'aliases')).catch(() => [])) {
      if (!n.endsWith('.history.jsonl')) continue;
      const lines = (await readFile(join(h.target.root, 'aliases', n), 'utf8')).split('\n').filter(Boolean);
      lines.forEach((l, i) => out.set(`history/${n}/${i}`, sha(l)));
    }
  } else if (h.kind === 'mock-cloudflare') {
    for (const [k, v] of Object.entries(h.endpoint.state.r2)) out.set(k, v.sha256);
    for (const [k, v] of Object.entries(h.endpoint.state.receipts)) out.set(`receipts/${k}`, sha(v));
    h.endpoint.state.d1.history.forEach((r, i) => out.set(`d1-history/${i}`, sha(JSON.stringify(r))));
  } else {
    throw new Error(`storedObjects: no reader for kind ${h.kind}`);
  }
  return out;
}
