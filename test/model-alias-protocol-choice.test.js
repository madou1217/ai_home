'use strict';

// `--model-alias claude.<model>` 的协议不对称拦截回归守卫。
//
// 覆盖三件事：
//   1. 双协议厂商端点对照表（Anthropic 地址 → OpenAI 基址）只认已知厂商；
//   2. CLI 能从凭据记录里认出可迁移账号，并在用户选择「新增到 codex」时写出一份
//      可用的 codex API Key 账号（幂等）；
//   3. 「自动适配」经已有的 AIH_CODEX_FLAGS 上下文送到 codex 的 -c http_headers，
//      网关侧按提示选择 openai_chat 回落、只保留能说该协议的账号。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listDualFormatEndpoints,
  resolveOpenAICompatibleBaseUrl
} = require('../lib/account/dual-format-endpoints');
const {
  filterAccountsForUpstreamProtocol,
  listUpstreamProtocolVariants,
  resolveUpstreamProtocolTarget
} = require('../lib/account/upstream-protocol-variants');
const {
  readUpstreamProtocolHint
} = require('../lib/server/upstream-protocol-hint');
const {
  copyCandidatesToTarget,
  formatCandidateLine,
  listProtocolChoiceCandidates,
  maybeOfferModelAliasProtocolChoice,
  parseChoiceAnswer,
  reloadServerAccountsSync
} = require('../lib/cli/services/ai-cli/model-alias-protocol-choice');
const { buildProviderRuntimeEnv } = require('../lib/cli/services/ai-cli/provider-runtime-env');
const { buildCodexProviderArgs } = require('../lib/cli/services/ai-cli/codex-provider-args');
const { readCodexFlag, setCodexFlag } = require('../lib/runtime/codex-flags');
const { buildApiKeyIdentity } = require('../lib/account/transfer-core');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  listAccountCredentialRecords,
  writeAccountCredentials
} = require('../lib/server/account-credential-store');
const { shouldSkipForwardHeader } = require('../lib/server/upstream-endpoints-headers');
const { __private: fallbackPrivate } = require('../lib/server/protocol-fallback-bridge');

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-protocol-choice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function seedClaudeAccount(home, env) {
  const seed = buildApiKeyIdentity('claude', { config: env });
  const registration = registerAccountIdentity(fs, home, { provider: 'claude', identitySeed: seed });
  writeAccountCredentials(fs, home, registration.accountRef, env);
  return registration;
}

test('双协议端点表：只映射已知厂商，未知地址与官方 Anthropic 一律不猜', () => {
  assert.equal(
    resolveOpenAICompatibleBaseUrl('https://api.deepseek.com/anthropic'),
    'https://api.deepseek.com/v1'
  );
  // 账号可能存 Anthropic SDK 形态（末尾带 /v1），同一个端点。
  assert.equal(
    resolveOpenAICompatibleBaseUrl('https://api.deepseek.com/anthropic/v1/'),
    'https://api.deepseek.com/v1'
  );
  assert.equal(
    resolveOpenAICompatibleBaseUrl('https://open.bigmodel.cn/api/anthropic'),
    'https://open.bigmodel.cn/api/paas/v4'
  );
  assert.equal(
    resolveOpenAICompatibleBaseUrl('https://dashscope.aliyuncs.com/apps/anthropic'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  );
  assert.equal(resolveOpenAICompatibleBaseUrl('https://api.anthropic.com'), '');
  assert.equal(resolveOpenAICompatibleBaseUrl('https://example.com/anthropic'), '');
  assert.equal(resolveOpenAICompatibleBaseUrl(''), '');
});

test('账号池按协议过滤：官方账号不会被打上 OpenAI 端点', () => {
  const accounts = [
    { accountRef: 'acct_official', baseUrl: 'https://api.anthropic.com' },
    { accountRef: 'acct_deepseek', baseUrl: 'https://api.deepseek.com/anthropic' }
  ];
  assert.deepEqual(
    filterAccountsForUpstreamProtocol(accounts, 'claude', 'openai_chat').map((item) => item.accountRef),
    ['acct_deepseek']
  );
  // 没有会话级选择时原样返回。
  assert.deepEqual(
    filterAccountsForUpstreamProtocol(accounts, 'claude', '').map((item) => item.accountRef),
    ['acct_official', 'acct_deepseek']
  );
  // 能力表不认识的协议不是约束，忽略。
  assert.deepEqual(
    filterAccountsForUpstreamProtocol(accounts, 'claude', 'openai_responses').map((item) => item.accountRef),
    ['acct_official', 'acct_deepseek']
  );
});

test('上游目标：基址含版本段，路径固定为 /chat/completions', () => {
  assert.deepEqual(
    resolveUpstreamProtocolTarget('claude', 'openai_chat', { baseUrl: 'https://api.deepseek.com/anthropic' }),
    {
      provider: 'claude',
      protocol: 'openai_chat',
      baseUrl: 'https://api.deepseek.com/v1',
      path: '/chat/completions'
    }
  );
  assert.equal(
    resolveUpstreamProtocolTarget('claude', 'openai_chat', { baseUrl: 'https://api.anthropic.com' }),
    null
  );
});

test('回落协议：显式提示只在本端能适配且 provider 有能力时生效', () => {
  assert.equal(
    fallbackPrivate.resolveFallbackRequestProtocol('openai_responses', 'claude', {
      preferredProtocol: 'openai_chat',
      requestJson: { model: 'deepseek-flash' }
    }),
    'openai_chat'
  );
  // 非 OpenAI 客户端不该被这个提示改道：gemini→claude 的默认回落是 anthropic_messages，
  // 若提示不受客户端协议约束就会变成 openai_chat。
  assert.equal(
    fallbackPrivate.resolveFallbackRequestProtocol('gemini_generate_content', 'claude', {
      preferredProtocol: 'openai_chat',
      requestJson: { model: 'deepseek-flash' }
    }),
    'anthropic_messages'
  );
  // 没有能力的 provider 保持默认回落。
  assert.equal(
    fallbackPrivate.resolveFallbackRequestProtocol('openai_responses', 'gemini', {
      preferredProtocol: 'openai_chat'
    }),
    'gemini_generate_content'
  );
});

test('CLI 识别可迁移账号，并能复制成可用的 codex API Key 账号（幂等）', (t) => {
  const home = makeHome(t);
  const sourceEnv = {
    ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'
  };
  const source = seedClaudeAccount(home, sourceEnv);
  const info = listProtocolChoiceCandidates({
    fs,
    aiHomeDir: home,
    rule: { source: '*', target: 'deepseek-flash', provider: 'claude' }
  });
  assert.ok(info, '应识别出可适配账号');
  assert.equal(info.protocol, 'openai_chat');
  assert.equal(info.candidates.length, 1);
  assert.equal(info.candidates[0].accountRef, source.accountRef);
  assert.equal(info.candidates[0].openAIBaseUrl, 'https://api.deepseek.com/v1');

  const first = copyCandidatesToTarget({ fs, aiHomeDir: home, info });
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].created, true);
  const codexRecords = listAccountCredentialRecords(fs, home, 'codex');
  assert.equal(codexRecords.length, 1);
  assert.equal(codexRecords[0].env.OPENAI_API_KEY, 'sk-deepseek-test-key');
  assert.equal(codexRecords[0].env.OPENAI_BASE_URL, 'https://api.deepseek.com/v1');

  const second = copyCandidatesToTarget({ fs, aiHomeDir: home, info });
  assert.equal(second.created.length, 1);
  assert.equal(second.created[0].created, false, '同一份凭据不应重复建号');
  assert.equal(listAccountCredentialRecords(fs, home, 'codex').length, 1);
});

test('OAuth claude 账号不会被当成可复制源', (t) => {
  const home = makeHome(t);
  const seed = buildApiKeyIdentity('claude', { config: { ANTHROPIC_API_KEY: 'x' } });
  const registration = registerAccountIdentity(fs, home, { provider: 'claude', identitySeed: seed });
  writeAccountCredentials(fs, home, registration.accountRef, { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' });
  const info = listProtocolChoiceCandidates({
    fs,
    aiHomeDir: home,
    rule: { source: '*', target: 'deepseek-flash', provider: 'claude' }
  });
  assert.equal(info, null);
});

test('自动适配：提示在宿主 env 过滤之后注入 AIH_CODEX_FLAGS', (t) => {
  const home = makeHome(t);
  const profile = path.join(home, 'run', 'auth-projections', 'codex', 'acct_test');
  fs.mkdirSync(profile, { recursive: true });
  // 模拟启动链路：launchBaseEnv 里故意带一份「宿主残留」的 flags，upstreamProtocol 走
  // runtimeOptions（而不是进程 env），确保最终 flags 里仍有这个字段。
  const baseEnv = {
    OPENAI_API_KEY: 'k',
    OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1',
    AIH_MODEL_ALIAS: '*=claude.deepseek-flash',
    AIH_CODEX_FLAGS: 'routeOwner=node'
  };
  const env = buildProviderRuntimeEnv('codex', profile, baseEnv, {
    fs,
    path,
    aiHomeDir: home,
    hostHomeDir: home,
    upstreamProtocol: 'openai_chat',
    isLogin: false
  });
  assert.equal(readCodexFlag(env, 'upstreamProtocol'), 'openai_chat');
  assert.equal(readCodexFlag(env, 'routeOwner'), 'node');
});

test('codex -c http_headers：协议提示进入 model_providers.aih_server', () => {
  const env = { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1' };
  setCodexFlag(env, 'upstreamProtocol', 'openai_chat');
  const args = buildCodexProviderArgs(env);
  assert.ok(
    args.includes('model_providers.aih_server.http_headers.X-Aih-Upstream-Protocol=openai_chat'),
    '缺少协议提示头：' + args.join(' ')
  );
  // 非法值不会被拼进 -c。
  const badEnv = { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1' };
  setCodexFlag(badEnv, 'upstreamProtocol', 'openai chat');
  assert.equal(
    buildCodexProviderArgs(badEnv).some((arg) => arg.includes('X-Aih-Upstream-Protocol')),
    false
  );
});

test('协议提示头不会到达上游', () => {
  assert.equal(shouldSkipForwardHeader('X-Aih-Upstream-Protocol'), true);
  assert.equal(shouldSkipForwardHeader('x-aih-upstream-protocol'), true);
  assert.equal(shouldSkipForwardHeader('x-aih-model-alias'), false);
});

function makeInteractiveProcess() {
  return {
    stdin: { isTTY: true },
    env: {},
    stdout: { write() {} },
    stderr: { write() {} }
  };
}

test('交互选择 1：只设置本次会话的协议提示，规则仍是 claude', (t) => {
  const home = makeHome(t);
  seedClaudeAccount(home, {
    ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'
  });
  const processImpl = makeInteractiveProcess();
  const rule = { source: '*', target: 'deepseek-flash', provider: 'claude' };
  const result = maybeOfferModelAliasProtocolChoice({
    rule,
    cliName: 'codex',
    fs,
    aiHomeDir: home,
    processImpl,
    readLine: { question: () => '1' }
  });
  assert.equal(result.rule.provider, 'claude');
  assert.equal(result.upstreamProtocol, 'openai_chat');
  // 不能写进程 env：AIH_CODEX_FLAGS 会被 filterHostEnvVars 删掉。
  assert.deepEqual(processImpl.env, {});
});

test('交互选择 2：复制账号并把本次规则切到 codex', (t) => {
  const home = makeHome(t);
  seedClaudeAccount(home, {
    ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'
  });
  const processImpl = makeInteractiveProcess();
  const result = maybeOfferModelAliasProtocolChoice({
    rule: { source: '*', target: 'deepseek-flash', provider: 'claude' },
    cliName: 'codex',
    fs,
    aiHomeDir: home,
    processImpl,
    readLine: { question: () => '2' },
    spawnSync: () => ({ status: 0 })
  });
  assert.equal(result.rule.provider, 'codex');
  assert.equal(result.rule.account, '');
  assert.equal(result.upstreamProtocol, '');
  assert.equal(listAccountCredentialRecords(fs, home, 'codex').length, 1);
  assert.deepEqual(processImpl.env, {}, '选择 2 不需要协议提示');
});

test('非交互终端：不提问、不改规则、不改环境', (t) => {
  const home = makeHome(t);
  seedClaudeAccount(home, {
    ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'
  });
  const processImpl = makeInteractiveProcess();
  processImpl.stdin.isTTY = false;
  const rule = { source: '*', target: 'deepseek-flash', provider: 'claude' };
  const result = maybeOfferModelAliasProtocolChoice({
    rule,
    cliName: 'codex',
    fs,
    aiHomeDir: home,
    processImpl,
    readLine: { question: () => { throw new Error('should not prompt'); } }
  });
  assert.deepEqual(result, { rule, upstreamProtocol: '' });
  assert.deepEqual(processImpl.env, {});
});

test('选择解析：默认保持现状，1/2 对应两种策略', () => {
  assert.equal(parseChoiceAnswer('1'), 'adapt');
  assert.equal(parseChoiceAnswer('2'), 'copy');
  assert.equal(parseChoiceAnswer('3'), 'keep');
  assert.equal(parseChoiceAnswer(''), 'keep');
  assert.equal(parseChoiceAnswer('nonsense'), 'keep');
});

test('端点表/变体表/提示头的边界输入都不猜', () => {
  assert.equal(resolveOpenAICompatibleBaseUrl('not a url'), '');
  assert.equal(resolveOpenAICompatibleBaseUrl('ftp://api.deepseek.com/anthropic'), '');
  assert.equal(resolveOpenAICompatibleBaseUrl('https://api.deepseek.com/anthropic/extra'), '');
  assert.equal(resolveOpenAICompatibleBaseUrl('https://api.deepseek.com/v1'), '');
  const endpoints = listDualFormatEndpoints();
  assert.ok(endpoints.some((entry) => entry.vendor === 'deepseek'));
  endpoints[0].vendor = 'mutated';
  assert.notEqual(listDualFormatEndpoints()[0].vendor, 'mutated', '列表必须是副本，不能改到内部表');
  const variants = listUpstreamProtocolVariants();
  assert.deepEqual(
    variants.find((variant) => variant.provider === 'claude' && variant.protocol === 'openai_chat'),
    {
      provider: 'claude',
      protocol: 'openai_chat',
      upstreamPath: '/chat/completions',
      hasCopyTarget: true
    }
  );
  assert.deepEqual(filterAccountsForUpstreamProtocol(null, 'claude', 'openai_chat'), []);
  assert.equal(resolveUpstreamProtocolTarget('claude', 'openai_chat', {}), null);
  assert.equal(resolveUpstreamProtocolTarget('unknown', 'openai_chat', {}), null);
});

test('提示头：数组、大小写、非法值', () => {
  assert.equal(readUpstreamProtocolHint({ 'X-Aih-Upstream-Protocol': ['openai_chat'] }), 'openai_chat');
  assert.equal(readUpstreamProtocolHint({ 'x-aih-upstream-protocol': 'OpenAI_Chat' }), 'openai_chat');
  assert.equal(readUpstreamProtocolHint({ 'x-aih-upstream-protocol': 'bad value' }), '');
  assert.equal(readUpstreamProtocolHint({}), '');
  assert.equal(readUpstreamProtocolHint(null), '');
});

test('钉选账号：accountRef 与 CLI 编号两种写法都能识别；不存在的编号不猜', (t) => {
  const home = makeHome(t);
  const registration = seedClaudeAccount(home, {
    ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'
  });
  const byRef = listProtocolChoiceCandidates({
    fs,
    aiHomeDir: home,
    rule: { target: 'deepseek-flash', provider: 'claude', account: registration.accountRef }
  });
  assert.equal(byRef.candidates.length, 1);
  assert.equal(byRef.candidates[0].accountRef, registration.accountRef);
  const byCli = listProtocolChoiceCandidates({
    fs,
    aiHomeDir: home,
    rule: { target: 'deepseek-flash', provider: 'claude', account: String(registration.cliAccountId) }
  });
  assert.equal(byCli.candidates.length, 1);
  assert.equal(
    listProtocolChoiceCandidates({
      fs,
      aiHomeDir: home,
      rule: { target: 'deepseek-flash', provider: 'claude', account: '999' }
    }),
    null
  );
});

test('交互输入非法值会重试；选择 3 保持现状', (t) => {
  const home = makeHome(t);
  seedClaudeAccount(home, {
    ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'
  });
  const processImpl = makeInteractiveProcess();
  const rule = { source: '*', target: 'deepseek-flash', provider: 'claude' };
  const writes = [];
  const stderr = { write(value) { writes.push(String(value || '')); } };
  const answers = ['x', '1'];
  const adapted = maybeOfferModelAliasProtocolChoice({
    rule,
    cliName: 'codex',
    fs,
    aiHomeDir: home,
    processImpl,
    readLine: { question: () => answers.shift() },
    stderr
  });
  assert.equal(adapted.upstreamProtocol, 'openai_chat');
  assert.ok(writes.join('').includes('请输入 1、2 或 3'));

  const kept = maybeOfferModelAliasProtocolChoice({
    rule,
    cliName: 'codex',
    fs,
    aiHomeDir: home,
    processImpl,
    readLine: { question: () => '3' },
    stderr
  });
  assert.deepEqual(kept, { rule, upstreamProtocol: '' });
});

test('复制目标缺失/重载账号池的失败与成功路径', (t) => {
  const home = makeHome(t);
  const missing = copyCandidatesToTarget({ fs, aiHomeDir: home, info: { candidates: [] } });
  assert.equal(missing.error, 'protocol_copy_target_unavailable');

  assert.equal(reloadServerAccountsSync({}), false);
  assert.equal(reloadServerAccountsSync({
    fs,
    aiHomeDir: home,
    readServerConfig: () => { throw new Error('config_unreadable'); }
  }), false);
  assert.equal(reloadServerAccountsSync({
    fs,
    aiHomeDir: home,
    readServerConfig: () => ({}),
    spawnSync: () => { throw new Error('spawn_failed'); }
  }), false);
  assert.equal(reloadServerAccountsSync({
    fs,
    aiHomeDir: home,
    readServerConfig: () => ({}),
    spawnSync: () => ({ status: 1 })
  }), false);

  let payload = null;
  const reloaded = reloadServerAccountsSync({
    fs,
    aiHomeDir: home,
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, managementKey: 'test-key' }),
    spawnSync: (_command, _args, options) => {
      payload = JSON.parse(options.input);
      return { status: 0 };
    }
  });
  assert.equal(reloaded, true);
  assert.match(payload.url, /\/v0\/management\/reload$/);
  assert.equal(payload.key, 'test-key');
});

test('交互连续非法输入三次后保持现状', (t) => {
  const home = makeHome(t);
  seedClaudeAccount(home, {
    ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'
  });
  const processImpl = makeInteractiveProcess();
  const rule = { source: '*', target: 'deepseek-flash', provider: 'claude' };
  const result = maybeOfferModelAliasProtocolChoice({
    rule,
    cliName: 'codex',
    fs,
    aiHomeDir: home,
    processImpl,
    readLine: { question: () => 'x' },
    stderr: { write() {} }
  });
  assert.deepEqual(result, { rule, upstreamProtocol: '' });
});

test('候选读取失败时静默保持现状', () => {
  const rule = { target: 'deepseek-flash', provider: 'claude' };
  const result = maybeOfferModelAliasProtocolChoice({
    rule,
    cliName: 'codex',
    fs: {},
    aiHomeDir: '/tmp/aih-nonexistent',
    processImpl: { stdin: { isTTY: false }, env: {} },
    readLine: null,
    stderr: { write() {} }
  });
  assert.deepEqual(result, { rule, upstreamProtocol: '' });
});

test('账号库读取异常时静默保持现状（启动链路不能被打断）', () => {
  const rule = { target: 'deepseek-flash', provider: 'claude' };
  const throwingFs = new Proxy({}, {
    get() { throw new Error('db_unreadable'); }
  });
  const result = maybeOfferModelAliasProtocolChoice({
    rule,
    cliName: 'codex',
    fs: throwingFs,
    aiHomeDir: '/tmp/aih-nonexistent',
    processImpl: { stdin: { isTTY: false }, env: {} },
    readLine: null,
    stderr: { write() {} }
  });
  assert.deepEqual(result, { rule, upstreamProtocol: '' });
});

test('复制时无法推导身份返回 protocol_copy_failed', (t) => {
  const home = makeHome(t);
  const result = copyCandidatesToTarget({
    fs,
    aiHomeDir: home,
    info: {
      variant: {
        copyTarget: {
          provider: 'codex',
          buildEnv: () => ({ OPENAI_API_KEY: '', OPENAI_BASE_URL: '' })
        }
      },
      candidates: [{ source: {} }]
    }
  });
  assert.equal(result.error, 'protocol_copy_failed');
  assert.deepEqual(result.created, []);
});

test('不支持的 CLI / 空规则直接返回，候选行兼容无 CLI 编号的账号', () => {
  assert.deepEqual(maybeOfferModelAliasProtocolChoice({ rule: null }), { rule: null, upstreamProtocol: '' });
  const rule = { target: 'deepseek-flash', provider: 'claude' };
  assert.deepEqual(
    maybeOfferModelAliasProtocolChoice({ rule, cliName: 'claude' }),
    { rule, upstreamProtocol: '' }
  );
  const line = formatCandidateLine({
    provider: 'claude',
    accountRef: 'acct_1234567890',
    baseUrl: 'https://api.deepseek.com/anthropic',
    openAIBaseUrl: 'https://api.deepseek.com/v1'
  });
  assert.ok(line.includes('acct_1234567'));
});
