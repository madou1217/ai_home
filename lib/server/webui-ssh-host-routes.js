'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { readJsonValue, writeJsonValue } = require('./app-state-store');
const { probeSshTarget } = require('../cli/services/node/bootstrap-probe');
const {
  KEY_FILE_AUTH_TYPE,
  SshIdentityFileError,
  resolveIdentityFilePath
} = require('./ssh-identity-file');
const { buildRemoteShellCommand, remoteSessionKey, removeCredentialFiles } = require('./ssh-remote-shell');

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

function encodePowerShellCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function quotePowerShell(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function buildWindowsBrowseCommand(targetPath) {
  const script = `$ErrorActionPreference = 'Stop'
$target = [Environment]::ExpandEnvironmentVariables(${quotePowerShell(targetPath)})
if (-not $target) { $target = (Get-Location).Path }
$resolved = (Resolve-Path -LiteralPath $target -ErrorAction Stop).Path
Write-Output $resolved
Get-ChildItem -LiteralPath $resolved -Directory -Force -ErrorAction Stop | ForEach-Object { Write-Output $_.Name }
`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function isWindowsRemotePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || '').trim());
}

function remoteParentPath(value) {
  const current = String(value || '').trim();
  if (isWindowsRemotePath(current)) {
    const normalized = current.replace(/[\\/]+$/, '');
    const match = normalized.match(/^(.*?)[\\/][^\\/]+$/);
    return match ? match[1] : normalized;
  }
  return current === '/' ? '/' : path.dirname(current);
}

function remoteChildPath(parent, name) {
  if (isWindowsRemotePath(parent)) return `${String(parent).replace(/[\\/]+$/, '')}\\${name}`;
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
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

  // 1.1 获取列表
  if (method === 'GET' && pathname === '/v0/webui/ssh-connections') {
    const list = getConnections(fsImpl, aiHomeDir);
    const sanitized = list.map(sanitizeConnection);
    writeJson(res, 200, { ok: true, connections: sanitized });
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
      const newConn = clearInactiveCredentials({
        id: 'conn_' + crypto.randomBytes(8).toString('hex'),
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
      const nextList = list.filter(c => c.id !== id);
      saveConnections(fsImpl, aiHomeDir, nextList);

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
  // 1.5 远程工作区终端：在 SSH 开发机的工作区目录里开一个持久 Web Terminal
  // ==========================================
  // POST /v0/webui/ssh-workspaces/:id/terminal  { cols?, rows?, fresh? }
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
    const openSession = deps.openWebUiTerminalSession || require('./webui-terminal-routes').openWebUiTerminalSession;
    const sessionKey = remoteSessionKey(workspace.id, body.fresh ? crypto.randomBytes(4).toString('hex') : '');
    let command;
    try {
      command = buildRemoteShellCommand({
        connection, remoteRoot: workspace.remoteRoot, sessionKey, aiHomeDir, fs: fsImpl, homeDir
      });
    } catch (error) {
      if (!writeIdentityFileError(res, writeJson, error)) {
        writeJson(res, 400, { ok: false, error: error.code || 'ssh_connection_invalid', message: error.message });
      }
      return true;
    }
    const result = openSession({
      sessionKey,
      file: command.file,
      args: command.args,
      env: command.env,
      cols: body.cols,
      rows: body.rows,
      title: workspace.label
    });
    // 复用已有 PTY 时不需要新凭据；新建时 ssh 在建连阶段读完私钥/askpass，稍后即可擦除。
    if (result && result.reused) removeCredentialFiles(command.tempFiles, fsImpl);
    else setTimeout(() => removeCredentialFiles(command.tempFiles, fsImpl), 15000).unref?.();
    if (!result || result.ok !== true) {
      removeCredentialFiles(command.tempFiles, fsImpl);
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
    const list = getWorkspaces(fsImpl, aiHomeDir);
    writeJson(res, 200, { ok: true, workspaces: list });
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
    let tempKeyFile = null;
    let tempAskPassFile = null;
    try {
      const connectionId = String(body.connectionId || '').trim();
      const subDir = String(body.subDir || '').trim();

      if (!connectionId) {
        writeJson(res, 400, { ok: false, error: 'missing_connection', message: 'Connection ID is required.' });
        return true;
      }

      const connections = getConnections(fsImpl, aiHomeDir);
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) {
        writeJson(res, 404, { ok: false, error: 'not_found', message: 'Connection not found.' });
        return true;
      }

      // 对命令行进行安全的 shell 参数保护
      const sanitizeShellArg = (val) => {
        return "'" + String(val || '').replace(/'/g, "'\\''") + "'";
      };

      const targetPath = subDir || '.';

      // 核心命令：进入路径并列出所有非文件目录，按首字符分组，确保 . 开头的隐藏目录也被遍历出
      const remoteCommand = `cd ${sanitizeShellArg(targetPath)} && pwd && for d in *; do [ -d "$d" ] && [ "$d" != "." ] && [ "$d" != ".." ] && printf "%s\\n" "$d"; done; for d in .*; do [ -d "$d" ] && [ "$d" != "." ] && [ "$d" != ".." ] && printf "%s\\n" "$d"; done; true`;

      const injectEnv = { ...process.env };
      const extraSshArgs = [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=5'
      ];

      if (conn.authType === 'key' && conn.privateKey) {
        tempKeyFile = path.join(os.tmpdir(), `aih-ssh-br-${crypto.randomBytes(8).toString('hex')}`);
        fs.writeFileSync(tempKeyFile, conn.privateKey, { mode: 0o600 });
        extraSshArgs.push('-i', tempKeyFile);
      } else if (conn.authType === KEY_FILE_AUTH_TYPE) {
        const resolvedIdentityFile = resolveIdentityFilePath(conn.identityFile, { fs: fsImpl, homeDir });
        extraSshArgs.push('-i', resolvedIdentityFile, '-o', 'IdentitiesOnly=yes');
      } else if (conn.authType === 'password' && conn.password) {
        tempAskPassFile = createTemporaryAskPass(conn.password);
        injectEnv.SSH_PASSWORD = conn.password;
        injectEnv.SSH_ASKPASS = tempAskPassFile;
        injectEnv.SSH_ASKPASS_REQUIRE = 'force';
        injectEnv.DISPLAY = ':0';
        // 覆盖为 BatchMode=no 使得 askpass 可触发
        const batchIndex = extraSshArgs.indexOf('BatchMode=yes');
        if (batchIndex !== -1) {
          extraSshArgs[batchIndex] = 'BatchMode=no';
        }
      }

      if (conn.port) {
        extraSshArgs.push('-p', String(conn.port));
      }

      const dest = conn.user ? `${conn.user}@${conn.host}` : conn.host;
      const sshArgs = [...extraSshArgs, dest, remoteCommand];

      // 运行 Unix 探针；Windows OpenSSH 主机默认由 PowerShell/cmd 解释远端
      // 命令，因此在 Unix 语法失败时用同一 SSH 连接参数重试 PowerShell 目录枚举。
      let probeRes = await runProcess('ssh', sshArgs, { timeoutMs: 5000, spawnImpl, env: injectEnv });
      if (probeRes.status !== 0 || /was unexpected|not recognized|syntax/i.test(String(probeRes.stderr || ''))) {
        const windowsArgs = [...extraSshArgs, dest, buildWindowsBrowseCommand(targetPath)];
        const windowsRes = await runProcess('ssh', windowsArgs, { timeoutMs: 5000, spawnImpl, env: injectEnv });
        if (windowsRes.status === 0 || windowsRes.stdout.trim()) probeRes = windowsRes;
      }

      if (tempKeyFile) wipeFileAndRemove(tempKeyFile);
      if (tempAskPassFile) wipeFileAndRemove(tempAskPassFile);

      if (probeRes.status !== 0) {
        writeJson(res, 500, {
          ok: false,
          error: 'remote_execution_failed',
          message: probeRes.stderr || '连接远程服务器失败或指定的工作区目录路径不存在。'
        });
        return true;
      }

      const lines = probeRes.stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) {
        writeJson(res, 500, { ok: false, error: 'invalid_output', message: 'Empty response from remote server.' });
        return true;
      }

      const currentDir = lines[0]; // 第一行输出绝对的 pwd 路径
      const parentDir = remoteParentPath(currentDir);

      const directories = lines.slice(1)
        .map(line => {
          // 排除通配符匹配不到时输出的字面量 * 或 .*
          if (line === '*' || line === '.*') return null;
          return {
            name: line,
            path: remoteChildPath(currentDir, line)
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));

      writeJson(res, 200, {
        ok: true,
        currentDir,
        parentDir,
        directories
      });
    } catch (err) {
      if (tempKeyFile) wipeFileAndRemove(tempKeyFile);
      if (tempAskPassFile) wipeFileAndRemove(tempAskPassFile);
      if (!writeIdentityFileError(res, writeJson, err)) {
        writeJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
      }
    }
    return true;
  }

  return false;
}

module.exports = {
  handleWebUiSshHostRoutes
};
