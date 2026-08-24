'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let createManagedToolJobManager;
try {
  ({ createManagedToolJobManager } = require('../lib/server/managed-tool-job-manager'));
} catch (_error) {}

let frpcReleaseRunner = {};
try {
  frpcReleaseRunner = require('../lib/cli/services/toolkit/tool-lifecycle/frpc-release-runner');
} catch (_error) {}
const { normalizeExternalFrpcPath } = require('../lib/cli/services/toolkit/tool-lifecycle/shared');
const {
  listManagedTools,
  planManagedToolAction
} = require('../lib/cli/services/toolkit/tool-manager');

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('condition_timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('网络接入生命周期任务复用统一任务中心并在状态探测后完成', async () => {
  assert.equal(typeof createManagedToolJobManager, 'function');
  const published = [];
  const registered = [];
  let installed = false;
  const manager = createManagedToolJobManager({
    platform: 'linux',
    taskHub: {
      registerSource(source, listActiveJobs) {
        registered.push({ source, listActiveJobs });
      },
      publish(task) {
        published.push(task);
      }
    },
    planAction(input) {
      return {
        ok: true,
        platform: 'linux',
        action: input.action,
        label: '安装 frpc',
        tool: { id: 'frpc', name: 'frpc' },
        plans: [{ id: 'frpc-install', label: '安装 frpc', command: 'noop', args: [], env: {} }]
      };
    },
    async runPlan() {
      installed = true;
      return { ok: true };
    },
    probeTool() {
      return { installed, executablePath: '/home/tester/.local/bin/frpc', version: '0.71.0' };
    }
  });

  const started = manager.start({ toolId: 'frpc', action: 'install', confirmed: true });
  assert.equal(started.ok, true);
  assert.equal(started.job.source, 'managed-tool');
  assert.equal(started.job.kind, 'managed-tool');
  assert.equal(started.job.appId, 'frpc');

  const duplicate = manager.start({ toolId: 'frpc', action: 'install', confirmed: true });
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.job.id, started.job.id);

  await waitFor(() => manager.getJob(started.job.id)?.status === 'succeeded');
  const completed = manager.getJob(started.job.id);
  assert.equal(completed.result.installed, true);
  assert.equal(completed.result.executablePath, '/home/tester/.local/bin/frpc');
  assert.deepEqual(registered.map((item) => item.source), ['managed-tool']);
  assert.ok(published.some((task) => task.status === 'queued'));
  assert.ok(published.some((task) => task.status === 'succeeded'));
});

test('frpc 受管路径不依赖 Server PATH 也能回流为已安装状态', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frpc-managed-probe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executablePath = path.join(home, '.local', 'bin', 'frpc');
  const externalPath = path.join(home, 'external', 'frpc');
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(path.dirname(externalPath), { recursive: true });
  fs.writeFileSync(executablePath, 'managed-frpc');
  fs.writeFileSync(externalPath, 'external-frpc');

  const frpc = listManagedTools({
    platform: 'linux',
    hostHomeDir: home,
    processObj: { platform: 'linux', arch: 'x64', env: { HOME: home, PATH: '' } },
    resolveCommandPath: () => externalPath,
    spawnSync: () => ({ status: 0, stdout: '0.71.0\n', stderr: '' }),
    processEntries: [],
    startupEntries: []
  }).tools.find((tool) => tool.id === 'frpc');

  assert.equal(frpc.installed, true);
  assert.equal(frpc.executablePath, executablePath);
  assert.equal(frpc.managedBy, 'aih');
  assert.equal(frpc.canUpdate, true);
});

test('外部 frpc 仍提供更新接管和精确路径卸载计划', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frpc-external-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const externalPath = path.join(home, 'external', 'frpc');
  fs.mkdirSync(path.dirname(externalPath), { recursive: true });
  fs.writeFileSync(externalPath, 'external-frpc');
  const options = {
    platform: 'linux',
    hostHomeDir: home,
    processObj: { platform: 'linux', arch: 'x64', env: { HOME: home, PATH: '' }, execPath: process.execPath },
    resolveCommandPath: () => externalPath,
    spawnSync: () => ({ status: 0, stdout: '0.70.0\n', stderr: '' }),
    processEntries: [],
    startupEntries: []
  };

  const frpc = listManagedTools(options).tools.find((tool) => tool.id === 'frpc');
  assert.equal(frpc.managedBy, 'external');
  assert.equal(frpc.canUpdate, true);
  assert.equal(frpc.canUninstall, true);

  const update = planManagedToolAction({ toolId: 'frpc', action: 'update' }, options);
  assert.equal(update.ok, true);
  assert.ok(update.plans.some((plan) => plan.id === 'frpc_update_official_release'));

  const uninstall = planManagedToolAction({ toolId: 'frpc', action: 'uninstall' }, options);
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.plans.length, 1);
  assert.equal(uninstall.plans[0].id, 'frpc_uninstall_external_path');
  assert.deepEqual(uninstall.plans[0].args.slice(-2), ['--target', externalPath]);
});

test('macOS frpc 卸载先尝试 Homebrew，状态未清除时回退精确路径', async () => {
  const executablePath = '/usr/local/bin/frpc';
  const options = {
    platform: 'macos',
    hostHomeDir: '/Users/tester',
    processObj: {
      platform: 'darwin',
      arch: 'arm64',
      env: { HOME: '/Users/tester', PATH: '' },
      execPath: process.execPath
    },
    resolveCommandPath(command) {
      if (command === 'frpc') return executablePath;
      if (command === 'brew') return '/opt/homebrew/bin/brew';
      return '';
    },
    spawnSync: () => ({ status: 0, stdout: '0.70.0\n', stderr: '' }),
    processEntries: [],
    startupEntries: []
  };

  const frpc = listManagedTools(options).tools.find((tool) => tool.id === 'frpc');
  assert.equal(frpc.managedBy, 'homebrew');

  const planned = planManagedToolAction({ toolId: 'frpc', action: 'uninstall' }, options);
  assert.equal(planned.ok, true);
  assert.deepEqual(
    planned.plans.map((plan) => plan.id),
    ['frpc_uninstall_homebrew', 'frpc_uninstall_external_path']
  );
  assert.deepEqual(planned.plans[1].args.slice(-2), ['--target', executablePath]);

  async function executeScenario(homebrewRemovesTarget) {
    let installed = true;
    const executed = [];
    const manager = createManagedToolJobManager({
      platform: 'darwin',
      taskHub: { registerSource() {}, publish() {} },
      planAction: () => planned,
      async runPlan(plan) {
        executed.push(plan.id);
        if (plan.id === 'frpc_uninstall_homebrew' && homebrewRemovesTarget) installed = false;
        if (plan.id === 'frpc_uninstall_external_path') installed = false;
        return { ok: true };
      },
      probeTool() {
        return { installed, executablePath: installed ? executablePath : '', version: installed ? '0.70.0' : '' };
      }
    });
    const started = manager.start({ toolId: 'frpc', action: 'uninstall', confirmed: true });
    await waitFor(() => ['succeeded', 'failed'].includes(manager.getJob(started.job.id)?.status));
    return { executed, job: manager.getJob(started.job.id) };
  }

  const homebrewSucceeded = await executeScenario(true);
  assert.equal(homebrewSucceeded.job.status, 'succeeded');
  assert.deepEqual(homebrewSucceeded.executed, ['frpc_uninstall_homebrew']);

  const fallbackRequired = await executeScenario(false);
  assert.equal(fallbackRequired.job.status, 'succeeded');
  assert.deepEqual(fallbackRequired.executed, ['frpc_uninstall_homebrew', 'frpc_uninstall_external_path']);
});

test('未知 CPU 架构只阻止发行包安装更新，不得阻止现有 frpc 卸载', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frpc-uninstall-unknown-arch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const externalPath = path.join(home, 'external', 'frpc');
  fs.mkdirSync(path.dirname(externalPath), { recursive: true });
  fs.writeFileSync(externalPath, 'external-frpc');
  const options = {
    platform: 'linux',
    hostHomeDir: home,
    processObj: { platform: 'linux', arch: 'riscv64', env: { HOME: home, PATH: '' }, execPath: process.execPath },
    resolveCommandPath: () => externalPath,
    spawnSync: () => ({ status: 0, stdout: '0.70.0\n', stderr: '' }),
    processEntries: [],
    startupEntries: []
  };

  const frpc = listManagedTools(options).tools.find((tool) => tool.id === 'frpc');
  assert.equal(frpc.canUpdate, false);
  assert.equal(frpc.canUninstall, true);

  const uninstall = planManagedToolAction({ toolId: 'frpc', action: 'uninstall' }, options);
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.plans[0].id, 'frpc_uninstall_external_path');

  const update = planManagedToolAction({ toolId: 'frpc', action: 'update' }, options);
  assert.equal(update.ok, false);
  assert.equal(update.error, 'unsupported_architecture');
});

test('frpc 外部卸载目标按三平台路径语义校验', () => {
  assert.equal(
    normalizeExternalFrpcPath('/Users/test/bin/frpc', { platform: 'macos' }),
    '/Users/test/bin/frpc'
  );
  assert.equal(
    normalizeExternalFrpcPath('/home/test/bin/frpc', { platform: 'linux' }),
    '/home/test/bin/frpc'
  );
  assert.equal(
    normalizeExternalFrpcPath('C:\\Tools\\frpc.exe', { platform: 'windows' }),
    'C:\\Tools\\frpc.exe'
  );
  assert.equal(normalizeExternalFrpcPath('/frpc', { platform: 'linux' }), '/frpc');
  assert.equal(normalizeExternalFrpcPath('C:\\frpc.exe', { platform: 'windows' }), 'C:\\frpc.exe');
  assert.equal(normalizeExternalFrpcPath('/home/test/bin/helper', { platform: 'linux' }), '');
});

test('根目录下的精确 frpc 文件仍提供卸载计划，不返回安装方式兜底', () => {
  const options = {
    platform: 'linux',
    hostHomeDir: '/home/tester',
    processObj: { platform: 'linux', arch: 'x64', env: { HOME: '/home/tester', PATH: '' }, execPath: process.execPath },
    resolveCommandPath: (command) => command === 'frpc' ? '/frpc' : '',
    spawnSync: () => ({ status: 0, stdout: '0.70.0\n', stderr: '' }),
    processEntries: [],
    startupEntries: []
  };

  const frpc = listManagedTools(options).tools.find((tool) => tool.id === 'frpc');
  assert.equal(frpc.managedBy, 'external');
  assert.equal(frpc.canUninstall, true);

  const uninstall = planManagedToolAction({ toolId: 'frpc', action: 'uninstall' }, options);
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.plans[0].id, 'frpc_uninstall_external_path');
  assert.deepEqual(uninstall.plans[0].args.slice(-2), ['--target', '/frpc']);

  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, '../lib/cli/services/toolkit/tool-lifecycle/index.js'),
    'utf8'
  );
  assert.doesNotMatch(lifecycleSource, /安装不属于/);
  assert.doesNotMatch(lifecycleSource, /不能由本页面(?:更新|卸载)/);
});

function response(body, statusCode = 200) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    statusCode,
    body: {
      async arrayBuffer() {
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      }
    }
  };
}

test('frpc 官方发布安装器按平台选择资产并校验 SHA256 后原子发布', async (t) => {
  assert.equal(typeof frpcReleaseRunner.executeFrpcReleaseAction, 'function');
  assert.equal(typeof frpcReleaseRunner.resolveAssetSpec, 'function');
  assert.equal(typeof frpcReleaseRunner.parseChecksum, 'function');

  assert.equal(frpcReleaseRunner.resolveAssetSpec('darwin', 'arm64', '0.71.0').assetName, 'frp_0.71.0_darwin_arm64.tar.gz');
  assert.equal(frpcReleaseRunner.resolveAssetSpec('linux', 'amd64', '0.71.0').assetName, 'frp_0.71.0_linux_amd64.tar.gz');
  assert.equal(frpcReleaseRunner.resolveAssetSpec('win32', 'amd64', '0.71.0').assetName, 'frp_0.71.0_windows_amd64.zip');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frpc-release-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const archive = Buffer.from('verified-frpc-archive');
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  const assetName = 'frp_0.71.0_linux_amd64.tar.gz';
  const assetUrl = `https://github.com/fatedier/frp/releases/download/v0.71.0/${assetName}`;
  const checksumUrl = 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_sha256_checksums.txt';
  const requests = [];
  const release = {
    tag_name: 'v0.71.0',
    assets: [
      { name: assetName, browser_download_url: assetUrl },
      { name: 'frp_sha256_checksums.txt', browser_download_url: checksumUrl }
    ]
  };

  const result = await frpcReleaseRunner.executeFrpcReleaseAction('install', {
    confirmed: true,
    platform: 'linux',
    arch: 'x64',
    hostHomeDir: home,
    requestImpl: async (url) => {
      requests.push(url);
      if (url === frpcReleaseRunner.RELEASE_API_URL) return response(JSON.stringify(release));
      if (url === checksumUrl) return response(`${digest}  ${assetName}\n`);
      if (url === assetUrl) return response(archive);
      return response('', 404);
    },
    extractArchive: async (received, spec) => {
      assert.deepEqual(received, archive);
      assert.equal(spec.assetName, assetName);
      return Buffer.from('frpc-binary');
    },
    verifyBinary: () => true
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, '0.71.0');
  assert.equal(result.executablePath, path.join(home, '.local', 'bin', 'frpc'));
  assert.equal(fs.readFileSync(result.executablePath, 'utf8'), 'frpc-binary');
  assert.deepEqual(requests, [frpcReleaseRunner.RELEASE_API_URL, checksumUrl, assetUrl]);
});

test('frpc 安装器在校验失败时保留旧版本，卸载只移除 AIH 受管目标', async (t) => {
  assert.equal(typeof frpcReleaseRunner.executeFrpcReleaseAction, 'function');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frpc-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const managed = path.join(home, '.local', 'bin', 'frpc');
  const external = path.join(home, 'external', 'frpc');
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(managed, 'old-version');
  fs.writeFileSync(external, 'external-version');

  const assetName = 'frp_0.71.0_linux_amd64.tar.gz';
  const assetUrl = `https://github.com/fatedier/frp/releases/download/v0.71.0/${assetName}`;
  const checksumUrl = 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_sha256_checksums.txt';
  const release = {
    tag_name: 'v0.71.0',
    assets: [
      { name: assetName, browser_download_url: assetUrl },
      { name: 'frp_sha256_checksums.txt', browser_download_url: checksumUrl }
    ]
  };
  const failed = await frpcReleaseRunner.executeFrpcReleaseAction('update', {
    confirmed: true,
    platform: 'linux',
    arch: 'x64',
    hostHomeDir: home,
    requestImpl: async (url) => {
      if (url === frpcReleaseRunner.RELEASE_API_URL) return response(JSON.stringify(release));
      if (url === checksumUrl) return response(`${'0'.repeat(64)}  ${assetName}\n`);
      return response(Buffer.from('changed-archive'));
    },
    extractArchive: async () => Buffer.from('new-version'),
    verifyBinary: () => true
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'frpc_release_digest_mismatch');
  assert.equal(fs.readFileSync(managed, 'utf8'), 'old-version');

  const removed = await frpcReleaseRunner.executeFrpcReleaseAction('uninstall', {
    confirmed: true,
    platform: 'linux',
    arch: 'x64',
    hostHomeDir: home
  });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external-version');
});

test('frpc 外部卸载只移除确认的精确可执行文件', async (t) => {
  assert.equal(typeof frpcReleaseRunner.executeFrpcReleaseAction, 'function');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-frpc-external-remove-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const managed = path.join(home, '.local', 'bin', 'frpc');
  const external = path.join(home, 'external', 'frpc');
  const unrelated = path.join(home, 'external', 'helper');
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(managed, 'managed-version');
  fs.writeFileSync(external, 'external-version');
  fs.writeFileSync(unrelated, 'keep-me');

  const rejected = await frpcReleaseRunner.executeFrpcReleaseAction('uninstall', {
    confirmed: true,
    platform: 'linux',
    arch: 'x64',
    hostHomeDir: home,
    targetPath: unrelated
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'frpc_uninstall_target_unsafe');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep-me');

  const removed = await frpcReleaseRunner.executeFrpcReleaseAction('uninstall', {
    confirmed: true,
    platform: 'linux',
    arch: 'x64',
    hostHomeDir: home,
    targetPath: external
  });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(external), false);
  assert.equal(fs.readFileSync(managed, 'utf8'), 'managed-version');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep-me');
});
