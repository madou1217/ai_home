'use strict';

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
 * Resolve the active driver instance with automatic fallback.
 * @param {object} options
 * @returns {import('./drivers/base-driver').BaseMultiplexerDriver}
 */
function resolveMultiplexerDriver(options = {}) {
  const configured = resolveConfiguredType(options);

  if (configured === MULTIPLEXER_TYPE.HERDR) {
    const herdrDetect = defaultHerdrDriver.detect(options);
    if (herdrDetect && herdrDetect.available) {
      return defaultHerdrDriver;
    }
    // If herdr was explicitly requested but unavailable, warn/fallback to tmux if possible
    if (options.strict) {
      return defaultHerdrDriver;
    }
    const tmuxDetect = defaultTmuxDriver.detect(options);
    if (tmuxDetect && tmuxDetect.available) {
      return defaultTmuxDriver;
    }
    return defaultHerdrDriver;
  }

  if (configured === MULTIPLEXER_TYPE.TMUX) {
    return defaultTmuxDriver;
  }

  // AUTO mode: check herdr first, then tmux
  const herdrDetect = defaultHerdrDriver.detect(options);
  if (herdrDetect && herdrDetect.available) {
    return defaultHerdrDriver;
  }

  return defaultTmuxDriver;
}

function getDriver(name) {
  const key = String(name || '').trim().toLowerCase();
  return DRIVER_REGISTRY[key] || null;
}

module.exports = {
  resolveConfiguredType,
  resolveMultiplexerDriver,
  getDriver,
  defaultTmuxDriver,
  defaultHerdrDriver
};
