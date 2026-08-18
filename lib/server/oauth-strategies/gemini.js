'use strict';

const { DEFAULT_STRATEGY, createPromptResponder, clientReady } = require('./base');

const respondToFolderTrust = createPromptResponder({
  shouldRespond: (logs) => /Do you trust the files in this folder\?/i.test(logs)
    && /\b2\.\s*Trust parent folder\b/i.test(logs),
  response: '2\r',
  stateFlag: '_geminiFolderTrustSelected',
  awaitingState: 'AWAITING_FOLDER_TRUST',
  selectedState: 'FOLDER_TRUST_SELECTED',
  unavailableMessage: '检测到 Gemini 文件夹信任提示，但当前 PTY 不支持自动输入。',
  selectedMessage: '检测到 Gemini 文件夹信任提示，自动选择 2. Trust parent folder。'
});

// Gemini CLI asks for folder trust before it can continue with browser OAuth.
// The WebUI owns the login PTY, so selecting the explicitly requested parent
// folder is deterministic and avoids leaving a job waiting for terminal input.
const GEMINI_STRATEGY = {
  prepareLogin: DEFAULT_STRATEGY.prepareLogin,
  buildLoginArgs: DEFAULT_STRATEGY.buildLoginArgs,

  handlePrompt({ job, deps }) {
    return respondToFolderTrust({ job, deps });
  },

  updateProgress({ job, hints, deps }) {
    if (!job || job.provider !== 'gemini' || job.status !== 'running') return;
    const trustSelected = Boolean(job && job._geminiFolderTrustSelected);
    if (trustSelected) {
      if (clientReady(hints.authorizationUrl, job.authorizationUrl)) {
        deps.setAuthProgressState(job, deps.states.AUTH_URL_READY);
      }
      return;
    }

    DEFAULT_STRATEGY.updateProgress({ job, hints, deps });
    respondToFolderTrust({ job, deps });
  },

  submitCallback: DEFAULT_STRATEGY.submitCallback
};

module.exports = {
  GEMINI_STRATEGY
};
