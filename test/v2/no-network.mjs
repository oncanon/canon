// Runtime no-network guard for the V2 suites. Importing this module replaces every
// outbound network entry point in this process with one that records the attempt
// and throws. The V2 tests assert, at the end, that nothing but the guard's own
// self-test was attempted: so the suite provably made zero network calls.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

export const attempts = [];

function blocked(what) {
  return function blockedCall(...args) {
    attempts.push({ what, target: String(args[0]?.host ?? args[0]?.hostname ?? args[0]?.href ?? args[0] ?? '') });
    const error = new Error(`network blocked in V2 tests: ${what}`);
    error.code = 'ERR_V2_NETWORK_BLOCKED';
    throw error;
  };
}

net.Socket.prototype.connect = blocked('net.Socket.connect');
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
tls.connect = blocked('tls.connect');
http.request = blocked('http.request');
http.get = blocked('http.get');
https.request = blocked('https.request');
https.get = blocked('https.get');
dns.lookup = blocked('dns.lookup');
dns.resolve = blocked('dns.resolve');
globalThis.fetch = blocked('fetch');
// Make named ESM imports of these builtins see the replacements too.
syncBuiltinESMExports();
