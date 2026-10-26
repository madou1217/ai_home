import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Runs in an isolated subprocess: the real host owns discovery and registration.
const [runtimePackage, agentDir, cwd, expected, extraExtensions = '[]'] = process.argv.slice(2);
const sdk = await import(pathToFileURL(path.join(runtimePackage, 'dist/index.js')));
const loader = new sdk.DefaultResourceLoader({
  cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: JSON.parse(extraExtensions),
  agentsFilesOverride: () => ({ agentsFiles: [] })
});
await loader.reload();
const { session } = await sdk.createAgentSession({
  cwd, agentDir, resourceLoader: loader, tools: [],
  sessionManager: sdk.SessionManager.inMemory(cwd)
});
try {
  const tool = session.extensionRunner.getToolDefinition('aih_demo');
  assert.equal(Boolean(tool), expected === 'enabled', 'native Pi tool discovery');
  if (tool) {
    const result = await tool.execute('demo-call', { text: 'portable-input' }, new AbortController().signal);
    assert.equal(result.content[0].text, 'AIH_PLUGIN_DEMO_OK:portable-input');
    await session.prompt('/aih-demo command-input');
    assert.ok(session.messages.some(message => message.customType === 'aih-demo' && message.content === 'AIH_PLUGIN_DEMO_OK:command-input'), 'native Pi command dispatch');
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    await assert.rejects(() => tool.execute('stale-call', { text: 'stale' }, new AbortController().signal), /portable_plugin_disposed/);
  }
  process.stdout.write(JSON.stringify({ discovered: Boolean(tool), called: Boolean(tool), command: Boolean(tool), cleanup: Boolean(tool) }) + '\n');
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
  session.dispose();
}
