'use strict';

const DEFAULT_KIMI_CONFIG = [
  'default_model = "kimi-code/kimi-for-coding"',
  '',
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'api_key = ""',
  'base_url = "https://api.kimi.com/coding/v1"',
  '',
  '[providers."managed:kimi-code".oauth]',
  'storage = "file"',
  'key = "oauth/kimi-code"',
  ''
].join('\n');

// relay 模式的精简模板：去掉 oauth 块（oauth 与 api_key 在 CLI 侧互斥，且
// oauth 存在时 OAuth 优先于 env 注入的 KIMI_API_KEY，relay 会被旁路），
// base_url 指向本地网关。api_key 留空：CLI 的 KimiChatProvider 会回退读进程
// env 的 KIMI_API_KEY（网关 clientKey 不落盘）。
const DEFAULT_KIMI_RELAY_BASE_URL = 'http://127.0.0.1:9527/v1';

function buildKimiRelayConfig(baseUrl) {
  // baseUrl 来自本机 server 配置；剥掉引号/换行防止 TOML 注入。
  const safeBaseUrl = String(baseUrl || '').trim().replace(/["\\\r\n]/g, '')
    || DEFAULT_KIMI_RELAY_BASE_URL;
  return [
    'default_model = "kimi-code/kimi-for-coding"',
    '',
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'api_key = ""',
    `base_url = "${safeBaseUrl}"`,
    ''
  ].join('\n');
}

const SENSITIVE_CONFIG_KEY_PATTERN = /^(\s*)(api_key|access_token|refresh_token|client_secret|secret|password)(\s*=\s*)(.*?)(\s*)$/i;

function sanitizeKimiConfigToml(rawConfig) {
  return String(rawConfig || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(SENSITIVE_CONFIG_KEY_PATTERN);
      if (!match) return line;
      return `${match[1]}${match[2]}${match[3]}""${match[5]}`;
    })
    .join('\n');
}

function isRegularFile(fs, filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT') ? false : false;
  }
}

function writeAtomic(fs, path, filePath, content) {
  const tempPath = `${filePath}.aih-tmp-${process.pid}-${Date.now()}`;
  let renamed = false;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(tempPath, 0o600); } catch (_error) {}
    }
    fs.renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tempPath); } catch (_error) {}
    }
  }
  if (typeof fs.chmodSync === 'function') {
    try { fs.chmodSync(filePath, 0o600); } catch (_error) {}
  }
  return path;
}

function createProjectionPathSymlinkError(filePath) {
  const error = new Error('provider_projection_path_symlink');
  error.code = 'provider_projection_path_symlink';
  error.path = filePath;
  return error;
}

function ensureProjectionDirectory(fs, directoryPath) {
  let stat = null;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat && stat.isSymbolicLink()) {
    throw createProjectionPathSymlinkError(directoryPath);
  }
  if (stat && !stat.isDirectory()) {
    throw new Error('kimi_projection_directory_not_directory');
  }
  if (!stat) fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const nextStat = fs.lstatSync(directoryPath);
  if (nextStat.isSymbolicLink()) {
    throw createProjectionPathSymlinkError(directoryPath);
  }
  if (!nextStat.isDirectory()) {
    throw new Error('kimi_projection_directory_not_directory');
  }
  if (typeof fs.chmodSync === 'function') {
    try { fs.chmodSync(directoryPath, 0o700); } catch (_error) {}
  }
}

function prepareKimiConfig(ctx = {}) {
  const fs = ctx.fs;
  const path = ctx.path;
  const sandboxDir = String(ctx.sandboxDir || '').trim();
  const hostHomeDir = String(ctx.hostHomeDir || '').trim();
  if (!fs || !path || !sandboxDir) return { prepared: false, reason: 'invalid_context' };

  const projectionHome = path.join(sandboxDir, '.kimi-code');
  const configPath = path.join(projectionHome, 'config.toml');
  const hostConfigPath = hostHomeDir
    ? path.join(hostHomeDir, '.kimi-code', 'config.toml')
    : '';

  // relay（钉账号 OAuth relay 或裸网关 profile）用独立精简模板；直连账号
  // （API key / 登录态）维持原模板。relay 的 base_url 取本次启动注入的网关
  // env（含实际端口），缺省回落 DEFAULT_KIMI_RELAY_BASE_URL。
  const useRelayTemplate = ctx.authRelayed === true || ctx.gateway === true;
  const relayConfigContent = useRelayTemplate
    ? buildKimiRelayConfig(ctx.baseEnv && ctx.baseEnv.KIMI_BASE_URL)
    : '';

  ensureProjectionDirectory(fs, projectionHome);

  let configStat = null;
  try {
    configStat = fs.lstatSync(configPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (configStat && configStat.isSymbolicLink()) {
    throw createProjectionPathSymlinkError(configPath);
  }
  if (configStat && !configStat.isFile()) {
    throw new Error('kimi_projection_config_not_file');
  }

  if (configStat && configStat.size > 0) {
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(configPath, 0o600); } catch (_error) {}
    }
    // relay 模式下，历史遗留的「默认直连模板」直接升级为 relay 模板（该文件
    // 是 aih 生成的样板，无用户定制）；定制过的配置保持原样。
    if (useRelayTemplate) {
      const existing = String(fs.readFileSync(configPath, 'utf8') || '');
      if (existing.trim() === DEFAULT_KIMI_CONFIG.trim()) {
        writeAtomic(fs, path, configPath, relayConfigContent);
        return { prepared: true, created: false, source: 'relay-upgrade', configPath };
      }
    }
    return { prepared: true, created: false, source: 'projection', configPath };
  }

  let source = '';
  // relay 模式不继承宿主配置：宿主 config.toml 里的 oauth 块与直连 base_url
  // 都会旁路网关。
  if (!useRelayTemplate
    && hostConfigPath && hostConfigPath !== configPath && isRegularFile(fs, hostConfigPath)) {
    source = sanitizeKimiConfigToml(fs.readFileSync(hostConfigPath, 'utf8'));
  }
  const content = useRelayTemplate
    ? relayConfigContent
    : (source.trim() ? `${source.replace(/\s+$/, '')}\n` : DEFAULT_KIMI_CONFIG);
  writeAtomic(fs, path, configPath, content);
  return {
    prepared: true,
    created: true,
    source: source.trim() ? 'host' : 'default',
    configPath
  };
}

function prepare(ctx) {
  return prepareKimiConfig(ctx);
}

module.exports = {
  DEFAULT_KIMI_CONFIG,
  DEFAULT_KIMI_RELAY_BASE_URL,
  buildKimiRelayConfig,
  prepare,
  prepareKimiConfig,
  sanitizeKimiConfigToml
};
