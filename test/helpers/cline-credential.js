'use strict';

/**
 * Cline（`<CLINE_DIR>/data/settings/providers.json`）测试夹具：与 CLI 真实落盘同形。
 *
 * 关键形态（见 lib/account/cline-credentials.js 的实测说明）：
 *   - accessToken 带 `workos:` 标记前缀（出网鉴权与持久化都保留它）；
 *   - expiresAt 是**毫秒时间戳字符串**；
 *   - Cline Pass 登录会同时写 `cline` 与 `cline-pass` 两个槽位；
 *   - 整库文档里还装着别的 provider 的明文密钥，所以夹具默认混进两条无关密钥，
 *     用来验证入库/投影不会把它们抄走。
 */
const NOW = 1791963322000;
const CLINE_CREDENTIAL_PATH = Object.freeze(['.cline', 'data', 'settings', 'providers.json']);
// 默认有效期给足 7 天：不注入固定时钟的路径会用真实时钟判定过期。
const DEFAULT_TTL_MS = 7 * 86400000;

function clineJwt(subject, issuedAtSec, expiresAtSec) {
  return `test.${Buffer.from(JSON.stringify({
    external_id: subject, iat: issuedAtSec, exp: expiresAtSec
  })).toString('base64url')}.not-a-real-signature`;
}

/** `generation` 越大 = 签发越晚 = 代际越新（iat 与 expiresAt 同步前进）。 */
function clineAuth(subject, generation, options = {}) {
  const issuedAtSec = Math.floor(NOW / 1000) + generation * 60;
  const expiresAt = options.expiresAt || issuedAtSec * 1000 + DEFAULT_TTL_MS;
  return {
    accessToken: `workos:${clineJwt(subject, issuedAtSec, Math.floor(expiresAt / 1000))}`,
    refreshToken: `refresh-${subject}-${generation}`,
    expiresAt: String(expiresAt),
    accountId: subject,
    metadata: {
      userInfo: { clineUserId: subject, email: `${subject}@example.invalid`, name: `User ${subject}` }
    }
  };
}

/** 一份 providers.json：目标槽位 + 两条**不属于 cline** 的明文密钥。 */
function providersDocument(slot, auth, extra = {}) {
  return {
    version: '1',
    lastUsedProvider: slot,
    providers: {
      [slot]: { settings: { auth }, updatedAt: new Date(NOW).toISOString() },
      anthropic: { settings: { apiKey: 'sk-ant-must-not-be-copied' } },
      openrouter: { settings: { apiKey: 'sk-or-must-not-be-copied' } },
      ...extra
    }
  };
}

module.exports = { NOW, CLINE_CREDENTIAL_PATH, clineAuth, clineJwt, providersDocument };
