'use strict';

// 宿主机可执行文件搜索路径的单一事实来源。
//
// 后台 Server 由 launchd / systemd / 服务管理器拉起时继承的是一份最小 PATH，
// 不包含用户 shell profile 追加的目录（macOS/Linux 官方安装器普遍把 CLI 落到
// ~/.local/bin 并只在 profile 里补 PATH）。于是"CLI 是否已安装"的纯 PATH 扫描
// 会与真正的启动链路结论相反——启动链路（command-path.js）在 PATH 扫描落空后
// 还会回落到登录 shell 的 `command -v`，因此能找到同一个二进制。
//
// 这里把登录 shell 的 PATH 与安装器约定目录一次性合并成宿主机搜索路径，
// 让检测与启动共用同一份事实，避免两侧再次漂移。
const nodePath = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

const LOGIN_SHELL_TIMEOUT_MS = 3000;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function isWindows(platform) {
  const key = normalizeText(platform).toLowerCase();
  return key === 'win32' || key === 'windows';
}

function splitPathEntries(raw, platform) {
  const delimiter = isWindows(platform) ? ';' : ':';
  return String(raw || '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function readEnvPath(env) {
  if (!env) return '';
  return String(env.PATH || env.Path || env.path || '');
}

// readLoginShellPath 只取登录 shell 解析后的 PATH，不执行任何 provider 命令；
// shell 缺失/超时/异常一律降级为空，调用方继续使用宿主 PATH。
function readLoginShellPath(options = {}) {
  if (isWindows(options.platform)) return '';
  const execFileSyncImpl = options.execFileSync || nodeExecFileSync;
  const shell = normalizeText(options.shell) || '/bin/sh';
  try {
    const output = execFileSyncImpl(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      env: options.env && typeof options.env === 'object' ? options.env : undefined,
      windowsHide: true
    });
    return normalizeText(output);
  } catch (_error) {
    return '';
  }
}

// collectInstallerBinDirs 覆盖安装器写死的落点：官方 POSIX 安装脚本与各
// provider 的 tar.gz 回退都会 `ln -sf` 到 $HOME/.local/bin（见
// app-installers/official-install.js），Windows 官方安装器同样使用该目录。
function collectInstallerBinDirs(options = {}) {
  const hostHomeDir = normalizeText(options.hostHomeDir);
  if (!hostHomeDir) return [];
  const pathImpl = options.path || nodePath;
  return [pathImpl.join(hostHomeDir, '.local', 'bin')];
}

// resolveHostSearchPathEntries 返回去重后的搜索目录列表，宿主 PATH 优先，
// 登录 shell 与安装器目录只做补齐，不改变已有解析顺序。
function resolveHostSearchPathEntries(options = {}) {
  const platform = options.platform;
  const entries = splitPathEntries(readEnvPath(options.env), platform);
  const extras = [
    ...splitPathEntries(readLoginShellPath(options), platform),
    ...collectInstallerBinDirs(options)
  ];
  const seen = new Set(entries);
  extras.forEach((entry) => {
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    entries.push(entry);
  });
  return entries;
}

// resolveHostSearchPath 返回可直接赋给 PATH 的字符串形式。
function resolveHostSearchPath(options = {}) {
  const delimiter = isWindows(options.platform) ? ';' : ':';
  return resolveHostSearchPathEntries(options).join(delimiter);
}

// withHostSearchPath 生成一份 PATH 已补齐的 env 副本，供沿用 env.PATH 的解析器复用。
// 只保留一个 PATH 键：不同解析器的读取优先级不一致（command-path 在 win32 上先读
// Path），留下旧值会让同一份 env 在两个模块里解析出不同结果。
function withHostSearchPath(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  const resolved = resolveHostSearchPath(options);
  const preferPathCase = Object.prototype.hasOwnProperty.call(env, 'Path')
    && !Object.prototype.hasOwnProperty.call(env, 'PATH');
  const out = {};
  Object.keys(env).forEach((key) => {
    if (key === 'PATH' || key === 'Path' || key === 'path') return;
    out[key] = env[key];
  });
  out[preferPathCase ? 'Path' : 'PATH'] = resolved;
  return out;
}

module.exports = {
  resolveHostSearchPath,
  resolveHostSearchPathEntries,
  withHostSearchPath
};
