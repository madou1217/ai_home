'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function resolvePluginSocket(aiHomeDir, options = {}) {
  const root = path.resolve(String(aiHomeDir || '').trim() || os.tmpdir());
  const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\aih-plugin-${digest}`;
  }
  const directory = path.join(root, 'run', 'plugins');
  return path.join(directory, `host-${digest}.sock`);
}

module.exports = { resolvePluginSocket };
