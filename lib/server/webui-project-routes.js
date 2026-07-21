'use strict';

const path = require('node:path');
const { addOpenedProject, removeOpenedProject } = require('./webui-project-store');
const { getWebUiModelsCache, accountScopeNeverProbed } = require('./webui-model-cache');
const { buildModelAccountRefProjection } = require('./webui-model-account-ref-projection');
const { accountMatchesScope, normalizeAccountScope } = require('./provider-model-discovery');
const {
  isAccountModelEnabled,
  listManualModelSettings,
  loadModelCatalogSettings,
  normalizeModelCatalogSettings
} = require('./model-catalog-settings-store');
const {
  ensureCodexHooksEnabled,
  ensureCodexProjectRegistered,
  removeCodexProjectRegistration
} = require('./codex-project-registry');
const {
  getProjectsSnapshot,
  getCompleteProjectSnapshot,
  scheduleProjectsSnapshotRefresh,
  updateProjectsSnapshot
} = require('./webui-project-cache');
const { notifyWebUiProjectWatchers } = require('./webui-project-watch');

function getContextFs(ctx) {
  return ctx && (ctx.fs || ctx.deps && ctx.deps.fs);
}

function getContextAiHomeDir(ctx) {
  return String(ctx && (ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir) || '').trim();
}

function getContextHostHomeDir(ctx) {
  return String(ctx && (ctx.hostHomeDir || ctx.deps && ctx.deps.hostHomeDir) || '').trim();
}

function parseModelsAccountScope(ctx) {
  const accountRef = String(ctx && ctx.url && ctx.url.searchParams && ctx.url.searchParams.get('accountRef') || '').trim();
  if (!accountRef) return { requested: false, accountScope: null };
  return {
    requested: true,
    accountScope: normalizeAccountScope({ accountRef })
  };
}

function serializeModelsAccountScope(accountScope) {
  const scope = normalizeAccountScope(accountScope);
  if (!scope) return null;
  return { accountRef: scope.accountRef || '' };
}

async function loadModelSettingsData(ctx) {
  const deps = ctx.deps || {};
  const fs = getContextFs(ctx);
  const aiHomeDir = getContextAiHomeDir(ctx);
  if (!fs || !aiHomeDir) return normalizeModelCatalogSettings(null);
  if (typeof deps.loadModelCatalogSettings === 'function') {
    return deps.loadModelCatalogSettings(fs, aiHomeDir);
  }
  return loadModelCatalogSettings(fs, aiHomeDir);
}

function buildProviderByAccountRef(state) {
  const out = new Map();
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};
  Object.entries(accountsByProvider).forEach(([provider, accounts]) => {
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      const accountRef = String(account && account.accountRef || '').trim();
      if (accountRef) out.set(accountRef, provider);
    });
  });
  return out;
}

function mergeSelectableModel(target, accountRef, modelId) {
  const ref = String(accountRef || '').trim();
  const id = String(modelId || '').trim();
  if (!ref || !id) return;
  if (!target[ref]) target[ref] = [];
  if (!target[ref].includes(id)) target[ref].push(id);
}

function buildSelectableModelProjection(state, accountRefProjection, settings, accountScope = null) {
  const selectableByAccountRef = {};
  const providerByAccountRef = buildProviderByAccountRef(state);
  Object.entries(accountRefProjection.byAccountRef || {}).forEach(([accountRef, models]) => {
    const provider = providerByAccountRef.get(accountRef) || '';
    (Array.isArray(models) ? models : []).forEach((modelId) => {
      if (!isAccountModelEnabled(settings, { id: modelId, provider, accountRef })) return;
      mergeSelectableModel(selectableByAccountRef, accountRef, modelId);
    });
  });
  listManualModelSettings(settings, { enabledOnly: true }).forEach((record) => {
    if (!accountMatchesScope(record.provider, record, accountScope)) return;
    mergeSelectableModel(selectableByAccountRef, record.accountRef, record.id);
  });
  Object.keys(selectableByAccountRef).forEach((accountRef) => {
    selectableByAccountRef[accountRef].sort();
  });
  return selectableByAccountRef;
}

function buildDefaultModelProjection(settings, selectableByAccountRef) {
  const defaultByAccountRef = {};
  normalizeModelCatalogSettings(settings).accountModels.forEach((record) => {
    if (record.defaultModel !== true || record.enabled === false) return;
    const accountRef = String(record.accountRef || '').trim();
    const modelId = String(record.id || '').trim();
    if (!accountRef || !modelId) return;
    const selectable = selectableByAccountRef[accountRef] || [];
    if (!selectable.includes(modelId)) return;
    defaultByAccountRef[accountRef] = modelId;
  });
  return defaultByAccountRef;
}

async function handleGetModelsRequest(ctx) {
  const {
    state,
    options,
    deps,
    writeJson
  } = ctx;

  try {
    const parsedScope = parseModelsAccountScope(ctx);
    const accountScope = parsedScope.accountScope;
    if (parsedScope.requested && !accountScope) {
      writeJson(ctx.res, 404, {
        ok: false,
        error: 'account_not_found',
        message: '未找到要读取模型缓存的账号'
      });
      return true;
    }
    // 冷账号首探：切到一个从未被背景调度器探测过的账号时，selectableByAccountRef 为空 →
    // 前端"无可用模型/模型不可选"。GET 本是只读（靠调度器慢慢探），但对【明确请求且从未探测过】
    // 的 accountScope 做一次有界强制探测，避免用户干等调度器轮到它。探测过即交回调度器 backoff。
    const modelCacheDeps = {
      fs: getContextFs(ctx),
      aiHomeDir: getContextAiHomeDir(ctx),
      accountStateService: ctx.deps && ctx.deps.accountStateService
    };
    const forceScopedProbe = accountScope
      ? accountScopeNeverProbed(state, modelCacheDeps, accountScope)
      : false;
    const result = await getWebUiModelsCache(state, options, {
      accountScope,
      forceRefresh: forceScopedProbe,
      ...modelCacheDeps,
      fetchModelsForAccount: deps.fetchModelsForAccount
    });
    const accountRefProjection = buildModelAccountRefProjection(ctx, state, result, accountScope);
    const settings = await loadModelSettingsData(ctx);
    const selectableByAccountRef = buildSelectableModelProjection(state, accountRefProjection, settings, accountScope);
    const defaultByAccountRef = buildDefaultModelProjection(settings, selectableByAccountRef);

    writeJson(ctx.res, 200, {
      ok: true,
      cached: result.cached,
      updatedAt: result.updatedAt,
      source: result.source,
      sources: result.sourceCount,
      scannedAccounts: result.scannedAccounts,
      firstError: result.firstError,
      accountScope: serializeModelsAccountScope(accountScope),
      models: result.models,
      byAccountRef: accountRefProjection.byAccountRef,
      selectableByAccountRef,
      defaultByAccountRef,
      errorsByAccountRef: accountRefProjection.errorsByAccountRef,
      labels: result.labels
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

async function handleGetProjectSessionsRequest(ctx) {
  const projectPath = String(ctx.url.searchParams?.get('projectPath') || '').trim();
  if (!projectPath) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'missing_projectPath',
      message: '缺少项目路径'
    });
    return true;
  }

  try {
    const project = await getCompleteProjectSnapshot(ctx, projectPath);
    if (!project) {
      ctx.writeJson(ctx.res, 404, {
        ok: false,
        error: 'project_not_found',
        message: '未找到项目'
      });
      return true;
    }

    ctx.writeJson(ctx.res, 200, { ok: true, project });
    return true;
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_project_sessions_failed',
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
    const hostHomeDir = getContextHostHomeDir(ctx);
    addOpenedProject(
      { path: projectPath, name: projectName },
      { fs, aiHomeDir: deps.aiHomeDir || '' }
    );
    ensureCodexHooksEnabled({ hostHomeDir });
    ensureCodexProjectRegistered(projectPath, { hostHomeDir });
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
    notifyWebUiProjectWatchers(ctx, { force: true }).catch(() => {});
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
    const hostHomeDir = getContextHostHomeDir(ctx);
    removeOpenedProject(projectPath, {
      fs,
      aiHomeDir: deps.aiHomeDir || ''
    });
    removeCodexProjectRegistration(projectPath, { hostHomeDir });
    updateProjectsSnapshot(ctx, (projects) => {
      const normalizedProjectPath = String(projectPath).replace(/\/+$/, '');
      return (Array.isArray(projects) ? projects : []).filter((item) =>
        String(item && item.path || '').replace(/\/+$/, '') !== normalizedProjectPath
      );
    });
    notifyWebUiProjectWatchers(ctx, { force: true }).catch(() => {});
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

/**
 * 浏览服务端本地目录结构
 */
async function handleBrowseProjectsRequest(ctx) {
  const { method, pathname, readRequestBody, writeJson, deps } = ctx;
  const { fs } = deps;

  try {
    const bodyBuf = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
      .catch(() => null);
    const body = bodyBuf ? JSON.parse(bodyBuf.toString('utf8')) : {};
    const subDir = String(body.subDir || '').trim();

    const os = require('node:os');
    const path = require('node:path');
    const pathImpl = process.platform === 'win32' ? path.win32 : path;

    const homeDir = os.homedir();
    const baseDir = homeDir || process.cwd();

    let targetDir = '';
    if (!subDir) {
      targetDir = baseDir;
    } else if (subDir.startsWith('~')) {
      targetDir = pathImpl.join(homeDir, subDir.slice(1));
    } else {
      targetDir = subDir;
    }

    if (pathImpl.isAbsolute(targetDir)) {
      targetDir = pathImpl.resolve(targetDir);
    } else {
      targetDir = pathImpl.resolve(baseDir, targetDir);
    }

    if (!fs.existsSync(targetDir)) {
      writeJson(ctx.res, 404, {
        ok: false,
        error: 'not_found',
        message: `路径不存在: ${targetDir}`
      });
      return true;
    }

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      writeJson(ctx.res, 400, {
        ok: false,
        error: 'not_a_directory',
        message: `路径不是目录: ${targetDir}`
      });
      return true;
    }

    // 安全拦截：禁止越权访问敏感系统目录，如 .ssh
    const lowerPath = targetDir.toLowerCase();
    if (
      lowerPath.includes('/.ssh') ||
      lowerPath.includes('\\.ssh')
    ) {
      writeJson(ctx.res, 403, {
        ok: false,
        error: 'permission_denied',
        message: '权限不足，无法访问该敏感系统目录'
      });
      return true;
    }

    const files = fs.readdirSync(targetDir, { withFileTypes: true });
    const directories = [];

    for (const file of files) {
      if (file.name === '.' || file.name === '..') continue;

      let isDir = false;
      const fullPath = pathImpl.join(targetDir, file.name);

      try {
        const fileStat = fs.statSync(fullPath);
        isDir = fileStat.isDirectory();
      } catch (_) {
        isDir = file.isDirectory();
      }

      if (isDir) {
        directories.push({
          name: file.name,
          path: fullPath
        });
      }
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));

    const currentDir = targetDir;
    const parentDir = currentDir === pathImpl.dirname(currentDir) ? currentDir : pathImpl.dirname(currentDir);

    writeJson(ctx.res, 200, {
      ok: true,
      currentDir,
      parentDir,
      directories
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'browse_failed',
      message: String(error && error.message || error || '目录浏览失败')
    });
    return true;
  }
}

module.exports = {
  handleGetModelsRequest,
  handleGetProjectsRequest,
  handleGetProjectSessionsRequest,
  handlePickProjectRequest,
  handleOpenProjectRequest,
  handleRemoveProjectRequest,
  handleBrowseProjectsRequest
};
