import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const git = promisify(execFile);
export const VERSION = '0.2.1';
import { snapshot } from './snapshot.js';
export { snapshot } from './snapshot.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const within = (root, target) => target === root || target.startsWith(root + path.sep);
const marker = description => /^verify:([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s|$)/.exec(description || '')?.[1];
const checkCancellation = signal => {
  if (signal?.aborted) throw new Error('workflow-guard: operation cancelled; no completion published');
};

// Store hashes and bounded metadata, never command output, patch text or source.
export class Journal {
  constructor(directory, limit = 10000) { this.directory = directory; this.limit = limit; this.cache = new Map(); }
  async records(create = true) {
    if (create) await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let files;
    try { files = await fs.readdir(this.directory); } catch (error) { if (!create && error.code === 'ENOENT') return []; throw error; }
    const names = files.filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (names.length > this.limit) throw new Error('workflow-guard: journal capacity exceeded; preserve the checkpoint and inspect storage');
    await Promise.all(names.filter(name => !this.cache.has(name)).map(async name => {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
      if (value.version !== 1) throw new Error('workflow-guard: unsupported journal record');
      this.cache.set(name, value);
    }));
    return names.map(name => this.cache.get(name));
  }
  async put(key, value, signal) {
    checkCancellation(signal);
    const records = await this.records();
    checkCancellation(signal);
    const filename = path.join(this.directory, hash(key) + '.json');
    try { await fs.access(filename); checkCancellation(signal); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (records.length >= this.limit) throw new Error('workflow-guard: journal capacity reached; preserve the checkpoint and inspect storage');
    const tmp = filename + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    let published = false;
    try {
      try {
        await fs.writeFile(tmp, JSON.stringify({ ...value, version: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
        checkCancellation(signal);
        // Atomically publish without overwriting another instance's same-key record.
        try { await fs.link(tmp, filename); published = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { await fs.rm(tmp, { force: true }); }
      // Cleanup is part of the transaction: cancellation during it also rolls back.
      checkCancellation(signal);
    } catch (error) {
      if (published && signal?.aborted) { await fs.unlink(filename); this.cache.delete(path.basename(filename)); }
      throw error;
    }
  }
}

export function patchPaths(patch, directory) {
  const paths = [];
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match) paths.push(path.resolve(directory, match[1].trim()));
  }
  return [...new Set(paths)].sort();
}

async function patchFingerprint(patch, directory) {
  const files = patchPaths(patch, directory);
  if (!files.length) return hash('unparsed:' + patch);
  const states = [];
  for (const file of files) {
    if (!within(directory, file)) return null; // Do not inspect external files before native permission checks.
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) return null;
      // Parent directories can also be symlinks.
      if (!within(directory, await fs.realpath(file))) return null;
      states.push([file, hash(await fs.readFile(file))]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      states.push([file, 'missing']);
    }
  }
  return hash(JSON.stringify([patch.replace(/\r\n/g, '\n'), states]));
}

const allowedActor = actor => actor === 'deep-review' || /^fusion-(planner|code-worker|quick-edit|ops|review-deep|explorer|critic)$/.test(actor || '');

export function createGuard({ client, directory, stateDir, maxIdenticalFailures = 2, maxFailedChecks = 3, now = () => Date.now(), snapshotOptions = {} }) {
  const roles = new Map();
  const roots = new Map();
  const journals = new Map();
  const rootDirectory = path.resolve(directory);
  const runtime = { version: VERSION, optionsHash: hash(JSON.stringify({ maxIdenticalFailures, maxFailedChecks, snapshotOptions })).slice(0, 16) };
  const storage = stateDir || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'opencode', 'workflow-guard', hash(rootDirectory));
  const journal = root => {
    if (!journals.has(root)) journals.set(root, new Journal(path.join(storage, hash(root))));
    return journals.get(root);
  };
  const rootOf = async sessionID => {
    if (roots.has(sessionID)) return roots.get(sessionID);
    let current = sessionID;
    const visited = [];
    for (let depth = 0; depth < 32; depth++) {
      if (visited.includes(current)) throw new Error('workflow-guard: session ancestry cycle');
      visited.push(current);
      const response = await client.session.get({ path: { id: current } });
      const info = response?.data || response;
      if (info?.id !== current) throw new Error('workflow-guard: session ancestry unavailable; no unverified child-to-root attribution');
      if (!info.parentID) { for (const id of visited) roots.set(id, current); return current; }
      current = info.parentID;
    }
    throw new Error('workflow-guard: session ancestry exceeds its bound');
  };
  const roleOf = async sessionID => {
    if (roles.has(sessionID)) return roles.get(sessionID);
    if (!client.session.messages) return null;
    const response = await client.session.messages({ path: { id: sessionID }, query: { limit: 2 } });
    const messages = response?.data || response;
    const assistant = Array.isArray(messages) && [...messages].reverse().find(m => m.info?.role === 'assistant');
    if (assistant?.info?.agent) roles.set(sessionID, assistant.info.agent);
    return roles.get(sessionID);
  };
  const snap = (cwd, signal) => snapshot(cwd, { ...snapshotOptions, ...(signal ? { signal } : {}) });
  const scopedDirectory = async (value, root) => {
    const cwd = await fs.realpath(path.resolve(rootDirectory, value || '.'));
    const base = await fs.realpath(rootDirectory);
    const bindings = (await journal(root).records()).filter(r => r.kind === 'binding');
    if (!within(base, cwd) && !bindings.some(r => within(r.directory, cwd))) throw new Error('workflow-guard: marked verification must run inside this worktree; the primary must prepare the selected Git worktree first');
    return cwd;
  };
  async function prepare(sessionID, workdir, checks, diagnosis, callID) {
    const root = await rootOf(sessionID);
    if (root !== sessionID) throw new Error('workflow-guard: only the primary root may prepare a run');
    const cwd = await fs.realpath(path.resolve(rootDirectory, workdir));
    const base = await fs.realpath(rootDirectory);
    if (!within(base, cwd)) {
      const common = async dir => {
        const { stdout } = await git('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 10000, maxBuffer: 4096 });
        return fs.realpath(stdout.trim());
      };
      if (await common(base) !== await common(cwd)) throw new Error('workflow-guard: selected worktree belongs to another repository');
      const { stdout } = await git('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10000, maxBuffer: 4096 });
      if (await fs.realpath(stdout.trim()) !== cwd) throw new Error('workflow-guard: select the Git worktree root');
    }
    const store = journal(root);
    const records = await store.records();
    if (new Set(checks.map(c => c.criterion)).size !== checks.length) throw new Error('workflow-guard: duplicate check criterion');
    if (new Set(checks.map(c => c.command)).size !== checks.length) throw new Error('workflow-guard: command must have one criterion');
    if (diagnosis && !checks.some(c => c.criterion === diagnosis.criterion) && !records.some(r => r.kind === 'check' && r.directory === cwd && r.criterion === diagnosis.criterion)) throw new Error('workflow-guard: diagnosis requires a declared criterion');
    for (const check of checks) {
      const commandHash = hash(check.command);
      const prior = records.find(r => r.kind === 'check' && r.directory === cwd && r.commandHash === commandHash);
      if (prior && prior.criterion !== check.criterion) throw new Error('workflow-guard: command already belongs to another criterion');
    }
    await store.put('binding:' + cwd, { kind: 'binding', directory: cwd, at: now(), runtime });
    for (const check of checks) {
      const commandHash = hash(check.command);
      await store.put('check:' + cwd + ':' + check.criterion + ':' + commandHash, { kind: 'check', directory: cwd, criterion: check.criterion, commandHash });
    }
    if (diagnosis) await store.put('diagnosis:' + sessionID + ':' + (callID || randomUUID()), {
      kind: 'diagnosis', directory: cwd, criterion: diagnosis.criterion,
      hypothesisHash: hash(diagnosis.hypothesis), exitConditionHash: hash(diagnosis.exitCondition), at: now(),
    });
    return { directory: cwd, checks: checks.map(c => c.criterion), diagnosticCriterion: diagnosis?.criterion || null, maxFailedChecks, runtime };
  }
  function failures(records, directory, criterion) {
    let count = 0;
    const seen = new Set();
    for (const r of records.filter(r => r.directory === directory && r.criterion === criterion).sort((a, b) => (a.startedAt ?? a.at ?? 0) - (b.startedAt ?? b.at ?? 0))) {
      if (r.kind === 'diagnosis' || (r.kind === 'outcome' && r.exit === 0 && r.stable)) { count = 0; seen.clear(); }
      else if (r.kind === 'outcome' && Number.isInteger(r.exit) && r.exit !== 0 && r.stable && !seen.has(r.snapshot.hash)) { seen.add(r.snapshot.hash); count++; }
    }
    return count;
  }
  async function complete(input, state) {
    if (!input.sessionID || !input.callID) return;
    const root = await rootOf(input.sessionID);
    const store = journal(root);
    const records = await store.records();
    const attempt = records.find(r => r.kind === 'attempt' && r.sessionID === input.sessionID && r.callID === input.callID);
    if (!attempt || records.some(r => r.kind === 'outcome' && r.sessionID === input.sessionID && r.callID === input.callID)) return;
    if (state.status !== 'completed' && state.status !== 'error') return;
    let result = { kind: 'outcome', sessionID: input.sessionID, callID: input.callID, tool: attempt.tool, endedAt: now() };
    if (attempt.tool === 'apply_patch') {
      result.patchKey = attempt.patchKey;
      result.failed = state.status === 'error' && /verification failed|failed to find expected|invalid patch|failed to parse patch/i.test(state.error || '');
    } else {
      const exit = state.status === 'completed' && Number.isInteger(state.metadata?.exit) ? state.metadata.exit : null;
      let after = null;
      try { after = await snap(attempt.directory); } catch { /* An incomplete snapshot can never pass. */ }
      result = { ...result, evidenceID: attempt.evidenceID, criterion: attempt.criterion, startedAt: attempt.startedAt, commandHash: attempt.commandHash,
        directory: attempt.directory, snapshot: attempt.snapshot, exit, stable: !!after && after.hash === attempt.snapshot.hash };
    }
    await store.put('outcome:' + input.sessionID + ':' + input.callID, result);
  }
  async function evidence(sessionID, ids, signal) {
    const root = await rootOf(sessionID);
    const records = await journal(root).records();
    const snapshots = new Map();
    const results = [];
    for (const id of ids) {
      const record = records.find(r => r.kind === 'outcome' && r.evidenceID === id);
      if (!record) { results.push({ id, validity: 'unknown', reason: 'No attested native check in this run' }); continue; }
      if (!snapshots.has(record.directory)) {
        try { snapshots.set(record.directory, await snap(record.directory, signal)); } catch { snapshots.set(record.directory, null); }
      }
      const current = snapshots.get(record.directory);
      const validity = record.exit !== 0 ? 'failed' : !record.stable ? 'changed-during-check' : !current ? 'unavailable' : current.hash !== record.snapshot.hash ? 'stale' : 'pass';
      results.push({ id, criterion: record.criterion, commandHash: record.commandHash, exit: record.exit, startedAt: record.startedAt, endedAt: record.endedAt,
        validity, directory: record.directory, snapshotHash: record.snapshot.hash, files: record.snapshot.files, excluded: record.snapshot.excluded });
    }
    return results;
  }
  const hooks = {
    'chat.params': async input => { if (input.agent) roles.set(input.sessionID, input.agent); },
    event: async ({ event }) => {
      if (event.type === 'message.updated') {
        const info = event.properties?.info;
        if (info?.role === 'assistant' && info.agent) roles.set(info.sessionID, info.agent);
      }
      if (event.type === 'message.part.updated') {
        const part = event.properties?.part;
        if (part?.type === 'tool' && part.state?.status === 'error' && /^cost-guard:/.test(part.state.error || '') && allowedActor(await roleOf(part.sessionID))) {
          // Cost Guard can deny checkpoint tools too. Persist the blocked state
          // from its actual error event without dispatching a tool or model.
          const root = await rootOf(part.sessionID);
          await journal(root).put('budget-block:' + part.sessionID + ':' + part.callID,
            { kind: 'checkpoint', state: 'blocked', root, at: now(), blocker: 'cost-guard', unresolvedCount: null });
        }
        if (part?.type === 'tool' && ['apply_patch', 'bash'].includes(part.tool) && ['error', 'completed'].includes(part.state?.status)) {
          if (part.tool === 'bash' && !marker(part.state.input?.description)) return;
          // Ignore unrelated actors before any ancestry/API or disk work.
          if (!allowedActor(await roleOf(part.sessionID))) return;
          await complete({ sessionID: part.sessionID, callID: part.callID }, part.state);
        }
      }
    },
    'tool.execute.before': async (input, output) => {
      if (!['apply_patch', 'bash', 'task'].includes(input.tool) || !allowedActor(await roleOf(input.sessionID))) return;
      let criterion = input.tool === 'bash' && marker(output.args.description);
      if (input.tool === 'bash' && !criterion) {
        // Only explicitly registered checks are promoted; ordinary commands stay untouched.
        const root = await rootOf(input.sessionID);
        const cwd = await fs.realpath(path.resolve(rootDirectory, output.args.workdir || '.'));
        const declared = (await journal(root).records(false)).find(r => r.kind === 'check' && r.directory === cwd && r.commandHash === hash(output.args.command || ''));
        if (!declared) return;
        criterion = declared.criterion;
        output.args.description = 'verify:' + criterion + ' Declared acceptance check';
      }
      const root = await rootOf(input.sessionID);
      const store = journal(root);
      if (input.tool === 'task') {
        await store.put('dispatch:' + input.sessionID + ':' + input.callID, { kind: 'dispatch', sessionID: input.sessionID, callID: input.callID, at: now() });
        return;
      }
      const record = { kind: 'attempt', sessionID: input.sessionID, callID: input.callID, tool: input.tool, startedAt: now() };
      if (input.tool === 'apply_patch') {
        const patch = output.args.patchText;
        if (typeof patch !== 'string') return;
        // Fingerprint only files inside the original or explicitly bound checkout.
        const records = await store.records();
        const base = await fs.realpath(rootDirectory);
        const paths = patchPaths(patch, base);
        const binding = records.find(r => r.kind === 'binding' && paths.length && paths.every(file => within(r.directory, file)));
        record.patchKey = await patchFingerprint(patch, binding?.directory || base);
        if (!record.patchKey) return;
        const failures = (await store.records()).filter(r => r.kind === 'outcome' && r.patchKey === record.patchKey && r.failed).length;
        if (failures >= maxIdenticalFailures) throw new Error('workflow-guard: identical patch already failed ' + failures + ' times against unchanged inputs. Read the current owner block and revise the patch; a fresh helper does not reset this guard. Diagnostic tools remain available.');
      } else {
        const cwd = await scopedDirectory(output.args.workdir, root);
        const records = await store.records();
        const declared = records.filter(r => r.kind === 'check' && r.directory === cwd && r.criterion === criterion);
        if (declared.length && !declared.some(r => r.commandHash === hash(output.args.command || ''))) throw new Error('workflow-guard: command differs from the declared criterion; return the change to the primary');
        const count = failures(records, cwd, criterion);
        if (count >= maxFailedChecks) throw new Error(`workflow-guard: ${criterion} failed on ${count} distinct input snapshots. Return the last failure and hypothesis to the primary; it must prepare a bounded diagnosis before more checks. Reads remain available; a fresh helper does not reset this boundary.`);
        record.directory = cwd;
        record.criterion = criterion;
        record.commandHash = hash(output.args.command || '');
        record.snapshot = await snap(cwd);
        record.evidenceID = 'wg_' + hash(input.sessionID + ':' + input.callID).slice(0, 24);
      }
      await store.put('attempt:' + input.sessionID + ':' + input.callID, record);
    },
    'tool.execute.after': async (input, output) => {
      if (!['apply_patch', 'bash'].includes(input.tool) || !allowedActor(await roleOf(input.sessionID))) return;
      if (input.tool === 'bash' && !marker(input.args?.description)) return;
      await complete(input, { status: 'completed', metadata: output.metadata });
      if (input.tool === 'bash') {
        const root = await rootOf(input.sessionID);
        const record = (await journal(root).records()).find(r => r.kind === 'outcome' && r.sessionID === input.sessionID && r.callID === input.callID && r.evidenceID);
        if (record) {
          const summary = { evidenceID: record.evidenceID, criterion: record.criterion, exit: record.exit, stable: record.stable,
            failedChecks: failures(await journal(root).records(), record.directory, record.criterion), runtime };
          output.metadata = { ...output.metadata, workflowGuard: summary };
          output.output += '\n[workflow-guard] ' + JSON.stringify(summary);
        }
      }
    },
  };
  async function checkpoint(sessionID, state, required, unresolvedCount = 0, signal) {
    checkCancellation(signal);
    const root = await rootOf(sessionID);
    const results = await evidence(sessionID, required, signal);
    if (state === 'completed' && (!required.length || unresolvedCount || results.some(r => r.validity !== 'pass'))) throw new Error('workflow-guard: completion requires declared evidence passing on current inputs and zero unresolved items. Save a blocked checkpoint instead.');
    const records = await journal(root).records();
    checkCancellation(signal);
    const report = { state, root, at: now(), runtime, unresolvedCount, evidence: results, dispatches: records.filter(r => r.kind === 'dispatch').length,
      patchFailures: records.filter(r => r.kind === 'outcome' && r.tool === 'apply_patch' && r.failed).length };
    await journal(root).put('checkpoint:' + hash(JSON.stringify(report)), { kind: 'checkpoint', ...report }, signal);
    checkCancellation(signal);
    return report;
  }
  return { hooks, evidence, checkpoint, prepare, rootOf };
}
