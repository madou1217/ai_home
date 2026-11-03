'use strict';

// #65 `aih cline` 不指定账号时用 AIH Server 当账号（与裸 `aih opencode` 同口径）。
//
// cline 没有「推理端点由 env 决定」的开关，所以这条链路的证据分三段：
//   1) 合同声明 gateway_profile —— 否则 router 不会走 .aih-server profile；
//   2) relay profile 把网关地址/key 交给启动策略（AIH_CLINE_GATEWAY）；
//   3) 启动策略把它落成 cline 认识的 providers.json 槽位 + `-P` 参数。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifest = require('../contracts/providers/manifest.json');
const { buildAihServerProfileEnv, supportsAihServerProfile } = require('../lib/account/self-relay-account');
const { getCliRelayProfile } = require('../lib/cli/services/ai-cli/relay/cli-relay-profile');
const { parseClineGateway } = require('../lib/cli/services/ai-cli/cline-gateway-context');
const {
  GATEWAY_PROVIDER_ID,
  buildLaunchArgs,
  pickGatewayModel,
  prepare,
  resolveAcpAuthMethod,
  resolveGatewayProfile,
  writeGatewayProviderSlot
} = require('../lib/cli/services/ai-cli/launch-profile/cline-strategy');

const GATEWAY = Object.freeze({ baseUrl: 'http://127.0.0.1:8790/v1', apiKey: 'sk-test' });

function gatewayEnv(urls = GATEWAY) {
  return getCliRelayProfile('cline').buildGatewayProfileEnv(urls);
}

function withSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-gw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandboxDir = path.join(root, 'sandbox');
  fs.mkdirSync(sandboxDir, { recursive: true });
  return {
    root,
    sandboxDir,
    ctx: {
      cliName: 'cline',
      sandboxDir,
      path,
      fs,
      baseEnv: gatewayEnv(),
      argv: [],
      hostHomeDir: path.join(root, 'host'),
      aiHomeDir: path.join(root, 'aih')
    },
    documentPath: path.join(sandboxDir, '.cline', 'data', 'settings', 'providers.json')
  };
}

test('合同声明 cline 的 gateway_profile', () => {
  const cline = manifest.providers.find((p) => p.id === 'cline');
  assert.ok(cline, 'cline 必须在合同里');
  assert.ok(cline.capabilities.includes('gateway_profile'));
  assert.equal(supportsAihServerProfile('cline'), true);
});

test('网关 profile env 带 baseUrl/apiKey，未声明能力的 provider 没有', () => {
  const env = buildAihServerProfileEnv('cline', { host: '127.0.0.1', port: 8790, apiKey: 'sk-test' });
  assert.ok(env && env.AIH_CLINE_GATEWAY);
  assert.deepEqual(parseClineGateway(env.AIH_CLINE_GATEWAY), {
    baseUrl: 'http://127.0.0.1:8790/v1',
    apiKey: 'sk-test'
  });
  assert.equal(buildAihServerProfileEnv('grok', { host: '127.0.0.1', port: 8790 }), null);
});

test('prepare 写入 openai-compatible 槽位并保留账号凭据槽位', (t) => {
  const { ctx, documentPath } = withSandbox(t);
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  fs.writeFileSync(documentPath, JSON.stringify({
    version: 1,
    lastUsedProvider: 'cline-pass',
    providers: { 'cline-pass': { settings: { auth: { accessToken: 'workos:jwt' } } } }
  }));
  prepare(ctx);
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  assert.equal(document.version, 1);
  assert.equal(document.lastUsedProvider, GATEWAY_PROVIDER_ID);
  assert.deepEqual(document.providers[GATEWAY_PROVIDER_ID].settings, {
    provider: GATEWAY_PROVIDER_ID,
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:8790/v1'
  });
  // 账号自己的 Cline Pass 凭据不能被网关槽位挤掉（同一份文档里共存）。
  assert.deepEqual(document.providers['cline-pass'].settings, { auth: { accessToken: 'workos:jwt' } });
});

test('槽位内容不变时不重复落盘', (t) => {
  const { ctx, documentPath } = withSandbox(t);
  assert.equal(writeGatewayProviderSlot(ctx, { ...GATEWAY, model: '' }), true);
  const first = fs.readFileSync(documentPath, 'utf8');
  assert.equal(writeGatewayProviderSlot(ctx, { ...GATEWAY, model: '' }), false);
  assert.equal(fs.readFileSync(documentPath, 'utf8'), first);
});

test('启动参数推导 -P openai-compatible，显式 -P 不覆盖', (t) => {
  const { ctx } = withSandbox(t);
  assert.deepEqual(buildLaunchArgs(ctx), ['-P', GATEWAY_PROVIDER_ID]);
  assert.deepEqual(buildLaunchArgs({ ...ctx, argv: ['-P', 'anthropic'] }), []);
  assert.deepEqual(buildLaunchArgs({ ...ctx, argv: ['--provider=anthropic'] }), []);
});

let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (_error) { DatabaseSync = null; }

// 模型只从运行时模型缓存挑（网关探测上游后写入 app-state），启动时不能现查上游。
test('默认模型取自运行时缓存并写进槽位与 -m', { skip: DatabaseSync ? false : 'node:sqlite unavailable' }, (t) => {
  const { ctx, documentPath } = withSandbox(t);
  const { writePersistedWebUiModelsCache } = require('../lib/server/webui-model-cache');
  writePersistedWebUiModelsCache({ fs, aiHomeDir: ctx.aiHomeDir }, {
    byProvider: { claude: ['claude-opus-4-5', 'claude-sonnet-4-6'] }
  });
  ctx.baseEnv = gatewayEnv();
  assert.equal(resolveGatewayProfile(ctx).model, 'claude-sonnet-4-6');
  prepare(ctx);
  assert.deepEqual(buildLaunchArgs(ctx), ['-P', GATEWAY_PROVIDER_ID, '-m', 'claude-sonnet-4-6']);
  const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'));
  assert.equal(document.providers[GATEWAY_PROVIDER_ID].settings.model, 'claude-sonnet-4-6');
});

test('网关 profile 不发起 Cline 账号认证', (t) => {
  const { ctx } = withSandbox(t);
  assert.equal(resolveAcpAuthMethod(ctx), '');
  assert.equal(resolveGatewayProfile({ baseEnv: {} }), null);
});

test('非网关启动沿用 cline-pass 槽位推导（回归）', (t) => {
  const { ctx, documentPath } = withSandbox(t);
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  fs.writeFileSync(documentPath, JSON.stringify({
    version: 1,
    providers: { 'cline-pass': { settings: { auth: { accessToken: 'workos:jwt', expiresAt: Date.now() + 3600_000 } } } }
  }));
  assert.deepEqual(buildLaunchArgs({ ...ctx, baseEnv: {} }), ['-P', 'cline-pass']);
});

test('默认模型按家族 + 版本号挑，空列表不注入', () => {
  assert.equal(pickGatewayModel([]), '');
  assert.equal(pickGatewayModel(['gpt-5', 'claude-opus-4-5', 'claude-sonnet-4-6']), 'claude-sonnet-4-6');
});
