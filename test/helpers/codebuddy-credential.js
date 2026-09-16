'use strict';
const FIXTURE_ISSUED_AT = Math.floor(Date.now() / 1000) - 60;
const DOMAINS = { codebuddy: 'www.codebuddy.ai', workbuddy: 'www.workbuddy.ai',
  codebuddycn: 'www.workbuddy.cn', workbuddycn: 'www.workbuddy.cn' };
function credential(provider, options = {}) {
  const domain = options.domain || DOMAINS[provider];
  const uid = options.uid || 'fixture-user';
  const iat = options.iat || FIXTURE_ISSUED_AT;
  const jwt = payload => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
  const claims = { iss: `https://${domain}/auth/realms/copilot`, sub: uid, iat, exp: iat + 3600 };
  return { account: { uid, nickname: 'fixture' }, auth: {
    accessToken: jwt({ ...claims, marker: options.marker || 'access' }),
    refreshToken: jwt({ ...claims, exp: iat + 86400, typ: 'Refresh' }),
    domain, tokenType: 'Bearer', lastRefreshTime: iat * 1000
  } };
}
module.exports = { credential };
