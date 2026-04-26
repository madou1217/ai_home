#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

function main() {
  const cliRoot = path.resolve(__dirname, '..', 'cli');
  const cliEntry = path.join(cliRoot, 'src', 'entrypoints', 'claudecodex.tsx');
  const child = spawn('bun', [cliEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd()
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    process.stderr.write(`claudecodex: 源码启动失败: ${error.message}\n`);
    process.exit(1);
  });
}

main();
