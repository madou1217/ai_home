'use strict';

const crypto = require('node:crypto');
const { createGoCoreSupervisor } = require('../cli/services/server/go-core-supervisor');
const { createGoCoreGatewayForwarder } = require('./go-core-gateway-forwarder');
const { createGoAccountSync } = require('./go-account-sync');
const { createGoManagementClient } = require('../account/go-bridge/go-management-client');
const {
  compileRouteTable,
  loadRouteOwnershipManifest,
  parseEntryIdList,
  resolveGoOwnedEntryIds
} = require('./go-core-route-ownership');

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function hasEnv(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) && String(env[name]).trim() !== '';
}

/** 持久化 server config 是事实来源；AIH_GO_CORE_* 环境变量仅作开发期覆盖。 */
function resolveGoCoreSettings(config = {}, env = {}) {
  const numberOrUndefined = (value) => (hasEnv(env, value) ? Number(env[value]) : undefined);
  return {
    enabled: hasEnv(env, 'AIH_GO_CORE_ENABLED') ? isTruthy(env.AIH_GO_CORE_ENABLED) : config.goCoreEnabled === true,
    routes: parseEntryIdList(hasEnv(env, 'AIH_GO_CORE_ROUTES') ? env.AIH_GO_CORE_ROUTES : config.goCoreRoutes),
    binaryPath: hasEnv(env, 'AIH_GO_CORE_BINARY') ? String(env.AIH_GO_CORE_BINARY).trim() : undefined,
    host: hasEnv(env, 'AIH_GO_CORE_HOST') ? String(env.AIH_GO_CORE_HOST).trim() : undefined,
    port: numberOrUndefined('AIH_GO_CORE_PORT'),
    managementKey: hasEnv(env, 'AIH_GO_CORE_MANAGEMENT_KEY') ? String(env.AIH_GO_CORE_MANAGEMENT_KEY).trim() : '',
    // 账号双向同步默认随 Go Core 开启：没有它 Go 的 aih.db 与 Node 的 app-state.db 会分叉。
    accountSync: hasEnv(env, 'AIH_GO_CORE_ACCOUNT_SYNC') ? isTruthy(env.AIH_GO_CORE_ACCOUNT_SYNC) : true,
    clientKey: hasEnv(env, 'AIH_GO_CORE_CLIENT_KEY') ? String(env.AIH_GO_CORE_CLIENT_KEY).trim() : ''
  };
}

function generateBootKey() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Go Core 在 Node 公开宿主进程内的组合根（Facade）：监督 Go 子进程的完整生命周期，
 * 并按 route-ownership manifest 把已划给 Go 的数据面请求透明转发过去。
 * 监督器必须活在长驻 Server 进程里——活在短命 CLI 进程里时，CLI 退出后 Go 无人监督。
 */
function createGoCoreHost(deps = {}) {
  const settings = deps.settings || resolveGoCoreSettings();
  const log = deps.log || console;
  // manifest 是随代码发布的合同文件，始终从真实文件系统读取（不受注入的 fs 替身影响）。
  const manifest = deps.manifest || loadRouteOwnershipManifest({ repositoryRoot: deps.repositoryRoot });
  const ownership = resolveGoOwnedEntryIds(manifest, settings.routes);
  const managementKey = settings.managementKey || generateBootKey();
  const clientKey = settings.clientKey || generateBootKey();
  const buildSupervisor = deps.createGoCoreSupervisor || createGoCoreSupervisor;
  const supervisor = buildSupervisor({
    enabled: settings.enabled,
    fs: deps.fs,
    path: deps.path,
    spawn: deps.spawn,
    fetchImpl: deps.fetchImpl,
    processObj: deps.processObj,
    repositoryRoot: deps.repositoryRoot,
    binaryPath: settings.binaryPath,
    host: settings.host,
    port: settings.port,
    publicPort: deps.publicPort,
    aiHomeDir: deps.aiHomeDir,
    managementKey: () => managementKey,
    clientKey: () => clientKey
  });

  let accountsSynced = !settings.accountSync;

  function managementClient() {
    const status = supervisor.status();
    if (status.state !== 'ready' || !status.endpoint) return null;
    return createGoManagementClient({ baseUrl: status.endpoint, managementKey, fetchImpl: deps.fetchImpl });
  }

  const buildAccountSync = deps.createGoAccountSync || createGoAccountSync;
  const accountSync = settings.enabled && settings.accountSync && deps.aiHomeDir
    ? buildAccountSync({ fs: deps.fs, aiHomeDir: deps.aiHomeDir, getClient: managementClient, log, intervalMs: deps.accountSyncIntervalMs })
    : null;

  // 转发目标只在 Go 进程在服务、且首轮账号同步完成后可用；否则 Go 的 aih.db 可能还是空的。
  function getTarget() {
    const status = supervisor.status();
    if (status.state !== 'ready' || !status.endpoint || !accountsSynced) return null;
    const endpoint = new URL(status.endpoint);
    return { host: endpoint.hostname, port: Number(endpoint.port), clientKey };
  }

  const forwarder = createGoCoreGatewayForwarder({
    http: deps.http,
    net: deps.net,
    routeTable: compileRouteTable(manifest),
    entryIds: ownership.entryIds,
    requiredClientKey: deps.requiredClientKey,
    writeJson: deps.writeJson,
    getTarget
  });

  function reportConfiguration() {
    for (const error of ownership.errors) {
      log.error(`\x1b[31m[aih:go-core]\x1b[0m canary route config rejected: ${error}`);
    }
    if (ownership.entryIds.size > 0 && !settings.enabled) {
      log.error('\x1b[31m[aih:go-core]\x1b[0m routes are assigned to Go Core but Go Core is disabled; they fail closed with 503');
    }
    if (ownership.entryIds.size > 0) {
      log.log(`\x1b[90m[aih:go-core]\x1b[0m Go-owned routes: ${[...ownership.entryIds].sort().join(', ')}`);
    }
  }

  async function start() {
    reportConfiguration();
    if (!settings.enabled) return supervisor.status();
    try {
      const status = await supervisor.start();
      log.log(`\x1b[90m[aih:go-core]\x1b[0m Go Core ready at ${status.endpoint} (pid=${status.pid})`);
      if (accountSync) {
        const first = await accountSync.reconcile();
        accountsSynced = Boolean(first && !first.failed && !first.skipped);
        log.log(`\x1b[90m[aih:go-core]\x1b[0m account sync: pushed=${first.pushed || 0} pulled=${first.pulled || 0} adopted=${first.adopted || 0} errors=${(first.errors || []).length}`);
        accountSync.start();
      }
      return status;
    } catch (error) {
      // Go 启动失败不拖垮 Node 宿主；已划给 Go 的路由由 getTarget()=null 失败关闭。
      log.error(`\x1b[31m[aih:go-core]\x1b[0m Go Core start failed: ${error.code || error.message}`);
      return supervisor.status();
    }
  }

  async function stop() {
    if (accountSync) await accountSync.stop();
    return supervisor.stop();
  }

  // Go 自身的 /readyz（有无可用账号）只在按需查询时读取，避免 Node /readyz 之外的常驻轮询。
  async function probeGoReadyz() {
    const status = supervisor.status();
    if (status.state !== 'ready' || !status.endpoint) return { ready: false, error: 'go_core_not_serving' };
    const fetchImpl = deps.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(deps.readyzTimeoutMs) || 1500);
    try {
      const response = await fetchImpl(`${status.endpoint}/readyz`, { signal: controller.signal });
      const body = typeof response.json === 'function' ? await response.json().catch(() => null) : null;
      return { ready: Boolean(response.ok && body && body.ready === true), error: response.ok ? '' : `http_${response.status}` };
    } catch (error) {
      return { ready: false, error: error && error.name === 'AbortError' ? 'go_core_readyz_timeout' : 'go_core_readyz_unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Node /readyz 汇合的 Go 视图：进程、首轮同步、Go /readyz.ready、已划转路由。
   * 有路由划给 Go 时，只要转发不可用或 Go 不 ready，整体就必须报告 not ready（失败关闭）。
   */
  async function readiness() {
    const status = supervisor.status();
    const routes = [...ownership.entryIds].sort();
    const base = {
      enabled: settings.enabled,
      state: status.state,
      pid: status.pid,
      error: status.error,
      accounts_synced: accountsSynced,
      routes,
      config_errors: ownership.errors
    };
    if (!settings.enabled) {
      return { ...base, go_ready: false, forwarding: false, ready: routes.length === 0 && ownership.errors.length === 0 };
    }
    const probe = await probeGoReadyz();
    const forwarding = getTarget() !== null;
    return {
      ...base,
      go_ready: probe.ready,
      go_readyz_error: probe.error,
      forwarding,
      ready: ownership.errors.length === 0 && (routes.length === 0 || (forwarding && probe.ready))
    };
  }

  return {
    start,
    stop,
    readiness,
    status: () => ({
      ...supervisor.status(),
      routes: [...ownership.entryIds].sort(),
      configErrors: ownership.errors,
      accountsSynced,
      accountSync: accountSync ? accountSync.status() : null
    }),
    tryHandleHttp: forwarder.tryHandleHttp,
    tryHandleUpgrade: forwarder.tryHandleUpgrade
  };
}

module.exports = {
  createGoCoreHost,
  resolveGoCoreSettings
};
