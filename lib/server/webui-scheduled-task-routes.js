'use strict';

// **WebUI 数据面：计划任务**（定义 / 状态 / 运行记录 / 手动触发）。
//
// 事件目录不是手写清单：`activity:<provider>:<actionId>` 来自 provider 描述符的
// `activity.actions[]`（如 zcode 的「领臭鸡蛋」、qoder 的「签到」），因此新增 provider
// 或动作只改描述符，这里的下拉框自动跟着变。另加一个用户自定义命令事件。
//
// 路由：
//   GET    /v0/webui/scheduled-tasks            列表 + 可选事件目录 + 调度器状态
//   POST   /v0/webui/scheduled-tasks            新建/更新（body: {id?, name, eventId, eventParams, schedule, enabled}）
//   POST   /v0/webui/scheduled-tasks/:id/run    立即执行一次（后台跑，进度进统一任务队列）
//   POST   /v0/webui/scheduled-tasks/:id/toggle 启用/停用（body: {enabled}）
//   POST   /v0/webui/scheduled-tasks/:id/delete 删除
//   GET    /v0/webui/scheduled-tasks/records    运行记录（默认近几天）

const { createScheduledTaskService } = require('./scheduled-task-service');
const { getAccountActivityJobManager } = require('./webui-account-activity-routes');
const { resolveAiHomeDir } = require('../runtime/aih-home');

const TASKS_ROUTE = '/v0/webui/scheduled-tasks';
const RECORDS_ROUTE = '/v0/webui/scheduled-tasks/records';
const PREVIEW_ROUTE = '/v0/webui/scheduled-tasks/preview';
const TASK_ACTION_ROUTE = /^\/v0\/webui\/scheduled-tasks\/([A-Za-z0-9._:-]{1,128})\/(run|toggle|delete)$/;

const servicesByState = new WeakMap();
let fallbackService = null;

async function readJsonBody(ctx) {
  const readRequestBody = ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody);
  if (typeof readRequestBody !== 'function') return null;
  try {
    const body = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 });
    return body && body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function createServiceForCtx(ctx) {
  return createScheduledTaskService({
    aiHomeDir: resolveAiHomeDir(ctx),
    deps: {
      ...(ctx && ctx.deps ? {
        ...(ctx.deps.accountEgressDeps ? { accountEgressDeps: ctx.deps.accountEgressDeps } : {}),
        ...(ctx.deps.fs ? { fs: ctx.deps.fs } : {}),
        ...(ctx.deps.path ? { path: ctx.deps.path } : {})
      } : {}),
      // 活动类事件复用**同一个**账号活动 job manager —— 于是计划触发的领取与手动触发
      // 在统一任务队列里完全一样（有实时进度），也天然串行、不会并发打上游。
      getActivityJobManager: () => getAccountActivityJobManager(ctx)
    }
  });
}

/** 每个 server 实例一个服务（调度器随首次使用启动）。 */
function getScheduledTaskService(ctx) {
  const injected = ctx && ctx.deps && ctx.deps.scheduledTaskService;
  if (injected) return injected;
  if (ctx && ctx.state && typeof ctx.state === 'object') {
    const cached = servicesByState.get(ctx.state);
    if (cached) return cached;
    const service = createServiceForCtx(ctx);
    service.start();
    servicesByState.set(ctx.state, service);
    return service;
  }
  if (!fallbackService) {
    fallbackService = createServiceForCtx(ctx);
    fallbackService.start();
  }
  return fallbackService;
}

function writeJson(ctx, status, payload) {
  if (typeof ctx.writeJson === 'function') {
    ctx.writeJson(ctx.res, status, payload);
    return;
  }
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  ctx.res.end(JSON.stringify(payload));
}

async function handleWebUiScheduledTaskRoutes(ctx = {}) {
  const { method, pathname } = ctx;
  if (pathname !== TASKS_ROUTE && pathname !== RECORDS_ROUTE && pathname !== PREVIEW_ROUTE
    && !TASK_ACTION_ROUTE.test(pathname)) {
    return false;
  }
  const service = getScheduledTaskService(ctx);

  if (pathname === TASKS_ROUTE && method === 'GET') {
    writeJson(ctx, 200, { ok: true, ...service.list() });
    return true;
  }
  if (pathname === TASKS_ROUTE && method === 'POST') {
    const body = await readJsonBody(ctx);
    if (!body || typeof body !== 'object') {
      writeJson(ctx, 400, { ok: false, error: 'invalid_body' });
      return true;
    }
    const result = service.upsert(body);
    if (!result.ok) {
      writeJson(ctx, 400, { ok: false, error: result.error });
      return true;
    }
    writeJson(ctx, 200, { ok: true, task: result.task });
    return true;
  }
  if (pathname === RECORDS_ROUTE && method === 'GET') {
    const query = ctx.query && typeof ctx.query === 'object' ? ctx.query : {};
    const url = new URL(String((ctx.req && ctx.req.url) || RECORDS_ROUTE), 'http://127.0.0.1');
    const pick = (key) => query[key] || url.searchParams.get(key);
    // 真分页：days 定时间窗，taskId 定归属，limit/offset 切页，响应带 total。
    writeJson(ctx, 200, {
      ok: true,
      ...service.records({
        days: pick('days'),
        taskId: pick('taskId'),
        limit: pick('limit'),
        offset: pick('offset')
      })
    });
    return true;
  }
  if (pathname === PREVIEW_ROUTE && method === 'POST') {
    // 调度预览：把「下次运行时间 + 中文解读」交给服务端算 —— 解读逻辑只实现一次
    // （lib/server/scheduled-task-cron.js），前端不重复一份。
    const body = await readJsonBody(ctx);
    if (!body || typeof body !== 'object') {
      writeJson(ctx, 400, { ok: false, error: 'invalid_body' });
      return true;
    }
    const preview = service.previewSchedule(body.schedule);
    writeJson(ctx, preview.ok ? 200 : 400, preview);
    return true;
  }
  const match = TASK_ACTION_ROUTE.exec(pathname);
  if (match) {
    const taskId = match[1];
    const action = match[2];
    if (method !== 'POST') {
      writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    if (action === 'delete') {
      const result = service.remove(taskId);
      writeJson(ctx, result.ok ? 200 : 409, { ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
      return true;
    }
    if (action === 'toggle') {
      const body = await readJsonBody(ctx);
      if (!body || typeof body !== 'object') {
        writeJson(ctx, 400, { ok: false, error: 'invalid_body' });
        return true;
      }
      const result = service.setEnabled(taskId, body.enabled !== false);
      writeJson(ctx, result.ok ? 200 : 404, { ok: result.ok, ...(result.ok ? { task: result.task } : { error: result.error }) });
      return true;
    }
    // run：立即执行一次。**异步**执行、立刻 202：账号活动要过验证码，同步 HTTP 会超时；
    // 进度与结果走统一任务队列 + 运行记录两条通道。
    const started = service.isRunning(taskId);
    if (started) {
      writeJson(ctx, 409, { ok: false, error: 'task_running' });
      return true;
    }
    void service.runTask(taskId, 'manual');
    writeJson(ctx, 202, { ok: true, accepted: true });
    return true;
  }
  writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = {
  TASKS_ROUTE,
  RECORDS_ROUTE,
  TASK_ACTION_ROUTE,
  getScheduledTaskService,
  handleWebUiScheduledTaskRoutes
};
