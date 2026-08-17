'use strict';

const { listProviderDefinitions } = require('../../../provider-catalog');

// deepFreeze 冻结生成合同的 CLI 投影，避免运行时修改全局配置。
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach((child) => deepFreeze(child));
  return Object.freeze(value);
}

// buildCliConfig 移除只用于生成排序的 order 字段，保持原有消费接口不变。
function buildCliConfig(source = {}) {
  const config = JSON.parse(JSON.stringify(source));
  delete config.order;
  return deepFreeze(config);
}

// AI_CLI_CONFIGS 由 Go Provider 合同生成，不再维护第二份 Provider 身份清单。
const AI_CLI_CONFIGS = deepFreeze(Object.fromEntries(
  listProviderDefinitions()
    .filter((definition) => definition.cli)
    .sort((left, right) => Number(left.cli.order || 0) - Number(right.cli.order || 0))
    .map((definition) => [definition.id, buildCliConfig(definition.cli)])
));

// getAiCliBinaryName 返回显式二进制名，否则使用 Provider ID。
function getAiCliBinaryName(cliName) {
  const config = getAiCliConfig(cliName);
  const binaryName = config && String(config.binaryName || '').trim();
  return binaryName || String(cliName || '').trim().toLowerCase();
}

// getAiCliConfig 返回只读 CLI 配置，未知 Provider 返回 null。
function getAiCliConfig(cliName) {
  return AI_CLI_CONFIGS[String(cliName || '').trim().toLowerCase()] || null;
}

// isSupportedAiCli 判断 Provider 是否声明了面向用户的原生 CLI。
function isSupportedAiCli(cliName) {
  const provider = String(cliName || '').trim().toLowerCase();
  const definition = listProviderDefinitions().find((item) => item.id === provider);
  return Boolean(definition && definition.clients && definition.clients.cli && getAiCliConfig(provider));
}

// listSupportedAiClis 按合同中的 CLI order 返回面向用户的 Provider 列表。
function listSupportedAiClis() {
  return listProviderDefinitions()
    .filter((definition) => definition.clients && definition.clients.cli && definition.cli)
    .sort((left, right) => Number(left.cli.order || 0) - Number(right.cli.order || 0))
    .map((definition) => definition.id);
}

// listInstallableAiClis 只返回合同明确面向用户安装的 CLI；运行时仍保留
// listSupportedAiClis，以兼容仅用于历史会话发现的内部 CLI 投影。
function listInstallableAiClis() {
  return listProviderDefinitions()
    .filter((definition) => definition.clients && definition.clients.cli && definition.cli)
    .sort((left, right) => Number(left.cli.order || 0) - Number(right.cli.order || 0))
    .map((definition) => definition.id);
}

module.exports = {
  AI_CLI_CONFIGS,
  getAiCliConfig,
  getAiCliBinaryName,
  isSupportedAiCli,
  listSupportedAiClis,
  listInstallableAiClis
};
