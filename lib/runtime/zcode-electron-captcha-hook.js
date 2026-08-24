'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const AIH_ZCODE_CAPTCHA_HOOK_STATE_ENV = 'AIH_ZCODE_CAPTCHA_HOOK_STATE_PATH';
const AIH_ZCODE_CAPTCHA_FORCE_INTERACTIVE_ENV = 'AIH_ZCODE_CAPTCHA_FORCE_INTERACTIVE';
const ZCODE_CAPTCHA_HOOK_VERSION = 3;
const ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX = '__AIH_ZCODE_CAPTCHA_STATE__:';
const RENDERER_OBSERVATION_COUNTER_KEYS = Object.freeze([
  'initCallCount',
  'instanceCount',
  'interactiveOnlyInstanceCount',
  'successCount',
  'sdkFailCount',
  'recognizedSuccessCount',
  'unrecognizedSuccessCount',
  'incompleteSuccessCount',
  'completeSuccessCount'
]);
const RENDERER_SUCCESS_KINDS = new Set([
  'none',
  'complete',
  'incomplete',
  'unrecognized'
]);

// 该函数会被序列化后注入 renderer，必须保持自包含，不能引用模块级变量。
function installZcodeCaptchaRendererHook(globalObject = globalThis, configuredEventPrefix, options = {}) {
  const globalMarker = '__aihZcodeCaptchaRendererHookV3';
  const wrappedMarker = '__aihZcodeCaptchaInitWrappedV3';
  const eventPrefix = typeof configuredEventPrefix === 'string' && configuredEventPrefix
    ? configuredEventPrefix
    : '__AIH_ZCODE_CAPTCHA_STATE__:';
  const forceInteractive = options && options.forceInteractive === true;

  if (!globalObject || (typeof globalObject !== 'object' && typeof globalObject !== 'function')) {
    return { installed: false, reason: 'invalid_global' };
  }
  if (globalObject[globalMarker]) return { installed: true, reused: true };

  const observation = {
    version: 1,
    forceInteractive,
    initCallCount: 0,
    instanceCount: 0,
    interactiveOnlyInstanceCount: 0,
    successCount: 0,
    sdkFailCount: 0,
    recognizedSuccessCount: 0,
    unrecognizedSuccessCount: 0,
    incompleteSuccessCount: 0,
    completeSuccessCount: 0,
    lastSuccessKind: 'none'
  };

  function reportObservation() {
    const debug = globalObject.console && globalObject.console.debug;
    if (typeof debug !== 'function') return;
    try {
      Reflect.apply(debug, globalObject.console, [ `${eventPrefix}${JSON.stringify(observation)}` ]);
    } catch (_error) {}
  }

  function parseCaptchaParam(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;

    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_error) {
        return null;
      }
    }

    if (typeof globalObject.atob !== 'function') return null;
    const unpadded = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!unpadded || !/^[A-Za-z0-9+/]*={0,2}$/.test(unpadded)) return null;
    const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
    try {
      const parsed = JSON.parse(globalObject.atob(padded));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function inspectCaptchaParam(value) {
    const parsed = parseCaptchaParam(value);
    if (!parsed) return { recognized: false, hasSecurityToken: false };
    const knownKeys = [ 'certifyId', 'isSign', 'sceneId', 'securityToken' ];
    const recognized = knownKeys.some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
    return {
      recognized,
      hasSecurityToken: typeof parsed.securityToken === 'string'
        && parsed.securityToken.trim().length > 0
    };
  }

  function wrapCaptchaInstance(instance) {
    if (!instance || (typeof instance !== 'object' && typeof instance !== 'function')) {
      return instance;
    }
    observation.instanceCount += 1;
    if (!forceInteractive || typeof instance.startTracelessVerification !== 'function') {
      reportObservation();
      return instance;
    }

    let wrapped;
    try {
      wrapped = new Proxy(instance, {
        get(target, property) {
          if (property === 'startTracelessVerification'
            && observation.completeSuccessCount === 0) {
            return undefined;
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function'
            ? (...args) => Reflect.apply(value, target, args)
            : value;
        }
      });
    } catch (_error) {
      reportObservation();
      return instance;
    }
    observation.interactiveOnlyInstanceCount += 1;
    reportObservation();
    return wrapped;
  }

  function wrapInitAliyunCaptcha(original) {
    if (typeof original !== 'function' || original[wrappedMarker]) return original;
    const wrapped = function (...args) {
      observation.initCallCount += 1;
      const options = args[0];
      if (!options || typeof options !== 'object') {
        reportObservation();
        return Reflect.apply(original, this, args);
      }
      const onSuccess = options.success;
      const onFail = options.fail;
      if (typeof onSuccess !== 'function' || typeof onFail !== 'function') {
        reportObservation();
        return Reflect.apply(original, this, args);
      }

      const hookedOptions = {
        ...options,
        ...(typeof options.getInstance === 'function' ? {
          getInstance(instance, ...instanceArgs) {
            return Reflect.apply(options.getInstance, this, [
              wrapCaptchaInstance(instance),
              ...instanceArgs
            ]);
          }
        } : {}),
        success(value, ...successArgs) {
          observation.successCount += 1;
          const inspection = inspectCaptchaParam(value);
          if (!inspection.recognized) {
            observation.unrecognizedSuccessCount += 1;
            observation.lastSuccessKind = 'unrecognized';
            reportObservation();
            return Reflect.apply(onSuccess, this, [ value, ...successArgs ]);
          }
          if (inspection.recognized && !inspection.hasSecurityToken) {
            observation.recognizedSuccessCount += 1;
            observation.incompleteSuccessCount += 1;
            observation.lastSuccessKind = 'incomplete';
            reportObservation();
            return Reflect.apply(onSuccess, this, [ value, ...successArgs ]);
          }
          observation.recognizedSuccessCount += 1;
          observation.completeSuccessCount += 1;
          observation.lastSuccessKind = 'complete';
          reportObservation();
          return Reflect.apply(onSuccess, this, [ value, ...successArgs ]);
        },
        fail(value, ...failArgs) {
          observation.sdkFailCount += 1;
          reportObservation();
          return Reflect.apply(onFail, this, [ value, ...failArgs ]);
        }
      };
      return Reflect.apply(original, this, [ hookedOptions, ...args.slice(1) ]);
    };
    Object.defineProperty(wrapped, wrappedMarker, { value: true });
    return wrapped;
  }

  const descriptor = Object.getOwnPropertyDescriptor(globalObject, 'initAliyunCaptcha');
  const current = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : globalObject.initAliyunCaptcha;

  if (descriptor && descriptor.configurable === false) {
    if (descriptor.writable !== true || typeof current !== 'function') {
      return { installed: false, reason: 'non_configurable_init' };
    }
    globalObject.initAliyunCaptcha = wrapInitAliyunCaptcha(current);
  } else {
    let wrappedCurrent = wrapInitAliyunCaptcha(current);
    Object.defineProperty(globalObject, 'initAliyunCaptcha', {
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable : true,
      get() {
        return wrappedCurrent;
      },
      set(value) {
        wrappedCurrent = wrapInitAliyunCaptcha(value);
      }
    });
  }

  Object.defineProperty(globalObject, globalMarker, {
    configurable: false,
    enumerable: false,
    value: observation
  });
  reportObservation();
  return { installed: true, reused: false };
}

function buildZcodeCaptchaRendererSource(options = {}) {
  return `;(${installZcodeCaptchaRendererHook.toString()})(window,${JSON.stringify(ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX)},${JSON.stringify({
    forceInteractive: options.forceInteractive === true
  })});`;
}

function normalizeRendererObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    return null;
  }
  const lastSuccessKind = String(value.lastSuccessKind || '');
  if (!RENDERER_SUCCESS_KINDS.has(lastSuccessKind)) return null;
  const normalized = { version: 1 };
  if (typeof value.forceInteractive !== 'boolean') return null;
  normalized.forceInteractive = value.forceInteractive;
  for (const key of RENDERER_OBSERVATION_COUNTER_KEYS) {
    const count = Number(value[key]);
    if (!Number.isSafeInteger(count) || count < 0) return null;
    normalized[key] = count;
  }
  normalized.lastSuccessKind = lastSuccessKind;
  return normalized;
}

function parseRendererObservationMessage(message) {
  const text = String(message || '');
  if (!text.startsWith(ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX)) return null;
  try {
    return normalizeRendererObservation(JSON.parse(
      text.slice(ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX.length)
    ));
  } catch (_error) {
    return null;
  }
}

function findRendererObservation(args) {
  for (const value of args) {
    const message = typeof value === 'string'
      ? value
      : value && typeof value.message === 'string'
        ? value.message
        : '';
    const observation = parseRendererObservationMessage(message);
    if (observation) return observation;
  }
  return null;
}

function isElectronBrowserProcess(processObject = process) {
  return Boolean(processObject && processObject.versions && processObject.versions.electron)
    && processObject.type === 'browser';
}

function installZcodeElectronCaptchaHook(options = {}) {
  const electron = options.electron;
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const processObject = options.processObject || process;
  const statePath = String(
    options.statePath
      || (processObject.env && processObject.env[AIH_ZCODE_CAPTCHA_HOOK_STATE_ENV])
      || ''
  ).trim();
  if (!isElectronBrowserProcess(processObject)) {
    return { installed: false, reason: 'not_electron_browser' };
  }
  if (!electron || !electron.app || typeof electron.app.on !== 'function') {
    return { installed: false, reason: 'electron_app_unavailable' };
  }

  const forceInteractive = String(
    processObject.env && processObject.env[AIH_ZCODE_CAPTCHA_FORCE_INTERACTIVE_ENV] || ''
  ).trim() === '1';
  const rendererSource = options.rendererSource || buildZcodeCaptchaRendererSource({
    forceInteractive
  });
  const state = {
    version: ZCODE_CAPTCHA_HOOK_VERSION,
    mainInstalled: true,
    mainProcessId: Number(processObject.pid) || 0,
    rendererInstalled: false,
    rendererInstallCount: 0,
    lastRendererStatus: 'pending',
    updatedAt: new Date().toISOString()
  };

  function persistState(patch = {}) {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    if (!statePath) return;
    const tempPath = `${statePath}.${state.mainProcessId || 'process'}.tmp`;
    try {
      fsImpl.mkdirSync(pathImpl.dirname(statePath), { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      fsImpl.renameSync(tempPath, statePath);
    } catch (_error) {
      try {
        fsImpl.unlinkSync(tempPath);
      } catch (_cleanupError) {}
    }
  }

  const attachedContents = new WeakSet();
  function attachWebContents(contents) {
    if (!contents || typeof contents.on !== 'function' || attachedContents.has(contents)) return;
    attachedContents.add(contents);
    contents.on('console-message', (...args) => {
      const rendererObservation = findRendererObservation(args);
      if (rendererObservation) persistState({ rendererObservation });
    });
    const injectRendererHook = () => {
      if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return;
      let execution;
      try {
        execution = contents.executeJavaScript(rendererSource, true);
      } catch (_error) {
        persistState({ lastRendererStatus: 'failed' });
        return;
      }
      Promise.resolve(execution).then((result) => {
        if (!result || result.installed !== true) {
          persistState({ lastRendererStatus: 'failed' });
          return;
        }
        persistState({
          rendererInstalled: true,
          rendererInstallCount: state.rendererInstallCount + 1,
          lastRendererStatus: 'installed'
        });
      }).catch(() => {
        persistState({ lastRendererStatus: 'failed' });
      });
    };
    contents.on('dom-ready', injectRendererHook);
    if (typeof contents.isLoadingMainFrame === 'function'
      && contents.isLoadingMainFrame() === false) {
      Promise.resolve().then(injectRendererHook);
    }
  }

  electron.app.on('web-contents-created', (_event, contents) => {
    attachWebContents(contents);
  });
  if (electron.webContents && typeof electron.webContents.getAllWebContents === 'function') {
    for (const contents of electron.webContents.getAllWebContents()) attachWebContents(contents);
  }
  persistState();
  return { installed: true };
}

function autoInstallZcodeElectronCaptchaHook() {
  if (!isElectronBrowserProcess(process)) return;
  try {
    installZcodeElectronCaptchaHook({ electron: require('electron') });
  } catch (_error) {}
}

autoInstallZcodeElectronCaptchaHook();

module.exports = {
  AIH_ZCODE_CAPTCHA_FORCE_INTERACTIVE_ENV,
  AIH_ZCODE_CAPTCHA_HOOK_STATE_ENV,
  ZCODE_CAPTCHA_HOOK_VERSION,
  ZCODE_CAPTCHA_RENDERER_EVENT_PREFIX,
  buildZcodeCaptchaRendererSource,
  isElectronBrowserProcess,
  installZcodeCaptchaRendererHook,
  installZcodeElectronCaptchaHook
};
