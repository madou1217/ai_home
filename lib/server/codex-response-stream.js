'use strict';

const { once } = require('node:events');
const { parseSseJsonStream } = require('./http-utils-sse');
const { createCodexChatStreamConverter } = require('./codex-chat-stream-converter');

// Own only the stream lifecycle. Account selection and failure policy stay in
// codex-adapter; the converter owns Chat Completions event state.
async function forwardCodexResponseStream({ response, res, signal, timeoutMs, model, native, detectFailure, start }) {
  const reader = response.body.getReader();
  const converter = createCodexChatStreamConverter(model);
  let completed = false;
  let usage = null;
  let idleError = null;
  let firstEventAt = 0;
  let firstContentAt = 0;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        signal.throwIfAborted();
        const timer = setTimeout(() => {
          idleError = new Error('Codex upstream stream timed out waiting for an event');
          idleError.name = 'TimeoutError';
          idleError.code = 'ETIMEDOUT';
          cancel();
        }, Math.max(1, Number(timeoutMs) || 120000));
        let entry;
        try {
          entry = await reader.read();
        } finally {
          clearTimeout(timer);
        }
        signal.throwIfAborted();
        if (idleError) throw idleError;
        if (entry.done) break;
        yield entry.value;
      }
    }
  };
  try {
    for await (const event of parseSseJsonStream(chunks)) {
      if (!firstEventAt) firstEventAt = Date.now();
      if (!firstContentAt && event.delta && (event.type === 'response.output_text.delta'
          || event.type === 'response.reasoning_summary_text.delta')) firstContentAt = Date.now();
      const failure = detectFailure(JSON.stringify(event));
      if (failure) {
        const error = new Error(failure.detail);
        error.codexFailure = failure;
        throw error;
      }
      if (event.type === 'response.incomplete') {
        throw new Error('Codex upstream response is incomplete');
      }
      const output = native
        ? [`event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`]
        : converter.event(event).map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
      if (output.length) {
        start();
        for (const frame of output) {
          signal.throwIfAborted();
          if (res.write(frame) === false) await once(res, 'drain', { signal });
        }
      }
      if (event.type === 'response.completed') {
        completed = true;
        usage = event.response && event.response.usage || null;
        break;
      }
    }
    if (!completed) throw new Error('stream disconnected before completion');
    if (!native) res.write('data: [DONE]\n\n');
    return { usage, firstEventAt, firstContentAt };
  } finally {
    signal.removeEventListener('abort', cancel);
    try { await reader.cancel(); } catch (_error) {}
    reader.releaseLock();
  }
}

module.exports = { forwardCodexResponseStream };
