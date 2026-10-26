'use strict';
// Local inference fixture for native loading conformance. It emits the success
// marker only if the native client supplied the skill body in its request.
// It does not emulate reasoning and is never evidence of remote inference.
const http = require('node:http');
const MARKER = 'AIH_SKILL_DEMO_OK';
async function createPromptFixture({ marker = MARKER, missing = 'SKILL_NOT_LOADED' } = {}) {
  const observations = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text = JSON.stringify({ messages: body.messages, input: body.input, instructions: body.instructions, system: body.system });
      const loaded = text.includes(marker);
      observations.push({ route: request.url.split('?')[0], loaded, skillMentioned: text.includes('aih-demo') });
      const answer = loaded ? marker : missing;
      const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      if (request.url.includes('/messages')) {
        const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 8 } };
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        emit('message_start', { message: { ...message, content: [], stop_reason: null } });
        emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
        emit('content_block_stop', { index: 0 });
        emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
        emit('message_stop', {});
      } else if (request.url.includes('/responses')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
        const result = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 } };
        emit('response.created', { response: { ...result, status: 'in_progress', output: [] } });
        emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: answer });
        emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: answer });
        emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
        emit('response.output_item.done', { output_index: 0, item });
        emit('response.completed', { response: result });
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }
      response.end();
    } catch (_) { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { observations, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
module.exports = { MARKER, createPromptFixture };
