'use strict';

const { spawn } = require('node:child_process');
const { rewriteCodexAppServerClientMessage } = require('./codex-app-server-proxy');
const AGGREGATE_THREAD_LIST_MAX_PAGES = 3;
const AGGREGATE_THREAD_LIST_MAX_ITEMS = 80;

function parseProxyArgs(argv) {
  const input = Array.isArray(argv) ? [...argv] : [];
  const result = {
    upstream: '',
    stateFile: '',
    forwardArgs: []
  };
  let passthrough = false;
  for (let index = 0; index < input.length; index += 1) {
    const token = String(input[index] || '');
    if (passthrough) {
      result.forwardArgs.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (token === '--upstream') {
      result.upstream = String(input[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--state-file') {
      result.stateFile = String(input[index + 1] || '').trim();
      index += 1;
      continue;
    }
  }
  return result;
}

function readHookState(fs, stateFile) {
  const filePath = String(stateFile || '').trim();
  if (!filePath || !fs || typeof fs.existsSync !== 'function' || !fs.existsSync(filePath)) {
    return { enabled: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { enabled: false };
    return {
      enabled: parsed.enabled === true,
      traceFile: String(parsed.traceFile || '').trim(),
      traceResponses: parsed.traceResponses === true
    };
  } catch (_error) {
    return { enabled: false };
  }
}

function createTraceWriter(fs, state) {
  const traceFile = String(state && state.traceFile || '').trim();
  if (!traceFile) {
    return () => {};
  }
  return (entry) => {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        ...entry
      });
      fs.appendFileSync(traceFile, `${line}\n`);
    } catch (_error) {}
  };
}

function createLinePump(onLine) {
  let buffer = '';
  return {
    write(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach((line) => onLine(line));
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = '';
      }
    }
  };
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch (_error) {
    return null;
  }
}

function shouldAggregateThreadList(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.method !== 'thread/list') return false;
  const params = payload.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  if (params.cursor) return false;
  if (params.archived !== false) return false;
  if (!Array.isArray(params.sourceKinds) || params.sourceKinds.length > 0) return false;
  return true;
}

function buildAggregatePageRequest(baseRequest, cursor, requestId, remainingItems) {
  const baseParams = baseRequest.params || {};
  const requestedLimit = Number(baseParams.limit);
  const fallbackLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : 50;
  const requestedPageLimit = Number.isFinite(remainingItems) && remainingItems > 0
    ? Math.min(fallbackLimit, remainingItems)
    : fallbackLimit;
  return {
    ...baseRequest,
    id: requestId,
    params: {
      ...baseParams,
      limit: requestedPageLimit,
      cursor
    }
  };
}

function mergeThreadListData(existingData, nextData) {
  const seen = new Set();
  const merged = [];
  for (const item of Array.isArray(existingData) ? existingData : []) {
    const key = item && item.id ? String(item.id) : '';
    if (key) seen.add(key);
    merged.push(item);
  }
  for (const item of Array.isArray(nextData) ? nextData : []) {
    const key = item && item.id ? String(item.id) : '';
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(item);
  }
  return merged;
}

function forwardExitCode(child, processObj) {
  child.on('exit', (code, signal) => {
    if (signal) {
      try {
        processObj.kill(processObj.pid, signal);
        return;
      } catch (_error) {}
    }
    processObj.exit(Number.isFinite(code) ? code : 0);
  });
}

function runCodexAppServerStdioProxy(argv, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const spawnImpl = deps.spawn || spawn;
  const processObj = deps.processObj || process;
  const parsed = parseProxyArgs(argv);
  if (!parsed.upstream) {
    throw new Error('missing_upstream_binary');
  }

  const state = readHookState(fs, parsed.stateFile);
  const writeTrace = createTraceWriter(fs, state);
  const aggregateContexts = new Map();
  const aggregateRequestIdToContextId = new Map();
  if (!state.enabled) {
    const child = spawnImpl(parsed.upstream, parsed.forwardArgs, {
      stdio: 'inherit',
      env: processObj.env || process.env
    });
    forwardExitCode(child, processObj);
    return child;
  }

  const child = spawnImpl(parsed.upstream, parsed.forwardArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: processObj.env || process.env
  });

  const stdinPump = createLinePump((line) => {
    const rewrittenPayload = rewriteCodexAppServerClientMessage(line);
    const parsedPayload = tryParseJson(rewrittenPayload);
    if (shouldAggregateThreadList(parsedPayload)) {
      const originalId = parsedPayload.id;
      const firstRequest = buildAggregatePageRequest(
        parsedPayload,
        null,
        originalId,
        AGGREGATE_THREAD_LIST_MAX_ITEMS
      );
      const contextId = String(originalId);
      aggregateContexts.set(contextId, {
        originalId,
        requestTemplate: firstRequest,
        pagesFetched: 0,
        collectedData: [],
        requestedItems: Number(firstRequest.params && firstRequest.params.limit) || 0,
        backwardsCursor: null,
        nextCursor: null
      });
      aggregateRequestIdToContextId.set(String(originalId), contextId);
      const payload = JSON.stringify(firstRequest);
      writeTrace({
        direction: 'client_to_upstream',
        original: line,
        rewritten: payload,
        changed: payload !== line,
        aggregate: true
      });
      child.stdin.write(`${payload}\n`);
      return;
    }
    if (line) {
      writeTrace({
        direction: 'client_to_upstream',
        original: line,
        rewritten: rewrittenPayload,
        changed: rewrittenPayload !== line
      });
    }
    child.stdin.write(`${rewrittenPayload}\n`);
  });
  const stdoutPump = createLinePump((line) => {
    const parsedResponse = tryParseJson(line);
    const responseId = parsedResponse && Object.prototype.hasOwnProperty.call(parsedResponse, 'id')
      ? String(parsedResponse.id)
      : '';
    const aggregateContextId = responseId ? aggregateRequestIdToContextId.get(responseId) : '';
    if (aggregateContextId) {
      const context = aggregateContexts.get(aggregateContextId);
      if (context && parsedResponse && parsedResponse.result && typeof parsedResponse.result === 'object') {
        const result = parsedResponse.result;
        context.pagesFetched += 1;
        context.collectedData = mergeThreadListData(context.collectedData, result.data);
        if (!context.backwardsCursor && result.backwardsCursor) {
          context.backwardsCursor = result.backwardsCursor;
        }
        context.nextCursor = result.nextCursor || null;
        aggregateRequestIdToContextId.delete(responseId);
        const remainingItems = Math.max(
          0,
          AGGREGATE_THREAD_LIST_MAX_ITEMS - context.requestedItems
        );

        if (
          context.pagesFetched < AGGREGATE_THREAD_LIST_MAX_PAGES
          && context.nextCursor
          && remainingItems > 0
        ) {
          const nextRequestId = `aih-aggregate-thread-list:${context.originalId}:${context.pagesFetched + 1}`;
          const nextRequest = buildAggregatePageRequest(
            context.requestTemplate,
            context.nextCursor,
            nextRequestId,
            remainingItems
          );
          context.requestedItems += Number(nextRequest.params && nextRequest.params.limit) || 0;
          aggregateRequestIdToContextId.set(String(nextRequestId), aggregateContextId);
          writeTrace({
            direction: 'proxy_to_upstream',
            rewritten: JSON.stringify(nextRequest),
            aggregate: true,
            page: context.pagesFetched + 1
          });
          child.stdin.write(`${JSON.stringify(nextRequest)}\n`);
          return;
        }

        aggregateContexts.delete(aggregateContextId);
        const finalPayload = JSON.stringify({
          id: context.originalId,
          result: {
            data: context.collectedData,
            nextCursor: context.nextCursor,
            backwardsCursor: context.backwardsCursor
          }
        });
        if (state.traceResponses) {
          writeTrace({
            direction: 'upstream_to_client',
            payload: finalPayload,
            aggregate: true,
            pagesFetched: context.pagesFetched
          });
        }
        processObj.stdout.write(`${finalPayload}\n`);
        return;
      }
      aggregateRequestIdToContextId.delete(responseId);
      aggregateContexts.delete(aggregateContextId);
    }

    if (line && state.traceResponses) {
      writeTrace({
        direction: 'upstream_to_client',
        payload: line
      });
    }
    processObj.stdout.write(`${line}\n`);
  });

  processObj.stdin.on('data', (chunk) => stdinPump.write(chunk));
  processObj.stdin.on('end', () => {
    stdinPump.flush();
    if (child.stdin) child.stdin.end();
  });
  child.stdout.on('data', (chunk) => stdoutPump.write(chunk));
  child.stdout.on('end', () => stdoutPump.flush());
  child.on('error', (error) => {
    processObj.stderr.write(`${String((error && error.message) || error || 'proxy_failed')}\n`);
    processObj.exit(1);
  });
  forwardExitCode(child, processObj);
  return child;
}

if (require.main === module) {
  try {
    runCodexAppServerStdioProxy(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String((error && error.message) || error || 'proxy_failed')}\n`);
    process.exit(1);
  }
}

module.exports = {
  AGGREGATE_THREAD_LIST_MAX_ITEMS,
  AGGREGATE_THREAD_LIST_MAX_PAGES,
  shouldAggregateThreadList,
  buildAggregatePageRequest,
  mergeThreadListData,
  parseProxyArgs,
  readHookState,
  runCodexAppServerStdioProxy
};
