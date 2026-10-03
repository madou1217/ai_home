'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolveAihLogPath } = require('../../../../runtime/aih-storage-layout');
const { entryDirectlyRunsRole, readProcessEntries } = require('../host-runtime-discovery');
const { extractConfigPath } = require('../network-tool-discovery');
const { createDetachedProcessSupervisor } = require('./detached-process-supervisor');
const { createServiceStateStore } = require('./service-state-store');

const supervisors = new Map();

function samePath(left, right, platform) {
  const normalize = (value) => {
    const text = nodePath.resolve(String(value || ''));
    return platform === 'win32' ? text.toLowerCase() : text;
  };
  return Boolean(left && right) && normalize(left) === normalize(right);
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/** 该 PID 是否仍是本服务的进程：可执行名匹配角色，且配置路径与记录一致。 */
function createOwnershipCheck(spec, options = {}) {
  const isAlive = options.isAlive || defaultIsAlive;
  const platform = (options.processObj || process).platform;
  return (pid, state = {}) => {
    if (!isAlive(pid)) return false;
    const entry = readProcessEntries(options).find((candidate) => Number(candidate.pid) === Number(pid));
    if (!entry || !entryDirectlyRunsRole(entry, spec.processRole, nodePath)) return false;
    if (!state.configPath) return true;
    return samePath(extractConfigPath(entry, { ...options, role: spec.processRole }), state.configPath, platform);
  };
}

/** 同一 aiHomeDir + 服务只有一个守护实例（服务端进程内单例）。 */
function getSupervisor(spec, options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const key = `${aiHomeDir}\0${spec.id}`;
  if (supervisors.has(key)) return supervisors.get(key);
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const supervisor = createDetachedProcessSupervisor({
    fs,
    path,
    spawn: options.spawn,
    isAlive: options.isAlive,
    isOwnedProcess: options.isOwnedProcess || createOwnershipCheck(spec, options),
    kill: options.kill,
    stateStore: createServiceStateStore({ aiHomeDir, serviceId: spec.id, fs, path }),
    logFile: resolveAihLogPath(aiHomeDir, `toolkit-${spec.id}.log`)
  });
  supervisors.set(key, supervisor);
  return supervisor;
}

function resetSupervisorsForTest() {
  for (const supervisor of supervisors.values()) supervisor.dispose();
  supervisors.clear();
}

/**
 * AIH 自带守护后端（全平台）：用于非 Homebrew 管理的二进制（AIH 自管或外部安装）。
 * 启动前做冲突守卫：已有其它进程使用同一份配置时拒绝启动，避免同名代理互相顶号。
 */
function createAihSupervisorBackend(spec, options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const platform = (options.processObj || process).platform;

  function supervisor() {
    return getSupervisor(spec, options);
  }

  function stateStore() {
    return createServiceStateStore({ aiHomeDir, serviceId: spec.id, fs, path: options.path || nodePath });
  }

  function resolveConfigPath(tool) {
    const stored = String(stateStore().read().configPath || '').trim();
    return stored || String(tool && tool.resolvedConfigPath || '').trim() || spec.defaultConfigPath(options);
  }

  function conflictingProcess(configPath, ownPid) {
    const entries = readProcessEntries(options);
    return entries.find((entry) => {
      // 只看真正的 frpc 进程；shell 包装进程（argv 里提到 frpc）不算冲突。
      if (!entryDirectlyRunsRole(entry, spec.processRole, nodePath)) return false;
      if (Number(entry.pid) === Number(ownPid)) return false;
      const entryConfig = extractConfigPath(entry, { ...options, role: spec.processRole });
      return !entryConfig || samePath(entryConfig, configPath, platform);
    }) || null;
  }

  function describe(tool) {
    if (!aiHomeDir) {
      return { backend: 'aih', backendLabel: 'AIH 守护', controllable: false, state: 'unknown', message: '缺少 AIH 数据目录' };
    }
    const status = supervisor().status();
    const configPath = resolveConfigPath(tool);
    let configExists = false;
    try { configExists = fs.existsSync(configPath); } catch (_error) {}
    const running = status.phase === 'running';
    const external = !running && tool && tool.running;
    return {
      backend: 'aih',
      backendLabel: 'AIH 守护',
      controllable: Boolean(tool && tool.installed),
      state: running ? 'running' : status.phase === 'backoff' ? 'backoff' : (external ? 'external' : 'stopped'),
      pid: status.pid,
      startedAt: status.startedAt,
      restarts: status.restarts,
      consecutiveFailures: status.consecutiveFailures,
      nextRestartAt: status.nextRestartAt,
      lastExit: status.lastExit,
      lastError: status.lastError,
      autoStart: status.autoStart,
      autoRestart: status.autoRestart,
      settingsEditable: true,
      settingsNote: '进程独立于 AIH 运行；AIH 重启后接管或按「随 AIH 启动」恢复，异常退出按退避自动重启',
      configReady: configExists,
      canCreateConfig: !configExists,
      logAvailable: true,
      message: external ? '检测到不受 AIH 守护的 frpc 进程（如 systemd / Windows 服务）正在运行，需先在原管理方式中停止' : '',
      canStart: Boolean(tool && tool.installed) && !running && !external && status.phase !== 'backoff' && configExists,
      canStop: running || status.phase === 'backoff',
      canRestart: running
    };
  }

  function launchSpec(tool, configPath) {
    return {
      command: String(tool.executablePath || '').trim(),
      args: spec.launchArgs(configPath),
      cwd: nodePath.dirname(configPath)
    };
  }

  async function control(action, tool) {
    if (!aiHomeDir) return { ok: false, error: 'service_backend_unavailable', message: '缺少 AIH 数据目录。' };
    if (action === 'stop') return supervisor().stop();
    if (!tool || !tool.installed || !tool.executablePath) {
      return { ok: false, error: 'managed_tool_not_installed', message: `${spec.name} 尚未安装。` };
    }
    const configPath = resolveConfigPath(tool);
    if (!fs.existsSync(configPath)) {
      return { ok: false, error: 'service_config_missing', message: '配置文件不存在，请先新建并编辑配置。' };
    }
    const ownPid = supervisor().status().pid;
    const conflict = conflictingProcess(configPath, ownPid);
    if (conflict) {
      return {
        ok: false,
        error: 'service_conflict_external_instance',
        message: `已有 ${spec.name} 进程（pid ${conflict.pid}）在使用同一份配置，请先停止它再由 AIH 守护。`
      };
    }
    stateStore().write({ configPath, executablePath: tool.executablePath });
    const launch = launchSpec(tool, configPath);
    return action === 'restart' ? supervisor().restart(launch) : supervisor().start(launch);
  }

  function updateSettings(patch) {
    if (!aiHomeDir) return { ok: false, error: 'service_backend_unavailable', message: '缺少 AIH 数据目录。' };
    supervisor().updateSettings(patch);
    return { ok: true };
  }

  function createConfig(tool) {
    const configPath = resolveConfigPath(tool);
    if (fs.existsSync(configPath)) {
      return { ok: false, error: 'service_config_exists', message: '配置文件已存在。' };
    }
    fs.mkdirSync(nodePath.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, spec.configTemplate, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    stateStore().write({ configPath });
    return { ok: true, configName: nodePath.basename(configPath) };
  }

  return {
    id: 'aih',
    adopt: () => supervisor().adopt(),
    control,
    createConfig,
    describe,
    logFiles: () => [resolveAihLogPath(aiHomeDir, `toolkit-${spec.id}.log`)],
    updateSettings
  };
}

module.exports = {
  createAihSupervisorBackend,
  resetSupervisorsForTest
};
