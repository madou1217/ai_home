'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { createManagedResourceStore } = require('./managed-resource-store');
const { resolveProviderNativeRoot } = require('../runtime/provider-storage-policy');
const { createMcpConfigAdapter } = require('./mcp-config-adapters');
const { createMcpStdioClient } = require('./mcp-stdio-client');
const { requireMcp } = require('./mcp-errors');
const clone = value => JSON.parse(JSON.stringify(value));
function validateName(name) {
  requireMcp(typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) && !['constructor', 'prototype'].includes(name), 'mcp_name_invalid');
}
function normalizeServer(server) {
  requireMcp(server && typeof server.command === 'string' && server.command.trim() && !server.command.includes('\0'), 'mcp_command_required');
  requireMcp(!server.args || (Array.isArray(server.args) && server.args.every(x => typeof x === 'string' && !x.includes('\0'))), 'mcp_args_invalid');
  requireMcp(!server.cwd || (typeof server.cwd === 'string' && path.isAbsolute(server.cwd)), 'mcp_cwd_invalid');
  requireMcp(!server.env || (typeof server.env === 'object' && !Array.isArray(server.env) && Object.entries(server.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'))), 'mcp_env_invalid');
  const result = { command: server.command, args: server.args || [], ...(server.cwd ? { cwd: server.cwd } : {}), ...(server.env ? { env: server.env } : {}) };
  requireMcp(Buffer.byteLength(JSON.stringify(result)) <= 65536, 'mcp_definition_limit');
  return clone(result);
}
function publicRecord(record) {
  const { server, ...rest } = record;
  return { ...rest, command: server.command, argCount: server.args.length, envKeys: Object.keys(server.env || {}) };
}
function createMcpManager(options = {}) {
  const { aiHomeDir, hostHomeDir } = options;
  requireMcp(aiHomeDir && hostHomeDir, 'mcp_home_required');
  const registry = options.registry || defaultProviderResourceRegistry;
  const store = createManagedResourceStore({ aiHomeDir });
  function boundary(provider) {
    const projection = registry.get(provider, 'mcp').projection;
    requireMcp(projection, 'mcp_provider_unsupported');
    return { projection, adapter: createMcpConfigAdapter(projection.format) };
  }
  function target(provider, home = hostHomeDir) {
    const { projection } = boundary(provider);
    const root = projection.pathBase === 'host-home' ? home : resolveProviderNativeRoot(home, provider);
    requireMcp(root && !path.isAbsolute(projection.path) && !projection.path.split(/[\\/]/).includes('..'), 'mcp_projection_path_invalid');
    const candidates = [projection.path, ...(projection.alternatives || [])].map(relative => path.join(root, relative));
    return candidates.find(file => fs.existsSync(file)) || candidates[0];
  }
  function getRecord(state, name, provider) {
    validateName(name);
    boundary(provider);
    const record = state.resources.find(x => x.kind === 'mcp' && x.id === name && x.provider === provider);
    requireMcp(record, 'mcp_not_installed');
    return record;
  }
  function add(name, input, { provider } = {}) {
    validateName(name);
    const { adapter } = boundary(provider);
    const server = normalizeServer(input);
    requireMcp(!server.cwd || adapter.supportsCwd, 'mcp_cwd_unsupported');
    return store.update(state => {
      const existing = state.resources.find(x => x.kind === 'mcp' && x.id === name && x.provider === provider);
      if (existing) {
        requireMcp(isDeepStrictEqual(server, existing.server), 'mcp_definition_conflict');
        return publicRecord(existing);
      }
      const record = { kind: 'mcp', id: name, provider, scope: 'host', server, enabled: false, projections: [], createdAt: Date.now(), updatedAt: Date.now() };
      state.resources.push(record);
      return publicRecord(record);
    });
  }
  function change(name, { provider } = {}, action) {
    return store.update(state => {
      const record = getRecord(state, name, provider);
      const { adapter } = boundary(provider);
      const entry = adapter.encode(record.server);
      const targets = new Set(action === 'enable' ? [target(provider), ...record.projections] : record.projections);
      for (const file of targets) {
        adapter.update(file, name, action === 'enable' ? entry : undefined, record.projections.includes(file) ? entry : undefined);
      }
      const enabled = action === 'enable';
      if (action === 'remove') state.resources.splice(state.resources.indexOf(record), 1);
      else if (record.enabled !== enabled || (enabled && !record.projections.includes(target(provider)))) {
        record.enabled = enabled; record.updatedAt = Date.now();
        if (enabled) record.projections = [...targets];
      }
      return { ...publicRecord(record), enabled, removed: action === 'remove' };
    });
  }
  function list({ provider } = {}) {
    const state = store.get();
    return { revision: state.revision, resources: state.resources.filter(x => x.kind === 'mcp' && (!provider || x.provider === provider)).map(publicRecord) };
  }
  function doctor(filter = {}) {
    const state = store.get();
    const resources = state.resources.filter(x => x.kind === 'mcp' && (!filter.provider || x.provider === filter.provider)).map(record => {
      const { adapter } = boundary(record.provider);
      const expected = adapter.encode(record.server);
      const projections = [...new Set([target(record.provider), ...record.projections])].map(file => {
        try {
          const servers = adapter.read(file).servers;
          const current = Object.hasOwn(servers, record.id) ? servers[record.id] : undefined;
          return { target: file, healthy: record.enabled ? isDeepStrictEqual(current, expected) : current === undefined };
        } catch (error) { return { target: file, healthy: false, error: error.code || 'mcp_config_unavailable' }; }
      });
      return { ...publicRecord(record), projections, healthy: projections.every(x => x.healthy) };
    });
    return { revision: state.revision, healthy: resources.every(x => x.healthy), resources };
  }
  async function withClient(name, selection, fn) {
    const record = clone(getRecord(store.get(), name, selection.provider));
    const client = createMcpStdioClient(record.server, { signal: selection.signal, timeoutMs: selection.timeoutMs });
    try { return await fn(client); } finally { await client.close(); }
  }
  async function test(name, selection = {}) {
    return withClient(name, selection, async client => {
      const initialized = await client.initialize();
      const tools = await client.listTools();
      return { ok: true, serverInfo: initialized.serverInfo, protocolVersion: initialized.protocolVersion, tools: tools.map(x => x.name) };
    });
  }
  function reconcileRuntime(provider, { sandboxDir } = {}) {
    const capability = registry.get(provider, 'mcp').projection;
    if (!capability?.accountScoped || !sandboxDir || sandboxDir === hostHomeDir) return { skipped: true };
    if (!store.get().resources.some(x => x.kind === 'mcp' && x.provider === provider && x.enabled)) return { projected: 0 };
    return store.update(state => {
      const file = target(provider, sandboxDir);
      const { adapter } = boundary(provider);
      const resources = state.resources.filter(x => x.kind === 'mcp' && x.provider === provider && x.enabled);
      for (const record of resources) {
        const entry = adapter.encode(record.server);
        adapter.update(file, record.id, entry, record.projections.includes(file) ? entry : undefined);
        if (!record.projections.includes(file)) { record.projections.push(file); record.updatedAt = Date.now(); }
      }
      return { projected: resources.length };
    });
  }
  return {
    add, list, doctor, test, reconcileRuntime,
    enable: (name, selection) => change(name, selection, 'enable'),
    disable: (name, selection) => change(name, selection, 'disable'),
    remove: (name, selection) => change(name, selection, 'remove'),
    tools: (name, selection = {}) => withClient(name, selection, client => client.listTools()),
    call: (name, tool, args, selection = {}) => withClient(name, selection, client => client.callTool(tool, args))
  };
}
module.exports = { createMcpManager };
