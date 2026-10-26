'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const MARKER = 'AIH_PLUGIN_DEMO_OK:portable-input';
const MISSING = 'PLUGIN_NOT_LOADED';
function createToolLoopFixture() {
  const observations = [];
  const fixtureErrors = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        assert.ok(Buffer.byteLength(body) <= 1024 * 1024, 'fixture_payload_limit');
      }
      const request = JSON.parse(body);
      const toolSchema = request.tools?.some(tool => tool.function?.name === 'aih_demo') || false;
      const toolResult = request.messages?.some(message => message.role === 'tool' && message.content === MARKER) || false;
      observations.push({ toolSchema, toolResult });
      assert.ok(observations.length <= 4, 'fixture_tool_loop_limit');
      const delta = toolSchema && !toolResult
        ? { tool_calls: [{ index: 0, id: 'portable-call', type: 'function', function: { name: 'aih_demo', arguments: JSON.stringify({ text: 'portable-input' }) } }] }
        : { content: toolResult ? MARKER : MISSING };
      const frame = (value, finishReason) => `data: ${JSON.stringify({ id: 'pi-fixture', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta: value, finish_reason: finishReason }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame({ role: 'assistant', ...delta }, null) + frame({}, delta.tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      fixtureErrors.push(error.message);
      res.writeHead(400); res.end('{}');
    }
  });
  return { server, observations, fixtureErrors };
}
module.exports = { createToolLoopFixture, MARKER, MISSING };
