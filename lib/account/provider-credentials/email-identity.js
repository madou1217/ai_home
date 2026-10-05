'use strict';

const { normalizeEmailComponent } = require('../identity-components');

// 只有文档化的例外（gemini、agy：原生凭据里没有比邮箱更稳定的字段）允许以邮箱作身份。
// 校验强度与 Go 对齐：normalizeEmailComponent 拒绝非邮箱形状的值，避免铸出 Go 不会产生的种子。
function emailIdentitySeed(provider, auth) {
  // 调用时再取 transfer-core：它在加载期依赖本注册表，顶层 require 会形成循环。
  const { extractOAuthEmail } = require('../transfer-core');
  const email = normalizeEmailComponent(extractOAuthEmail(provider, auth));
  return email ? `oauth:${provider}:${email}` : '';
}

module.exports = { emailIdentitySeed };
