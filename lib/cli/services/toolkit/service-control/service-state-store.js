'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const DEFAULT_STATE = Object.freeze({
  desired: 'stopped',
  autoStart: true,
  autoRestart: true,
  configPath: '',
  executablePath: '',
  pid: 0,
  startedAt: 0
});

/**
 * AIH 守护服务的持久化状态（每个工具一个 JSON）：
 * 期望状态、随 AIH 启动、自动重启、启动参数与当前 pid。
 * 进程以 detached 方式运行，AIH 重启后依赖这份状态重新接管。
 */
function createServiceStateStore({ aiHomeDir, serviceId, fs = nodeFs, path = nodePath }) {
  const directory = path.join(aiHomeDir, 'toolkit', 'services');
  const statePath = path.join(directory, `${serviceId}.json`);

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return { ...DEFAULT_STATE, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch (_error) {
      return { ...DEFAULT_STATE };
    }
  }

  function write(patch) {
    const next = { ...read(), ...patch };
    fs.mkdirSync(directory, { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, statePath);
    return next;
  }

  return { read, write, statePath, directory };
}

module.exports = {
  DEFAULT_STATE,
  createServiceStateStore
};
