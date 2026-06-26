#!/usr/bin/env node
'use strict';

const { runSshClipboardShimCli } = require('./shim-cli');

runSshClipboardShimCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`[aih ssh-clipboard] ${String(error && error.message || error)}\n`);
  process.exitCode = 1;
});
