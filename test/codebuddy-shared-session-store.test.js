'use strict';

/**
 * CodeBuddy 家族的共享会话存储语义（与账号存储层的约定）。
 *
 * 用户口径：会话打通**不能**用"复制会话"的策略。所以这里把三条硬约束钉住：
 *
 *   1. 共享面**严格等于**声明的 sharedEntries —— 对家族就是 `projects` 一个，
 *      不放宽成"检测到什么就共享什么"（那会把 logs / plugins / shell-snapshots /
 *      history.jsonl 一并链接出去）；
 *   2. 账号沙箱里的 `<configDir>/projects` 是一条指向宿主**地区存储**的**软链接**
 *      （一份物理数据，relay 时 CLI 直接写进地区存储）；
 *   3. **绝不**把投影里已有的会话 move/merge 进宿主存储 —— 空目录可以丢弃后建链，
 *      里面有真实会话文件就如实报 unresolved（fail-closed），不复制、不移动、不覆盖。
 *
 * 另外钉住 WorkBuddy 两个站点的账号私有条目：缺了它们，通用的"检测到什么就共享
 * 什么"会把 settings.json / .mcp.json / sessions 链接进宿主，等于所有账号共用一份
 * 配置。这一条与 codebuddy / codebuddycn 对称。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fse = require('fs-extra');

const {
  collectSharedToolEntryNames,
  createSessionStoreService
} = require('../lib/cli/services/session-store');
const {
  getProviderPrivateEntryNames,
  getProviderSharedEntries,
  getProviderStoragePolicy
} = require('../lib/runtime/provider-storage-policy');

// provider -> 宿主/投影下的配置目录名（= CLIConfig.globalDir）
const CONFIG_DIR_BY_PROVIDER = Object.freeze({
  codebuddy: '.codebuddy',
  codebuddycn: '.codebuddy-cn',
  workbuddy: '.workbuddy-ai',
  workbuddycn: '.workbuddy'
});
const FAMILY_PROVIDERS = Object.freeze(Object.keys(CONFIG_DIR_BY_PROVIDER));

const CLI_CONFIGS = Object.fromEntries(
  FAMILY_PROVIDERS.map((provider) => [provider, { globalDir: CONFIG_DIR_BY_PROVIDER[provider] }])
);

function createTree() {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'aih-codebuddy-store-'));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'host');
  nodeFs.mkdirSync(aiHomeDir, { recursive: true });
  nodeFs.mkdirSync(hostHomeDir, { recursive: true });
  const service = createSessionStoreService({
    fs: nodeFs,
    fse,
    path,
    processObj: process,
    aiHomeDir,
    hostHomeDir,
    cliConfigs: CLI_CONFIGS,
    getProfileDir: (provider, id) => path.join(aiHomeDir, 'proj', provider, id),
    ensureDir: (directory) => nodeFs.mkdirSync(directory, { recursive: true })
  });
  return { root, aiHomeDir, hostHomeDir, service };
}

function projectionDir(root, provider, accountRef = 'acct_x') {
  return path.join(root, 'proj', provider, accountRef);
}

function configDirOf(projectionRoot, provider) {
  return path.join(projectionRoot, CONFIG_DIR_BY_PROVIDER[provider]);
}

function isLink(targetPath) {
  try {
    return nodeFs.lstatSync(targetPath).isSymbolicLink();
  } catch (_error) {
    return false;
  }
}

function readDirNames(directory) {
  return nodeFs.readdirSync(directory).sort();
}

// --- 1. 共享面严格等于声明的条目 -----------------------------------------

test('the family shares exactly its declared sharedEntries, not everything detected', () => {
  const { root } = createTree();
  try {
    // 模拟 CLI 首启自建的目录 + 账号私有文件 + 名字里带 session/history 的目录。
    const noisy = [
      'projects', 'settings.json', '.mcp.json', 'sessions',
      'logs', 'plugins', 'local_storage', 'shell-snapshots', 'history.jsonl'
    ];
    for (const provider of FAMILY_PROVIDERS) {
      const dir = path.join(root, 'noisy', provider, CONFIG_DIR_BY_PROVIDER[provider]);
      nodeFs.mkdirSync(dir, { recursive: true });
      for (const name of noisy) nodeFs.writeFileSync(path.join(dir, name), '');
      assert.deepEqual(
        collectSharedToolEntryNames(nodeFs, provider, [dir]),
        ['projects'],
        `${provider}: 共享面必须只有 projects`
      );
    }
    // 基线：通用 Provider 仍然是"检测到什么就共享什么"，本改动没有收窄它们。
    const codexDir = path.join(root, 'noisy', 'codex', '.codex');
    nodeFs.mkdirSync(codexDir, { recursive: true });
    for (const name of noisy) nodeFs.writeFileSync(path.join(codexDir, name), '');
    const codexShared = collectSharedToolEntryNames(nodeFs, 'codex', [codexDir]);
    assert.ok(codexShared.includes('logs'), 'codex 仍按通用口径共享 logs');
    assert.ok(codexShared.includes('settings.json'), 'codex 仍按通用口径共享 settings.json');
  } finally {
    fse.removeSync(root);
  }
});

// --- 2. 家族私有条目（修掉 WorkBuddy 的账号间共享） -----------------------

test('all four family providers keep settings.json, .mcp.json and sessions account-private', () => {
  for (const provider of FAMILY_PROVIDERS) {
    const privateNames = getProviderPrivateEntryNames(provider);
    for (const entry of ['settings.json', '.mcp.json', 'sessions']) {
      assert.ok(
        privateNames.includes(entry),
        `${provider}: ${entry} 必须账号私有（否则所有账号共用一份）`
      );
    }
    assert.deepEqual(getProviderSharedEntries(provider), ['projects']);
    assert.equal(getProviderStoragePolicy(provider).precreatedDirectories.includes('projects'), true,
      `${provider}: 共享存储要在首启前于宿主预建，链接才有目标`);
  }
});

// --- 3. 新建投影：projects 变成指向宿主地区存储的软链接 -------------------

test('a fresh projection links projects into the host region store without copying', () => {
  const { root, hostHomeDir, service } = createTree();
  try {
    for (const provider of FAMILY_PROVIDERS) {
      const projection = projectionDir(root, provider);
      const configDir = configDirOf(projection, provider);
      nodeFs.mkdirSync(configDir, { recursive: true });
      // 账号私有文件已存在，必须原样留下、且不能被链接。
      nodeFs.writeFileSync(path.join(configDir, 'settings.json'), '{"account":"A"}');

      const summary = service.ensureSessionStoreLinks(provider, 'acct_x', { projectionRoot: projection });
      assert.equal(summary.migrated, 0, `${provider}: 新建投影不该有迁移`);
      assert.equal(summary.linked, 1, `${provider}: projects 应被链接`);

      const link = path.join(configDir, 'projects');
      assert.ok(isLink(link), `${provider}: projects 应是软链接`);
      assert.equal(
        nodeFs.realpathSync(link),
        nodeFs.realpathSync(path.join(hostHomeDir, CONFIG_DIR_BY_PROVIDER[provider], 'projects')),
        `${provider}: 链接目标是宿主地区存储`
      );
      assert.ok(!isLink(path.join(configDir, 'settings.json')), `${provider}: settings.json 不得被链接`);
      assert.equal(nodeFs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'), '{"account":"A"}');
    }
  } finally {
    fse.removeSync(root);
  }
});

test('linking is idempotent and never duplicates the store', () => {
  const { root, hostHomeDir, service } = createTree();
  try {
    const provider = 'codebuddycn';
    const projection = projectionDir(root, provider);
    nodeFs.mkdirSync(configDirOf(projection, provider), { recursive: true });
    service.ensureSessionStoreLinks(provider, 'acct_x', { projectionRoot: projection });
    const second = service.ensureSessionStoreLinks(provider, 'acct_x', { projectionRoot: projection });
    assert.equal(second.migrated, 0);
    assert.equal(second.linked, 1, '已存在的受管链接应被识别，而不是重建');
    assert.ok(isLink(path.join(configDirOf(projection, provider), 'projects')));
    assert.deepEqual(readDirNames(path.join(hostHomeDir, CONFIG_DIR_BY_PROVIDER[provider])).filter((n) => n === 'projects'), ['projects']);
  } finally {
    fse.removeSync(root);
  }
});

// --- 4. 投影里已有真实会话：绝不迁移/复制 ---------------------------------

test('pre-existing projection sessions are never moved into the host store', () => {
  const { root, hostHomeDir, service } = createTree();
  try {
    for (const provider of FAMILY_PROVIDERS) {
      const projection = projectionDir(root, provider);
      const configDir = configDirOf(projection, provider);
      const projectionProjects = path.join(configDir, 'projects');
      const hostProjects = path.join(hostHomeDir, CONFIG_DIR_BY_PROVIDER[provider], 'projects');
      nodeFs.mkdirSync(projectionProjects, { recursive: true });
      nodeFs.mkdirSync(hostProjects, { recursive: true });
      nodeFs.writeFileSync(path.join(projectionProjects, 'account-session.jsonl'), 'ACCOUNT-DATA');
      nodeFs.writeFileSync(path.join(hostProjects, 'host-session.jsonl'), 'HOST-DATA');

      const summary = service.ensureSessionStoreLinks(provider, 'acct_x', { projectionRoot: projection });

      assert.equal(summary.migrated, 0, `${provider}: 不该发生迁移`);
      assert.deepEqual(summary.unresolved, ['projects'], `${provider}: 应如实报 unresolved（fail-closed）`);
      assert.ok(!isLink(projectionProjects), `${provider}: 有真实会话时不得覆盖成链接`);
      // 两侧内容都原封不动：既没被搬走，也没被覆盖。
      assert.deepEqual(readDirNames(projectionProjects), ['account-session.jsonl']);
      assert.equal(nodeFs.readFileSync(path.join(projectionProjects, 'account-session.jsonl'), 'utf8'), 'ACCOUNT-DATA');
      assert.deepEqual(readDirNames(hostProjects), ['host-session.jsonl']);
      assert.equal(nodeFs.readFileSync(path.join(hostProjects, 'host-session.jsonl'), 'utf8'), 'HOST-DATA');
    }
  } finally {
    fse.removeSync(root);
  }
});

test('an empty leftover projects directory is dropped and linked (no data to lose)', () => {
  const { root, hostHomeDir, service } = createTree();
  try {
    const provider = 'workbuddycn';
    const projection = projectionDir(root, provider);
    const configDir = configDirOf(projection, provider);
    const projectionProjects = path.join(configDir, 'projects');
    const hostProjects = path.join(hostHomeDir, CONFIG_DIR_BY_PROVIDER[provider], 'projects');
    nodeFs.mkdirSync(projectionProjects, { recursive: true }); // 空的
    nodeFs.mkdirSync(hostProjects, { recursive: true });
    nodeFs.writeFileSync(path.join(hostProjects, 'host-session.jsonl'), 'HOST-DATA');

    const summary = service.ensureSessionStoreLinks(provider, 'acct_x', { projectionRoot: projection });

    assert.equal(summary.migrated, 1, '空目录可安全丢弃');
    assert.ok(isLink(projectionProjects));
    // 宿主内容没有被投影的"空"覆盖，也没有多出文件。
    assert.deepEqual(readDirNames(hostProjects), ['host-session.jsonl']);
    assert.equal(nodeFs.readFileSync(path.join(hostProjects, 'host-session.jsonl'), 'utf8'), 'HOST-DATA');
  } finally {
    fse.removeSync(root);
  }
});

// --- 5. 读的仍是同一份宿主地区存储（与账号无关） ---------------------------

test('the sandbox link resolves to the same physical store every account shares', () => {
  const { root, hostHomeDir, service } = createTree();
  try {
    const provider = 'codebuddycn';
    const hostProjects = path.join(hostHomeDir, CONFIG_DIR_BY_PROVIDER[provider], 'projects');
    nodeFs.mkdirSync(hostProjects, { recursive: true });
    nodeFs.writeFileSync(path.join(hostProjects, 'region-session.jsonl'), 'REGION');

    const targets = ['acct_a', 'acct_b'].map((accountRef) => {
      const projection = projectionDir(root, provider, accountRef);
      nodeFs.mkdirSync(configDirOf(projection, provider), { recursive: true });
      service.ensureSessionStoreLinks(provider, accountRef, { projectionRoot: projection });
      return nodeFs.realpathSync(path.join(configDirOf(projection, provider), 'projects'));
    });

    // 两个账号的 projects 指向**同一个**物理目录：切换账号不改动会话数据。
    assert.equal(targets[0], targets[1]);
    assert.equal(targets[0], nodeFs.realpathSync(hostProjects));
    // 通过任一账号的链接读到的都是地区存储的内容。
    assert.deepEqual(readDirNames(path.join(projectionDir(root, provider, 'acct_b'), CONFIG_DIR_BY_PROVIDER[provider], 'projects')), ['region-session.jsonl']);
  } finally {
    fse.removeSync(root);
  }
});
