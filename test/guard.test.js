import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

test('an actual budget block saves a checkpoint without a permitted tool invocation', async t => {
  const f = await fixture(t);
  const event = { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'workflow_checkpoint', sessionID: 'child', callID: 'budget',
    state: { status: 'error', error: 'cost-guard: active budget exceeded. Private message not persisted.' },
  } } };
  await f.guard.hooks.event({ event }); await f.guard.hooks.event({ event });
  const root = (await fs.readdir(f.stateDir))[0];
  const records = await new Journal(path.join(f.stateDir, root)).records();
  assert.equal(records.length, 1); assert.equal(records[0].state, 'blocked');
  assert.equal(records[0].blocker, 'cost-guard'); assert.equal(records[0].unresolvedCount, null);
  assert.ok(!JSON.stringify(records).includes('Private message'));
});

test('standalone Deep Review budget errors persist once while unrelated actors stay untouched', async t => {
  const f = await fixture(t);
  await f.guard.hooks['chat.params']({ sessionID: 'root', agent: 'deep-review' });
  await f.guard.hooks['chat.params']({ sessionID: 'other', agent: 'build' });
  const eventFor = sessionID => ({ type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'read', sessionID, callID: 'budget',
    state: { status: 'error', error: 'cost-guard: active budget exceeded. Private details.' },
  } } });
  await f.guard.hooks.event({ event: eventFor('other') });
  await assert.rejects(fs.access(f.stateDir), { code: 'ENOENT' });
  await f.guard.hooks.event({ event: eventFor('root') });
  await f.guard.hooks.event({ event: eventFor('root') });
  const root = (await fs.readdir(f.stateDir))[0];
  const records = await new Journal(path.join(f.stateDir, root)).records();
  assert.equal(records.length, 1);
  assert.equal(records[0].root, 'root');
  assert.equal(records[0].blocker, 'cost-guard');
  assert.ok(!JSON.stringify(records).includes('Private details'));
});

test('Deep Review evidence helpers and dispatches share the standalone review root', async t => {
  const f = await fixture(t);
  await f.guard.hooks['chat.params']({ sessionID: 'root', agent: 'deep-review' });
  await f.guard.hooks['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: 'ops' }, { args: {} });
  const input = await verifyBefore(f.guard);
  const id = await verifyAfter(f.guard, input);
  const report = await f.guard.checkpoint('root', 'completed', [id]);
  assert.equal(report.dispatches, 1);
  assert.equal(report.evidence[0].validity, 'pass');
});

test('prepared sibling Git worktree survives restart without granting unrelated directory access', async t => {
  const f = await fixture(t);
  const run = args => execFileSync('git', args, { cwd: f.directory, stdio: 'pipe' });
  run(['init', '-q']); run(['add', 'source.js']);
  run(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const sibling = path.join(path.dirname(f.directory), 'selected');
  run(['worktree', 'add', '-q', '-b', 'selected', sibling]);
  await assert.rejects(verifyBefore(f.guard, 'unbound', { workdir: sibling }), /prepare.*worktree/);
  const prepared = await f.guard.prepare('root', sibling, [{ criterion: 'unit', command: 'npm test' }]);
  assert.equal(prepared.runtime.version, '0.2.1');
  const restarted = createGuard(f);
  await restarted.hooks['chat.params']({ sessionID: 'child', agent: 'fusion-code-worker' });
  const input = await verifyBefore(restarted, 'selected', { workdir: sibling });
  const id = await verifyAfter(restarted, input);
  assert.equal((await restarted.evidence('root', [id]))[0].directory, await fs.realpath(sibling));
  await assert.rejects(f.guard.prepare('child', sibling, []), /primary root/);
  const unrelated = path.join(path.dirname(f.directory), 'unrelated');
  await fs.mkdir(unrelated); execFileSync('git', ['init', '-q', unrelated]);
  await assert.rejects(f.guard.prepare('root', unrelated, []), /another repository/);
  await assert.rejects(verifyBefore(restarted, 'outside', { workdir: unrelated }), /inside this worktree/);
});

test('only exact declared acceptance commands acquire a native marker', async t => {
  const f = await fixture(t);
  await f.guard.prepare('root', f.directory, [{ criterion: 'unit', command: 'npm test' }]);
  const input = { tool: 'bash', sessionID: 'child', callID: 'declared', args: { command: 'npm test', description: 'Run focused tests', workdir: f.directory } };
  await f.guard.hooks['tool.execute.before'](input, { args: input.args });
  assert.match(input.args.description, /^verify:unit /);
  const id = await verifyAfter(f.guard, input);
  assert.equal((await f.guard.evidence('root', [id]))[0].validity, 'pass');
  const ordinary = { tool: 'bash', sessionID: 'child', callID: 'formatter', args: { command: 'npm run fix', description: 'Format owned changes' } };
  await f.guard.hooks['tool.execute.before'](ordinary, { args: ordinary.args });
  assert.equal(ordinary.args.description, 'Format owned changes');
  await assert.rejects(verifyBefore(f.guard, 'weaker', { command: 'true' }), /differs from the declared criterion/);
});

test('three distinct failed snapshots require primary diagnosis across resumes and new helpers', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 3; n++) {
    await fs.writeFile(path.join(f.directory, 'source.js'), 'fix ' + n);
    await verifyAfter(f.guard, await verifyBefore(f.guard, 'fail-' + n), 1);
  }
  const restarted = createGuard(f);
  await restarted.hooks['chat.params']({ sessionID: 'child', agent: 'fusion-code-worker' });
  await assert.rejects(verifyBefore(restarted, 'fourth'), /3 distinct input snapshots/);
  await restarted.hooks['tool.execute.before']({ tool: 'read', sessionID: 'child', callID: 'diagnosis-read' }, { args: {} });
  await restarted.prepare('root', f.directory, [{ criterion: 'unit', command: 'npm test' }], { criterion: 'unit', hypothesis: 'Fixture owns the missing dependency', exitCondition: 'One focused correction, then return' }, 'diagnosis');
  const id = await verifyAfter(restarted, await verifyBefore(restarted, 'recovered'));
  assert.equal((await restarted.evidence('root', [id]))[0].validity, 'pass');
});

test('unchanged checks count one failing input and criteria remain independent', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 4; n++) await verifyAfter(f.guard, await verifyBefore(f.guard, 'same-' + n), 1);
  await fs.writeFile(path.join(f.directory, 'source.js'), 'second fix');
  await verifyAfter(f.guard, await verifyBefore(f.guard, 'changed'), 1);
  const independent = await verifyBefore(f.guard, 'other-criterion', { description: 'verify:compile Compile only' });
  await verifyAfter(f.guard, independent, 0);
  await assert.rejects(f.guard.prepare('root', f.directory, [], { criterion: 'unknown', hypothesis: 'Unknown', exitCondition: 'Stop' }, 'bad'), /declared criterion/);
});

test('cancelled evidence cannot close a completed checkpoint', async t => {
  const f = await fixture(t);
  const id = await verifyAfter(f.guard, await verifyBefore(f.guard));
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.guard.evidence('root', [id], controller.signal))[0].validity, 'unavailable');
  await assert.rejects(f.guard.checkpoint('root', 'completed', [id], 0, controller.signal), /cancelled/);
});

test('cancellation during atomic completion publication removes only its own record', async t => {
  const f = await fixture(t);
  const store = new Journal(path.join(f.stateDir, 'publication'));
  await store.put('prior', { kind: 'checkpoint', state: 'blocked' });
  const controller = new AbortController();
  const link = fs.link;
  t.mock.method(fs, 'link', async (...args) => { await link(...args); controller.abort(); });
  await assert.rejects(store.put('completion', { kind: 'checkpoint', state: 'completed' }, controller.signal), /cancelled/);
  const records = await store.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'blocked');
  assert.equal((await fs.readdir(store.directory)).some(name => name.endsWith('.tmp')), false);
});


test('same-key publication race preserves the existing writer on cancellation', async t => {
  const f = await fixture(t);
  const store = new Journal(path.join(f.stateDir, 'race'));
  await store.put('same', { kind: 'checkpoint', state: 'blocked', owner: 'first' });
  const controller = new AbortController();
  // Simulate a stale existence check, followed by a competing published record.
  t.mock.method(fs, 'access', async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
  const link = fs.link;
  t.mock.method(fs, 'link', async (...args) => {
    try { await link(...args); } finally { controller.abort(); }
  });
  await assert.rejects(store.put('same', { kind: 'checkpoint', state: 'completed', owner: 'second' }, controller.signal), /cancelled/);
  const records = await new Journal(store.directory).records();
  assert.equal(records.length, 1);
  assert.equal(records[0].owner, 'first');
  assert.equal((await fs.readdir(store.directory)).some(name => name.endsWith('.tmp')), false);
});


test('cancellation during temporary cleanup cannot leave a completed checkpoint', async t => {
  const f = await fixture(t);
  const store = new Journal(path.join(f.stateDir, 'cleanup'));
  const controller = new AbortController();
  const remove = fs.rm;
  t.mock.method(fs, 'rm', async (...args) => {
    await remove(...args);
    if (String(args[0]).endsWith('.tmp')) controller.abort();
  });
  await assert.rejects(store.put('completion', { kind: 'checkpoint', state: 'completed' }, controller.signal), /cancelled/);
  assert.equal((await store.records()).length, 0);
  assert.equal((await fs.readdir(store.directory)).length, 0);
});
