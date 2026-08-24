'use strict';

const tmux = require('./tmux');
const psmux = require('./psmux');
const herdr = require('./herdr');
const frpc = require('./frpc');

const ADAPTERS = Object.freeze([tmux, psmux, herdr, frpc]);
const ADAPTER_BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

function listManagedToolAdapters() {
  return [...ADAPTERS];
}

function getManagedToolAdapter(toolId) {
  return ADAPTER_BY_ID.get(String(toolId || '').trim().toLowerCase()) || null;
}

module.exports = {
  getManagedToolAdapter,
  listManagedToolAdapters
};
