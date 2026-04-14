const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  getProjectsSnapshot,
  refreshProjectsSnapshot
} = require('../lib/server/webui-project-cache');
const sessionReader = require('../lib/sessions/session-reader');

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
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;

  try {
    const hostProjects = [
      {
        id: 'p-1',
        name: 'demo-project',
        path: '/tmp/demo-project',
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

    fs.rmSync(path.join(aiHomeDir, 'cache', 'webui-projects-snapshot.json'), { force: true });
    sessionReader.readAllProjectsFromHost = () => {
      throw new Error('should rebuild from persisted host index');
    };

    const snapshot = await getProjectsSnapshot(createContext(aiHomeDir));
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0].path, '/tmp/demo-project');
    assert.equal(snapshot.projects[0].sessions.length, 1);
    assert.equal(snapshot.projects[0].sessions[0].id, 's-1');
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('projects snapshot returns persisted snapshot first and refreshes stale host index in background', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-bg-'));
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;

  try {
    sessionReader.readAllProjectsFromHost = () => ([
      {
        id: 'p-old',
        name: 'old-project',
        path: '/tmp/old-project',
        provider: 'codex',
        sessions: [
          { id: 's-old', title: 'old session', updatedAt: 100, provider: 'codex' }
        ]
      }
    ]);

    await refreshProjectsSnapshot(createContext(aiHomeDir), { forceRefresh: true });

    const cacheDir = path.join(aiHomeDir, 'cache');
    const snapshotPath = path.join(cacheDir, 'webui-projects-snapshot.json');
    const hostIndexPath = path.join(cacheDir, 'webui-host-projects-index.json');
    const persistedSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const persistedHostIndex = JSON.parse(fs.readFileSync(hostIndexPath, 'utf8'));
    persistedSnapshot.updatedAt = 1;
    persistedHostIndex.updatedAt = 1;
    fs.writeFileSync(snapshotPath, JSON.stringify(persistedSnapshot, null, 2));
    fs.writeFileSync(hostIndexPath, JSON.stringify(persistedHostIndex, null, 2));

    let reads = 0;
    sessionReader.readAllProjectsFromHost = () => {
      reads += 1;
      return [
        {
          id: 'p-new',
          name: 'new-project',
          path: '/tmp/new-project',
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
    assert.equal(firstSnapshot.projects[0].path, '/tmp/old-project');

    await new Promise((resolve) => setTimeout(resolve, 30));

    const secondSnapshot = await getProjectsSnapshot(ctx);
    assert.equal(reads >= 1, true);
    assert.equal(secondSnapshot.projects.length, 1);
    assert.equal(secondSnapshot.projects[0].path, '/tmp/new-project');
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('projects snapshot marks host index dirty from fs watch events and refreshes in background', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-watch-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-watch-host-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalWatch = fs.watch;
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
          path: '/tmp/initial-project',
          provider: 'codex',
          sessions: [{ id: 's-initial', title: 'initial', updatedAt: 100, provider: 'codex' }]
        }];
      }
      return [{
        id: 'p-updated',
        name: 'updated-project',
        path: '/tmp/updated-project',
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
          path: '/tmp/initial-project',
          provider: 'codex',
          sessions: [{ id: 's-initial', title: 'initial', updatedAt: 100, provider: 'codex' }]
        }];
      }
      return [{
        id: 'p-updated',
        name: 'updated-project',
        path: '/tmp/updated-project',
        provider: 'codex',
        sessions: [{ id: 's-updated', title: 'updated', updatedAt: 200, provider: 'codex' }]
      }];
    };

    const ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });
    const firstSnapshot = await getProjectsSnapshot(ctx);
    assert.equal(firstSnapshot.projects[0].path, '/tmp/initial-project');
    assert.equal(watcherCallbacks.size > 0, true);

    phase = 'updated';
    const codexDirWatcher = watcherCallbacks.get(path.join(hostHomeDir, '.codex'))
      || watcherCallbacks.get(hostHomeDir);
    assert.equal(typeof codexDirWatcher, 'function');
    codexDirWatcher('change', 'session_index.jsonl');

    await waitFor(async () => {
      const secondSnapshot = await getProjectsSnapshot(ctx);
      assert.equal(secondSnapshot.projects[0].path, '/tmp/updated-project');
    });
  } finally {
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('projects snapshot refreshes only changed provider after fs watch event', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-partial-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-partial-host-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalWatch = fs.watch;
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
        path: '/tmp/codex-project',
        provider: 'codex',
        sessions: [{ id: 'codex-s1', title: 'codex initial', updatedAt: 100, provider: 'codex' }]
      },
      {
        id: 'claude-initial',
        name: 'claude-project',
        path: '/tmp/claude-project',
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
          path: '/tmp/codex-project',
          provider: 'codex',
          sessions: [{ id: 'codex-s2', title: 'codex updated', updatedAt: 200, provider: 'codex' }]
        }
      ];
    };

    const ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });

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
      const codexProject = snapshot.projects.find((item) => item.path === '/tmp/codex-project');
      const claudeProject = snapshot.projects.find((item) => item.path === '/tmp/claude-project');
      assert.ok(codexProject);
      assert.ok(claudeProject);
      assert.equal(codexProject.sessions[0].id, 'codex-s2');
      assert.equal(claudeProject.sessions[0].id, 'claude-s1');
    });
  } finally {
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('projects snapshot refreshes only changed claude project after directory watch event', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-claude-project-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-claude-host-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalWatch = fs.watch;
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
        path: '/tmp/project-a',
        provider: 'claude',
        sessions: [{ id: 'claude-a-1', title: 'claude a old', updatedAt: 100, provider: 'claude' }]
      },
      {
        id: 'project-b',
        name: 'project-b',
        path: '/tmp/project-b',
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
          path: '/tmp/project-a',
          provider: 'claude',
          sessions: [{ id: 'claude-a-2', title: 'claude a new', updatedAt: 200, provider: 'claude' }]
        }
      ];
    };

    const ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });

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
      const projectA = snapshot.projects.find((item) => item.path === '/tmp/project-a');
      const projectB = snapshot.projects.find((item) => item.path === '/tmp/project-b');
      assert.ok(projectA);
      assert.ok(projectB);
      assert.equal(projectA.sessions[0].id, 'claude-a-2');
      assert.equal(projectB.sessions[0].id, 'claude-b-1');
    });
  } finally {
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('projects snapshot refreshes only changed codex project after session file watch event', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-codex-project-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-cache-codex-host-'));
  const originalRealHome = process.env.REAL_HOME;
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalReadProjectsFromHostByProviders = sessionReader.readProjectsFromHostByProviders;
  const originalReadCodexSessionProjectPath = sessionReader.readCodexSessionProjectPath;
  const originalWatch = fs.watch;
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
        path: '/tmp/codex-a',
        provider: 'codex',
        sessions: [{ id: 'codex-a-1', title: 'codex a old', updatedAt: 100, provider: 'codex' }]
      },
      {
        id: 'codex-b',
        name: 'codex-b',
        path: '/tmp/codex-b',
        provider: 'codex',
        sessions: [{ id: 'codex-b-1', title: 'codex b old', updatedAt: 90, provider: 'codex' }]
      }
    ]);

    sessionReader.readCodexSessionProjectPath = (sessionFilePath) => {
      if (String(sessionFilePath).endsWith('rollout-2026-04-13T12-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl')) {
        return '/tmp/codex-a';
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
          path: '/tmp/codex-a',
          provider: 'codex',
          sessions: [{ id: 'codex-a-2', title: 'codex a new', updatedAt: 200, provider: 'codex' }]
        }
      ];
    };

    const ctx = createContext(aiHomeDir);
    await refreshProjectsSnapshot(ctx, { forceRefresh: true });

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
        ['/tmp/codex-a']
      );
      const projectA = snapshot.projects.find((item) => item.path === '/tmp/codex-a');
      const projectB = snapshot.projects.find((item) => item.path === '/tmp/codex-b');
      assert.ok(projectA);
      assert.ok(projectB);
      assert.equal(projectA.sessions[0].id, 'codex-a-2');
      assert.equal(projectB.sessions[0].id, 'codex-b-1');
    });
  } finally {
    fs.watch = originalWatch;
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.readProjectsFromHostByProviders = originalReadProjectsFromHostByProviders;
    sessionReader.readCodexSessionProjectPath = originalReadCodexSessionProjectPath;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});
