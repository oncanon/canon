// V2 CLI commands (docs/v2/publication-protocol.md §6): publish --target, promote,
// rollback and reconcile. Every provider-reaching action needs its own explicit
// --grant; grants are only `upload` and `promote`. There is no delete, DNS or
// public-exposure command. Output is JSON and never contains a credential.
import { parseArgs } from 'node:util';
import { PublicationError } from './errors.mjs';
import { promote, publish, publishSite, reconcile, rollback } from './protocol.mjs';
import { adapterFor, findTarget, loadTargets } from './targets.mjs';

export const V2_USAGE = `  canon publish <packet-dir> --target <name> --targets <file> [--grant upload] [--dry-run] [--allow-render-policy-1]
  canon publish --site <site-bundle-dir> --target <name> --targets <file> [--grant upload] [--dry-run]
  canon promote --target <name> --targets <file> --alias <name> --content-id <id> --expect-generation <n> [--grant promote] [--dry-run]
  canon rollback --target <name> --targets <file> --alias <name> --to <content-id> --expect-generation <n> [--grant promote] [--dry-run]
  canon reconcile --target <name> --targets <file> [--grant promote]

  V2 targets: grants are explicit and separate (upload; promote). No command deletes,
  changes DNS or exposes a target publicly. A real cloudflare target is refused unless its
  target file sets an https://<worker>.workers.dev endpoint, its credential variable is
  set, and the command carries a grant.
  --dry-run prints the writes the command would send and sends nothing: it builds no
  transport and reads no credential.`;

const GRANTS = new Set(['upload', 'promote']);

const COMMON = { target: { type: 'string' }, targets: { type: 'string' }, grant: { type: 'string', multiple: true, default: [] }, 'dry-run': { type: 'boolean', default: false } };

function parse(args, extra, usage) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { ...COMMON, ...extra } });
  } catch (err) {
    usage(err.message);
  }
  const { values } = parsed;
  if (!values.target || !values.targets) usage('V2 commands need --target <name> and --targets <file>');
  for (const g of values.grant) if (!GRANTS.has(g)) usage(`unknown grant ${g}: grants are upload and promote`);
  return parsed;
}

function expectGeneration(values, usage) {
  if (!/^\d+$/.test(values['expect-generation'] ?? '')) usage('--expect-generation <n> is required (0 creates the alias)');
  return Number(values['expect-generation']);
}

async function run(fn) {
  try {
    const result = await fn();
    console.log(JSON.stringify({ ...result, receipt: result.receipt ? { receiptId: result.receipt.receiptId, state: result.receipt.state } : undefined }, null, 2));
    process.exit(0);
  } catch (err) {
    if (!(err instanceof PublicationError)) throw err;
    console.error(err.message);
    console.log(JSON.stringify({ error: err.code, state: err.details?.state ?? null }, null, 2));
    process.exit(1);
  }
}

async function context(values, { allowRenderPolicy1 = false } = {}) {
  const target = findTarget(await loadTargets(values.targets), values.target);
  const grants = new Set(values.grant);
  // A dry run sends nothing, so no adapter (and with it no transport or credential) is built.
  if (values['dry-run']) return { target, grants, dryRun: true };
  return { target, adapter: adapterFor(target, { grants, allowRenderPolicy1 }), grants };
}

export async function v2Publish(args, usage) {
  const { values, positionals } = parse(args, { site: { type: 'boolean', default: false }, 'allow-render-policy-1': { type: 'boolean', default: false } }, usage);
  if (positionals.length !== 1) usage('publish --target needs <packet-dir> (or --site <site-bundle-dir>)');
  if (values.site) await run(async () => publishSite({ ...(await context(values)), bundleDir: positionals[0] }));
  else {
    // render-policy-2.md R12: the one flag reaches both the protocol's gate and the fs store's own.
    const allowRenderPolicy1 = values['allow-render-policy-1'];
    await run(async () => publish({ ...(await context(values, { allowRenderPolicy1 })), packetDir: positionals[0], allowRenderPolicy1 }));
  }
}

export async function v2Promote(args, usage) {
  const { values } = parse(args, { alias: { type: 'string' }, 'content-id': { type: 'string' }, 'expect-generation': { type: 'string' } }, usage);
  if (!values.alias || !values['content-id']) usage('promote needs --alias and --content-id');
  const g = expectGeneration(values, usage);
  await run(async () => promote({ ...(await context(values)), alias: values.alias, contentId: values['content-id'], expectGeneration: g }));
}

export async function v2Rollback(args, usage) {
  const { values } = parse(args, { alias: { type: 'string' }, to: { type: 'string' }, 'expect-generation': { type: 'string' } }, usage);
  if (!values.alias || !values.to) usage('rollback needs --alias and --to <content-id>');
  const g = expectGeneration(values, usage);
  await run(async () => rollback({ ...(await context(values)), alias: values.alias, to: values.to, expectGeneration: g }));
}

export async function v2Reconcile(args, usage) {
  const { values } = parse(args, {}, usage);
  if (values['dry-run']) usage('reconcile has no dry run');
  await run(async () => reconcile(await context(values)));
}
