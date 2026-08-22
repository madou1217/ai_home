'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const {
  AIH_ZCODE_SESSION_SCOPE_ENV,
  patchZcodeAgentSource,
  scopeZcodeSessionId
} = require('../lib/runtime/zcode-session-attribution-hook');
const { getDesktopLaunchStrategy } = require('../lib/server/desktop-launch');
const { buildZcodeDesktopApplicationName } = require('../lib/runtime/account-app-process-marker');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const OTHER_ACCOUNT_REF = 'acct_ffffffffffffffffffff';
const NATIVE_SESSION_ID = '03961b9d-c562-47c2-a142-ec408a21d59d';

function buildContext(overrides = {}) {
  return {
    provider: 'zcode',
    account: { accountRef: ACCOUNT_REF },
    accountRef: ACCOUNT_REF,
    profileDir: '/sandbox/account',
    userDataDir: '/sandbox/account/electron-user-data',
    applicationName: buildZcodeDesktopApplicationName(ACCOUNT_REF),
    platformKey: 'macos',
    path: path.posix,
    aiHomeDir: '/aih',
    getBaseEnv: () => ({ HOME: '/host' }),
    deps: { resolveZcodeCredentialSecret: () => 'credential-secret' },
    ...overrides
  };
}

test('账号作用域把共享 native session 稳定映射为 UUID，跨账号绝不复用', () => {
  const first = scopeZcodeSessionId(NATIVE_SESSION_ID, ACCOUNT_REF);
  const repeated = scopeZcodeSessionId(NATIVE_SESSION_ID, ACCOUNT_REF);
  const other = scopeZcodeSessionId(NATIVE_SESSION_ID, OTHER_ACCOUNT_REF);

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(repeated, first);
  assert.notEqual(other, first);
  assert.notEqual(first, NATIVE_SESSION_ID);
});

test('源码 hook 同步改写 x-session-id 与 Anthropic metadata.user_id.session_id', () => {
  const source = [
    'const Wgo="sess_",Hgo="subagent_agent_",Vgo="x-session-id";',
    'function zlr(e,t){let r=e;for(const n of t)r.startsWith(n)&&(r=r.slice(n.length));return r||e}',
    'function vXe(e){let t=xXe(e.sessionId);return{...t?{[Vgo]:t}:{}}}',
    'function xXe(e){if(e)return zlr(e,[Wgo,Hgo])}',
    'function Qgo(e){return JSON.stringify({device_id:e.deviceMid,account_uuid:"",session_id:xXe(e.sessionId)??""})}',
    'function s(){}',
    's(xXe,"normalizeModelSessionIdForAttribution");',
    'module.exports={vXe,Qgo};'
  ].join('');
  const patched = patchZcodeAgentSource(source);
  const moduleObj = { exports: {} };
  const context = {
    module: moduleObj,
    exports: moduleObj.exports,
    JSON,
    globalThis: {
      __aihScopeZcodeSessionId: (sessionId) => scopeZcodeSessionId(sessionId, ACCOUNT_REF)
    }
  };
  vm.runInNewContext(patched, context);

  const headerSessionId = moduleObj.exports.vXe({ sessionId: `sess_${NATIVE_SESSION_ID}` })['x-session-id'];
  const metadata = JSON.parse(moduleObj.exports.Qgo({
    deviceMid: 'device-account-2',
    sessionId: `sess_${NATIVE_SESSION_ID}`
  }));

  assert.equal(metadata.session_id, headerSessionId);
  assert.equal(headerSessionId, scopeZcodeSessionId(NATIVE_SESSION_ID, ACCOUNT_REF));
  assert.equal(metadata.device_id, 'device-account-2');
});

test('显式 agent runner 能在真实 CJS 入口加载前应用账号作用域 hook', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-session-hook-test-'));
  const fixturePath = path.join(root, 'zcode.cjs');
  try {
    fs.writeFileSync(fixturePath, [
      'const Wgo="sess_",Hgo="subagent_agent_";',
      'function zlr(e,t){let r=e;for(const n of t)r.startsWith(n)&&(r=r.slice(n.length));return r||e}',
      'function xXe(e){if(e)return zlr(e,[Wgo,Hgo])}',
      'function s(){}',
      's(xXe,"normalizeModelSessionIdForAttribution");',
      `process.stdout.write(xXe("sess_${NATIVE_SESSION_ID}"));`
    ].join(''));
    const runnerPath = require.resolve('../lib/runtime/zcode-session-attribution-runner');
    const result = spawnSync(process.execPath, [runnerPath, fixturePath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [AIH_ZCODE_SESSION_SCOPE_ENV]: ACCOUNT_REF
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, scopeZcodeSessionId(NATIVE_SESSION_ID, ACCOUNT_REF));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('zcode desktop 仅在 macOS 注入 agent runner 与账号作用域', () => {
  const strategy = getDesktopLaunchStrategy('zcode');
  const macEnv = {};
  const macContext = buildContext({ deps: {
    resolveZcodeCredentialSecret: () => 'credential-secret',
    nodeExecutablePath: '/opt/node/bin/node'
  } });
  strategy.decorateLaunchEnv(macEnv, macContext);
  strategy.decorateResolvedLaunchEnv(macEnv, {
    executablePath: '/Applications/ZCode.app/Contents/MacOS/ZCode',
    bundlePath: '/Applications/ZCode.app'
  }, macContext);

  assert.equal(macEnv[AIH_ZCODE_SESSION_SCOPE_ENV], ACCOUNT_REF);
  assert.equal(macEnv.ZCODE_AGENT_SERVER_COMMAND, '/opt/node/bin/node');
  const args = JSON.parse(macEnv.ZCODE_AGENT_SERVER_ARGS_JSON);
  assert.match(args[0], /zcode-session-attribution-runner\.js$/);
  assert.equal(args[1], '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
  assert.deepEqual(args.slice(2), ['app-server', '--stdio']);

  const windowsEnv = {};
  const windowsContext = buildContext({ platformKey: 'windows' });
  strategy.decorateLaunchEnv(windowsEnv, windowsContext);
  strategy.decorateResolvedLaunchEnv(windowsEnv, {
    executablePath: 'C:\\Program Files\\ZCode\\ZCode.exe',
    bundlePath: ''
  }, windowsContext);
  assert.equal(windowsEnv[AIH_ZCODE_SESSION_SCOPE_ENV], undefined);
  assert.equal(windowsEnv.ZCODE_AGENT_SERVER_COMMAND, undefined);
});
