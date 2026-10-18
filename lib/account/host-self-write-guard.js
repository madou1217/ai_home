'use strict';

// 宿主扫描的「自写回流」守卫：aih 自己写到宿主的东西绝不能被扫回账号池。
//
// aih 会往宿主写三类东西：
//   ① 默认账号投影（host-sync 把某个已登记账号的凭据写成宿主 CLI 的登录态）——它的身份就是那个
//      账号，入库链路按身份去重 / 墓碑即可挡住，这里不需要识别；
//   ② 网关默认配置（指向本机网关 127.0.0.1:<port> 的 base URL、aih 的 client key、
//      Claude 的 `x-account-ref` 钉选头、codex 的 `[model_providers.aih_server]` 受管块）——
//      这些不是任何上游账号，扫回来等于「把网关自己登记成一个账号」，必须在这里拒绝；
//   ③ aih 私有运行目录下的文件（`<aiHomeDir>/run/**`，含 claude-launch-settings）——扫描来源
//      只有宿主家目录里的固定槽位，本就不会读到它们；这里再兜一层：来源路径落在 aiHomeDir 内一律拒绝。
//
// 判定只看「是否带有 aih 自己的签名」，不猜内容是不是像凭据：签名来自 server 配置（端口 / key），
// 读不到配置时按默认端口判断（与 host-sync 的接管判定同一口径）。

const nodePath = require('node:path');

const AIH_MANAGED_MARKERS = Object.freeze([
  // Claude 网关默认 / relay 写进 settings.json 的账号钉选头（claude-account-relay PINNED_ACCOUNT_HEADER）。
  'x-account-ref',
  // codex 宿主受管块（host-sync patchCodexConfigToml）。
  'model_providers.aih_server'
]);

function readServerSignatures(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  let serverConfig = {};
  try {
    serverConfig = typeof options.readServerConfig === 'function'
      ? (options.readServerConfig() || {})
      : require('../server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    serverConfig = {};
  }
  const { buildAihServerBaseUrl, buildAihServerRootUrl, normalizeServerPort } = require('./self-relay-account');
  const clientKey = String(serverConfig.apiKey || serverConfig.clientKey || '').trim();
  const managementKey = String(serverConfig.managementKey || '').trim();
  return {
    serverPort: normalizeServerPort(serverConfig.port),
    gatewayUrls: [buildAihServerBaseUrl(serverConfig), buildAihServerRootUrl(serverConfig)]
      .map((url) => String(url || '').trim().replace(/\/+$/, ''))
      .filter(Boolean),
    // 太短的 key（例如 'dummy' 兜底）不当签名用：会误伤正常内容。
    secrets: [clientKey, managementKey].filter((secret) => secret.length >= 12)
  };
}

function isInside(parent, child) {
  const root = String(parent || '').trim();
  const target = String(child || '').trim();
  if (!root || !target) return false;
  const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

/**
 * @returns {{ rejectsPath(file): string, rejectsText(text): string, rejectsApiKey(info): string }}
 *   每个判定返回原因码（'' 表示放行）。
 */
function createSelfWriteGuard(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  let signatures = null;
  const load = () => {
    if (!signatures) signatures = readServerSignatures(options);
    return signatures;
  };

  function rejectsPath(file) {
    return aiHomeDir && isInside(aiHomeDir, file) ? 'aih_private_runtime_file' : '';
  }

  function rejectsText(text) {
    const content = String(text || '');
    if (!content) return '';
    const lower = content.toLowerCase();
    if (AIH_MANAGED_MARKERS.some((marker) => lower.includes(marker))) return 'aih_managed_host_config';
    const current = load();
    if (current.gatewayUrls.some((url) => content.includes(url))) return 'aih_gateway_host_config';
    if (current.secrets.some((secret) => content.includes(secret))) return 'aih_client_key_host_config';
    return '';
  }

  function rejectsApiKey(info = {}) {
    const apiKey = String(info.apiKey || '').trim();
    const baseUrl = String(info.baseUrl || '').trim();
    const current = load();
    if (apiKey && current.secrets.includes(apiKey)) return 'aih_client_key_host_config';
    if (baseUrl) {
      const { isSelfRelayApiKeyInfo } = require('./self-relay-account');
      if (isSelfRelayApiKeyInfo({ apiKeyMode: true, apiKey, baseUrl }, current.serverPort)) {
        return 'aih_gateway_host_config';
      }
      const normalized = baseUrl.replace(/\/+$/, '');
      if (current.gatewayUrls.some((url) => normalized === url || normalized.startsWith(`${url}/`))) {
        return 'aih_gateway_host_config';
      }
    }
    return rejectsText(info.rawText || '');
  }

  return { rejectsPath, rejectsText, rejectsApiKey };
}

module.exports = { AIH_MANAGED_MARKERS, createSelfWriteGuard };
