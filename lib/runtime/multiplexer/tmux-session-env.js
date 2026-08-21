'use strict';

// 持久会话（tmux/psmux）不继承调用方的完整环境：新建 session 时只显式注入这份
// 白名单。会话是长驻的，重连时环境不会重新推导，所以任何"会话内的进程必须知道
// 的身份/渲染开关"都必须列在这里，否则它在 CLI 里就是不存在的。
//
// AIH_PROVIDER_ACCOUNT_REF 就踩过这个坑：启动侧算好了账号标识，却因为不在白名单
// 里而进不了 tmux，provider hook 于是报不出自己属于哪个账号，WebUI 账号行的
// 「运行中」指示（logo 转动 / 额度燃烧）对原生会话一直是灭的。
const TMUX_SAFE_RENDER_ENV_KEYS = Object.freeze([
  'CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT',
  'CLAUDE_CODE_FORCE_SYNC_OUTPUT',
  'CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL',
  'NODE_PATH',
  'AIH_CLAUDE_TMUX_RENDER_RUNTIME',
  'AIH_PROVIDER_SESSION_CORRELATION_ID',
  'AIH_PROVIDER_ACCOUNT_REF',
  'AIH_CODEX_MANAGED_LAUNCH',
  'AIH_PSMUX_CODEX_LAUNCH_RUNTIME',
  'AIH_PERSIST_PROVIDER_SUPERVISOR_RUNTIME'
]);

module.exports = {
  TMUX_SAFE_RENDER_ENV_KEYS
};
