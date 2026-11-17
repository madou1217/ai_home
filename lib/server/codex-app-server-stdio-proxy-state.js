'use strict';
// AIH cursor routing keeps its public wire contract; vendor state reads are native.

const { STATE_THREAD_LIST_CURSOR_PREFIX, resolveCodexStateHome, readStateThreadListPage, buildThreadFromStateRow } = require('./codex-app-server-stdio-proxy-utils');

function buildStateThreadListResponse(payload, deps = {}, requestContext = null) {
  if (!payload || payload.method !== 'thread/list' || !Object.prototype.hasOwnProperty.call(payload, 'id')) return null;
  const params = requestContext || (payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {});
  if (!String(params.cursor || '').startsWith(STATE_THREAD_LIST_CURSOR_PREFIX)) return null;
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  try {
    return require('./codex-state-native-reader').readNativeThreadListResponse(codexHome, payload.id, params, deps);
  } catch (error) {
    // Only subprocess/admission failures are local I/O errors. The complete
    // business result/error, including the typed ID, is owned by Go.
    return { id: payload.id, error: { code: -32000, message: error.code || 'codex_state_read_unavailable' } };
  }
}


function buildThreadListStateThreads(params = {}, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  if (!codexHome) return [];
  const page = readStateThreadListPage(params, { ...deps, fs, codexHome });
  const rows = page ? page.rows : [];
  return rows
    .map((row) => {
      const thread = buildThreadFromStateRow(row, [], {
        status: { type: 'notLoaded' }
      });
      if (!thread || !thread.id) return null;
      return thread;
    })
    .filter(Boolean);
}


module.exports = { buildStateThreadListResponse, buildThreadListStateThreads };
