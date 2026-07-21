'use strict';

const path = require('node:path');
const { readJsonValue, writeJsonValue } = require('./app-state-store');

const WEBUI_PROJECTS_KEY = 'webui-projects';

function normalizeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/\/+$/, '');
}

function readProjectState(deps = {}) {
  const { fs, aiHomeDir } = deps;
  const value = readJsonValue(fs, aiHomeDir, WEBUI_PROJECTS_KEY);
  return value && typeof value === 'object' ? value : {};
}

function writeProjectState(state, deps = {}) {
  const { fs, aiHomeDir } = deps;
  if (!writeJsonValue(fs, aiHomeDir, WEBUI_PROJECTS_KEY, state)) {
    throw new Error('webui_project_state_write_failed');
  }
}

function readOpenedProjects(deps = {}) {
  const list = readProjectState(deps).projects;
  return (Array.isArray(list) ? list : [])
    .map((item) => ({
      path: normalizeProjectPath(item && item.path),
      name: String((item && item.name) || '').trim(),
      addedAt: Number(item && item.addedAt) || 0
    }))
    .filter((item) => item.path);
}

function readHiddenProjectPaths(deps = {}) {
  const list = readProjectState(deps).hiddenPaths;
  return (Array.isArray(list) ? list : [])
    .map((item) => normalizeProjectPath(item))
    .filter(Boolean);
}

function writeOpenedProjects(projects, deps = {}) {
  const normalized = Array.isArray(projects) ? projects : [];
  const hiddenPaths = readHiddenProjectPaths(deps);
  writeProjectState({ projects: normalized, hiddenPaths }, deps);
  return normalized;
}

function addOpenedProject(project, deps = {}) {
  const { fs } = deps;
  const projectPath = normalizeProjectPath(project && project.path);
  const projectName = String((project && project.name) || '').trim() || path.basename(projectPath);
  if (!projectPath) {
    const error = new Error('missing_project_path');
    error.code = 'missing_project_path';
    throw error;
  }
  if (!path.isAbsolute(projectPath)) {
    const error = new Error('project_path_must_be_absolute');
    error.code = 'project_path_must_be_absolute';
    throw error;
  }
  if (!fs || !fs.existsSync(projectPath)) {
    const error = new Error('project_path_not_found');
    error.code = 'project_path_not_found';
    throw error;
  }
  if (!fs.statSync(projectPath).isDirectory()) {
    const error = new Error('project_path_not_directory');
    error.code = 'project_path_not_directory';
    throw error;
  }

  const current = readOpenedProjects(deps);
  const existing = current.find((item) => normalizeProjectPath(item.path) === projectPath);
  if (existing) {
    existing.name = projectName || existing.name;
    const written = writeOpenedProjects(current, deps);
    unhideOpenedProject(projectPath, deps);
    return written;
  }

  current.unshift({
    path: projectPath,
    name: projectName,
    addedAt: Date.now()
  });
  const written = writeOpenedProjects(current, deps);
  unhideOpenedProject(projectPath, deps);
  return written;
}

function removeOpenedProject(projectPath, deps = {}) {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) return [];

  const current = readOpenedProjects(deps);
  const next = current.filter((item) => normalizeProjectPath(item.path) !== normalizedPath);
  const hiddenPaths = new Set(readHiddenProjectPaths(deps));
  hiddenPaths.add(normalizedPath);

  writeProjectState({
    projects: next,
    hiddenPaths: Array.from(hiddenPaths)
  }, deps);
  return next;
}

function unhideOpenedProject(projectPath, deps = {}) {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) return;

  const projects = readOpenedProjects(deps);
  const hiddenPaths = readHiddenProjectPaths(deps).filter((item) => item !== normalizedPath);
  writeProjectState({ projects, hiddenPaths }, deps);
}

module.exports = {
  readOpenedProjects,
  readHiddenProjectPaths,
  addOpenedProject,
  removeOpenedProject,
  unhideOpenedProject
};
