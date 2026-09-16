'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveWorkbuddyNativeCli } = require('../lib/server/workbuddy-native-cli');
const { buildStartCommand, buildResumeCommand, isOfficialNativeSessionProvider } = require('../lib/server/native-session-chat-command');
const { parseNativeStreamEvent } = require('../lib/server/native-session-chat-stream');
const { buildEnvPatch } = require('../lib/cli/services/ai-cli/launch-profile/codebuddy-strategy');
const { getProviderClientSupport } = require('../lib/provider-catalog');

for (const provider of ['workbuddy', 'workbuddycn']) {
  test(`${provider} uses only the matching desktop embedded runtime, never generic PATH`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-entry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cli = path.join(root, 'Contents/Resources/app.asar.unpacked/cli'); fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'bin/codebuddy'), '// fixture');
    const getProviderCLIConfig = () => ({ desktopClient: { macos: { installPaths: [root] } } });
    const options = { platform: 'darwin', getProviderCLIConfig };
    const expected = provider === 'workbuddy' ? 'workbuddy-desktop-ai' : 'workbuddy-desktop';
    fs.writeFileSync(path.join(cli, 'product.json'), JSON.stringify({ authentication: { id: expected } }));
    assert.deepEqual(resolveWorkbuddyNativeCli(provider, options).prefixArgs, [path.join(cli, 'bin/codebuddy')]);
    fs.writeFileSync(path.join(cli, 'product.json'), JSON.stringify({ authentication: { id: 'wrong-edition' } }));
    assert.throws(() => resolveWorkbuddyNativeCli(provider, options), { code: 'workbuddy_native_runtime_missing' });
    assert.throws(() => resolveWorkbuddyNativeCli(provider, { ...options, platform: 'linux' }), { code: 'workbuddy_native_runtime_missing' });
  });

  test(`${provider} supports new and exact resumed native sessions without pretending to distribute a CLI`, () => {
    assert.equal(isOfficialNativeSessionProvider(provider), true);
    assert.equal(getProviderClientSupport(provider).cli, false);
    const id = '11111111-2222-4333-8444-555555555555';
    const start = buildStartCommand(provider, { prompt: 'fixture', sessionId: id });
    assert.deepEqual(start.args, ['--print', '--output-format', 'stream-json', '--session-id', id, 'fixture']);
    const resumed = buildResumeCommand(provider, { prompt: 'next', sessionId: id });
    assert.deepEqual(resumed.args, ['--print', '--output-format', 'stream-json', '--resume', id, 'next']);
  });

  test(`${provider} isolates both native config variables and does not inherit API keys`, () => {
    const patch = buildEnvPatch({ cliName: provider, sandboxDir: '/test/scoped', hostHomeDir: '/test/host', path, baseEnv: {}, platform: 'darwin' });
    assert.equal(patch.set.HOME, '/test/scoped');
    assert.equal(patch.set.CODEBUDDY_CONFIG_DIR, `/test/scoped/${provider === 'workbuddy' ? '.workbuddy-ai' : '.workbuddy'}`);
    assert.equal(patch.set.WORKBUDDY_CONFIG_DIR, patch.set.CODEBUDDY_CONFIG_DIR);
    assert.ok(patch.unset.includes('CODEBUDDY_API_KEY'));
  });
}

for (const provider of ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']) test(`${provider} streams native session, answer and terminal result rather than dropping its JSON`, () => {
  const state = { content: '' };
  assert.equal(parseNativeStreamEvent(provider, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-fixture' }), state).type, 'session-created');
  const events = parseNativeStreamEvent(provider, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture-answer' }] } }), state);
  assert.equal(events[0].delta, 'fixture-answer');
  assert.equal(parseNativeStreamEvent(provider, JSON.stringify({ type: 'result', result: 'fixture-answer' }), state).content, 'fixture-answer');
  assert.equal(parseNativeStreamEvent(provider, JSON.stringify({ type: 'result', is_error: true, result: 'rejected' }), state).type, 'error');
});
