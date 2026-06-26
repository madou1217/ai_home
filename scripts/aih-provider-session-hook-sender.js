#!/usr/bin/env node
'use strict';

const { runProviderSessionHookSender } = require('../lib/server/provider-session-hook-sender');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

(async () => {
  const stdin = await readStdin();
  const result = await runProviderSessionHookSender({
    argv: process.argv.slice(2),
    stdin
  });
  if (result.stderr) process.stderr.write(result.stderr);
  process.stdout.write(result.stdout || '{}');
})().catch((error) => {
  process.stderr.write(`[aih-provider-session-hook] ${String((error && error.message) || error || 'failed')}\n`);
  process.stdout.write('{}');
});
