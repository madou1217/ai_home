'use strict';

const DEFAULT_TERMINAL_ID = 'system-default';
const TERMINAL_IDS = Object.freeze({
  SYSTEM_DEFAULT: DEFAULT_TERMINAL_ID,
  WEZTERM: 'wezterm',
  WARP: 'warp',
  ITERM2: 'iterm2',
  WINDOWS_TERMINAL: 'windows-terminal',
  CMD: 'cmd'
});

module.exports = {
  DEFAULT_TERMINAL_ID,
  TERMINAL_IDS
};
