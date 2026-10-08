import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const hash = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'target', 'coverage', '.cache', '.next', '.nuxt', '.turbo', 'screenshots', 'videos']);
const sensitive = name => name === '.env' || name.startsWith('.env.') || /\.(pem|key|p12|pfx)$/.test(name) || ['auth.json', 'credentials', 'secrets', '.DS_Store'].includes(name);
const within = (root, target) => target === root || target.startsWith(root + path.sep);
const marker = description => /^verify:([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\s|$)/.exec(description || '')?.[1];

// Store hashes and bounded metadata, never command output, patch text or source.
export class Journal {
  constructor(directory, limit = 10000) { this.directory = directory; this.limit = limit; this.cache = new Map(); }
  async records() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await fs.readdir(this.directory)).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (names.length > this.limit) throw new Error('workflow-guard: journal capacity exceeded; preserve the checkpoint and inspect storage');
    await Promise.all(names.filter(name => !this.cache.has(name)).map(async name => {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
      if (value.version !== 1) throw new Error('workflow-guard: unsupported journal record');
      this.cache.set(name, value);
    }));
    return names.map(name => this.cache.get(name));
  }
  async put(key, value) {
    const records = await this.records();
    const filename = path.join(this.directory, hash(key) + '.json');
    try { await fs.access(filename); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (records.length >= this.limit) throw new Error('workflow-guard: journal capacity reached; preserve the checkpoint and inspect storage');
    const tmp = filename + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ ...value, version: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
    // Unique event keys and atomic publication allow replay across instances.
    await fs.rename(tmp, filename);
  }
}

export async function snapshot(directory, options = {}) {
  const root = await fs.realpath(directory);
  const entries = [];
  let bytes = 0;
  const skips = new Set();
  async function walk(folder) {
    const before = await fs.stat(folder);
    for (const item of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(item.name) || sensitive(item.name)) { skips.add(item.name); continue; }
      const absolute = path.join(folder, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (item.isSymbolicLink()) throw new Error('workflow-guard: verification input contains a symlink; use a supported checkout without source symlinks');
      if (item.isDirectory()) await walk(absolute);
      else if (item.isFile()) {
        const stat = await fs.stat(absolute);
        bytes += stat.size;
        if (entries.length >= (options.maxFiles || 20000) || bytes > (options.maxBytes || 128 * 1024 * 1024)) throw new Error('workflow-guard: verification snapshot exceeds its bound; no verification attested');
        const content = await fs.readFile(absolute);
        const after = await fs.stat(absolute);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('workflow-guard: inputs changed during snapshot; freeze writes before verification');
        entries.push([relative, hash(content), stat.mode & 0o777]);
      } else throw new Error('workflow-guard: unsupported verification input type');
    }
    const after = await fs.stat(folder);
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('workflow-guard: directory changed during snapshot; freeze writes before verification');
  }
  await walk(root);
  return { hash: hash(JSON.stringify(entries)), files: entries.length, bytes, excluded: [...skips].sort() };
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

const allowedActor = actor => /^fusion-(planner|code-worker|quick-edit|ops|review-deep|explorer|critic)$/.test(actor || '');

export function createGuard({ client, directory, stateDir, maxIdenticalFailures = 2, now = () => Date.now(), snapshotOptions = {} }) {
  const roles = new Map();
  const roots = new Map();
  const journals = new Map();
  const rootDirectory = path.resolve(directory);
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
  const snap = cwd => snapshot(cwd, snapshotOptions);
  const scopedDirectory = async value => {
    const cwd = await fs.realpath(path.resolve(rootDirectory, value || '.'));
    const base = await fs.realpath(rootDirectory);
    if (!within(base, cwd)) throw new Error('workflow-guard: marked verification must run inside this worktree');
    return cwd;
  };
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
  async function evidence(sessionID, ids) {
    const root = await rootOf(sessionID);
    const records = await journal(root).records();
    const snapshots = new Map();
    const results = [];
    for (const id of ids) {
      const record = records.find(r => r.kind === 'outcome' && r.evidenceID === id);
      if (!record) { results.push({ id, validity: 'unknown', reason: 'No attested native check in this run' }); continue; }
      if (!snapshots.has(record.directory)) {
        try { snapshots.set(record.directory, await snap(record.directory)); } catch { snapshots.set(record.directory, null); }
      }
      const current = snapshots.get(record.directory);
      const validity = record.exit !== 0 ? 'failed' : !record.stable ? 'changed-during-check' : !current ? 'unavailable' : current.hash !== record.snapshot.hash ? 'stale' : 'pass';
      results.push({ id, criterion: record.criterion, commandHash: record.commandHash, exit: record.exit, startedAt: record.startedAt, endedAt: record.endedAt,
        validity, snapshotHash: record.snapshot.hash, files: record.snapshot.files, excluded: record.snapshot.excluded });
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
      const criterion = input.tool === 'bash' && marker(output.args.description);
      if (input.tool === 'bash' && !criterion) return;
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
        record.patchKey = await patchFingerprint(patch, await fs.realpath(rootDirectory));
        if (!record.patchKey) return;
        const failures = (await store.records()).filter(r => r.kind === 'outcome' && r.patchKey === record.patchKey && r.failed).length;
        if (failures >= maxIdenticalFailures) throw new Error('workflow-guard: identical patch already failed ' + failures + ' times against unchanged inputs. Read the current owner block and revise the patch; a fresh helper does not reset this guard. Diagnostic tools remain available.');
      } else {
        const cwd = await scopedDirectory(output.args.workdir);
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
          const summary = { evidenceID: record.evidenceID, criterion: record.criterion, exit: record.exit, stable: record.stable };
          output.metadata = { ...output.metadata, workflowGuard: summary };
          output.output += '\n[workflow-guard] ' + JSON.stringify(summary);
        }
      }
    },
  };
  async function checkpoint(sessionID, state, required, unresolvedCount = 0) {
    const root = await rootOf(sessionID);
    const results = await evidence(sessionID, required);
    if (state === 'completed' && (!required.length || unresolvedCount || results.some(r => r.validity !== 'pass'))) throw new Error('workflow-guard: completion requires declared evidence passing on current inputs and zero unresolved items. Save a blocked checkpoint instead.');
    const records = await journal(root).records();
    const report = { state, root, at: now(), unresolvedCount, evidence: results, dispatches: records.filter(r => r.kind === 'dispatch').length,
      patchFailures: records.filter(r => r.kind === 'outcome' && r.tool === 'apply_patch' && r.failed).length };
    await journal(root).put('checkpoint:' + hash(JSON.stringify(report)), { kind: 'checkpoint', ...report });
    return report;
  }
  return { hooks, evidence, checkpoint, rootOf };
}
