import { z } from 'zod';
import { createGuard } from './guard.js';

export const WorkflowGuard = async ({ client, directory, worktree }, options = {}) => {
  const maxIdenticalFailures = options.maxIdenticalFailures ?? 2;
  if (!Number.isInteger(maxIdenticalFailures) || maxIdenticalFailures < 1 || maxIdenticalFailures > 10) throw new Error('workflow-guard: maxIdenticalFailures must be an integer from 1 to 10');
  const cwd = typeof directory === 'string' ? directory : directory?.worktree || worktree || process.cwd();
  const guard = createGuard({ client, directory: cwd, maxIdenticalFailures });
  const ids = z.array(z.string().regex(/^wg_[a-f0-9]{24}$/)).max(20);
  return { ...guard.hooks, tool: {
    workflow_evidence: {
      description: 'Read attested native verification records for this run and check validity against current inputs. Never executes commands.',
      args: { ids },
      execute: async (args, context) => JSON.stringify(await guard.evidence(context.sessionID, args.ids)),
    },
    workflow_checkpoint: {
      description: 'Save compact completed/blocked/stopped state. Completed requires declared evidence passing on current inputs; this is not a correctness review.',
      args: { state: z.enum(['completed', 'blocked', 'stopped']), required: ids, unresolvedCount: z.number().int().nonnegative().max(10000) },
      execute: async (args, context) => {
        if (!['fusion-planner', 'deep-review'].includes(context.agent)) throw new Error('workflow-guard: only the primary workflow owner may close a run');
        return JSON.stringify(await guard.checkpoint(context.sessionID, args.state, args.required, args.unresolvedCount));
      },
    },
  } };
};
