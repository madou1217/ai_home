'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { runMcpCommand } = require('../lib/cli/services/mcp-command');
const demo = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-mcp-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = [];
  return { dir, output, context: { aiHomeDir: path.join(dir, 'aih'), hostHomeDir: path.join(dir, 'host'), consoleImpl: { log: value => output.push(String(value)), error: value => output.push(String(value)) } } };
}
test('MCP CLI performs actual lifecycle and stdio calls, and supports help at each level', async (t) => {
  const f = fixture(t);
  for (const action of ['list', 'add', 'test', 'tools', 'call', 'enable', 'disable', 'remove', 'doctor']) {
    assert.equal(await runMcpCommand(['mcp', action, '--help'], f.context), 0);
    assert.match(f.output.at(-1), /Usage: aih mcp/);
  }
  const run = (...args) => runMcpCommand(['mcp', ...args, '--provider', 'codex', '--json'], f.context);
  assert.equal(await run('add', 'demo', '--command', process.execPath, '--arg', demo), 0);
  for (const action of ['list', 'test', 'tools', 'enable']) assert.equal(await run(action, ...(action === 'list' ? [] : ['demo'])), 0);
  assert.equal(await run('call', 'demo', 'aih_echo', '--args-json', '{"text":"AIH_MCP_DEMO_OK"}'), 0);
  assert.equal(JSON.parse(f.output.at(-1)).results[0].result.content[0].text, 'AIH_MCP_DEMO_OK');
  for (const action of ['disable', 'remove']) assert.equal(await run(action, 'demo'), 0);
  assert.equal(await run('doctor'), 0);
});
test('MCP CLI rejects invalid selectors, unknown options and malformed inputs', async (t) => {
  const f = fixture(t);
  for (const args of [
    ['add', 'demo', '--command', process.execPath],
    ['add', 'demo', '--provider', 'codex', '--all-supported', '--command', process.execPath],
    ['add', 'demo', '--provider', 'missing', '--command', process.execPath],
    ['list', '--unknown'], ['call', 'demo', 'tool', '--args-json', 'bad'], ['tools', 'demo', '--provider']
  ]) assert.equal(await runMcpCommand(['mcp', ...args, '--json'], f.context), 1);
});
test('actual executable dispatches mcp list in an isolated home', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['bin/ai-home.js', 'mcp', 'list', '--json'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, AIH_HOME_DIR: f.context.aiHomeDir, AIH_HOST_HOME: f.context.hostHomeDir }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).resources, []);
});
