'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('./process-runner');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');

const MCP_SERVER = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');
const MARKER = 'AIH_GEMINI_MCP_OK';
const MISSING = 'MCP_NOT_LOADED';
const RESULT_MARKER = 'AIH_GEMINI_MCP_RESULT';
const DEFAULT_BINARY = '/tmp/aih-gemini-resource-runtime/node_modules/.bin/gemini';

function parseEvents(output) {
  return String(output || '').split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch (_error) { return []; }
  });
}

function resolveBinary(value) {
  const requested = String(value || '').trim();
  if (requested) return requested;
  if (fs.existsSync(DEFAULT_BINARY)) return DEFAULT_BINARY;
  return 'gemini';
}

function createFixture() {
  const observations = [];
  let enabled = false;
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) throw new Error('fixture_payload_limit');
      }
      const request = JSON.parse(body || '{}');
      const text = JSON.stringify(request);
      const declarations = (Array.isArray(request.tools) ? request.tools : [])
        .flatMap((tool) => Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : []);
      const echo = declarations.find((tool) => tool.name === 'mcp_aih-demo_aih_echo');
      const functionResponse = text.includes('functionResponse') || text.includes(RESULT_MARKER);
      observations.push({
        toolSchema: Boolean(echo),
        functionResponse,
        requestCount: observations.length + 1
      });
      assert.ok(observations.length <= 3, 'unexpected_extra_model_request');

      const part = enabled && echo && !functionResponse
        ? { functionCall: { name: echo.name, args: { text: RESULT_MARKER } } }
        : { text: enabled && echo && functionResponse ? MARKER : MISSING };
      const payload = {
        candidates: [{
          content: { role: 'model', parts: [part] },
          finishReason: 'STOP',
          index: 0
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 }
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (_error) {
      res.writeHead(400);
      res.end('{}');
    }
  });
  return {
    observations,
    setEnabled(value) { enabled = Boolean(value); },
    server,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runGeminiStage(binary, env, cwd, fixture, expectedEnabled) {
  fixture.setEnabled(expectedEnabled);
  fixture.observations.length = 0;
  const run = await runProcess(binary, [
    '--skip-trust',
    '-p', 'Use the available AIH MCP tool if it is present.',
    '-m', 'gemini-2.5-flash',
    '--output-format', 'stream-json',
    '--allowed-tools', 'mcp_aih-demo_aih_echo',
    '--approval-mode', 'yolo'
  ], {
    cwd,
    env,
    timeoutMs: 45000,
    maxOutput: 2 * 1024 * 1024
  });
  assert.equal(run.status, 0, run.stderr || 'gemini_mcp_process_failed');
  assert.equal(run.timedOut, false, JSON.stringify({
    error: 'gemini_mcp_process_timeout',
    stdout: String(run.stdout || '').slice(-6000),
    stderr: String(run.stderr || '').slice(-2000),
    observations: fixture.observations
  }));

  const events = parseEvents(run.stdout);
  const toolUse = events.find((event) => event.type === 'tool_use'
    && event.tool_name === 'mcp_aih-demo_aih_echo'
    && event.parameters?.text === RESULT_MARKER);
  const toolResult = events.find((event) => event.type === 'tool_result'
    && event.tool_id === toolUse?.tool_id
    && event.status === 'success'
    && String(event.output || '').includes(RESULT_MARKER));
  const answer = events
    .filter((event) => event.type === 'message' && event.role === 'assistant')
    .map((event) => String(event.content || ''))
    .join('')
    .trim();
  const result = events.findLast((event) => event.type === 'result');

  assert.equal(Boolean(toolUse), expectedEnabled, 'native Gemini MCP tool use');
  assert.equal(Boolean(toolResult), expectedEnabled, 'native Gemini MCP tool result');
  assert.equal(result?.status, 'success', 'native Gemini result status');
  assert.equal(fixture.observations.length, expectedEnabled ? 2 : 1, 'Gemini model request count');
  assert.equal(fixture.observations.some((row) => row.toolSchema), expectedEnabled, 'Gemini MCP schema');
  assert.equal(fixture.observations.some((row) => row.functionResponse), expectedEnabled, 'Gemini MCP result in next request');
  assert.equal(answer, expectedEnabled ? MARKER : MISSING, 'Gemini final answer');

  return {
    toolSchema: expectedEnabled,
    toolUse: Boolean(toolUse),
    toolResult: Boolean(toolResult),
    resultObserved: expectedEnabled,
    requests: fixture.observations.length,
    answer,
    passed: true
  };
}

async function runGeminiMcpDemo(binary = '') {
  const resolvedBinary = resolveBinary(binary);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gemini-mcp-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const aiHomeDir = path.join(root, 'aih');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'gemini-api-key' } },
    privacy: { usageStatisticsEnabled: false },
    general: { disableAutoUpdate: true }
  }, null, 2));

  const fixture = createFixture();
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    GEMINI_API_KEY: 'fixture-key',
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${fixture.server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost',
    TERM: 'dumb'
  };
  const manager = createMcpManager({ aiHomeDir, hostHomeDir: home });
  try {
    const version = await runProcess(resolvedBinary, ['--version'], {
      cwd: work,
      env,
      timeoutMs: 10000,
      maxOutput: 10000
    });
    if (version.error || version.status !== 0) {
      return {
        host: 'gemini', resource: 'mcp', binary: resolvedBinary,
        state: 'runtime-unavailable', reason: version.error || `version_exit_${version.status}`,
        passed: true, toolExecutionVerified: false
      };
    }

    manager.add('aih-demo', { command: process.execPath, args: [MCP_SERVER] }, { provider: 'gemini' });
    const direct = await manager.test('aih-demo', { provider: 'gemini' });
    const tools = await manager.tools('aih-demo', { provider: 'gemini' });
    const call = await manager.call('aih-demo', 'aih_echo', { text: 'AIH_GEMINI_DIRECT_MCP_OK' }, { provider: 'gemini' });
    assert.deepEqual(tools.map((tool) => tool.name), ['aih_echo', 'aih_list_files']);
    assert.equal(call.content?.[0]?.text, 'AIH_GEMINI_DIRECT_MCP_OK');
    assert.equal(direct.ok, true);

    manager.enable('aih-demo', { provider: 'gemini' });
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider: 'gemini' });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider: 'gemini' });
      if (stage === 'removed') manager.remove('aih-demo', { provider: 'gemini' });
      const expectedEnabled = stage === 'enabled' || stage === 're-enabled';
      steps.push({ stage, ...(await runGeminiStage(resolvedBinary, env, work, fixture, expectedEnabled)) });
    }
    return {
      host: 'gemini', resource: 'mcp', binary: resolvedBinary,
      version: String(version.stdout || '').trim(), inference: 'local-deterministic-tool-fixture',
      directManagement: { test: direct.ok, tools: tools.map((tool) => tool.name), call: call.content?.[0]?.text || '' },
      toolExecutionVerified: true, steps, passed: true
    };
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/gemini-mcp-tool-loop-demo.js [native-cli-path]');
  else runGeminiMcpDemo(process.argv[2]).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { runGeminiMcpDemo, resolveBinary };
