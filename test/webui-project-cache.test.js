const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  getProjectsSnapshot,
  refreshProjectsSnapshot,
  ensureProjectsSnapshotScheduler,
  closeProjectsSnapshotScheduler
} = require('../lib/server/webui-project-cache');
const {
  readJsonValue,
  writeJsonValue
} = require('../lib/server/app-state-store');
const sessionReader = require('../lib/sessions/session-reader');

const PROJECTS_SNAPSHOT_CACHE_KEY = 'cache:webui-projects-snapshot.json';
const HOST_PROJECTS_INDEX_CACHE_KEY = 'cache:webui-host-projects-index.json';

function createContext(aiHomeDir) {
  return {
    state: {},
    fs,
    aiHomeDir
  };
}

async function waitFor(assertion, timeoutMs = 3000, intervalMs = 50) {
  const startedAt = Date.now();
  let lastError = null;
  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError || new Error('waitFor timeout');
}

test('projects snapshot can rebuild from persisted host index without rescanning host', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-'));
  const demoProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-demo-'));
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;

  try {
    const hostProjects = [
      {
        id: 'p-1',
        name: 'demo-project',
        path: demoProjectDir,
        provider: 'codex',
        sessions: [
          { id: 's-1', title: 'demo session', updatedAt: 123, provider: 'codex' }
        ]
      }
    ];
    let reads = 0;
    sessionReader.readAllProjectsFromHost = () => {
      reads += 1;
      return hostProjects;
    };

    await refreshProjectsSnapshot(createContext(aiHomeDir), { forceRefresh: true });
    assert.equal(reads >= 1, true);

    writeJsonValue(fs, aiHomeDir, PROJECTS_SNAPSHOT_CACHE_KEY, null);
    sessionReader.readAllProjectsFromHost = () => {
      throw new Error('should rebuild from persisted host index');
    };

    const snapshot = await getProjectsSnapshot(createContext(aiHomeDir));
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0].path, demoProjectDir);
    assert.equal(snapshot.projects[0].sessions.length, 1);
    assert.equal(snapshot.projects[0].sessions[0].id, 's-1');
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(demoProjectDir, { recursive: true, force: true });
  }
});

test('projects snapshot aggregates account-scoped Qoder sessions', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-qoder-project-cache-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-qoder-project-'));
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const calls = [];

  try {
    sessionReader.readAllProjectsFromHost = () => [];
    sessionReader.readProjectsFromHostByProviders = (providers, options = {}) => {
      calls.push({ providers, options });
      if (providers[0] !== 'qodercn' || options.accountRef !== 'acct_qoder') return [];
      return [{
        id: 'qoder-project',
        name: 'qoder-project',
        path: projectDir,
        provider: 'qodercn',
        sessions: [{
          id: 'qoder-session',
          title: 'Qoder session',
          updatedAt: 200,
          provider: 'qodercn',
          accountRef: 'acct_qoder'
        }]
      }];
    };
    const ctx = createContext(aiHomeDir);
    ctx.hostHomeDir = path.dirname(aiHomeDir);
    ctx.state.accounts = { qodercn: [{ accountRef: 'acct_qoder' }] };

    await refreshProjectsSnapshot(ctx, { forceRefresh: true });
    const snapshot = await getProjectsSnapshot(ctx);
    assert.equal(snapshot.projects[0].sessions[0].id, 'qoder-session');
    assert.equal(calls.some((call) => call.options.accountRef === 'acct_qoder'), true);
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('projects snapshot aggregates account-scoped Grok sessions', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-grok-project-cache-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-grok-project-'));
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const calls = [];
  try {
    sessionReader.readAllProjectsFromHost = () => [];
    sessionReader.readProjectsFromHostByProviders = (providers, options = {}) => {
      calls.push({ providers, options });
      if (providers[0] !== 'grok' || options.accountRef !== 'acct_grok') return [];
      return [{
        id: 'grok-project', name: 'grok-project', path: projectDir, provider: 'grok',
        sessions: [{ id: 'grok-session', title: 'Grok session', updatedAt: 200, provider: 'grok', accountRef: 'acct_grok' }]
      }];
    };
    const ctx = createContext(aiHomeDir);
    ctx.hostHomeDir = path.dirname(aiHomeDir);
    ctx.state.accounts = { grok: [{ accountRef: 'acct_grok' }] };

    await refreshProjectsSnapshot(ctx, { forceRefresh: true });
    const snapshot = await getProjectsSnapshot(ctx);
    assert.equal(calls.some((call) => call.providers[0] === 'grok' && call.options.accountRef === 'acct_grok'), true);
    const grokProject = snapshot.projects.find((project) => project.sessions.some((session) => session.provider === 'grok'));
    assert.equal(grokProject.sessions[0].id, 'grok-session');
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('projects snapshot returns persisted snapshot first and refreshes stale host index in background', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-bg-'));
  const oldProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-old-'));
  const newProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-new-'));
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;

  try {
    sessionReader.readAllProjectsFromHost = () => ([
      {
        id: 'p-old',
        name: 'old-project',
        path: oldProjectDir,
        provider: 'codex',
        sessions: [
          { id: 's-old', title: 'old session', updatedAt: 100, provider: 'codex' }
        ]
      }
    ]);

    await refreshProjectsSnapshot(createContext(aiHomeDir), { forceRefresh: true });

    const persistedSnapshot = readJsonValue(fs, aiHomeDir, PROJECTS_SNAPSHOT_CACHE_KEY);
    const persistedHostIndex = readJsonValue(fs, aiHomeDir, HOST_PROJECTS_INDEX_CACHE_KEY);
    persistedSnapshot.updatedAt = 1;
    persistedHostIndex.updatedAt = 1;
    writeJsonValue(fs, aiHomeDir, PROJECTS_SNAPSHOT_CACHE_KEY, persistedSnapshot);
    writeJsonValue(fs, aiHomeDir, HOST_PROJECTS_INDEX_CACHE_KEY, persistedHostIndex);

    let reads = 0;
    sessionReader.readAllProjectsFromHost = () => {
      reads += 1;
      return [
        {
          id: 'p-new',
          name: 'new-project',
          path: newProjectDir,
          provider: 'codex',
          sessions: [
            { id: 's-new', title: 'new session', updatedAt: 200, provider: 'codex' }
          ]
        }
      ];
    };

    const ctx = createContext(aiHomeDir);
    const firstSnapshot = await getProjectsSnapshot(ctx);
    assert.equal(firstSnapshot.projects.length, 1);
    assert.equal(firstSnapshot.projects[0].path, oldProjectDir);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const secondSnapshot = await getProjectsSnapshot(ctx);
    assert.equal(reads >= 1, true);
    assert.equal(secondSnapshot.projects.length, 1);
    assert.equal(secondSnapshot.projects[0].path, newProjectDir);
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(oldProjectDir, { recursive: true, force: true });
    fs.rmSync(newProjectDir, { recursive: true, force: true });
  }
});

test('projects snapshot marks host index dirty from fs watch events and refreshes in background', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-watch-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-watch-host-'));
  const initialProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-initial-'));
  const updatedProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-updated-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalWatch = fs.watch;
  let ctx = null;
  process.env.REAL_HOME = hostHomeDir;

  try {
    fs.ensureDirSync(path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13'));
    const watcherCallbacks = new Map();
    fs.watch = (targetPath, listener) => {
      watcherCallbacks.set(String(targetPath), listener);
      return {
        close() {},
        on() { return this; }
      };
    };

    let phase = 'initial';
    sessionReader.readAllProjectsFromHost = () => {
      if (phase === 'initial') {
        return [{
          id: 'p-initial',
          name: 'initial-project',
          path: initialProjectDir,
          provider: 'codex',
          sessions: [{ id: 's-initial', title: 'initial', updatedAt: 100, provider: 'codex' }]
        }];
      }
      return [{
        id: 'p-updated',
        name: 'updated-project',
        path: updatedProjectDir,
        provider: 'codex',
        sessions: [{ id: 's-updated', title: 'updated', updatedAt: 200, provider: 'codex' }]
      }];
    };
    sessionReader.readProjectsFromHostByProviders = (providers) => {
      if (!Array.isArray(providers) || !providers.includes('codex')) return [];
      if (phase === 'initial') {
        return [{
          id: 'p-initial',
          name: 'initial-project',
          path: initialProjectDir,
          provider: 'codex',
          sessions: [{ id: 's-initial', title: 'initial', updatedAt: 100, provider: 'codex' }]
        }];
      }
      return [{
        id: 'p-updated',
        name: 'updated-project',
        path: updatedProjectDir,
        provider: 'codex',
        sessions: [{ id: 's-updated', title: 'updated', updatedAt: 200, provider: 'codex' }]
      }];
    };

    ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });
    ensureProjectsSnapshotScheduler(ctx);
    const firstSnapshot = await getProjectsSnapshot(ctx);
    assert.equal(firstSnapshot.projects[0].path, initialProjectDir);
    assert.equal(watcherCallbacks.size > 0, true);

    phase = 'updated';
    const codexDirWatcher = watcherCallbacks.get(path.join(hostHomeDir, '.codex'))
      || watcherCallbacks.get(hostHomeDir);
    assert.equal(typeof codexDirWatcher, 'function');
    codexDirWatcher('change', 'session_index.jsonl');

    await waitFor(async () => {
      const secondSnapshot = await getProjectsSnapshot(ctx);
      assert.equal(secondSnapshot.projects[0].path, updatedProjectDir);
    });
  } finally {
    if (ctx) closeProjectsSnapshotScheduler(ctx);
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
    fs.rmSync(initialProjectDir, { recursive: true, force: true });
    fs.rmSync(updatedProjectDir, { recursive: true, force: true });
  }
});

test('projects snapshot refreshes only changed provider after fs watch event', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-partial-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-partial-host-'));
  const codexProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-codex-'));
  const claudeProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-claude-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalWatch = fs.watch;
  let ctx = null;
  process.env.REAL_HOME = hostHomeDir;

  try {
    fs.ensureDirSync(path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13'));
    fs.ensureDirSync(path.join(hostHomeDir, '.claude', 'projects'));

    const watcherCallbacks = new Map();
    fs.watch = (targetPath, listener) => {
      watcherCallbacks.set(String(targetPath), listener);
      return {
        close() {},
        on() { return this; }
      };
    };

    sessionReader.readAllProjectsFromHost = () => ([
      {
        id: 'codex-initial',
        name: 'codex-project',
        path: codexProjectDir,
        provider: 'codex',
        sessions: [{ id: 'codex-s1', title: 'codex initial', updatedAt: 100, provider: 'codex' }]
      },
      {
        id: 'claude-initial',
        name: 'claude-project',
        path: claudeProjectDir,
        provider: 'claude',
        sessions: [{ id: 'claude-s1', title: 'claude initial', updatedAt: 90, provider: 'claude' }]
      }
    ]);

    let partialProviders = [];
    sessionReader.readProjectsFromHostByProviders = (providers) => {
      partialProviders = Array.isArray(providers) ? providers.slice() : [providers];
      return [
        {
          id: 'codex-updated',
          name: 'codex-project',
          path: codexProjectDir,
          provider: 'codex',
          sessions: [{ id: 'codex-s2', title: 'codex updated', updatedAt: 200, provider: 'codex' }]
        }
      ];
    };

    ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });
    ensureProjectsSnapshotScheduler(ctx);

    sessionReader.readAllProjectsFromHost = () => {
      throw new Error('should not full refresh for codex-only fs change');
    };

    const codexDirWatcher = watcherCallbacks.get(path.join(hostHomeDir, '.codex'))
      || watcherCallbacks.get(hostHomeDir);
    assert.equal(typeof codexDirWatcher, 'function');
    codexDirWatcher('change', 'session_index.jsonl');

    await waitFor(async () => {
      const snapshot = await getProjectsSnapshot(ctx);
      assert.deepEqual(partialProviders, ['codex']);
      assert.equal(snapshot.projects.length, 2);
      const codexProject = snapshot.projects.find((item) => item.path === codexProjectDir);
      const claudeProject = snapshot.projects.find((item) => item.path === claudeProjectDir);
      assert.ok(codexProject);
      assert.ok(claudeProject);
      assert.equal(codexProject.sessions[0].id, 'codex-s2');
      assert.equal(claudeProject.sessions[0].id, 'claude-s1');
    });
  } finally {
    if (ctx) closeProjectsSnapshotScheduler(ctx);
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
    fs.rmSync(codexProjectDir, { recursive: true, force: true });
    fs.rmSync(claudeProjectDir, { recursive: true, force: true });
  }
});

test('projects snapshot refreshes only changed claude project after directory watch event', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-claude-project-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-claude-host-'));
  const projectADir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-claude-a-'));
  const projectBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-claude-b-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalWatch = fs.watch;
  let ctx = null;
  process.env.REAL_HOME = hostHomeDir;

  try {
    fs.ensureDirSync(path.join(hostHomeDir, '.claude', 'projects', 'project-a'));
    fs.ensureDirSync(path.join(hostHomeDir, '.claude', 'projects', 'project-b'));

    const watcherCallbacks = new Map();
    fs.watch = (targetPath, listener) => {
      watcherCallbacks.set(String(targetPath), listener);
      return {
        close() {},
        on() { return this; }
      };
    };

    sessionReader.readAllProjectsFromHost = () => ([
      {
        id: 'project-a',
        name: 'project-a',
        path: projectADir,
        provider: 'claude',
        sessions: [{ id: 'claude-a-1', title: 'claude a old', updatedAt: 100, provider: 'claude' }]
      },
      {
        id: 'project-b',
        name: 'project-b',
        path: projectBDir,
        provider: 'claude',
        sessions: [{ id: 'claude-b-1', title: 'claude b old', updatedAt: 90, provider: 'claude' }]
      }
    ]);

    let partialArgs = null;
    sessionReader.readProjectsFromHostByProviders = (providers, options) => {
      partialArgs = {
        providers: Array.isArray(providers) ? providers.slice() : [providers],
        options
      };
      return [
        {
          id: 'project-a',
          name: 'project-a',
          path: projectADir,
          provider: 'claude',
          sessions: [{ id: 'claude-a-2', title: 'claude a new', updatedAt: 200, provider: 'claude' }]
        }
      ];
    };

    ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });
    ensureProjectsSnapshotScheduler(ctx);

    sessionReader.readAllProjectsFromHost = () => {
      throw new Error('should not full refresh for one claude project change');
    };

    const claudeProjectsWatcher = watcherCallbacks.get(path.join(hostHomeDir, '.claude', 'projects'));
    assert.equal(typeof claudeProjectsWatcher, 'function');
    claudeProjectsWatcher('change', 'project-a');

    await waitFor(async () => {
      const snapshot = await getProjectsSnapshot(ctx);
      assert.deepEqual(partialArgs && partialArgs.providers, ['claude']);
      assert.deepEqual(
        partialArgs && partialArgs.options && partialArgs.options.projectHints && partialArgs.options.projectHints.claudeProjectDirs,
        ['project-a']
      );
      const projectA = snapshot.projects.find((item) => item.path === projectADir);
      const projectB = snapshot.projects.find((item) => item.path === projectBDir);
      assert.ok(projectA);
      assert.ok(projectB);
      assert.equal(projectA.sessions[0].id, 'claude-a-2');
      assert.equal(projectB.sessions[0].id, 'claude-b-1');
    });
  } finally {
    if (ctx) closeProjectsSnapshotScheduler(ctx);
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
    fs.rmSync(projectADir, { recursive: true, force: true });
    fs.rmSync(projectBDir, { recursive: true, force: true });
  }
});

test('projects snapshot refreshes only changed codex project after session file watch event', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-codex-project-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-codex-host-'));
  const codexADir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-codex-a-'));
  const codexBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-codex-b-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalReadCodexSessionProjectPath = sessionReader.readCodexSessionProjectPath;
  const originalWatch = fs.watch;
  let ctx = null;
  process.env.REAL_HOME = hostHomeDir;

  try {
    fs.ensureDirSync(path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13'));

    const watcherCallbacks = new Map();
    fs.watch = (targetPath, listener) => {
      watcherCallbacks.set(String(targetPath), listener);
      return {
        close() {},
        on() { return this; }
      };
    };

    sessionReader.readAllProjectsFromHost = () => ([
      {
        id: 'codex-a',
        name: 'codex-a',
        path: codexADir,
        provider: 'codex',
        sessions: [{ id: 'codex-a-1', title: 'codex a old', updatedAt: 100, provider: 'codex' }]
      },
      {
        id: 'codex-b',
        name: 'codex-b',
        path: codexBDir,
        provider: 'codex',
        sessions: [{ id: 'codex-b-1', title: 'codex b old', updatedAt: 90, provider: 'codex' }]
      }
    ]);

    sessionReader.readCodexSessionProjectPath = (sessionFilePath) => {
      if (String(sessionFilePath).endsWith('rollout-2026-04-13T12-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl')) {
        return codexADir;
      }
      return '';
    };

    let partialArgs = null;
    sessionReader.readProjectsFromHostByProviders = (providers, options) => {
      partialArgs = {
        providers: Array.isArray(providers) ? providers.slice() : [providers],
        options
      };
      return [
        {
          id: 'codex-a',
          name: 'codex-a',
          path: codexADir,
          provider: 'codex',
          sessions: [{ id: 'codex-a-2', title: 'codex a new', updatedAt: 200, provider: 'codex' }]
        }
      ];
    };

    ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });
    ensureProjectsSnapshotScheduler(ctx);

    sessionReader.readAllProjectsFromHost = () => {
      throw new Error('should not full refresh for one codex project change');
    };

    const dayWatcher = watcherCallbacks.get(path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13'));
    assert.equal(typeof dayWatcher, 'function');
    dayWatcher('change', 'rollout-2026-04-13T12-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');

    await waitFor(async () => {
      const snapshot = await getProjectsSnapshot(ctx);
      assert.deepEqual(partialArgs && partialArgs.providers, ['codex']);
      assert.deepEqual(
        partialArgs && partialArgs.options && partialArgs.options.projectHints && partialArgs.options.projectHints.codexProjectPaths,
        [codexADir]
      );
      const projectA = snapshot.projects.find((item) => item.path === codexADir);
      const projectB = snapshot.projects.find((item) => item.path === codexBDir);
      assert.ok(projectA);
      assert.ok(projectB);
      assert.equal(projectA.sessions[0].id, 'codex-a-2');
      assert.equal(projectB.sessions[0].id, 'codex-b-1');
    });
  } finally {
    if (ctx) closeProjectsSnapshotScheduler(ctx);
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    sessionReader.readCodexSessionProjectPath = originalReadCodexSessionProjectPath;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
    fs.rmSync(codexADir, { recursive: true, force: true });
    fs.rmSync(codexBDir, { recursive: true, force: true });
  }
});
