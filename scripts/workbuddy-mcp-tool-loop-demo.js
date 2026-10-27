'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');
const { resolveProviderResourceRuntime, nativeResourceEnvironment } = require('../lib/native-resources/provider-native-runtime');
const { resolveProviderNativeRoot } = require('../lib/runtime/provider-storage-policy');
const { runProcess } = require('./process-runner');

const MCP_SERVER = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');
const MARKER = 'WORKBUDDY_MCP_OK';
const MISSING = 'MCP_NOT_LOADED';

async function removeRoot(root) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function parseEvents(output) {
  return String(output || '').split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch (_error) { return []; }
  });
}

function messageToolNames(message) {
  const names = [];
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    const name = call?.function?.name || call?.name;
    if (name) names.push(String(name));
  }
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    const name = block?.name || block?.function?.name;
    if (name) names.push(String(name));
  }
  return names;
}

function createFixture() {
  const observations = [];
  let enabled = false;
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('fixture_payload_limit');
      }
      const request = JSON.parse(body || '{}');
      const tools = Array.isArray(request.tools) ? request.tools : [];
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const searchResult = messages.some((message) => {
        const content = JSON.stringify(message.content || '');
        return messageToolNames(message).some((name) => name === 'ToolSearch')
          || String(message.name || message.tool_call_id || '').includes('ToolSearch')
          || content.includes('mcp__aih-demo__aih_echo');
      });
      const mcpResult = messages.some((message) => {
        const content = JSON.stringify(message.content || '');
        const toolCallId = String(message.tool_call_id || '');
        return content.includes('WORKBUDDY_MCP_RESULT')
          && (message.role === 'tool' || toolCallId === 'defer-call' || toolCallId === 'mcp-call');
      });
      const toolSearch = tools.find((tool) => String(tool.function?.name || tool.name || '') === 'ToolSearch');
      const mcpTool = tools.find((tool) => String(tool.function?.name || tool.name || '') === 'mcp__aih-demo__aih_echo');
      observations.push({
        toolSearch: Boolean(toolSearch),
        mcpSchema: Boolean(mcpTool),
        searchResult,
        mcpResult,
        toolNames: messages.flatMap(messageToolNames),
        toolMessages: messages.filter((message) => messageToolNames(message).length || message.role === 'tool')
          .map((message) => ({ role: message.role, names: messageToolNames(message), content: message.content }))
      });
      const selected = enabled && !searchResult && toolSearch
        ? { id: 'search-call', name: 'ToolSearch', input: { tool_names: ['mcp__aih-demo__aih_echo'] } }
        : enabled && searchResult && !mcpResult
        ? { id: 'defer-call', name: 'DeferExecuteTool', input: {
            toolName: mcpTool?.function?.name || mcpTool?.name || 'mcp__aih-demo__aih_echo',
            params: { text: 'WORKBUDDY_MCP_RESULT' }
          } }
          : null;
      const content = selected
        ? { type: 'tool_calls', tool_calls: [{ index: 0, id: selected.id, type: 'function', function: { name: selected.name, arguments: JSON.stringify(selected.input) } }] }
        : { type: 'content', text: mcpResult ? MARKER : MISSING };
      const frame = {
        id: `workbuddy_mcp_${observations.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: request.model || 'primary-model',
        choices: [{ index: 0, delta: { role: 'assistant', ...(content.type === 'tool_calls' ? { tool_calls: content.tool_calls } : { content: content.text }) }, finish_reason: null }]
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        `data: ${JSON.stringify(frame)}\n\n`,
        `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: selected ? 'tool_calls' : 'stop' }] })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''));
    } catch (_error) {
      res.writeHead(400);
      res.end('{}');
    }
  });
  return {
    observations,
    setEnabled(value) {
      enabled = Boolean(value);
    },
    server,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runStage(runtime, env, cwd, configPath, fixture) {
  const run = await runProcess(runtime.command, [
    ...runtime.args,
    '-p', 'Use the available AIH MCP tools.',
    '--model', 'primary-model',
    '--output-format', 'stream-json',
    '--no-session-persistence',
    '--max-turns', '6',
    '--channels', 'server:aih-demo',
    '--strict-mcp-config', '--mcp-config', configPath,
    '--allowedTools', 'mcp__aih-demo__aih_echo',
    '-y'
  ], {
    cwd,
    env,
    timeoutMs: 45000,
    maxOutput: 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || 'workbuddy_mcp_process_failed');
  assert.equal(run.timedOut, false, JSON.stringify({
    error: 'workbuddy_mcp_process_timeout',
    stdout: String(run.stdout || '').slice(-6000),
    stderr: String(run.stderr || '').slice(-2000),
    observations: fixture.observations
  }));
  const events = parseEvents(run.stdout);
  const result = events.filter((event) => event.type === 'result').at(-1);
  assert.ok(result && !result.is_error, JSON.stringify({ result, output: run.stdout.slice(-2500), observations: fixture.observations }));
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const connected = Array.isArray(init?.mcp_servers)
    && init.mcp_servers.some((server) => server.name === 'aih-demo' && server.status === 'connected');
  const toolSearch = events.some((event) => event.type === 'assistant'
    && event.message?.content?.some((block) => block.type === 'tool_use' && block.name === 'ToolSearch'));
  const toolCall = events.some((event) => event.type === 'assistant'
    && event.message?.content?.some((block) => block.type === 'tool_use'
      && (block.name === 'mcp__aih-demo__aih_echo' || block.name === 'DeferExecuteTool')));
  const toolResult = events.some((event) => event.type === 'user'
    && event.message?.content?.some((block) => block.type === 'tool_result'
      && (block.tool_use_id === 'defer-call' || block.tool_use_id === 'mcp-call')));
  return {
    answer: String(result.result || '').trim(),
    connected,
    toolSearch,
    toolCall,
    toolResult,
    fixtureSearchResult: fixture.observations.some((row) => row.searchResult),
    fixtureMcpResult: fixture.observations.some((row) => row.mcpResult),
    requests: fixture.observations.length,
    nativeTools: Array.isArray(init?.tools) ? init.tools.filter((name) => String(name).startsWith('mcp__aih-demo__')) : []
  };
}

async function runWorkbuddyMcpDemo(binary, provider = 'workbuddy') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-mcp-'));
  const hostHomeDir = path.join(root, 'home');
  const aiHomeDir = path.join(root, 'aih');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  const runtime = resolveProviderResourceRuntime(provider, {
    hostHomeDir,
    nativeBinaries: binary ? { [provider]: binary } : undefined
  });
  assert.ok(runtime, 'workbuddy_native_runtime_required');
  const fixture = createFixture();
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  const baseEnv = nativeResourceEnvironment(provider, {
    hostHomeDir,
    env: { PATH: process.env.PATH }
  }, runtime);
  const env = {
    ...baseEnv,
    NO_PROXY: '127.0.0.1,localhost',
    CODEBUDDY_API_KEY: 'fixture-key',
    CODEBUDDY_BASE_URL: `http://127.0.0.1:${fixture.server.address().port}`
  };
  const manager = createMcpManager({ aiHomeDir, hostHomeDir });
  try {
    manager.add('aih-demo', { command: process.execPath, args: [MCP_SERVER] }, { provider });
    const direct = await manager.test('aih-demo', { provider });
    const tools = await manager.tools('aih-demo', { provider });
    const call = await manager.call('aih-demo', 'aih_echo', { text: 'AIH_RESOURCE_MCP_OK' }, { provider });
    assert.deepEqual(tools.map((tool) => tool.name), ['aih_echo', 'aih_list_files']);
    assert.equal(call.content?.[0]?.text, 'AIH_RESOURCE_MCP_OK');
    const stages = [];
    const configRoot = resolveProviderNativeRoot(hostHomeDir, provider);
    // Both WorkBuddy desktop bundles own the `.codebuddy.json` projection.
    // CodeBuddy/CodeBuddy CN use `.mcp.json`; keep the imported-host choice
    // descriptor-shaped instead of treating every non-workbuddy provider as a
    // CodeBuddy CLI.
    const configPath = ['workbuddy', 'workbuddycn'].includes(provider)
      ? path.join(configRoot, '.codebuddy.json')
      : path.join(configRoot, '.mcp.json');
    manager.enable('aih-demo', { provider });
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'enabled') manager.enable('aih-demo', { provider });
      if (stage === 'disabled') manager.disable('aih-demo', { provider });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider });
      if (stage === 'removed') manager.remove('aih-demo', { provider });
      fixture.observations.length = 0;
      const expected = stage === 'enabled' || stage === 're-enabled';
      fixture.setEnabled(expected);
      const evidence = await runStage(runtime, env, root, configPath, fixture);
      assert.equal(evidence.answer, expected ? MARKER : MISSING);
      assert.equal(evidence.connected, expected);
      assert.equal(evidence.toolSearch, expected);
      assert.equal(evidence.toolCall, expected);
      assert.equal(evidence.toolResult, expected);
      assert.equal(evidence.fixtureSearchResult, expected);
      assert.equal(evidence.fixtureMcpResult, expected);
      stages.push({ stage, ...evidence, expectedEnabled: expected, nativeAgentToolLoopVerified: expected && evidence.answer === MARKER, passed: true });
    }
    const report = {
      host: provider,
      resource: 'mcp',
      binary: runtime.command,
      runtimeSource: runtime.source,
      directManagement: direct,
      tools: tools.map((tool) => tool.name),
      stages,
      nativeAgentToolLoopVerified: stages.filter((stage) => stage.expectedEnabled)
        .every((stage) => stage.nativeAgentToolLoopVerified),
      passed: true
    };
    return report;
  } finally {
    await fixture.close();
    await removeRoot(root);
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/workbuddy-mcp-tool-loop-demo.js [native-cli-path] [--provider workbuddy|codebuddy|codebuddycn]');
  else {
    const providerIndex = process.argv.indexOf('--provider');
    const provider = providerIndex >= 0 ? process.argv[providerIndex + 1] : 'workbuddy';
    runWorkbuddyMcpDemo(process.argv[2], provider).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
  }
}

module.exports = { runWorkbuddyMcpDemo };
