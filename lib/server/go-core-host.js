'use strict';

const crypto = require('node:crypto');
const { createGoCoreSupervisor } = require('../cli/services/server/go-core-supervisor');
const { createGoCoreGatewayForwarder } = require('./go-core-gateway-forwarder');
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

  function getTarget() {
    const status = supervisor.status();
    if (status.state !== 'ready' || !status.endpoint) return null;
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
      return status;
    } catch (error) {
      // Go 启动失败不拖垮 Node 宿主；已划给 Go 的路由由 getTarget()=null 失败关闭。
      log.error(`\x1b[31m[aih:go-core]\x1b[0m Go Core start failed: ${error.code || error.message}`);
      return supervisor.status();
    }
  }

  function stop() {
    return supervisor.stop();
  }

  return {
    start,
    stop,
    status: () => ({ ...supervisor.status(), routes: [...ownership.entryIds].sort(), configErrors: ownership.errors }),
    tryHandleHttp: forwarder.tryHandleHttp,
    tryHandleUpgrade: forwarder.tryHandleUpgrade
  };
}

module.exports = {
  createGoCoreHost,
  resolveGoCoreSettings
};
