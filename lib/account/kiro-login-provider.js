'use strict';

// kiro 的**登录方式**（不是认证方式）归一。
//
// WebUI 的认证方式只有一条「OAuth 登录」（authMode=oauth-device）；用户在里面再显式选
// Builder ID / Google / GitHub。三者的授权协议不同：
//   * Builder ID（含 IAM Identity Center）—— AWS SSO OIDC，见 kiro-device-authorization.js；
//   * Google / GitHub —— Kiro social 设备流，见 kiro-social-device-flow.js。
//
// 服务端此前用「loginProvider 非空 = social」来判断，于是任何拼错的值（例如 'builder-id'）
// 都会被静默当成 Google —— 登录到了别的账号体系，还很难看出来。这个模块把判断收口：
// 只有明确认出的 Google / GitHub 才是 social，其余（含空值 / builder-id）都是 Builder ID。

const KIRO_LOGIN_PROVIDERS = Object.freeze({
  BUILDER_ID: 'builder-id',
  GOOGLE: 'Google',
  GITHUB: 'Github'
});

const SOCIAL_ALIASES = Object.freeze({
  google: KIRO_LOGIN_PROVIDERS.GOOGLE,
  gmail: KIRO_LOGIN_PROVIDERS.GOOGLE,
  github: KIRO_LOGIN_PROVIDERS.GITHUB,
  git: KIRO_LOGIN_PROVIDERS.GITHUB
});

const BUILDER_ID_ALIASES = Object.freeze([
  KIRO_LOGIN_PROVIDERS.BUILDER_ID,
  'builderid',
  'builder',
  'aws-builder-id',
  'awsbuilderid',
  'idc'
]);

/**
 * 归一成服务端两条协议之一：
 *   ''        —— Builder ID / IAM Identity Center（AWS SSO OIDC，job 里沿用历史空值口径）；
 *   'Google'  / 'Github' —— social 设备流。
 * 认不出的值按 Builder ID 处理（历史上缺省就是 Builder ID，且**绝不**静默登成 Google）。
 */
function normalizeKiroLoginProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || BUILDER_ID_ALIASES.includes(raw)) return '';
  return SOCIAL_ALIASES[raw] || '';
}

module.exports = {
  normalizeKiroLoginProvider
};
