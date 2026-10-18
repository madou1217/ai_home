'use strict';

// 出口池的跨进程运行文件：`<aiHomeDir>/run/egress-pool/state.json`（目录 0700、文件 0600）。
//
// 为什么需要它：池只在 server 进程里运行，进程内单例（egress-pool-registry）在用户自己启动的
// `aih <cli> <id>` 进程里是空的。CLI 不能直接假设固定回环端口 —— 它分不清那是 server 的内核、
// 上次崩溃留下的孤儿，还是别的程序。因此由 server 在池就绪时写下这份文件，CLI 只在
// 「写文件的 server 进程仍存活 + 文件里登记的内核进程仍存活」时才采用其中的地址；任何一条
// 不满足都按未就绪 fail-closed。
//
// 同一份文件也让下一次启动能认出并回收**自己**的孤儿内核（见 egress-pool-runtime 的
// reapOwnOrphan）：文件里的控制端口密钥只有写它的 server 知道（与 config.json 同权限、同目录），
// 用它在控制端口上验明正身后才会结束那个进程，绝不误杀别人的进程。
//
// 文件不含节点凭据，只有：ownerPid / corePid / proxyUrl / controllerPort / secret / startedAt。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const STATE_FILE_VERSION = 1;

function egressPoolWorkDir(aiHomeDir, pathImpl = nodePath) {
  return pathImpl.join(String(aiHomeDir || ''), 'run', 'egress-pool');
}

function egressPoolStateFilePath(aiHomeDir, pathImpl = nodePath) {
  return pathImpl.join(egressPoolWorkDir(aiHomeDir, pathImpl), 'state.json');
}

function toPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/** 进程是否存活：signal 0 只做权限/存在检查；EPERM 表示进程存在但属于别的用户。 */
function isPidAlive(pid, processObj = process) {
  const target = toPid(pid);
  if (!target) return false;
  try {
    processObj.kill(target, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/** 只接受回环 HTTP 地址：文件被篡改成外部地址时绝不当作出口。 */
function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port);
  } catch (_error) {
    return false;
  }
}

/** 读文件并做形状校验；不存在/损坏返回 null。永不抛。 */
function readEgressPoolState(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir || typeof fs.readFileSync !== 'function') return null;
  let parsed;
  try {
    parsed = JSON.parse(String(fs.readFileSync(egressPoolStateFilePath(aiHomeDir, options.path), 'utf8')));
  } catch (_error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_FILE_VERSION) return null;
  const state = {
    ownerPid: toPid(parsed.ownerPid),
    corePid: toPid(parsed.corePid),
    proxyUrl: String(parsed.proxyUrl || ''),
    controllerPort: Number(parsed.controllerPort) || 0,
    secret: String(parsed.secret || ''),
    startedAt: Number(parsed.startedAt) || 0
  };
  if (!state.ownerPid || !state.corePid || !isLoopbackHttpUrl(state.proxyUrl)) return null;
  return state;
}

/**
 * CLI 侧的读取口：只有 owner（server）与 core 两个进程都存活时返回状态，否则返回
 * `{ state: null, reason }`。reason 用于告诉用户为什么不可用（而不是笼统地怪池子）。
 */
function readLiveEgressPoolState(options = {}) {
  const processObj = options.processObj || process;
  const alive = typeof options.isPidAlive === 'function'
    ? options.isPidAlive
    : (pid) => isPidAlive(pid, processObj);
  const state = readEgressPoolState(options);
  if (!state) return { state: null, reason: 'egress_pool_server_not_running' };
  if (!alive(state.ownerPid)) return { state: null, reason: 'egress_pool_server_not_running' };
  if (!alive(state.corePid)) return { state: null, reason: 'egress_pool_core_exited' };
  return { state, reason: '' };
}

/** server 侧写入（池就绪时）。失败只返回 false，不影响池本身。 */
function writeEgressPoolState(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir || typeof fs.writeFileSync !== 'function') return false;
  const filePath = egressPoolStateFilePath(aiHomeDir, options.path);
  const payload = {
    version: STATE_FILE_VERSION,
    ownerPid: toPid(options.ownerPid),
    corePid: toPid(options.corePid),
    proxyUrl: String(options.proxyUrl || ''),
    controllerPort: Number(options.controllerPort) || 0,
    secret: String(options.secret || ''),
    startedAt: Number(options.startedAt) || Date.now()
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload), { mode: 0o600 });
    if (typeof fs.chmodSync === 'function') fs.chmodSync(filePath, 0o600);
    return true;
  } catch (_error) {
    return false;
  }
}

/** 删除运行文件（池停止/启动失败/孤儿已回收）。幂等、永不抛。 */
function removeEgressPoolState(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return;
  const filePath = egressPoolStateFilePath(aiHomeDir, options.path);
  try {
    if (typeof fs.rmSync === 'function') fs.rmSync(filePath, { force: true });
    else if (typeof fs.unlinkSync === 'function') fs.unlinkSync(filePath);
  } catch (_error) {
    /* best effort */
  }
}

module.exports = {
  STATE_FILE_VERSION,
  egressPoolStateFilePath,
  egressPoolWorkDir,
  isLoopbackHttpUrl,
  isPidAlive,
  readEgressPoolState,
  readLiveEgressPoolState,
  removeEgressPoolState,
  writeEgressPoolState
};
