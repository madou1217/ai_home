'use strict';

// codex 启动/恢复的调试与行为开关，合并成一个环境变量：
//   authPreflight       '0' 跳过启动鉴权预检
//   autoSkipRepoCheck   '1' 跳过仓库信任检查
//   disableRemoteResume '1' 恢复会话时不走远端 app-server
//   tuiLocalRemote     '0' 关闭 codex TUI 的本地 app-server（退回原生进程内 TUI）
const CODEX_FLAGS_ENV = 'AIH_CODEX_FLAGS';
const FIELD_ORDER = Object.freeze(['authPreflight', 'autoSkipRepoCheck', 'disableRemoteResume', 'tuiLocalRemote']);

function parseCodexFlags(value) {
  const fields = {};
  for (const part of String(value || '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key || !raw) continue;
    try { fields[key] = decodeURIComponent(raw); } catch (_error) { fields[key] = raw; }
  }
  return fields;
}

function serializeCodexFlags(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readCodexFlag(env, key, fallback = '') {
  const fields = parseCodexFlags(env && env[CODEX_FLAGS_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

function setCodexFlag(env, key, value) {
  if (!env || !key || value === undefined || value === null || String(value) === '') return env;
  const fields = parseCodexFlags(env[CODEX_FLAGS_ENV]);
  fields[key] = String(value);
  env[CODEX_FLAGS_ENV] = serializeCodexFlags(fields);
  return env;
}

module.exports = {
  CODEX_FLAGS_ENV,
  parseCodexFlags,
  serializeCodexFlags,
  readCodexFlag,
  setCodexFlag
};
