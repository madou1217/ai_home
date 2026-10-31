'use strict';

// toolkit 执行目标（Strategy）：同一套 toolkit（工具目录、安装计划、作业队列、确认门）作用于
//   - local：AIH Server 所在机器（原有行为，本机子进程）；
//   - ssh:<connectionId>：「SSH 开发机」里的一台远端机器（零安装，经远程工作区通道执行）。
//
// 每个目标提供同形能力：
//   key            目标标识（作业去重 / 缓存分区用）
//   describe()     { kind, id, label, platform, arch, os }
//   probeOptions() 交给 probe / resource-manager / lifecycle 的 options（平台、家目录、fs、execCommandAsync）
//   runPlan(plan, {onOutput}) 执行一个生命周期计划，返回 executeLifecyclePlan 同形结果
//
// 「Server 管理」里的其他 AIH Server 不走这里：它们由 webui-server-proxy 整体转发，在对端是 local。

const { readJsonValue } = require('./app-state-store');
const { executeEnvironmentPlan } = require('../cli/services/toolkit/environment/plan-executor');
const { createRemoteProbeOptions } = require('../cli/services/toolkit/environment/remote-probe');
const { executeRemotePlan } = require('../cli/services/toolkit/environment/remote-plan-executor');

const LOCAL_TARGET_KEY = 'local';
const SSH_PREFIX = 'ssh:';
const CONNECTION_ID = /^conn_[a-f0-9]{16}$/;

class ToolkitTargetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseTargetKey(raw) {
  const value = String(raw || '').trim();
  if (!value || value === LOCAL_TARGET_KEY) return { kind: 'local' };
  if (value.startsWith(SSH_PREFIX)) {
    const connectionId = value.slice(SSH_PREFIX.length);
    if (CONNECTION_ID.test(connectionId)) return { kind: 'ssh', connectionId };
  }
  throw new ToolkitTargetError('invalid_toolkit_target', '执行目标无效（local 或 ssh:<连接 ID>）');
}

function createLocalTarget(baseOptions) {
  return {
    key: LOCAL_TARGET_KEY,
    kind: 'local',
    describe: () => ({ kind: 'local', id: LOCAL_TARGET_KEY, label: '本机（AIH Server）' }),
    probeOptions: async () => baseOptions,
    runPlan: (plan, extra = {}) => executeEnvironmentPlan(plan, { ...baseOptions, ...extra })
  };
}

function remoteFailure(error) {
  const code = String(error && error.code || '');
  if (code === 'connection_not_found') return new ToolkitTargetError(code, 'SSH 连接不存在', 404);
  if (code === 'unsupported_platform' || code === 'unsupported_remote') return new ToolkitTargetError('unsupported_platform', error.message, 400);
  if (code === 'auth_failed' || code === 'host_key_mismatch') return new ToolkitTargetError(code, error.message, 502);
  return new ToolkitTargetError('remote_unreachable', `远端不可达：${error && error.message || code}`, 502);
}

function createSshTarget({ connectionId, connection, machine, service }) {
  const egressId = String(connection.egressConnectionId || '').trim();
  let probeOptionsPromise = null;
  const target = {
    key: `${SSH_PREFIX}${connectionId}`,
    kind: 'ssh',
    connectionId,
    async describe() {
      const facts = await machine.profile();
      return {
        kind: 'ssh',
        id: target.key,
        label: connection.label || connection.host,
        host: connection.host,
        platform: facts.platform,
        arch: facts.arch,
        os: facts.os,
        ...(egressId ? { egress: egressId } : {})
      };
    },
    /**
     * 远端探测上下文。同一个目标对象只在一次请求 / 一个作业内复用（目录快照是那一刻的状态），
     * 跨请求每次重新取（连接本身由池复用，不重新握手）。
     */
    probeOptions() {
      if (!probeOptionsPromise) {
        probeOptionsPromise = createRemoteProbeOptions(machine).catch((error) => {
          probeOptionsPromise = null;
          throw remoteFailure(error);
        });
      }
      return probeOptionsPromise;
    },
    /**
     * 执行计划。连接配置了出网代理时，本次任务期间打开出网中继（入口机回环端口 → 出口机网络），
     * 代理变量只注入这个计划的环境，任务结束即撤销转发。
     */
    async runPlan(plan, extra = {}) {
      const options = await target.probeOptions();
      if (!egressId) return executeRemotePlan(plan, { machine, platform: options.platform, onOutput: extra.onOutput });
      let relay;
      try {
        relay = await service.openEgressRelay(connectionId, egressId);
      } catch (error) {
        return {
          ok: false,
          error: 'environment_action_spawn_failed',
          message: `出网代理不可用：${error && error.message || error}`,
          stdout: '',
          stderr: '',
          outputTruncated: false
        };
      }
      try {
        extra.onOutput?.(`[aih] 经出网代理执行（入口 127.0.0.1:${relay.port}）\n`, 'stderr');
        return await executeRemotePlan({ ...plan, env: { ...(plan.env || {}), ...relay.proxyEnv() } },
          { machine, platform: options.platform, onOutput: extra.onOutput });
      } finally {
        relay.close();
      }
    },
    /** 作业校验要看安装后的新状态：丢弃旧快照。 */
    refresh() {
      probeOptionsPromise = null;
    }
  };
  return target;
}

/**
 * 按请求解析执行目标。
 * @param {string} rawKey 'local' | 'ssh:<connectionId>'（缺省 local）
 * @param {{fs, aiHomeDir, baseOptions, remoteService?}} deps
 */
function resolveToolkitTarget(rawKey, { fs, aiHomeDir, baseOptions, remoteService }) {
  const parsed = parseTargetKey(rawKey);
  if (parsed.kind === 'local') return createLocalTarget(baseOptions);
  const connections = readJsonValue(fs, aiHomeDir, 'ssh_connections');
  const connection = Array.isArray(connections) ? connections.find((item) => item && item.id === parsed.connectionId) : null;
  if (!connection) throw new ToolkitTargetError('connection_not_found', 'SSH 连接不存在', 404);
  const service = remoteService || require('../remote-workspace').getRemoteWorkspaceService({ fs, aiHomeDir });
  let machine;
  try {
    machine = service.machine(parsed.connectionId);
  } catch (error) {
    throw remoteFailure(error);
  }
  return createSshTarget({ connectionId: parsed.connectionId, connection, machine, service });
}

/** 可选目标清单（本机 + 所有 SSH 连接），不触发任何远端连接。 */
function listToolkitTargets({ fs, aiHomeDir }) {
  const connections = readJsonValue(fs, aiHomeDir, 'ssh_connections');
  return [
    { kind: 'local', id: LOCAL_TARGET_KEY, label: '本机（AIH Server）' },
    ...(Array.isArray(connections) ? connections : [])
      .filter((item) => item && CONNECTION_ID.test(String(item.id || '')))
      .map((item) => ({
        kind: 'ssh',
        id: `${SSH_PREFIX}${item.id}`,
        label: item.label || item.host,
        host: item.user ? `${item.user}@${item.host}` : item.host
      }))
  ];
}

module.exports = {
  LOCAL_TARGET_KEY,
  ToolkitTargetError,
  listToolkitTargets,
  parseTargetKey,
  resolveToolkitTarget
};
