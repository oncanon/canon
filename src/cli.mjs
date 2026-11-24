#!/usr/bin/env node
// canon: deterministic typesetting & sealing CLI.
// Exit status: 0 success, 1 verification/publication failure or rejected input, 2 usage error.
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AliasError, listAliases, readAlias, setAlias } from './alias/alias.mjs';
import { archivePacket } from './archive/tar.mjs';
import { BuildError, buildPacket } from './packet/build.mjs';
import { buildDocSet, DocSetError } from './doc/docset.mjs';
import { verifyDocSet } from './doc/verify.mjs';
import { DEFAULT_RENDER_POLICY, RENDER_POLICY_1, RENDER_POLICY_2 } from './policy.mjs';
import { formatWarning } from './report/lint.mjs';
import { verifyPacketFull as verifyPacket, verifyReissue } from './packet/reproduce.mjs';
import { activeVisibilityFromService, loadProfile, preferredBaseUrlFromService, ProfileError } from './profile.mjs';
import { PublishError, publishPacket } from './publish/filesystem.mjs';
import { makeReceipt, receiptPathInStore, writeReceipt } from './receipts.mjs';
import { ReportValidationError } from './report/validate.mjs';
import { BindError } from './server/bind.mjs';
import { startServer } from './server/server.mjs';
import { buildSiteBundle } from './site/build.mjs';
import { SiteInputValidationError } from './site/validate.mjs';
import { verifySiteBundle } from './site/verify.mjs';
import { V2_USAGE, v2Promote, v2Publish, v2Reconcile, v2Rollback } from './publication/cli-v2.mjs';
import { clean as serviceClean, paths as servicePaths, restart as serviceRestart, rotateLogIfOversize, ServiceError, start as serviceStart, startIdentity, status as serviceStatus, stop as serviceStop, readStateTolerant, writeStateAtomic } from './service.mjs';
import { main as publisherKeygen } from '../scripts/public-target-keygen.mjs';

const USAGE = `usage:
  canon build <report.json> --out <dir> [--receipt <file>] [--render-policy 1|2] [--reissue-of <packet-dir>]
  canon verify <packet-dir> [--json] [--reissue-of <old-packet-dir>]
  canon build-site <site-input.json> --out <dir> [--receipt <file>]
  canon verify-site <bundle-dir> [--json]
  canon build-docs <manifest.doc-set.json> --out <dir> [--receipt <file>]
  canon verify-docs <bundle-dir> [--json]
  canon publish <packet-dir> [--root <store>] [--build-receipt <file>] [--receipt <file>] [--allow-render-policy-1]
  canon alias set <name> <content-id> [--root <store>] --expect-generation <n>
  canon alias get <name> [--root <store>]
  canon alias list [--root <store>]
  canon status [--root <store>] [--state-dir <dir>]
  canon archive <packet-dir> --out <file.tar>
  canon key generate --out <path> | --print-once
  canon brief <report.json> [--store <store>] --alias <name> [--out <dir>] [--render-policy 1|2] [--reissue-of <packet-dir>] [--allow-render-policy-1]
  canon sitrep <site-input.json> [--store <store>] --alias <name> [--out <dir>]
  canon serve --root <store> [--port <n>] [--host <ip> | --tailscale] [--expect-tailscale-address <ipv4> --expect-tailscale-name <dns-name>] [--allow-host <name>]... [--state-file <file>] [--pid-file <file>]
  canon service start --root <store> [--state-dir dist/service] [--port 8791] [--host <ip> | --tailscale] [--expect-tailscale-address <ipv4> --expect-tailscale-name <dns-name>] [--allow-host <name>]...
  canon service status|stop|restart [--state-dir dist/service]
  canon service clean [--state-dir dist/service] [--store <store>]
  canon --version | -v
  canon --help | -h
${V2_USAGE}

  Binding: loopback (127.0.0.1) by default. A non-loopback bind must be named:
  --host <ip> (an IP literal on a local interface, private or Tailscale range) or
  --tailscale. Wildcards (0.0.0.0, ::), public, and link-local addresses are
  always refused. There is no authentication: anyone who can reach the bound
  address can read every packet in the store.
  --tailscale must name the node you expect, with --expect-tailscale-address
  and --expect-tailscale-name (its Self DNS name): a machine can run more than
  one Tailscale node, and any other node the tailscale CLI answers for is
  refused before listening. Read the values with "tailscale ip -4" and
  "tailscale status --json" (Self.DNSName, without the trailing dot).

  Render policy: --render-policy defaults to ${DEFAULT_RENDER_POLICY}. Once that default is
  render-policy/2, publishing a render-policy/1 packet into a store (publish, brief,
  publish --target) is refused unless --allow-render-policy-1 is given, and the override
  is recorded in the receipt. Aliases may still point at any packet already in the store.`;

function usage(message) {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(2);
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

// --render-policy 1|2 (render-policy-2.md R1). The default is DEFAULT_RENDER_POLICY
// (src/policy.mjs), which stays render-policy/1 until R10 acceptance moves it.
function renderPolicyArg(value) {
  if (value === undefined) return DEFAULT_RENDER_POLICY;
  if (value === '1') return RENDER_POLICY_1;
  if (value === '2') return RENDER_POLICY_2;
  return usage(`--render-policy must be 1 or 2, got ${JSON.stringify(value)}`);
}

// --reissue-of <packet-dir> (render-policy-2.md R8): a render-policy/2 field, so it needs
// --render-policy 2. The builder verifies the old packet and compares source digests.
function reissueOfArg(value, renderPolicy) {
  if (value === undefined) return null;
  if (!value) return usage('--reissue-of needs <packet-dir>');
  if (renderPolicy !== RENDER_POLICY_2) return usage('--reissue-of needs --render-policy 2 (reissueOf is a render-policy/2 field)');
  return resolve(value);
}

// R7: lint warnings go to stderr and never change the exit status.
function printWarnings(warnings) {
  for (const w of warnings ?? []) console.error(formatWarning(w));
}

function isExpectedFailure(err) {
  return err instanceof BuildError || err instanceof ReportValidationError || err instanceof SiteInputValidationError || err instanceof PublishError || err instanceof AliasError || err instanceof ProfileError || err instanceof DocSetError;
}

async function tryLoadProfileOrExit() {
  try {
    return await loadProfile();
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// When --store or --root is passed explicitly, reading $CANON_HOME/profile.json is
// purely best-effort (to populate live URLs when the store matches), so sandboxed
// EPERM/EACCES or an unrelated broken profile never blocks an explicit store target.
async function tryLoadOptionalProfile() {
  try {
    return await loadProfile();
  } catch {
    return null;
  }
}

async function liveUrlsForStore(store, profile, aliasName, contentId, agentEntry) {
  if (!profile || resolve(profile.storeRoot) !== resolve(store)) return null;
  const st = await serviceStatus(profile.stateDir).catch(() => null);
  const baseUrl = preferredBaseUrlFromService(st);
  const activeRoot = st?.root ?? st?.recorded?.root;
  if (!baseUrl || !activeRoot || resolve(activeRoot) !== resolve(store)) return null;
  return {
    baseUrl,
    visibility: activeVisibilityFromService(st) ?? profile.exposure,
    humanAlias: `${baseUrl}/a/${aliasName}/`,
    agentAlias: `${baseUrl}/a/${aliasName}/${agentEntry}`,
    humanImmutable: `${baseUrl}/p/${contentId}/`,
    agentImmutable: `${baseUrl}/p/${contentId}/${agentEntry}`,
  };
}

async function cmdBuild(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' }, receipt: { type: 'string' }, 'render-policy': { type: 'string' }, 'reissue-of': { type: 'string' } } });
  if (positionals.length !== 1 || !values.out) usage('build needs <report.json> and --out');
  const renderPolicy = renderPolicyArg(values['render-policy']);
  const reissueOfDir = reissueOfArg(values['reissue-of'], renderPolicy);
  const startedAt = new Date();
  const receiptPath = values.receipt ?? `${resolve(values.out)}.build-receipt.json`;
  try {
    const result = await buildPacket({ reportPath: positionals[0], outDir: values.out, renderPolicy, reissueOfDir });
    printWarnings(result.warnings);
    const totalBytes = [...result.output.values()].reduce((n, b) => n + b.length, 0);
    const receipt = makeReceipt({
      operation: 'build', provider: 'local-builder', contentId: result.contentId,
      destination: { kind: 'directory', path: result.outDir }, startedAt, finishedAt: new Date(),
      fileCount: result.output.size, totalBytes, manifestSha256: result.checksums.manifestSha256, outcome: 'built',
      warnings: result.warnings,
    });
    await writeReceipt(receipt, receiptPath);
    print({ contentId: result.contentId, outDir: result.outDir, manifestSha256: receipt.manifestSha256, fileCount: receipt.fileCount, totalBytes, receipt: resolve(receiptPath) });
  } catch (err) {
    if (!isExpectedFailure(err)) throw err;
    const receipt = makeReceipt({ operation: 'build', provider: 'local-builder', contentId: null, destination: { kind: 'directory', path: resolve(values.out) }, startedAt, finishedAt: new Date(), errorClass: err.code ?? 'report-invalid' });
    await writeReceipt(receipt, receiptPath).catch(() => {});
    console.error(err.message);
    process.exit(1);
  }
}

async function cmdVerify(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, 'reissue-of': { type: 'string' } } });
  if (positionals.length !== 1) usage('verify needs <packet-dir>');
  if (values['reissue-of'] !== undefined) {
    if (!values['reissue-of']) usage('--reissue-of needs <old-packet-dir>');
    const result = await verifyReissue(resolve(positionals[0]), resolve(values['reissue-of']));
    if (values.json) print(result);
    else if (result.ok) console.log(`OK ${result.contentId} is a reissue of ${result.reissueOf}`);
    else for (const e of result.errors) console.error(`FAIL ${e.code} ${e.path}: ${e.message}`);
    process.exit(result.ok ? 0 : 1);
  }
  const result = await verifyPacket(resolve(positionals[0]));
  if (values.json) print(result);
  else if (result.ok) console.log(`OK ${result.contentId} (${result.fileCount} files, ${result.totalBytes} bytes, manifest sha256 ${result.manifestSha256})`);
  else for (const e of result.errors) console.error(`FAIL ${e.code} ${e.path}: ${e.message}`);
  process.exit(result.ok ? 0 : 1);
}

async function cmdBuildSite(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' }, receipt: { type: 'string' } } });
  if (positionals.length !== 1 || !values.out) usage('build-site needs <site-input.json> and --out');
  const startedAt = new Date();
  const receiptPath = values.receipt ?? `${resolve(values.out)}.build-receipt.json`;
  try {
    const result = await buildSiteBundle({ sitePath: positionals[0], outDir: values.out });
    const totalBytes = [...result.output.values()].reduce((n, b) => n + b.length, 0);
    const receipt = makeReceipt({
      operation: 'build', provider: 'local-builder', contentId: result.contentId,
      destination: { kind: 'directory', path: result.outDir }, startedAt, finishedAt: new Date(),
      fileCount: result.output.size, totalBytes, manifestSha256: result.checksums.manifestSha256, outcome: 'built',
    });
    await writeReceipt(receipt, receiptPath);
    print({ contentId: result.contentId, outDir: result.outDir, manifestSha256: receipt.manifestSha256, fileCount: receipt.fileCount, totalBytes, receipt: resolve(receiptPath) });
  } catch (err) {
    if (!isExpectedFailure(err)) throw err;
    const receipt = makeReceipt({ operation: 'build', provider: 'local-builder', contentId: null, destination: { kind: 'directory', path: resolve(values.out) }, startedAt, finishedAt: new Date(), errorClass: err.code ?? 'report-invalid' });
    await writeReceipt(receipt, receiptPath).catch(() => {});
    console.error(err.message);
    process.exit(1);
  }
}

async function cmdVerifySite(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) usage('verify-site needs <bundle-dir>');
  const result = await verifySiteBundle(resolve(positionals[0]));
  if (values.json) print(result);
  else if (result.ok) console.log(`OK ${result.contentId} (${result.fileCount} files, ${result.totalBytes} bytes, manifest sha256 ${result.manifestSha256})`);
  else for (const e of result.errors) console.error(`FAIL ${e.code} ${e.path}: ${e.message}`);
  process.exit(result.ok ? 0 : 1);
}

async function cmdBuildDocs(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' }, receipt: { type: 'string' } } });
  if (positionals.length !== 1 || !values.out) usage('build-docs needs <manifest.doc-set.json> and --out');
  const startedAt = new Date();
  const receiptPath = values.receipt ?? `${resolve(values.out)}.build-receipt.json`;
  // writePacketDirectory (src/packet/build.mjs) makes its staging dir a sibling of --out
  // with mkdir's recursive: false, so a --out whose parent does not exist yet fails with a
  // raw ENOENT instead of a clear, expected error. Ensuring the parent exists first (the
  // same thing cmdBrief/cmdSitrep already do for their own computed --out paths above)
  // makes an --out nested under directories that don't exist yet build cleanly.
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  try {
    const result = await buildDocSet({ manifestPath: positionals[0], outDir: values.out });
    const totalBytes = [...result.output.values()].reduce((n, b) => n + b.length, 0);
    const receipt = makeReceipt({
      operation: 'build', provider: 'local-builder', contentId: result.contentId,
      destination: { kind: 'directory', path: result.outDir }, startedAt, finishedAt: new Date(),
      fileCount: result.output.size, totalBytes, manifestSha256: result.checksums.manifestSha256, outcome: 'built',
    });
    // overwrite: true — this receipt describes the latest build attempt into --out, not a
    // store history entry (receiptPathInStore's own receipts stay exclusive-create). Once
    // the prior build's own output directory is gone, a stale receipt beside it must not
    // block a rebuild into the same --out.
    await writeReceipt(receipt, receiptPath, { overwrite: true });
    print({ contentId: result.contentId, outDir: result.outDir, manifestSha256: receipt.manifestSha256, fileCount: receipt.fileCount, totalBytes, receipt: resolve(receiptPath) });
  } catch (err) {
    if (!isExpectedFailure(err)) throw err;
    const receipt = makeReceipt({ operation: 'build', provider: 'local-builder', contentId: null, destination: { kind: 'directory', path: resolve(values.out) }, startedAt, finishedAt: new Date(), errorClass: err.code ?? 'doc-set-invalid' });
    await writeReceipt(receipt, receiptPath, { overwrite: true }).catch(() => {});
    console.error(err.message);
    process.exit(1);
  }
}

async function cmdVerifyDocs(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) usage('verify-docs needs <bundle-dir>');
  const result = await verifyDocSet(resolve(positionals[0]));
  if (values.json) print(result);
  else if (result.ok) console.log(`OK ${result.contentId}`);
  else for (const e of result.errors) console.error(`FAIL ${e.code} ${e.path}: ${e.message}`);
  process.exit(result.ok ? 0 : 1);
}

async function cmdPublish(args) {
  // V2: publishing to a named target is additive; without --target this is V1.
  if (args.includes('--target')) return v2Publish(args, usage);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { root: { type: 'string' }, 'build-receipt': { type: 'string' }, receipt: { type: 'string' }, 'allow-render-policy-1': { type: 'boolean', default: false } } });
  const profile = values.root ? null : await tryLoadProfileOrExit();
  const rootVal = values.root ?? profile?.storeRoot;
  if (positionals.length !== 1 || !rootVal) usage('publish needs <packet-dir> and --root (or $CANON_HOME/profile.json)');
  const startedAt = new Date();
  const expectedBuild = values['build-receipt'] ? JSON.parse(await readFile(values['build-receipt'], 'utf8')) : undefined;
  const root = resolve(rootVal);
  let receipt;
  let exitCode = 0;
  let result;
  try {
    result = await publishPacket({ packetDir: positionals[0], root, expectedBuild, allowRenderPolicy1: values['allow-render-policy-1'] });
    receipt = makeReceipt({
      operation: 'publish', provider: 'filesystem', contentId: result.contentId,
      destination: { kind: 'filesystem-store', path: result.target }, startedAt, finishedAt: new Date(),
      fileCount: result.fileCount, totalBytes: result.totalBytes, manifestSha256: result.readBack.manifestSha256,
      outcome: result.outcome, readBack: result.readBack, admissionOverride: result.admissionOverride ?? null,
    });
  } catch (err) {
    if (!(err instanceof PublishError)) throw err;
    receipt = makeReceipt({ operation: 'publish', provider: 'filesystem', contentId: expectedBuild?.contentId ?? null, destination: { kind: 'filesystem-store', path: root }, startedAt, finishedAt: new Date(), errorClass: err.code });
    console.error(err.message);
    for (const e of err.details.errors ?? []) console.error(`  ${e.code} ${e.path}: ${e.message}`);
    exitCode = 1;
  }
  const written = await writeReceipt(receipt, values.receipt ?? receiptPathInStore(root, receipt));
  if (result) print({ ...result, receipt: written });
  process.exit(exitCode);
}

async function cmdAlias(args) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { root: { type: 'string' }, 'expect-generation': { type: 'string' } } });
  const profile = values.root ? null : await tryLoadProfileOrExit();
  const rootVal = values.root ?? profile?.storeRoot;
  if (!rootVal) usage('alias needs --root (or $CANON_HOME/profile.json)');
  try {
    if (sub === 'list' && positionals.length === 0) {
      print(await listAliases(rootVal));
    } else if (sub === 'get' && positionals.length === 1) {
      const record = await readAlias(rootVal, positionals[0]);
      if (!record) {
        console.error(`alias ${positionals[0]} not found`);
        process.exit(1);
      }
      print(record);
    } else if (sub === 'set' && positionals.length === 2) {
      if (values['expect-generation'] === undefined || !/^\d+$/.test(values['expect-generation'])) usage('alias set needs --expect-generation <n> (0 creates)');
      const startedAt = new Date();
      const record = await setAlias({ root: rootVal, name: positionals[0], contentId: positionals[1], expectGeneration: Number(values['expect-generation']) });
      const receipt = makeReceipt({ operation: 'alias', provider: 'filesystem', contentId: record.contentId, destination: { kind: 'alias-record', path: resolve(rootVal, 'aliases', `${record.name}.json`) }, startedAt, finishedAt: new Date(), outcome: 'updated', alias: { name: record.name, generation: record.generation, previousContentId: record.previousContentId } });
      const written = await writeReceipt(receipt, receiptPathInStore(rootVal, receipt));
      print({ ...record, receipt: written });
    } else {
      usage();
    }
  } catch (err) {
    if (!(err instanceof AliasError || err instanceof PublishError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

async function cmdStatus(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { root: { type: 'string' }, 'state-dir': { type: 'string' } } });
  if (positionals.length !== 0) usage('status takes no positional arguments');
  const profile = values.root ? await tryLoadOptionalProfile() : await tryLoadProfileOrExit();
  const storeRoot = values.root ? resolve(values.root) : (profile?.storeRoot ?? null);
  const stateDir = values['state-dir'] ? resolve(values['state-dir']) : (profile?.stateDir ?? null);
  if (!storeRoot) usage('status needs --root <store> (or $CANON_HOME/profile.json)');
  try {
    const st = stateDir ? await serviceStatus(stateDir) : null;
    const aliases = await listAliases(storeRoot);
    print({
      profile: profile
        ? { configured: true, path: profile.path, exposure: profile.exposure, port: profile.port, tailscale: profile.tailscale }
        : { configured: false, path: null, exposure: null, port: null, tailscale: null },
      storeRoot,
      service: st
        ? {
            state: st.state,
            visibility: activeVisibilityFromService(st),
            pid: st.pid ?? null,
            storeRoot: st.root ?? st.recorded?.root ?? null,
            urls: st.urls ?? st.recorded?.urls ?? (st.url ? [st.url] : []),
            preferredBaseUrl: preferredBaseUrlFromService(st),
            stateDir: st.paths.dir,
          }
        : null,
      aliases,
    });
  } catch (err) {
    if (!isExpectedFailure(err) && !(err instanceof ServiceError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

async function cmdArchive(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' } } });
  if (positionals.length !== 1 || !values.out) usage('archive needs <packet-dir> and --out');
  const { contentId, bytes } = await archivePacket(resolve(positionals[0]));
  await writeFile(values.out, bytes, { flag: 'wx' });
  print({ contentId, archive: resolve(values.out), bytes: bytes.length });
}

// SH-6: exposes the already-reviewed keygen (scripts/public-target-keygen.mjs) as
// `canon key generate`, reusing its own refusals (inside the repo, inside a git worktree,
// an existing file) rather than re-implementing them.
async function cmdKey(args) {
  const [sub, ...rest] = args;
  if (sub !== 'generate') usage();
  const code = publisherKeygen(rest);
  if (code !== 0) process.exit(code);
}

const DEFAULT_PORT = '8791';

// The two --expect-tailscale-* flags as resolveBind's expectTailscale, or undefined when
// neither is given. One without the other is passed on as it is, and refused there.
const EXPECT_TAILSCALE_OPTIONS = { 'expect-tailscale-address': { type: 'string' }, 'expect-tailscale-name': { type: 'string' } };
function expectTailscaleOf(values) {
  const address = values['expect-tailscale-address'];
  const name = values['expect-tailscale-name'];
  return address === undefined && name === undefined ? undefined : { address, name };
}

async function cmdServe(args) {
  const { values } = parseArgs({ args, options: {
    root: { type: 'string' }, host: { type: 'string' }, tailscale: { type: 'boolean', default: false },
    'allow-host': { type: 'string', multiple: true, default: [] }, port: { type: 'string', default: DEFAULT_PORT },
    'pid-file': { type: 'string' }, 'state-file': { type: 'string' }, ...EXPECT_TAILSCALE_OPTIONS,
  } });
  if (!values.root) usage('serve needs --root');
  // Under `canon service start`, stdio fd 2 is server.log itself (src/service.mjs); rotate
  // it in place once it grows past the cap. A foreground `canon serve` has no --state-file,
  // so fd 2 is a terminal or pipe, rotateLogIfOversize is a no-op, and logging is unlimited.
  const serveLogPath = values['state-file'] ? servicePaths(dirname(resolve(values['state-file']))).log : null;
  let started;
  try {
    started = await startServer({ root: resolve(values.root), host: values.host, tailscale: values.tailscale, allowHosts: values['allow-host'], expectTailscale: expectTailscaleOf(values), port: Number(values.port), log: (entry) => {
      console.error(JSON.stringify(entry));
      if (serveLogPath) rotateLogIfOversize(2, serveLogPath);
    } });
  } catch (err) {
    if (!(err instanceof BindError) && err.code !== 'EADDRINUSE' && err.code !== 'EADDRNOTAVAIL') throw err;
    console.error(err.code === 'EADDRINUSE' ? `port ${values.port} is already in use; choose another --port` : err.message);
    process.exit(1);
  }
  const { server, url, urls, address, bind, allowedHosts } = started;
  const hostHeader = `${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  if (values['pid-file']) await writeFile(values['pid-file'], `${process.pid}\n`, { flag: 'wx' });
  if (values['state-file']) {
    await mkdir(dirname(resolve(values['state-file'])), { recursive: true });
    // This process's own start identity (see startIdentity): exact, because it asks about itself.
    const ownStart = startIdentity(process.pid);
    const state = { pid: process.pid, ...(ownStart ? { startIdentity: ownStart } : {}), url, urls, bind: bind.kind, address: address.address, port: address.port, hostHeader, allowedHosts, root: resolve(values.root), startedAt: new Date().toISOString() };
    await writeStateAtomic(values['state-file'], state);
  }
  const exposure = bind.kind === 'loopback' ? 'loopback only' : `${bind.kind} interface; no authentication, reachable by anyone who can reach ${address.address}`;
  console.log(`serving ${resolve(values.root)} at ${urls.map((u) => `${u}/`).join(' and ')} (${exposure}; pid ${process.pid})`);
  const stop = async () => {
    server.close();
    if (values['pid-file']) await unlink(values['pid-file']).catch(() => {});
    if (values['state-file']) {
      // Remove the state file only if it still describes this process.
      const current = await readStateTolerant(values['state-file']).catch(() => null);
      if (current?.pid === process.pid) await unlink(values['state-file']).catch(() => {});
    }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const SERVICE_EXIT = { running: 0, stopped: 1, stale: 2, unhealthy: 3, orphaned: 5 };

async function cmdService(args) {
  const [sub, ...rest] = args;
  const { values } = parseArgs({ args: rest, options: {
    'state-dir': { type: 'string', default: 'dist/service' }, root: { type: 'string' }, store: { type: 'string' },
    host: { type: 'string' }, tailscale: { type: 'boolean', default: false }, 'allow-host': { type: 'string', multiple: true, default: [] },
    port: { type: 'string', default: DEFAULT_PORT }, ...EXPECT_TAILSCALE_OPTIONS,
  } });
  const stateDir = values['state-dir'];
  try {
    if (sub === 'start') {
      if (!values.root) usage('service start needs --root <store>');
      print(await serviceStart({ stateDir, root: values.root, host: values.host, tailscale: values.tailscale, allowHosts: values['allow-host'], expectTailscale: expectTailscaleOf(values), port: Number(values.port) }));
    } else if (sub === 'status') {
      const st = await serviceStatus(stateDir);
      print({ ...st, paths: undefined, stateDir: st.paths.dir, log: st.paths.log });
      process.exit(SERVICE_EXIT[st.state]);
    } else if (sub === 'stop') {
      print(await serviceStop({ stateDir }));
    } else if (sub === 'restart') {
      print(await serviceRestart({ stateDir }));
    } else if (sub === 'clean') {
      print(await serviceClean({ stateDir, store: values.store }));
    } else {
      usage(`unknown service subcommand ${sub ?? ''}`);
    }
  } catch (err) {
    if (!(err instanceof ServiceError || err instanceof BindError)) throw err;
    console.error(err.message);
    process.exit(err.code === 'port-in-use' ? 4 : err.code === 'orphaned' ? 5 : err.code === 'state-corrupt' ? 6 : 1);
  }
}

// One-step reuse path: build -> verify -> publish -> alias (compare-and-swap on the
// generation just read, so a concurrent alias change still fails loudly).
async function cmdBrief(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { store: { type: 'string' }, alias: { type: 'string' }, out: { type: 'string' }, 'render-policy': { type: 'string' }, 'reissue-of': { type: 'string' }, 'allow-render-policy-1': { type: 'boolean', default: false } } });
  const renderPolicy = renderPolicyArg(values['render-policy']);
  const reissueOfDir = reissueOfArg(values['reissue-of'], renderPolicy);
  const profile = values.store ? await tryLoadOptionalProfile() : await tryLoadProfileOrExit();
  const storeVal = values.store ?? profile?.storeRoot;
  if (positionals.length !== 1 || !storeVal || !values.alias) usage('brief needs <report.json>, --alias, and --store (or $CANON_HOME/profile.json)');
  const store = resolve(storeVal);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const buildsBase = (!values.store && profile?.buildsDir) ? profile.buildsDir : join(dirname(store), 'builds');
  const out = resolve(values.out ?? join(buildsBase, `build-${stamp}-${process.pid}`));
  await mkdir(dirname(out), { recursive: true });
  const receiptPath = `${out}.build-receipt.json`;
  const startedAt = new Date();
  try {
    const built = await buildPacket({ reportPath: positionals[0], outDir: out, renderPolicy, reissueOfDir });
    printWarnings(built.warnings);
    const totalBytes = [...built.output.values()].reduce((n, b) => n + b.length, 0);
    const buildReceipt = makeReceipt({ operation: 'build', provider: 'local-builder', contentId: built.contentId, destination: { kind: 'directory', path: out }, startedAt, finishedAt: new Date(), fileCount: built.output.size, totalBytes, manifestSha256: built.checksums.manifestSha256, outcome: 'built', warnings: built.warnings });
    await writeReceipt(buildReceipt, receiptPath);
    const verified = await verifyPacket(out);
    if (!verified.ok) throw new PublishError('source-invalid', 'freshly built packet does not verify', { errors: verified.errors });
    const pubStarted = new Date();
    const pub = await publishPacket({ packetDir: out, root: store, expectedBuild: buildReceipt, allowRenderPolicy1: values['allow-render-policy-1'] });
    await writeReceipt(makeReceipt({ operation: 'publish', provider: 'filesystem', contentId: pub.contentId, destination: { kind: 'filesystem-store', path: pub.target }, startedAt: pubStarted, finishedAt: new Date(), fileCount: pub.fileCount, totalBytes: pub.totalBytes, manifestSha256: pub.readBack.manifestSha256, outcome: pub.outcome, readBack: pub.readBack, admissionOverride: pub.admissionOverride ?? null }), receiptPathInStore(store, { startedAt: pubStarted.toISOString(), operation: 'publish', contentId: pub.contentId }));
    const current = await readAlias(store, values.alias);
    let alias = current;
    if (current?.contentId !== pub.contentId) {
      const aliasStarted = new Date();
      alias = await setAlias({ root: store, name: values.alias, contentId: pub.contentId, expectGeneration: current ? current.generation : 0 });
      await writeReceipt(makeReceipt({ operation: 'alias', provider: 'filesystem', contentId: alias.contentId, destination: { kind: 'alias-record', path: join(store, 'aliases', `${alias.name}.json`) }, startedAt: aliasStarted, finishedAt: new Date(), outcome: 'updated', alias: { name: alias.name, generation: alias.generation, previousContentId: alias.previousContentId } }), receiptPathInStore(store, { startedAt: aliasStarted.toISOString(), operation: 'alias', contentId: alias.contentId }));
    }
    const urls = await liveUrlsForStore(store, profile, alias.name, pub.contentId, 'report.md');
    print({ contentId: pub.contentId, build: out, buildReceipt: receiptPath, publish: pub.outcome, alias: { name: alias.name, generation: alias.generation, changed: current?.contentId !== pub.contentId }, paths: { alias: `/a/${alias.name}/`, packet: `/p/${pub.contentId}/`, markdown: `/p/${pub.contentId}/report.md` }, urls });
  } catch (err) {
    if (!isExpectedFailure(err)) throw err;
    console.error(err.message);
    for (const e of err.errors ?? err.details?.errors ?? []) console.error(`  ${e.code} ${e.path}: ${e.message}`);
    process.exit(1);
  }
}

// One-step multi-page SitRep pathway: build-site -> verify-site -> publish -> alias
async function cmdSitrep(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { store: { type: 'string' }, alias: { type: 'string' }, out: { type: 'string' } } });
  const profile = values.store ? await tryLoadOptionalProfile() : await tryLoadProfileOrExit();
  const storeVal = values.store ?? profile?.storeRoot;
  if (positionals.length !== 1 || !storeVal || !values.alias) usage('sitrep needs <site-input.json>, --alias, and --store (or $CANON_HOME/profile.json)');
  const store = resolve(storeVal);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const buildsBase = (!values.store && profile?.buildsDir) ? profile.buildsDir : join(dirname(store), 'builds');
  const out = resolve(values.out ?? join(buildsBase, `sitrep-${stamp}-${process.pid}`));
  await mkdir(dirname(out), { recursive: true });
  const receiptPath = `${out}.build-receipt.json`;
  const startedAt = new Date();
  try {
    const built = await buildSiteBundle({ sitePath: positionals[0], outDir: out });
    const totalBytes = [...built.output.values()].reduce((n, b) => n + b.length, 0);
    const buildReceipt = makeReceipt({ operation: 'build', provider: 'local-builder', contentId: built.contentId, destination: { kind: 'directory', path: out }, startedAt, finishedAt: new Date(), fileCount: built.output.size, totalBytes, manifestSha256: built.checksums.manifestSha256, outcome: 'built' });
    await writeReceipt(buildReceipt, receiptPath);
    const verified = await verifySiteBundle(out);
    if (!verified.ok) throw new PublishError('source-invalid', 'freshly built site-bundle/v1 does not verify', { errors: verified.errors });
    const pubStarted = new Date();
    const pub = await publishPacket({ packetDir: out, root: store, expectedBuild: buildReceipt });
    await writeReceipt(makeReceipt({ operation: 'publish', provider: 'filesystem', contentId: pub.contentId, destination: { kind: 'filesystem-store', path: pub.target }, startedAt: pubStarted, finishedAt: new Date(), fileCount: pub.fileCount, totalBytes: pub.totalBytes, manifestSha256: pub.readBack.manifestSha256, outcome: pub.outcome, readBack: pub.readBack }), receiptPathInStore(store, { startedAt: pubStarted.toISOString(), operation: 'publish', contentId: pub.contentId }));
    const current = await readAlias(store, values.alias);
    let alias = current;
    if (current?.contentId !== pub.contentId) {
      const aliasStarted = new Date();
      alias = await setAlias({ root: store, name: values.alias, contentId: pub.contentId, expectGeneration: current ? current.generation : 0 });
      await writeReceipt(makeReceipt({ operation: 'alias', provider: 'filesystem', contentId: alias.contentId, destination: { kind: 'alias-record', path: join(store, 'aliases', `${alias.name}.json`) }, startedAt: aliasStarted, finishedAt: new Date(), outcome: 'updated', alias: { name: alias.name, generation: alias.generation, previousContentId: alias.previousContentId } }), receiptPathInStore(store, { startedAt: aliasStarted.toISOString(), operation: 'alias', contentId: alias.contentId }));
    }
    const urls = await liveUrlsForStore(store, profile, alias.name, pub.contentId, 'index.md');
    print({ contentId: pub.contentId, build: out, buildReceipt: receiptPath, publish: pub.outcome, alias: { name: alias.name, generation: alias.generation, changed: current?.contentId !== pub.contentId }, paths: { alias: `/a/${alias.name}/`, bundle: `/p/${pub.contentId}/`, html: `/p/${pub.contentId}/index.html`, markdown: `/p/${pub.contentId}/index.md` }, urls });
  } catch (err) {
    if (!isExpectedFailure(err)) throw err;
    console.error(err.message);
    for (const e of err.errors ?? err.details?.errors ?? []) console.error(`  ${e.code} ${e.path}: ${e.message}`);
    process.exit(1);
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  if (rest.length > 0) usage(`${command} takes no other arguments`);
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(version);
  process.exit(0);
}
if (command === '--help' || command === '-h') {
  if (rest.length > 0) usage(`${command} takes no other arguments`);
  console.log(USAGE);
  process.exit(0);
}

const commands = {
  build: cmdBuild, verify: cmdVerify, 'build-site': cmdBuildSite, 'verify-site': cmdVerifySite,
  'build-docs': cmdBuildDocs, 'verify-docs': cmdVerifyDocs,
  publish: cmdPublish, alias: cmdAlias, status: cmdStatus, archive: cmdArchive, key: cmdKey, brief: cmdBrief, sitrep: cmdSitrep, serve: cmdServe, service: cmdService,
  promote: (a) => v2Promote(a, usage), rollback: (a) => v2Rollback(a, usage), reconcile: (a) => v2Reconcile(a, usage),
};
if (!commands[command]) usage(command ? `unknown command ${command}` : undefined);
commands[command](rest).catch((err) => {
  // node:util parseArgs in strict mode throws ERR_PARSE_ARGS_UNKNOWN_OPTION /
  // ERR_PARSE_ARGS_INVALID_OPTION_VALUE for any bad flag reaching a subcommand's own
  // parseArgs call (including --help or --version after a subcommand, which are not
  // options any subcommand defines). Its message already names the option on one line;
  // treat it as the usage error it is instead of a crash.
  if (err?.code?.startsWith('ERR_PARSE_ARGS')) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err.stack ?? String(err));
  process.exit(1);
});
