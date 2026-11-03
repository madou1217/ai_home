'use strict';

/**
 * BaseMultiplexerDriver
 * Defines the standard SPI lifecycle contract for all terminal multiplexers in aih.
 *
 * Subclasses MUST implement:
 * 1. Metadata: name
 * 2. Detection: detect(options)
 * 3. CLI persistent session launch: buildLaunchArgs(options)
 * 4. Session inspection: listSessions(target, options)
 * 5. Headless Native Run: spawnHeadlessRun(options), hasRun(target, options), killRun(target, options), sendInput(target, text, options)
 */
class BaseMultiplexerDriver {
  get name() {
    throw new Error('BaseMultiplexerDriver: name must be implemented');
  }

  /**
   * Detect whether this multiplexer is installed and usable on the host.
   * `spawnSync` is the canonical process dependency for every SPI method;
   * compatibility aliases are normalized at the factory boundary.
   * @param {object} _options { platform, env, spawnSync, resolveCommandPath, existsSync }
   * @returns {{ available: boolean, reason: string, command: string, viaShell?: boolean }}
   */
  detect(_options = {}) {
    throw new Error('BaseMultiplexerDriver: detect must be implemented');
  }

  /**
   * Build the execution command & arguments to launch/attach an interactive persistent session.
   * @param {object} _options { command, inner, socket, session, confPath, attachExisting, detached, share, detachOnAttach, cwd, env, label }
   * @returns {{ command: string, args: string[], socket: string, session: string, detached?: boolean }}
   */
  buildLaunchArgs(_options = {}) {
    throw new Error('BaseMultiplexerDriver: buildLaunchArgs must be implemented');
  }

  /**
   * Query the list of active sessions on a given target (e.g. account socket / namespace).
   * @param {string|object} _target socket identifier or query options
   * @param {object} _options { command, spawnSync }
   * @returns {string} Raw output or formatted list
   */
  listSessions(_target, _options = {}) {
    throw new Error('BaseMultiplexerDriver: listSessions must be implemented');
  }

  /**
   * Spawn a detached, headless run for WebUI / Background Agent executions.
   * @param {object} _options { command, socket, shellCommand, cwd, env, useSystemdScope, spawnSync }
   * @returns {{ ok: boolean, socket?: string, session?: string, scoped?: boolean, error?: string }}
   */
  spawnHeadlessRun(_options = {}) {
    throw new Error('BaseMultiplexerDriver: spawnHeadlessRun must be implemented');
  }

  /**
   * Check if a headless run session is still alive.
   * @param {string} _socket
   * @param {object} _options { command, spawnSync }
   * @returns {boolean}
   */
  hasRun(_socket, _options = {}) {
    throw new Error('BaseMultiplexerDriver: hasRun must be implemented');
  }

  /**
   * Forcefully terminate a headless run session/server.
   * @param {string} _socket
   * @param {object} _options { command, spawnSync }
   */
  killRun(_socket, _options = {}) {
    throw new Error('BaseMultiplexerDriver: killRun must be implemented');
  }

  /**
   * Clean up any residual socket files / state after a run finishes.
   * @param {string} _socket
   * @param {object} _options { command, fs, env, spawnSync }
   */
  cleanupRun(_socket, _options = {}) {
    throw new Error('BaseMultiplexerDriver: cleanupRun must be implemented');
  }

  /**
   * Send keystrokes / text into an active headless run.
   * @param {string} _socket
   * @param {string} _text
   * @param {object} _options { command, appendNewline, spawnSync }
   * @returns {boolean}
   */
  sendInput(_socket, _text, _options = {}) {
    throw new Error('BaseMultiplexerDriver: sendInput must be implemented');
  }
}

module.exports = {
  BaseMultiplexerDriver
};
