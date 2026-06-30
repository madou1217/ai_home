'use strict';

const fs = require('node:fs');

const { readJsonValue } = require('../../../server/app-state-store');

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeRemotePath(value) {
  const text = normalizeText(value, 2048);
  if (!text) return '';
  const trimmed = text.replace(/\/+$/, '');
  return trimmed || '/';
}

function normalizePort(value) {
  const port = Number(value || 0);
  return Number.isFinite(port) && port > 0 ? port : 22;
}

function loadLocalSshInventory(options = {}, deps = {}) {
  const aiHomeDir = normalizeText(options.aiHomeDir, 2048);
  if (!aiHomeDir) {
    return { connections: [], workspaces: [] };
  }
  const fsImpl = deps.fs || fs;
  return {
    connections: normalizeArray(readJsonValue(fsImpl, aiHomeDir, 'ssh_connections', deps)),
    workspaces: normalizeArray(readJsonValue(fsImpl, aiHomeDir, 'ssh_workspaces', deps))
  };
}

function collectProjectPaths(project) {
  const source = normalizeObject(project);
  return Array.from(new Set([
    normalizeRemotePath(source.displayPath),
    normalizeRemotePath(source.path),
    normalizeRemotePath(source.remoteRoot),
    normalizeRemotePath(source.root),
    normalizeRemotePath(source.cwd)
  ].filter(Boolean)));
}

function buildConnectionMap(connections) {
  const map = new Map();
  normalizeArray(connections).forEach((connection) => {
    const source = normalizeObject(connection);
    const id = normalizeText(source.id, 96);
    if (!id) return;
    map.set(id, {
      id,
      label: normalizeText(source.label, 120),
      host: normalizeText(source.host, 255),
      port: normalizePort(source.port),
      user: normalizeText(source.user, 96),
      authType: normalizeText(source.authType || 'agent', 48)
    });
  });
  return map;
}

function buildWorkspaceBindings(localInventory) {
  const connectionMap = buildConnectionMap(localInventory && localInventory.connections);
  return normalizeArray(localInventory && localInventory.workspaces)
    .map((workspace) => {
      const source = normalizeObject(workspace);
      const connectionId = normalizeText(source.connectionId, 96);
      const connection = connectionMap.get(connectionId);
      const remoteRoot = normalizeRemotePath(source.remoteRoot);
      if (!connection || !connection.host || !remoteRoot) return null;
      return {
        source: 'local_ssh_workspace',
        connectionId: connection.id,
        connectionLabel: connection.label,
        workspaceId: normalizeText(source.id, 96),
        workspaceLabel: normalizeText(source.label, 120),
        host: connection.host,
        port: connection.port,
        user: connection.user,
        authType: connection.authType,
        target: connection.user ? `${connection.user}@${connection.host}` : connection.host,
        remoteRoot
      };
    })
    .filter(Boolean);
}

function findNodeSshBindings(node, workspaceBindings) {
  const projects = normalizeArray(node && node.projects);
  const projectPaths = new Map();
  projects.forEach((project) => {
    collectProjectPaths(project).forEach((remotePath) => {
      if (!projectPaths.has(remotePath)) projectPaths.set(remotePath, project);
    });
  });
  if (projectPaths.size === 0) return [];
  const seen = new Set();
  return workspaceBindings
    .map((binding) => {
      const project = projectPaths.get(binding.remoteRoot);
      if (!project) return null;
      const key = `${binding.connectionId}:${binding.workspaceId}:${binding.remoteRoot}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        ...binding,
        projectId: normalizeText(project.id, 96),
        projectName: normalizeText(project.name, 120)
      };
    })
    .filter(Boolean);
}

function buildConfigureSshAction(existingAction, bindings) {
  return {
    id: 'configure-ssh',
    label: normalizeText(existingAction && existingAction.label, 120) || 'Configure SSH',
    enabled: true,
    eligible: true,
    blockers: [],
    source: 'local_ssh_inventory',
    localBindingCount: bindings.length
  };
}

function applyLocalSshBindings(node, bindings) {
  if (!bindings.length) return node;
  const capabilities = {
    ...normalizeObject(node && node.capabilities),
    sshBootstrap: true
  };
  const actions = normalizeArray(node && node.actions);
  let replaced = false;
  const nextActions = actions.map((action) => {
    if (normalizeText(action && action.id, 160) !== 'configure-ssh') return action;
    replaced = true;
    return buildConfigureSshAction(action, bindings);
  });
  if (!replaced) {
    nextActions.push(buildConfigureSshAction(null, bindings));
  }
  return {
    ...node,
    capabilities,
    localSshBindings: bindings,
    actions: nextActions
  };
}

function enrichNodeInventoryWithLocalSsh(nodeInventory, localInventory) {
  const workspaceBindings = buildWorkspaceBindings(localInventory);
  if (workspaceBindings.length === 0) return nodeInventory;
  return normalizeArray(nodeInventory).map((node) => {
    const bindings = findNodeSshBindings(node, workspaceBindings);
    return applyLocalSshBindings(node, bindings);
  });
}

module.exports = {
  buildWorkspaceBindings,
  enrichNodeInventoryWithLocalSsh,
  findNodeSshBindings,
  loadLocalSshInventory
};
