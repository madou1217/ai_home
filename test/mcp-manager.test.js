'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const TOML = require('smol-toml');
const jsonc = require('jsonc-parser');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');
const demo = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');
const server = { command: process.execPath, args: [demo] };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-mcp-manager-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { aiHomeDir: path.join(dir, 'aih'), hostHomeDir: path.join(dir, 'host') };
  return { dir, options, manager: createMcpManager(options) };
}
const cases = [
  ['codex', '.codex/config.toml', '# User comment\nmodel = "keep"\n[mcp_servers.foreign]\ncommand = "user-owned"\n', d => TOML.parse(d).mcp_servers, 'command'],
  ['claude', '.claude/.claude.json', '{"userField":true,"mcpServers":{"foreign":{"command":"user-owned"}}}', d => JSON.parse(d).mcpServers, 'command'],
  ['opencode', '.config/opencode/opencode.json', '{\n// User comment\n"theme":"keep", "mcp":{"foreign":{"type":"local","command":["user-owned"]}}\n}', d => jsonc.parse(d).mcp, 'command'],
  ['gemini', '.gemini/settings.json', '{"theme":"keep","mcpServers":{"foreign":{"command":"user-owned"}}}', d => JSON.parse(d).mcpServers, 'command'],
  ['agy', '.gemini/antigravity-cli/mcp_config.json', '{"mcpServers":{"foreign":{"command":"user-owned"}}}', d => JSON.parse(d).mcpServers, 'command'],
  ['kiro', '.kiro/settings/mcp.json', '{"mcpServers":{"foreign":{"command":"user-owned"}}}', d => JSON.parse(d).mcpServers, 'command'],
  ['cline', '.cline/data/settings/cline_mcp_settings.json', '{"mcpServers":{"foreign":{"transport":{"type":"stdio","command":"user-owned"}}}}', d => JSON.parse(d).mcpServers, 'transport']
];
for (const [provider, relative, original, parse, field] of cases) {
  test(`${provider}: real add/test/tools/call/enable/disable/remove preserves foreign config`, async (t) => {
    const f = fixture(t);
    const target = path.join(f.options.hostHomeDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, original);
    const foreign = parse(original).foreign;
    const added = f.manager.add('aih-demo', server, { provider });
    assert.equal(added.enabled, false);
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'add only registers; enable projects');
    assert.equal((await f.manager.test('aih-demo', { provider })).ok, true);
    assert.deepEqual((await f.manager.tools('aih-demo', { provider })).map(x => x.name).sort(), ['aih_echo', 'aih_list_files']);
    f.manager.enable('aih-demo', { provider });
    assert.ok(parse(fs.readFileSync(target, 'utf8'))['aih-demo'][field]);
    assert.equal((await f.manager.call('aih-demo', 'aih_echo', { text: 'AIH_MCP_DEMO_OK' }, { provider })).content[0].text, 'AIH_MCP_DEMO_OK');
    assert.deepEqual(parse(fs.readFileSync(target, 'utf8')).foreign, foreign);
    const revision = f.manager.list().revision;
    f.manager.enable('aih-demo', { provider });
    assert.equal(f.manager.list().revision, revision);
    const restored = createMcpManager(f.options);
    restored.disable('aih-demo', { provider });
    assert.equal(parse(fs.readFileSync(target, 'utf8'))['aih-demo'], undefined);
    assert.deepEqual(parse(fs.readFileSync(target, 'utf8')).foreign, foreign);
    if (original.includes('User comment')) assert.match(fs.readFileSync(target, 'utf8'), /User comment/);
    restored.enable('aih-demo', { provider });
    restored.remove('aih-demo', { provider });
    assert.equal(restored.list().resources.length, 0);
    assert.equal(parse(fs.readFileSync(target, 'utf8'))['aih-demo'], undefined);
  });
}
test('ownership conflicts, user edits, malformed configs and unsupported providers fail closed', (t) => {
  const f = fixture(t); const provider = 'claude';
  const target = path.join(f.options.hostHomeDir, '.claude', '.claude.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  f.manager.add('demo', server, { provider });
  fs.writeFileSync(target, '{"mcpServers":{"demo":{"command":"foreign"}}}');
  assert.throws(() => f.manager.enable('demo', { provider }), { code: 'mcp_target_conflict' });
  fs.writeFileSync(target, '{}'); f.manager.enable('demo', { provider });
  const doc = JSON.parse(fs.readFileSync(target, 'utf8')); doc.mcpServers.demo.args.push('USER EDIT');
  fs.writeFileSync(target, JSON.stringify(doc));
  assert.throws(() => f.manager.remove('demo', { provider }), { code: 'mcp_target_modified' });
  assert.equal(f.manager.doctor().healthy, false);
  fs.writeFileSync(target, '{broken');
  assert.throws(() => f.manager.enable('demo', { provider }), { code: 'mcp_config_invalid' });
  assert.throws(() => f.manager.add('demo', server, { provider: 'missing' }), { code: 'mcp_provider_unsupported' });
});
test('Cline launch projection reaches isolated account config and disable removes all owned projections', (t) => {
  const f = fixture(t); const provider = 'cline';
  f.manager.add('demo', server, { provider }); f.manager.enable('demo', { provider });
  const sandboxDir = path.join(f.dir, 'account');
  f.manager.reconcileRuntime(provider, { sandboxDir });
  const target = path.join(sandboxDir, '.cline/data/settings/cline_mcp_settings.json');
  assert.equal(JSON.parse(fs.readFileSync(target)).mcpServers.demo.transport.command, process.execPath);
  f.manager.disable('demo', { provider });
  assert.equal(JSON.parse(fs.readFileSync(target)).mcpServers.demo, undefined);
  f.manager.reconcileRuntime(provider, { sandboxDir });
  assert.equal(JSON.parse(fs.readFileSync(target)).mcpServers.demo, undefined);
});
test('list and doctor redact argument and environment values', (t) => {
  const f = fixture(t);
  f.manager.add('secret-demo', { ...server, args: ['secret-argument'], env: { ACCESS_TOKEN: 'secret-value' } }, { provider: 'codex' });
  const output = JSON.stringify({ list: f.manager.list(), doctor: f.manager.doctor() });
  assert.doesNotMatch(output, /secret-argument|secret-value/);
  assert.match(output, /ACCESS_TOKEN/);
});
test('removing an unprojected definition preserves a foreign native entry with the same name', (t) => {
  const f = fixture(t); const provider = 'claude';
  f.manager.add('demo', server, { provider });
  const target = path.join(f.options.hostHomeDir, '.claude/.claude.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = '{"mcpServers":{"demo":{"command":"foreign"}}}';
  fs.writeFileSync(target, text);
  f.manager.remove('demo', { provider });
  assert.equal(fs.readFileSync(target, 'utf8'), text);
  assert.equal(f.manager.list().resources.length, 0);
});
test('runtime preparation projects enabled Cline MCP resources into the actual launch directory', (t) => {
  const f = fixture(t); const provider = 'cline';
  f.manager.add('demo', server, { provider }); f.manager.enable('demo', { provider });
  const { prepareProviderRuntime } = require('../lib/cli/services/ai-cli/provider-runtime-env');
  const sandboxDir = path.join(f.dir, 'runtime');
  prepareProviderRuntime(provider, sandboxDir, {}, { ...f.options, fs, path, materializeAuth: false, installSkill: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(sandboxDir, '.cline/data/settings/cline_mcp_settings.json'))).mcpServers.demo.transport.command, process.execPath);
});
