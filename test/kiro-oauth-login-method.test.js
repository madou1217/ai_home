'use strict';

// kiro 登录流程（2026-11-02）：WebUI 不再默认 Builder ID。
//   * 认证方式只叫「OAuth 登录」；
//   * 点开之后 Builder ID / Google / GitHub 并排三选一，**点选后**才去取授权链接；
//   * 服务端只把明确认出的 Google / GitHub 当 social，拼错的值不会再静默登成 Google。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeKiroLoginProvider } = require('../lib/account/kiro-login-provider');
const manifest = require('../contracts/providers/manifest.json');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('kiro 认证方式不再叫 AWS Builder ID 登录：契约与生成投影都是 OAuth 登录', () => {
  const kiro = manifest.providers.find((provider) => provider.id === 'kiro');
  assert.ok(kiro, 'manifest 必须有 kiro');
  const option = kiro.authOptions.find((entry) => entry.value === 'oauth-device');
  assert.ok(option, 'kiro 必须保留 oauth-device 认证方式');
  assert.equal(option.label, 'OAuth 登录');
  // 三个登录方式必须在说明里点明，避免又变成「只有一个 Builder ID」的暗示。
  assert.match(option.description, /Builder ID/);
  assert.match(option.description, /Google/);
  assert.match(option.description, /GitHub/);

  // 生成的 Client 投影与真值源同源：漏跑 npm run providers:generate 会在这里红。
  const generated = read('web/src/providers/provider-contract.generated.ts');
  assert.match(generated, /"label": "OAuth 登录"/);
  assert.doesNotMatch(generated, /"label": "AWS Builder ID 登录"/);
});

test('kiro 的三种登录方式并排渲染，且没有默认项（不选不发授权请求）', () => {
  const addModal = read('web/src/features/accounts/AddAccountModal.tsx');
  const choice = read('web/src/features/accounts/KiroLoginMethodChoice.tsx');
  const actions = read('web/src/features/accounts/use-account-actions.ts');
  const flowModals = read('web/src/features/accounts/AccountFlowModals.tsx');

  // 只在 kiro + oauth-device 时出现。
  assert.match(addModal, /selectedProvider === 'kiro' && selectedAuthMode === 'oauth-device'/);
  assert.match(addModal, /name="kiroLoginProvider"/);
  // 没有 initialValue：旧行为就是靠默认选中 Builder ID 直接发起授权。
  assert.doesNotMatch(addModal, /name="kiroLoginProvider"[\s\S]{0,240}initialValue/);

  // 2026-11-02 交互修正：点选只写回表单，**不**立即发请求；由「确定」统一提交。
  // 之前的 onSelect 直连 add 会让「点一下就开始登录」，用户没有确认这一步。
  assert.doesNotMatch(addModal, /onSelect=/);
  assert.doesNotMatch(choice, /onSelect/);
  assert.doesNotMatch(flowModals, /onKiroLogin/);
  assert.match(choice, /onChange\?\.\(event\.target\.value as KiroLoginProvider\)/);

  // 没有选择时「确定」必须 disable（用户报的正是这个）。
  assert.match(addModal, /const kiroLoginProvider = Form\.useWatch\('kiroLoginProvider', form\)/);
  assert.match(addModal, /const okDisabled = [\s\S]{0,200}needsKiroLoginMethod && !kiroLoginProvider/);
  assert.match(addModal, /okButtonProps=\{\{ disabled: okDisabled \}\}/);

  // 三个选项并排（同一行 flex），而不是旧的纵向认证方式列表。
  assert.match(choice, /label: 'Builder ID 登录'/);
  assert.match(choice, /label: '用 Google 登录'/);
  assert.match(choice, /label: '用 GitHub 登录'/);
  assert.match(choice, /kiro-login-methods-row/);
  const css = read('web/src/features/accounts/account-overlays.css');
  assert.match(css, /\.kiro-login-methods-row \{[^}]*display: flex/);

  // 交互动效：三块依次进场 + 悬停抬起（时长只取 tokens，reduced-motion 由 tokens 归零）。
  assert.match(css, /kiro-login-methods-row > \.ant-radio-wrapper \{[\s\S]{0,240}animation: aih-fade-up/);
  assert.match(css, /:hover \{[\s\S]{0,60}transform: translateY\(-1px\)/);
  assert.match(css, /nth-child\(2\)[\s\S]{0,40}animation-delay/);

  // 点选之后走的还是同一条 add 链路，显式把 loginProvider 交给服务端。
  assert.match(actions, /configPayload = \{ loginProvider: String\(values\.kiroLoginProvider \|\| ''\) \}/);
});

test('服务端按显式 loginProvider 选协议：builder-id 不会被当成 social', () => {
  assert.equal(normalizeKiroLoginProvider(''), '');
  assert.equal(normalizeKiroLoginProvider('builder-id'), '');
  assert.equal(normalizeKiroLoginProvider('AWS-Builder-ID'), '');
  assert.equal(normalizeKiroLoginProvider('idc'), '');
  assert.equal(normalizeKiroLoginProvider('Google'), 'Google');
  assert.equal(normalizeKiroLoginProvider('google'), 'Google');
  assert.equal(normalizeKiroLoginProvider('Github'), 'Github');
  assert.equal(normalizeKiroLoginProvider('git'), 'Github');
  // 认不出的值以前会被 social 归一成 Google（登进别的账号体系）；现在回到 Builder ID。
  assert.equal(normalizeKiroLoginProvider('builderid-typo'), '');

  const authJob = read('lib/server/web-account-auth.js');
  assert.match(authJob, /_kiroLoginProvider: normalizeKiroLoginProvider\(jobOptions\.loginProvider\)/);
  // Builder ID 已固定由 Go 承接：Node 不再自己跑 AWS SSO OIDC 设备码。
  assert.match(authJob, /nativeOauth = KIRO_GO_DEVICE_OAUTH/);
  assert.doesNotMatch(authJob, /等待 Builder ID 完成 AWS SSO OIDC 设备码授权/);
  assert.doesNotMatch(authJob, /beginKiroDeviceLogin|pollKiroDeviceLogin/);
});
