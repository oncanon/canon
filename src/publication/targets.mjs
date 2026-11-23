// Target configuration (publication-targets/v1) and adapter construction. A config
// file holds names and non-secret settings only; a credential is read from the
// environment variable the target names (credentialEnv) and is never written back.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cloudflareAdapter } from './adapters/cloudflare.mjs';
import { fsAdapter } from './adapters/fs.mjs';
import { CODES, PublicationError } from './errors.mjs';
import { createCloudflareWorker } from './mocks/cloudflare-worker.mjs';
import { assertTargetAvailable } from './policy.mjs';
import { canonicalPath } from './paths.mjs';
import { adminSigner } from './signing.mjs';
import { assertValid } from './schemas.mjs';
import { InProcessTransport } from './transport.mjs';
import { CloudflareHttpTransport } from './transports/cloudflare-http.mjs';

// Values that look like credentials must never appear in a target file.
const SECRETISH = /(secret|token|password|passwd|private[_-]?key|AKIA|ASIA|-----BEGIN)/i;

export async function loadTargets(path) {
  const raw = await readFile(path, 'utf8');
  const config = JSON.parse(raw);
  assertValid('publication-targets/v1', config, path);
  for (const t of config.targets) {
    for (const [k, v] of Object.entries(t)) {
      if (k !== 'credentialEnv' && typeof v === 'string' && SECRETISH.test(v)) throw new PublicationError(CODES.INVALID, `${path}: target ${t.name} field ${k} looks like a credential; targets hold no secrets`);
    }
  }
  const names = config.targets.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new PublicationError(CODES.INVALID, `${path}: duplicate target names`);
  const base = dirname(resolve(path));
  const targets = config.targets.map((t) => ({ ...t, ...(t.root ? { root: resolve(base, t.root) } : {}), ...(t.stateDir ? { stateDir: resolve(base, t.stateDir) } : {}), ...(t.ledgerDir ? { ledgerDir: resolve(base, t.ledgerDir) } : {}) }));
  // Public/private separation by construction (V2.1 slice 04, mode (c)): a public target
  // shares nothing with an access-controlled one: not its endpoint origin, credential,
  // state, root or ledger. A public target is never the private target with its mode
  // switched.
  for (const pub of targets.filter((x) => x.accessMode === 'public')) {
    for (const priv of targets.filter((x) => x.accessMode !== 'public')) {
      const shared = sharedSettings(pub, priv);
      if (shared.length) throw new PublicationError(CODES.INVALID, `${path}: public target ${pub.name} shares ${shared.join(', ')} with access-controlled target ${priv.name}`);
    }
  }
  return targets;
}

// A path as the filesystem resolves it (paths.mjs canonicalPath): symlinks are followed and, on a
// case-insensitive volume, case is canonical, so a public stateDir that is a symlink to, or a case
// variant of, a private one is the same directory (N-V21-2, N-V21-6).
function realPath(p) {
  return p === null ? null : canonicalPath(p);
}

// The settings two targets have in common, by effective value. The Worker name (the
// first label of the workers.dev host) is shared when either is a prefix of the other,
// so a public Worker is never named as a variant of a private one.
function sharedSettings(a, b) {
  const origin = (t) => (t.endpoint ? new URL(t.endpoint).origin : null);
  const ledger = (t) => realPath(t.ledgerDir ?? t.stateDir ?? t.root ?? null);
  const fields = [['endpoint', origin], ['credentialEnv', (t) => t.credentialEnv ?? null], ['stateDir', (t) => realPath(t.stateDir ?? null)], ['root', (t) => realPath(t.root ?? null)], ['ledger', ledger]];
  const shared = fields.filter(([, value]) => value(a) !== null && value(a) === value(b)).map(([name]) => name);
  const worker = (t) => (t.endpoint ? new URL(t.endpoint).hostname.split('.')[0] : null);
  const [wa, wb] = [worker(a), worker(b)];
  if (wa && wb && (wa.startsWith(wb) || wb.startsWith(wa))) shared.push('worker name prefix');
  return shared;
}

export function findTarget(targets, name) {
  const t = targets.find((x) => x.name === name);
  if (!t) throw new PublicationError(CODES.INVALID, `no target named ${name}`);
  return t;
}

function credentialFrom(env, target) {
  if (!target.credentialEnv) throw new PublicationError(CODES.INVALID, `target ${target.name} names no credentialEnv`);
  const raw = env[target.credentialEnv];
  if (!raw) throw new PublicationError(CODES.CREDENTIAL_MISSING, `no credential in $${target.credentialEnv} for target ${target.name}`);
  try {
    return JSON.parse(raw);
  } catch {
    // The message names the variable, never its value.
    throw new PublicationError(CODES.INVALID, `$${target.credentialEnv} is not JSON`);
  }
}

// Build the adapter for a target. `endpoint` lets tests hand in a mock they already
// hold (to inject faults); otherwise mock targets open their state directory.
// `grants` are the operation's explicit grants. `connectTo` is for tests only: a
// loopback origin a real transport connects to instead of its endpoint.
export function adapterFor(target, { env = process.env, endpoint = null, now, grants = null, connectTo = null, allowRenderPolicy1 = false } = {}) {
  assertTargetAvailable(target);
  if (target.kind === 'cloudflare') {
    // Refused by default (see assertTargetAvailable), and even with an endpoint only
    // for a granted operation and with the credential present in the environment.
    if (!grants || !['upload', 'promote'].some((g) => grants.has(g))) throw new PublicationError(CODES.GRANT_MISSING, `the real Cloudflare transport for ${target.name} is built only for a granted operation (--grant upload or --grant promote)`);
    const credentials = credentialFrom(env, target);
    // A public target (V2.1 slice 04) authenticates with its signing key alone: it has no
    // Access, so it is never given an Access credential, and a service token is refused.
    if (target.accessMode === 'public') {
      if (Object.keys(credentials).some((k) => k !== 'privateKey')) throw new PublicationError(CODES.INVALID, `$${target.credentialEnv} for a public target must be JSON with privateKey only`);
      const signer = adminSigner({ targetId: target.targetId, privateKey: credentials.privateKey, ...(now ? { now } : {}) });
      return cloudflareAdapter({ transport: new CloudflareHttpTransport({ endpoint: target.endpoint, allowCustomDomain: target.allowCustomDomain === true, connectTo }), credentials, kind: 'cloudflare', signer });
    }
    for (const field of ['clientId', 'clientSecret']) {
      if (typeof credentials[field] !== 'string' || !credentials[field]) throw new PublicationError(CODES.INVALID, `$${target.credentialEnv} must be JSON with a non-empty ${field}`);
    }
    return cloudflareAdapter({ transport: new CloudflareHttpTransport({ endpoint: target.endpoint, allowCustomDomain: target.allowCustomDomain === true, connectTo }), credentials, kind: 'cloudflare' });
  }
  if (target.kind === 'fs') {
    if (!target.root) throw new PublicationError(CODES.INVALID, `fs target ${target.name} needs root`);
    return fsAdapter({ root: target.root, allowRenderPolicy1 });
  }
  if (target.kind === 'mock-cloudflare') {
    const ep = endpoint ?? createCloudflareWorker({ stateDir: target.stateDir ?? null, ...(now ? { now } : {}) });
    return cloudflareAdapter({ transport: new InProcessTransport(ep), credentials: credentialFrom(env, target) });
  }
  throw new PublicationError(CODES.NOT_AVAILABLE, `no adapter for ${target.kind} in this phase`);
}
