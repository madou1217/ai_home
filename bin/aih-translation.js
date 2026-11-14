#!/usr/bin/env node
'use strict';

// Compatibility entry only: native desktop orchestration lives in the Go host.
// Never load the legacy Node desktop service as an implicit failure fallback.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const platform = process.platform;
const architecture = process.arch === 'x64' ? 'x64' : process.arch;
const root = path.resolve(__dirname, '..');
const executable = path.join(root, 'bin', 'native', `${platform}-${architecture}`, platform === 'win32' ? 'aih-server.exe' : 'aih-server');
if (!fs.existsSync(executable)) {
  process.stderr.write('AIH Translation: 缺少原生 Go Server 构件，请构建或安装完整发布包。\n');
  process.exitCode = 1;
} else {
  const child = spawn(executable, ['__desktop-translation', '--repo', root, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env
  });
  const forward = (signal) => { try { child.kill(signal); } catch (_) {} };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.once('error', () => {
    process.stderr.write('AIH Translation: 无法启动原生桌面宿主。\n');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : 1;
  });
}
