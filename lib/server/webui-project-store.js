'use strict';

const path = require('node:path');
const { ensureDirSync } = require('./fs-compat');

function getProjectStorePath(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? path.join(root, 'webui-projects.json') : '';
}

function normalizeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/\/+$/, '');
}

function readOpenedProjects(deps = {}) {
  const { fs, aiHomeDir } = deps;
  const storePath = getProjectStorePath(aiHomeDir);
  if (!storePath || !fs || !fs.existsSync(storePath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const list = Array.isArray(parsed && parsed.projects) ? parsed.projects : [];
    return list
      .map((item) => ({
        path: normalizeProjectPath(item && item.path),
        name: String((item && item.name) || '').trim(),
        addedAt: Number(item && item.addedAt) || 0
      }))
      .filter((item) => item.path);
  } catch (_error) {
    return [];
  }
}

function readHiddenProjectPaths(deps = {}) {
  const { fs, aiHomeDir } = deps;
  const storePath = getProjectStorePath(aiHomeDir);
  if (!storePath || !fs || !fs.existsSync(storePath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const list = Array.isArray(parsed && parsed.hiddenPaths) ? parsed.hiddenPaths : [];
    return list
      .map((item) => normalizeProjectPath(item))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function writeOpenedProjects(projects, deps = {}) {
  const { fs, aiHomeDir } = deps;
  const storePath = getProjectStorePath(aiHomeDir);
  if (!storePath || !fs) return [];

  const normalized = Array.isArray(projects) ? projects : [];
  const hiddenPaths = readHiddenProjectPaths(deps);
  ensureDirSync(fs, path.dirname(storePath));
  fs.writeFileSync(storePath, JSON.stringify({ projects: normalized, hiddenPaths }, null, 2));
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

  const { fs, aiHomeDir } = deps;
  const storePath = getProjectStorePath(aiHomeDir);
  ensureDirSync(fs, path.dirname(storePath));
  fs.writeFileSync(storePath, JSON.stringify({
    projects: next,
    hiddenPaths: Array.from(hiddenPaths)
  }, null, 2));
  return next;
}

function unhideOpenedProject(projectPath, deps = {}) {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) return;

  const { fs, aiHomeDir } = deps;
  const storePath = getProjectStorePath(aiHomeDir);
  const projects = readOpenedProjects(deps);
  const hiddenPaths = readHiddenProjectPaths(deps).filter((item) => item !== normalizedPath);
  ensureDirSync(fs, path.dirname(storePath));
  fs.writeFileSync(storePath, JSON.stringify({
    projects,
    hiddenPaths
  }, null, 2));
}

module.exports = {
  readOpenedProjects,
  readHiddenProjectPaths,
  addOpenedProject,
  removeOpenedProject,
  unhideOpenedProject
};
