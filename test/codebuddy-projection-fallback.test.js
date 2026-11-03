'use strict';

// 2026-11-01 真机事故：`aih codebuddycn login` 认证成功、起会话时立刻崩：
//
//   account_auth_projection_failed:unsupported_credential_file
//   at prepareProviderRuntime (provider-runtime-env.js)
//
// 根因不在登录流程，而在投影准备。codebuddycn 的候选凭据文件有两个：
//   首选 workbuddy-desktop.info（本账号自己的）
//   次选 Tencent-Cloud.coding-copilot.info（跨站兼容的独立分发 CLI 文件名）
// 一次迁移把两个账号投影里的**次选**文件换成了指向共享运行时 HOME 的符号链接，而
// materializeProviderAuth 把「次选文件读不出来」当致命错误，于是账号 1/2 全部起不来——
// 它们自己的首选文件完好无损。次选文件只是「可能存在的另一份凭据」，不该有这种权力。
//
// 这里钉住三件事，缺一条都会退回事故状态：
//   1. 次选文件是符号链接 → 照常启动，并把链接换成普通文件（账号隔离自动修复）
//   2. 首选文件是符号链接 → 仍然失败（投影坏了要报出来，不能默默覆盖）
//   3. 次选文件读得出来但属于别的站点 → 仍然失败（不能把别人的登录态导进来）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  materializeProviderAuth,
  registerProviderAuthProjection
} = require('../lib/account/native-auth-projection');

const AUTH_DIR = ['Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'];
const PRIMARY_FILE = 'workbuddy-desktop.info';
const FALLBACK_FILE = 'Tencent-Cloud.coding-copilot.info';
const CN_ISSUER = 'https://www.codebuddy.cn/auth/realms/copilot';
const INTL_ISSUER = 'https://www.codebuddy.ai/auth/realms/copilot';

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

function credential(issuer, uid) {
  return {
    auth: {
      accessToken: token(issuer, uid),
      refreshToken: token(issuer, uid),
      domain: new URL(issuer).hostname,
      lastRefreshTime: Date.now()
    },
    account: { uid, nickname: uid }
  };
}

/** 建一个已登记账号 + 一个投影目录；投影里两个候选文件都由调用方决定怎么放。 */
function withAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-projection-fallback-'));
  try {
    const runtimeDir = path.join(root, 'runtime');
    const aiHomeDir = path.join(root, 'ai-home');
    const primary = path.join(runtimeDir, ...AUTH_DIR, PRIMARY_FILE);
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, JSON.stringify(credential(CN_ISSUER, 'uid-cn')));
    const registration = registerProviderAuthProjection(fs, runtimeDir, 'codebuddycn', { aiHomeDir });
    assert.equal(registration.registered, true, `登记失败：${registration.reason}`);
    const projection = path.join(root, 'projection');
    const projectionAuthDir = path.join(projection, ...AUTH_DIR);
    fs.mkdirSync(projectionAuthDir, { recursive: true });
    return fn({
      root,
      aiHomeDir,
      accountRef: registration.accountRef,
      projection,
      projectionAuthDir,
      credentialFile: primary
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sharedRuntimeCopy(root, content) {
  const shared = path.join(root, 'shared-runtime-home', ...AUTH_DIR, FALLBACK_FILE);
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(shared, content);
  return shared;
}

test('次选文件是符号链接：照常启动，并把链接换成普通文件', () => {
  withAccount(({ root, aiHomeDir, accountRef, projection, projectionAuthDir, credentialFile }) => {
    const own = fs.readFileSync(credentialFile, 'utf8');
    fs.writeFileSync(path.join(projectionAuthDir, PRIMARY_FILE), own);
    const shared = sharedRuntimeCopy(root, own);
    const fallback = path.join(projectionAuthDir, FALLBACK_FILE);
    fs.symlinkSync(shared, fallback, 'file');

    const result = materializeProviderAuth(fs, projection, 'codebuddycn', { aiHomeDir, accountRef });

    assert.equal(result.missing, false, `不该判缺失：${result.reason || ''}`);
    assert.equal(result.reason, undefined);
    assert.equal(result.materialized, 2, '两个候选文件都应写入');

    const after = fs.lstatSync(fallback);
    assert.equal(after.isSymbolicLink(), false, '符号链接必须被原子写入替换掉，账号隔离才算恢复');
    assert.deepEqual(JSON.parse(fs.readFileSync(fallback, 'utf8')), JSON.parse(own), '次选文件应写成本账号自己的凭据');
    assert.equal(fs.readFileSync(shared, 'utf8'), own, '共享运行时那份不该被改动');
  });
});

test('首选文件是符号链接：仍然失败，不默默覆盖', () => {
  withAccount(({ root, aiHomeDir, accountRef, projection, projectionAuthDir, credentialFile }) => {
    const own = fs.readFileSync(credentialFile, 'utf8');
    const shared = sharedRuntimeCopy(root, own);
    const primary = path.join(projectionAuthDir, PRIMARY_FILE);
    fs.symlinkSync(shared, primary, 'file');

    const result = materializeProviderAuth(fs, projection, 'codebuddycn', { aiHomeDir, accountRef });

    assert.equal(result.missing, true);
    assert.equal(result.reason, 'unsupported_credential_file');
    assert.equal(fs.lstatSync(primary).isSymbolicLink(), true, '失败时不该改动磁盘');
  });
});

test('次选文件读得出来但属于别的站点：仍然失败，不能串号', () => {
  withAccount(({ aiHomeDir, accountRef, projection, projectionAuthDir, credentialFile }) => {
    fs.writeFileSync(path.join(projectionAuthDir, PRIMARY_FILE), fs.readFileSync(credentialFile, 'utf8'));
    fs.writeFileSync(
      path.join(projectionAuthDir, FALLBACK_FILE),
      JSON.stringify(credential(INTL_ISSUER, 'uid-intl'))
    );

    const result = materializeProviderAuth(fs, projection, 'codebuddycn', { aiHomeDir, accountRef });

    assert.equal(result.missing, true);
    assert.equal(result.reason, 'credential_realm_mismatch');
  });
});
