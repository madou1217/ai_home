'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');
const { defaultProviderResourceRegistry: registry } = require('../lib/native-resources/provider-resource-registry');
const SOURCE = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');
const CLIENTS = [
  { provider: 'codex', binary: '/Users/model/.codex/packages/standalone/current/bin/codex.aih-original', version: ['--version'], list: ['mcp', 'list'], toolLoop: require('./codex-mcp-tool-loop-demo').runCodexMcpDemo },
  { provider: 'claude', binary: '/Users/model/.local/bin/claude', version: ['--version'], list: ['mcp', 'list'], toolLoop: require('./claude-mcp-tool-loop-demo').runClaudeMcpDemo },
  { provider: 'opencode', binary: '/Users/model/Library/pnpm/bin/opencode', version: ['--version'], list: ['mcp', 'list'], toolLoop: require('./opencode-mcp-tool-loop-demo').runOpenCodeMcpDemo },
  { provider: 'cline', binary: '/opt/homebrew/bin/cline', version: ['--version'], list: ['config', '--json'] }
];
function run(binary, args, options) {
  const result = spawnSync(binary, args, { ...options, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  return { status: result.status, signal: result.signal, stdout: String(result.stdout || '').slice(0, 4000), stderr: String(result.stderr || '').slice(0, 1200) };
}
function summarize(command) {
  return { status: command.status, signal: command.signal, stdout: command.stdout.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'), stderr: command.stderr.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') };
}
async function runMcpNativeDemo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-mcp-native-'));
  const fixture = { aiHomeDir: path.join(root, 'aih'), hostHomeDir: path.join(root, 'host') };
  const manager = createMcpManager(fixture);
  const stages = [];
  for (const client of CLIENTS) {
    const capability = registry.get(client.provider, 'mcp');
    if (!capability.projection || !fs.existsSync(client.binary)) {
      stages.push({ provider: client.provider, state: fs.existsSync(client.binary) ? 'projection-only' : 'runtime-unavailable', reason: capability.reason || 'native_cli_missing' });
      continue;
    }
    try {
      manager.add('aih-demo', { command: process.execPath, args: [SOURCE] }, { provider: client.provider });
      manager.enable('aih-demo', { provider: client.provider });
      const target = manager.list({ provider: client.provider }).resources[0];
      const rootConfig = target?.projections?.[0] || '';
      const enabled = run(client.binary, client.list, { cwd: root, env: { ...process.env, HOME: fixture.hostHomeDir, USERPROFILE: fixture.hostHomeDir, CODEX_HOME: path.join(fixture.hostHomeDir, '.codex'), CLAUDE_CONFIG_DIR: path.join(fixture.hostHomeDir, '.claude'), XDG_CONFIG_HOME: path.join(fixture.hostHomeDir, '.config'), XDG_DATA_HOME: path.join(fixture.hostHomeDir, '.local/share'), CLINE_DIR: path.join(fixture.hostHomeDir, '.cline'), CLINE_DATA_DIR: path.join(fixture.hostHomeDir, '.cline/data'), NO_PROXY: '127.0.0.1,localhost' } });
      const test = await manager.test('aih-demo', { provider: client.provider });
      const tools = await manager.tools('aih-demo', { provider: client.provider });
      const called = await manager.call('aih-demo', 'aih_echo', { text: 'AIH_MCP_DEMO_OK' }, { provider: client.provider });
      manager.disable('aih-demo', { provider: client.provider });
      const disabled = run(client.binary, client.list, { cwd: root, env: { ...process.env, HOME: fixture.hostHomeDir, USERPROFILE: fixture.hostHomeDir, CODEX_HOME: path.join(fixture.hostHomeDir, '.codex'), CLAUDE_CONFIG_DIR: path.join(fixture.hostHomeDir, '.claude'), XDG_CONFIG_HOME: path.join(fixture.hostHomeDir, '.config'), XDG_DATA_HOME: path.join(fixture.hostHomeDir, '.local/share'), CLINE_DIR: path.join(fixture.hostHomeDir, '.cline'), CLINE_DATA_DIR: path.join(fixture.hostHomeDir, '.cline/data'), NO_PROXY: '127.0.0.1,localhost' } });
      const nativeToolLoop = client.toolLoop ? await client.toolLoop(client.binary) : undefined;
      stages.push({ ...(nativeToolLoop ? { nativeToolLoop } : {}), provider: client.provider, binary: client.binary, version: summarize(run(client.binary, client.version, { env: process.env })), projection: rootConfig, managerTest: test.ok, tools: tools.map(x => x.name), call: called.content?.[0]?.text || '', nativeEnabled: summarize(enabled), nativeDisabled: summarize(disabled), passed: (!nativeToolLoop || nativeToolLoop.passed) && test.ok && tools.length === 2 && called.content?.[0]?.text === 'AIH_MCP_DEMO_OK' && enabled.status === 0 && disabled.status === 0 });
      manager.remove('aih-demo', { provider: client.provider });
    } catch (error) {
      stages.push({ provider: client.provider, passed: false, error: error.code || error.message });
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { inference: 'local-stdio-demo', stages, passed: stages.every(x => x.passed || ['runtime-unavailable', 'projection-only'].includes(x.state)) };
}
if (require.main === module) runMcpNativeDemo().then(x => { console.log(JSON.stringify(x, null, 2)); process.exitCode = x.passed ? 0 : 1; }).catch(e => { console.error(JSON.stringify({ error: e.code || e.message })); process.exitCode = 1; });
module.exports = { runMcpNativeDemo };
