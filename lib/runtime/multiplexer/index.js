'use strict';

const { MULTIPLEXER_TYPE, MULTIPLEXER_ENV } = require('./types');
const { BaseMultiplexerDriver } = require('./drivers/base-driver');
const { TmuxDriver, RUN_EXIT_MARKER, RUN_SESSION_NAME, TRANSPARENT_CONF, PSMUX_TRANSPARENT_CONF } = require('./drivers/tmux-driver');
const { HerdrDriver } = require('./drivers/herdr-driver');
const {
  resolveConfiguredType,
  resolveMultiplexerDriver,
  getDriver,
  defaultTmuxDriver,
  defaultHerdrDriver
} = require('./multiplexer-factory');

module.exports = {
  MULTIPLEXER_TYPE,
  MULTIPLEXER_ENV,
  BaseMultiplexerDriver,
  TmuxDriver,
  HerdrDriver,
  RUN_EXIT_MARKER,
  RUN_SESSION_NAME,
  TRANSPARENT_CONF,
  PSMUX_TRANSPARENT_CONF,
  resolveConfiguredType,
  resolveMultiplexerDriver,
  getDriver,
  defaultTmuxDriver,
  defaultHerdrDriver
};
