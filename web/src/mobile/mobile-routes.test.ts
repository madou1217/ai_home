import assert from 'node:assert/strict';
import test from 'node:test';

import routes from '../../config/routes.ts';
import { MOBILE_ROUTES, resolveMobileRoute } from './mobile-routes';

interface RouteNode { path?: string; component?: string; routes?: RouteNode[] }

const componentPaths = (nodes: RouteNode[], acc: string[] = []): string[] => {
  for (const node of nodes) {
    if (node.component && node.path) acc.push(node.path);
    if (node.routes) componentPaths(node.routes, acc);
  }
  return acc;
};

test('移动端只登记真实存在的页面路由（零虚构页面）', () => {
  const real = new Set(componentPaths(routes as RouteNode[]));
  for (const entry of MOBILE_ROUTES) {
    assert.ok(real.has(entry.pattern), `${entry.pattern} 不是 config/routes.ts 中的页面`);
  }
});

test('每个带组件的真实页面都有移动端页面', () => {
  const mobile = new Set(MOBILE_ROUTES.map((entry) => entry.pattern));
  for (const path of componentPaths(routes as RouteNode[])) {
    if (path === '/' || path === '*') continue;
    assert.ok(mobile.has(path), `${path} 缺少移动端页面`);
  }
});

test('具体路径优先于前缀路径，并解析路由参数', () => {
  const resolved = resolveMobileRoute('/accounts/codex/acct_1/models');
  assert.equal(resolved?.entry.pattern, '/accounts/:provider/:accountRef/models');
  assert.deepEqual(resolved?.params, { provider: 'codex', accountRef: 'acct_1' });
  assert.equal(resolveMobileRoute('/accounts/')?.entry.pattern, '/accounts');
  assert.equal(resolveMobileRoute('/toolkit/install-guide')?.entry.code, 'GUIDE');
  assert.equal(resolveMobileRoute('/nope'), null);
});
