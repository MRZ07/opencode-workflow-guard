import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGuard, Journal, snapshot } from '../guard.js';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-guard-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'project');
  const stateDir = path.join(temp, 'state');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'source.js'), 'old\n');
  const sessions = { root: { id: 'root' }, child: { id: 'child', parentID: 'root' }, child2: { id: 'child2', parentID: 'root' }, other: { id: 'other' } };
  const client = { session: { get: async ({ path: { id } }) => ({ data: sessions[id] }) } };
  const guard = createGuard({ directory, stateDir, client });
  for (const id of Object.keys(sessions)) await guard.hooks['chat.params']({ sessionID: id, agent: 'fusion-code-worker' });
  return { directory, stateDir, client, guard };
}
const patch = '*** Begin Patch\n*** Update File: source.js\n@@\n-missing\n+new\n*** End Patch';
async function patchBefore(guard, callID, text = patch, sessionID = 'child') {
  await guard.hooks['tool.execute.before']({ tool: 'apply_patch', sessionID, callID }, { args: { patchText: text } });
}
async function patchError(guard, callID, sessionID = 'child', error = 'apply_patch verification failed: Failed to find expected lines') {
  await guard.hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'apply_patch', sessionID, callID, state: { status: 'error', error },
  } } } });
}
async function verifyBefore(guard, callID = 'check', extra = {}) {
  const input = { tool: 'bash', sessionID: 'child', callID, args: { command: 'npm test', description: 'verify:unit Run unit tests', ...extra } };
  await guard.hooks['tool.execute.before'](input, { args: input.args });
  return input;
}
async function verifyAfter(guard, input, exit = 0) {
  const output = { output: 'Do not persist these logs', metadata: { exit } };
  await guard.hooks['tool.execute.after'](input, output);
  return output.metadata.workflowGuard.evidenceID;
}

test('blocks third identical context failure across children, restart and duplicate events', async t => {
  const f = await fixture(t);
  await patchBefore(f.guard, 'one'); await patchError(f.guard, 'one'); await patchError(f.guard, 'one');
  await patchBefore(f.guard, 'two', patch, 'child2'); await patchError(f.guard, 'two', 'child2');
  const restarted = createGuard(f);
  await restarted.hooks['chat.params']({ sessionID: 'child2', agent: 'fusion-code-worker' });
  await assert.rejects(patchBefore(restarted, 'three', patch, 'child2'), /identical patch already failed 2/);
  // Recovery reads are unrestricted and a genuinely different patch is allowed.
  await restarted.hooks['tool.execute.before']({ tool: 'read', sessionID: 'child2', callID: 'read' }, { args: {} });
  await patchBefore(restarted, 'revised', patch.replace('missing', 'old'), 'child2');
});

test('changed file bytes and separate root runs do not share a repetition block', async t => {
  const f = await fixture(t);
  for (const id of ['one', 'two']) { await patchBefore(f.guard, id); await patchError(f.guard, id); }
  await patchBefore(f.guard, 'independent', patch, 'other');
  await fs.writeFile(path.join(f.directory, 'source.js'), 'changed\n');
  await patchBefore(f.guard, 'new-input');
});

test('cancellation and permission errors are not patch context failures', async t => {
  const f = await fixture(t);
  for (const id of ['one', 'two']) { await patchBefore(f.guard, id); await patchError(f.guard, id, 'child', 'Task cancelled'); }
  await patchBefore(f.guard, 'three');
});

test('native checks carry real exit and current-input attestation, invalidated by later edits', async t => {
  const f = await fixture(t);
  const input = await verifyBefore(f.guard);
  const id = await verifyAfter(f.guard, input);
  const [valid] = await f.guard.evidence('root', [id]);
  assert.equal(valid.validity, 'pass'); assert.equal(valid.exit, 0); assert.equal(valid.criterion, 'unit');
  await fs.writeFile(path.join(f.directory, 'source.js'), 'new\n');
  assert.equal((await f.guard.evidence('root', [id]))[0].validity, 'stale');
  await assert.rejects(f.guard.checkpoint('root', 'completed', [id]), /completion requires/);
  assert.equal((await f.guard.checkpoint('root', 'blocked', [id], 1)).state, 'blocked');
});

test('a zero exit cannot pass when files changed during the check', async t => {
  const f = await fixture(t);
  const input = await verifyBefore(f.guard);
  await fs.writeFile(path.join(f.directory, 'source.js'), 'changed by formatter\n');
  const id = await verifyAfter(f.guard, input);
  assert.equal((await f.guard.evidence('root', [id]))[0].validity, 'changed-during-check');
});

test('nonzero, unknown exit and unknown evidence cannot pass', async t => {
  const f = await fixture(t);
  for (const [callID, exit] of [['fail', 1], ['unknown', undefined]]) {
    const input = await verifyBefore(f.guard, callID);
    const output = { output: '', metadata: { exit } };
    await f.guard.hooks['tool.execute.after'](input, output);
    assert.equal((await f.guard.evidence('root', [output.metadata.workflowGuard.evidenceID]))[0].validity, 'failed');
  }
  assert.equal((await f.guard.evidence('root', ['wg_' + '0'.repeat(24)]))[0].validity, 'unknown');
  await assert.rejects(f.guard.checkpoint('root', 'completed', []), /completion requires/);
});

test('failed native tool event is captured even without after hook', async t => {
  const f = await fixture(t);
  const input = await verifyBefore(f.guard);
  await f.guard.hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'bash', sessionID: input.sessionID, callID: input.callID,
    state: { status: 'error', input: input.args, error: 'arbitrary runtime failure' },
  } } } });
  const checkpoint = await f.guard.checkpoint('root', 'blocked', [], 1);
  assert.equal(checkpoint.state, 'blocked');
});

test('persistent evidence survives restart; repeated completion event is idempotent', async t => {
  const f = await fixture(t);
  const input = await verifyBefore(f.guard);
  const id = await verifyAfter(f.guard, input);
  await f.guard.hooks['tool.execute.after'](input, { output: '', metadata: { exit: 1 } });
  const restarted = createGuard(f);
  assert.equal((await restarted.evidence('root', [id]))[0].validity, 'pass');
  assert.equal((await restarted.checkpoint('root', 'completed', [id])).state, 'completed');
});

test('unsupported ancestry fails explicitly rather than resetting root counters', async t => {
  const f = await fixture(t);
  await f.guard.hooks['chat.params']({ sessionID: 'missing', agent: 'fusion-code-worker' });
  await assert.rejects(patchBefore(f.guard, 'one', patch, 'missing'), /ancestry unavailable/);
});

test('ordinary commands and non-Fusion actors cause no journal or snapshot activity', async t => {
  const f = await fixture(t);
  const ordinary = { tool: 'bash', sessionID: 'child', callID: 'ordinary', args: { command: 'ls' } };
  await f.guard.hooks['tool.execute.before'](ordinary, { args: ordinary.args });
  await f.guard.hooks['tool.execute.after'](ordinary, { output: '', metadata: { exit: 0 } });
  await f.guard.hooks['chat.params']({ sessionID: 'child', agent: 'build' });
  await patchBefore(f.guard, 'build');
  await assert.rejects(fs.access(f.stateDir), { code: 'ENOENT' });
});

test('concurrent isolated checks and dispatch counts remain attributable', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([verifyBefore(f.guard, 'a'), verifyBefore(f.guard, 'b')]);
  const ids = await Promise.all([verifyAfter(f.guard, a), verifyAfter(f.guard, b)]);
  await f.guard.hooks['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: 'dispatch' }, { args: {} });
  const checkpoint = await f.guard.checkpoint('root', 'completed', ids);
  assert.equal(checkpoint.dispatches, 1); assert.equal(checkpoint.evidence.length, 2);
});

test('state contains no command strings, patches or command logs', async t => {
  const f = await fixture(t);
  await patchBefore(f.guard, 'patch'); await patchError(f.guard, 'patch');
  const input = await verifyBefore(f.guard); await verifyAfter(f.guard, input);
  const directories = await fs.readdir(f.stateDir);
  const data = (await Promise.all((await fs.readdir(path.join(f.stateDir, directories[0]))).map(name => fs.readFile(path.join(f.stateDir, directories[0], name), 'utf8')))).join('');
  assert.ok(!data.includes('npm test')); assert.ok(!data.includes('Do not persist')); assert.ok(!data.includes('*** Begin Patch'));
});

test('source symlinks and oversized snapshots fail explicitly; standard output artifacts are excluded', async t => {
  const f = await fixture(t);
  await assert.rejects(snapshot(f.directory, { maxBytes: 1 }), /exceeds its bound/);
  const before = await snapshot(f.directory);
  await fs.mkdir(path.join(f.directory, 'node_modules'));
  await fs.writeFile(path.join(f.directory, 'node_modules', 'generated.js'), 'ignored');
  assert.equal((await snapshot(f.directory)).hash, before.hash);
  await fs.symlink(path.join(f.directory, 'source.js'), path.join(f.directory, 'link.js'));
  await assert.rejects(snapshot(f.directory), /symlink/);
});

test('marked checks cannot silently fingerprint another worktree', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyBefore(f.guard, 'outside', { workdir: '..' }), /inside this worktree/);
});

test('journal replays new external events and enforces explicit capacity', async t => {
  const f = await fixture(t);
  const a = new Journal(path.join(f.stateDir, 'shared'), 2);
  const b = new Journal(path.join(f.stateDir, 'shared'), 2);
  await a.put('first', { kind: 'test' });
  await b.put('second', { kind: 'test' });
  assert.equal((await a.records()).length, 2);
  await assert.rejects(a.put('third', { kind: 'test' }), /capacity reached/);
  await a.put('first', { kind: 'test' });
});
