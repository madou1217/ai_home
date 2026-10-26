'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');

const MARKER = 'AIH_NATIVE_MCP_OK';
const DEMO_SERVER = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');

function runProcess(binary, args, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error(`process_timeout:${binary}`);
      error.code = 'process_timeout';
      finish(null, error);
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish(null, error));
    child.once('close', (code, signal) => finish({ code, signal, stdout, stderr }));
  });
}

function parseJsonLines(text) {
  return String(text || '').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
}

function createFixtureServer(observations, fixtureErrors, nonce) {
  return http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('fixture_payload_limit');
      }
      const payload = JSON.parse(body || '{}');
      const functions = (Array.isArray(payload.tools) ? payload.tools : [])
        .map(tool => tool && tool.function)
        .filter(Boolean);
      const echo = functions.find(tool => String(tool.name || '').includes('aih_echo'));
      const toolResults = (Array.isArray(payload.messages) ? payload.messages : [])
        .filter(message => message && message.role === 'tool');
      const echoed = toolResults.some(message => String(message.content || '').includes(nonce));
      observations.push({ echoSchema: Boolean(echo), echoed });
      assert.ok(observations.length <= 2, 'unexpected_extra_model_request');

      const tool = echo && !echoed;
      const name = echo?.name || '';
      const argumentsText = JSON.stringify({ text: nonce });
      const frame = (delta, finishReason = null) => `data: ${JSON.stringify({
        id: 'aih-cline-fixture',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: payload.model || 'demo',
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      })}\n\n`;
      let stream = frame({ role: 'assistant' });
      if (tool) {
        stream += frame({ tool_calls: [{ index: 0, id: 'echo-call', type: 'function', function: { name } }] });
        stream += frame({ tool_calls: [{ index: 0, function: { arguments: argumentsText } }] });
      } else {
        stream += frame({ content: echoed ? MARKER : 'MCP_NOT_LOADED' });
      }
      stream += frame({}, tool ? 'tool_calls' : 'stop');
      stream += 'data: [DONE]\n\n';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(stream);
    } catch (error) {
      fixtureErrors.push(error.message);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{}');
    }
  });
}

async function runClineMcpDemo(binary = '/opt/homebrew/bin/cline') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-mcp-'));
  const host = path.join(root, 'home');
  const work = path.join(root, 'work');
  const configDir = path.join(host, '.cline');
  const dataDir = path.join(configDir, 'data');
  const nonce = randomUUID();
  const observations = [];
  const fixtureErrors = [];
  const server = createFixtureServer(observations, fixtureErrors, nonce);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const env = {
    PATH: process.env.PATH,
    HOME: host,
    USERPROFILE: host,
    CLINE_DIR: configDir,
    CLINE_DATA_DIR: dataDir,
    NO_PROXY: '127.0.0.1,localhost',
    TERM: 'dumb'
  };
  const manager = createMcpManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: host });
  const stages = [];

  try {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, `native-mcp-${nonce}.txt`), 'Native MCP directory evidence.\n');
    const auth = await runProcess(binary, [
      'auth', '--provider', 'openai-compatible', '--apikey', 'fixture-key',
      '--modelid', 'demo', '--baseurl', baseUrl,
      '--config', configDir, '--data-dir', dataDir
    ], { env, cwd: work, timeoutMs: 30000 });
    assert.equal(auth.code, 0, `cline auth failed: ${auth.stderr || auth.stdout}`);

    manager.add('aih-demo', { command: process.execPath, args: [DEMO_SERVER] }, { provider: 'cline' });
    manager.enable('aih-demo', { provider: 'cline' });
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider: 'cline' });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider: 'cline' });
      if (stage === 'removed') manager.remove('aih-demo', { provider: 'cline' });
      const expected = stage === 'enabled' || stage === 're-enabled';
      observations.length = 0;
      fixtureErrors.length = 0;
      const run = await runProcess(binary, [
        '--provider', 'openai-compatible', '--model', 'demo',
        '--config', configDir, '--data-dir', dataDir,
        '--json', '--auto-approve', 'true',
        'Use the available AIH MCP tools.'
      ], { env, cwd: work, timeoutMs: 45000 });
      assert.equal(run.code, 0, `cline run failed: ${run.stderr || run.stdout}`);
      const events = parseJsonLines(run.stdout);
      const result = events.findLast(event => event.type === 'run_result');
      const toolEvents = events.filter(event => (
        event.type === 'agent_event'
        && event.event?.type === 'content_end'
        && event.event?.contentType === 'tool'
      ));
      assert.deepEqual(fixtureErrors, []);
      assert.equal(observations.length, expected ? 2 : 1, 'native MCP roundtrip count');
      assert.equal(observations.some(row => row.echoSchema), expected, 'native MCP schema availability');
      assert.equal(observations.some(row => row.echoed), expected, 'native MCP result reached model');
      assert.equal(toolEvents.length > 0, expected, 'native completed tool event');
      assert.ok(result && result.finishReason === 'completed', 'native final result missing');
      assert.equal(result.text?.trim(), expected ? MARKER : 'MCP_NOT_LOADED');
      stages.push({
        stage,
        toolSchema: expected,
        toolExecuted: toolEvents.length > 0,
        resultObserved: expected,
        requests: observations.length,
        answer: result.text?.trim() || '',
        passed: true
      });
    }
    const version = await runProcess(binary, ['--version'], { env, cwd: work, timeoutMs: 10000 });
    return {
      host: 'cline',
      resource: 'mcp',
      binary,
      version: version.stdout.trim() || version.stderr.trim(),
      inference: 'local-deterministic-tool-fixture',
      toolExecutionVerified: true,
      stages,
      passed: true
    };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/cline-mcp-tool-loop-demo.js [native-cli-path]');
  else runClineMcpDemo(process.argv[2]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { runClineMcpDemo };
