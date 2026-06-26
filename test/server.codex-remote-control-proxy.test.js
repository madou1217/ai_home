const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRemoteChunkAssembler,
  readRemoteHydrationSuppressionState,
  rewriteRemoteControlPayload,
  sanitizeTraceText,
  shouldSuppressRemoteHydrationEnvelope,
  summarizeJsonRpcMessage,
  summarizeRemoteEnvelope
} = require('../lib/server/codex-remote-control-proxy');

test('remote-control proxy rewrites mobile thread/list requests for shared AIH sessions', () => {
  const payload = JSON.stringify({
    type: 'client_message',
    client_id: 'client-1',
    stream_id: 'stream-1',
    seq_id: 12,
    message: {
      id: 'list-1',
      method: 'thread/list',
      params: {
        cursor: null,
        limit: 50,
        archived: false
      }
    }
  });

  const rewritten = rewriteRemoteControlPayload(payload);
  assert.equal(rewritten.changed, true);
  const envelope = JSON.parse(rewritten.payload);
  assert.deepEqual(envelope.message.params.modelProviders, []);
  assert.equal(envelope.message.params.useStateDbOnly, true);
  assert.equal(rewritten.summary.type, 'client_message');
  assert.equal(rewritten.summary.message.method, 'thread/list');
  assert.equal(rewritten.summary.message.limit, 50);
  assert.equal(rewritten.summary.message.cursor, null);
  assert.deepEqual(rewritten.summary.message.modelProviders, []);
  assert.equal(rewritten.summary.message.useStateDbOnly, true);
});

test('remote-control proxy leaves non-list envelopes unchanged and summarizes chunks safely', () => {
  const payload = JSON.stringify({
    type: 'client_message_chunk',
    client_id: 'client-1',
    stream_id: 'stream-1',
    seq_id: 13,
    segment_id: 0,
    segment_count: 2,
    message_size_bytes: 9000,
    message_chunk_base64: 'abc'
  });

  const rewritten = rewriteRemoteControlPayload(payload);
  assert.equal(rewritten.changed, false);
  assert.equal(rewritten.payload, payload);
  assert.deepEqual(summarizeRemoteEnvelope(payload), {
    type: 'client_message_chunk',
    clientId: 'client-1',
    streamId: 'stream-1',
    seqId: 13,
    segmentId: 0,
    segmentCount: 2,
    messageSizeBytes: 9000
  });
});

test('remote-control proxy trace sanitizer redacts bearer and JWT-shaped secrets', () => {
  assert.equal(
    sanitizeTraceText('Authorization: Bearer eyJabc.def.ghi "refresh_token":"secret"'),
    'Authorization: Bearer [redacted] "refresh_token":"[redacted]"'
  );
});

test('remote-control proxy summarizes thread/list response ids and cursors', () => {
  const summary = summarizeJsonRpcMessage({
    id: 'list-1',
    result: {
      data: [
        { id: 'thread-1', updatedAt: 123, createdAt: 100, modelProvider: 'aih_10', source: 'vscode', cwd: '/tmp/a' },
        { sessionId: 'thread-2', updated_at_ms: 122, model_provider: 'openai', thread_source: 'user' }
      ],
      nextCursor: 'cursor-next',
      backwardsCursor: 'cursor-back'
    }
  });

  assert.equal(summary.resultDataLength, 2);
  assert.deepEqual(summary.resultThreadIds, ['thread-1', 'thread-2']);
  assert.equal(summary.resultThreads[0].updatedAt, 123);
  assert.equal(summary.resultThreads[1].threadSource, 'user');
  assert.equal(summary.nextCursorValue, 'cursor-next');
  assert.equal(summary.backwardsCursorValue, 'cursor-back');
});

test('remote-control proxy reassembles chunked messages for trace summaries', () => {
  const traces = [];
  const assembler = createRemoteChunkAssembler((entry) => traces.push(entry));
  const message = JSON.stringify({
    id: 'list-1',
    result: {
      data: [{ id: 'thread-1', updatedAt: 123 }],
      nextCursor: null
    }
  });
  const first = Buffer.from(message.slice(0, 20)).toString('base64');
  const second = Buffer.from(message.slice(20)).toString('base64');

  assembler({
    type: 'server_message_chunk',
    client_id: 'client-1',
    stream_id: 'stream-1',
    seq_id: 2,
    segment_id: 0,
    segment_count: 2,
    message_size_bytes: message.length,
    message_chunk_base64: first
  }, 'ws_app_server_to_chatgpt');
  assembler({
    type: 'server_message_chunk',
    client_id: 'client-1',
    stream_id: 'stream-1',
    seq_id: 2,
    segment_id: 1,
    segment_count: 2,
    message_size_bytes: message.length,
    message_chunk_base64: second
  }, 'ws_app_server_to_chatgpt');

  assert.equal(traces.length, 1);
  assert.equal(traces[0].summary.type, 'server_message_chunk_reassembled');
  assert.deepEqual(traces[0].summary.message.resultThreadIds, ['thread-1']);
});

test('remote-control proxy suppresses hidden hydration notifications from shared state', () => {
  const envelope = {
    type: 'server_message',
    message: {
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: { type: 'active', activeFlags: [] }
      }
    }
  };

  assert.equal(shouldSuppressRemoteHydrationEnvelope(envelope, {
    suppressedThreadIds: new Set(['thread-1'])
  }), true);
  assert.equal(shouldSuppressRemoteHydrationEnvelope(envelope, {
    suppressedThreadIds: new Set(['thread-2'])
  }), false);
  assert.equal(shouldSuppressRemoteHydrationEnvelope({
    type: 'client_message',
    message: envelope.message
  }, {
    suppressedThreadIds: new Set(['thread-1'])
  }), false);
});

test('remote-control proxy ignores expired hidden hydration suppression entries', () => {
  const reads = [];
  const suppressed = readRemoteHydrationSuppressionState('/tmp/suppress.json', {
    nowMs: 2000,
    fs: {
      readFileSync(filePath, encoding) {
        reads.push([filePath, encoding]);
        return JSON.stringify({
          threads: [
            { id: 'thread-old', expiresAt: 1999 },
            { id: 'thread-live', expiresAt: 2001 }
          ]
        });
      }
    }
  });

  assert.deepEqual([...suppressed], ['thread-live']);
  assert.deepEqual(reads, [['/tmp/suppress.json', 'utf8']]);
  assert.equal(shouldSuppressRemoteHydrationEnvelope({
    type: 'server_message',
    message: {
      method: 'thread/status/changed',
      params: { threadId: 'thread-old', status: { type: 'active' } }
    }
  }, {
    suppressedThreadIds: suppressed
  }), false);
});
