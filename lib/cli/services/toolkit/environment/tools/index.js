'use strict';

const nvm = require('./nvm');
const fnm = require('./fnm');
const volta = require('./volta');
const pnpm = require('./pnpm');
const yarn = require('./yarn');
const bun = require('./bun');
const pyenv = require('./pyenv');
const conda = require('./conda');
const uv = require('./uv');
const poetry = require('./poetry');

const ADAPTERS = Object.freeze([
  nvm,
  fnm,
  volta,
  pnpm,
  yarn,
  bun,
  pyenv,
  conda,
  uv,
  poetry
]);
const ADAPTER_BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

function listEnvironmentToolAdapters() {
  return [...ADAPTERS];
}

function getEnvironmentToolAdapter(toolId) {
  return ADAPTER_BY_ID.get(String(toolId || '').trim().toLowerCase()) || null;
}

module.exports = {
  getEnvironmentToolAdapter,
  listEnvironmentToolAdapters
};
