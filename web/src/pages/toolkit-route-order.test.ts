import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import routes from '../../config/routes.ts';

test('Toolkit 安装指南路由先于父页面路由注册', () => {
  const guideIndex = routes.findIndex((route) => route.path === '/toolkit/install-guide');
  const toolkitIndex = routes.findIndex((route) => route.path === '/toolkit');

  assert.ok(guideIndex >= 0);
  assert.ok(toolkitIndex >= 0);
  assert.ok(guideIndex < toolkitIndex);
});

test('Toolkit 与安装指南使用保留应用基路径的语义化链接', () => {
  const environmentSource = fs.readFileSync(
    new URL('../components/toolkit/EnvironmentPanel.tsx', import.meta.url),
    'utf8'
  );
  const guideSource = fs.readFileSync(new URL('./ToolkitInstallGuide.tsx', import.meta.url), 'utf8');

  assert.match(environmentSource, /href=\{buildAppHref\('\/toolkit\/install-guide'\)\}/);
  assert.doesNotMatch(environmentSource, /window\.location\.href/);
  assert.match(guideSource, /href=\{buildAppHref\('\/toolkit'\)\}/);
  assert.doesNotMatch(guideSource, /useNavigate/);
});
