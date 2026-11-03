'use strict';

const { AIH_CODEX_PROVIDER_NAME } = require('./codex-config-sync');

const PROVIDER_HEADER = /^\s*\[\s*model_providers\s*\.\s*(?:aih_server|"aih_server"|'aih_server')\s*(\.[^\]]+)?\s*\]\s*(?:#.*)?$/;
const NAME_KEY = /^\s*(?:name|"name"|'name')\s*=/;
const NAME_VALUE = /^(\s*(?:name|"name"|'name')\s*=\s*)("(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)$/;

// 忽略多行字符串里的配置示例，避免把 developer_instructions 当成 TOML 表修改。
function structuralLines(lines) {
  let multiline = '';
  return lines.map((line) => {
    const structural = !multiline;
    let quote = '';
    for (let index = 0; index < line.length; index += 1) {
      if ((multiline === '"""' || quote === '"') && line[index] === '\\') {
        index += 1;
      } else if (multiline) {
        if (line.startsWith(multiline, index)) { multiline = ''; index += 2; }
      } else if (quote) {
        if (line[index] === quote) quote = '';
      } else if (line[index] === '#') {
        break;
      } else if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        multiline = line.slice(index, index + 3);
        index += 2;
      } else if (line[index] === '"' || line[index] === "'") {
        quote = line[index];
      }
    }
    return structural;
  });
}

function hasEmptyName(line) {
  const match = line.match(NAME_VALUE);
  if (!match) return false;
  try {
    const value = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].slice(1, -1);
    return !value.trim();
  } catch (_error) {
    return false;
  }
}

function hasInlineProviderConfig(lines, structural) {
  let providerTable = false;
  return lines.some((line, index) => {
    if (!structural[index]) return false;
    if (/^\s*\[/.test(line)) {
      providerTable = /^\s*\[\s*model_providers\s*\]\s*(?:#.*)?$/.test(line);
      return false;
    }
    return /^\s*(?:model_providers|"model_providers"|'model_providers')\s*(?:\.|=)/.test(line)
      || (providerTable && /^\s*(?:aih_server|"aih_server"|'aih_server')\s*(?:\.|=)/.test(line));
  });
}

function healCodexProviderConfig(configText, options = {}) {
  const original = String(configText || '');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const structural = structuralLines(lines);
  const headers = lines.map((line, index) => structural[index] && line.match(PROVIDER_HEADER));
  const parent = headers.findIndex((match) => match && !match[1]);
  const nameLine = `name = "${AIH_CODEX_PROVIDER_NAME}"`;
  if (parent >= 0) {
    let end = parent + 1;
    while (end < lines.length && !(structural[end] && /^\s*\[/.test(lines[end]))) end += 1;
    const name = lines.findIndex((line, index) => index > parent && index < end
      && structural[index] && NAME_KEY.test(line));
    if (name >= 0) {
      if (!hasEmptyName(lines[name])) return { config: original, changed: false };
      lines[name] = lines[name].replace(NAME_VALUE, (_match, prefix, _value, suffix) => (
        `${prefix}"${AIH_CODEX_PROVIDER_NAME}"${suffix}`
      ));
    } else {
      lines.splice(parent + 1, 0, nameLine);
    }
  } else {
    const child = headers.findIndex(Boolean);
    if (child >= 0) {
      lines.splice(child, 0, '[model_providers.aih_server]', nameLine, '');
    } else if (options.missingProviderBlock && !hasInlineProviderConfig(lines, structural)) {
      // 只补确实缺失的受管表，不向用户的 inline/dotted TOML 写入重复定义。
      return { config: `${original.trimEnd()}${original.trim() ? newline + newline : ''}`
        + `${options.missingProviderBlock.replace(/\r?\n/g, newline)}${newline}`, changed: true };
    } else {
      return { config: original, changed: false };
    }
  }
  return { config: lines.join(newline), changed: true };
}

module.exports = { healCodexProviderConfig };
