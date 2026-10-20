'use strict';

// 把「最大权限」写入宿主 CLI 自己的配置文件。
//
// 只处理 `permission-profiles` 已登记、字段经真实 schema/真机验证的 provider。
// 写入复用 Provider 配置工作台的唯一写入口（校验 + 冲突检测 + 历史备份），
// 不直接 fs.write，避免绕过版本历史。

const {
  readConfigFile,
  saveConfigFile
} = require('./provider-config-manager');
const { resolvePermissionProfile } = require('../../../providers/permission-profiles');

const jsonc = require('jsonc-parser');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlLiteral(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return JSON.stringify(String(value));
}

// 顶层 TOML 键用文本替换，保留 codex 配置里的注释与其它段落。
function patchTomlTopLevel(content, patch) {
  const source = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  let tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (tableIndex < 0) tableIndex = lines.length;
  const inserts = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (key.includes('.')) throw new Error('nested_toml_permission_patch_unsupported');
    const matcher = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    let replaced = false;
    for (let index = 0; index < tableIndex; index += 1) {
      if (!matcher.test(lines[index])) continue;
      lines[index] = `${key} = ${tomlLiteral(value)}`;
      replaced = true;
      break;
    }
    if (!replaced) inserts.push(`${key} = ${tomlLiteral(value)}`);
  }
  if (inserts.length) lines.unshift(...inserts);
  return lines.join('\n');
}

function patchJson(content, patch) {
  const source = String(content == null ? '' : content).trim() ? String(content) : '{}';
  let next = source;
  for (const [path, value] of Object.entries(patch || {})) {
    const edits = jsonc.modify(next, path.split('.'), value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 }
    });
    next = jsonc.applyEdits(next, edits);
  }
  return next;
}

function buildHostPermissionContent(content, format, patch) {
  if (String(format || '').toLowerCase() === 'toml') return patchTomlTopLevel(content, patch);
  return patchJson(content, patch);
}

function describeHostPermissionTarget(provider, options = {}) {
  const profile = resolvePermissionProfile(provider);
  if (!profile.hostSupported) {
    return { supported: false, reason: 'host_profile_unsupported', profile };
  }
  const target = readConfigFile(profile.provider, profile.hostFileId, options);
  return {
    supported: true,
    provider: profile.provider,
    fileId: profile.hostFileId,
    displayPath: target.file.displayPath,
    exists: target.file.exists,
    writable: target.file.writable,
    requiresElevation: target.file.requiresElevation,
    profile
  };
}

function applyHostPermission(provider, options = {}) {
  const profile = resolvePermissionProfile(provider);
  if (!profile.hostSupported) {
    return {
      supported: false,
      applied: false,
      changed: false,
      reason: 'host_profile_unsupported'
    };
  }
  const detail = readConfigFile(profile.provider, profile.hostFileId, options);
  const content = buildHostPermissionContent(detail.content, detail.file.format, profile.hostPatch);
  if (content === detail.content) {
    return {
      supported: true,
      applied: true,
      changed: false,
      provider: profile.provider,
      fileId: profile.hostFileId,
      displayPath: detail.file.displayPath,
      revision: detail.revision
    };
  }
  const saved = saveConfigFile(profile.provider, profile.hostFileId, content, {
    ...options,
    expectedRevision: detail.revision,
    note: 'AIH：写入最大权限启动默认值'
  });
  return {
    supported: true,
    applied: true,
    changed: true,
    provider: profile.provider,
    fileId: profile.hostFileId,
    displayPath: detail.file.displayPath,
    revision: saved.revision
  };
}

module.exports = {
  applyHostPermission,
  buildHostPermissionContent,
  describeHostPermissionTarget,
  patchJson,
  patchTomlTopLevel
};
