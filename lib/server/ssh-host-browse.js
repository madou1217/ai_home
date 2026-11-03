'use strict';

// SSH 目录浏览（WebUI 的「选择远端目录」）：走远程工作区的连接池（ssh2），
// 不再为每次请求 spawn 一个 ssh 进程。
//
// 为什么换：spawn 方案每次都要付完整的 SSH 登录（公网直连 ~1s，反向隧道目标 3–4s），
// 而连接池把登录留在常驻连接上，一次浏览就是「一个往返 + 列目录」。
// 认证 / 主机指纹 / 超时 / 车道 / 方言都复用 lib/remote-workspace，这里只负责
// 「把路径解析成绝对路径 → 列目录 → 只留目录」这一层展示逻辑。

const DEFAULT_BROWSE_TIMEOUT_MS = 15000;

function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || '').trim());
}

function isWindowsDialect(dialectId) {
  return String(dialectId || '') === 'powershell';
}

/** 拼远端路径：POSIX 用 /，PowerShell 用 \\。 */
function joinRemotePath(base, name, dialectId) {
  const parent = String(base || '');
  if (isWindowsDialect(dialectId)) {
    return `${parent.replace(/[\\/]+$/, '')}\\${String(name || '').replace(/^[\\/]+/, '')}`;
  }
  const root = parent.replace(/\/+$/, '');
  return root ? `${root}/${String(name || '').replace(/^\/+/, '')}` : `/${String(name || '').replace(/^\/+/, '')}`;
}

/**
 * 把界面传进来的路径折成绝对路径：
 * 空 / ~ → 远端家目录；相对路径 → 家目录下的相对路径；绝对路径原样。
 */
function resolveBrowsePath(input, home, dialectId) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  const homeDir = String(home || '').trim();
  if (!raw) return homeDir;
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return joinRemotePath(homeDir, raw.slice(2), dialectId);
  }
  if (isWindowsDialect(dialectId)) {
    return isWindowsPath(raw) ? raw : joinRemotePath(homeDir, raw, dialectId);
  }
  return raw.startsWith('/') ? raw : joinRemotePath(homeDir, raw, dialectId);
}

function parentRemotePath(value, dialectId) {
  const current = String(value || '').trim();
  if (isWindowsDialect(dialectId) || isWindowsPath(current)) {
    const normalized = current.replace(/[\\/]+$/, '');
    const match = normalized.match(/^(.*?)[\\/][^\\/]+$/);
    return match ? match[1] : normalized;
  }
  if (current === '/' || !current) return '/';
  const trimmed = current.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

// GNU stat %F / BSD stat %HT 的类型名（以及 PowerShell 的 d/f/l）→ d / f / l。
function normalizeType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'd' || text === 'directory') return 'd';
  if (text === 'l' || text.includes('symbolic') || text.includes('link')) return 'l';
  return 'f';
}

/** dialect.listDir 的输出：每行 type\tsize\tmtime\tname。 */
function parseListDirOutput(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [type, size, mtime, ...name] = line.split('\t');
      return {
        name: name.join('\t'),
        type: normalizeType(type),
        size: Number(size) || 0,
        mtime: Number(mtime) || 0
      };
    })
    .filter((entry) => entry.name && entry.name !== '.' && entry.name !== '..');
}

function remoteBrowseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 列出一台远端机器上某个目录下的子目录。
 * @param {{service: object, connectionId: string, subDir?: string, timeoutMs?: number}} options
 *   service：RemoteWorkspaceService（lib/remote-workspace 的实例）
 * @returns {Promise<{currentDir: string, parentDir: string, directories: {name: string, path: string}[]}>}
 */
async function browseRemoteDirectories({ service, connectionId, subDir = '', timeoutMs = DEFAULT_BROWSE_TIMEOUT_MS } = {}) {
  const machine = service.machine(connectionId); // 连接不存在时抛 connection_not_found
  const facts = await machine.profile();
  const dialectId = facts && facts.dialect ? facts.dialect.id : 'posix';
  const currentDir = resolveBrowsePath(subDir, facts.home, dialectId);
  const result = await machine.exec(facts.dialect.listDir(currentDir), {
    timeoutMs,
    lane: 'interactive'
  });
  if (result.code !== 0) {
    const stderr = String(result.stderr || '').trim();
    if (result.code === 3 || /NOENT/.test(stderr)) {
      throw remoteBrowseError('not_found', '目录不存在或不可访问。');
    }
    if (/permission denied|access.*denied/i.test(stderr)) {
      throw remoteBrowseError('permission_denied', '没有权限访问该目录。');
    }
    throw remoteBrowseError('remote_io_error', stderr || '连接远程服务器失败。');
  }
  const directories = parseListDirOutput(result.stdout)
    .filter((entry) => entry.type === 'd')
    .map((entry) => ({ name: entry.name, path: joinRemotePath(currentDir, entry.name, dialectId) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    currentDir,
    parentDir: parentRemotePath(currentDir, dialectId),
    directories
  };
}

module.exports = {
  DEFAULT_BROWSE_TIMEOUT_MS,
  browseRemoteDirectories,
  joinRemotePath,
  normalizeType,
  parentRemotePath,
  parseListDirOutput,
  resolveBrowsePath
};
