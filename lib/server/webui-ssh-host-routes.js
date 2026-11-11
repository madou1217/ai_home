'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { readJsonValue, writeJsonValue } = require('./app-state-store');
const { probeSshTarget } = require('./ssh-host-probe');
const {
  KEY_FILE_AUTH_TYPE,
  SshIdentityFileError,
  resolveIdentityFilePath
} = require('./ssh-identity-file');
const { buildRemoteShellCommand, remoteSessionKey, removeCredentialFiles } = require('./ssh-remote-shell');
const { browseRemoteDirectories } = require('./ssh-host-browse');

// 密码掩码常量
const PASSWORD_MASK = '******';
const SSH_AUTH_TYPES = new Set(['agent', 'key', KEY_FILE_AUTH_TYPE, 'password']);

const IDENTITY_FILE_ERROR_MESSAGES = Object.freeze({
  identity_file_required: 'SSH identity file path is required.',
  identity_file_must_be_absolute: 'SSH identity file path must be absolute or start with ~/.',
  identity_file_outside_ssh_dir: 'SSH identity file must be inside the current server user SSH directory.',
  identity_file_not_found: 'SSH identity file was not found.',
  identity_file_not_regular_file: 'SSH identity file must be a regular file.',
  identity_file_permissions_too_open: 'SSH identity file permissions must not allow group or other access.'
});

function writeIdentityFileError(res, writeJson, error) {
  if (!(error instanceof SshIdentityFileError)) return false;
  writeJson(res, 400, {
    ok: false,
    error: 'invalid_identity_file',
    reason: error.code,
    message: IDENTITY_FILE_ERROR_MESSAGES[error.code] || 'SSH identity file is invalid.'
  });
  return true;
}

function clearInactiveCredentials(connection) {
  const authType = String(connection.authType || 'agent').trim();
  if (authType !== 'password') connection.password = '';
  if (authType !== 'key') connection.privateKey = '';
  if (authType !== KEY_FILE_AUTH_TYPE) connection.identityFile = '';
  return connection;
}

// ------------------------------------------
// DB 辅助操作函数
// ------------------------------------------
// 连接被编辑 / 删除：关掉远程工作区通道池里该连接的全部长连接（下次按新配置重建）。
function dropPooledConnection(fsImpl, aiHomeDir, connectionId) {
  try {
    require('../remote-workspace').getRemoteWorkspaceService({ fs: fsImpl, aiHomeDir }).dropConnection(connectionId);
  } catch (_error) { /* 池未初始化等：无需处理 */ }
}

// 出网代理（借另一台 SSH 连接的网络出去，见 remote-workspace/transport/egress-relay）。
// 只能指向另一条已存在的连接；空值表示直连。
function normalizeEgressConnectionId(value, selfId, list) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (id === selfId) throw Object.assign(new Error('出网代理不能是这条连接自己'), { code: 'invalid_egress' });
  if (!list.some((item) => item.id === id)) throw Object.assign(new Error('出网代理指向的连接不存在'), { code: 'invalid_egress' });
  return id;
}

// 反向隧道（C2，见 remote-workspace/transport/reverse-tunnel）：远端 127.0.0.1:remotePort → 本机 sshd。
// 空 / remotePort 为 0 表示关闭。
function normalizeReverseTunnel(value) {
  if (!value || typeof value !== 'object') return null;
  const remotePort = Number(value.remotePort) || 0;
  if (!remotePort) return null;
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
    throw Object.assign(new Error('反向隧道端口必须在 1024–65535'), { code: 'invalid_reverse_tunnel' });
  }
  const localPort = Number(value.localPort) || 22;
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw Object.assign(new Error('本机 SSH 端口无效'), { code: 'invalid_reverse_tunnel' });
  }
  return { remotePort, localPort };
}

// 隧道与连接配置对齐：反向隧道已切 Go，Node 只触发 reconcile 并读状态。
async function reconcileReverseTunnels(goHost) {
  if (!goHost || typeof goHost.reconcileSshReverseTunnels !== 'function') return [];
  try {
    const response = await goHost.reconcileSshReverseTunnels();
    return response && response.ok && response.data && Array.isArray(response.data.tunnels)
      ? response.data.tunnels : [];
  } catch (_error) {
    return [];
  }
}

function getConnections(fsImpl, aiHomeDir) {
  const data = readJsonValue(fsImpl, aiHomeDir, 'ssh_connections');
  return Array.isArray(data) ? data : [];
}

function saveConnections(fsImpl, aiHomeDir, connections) {
  writeJsonValue(fsImpl, aiHomeDir, 'ssh_connections', connections);
}

function getWorkspaces(fsImpl, aiHomeDir) {
  const data = readJsonValue(fsImpl, aiHomeDir, 'ssh_workspaces');
  return Array.isArray(data) ? data : [];
}

function saveWorkspaces(fsImpl, aiHomeDir, workspaces) {
  writeJsonValue(fsImpl, aiHomeDir, 'ssh_workspaces', workspaces);
}

// 脱敏函数
function sanitizeConnection(conn) {
  const copy = { ...conn };
  copy.password = conn.password ? PASSWORD_MASK : '';
  copy.privateKey = conn.privateKey ? PASSWORD_MASK : '';
  return copy;
}

// ------------------------------------------
// SSH 命令行工具安全包装函数
// ------------------------------------------
function runProcess(command, args, options = {}) {
  const spawn = options.spawnImpl || require('node:child_process').spawn;
  const timeoutMs = options.timeoutMs || 5000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timer = null;

    if (child.stdout) {
      child.stdout.on('data', (data) => { stdout += data.toString(); });
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => { stderr += data.toString(); });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_e) {}
        reject(new Error('SSH command execution timed out.'));
      }, timeoutMs);
    }

    child.on('close', (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// 安全物理擦除文件（覆盖 -> 删除）
function wipeFileAndRemove(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      // 写入全零的字节流，擦除磁盘数据
      const zeros = Buffer.alloc(stat.size);
      fs.writeFileSync(filePath, zeros);
    }
    fs.rmSync(filePath, { force: true });
  } catch (_error) {
    // 降级只做删除
    try { fs.rmSync(filePath, { force: true }); } catch (_e) {}
  }
}

// 写入临时 askpass 脚本
function createTemporaryAskPass(password) {
  const tempAskPassPath = path.join(os.tmpdir(), `aih-ssh-ap-${crypto.randomBytes(8).toString('hex')}`);
  // 写出 askpass 脚本（仅输出密码变量值）
  const content = process.platform === 'win32'
    ? `@echo off\r\necho %SSH_PASSWORD%\r\n`
    : `#!/bin/sh\necho "$SSH_PASSWORD"\n`;

  fs.writeFileSync(tempAskPassPath, content, { mode: 0o700 });
  return tempAskPassPath;
}

// ------------------------------------------
// 路由核心处理逻辑
// ------------------------------------------
async function handleWebUiSshHostRoutes(ctx) {
  const { method, pathname, res, aiHomeDir, deps } = ctx;
  const { fs: fsImpl, readRequestBody, writeJson, spawnImpl, homeDir } = deps;

  // 通用 Body 载荷解析器：对于带载荷的请求，安全解析为 JSON 对象
  let body = {};
  if (method === 'POST' || method === 'PUT') {
    try {
      const bodyBuf = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 });
      if (bodyBuf && bodyBuf.length > 0) {
        body = JSON.parse(bodyBuf.toString('utf8'));
      }
    } catch (_err) {
      body = {};
    }
  }

  // ==========================================
  // 1. SSH Connections 物理连接接口
  // ==========================================

  // 1.1 获取列表：GET 固定读 Go（脱敏在 Go 侧完成），Node 不再本地展开。
  if (method === 'GET' && pathname === '/v0/webui/ssh-connections') {
    const goHost = deps && deps.goCoreSync;
    if (!goHost || typeof goHost.getSshConnections !== 'function') {
      writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，SSH 连接不可读' });
      return true;
    }
    let response = null;
    try {
      response = await goHost.getSshConnections();
    } catch (_error) {
      response = null;
    }
    if (response && response.ok === true && response.data) {
      writeJson(res, 200, response.data);
      return true;
    }
    writeJson(res, 503, {
      ok: false,
      error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
      message: 'Go Core 未就绪，SSH 连接不可读'
    });
    return true;
  }

  // 1.1b 反向隧道状态：Go 是唯一运行态。
  if (method === 'GET' && pathname === '/v0/webui/ssh-connections/tunnels') {
    const goHost = deps && deps.goCoreSync;
    if (!goHost || typeof goHost.getSshReverseTunnels !== 'function') {
      writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，反向隧道状态不可读' });
      return true;
    }
    const response = await goHost.getSshReverseTunnels().catch(() => null);
    if (response && response.ok && response.data) {
      writeJson(res, 200, response.data);
      return true;
    }
    writeJson(res, 503, {
      ok: false,
      error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
      message: 'Go Core 未就绪，反向隧道状态不可读'
    });
    return true;
  }

  // 1.2 新增连接
  if (method === 'POST' && pathname === '/v0/webui/ssh-connections') {
    try {
      const label = String(body.label || '').trim();
      const host = String(body.host || '').trim();
      const port = Number(body.port) || 22;
      const user = String(body.user || '').trim();
      const authType = String(body.authType || 'agent').trim();
      const password = String(body.password || '').trim();
      const privateKey = String(body.privateKey || '').trim();
      const identityFile = String(body.identityFile || '').trim();

      if (!label || !host) {
        writeJson(res, 400, { ok: false, error: 'missing_fields', message: 'Label and Host are required.' });
        return true;
      }
      if (!SSH_AUTH_TYPES.has(authType)) {
        writeJson(res, 400, { ok: false, error: 'invalid_auth_type', message: 'Unsupported SSH authentication type.' });
        return true;
      }
      if (authType === KEY_FILE_AUTH_TYPE) {
        resolveIdentityFilePath(identityFile, { fs: fsImpl, homeDir });
      }

      const list = getConnections(fsImpl, aiHomeDir);
      const newId = 'conn_' + crypto.randomBytes(8).toString('hex');
      let egressConnectionId;
      let reverseTunnel;
      try {
        egressConnectionId = normalizeEgressConnectionId(body.egressConnectionId, newId, list);
        reverseTunnel = normalizeReverseTunnel(body.reverseTunnel);
      } catch (error) {
        writeJson(res, 400, { ok: false, error: error.code, message: error.message });
        return true;
      }
      const newConn = clearInactiveCredentials({
        id: newId,
        egressConnectionId,
        ...(reverseTunnel ? { reverseTunnel } : {}),
        label,
        host,
        port,
        user,
        authType,
        password: password === PASSWORD_MASK ? '' : password,
        privateKey: privateKey === PASSWORD_MASK ? '' : privateKey,
        identityFile,
        createdAt: Date.now()
      });

      list.push(newConn);
      saveConnections(fsImpl, aiHomeDir, list);
      if (newConn.reverseTunnel) await reconcileReverseTunnels(deps && deps.goCoreSync);

      writeJson(res, 200, { ok: true, connection: sanitizeConnection(newConn) });
    } catch (err) {
      if (!writeIdentityFileError(res, writeJson, err)) {
        writeJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
      }
    }
    return true;
  }

  // 1.3 编辑连接
  if (method === 'PUT' && pathname.startsWith('/v0/webui/ssh-connections/')) {
    const segments = pathname.split('/');
    const id = segments[segments.length - 1];

    if (!id || id === 'test') return false;

    try {
      const list = getConnections(fsImpl, aiHomeDir);
      const index = list.findIndex(c => c.id === id);

      if (index === -1) {
        writeJson(res, 404, { ok: false, error: 'not_found', message: 'Connection not found.' });
        return true;
      }

      const conn = list[index];
      if (body.label !== undefined) conn.label = String(body.label || '').trim();
      if (body.host !== undefined) conn.host = String(body.host || '').trim();
      if (body.port !== undefined) conn.port = Number(body.port) || 22;
      if (body.user !== undefined) conn.user = String(body.user || '').trim();
      if (body.authType !== undefined) conn.authType = String(body.authType || 'agent').trim();

      // 脱敏判断：如果传入的不是遮罩，则修改
      if (body.password !== undefined && body.password !== PASSWORD_MASK) {
        conn.password = String(body.password || '').trim();
      }
      if (body.privateKey !== undefined && body.privateKey !== PASSWORD_MASK) {
        conn.privateKey = String(body.privateKey || '').trim();
      }
      if (body.identityFile !== undefined) {
        conn.identityFile = String(body.identityFile || '').trim();
      }
      if (body.reverseTunnel !== undefined) {
        try {
          const tunnel = normalizeReverseTunnel(body.reverseTunnel);
          if (tunnel) conn.reverseTunnel = tunnel; else delete conn.reverseTunnel;
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.code, message: error.message });
          return true;
        }
      }
      if (body.egressConnectionId !== undefined) {
        try {
          conn.egressConnectionId = normalizeEgressConnectionId(body.egressConnectionId, id, list);
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.code, message: error.message });
          return true;
        }
      }

      if (!conn.label || !conn.host) {
        writeJson(res, 400, { ok: false, error: 'invalid_fields', message: 'Label and Host cannot be empty.' });
        return true;
      }
      if (!SSH_AUTH_TYPES.has(conn.authType)) {
        writeJson(res, 400, { ok: false, error: 'invalid_auth_type', message: 'Unsupported SSH authentication type.' });
        return true;
      }
      if (conn.authType === KEY_FILE_AUTH_TYPE) {
        resolveIdentityFilePath(conn.identityFile, { fs: fsImpl, homeDir });
      }
      clearInactiveCredentials(conn);

      list[index] = conn;
      saveConnections(fsImpl, aiHomeDir, list);
      dropPooledConnection(fsImpl, aiHomeDir, id);
      await reconcileReverseTunnels(deps && deps.goCoreSync);

      writeJson(res, 200, { ok: true, connection: sanitizeConnection(conn) });
    } catch (err) {
      if (!writeIdentityFileError(res, writeJson, err)) {
        writeJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
      }
    }
    return true;
  }

  // 1.4 删除连接（级联删除关联的 Workspaces）
  if (method === 'DELETE' && pathname.startsWith('/v0/webui/ssh-connections/')) {
    const segments = pathname.split('/');
    const id = segments[segments.length - 1];

    if (!id) return false;

    try {
      const list = getConnections(fsImpl, aiHomeDir);
      // 以这条连接为出网代理的其他连接：改回直连（不留悬空引用）。
      const nextList = list.filter(c => c.id !== id)
        .map((c) => (c.egressConnectionId === id ? { ...c, egressConnectionId: '' } : c));
      saveConnections(fsImpl, aiHomeDir, nextList);
      dropPooledConnection(fsImpl, aiHomeDir, id);
      await reconcileReverseTunnels(deps && deps.goCoreSync);

      // 级联删除关联的 Workspaces
      const workspaces = getWorkspaces(fsImpl, aiHomeDir);
      const nextWorkspaces = workspaces.filter(w => w.connectionId !== id);
      saveWorkspaces(fsImpl, aiHomeDir, nextWorkspaces);

      writeJson(res, 200, { ok: true });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
    }
    return true;
  }

  // 1.5 物理连接探测诊断接口
  if (method === 'POST' && pathname === '/v0/webui/ssh-connections/test') {
    let tempKeyFile = null;
    let tempAskPassFile = null;
    try {
      let host = String(body.host || '').trim();
      let port = Number(body.port) || 22;
      let user = String(body.user || '').trim();
      let authType = String(body.authType || 'agent').trim();
      let password = String(body.password || '').trim();
      let privateKey = String(body.privateKey || '').trim();
      let identityFile = String(body.identityFile || '').trim();
      const timeoutMs = Number(body.timeoutMs) || 5000;

      // 已保存连接由 Server 作为唯一真相源，避免客户端缓存的旧认证配置覆盖数据库记录。
      const connectionId = String(body.connectionId || '').trim();
      if (connectionId) {
        const list = getConnections(fsImpl, aiHomeDir);
        const saved = list.find(c => c.id === connectionId);
        if (!saved) {
          writeJson(res, 404, { ok: false, error: 'not_found', message: 'Connection not found.' });
          return true;
        }
        host = String(saved.host || '').trim();
        port = Number(saved.port) || 22;
        user = String(saved.user || '').trim();
        authType = String(saved.authType || 'agent').trim();
        password = String(saved.password || '').trim();
        privateKey = String(saved.privateKey || '').trim();
        identityFile = String(saved.identityFile || '').trim();
      }

      if (!host) {
        writeJson(res, 400, { ok: false, error: 'missing_host', message: 'Host is required.' });
        return true;
      }

      // 构建用于探针执行的临时私钥或密码脚本
      const injectEnv = { ...process.env };
      const extraSshArgs = [];
      let sshIdentityFile = '';

      if (authType === 'key' && privateKey) {
        tempKeyFile = path.join(os.tmpdir(), `aih-ssh-test-${crypto.randomBytes(8).toString('hex')}`);
        fs.writeFileSync(tempKeyFile, privateKey, { mode: 0o600 });
        extraSshArgs.push('-i', tempKeyFile);
      } else if (authType === KEY_FILE_AUTH_TYPE) {
        sshIdentityFile = resolveIdentityFilePath(identityFile, { fs: fsImpl, homeDir });
      } else if (authType === 'password' && password) {
        tempAskPassFile = createTemporaryAskPass(password);
        injectEnv.SSH_PASSWORD = password;
        injectEnv.SSH_ASKPASS = tempAskPassFile;
        injectEnv.SSH_ASKPASS_REQUIRE = 'force';
        injectEnv.DISPLAY = ':0'; // 绕过 X11 要求
      }

      // 执行 SSH 探针检测 (复用 probeSshTarget)
      const parsedTarget = {
        kind: 'ssh',
        raw: user ? `${user}@${host}` : host,
        label: user ? `${user}@${host}` : host,
        user,
        host,
        port,
        target: user ? `${user}@${host}` : host
      };

      const options = {
        timeoutMs,
        repoDir: '',
        sshIdentityFile
      };

      // 封装动态拦截凭据参数的 spawnImpl
      const customSpawn = (command, args, spawnOpts = {}) => {
        const nextArgs = [...args];
        if (command === 'ssh') {
          // 如果是非交互密码认证，剥离默认的 BatchMode 强迫使用 AskPass
          if (authType === 'password' && password) {
            const batchIndex = nextArgs.indexOf('BatchMode=yes');
            if (batchIndex !== -1) {
              nextArgs[batchIndex] = 'BatchMode=no';
            }
          }
          // 追加额外的证书参数
          nextArgs.unshift(...extraSshArgs);
        }

        const realSpawn = spawnImpl || require('node:child_process').spawn;
        return realSpawn(command, nextArgs, {
          ...spawnOpts,
          env: {
            ...injectEnv,
            ...(spawnOpts.env || {})
          }
        });
      };

      const result = await probeSshTarget(parsedTarget, options, { spawnImpl: customSpawn });
      writeJson(res, 200, { ok: true, result });
    } catch (err) {
      if (!writeIdentityFileError(res, writeJson, err)) {
        writeJson(res, 500, { ok: false, error: 'probe_failed', message: err.message });
      }
    } finally {
      // 绝对安全物理擦除，保障凭证安全
      if (tempKeyFile) wipeFileAndRemove(tempKeyFile);
      if (tempAskPassFile) wipeFileAndRemove(tempAskPassFile);
    }
    return true;
  }

  // ==========================================
  // 1.4 远程工作区会话状态（B6）：哪些工作区的远端会话还活着
  // ==========================================
  // GET /v0/webui/ssh-workspaces/sessions -> { ok, sessions: [{ workspaceId, sessionKey, alive }] }
  // 状态以 Server 端持久 PTY 为准（不是浏览器 localStorage）：换设备、清缓存、Server 重启后
  // 打开 Work 页仍能看到「运行中」，点一下就接回原来的远端 shell。
  if (method === 'GET' && pathname === '/v0/webui/ssh-workspaces/sessions') {
    // 工作区列表与 tmux 探测都在 Go：Node 不再逐个 workspace 发 N 次探测请求。
    const goHost = deps && deps.goCoreSync;
    if (!goHost || typeof goHost.getSshWorkspaceSessions !== 'function') {
      writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，SSH 工作区终端状态不可读' });
      return true;
    }
    let response = null;
    try {
      response = await goHost.getSshWorkspaceSessions();
    } catch (_error) {
      response = null;
    }
    if (response && response.ok === true && response.data) {
      writeJson(res, 200, response.data);
      return true;
    }
    writeJson(res, 503, {
      ok: false,
      error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
      message: 'Go Core 未就绪，SSH 工作区终端状态不可读'
    });
    return true;
  }

  // ==========================================
  // 1.5 远程工作区终端：在 SSH 开发机的工作区目录里开一个持久 Web Terminal
  // ==========================================
  // POST /v0/webui/ssh-workspaces/:id/terminal  { cols?, rows?, fresh?, agent?: 'claude'|'codex' }
  //   -> { ok, sessionKey, termId, reused, label, remoteRoot, host }
  // 同一个工作区默认复用同一个 PTY（刷新/断线重连不丢远端 shell）；fresh=true 另开一个。
  const terminalMatch = method === 'POST'
    ? /^\/v0\/webui\/ssh-workspaces\/([^/]+)\/terminal$/.exec(pathname) : null;
  if (terminalMatch) {
    const workspaceId = decodeURIComponent(terminalMatch[1]);
    const workspace = getWorkspaces(fsImpl, aiHomeDir).find((item) => item.id === workspaceId);
    if (!workspace) {
      writeJson(res, 404, { ok: false, error: 'workspace_not_found', message: '远程工作区不存在。' });
      return true;
    }
    const connection = getConnections(fsImpl, aiHomeDir).find((item) => item.id === workspace.connectionId);
    if (!connection) {
      writeJson(res, 409, { ok: false, error: 'connection_not_found', message: '工作区关联的 SSH 连接已被删除。' });
      return true;
    }
    const openSession = deps.openWebUiTerminalSession
      || ((input) => require('./webui-terminal-routes').openWebUiTerminalSession(input, deps.goCoreSync));
    // agent=claude|codex：AI 终端。harness 在 Server 本机跑（交互 TUI），文件 / 命令经远程工具落到远端，
    // 远端零安装；与 WebUI Work 共用同一套远程工具、凭据与主机密钥。cwd 是该工作区的影子目录。
    const agent = ['claude', 'codex'].includes(String(body.agent || '')) ? String(body.agent) : '';
    if (agent) {
      const { ensureShadowDirectory } = require('./remote-session-bridge');
      const processObj = deps.processObj || process;
      const agentKey = `remote-ai:${workspace.id}:${agent}${body.fresh ? `:${crypto.randomBytes(4).toString('hex')}` : ''}`;
      const result = await openSession({
        sessionKey: agentKey,
        file: String(processObj.execPath || 'node'),
        args: [path.join(__dirname, '..', '..', 'bin', 'ai-home.js'), agent, `--remote=${workspace.id}`],
        env: { AIH_HOME_DIR: aiHomeDir },
        cwd: ensureShadowDirectory(fsImpl, aiHomeDir, workspace.id),
        cols: body.cols,
        rows: body.rows,
        title: `${workspace.label} · ${agent}`
      });
      if (!result || result.ok !== true) {
        writeJson(res, 503, { ...(result || {}), ok: false, error: (result && result.error) || 'remote_terminal_open_failed' });
        return true;
      }
      writeJson(res, 200, {
        ok: true, sessionKey: result.sessionKey || agentKey, termId: result.termId, reused: Boolean(result.reused),
        durable: Boolean(result.durable), label: `${workspace.label} · ${agent}`, remoteRoot: workspace.remoteRoot,
        host: connection.user ? `${connection.user}@${connection.host}` : connection.host, agent
      });
      return true;
    }
    // transport=native（C1）：浏览器就在 Server 本机且有桌面时，在原生终端窗口里打开同一个 SSH 守护
    // （aih __remote_ws__：断线自动重连、凭据不进命令行）。其余情况回 409，前端改用 Web Terminal。
    if (String(body.transport || '') === 'native') {
      const { resolveTerminalTransport } = require('./webui-terminal-transport-policy');
      const processObj = deps.processObj || process;
      if (resolveTerminalTransport({ req: ctx.req, processObj, env: processObj.env }) !== 'native') {
        writeJson(res, 409, { ok: false, error: 'web_terminal_required', message: '浏览器不在 AIH Server 本机，改用 Web Terminal 打开。' });
        return true;
      }
      const { launchClientTerminal } = require('../runtime/client-terminal');
      const quote = (value) => (processObj.platform === 'win32' ? `"${String(value).replace(/"/g, '\\"')}"` : `'${String(value).replace(/'/g, "'\\''")}'`);
      const nativeKey = remoteSessionKey(workspace.id, `native-${crypto.randomBytes(4).toString('hex')}`);
      const envPrefix = processObj.platform === 'win32' ? `set "AIH_HOME_DIR=${aiHomeDir}" && ` : `AIH_HOME_DIR=${quote(aiHomeDir)} `;
      const command = `${envPrefix}${quote(processObj.execPath || 'node')} ${quote(path.join(__dirname, '..', '..', 'bin', 'ai-home.js'))} __remote_ws__ ${quote(workspace.id)} ${quote(nativeKey)}`;
      const result = launchClientTerminal(String(body.terminalId || ''), { processObj, env: processObj.env, title: `${workspace.label} · ${connection.host}`, command });
      writeJson(res, result.ok ? 200 : 503, { ...result, transport: 'native', label: workspace.label, remoteRoot: workspace.remoteRoot });
      return true;
    }
    const sessionKey = remoteSessionKey(workspace.id, body.fresh ? crypto.randomBytes(4).toString('hex') : '');
    // 先校验一次连接配置（密钥文件路径、权限等），错误立即回给页面，而不是等进了终端才看到。
    try {
      const probe = buildRemoteShellCommand({
        connection, remoteRoot: workspace.remoteRoot, sessionKey, aiHomeDir, fs: fsImpl, homeDir
      });
      removeCredentialFiles(probe.tempFiles, fsImpl);
    } catch (error) {
      if (!writeIdentityFileError(res, writeJson, error)) {
        writeJson(res, 400, { ok: false, error: error.code || 'ssh_connection_invalid', message: error.message });
      }
      return true;
    }
	    // Go 直接用 SSH PTY 打开工作区；远程命令复用 buildRemoteShellCommand 的
	    // 引用结果（cd 到 remoteRoot + tmux 接回），凭据只在管理链路里。
	    const remote = buildRemoteShellCommand({
	      connection, remoteRoot: workspace.remoteRoot, sessionKey, aiHomeDir, fs: fsImpl, homeDir
	    });
	    const remoteCommand = String(remote.args[remote.args.length - 1] || '');
	    removeCredentialFiles(remote.tempFiles, fsImpl);
	    // egressConnectionId 解析成 Go 的 Jump 链；成环/缺失时宁可不填，由 Go 失败关闭。
	    const byConnectionId = new Map(getConnections(fsImpl, aiHomeDir).map((item) => [item.id, item]));
	    const buildSshLaunch = (current, seen = new Set()) => {
	      const launch = {
	        host: current.host,
	        port: Number(current.port) || 22,
	        user: current.user,
	        authType: current.authType,
	        password: current.password,
	        privateKey: current.privateKey,
	        identityFile: current.identityFile
	      };
	      const egressId = String(current.egressConnectionId || '').trim();
	      if (egressId) {
	        const egress = byConnectionId.get(egressId);
	        if (!egress || seen.has(egressId) || seen.size >= 5) return null;
	        const nextSeen = new Set(seen);
	        nextSeen.add(egressId);
	        const jump = buildSshLaunch(egress, nextSeen);
	        if (!jump) return null;
	        launch.jump = jump;
	      }
	      return launch;
	    };
	    const sshLaunch = buildSshLaunch(connection);
	    if (!sshLaunch) {
	      writeJson(res, 409, {
	        ok: false,
	        error: 'egress_connection_invalid',
	        message: '该连接依赖的出口/跳板连接不存在或形成环。'
	      });
	      return true;
	    }
	    const result = await openSession({
	      sessionKey,
	      ssh: {
	        ...sshLaunch,
	        command: remoteCommand
	      },
	      cols: body.cols,
	      rows: body.rows,
	      title: workspace.label
	    });
    if (!result || result.ok !== true) {
      writeJson(res, 503, { ...(result || {}), ok: false, error: (result && result.error) || 'remote_terminal_open_failed' });
      return true;
    }
    writeJson(res, 200, {
      ok: true,
      sessionKey: result.sessionKey || sessionKey,
      termId: result.termId,
      reused: Boolean(result.reused),
      durable: Boolean(result.durable),
      label: workspace.label,
      remoteRoot: workspace.remoteRoot,
      host: connection.user ? `${connection.user}@${connection.host}` : connection.host
    });
    return true;
  }

  // ==========================================
  // 2. SSH Workspaces 工作空间映射接口
  // ==========================================

  // 2.1 获取列表
  if (method === 'GET' && pathname === '/v0/webui/ssh-workspaces') {
    // GET 固定读 Go：远端工作区的 projectPath 影子目录由 Go 补，Node 不再本地组装。
    const goHost = deps && deps.goCoreSync;
    if (!goHost || typeof goHost.getSshWorkspaces !== 'function') {
      writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，SSH 工作区不可读' });
      return true;
    }
    let response = null;
    try {
      response = await goHost.getSshWorkspaces();
    } catch (_error) {
      response = null;
    }
    if (response && response.ok === true && response.data) {
      writeJson(res, 200, response.data);
      return true;
    }
    writeJson(res, 503, {
      ok: false,
      error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
      message: 'Go Core 未就绪，SSH 工作区不可读'
    });
    return true;
  }

  // 2.2 新增工作空间
  if (method === 'POST' && pathname === '/v0/webui/ssh-workspaces') {
    try {
      const connectionId = String(body.connectionId || '').trim();
      const label = String(body.label || '').trim();
      const remoteRoot = String(body.remoteRoot || '').trim();

      if (!connectionId || !label || !remoteRoot) {
        writeJson(res, 400, { ok: false, error: 'missing_fields', message: 'Connection, Label, and Remote Root are required.' });
        return true;
      }

      // 验证连接是否存在
      const connections = getConnections(fsImpl, aiHomeDir);
      if (!connections.some(c => c.id === connectionId)) {
        writeJson(res, 400, { ok: false, error: 'invalid_connection', message: 'Specified SSH connection does not exist.' });
        return true;
      }

      const list = getWorkspaces(fsImpl, aiHomeDir);
      const newWorkspace = {
        id: 'ws_' + crypto.randomBytes(8).toString('hex'),
        connectionId,
        label,
        remoteRoot,
        createdAt: Date.now()
      };

      list.push(newWorkspace);
      saveWorkspaces(fsImpl, aiHomeDir, list);

      writeJson(res, 200, { ok: true, workspace: newWorkspace });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
    }
    return true;
  }

  // 2.3 编辑工作空间
  if (method === 'PUT' && pathname.startsWith('/v0/webui/ssh-workspaces/')) {
    const segments = pathname.split('/');
    const id = segments[segments.length - 1];

    if (!id) return false;

    try {
      const list = getWorkspaces(fsImpl, aiHomeDir);
      const index = list.findIndex(w => w.id === id);

      if (index === -1) {
        writeJson(res, 404, { ok: false, error: 'not_found', message: 'Workspace not found.' });
        return true;
      }

      const ws = list[index];
      if (body.label !== undefined) ws.label = String(body.label || '').trim();
      if (body.remoteRoot !== undefined) ws.remoteRoot = String(body.remoteRoot || '').trim();
      if (body.connectionId !== undefined) {
        const connId = String(body.connectionId || '').trim();
        const connections = getConnections(fsImpl, aiHomeDir);
        if (connId && !connections.some(c => c.id === connId)) {
          writeJson(res, 400, { ok: false, error: 'invalid_connection', message: 'Specified SSH connection does not exist.' });
          return true;
        }
        ws.connectionId = connId;
      }

      if (!ws.label || !ws.remoteRoot) {
        writeJson(res, 400, { ok: false, error: 'invalid_fields', message: 'Label and Remote Root cannot be empty.' });
        return true;
      }

      list[index] = ws;
      saveWorkspaces(fsImpl, aiHomeDir, list);

      writeJson(res, 200, { ok: true, workspace: ws });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
    }
    return true;
  }

  // 2.4 删除工作空间
  if (method === 'DELETE' && pathname.startsWith('/v0/webui/ssh-workspaces/')) {
    const segments = pathname.split('/');
    const id = segments[segments.length - 1];

    if (!id) return false;

    try {
      const list = getWorkspaces(fsImpl, aiHomeDir);
      const nextList = list.filter(w => w.id !== id);
      saveWorkspaces(fsImpl, aiHomeDir, nextList);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
    }
    return true;
  }

  // ==========================================
  // 3. SSH 远程目录浏览器列表接口
  // ==========================================
  if (method === 'POST' && pathname === '/v0/webui/ssh-hosts/browse') {
    const connectionId = String(body.connectionId || '').trim();
    const subDir = String(body.subDir || '').trim();
    if (!connectionId) {
      writeJson(res, 400, { ok: false, error: 'missing_connection', message: 'Connection ID is required.' });
      return true;
    }
	    try {
	      // 目录浏览已切 Go 进程内 SSH；Node 只转发结果。带出口/反向隧道的连接
	      // Go 暂未承接（会返回 ssh_tunnel_unsupported），这时才回落到 Node 的常驻连接池。
	      const goHost = deps && deps.goCoreSync;
	      if (goHost && typeof goHost.browseSshHost === 'function') {
	        const result = await goHost.browseSshHost({ connectionId, subDir });
	        if (result && result.ok) {
	          writeJson(res, 200, { ok: true, ...(result.data || {}) });
	          return true;
	        }
	        const errorCode = String((result && result.data && result.data.error) || (result && result.errorCode) || '').trim();
	        if (errorCode !== 'ssh_tunnel_unsupported') {
	          const status = Number(result && result.status) || 503;
	          const message = (result && result.data && result.data.message)
	            || (status === 503 ? 'Go Core 未就绪，远端目录浏览不可用。' : '连接远程服务器失败。');
	          writeJson(res, status, { ok: false, error: errorCode || 'remote_execution_failed', message });
	          return true;
	        }
	      }
	      // 走远程工作区连接池：登录留在常驻连接上，一次浏览只剩「列目录」的往返，
	      // 不再为每次请求 spawn 一个 ssh 进程（隧道目标每次登录 3–4s 的代价就没了）。
	      const { getRemoteWorkspaceService } = require('../remote-workspace');
	      const service = getRemoteWorkspaceService({ fs: fsImpl, aiHomeDir });
	      const result = await browseRemoteDirectories({ service, connectionId, subDir });
	      writeJson(res, 200, { ok: true, ...result });
	    } catch (err) {
      if (err && err.code === 'connection_not_found') {
        writeJson(res, 404, { ok: false, error: 'not_found', message: 'Connection not found.' });
      } else if (err && err.code === 'not_found') {
        writeJson(res, 500, { ok: false, error: 'remote_execution_failed', message: err.message });
      } else if (!writeIdentityFileError(res, writeJson, err)) {
        writeJson(res, 500, {
          ok: false,
          error: 'remote_execution_failed',
          message: String((err && err.message) || '').trim() || '连接远程服务器失败或指定的工作区目录路径不存在。'
        });
      }
    }
    return true;
  }

  return false;
}

module.exports = {
  handleWebUiSshHostRoutes
};
