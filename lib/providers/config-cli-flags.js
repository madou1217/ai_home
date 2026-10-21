'use strict';

// 配置字段 → CLI 等价参数的推导（唯一事实源）。
//
// 原则：**只认 CLI 自己的 `--help` 里确实出现过的长旗标**。
// 字段键名换成 kebab-case 得到候选旗标，候选在 help 文本里找不到就不给等价用法 ——
// 宁可什么都不说，也不猜一个不存在的参数（猜错的代价是用户照着敲一遍才报错）。
//
// `--help` 输出按「二进制路径 + mtime + size」缓存，CLI 升级后自动失效。
// 这里不做 provider 名判断：少数「配置键名 ≠ 旗标名」的差异放在 FIELD_FLAG_HINTS 里，
// 并且**仍然要过 help 存在性检查**，所以不会因为 CLI 改名而留下失效示例。

const nodeFs = require('node:fs');
const { spawnSync: systemSpawnSync } = require('node:child_process');

const HELP_TIMEOUT_MS = 5000;
const HELP_CACHE_TTL_MS = 10 * 60 * 1000;
const FLAG_TOKEN_RE = /--[a-zA-Z][a-zA-Z0-9-]*/g;

// 已核实的「配置键 → 旗标名」差异。键是字段路径的叶子名（小写、下划线形式）。
const FIELD_FLAG_HINTS = Object.freeze({
  codex: Object.freeze({
    approval_policy: '--ask-for-approval',
    sandbox_mode: '--sandbox'
  }),
  claude: Object.freeze({
    defaultmode: '--permission-mode'
  })
});

const helpCache = new Map();

function leafKey(fieldPath) {
  const parts = String(fieldPath || '').split('.').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function stripKeyDecorations(key) {
  return String(key || '').replace(/^["'[]+|["'\]]+$/g, '').trim();
}

function toKebab(key) {
  return stripKeyDecorations(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

/** 该字段可能对应的 CLI 旗标候选（按可信度排序）。 */
function candidateFlags(providerRaw, fieldPath) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  const leaf = leafKey(fieldPath);
  const normalizedLeaf = leaf.toLowerCase();
  const hints = FIELD_FLAG_HINTS[provider] || {};
  const candidates = [];
  // 已核实的映射优先且唯一：它是人工核对过的结论，不再参与键名推导。
  if (hints[normalizedLeaf]) return [hints[normalizedLeaf]];
  const kebab = toKebab(leaf);
  if (kebab) {
    candidates.push(`--${kebab}`);
    // `sandbox_mode` → `--sandbox-mode`（多数 CLI 没有这个旗标），再退回 `--sandbox`
    const trimmed = kebab.replace(/-(mode|policy|permissions?|enabled|type)$/, '');
    if (trimmed && trimmed !== kebab) candidates.push(`--${trimmed}`);
  }
  return [...new Set(candidates.filter((item) => item.length > 2))];
}

function collectHelpFlags(helpText) {
  const text = String(helpText || '');
  const flags = new Set();
  let match;
  FLAG_TOKEN_RE.lastIndex = 0;
  while ((match = FLAG_TOKEN_RE.exec(text))) {
    flags.add(match[0]);
  }
  return flags;
}

function runHelp(binary, options = {}) {
  const spawnSync = options.spawnSync || systemSpawnSync;
  const platform = String(options.platform || process.platform);
  const spawnOptions = {
    encoding: 'utf8',
    timeout: HELP_TIMEOUT_MS,
    windowsHide: true,
    env: options.env || process.env
  };
  if (platform === 'win32') {
    // Windows 上的 npm 垫片是 .cmd，直接 spawn 会 EINVAL（CVE-2024-27980 防护）；
    // 复用 pty-launch 的解析结果（node 垫片直连 / 其余走 cmd 包装 + verbatim）。
    try {
      // eslint-disable-next-line global-require
      const { resolveWindowsUpstreamSpawn } = require('../../runtime/pty-launch');
      const launch = resolveWindowsUpstreamSpawn(binary, ['--help'], {
        platform,
        env: spawnOptions.env
      });
      if (launch && launch.command) {
        return spawnSync(launch.command, launch.args, {
          ...spawnOptions,
          windowsVerbatimArguments: Boolean(launch.windowsVerbatimArguments)
        });
      }
    } catch (_error) {
      // 解析失败时退回直接 spawn：取不到 help 只是少一段增强信息。
    }
  }
  return spawnSync(binary, ['--help'], spawnOptions);
}

/**
 * 读取某个二进制的 `--help` 输出（带缓存）。失败一律返回空结果：等价用法是增强信息，
 * 取不到就不显示，绝不让它影响配置文件的读取。
 *
 * 返回 `{ text, command }`，`command` 是用户实际敲的命令名（二进制 basename），
 * 这样示例里不会出现宿主绝对路径。
 */
function readCliHelp(providerRaw, options = {}) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  const fs = options.fs || nodeFs;
  let binary = '';
  try {
    binary = String(typeof options.resolveBinary === 'function' ? options.resolveBinary(provider) : '').trim();
  } catch (_error) {
    binary = '';
  }
  if (!binary) return { text: '', command: '' };
  const command = String(require('node:path').basename(binary)).replace(/\.(exe|cmd|bat)$/i, '');
  let signature = binary;
  try {
    const stat = fs.statSync(binary);
    signature = `${binary}|${stat.mtimeMs}|${stat.size}`;
  } catch (_error) {
    // 取不到 stat 时只用路径做键：help 输出仍然会被 TTL 兜住。
  }
  const cached = helpCache.get(signature);
  if (cached && Date.now() - cached.at < HELP_CACHE_TTL_MS) {
    return { text: cached.text, command };
  }
  let text = '';
  try {
    const result = runHelp(binary, options);
    text = `${String(result && result.stdout || '')}\n${String(result && result.stderr || '')}`;
  } catch (_error) {
    text = '';
  }
  helpCache.set(signature, { at: Date.now(), text });
  return { text, command };
}

/**
 * 给 schema 字段补上 CLI 等价用法。
 *
 * 返回 `{ [fieldPath]: { flag, sample } }`，只包含**在 help 里验证过**的字段。
 * `sample` 是可直接复制的命令，例如 `codex --model <model>`。
 */
function buildFieldCliEquivalents(providerRaw, fields, helpText, executable) {
  const flags = collectHelpFlags(helpText);
  if (!flags.size) return {};
  const command = String(executable || '').trim() || String(providerRaw || '').trim();
  const result = {};
  for (const field of fields || []) {
    const path = String(field && field.path || '').trim();
    if (!path) continue;
    const flag = candidateFlags(providerRaw, path).find((item) => flags.has(item));
    if (!flag) continue;
    const leaf = toKebab(leafKey(path)) || 'value';
    result[path] = {
      flag,
      sample: [command, flag, `<${leaf}>`].filter(Boolean).join(' ')
    };
  }
  return result;
}

function resetCliHelpCache() {
  helpCache.clear();
}

module.exports = {
  FIELD_FLAG_HINTS,
  buildFieldCliEquivalents,
  candidateFlags,
  collectHelpFlags,
  readCliHelp,
  resetCliHelpCache
};
