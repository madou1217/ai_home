'use strict';

// 「从本机导入」端到端回归（任务链路 + 真实宿主机探测，不注入假探测器）。
//
// 关键点：这里**不伪造宿主能力** —— 在临时家目录里按契约声明的路径造出 Kiro.app 与 IDE 的
// token 文件，让 createAppEntryDetector 自己认出「应用已装」，从而证明
// 「能力门面 → 认证来源链 → 任务链路 → 账号入库」整条链是通的。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuthJobManager } = require('../lib/server/web-account-auth');
const { readAccountNativeAuth } = require('../lib/server/account-credential-store');
const { resolveAuthSources } = require('../lib/account/auth-sources');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-local-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'host');
  const aiHomeDir = path.join(root, 'aih');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return { root, hostHomeDir, aiHomeDir };
}

/** 按契约里的 macOS 安装路径造一个「已安装」的 Kiro 桌面应用。 */
function installFakeKiroDesktop(hostHomeDir) {
  const executable = path.join(hostHomeDir, 'Applications', 'Kiro.app', 'Contents', 'MacOS', 'kiro_cli_desktop');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return executable;
}

function writeIdeToken(hostHomeDir, document) {
  const tokenPath = path.join(hostHomeDir, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(document));
  return tokenPath;
}

function createManager({ hostHomeDir, aiHomeDir }) {
  const spawnCalls = [];
  const manager = createAuthJobManager({
    fs,
    aiHomeDir,
    hostHomeDir,
    processObj: {
      env: { HOME: hostHomeDir, USERPROFILE: hostHomeDir, AIH_HOST_HOME: hostHomeDir, PATH: '' },
      platform: process.platform,
      cwd: () => aiHomeDir,
      kill() {}
    },
    // 本机导入路径既不该解析 CLI，也不该 spawn PTY。
    resolveCliPathImpl: () => { throw new Error('must_not_resolve_cli'); },
    ptyImpl: { spawn() { spawnCalls.push('spawn'); throw new Error('must_not_spawn_pty'); } },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('auth.desktop.kiro.dev/refreshToken')) {
        return { status: 200, json: async () => ({ accessToken: 'aoa-from-ide', refreshToken: 'aor-from-ide',
          expiresIn: 3600, profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/ide' }) };
      }
      return new Response(JSON.stringify({
        userInfo: { userId: 'ide-user' },
        usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 50, currentUsageWithPrecision: 1,
          usageLimitWithPrecision: 50 }]
      }), { status: 200 });
    }
  });
  return { manager, spawnCalls };
}

test('装了 Kiro IDE：认证来源判定为可用 → 从本机导入直接产出账号（不 spawn CLI、不粘贴）', async t => {
  const { hostHomeDir, aiHomeDir } = fixture(t);
  installFakeKiroDesktop(hostHomeDir);
  writeIdeToken(hostHomeDir, {
    accessToken: 'aoa-ide', refreshToken: 'aor-ide', expiresAt: '2030-01-01T00:00:00Z',
    authMethod: 'social', provider: 'Google', profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/ide'
  });

  // 真实探测：门面自己认出「Kiro 桌面已安装」→ 本机来源可用。
  const resolved = resolveAuthSources('kiro', { hostCapabilitiesOptions: { hostHomeDir } });
  const ide = resolved.sources.find((source) => source.id === 'kiro-ide-local');
  assert.equal(ide.available, true, '真实探测应认出临时家目录里的 Kiro.app');

  const { manager, spawnCalls } = createManager({ hostHomeDir, aiHomeDir });
  const started = manager.startOauthJob('kiro', 'oauth-refresh-token');
  const result = await manager.completeLocalAuthImport(started.jobId, 'kiro-ide-local');
  assert.equal(result.ok, true, JSON.stringify(result.code || ''));

  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded', job.error);
  assert.equal(job.authProgressState, 'completed');
  assert.equal(spawnCalls.length, 0, '本机导入不得 spawn 任何 CLI/PTY');
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, job.accountRef);
  assert.equal(nativeAuth.auth.access_token, 'aoa-from-ide', '必须用真刷后的 token 入库');
  assert.equal(nativeAuth.auth.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/ide');
  const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('../lib/account/kiro-token-flavour');
  assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.DESKTOP);
});

test('没装 Kiro IDE：本机来源不可用 → 明确拒绝并给出原因（不静默成功）', async t => {
  const { hostHomeDir, aiHomeDir } = fixture(t);
  writeIdeToken(hostHomeDir, { refreshToken: 'aor-ide' });
  const { manager } = createManager({ hostHomeDir, aiHomeDir });
  const started = manager.startOauthJob('kiro', 'oauth-refresh-token');
  const result = await manager.completeLocalAuthImport(started.jobId, 'kiro-ide-local');
  assert.equal(result.ok, false);
  assert.match(String(result.code), /^auth_source_unavailable:client_/);
  assert.equal(manager.getJob(started.jobId).status, 'running', '拒绝时任务应保持可继续（用户还能粘贴）');

  const unknown = await manager.completeLocalAuthImport(started.jobId, 'nope');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'auth_source_unknown');

  // 装了 IDE 但没有登录态（token 文件不存在）：失败带原因，任务结束而不是无限等。
  installFakeKiroDesktop(hostHomeDir);
  fs.rmSync(path.join(hostHomeDir, '.aws'), { recursive: true, force: true });
  const noLogin = await manager.completeLocalAuthImport(started.jobId, 'kiro-ide-local');
  assert.equal(noLogin.ok, false);
  assert.equal(noLogin.code, 'ide_token_file_missing');
  const failedJob = manager.getJob(started.jobId);
  assert.equal(failedJob.status, 'failed');
  assert.match(failedJob.error, /ide_token_file_missing/);
});
