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
    return { prepared: true, created: false, source: 'projection', configPath };
  }

  let source = '';
  if (hostConfigPath && hostConfigPath !== configPath && isRegularFile(fs, hostConfigPath)) {
    source = sanitizeKimiConfigToml(fs.readFileSync(hostConfigPath, 'utf8'));
  }
  const content = source.trim() ? `${source.replace(/\s+$/, '')}\n` : DEFAULT_KIMI_CONFIG;
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
  prepare,
  prepareKimiConfig,
  sanitizeKimiConfigToml
};
