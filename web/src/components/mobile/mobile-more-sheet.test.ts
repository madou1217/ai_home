import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import routes from '../../../config/routes.ts';

interface RouteNode {
  path?: string;
  component?: string;
  routes?: RouteNode[];
}

const collectComponentPaths = (nodes: RouteNode[], acc: string[] = []): string[] => {
  for (const node of nodes) {
    if (node.component && node.path) acc.push(node.path);
    if (node.routes) collectComponentPaths(node.routes, acc);
  }
  return acc;
};

test('「更多」面板的每个入口都指向已注册的页面路由', () => {
  const sheetSource = fs.readFileSync(
    new URL('./MobileMoreSheet.tsx', import.meta.url),
    'utf8'
  );
  const entryPaths = [...sheetSource.matchAll(/path: '(\/[^']+)'/g)].map((m) => m[1]);

  // D4 审计 G1：仪表盘/模型目录/灵感工坊/Server 管理/SSH 开发机五个入口缺一不可
  assert.deepEqual(entryPaths, [
    '/dashboard',
    '/models',
    '/studio/image',
    '/fabric/servers',
    '/fabric/ssh-hosts',
  ]);

  const registered = collectComponentPaths(routes as RouteNode[]);
  for (const entryPath of entryPaths) {
    assert.ok(
      registered.includes(entryPath),
      `入口 ${entryPath} 未在 config/routes.ts 注册为页面路由`
    );
  }
});

test('Settings 移动端分支不再硬过滤 section', () => {
  const settingsSource = fs.readFileSync(
    new URL('../../pages/Settings.tsx', import.meta.url),
    'utf8'
  );
  const mobileBranch = settingsSource.match(/isMobile \? \(\s*\(\(\) => \{([\s\S]*?)\}\)\(\)/);

  assert.ok(mobileBranch, 'Settings.tsx 缺少 isMobile 移动端分支');
  // D4 审计 G2：移动端 MobilePills 必须覆盖全部 section（含 Server/SSH），
  // 不允许再只保留 basic + aliases。
  assert.doesNotMatch(mobileBranch[1], /\.filter\(/);
  assert.match(mobileBranch[1], /items=\{sectionItems\.map/);
});
