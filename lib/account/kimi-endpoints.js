'use strict';

const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_API_BASE_URL = 'https://api.moonshot.cn/v1';

function resolveKimiBaseUrl(options = {}) {
  const configured = String(options.baseUrl || '').trim();
  if (configured) return configured;
  return options.apiKeyMode === true ? KIMI_API_BASE_URL : KIMI_CODE_BASE_URL;
}

module.exports = {
  KIMI_API_BASE_URL,
  KIMI_CODE_BASE_URL,
  resolveKimiBaseUrl
};
