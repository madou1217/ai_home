import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogCacheVersion,
  installCatalogCacheInvalidation,
  invalidateCatalogCache,
  readCachedCatalog,
  resetCatalogCacheForTests,
  writeCachedCatalog
} from './account-model-catalog-cache';
import { setAccountModelCatalogEventTarget } from '@/features/models/account-model-catalog-events';

const REF = 'acct_0123456789abcdefabcd';

function withBus(): EventTarget {
  const bus = new EventTarget();
  setAccountModelCatalogEventTarget(bus);
  return bus;
}

test('a cached catalog is readable and replaced on write', () => {
  resetCatalogCacheForTests();
  writeCachedCatalog(REF, { ids: ['a'], defaultModel: '' });
  assert.deepEqual(readCachedCatalog(REF)?.ids, ['a']);

  writeCachedCatalog(REF, { ids: ['a', 'b'], defaultModel: 'b' });
  assert.deepEqual(readCachedCatalog(REF)?.ids, ['a', 'b']);
});

// 2026-10-23 用户反馈：账号模型页加完模型切回 chat 看不到。缓存必须能被跨页面事件清掉。
test('a catalog change event drops the cache and bumps its version', () => {
  resetCatalogCacheForTests();
  const bus = withBus();
  const off = installCatalogCacheInvalidation();
  writeCachedCatalog(REF, { ids: ['old'], defaultModel: '' });
  const versionBefore = catalogCacheVersion(REF);

  bus.dispatchEvent(new CustomEvent('aih:account-model-catalog-changed', { detail: { accountRef: REF } }));

  assert.equal(readCachedCatalog(REF), undefined, '旧缓存必须被丢掉');
  assert.equal(catalogCacheVersion(REF), versionBefore + 1, '代次 +1 供订阅方重拉');
  off();
});

test('a change event for one account leaves other accounts untouched', () => {
  resetCatalogCacheForTests();
  const bus = withBus();
  const off = installCatalogCacheInvalidation();
  const other = 'acct_ffffffffffffffffffff';
  writeCachedCatalog(REF, { ids: ['a'], defaultModel: '' });
  writeCachedCatalog(other, { ids: ['b'], defaultModel: '' });

  bus.dispatchEvent(new CustomEvent('aih:account-model-catalog-changed', { detail: { accountRef: REF } }));

  assert.equal(readCachedCatalog(REF), undefined);
  assert.deepEqual(readCachedCatalog(other)?.ids, ['b']);
  off();
});

test('an empty account ref clears every cached account', () => {
  resetCatalogCacheForTests();
  const bus = withBus();
  const off = installCatalogCacheInvalidation();
  writeCachedCatalog(REF, { ids: ['a'], defaultModel: '' });
  writeCachedCatalog('acct_ffffffffffffffffffff', { ids: ['b'], defaultModel: '' });

  bus.dispatchEvent(new CustomEvent('aih:account-model-catalog-changed', { detail: {} }));

  assert.equal(readCachedCatalog(REF), undefined);
  assert.equal(readCachedCatalog('acct_ffffffffffffffffffff'), undefined);
  off();
});

test('unsubscribing stops the invalidation', () => {
  resetCatalogCacheForTests();
  const bus = withBus();
  const off = installCatalogCacheInvalidation();
  off();
  writeCachedCatalog(REF, { ids: ['kept'], defaultModel: '' });

  bus.dispatchEvent(new CustomEvent('aih:account-model-catalog-changed', { detail: { accountRef: REF } }));

  assert.deepEqual(readCachedCatalog(REF)?.ids, ['kept']);
});

test('invalidate without a target clears everything', () => {
  resetCatalogCacheForTests();
  writeCachedCatalog(REF, { ids: ['a'], defaultModel: '' });
  invalidateCatalogCache('');
  assert.equal(readCachedCatalog(REF), undefined);
});
