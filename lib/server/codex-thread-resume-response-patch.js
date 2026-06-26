'use strict';

function normalizeString(value) {
  return String(value || '').trim();
}

function getJsonRpcId(payload) {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'id')) return '';
  return String(payload.id).trim();
}

function getJsonRpcThreadId(payload) {
  const params = payload && payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const thread = params.thread && typeof params.thread === 'object' && !Array.isArray(params.thread)
    ? params.thread
    : {};
  return normalizeString(params.threadId || params.thread_id || params.id || thread.id);
}

function rememberThreadResumeRequest(payload, responseContexts) {
  if (
    !payload
    || payload.method !== 'thread/resume'
    || !responseContexts
    || typeof responseContexts.set !== 'function'
  ) {
    return false;
  }
  const id = getJsonRpcId(payload);
  if (!id) return false;
  responseContexts.set(id, {
    method: 'thread/resume',
    threadId: getJsonRpcThreadId(payload)
  });
  return true;
}

function rememberThreadResumeRequestMessage(raw, responseContexts) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || ''));
  } catch (_error) {
    return false;
  }
  return rememberThreadResumeRequest(parsed, responseContexts);
}

function patchThreadResumeResponse(payload, requestContext) {
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || !payload.result
    || typeof payload.result !== 'object'
    || Array.isArray(payload.result)
  ) {
    return payload;
  }
  if (Object.prototype.hasOwnProperty.call(payload.result, 'threadIds')) return payload;

  const thread = payload.result.thread && typeof payload.result.thread === 'object' && !Array.isArray(payload.result.thread)
    ? payload.result.thread
    : {};
  const threadId = normalizeString(
    requestContext && requestContext.threadId
      ? requestContext.threadId
      : thread.id
  );
  if (!threadId) return payload;

  return {
    ...payload,
    result: {
      ...payload.result,
      threadIds: [threadId]
    }
  };
}

function patchThreadResumeResponseMessage(raw, responseContexts) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;

  const id = getJsonRpcId(parsed);
  if (!id || !responseContexts || typeof responseContexts.get !== 'function') return text;

  const context = responseContexts.get(id);
  if (!context || context.method !== 'thread/resume') return text;
  responseContexts.delete(id);

  const patched = patchThreadResumeResponse(parsed, context);
  return patched === parsed ? text : JSON.stringify(patched);
}

module.exports = {
  getJsonRpcId,
  getJsonRpcThreadId,
  rememberThreadResumeRequest,
  rememberThreadResumeRequestMessage,
  patchThreadResumeResponse,
  patchThreadResumeResponseMessage
};
