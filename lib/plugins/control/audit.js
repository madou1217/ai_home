'use strict';

// 插件治理审计日志：安装、启用/停用、卸载、信任根变更、价格目录刷新都留一条。
//
// 只记录身份与授权事实（pluginId / version / digest / 签名状态 / 权限），
// **绝不记录配置值、secrets 或凭据正文**。文件 0600，单文件超过 8MB 轮转为 .1。

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_FILE = 'audit.log';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_READ = 1000;

function auditPath(aiHomeDir) {
  return path.join(String(aiHomeDir || ''), 'plugins', AUDIT_FILE);
}

function createPluginAuditLog(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const file = auditPath(aiHomeDir);

  function append(event, details = {}) {
    if (!aiHomeDir) return null;
    const record = {
      at: new Date(now()).toISOString(),
      event: String(event || '').trim(),
      ...details
    };
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        if (fsImpl.statSync(file).size >= MAX_BYTES) fsImpl.renameSync(file, `${file}.1`);
      } catch (_error) { /* 文件不存在是正常起点 */ }
      fsImpl.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      try { fsImpl.chmodSync(file, 0o600); } catch (_error) { /* Windows 上可能不支持 */ }
      return record;
    } catch (_error) {
      // 审计写失败不能反向阻断控制面操作（操作本身已经落库）；doctor 读不到会显现。
      return null;
    }
  }

  function read(options = {}) {
    const limit = Math.max(1, Math.min(MAX_READ, Number(options.limit) || 100));
    if (!aiHomeDir || !fsImpl.existsSync(file)) return [];
    const lines = fsImpl.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch (_error) { return { at: '', event: 'audit_record_invalid' }; }
    });
  }

  return { append, read, file, path: file };
}

module.exports = { AUDIT_FILE, auditPath, createPluginAuditLog };
