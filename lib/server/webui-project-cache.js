'use strict';

// 项目快照读与刷新的兼容薄桥接（全部真值与扫描已在 Go Core webuiprojectsapi）：
// 仅保留供 server.js / webui-chat-routes-native-session.js / web-ui-router.js 调用的导出。

const GO_PROJECTS_PATH = '/v1/management/webui/projects';
const GO_PROJECT_SESSIONS_PATH = '/v1/management/webui/projects/sessions';
const GO_PROJECTS_SNAPSHOT_PATH = '/v1/management/webui/projects/watch/snapshot';

function resolveGoHost(ctx) {
  return (ctx && ctx.deps && ctx.deps.goCoreSync)
    || (ctx && ctx.state && ctx.state.deps && ctx.state.deps.goCoreSync)
    || null;
}

async function getProjectsSnapshot(ctx) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.webuiRequest !== 'function') {
    throw new Error('Go Core 未就绪，无法读取项目快照');
  }
  const response = await goHost.webuiRequest({ method: 'GET', path: GO_PROJECTS_PATH });
  if (response && response.ok && response.data) {
    return response.data;
  }
  throw new Error(String((response && response.data && response.data.message) || '读取 Go Core 项目快照失败'));
}

async function buildProjectsSnapshot(ctx) {
  return getProjectsSnapshot(ctx);
}

async function getHostProjectsIndex(ctx) {
  return getProjectsSnapshot(ctx);
}

async function refreshHostProjectsIndex(ctx) {
  return getProjectsSnapshot(ctx);
}

async function getCompleteProjectSnapshot(ctx, projectPath) {
  const target = String(projectPath || '').trim();
  if (!target) return null;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.webuiRequest !== 'function') {
    throw new Error('Go Core 未就绪，无法读取完整项目会话');
  }
  const query = `?projectPath=${encodeURIComponent(target)}`;
  const response = await goHost.webuiRequest({
    method: 'GET',
    path: `${GO_PROJECT_SESSIONS_PATH}${query}`
  });
  if (response && response.ok && response.data && response.data.project) {
    return response.data.project;
  }
  return null;
}

async function refreshProjectsSnapshot(ctx) {
  const goHost = resolveGoHost(ctx);
  if (goHost && typeof goHost.webuiRequest === 'function') {
    try {
      await goHost.webuiRequest({ method: 'POST', path: GO_PROJECTS_SNAPSHOT_PATH });
    } catch (_error) {}
  }
  return { projects: [] };
}

function scheduleProjectsSnapshotRefresh(ctx) {
  refreshProjectsSnapshot(ctx).catch(() => {});
}

function updateProjectsSnapshot() {}
function ensureProjectsSnapshotScheduler() {}
function closeProjectsSnapshotScheduler() {}

module.exports = {
  buildProjectsSnapshot,
  getProjectsSnapshot,
  getHostProjectsIndex,
  getCompleteProjectSnapshot,
  refreshHostProjectsIndex,
  refreshProjectsSnapshot,
  scheduleProjectsSnapshotRefresh,
  updateProjectsSnapshot,
  ensureProjectsSnapshotScheduler,
  closeProjectsSnapshotScheduler
};
