'use strict';

const { createCodePasteStrategy } = require('./code-paste');
const { createPromptResponder } = require('./base');

// agy 的 Google 直连登录已固定由 Go 承接（见 web-account-auth 的 AGY_GO_NATIVE_OAUTH），
// 本文件只保留 native-cli 模式：CLI 打印授权码后由 PTY 写回。
const respondToGoogleOAuthMethod = createPromptResponder({
  shouldRespond: (logs) => /Select login method/i.test(logs)
    && /Google OAuth/i.test(logs)
    && /Google Cloud project/i.test(logs),
  response: '1\r',
  stateFlag: '_agyGoogleOAuthSelected',
  awaitingState: 'AWAITING_LOGIN_METHOD',
  selectedState: 'LOGIN_METHOD_SELECTED',
  unavailableMessage: '检测到 Antigravity 登录方式菜单，但当前 PTY 不支持自动输入。',
  selectedMessage: '检测到 Antigravity 登录方式菜单，自动选择 1. Google OAuth。'
});

const baseAgyStrategy = createCodePasteStrategy({
  // Antigravity's CLI prints "paste the authorization code" once it is ready.
  detectAwaitingCode: (job, deps) => {
    const logs = deps && typeof deps.stripAnsi === 'function'
      ? deps.stripAnsi(job.logs || '')
      : String(job.logs || '');
    return /authorization\s+code/i.test(logs)
      || /paste\s+the\s+authorization\s+code/i.test(logs)
      || /授权码/.test(logs);
  },
  buildCliInput: (parsed) => parsed.code,
  notReadyMessage: 'Antigravity 授权链接尚未准备好，等待 CLI 输出授权链接后再提交授权码。',
  parseErrorMessage: 'Antigravity 授权码解析失败。',
  stateMismatchMessage: 'Antigravity 授权码 state 校验失败。',
  emptyCodeMessage: 'Antigravity 授权码为空。',
  noPtyMessage: 'Antigravity 授权码无法写回：当前 PTY 不支持自动输入。',
  submittedMessage: '收到 Antigravity 授权码，已写回 CLI 等待原生登录完成。'
});

const AGY_STRATEGY = {
  ...baseAgyStrategy,

  getInitialAuthProgressState({ states }) {
    return (states && states.AWAITING_LOGIN_METHOD) || 'awaiting_login_method';
  },

  handlePrompt({ job, deps }) {
    return respondToGoogleOAuthMethod({ job, deps });
  },

  updateProgress(ctx) {
    respondToGoogleOAuthMethod({ job: ctx.job, deps: ctx.deps });
    return baseAgyStrategy.updateProgress(ctx);
  }
};

const AGY_STRATEGIES = Object.freeze({
  // 直连 Google 登录已走 Go；策略名仍接受，但解析到 CLI 形态即可
  // （auth.js 会按 provider/strategy 覆盖成 Go 作业描述符）。
  'aih-google-oauth': AGY_STRATEGY,
  'native-cli': AGY_STRATEGY,
  default: AGY_STRATEGY
});

module.exports = {
  AGY_STRATEGY,
  AGY_STRATEGIES,
  respondToGoogleOAuthMethod
};
