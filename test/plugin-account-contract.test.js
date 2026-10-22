'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAccountPluginService } = require('../lib/plugins/account/service');
const { toAuthSourceDescriptor } = require('../lib/plugins/account/auth-sources');
const { normalizeSourceListResult } = require('../lib/plugins/account/contract');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeRuntime(contributions = []) {
  const handlers = new Map();
  const snapshot = { byCapability: new Map() };
  for (const item of contributions) {
    handlers.set(item.id, item.handler);
    if (!snapshot.byCapability.has(item.capability)) snapshot.byCapability.set(item.capability, []);
    snapshot.byCapability.get(item.capability).push(item);
  }
  return {
    handlers,
    snapshot,
    acquire: () => ({ generation: 7, snapshot, release() {} }),
    async invoke(id, value) {
      const handler = handlers.get(id);
      if (!handler) throw new Error(`missing handler ${id}`);
      return { value: await handler(value) };
    }
  };
}

const sourceContribution = {
  id: 'demo.account.source',
  capability: 'account.source',
  instanceId: 'inst-1',
  handler: () => ({
    sources: [{
      id: 'demo-source',
      kind: 'local',
      authMode: 'api-key',
      clientDependent: false,
      directImport: true,
      projectionId: 'demo-projection',
      available: true,
      identity: 'user@example.com',
      description: 'demo'
    }]
  })
};

test('account source results preserve plugin ownership and merge into auth sources', async (t) => {
  const runtime = fakeRuntime([sourceContribution]);
  const service = createAccountPluginService({ runtime, aiHomeDir: tempHome(t) });
  const listed = await service.listSources('opencode');
  assert.equal(listed.sources.length, 1);
  assert.equal(listed.sources[0].pluginInstanceId, 'inst-1');
  assert.equal(listed.sources[0].provider, 'opencode');

  const descriptor = toAuthSourceDescriptor(listed.sources[0], service);
  assert.equal(descriptor.directImport, true);
  assert.equal(descriptor.available(), true);
  assert.equal(descriptor.identity(), 'user@example.com');
  assert.equal(typeof descriptor.import, 'function');
});

test('account source accepts the legacy array shape and app field', () => {
  const normalized = normalizeSourceListResult([{
    id: 'legacy',
    kind: 'local',
    app: 'desktop',
    authMode: 'oauth-browser',
    clientDependent: true,
    directImport: false
  }], { instanceId: 'i', contributionId: 'c', provider: 'kiro' });
  assert.equal(normalized[0].requiresApp, 'desktop');
  assert.equal(normalized[0].provider, 'kiro');
});

test('account login jobs expose only public state and can be cancelled', async (t) => {
  const loginContribution = {
    id: 'demo.account.login',
    capability: 'account.login',
    instanceId: 'inst-1',
    handler: (input) => {
      if (input.kind === 'start') {
        return {
          status: 'waiting_user',
          jobId: 'plugin-job-1',
          verificationUri: 'https://example.com/device',
          userCode: 'ABCD-EFGH',
          expiresAt: Date.now() + 60_000
        };
      }
      if (input.kind === 'poll') return { status: 'waiting_user' };
      return { status: 'cancelled' };
    }
  };
  const runtime = fakeRuntime([sourceContribution, loginContribution]);
  const service = createAccountPluginService({ runtime, aiHomeDir: tempHome(t) });
  const listed = await service.listSources('opencode');
  assert.equal(listed.sources[0].loginAvailable, true);
  assert.equal(toAuthSourceDescriptor(listed.sources[0], service).pluginLogin, true);
  const job = await service.startLogin({ provider: 'opencode', sourceId: 'demo-source' });
  assert.equal(job.status, 'waiting_user');
  assert.equal(job.userCode, 'ABCD-EFGH');
  assert.equal(job.credential, undefined);
  const polled = await service.pollLogin(job.jobId);
  assert.equal(polled.status, 'waiting_user');
  const cancelled = await service.cancelLogin(job.jobId);
  assert.equal(cancelled.status, 'cancelled');
});

test('account materialize writes only into the host runtime directory', async (t) => {
  const aiHomeDir = tempHome(t);
  const runtimeDir = path.join(aiHomeDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const materializeContribution = {
    id: 'demo.account.materialize',
    capability: 'account.materialize',
    instanceId: 'inst-1',
    handler: (input) => {
      if (input.kind === 'match') return { handles: input.provider === 'opencode' };
      return {
        handled: true,
        files: [
          { path: 'auth.json', content: '{"token":"x"}', mode: 0o600 },
          { path: 'nested/id', content: 'device' }
        ]
      };
    }
  };
  const runtime = fakeRuntime([materializeContribution]);
  const service = createAccountPluginService({ runtime, aiHomeDir });
  const result = await service.materialize({
    provider: 'opencode',
    accountRef: 'acct',
    credential: { token: 'x' },
    runtimeDir
  });
  assert.equal(result.handled, true);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'auth.json'), 'utf8'), '{"token":"x"}');
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'nested/id'), 'utf8'), 'device');
  assert.equal(fs.statSync(path.join(runtimeDir, 'auth.json')).mode & 0o777, 0o600);
});

test('unsafe projection paths are rejected before writing', async (t) => {
  const aiHomeDir = tempHome(t);
  const runtimeDir = path.join(aiHomeDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtime = fakeRuntime([{
    id: 'demo.account.materialize',
    capability: 'account.materialize',
    instanceId: 'inst-1',
    handler: (input) => (input.kind === 'match'
      ? { handles: true }
      : { handled: true, files: [{ path: '../escape', content: 'x' }] })
  }]);
  const service = createAccountPluginService({ runtime, aiHomeDir });
  const result = await service.materialize({
    provider: 'opencode',
    credential: {},
    runtimeDir
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'account_plugin_file_path_invalid');
  assert.equal(fs.existsSync(path.join(runtimeDir, '..', 'escape')), false);
});

function openCodeProjection() {
  return JSON.stringify({ opencode: { type: 'api', key: 'plugin-test-key' } });
}

function accountSourceContribution(options = {}) {
  return {
    id: 'demo.account.source',
    capability: 'account.source',
    instanceId: 'inst-1',
    handler: (input) => {
      if (input.kind === 'list') {
        return {
          sources: [{
            id: 'demo-source',
            kind: options.kind || 'local',
            authMode: options.authMode || 'api-key',
            clientDependent: false,
            directImport: options.directImport !== false,
            available: true,
            description: 'demo source'
          }]
        };
      }
      if (input.kind === 'import') {
        if (options.importError) throw new Error(options.importError);
        return {
          files: [{
            path: '.local/share/opencode/auth.json',
            content: options.authContent || openCodeProjection()
          }]
        };
      }
      throw new Error(`unexpected kind ${input.kind}`);
    }
  };
}

test('account source may defer projection files to the import call', async (t) => {
  const aiHomeDir = tempHome(t);
  const runtime = fakeRuntime([accountSourceContribution()]);
  const service = createAccountPluginService({ runtime, aiHomeDir });
  const listed = await service.listSources('opencode');
  assert.equal(listed.sources[0].directImport, true);
  assert.equal(listed.sources[0].credential, null);

  const imported = await service.importSource({ provider: 'opencode', sourceId: 'demo-source' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.match(imported.accountRef, /^acct_/);
  assert.equal(
    fs.readFileSync(path.join(imported.runtimeDir, '.local/share/opencode/auth.json'), 'utf8'),
    openCodeProjection()
  );
});

test('automatic source import respects the user deletion tombstone', async (t) => {
  const aiHomeDir = tempHome(t);
  const runtime = fakeRuntime([accountSourceContribution()]);
  const service = createAccountPluginService({ runtime, aiHomeDir });
  const first = await service.importSource({ provider: 'opencode', sourceId: 'demo-source' });
  assert.equal(first.ok, true, JSON.stringify(first));

  const { deleteAccountRef } = require('../lib/server/account-ref-store');
  assert.equal(deleteAccountRef(fs, aiHomeDir, first.accountRef), true);

  const second = await service.importSource({ provider: 'opencode', sourceId: 'demo-source' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'account_deleted_by_user');
});

test('login completes through the host registration chain without persisting credentials', async (t) => {
  const aiHomeDir = tempHome(t);
  const loginContribution = {
    id: 'demo.account.login',
    capability: 'account.login',
    instanceId: 'inst-1',
    handler: (input) => {
      if (input.kind === 'start') {
        return {
          status: 'waiting_user',
          jobId: 'plugin-job-success',
          verificationUri: 'https://example.com/device',
          userCode: 'WXYZ-1234',
          expiresAt: Date.now() + 60_000
        };
      }
      if (input.kind === 'poll') {
        return {
          status: 'success',
          files: [{
            path: '.local/share/opencode/auth.json',
            content: openCodeProjection()
          }]
        };
      }
      return { status: 'cancelled' };
    }
  };
  const runtime = fakeRuntime([accountSourceContribution({ directImport: false }), loginContribution]);
  const events = [];
  const service = createAccountPluginService({
    runtime,
    aiHomeDir,
    audit: { append: (event, details) => events.push({ event, ...details }) }
  });
  const started = await service.startLogin({ provider: 'opencode', sourceId: 'demo-source' });
  assert.equal(started.status, 'waiting_user');
  const finished = await service.pollLogin(started.jobId);
  assert.equal(finished.status, 'success');
  assert.match(finished.accountRef, /^acct_/);
  assert.equal(events.some((item) => item.event === 'account_login' && item.status === 'success'), true);
  assert.doesNotMatch(JSON.stringify(events), /plugin-test-key/);

  const jobsFile = path.join(aiHomeDir, 'plugins', 'account-login-jobs.json');
  const persisted = fs.readFileSync(jobsFile, 'utf8');
  assert.doesNotMatch(persisted, /plugin-test-key/);
  assert.doesNotMatch(persisted, /WXYZ-1234/);
});

test('login submit accepts pasted credentials without persisting them', async (t) => {
  const aiHomeDir = tempHome(t);
  const submitted = [];
  const loginContribution = {
    id: 'demo.account.login',
    capability: 'account.login',
    instanceId: 'inst-1',
    handler: (input) => {
      if (input.kind === 'start') {
        return {
          status: 'waiting_user',
          jobId: 'plugin-job-submit',
          canSubmit: true,
          submitLabel: '提交令牌',
          submitPlaceholder: '粘贴 API Key',
          expiresAt: Date.now() + 60_000
        };
      }
      if (input.kind === 'poll') return { status: 'waiting_user' };
      if (input.kind === 'submit') {
        submitted.push(input.value);
        return {
          status: 'success',
          files: [{
            path: '.local/share/opencode/auth.json',
            content: openCodeProjection()
          }]
        };
      }
      return { status: 'cancelled' };
    }
  };
  const runtime = fakeRuntime([accountSourceContribution({ directImport: false }), loginContribution]);
  const service = createAccountPluginService({ runtime, aiHomeDir });
  const started = await service.startLogin({ provider: 'opencode', sourceId: 'demo-source' });
  assert.equal(started.canSubmit, true);
  assert.equal(started.submitLabel, '提交令牌');
  assert.equal(started.submitPlaceholder, '粘贴 API Key');

  const finished = await service.submitLogin(started.jobId, { value: 'plugin-test-key' });
  assert.equal(finished.status, 'success');
  assert.match(finished.accountRef, /^acct_/);
  assert.deepEqual(submitted, ['plugin-test-key']);

  const jobsFile = path.join(aiHomeDir, 'plugins', 'account-login-jobs.json');
  const persisted = fs.readFileSync(jobsFile, 'utf8');
  assert.doesNotMatch(persisted, /plugin-test-key/);
});

test('login submit rejects tasks whose plugin did not advertise it', async (t) => {
  const runtime = fakeRuntime([accountSourceContribution({ directImport: false }), {
    id: 'demo.account.login',
    capability: 'account.login',
    instanceId: 'inst-1',
    handler: (input) => (input.kind === 'start'
      ? { status: 'waiting_user', jobId: 'device-only', expiresAt: Date.now() + 60_000 }
      : { status: 'waiting_user' })
  }]);
  const service = createAccountPluginService({ runtime, aiHomeDir: tempHome(t) });
  const started = await service.startLogin({ provider: 'opencode', sourceId: 'demo-source' });
  assert.equal(started.canSubmit, false);
  await assert.rejects(
    () => service.submitLogin(started.jobId, { value: 'secret' }),
    (error) => error.code === 'account_login_submit_unsupported'
  );
});

test('refresh refuses to overwrite a runtime dir another writer changed concurrently', async (t) => {
  const aiHomeDir = tempHome(t);
  const runtimeDir = path.join(aiHomeDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'auth.json'), 'before', { mode: 0o600 });
  const runtime = fakeRuntime([{
    id: 'demo.account.refresh',
    capability: 'account.refresh',
    instanceId: 'inst-1',
    handler: (input) => {
      if (input.kind === 'match') return { handles: true };
      if (input.kind === 'refresh') {
        // 模拟另一条刷新链在插件执行期间写入同一投影。
        fs.writeFileSync(path.join(runtimeDir, 'auth.json'), 'concurrent', { mode: 0o600 });
        return {
          handled: true,
          files: [{ path: 'auth.json', content: 'from-plugin' }]
        };
      }
      return { handled: false };
    }
  }]);
  const service = createAccountPluginService({ runtime, aiHomeDir });
  const result = await service.refresh({
    provider: 'opencode',
    accountRef: 'acct_demo',
    runtimeDir,
    credential: { refreshToken: 'refresh-token' }
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'account_refresh_conflict');
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'auth.json'), 'utf8'), 'concurrent');
});

test('account plugins cannot write outside the configured AIH home', async (t) => {
  const aiHomeDir = tempHome(t);
  const outside = tempHome(t);
  const runtime = fakeRuntime([{
    id: 'demo.account.materialize',
    capability: 'account.materialize',
    instanceId: 'inst-1',
    handler: (input) => (input.kind === 'match'
      ? { handles: true }
      : { handled: true, files: [{ path: 'auth.json', content: 'x' }] })
  }]);
  const service = createAccountPluginService({ runtime, aiHomeDir });
  await assert.rejects(
    () => service.materialize({
      provider: 'opencode',
      credential: {},
      runtimeDir: outside
    }),
    (error) => error.code === 'account_plugin_runtime_dir_outside_home'
  );
  assert.equal(fs.existsSync(path.join(outside, 'auth.json')), false);
});
