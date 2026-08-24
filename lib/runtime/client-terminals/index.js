'use strict';

const { defineClientTerminalAdapter } = require('./adapter');
const { DEFAULT_TERMINAL_ID, TERMINAL_IDS } = require('./constants');
const systemDefault = require('./system-default');
const wezterm = require('./wezterm');
const warp = require('./warp');
const iterm2 = require('./iterm2');
const windowsTerminal = require('./windows-terminal');
const cmd = require('./cmd');

const ADAPTERS = Object.freeze([
  systemDefault,
  wezterm,
  warp,
  iterm2,
  windowsTerminal,
  cmd
]);
const TERMINAL_DEFINITIONS = Object.freeze(Object.fromEntries(
  ADAPTERS.map((adapter) => [adapter.id, adapter])
));

function listClientTerminalAdapters() {
  return [...ADAPTERS];
}

function getClientTerminalAdapter(id) {
  return TERMINAL_DEFINITIONS[String(id || DEFAULT_TERMINAL_ID).trim().toLowerCase()] || null;
}

module.exports = {
  DEFAULT_TERMINAL_ID,
  TERMINAL_IDS,
  TERMINAL_DEFINITIONS,
  defineClientTerminalAdapter,
  getClientTerminalAdapter,
  listClientTerminalAdapters
};
