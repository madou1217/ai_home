'use strict';

const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const LOW_MEMORY_BUILD_LIMIT = 2048 * 1024 * 1024;

function readCgroupMemoryLimit() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (!value || value === 'max') continue;
      const bytes = Number(value);
      if (Number.isFinite(bytes) && bytes > 0) return bytes;
    } catch {
      // cgroup v1/v2 is optional; fall back to os.totalmem().
    }
  }
  return Infinity;
}

function availableMemory() {
  return Math.min(os.totalmem(), readCgroupMemoryLimit());
}

function run() {
  const env = { ...process.env };
  // Umi/webpack can exceed Node's default ~1 GiB old-space limit while it
  // serializes the production asset graph. Keep the limit explicit so a build
  // fails for real errors instead of dying after compilation with OOM.
  if (!env.NODE_OPTIONS || !/--max-old-space-size=\d+/.test(env.NODE_OPTIONS)) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--max-old-space-size=1536`;
  }
  const memory = availableMemory();
  if (!env.COMPRESS && memory <= LOW_MEMORY_BUILD_LIMIT) {
    env.COMPRESS = 'none';
    process.stderr.write(
      `web build: ${Math.round(memory / 1024 / 1024)} MiB available; ` +
      'disabling production minification to stay within the low-memory build budget\n'
    );
  }

  const result = spawnSync('max', ['build'], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run();
