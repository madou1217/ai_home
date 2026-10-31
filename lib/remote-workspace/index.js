'use strict';

// 远程工作区通道的组装入口（Composition Root）。
//
// 一个 Server 进程只持有一个 RemoteWorkspaceService：所有工作区共享同一个连接池，
// 同一台远端（同一条 SSH 连接配置）的所有工作区复用同一组连接。
// 上层（WorkspaceBackend / AI 会话 / 文件面板，见后续阶段）只调用 host(workspace)，
// 不直接接触 ssh2、连接池或方言。

const os = require('node:os');
const crypto = require('node:crypto');
const { readJsonValue } = require('../server/app-state-store');
const { resolveRemoteWorkspaceConfig } = require('./config');
const { createSshConnector } = require('./transport/ssh-connector');
const { ConnectionPool } = require('./transport/connection-pool');
const { HostKeyStore } = require('./transport/host-key-store');
const { resolveTarget } = require('./transport/target-resolver');
const { RemoteHost } = require('./ops/remote-host');
const { RemoteMachine } = require('./ops/remote-machine');
const { EgressRelay } = require('./transport/egress-relay');
const { remoteError } = require('./errors');

class RemoteWorkspaceService {
  /**
   * @param {{fs, aiHomeDir, homeDir?, env?, config?, connector?, timers?, now?}} options
   */
  constructor({ fs, aiHomeDir, homeDir = os.homedir(), env = process.env, config, connector, timers, now } = {}) {
    this.fs = fs;
    this.aiHomeDir = aiHomeDir;
    this.homeDir = homeDir;
    this.env = env;
    this.config = resolveRemoteWorkspaceConfig(config);
    this.hostKeys = new HostKeyStore({ fs, aiHomeDir, now });
    this.pool = new ConnectionPool({
      connector: connector || createSshConnector({ hostKeyStore: this.hostKeys }),
      config: this.config,
      timers,
      now
    });
    this.hosts = new Map(); // workspaceId → { host, fingerprint }
    this.machines = new Map(); // connectionId → { machine, fingerprint }
  }

  loadConnection(connectionId) {
    const connections = readJsonValue(this.fs, this.aiHomeDir, 'ssh_connections');
    const connection = Array.isArray(connections) ? connections.find((item) => item && item.id === connectionId) : null;
    if (!connection) throw remoteError('connection_not_found', 'SSH 连接不存在');
    return connection;
  }

  /** 拿到某台远端机器（按 SSH 连接）的 Facade：toolkit 远端执行目标用。 */
  machine(connectionId) {
    const connection = this.loadConnection(connectionId);
    const fingerprint = connectionFingerprint(connection);
    const cached = this.machines.get(connectionId);
    if (cached && cached.fingerprint === fingerprint) return cached.machine;
    if (cached) this.pool.drop(connectionId); // 认证材料变了：旧连接作废
    const target = resolveTarget(connection, { fs: this.fs, homeDir: this.homeDir, env: this.env });
    const machine = new RemoteMachine({ pool: this.pool, target, config: this.config });
    this.machines.set(connectionId, { machine, fingerprint });
    return machine;
  }

  loadWorkspace(workspaceId) {
    const workspaces = readJsonValue(this.fs, this.aiHomeDir, 'ssh_workspaces');
    const workspace = Array.isArray(workspaces) ? workspaces.find((item) => item && item.id === workspaceId) : null;
    if (!workspace) throw remoteError('workspace_not_found', '远程工作区不存在');
    const connections = readJsonValue(this.fs, this.aiHomeDir, 'ssh_connections');
    const connection = Array.isArray(connections) ? connections.find((item) => item && item.id === workspace.connectionId) : null;
    if (!connection) throw remoteError('connection_not_found', '工作区关联的 SSH 连接已被删除');
    return { workspace, connection };
  }

  /**
   * 拿到某个工作区的远端操作 Facade。连接配置或工作区根目录被编辑后，下次调用自动换新的
   * （连接本身由池按连接 ID 复用，不会因此重建）。
   */
  host(workspaceId) {
    const { workspace, connection } = this.loadWorkspace(workspaceId);
    const fingerprint = JSON.stringify([connectionFingerprint(connection), workspace.remoteRoot]);
    const cached = this.hosts.get(workspaceId);
    if (cached && cached.fingerprint === fingerprint) return cached.host;
    const target = resolveTarget(connection, { fs: this.fs, homeDir: this.homeDir, env: this.env });
    const host = new RemoteHost({ pool: this.pool, target, root: workspace.remoteRoot, config: this.config });
    this.hosts.set(workspaceId, { host, fingerprint });
    return host;
  }

  /**
   * 为一次任务打开出网中继：entryConnectionId 这台机器借 exitConnectionId 那台机器的网络出去。
   * 两端各用一条独立的 relay 车道连接（转发流量不挤占交互 / 重活车道）。
   * @returns {Promise<EgressRelay>} 已 open；用完调用 close()
   */
  async openEgressRelay(entryConnectionId, exitConnectionId) {
    if (entryConnectionId === exitConnectionId) throw remoteError('invalid_egress', '出口机不能是自己');
    const entryTarget = this.machine(entryConnectionId).target;
    const exitTarget = this.machine(exitConnectionId).target;
    const [entry, exit] = await Promise.all([
      this.pool.rawConnection(entryTarget, 'relay'),
      this.pool.rawConnection(exitTarget, 'relay')
    ]);
    const relay = new EgressRelay({ entry, exit });
    await relay.open();
    return relay;
  }

  /** 连接被删除 / 编辑 / 需要重新信任指纹时，关掉该连接上的全部通道。 */
  dropConnection(connectionId) {
    this.pool.drop(connectionId);
    for (const [id, entry] of this.hosts) {
      if (entry.host.target.id === connectionId) this.hosts.delete(id);
    }
    this.machines.delete(connectionId);
  }

  close() {
    this.pool.closeAll();
    this.hosts.clear();
    this.machines.clear();
  }
}

// 连接被编辑（含换密码 / 换密钥）就是新指纹；凭据只参与摘要，不进缓存键原文。
function connectionFingerprint(connection) {
  const secret = crypto.createHash('sha256').update(String(connection.password || '') + '\0' + String(connection.privateKey || '')).digest('hex');
  return JSON.stringify([connection.host, connection.port, connection.user, connection.authType, connection.identityFile, secret]);
}

// Server 进程内共享一个服务（一个连接池）；按 aiHomeDir 区分（测试 / 多实例互不串）。
const shared = new Map();

function getRemoteWorkspaceService({ fs, aiHomeDir }) {
  const key = String(aiHomeDir || '');
  let service = shared.get(key);
  if (!service) {
    service = new RemoteWorkspaceService({ fs, aiHomeDir });
    shared.set(key, service);
  }
  return service;
}

module.exports = { RemoteWorkspaceService, getRemoteWorkspaceService };
