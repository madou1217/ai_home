'use strict';

// Grok Build 的账单和身份接口独立于 xAI 推理 API；OAuth 凭据只发往官方端点。
const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const GROK_BILLING_LEGACY_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const GROK_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription';
const GROK_BILLING_GRPC_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

module.exports = { GROK_BILLING_URL, GROK_BILLING_LEGACY_URL, GROK_USER_URL, GROK_BILLING_GRPC_URL };
