import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTerminalExecutablePresentation,
  hasManagedTerminalLifecycle
} from './terminal-presentation.ts';

test('只有具备完整更新与卸载能力的终端显示生命周期操作', () => {
  assert.equal(hasManagedTerminalLifecycle({ canUpdate: true, canUninstall: true }), true);
  assert.equal(hasManagedTerminalLifecycle({ canUpdate: false, canUninstall: false }), false);
  assert.equal(hasManagedTerminalLifecycle({ canUpdate: true, canUninstall: false }), false);
});

test('终端路径文案区分已安装、系统默认和未安装状态', () => {
  assert.deepEqual(
    getTerminalExecutablePresentation({ installed: true, default: false, executablePath: '/usr/bin/wezterm' }),
    { value: '/usr/bin/wezterm', tooltip: '/usr/bin/wezterm', muted: false }
  );
  assert.deepEqual(
    getTerminalExecutablePresentation({ installed: true, default: true, executablePath: '' }),
    {
      value: '由系统默认终端解析',
      tooltip: '启动时由当前操作系统解析默认终端',
      muted: true
    }
  );
  assert.deepEqual(
    getTerminalExecutablePresentation({ installed: false, default: false, executablePath: '' }),
    { value: '未安装', tooltip: '当前主机尚未安装该终端', muted: true }
  );
  assert.deepEqual(
    getTerminalExecutablePresentation({ installed: false, default: true, executablePath: '' }),
    { value: '未安装', tooltip: '当前主机尚未安装该终端', muted: true }
  );
});
