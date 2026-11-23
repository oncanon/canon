// Public-release hygiene: no tracked file names a real machine, tailnet, cloud
// account or personal mailbox. The patterns are generic on purpose: they name no
// person or organization, so this file is itself safe to publish. Employer and
// project names are swept by hand before a release; they are not listed here,
// because listing them would publish them.
//
// Exclusions (loud, by design):
// - this file, because its seeded samples must contain each shape it rejects;
// - files that contain a NUL byte (binary), because the patterns are textual.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REPO } from '../helpers.mjs';

const SELF = 'test/unit/public-hygiene.test.mjs';

// Placeholder values that are documented as examples, never real.
// `nonroot` is the distroless container user and `ops` a role, not people.
const HOME_OK = new Set(['you', 'user', 'username', 'example', 'runner', 'me', 'name', 'nonroot', 'ops']);
const SUBDOMAIN_OK = new Set(['example', 'your-subdomain']);
const TAILNET_OK = new Set(['example-tailnet', 'tailnet', 'your-tailnet']);
// Reserved names only: example.{com,net,org} and the .example, .invalid, .test and .localhost TLDs.
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/i;
// The AWS documentation's own example account ids, plus any repeated digit.
// Assembled from parts so the H-8.1 identifier scanner reads no literal account id here.
const AWS_DOC_ACCOUNTS = new Set([['123456', '789012'], ['012345', '678910'], ['111122', '223333'], ['444455', '556666'], ['777788', '889999']].map((p) => p.join('')));
const [DOC_A, DOC_B, DOC_C] = [...AWS_DOC_ACCOUNTS];
const isPlaceholderAwsAccount = (id) => /^(\d)\1{11}$/.test(id) || AWS_DOC_ACCOUNTS.has(id);

export const RULES = [
  {
    id: 'home-path',
    why: 'an absolute path into a real home directory',
    re: /\/(?:Users|home)\/([A-Za-z0-9._-]+)(?=[\/"'`\s)\]:;,]|$)/gm,
    real: (m) => !HOME_OK.has(m[1].toLowerCase()),
  },
  {
    id: 'windows-home-path',
    why: 'an absolute Windows path into a real home directory',
    re: /\b[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._-]+)/g,
    real: (m) => !HOME_OK.has(m[1].toLowerCase()),
  },
  {
    id: 'tailnet-host',
    why: 'a real Tailscale tailnet name (<host>.<tailnet>.ts.net)',
    re: /\b([a-z0-9-]+)\.ts\.net\b/gi,
    real: (m) => !TAILNET_OK.has(m[1].toLowerCase()),
  },
  {
    id: 'tailscale-ip',
    why: 'a real Tailscale address (100.64.0.0/10 outside the 100.64.0.0/24 placeholder block)',
    re: /\b100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    real: (m) => {
      const [b, c] = [Number(m[1]), Number(m[2])];
      if (b < 64 || b > 127) return false; // not the CGNAT range Tailscale uses
      if (b === 64 && c === 0) return false; // the placeholder block
      return m[0] !== '100.100.100.100'; // Tailscale's fixed MagicDNS resolver
    },
  },
  {
    id: 'cloudflare-account-id',
    why: 'a Cloudflare account id (32 hex) in an account context',
    re: /(?:accounts\/|dash\.cloudflare\.com\/|account[_ -]?id["'`]?\s*[:=]\s*["'`]?)([0-9a-f]{32})\b/gi,
    real: (m) => !/^(.)\1{31}$/.test(m[1]),
  },
  {
    id: 'workers-subdomain',
    why: 'a real workers.dev account subdomain',
    re: /\b[a-z0-9-]+\.([a-z0-9-]+)\.workers\.dev\b/gi,
    real: (m) => !SUBDOMAIN_OK.has(m[1].toLowerCase()),
  },
  {
    id: 'aws-account-id',
    why: 'a real 12-digit AWS account id in an ARN or account field',
    re: /(?:arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:|account(?:[_ -]?id)?["'`]?\s*[:=]\s*["'`]?)(\d{12})\b/gi,
    real: (m) => !isPlaceholderAwsAccount(m[1]),
  },
  {
    id: 'email-domain',
    why: 'an email address outside the reserved example domains (RFC 2606, RFC 6761)',
    re: /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g,
    // `scheme://user:pw@host` is URL user information, not an address.
    real: (m) => !RESERVED_DOMAIN.test(m[1]) && m.input[m.index - 1] !== ':',
  },
];

export function findings(text, file = '<text>') {
  const out = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (!rule.real(m)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push(`${file}:${line}: ${rule.id} (${rule.why})`);
    }
  }
  return out;
}

function trackedTextFiles() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  const out = [];
  for (const f of files) {
    if (f === SELF) continue;
    let buf;
    try { buf = readFileSync(join(REPO, f)); } catch { continue; } // deleted in the working tree
    if (buf.includes(0)) continue;
    out.push([f, buf.toString('utf8')]);
  }
  return out;
}

test('[HYGIENE] the detector finds every seeded real shape and passes every placeholder', () => {
  // Built by concatenation so no other scanner reads these as real values.
  const h = 'h' + 'ex';
  const real = [
    ['home-path', `/Users/${'jdoe'}/Code/x`],
    ['home-path', `/home/${'jdoe'}/src`],
    ['tailnet-host', `laptop.tail${'0a1b2c'}.ts.net`],
    ['cloudflare-account-id', `accounts/${'0123456789abcdef'.repeat(2)}/workers`],
    ['cloudflare-account-id', `account_id = "${'fedcba9876543210'.repeat(2)}"`],
    ['workers-subdomain', `https://app.${'jdoe-1a2'}.workers.dev/`],
    ['aws-account-id', `${'arn:aws'}:iam::${'4815162342'}42:root`],
    ['home-path', `"/Users/${'jdoe'}"`],
    ['windows-home-path', `C:\\Users\\${'jdoe'}\\x`],
    ['tailnet-host', `mybox.${'cat-crocodile'}.ts.net`],
    ['tailscale-ip', `http://100.${'74.34'}.16:8791`],
    ['aws-account-id', `"Account": "${'4815162342'}42"`],
    ['cloudflare-account-id', `https://dash.cloudflare.com/${'0123456789abcdef'.repeat(2)}/home`],
    ['email-domain', `${'jdoe'}@${'gmail'}.com`],
    ['email-domain', `${'jdoe'}@${'some-company'}.com`],
  ];
  for (const [id, sample] of real) {
    const got = findings(sample);
    assert.equal(got.length, 1, `${id} must flag ${sample}`);
    assert.match(got[0], new RegExp(`: ${id} `));
  }
  const placeholders = [
    '/Users/you/Code/canon', '/home/runner/work', '<machine>.<tailnet>.ts.net', 'review-host.example-tailnet.ts.net',
    `accounts/${'0'.repeat(32)}/x`, 'https://rp.example.workers.dev/', 'https://<worker>.<sub>.workers.dev',
    `${'arn:aws'}:iam::${DOC_A}:root`, `${'arn:aws'}:iam::${'1'.repeat(12)}:root`, `${'arn:aws'}:ecs:us-east-1:${DOC_B}:task/x`,
    `${'arn:aws'}:ssm:us-east-2:${DOC_C}:parameter/x`, '/home/nonroot/written-by-test',
    '100.64.0.11', '100.100.100.100', '10.0.0.1', 'node-a.example-tailnet.ts.net', `ops${'@'}mail.example`, `a${'@'}b.example.invalid`, `https://user:pw${'@'}rp.example.workers.dev`, `ops${'@'}example.com`, `sha256 ${h}: ${'ab'.repeat(32)}`,
  ];
  for (const p of placeholders) assert.deepEqual(findings(p), [], `placeholder must pass: ${p}`);
});

test('[HYGIENE] no tracked file names a real home directory, tailnet, cloud account or personal mailbox', () => {
  const files = trackedTextFiles();
  assert.ok(files.length > 100, `scanned ${files.length} tracked text files; expected the whole tree`);
  // File and directory names are scanned too: a path can leak as much as content.
  const hits = [...files.flatMap(([f]) => findings(f, `${f} (path)`)), ...files.flatMap(([f, text]) => findings(text, f))];
  assert.deepEqual(hits, []);
});
