'use strict';

const { stableHash } = require('./model-usage-stable-hash');
const { discoverCodebuddyIdeSessions, readCodebuddyIdeSession, nativeTime } = require('../sessions/codebuddy-ide-store');

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function readIdeRequestUsage(request) {
  if (request?.state !== 'complete' || !/^[a-f0-9]{32}$/.test(request.id)) return null;
  const usage = request.usage;
  const input = count(usage?.inputTokens), output = count(usage?.outputTokens);
  if (input == null || output == null || input + output <= 0
    || count(usage.totalTokens) !== input + output) return null;
  const cacheRead = Math.min(input, count(usage.cacheTokens) || 0);
  const cacheCreation = Math.min(input - cacheRead, count(usage.cachedWriteTokens) || 0);
  return { inputTokens: input - cacheRead - cacheCreation, outputTokens: output,
    cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation,
    reasoningOutputTokens: 0, totalTokens: input + output };
}

function scanCodebuddyIdeUsage(options) {
  const { fs, path, store } = options;
  const result = { files: 0, records: 0, prompts: 0, skipped: 0, providers: {} };
  const sessions = discoverCodebuddyIdeSessions({ ...options, sessionId: options.codebuddySessionId });
  const records = new Map();
  for (const session of sessions) {
    const providerResult = result.providers[session.provider]
      || (result.providers[session.provider] = { files: 0, records: 0, prompts: 0, skipped: 0 });
    const content = readCodebuddyIdeSession(session, { fs, path });
    if (!content) { result.skipped += 1; providerResult.skipped += 1; continue; }
    result.files += 1;
    providerResult.files += 1;
    const prefix = `codebuddy:ide-request:${stableHash(`${session.provider.endsWith('cn') ? 'cn' : 'global'}:${session.sessionId}`)}:`;
    for (const request of content.requests) {
      const usage = readIdeRequestUsage(request);
      const messages = Array.isArray(request?.messages)
        ? request.messages.map(id => content.messages.get(id)).filter(Boolean) : [];
      // The IDE can leave message.isComplete=false after the request is already
      // complete. The finalized request state and totals are the billing truth.
      const assistant = messages.filter(message => message.role === 'assistant').at(-1);
      const model = String(assistant?.extra?.modelId || '').trim();
      const timestampMs = assistant?.timestampMs || nativeTime(request?.startedAt);
      if (!usage || !model || !timestampMs || !assistant) continue;
      const eventKey = `${prefix}${stableHash(request.id)}:usage`;
      const previous = store.db.prepare('SELECT provider, account_ref FROM model_usage_records WHERE event_key=?').get(eventKey);
      let record = records.get(eventKey);
      if (record) {
        if (!previous?.account_ref && record.accountRef !== session.accountRef) record.accountRef = '';
        continue;
      }
      record = { eventKey, provider: previous?.account_ref ? previous.provider : session.provider,
        accountRef: previous?.account_ref || session.accountRef, sourceKind: 'desktop_history',
        sessionId: session.sessionId, requestId: request.id, model, ...usage, timestampMs,
        cwd: session.cwd, project: path.basename(session.cwd || session.projectDirName) };
      records.set(eventKey, record);
    }
    const promptEvents = [...content.messages.values()].filter(message => message.role === 'user' && message.timestampMs > 0)
      .map(message => ({ eventKey: `${prefix}${stableHash(message.id)}:prompt`, provider: session.provider,
        sessionId: session.sessionId, timestampMs: message.timestampMs }));
    const promptCount = store.insertPromptEvents(promptEvents);
    result.prompts += promptCount;
    providerResult.prompts += promptCount;
    store.upsertSessions([{ provider: session.provider, sessionId: session.sessionId, cwd: session.cwd,
      project: path.basename(session.cwd || session.projectDirName), promptCount,
      startedAtMs: session.createdAt || (promptEvents.length ? Math.min(...promptEvents.map(event => event.timestampMs)) : 0),
      updatedAtMs: Math.max(session.updatedAt, ...[...content.messages.values()].map(message => message.timestampMs)) }]);
  }
  for (const provider of Object.keys(result.providers)) {
    const changed = store.reconcileCodebuddyUsageBatch([...records.values()].filter(record => record.provider === provider));
    result.records += changed;
    result.providers[provider].records += changed;
  }
  return result;
}

module.exports = { readIdeRequestUsage, scanCodebuddyIdeUsage };
