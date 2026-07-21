const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildProviderRuntimeEnv
} = require('../lib/cli/services/ai-cli/provider-runtime-env');

test('provider runtime env prepends project-local runtime tool paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-tools-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeBin = path.join(root, '.runtime-tools', 'bin');
  const npmBin = path.join(root, '.runtime-tools', 'npm', 'node_modules', '.bin');
  const nodeBin = path.join(root, '.node-runtime', 'node-v22.16.0-linux-x64', 'bin');
  fs.mkdirSync(runtimeBin, { recursive: true });
  fs.mkdirSync(npmBin, { recursive: true });
  fs.mkdirSync(nodeBin, { recursive: true });

  const env = buildProviderRuntimeEnv('claude', '/home/u/.ai_home/run/auth-projections/claude/acct_0123456789abcdef0123', {
    HOME: '/home/u',
    PATH: `/usr/bin:${runtimeBin}`
  }, {
    fs,
    path,
    platform: 'linux',
    runtimeRootDir: root
  });

  assert.deepEqual(env.PATH.split(path.delimiter).slice(0, 4), [
    runtimeBin,
    npmBin,
    nodeBin,
    '/usr/bin'
  ]);
});
