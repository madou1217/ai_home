'use strict';

module.exports = Object.freeze({
  id: 'claude',
  capability: 'provider-cli.upgrade',
  // 官方安装器自带更新器（~/.local/share/claude/versions/*），aih 不接管。
  vendorSelfUpdateRoots: ({ home, path }) => [
    home && path.join(home, '.local', 'share', 'claude'),
    home && path.join(home, '.claude', 'local')
  ]
});
