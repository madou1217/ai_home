'use strict';

const { spawnSync: defaultSpawnSync } = require('node:child_process');

/**
 * MultiplexerFactory
 * Resolves and instantiates the appropriate multiplexer driver based on configuration and host availability.
 *
 * Supports:
 * - explicit AIH_MULTIPLEXER=herdr | tmux
 * - auto mode (default): probes herdr -> tmux with graceful fallback
 */

const { MULTIPLEXER_TYPE, MULTIPLEXER_ENV } = require('./types');
const { TmuxDriver } = require('./drivers/tmux-driver');
const { HerdrDriver } = require('./drivers/herdr-driver');

const defaultTmuxDriver = new TmuxDriver();
const defaultHerdrDriver = new HerdrDriver();

const DRIVER_REGISTRY = {
  [MULTIPLEXER_TYPE.TMUX]: defaultTmuxDriver,
  [MULTIPLEXER_TYPE.HERDR]: defaultHerdrDriver
};

function normalizeMultiplexerOptions(options = {}, { withDefaultSpawn = false } = {}) {
  const normalized = { ...options };
  const injectedSpawn = typeof options.spawnSync === 'function'
    ? options.spawnSync
    : (typeof options.spawnSyncImpl === 'function' ? options.spawnSyncImpl : null);
  if (injectedSpawn || withDefaultSpawn) {
    normalized.spawnSync = injectedSpawn || defaultSpawnSync;
  }
  delete normalized.spawnSyncImpl;
  return normalized;
}

/**
 * Resolve configured multiplexer type from options or env.
 * @param {object} options
 * @returns {string} 'tmux' | 'herdr' | 'auto'
 */
function resolveConfiguredType(options = {}) {
  const env = options.env || process.env;
  const config = options.type || env[MULTIPLEXER_ENV] || MULTIPLEXER_TYPE.AUTO;
  const normalized = String(config || '').trim().toLowerCase();
  if (normalized === MULTIPLEXER_TYPE.HERDR) return MULTIPLEXER_TYPE.HERDR;
  if (normalized === MULTIPLEXER_TYPE.TMUX) return MULTIPLEXER_TYPE.TMUX;
  return MULTIPLEXER_TYPE.AUTO;
}

/**
 * Detect candidates once and return the selected driver with its exact result.
 * @param {object} options
 * @returns {{ driver: import('./drivers/base-driver').BaseMultiplexerDriver, detection: object }}
 */
function resolveMultiplexerSelection(options = {}) {
  if (options.driver) {
    return {
      driver: options.driver,
      detection: options.driver.detect(options)
    };
  }

  const configured = resolveConfiguredType(options);

  if (configured === MULTIPLEXER_TYPE.HERDR) {
    const herdrDetect = defaultHerdrDriver.detect(options);
    if (herdrDetect && herdrDetect.available) {
      return { driver: defaultHerdrDriver, detection: herdrDetect };
    }
    // If herdr was explicitly requested but unavailable, warn/fallback to tmux if possible
    if (options.strict) {
      return { driver: defaultHerdrDriver, detection: herdrDetect };
    }
    const tmuxDetect = defaultTmuxDriver.detect(options);
    if (tmuxDetect && tmuxDetect.available) {
      return { driver: defaultTmuxDriver, detection: tmuxDetect };
    }
    return { driver: defaultHerdrDriver, detection: herdrDetect };
  }

  if (configured === MULTIPLEXER_TYPE.TMUX) {
    return {
      driver: defaultTmuxDriver,
      detection: defaultTmuxDriver.detect(options)
    };
  }

  // AUTO mode: check herdr first, then tmux
  const herdrDetect = defaultHerdrDriver.detect(options);
  if (herdrDetect && herdrDetect.available) {
    return { driver: defaultHerdrDriver, detection: herdrDetect };
  }

  return {
    driver: defaultTmuxDriver,
    detection: defaultTmuxDriver.detect(options)
  };
}

function bindMultiplexerDriver(driver, detection, options = {}) {
  if (!driver || typeof driver.detect !== 'function') {
    throw new TypeError('bindMultiplexerDriver: driver must implement the multiplexer SPI');
  }
  const normalized = normalizeMultiplexerOptions(options, { withDefaultSpawn: true });
  const fixedDetection = Object.freeze({ ...(detection || driver.detect(normalized)) });
  const command = String(fixedDetection.command || driver.name || '').trim();
  const spawnSync = normalized.spawnSync;
  const baseOptions = {
    ...normalized,
    command,
    spawnSync
  };
  delete baseOptions.driver;

  const bindOptions = (operationOptions = {}) => ({
    ...baseOptions,
    ...operationOptions,
    command,
    spawnSync
  });

  return Object.freeze({
    name: driver.name,
    driver,
    detection: fixedDetection,
    available: fixedDetection.available === true,
    command,
    spawnSync,
    buildLaunchArgs(operationOptions = {}) {
      return driver.buildLaunchArgs(bindOptions(operationOptions));
    },
    listSessions(target, operationOptions = {}) {
      return driver.listSessions(target, bindOptions(operationOptions));
    },
    spawnHeadlessRun(operationOptions = {}) {
      return driver.spawnHeadlessRun(bindOptions(operationOptions));
    },
    hasRun(target, operationOptions = {}) {
      return driver.hasRun(target, bindOptions(operationOptions));
    },
    killRun(target, operationOptions = {}) {
      return driver.killRun(target, bindOptions(operationOptions));
    },
    cleanupRun(target, operationOptions = {}) {
      return driver.cleanupRun(target, bindOptions(operationOptions));
    },
    sendInput(target, text, operationOptions = {}) {
      return driver.sendInput(target, text, bindOptions(operationOptions));
    },
    isSystemdScopeSupported(operationOptions = {}) {
      if (typeof driver.isSystemdScopeSupported !== 'function') return false;
      return driver.isSystemdScopeSupported(bindOptions(operationOptions));
    }
  });
}

/**
 * Detect and bind one multiplexer backend for an entire runtime lifecycle.
 * The selected driver, executable path, and process dependency cannot be
 * replaced by individual lifecycle calls.
 * @param {object} options
 * @returns {object} immutable multiplexer binding
 */
function resolveMultiplexerBinding(options = {}) {
  const normalized = normalizeMultiplexerOptions(options, { withDefaultSpawn: true });
  const selection = resolveMultiplexerSelection(normalized);
  return bindMultiplexerDriver(selection.driver, selection.detection, normalized);
}

/**
 * Compatibility facade for callers that only need the selected driver.
 * @param {object} options
 * @returns {import('./drivers/base-driver').BaseMultiplexerDriver}
 */
function resolveMultiplexerDriver(options = {}) {
  return resolveMultiplexerBinding(options).driver;
}

function getDriver(name) {
  const key = String(name || '').trim().toLowerCase();
  return DRIVER_REGISTRY[key] || null;
}

module.exports = {
  resolveConfiguredType,
  normalizeMultiplexerOptions,
  bindMultiplexerDriver,
  resolveMultiplexerBinding,
  resolveMultiplexerDriver,
  getDriver,
  defaultTmuxDriver,
  defaultHerdrDriver
};
