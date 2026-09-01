'use strict';

const { claudeRelayProfile } = require('./claude-relay-profile');
const { codexRelayProfile } = require('./codex-relay-profile');
const { kimiRelayProfile } = require('./kimi-relay-profile');
const { opencodeRelayProfile } = require('./opencode-relay-profile');

/**
 * CliRelayProfile —— provider 网关 relay 策略接口（策略模式）。
 *
 * 每个支持网关 relay 的 provider 一个独立 profile 模块；运行时调用点
 * （pty-runtime-spawn / pty-runtime-launch / self-relay-account /
 * persistent-session-list）只依赖本注册表分发，不再散落
 * `provider === 'claude'` 式硬编码分支（OCP/DIP）。
 *
 * 契约（各 profile 必须遵守）：
 *
 * - provider: string
 *     provider id，与 provider-catalog 一致。
 *
 * - shouldRelayAccount(input): boolean
 *     判定一次「钉账号」启动是否经网关 relay。
 *     input: { provider, accountRef, accountEnv, isLogin, gateway }
 *     统一语义：provider 匹配 && accountRef 为持久 accountRef（拒绝可变
 *     cliAccountId）&& 非登录流程 && 非网关 profile && 账号无直连凭据。
 *     没有 env 注入式 account relay 形态的 provider（codex 走 args/config
 *     手术，见 codex-relay-profile 注释）恒返回 false。
 *
 * - buildAccountRelayEnv(gatewayEnv, accountRef): object
 *     relay 生效时构造子进程 env：网关 base env + `x-account-ref` 钉账号头
 *     （换行分隔的 `Name: value` 格式）。accountRef 非法必须抛错。
 *     当 shouldRelayAccount 恒 false 时可省略；注册表保证不会在
 *     shouldRelayAccount 为 false 时调用它。
 *
 * - buildGatewayProfileEnv(urls): object
 *     裸 `aih <provider>`（内置网关 profile）的客户端 env。
 *     urls: { apiKey, baseUrl, rootUrl } —— apiKey 已含 `|| 'dummy'` 兜底；
 *     baseUrl 带 `/v1`（OpenAI 形态），rootUrl 不带（Anthropic SDK 自行拼
 *     `/v1/messages`）。
 *
 * - relayKeepsAccountSandbox?: boolean
 *     relay 时是否保留账号沙箱目录。缺省/false（claude）：runtimeDir 回落到
 *     宿主 HOME，env 覆盖即可。kimi 为 true：relay 需要一份隔离的
 *     config.toml（去掉 oauth 块、base_url 指网关），写宿主真实
 *     ~/.kimi-code 会污染用户配置，且 oauth 块存在时 CLI 的 OAuth 优先于
 *     env 注入的 KIMI_API_KEY，relay 会被旁路。被跳过的只是 OAuth 凭据投影
 *     （authRelayed → requiresProviderAuthProjection 返回 false）。
 */

/** @type {Object<string, CliRelayProfile>} */
const RELAY_PROFILES = Object.freeze({
  claude: claudeRelayProfile,
  codex: codexRelayProfile,
  kimi: kimiRelayProfile,
  opencode: opencodeRelayProfile
});

/**
 * @param {string} provider
 * @returns {CliRelayProfile|null}
 */
function getCliRelayProfile(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return RELAY_PROFILES[normalized] || null;
}

module.exports = {
  RELAY_PROFILES,
  getCliRelayProfile
};
