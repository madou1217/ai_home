'use strict';

// WebUI 运行环境路由：本文件只做「解析请求 → Go 管理面 → 回写响应」。
//
// 迁移后 Node 不再持有工具目录、安装计划、探测与作业状态机：
//   GET  /v0/webui/toolkit/environments               → Go 汇总（含 ssh 远端）
//   GET  /v0/webui/toolkit/environments/guide         → Go 指南
//   POST /v0/webui/toolkit/environments/plan          → Go 计划
//   POST /v0/webui/toolkit/environments/execute       → Go 执行 / 作业
//   GET  /v0/webui/toolkit/environments/jobs          → Go 活动作业
//   GET  /v0/webui/toolkit/environments/jobs/:id      → Go 单作业
//   GET  /v0/webui/toolkit/environments/jobs/:id/watch→ Go SSE
//   POST /v0/webui/toolkit/environments/jobs/:id/cancel → Go 取消
//
// 任务队列（/v0/webui/tasks）仍由 Node 提供：作业事件由 webui-environment-job-bridge
// 订阅 Go 的全局事件流后投影过去，这里只保证桥已启动。

const { callGoHost } = require('./webui-go-proxy');
const {
  ensureEnvironmentJobBridge,
  publishEnvironmentJob
} = require('./webui-environment-job-bridge');

const PASS_STATUSES = [400, 404, 409, 428, 502, 504];
const JOB_ROUTE = /^\/v0\/webui\/toolkit\/environments\/jobs\/([^/]+)(?:\/(watch|cancel))?$/;

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('environment_payload_too_large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeGoResult(ctx, response, options = {}) {
  const status = Number(response && response.status) || 0;
  if (response && response.ok === true) {
    ctx.writeJson(ctx.res, Number(options.status) || 200, response.data);
    return true;
  }
  if (PASS_STATUSES.includes(status) && response && response.data) {
    ctx.writeJson(ctx.res, status, response.data);
    return true;
  }
  ctx.writeJson(ctx.res, Number(options.fallbackStatus) || 503, {
    ok: false,
    error: String(
      (response && response.data && response.data.error)
      || (response && response.errorCode)
      || 'go_core_unavailable'
    ),
    message: String(options.message || '')
  });
  return true;
}

function requestTarget(ctx, body) {
  const fromBody = body && typeof body.target === 'string' ? body.target.trim() : '';
  if (fromBody) return fromBody;
  const fromQuery = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('target') : '';
  return String(fromQuery || '').trim();
}

async function proxyJobWatch(ctx, goHost, jobId) {
  if (!goHost || typeof goHost.watchToolkitEnvironmentJob !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，作业事件不可读' });
    return true;
  }
  const result = await goHost.watchToolkitEnvironmentJob(jobId).catch(() => null);
  if (!result || !result.ok || !result.body) {
    return writeGoResult(ctx, result, { message: 'Go Core 未就绪，作业事件不可读' });
  }
  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  ctx.req.on('close', () => {
    try { result.abort?.(); } catch (_error) {}
  });
  const reader = result.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) ctx.res.write(Buffer.from(value));
    }
  } catch (_error) {
    // 客户端断开 / Go 侧关闭：结束响应即可。
  } finally {
    try { ctx.res.end(); } catch (_error) {}
  }
  return true;
}

async function handleWebUiEnvironmentRoutes(ctx = {}) {
  const { method, pathname, url } = ctx;
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  const message = 'Go Core 未就绪，运行环境不可用';
  ensureEnvironmentJobBridge(ctx);

  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments') {
    const target = requestTarget(ctx, null);
    const refresh = String((url && url.searchParams && url.searchParams.get('refresh')) || '') === '1';
    const response = goHost && typeof goHost.getToolkitEnvironmentSummary === 'function'
      ? await goHost.getToolkitEnvironmentSummary({ target, refresh }).catch(() => null)
      : null;
    return writeGoResult(ctx, response, { message });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments/guide') {
    const platform = String((url && url.searchParams && url.searchParams.get('platform')) || '').trim();
    const response = goHost && typeof goHost.getToolkitEnvironmentGuide === 'function'
      ? await goHost.getToolkitEnvironmentGuide(platform).catch(() => null)
      : null;
    return writeGoResult(ctx, response, { message: 'Go Core 未就绪，运行环境指南不可读' });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/environments/plan') {
    let body;
    try {
      body = await readJsonBody(ctx.req);
    } catch (_error) {
      ctx.writeJson(ctx.res, 500, { ok: false, error: 'invalid_environment_payload', message: '运行环境参数无效。' });
      return true;
    }
    const payload = { ...body, target: requestTarget(ctx, body) };
    const response = goHost && typeof goHost.planToolkitEnvironment === 'function'
      ? await goHost.planToolkitEnvironment(payload).catch(() => null)
      : null;
    return writeGoResult(ctx, response, { message: 'Go Core 未就绪，无法生成运行环境计划' });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/environments/execute') {
    let body;
    try {
      body = await readJsonBody(ctx.req);
    } catch (_error) {
      ctx.writeJson(ctx.res, 500, { ok: false, error: 'invalid_environment_payload', message: '运行环境参数无效。' });
      return true;
    }
    const payload = { ...body, target: requestTarget(ctx, body) };
    const response = goHost && typeof goHost.executeToolkitEnvironment === 'function'
      ? await goHost.executeToolkitEnvironment(payload).catch(() => null)
      : null;
    if (response && response.ok === true && response.data && response.data.job) {
      publishEnvironmentJob(ctx, response.data.job);
    }
    return writeGoResult(ctx, response, { status: 202, message: 'Go Core 未就绪，无法执行运行环境操作' });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/environments/jobs') {
    const response = goHost && typeof goHost.listToolkitEnvironmentJobs === 'function'
      ? await goHost.listToolkitEnvironmentJobs().catch(() => null)
      : null;
    return writeGoResult(ctx, response, { message });
  }

  const jobMatch = String(pathname || '').match(JOB_ROUTE);
  if (jobMatch) {
    let jobId = '';
    try {
      jobId = decodeURIComponent(jobMatch[1]);
    } catch (_error) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_job_path', message: '运行环境任务路径无效。' });
      return true;
    }
    const action = jobMatch[2] || '';
    if (method === 'GET' && action === 'watch') {
      return proxyJobWatch(ctx, goHost, jobId);
    }
    if (method === 'GET' && !action) {
      const response = goHost && typeof goHost.getToolkitEnvironmentJob === 'function'
        ? await goHost.getToolkitEnvironmentJob(jobId).catch(() => null)
        : null;
      if (response && response.ok === true && response.data && response.data.job) {
        publishEnvironmentJob(ctx, response.data.job);
      }
      return writeGoResult(ctx, response, { message });
    }
    if (method === 'POST' && action === 'cancel') {
      const response = goHost && typeof goHost.cancelToolkitEnvironmentJob === 'function'
        ? await goHost.cancelToolkitEnvironmentJob(jobId).catch(() => null)
        : null;
      return writeGoResult(ctx, response, { message });
    }
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'unsupported_environment_job_action', message: '不支持的运行环境任务操作。' });
    return true;
  }

  return false;
}

module.exports = {
  handleWebUiEnvironmentRoutes
};
