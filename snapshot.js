import { createHash } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const hash = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'target', 'coverage', '.cache', '.next', '.nuxt', '.turbo', 'screenshots', 'videos']);
const sensitive = name => name === '.env' || name.startsWith('.env.') || /\.(pem|key|p12|pfx)$/.test(name) || ['auth.json', 'credentials', 'secrets', '.DS_Store'].includes(name);

export const DEFAULT_SNAPSHOT_LIMITS = Object.freeze({ maxBytes: 512 * 1024 * 1024, maxFiles: 20000, maxEntries: 40000, maxDurationMs: 60000 });
const CHUNK_BYTES = 64 * 1024;
const stable = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function snapshotLimits(options = {}) {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options };
  for (const key of Object.keys(DEFAULT_SNAPSHOT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error('workflow-guard: ' + key + ' must be a positive safe integer');
  }
  return limits;
}

// One reusable file buffer and bounded directory/manifest collections. No partial
// snapshot can attest; cancellation/deadlines are checked after pending I/O too.
export async function snapshot(directory, options = {}) {
  const limits = snapshotLimits(options);
  const clock = options.clock || (() => performance.now());
  const started = clock();
  const check = () => {
    if (options.signal?.aborted) throw new Error('workflow-guard: verification snapshot cancelled; no verification attested');
    if (clock() - started >= limits.maxDurationMs) throw new Error('workflow-guard: verification snapshot deadline exceeded; no verification attested');
  };
  const io = async operation => { check(); const value = await operation(); check(); return value; };
  check();
  const root = await io(() => fs.realpath(directory));
  const entries = [];
  const skips = new Set();
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  let encountered = 0;
  const changed = () => new Error('workflow-guard: inputs changed during snapshot; freeze writes before verification');
  async function walk(folder) {
    check();
    const before = await io(() => fs.lstat(folder));
    if (before.isSymbolicLink()) throw new Error('workflow-guard: verification input contains a symlink; use a supported checkout without source symlinks');
    if (!before.isDirectory()) throw changed();
    let dir;
    const children = [];
    try {
      // Assign handles before the post-I/O check so late cancellation cannot leak them.
      dir = await fs.opendir(folder, { bufferSize: 32 }); check();
      while (true) {
        const item = await io(() => dir.read());
        if (!item) break;
        if (++encountered > limits.maxEntries) throw new Error('workflow-guard: snapshot entry budget exceeded; no verification attested');
        if (excluded.has(item.name) || sensitive(item.name)) { skips.add(item.name); continue; }
        children.push(item.name);
      }
    } finally { if (dir) await dir.close(); }
    check();
    for (const name of children.sort((a, b) => a.localeCompare(b))) {
      const absolute = path.join(folder, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const beforeFile = await io(() => fs.lstat(absolute));
      if (beforeFile.isSymbolicLink()) throw new Error('workflow-guard: verification input contains a symlink; use a supported checkout without source symlinks');
      if (beforeFile.isDirectory()) await walk(absolute);
      else if (beforeFile.isFile()) {
        if (entries.length >= limits.maxFiles || beforeFile.size > limits.maxBytes - bytes) throw new Error('workflow-guard: verification snapshot exceeds its bound; no verification attested');
        let file;
        try {
          check();
          file = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); check();
          const opened = await io(() => file.stat());
          if (!opened.isFile() || !stable(beforeFile, opened)) throw changed();
          const content = createHash('sha256');
          let fileBytes = 0;
          while (true) {
            const { bytesRead } = await io(() => file.read(buffer, 0, buffer.length, null));
            if (!bytesRead) break;
            bytes += bytesRead; fileBytes += bytesRead;
            if (bytes > limits.maxBytes) throw new Error('workflow-guard: verification snapshot exceeds its bound; no verification attested');
            content.update(buffer.subarray(0, bytesRead));
          }
          const afterHandle = await io(() => file.stat());
          const afterPath = await io(() => fs.lstat(absolute));
          if (fileBytes !== beforeFile.size || !stable(beforeFile, afterHandle) || !stable(beforeFile, afterPath)) throw changed();
          entries.push([relative, content.digest('hex'), beforeFile.mode & 0o777]);
        } finally { if (file) await file.close(); }
        check();
      } else throw new Error('workflow-guard: unsupported verification input type');
    }
    const after = await io(() => fs.lstat(folder));
    if (!stable(before, after)) throw changed();
  }
  await walk(root);
  check();
  const result = { hash: hash(JSON.stringify(entries)), files: entries.length, bytes, excluded: [...skips].sort() };
  check();
  return result;
}
