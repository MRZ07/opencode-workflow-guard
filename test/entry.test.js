import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowGuard } from '../index.js';

test('invalid repetition thresholds fail at plugin initialization', async () => {
  for (const value of [-1, 0, 1.5, '2', 11]) await assert.rejects(WorkflowGuard({ client: {}, directory: '/tmp' }, { maxIdenticalFailures: value }), /integer from 1 to 10/);
  for (const value of [0, 1.5, '3', 11]) await assert.rejects(WorkflowGuard({ client: {}, directory: '/tmp' }, { maxFailedChecks: value }), /integer from 1 to 10/);
});

test('checkpoint tool preserves primary authority and exposes no shell runner', async () => {
  const hooks = await WorkflowGuard({ client: {}, directory: '/tmp' });
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['workflow_checkpoint', 'workflow_evidence', 'workflow_prepare']);
  await assert.rejects(hooks.tool.workflow_checkpoint.execute({ state: 'blocked', required: [], unresolvedCount: 1 }, { agent: 'fusion-code-worker', sessionID: 'child' }), /primary workflow owner/);
  await assert.rejects(hooks.tool.workflow_prepare.execute({ workdir: '/tmp', checks: [] }, { agent: 'fusion-ops', sessionID: 'child' }), /primary workflow owner/);
});

test('task-dispatched Deep Review cannot act as the primary workflow owner', async () => {
  const client = { session: { get: async ({ path: { id } }) => ({ data: { id, ...(id === 'child' ? { parentID: 'root' } : {}) } }) } };
  const hooks = await WorkflowGuard({ client, directory: '/tmp' });
  await assert.rejects(hooks.tool.workflow_checkpoint.execute({ state: 'blocked', required: [], unresolvedCount: 1 }, { agent: 'deep-review', sessionID: 'child' }), /primary workflow owner/);
});
