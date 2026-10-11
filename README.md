# opencode-workflow-guard

Small OpenCode guard for Fusion: bound identical failed patches, record native
verification evidence, and persist blocked/completed checkpoints. No additional
model requests, check execution, billing logic or permission grants. Worktree
registration performs bounded read-only Git identity queries.

## Install

Pin the GitHub release in `opencode.json`, as with the cost guard:

```json
{
  "plugin": [["github:MRZ07/opencode-workflow-guard#v0.2.0", {"maxIdenticalFailures": 2}]]
}
```

Load it in a new OpenCode instance. Existing sessions/processes do not receive
new hooks automatically. Keep the cost guard for financial/token limits.

## Run preparation

The primary `fusion-planner` or standalone `deep-review` calls `workflow_prepare`
with the Ops-verified absolute `workdir` and `checks: [{criterion, command}]`.
Only exact declared commands receive automatic native markers; arbitrary commands
remain ordinary. Register non-mutating checks, never formatters or installs.
Sibling Git worktrees must have the same Git common directory. Unrelated external
repositories are rejected; bindings survive helper resumes and server restarts.

After `maxFailedChecks` distinct failing input snapshots per criterion (default 3,
configurable 1–10), further checks require a primary diagnosis. Reads remain
available. The helper returns its failure/hypothesis; the primary registers
`diagnosis: {criterion, hypothesis, exitCondition}` and resumes that same helper.
This resets the diagnostic window, preserves historical failures and never
extends a Cost Guard budget. A passing stable check resets the window. Repeated
checks of the same failing bytes count once; tool errors/unknown exits do not
count as failed fixes. The guard measures snapshots, not semantic fix cycles.

Runtime version and option fingerprints accompany preparation, native results
and checkpoints. No source, commands, check logs or diagnostic text are stored
in the journal; it stores hashes and bounded metadata only.

## Native verification

Use native `bash` with a stable criterion in its description:

```json
{
  "command": "pnpm test:vitest:run",
  "description": "verify:unit Run required unit tests",
  "workdir": "/absolute/selected/worktree",
  "timeout": 600000
}
```

The plugin hashes the current worktree before/after the command and records the
native exit status. The returned output/metadata includes a `wg_...` evidence ID.
The executor reports this ID with the exact command and its normal compact result.
The parent calls `workflow_evidence` with the IDs before relying on them.

Evidence states: `pass`, `failed`, `changed-during-check`, `stale`, `unavailable`,
`unknown`. Missing exit status never passes. A reused ID remains reuse; a new
requested execution needs a new ID/start time. Subsequent edits invalidate old
evidence. Put mutating formatters in separate, unmarked calls, then run checks.
Use explicit native `workdir` for a subdirectory; do not hide a changed working
directory in `cd ...` and expect the snapshot scope to follow it. Normal calls
without `verify:` are not attested. Context Mode wrappers are not attested.

`workflow_checkpoint` takes `state`, `required` evidence IDs and
`unresolvedCount`. Only `fusion-planner`/`deep-review` can call it. Completed
requires at least one declared check passing on current inputs and no unresolved
items. Blocked/stopped states preserve the partial result and dispatch/patch
failure counts. This validates **declared** requirements; the lead remains
responsible for declaring all applicable gates and interpreting correctness.
For tasks without applicable command checks, use the existing task report rather
than manufacturing a check just to obtain a completed checkpoint.
An actual Cost Guard tool error automatically persists a blocked checkpoint,
even when the budget guard prevents further checkpoint-tool calls. This stores
only the blocker category; no additional model request or budget approval.

## Repetition protection

Fusion actors are identified from runtime agent/message metadata. After two
native patch-context failures of identical patch text against unchanged file
contents, another identical attempt is blocked. Read tools, diagnosis, revised
patches and changed inputs remain available. Counts follow canonical session
ancestry, so replacing the helper does not reset them. Cancellation/permission
errors do not count. External-path patches are not inspected or guarded.
Dispatch counts are observed, not capped: tier budgets need explicit plan/run
criteria that this version does not guess from prose.

## Bounds and limitations

- Fusion actors and `deep-review` are instrumented; unrelated agents retain their workflow.
- Native permissions still decide whether a tool can execute. Custom tools only
  read verification metadata and write checkpoint metadata, never execute shell.
- Source snapshots cover regular files, contents and modes; common generated,
  dependency and sensitive paths are excluded and exclusions are reported.
  Excluded/environment/remote inputs are not attested. Symlinked source,
  unsupported file types and snapshots over 20,000 files / 128 MiB fail explicitly.
- Do not write verification inputs while checks run. Before/after snapshots
  detect changed end states, not a change temporarily applied and reverted during
  execution. Keep the existing write barrier. A zero exit does not prove test
  quality or all acceptance criteria.
- Events capture failed tools because the after hook may not execute for them.
  Atomic, immutable journal events are replayed without duplicate counting;
  serialized repeats persist across restart/compaction/helper replacement.
  Simultaneous in-flight failures can overshoot the repetition threshold.
- State lives under `$XDG_STATE_HOME/opencode/workflow-guard/`, or
  `~/.local/state/opencode/workflow-guard/`, keyed by worktree and root session.
  It contains bounded IDs/hashes/counts/timestamps, not source, patches, commands
  or full logs. At 10,000 events a run fails explicitly; no automatic deletion.
- No auto-restart, config hot-reload, semantic fix-cycle classification,
  arbitrary-script parsing, final-prose filtering or automatic user approval.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run test:integration
```

Integration requires an installed `opencode`; it uses an isolated configuration,
temporary worktree and deterministic localhost model, without paid model calls.
