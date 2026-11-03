'use strict';

// One scope for inspection and rehearsal copying. These exclusions are existing
// immutable native resources, not an excuse to omit an unknown executable ref.
module.exports = Object.freeze({
  roots: Object.freeze(['run', 'runtime', 'profiles', 'config']),
  skippedDirectories: Object.freeze([
    '.git', 'node_modules', '.pnpm', 'packages', 'vendor', 'Cache', 'GPUCache',
    'cache', 'logs', 'sessions', 'projects', 'history'
  ]),
  textExtensions: Object.freeze([
    '.json', '.toml', '.yaml', '.yml', '.conf', '.plist', '.cmd', '.sh', '.env', '.ini', '.jsonl', ''
  ])
});
