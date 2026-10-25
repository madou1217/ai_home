#!/usr/bin/env node
'use strict';

const { runFullAppHost } = require('../lib/desktop/runtime/full-app-host');

runFullAppHost().catch((error) => {
  process.stderr.write(`AIH Translation: ${error && error.message ? error.message : '启动失败'}\n`);
  process.exitCode = 1;
});
