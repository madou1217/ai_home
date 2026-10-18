'use strict';

// `aih kiro login --device-code | --refresh-token` 的实现 —— **不经过本地 CLI 的原生登录**。
//
// 分层：设备码 / 刷新 / 投影落盘 / 账号注册全在 lib/account/kiro-device-login.js（纯 HTTP + 既有注册契约），
// 本文件只负责「参数解析、等待与输出」，不重复实现任何协议细节。

const crypto = require('node:crypto');
const { resolveLoginRuntimeDir } = require('../../../runtime/aih-storage-layout');
const {
  beginKiroDeviceLogin,
  beginKiroSocialDeviceLogin,
  buildKiroAuthRow,
  commitKiroCredential,
  importKiroRefreshToken,
  pollKiroDeviceLogin,
  pollKiroSocialDeviceLogin
} = require('../../../account/kiro-device-login');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// 等待必须真的挂住事件循环（unref 会让 CLI 在等待期间直接退出）。
function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 轮询直到授权/拒绝/过期；slow_down 时按 RFC 8628 拉长间隔。 */
async function waitForKiroDeviceAuthorization(flow, options = {}) {
  return waitForKiroAuthorization(pollKiroDeviceLogin, flow, options);
}

/**
 * social（Google / GitHub）设备流的等待。
 *
 * 与 Builder ID 的区别：这一口径没有 slow_down / denied 状态（上游只给
 * authorization_pending / invalid_token），因此等待循环更简单。
 */
async function waitForKiroSocialDeviceAuthorization(flow, options = {}) {
  return waitForKiroAuthorization(pollKiroSocialDeviceLogin, flow, options);
}

/** 两条设备流共用的等待循环（轮询实现由调用方注入）。 */
async function waitForKiroAuthorization(poll, flow, options = {}) {
  const request = options.request || globalThis.fetch;
  const sleep = options.sleep || defaultSleep;
  let intervalMs = Math.max(1, Number(flow.intervalSeconds) || 5) * 1000;
  const deadline = Math.min(
    Number.isFinite(flow.expiresAtMs) ? flow.expiresAtMs : Infinity,
    Date.now() + (Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS)
  );
  for (;;) {
    const result = await poll(flow, { request });
    if (result.status !== 'pending' && result.status !== 'slow_down') return result;
    if (result.status === 'slow_down') intervalMs += 5000;
    if (Date.now() + intervalMs > deadline) return { status: 'expired' };
    await sleep(intervalMs);
  }
}

/**
 * 跑一次原生登录（A 设备码 / B 刷新令牌）。
 *
 * @returns {Promise<{ok: boolean, mode: string, reason?: string, accountRef?: string, cliAccountId?: string}>}
 */
async function runKiroNativeLogin(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const request = options.request || globalThis.fetch;
  const mode = options.mode === 'refresh-token' ? 'refresh-token' : 'device-code';
  const loginProvider = String(options.loginProvider || '').trim();
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));

  const runtimeDir = resolveLoginRuntimeDir(aiHomeDir, 'kiro', `auth-${crypto.randomUUID()}`);
  if (!runtimeDir) return { ok: false, mode, reason: 'invalid_login_runtime' };

  let registration = null;
  let auth = null;
  if (mode === 'refresh-token') {
    const imported = await importKiroRefreshToken({
      refreshToken: options.refreshToken,
      region: options.region,
      provider: options.provider,
      profileArn: options.profileArn,
      request
    });
    auth = imported.auth;
  } else if (loginProvider) {
    // social（Google / GitHub）：与 Builder ID 是两套协议，走 Kiro 自己的认证服务。
    const flow = await beginKiroSocialDeviceLogin({ loginProvider, region: options.region, request });
    log('');
    log(`  1) 用 ${loginProvider} 账号在任意设备打开：${flow.verificationUriComplete}`);
    log(`  2) 确认代码：${flow.userCode}`);
    log('     （设备流不需要本机浏览器回调，SSH / 远程机器同样可用）');
    log('  等待授权…');
    const authorized = await waitForKiroSocialDeviceAuthorization(flow, {
      request, sleep: options.sleep, timeoutMs: options.timeoutMs
    });
    if (authorized.status !== 'authorized') return { ok: false, mode, reason: authorized.status };
    // pollKiroSocialDeviceLogin 已组装好与 importKiroRefreshToken 同构的 auth 行。
    auth = authorized.auth;
  } else {
    const flow = await beginKiroDeviceLogin({
      region: options.region,
      startUrl: options.startUrl,
      request
    });
    registration = flow.registration;
    log('');
    log(`  1) 在任意设备打开：${flow.verificationUriComplete}`);
    log(`  2) 输入代码：${flow.userCode}`);
    log(`     （也可以打开 ${flow.verificationUri} 手工填代码；SSH / 无浏览器环境同样可用）`);
    log('  等待授权…');
    const authorized = await waitForKiroDeviceAuthorization(flow, {
      request, sleep: options.sleep, timeoutMs: options.timeoutMs
    });
    if (authorized.status !== 'authorized') return { ok: false, mode, reason: authorized.status };
    auth = buildKiroAuthRow(authorized.grant);
  }

  const committed = await commitKiroCredential(fs, {
    runtimeDir,
    aiHomeDir,
    registration,
    auth,
    request,
    accountRef: options.accountRef,
    registerKiroNativeLogin: options.registerKiroNativeLogin
  });
  if (!committed.ok) return { ok: false, mode, reason: committed.reason };
  return { ok: true, mode, accountRef: committed.accountRef, cliAccountId: committed.cliAccountId };
}

const FLAG_SPECS = Object.freeze({
  '--refresh-token': 'refreshToken',
  '--region': 'region',
  '--start-url': 'startUrl',
  '--profile-arn': 'profileArn',
  '--provider': 'provider',
  '--timeout-ms': 'timeoutMs'
});

/** 解析 `aih kiro login <flags>` 的参数（未知 flag 直接报错，不静默忽略）。 */
function parseKiroNativeLoginArgs(argv = []) {
  const parsed = { mode: '', refreshToken: '', region: '', startUrl: '', profileArn: '', provider: '', timeoutMs: 0, loginProvider: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--device-code') { parsed.mode = 'device-code'; continue; }
    // social（Google / GitHub）设备流：与 Builder ID 是两套协议，因此是显式开关而不是猜测。
    if (token === '--social') { parsed.mode = 'device-code'; parsed.loginProvider = 'Google'; continue; }
    if (token === '--google') { parsed.mode = 'device-code'; parsed.loginProvider = 'Google'; continue; }
    if (token === '--github') { parsed.mode = 'device-code'; parsed.loginProvider = 'Github'; continue; }
    if (token === '--refresh-token' && !argv[index + 1]) return { error: 'missing_refresh_token_value' };
    const field = FLAG_SPECS[token];
    if (!field) return { error: `unknown_flag:${token}` };
    const value = String(argv[index + 1] || '').trim();
    if (!value) return { error: `missing_value:${token}` };
    parsed[field] = field === 'timeoutMs' ? Number(value) : value;
    index += 1;
  }
  if (!parsed.mode) parsed.mode = parsed.refreshToken ? 'refresh-token' : 'device-code';
  if (parsed.mode === 'refresh-token' && !parsed.refreshToken) return { error: 'missing_refresh_token_value' };
  return parsed;
}

const USAGE_LINES = Object.freeze([
  '用法：aih kiro login --device-code [--region us-east-1] [--start-url <portal>]',
  '      aih kiro login --social [--github] [--region us-east-1]',
  '      aih kiro login --refresh-token <token> [--profile-arn <arn>] [--region us-east-1]',
  '  --device-code   走 AWS SSO OIDC 设备码授权（Builder ID / IAM Identity Center），不需要本地 kiro CLI',
  '  --social        Google / GitHub 账号的设备码授权（默认 Google；--github 切换）',
  '                  远程机器上 social 的浏览器回调打不通，设备流是唯一可用路径',
  '  --refresh-token Kiro Desktop / social（Google / GitHub）账号：直接给 refresh_token',
  '  三者都不需要安装 kiro CLI 或 Kiro IDE。'
]);

/** 命令层：解析参数 → 跑登录 → 打印结果 → 返回进程退出码（0 成功 / 1 失败 / 2 用法错误）。 */
async function runKiroNativeLoginCommand(options = {}) {
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));
  const errorLog = options.errorLog || ((line) => process.stderr.write(`${line}\n`));
  const parsed = parseKiroNativeLoginArgs(options.argv || []);
  if (parsed.error) {
    errorLog(`\x1b[31m[aih]\x1b[0m kiro login: ${parsed.error}`);
    for (const line of USAGE_LINES) errorLog(line);
    return 2;
  }

  log(`\x1b[36m[aih]\x1b[0m Kiro 原生登录（${parsed.mode}）—— 不需要本地 kiro CLI / Kiro IDE`);
  let result;
  try {
    result = await runKiroNativeLogin({ ...options, ...parsed, mode: parsed.mode });
  } catch (error) {
    errorLog(`\x1b[31m[aih]\x1b[0m Kiro 登录失败：${(error && (error.code || error.message)) || 'unknown'}`);
    return 1;
  }
  if (!result.ok) {
    errorLog(`\x1b[31m[aih]\x1b[0m Kiro 登录未完成：${result.reason}`);
    return 1;
  }
  log(`\x1b[32m[Success]\x1b[0m Kiro 账号已加入（CLI 编号 ${result.cliAccountId}）`);
  return 0;
}

module.exports = {
  USAGE_LINES,
  parseKiroNativeLoginArgs,
  runKiroNativeLogin,
  runKiroNativeLoginCommand,
  waitForKiroDeviceAuthorization,
  waitForKiroSocialDeviceAuthorization
};
