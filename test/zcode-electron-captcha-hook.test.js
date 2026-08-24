'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { getDesktopLaunchStrategy } = require('../lib/server/desktop-launch');
const { buildZcodeDesktopApplicationName } = require('../lib/runtime/account-app-process-marker');
const captchaHook = require('../lib/runtime/zcode-electron-captcha-hook');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const CAPTCHA_HOOK_STATE_ENV = 'AIH_ZCODE_CAPTCHA_HOOK_STATE_PATH';

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
    deps: {
      resolveZcodeCredentialSecret: () => 'credential-secret',
      nodeExecutablePath: '/opt/node/bin/node'
    },
    ...overrides
  };
}

test('zcode macOS 启动保留现有 NODE_OPTIONS，并把影子入口所需 hook 路径放进账号 env', () => {
  const strategy = getDesktopLaunchStrategy('zcode');
  const env = { NODE_OPTIONS: '--trace-warnings' };
  const ctx = buildContext();

  strategy.decorateResolvedLaunchEnv(env, {
    executablePath: '/Applications/ZCode.app/Contents/MacOS/ZCode',
    bundlePath: '/Applications/ZCode.app'
  }, ctx);

  assert.equal(env.NODE_OPTIONS, '--trace-warnings');
  assert.match(env.AIH_ZCODE_CAPTCHA_HOOK_MODULE_PATH, /zcode-electron-captcha-hook\.js/);
  assert.equal(env.AIH_ZCODE_CAPTCHA_FORCE_INTERACTIVE, '1');
  assert.equal(
    env[CAPTCHA_HOOK_STATE_ENV],
    '/sandbox/account/.aih-runtime/zcode-captcha-hook.json'
  );
});

test('验证码 runtime 暴露可独立验证的 renderer hook 安装入口', () => {
  assert.equal(typeof captchaHook.installZcodeCaptchaRendererHook, 'function');
  assert.equal(typeof captchaHook.buildZcodeCaptchaRendererSource, 'function');
  assert.equal(typeof captchaHook.installZcodeElectronCaptchaHook, 'function');
});

function encodeCaptchaParam(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function buildRendererGlobal(initAliyunCaptcha) {
  const messages = [];
  return {
    atob(value) {
      return Buffer.from(value, 'base64').toString('binary');
    },
    console: {
      debug(message) {
        messages.push(message);
      }
    },
    __messages: messages,
    ...(initAliyunCaptcha ? { initAliyunCaptcha } : {})
  };
}

function readLastRendererObservation(rendererGlobal) {
  const prefix = captchaHook.ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX;
  assert.equal(typeof prefix, 'string');
  const message = rendererGlobal.__messages.filter((item) => item.startsWith(prefix)).at(-1);
  assert.ok(message, 'renderer hook 应上报不含凭据的观测状态');
  return JSON.parse(message.slice(prefix.length));
}

function installRendererHook(rendererGlobal) {
  return captchaHook.installZcodeCaptchaRendererHook(
    rendererGlobal,
    captchaHook.ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX,
    { forceInteractive: true }
  );
}

test('renderer hook 对包含 securityToken 的 SDK success 参数保持完全透传', () => {
  const completeParam = encodeCaptchaParam({
    certifyId: 'cert-complete',
    isSign: true,
    sceneId: 'scene-1',
    securityToken: 'security-token-value'
  });
  const received = [];
  const failures = [];
  const rendererGlobal = buildRendererGlobal((options) => options.success(completeParam));

  installRendererHook(rendererGlobal);
  rendererGlobal.initAliyunCaptcha({
    success: (value) => received.push(value),
    fail: (value) => failures.push(value)
  });

  assert.deepEqual(received, [ completeParam ]);
  assert.deepEqual(failures, []);
  assert.deepEqual(readLastRendererObservation(rendererGlobal), {
    version: 1,
    forceInteractive: true,
    initCallCount: 1,
    instanceCount: 0,
    interactiveOnlyInstanceCount: 0,
    successCount: 1,
    sdkFailCount: 0,
    recognizedSuccessCount: 1,
    unrecognizedSuccessCount: 0,
    incompleteSuccessCount: 0,
    completeSuccessCount: 1,
    lastSuccessKind: 'complete'
  });
});

test('renderer hook 不在 SDK success 后伪造 fail，缺少 securityToken 时仍保持原值透传', () => {
  const incompleteParam = encodeCaptchaParam({
    certifyId: 'cert-incomplete',
    isSign: true,
    sceneId: 'scene-1'
  });
  const received = [];
  const failures = [];
  const rendererGlobal = buildRendererGlobal((options) => options.success(incompleteParam));

  installRendererHook(rendererGlobal);
  rendererGlobal.initAliyunCaptcha({
    success: (value) => received.push(value),
    fail: (value) => failures.push(value)
  });

  assert.deepEqual(received, [ incompleteParam ]);
  assert.deepEqual(failures, []);
  assert.deepEqual(readLastRendererObservation(rendererGlobal), {
    version: 1,
    forceInteractive: true,
    initCallCount: 1,
    instanceCount: 0,
    interactiveOnlyInstanceCount: 0,
    successCount: 1,
    sdkFailCount: 0,
    recognizedSuccessCount: 1,
    unrecognizedSuccessCount: 0,
    incompleteSuccessCount: 1,
    completeSuccessCount: 0,
    lastSuccessKind: 'incomplete'
  });
});

test('renderer hook 对官方 opaque captchaVerifyParam 保持透传且不猜测 token 结构', () => {
  const opaqueParam = 'opaque-captcha-param-without-json-shape';
  const received = [];
  const failures = [];
  const rendererGlobal = buildRendererGlobal((options) => options.success(opaqueParam));

  installRendererHook(rendererGlobal);
  rendererGlobal.initAliyunCaptcha({
    success: (value) => received.push(value),
    fail: (value) => failures.push(value)
  });

  assert.deepEqual(received, [ opaqueParam ]);
  assert.deepEqual(failures, []);
  assert.deepEqual(readLastRendererObservation(rendererGlobal), {
    version: 1,
    forceInteractive: true,
    initCallCount: 1,
    instanceCount: 0,
    interactiveOnlyInstanceCount: 0,
    successCount: 1,
    sdkFailCount: 0,
    recognizedSuccessCount: 0,
    unrecognizedSuccessCount: 1,
    incompleteSuccessCount: 0,
    completeSuccessCount: 0,
    lastSuccessKind: 'unrecognized'
  });
});

test('renderer hook 能代理 SDK 在安装 hook 后对 initAliyunCaptcha 的赋值', () => {
  const incompleteParam = encodeCaptchaParam({
    certifyId: 'cert-late-assignment',
    isSign: true,
    sceneId: 'scene-1'
  });
  const received = [];
  const rendererGlobal = buildRendererGlobal();

  installRendererHook(rendererGlobal);
  rendererGlobal.initAliyunCaptcha = (options) => options.success(incompleteParam);
  rendererGlobal.initAliyunCaptcha({
    success: (value) => received.push(value),
    fail: () => assert.fail('hook 不得在 success 终态后伪造 fail')
  });

  assert.deepEqual(received, [ incompleteParam ]);
});

test('renderer hook 在 getInstance 阶段隐藏无感方法并保持 SDK 方法 this 绑定', () => {
  let deliveredInstance;
  let showCalls = 0;
  let tracelessCalls = 0;
  const sdkInstance = {
    show() {
      assert.equal(this, sdkInstance);
      showCalls += 1;
    },
    startTracelessVerification() {
      tracelessCalls += 1;
    }
  };
  const rendererGlobal = buildRendererGlobal((options) => options.getInstance(sdkInstance));

  installRendererHook(rendererGlobal);
  rendererGlobal.initAliyunCaptcha({
    getInstance: (instance) => {
      deliveredInstance = instance;
    },
    success: () => {},
    fail: () => {}
  });

  assert.ok(deliveredInstance);
  assert.equal(deliveredInstance.startTracelessVerification, undefined);
  deliveredInstance.show();
  assert.equal(showCalls, 1);
  assert.equal(tracelessCalls, 0);
  const observation = readLastRendererObservation(rendererGlobal);
  assert.equal(observation.instanceCount, 1);
  assert.equal(observation.interactiveOnlyInstanceCount, 1);
  assert.equal(observation.forceInteractive, true);
});

test('renderer 注入脚本在隔离上下文执行后仍提前关闭无感入口', () => {
  let deliveredInstance;
  const sdkInstance = {
    show() {},
    startTracelessVerification() {}
  };
  const rendererGlobal = buildRendererGlobal();

  vm.runInNewContext(captchaHook.buildZcodeCaptchaRendererSource({ forceInteractive: true }), {
    window: rendererGlobal
  });
  rendererGlobal.initAliyunCaptcha = (options) => options.getInstance(sdkInstance);
  rendererGlobal.initAliyunCaptcha({
    getInstance: (instance) => {
      deliveredInstance = instance;
    },
    success: () => {},
    fail: () => {}
  });

  assert.equal(deliveredInstance.startTracelessVerification, undefined);
});

test('Electron 主进程在 dom-ready 注入 renderer hook，并仅落盘无凭据安装状态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-captcha-hook-test-'));
  const statePath = path.join(root, 'runtime', 'state.json');
  const app = new EventEmitter();
  app.isReady = () => false;
  const electron = {
    app,
    webContents: { getAllWebContents: () => [] }
  };
  let resolveInjection;
  const injection = new Promise((resolve) => {
    resolveInjection = resolve;
  });

  try {
    const result = captchaHook.installZcodeElectronCaptchaHook({
      electron,
      fs,
      path,
      processObject: {
        env: { AIH_ZCODE_CAPTCHA_FORCE_INTERACTIVE: '1' },
        pid: 4242,
        type: 'browser',
        versions: { electron: '41.0.3' }
      },
      statePath
    });
    assert.equal(result.installed, true);

    const contents = new EventEmitter();
    contents.isDestroyed = () => false;
    contents.executeJavaScript = async (source, userGesture) => {
      resolveInjection({ source, userGesture });
      return { installed: true, reused: false };
    };
    app.emit('web-contents-created', {}, contents);
    contents.emit('dom-ready');

    const injected = await injection;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      injected.source,
      captchaHook.buildZcodeCaptchaRendererSource({ forceInteractive: true })
    );
    assert.equal(injected.userGesture, true);

    contents.emit('console-message', {}, {
      message: `${captchaHook.ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX}${JSON.stringify({
        version: 1,
        forceInteractive: true,
        initCallCount: 1,
        instanceCount: 1,
        interactiveOnlyInstanceCount: 1,
        successCount: 1,
        sdkFailCount: 0,
        recognizedSuccessCount: 0,
        unrecognizedSuccessCount: 1,
        incompleteSuccessCount: 0,
        completeSuccessCount: 0,
        lastSuccessKind: 'unrecognized',
        securityToken: 'must-not-persist'
      })}`
    });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(Object.keys(state).sort(), [
      'lastRendererStatus',
      'mainInstalled',
      'mainProcessId',
      'rendererInstallCount',
      'rendererInstalled',
      'rendererObservation',
      'updatedAt',
      'version'
    ]);
    assert.equal(state.version, 3);
    assert.equal(state.mainInstalled, true);
    assert.equal(state.mainProcessId, 4242);
    assert.equal(state.rendererInstalled, true);
    assert.equal(state.rendererInstallCount, 1);
    assert.equal(state.lastRendererStatus, 'installed');
    assert.deepEqual(state.rendererObservation, {
      version: 1,
      forceInteractive: true,
      initCallCount: 1,
      instanceCount: 1,
      interactiveOnlyInstanceCount: 1,
      successCount: 1,
      sdkFailCount: 0,
      recognizedSuccessCount: 0,
      unrecognizedSuccessCount: 1,
      incompleteSuccessCount: 0,
      completeSuccessCount: 0,
      lastSuccessKind: 'unrecognized'
    });
    assert.equal(JSON.stringify(state).includes('must-not-persist'), false);
    assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
