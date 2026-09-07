'use strict';

const AIH_CODEX_PROVIDER_KEY = 'aih_server';
const CONFIG_SCOPED_SUBCOMMANDS = new Set(['exec', 'resume', 'app-server']);
const CODEX_STARTUP_POLICY_CONFIGS = Object.freeze([
  'suppress_unstable_features_warning=true',
  'check_for_update_on_startup=false'
]);

function buildCodexStartupPolicyArgs() {
  return CODEX_STARTUP_POLICY_CONFIGS.flatMap((value) => ['-c', value]);
}

function buildCodexProviderArgs(env = {}, options = {}) {
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  const configuredBaseUrl = String(env.OPENAI_BASE_URL || '').trim();
  if (!apiKey && !configuredBaseUrl && options.force !== true) return [];

  const providerKey = String(options.providerKey || AIH_CODEX_PROVIDER_KEY).trim();
  // 这些值会作为 -c key=value 传给 codex。Windows 上该命令经 buildPtyLaunch 的
  // cmd.exe 包装（node-pty 会把 " 转义成 \"，cmd.exe 不认识 \"），所以这里
  // 不允许出现引号或空格：provider 显示名（name = "AIH Server"）由
  // codex-config-sync 写入沙箱 config.toml，不经命令行传递。
  const configValues = [
    ...CODEX_STARTUP_POLICY_CONFIGS,
    `model_provider=${providerKey}`,
    // 未显式提供地址时沿用同步后的受管配置，避免 CLI 参数把网关覆盖为官方地址。
    ...(configuredBaseUrl ? [`model_providers.${providerKey}.base_url=${configuredBaseUrl}`] : []),
    `model_providers.${providerKey}.wire_api=responses`
  ];
  const gatewayAccountRef = String(env.AIH_CODEX_GATEWAY_ACCOUNT_REF || '').trim();
  if (/^acct_[a-zA-Z0-9]+$/.test(gatewayAccountRef)) {
    configValues.push(`model_providers.${providerKey}.http_headers.X-Account-Ref=${gatewayAccountRef}`);
  }
  // 认证不经 -c 传递：宿主 auth 命令固定读取网关 key，沙箱用 env_key。
  // env_key 与 auth 表在 codex 0.149 互斥（并存拒绝加载配置）。
  return configValues.flatMap((value) => ['-c', value]);
}

function hasCodexModelProviderArg(args = []) {
  return args.some((arg, index) => {
    const value = String(arg || '').trim();
    if (/^--config=model_provider\s*=/.test(value)) return true;
    return (value === '-c' || value === '--config')
      && /^model_provider\s*=/.test(String(args[index + 1] || '').trim());
  });
}

function injectCodexProviderArgs(args = [], providerArgs = []) {
  const result = Array.isArray(args) ? [...args] : [];
  const overrides = Array.isArray(providerArgs) ? providerArgs.filter((arg) => arg != null) : [];
  if (!overrides.length) return result;
  // 三个调用点都在追加 global flags 前注入；只认首 token，避免把 option value 或 prompt
  // 中恰好出现的 exec/resume/app-server 误判为子命令。
  if (!CONFIG_SCOPED_SUBCOMMANDS.has(String(result[0] || '').trim())) {
    return [...overrides, ...result];
  }
  result.splice(1, 0, ...overrides);
  return result;
}

module.exports = {
  AIH_CODEX_PROVIDER_KEY,
  CODEX_STARTUP_POLICY_CONFIGS,
  buildCodexStartupPolicyArgs,
  buildCodexProviderArgs,
  hasCodexModelProviderArg,
  injectCodexProviderArgs
};
