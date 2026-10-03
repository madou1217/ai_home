'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createDetachedProcessSupervisor } = require('../lib/cli/services/toolkit/service-control/detached-process-supervisor');
const { createServiceStateStore } = require('../lib/cli/services/toolkit/service-control/service-state-store');
const { clearHomebrewStatusCache, createHomebrewServicesBackend } = require('../lib/cli/services/toolkit/service-control/homebrew-services-backend');
const { resolveServiceBackend } = require('../lib/cli/services/toolkit/service-control');
const { createAihSupervisorBackend, resetSupervisorsForTest } = require('../lib/cli/services/toolkit/service-control/aih-supervisor-backend');
const { parseServicePath } = require('../lib/server/webui-tool-service-routes');
const frpcPlugin = require('../lib/cli/services/toolkit/tool-plugins/frpc');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-service-control-'));
}

function createFakeProcessWorld() {
  const alive = new Set();
  const children = new Map();
  let nextPid = 1000;
  return {
    alive,
    spawnCalls: [],
    spawn(command, args, spawnOptions) {
      const child = new EventEmitter();
      child.pid = nextPid++;
      child.unref = () => {};
      alive.add(child.pid);
      children.set(child.pid, child);
      this.spawnCalls.push({ command, args, options: spawnOptions });
      return child;
    },
    crash(pid, code = 1) {
      alive.delete(pid);
      children.get(pid).emit('exit', code, null);
    },
    isAlive: (pid) => alive.has(pid),
    kill(pid) {
      alive.delete(pid);
      const child = children.get(pid);
      if (child) child.emit('exit', null, 'SIGTERM');
      return true;
    }
  };
}

function createManualTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    flush() {
      const due = pending.splice(0).filter((timer) => !timer.cleared);
      due.forEach((timer) => timer.fn());
      return due;
    }
  };
}

test('detached supervisor 以 detached 方式启动、异常退出按退避自动重启、停止后不再拉起', async () => {
  const home = tempHome();
  const world = createFakeProcessWorld();
  const timers = createManualTimers();
  let clock = 0;
  const store = createServiceStateStore({ aiHomeDir: home, serviceId: 'frpc' });
  const supervisor = createDetachedProcessSupervisor({
    stateStore: store,
    logFile: path.join(home, 'logs', 'frpc.log'),
    spawn: world.spawn.bind(world),
    isAlive: world.isAlive,
    kill: world.kill,
    now: () => clock,
    ...timers
  });

  const started = supervisor.start({ command: '/bin/frpc', args: ['-c', '/cfg/frpc.toml'], cwd: '/cfg' });
  assert.equal(started.ok, true);
  assert.equal(world.spawnCalls[0].options.detached, true);
  assert.equal(store.read().desired, 'running');
  assert.equal(store.read().pid, started.pid);

  clock = 500;
  world.crash(started.pid);
  assert.equal(supervisor.status().phase, 'backoff');
  assert.equal(timers.pending[0].ms, 2000, '短时间内崩溃应进入下一档退避');
  timers.flush();
  assert.equal(world.spawnCalls.length, 2);
  const status = supervisor.status();
  assert.equal(status.phase, 'running');
  assert.equal(status.restarts, 1);

  await supervisor.stop();
  assert.equal(store.read().desired, 'stopped');
  assert.equal(supervisor.status().phase, 'stopped');
  assert.equal(timers.pending.filter((timer) => !timer.cleared && timer.ms >= 1000).length, 0);
});

test('detached supervisor 关闭自动重启后崩溃即停止；AIH 重启后接管存活进程或按随 AIH 启动恢复', () => {
  const home = tempHome();
  const world = createFakeProcessWorld();
  const timers = createManualTimers();
  const store = createServiceStateStore({ aiHomeDir: home, serviceId: 'frpc' });
  const make = () => createDetachedProcessSupervisor({
    stateStore: store,
    spawn: world.spawn.bind(world),
    isAlive: world.isAlive,
    kill: world.kill,
    ...timers
  });

  const first = make();
  first.updateSettings({ autoRestart: false });
  const started = first.start({ command: '/bin/frpc', args: [] });
  world.crash(started.pid);
  assert.equal(first.status().phase, 'stopped');
  assert.equal(timers.pending.length, 0);

  first.updateSettings({ autoRestart: true });
  const again = first.start({ command: '/bin/frpc', args: [] });
  first.dispose();

  const adopted = make().adopt();
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.pid, again.pid);

  world.alive.delete(again.pid);
  const restored = make().adopt();
  assert.equal(restored.restored, true);
  assert.notEqual(restored.pid, again.pid);
});

test('detached supervisor 不接管、不终止被系统复用给其它程序的 PID', async () => {
  const home = tempHome();
  const world = createFakeProcessWorld();
  const timers = createManualTimers();
  const store = createServiceStateStore({ aiHomeDir: home, serviceId: 'frpc' });
  store.write({ desired: 'running', autoStart: false, pid: 4242, configPath: '/cfg/frpc.toml', launch: { command: '/bin/frpc', args: [] } });
  world.alive.add(4242);
  const killed = [];
  const supervisor = createDetachedProcessSupervisor({
    stateStore: store,
    spawn: world.spawn.bind(world),
    isAlive: world.isAlive,
    isOwnedProcess: () => false,
    kill: (pid) => { killed.push(pid); return true; },
    ...timers
  });
  const adopted = supervisor.adopt();
  assert.equal(adopted.adopted, false);
  assert.equal(store.read().pid, 0);
  store.write({ pid: 4242 });
  await supervisor.stop();
  assert.deepEqual(killed, []);
  assert.equal(world.alive.has(4242), true);
});

test('Homebrew 后端读取 brew services 状态并通过 brew services 控制', async () => {
  clearHomebrewStatusCache();
  const calls = [];
  const backend = createHomebrewServicesBackend({ formula: 'frpc', label: 'frpc' }, {
    brewPath: '/opt/homebrew/bin/brew',
    spawnSync(command, args) {
      calls.push([command, ...args].join(' '));
      return {
        status: 0,
        stdout: JSON.stringify([{ name: 'frpc', running: true, loaded: true, registered: true, pid: 2431, log_path: '/var/log/frpc.log' }])
      };
    },
    async runPlan(plan) {
      calls.push([plan.command, ...plan.args].join(' '));
      return { ok: true, stdout: 'Successfully stopped `frpc`' };
    }
  });
  const status = backend.describe();
  assert.equal(status.backend, 'homebrew');
  assert.equal(status.state, 'running');
  assert.equal(status.pid, 2431);
  assert.equal(status.settingsEditable, false);
  assert.equal(status.canRestart, true);
  const result = await backend.control('stop');
  assert.equal(result.ok, true);
  assert.ok(calls.includes('/opt/homebrew/bin/brew services stop frpc'));
  assert.deepEqual(backend.logFiles(), ['/var/log/frpc.log']);
});

test('Homebrew 状态缓存跨后端实例共享，避免每次清单刷新都同步调用 brew', () => {
  clearHomebrewStatusCache();
  let infoCalls = 0;
  const make = () => createHomebrewServicesBackend({ formula: 'frpc', label: 'frpc' }, {
    brewPath: '/opt/homebrew/bin/brew',
    spawnSync() {
      infoCalls += 1;
      return { status: 0, stdout: '[{"name":"frpc","running":false,"loaded":false}]' };
    }
  });
  make().describe();
  make().describe();
  assert.equal(infoCalls, 1);
  clearHomebrewStatusCache();
});

test('后端选择：Homebrew 安装走 brew services，其余走 AIH 守护', () => {
  const home = tempHome();
  const brewBackend = resolveServiceBackend(frpcPlugin, { managedBy: 'homebrew' }, { brewPath: '/opt/homebrew/bin/brew', aiHomeDir: home });
  assert.equal(brewBackend.id, 'homebrew');
  const aihBackend = resolveServiceBackend(frpcPlugin, { managedBy: 'aih' }, { aiHomeDir: home });
  assert.equal(aihBackend.id, 'aih');
  assert.equal(resolveServiceBackend({ id: 'tmux' }, {}, {}), null);
});

test('AIH 守护后端：新建配置、冲突守卫拒绝与外部进程共用同一配置', async () => {
  resetSupervisorsForTest();
  const home = tempHome();
  const configPath = path.join(home, '.config', 'frp', 'frpc.toml');
  const tool = { id: 'frpc', installed: true, executablePath: '/usr/local/bin/frpc', resolvedConfigPath: '' };
  const backend = createAihSupervisorBackend({ ...frpcPlugin.service, id: 'frpc', name: 'frpc' }, {
    aiHomeDir: path.join(home, '.ai_home'),
    hostHomeDir: home,
    processEntries: [
      { pid: 76, name: 'zsh', executablePath: '/bin/zsh', commandLine: `/bin/zsh -c "frpc -c ${configPath}"` },
      { pid: 77, name: 'frpc', executablePath: '/usr/local/bin/frpc', commandLine: `/usr/local/bin/frpc -c ${configPath}` }
    ]
  });

  const before = backend.describe(tool);
  assert.equal(before.canCreateConfig, true);
  assert.equal(before.canStart, false);
  const missing = await backend.control('start', tool);
  assert.equal(missing.error, 'service_config_missing');

  const created = backend.createConfig(tool);
  assert.equal(created.ok, true);
  assert.match(fs.readFileSync(configPath, 'utf8'), /loginFailExit = false/);
  assert.equal(backend.createConfig(tool).error, 'service_config_exists');

  const conflict = await backend.control('start', tool);
  assert.equal(conflict.error, 'service_conflict_external_instance');
  assert.match(conflict.message, /pid 77/);
  resetSupervisorsForTest();
});

test('服务路由路径解析', () => {
  assert.deepEqual(parseServicePath('/v0/webui/toolkit/tools/frpc/service'), { toolId: 'frpc', sub: '' });
  assert.deepEqual(parseServicePath('/v0/webui/toolkit/tools/frpc/service/settings'), { toolId: 'frpc', sub: 'settings' });
  assert.deepEqual(parseServicePath('/v0/webui/toolkit/tools/frpc/service/logs'), { toolId: 'frpc', sub: 'logs' });
  assert.equal(parseServicePath('/v0/webui/toolkit/tools/frpc/config'), null);
});
