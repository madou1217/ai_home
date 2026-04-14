'use strict';

const path = require('node:path');
const { addOpenedProject, removeOpenedProject } = require('./webui-project-store');
const { getWebUiModelsCache } = require('./webui-model-cache');
const { ensureCodexHooksEnabled, ensureCodexProjectRegistered } = require('./codex-project-registry');
const {
  getProjectsSnapshot,
  scheduleProjectsSnapshotRefresh,
  updateProjectsSnapshot
} = require('./webui-project-cache');

async function handleGetModelsRequest(ctx) {
  const {
    state,
    options,
    url,
    deps,
    writeJson
  } = ctx;

  try {
    const forceRefresh = ['1', 'true', 'yes'].includes(
      String(url && url.searchParams && url.searchParams.get('refresh') || '').trim().toLowerCase()
    );
    const result = await getWebUiModelsCache(state, options, {
      forceRefresh,
      fetchModelsForAccount: deps.fetchModelsForAccount
    });

    writeJson(ctx.res, 200, {
      ok: true,
      cached: result.cached,
      updatedAt: result.updatedAt,
      source: result.source,
      models: result.models
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_models_failed',
      message: String((error && error.message) || error || 'get_models_failed')
    });
    return true;
  }
}

async function handleGetProjectsRequest(ctx) {
  const {
    url,
    writeJson
  } = ctx;

  try {
    const forceRefresh = url.searchParams?.get('refresh') === '1' || (url.search && url.search.includes('refresh=1'));
    const snapshot = await getProjectsSnapshot(ctx, {
      forceRefresh,
      waitForRefresh: forceRefresh
    });
    const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    writeJson(ctx.res, 200, { ok: true, projects });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_projects_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handlePickProjectRequest(ctx) {
  const {
    deps,
    pickProjectDirectory,
    writeJson
  } = ctx;

  if (typeof pickProjectDirectory !== 'function') {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'project_picker_unavailable',
      message: '当前运行环境不支持目录选择器，请手动输入路径。'
    });
    return true;
  }

  try {
    const picked = pickProjectDirectory({
      prompt: '请选择要打开的项目文件夹'
    });
    if (!picked || !picked.path) {
      writeJson(ctx.res, 200, { ok: true, cancelled: true });
      return true;
    }
    writeJson(ctx.res, 200, {
      ok: true,
      cancelled: false,
      project: {
        path: picked.path,
        name: picked.name || path.basename(picked.path)
      }
    });
    return true;
  } catch (error) {
    const code = String(error && error.code || 'project_picker_failed');
    const message = code === 'project_picker_unsupported_platform'
      ? '当前平台暂不支持目录选择器，请手动输入路径。'
      : '无法打开目录选择器，请手动输入路径。';
    writeJson(ctx.res, 500, {
      ok: false,
      error: code,
      message
    });
    return true;
  }
}

async function handleOpenProjectRequest(ctx) {
  const {
    readRequestBody,
    deps,
    fs,
    writeJson
  } = ctx;

  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  const projectPath = String(payload && payload.projectPath || '').trim();
  const projectName = String(payload && payload.name || '').trim();
  if (!projectPath) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_project_path' });
    return true;
  }

  try {
    addOpenedProject(
      { path: projectPath, name: projectName },
      { fs, aiHomeDir: deps.aiHomeDir || '' }
    );
    ensureCodexHooksEnabled({ fs });
    ensureCodexProjectRegistered(projectPath, {
      fs
    });
    updateProjectsSnapshot(ctx, (projects) => {
      const nextProjects = Array.isArray(projects) ? projects.slice() : [];
      const normalizedProjectPath = String(projectPath).replace(/\/+$/, '');
      const existingIndex = nextProjects.findIndex((item) => String(item && item.path || '').replace(/\/+$/, '') === normalizedProjectPath);
      if (existingIndex >= 0) {
        const existing = nextProjects[existingIndex];
        nextProjects[existingIndex] = {
          ...existing,
          name: projectName || existing.name || path.basename(projectPath),
          manual: true
        };
        return nextProjects;
      }
      nextProjects.unshift({
        id: Buffer.from(projectPath).toString('base64').replace(/[/+=]/g, '_'),
        name: projectName || path.basename(projectPath),
        path: projectPath,
        providers: [],
        sessions: [],
        manual: true,
        addedAt: Date.now()
      });
      return nextProjects;
    });
    scheduleProjectsSnapshotRefresh(ctx, { delayMs: 1000 });
    writeJson(ctx.res, 200, {
      ok: true,
      project: {
        id: Buffer.from(projectPath).toString('base64').replace(/[/+=]/g, '_'),
        name: projectName || path.basename(projectPath),
        path: projectPath,
        providers: [],
        sessions: [],
        manual: true
      }
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: String(error && error.code || 'open_project_failed'),
      message: String((error && error.message) || error || 'open_project_failed')
    });
    return true;
  }
}

async function handleRemoveProjectRequest(ctx) {
  const {
    readRequestBody,
    deps,
    fs,
    writeJson
  } = ctx;

  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  const projectPath = String(payload && payload.projectPath || '').trim();
  if (!projectPath) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_project_path' });
    return true;
  }

  try {
    removeOpenedProject(projectPath, {
      fs,
      aiHomeDir: deps.aiHomeDir || ''
    });
    updateProjectsSnapshot(ctx, (projects) => {
      const normalizedProjectPath = String(projectPath).replace(/\/+$/, '');
      return (Array.isArray(projects) ? projects : []).filter((item) => {
        const currentPath = String(item && item.path || '').replace(/\/+$/, '');
        if (currentPath !== normalizedProjectPath) return true;
        return Array.isArray(item && item.sessions) && item.sessions.length > 0;
      });
    });
    scheduleProjectsSnapshotRefresh(ctx, { delayMs: 1000 });
    writeJson(ctx.res, 200, {
      ok: true,
      removed: true,
      projectPath
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: String(error && error.code || 'remove_project_failed'),
      message: String((error && error.message) || error || 'remove_project_failed')
    });
    return true;
  }
}

module.exports = {
  handleGetModelsRequest,
  handleGetProjectsRequest,
  handlePickProjectRequest,
  handleOpenProjectRequest,
  handleRemoveProjectRequest
};
