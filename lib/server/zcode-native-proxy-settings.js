'use strict';

// ZCode Desktop 的原生代理设置适配器。
//
// 真实客户端按 HOME/.zcode/v2/setting.json 读取 httpProxy / httpProxyNoProxy；
// 具体合并与托管标记逻辑由本模块集中处理，启动策略只调用这一入口。

const nodePath = require('node:path');

const {
  DEFAULT_NO_PROXY,
  toZcodeProxyUrl
} = require('./zcode-native-proxy-values');

const MANAGED_PROXY_MARKER_VERSION = 1;
const MANAGED_PROXY_MARKER_FILE = '.aih-zcode-egress.json';
const UNRECOGNIZED_MARKER_ERROR = 'zcode_native_proxy_marker_unrecognized';
const UNRECOGNIZED_MARKER_WARNING =
  '无法识别 ZCode 出口 marker；本次保留现有原生设置，账号出口变更未应用';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function resolveZcodeNativeProxyPaths(profileDir, pathImpl = nodePath) {
  const root = String(profileDir || '').trim();
  return {
    settingsPath: pathImpl.join(root, '.zcode', 'v2', 'setting.json'),
    markerPath: pathImpl.join(root, MANAGED_PROXY_MARKER_FILE)
  };
}

function readJsonObject(fsImpl, filePath) {
  if (!fsImpl.existsSync(filePath)) return {};
  const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  if (!isPlainObject(parsed)) throw new Error('zcode_native_settings_not_object');
  return parsed;
}

function writeJsonAtomic(fsImpl, pathImpl, filePath, value) {
  fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.aih-${process.pid}-${Date.now()}.tmp`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    fsImpl.renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(tempPath); } catch (_error) {}
    }
  }
}

function unlinkIfExists(fsImpl, filePath) {
  if (fsImpl.existsSync(filePath)) fsImpl.unlinkSync(filePath);
}

function buildUnrecognizedMarkerResult(paths) {
  return {
    ready: false,
    status: 'preserved_unrecognized_marker',
    error: UNRECOGNIZED_MARKER_ERROR,
    reason: UNRECOGNIZED_MARKER_WARNING,
    egressApplied: false,
    egressWarning: UNRECOGNIZED_MARKER_WARNING,
    ...paths
  };
}

function normalizeManagedProxyPair(raw) {
  if (!isPlainObject(raw)) return null;
  const httpProxy = typeof raw.httpProxy === 'string' ? raw.httpProxy.trim() : '';
  const httpProxyNoProxy = typeof raw.httpProxyNoProxy === 'string'
    ? raw.httpProxyNoProxy.trim()
    : '';
  return httpProxy ? { httpProxy, httpProxyNoProxy } : null;
}

function captureRestorableProxySettings(settings) {
  const restore = {};
  for (const key of ['httpProxy', 'httpProxyNoProxy']) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) restore[key] = settings[key];
  }
  return restore;
}

function readRestorableProxySettings(raw) {
  if (!isPlainObject(raw)) return null;
  return captureRestorableProxySettings(raw);
}

function buildRestorableProxySettings(settings, previousMarker) {
  const restore = {};
  for (const key of ['httpProxy', 'httpProxyNoProxy']) {
    const stillManaged = previousMarker
      && previousMarker.owned.some((candidate) => settings[key] === candidate[key]);
    const source = stillManaged ? previousMarker.restore : settings;
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      restore[key] = source[key];
    }
  }
  return restore;
}

function readManagedProxyMarker(fsImpl, markerPath) {
  let raw;
  try {
    raw = readJsonObject(fsImpl, markerPath);
  } catch (_error) {
    return null;
  }
  if (raw.version !== MANAGED_PROXY_MARKER_VERSION) return null;
  const current = normalizeManagedProxyPair(raw);
  if (!current) return null;
  const previousValues = Array.isArray(raw.previous)
    ? raw.previous
    : (raw.previous ? [raw.previous] : []);
  const owned = [current];
  const seen = new Set([`${current.httpProxy}\n${current.httpProxyNoProxy}`]);
  for (const candidate of previousValues) {
    const normalized = normalizeManagedProxyPair(candidate);
    if (!normalized) continue;
    const key = `${normalized.httpProxy}\n${normalized.httpProxyNoProxy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    owned.push(normalized);
  }
  return {
    current,
    owned,
    restore: readRestorableProxySettings(raw.restore)
  };
}

function buildManagedProxyMarker(httpProxy, httpProxyNoProxy, settings, previousMarker) {
  const currentKey = `${httpProxy}\n${httpProxyNoProxy}`;
  const previous = previousMarker
    ? previousMarker.owned
      .filter((candidate) => `${candidate.httpProxy}\n${candidate.httpProxyNoProxy}` !== currentKey)
      .slice(0, 8)
    : [];
  const restore = buildRestorableProxySettings(settings, previousMarker);
  return {
    version: MANAGED_PROXY_MARKER_VERSION,
    httpProxy,
    httpProxyNoProxy,
    restore,
    ...(previous.length > 0 ? { previous } : {})
  };
}

function releaseManagedProxySettings(fsImpl, pathImpl, paths) {
  if (!fsImpl.existsSync(paths.markerPath)) {
    return { ready: true, status: 'unchanged', ...paths };
  }
  const marker = readManagedProxyMarker(fsImpl, paths.markerPath);
  if (!marker) {
    // 未知版本或损坏 marker 不具备清理设置的权限，也不能被当前版本删除：保留它
    // 才能让创建该格式的版本或人工诊断继续判断所有权；重新绑定同样不得接管。
    return buildUnrecognizedMarkerResult(paths);
  }
  const settings = readJsonObject(fsImpl, paths.settingsPath);
  const next = { ...settings };
  let changed = false;
  for (const key of ['httpProxy', 'httpProxyNoProxy']) {
    if (marker.owned.some((candidate) => next[key] === candidate[key])) {
      if (marker.restore && Object.prototype.hasOwnProperty.call(marker.restore, key)) {
        next[key] = marker.restore[key];
      } else {
        delete next[key];
      }
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(fsImpl, pathImpl, paths.settingsPath, next);
  unlinkIfExists(fsImpl, paths.markerPath);
  return { ready: true, status: 'released', ...paths };
}

function prepareZcodeNativeProxySettings(input = {}) {
  const fsImpl = input.fs;
  const pathImpl = input.path || nodePath;
  const profileDir = String(input.profileDir || '').trim();
  if (!fsImpl || !profileDir) throw new Error('zcode_native_settings_context_missing');

  const paths = resolveZcodeNativeProxyPaths(profileDir, pathImpl);
  const markerExists = fsImpl.existsSync(paths.markerPath);
  const previousMarker = markerExists
    ? readManagedProxyMarker(fsImpl, paths.markerPath)
    : null;
  if (markerExists && !previousMarker) {
    // 当前版本无法证明 marker 中记录的字段所有权。无论解绑还是重新绑定都不能
    // 删除或覆盖它，否则可能吞掉未来版本/人工维护的恢复信息与原生代理设置。
    return buildUnrecognizedMarkerResult(paths);
  }
  const httpProxy = toZcodeProxyUrl(input.proxyServer);
  if (!httpProxy) return releaseManagedProxySettings(fsImpl, pathImpl, paths);

  const httpProxyNoProxy = String(input.noProxy || '').trim() || DEFAULT_NO_PROXY;
  const settings = readJsonObject(fsImpl, paths.settingsPath);
  const pendingMarker = buildManagedProxyMarker(
    httpProxy,
    httpProxyNoProxy,
    settings,
    previousMarker
  );
  // marker 必须先落盘：如果随后 setting.json 原子替换失败，下一次解绑仍能按精确值
  // 判断并安全收敛；反过来会留下没有所有权记录的 AIH 代理值。
  writeJsonAtomic(fsImpl, pathImpl, paths.markerPath, pendingMarker);
  writeJsonAtomic(fsImpl, pathImpl, paths.settingsPath, {
    ...settings,
    httpProxy,
    httpProxyNoProxy
  });
  if (pendingMarker.previous) {
    writeJsonAtomic(fsImpl, pathImpl, paths.markerPath, {
      version: MANAGED_PROXY_MARKER_VERSION,
      httpProxy,
      httpProxyNoProxy,
      restore: pendingMarker.restore
    });
  }
  return { ready: true, status: 'managed', ...paths };
}

module.exports = {
  MANAGED_PROXY_MARKER_FILE,
  MANAGED_PROXY_MARKER_VERSION,
  UNRECOGNIZED_MARKER_ERROR,
  prepareZcodeNativeProxySettings,
  resolveZcodeNativeProxyPaths
};
