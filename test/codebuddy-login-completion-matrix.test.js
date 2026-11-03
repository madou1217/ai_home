'use strict';

// 家族登录收尾的**全矩阵**回归（2026-11-01 真机事故）。
//
// 事故：`aih codebuddycn login` 里浏览器已经显示登录成功，CLI 却直接进 TUI、账号没入库，
// 用户看到的是「login 直接进入了会话」。根因是登录完成判定只认 Provider 的**首选**文件：
//   codebuddycn 首选 workbuddy-desktop.info（WorkBuddy.app 写的）
//   而 aih 起的是独立分发 CLI（codebuddy 二进制），它写 Tencent-Cloud.coding-copilot.info
// 于是探针永远返回 false，watcher 不结束登录进程，onExit 的登记路径也就永远不跑。
//
// 这里不逐条手写「哪个文件算完成」，而是对**家族每一支 × 它的每一个候选凭据文件**跑一遍
// 真实链路：探针判完成 → 用同一份凭据登记账号。以后新增成员、改文件名、改候选顺序，
// 只要有一条组合「探针不认」或「登记失败」，这个测试立刻红。
//
// 站点归属**只看 token 的 realm**（不是文件名），所以断言的是登记出的 Provider 与
// 凭据签发站点一致。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FAMILY_PROVIDERS,
  familyAuthPaths
} = require('../lib/runtime/codebuddy-family-layouts');
const { hasOauthCompletionArtifacts } = require('../lib/server/web-account-auth-oauth-tokens');
const { registerProviderAuthProjection } = require('../lib/account/native-auth-projection');

// 每个家族成员的**本站在用签发域**（取自 codebuddy-credential-source 的 ISSUERS 白名单）。
const SITE_ISSUER = Object.freeze({
  codebuddy: 'https://www.codebuddy.ai/auth/realms/copilot',
  codebuddycn: 'https://www.codebuddy.cn/auth/realms/copilot',
  workbuddy: 'https://www.workbuddy.ai/auth/realms/copilot',
  workbuddycn: 'https://www.workbuddy.cn/auth/realms/copilot'
});

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(issuer, uid) {
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: 'none' }),
    encode({ iss: issuer, sub: uid, iat: now, exp: now + 3600 }),
    'sig'
  ].join('.');
}

function withSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-family-login-matrix-'));
  try {
    return fn({ runtimeDir: path.join(root, 'runtime'), aiHomeDir: path.join(root, 'ai-home') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const provider of FAMILY_PROVIDERS) {
  // 候选来自布局模块本身：首选 + 跨站次选（国内站额外认独立分发的凭据文件）。
  for (const artifact of familyAuthPaths('/home', provider, { platform: 'darwin' })) {
    // /home/<相对段> → 沙箱里的 runtimeDir/<相对段>
    const relative = artifact.slice('/home/'.length);
    const fileName = path.basename(artifact);

    test(`${provider}：${fileName} 落地即判定登录完成，并能登记为同一 Provider`, () => {
      withSandbox(({ runtimeDir, aiHomeDir }) => {
        const job = { provider, runtimeDir, platform: 'darwin' };
        assert.equal(
          hasOauthCompletionArtifacts(job, fs),
          false,
          '空沙箱不能判完成（否则会在登录开始前就收尾）'
        );

        const issuer = SITE_ISSUER[provider];
        const uid = `uid-${provider}-${fileName}`;
        const target = path.join(runtimeDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify({
          auth: {
            accessToken: token(issuer, uid),
            refreshToken: token(issuer, uid),
            domain: new URL(issuer).hostname,
            lastRefreshTime: Date.now()
          },
          account: { uid, nickname: 'matrix' }
        }));

        assert.equal(
          hasOauthCompletionArtifacts(job, fs),
          true,
          `${fileName} 是这支统一二进制会写的文件，探针必须认`
        );

        const registration = registerProviderAuthProjection(fs, runtimeDir, provider, { aiHomeDir });
        assert.equal(registration.registered, true, `登记失败：${registration.reason}`);
        assert.equal(registration.provider, provider, '站点归属由 realm 决定，应与签发站点一致');
      });
    });
  }
}
