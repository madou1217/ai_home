#!/usr/bin/env node
'use strict';

// 生成 sessionchat Go 包的对拍夹具：同一批输入分别喂给 Node 现有实现与 Go 移植，
// 逐字段比较输出。夹具是「快照」，不是第二份实现——Node 侧行为变了就重新生成。
//
// 用法：node scripts/dump-session-chat-parity-cases.js > internal/runtime/providercli/sessionchat/testdata/parity-cases.json
//
// 覆盖：命令构造（新会话/续接/错误）、tmux 包装、stream-json 消息、传输描述符、
// 环境投影、失败分类、账号运行态阻塞、opencode 布局、账号目录旗标。

const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const command = require(path.join(repoRoot, 'lib/server/native-session-chat-command'));
const transport = require(path.join(repoRoot, 'lib/server/native-session-chat-transport'));
const failure = require(path.join(repoRoot, 'lib/server/native-session-chat-failure'));
const envModule = require(path.join(repoRoot, 'lib/server/native-session-chat-env'));
const providerRuntime = require(path.join(repoRoot, 'lib/cli/services/ai-cli/provider-runtime-env'));
const runTmux = require(path.join(repoRoot, 'lib/server/native-run-tmux'));
const geminiEndpoint = require(path.join(repoRoot, 'lib/runtime/gemini-endpoint-env'));
const providerCatalog = require(path.join(repoRoot, 'lib/provider-catalog'));

const NOW_MS = 1755000000000;
const PROVIDERS = [
  'codex', 'claude', 'gemini', 'agy', 'opencode', 'grok', 'zcode', 'qoder',
  'qodercn', 'cline', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn', 'kimi'
];

// 固定 Date.now，账号运行态里的时间戳才能进快照。
const realDateNow = Date.now;
Date.now = () => NOW_MS;

function capture(run) {
  try {
    return { result: run() };
  } catch (error) {
    return { error: { code: error && error.code ? String(error.code) : '', message: String(error && error.message || error) } };
  }
}

function buildStartCases() {
  const cases = [];
  const full = {
    prompt: 'hi there',
    sessionId: 'sid-1',
    model: 'm1',
    imagePaths: ['/tmp/a.png', ' /tmp/b.PNG ', ''],
    interactiveCli: false,
    projectPath: '/proj',
    cliPath: '/nonexistent/opencode'
  };
  for (const provider of PROVIDERS) {
    cases.push({ name: provider + ' headless full', provider, options: full });
    cases.push({ name: provider + ' interactive full', provider, options: { ...full, interactiveCli: true } });
    cases.push({ name: provider + ' headless minimal', provider, options: { prompt: 'x' } });
    cases.push({ name: provider + ' interactive minimal', provider, options: { prompt: '', interactiveCli: true } });
    cases.push({ name: provider + ' headless empty prompt', provider, options: { prompt: '   ' } });
  }
  cases.push({ name: 'agy image model rejected', provider: 'agy', options: { prompt: 'draw', model: 'gemini-3.1-flash-image' } });
  cases.push({ name: 'agy nano banana rejected', provider: 'agy', options: { prompt: 'draw', model: 'nano-banana' } });
  cases.push({ name: 'unknown provider', provider: 'unknown', options: { prompt: 'x' } });
  cases.push({ name: 'opencode v1 layout', provider: 'opencode', options: { ...full }, env: { AIH_OPENCODE_GATEWAY: 'runLayout=v1' } });
  cases.push({ name: 'opencode v2 pinned', provider: 'opencode', options: { ...full, interactiveCli: true }, env: { AIH_OPENCODE_GATEWAY: 'runLayout=v2' } });
  for (const entry of cases) {
    const previous = process.env.AIH_OPENCODE_GATEWAY;
    if (entry.env) process.env.AIH_OPENCODE_GATEWAY = entry.env.AIH_OPENCODE_GATEWAY;
    else delete process.env.AIH_OPENCODE_GATEWAY;
    Object.assign(entry, capture(() => command.buildStartCommand(entry.provider, entry.options)));
    if (previous === undefined) delete process.env.AIH_OPENCODE_GATEWAY;
    else process.env.AIH_OPENCODE_GATEWAY = previous;
  }
  return cases;
}

function buildResumeCases() {
  const cases = [];
  const full = {
    prompt: 'continue please',
    sessionId: 'sid-1',
    model: 'm1',
    imagePaths: ['/tmp/a.png'],
    interactiveCli: false,
    projectDirName: 'proj-dir',
    sessionPath: '/sessions/sid-1.jsonl',
    cliPath: '/nonexistent/opencode'
  };
  for (const provider of PROVIDERS) {
    cases.push({ name: provider + ' resume headless full', provider, options: full });
    cases.push({ name: provider + ' resume interactive full', provider, options: { ...full, interactiveCli: true } });
    cases.push({ name: provider + ' resume headless minimal', provider, options: { prompt: 'x', sessionId: 's' } });
    cases.push({ name: provider + ' resume missing session id', provider, options: { prompt: 'x' } });
    cases.push({ name: provider + ' resume empty prompt', provider, options: { prompt: ' ', sessionId: 's' } });
  }
  cases.push({ name: 'family ide project rejected', provider: 'codebuddy', options: { ...full, projectDirName: 'ide-abc' } });
  cases.push({ name: 'family index.json rejected', provider: 'workbuddycn', options: { ...full, sessionPath: '/sessions/x/index.json' } });
  cases.push({ name: 'agy resume image model', provider: 'agy', options: { ...full, model: 'gemini-3.1-flash-image' } });
  cases.push({ name: 'opencode resume v1', provider: 'opencode', options: { ...full, interactiveCli: true }, env: { AIH_OPENCODE_GATEWAY: 'runLayout=v1' } });
  cases.push({ name: 'unknown resume provider', provider: 'unknown', options: full });
  for (const entry of cases) {
    const previous = process.env.AIH_OPENCODE_GATEWAY;
    process.env.AIH_OPENCODE_GATEWAY = entry.env ? entry.env.AIH_OPENCODE_GATEWAY : 'runLayout=v2';
    Object.assign(entry, capture(() => command.buildResumeCommand(entry.provider, entry.options)));
    if (previous === undefined) delete process.env.AIH_OPENCODE_GATEWAY;
    else process.env.AIH_OPENCODE_GATEWAY = previous;
  }
  return cases;
}

function buildShellCases() {
  const quoteCase = ['', "it's ok", 'plain', "a'b'c"];
  const inner = { command: '/usr/bin/claude', args: ['--print', "it's ok"] };
  const runShell = { inner: 'echo hi', logPath: '/tmp/log file.txt' };
  const claudeShell = { messageFile: '/tmp/a b.jsonl', command: '/bin/claude', args: ['--print'] };
  return {
    quote: quoteCase.map((value) => ({ value, expect: command.shellSingleQuote(value) })),
    socket: ['run-abc_DEF:1234567890', '', '!!!', 'abcdefghijklmnop'].map((value) => ({ value, expect: runTmux.socketForRun(value) })),
    inner: [{ ...inner, expect: runTmux.buildInnerCommandFromArgv(inner.command, inner.args) }],
    runShell: [{ ...runShell, expect: runTmux.buildRunShellCommand(runShell.inner, runShell.logPath) }],
    claudeShell: [{
      ...claudeShell,
      args: claudeShell.args,
      expect: 'cat ' + command.shellSingleQuote(claudeShell.messageFile) + ' - | ' +
        runTmux.buildInnerCommandFromArgv(claudeShell.command, claudeShell.args)
    }]
  };
}

function buildStreamJsonCases() {
  const cases = [
    { name: 'text only', prompt: 'hello', images: [] },
    { name: 'text with blank prompt', prompt: '   ', images: [] },
    { name: 'empty prompt', prompt: '', images: [] },
    {
      name: 'with images',
      prompt: 'look',
      images: [
        { mediaType: 'image/png', data: 'QUJD' },
        { mediaType: 'image/jpeg', data: 'REVG' }
      ]
    }
  ];
  for (const entry of cases) {
    const content = [];
    if (String(entry.prompt || '').trim()) content.push({ type: 'text', text: String(entry.prompt) });
    for (const image of entry.images) {
      if (image.data) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
    }
    if (content.length === 0) content.push({ type: 'text', text: String(entry.prompt) });
    entry.expect = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  }
  return cases;
}

function buildMediaTypeCases() {
  return ['/tmp/a.png', '/tmp/a.JPG', '/tmp/a.jpeg', '/tmp/a.gif', '/tmp/a.webp', '/tmp/a.bmp', 'png', ''].map((value) => ({
    value, expect: command.detectImageMediaType(value)
  }));
}

function buildMiscCases() {
  const configDirArgs = [];
  for (const provider of ['qoder', 'qodercn', 'codex', 'claude', 'unknown']) {
    configDirArgs.push({
      name: provider + ' with dir',
      provider,
      args: ['--model', 'm'],
      runtimeDir: '/runtime/dir',
      expect: command.applyProviderConfigDirArgs(provider, ['--model', 'm'], '/runtime/dir')
    });
  }
  configDirArgs.push({
    name: 'already has flag', provider: 'qoder', args: ['--config-dir', '/x'], runtimeDir: '/runtime/dir',
    expect: command.applyProviderConfigDirArgs('qoder', ['--config-dir', '/x'], '/runtime/dir')
  });
  configDirArgs.push({
    name: 'empty dir', provider: 'qoder', args: [], runtimeDir: '  ',
    expect: command.applyProviderConfigDirArgs('qoder', [], '  ')
  });

  const runsHome = [];
  {
    // 快照里不能出现真实家目录：临时把 os.homedir 钉到稳定路径。
    const realHomedir = os.homedir;
    os.homedir = () => '/home/test';
    const homeDir = '/home/test';
    // Node resolveRunsAiHomeDir 直接读 process.env.AIH_HOST_HOME，必须在采集时固定环境。
    const previous = process.env.AIH_HOST_HOME;
    runsHome.push({ name: 'injected', injected: '/injected', env: {}, homeDir, expect: command.resolveRunsAiHomeDir({ aiHomeDir: '/injected' }) });
    process.env.AIH_HOST_HOME = '/host-home';
    runsHome.push({ name: 'host home env', injected: '', env: { AIH_HOST_HOME: '/host-home' }, homeDir, expect: command.resolveRunsAiHomeDir({}) });
    delete process.env.AIH_HOST_HOME;
    runsHome.push({ name: 'fallback home', injected: '', env: {}, homeDir, expect: command.resolveRunsAiHomeDir({}) });
    if (previous === undefined) delete process.env.AIH_HOST_HOME;
    else process.env.AIH_HOST_HOME = previous;
    os.homedir = realHomedir;
  }

  const binding = {
    name: 'tmux',
    available: true,
    spawnHeadlessRun() { return {}; },
    hasRun() { return false; },
    killRun() { return {}; },
    cleanupRun() { return {}; },
    sendInput() { return {}; }
  };
  const unavailable = { ...binding, available: false };
  const multiplexer = [];
  for (const provider of ['claude', 'codex', 'opencode', 'agy', 'gemini', 'cline']) {
    for (const interactiveCli of [false, true]) {
      for (const platform of ['darwin', 'win32']) {
        for (const [multiplexerEnv, multiplexerBinding] of [['', binding], ['off', binding], ['', unavailable]]) {
          const previous = process.env.AIH_MULTIPLEXER;
          if (multiplexerEnv) process.env.AIH_MULTIPLEXER = multiplexerEnv;
          else delete process.env.AIH_MULTIPLEXER;
          const expect = Boolean(command.resolveNativeRunMultiplexer(provider, { interactiveCli, platform, multiplexerBinding }));
          if (previous === undefined) delete process.env.AIH_MULTIPLEXER;
          else process.env.AIH_MULTIPLEXER = previous;
          multiplexer.push({
            name: provider + ' i=' + interactiveCli + ' p=' + platform + ' env=' + (multiplexerEnv || 'auto') + ' avail=' + multiplexerBinding.available,
            provider,
            interactiveCli,
            platform,
            multiplexerEnv,
            available: multiplexerBinding.available,
            options: { interactiveCli, platform, multiplexerEnv, multiplexerBinding },
            expect
          });
        }
      }
    }
  }

  const openCodeLayout = ['runLayout=v1', 'runLayout=v2', 'runLayout=bad', '', 'baseUrl=http%3A%2F%2Fx,runLayout=v1'].map((value) => {
    const layout = require(path.join(repoRoot, 'lib/runtime/opencode-run-layouts')).resolveOpenCodeRunLayout({
      cliPath: '', env: { AIH_OPENCODE_GATEWAY: value }, force: true,
      spawnSync: () => null
    });
    return {
      env: value,
      expect: { id: layout.id, directoryFlag: layout.directoryFlag || '', standaloneFlag: layout.standaloneFlag || '', pwdDirectory: layout.pwdDirectory === true }
    };
  });

  return { configDirArgs, runsHome, multiplexer, openCodeLayout };
}

function buildTransportCases() {
  const cases = [];
  for (const provider of PROVIDERS) {
    for (const isResume of [false, true]) {
      cases.push({ provider, isResume, expect: transport.resolveNativeChatTransport(provider, { isResume }) });
    }
  }
  return {
    cases,
    tmuxRunProviders: transport.tmuxRunProviders(),
    cliGenerated: PROVIDERS.map((provider) => ({ provider, expect: transport.infersCliGeneratedSessionIdOnExit(provider) }))
  };
}

function buildFailureCases() {
  const cases = [
    { name: 'plain error', provider: 'codex', errorLike: { message: 'tool crashed' } },
    { name: 'rate limited in details', provider: 'codex', errorLike: { code: 'native_session_failed', message: 'native_session_failed', details: { provider: 'codex', detail: '429 Too Many Requests' } } },
    { name: 'rate limited message', provider: 'claude', errorLike: { message: 'upstream said rate_limit exceeded' } },
    { name: 'gemini permission', provider: 'gemini', errorLike: { message: 'rpc error: PERMISSION_DENIED' } },
    { name: 'cline credits', provider: 'cline', errorLike: { message: 'Insufficient balance. Your Cline Credits balance is $0.00' } },
    { name: 'agy eligibility', provider: 'agy', errorLike: { message: 'Eligibility check failed: not available in your location' } },
    { name: 'quota exceeded', provider: 'qoder', errorLike: { message: 'exceeded your current quota' } },
    { name: 'custom code', provider: 'codex', errorLike: { code: 'boom', message: '   ' } },
    { name: 'empty with exit code', provider: 'codex', errorLike: {}, options: { exitCode: 7 } },
    { name: 'empty no exit code', provider: 'codex', errorLike: {}, options: {} },
    { name: 'string-ish message', provider: 'claude', errorLike: { message: 'plain failure' } }
  ];
  for (const entry of cases) {
    entry.expect = failure.classifyNativeSessionFailure(entry.provider, entry.errorLike, entry.options || {});
  }
  return cases;
}

function buildBlockerCases() {
  const outputs = [
    'Eligibility check failed: Your current account is not eligible for Antigravity',
    'Request failed: 401 Unauthorized - invalid api key',
    'Error: Incorrect API key provided',
    'oauth token_expired',
    'refresh token invalid_grant',
    'Not logged in - Please run /login',
    'not signed in. Signing in...',
    'Please select login method:\n  > Google OAuth\n  > GitHub',
    'processed 14012 tokens',
    '\u001b[31m401\u001b[0m Unauthorized: token has expired   ',
    'x'.repeat(600)
  ];
  return outputs.map((output) => ({
    output,
    expect: failure.classifyNativeAccountRuntimeBlocker('claude', output)
  })).concat([
    { output: 'Eligibility check failed: nope', provider: 'agy', expect: failure.classifyNativeAccountRuntimeBlocker('agy', 'Eligibility check failed: nope') }
  ]);
}

function buildEnvironmentCases() {
  const baseEnv = {
    HOME: '/host/home',
    USERPROFILE: '/host/home',
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'host-key',
    openai_base_url: 'http://host',
    ANTHROPIC_AUTH_TOKEN: 'host-token',
    CLAUDE_CONFIG_DIR: '/host/.claude',
    CODEBUDDY_CONFIG_DIR: '/host/.codebuddy',
    KEEP_ME: 'yes'
  };
  const accountEnv = { OPENAI_API_KEY: 'acct-key', AIH_MODEL_ALIAS: 'm' };
  const strips = [{
    name: 'strip account scoped',
    base: baseEnv,
    expect: providerRuntime.stripAccountScopedEnv(baseEnv)
  }];
  const scoped = [{
    name: 'build account scoped',
    base: baseEnv,
    account: accountEnv,
    expect: providerRuntime.buildAccountScopedEnv(baseEnv, accountEnv)
  }];

  const projection = [];
  for (const provider of PROVIDERS) {
    const facts = providerCatalog.getProviderCredentialFacts(provider);
    const apiKeyEnv = (facts.apiKeyEnv || [])[0] || '';
    const variants = [{ name: 'empty', accountEnv: {} }];
    if (apiKeyEnv) variants.push({ name: 'api key', accountEnv: { [apiKeyEnv]: 'key' } });
    for (const variant of variants) {
      for (const flags of [{}, { isLogin: true }, { gateway: true }, { authRelayed: true }]) {
        projection.push({
          provider, variant: variant.name, accountEnv: variant.accountEnv, flags,
          expect: providerRuntime.requiresProviderAuthProjection(provider, variant.accountEnv, flags)
        });
      }
    }
  }

  const scopes = [];
  for (const provider of ['claude', 'opencode', 'workbuddy', 'workbuddycn', 'gemini']) {
    for (const projectionDir of ['/proj/' + provider + '/ref', '/proj/cli-home', '']) {
      for (const flags of [{}, { gateway: true, relayKeepsAccountSandbox: true }, { gateway: true }]) {
        scopes.push({
          provider, projectionDir, accountEnv: {}, flags,
          expect: providerRuntime.resolveProviderRuntimeScope(provider, projectionDir, baseEnv, {
            ...flags, hostHomeDir: '/host/home', platform: 'darwin'
          })
        });
      }
    }
  }

  const gemini = [
    {},
    { GEMINI_BASE_URL: 'http://gw' },
    { VERTEX_AI_PROJECT_ID: 'p', VERTEX_AI_LOCATION: 'us', GEMINI_BASE_URL: 'http://gw' },
    { VERTEX_AI_PROJECT_ID: 'p', VERTEX_AI_PLACEHOLDER: 'true', GEMINI_BASE_URL: 'http://gw' },
    { GOOGLE_GENAI_USE_VERTEXAI: 'TRUE' }
  ].map((account) => ({ accountEnv: account, expect: geminiEndpoint.geminiCliEndpointEnv(account) }));

  const extra = ['gemini', 'claude'].map((provider) => ({
    provider,
    accountEnv: { GEMINI_BASE_URL: 'http://gw' },
    expect: (() => {
      const result = {};
      if (String(provider || '').toLowerCase() === 'gemini') result.GEMINI_CLI_TRUST_WORKSPACE = 'true';
      if (String(provider || '').toLowerCase() === 'gemini') Object.assign(result, geminiEndpoint.geminiCliEndpointEnv({ GEMINI_BASE_URL: 'http://gw' }));
      return result;
    })()
  }));

  const hostHome = [
    { injected: '/injected', env: {}, platform: 'darwin', expect: require(path.join(repoRoot, 'lib/runtime/host-home')).resolveHostHomeDir({ hostHomeDir: '/injected', env: {}, platform: 'darwin' }) },
    { injected: '', env: { AIH_HOST_HOME: '/aih-home' }, platform: 'darwin', expect: require(path.join(repoRoot, 'lib/runtime/host-home')).resolveHostHomeDir({ env: { AIH_HOST_HOME: '/aih-home' }, platform: 'darwin' }) },
    { injected: '', env: { HOME: '/env-home' }, platform: 'darwin', expect: require(path.join(repoRoot, 'lib/runtime/host-home')).resolveHostHomeDir({ env: { HOME: '/env-home' }, platform: 'darwin' }) },
    { injected: '/x/.codex', env: {}, platform: 'darwin', expect: require(path.join(repoRoot, 'lib/runtime/host-home')).resolveHostHomeDir({ hostHomeDir: '/x/.codex', env: {}, platform: 'darwin' }) }
  ];

  const authModes = ['api_key', 'auth-token', 'oauth-browser', '', 'weird'].map((value) => ({
    value,
    expect: failure.buildNativeAccountRuntimeBaseState({ authMode: value }, 'claude', 'acct_x')
  }));

  // buildHostScopedBaseEnv 未在 Node 侧导出（属于 provider-runtime-env 私有实现），
  // 因此宿主作用域基座与整体投影改由 Go 单测覆盖，不进对拍快照。
  return { strips, scoped, projection, scopes, gemini, extra, hostHome, authModes };
}

function main() {
  const payload = {
    version: 1,
    generatedBy: 'scripts/dump-session-chat-parity-cases.js',
    platform: process.platform,
    nowMs: NOW_MS,
    start: buildStartCases(),
    resume: buildResumeCases(),
    shell: buildShellCases(),
    streamJson: buildStreamJsonCases(),
    mediaType: buildMediaTypeCases(),
    misc: buildMiscCases(),
    transport: buildTransportCases(),
    failure: buildFailureCases(),
    blocker: buildBlockerCases(),
    environment: buildEnvironmentCases()
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main();
Date.now = realDateNow;
