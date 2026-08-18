'use strict';

const { DEFAULT_STRATEGY, createPromptResponder } = require('./base');

const respondToOpenCodeProviderSelect = createPromptResponder({
  shouldRespond: (logs) => {
    return /Select provider/i.test(logs)
      || (/Add credential/i.test(logs) && /OpenCode Zen/i.test(logs));
  },
  response: '\r',
  stateFlag: '_opencodeProviderSelected',
  unavailableMessage: '检测到 OpenCode 提供商选择菜单，但当前 PTY 不支持自动输入。',
  selectedMessage: '检测到 OpenCode 提供商选择菜单，自动选择 OpenCode Zen。'
});

const OPENCODE_STRATEGY = {
  prepareLogin: DEFAULT_STRATEGY.prepareLogin,

  buildLoginArgs({ authMode, baseArgs }) {
    const args = Array.isArray(baseArgs) ? baseArgs.slice() : [];
    const hasProviderFlag = args.includes('-p') || args.includes('--provider');
    if (!hasProviderFlag) {
      args.push('-p', 'opencode');
    }
    return args;
  },

  handlePrompt({ job, deps }) {
    return respondToOpenCodeProviderSelect({ job, deps });
  },

  updateProgress(ctx) {
    respondToOpenCodeProviderSelect({ job: ctx.job, deps: ctx.deps });
    return DEFAULT_STRATEGY.updateProgress(ctx);
  },

  submitCallback: DEFAULT_STRATEGY.submitCallback
};

module.exports = {
  OPENCODE_STRATEGY,
  respondToOpenCodeProviderSelect
};
