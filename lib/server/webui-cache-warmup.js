'use strict';

// Post-listen warm-up for WebUI GET endpoints whose first build is expensive.
//
// Each listed route already caches its result stale-while-revalidate on the server
// state; this only issues the first read in the background so the user's first page
// load is served from memory. Requests are sequential (they are mostly synchronous
// probes; running them together would just queue on the event loop) and go through
// the normal authenticated loopback path, so no route logic is duplicated here.

const WARMUP_PATHS = Object.freeze([
  '/v0/webui/toolkit/native-resources',
  '/v0/webui/toolkit/apps',
  '/v0/webui/toolkit/tools',
  '/v0/webui/toolkit/environments',
  '/v0/webui/toolkit/mirrors',
  '/v0/webui/toolkit/provider-configs',
  '/v0/webui/toolkit/terminals',
  '/v0/webui/management/usage/stats'
]);
const WARMUP_REQUEST_TIMEOUT_MS = 30 * 1000;
const WARMUP_GAP_MS = 250;

function warmPath(http, port, managementKey, pathname) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${managementKey}`,
        'X-AIH-Warmup': '1'
      },
      timeout: WARMUP_REQUEST_TIMEOUT_MS
    }, (response) => {
      response.resume();
      response.on('end', resolve);
      response.on('error', resolve);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', resolve);
    request.end();
  });
}

async function warmWebUiCaches(options = {}) {
  const http = options.http || require('node:http');
  const port = Number(options.port);
  const managementKey = String(
    typeof options.getManagementKey === 'function' ? options.getManagementKey() || '' : ''
  ).trim();
  if (!Number.isInteger(port) || port <= 0 || !managementKey) return false;
  for (const pathname of options.paths || WARMUP_PATHS) {
    await warmPath(http, port, managementKey, pathname);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, WARMUP_GAP_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
  return true;
}

module.exports = { WARMUP_PATHS, warmWebUiCaches };
