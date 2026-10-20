'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { isAccountRef } = require('../../../server/account-ref-store');
const { CLAUDE_LAUNCH_SETTINGS_RETENTION_MS } = require('../../config/constants');
const { ROUTE_OWNER_HEADER, ROUTE_OWNER_NODE } = require('../../../protocol/route-owner-header');

const PINNED_ACCOUNT_HEADER = 'x-account-ref';

// OAuth 与 API key 账号都经网关钉选 relay，用量与可用率才能统一记账。API key 账号设为
// 宿主默认时同样写成钉选 relay（host-sync）；只有 OAuth 宿主默认投射原生登录态直连。
function shouldRelayClaudeAccount(input = {}) {
  return String(input.provider || '').trim().toLowerCase() === 'claude'
    && isAccountRef(String(input.accountRef || '').trim())
    && input.isLogin !== true
    && input.gateway !== true;
}

function buildClaudeAccountRelayEnv(gatewayEnv = {}, accountRef, options = {}) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) {
    throw new Error('invalid_claude_relay_account_ref');
  }
  const existingHeaders = String(gatewayEnv.ANTHROPIC_CUSTOM_HEADERS || '').trim();
  const pinHeader = `${PINNED_ACCOUNT_HEADER}: ${normalizedRef}`;
  // 跨 Provider harness：模型不属于 Claude 的协议族，Go Core 上同一入口的协议桥
  // 尚未对齐（返回 200 但长时间不结束），因此显式要求 Node 完整实现这条请求。
  const routeOwnerHeader = options.crossProvider === true
    ? `${ROUTE_OWNER_HEADER}: ${ROUTE_OWNER_NODE}`
    : '';
  return {
    ...gatewayEnv,
    ANTHROPIC_CUSTOM_HEADERS: [existingHeaders, pinHeader, routeOwnerHeader].filter(Boolean).join('\n')
  };
}

function hasSettingsArg(args) {
  return (Array.isArray(args) ? args : [])
    .some((arg) => arg === '--settings' || String(arg).startsWith('--settings='));
}

// 两个凭据槽：x-api-key（ANTHROPIC_API_KEY）与 Authorization: Bearer（ANTHROPIC_AUTH_TOKEN）。
const CLAUDE_LAUNCH_CREDENTIAL_KEYS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const CLAUDE_LAUNCH_SETTINGS_DIR = path.join('run', 'claude-launch-settings');

function resolveClaudeLaunchSettingsDir(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? path.join(root, CLAUDE_LAUNCH_SETTINGS_DIR) : '';
}

const CLAUDE_LAUNCH_SETTINGS_FILE_PATTERN = /^claude-launch-[0-9a-f]{16}\.json$/;

// 清理过期的启动设置文件：文件名按内容哈希命名，密钥轮换后旧 key 的那份不会再被写到，
// 不清理就会无限期留在磁盘上。按「最后一次被写」计龄（同内容的启动会 rename 刷新 mtime），
// 超过保留期才删，正在运行的 Claude 会话用到的那份不会被删。清理失败不影响启动。
function pruneClaudeLaunchSettingsFiles(fs, settingsDir, keepPath, nowMs = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(settingsDir);
  } catch (_error) {
    return;
  }
  for (const name of names) {
    if (!CLAUDE_LAUNCH_SETTINGS_FILE_PATTERN.test(name)) continue;
    const filePath = path.join(settingsDir, name);
    if (filePath === keepPath) continue;
    try {
      const stat = fs.statSync(filePath);
      if (nowMs - Number(stat.mtimeMs) > CLAUDE_LAUNCH_SETTINGS_RETENTION_MS) fs.unlinkSync(filePath);
    } catch (_error) {
      // 并发启动可能已删掉它；忽略。
    }
  }
}

// 同目录临时文件 + rename 原子替换，权限 0600。文件名取内容哈希：同一份网关/账号组合
// 复用同一个文件（不随启动次数堆积），内容不同则互不覆盖（并发启动不同账号安全）。
function writeClaudeLaunchSettingsFile(fs, settingsDir, content) {
  fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const filePath = path.join(settingsDir, `claude-launch-${digest}.json`);
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (_cleanupError) {}
    throw error;
  }
  pruneClaudeLaunchSettingsFiles(fs, settingsDir, filePath);
  return filePath;
}

/**
 * aih 自己启动 Claude 时，把网关地址、钉选头与网关凭据经 --settings 再交一次：Claude Code
 * 会用 ~/.claude/settings.json 的 env 覆盖进程环境，而 --settings 的优先级高于它，宿主
 * settings.json 里手写的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 因此劫持不了 aih 的启动
 * （否则 Claude 会带着那份 Bearer 打到网关，网关 Bearer 优先 → 401 unauthorized_client）。
 *
 * 凭据只走文件：argv 对本机可见，密钥写进 `<aiHomeDir>/run/claude-launch-settings/` 下的
 * 0600 文件，argv 只带路径。启动环境里没有的那个凭据槽显式写成空串（Claude Code 2.1.302
 * 实测：--settings 的 "" 会压掉 settings.json 的同名变量，请求不再带该头）。拿不到存储
 * （未传 settingsDir 或写入失败）时退回不含密钥的内联 JSON（旧行为），绝不把密钥放进 argv。
 * 钉选头为空时同样写出，显式清掉宿主默认的钉选（不钉选 = AIH Server 账号池）。
 */
function buildClaudeLaunchSettingsArgs(launchEnv = {}, args = [], options = {}) {
  const baseUrl = String(launchEnv.ANTHROPIC_BASE_URL || '').trim();
  if (!baseUrl || hasSettingsArg(args)) return [];
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: String(launchEnv.ANTHROPIC_CUSTOM_HEADERS || '')
  };
  const credentials = Object.fromEntries(CLAUDE_LAUNCH_CREDENTIAL_KEYS
    .map((key) => [key, String(launchEnv[key] || '').trim()]));
  const hasCredential = Object.values(credentials).some(Boolean);
  const fsImpl = options.fs;
  const settingsDir = String(options.settingsDir || '').trim();
  if (hasCredential && fsImpl && settingsDir) {
    try {
      const content = `${JSON.stringify({ env: { ...env, ...credentials } }, null, 2)}\n`;
      return ['--settings', writeClaudeLaunchSettingsFile(fsImpl, settingsDir, content)];
    } catch (_error) {
      // 存储不可用时退回旧行为（不含密钥），启动不因此失败。
    }
  }
  return ['--settings', JSON.stringify({ env })];
}

module.exports = {
  CLAUDE_LAUNCH_CREDENTIAL_KEYS,
  PINNED_ACCOUNT_HEADER,
  buildClaudeAccountRelayEnv,
  buildClaudeLaunchSettingsArgs,
  pruneClaudeLaunchSettingsFiles,
  resolveClaudeLaunchSettingsDir,
  shouldRelayClaudeAccount
};
