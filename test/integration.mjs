import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-guard-integration-'));
const project = path.join(temp, 'project');
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'source.js'), 'old\n');
spawnSync('git', ['init', '-q', project]);
for (const args of [['add', 'source.js'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]) {
  assert.equal(spawnSync('git', args, { cwd: project }).status, 0);
}
const selected = path.join(temp, 'selected');
assert.equal(spawnSync('git', ['worktree', 'add', '-q', '-b', 'selected', selected], { cwd: project }).status, 0);

const seen = [];
const costMode = !!process.env.WORKFLOW_GUARD_COST_PLUGIN_PATH;
const actor = process.env.WORKFLOW_GUARD_TEST_AGENT || 'fusion-planner';
assert.ok(['fusion-planner', 'deep-review'].includes(actor), 'Unsupported integration actor');
let step = 0;
let evidenceID;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages || [];
  const toolMessages = messages.filter(m => m.role === 'tool');
  const last = toolMessages.at(-1)?.content || '';
  if (toolMessages.length) seen.push(String(last));
  evidenceID ||= /wg_[a-f0-9]{24}/.exec(String(last))?.[0];
  let tool;
  let args;
  if (body.tools?.some(t => t.function?.name === 'workflow_evidence')) {
    step++;
    const badPatch = '*** Begin Patch\n*** Update File: source.js\n@@\n-missing\n+new\n*** End Patch';
    if (step <= 3) { tool = 'apply_patch'; args = { patchText: badPatch }; }
    if (step === 4) { tool = 'workflow_prepare'; args = { workdir: selected, checks: [{ criterion: 'unit', command: 'node -e "process.exit(0)"' }] }; }
    if (step === 5) { tool = 'bash'; args = { command: 'node -e "process.exit(0)"', workdir: selected, description: 'Run declared check', timeout: 10000 }; }
    if (step === 6) { tool = 'workflow_evidence'; args = { ids: [evidenceID] }; }
    if (step === 7) { tool = 'bash'; args = { command: 'node -e "require(\'fs\').appendFileSync(\'source.js\', \'changed\\n\')"', workdir: selected, description: 'Mutate owned integration fixture', timeout: 10000 }; }
    if (step === 8) { tool = 'workflow_evidence'; args = { ids: [evidenceID] }; }
    if (step === 9) { tool = 'workflow_checkpoint'; args = { state: 'completed', required: [evidenceID], unresolvedCount: 0 }; }
    if (step === 10) { tool = 'workflow_checkpoint'; args = { state: 'blocked', required: [evidenceID], unresolvedCount: 1 }; }
    if (costMode) {
      tool = step <= 2 ? 'read' : undefined;
      args = { filePath: path.join(project, 'source.js') };
    }
  }
  const delta = tool ? { tool_calls: [{ index: 0, id: 'call_' + step, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: 'Integration complete' };
  const chunk = choices => ({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify(chunk([{ index: 0, delta, finish_reason: null }])) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk([{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configRoot = path.join(temp, 'config');
await fs.mkdir(path.join(configRoot, 'opencode'), { recursive: true });
const config = {
  plugin: [pathToFileURL(process.env.WORKFLOW_GUARD_PLUGIN_PATH || path.join(repo, 'index.js')).href],
  model: 'workflow_test/gpt-6.1', small_model: 'workflow_test/gpt-6.1', default_agent: actor, autoupdate: false,
  lsp: false, formatter: false, permission: { '*': 'allow' },
  agent: { [actor]: { mode: 'primary', permission: { '*': 'allow' }, prompt: 'Execute the deterministic integration tool sequence.' } },
  provider: { workflow_test: { npm: '@ai-sdk/openai-compatible', name: 'Workflow test', options: { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'local-test-only' }, models: { 'gpt-6.1': { name: 'gpt-6.1', limit: { context: 128000, output: 8192 }, tool_call: true } } } },
};
if (costMode) {
  const guard = [pathToFileURL(process.env.WORKFLOW_GUARD_COST_PLUGIN_PATH).href, { action: 'block', onBlock: 'ask', tokenLimit: 1, persist: false }];
  if (process.env.WORKFLOW_GUARD_TEST_REVERSE_ORDER) config.plugin.push(guard);
  else config.plugin.unshift(guard); // Match the live Cost Guard -> Workflow Guard order.
}
await fs.writeFile(path.join(configRoot, 'opencode', 'opencode.json'), JSON.stringify(config));
const env = { ...process.env, XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: path.join(temp, 'data'), XDG_CACHE_HOME: path.join(temp, 'cache'), XDG_STATE_HOME: path.join(temp, 'state'), OPENCODE_CONFIG_DIR: path.join(configRoot, 'opencode') };
delete env.OPENCODE_CONFIG; delete env.OPENCODE_CONFIG_CONTENT;
delete env.OPENCODE_COST_GUARD_ACTION; delete env.OPENCODE_COST_GUARD_LIMIT;
env.OPENCODE_COST_GUARD_CONFIG = path.join(configRoot, 'budget.json');
await fs.writeFile(env.OPENCODE_COST_GUARD_CONFIG, '{}');
// Use an owned server: newer CLIs resolve `debug config` through a shared service.
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const host = spawn(process.env.OPENCODE_BIN || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
  { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
let hostErrors = '';
host.stderr.on('data', chunk => { hostErrors += chunk; });
host.stdout.resume();
const baseURL = `http://127.0.0.1:${port}`;
const api = async (route, method = 'GET', body) => {
  const response = await fetch(baseURL + route + '?directory=' + encodeURIComponent(project),
    { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(method === 'POST' ? 80000 : 5000) });
  assert.ok(response.ok, `Owned server ${route}: ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /application\/json/, 'This integration requires the native plugin server API (/global/health, /config); choose its executable with OPENCODE_BIN');
  return response.json();
};
let output = '';
try {
  const deadline = Date.now() + 45000;
  while (true) {
    try { await api('/global/health'); break; }
    catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      if (Date.now() >= deadline || host.exitCode != null) throw new Error(hostErrors.slice(-1000) || error.message);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const parsed = await api('/config');
  assert.deepEqual(parsed.plugin, config.plugin, 'Integration must load only the exact owned-fixture plugins');
  const session = await api('/session', 'POST', {});
  const result = await api(`/session/${session.id}/message`, 'POST', {
    agent: actor, parts: [{ type: 'text', text: 'WORKFLOW_GUARD_INTEGRATION' }],
  });
  output = JSON.stringify(result);
  if (costMode) {
    assert.ok(seen.some(s => s.includes('cost-guard:')), 'Real cost guard did not block the native call');
    const state = path.join(temp, 'state', 'opencode', 'workflow-guard');
    const records = [];
    async function walk(folder) {
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name);
        if (item.isDirectory()) await walk(file);
        else if (item.name.endsWith('.json')) records.push(JSON.parse(await fs.readFile(file, 'utf8')));
      }
    }
    await walk(state);
    assert.ok(records.some(r => r.kind === 'checkpoint' && r.state === 'blocked' && r.blocker === 'cost-guard'), 'Actual budget error did not persist the blocked checkpoint');
    console.log(`Native cost-guard integration passed (${actor}): blocked checkpoint saved without another tool call.`);
  } else {
  assert.ok(seen.some(s => s.includes('identical patch already failed 2')), 'Native failed-tool event repetition guard did not fire');
  assert.ok(seen.some(s => s.includes('"validity":"pass"')), 'Native check was not attested');
  assert.ok(seen.some(s => s.includes('"validity":"stale"')), 'Changed bytes did not invalidate evidence');
  assert.ok(seen.some(s => s.includes('completion requires')), 'Stale completion was not blocked');
  assert.ok(seen.some(s => s.includes('"state":"blocked"')), 'Blocked checkpoint missing');
  assert.equal(await fs.readFile(path.join(selected, 'source.js'), 'utf8'), 'old\nchanged\n', 'Native command must mutate only the selected worktree fixture');
  assert.equal(await fs.readFile(path.join(project, 'source.js'), 'utf8'), 'old\n', 'Original repository must remain unchanged');
  const attestation = JSON.parse(seen.find(s => s.startsWith('[{') && s.includes('"validity":"pass"')))[0];
  assert.equal(attestation.directory, await fs.realpath(selected), 'Evidence must identify the exact selected worktree');
  console.log('Native OpenCode integration passed: repeat blocked, check attested, stale evidence rejected, checkpoint saved.');
  }
} catch (error) {
  await fs.writeFile(path.join(temp, 'diagnostic.json'), JSON.stringify({ step, seen, output, errors: hostErrors }, null, 2));
  console.error('Owned-fixture diagnostics:', path.join(temp, 'diagnostic.json'));
  throw error;
} finally {
  host.kill('SIGTERM');
  if (host.exitCode == null && host.signalCode == null) await new Promise(resolve => host.once('close', resolve));
  await new Promise(resolve => server.close(resolve));
}
