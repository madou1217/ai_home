'use strict';

/**
 * Multiplexer provider type contracts & constants.
 * Standardizes session management, headless execution, and capability detection across
 * different multiplexers (tmux, herdr).
 */

const MULTIPLEXER_TYPE = Object.freeze({
  TMUX: 'tmux',
  HERDR: 'herdr',
  AUTO: 'auto'
});

const MULTIPLEXER_ENV = 'AIH_MULTIPLEXER';

module.exports = {
  MULTIPLEXER_TYPE,
  MULTIPLEXER_ENV
};
