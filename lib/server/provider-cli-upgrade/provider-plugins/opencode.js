'use strict';

module.exports = Object.freeze({
  id: 'opencode',
  capability: 'provider-cli.upgrade',
  // 官方安装脚本的布局（~/.opencode/bin），自带更新器，aih 不接管。
  vendorSelfUpdateRoots: ({ home, path }) => [
    home && path.join(home, '.opencode')
  ]
});
