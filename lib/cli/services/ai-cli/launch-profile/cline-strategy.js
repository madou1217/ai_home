'use strict';

/**
 * Cline CLI（`cline`，bun 单文件分发）的启动隔离。
 *
 * CLI 的配置根与本地状态根各有一个 env 开关（与 `--config` / `--data-dir` 同义）：
 *
 *   CLINE_DIR      配置根（默认 ~/.cline：CA bundle、hooks、worktrees 都在它下面）
 *   CLINE_DATA_DIR 本地状态根（默认 <CLINE_DIR>/data：settings/providers.json、
 *                  secrets.json、sessions、db、logs 都在它下面）
 *
 * 两者都钉进账号沙箱，于是 HOME 保持宿主真实值（与 kiro / codebuddy 同构）：账号之间
 * 只有 cline 自己的配置与本地状态不同。
 *
 * **会话历史例外（2026-10-15）**：会话不属于账号——宿主 `cline /history` 与
 * `aih cline` 必须看到同一批会话。因此 `data/sessions`、`data/db/sessions.db`、
 * `data/db/session-search.db`、`data/checkpoint-scratch` 由
 * `cline-shared-session-store` 链回宿主 `~/.cline`；凭据（`data/settings/providers.json`、
 * `data/secrets.json`）与缓存/日志仍留在投影里。见
 * launch-profile/cline-shared-session-store.js。
 *
 * 2026-10-14 在本机实测：CLINE_DIR 决定 `cli-node-extra-ca-certs.pem` 的落点，
 * CLINE_DATA_DIR 决定 `data/settings`、`data/cache`、`data/logs` 的落点。
 *
 * 交互形态由 CLI 自己的 argv 决定，不需要注入参数：裸 `cline` 打开 TUI（非 TTY 下报
 * "interactive mode requires a TTY"），位置参数即一次性 prompt，`-i/--tui` 显式进 TUI。
 *
 * **网关 profile（2026-11-01）**：裸 `aih cline` 不指定账号时用 AIH Server 当账号。
 * cline 没有「推理端点由 env 决定」的开关（CLINE_API_BASE_URL 只改 Cline 自己的控制面），
 * 端点来自 providers.json 的槽位，所以网关 profile 是配置注入而不是 env 注入：把
 * openai-compatible 槽位写进账号沙箱的 providers.json，并推导 `-P openai-compatible`。
 * 模型来自运行时模型缓存（网关探测上游后写入）；缓存为空就不带 `-m`，不猜型号。
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

const {
  CLINE_PASS_PROVIDER_ID,
  selectClineOAuthCredential
} = require('../../../../account/cline-credentials');
const { ensureClineSharedSessionState } = require('./cline-shared-session-store');
const { readClineGatewayField } = require('../cline-gateway-context');
const { pickPreferredClaudeModel } = require('./opencode-gateway-default-model');
const { resolveHealthyGatewayModels } = require('./opencode-strategy');

/**
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 */
function prepare(ctx) {
  const { fs, sandboxDir, path } = ctx || {};
  if (!fs || !sandboxDir || !path || typeof fs.mkdirSync !== 'function') return;
  // 首次登录（登录投影）与普通启动都要先有配置根，否则 CLI 会把 CA bundle 写到宿主。
  fs.mkdirSync(path.join(sandboxDir, '.cline'), { recursive: true, mode: 0o700 });
  // 会话历史链回宿主同一份（best-effort，绝不抛出）：宿主 `cline /history` 与
  // `aih cline` 因此看到同一批会话；凭据/配置仍留在账号投影里。
  ensureClineSharedSessionState({
    fs,
    path,
    sandboxDir,
    hostHomeDir: ctx && ctx.hostHomeDir
  });
  // 网关 profile：把 AIH 网关写成 openai-compatible 槽位。放在最后，是在
  // materializeProviderAuth 投影完账号凭据之后合并（不覆盖其它槽位）。
  const gateway = resolveGatewayProfile(ctx);
  if (gateway) writeGatewayProviderSlot(ctx, gateway);
}

const PROVIDERS_DOCUMENT_RELATIVE_PATH = Object.freeze(['.cline', 'data', 'settings', 'providers.json']);
// 网关 profile 写的槽位：cline 内置的 OpenAI 兼容 provider。选择它的理由是本机实测
// （cline 3.0.74）：该槽位把 baseUrl 当推理端点直连，请求形如
// POST {baseUrl}/chat/completions + Authorization: Bearer <槽位 apiKey>，
// 而 cline / cline-pass 两个槽位的端点固定写死在 CLI 里（不可由 env 改）。
const GATEWAY_PROVIDER_ID = 'openai-compatible';

function hasExplicitProviderFlag(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return list.some((arg) => {
    const value = String(arg || '').trim();
    return value === '-P' || value === '--provider' || value.startsWith('--provider=');
  });
}

/**
 * 槽位推导（**这是 Cline Pass 账号能直接用起来的关键**）。
 *
 * Cline CLI 的 provider 默认值是 `cline`，走的是 **Cline Credits** 通道；Cline Pass 订阅的
 * 凭据落在 `cline-pass` 槽位。不显式指定槽位时，订阅账号会先要求设备码登录、然后报
 * `Insufficient balance. Your Cline Credits balance is $0.00`（2026-10-15 本机实测：
 * 不带 `-P` 必失败，`-P cline-pass` 正常返回）。
 *
 * 因此：投影文档里 `cline-pass` 槽位有可用 OAuth 凭据就用 `cline-pass`；
 * API Key / 普通 cline 账号保持默认（它们本来就走 `cline` 槽位，返回 ''）。
 *
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 * @returns {string} 槽位 id（'' = CLI 默认 `cline` 槽位）
 */
function resolveProviderSlot(ctx = {}) {
  const { fs, sandboxDir, path } = ctx;
  if (!fs || !sandboxDir || !path || typeof fs.readFileSync !== 'function') return '';
  const documentPath = path.join(sandboxDir, ...PROVIDERS_DOCUMENT_RELATIVE_PATH);
  let document = null;
  try {
    document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  } catch (_error) {
    return '';
  }
  if (!document || typeof document !== 'object' || !document.providers) return '';
  const passCredential = selectClineOAuthCredential({
    providers: { [CLINE_PASS_PROVIDER_ID]: document.providers[CLINE_PASS_PROVIDER_ID] }
  });
  return passCredential ? CLINE_PASS_PROVIDER_ID : '';
}

/**
 * `-P/--provider` 参数形态：槽位解析见 resolveProviderSlot；用户自己传了
 * `-P/--provider` 时不覆盖。
 *
 * @param {SandboxLaunchContext & {fs?: any, argv?: string[]}} ctx
 * @returns {string[]} 追加到 argv 前面的参数
 */
function buildLaunchArgs(ctx = {}) {
  if (hasExplicitProviderFlag(ctx.argv)) return [];
  // 网关 profile 优先于账号槽位推导：它没有 cline 账号，用 cline-pass 槽位启动
  // 只会要求设备码登录，然后用 Cline 自己的额度跑。
  const gateway = resolveGatewayProfile(ctx);
  if (gateway) {
    const args = ['-P', GATEWAY_PROVIDER_ID];
    // 模型必须显式给：openai-compatible 槽位缺 model 时 CLI 回落到自己的
    // models.dev 默认值（实测 gpt-4o），那是个 AIH 网关不认识的模型名。
    if (gateway.model) args.push('-m', gateway.model);
    return args;
  }
  const slot = resolveProviderSlot(ctx);
  return slot ? ['-P', slot] : [];
}

/**
 * ACP 模式的认证方法（`authenticate {methodId}`）：与 `-P/--provider` 是同一份槽位推导 ——
 * ACP 实测忽略 `-P`（槽位要经 authenticate 表达，见 lib/server/acp-session-runner.js 头注释）。
 * 无 cline-pass 凭据时返回 ''（不调 authenticate，与 CLI 默认 `cline` 槽位对齐）。
 *
 * @param {SandboxLaunchContext & {fs?: any}} ctx
 * @returns {string}
 */
function resolveAcpAuthMethod(ctx = {}) {
  // 网关 profile 不走 Cline 账号（也没有 authenticate 可做）：槽位由
  // providers.json 直接给出，这里返回 '' 表示不发起认证。
  if (resolveGatewayProfile(ctx)) return '';
  return resolveProviderSlot(ctx);
}

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, path } = ctx || {};
  const set = {};
  if (sandboxDir && path) {
    const configDir = path.join(sandboxDir, '.cline');
    set.CLINE_DIR = configDir;
    set.CLINE_DATA_DIR = path.join(configDir, 'data');
  }
  return { set, unset: [] };
}

// ---- 网关 profile（裸 `aih cline` 走 AIH Server） -------------------------
//
// 连接参数经 CliRelayProfile 的 buildGatewayProfileEnv 以 AIH_CLINE_GATEWAY 传进来
// （k=v 逗号分隔，见 ../cline-gateway-context）。本模块负责把它落成 cline 认识的形态：
//
//   <CLINE_DIR>/data/settings/providers.json
//     providers['openai-compatible'].settings = { provider, apiKey, baseUrl, model }
//   launch argv 补 -P openai-compatible [-m <model>]
//
// 模型只从运行时模型缓存里挑（网关探测上游后写入），不写死、也不回落到
// models.dev 的默认值——缓存为空时宁可不带 -m，让用户自己指定。

/** 从上下文 env 解析网关 profile；没有 AIH_CLINE_GATEWAY 时返回 null。 */
function resolveGatewayProfile(ctx = {}) {
  const env = (ctx && ctx.baseEnv) || {};
  const baseUrl = String(readClineGatewayField(env, 'baseUrl')).trim();
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: String(readClineGatewayField(env, 'apiKey')).trim() || 'dummy',
    model: resolveGatewayModel(ctx)
  };
}

// 默认模型挑选规则的唯一实现在 opencode-gateway-default-model（家族优先 + 版本号最大）；
// 这里的入参是「网关当前确实有的模型」，列表为空就不给 -m。
function pickGatewayModel(names) {
  return String(pickPreferredClaudeModel(names) || '').trim();
}

function resolveGatewayModel(ctx = {}) {
  try {
    return pickGatewayModel(resolveHealthyGatewayModels(ctx));
  } catch (_error) {
    return '';
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readProvidersDocument(fs, documentPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 合并写入网关槽位（不覆盖账号凭据槽位 cline / cline-pass）。
 * 内容没变时不落盘：同一账号会反复启动，不必每次都改 mtime。
 */
function writeGatewayProviderSlot(ctx = {}, gateway = {}) {
  const { fs, sandboxDir, path } = ctx || {};
  if (!fs || !sandboxDir || !path || typeof fs.writeFileSync !== 'function') return false;
  if (!gateway || !gateway.baseUrl) return false;
  const documentPath = path.join(sandboxDir, ...PROVIDERS_DOCUMENT_RELATIVE_PATH);
  const current = readProvidersDocument(fs, documentPath);
  const providers = isPlainObject(current && current.providers) ? current.providers : {};
  const settings = {
    provider: GATEWAY_PROVIDER_ID,
    apiKey: gateway.apiKey,
    baseUrl: gateway.baseUrl
  };
  if (gateway.model) settings.model = gateway.model;
  const previous = providers[GATEWAY_PROVIDER_ID];
  const unchanged = isPlainObject(previous)
    && isPlainObject(previous.settings)
    && previous.settings.provider === settings.provider
    && previous.settings.apiKey === settings.apiKey
    && previous.settings.baseUrl === settings.baseUrl
    && previous.settings.model === settings.model
    && (current.lastUsedProvider === GATEWAY_PROVIDER_ID);
  if (unchanged) return false;
  const next = {
    ...(current || {}),
    version: current && typeof current.version === 'number' ? current.version : 1,
    modes: isPlainObject(current && current.modes) ? current.modes : {},
    lastUsedProvider: GATEWAY_PROVIDER_ID,
    providers: {
      ...providers,
      [GATEWAY_PROVIDER_ID]: {
        settings,
        updatedAt: new Date().toISOString(),
        tokenSource: 'manual'
      }
    }
  };
  fs.mkdirSync(path.dirname(documentPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(documentPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return true;
}

const clineStrategy = Object.freeze({
  name: 'cline-config-dir',
  prepare,
  buildEnvPatch,
  // 启动参数整形（槽位推导）：见 buildLaunchArgs 的注释。
  buildLaunchArgs,
  // ACP 认证方法（槽位推导复用）：见 resolveAcpAuthMethod 的注释。
  resolveAcpAuthMethod
});

module.exports = {
  clineStrategy,
  GATEWAY_PROVIDER_ID,
  prepare,
  buildEnvPatch,
  buildLaunchArgs,
  resolveAcpAuthMethod,
  pickGatewayModel,
  resolveGatewayProfile,
  resolveProviderSlot,
  writeGatewayProviderSlot
};
