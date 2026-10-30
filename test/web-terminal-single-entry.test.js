'use strict';

// 终端入口收敛守卫：Chat / Work 只有输入框工具栏一个终端入口，且所有终端都在全局
// Web Terminal 浮窗里（不再内嵌页面）。新加一个内嵌终端或第二个入口会直接失败。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webSrc = path.join(__dirname, '..', 'web', 'src');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.umi') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(webSrc);
const read = (file) => fs.readFileSync(file, 'utf8');
const rel = (file) => path.relative(webSrc, file).split(path.sep).join('/');

test('ShellTerminalPanel is rendered only by the global web terminal host', () => {
  const hosts = files.filter((file) => /<ShellTerminalPanel\b/.test(read(file))).map(rel);
  assert.deepEqual(hosts, ['features/web-terminal/GlobalWebTerminalHost.tsx']);
});

test('chat and work open terminals through the shared global-terminal hook', () => {
  for (const file of [
    'components/chat/MessageArea.tsx',
    'features/chat-runtime/SessionWorkspace.tsx',
    'features/project-workbench/ProjectWorkbench.tsx',
  ]) {
    assert.match(read(path.join(webSrc, file)), /useOpenProjectTerminal\(\)/, file);
  }
});

test('the work three-column layout has no terminal pane of its own', () => {
  const source = read(path.join(webSrc, 'features/project-workbench/WorkbenchColumns.tsx'));
  assert.match(source, /const RIGHT_PANES: readonly RightPane\[\] = \['review', 'browser'\];/);
  assert.doesNotMatch(source, /打开终端/);
});

test('each chat surface has exactly one terminal button', () => {
  const count = (file, pattern) => (read(path.join(webSrc, file)).match(pattern) || []).length;
  assert.equal(count('components/chat/MessageArea.tsx', /openProjectTerminal\(/g), 1);
  assert.equal(count('features/chat-runtime/ComposerToolbar.tsx', /onToggleTerminal/g), 1);
});
