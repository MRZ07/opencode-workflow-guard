import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshot, DEFAULT_SNAPSHOT_LIMITS } from '../snapshot.js';

const hash = content => createHash('sha256').update(content).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-snapshot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('streaming manifest matches full-content hashing including binary game assets', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'assets'));
  const binary = Buffer.alloc(150000, 0xab);
  await fs.writeFile(path.join(root, 'assets/music.mp3'), binary);
  await fs.writeFile(path.join(root, 'code.js'), 'code');
  const manifest = [];
  for (const [name, content] of [['assets/music.mp3', binary], ['code.js', 'code']]) manifest.push([name, hash(content), (await fs.stat(path.join(root, name))).mode & 0o777]);
  const result = await snapshot(root);
  assert.equal(result.hash, hash(JSON.stringify(manifest)));
  assert.equal(result.bytes, binary.length + 4);
  await fs.writeFile(path.join(root, 'assets/music.mp3'), Buffer.alloc(150000, 0xac));
  assert.notEqual((await snapshot(root)).hash, result.hash);
});

test('a single input exceeding the former 128 MiB ceiling succeeds without a whole-file buffer', async t => {
  const root = await fixture(t);
  const file = await fs.open(path.join(root, 'music.bin'), 'w');
  await file.truncate(129 * 1024 * 1024); await file.close();
  const result = await snapshot(root);
  assert.equal(DEFAULT_SNAPSHOT_LIMITS.maxBytes, 512 * 1024 * 1024);
  assert.equal(result.bytes, 129 * 1024 * 1024);
  assert.equal(result.files, 1);
});

test('exact byte/file/entry ceilings pass and the next included byte or entry fails closed', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'a'), '1234');
  await fs.writeFile(path.join(root, 'b'), '5678');
  assert.equal((await snapshot(root, { maxBytes: 8, maxFiles: 2, maxEntries: 2 })).files, 2);
  await assert.rejects(snapshot(root, { maxBytes: 7 }), /exceeds its bound/);
  await assert.rejects(snapshot(root, { maxFiles: 1 }), /exceeds its bound/);
  await assert.rejects(snapshot(root, { maxEntries: 1 }), /entry budget/);
  for (const value of [0, -1, Infinity, 1.5]) await assert.rejects(snapshot(root, { maxBytes: value }), /positive safe integer/);
});

test('excluded entries still consume traversal budget without expanding the input manifest', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, '.env.test'), 'private');
  assert.equal((await snapshot(root, { maxEntries: 2 })).files, 0);
  await assert.rejects(snapshot(root, { maxEntries: 1 }), /entry budget/);
});

test('source links remain rejected whether dangling, internal, external or cyclic', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'input');
  const link = path.join(root, 'link');
  for (const target of ['missing', 'file', os.tmpdir(), 'link']) {
    await fs.symlink(target, link);
    await assert.rejects(snapshot(root), /symlink/);
    await fs.unlink(link);
  }
});

test('cancellation and elapsed deadline reject even when an I/O has just completed', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'data');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(snapshot(root, { signal: controller.signal }), /cancelled/);
  let calls = 0;
  await assert.rejects(snapshot(root, { maxDurationMs: 10, clock: () => ++calls < 4 ? 0 : 11 }), /deadline/);
  const midRead = new AbortController();
  calls = 0;
  await assert.rejects(snapshot(root, { signal: midRead.signal, clock: () => { if (++calls === 17) midRead.abort(); return 0; } }), /cancelled/);
  assert.equal((await snapshot(root)).bytes, 4, 'cancelled traversal leaves no partial result or unusable handle');
});

test('observed mutation during streaming cannot yield a valid snapshot', async t => {
  const root = await fixture(t);
  const filename = path.join(root, 'file');
  await fs.writeFile(filename, Buffer.alloc(2 * 1024 * 1024));
  let mutated = false;
  const timer = setInterval(() => { mutated = true; fs.appendFile(filename, 'x').catch(() => {}); }, 1);
  try { await assert.rejects(snapshot(root), /changed during snapshot/); }
  finally { clearInterval(timer); }
  assert.ok(mutated);
});

test('deadline expiry during final manifest serialization cannot publish a snapshot', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'data');
  let now = 0;
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    const result = stringify(value, ...args);
    if (Array.isArray(value) && value[0]?.[0] === 'file') now = 11;
    return result;
  });
  await assert.rejects(snapshot(root, { clock: () => now, maxDurationMs: 10 }), /deadline/);
});
