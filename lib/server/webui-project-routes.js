'use strict';

const path = require('node:path');
const { readOpenedProjects, readHiddenProjectPaths, addOpenedProject, removeOpenedProject } = require('./webui-project-store');
const { getWebUiModelsCache } = require('./webui-model-cache');
const { ensureCodexHooksEnabled, ensureCodexProjectRegistered } = require('./codex-project-registry');

function getProjectLastActivityAt(project) {
  if (!project || !Array.isArray(project.sessions) || project.sessions.length === 0) {
    return Number(project && project.addedAt) || 0;
  }
  return Math.max(
    ...project.sessions.map((session) => Number(session && session.updatedAt) || 0),
    Number(project.addedAt) || 0
  );
}

function sortProjectSessionsByUpdatedAtDesc(sessions) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((left, right) => {
    const rightUpdatedAt = Number(right && right.updatedAt) || 0;
    const leftUpdatedAt = Number(left && left.updatedAt) || 0;
    return rightUpdatedAt - leftUpdatedAt;
  });
}

function sortProjectsByLastActivityDesc(projects) {
  return [...(Array.isArray(projects) ? projects : [])].sort((left, right) => {
    const rightUpdatedAt = getProjectLastActivityAt(right);
    const leftUpdatedAt = getProjectLastActivityAt(left);
    return rightUpdatedAt - leftUpdatedAt;
  });
}

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
    deps,
    fs,
    writeJson,
    cacheState
  } = ctx;

  try {
    const { readAllProjectsFromHost } = require('../sessions/session-reader');
    const now = Date.now();
    const forceRefresh = url.searchParams?.get('refresh') === '1' || (url.search && url.search.includes('refresh=1'));

    let allProjects;
    if (!forceRefresh && cacheState.projects && (now - cacheState.projectsAt) < cacheState.projectsTtlMs) {
      allProjects = cacheState.projects;
    } else {
      allProjects = readAllProjectsFromHost();
      cacheState.projects = allProjects;
      cacheState.projectsAt = now;
    }

    const projectMap = new Map();
    const normalizePath = (projectPath) => (projectPath || '').replace(/\/+$/, '');

    for (const project of allProjects) {
      const key = normalizePath(project.path);
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          id: project.id,
          name: project.name,
          path: project.path,
          providers: [project.provider],
          sessions: []
        });
      } else {
        const existing = projectMap.get(key);
        if (!existing.providers.includes(project.provider)) {
          existing.providers.push(project.provider);
        }
      }

      const projectData = projectMap.get(key);
      for (const session of project.sessions) {
        projectData.sessions.push({
          ...session,
          provider: project.provider,
          projectDirName: session.projectDirName || project.id,
          projectPath: project.path
        });
      }
    }

    const openedProjects = readOpenedProjects({ fs, aiHomeDir: deps.aiHomeDir || '' });
    const hiddenPaths = new Set(readHiddenProjectPaths({ fs, aiHomeDir: deps.aiHomeDir || '' }));
    for (const opened of openedProjects) {
      const key = normalizePath(opened.path);
      if (hiddenPaths.has(key)) continue;
      if (projectMap.has(key)) {
        const existing = projectMap.get(key);
        if (!existing.name || existing.name === path.basename(existing.path || '')) {
          existing.name = opened.name || existing.name;
        }
        existing.manual = true;
        continue;
      }
      projectMap.set(key, {
        id: Buffer.from(opened.path).toString('base64').replace(/[/+=]/g, '_'),
        name: opened.name || path.basename(opened.path),
        path: opened.path,
        providers: [],
        sessions: [],
        manual: true,
        addedAt: opened.addedAt || 0
      });
    }

    const projects = sortProjectsByLastActivityDesc(Array.from(projectMap.values())
      .filter((project) => !hiddenPaths.has(normalizePath(project.path)))
      .map((project) => ({
        ...project,
        sessions: sortProjectSessionsByUpdatedAtDesc(project.sessions)
      })));

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
    writeJson,
    invalidateProjectsCache
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
    invalidateProjectsCache();
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
    writeJson,
    invalidateProjectsCache
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
    invalidateProjectsCache();
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
