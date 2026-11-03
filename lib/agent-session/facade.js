'use strict';

// 门面：调用方只认 provider 名，不认 adapter。
//
// 这里做三件事：按登记表的降级链找 adapter、装配 bus/router/session、把
// 「哪个 adapter 都没装」变成带 attempted 列表的明确错误。绝不在调用方写
// if (provider === 'codex') —— 那是上一轮已经点过名的反模式。

const { AgentSessionError, nonEmptyString } = require('./contracts');
const { createEventBus } = require('./event-bus');
const { createInteractionRouter } = require('./interaction-router');
const { createAgentSession } = require('./session');
const {
  getAdapterCapabilities,
  getHarnessAdapter,
  isExcludedHarness,
  listHarnessAdapterRows,
  resolveAdapterCandidates
} = require('./registry');

// adapter 实现模块的**唯一**映射处。新增 adapter = 加一行 + 加实现文件。
const ADAPTER_MODULES = Object.freeze({
  'acp-stdio': './adapters/acp-stdio',
  'acp-http-sse': './adapters/acp-http-sse',
  'codex-app-server': './adapters/codex-app-server',
  'claude-stream-mcp': './adapters/claude-stream-mcp',
  'opencode-serve': './adapters/opencode-serve',
  pty: './adapters/pty-tui'
});

function loadAdapterFactory(adapterId) {
  const modulePath = ADAPTER_MODULES[adapterId];
  if (!modulePath) return null;
  let loaded;
  try {
    loaded = require(modulePath);
  } catch (error) {
    // 只吞「这个 adapter 还没写」，其它加载错误（语法错误、循环依赖）必须冒出来。
    const missing = error && error.code === 'MODULE_NOT_FOUND'
      && String(error.message || '').includes(modulePath);
    if (missing) return null;
    throw error;
  }
  return loaded && typeof loaded.createAdapter === 'function' ? loaded.createAdapter : null;
}

function isAdapterImplemented(adapterId) {
  return Boolean(loadAdapterFactory(adapterId));
}

function resolveAdapter(provider) {
  const normalized = nonEmptyString(provider).toLowerCase();
  if (!normalized) throw new AgentSessionError('agent_session_provider_required');
  if (isExcludedHarness(normalized)) {
    throw new AgentSessionError('agent_session_harness_excluded', { provider: normalized });
  }
  const row = getHarnessAdapter(normalized);
  if (!row) throw new AgentSessionError('agent_session_harness_unknown', { provider: normalized });

  const attempted = [];
  for (const candidate of resolveAdapterCandidates(normalized)) {
    const createAdapter = loadAdapterFactory(candidate.adapterId);
    attempted.push({ adapterId: candidate.adapterId, implemented: Boolean(createAdapter) });
    if (createAdapter) {
      return {
        provider: normalized,
        row,
        adapterId: candidate.adapterId,
        capabilities: candidate.capabilities,
        createAdapter,
        attempted
      };
    }
  }
  throw new AgentSessionError('agent_session_adapter_unavailable', {
    provider: normalized,
    attempted
  });
}

function describeProvider(provider) {
  const normalized = nonEmptyString(provider).toLowerCase();
  const row = getHarnessAdapter(normalized);
  if (!row) return null;
  return {
    provider: row.provider,
    label: row.label,
    phase: row.phase,
    note: row.note,
    candidates: row.candidates.map((adapterId) => ({
      adapterId,
      implemented: isAdapterImplemented(adapterId),
      capabilities: getAdapterCapabilities(adapterId)
    }))
  };
}

function describeAllProviders() {
  return listHarnessAdapterRows().map((row) => describeProvider(row.provider));
}

function startAgentSession(options) {
  const config = options && typeof options === 'object' ? options : {};
  const sessionId = nonEmptyString(config.sessionId);
  if (!sessionId) throw new AgentSessionError('agent_session_id_required');
  const resolution = resolveAdapter(config.provider);
  const bus = createEventBus({ sessionId });
  const router = createInteractionRouter({ sessionId, bus, timeoutMs: config.interactionTimeoutMs });
  const adapter = resolution.createAdapter({
    sessionId,
    provider: resolution.provider,
    transport: resolution.capabilities.transport,
    context: config.context || {}
  });
  const session = createAgentSession({ sessionId, adapter, bus, router });
  return { session, adapterId: resolution.adapterId, transport: resolution.capabilities.transport, attempted: resolution.attempted };
}

module.exports = {
  ADAPTER_MODULES,
  describeAllProviders,
  describeProvider,
  isAdapterImplemented,
  loadAdapterFactory,
  resolveAdapter,
  startAgentSession
};
