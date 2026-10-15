'use strict';

// kiro 凭据的**口径判型** —— 一个 refresh_token 有两种上游口径，选错就是 401/400，
// 因此判型只允许有一处实现，额度探针、模型发现、设备码登录三条链路都问这里。
//
//   * oidc    ：AWS SSO OIDC（Builder ID / IAM Identity Center / 公司 SSO）。
//                凭据里带 device-registration（clientId/clientSecret，显式字段或内嵌 sqlite），
//                刷新打 https://oidc.<region>.amazonaws.com/token。
//   * desktop ：Kiro Desktop / social 登录（Google / GitHub）。只有 refresh_token，
//                刷新打 https://prod.<region>.auth.desktop.kiro.dev/refreshToken。
//
// 判型顺序（fail closed，宁可回到旧行为也不猜新口径）：
//   1. 凭据里显式写的 flavor / tokenFlavour（我们自己的导入路径一定会写）；
//   2. 拿得到 device-registration → oidc（历史上所有导入都是这一形态，行为不变）；
//   3. 带 social 标记（authMethod / provider / profileArn）→ desktop；
//   4. 其余 → oidc（让调用方按旧路径失败并切 CLI 兜底，不静默换口径）。

const { normalizeRegistration } = require('./kiro-device-registration');

const KIRO_TOKEN_FLAVOURS = Object.freeze({ OIDC: 'oidc', DESKTOP: 'desktop' });

function normalizeFlavour(value) {
  const flavour = String(value || '').trim().toLowerCase();
  if (flavour === KIRO_TOKEN_FLAVOURS.OIDC) return KIRO_TOKEN_FLAVOURS.OIDC;
  if (flavour === KIRO_TOKEN_FLAVOURS.DESKTOP) return KIRO_TOKEN_FLAVOURS.DESKTOP;
  return '';
}

/** social / desktop 口径的凭据标记（Kiro IDE 的 kiro-auth-token.json 就是这几个字段）。 */
function hasDesktopMarkers(auth) {
  if (!auth || typeof auth !== 'object') return false;
  return Boolean(
    String(auth.authMethod || auth.auth_method || '').trim()
    || String(auth.provider || '').trim()
    || String(auth.profileArn || auth.profile_arn || '').trim()
  );
}

/**
 * 判定该账号的刷新口径。
 *
 * @param {object} nativeAuth 凭据记录里的 nativeAuth
 * @param {{resolveKiroDeviceRegistration?: Function}} [options] 注入用于测试/复用调用方已解析的 registration
 * @returns {{flavour: string, reason: string}}
 */
function resolveKiroTokenFlavour(nativeAuth, options = {}) {
  const explicit = normalizeFlavour(nativeAuth && (nativeAuth.flavor || nativeAuth.tokenFlavour));
  if (explicit) return { flavour: explicit, reason: 'explicit' };

  const explicitRegistration = normalizeRegistration(nativeAuth && nativeAuth.registration);
  if (explicitRegistration) return { flavour: KIRO_TOKEN_FLAVOURS.OIDC, reason: 'registration' };

  const resolveRegistration = options.resolveKiroDeviceRegistration;
  if (typeof resolveRegistration === 'function') {
    const resolved = resolveRegistration(nativeAuth, options);
    if (resolved && resolved.registration) return { flavour: KIRO_TOKEN_FLAVOURS.OIDC, reason: 'embedded_registration' };
  }

  if (hasDesktopMarkers(nativeAuth && nativeAuth.auth)) {
    return { flavour: KIRO_TOKEN_FLAVOURS.DESKTOP, reason: 'desktop_markers' };
  }
  return { flavour: KIRO_TOKEN_FLAVOURS.OIDC, reason: 'default' };
}

module.exports = {
  KIRO_TOKEN_FLAVOURS,
  hasDesktopMarkers,
  normalizeFlavour,
  resolveKiroTokenFlavour
};
