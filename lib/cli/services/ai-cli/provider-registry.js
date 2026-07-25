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

// isSupportedAiCli 判断 Provider 是否声明了原生 CLI。
function isSupportedAiCli(cliName) {
  return Boolean(getAiCliConfig(cliName));
}

// listSupportedAiClis 按合同中的 CLI order 返回 Provider 列表。
function listSupportedAiClis() {
  return Object.keys(AI_CLI_CONFIGS);
}

module.exports = {
  AI_CLI_CONFIGS,
  getAiCliConfig,
  getAiCliBinaryName,
  isSupportedAiCli,
  listSupportedAiClis
};
