'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_AGE_MS, createReleaseTimeCache } = require('../lib/server/provider-cli-upgrade/upgrade-release-cache');
const { createProviderUpgradeDeps } = require('../lib/server/provider-cli-upgrade/upgrade-deps');

const PUBLISHED = Date.parse('2026-10-01T00:00:00Z');

// 远端查询全部是脚本化假件：latest 由 state.latest 决定，time 表查询次数记在 calls。
function makeDeps(state) {
  const calls = { latest: 0, releases: 0, publishTime: 0 };
  let clock = Date.parse('2026-10-06T00:00:00Z');
  const deps = createProviderUpgradeDeps({
    processObj: { platform: 'linux', env: {}, execPath: '/usr/bin/node' },
    aiHomeDir: '/tmp/aih-upgrade-release-cache-test',
    now: () => clock,
    resolveCliPath: () => '',
    checkManagedAppUpdate: async () => {
      calls.latest += 1;
      return { ok: true, latestVersion: state.latest };
    },
    fetchStableReleases: async () => {
      calls.releases += 1;
      if (state.releasesFail) return { ok: false, releases: [], error: 'npm_view_failed' };
      return { ok: true, releases: [{ version: state.latest, publishedAt: PUBLISHED }], error: '' };
    },
    fetchPublishTime: async () => {
      calls.publishTime += 1;
      return { ok: false, publishedAt: 0, error: 'publish_time_missing' };
    }
  });
  return { deps, calls, advance: (ms) => { clock += ms; } };
}

test('latest unchanged: the publish-time table is fetched once and reused', async () => {
  const state = { latest: '0.160.1' };
  const { deps, calls } = makeDeps(state);

  const first = await deps.checkUpdate('codex');
  const second = await deps.checkUpdate('codex');

  assert.equal(calls.latest, 2, 'the cheap latest-version query still runs every tick');
  assert.equal(calls.releases, 1);
  assert.equal(second.publishedAt, PUBLISHED);
  assert.deepEqual(second.releases, first.releases);
});

test('a new latest version invalidates the cached table immediately', async () => {
  const state = { latest: '0.160.1' };
  const { deps, calls } = makeDeps(state);

  await deps.checkUpdate('codex');
  state.latest = '0.161.0';
  const next = await deps.checkUpdate('codex');

  assert.equal(calls.releases, 2);
  assert.equal(next.latestVersion, '0.161.0');
  assert.equal(next.releases[0].version, '0.161.0');
});

test('failed table queries are not cached', async () => {
  const state = { latest: '0.160.1', releasesFail: true };
  const { deps, calls } = makeDeps(state);

  const failed = await deps.checkUpdate('codex');
  assert.equal(failed.publishedAt, 0);
  state.releasesFail = false;
  const recovered = await deps.checkUpdate('codex');

  assert.equal(calls.releases, 2);
  assert.equal(recovered.publishedAt, PUBLISHED);
});

test('providers sharing one npm package share the cached table', async () => {
  const state = { latest: '2.151.0' };
  const { deps, calls } = makeDeps(state);

  await deps.checkUpdate('codebuddy');
  const cn = await deps.checkUpdate('codebuddycn');

  assert.equal(calls.releases, 1);
  assert.equal(cn.publishedAt, PUBLISHED);
});

test('the cached table expires after MAX_AGE_MS even when latest is unchanged', async () => {
  const state = { latest: '0.160.1' };
  const { deps, calls, advance } = makeDeps(state);

  await deps.checkUpdate('codex');
  advance(MAX_AGE_MS - 1);
  await deps.checkUpdate('codex');
  assert.equal(calls.releases, 1);
  advance(1);
  await deps.checkUpdate('codex');
  assert.equal(calls.releases, 2);
});

test('release cache ignores entries without a package or version', () => {
  const cache = createReleaseTimeCache({ now: () => 0 });
  cache.set('', '1.0.0', { releases: [], publishedAt: 1 });
  cache.set('pkg', '', { releases: [], publishedAt: 1 });
  assert.equal(cache.get('', '1.0.0'), null);
  assert.equal(cache.get('pkg', ''), null);
  cache.set('pkg', '1.0.0', { releases: [{ version: '1.0.0', publishedAt: 1 }], publishedAt: 1 });
  assert.equal(cache.get('pkg', '1.0.1'), null);
  assert.equal(cache.get('pkg', '1.0.0').publishedAt, 1);
});
