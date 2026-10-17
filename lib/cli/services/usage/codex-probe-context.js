'use strict';

// codex 用量探测的测试/运维上下文（直连开关、base URL、rate-limit 路径）。
// 合并成一个环境变量，避免为每个调试旋钮新增 AIH_* 名字。
const CODEX_PROBE_ENV = 'AIH_CODEX_USAGE_PROBE';
const FIELD_ORDER = Object.freeze(['direct', 'baseUrl', 'path']);

function parseCodexProbeContext(value) {
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

function serializeCodexProbeContext(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readCodexProbeField(env, key, fallback = '') {
  const fields = parseCodexProbeContext(env && env[CODEX_PROBE_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  CODEX_PROBE_ENV,
  parseCodexProbeContext,
  serializeCodexProbeContext,
  readCodexProbeField
};
