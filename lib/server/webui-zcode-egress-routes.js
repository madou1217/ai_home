'use strict';

// WebUI 数据面：账号出口绑定的读写薄壳。
//
// 设置本身（provider/账号校验、mode 与代理地址校验、绑定落盘、出口池分配投影）已经
// 划给 Go（internal/transport/http/webuiaccountegressapi，键 account:egress:<ref>）。
// 这里只保留浏览器契约与 Node 才能做的运行态部分：
//   1. 把请求转给 Go，400/404/409/500 原样透传；
//   2. 绑定变化后让 Go 转发判定用的出口索引失效、重排池车道；
//   3. 启动出口池、拉起 Desktop/CLI 并把绑定应用到运行中的实例；
//   4. apply 失败时用 Go 写回「写入前的绑定」做回滚；
//   5. 合并运行态与分配投影后回给浏览器。
//
// 为什么不复用既有的 /update 路由：那条路由对非 API-key 账号直接返回
// oauth_config_edit_unsupported（见 webui-account-routes.js 的 detectStoredApiKeyMode 分支），
// 而 zcode 账号是 oauth-browser，永远进不去。出口绑定与凭据编辑也不是一回事。

const { EGRESS_MODE_POOL } = require('../account/zcode-egress-binding-store');
const { createWebUiAccountAppLauncher } = require('./webui-account-app-launcher');
const {
  applyStoredAccountEgress,
  getAccountEgressRuntimeStatus
} = require('./zcode-egress-service');
const { callGoHost, writeGoFailure } = require('./webui-go-proxy');
const { startEgressPool } = require('../runtime/egress-pool-registry');

const EGRESS_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress$/;

function parseEgressRoute(pathname) {
  const match = EGRESS_ROUTE_PATTERN.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim()
    };
  } catch {
    return null;
  }
}

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME_DIR
    || ''
  ).trim();
}

function matchEgressRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return EGRESS_ROUTE_PATTERN.test(String(pathname || '')) && (verb === 'GET' || verb === 'POST');
}

function resolveRouteDependency(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

// 分配投影是增量读模型：读不到不影响绑定本身，按 null 返回。
function resolveAssignmentReadService(ctx) {
  const supplied = ctx && ctx.deps && ctx.deps.egressAssignmentService;
  if (supplied && typeof supplied.getAssignment === 'function') return supplied;
  const stateService = ctx && ctx.state && ctx.state.egressAssignmentService;
  if (stateService && typeof stateService.getAssignment === 'function') return stateService;
  return null;
}

function readAssignmentProjection(ctx, accountRef) {
  const service = resolveAssignmentReadService(ctx);
  if (!service) return null;
  try {
    return service.getAssignment(accountRef) || null;
  } catch (_error) {
    return null;
  }
}

async function readRuntimePresentation(ctx, input) {
  const getRuntimeStatus = resolveRouteDependency(
    ctx,
    'getAccountEgressRuntimeStatus',
    getAccountEgressRuntimeStatus
  );
  let launcher = input.launcher || null;
  if (!launcher) {
    const createLauncher = resolveRouteDependency(
      ctx,
      'createWebUiAccountAppLauncher',
      createWebUiAccountAppLauncher
    );
    try {
      launcher = createLauncher(ctx, input.provider, input.accountRef, 'inspect');
    } catch {
      launcher = null;
    }
  }
  try {
    const result = await getRuntimeStatus({
      ...input,
      ...(launcher ? { launcher } : {})
    });
    return result?.ok
      ? { runtime: result.runtime || null }
      : { runtime: null, runtimeError: String(result?.error || 'egress_status_unavailable') };
  } catch {
    return { runtime: null, runtimeError: 'egress_status_unavailable' };
  }
}

function goFailureOptions(message) {
  // 400/404/409 是 Go 的入参/账号判定，500 是绑定读写的失败码；两者都必须原样回给
  // 浏览器（前端按 error 码映射文案）。只有「宿主缺失/调用炸了」才落到 503。
  return { passStatuses: [400, 404, 409, 500], message };
}

// 回滚用的写入口：把 Go 返回的规范化记录还原成可再写入的 payload。
function rollbackPayload(binding) {
  if (!binding) return {};
  return {
    mode: binding.mode,
    proxyUrl: binding.proxyUrl,
    ...(binding.mode === EGRESS_MODE_POOL ? { scope: binding.scope, strategy: binding.strategy } : {})
  };
}

// 绑定变了：Go 转发判定用的出口索引立即失效（否则最长 TTL 内仍按旧绑定决定交给谁）。
function invalidateEgressIndex(ctx) {
  const index = ctx.state && ctx.state.accountEgressBindingIndex;
  if (index && typeof index.invalidate === 'function') index.invalidate();
  const planner = ctx.state && ctx.state.egressPoolPlanner;
  if (planner && typeof planner.reconcile === 'function') planner.reconcile();
}

/**
 * GET  /v0/webui/accounts/:provider/:accountRef/egress  读当前绑定
 * POST /v0/webui/accounts/:provider/:accountRef/egress  写入或清除绑定
 *
 * POST body: { mode: 'system' | 'tun' | 'url', proxyUrl?: string }
 *   —— body 为空对象、或 url 模式的地址为空，均视为解绑。
 *
 * @returns {Promise<boolean>} 是否已处理该请求
 */
async function handleZcodeEgressRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseEgressRoute(pathname);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 503, { ok: false, error: 'ai_home_dir_unavailable' });
    return true;
  }

  const method = String((ctx.req && ctx.req.method) || '').toUpperCase();
  const serviceInput = {
    fs: ctx.fs,
    aiHomeDir,
    provider,
    accountRef,
    processObj: ctx.processObj || process,
    deps: ctx.deps || {}
  };

  if (method === 'GET') {
    const read = await callGoHost(ctx, 'getAccountEgress', [provider, accountRef]);
    if (!read.available) {
      writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，账号出口不可读' });
      return true;
    }
    if (!read.response || read.response.ok !== true || !read.response.data) {
      writeGoFailure(ctx, read.response, goFailureOptions('Go Core 未就绪，账号出口不可读'));
      return true;
    }
    const binding = read.response.data.binding || null;
    const presentation = await readRuntimePresentation(ctx, { ...serviceInput, binding });
    const assignment = readAssignmentProjection(ctx, accountRef);
    writeJson(ctx.res, 200, { ok: true, binding, assignment, ...presentation });
    return true;
  }

  let payload;
  try {
    const body = await ctx.readRequestBody(ctx.req, { maxBytes: 16 * 1024 });
    payload = body ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }

  // 写入走 Go：mode/地址校验与落盘都由 Go 完成，Node 只按返回的规范化记录做运行态。
  const write = await callGoHost(ctx, 'saveAccountEgress', [provider, accountRef, payload]);
  if (!write.available) {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，账号出口设置未保存' });
    return true;
  }
  if (!write.response || write.response.ok !== true || !write.response.data) {
    writeGoFailure(ctx, write.response, goFailureOptions('Go Core 未就绪，账号出口设置未保存'));
    return true;
  }

  let binding = write.response.data.binding || null;
  const previousBinding = write.response.data.previous || null;
  const shouldClear = !binding;
  const poolBound = !shouldClear && binding.mode === EGRESS_MODE_POOL;

  invalidateEgressIndex(ctx);
  // 池模式：等车道真的选好节点再往下探测。规划器是异步应用车道表的，不等就会以
  // `egress_pool_lane_not_ready` 失败、把刚保存的绑定回滚（2026-10-21 报障）。
  if (poolBound) {
    const planner = ctx.state && ctx.state.egressPoolPlanner;
    if (planner && typeof planner.reconcileAndApply === 'function') {
      try {
        await planner.reconcileAndApply({ force: true });
      } catch {}
    }
  }

  const applyBinding = resolveRouteDependency(
    ctx,
    'applyStoredAccountEgress',
    applyStoredAccountEgress
  );
  const createLauncher = resolveRouteDependency(
    ctx,
    'createWebUiAccountAppLauncher',
    createWebUiAccountAppLauncher
  );
  // 出口池只在有人绑定时才起：这里是「第一次有人绑定」的时刻，先把池拉起来再探测，
  // 否则保存即探测会因池未就绪而回滚。启动失败照常落到探测的 fail-closed 结果上。
  if (poolBound) {
    const startPool = resolveRouteDependency(ctx, 'startEgressPool', startEgressPool);
    try {
      await startPool();
    } catch {}
  }
  let launcher = null;
  try {
    launcher = createLauncher(ctx, provider, accountRef, 'open');
  } catch {}
  const applyInput = {
    ...serviceInput,
    ...(launcher ? { launcher } : {})
  };
  let apply;
  try {
    apply = await applyBinding({ ...applyInput, binding });
  } catch {
    apply = { ok: false, applied: false, error: 'egress_apply_failed' };
  }
  // 已下线模式的旧记录不能再写回：新绑定即便暂不可用也照样 fail-closed，不比旧记录更松。
  if (apply?.ok === false && !previousBinding?.retired) {
    const restore = await callGoHost(ctx, 'saveAccountEgress', [provider, accountRef, rollbackPayload(previousBinding)]);
    const restored = restore.available && restore.response && restore.response.ok === true && restore.response.data
      ? (restore.response.data.binding || null)
      : null;
    if (!restore.available || !restore.response || restore.response.ok !== true) {
      apply = { ...apply, rolledBack: false, rollbackError: 'egress_binding_rollback_failed' };
    } else {
      binding = restored;
      invalidateEgressIndex(ctx);
      let rollback;
      try {
        rollback = await applyBinding({ ...applyInput, binding });
      } catch {
        rollback = { ok: false, error: 'egress_binding_rollback_failed' };
      }
      apply = rollback?.ok
        ? { ...apply, rolledBack: true }
        : {
            ...apply,
            rolledBack: false,
            rollbackError: String(rollback?.error || 'egress_binding_rollback_failed')
          };
    }
  }
  const presentation = await readRuntimePresentation(ctx, {
    ...serviceInput,
    binding,
    ...(launcher ? { launcher } : {})
  });
  const assignment = readAssignmentProjection(ctx, accountRef);
  writeJson(ctx.res, 200, { ok: true, binding, assignment, apply, ...presentation });
  return true;
}

module.exports = {
  EGRESS_ROUTE_PATTERN,
  handleZcodeEgressRequest,
  matchEgressRoute,
  parseEgressRoute,
  readAssignmentProjection
};
