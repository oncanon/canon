#!/usr/bin/env node
// V2-QA-6 evidence: the IaC gate's planted cases are real HCL, and the in-repo scanner reads
// them as Terraform does. For every case, `terraform fmt -` and `tofu fmt -` (stdin to
// stdout; exit 0 only for valid syntax) run inside a deny-network sandbox with
// CHECKPOINT_DISABLE=1, so neither tool can reach the network or HashiCorp's checkpoint
// service. Nothing is written to disk; no init, validate, plan or download.
//
//   node scripts/hcl-fmt-acceptance.mjs            (prints JSON; exit 0 only if all hold)
//
// Required: every VALID case (the committed .tf files, QA's B1-B9 and regression payloads, every red
// control on a .tf file, the scanner's valid snippets) is accepted by both tools AND parsed
// by scripts/hcl-scan.mjs, with the same blocks and attribute keys before and after fmt
// rewrites it; every INVALID snippet is rejected by both tools AND by the scanner.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanHcl } from './hcl-scan.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TF_DIR = 'infra/cloudflare/terraform';
const PUBLIC_TF_DIR = 'infra/cloudflare/terraform-public';
const PROFILE = '(version 1)(allow default)(deny network*)';
const TOOLS = ['terraform', 'tofu'];

function fmt(tool, text) {
  const r = spawnSync('sandbox-exec', ['-p', PROFILE, tool, 'fmt', '-no-color', '-'], { input: text, encoding: 'utf8', env: { ...process.env, CHECKPOINT_DISABLE: '1' } });
  if (r.error) throw r.error;
  return { exit: r.status, out: r.stdout, err: r.stderr.split('\n').filter(Boolean).slice(0, 2).join(' | ') };
}
const shape = (text) => {
  const s = scanHcl(text);
  return JSON.stringify([s.blocks.map((b) => b.blockPath), s.attributes.map((a) => `${a.path}:${a.name}`)]);
};
function scanOk(text) {
  try {
    return { ok: true, shape: shape(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function acceptance() {
  const { QA_CASES, QA_IAC_REGRESSION, HCL_VALID, HCL_INVALID, PUBLIC_CASES } = await import(pathToFileURL(join(REPO, 'test/iac-cases.mjs')).href);
  const { CONTROLS } = await import(pathToFileURL(join(REPO, 'scripts/red-controls.mjs')).href);
  const read = (f) => readFileSync(join(REPO, TF_DIR, f), 'utf8');
  const valid = [];
  for (const f of readdirSync(join(REPO, TF_DIR)).filter((x) => x.endsWith('.tf'))) valid.push({ name: `committed ${f}`, text: read(f) });
  for (const c of QA_CASES) valid.push({ name: `QA ${c.name}`, text: c.mutate(read(c.file)) });
  const tfFiles = readdirSync(join(REPO, TF_DIR));
  for (const c of QA_IAC_REGRESSION) valid.push({ name: `QA ${c.id}`, text: c.mutate(tfFiles.includes(c.file) ? read(c.file) : '') });
  for (const c of CONTROLS.filter((x) => x.file.startsWith(`${TF_DIR}/`) && x.file.endsWith('.tf'))) {
    const src = readFileSync(join(REPO, c.file), 'utf8');
    valid.push({ name: `control ${c.id}`, text: src.replace(c.find, () => c.replace), applied: src.includes(c.find) });
  }
  for (const [k, text] of Object.entries(HCL_VALID)) valid.push({ name: `scanner ${k}`, text });
  // V2.1 slice 04: the public root module, its planted cases (either module) and its red controls.
  const dirOf = { public: PUBLIC_TF_DIR, private: TF_DIR };
  for (const f of readdirSync(join(REPO, PUBLIC_TF_DIR)).filter((x) => x.endsWith('.tf'))) valid.push({ name: `committed public ${f}`, text: readFileSync(join(REPO, PUBLIC_TF_DIR, f), 'utf8') });
  for (const c of PUBLIC_CASES) valid.push({ name: `public ${c.id}`, text: c.mutate(readFileSync(join(REPO, dirOf[c.module], c.file), 'utf8')) });
  for (const c of CONTROLS.filter((x) => x.file.startsWith(`${PUBLIC_TF_DIR}/`) && x.file.endsWith('.tf'))) {
    const src = readFileSync(join(REPO, c.file), 'utf8');
    valid.push({ name: `control ${c.id}`, text: src.replace(c.find, () => c.replace), applied: src.includes(c.find) });
  }

  const results = [];
  const problems = [];
  for (const v of valid) {
    const r = { name: v.name, kind: 'valid', scanner: scanOk(v.text) };
    if (v.applied === false) problems.push(`${v.name}: the control's find string is not in its file`);
    if (!r.scanner.ok) problems.push(`${v.name}: the scanner cannot parse it (${r.scanner.error})`);
    for (const t of TOOLS) {
      const f = fmt(t, v.text);
      r[t] = f.exit;
      if (f.exit !== 0) problems.push(`${v.name}: ${t} fmt exit ${f.exit} (${f.err})`);
      else if (r.scanner.ok) {
        const after = scanOk(f.out);
        r[`${t}Roundtrip`] = after.ok && after.shape === r.scanner.shape;
        if (!r[`${t}Roundtrip`]) problems.push(`${v.name}: the scanner sees a different structure after ${t} fmt`);
      }
    }
    delete r.scanner.shape;
    results.push(r);
  }
  for (const [n, text] of HCL_INVALID.entries()) {
    const r = { name: `invalid ${n}: ${JSON.stringify(text).slice(0, 40)}`, kind: 'invalid', scanner: scanOk(text) };
    if (r.scanner.ok) problems.push(`${r.name}: the scanner accepts it`);
    for (const t of TOOLS) {
      r[t] = fmt(t, text).exit;
      if (r[t] === 0) problems.push(`${r.name}: ${t} fmt accepts it`);
    }
    delete r.scanner.shape;
    results.push(r);
  }
  const versions = Object.fromEntries(TOOLS.map((t) => [t, spawnSync('sandbox-exec', ['-p', PROFILE, t, 'version'], { encoding: 'utf8', env: { ...process.env, CHECKPOINT_DISABLE: '1' } }).stdout.split('\n')[0]]));
  return { versions, cases: results.length, results, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await acceptance();
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.problems.length ? 1 : 0);
}
