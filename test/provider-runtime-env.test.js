const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildProviderRuntimeEnv
} = require('../lib/cli/services/ai-cli/provider-runtime-env');
const {
  parseWindowsProxyServer
} = require('../lib/runtime/windows-system-proxy');
const { CODEX_MANAGED_LAUNCH_ENV } = require('../lib/runtime/codex-launch-context');
const { PROVIDER_ACCOUNT_REF_ENV } = require('../lib/runtime/provider-session-context');

test('provider runtime env marks codex launches managed and clears the marker elsewhere', () => {
  // 单一装配线保证：任何经 buildProviderRuntimeEnv 组出来的 codex env（PTY /
  // WebUI 原生会话 / 登录 / 用量采集）都带 managed-launch 标记，全局 codex hook
  // 因此透传本账号鉴权，而不是回落到 `codex set-default` 账号重新推导。
  const codexEnv = buildProviderRuntimeEnv('codex', '/home/u/.ai_home/run/auth-projections/codex/acct_0123456789abcdef0123', {
    HOME: '/home/u',
    PATH: '/usr/bin'
  }, { fs, path, platform: 'linux' });
  assert.equal(codexEnv[CODEX_MANAGED_LAUNCH_ENV], '1');

  const claudeEnv = buildProviderRuntimeEnv('claude', '/home/u/.ai_home/run/auth-projections/claude/acct_0123456789abcdef0123', {
    HOME: '/home/u',
    PATH: '/usr/bin',
    [CODEX_MANAGED_LAUNCH_ENV]: '1'
  }, { fs, path, platform: 'linux' });
  assert.equal(claudeEnv[CODEX_MANAGED_LAUNCH_ENV], undefined);
});

test('provider runtime env rejects empty and object profile paths before composing provider home paths', () => {
  ['', null, { toString: () => '/tmp/[object Object]' }].forEach((profileDir) => {
    assert.throws(
      () => buildProviderRuntimeEnv('grok', profileDir, {
        HOME: '/home/u',
        PATH: '/usr/bin'
      }, { fs, path, platform: 'linux' }),
      /provider_runtime_profile_dir_invalid/
    );
  });
});

test('provider runtime env replaces inherited hook account context with the selected account', () => {
  const accountRef = 'acct_0123456789abcdef0123';
  const env = buildProviderRuntimeEnv('grok', '/home/u/.ai_home/run/auth-projections/grok/account', {
    HOME: '/home/u',
    PATH: '/usr/bin',
    [PROVIDER_ACCOUNT_REF_ENV]: 'acct_aaaaaaaaaaaaaaaaaaaa'
  }, {
    fs,
    path,
    platform: 'linux',
    accountRef
  });
  assert.equal(env[PROVIDER_ACCOUNT_REF_ENV], accountRef);

  const unscoped = buildProviderRuntimeEnv('grok', '/home/u/.ai_home/run/login/grok', {
    HOME: '/home/u',
    PATH: '/usr/bin',
    [PROVIDER_ACCOUNT_REF_ENV]: accountRef
  }, { fs, path, platform: 'linux' });
  assert.equal(unscoped[PROVIDER_ACCOUNT_REF_ENV], undefined);
});

test('provider runtime env strips the trailing /v1 the Anthropic SDK re-appends', () => {
  // 中转常把 base 存成 `http://host:4000/v1`，而 Anthropic SDK 自己会再拼
  // `/v1/messages` → `/v1/v1/messages` → 404，Claude Code 把任何 404 都渲染成
  // 「模型不存在」，把问题甩给模型而不是 URL。原生 CLI 的 env 必须先去掉版本段。
  const relayEnv = buildProviderRuntimeEnv('claude', '/home/u/.ai_home/run/auth-projections/claude/acct_0123456789abcdef0123', {
    HOME: '/home/u',
    PATH: '/usr/bin'
  }, {
    fs,
    path,
    platform: 'linux',
    accountEnv: {
      ANTHROPIC_API_KEY: 'sk-relay',
      ANTHROPIC_BASE_URL: 'http://130.210.35.157:4000/v1'
    }
  });
  assert.equal(relayEnv.ANTHROPIC_BASE_URL, 'http://130.210.35.157:4000');

  // 不带版本段的第三方代理（GLM/…/anthropic）原样保留。
  const glmEnv = buildProviderRuntimeEnv('claude', '/home/u/.ai_home/run/auth-projections/claude/acct_0123456789abcdef0123', {
    HOME: '/home/u',
    PATH: '/usr/bin'
  }, {
    fs,
    path,
    platform: 'linux',
    accountEnv: {
      ANTHROPIC_API_KEY: 'sk-glm',
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic'
    }
  });
  assert.equal(glmEnv.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
});

test('provider runtime env prepends project-local runtime tool paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-tools-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeBin = path.join(root, '.runtime-tools', 'bin');
  const npmBin = path.join(root, '.runtime-tools', 'npm', 'node_modules', '.bin');
  const nodeBin = path.join(root, '.node-runtime', 'node-v22.16.0-linux-x64', 'bin');
  fs.mkdirSync(runtimeBin, { recursive: true });
  fs.mkdirSync(npmBin, { recursive: true });
  fs.mkdirSync(nodeBin, { recursive: true });

  const env = buildProviderRuntimeEnv('claude', '/home/u/.ai_home/run/auth-projections/claude/acct_0123456789abcdef0123', {
    HOME: '/home/u',
    PATH: `/usr/bin${path.delimiter}${runtimeBin}`
  }, {
    fs,
    path,
    platform: 'linux',
    runtimeRootDir: root
  });

  assert.deepEqual(env.PATH.split(path.delimiter).slice(0, 4), [
    runtimeBin,
    npmBin,
    nodeBin,
    '/usr/bin'
  ]);
});

test('Windows provider runtime inherits enabled WinINET proxy without overriding explicit env', () => {
  const registryOutput = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    192.168.3.76:6152
`;
  const execCalls = [];
  const env = buildProviderRuntimeEnv('grok', 'C:\\Users\\u\\.ai_home\\run\\login\\grok', {
    USERPROFILE: 'C:\\Users\\u',
    PATH: 'C:\\Windows\\System32'
  }, {
    platform: 'win32',
    execFileSync(command, args, options) {
      execCalls.push({ command, args, options });
      return registryOutput;
    }
  });

  assert.equal(env.HTTP_PROXY, 'http://192.168.3.76:6152');
  assert.equal(env.HTTPS_PROXY, 'http://192.168.3.76:6152');
  assert.equal(env.http_proxy, 'http://192.168.3.76:6152');
  assert.equal(env.https_proxy, 'http://192.168.3.76:6152');
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].options.windowsHide, true);

  const explicitEnv = buildProviderRuntimeEnv('grok', 'C:\\Users\\u\\.ai_home\\run\\login\\grok', {
    USERPROFILE: 'C:\\Users\\u',
    PATH: 'C:\\Windows\\System32',
    HTTPS_PROXY: 'http://explicit-proxy:8080'
  }, {
    platform: 'win32',
    execFileSync() {
      throw new Error('registry must not be queried');
    }
  });
  assert.equal(explicitEnv.HTTPS_PROXY, 'http://explicit-proxy:8080');
  assert.equal(explicitEnv.https_proxy, 'http://explicit-proxy:8080');
});

test('Windows proxy parser supports protocol-specific and socks entries', () => {
  assert.deepEqual(parseWindowsProxyServer('http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080'), {
    HTTP_PROXY: 'http://127.0.0.1:8080',
    HTTPS_PROXY: 'http://127.0.0.1:8443',
    ALL_PROXY: 'socks5://127.0.0.1:1080'
  });
});
