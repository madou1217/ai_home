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
  'AIH_CODEX_GATEWAY_ACCOUNT_REF',
  'AIH_PSMUX_CODEX_LAUNCH_RUNTIME',
  'AIH_PERSIST_PROVIDER_SUPERVISOR_RUNTIME'
]);

// 每次启动各自投影的 provider 目录（凭据所在的 CODEX_HOME 等）。它们随启动而变：同一账号
// 的第二个会话会用新的临时投影目录。POSIX 上新 session 的环境来自该 socket 上长驻的 tmux
// 服务器——也就是**第一个**会话启动时的环境；不显式注入，后来的会话都会继承第一个会话的
// 目录。第一个会话退出时按租约删掉那个目录（连同 auth.json），同 socket 上所有会话随之丢失
// 凭据：运行中的会话掉线，新启动的直接进入登录界面。
// 只在 new-session -e 时注入（不写 -g 全局），且只列路径，不列密钥（密钥只走进程 env）。
const TMUX_PROVIDER_HOME_ENV_KEYS = Object.freeze([
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CODEX_ELECTRON_USER_DATA_PATH',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'KIMI_CODE_HOME',
  'ZCODE_DATA_BASE_DIR',
  'CODEBUDDY_CONFIG_DIR'
]);

module.exports = {
  TMUX_PROVIDER_HOME_ENV_KEYS,
  TMUX_SAFE_RENDER_ENV_KEYS
};
