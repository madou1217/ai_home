'use strict';

// Claude Code 的跨会话消息：本机 UDS + 逐行 JSON。
//
// 每个 claude 会话在 <config>/sessions/<pid>.json 里登记自己（name / cwd /
// sessionId / messagingSocketPath / peerFeatures），收件箱是
// /tmp/cc-socks[-<uid>]/<pid>.sock，token 在 <config>/sessions/<pid>.<sha256(sock)>.key。
// 发送 = 连接 socket，先写一行 {type:"auth",token}，再写一行消息帧。
//
// 协议取证见 docs/providers/claude-cross-session-protocol.md。
// 这里是 aih peer 的 **native 通道实现**；对没有本机通道的 harness，见 tmux-session.js。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

/**
 * 要扫描的配置根。aih 给每个账号一套沙箱环境，各自可能有 CLAUDE_CONFIG_DIR，
 * 所以这里既认环境变量，也认宿主 ~/.claude，去重后返回。
 */
function claudeConfigDirs(env = process.env) {
  const dirs = [];
  const explicit = String(env.CLAUDE_CONFIG_DIR || '').trim();
  if (explicit) dirs.push(explicit);
  const home = String(env.HOME || env.USERPROFILE || os.homedir()).trim();
  if (home) dirs.push(path.join(home, '.claude'));
  return [...new Set(dirs)];
}

function claudeConfigDir(env = process.env) {
  return claudeConfigDirs(env)[0];
}

function sessionsDir(configDir) {
  return path.join(configDir, 'sessions');
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

// 收件箱是否还活着：连一下再断开（claude 自己的存活探测也是这么做的）。
// 不拿 procStart 做字符串比较——它受 locale/TZ 影响（同一进程可能被写成
// "Sun Nov  1 14:04:03 2026" 或 "日 11月/ 1 22:04:03 2026"），比错就会漏掉活会话。
function probeSocket(socketPath, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', (error) => done(Boolean(error && error.code === 'EBUSY')));
  });
}

function readPeerRecords(configDir) {
  const dir = sessionsDir(configDir);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_error) { return []; }
  const peers = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_error) { continue; }
    if (!record || !record.messagingSocketPath) continue;
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || !isProcessAlive(pid)) continue;
    peers.push({
      pid,
      name: record.name || '',
      sessionId: record.sessionId || '',
      cwd: record.cwd || '',
      socket: record.messagingSocketPath,
      status: record.status || '',
      version: record.version || '',
      features: Array.isArray(record.peerFeatures) ? record.peerFeatures : [],
      configDir
    });
  }
  return peers;
}

function listPeersSync(options = {}) {
  const dirs = Array.isArray(options.configDirs) && options.configDirs.length
    ? options.configDirs
    : claudeConfigDirs(options.env);
  const peers = [];
  for (const configDir of dirs) peers.push(...readPeerRecords(configDir));
  return peers.sort((a, b) => a.pid - b.pid);
}

// 带 socket 探测的版本（默认走这个）：pid 活着不代表收件箱还在。
async function listPeers(options = {}) {
  const peers = listPeersSync(options);
  const alive = await Promise.all(peers.map((peer) => probeSocket(peer.socket)));
  return peers.filter((_peer, index) => alive[index]);
}

function keyFileName(pid, socketPath) {
  const digest = crypto.createHash('sha256').update(socketPath).digest('hex');
  return `${pid}.${digest}.key`;
}

/**
 * token 文件在**登记它的那个配置根**里。以前这里从全局环境重算配置根，
 * 多账号（多份 CLAUDE_CONFIG_DIR）时会去错目录找 key。
 */
function peerKeyPath(pid, socketPath, options = {}) {
  const configDir = options.configDir || claudeConfigDir(options.env);
  return path.join(sessionsDir(configDir), keyFileName(pid, socketPath));
}

function readPeerToken(peer, options = {}) {
  const candidates = [];
  if (peer && peer.configDir) candidates.push(peer.configDir);
  candidates.push(...claudeConfigDirs(options.env));
  const fileName = keyFileName(peer.pid, peer.socket);
  for (const configDir of [...new Set(candidates)]) {
    const keyPath = path.join(sessionsDir(configDir), fileName);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8')); } catch (_error) { continue; }
    const token = String(parsed && parsed.peerToken || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(token)) continue;
    return token;
  }
  throw new Error(`no peerToken for pid ${peer && peer.pid} (looked in ${[...new Set(candidates)].join(', ')})`);
}

function findByTarget(peers, target) {
  const wanted = String(target || '').trim();
  if (!wanted) return null;
  return peers.find((peer) => String(peer.pid) === wanted)
    || peers.find((peer) => peer.name === wanted)
    || peers.find((peer) => peer.sessionId === wanted)
    || null;
}

function envelope(body, options = {}) {
  const attrs = [];
  const from = String(options.fromAddress || '').trim();
  if (from) attrs.push(`from="${from}"`);
  if (options.fromName) attrs.push(`from-name="${String(options.fromName).replace(/["<>]/g, '')}"`);
  // from-mode 决定收件方是「直接投递」还是「挂起等批准」：收件方 bypass 时就写 bypass。
  if (options.mode) attrs.push(`from-mode="${String(options.mode).replace(/["<>]/g, '')}"`);
  const head = attrs.length ? `<cross-session-message ${attrs.join(' ')}>` : '<cross-session-message>';
  return `${head}\n${String(body).replace(/\r\n/g, '\n')}\n</cross-session-message>`;
}

function buildFrames(peer, body, options = {}) {
  // token 可注入（测试/dry-run 用），否则从收件方的 key 文件读。
  const token = String(options.token || '').trim() || readPeerToken(peer, options);
  const fromAddress = String(options.fromAddress || '').trim();
  const message = {
    msgV: 1,
    msg_id: 'cc-msg-' + crypto.randomBytes(16).toString('hex'),
    type: 'user',
    message: {
      role: 'user',
      content: envelope(body, { ...options, fromAddress })
    },
    priority: 'next',
    ...(fromAddress ? { from: fromAddress } : {})
  };
  return {
    auth: JSON.stringify({ type: 'auth', token }) + '\n',
    control: JSON.stringify(message) + '\n',
    message
  };
}

function sendToPeer(peer, body, options = {}) {
  const frames = buildFrames(peer, body, options);
  if (options.dryRun) return Promise.resolve({ ok: true, dryRun: true, frames });
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: peer.socket });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out connecting to peer inbox'));
    }, Number(options.timeoutMs) || 5000);
    socket.on('connect', () => {
      socket.write(frames.auth);
      socket.write(frames.control);
      // macOS 上 UDS 半关闭不可靠，claude 自己也只等 150ms 再 end。
      setTimeout(() => {
        clearTimeout(timer);
        socket.end();
        resolve({ ok: true, msgId: frames.message.msg_id });
      }, 150);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

module.exports = {
  id: 'claude',
  channel: 'native',
  claudeConfigDir,
  claudeConfigDirs,
  sessionsDir,
  isProcessAlive,
  probeSocket,
  peerKeyPath,
  readPeerToken,
  listPeersSync,
  listPeers,
  findByTarget,
  envelope,
  buildFrames,
  sendToPeer
};
