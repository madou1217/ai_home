'use strict';

const {
  normalizeProtocolId,
  resolveProtocolPath
} = require('./protocol-graph');

const PROTOCOL_ADAPTER_NAME_PARTS = Object.freeze({
  anthropic_messages: 'claude',
  gemini_generate_content: 'gemini',
  gemini_stream_generate_content: 'geminiStream',
  openai_chat: 'openaiChat',
  openai_responses: 'codex'
});

function getProtocolAdapterNamePart(protocol) {
  const id = normalizeProtocolId(protocol);
  return PROTOCOL_ADAPTER_NAME_PARTS[id] || id.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
}

function createProtocolAdapterId(sourceProtocol, targetProtocol) {
  return `${getProtocolAdapterNamePart(sourceProtocol)}2${getProtocolAdapterNamePart(targetProtocol)}Adapter`;
}

function createProtocolAdapter(config) {
  const sourceProtocol = normalizeProtocolId(config && config.sourceProtocol);
  const targetProtocol = normalizeProtocolId(config && config.targetProtocol);
  const requestAdapter = createProtocolAdapterId(sourceProtocol, targetProtocol);
  const responseAdapter = createProtocolAdapterId(targetProtocol, sourceProtocol);
  return Object.freeze({
    id: requestAdapter,
    sourceProtocol,
    targetProtocol,
    requestAdapter: config && config.requestAdapter || requestAdapter,
    responseAdapter: config && config.responseAdapter || responseAdapter
  });
}

const PROTOCOL_REQUEST_ADAPTERS = Object.freeze([
  createProtocolAdapter({
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'openai_chat'
  }),
  createProtocolAdapter({
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'openai_responses'
  }),
  createProtocolAdapter({
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'gemini_generate_content'
  }),
  createProtocolAdapter({
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'gemini_stream_generate_content'
  }),
  createProtocolAdapter({
    sourceProtocol: 'openai_chat',
    targetProtocol: 'anthropic_messages'
  }),
  createProtocolAdapter({
    sourceProtocol: 'openai_chat',
    targetProtocol: 'gemini_generate_content'
  }),
  createProtocolAdapter({
    sourceProtocol: 'openai_chat',
    targetProtocol: 'gemini_stream_generate_content'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_generate_content',
    targetProtocol: 'openai_chat'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_generate_content',
    targetProtocol: 'openai_responses'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_generate_content',
    targetProtocol: 'anthropic_messages'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_generate_content',
    targetProtocol: 'gemini_stream_generate_content'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_stream_generate_content',
    targetProtocol: 'openai_chat'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_stream_generate_content',
    targetProtocol: 'openai_responses'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_stream_generate_content',
    targetProtocol: 'anthropic_messages'
  }),
  createProtocolAdapter({
    sourceProtocol: 'gemini_stream_generate_content',
    targetProtocol: 'gemini_generate_content'
  }),
  createProtocolAdapter({
    sourceProtocol: 'openai_responses',
    targetProtocol: 'openai_chat'
  }),
  createProtocolAdapter({
    sourceProtocol: 'openai_responses',
    targetProtocol: 'anthropic_messages'
  }),
  createProtocolAdapter({
    sourceProtocol: 'openai_responses',
    targetProtocol: 'gemini_generate_content'
  }),
  createProtocolAdapter({
    sourceProtocol: 'openai_responses',
    targetProtocol: 'gemini_stream_generate_content'
  })
]);

function resolveProtocolRequestAdapter(sourceProtocol, targetProtocol) {
  const source = normalizeProtocolId(sourceProtocol);
  const target = normalizeProtocolId(targetProtocol);
  if (!source || !target || source === target) return null;
  return PROTOCOL_REQUEST_ADAPTERS.find((adapter) => (
    adapter.sourceProtocol === source
    && adapter.targetProtocol === target
  )) || null;
}

function resolveProtocolRequestAdapterPath(sourceProtocol, targetProtocol) {
  return resolveProtocolPath(PROTOCOL_REQUEST_ADAPTERS, sourceProtocol, targetProtocol);
}

function listProtocolRequestAdapters() {
  return PROTOCOL_REQUEST_ADAPTERS.map((adapter) => ({ ...adapter }));
}

module.exports = {
  PROTOCOL_REQUEST_ADAPTERS,
  listProtocolRequestAdapters,
  normalizeProtocolId,
  resolveProtocolRequestAdapter,
  resolveProtocolRequestAdapterPath
};
