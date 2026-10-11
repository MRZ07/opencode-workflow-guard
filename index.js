import { z } from 'zod';
import { createGuard } from './guard.js';

export const WorkflowGuard = async ({ client, directory, worktree }, options = {}) => {
  const maxIdenticalFailures = options.maxIdenticalFailures ?? 2;
  const maxFailedChecks = options.maxFailedChecks ?? 3;
  if (!Number.isInteger(maxIdenticalFailures) || maxIdenticalFailures < 1 || maxIdenticalFailures > 10) throw new Error('workflow-guard: maxIdenticalFailures must be an integer from 1 to 10');
  if (!Number.isInteger(maxFailedChecks) || maxFailedChecks < 1 || maxFailedChecks > 10) throw new Error('workflow-guard: maxFailedChecks must be an integer from 1 to 10');
  const cwd = typeof directory === 'string' ? directory : directory?.worktree || worktree || process.cwd();
  const guard = createGuard({ client, directory: cwd, maxIdenticalFailures, maxFailedChecks });
  const ids = z.array(z.string().regex(/^wg_[a-f0-9]{24}$/)).max(20);
  const criterion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
  const owner = async context => {
    if (!['fusion-planner', 'deep-review'].includes(context.agent) || await guard.rootOf(context.sessionID) !== context.sessionID) throw new Error('workflow-guard: only the primary workflow owner may prepare or close a run');
  };
  return { ...guard.hooks, tool: {
    workflow_prepare: {
      description: 'Primary fusion-planner or standalone deep-review only: bind the verified worktree and declare non-mutating acceptance checks before execution. Register exact commands once; resumes send deltas. After repeated failures, include a bounded revised diagnosis to resume the same criterion. Never executes checks.',
      args: {
        workdir: z.string().min(1).max(4096),
        checks: z.array(z.object({ criterion, command: z.string().min(1).max(16000) })).max(20),
        diagnosis: z.object({ criterion, hypothesis: z.string().min(1).max(500), exitCondition: z.string().min(1).max(500) }).optional(),
      },
      execute: async (args, context) => {
        await owner(context);
        return JSON.stringify(await guard.prepare(context.sessionID, args.workdir, args.checks, args.diagnosis, context.callID));
      },
    },
    workflow_evidence: {
      description: 'Read attested native verification records for this run and check validity against current inputs. Never executes commands.',
      args: { ids },
      execute: async (args, context) => JSON.stringify(await guard.evidence(context.sessionID, args.ids)),
    },
    workflow_checkpoint: {
      description: 'Primary fusion-planner or standalone deep-review only: save completed/blocked/stopped state. Helpers return blockers to their parent. Completed requires current passing evidence; this is not a correctness review.',
      args: { state: z.enum(['completed', 'blocked', 'stopped']), required: ids, unresolvedCount: z.number().int().nonnegative().max(10000) },
      execute: async (args, context) => {
        await owner(context);
        return JSON.stringify(await guard.checkpoint(context.sessionID, args.state, args.required, args.unresolvedCount));
      },
    },
  } };
};
