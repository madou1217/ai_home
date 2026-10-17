'use strict';

/**
 * Multiplexer provider type contracts & constants.
 * Standardizes session management, headless execution, and capability detection across
 * different multiplexers (tmux, herdr).
 */

const MULTIPLEXER_TYPE = Object.freeze({
  TMUX: 'tmux',
  HERDR: 'herdr',
  AUTO: 'auto',
  // off = 显式关闭复用器（前台直跑），用于排障与单测。
  OFF: 'off'
});

const MULTIPLEXER_ENV = 'AIH_MULTIPLEXER';

module.exports = {
  MULTIPLEXER_TYPE,
  MULTIPLEXER_ENV
};
