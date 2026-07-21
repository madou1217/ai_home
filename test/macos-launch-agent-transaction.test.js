'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createMacosLaunchAgent
} = require('../lib/cli/services/background/macos-launch-agent');

function makeFixture(spawnSync, buildLegacyServices = () => [], runtimeDeps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-macos-launch-agent-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.plist');
  const appPath = path.join(root, 'AI Home.app');
  const iconSourcePath = path.join(root, 'AIHome.icns');
  const launchServicesPath = path.join(root, 'lsregister');
  fs.writeFileSync(iconSourcePath, 'test-icon');
  fs.writeFileSync(launchServicesPath, 'test-launch-services');
  const legacyServices = buildLegacyServices(root);
  const agent = createMacosLaunchAgent({
    aiHomeDir,
    hostHomeDir: root,
    launchdPlist,
    appPath,
    iconSourcePath,
    launchServicesPath,
    resolveAihCommandPath: () => '/opt/homebrew/bin/aih',
    legacyServices
  }, {
    fs,
    path,
    spawnSync,
    processObj: {
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
      getuid: () => 501
    },
    ...runtimeDeps,
    ensureDir(directory) {
      fs.mkdirSync(directory, { recursive: true });
    }
  });
  return { root, launchdPlist, appPath, agent };
}

function launchctlResult(status, stderr = '') {
  return { status, stdout: '', stderr };
}

test('macOS launch agent uninstall preserves its plist when the loaded job cannot be stopped', (t) => {
  let launchdPlist = '';
  const calls = [];
  const fixture = makeFixture((command, args) => {
    calls.push({ command, args: args.slice() });
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') return launchctlResult(0);
    if (args[0] === 'bootout' || args[0] === 'unload') {
      return launchctlResult(1, 'operation not permitted');
    }
    return launchctlResult(0);
  });
  ({ launchdPlist } = fixture);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(launchdPlist), { recursive: true });
  fs.writeFileSync(launchdPlist, 'existing-supervisor-plist');
  let restoredState = 0;

  assert.throws(
    () => fixture.agent.uninstall({
      restoreState() {
        restoredState += 1;
      }
    }),
    { code: 'background_launchd_stop_failed' }
  );

  assert.equal(restoredState, 1);
  assert.equal(fs.readFileSync(launchdPlist, 'utf8'), 'existing-supervisor-plist');
  assert.equal(calls.some((call) => call.command === 'launchctl' && call.args[0] === 'unload'), true);
});

test('macOS launch agent stages an installed but unloaded plist without requiring bootout', (t) => {
  const calls = [];
  const fixture = makeFixture((command, args) => {
    calls.push({ command, args: args.slice() });
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') return launchctlResult(1, 'service not found');
    if (args[0] === 'bootout' || args[0] === 'unload') {
      return launchctlResult(1, 'service not found');
    }
    return launchctlResult(0);
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'unloaded-supervisor-plist');

  const status = fixture.agent.install();

  assert.equal(status.installed, true);
  assert.equal(calls.some((call) => (
    call.command === 'launchctl'
      && (call.args[0] === 'bootout' || call.args[0] === 'unload')
  )), false);
});

test('macOS launch agent identifies the job through the AI Home app without adding a resident process', (t) => {
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      return launchctlResult(1, 'service not found');
    }
    return launchctlResult(0);
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  fixture.agent.install();

  const executable = path.join(
    fixture.appPath,
    'Contents',
    'MacOS',
    'AIHomeBackground'
  );
  const plist = fs.readFileSync(fixture.launchdPlist, 'utf8');
  assert.match(
    plist,
    new RegExp(`${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/string>\\s+<string>\\/opt\\/homebrew\\/bin\\/aih`)
  );
  assert.equal(fs.readFileSync(executable, 'utf8'), '#!/bin/sh\nexec "$@"\n');
  assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
});

test('macOS launch agent waits for an old job to finish bootout before bootstrapping its replacement', (t) => {
  const events = [];
  let loaded = true;
  let terminatingPolls = 0;
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      if (terminatingPolls > 0) {
        terminatingPolls -= 1;
        events.push('query:terminating');
        return launchctlResult(0);
      }
      return loaded ? launchctlResult(0) : launchctlResult(1, 'service not found');
    }
    if (args[0] === 'bootout') {
      loaded = false;
      terminatingPolls = 2;
      events.push('bootout');
      return launchctlResult(0);
    }
    if (args[0] === 'bootstrap') {
      assert.equal(terminatingPolls, 0);
      loaded = true;
      events.push('bootstrap');
      return launchctlResult(0);
    }
    return launchctlResult(0);
  }, () => [], {
    sleepSync() {
      events.push('wait');
    }
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'existing-supervisor-plist');

  fixture.agent.install();

  assert.deepEqual(
    events.filter((event) => event !== 'query:terminating'),
    ['bootout', 'wait', 'wait', 'bootstrap']
  );
});

test('macOS launch agent fails closed when launchd never completes bootout', (t) => {
  let clock = 0;
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') return launchctlResult(0);
    if (args[0] === 'bootout') return launchctlResult(0);
    return launchctlResult(0);
  }, () => [], {
    now: () => clock,
    sleepSync(delayMs) {
      clock += delayMs;
    }
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'existing-supervisor-plist');

  assert.throws(
    () => fixture.agent.install(),
    { code: 'background_launchd_stop_timeout' }
  );
  assert.equal(fs.readFileSync(fixture.launchdPlist, 'utf8'), 'existing-supervisor-plist');
});

test('macOS launch agent does not treat a launchctl query timeout as an unloaded job', (t) => {
  const timeoutError = Object.assign(new Error('launchctl timed out'), { code: 'ETIMEDOUT' });
  const fixture = makeFixture((command, args) => {
    if (command === 'launchctl' && (args[0] === 'print' || args[0] === 'list')) {
      return {
        status: null,
        signal: 'SIGTERM',
        error: timeoutError,
        stdout: '',
        stderr: ''
      };
    }
    return launchctlResult(0);
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(
    () => fixture.agent.getStatus(),
    { code: 'background_launchd_status_failed' }
  );
});

test('macOS launch agent stopLoaded waits for the job to disappear', (t) => {
  const events = [];
  let loaded = true;
  let terminatingPolls = 0;
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      if (terminatingPolls > 0) {
        terminatingPolls -= 1;
        return launchctlResult(0);
      }
      return loaded ? launchctlResult(0) : launchctlResult(1, 'service not found');
    }
    if (args[0] === 'bootout') {
      loaded = false;
      terminatingPolls = 2;
      events.push('bootout');
      return launchctlResult(0);
    }
    return launchctlResult(0);
  }, () => [], {
    sleepSync() {
      events.push('wait');
    }
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const status = fixture.agent.stopLoaded();

  assert.equal(status.loaded, false);
  assert.deepEqual(events, ['bootout', 'wait', 'wait']);
});

test('macOS launch agent refuses to treat launchctl status errors as an unloaded job', (t) => {
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      return launchctlResult(1, 'Operation not permitted');
    }
    return launchctlResult(0);
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'existing-supervisor-plist');

  assert.throws(
    () => fixture.agent.getStatus(),
    { code: 'background_launchd_status_failed' }
  );
  assert.equal(fs.readFileSync(fixture.launchdPlist, 'utf8'), 'existing-supervisor-plist');
});

test('macOS launch agent treats icon registration failure as an install failure', (t) => {
  const fixture = makeFixture((command, args) => {
    if (command === path.join(fixture.root, 'lsregister')) {
      return launchctlResult(1, 'LaunchServices registration failed');
    }
    if (command === 'launchctl' && (args[0] === 'print' || args[0] === 'list')) {
      return launchctlResult(0);
    }
    return launchctlResult(0);
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'existing-supervisor-plist');
  let restoredState = 0;

  assert.throws(
    () => fixture.agent.install({
      restoreState() {
        restoredState += 1;
      }
    }),
    { code: 'background_supervisor_app_registration_failed' }
  );

  assert.equal(restoredState, 1);
  assert.equal(fs.readFileSync(fixture.launchdPlist, 'utf8'), 'existing-supervisor-plist');
});

test('macOS launch agent reconciles an indeterminate bootstrap without legacy fallback or ghost job', (t) => {
  let loaded = false;
  const calls = [];
  const timeoutError = Object.assign(new Error('bootstrap timed out'), { code: 'ETIMEDOUT' });
  const fixture = makeFixture((command, args) => {
    calls.push({ command, args: args.slice() });
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      return loaded ? launchctlResult(0) : launchctlResult(1, 'service not found');
    }
    if (args[0] === 'bootstrap') {
      loaded = true;
      return {
        status: null,
        signal: 'SIGTERM',
        error: timeoutError,
        stdout: '',
        stderr: ''
      };
    }
    if (args[0] === 'bootout') {
      loaded = false;
      return launchctlResult(0);
    }
    if (args[0] === 'load') {
      throw new Error('legacy load fallback must not run after an indeterminate bootstrap');
    }
    return launchctlResult(0);
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(
    () => fixture.agent.install(),
    { code: 'background_supervisor_bootstrap_failed' }
  );

  assert.equal(loaded, false);
  assert.equal(fs.existsSync(fixture.launchdPlist), false);
  assert.equal(calls.some((call) => call.command === 'launchctl' && call.args[0] === 'load'), false);
  assert.equal(calls.some((call) => call.command === 'launchctl' && call.args[0] === 'bootout'), true);
});

test('macOS launch agent rolls back a new supervisor when a legacy job has no cleanup plist', (t) => {
  const legacyLabel = 'com.clawdcodex.ai_home.node-relay.ghost';
  let supervisorLoaded = false;
  let fixture;
  let legacyFile = '';
  const calls = [];
  fixture = makeFixture((command, args) => {
    calls.push({ command, args: args.slice() });
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      const target = String(args[1] || '');
      if (target.endsWith(`/${legacyLabel}`) || target === legacyLabel) return launchctlResult(0);
      return supervisorLoaded ? launchctlResult(0) : launchctlResult(1);
    }
    if (args[0] === 'bootstrap' || args[0] === 'load') {
      supervisorLoaded = true;
      return launchctlResult(0);
    }
    if (args[0] === 'bootout') {
      supervisorLoaded = false;
      return launchctlResult(0);
    }
    return launchctlResult(0);
  }, (root) => {
    legacyFile = path.join(root, 'Library', 'LaunchAgents', `${legacyLabel}.plist`);
    return [{ label: legacyLabel, file: legacyFile }];
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let restoredState = 0;

  assert.throws(
    () => fixture.agent.install({
      restoreState() {
        restoredState += 1;
      }
    }),
    { code: 'background_legacy_service_plist_missing' }
  );

  assert.equal(restoredState, 1);
  assert.equal(fs.existsSync(fixture.launchdPlist), false);
  assert.equal(fs.existsSync(legacyFile), false);
  assert.equal(calls.some((call) => (
    call.command === 'launchctl'
      && call.args[0] === 'bootout'
      && call.args[1] === 'gui/501/com.clawdcodex.ai_home'
  )), true);
});

test('macOS launch agent rolls back stopped legacy jobs when a later legacy cleanup fails', (t) => {
  const events = [];
  const stoppedLabels = new Set();
  let legacyOne;
  let legacyTwo;
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      const label = String(args[1] || '').split('/').pop();
      return stoppedLabels.has(label)
        ? launchctlResult(1, 'service not found')
        : launchctlResult(0);
    }
    if (args[0] === 'bootout') {
      const target = String(args[1] || '');
      events.push(`stop:${target}`);
      if (target.endsWith(`/${legacyTwo.label}`)) return launchctlResult(1, 'legacy stop failed');
      stoppedLabels.add(target.split('/').pop());
      return launchctlResult(0);
    }
    if (args[0] === 'unload') {
      if (args[1] === legacyTwo.file) return launchctlResult(1, 'legacy unload failed');
      return launchctlResult(0);
    }
    if (args[0] === 'bootstrap' || args[0] === 'load') {
      const plistFile = args[0] === 'bootstrap' ? args[2] : args[1];
      const content = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, 'utf8') : '';
      if (content === 'existing-supervisor-plist') events.push('start:old-supervisor');
      else if (content === 'legacy-one-plist') events.push('start:legacy-one');
      else events.push('start:new-supervisor');
      stoppedLabels.delete(path.basename(plistFile, '.plist'));
      return launchctlResult(0);
    }
    return launchctlResult(0);
  }, (root) => {
    legacyOne = {
      label: 'com.clawdcodex.ai_home.node-relay.one',
      file: path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.node-relay.one.plist')
    };
    legacyTwo = {
      label: 'com.clawdcodex.ai_home.node-webrtc.two',
      file: path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.node-webrtc.two.plist')
    };
    return [legacyOne, legacyTwo];
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'existing-supervisor-plist');
  fs.writeFileSync(legacyOne.file, 'legacy-one-plist');
  fs.writeFileSync(legacyTwo.file, 'legacy-two-plist');

  assert.throws(
    () => fixture.agent.install({
      restoreState() {
        events.push('restore:state');
      }
    }),
    { code: 'background_legacy_service_stop_failed' }
  );

  assert.equal(fs.readFileSync(fixture.launchdPlist, 'utf8'), 'existing-supervisor-plist');
  assert.equal(fs.readFileSync(legacyOne.file, 'utf8'), 'legacy-one-plist');
  assert.equal(fs.readFileSync(legacyTwo.file, 'utf8'), 'legacy-two-plist');
  assert.ok(events.indexOf('restore:state') < events.indexOf('start:old-supervisor'));
  assert.ok(events.indexOf('start:old-supervisor') < events.indexOf('start:legacy-one'));
});

test('macOS launch agent exposes a failed rollback after restoring state first', (t) => {
  const events = [];
  let bootstrapAttempts = 0;
  let supervisorLoaded = true;
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      return supervisorLoaded
        ? launchctlResult(0)
        : launchctlResult(1, 'service not found');
    }
    if (args[0] === 'bootout' || args[0] === 'unload') {
      supervisorLoaded = false;
      return launchctlResult(0);
    }
    if (args[0] === 'bootstrap' || args[0] === 'load') {
      const plistFile = args[0] === 'bootstrap' ? args[2] : args[1];
      const content = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, 'utf8') : '';
      if (content === 'existing-supervisor-plist') events.push('start:old-supervisor');
      else events.push('start:new-supervisor');
      bootstrapAttempts += 1;
      return launchctlResult(1, bootstrapAttempts <= 2 ? 'new bootstrap failed' : 'rollback bootstrap failed');
    }
    return launchctlResult(0);
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'existing-supervisor-plist');

  assert.throws(
    () => fixture.agent.install({
      restoreState() {
        events.push('restore:state');
      }
    }),
    (error) => {
      assert.equal(error.code, 'background_supervisor_rollback_failed');
      assert.equal(error.cause && error.cause.code, 'background_supervisor_bootstrap_failed');
      assert.ok(Array.isArray(error.rollbackErrors));
      assert.ok(error.rollbackErrors.length > 0);
      return true;
    }
  );

  assert.equal(fs.readFileSync(fixture.launchdPlist, 'utf8'), 'existing-supervisor-plist');
  assert.ok(events.indexOf('restore:state') < events.indexOf('start:old-supervisor'));
});

test('macOS launch agent uninstall restores stopped legacy jobs when cleanup fails', (t) => {
  const events = [];
  const stoppedLabels = new Set();
  let legacyOne;
  let legacyTwo;
  const fixture = makeFixture((command, args) => {
    if (command !== 'launchctl') return launchctlResult(0);
    if (args[0] === 'print' || args[0] === 'list') {
      const label = String(args[1] || '').split('/').pop();
      return stoppedLabels.has(label)
        ? launchctlResult(1, 'service not found')
        : launchctlResult(0);
    }
    if (args[0] === 'bootout') {
      const target = String(args[1] || '');
      if (target.endsWith(`/${legacyTwo.label}`)) return launchctlResult(1, 'legacy stop failed');
      stoppedLabels.add(target.split('/').pop());
      return launchctlResult(0);
    }
    if (args[0] === 'unload') {
      if (args[1] === legacyTwo.file) return launchctlResult(1, 'legacy unload failed');
      return launchctlResult(0);
    }
    if (args[0] === 'bootstrap' || args[0] === 'load') {
      const plistFile = args[0] === 'bootstrap' ? args[2] : args[1];
      const content = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, 'utf8') : '';
      if (content === 'existing-supervisor-plist') events.push('start:old-supervisor');
      if (content === 'legacy-one-plist') events.push('start:legacy-one');
      stoppedLabels.delete(path.basename(plistFile, '.plist'));
      return launchctlResult(0);
    }
    return launchctlResult(0);
  }, (root) => {
    legacyOne = {
      label: 'com.clawdcodex.ai_home.node-relay.one',
      file: path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.node-relay.one.plist')
    };
    legacyTwo = {
      label: 'com.clawdcodex.ai_home.node-webrtc.two',
      file: path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.node-webrtc.two.plist')
    };
    return [legacyOne, legacyTwo];
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(fixture.launchdPlist), { recursive: true });
  fs.writeFileSync(fixture.launchdPlist, 'existing-supervisor-plist');
  fs.writeFileSync(legacyOne.file, 'legacy-one-plist');
  fs.writeFileSync(legacyTwo.file, 'legacy-two-plist');

  assert.throws(
    () => fixture.agent.uninstall({
      restoreState() {
        events.push('restore:state');
      }
    }),
    { code: 'background_legacy_service_stop_failed' }
  );

  assert.equal(fs.readFileSync(fixture.launchdPlist, 'utf8'), 'existing-supervisor-plist');
  assert.equal(fs.readFileSync(legacyOne.file, 'utf8'), 'legacy-one-plist');
  assert.equal(fs.readFileSync(legacyTwo.file, 'utf8'), 'legacy-two-plist');
  assert.ok(events.indexOf('restore:state') < events.indexOf('start:old-supervisor'));
  assert.ok(events.indexOf('start:old-supervisor') < events.indexOf('start:legacy-one'));
});
