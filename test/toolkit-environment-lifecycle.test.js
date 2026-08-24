'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listEnvironmentTools } = require('../lib/cli/services/toolkit/environment/catalog');
const { buildEnvironmentGuide } = require('../lib/cli/services/toolkit/environment/guide-builder');
const { resolveEnvironmentToolPlans } = require('../lib/cli/services/toolkit/environment/lifecycle');
const { createEnvironmentToolJobManager } = require('../lib/server/environment-tool-job-manager');
const {
  encodeManifest,
  decodeManifest,
  normalizeManifest,
  removeManagedPaths
} = require('../lib/runtime/managed-path-cleaner');

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('condition_timeout'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('运行环境目录按平台提供完整安装、更新和卸载计划', () => {
  for (const platform of ['macos', 'windows', 'linux']) {
    const tools = listEnvironmentTools(platform);
    assert.ok(tools.length > 0);
    assert.equal(platform === 'windows' && tools.some((tool) => tool.id === 'nvm'), false);
    assert.equal(platform === 'windows' && tools.some((tool) => tool.id === 'pyenv'), false);

    for (const tool of tools) {
      for (const action of ['install', 'update', 'uninstall']) {
        const result = resolveEnvironmentToolPlans(tool.id, action, {
          platform,
          hostHomeDir: platform === 'windows' ? 'C:\\Users\\tester' : '/home/tester',
          processObj: {
            platform: platform === 'macos' ? 'darwin' : platform === 'windows' ? 'win32' : 'linux',
            env: {}
          }
        });
        assert.equal(result.ok, true, `${platform}/${tool.id}/${action}: ${result.message || result.error || ''}`);
        assert.ok(result.plans.length > 0);
        assert.ok(result.plans.every((plan) => plan.requiresConfirmation));
      }
    }
  }
});

test('生命周期契约错误不再向用户提供缺少卸载计划的兜底文案', () => {
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, '../lib/cli/services/toolkit/environment/lifecycle.js'),
    'utf8'
  );
  const appJobSource = fs.readFileSync(
    path.join(__dirname, '../lib/server/app-install-job-manager.js'),
    'utf8'
  );

  for (const source of [lifecycleSource, appJobSource]) {
    assert.doesNotMatch(source, /没有可用的(?:安装|更新|卸载)计划/);
    assert.doesNotMatch(source, /没有(?:安装|更新|卸载)计划/);
  }
});

function guideTemplates(guide) {
  return guide.tools.flatMap((tool) => tool.tasks.map((task) => String(task.template)));
}

test('安装指南按目标平台隔离主目录占位符，默认当前平台', () => {
  const cases = [
    {
      target: 'macos',
      current: 'linux',
      currentHome: '/home/tester',
      expectedHome: '/Users/<user>',
      rejectedHomes: ['/home/<user>', 'C:\\Users\\<user>']
    },
    {
      target: 'windows',
      current: 'darwin',
      currentHome: '/Users/tester',
      expectedHome: 'C:\\Users\\<user>',
      rejectedHomes: ['/Users/<user>', '/home/<user>']
    },
    {
      target: 'linux',
      current: 'win32',
      currentHome: 'C:\\Users\\tester',
      expectedHome: '/home/<user>',
      rejectedHomes: ['/Users/<user>', 'C:\\Users\\<user>']
    }
  ];

  for (const scenario of cases) {
    const guide = buildEnvironmentGuide({
      guidePlatform: scenario.target,
      hostHomeDir: scenario.currentHome,
      processObj: { platform: scenario.current, env: {} }
    });
    const templates = guideTemplates(guide);
    assert.equal(guide.platform, scenario.target);
    assert.ok(
      templates.some((template) => template.includes(scenario.expectedHome)),
      `${scenario.target} 指南应使用 ${scenario.expectedHome}`
    );
    for (const rejectedHome of scenario.rejectedHomes) {
      assert.ok(
        templates.every((template) => !template.includes(rejectedHome)),
        `${scenario.target} 指南不应包含 ${rejectedHome}`
      );
    }
    assert.ok(
      templates.every((template) => !template.includes(scenario.currentHome)),
      `${scenario.target} 指南不应泄漏当前 ${scenario.current} 主机路径 ${scenario.currentHome}`
    );
    assert.ok(
      templates.every((template) => !template.includes('managed-path-cleaner.js')),
      `${scenario.target} 指南不应依赖生成指南主机上的 AIH 清理脚本路径`
    );
  }

  const windows = buildEnvironmentGuide({
    guidePlatform: 'windows',
    hostHomeDir: '/Users/tester',
    processObj: { platform: 'darwin', env: {} }
  });
  assert.equal(windows.tools.some((tool) => tool.id === 'nvm'), false);
  assert.equal(windows.tools.some((tool) => tool.id === 'pyenv'), false);

  const current = buildEnvironmentGuide({
    hostHomeDir: '/Users/tester',
    processObj: { platform: 'darwin', env: {} }
  });
  assert.equal(current.platform, 'macos');
  assert.equal(current.tools.some((tool) => tool.id === 'nvm'), true);
});

test('安装指南生命周期命令复用各平台实际执行计划', () => {
  const cases = [
    { platform: 'macos', processPlatform: 'darwin', hostHomeDir: '/Users/tester' },
    { platform: 'windows', processPlatform: 'win32', hostHomeDir: 'C:\\Users\\tester' },
    { platform: 'linux', processPlatform: 'linux', hostHomeDir: '/home/tester' }
  ];

  for (const scenario of cases) {
    const options = {
      guidePlatform: scenario.platform,
      platform: scenario.platform,
      hostHomeDir: scenario.hostHomeDir,
      processObj: { platform: scenario.processPlatform, env: {} }
    };
    const guide = buildEnvironmentGuide(options);

    for (const tool of listEnvironmentTools(scenario.platform)) {
      const guideTool = guide.tools.find((item) => item.id === tool.id);
      assert.ok(guideTool, `${scenario.platform}/${tool.id} 缺少指南条目`);
      for (const action of ['install', 'update', 'uninstall']) {
        const resolved = resolveEnvironmentToolPlans(tool.id, action, options);
        assert.equal(resolved.ok, true, `${scenario.platform}/${tool.id}/${action} 计划不可用`);
        const preferred = resolved.plans.find((plan) => plan.method !== 'AIH 清理器') || resolved.plans[0];
        const guideTask = guideTool.tasks.find((task) => task.id === `${tool.id}:lifecycle:${action}`);
        assert.ok(guideTask, `${scenario.platform}/${tool.id}/${action} 缺少指南命令`);
        assert.equal(guideTask.template, preferred.preview);
        assert.equal(guideTask.method, preferred.method);
      }
    }
  }
});

test('运行环境任务异步发布到共享任务队列并在探测通过后完成', async () => {
  const published = [];
  const registered = [];
  let installed = false;
  const manager = createEnvironmentToolJobManager({
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
        label: '安装 FNM',
        tool: { id: 'fnm', name: 'FNM' },
        plans: [{ id: 'fnm-install', label: '安装 FNM', command: 'noop', args: [], env: {} }]
      };
    },
    async runPlan() {
      installed = true;
      return { ok: true };
    },
    probeTool() {
      return { installed, executablePath: '/home/tester/.local/bin/fnm', version: '1.38.1' };
    }
  });

  const started = manager.start({ toolId: 'fnm', action: 'install', confirmed: true });
  assert.equal(started.ok, true);
  assert.equal(started.job.source, 'environment');
  await waitFor(() => manager.getJob(started.job.id)?.status === 'succeeded');

  const job = manager.getJob(started.job.id);
  assert.equal(job.result.installed, true);
  assert.equal(job.result.executablePath, '/home/tester/.local/bin/fnm');
  assert.deepEqual(registered.map((item) => item.source), ['environment']);
  assert.ok(published.some((task) => task.status === 'queued'));
  assert.ok(published.some((task) => task.status === 'succeeded'));
});

test('受管路径清理器拒绝根目录并只移除声明目标', (t) => {
  assert.throws(() => normalizeManifest({ trees: ['/'] }), /managed_cleanup_unsafe_target/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-managed-cleaner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'shim');
  const tree = path.join(root, 'runtime');
  const kept = path.join(root, 'keep');
  fs.writeFileSync(file, 'shim', 'utf8');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'binary'), 'binary', 'utf8');
  fs.writeFileSync(kept, 'keep', 'utf8');

  const encoded = encodeManifest({ files: [file], trees: [tree] });
  assert.deepEqual(decodeManifest(encoded), {
    files: [path.resolve(file)],
    trees: [path.resolve(tree)]
  });
  const result = removeManagedPaths(decodeManifest(encoded));
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(tree), false);
  assert.equal(fs.existsSync(kept), true);
});
