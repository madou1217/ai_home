import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(relativePath: string) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('三类资源管理标题不再重复解释页面名称', () => {
  const sources = [
    read('./AppManagerPanel.tsx'),
    read('./TerminalManagerPanel.tsx'),
    read('./EnvironmentPanel.tsx')
  ];

  for (const source of sources) {
    assert.doesNotMatch(source, /<p>管理当前系统/);
  }
  assert.doesNotMatch(read('../../pages/ToolkitInstallGuide.tsx'), /<p>选择目标系统和工具/);
});

test('应用、终端和运行环境共用同一资源卡信息密度', () => {
  const cardSource = read('./ManagedResourceCard.tsx');
  const terminalSource = read('./TerminalManagerPanel.tsx');
  const environmentSource = read('./EnvironmentPanel.tsx');

  assert.doesNotMatch(cardSource, /description\?: ReactNode/);
  assert.doesNotMatch(terminalSource, /description=\{terminal\.description\}/);
  assert.doesNotMatch(environmentSource, /description=\{resource\.description\}/);
});

test('网络接入与隧道复用应用式资源卡和生命周期操作', () => {
  const source = read('./ManagedToolsPanel.tsx');

  assert.match(source, /<ManagedResourceCard/);
  assert.match(source, /<InstallLifecycleAction/);
  assert.match(source, /toolkitAPI\.planManagedToolAction/);
  assert.match(source, /toolkitAPI\.executeManagedToolAction/);
  assert.doesNotMatch(source, /className=\{`toolkit-app-card/);
  assert.doesNotMatch(source, /<Alert/);
  assert.doesNotMatch(source, /不会在本面板自动安装/);
  assert.match(source, /外部安装/);
});
