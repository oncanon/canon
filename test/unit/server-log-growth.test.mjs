import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import test from 'node:test';
import { setAlias } from '../../src/alias/alias.mjs';
import { buildPacket } from '../../src/packet/build.mjs';
import { publishPacket } from '../../src/publish/filesystem.mjs';
import { startServer } from '../../src/server/server.mjs';
import { DEFAULT_LOG_MAX_BYTES, rotateLogIfOversize } from '../../src/service.mjs';
import { FIXTURE, tempDir } from '../helpers.mjs';

function get(url, path) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function served(t) {
  const dir = await tempDir(t, 'canon-log-growth');
  const store = join(dir, 'store');
  const built = await buildPacket({ reportPath: FIXTURE, outDir: join(dir, 'pkt') });
  await publishPacket({ packetDir: join(dir, 'pkt'), root: store });
  await setAlias({ root: store, name: 'review', contentId: built.contentId, expectGeneration: 0 });
  const calls = [];
  const srv = await startServer({ root: store, log: (entry) => calls.push(entry) });
  t.after(() => srv.server.close());
  return { ...srv, calls };
}

test('[log-growth] a successful GET /healthz writes no request log line', async (t) => {
  const { url, calls } = await served(t);
  const status = await get(url, '/healthz');
  assert.equal(status, 200);
  assert.deepEqual(calls, []);
});

test('[log-growth] a failed request is still logged', async (t) => {
  const { url, calls } = await served(t);
  const status = await get(url, '/nope');
  assert.equal(status, 404);
  const requestEvents = calls.filter((e) => e.event === 'request');
  assert.equal(requestEvents.length, 1);
  assert.equal(requestEvents[0].path, '/nope');
  assert.equal(requestEvents[0].status, 404);
});

test('[log-growth] rotateLogIfOversize copies to .1 and truncates in place once over the limit', async (t) => {
  const dir = await tempDir(t, 'canon-log-rotate');
  const path = join(dir, 'server.log');
  const fd = openSync(path, 'a');
  t.after(() => closeSync(fd));
  const maxBytes = 1024;
  writeSync(fd, Buffer.alloc(maxBytes - 1, 'x'));

  assert.equal(rotateLogIfOversize(fd, path, maxBytes), false, 'below the limit: no rotation yet');
  writeSync(fd, 'yy');
  assert.equal(rotateLogIfOversize(fd, path, maxBytes), true, 'over the limit: rotates');

  assert.equal(readFileSync(`${path}.1`).length, maxBytes + 1);
  assert.equal(readFileSync(path).length, 0, 'server.log is truncated in place');

  // fd is O_APPEND: a write after truncate must land at the new (empty) end of file,
  // not at the old pre-truncate offset, or the rotated-away bytes would leave a gap.
  writeSync(fd, 'fresh\n');
  assert.equal(readFileSync(path, 'utf8'), 'fresh\n');
});

test('[log-growth] rotateLogIfOversize is a no-op on a non-file fd (foreground serve: a terminal or pipe)', (t) => {
  // fd 0 here is this test process's own stdin: never a plain file in the test runner.
  assert.equal(rotateLogIfOversize(0, '/does/not/matter', 1), false);
});

test('[log-growth] DEFAULT_LOG_MAX_BYTES is a small, explicit cap', () => {
  assert.ok(DEFAULT_LOG_MAX_BYTES > 0);
  assert.ok(DEFAULT_LOG_MAX_BYTES <= 10 * 1024 * 1024);
});

test('[log-growth] rotateLogIfOversize does not rotate when fd is open on a different file than path', async (t) => {
  const dir = await tempDir(t, 'canon-log-rotate-mismatch');
  const otherPath = join(dir, 'other.log');
  const namedPath = join(dir, 'server.log');
  const fd = openSync(otherPath, 'a');
  t.after(() => closeSync(fd));
  const maxBytes = 16;
  writeSync(fd, Buffer.alloc(maxBytes + 1, 'x'));
  writeFileSync(namedPath, Buffer.alloc(maxBytes + 1, 'y'));

  assert.equal(rotateLogIfOversize(fd, namedPath, maxBytes), false);
  assert.equal(existsSync(`${namedPath}.1`), false, 'namedPath was not copied');
  assert.equal(readFileSync(otherPath).length, maxBytes + 1, 'fd was not truncated');
  assert.equal(readFileSync(namedPath).length, maxBytes + 1, 'namedPath was not truncated');
});

test('[log-growth] rotateLogIfOversize returns false, not a throw, when path does not exist', async (t) => {
  const dir = await tempDir(t, 'canon-log-rotate-missing');
  const path = join(dir, 'server.log');
  const fd = openSync(path, 'a');
  t.after(() => closeSync(fd));
  writeSync(fd, Buffer.alloc(16, 'x'));
  unlinkSync(path);

  assert.equal(rotateLogIfOversize(fd, path, 1), false);
});
