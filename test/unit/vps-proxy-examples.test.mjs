import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// [VPS-1/VPS-2] Static checks on the example reverse-proxy configs in infra/vps/.
//
// canon serve has no authentication of its own and refuses any Host header that is
// not the loopback authority it is bound to (src/server/server.mjs, bind.mjs). The
// example configs are the only place that documents how to make the service private
// on a VPS, so a silent edit that drops the auth block or the Host rewrite would
// leave every reader's server either open to the world (no auth) or broken by
// canon serve's own 421 (Host not rewritten). These checks fail on either mistake.

const CADDYFILE = fileURLToPath(new URL('../../infra/vps/Caddyfile.example', import.meta.url));
const NGINX_CONF = fileURLToPath(new URL('../../infra/vps/nginx.example.conf', import.meta.url));
const LOOPBACK_AUTHORITY = '127.0.0.1:8791';

test('[VPS-1] Caddyfile.example requires basic auth before proxying to canon serve', async () => {
  const text = await readFile(CADDYFILE, 'utf8');
  assert.match(text, /basic_auth\s*\{/, 'must gate access with basic_auth');
  assert.match(text, /reverse_proxy\s+127\.0\.0\.1:8791/, 'must proxy to the loopback canon serve port');
});

test('[VPS-2] Caddyfile.example rewrites Host to the loopback authority, not the client Host', async () => {
  const text = await readFile(CADDYFILE, 'utf8');
  assert.match(
    text,
    new RegExp(`header_up\\s+Host\\s+${LOOPBACK_AUTHORITY.replace('.', '\\.')}`),
    'must rewrite Host to the loopback authority canon serve is bound to',
  );
});

test('[VPS-1] nginx.example.conf requires basic auth before proxying to canon serve', async () => {
  const text = await readFile(NGINX_CONF, 'utf8');
  assert.match(text, /auth_basic\s+["']/, 'must gate access with auth_basic');
  assert.match(text, /auth_basic_user_file\s+\S+;/, 'must reference a password file');
  assert.match(text, /proxy_pass\s+http:\/\/127\.0\.0\.1:8791;/, 'must proxy to the loopback canon serve port');
});

test('[VPS-2] nginx.example.conf rewrites Host to the loopback authority, not the client Host', async () => {
  const text = await readFile(NGINX_CONF, 'utf8');
  assert.match(
    text,
    new RegExp(`proxy_set_header\\s+Host\\s+${LOOPBACK_AUTHORITY.replace('.', '\\.')};`),
    'must rewrite Host to the loopback authority canon serve is bound to',
  );
  assert.doesNotMatch(text, /proxy_set_header\s+Host\s+\$host;/, 'must not forward the client\'s original Host');
});
