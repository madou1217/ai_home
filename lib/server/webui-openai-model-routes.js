'use strict';

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const GO_OPENAI_MODELS_PREFIX = '/v1/management/webui/openai-models';
const PASS_STATUSES = Object.freeze([400, 404, 405, 409, 501]);
const GO_UNAVAILABLE_MESSAGE = 'Go Core 模型目录服务不可用';
const REFRESH_JOB_WAIT_TIMEOUT_MS = 120000;

function readAccountRefQuery(ctx) {
  const params = ctx && ctx.url && ctx.url.searchParams;
  if (!params) return '';
  const accountRef = String(params.get('accountRef') || '').trim();
  return accountRef ? `accountRef=${encodeURIComponent(accountRef)}` : '';
}

async function readJsonRequestBody(ctx) {
  const readRequestBody = ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody);
  const writeJson = ctx.writeJson || (ctx.deps && ctx.deps.writeJson);
  if (typeof readRequestBody !== 'function') {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return null;
  }
  const buffer = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!buffer) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return null;
  }
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
      return null;
    }
    return parsed;
  } catch (_error) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json' });
    return null;
  }
}

async function handleGetOpenAIModelsRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `${GO_OPENAI_MODELS_PREFIX}/catalog`,
    query: readAccountRefQuery(ctx),
    useFullBody: true,
    passStatuses: [400, 404],
    message: GO_UNAVAILABLE_MESSAGE
  });
}

async function handleCreateManualOpenAIModelRequest(ctx) {
  const payload = await readJsonRequestBody(ctx);
  if (!payload) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: GO_OPENAI_MODELS_PREFIX,
    body: payload,
    passStatuses: PASS_STATUSES,
    message: GO_UNAVAILABLE_MESSAGE
  });
}

async function handleUpdateOpenAIModelRequest(ctx) {
  const payload = await readJsonRequestBody(ctx);
  if (!payload) return true;
  return proxyWebuiGo(ctx, {
    method: 'PATCH',
    path: GO_OPENAI_MODELS_PREFIX,
    body: payload,
    passStatuses: PASS_STATUSES,
    message: GO_UNAVAILABLE_MESSAGE
  });
}

async function handleDeleteOpenAIModelRequest(ctx) {
  const payload = await readJsonRequestBody(ctx);
  if (!payload) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_OPENAI_MODELS_PREFIX}/catalog/delete`,
    body: payload,
    passStatuses: [400, 404],
    message: GO_UNAVAILABLE_MESSAGE
  });
}

function handleRefreshOpenAIModelsRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_OPENAI_MODELS_PREFIX}/catalog/refresh`,
    query: readAccountRefQuery(ctx),
    status: 202,
    passStatuses: [400, 404, 501],
    message: GO_UNAVAILABLE_MESSAGE
  });
}

async function handleWatchOpenAIModelsRequest(ctx) {
  const { req, res } = ctx;
  const writeJson = ctx.writeJson || (ctx.deps && ctx.deps.writeJson);
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: GO_UNAVAILABLE_MESSAGE });
    return true;
  }

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'GET',
      path: `${GO_OPENAI_MODELS_PREFIX}/watch`,
      accept: 'text/event-stream'
    });
  } catch (_error) {
    upstream = null;
  }
  if (!upstream) {
    writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: GO_UNAVAILABLE_MESSAGE });
    return true;
  }
  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(res, Number(upstream.status) || 502, payload || { ok: false, error: 'go_core_unavailable' });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const reader = upstream.body.getReader();
  let closed = false;
  const abort = () => {
    if (closed) return;
    closed = true;
    try { reader.cancel(); } catch (_error) {}
  };
  req.on('close', abort);
  res.on('close', abort);
  res.on('error', abort);

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const onFinish = () => {
            res.off('drain', onFinish);
            res.off('close', onFinish);
            resolve();
          };
          res.once('drain', onFinish);
          res.once('close', onFinish);
        });
      }
    }
  } catch (_error) {
    // 客户端断开或 Go SSE 流结束。
  }
  try { res.end(); } catch (_error) {}
  return true;
}

function isTerminalJobStatus(status) {
  return status === 'succeeded' || status === 'failed';
}

function applyCatalogJobState(target, source) {
  if (!source || typeof source !== 'object') return;
  if (source.id) target.id = String(source.id);
  if (source.status) target.status = String(source.status);
  if (source.accountScope !== undefined) target.accountScope = source.accountScope;
  if (Number.isFinite(Number(source.startedAt))) target.startedAt = Number(source.startedAt);
  if (Number.isFinite(Number(source.finishedAt))) target.finishedAt = Number(source.finishedAt);
  if (source.catalog !== undefined) target.catalog = source.catalog;
  if (source.error !== undefined) target.error = String(source.error || '');
}

function parseSseDataFrame(frame) {
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n'));
  } catch (_error) {
    return null;
  }
}

async function waitForCatalogJobCompletion(reader, job, timeoutMs) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let timer = null;
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { reader.cancel(); } catch (_error) {}
      const err = new Error('model_catalog_refresh_timeout');
      job.status = 'failed';
      job.error = err.message;
      job.finishedAt = Date.now();
      reject(err);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  const consumeLoop = (async () => {
    while (!timedOut) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const frame of parts) {
        const event = parseSseDataFrame(frame);
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'model-catalog-snapshot' && Array.isArray(event.jobs)) {
          const matched = event.jobs.find((item) => item && item.id === job.id);
          if (matched) {
            applyCatalogJobState(job, matched);
            if (isTerminalJobStatus(job.status)) return job;
          }
        } else if (event.type === 'model-catalog-job' && event.job && event.job.id === job.id) {
          applyCatalogJobState(job, event.job);
          if (isTerminalJobStatus(job.status)) return job;
        }
      }
    }
    if (!isTerminalJobStatus(job.status)) {
      const err = new Error(job.error || 'model_catalog_watch_closed');
      job.status = 'failed';
      job.error = err.message;
      job.finishedAt = Date.now();
      throw err;
    }
    return job;
  })();

  try {
    return await Promise.race([consumeLoop, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runGoModelCatalogRefreshJob(ctx, job, accountRef) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.webuiRequest !== 'function') {
    const err = new Error('go_core_unavailable');
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = Date.now();
    throw err;
  }

  let upstream = null;
  if (typeof goHost.openWebuiStream === 'function') {
    upstream = await goHost.openWebuiStream({
      method: 'GET',
      path: `${GO_OPENAI_MODELS_PREFIX}/watch`,
      accept: 'text/event-stream'
    }).catch(() => null);
  }
  const reader = upstream && upstream.ok && upstream.body
    ? upstream.body.getReader()
    : null;
  const abortStream = () => {
    if (!reader) return;
    try { reader.cancel(); } catch (_error) {}
  };

  const query = accountRef ? `?accountRef=${encodeURIComponent(accountRef)}` : '';
  let resp = null;
  try {
    resp = await goHost.webuiRequest({
      method: 'POST',
      path: `${GO_OPENAI_MODELS_PREFIX}/catalog/refresh${query}`
    });
  } catch (error) {
    abortStream();
    job.status = 'failed';
    job.error = String((error && error.message) || error || 'go_core_unavailable');
    job.finishedAt = Date.now();
    throw error;
  }

  if (!resp || resp.ok !== true) {
    abortStream();
    const message = String(
      (resp && resp.data && (resp.data.message || resp.data.error))
      || (resp && resp.errorCode)
      || 'go_core_unavailable'
    );
    const err = new Error(message);
    if (resp && Number(resp.status) === 404) err.code = 'account_not_found';
    job.status = 'failed';
    job.error = message;
    job.finishedAt = Date.now();
    throw err;
  }

  const startedJob = resp.data && resp.data.job;
  if (startedJob) {
    applyCatalogJobState(job, startedJob);
    if (isTerminalJobStatus(job.status)) {
      abortStream();
      return job;
    }
  }

  if (!reader) {
    const catalogResp = await goHost.webuiRequest({
      method: 'GET',
      path: `${GO_OPENAI_MODELS_PREFIX}/catalog${query}`
    }).catch(() => null);
    if (catalogResp && catalogResp.ok === true) {
      job.catalog = catalogResp.body !== undefined ? catalogResp.body : catalogResp.data;
    }
    if (!isTerminalJobStatus(job.status)) {
      job.status = 'succeeded';
      job.finishedAt = Date.now();
    }
    return job;
  }

  try {
    return await waitForCatalogJobCompletion(reader, job, REFRESH_JOB_WAIT_TIMEOUT_MS);
  } finally {
    abortStream();
  }
}

function startModelCatalogRefreshJob(ctx, accountScope) {
  const accountRef = String(accountScope && accountScope.accountRef || '').trim();
  const job = {
    id: '',
    status: 'queued',
    accountScope: accountRef ? { accountRef } : null,
    startedAt: 0,
    finishedAt: 0,
    catalog: null,
    error: ''
  };
  job.completion = runGoModelCatalogRefreshJob(ctx, job, accountRef);
  job.completion.catch(() => {});
  return { job, alreadyRunning: false };
}

module.exports = {
  handleCreateManualOpenAIModelRequest,
  handleDeleteOpenAIModelRequest,
  handleRefreshOpenAIModelsRequest,
  handleGetOpenAIModelsRequest,
  handleUpdateOpenAIModelRequest,
  handleWatchOpenAIModelsRequest,
  startModelCatalogRefreshJob
};
