'use strict';

const { clientReady, parsePastedCode, DEFAULT_STRATEGY } = require('./base');

/**
 * createCodePasteStrategy: write an authorization code back into a live CLI.
 * Antigravity keeps its CLI running and reads the authorization code from stdin.
 */
function createCodePasteStrategy(config) {
  return {
    prepareLogin: config.prepareLogin || DEFAULT_STRATEGY.prepareLogin,
    buildLoginArgs: config.buildLoginArgs || DEFAULT_STRATEGY.buildLoginArgs,

    updateProgress({ job, hints, deps }) {
      if (clientReady(hints.authorizationUrl, job.authorizationUrl)) {
        deps.setAuthProgressState(job, deps.states.AUTH_URL_READY);
        if (config.detectAwaitingCode(job, deps)) {
          deps.setAuthProgressState(job, deps.states.AWAITING_CODE);
        }
      }
    },

    submitCallback({ job, rawInput, deps }) {
      const ready = job.authProgressState === deps.states.AWAITING_CODE
        || config.detectAwaitingCode(job, deps);
      if (!ready) {
        deps.appendJobLog(job, config.notReadyMessage);
        return { ok: false, code: 'oauth_redirect_not_ready', job };
      }
      const parsed = parsePastedCode(rawInput, job.redirectUri, deps);
      if (!parsed) {
        deps.appendJobLog(job, config.parseErrorMessage);
        return { ok: false, code: 'invalid_authorization_code', job };
      }
      if (parsed.error) {
        job.error = parsed.error;
        deps.appendJobLog(job, `OAuth provider 返回错误：${deps.compactLogText(parsed.error)}`);
        deps.finalizeJob(job, 'failed', parsed.error, 1);
        return { ok: false, code: 'oauth_provider_error', job };
      }
      if (job.oauthState && parsed.state && parsed.state !== job.oauthState) {
        deps.appendJobLog(job, config.stateMismatchMessage);
        return { ok: false, code: 'invalid_callback_state', job };
      }
      if (!parsed.code) {
        deps.appendJobLog(job, config.emptyCodeMessage);
        return { ok: false, code: 'invalid_authorization_code', job };
      }

      const ptyProcess = job._ptyProcess;
      if (!ptyProcess || typeof ptyProcess.write !== 'function') {
        deps.appendJobLog(job, config.noPtyMessage);
        return { ok: false, code: 'authorization_code_forward_unavailable', job };
      }

      const payload = config.buildCliInput(parsed, job);
      deps.appendJobLog(job, config.submittedMessage);
      ptyProcess.write(`${payload}\r`);
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      deps.setAuthProgressState(job, deps.states.SUBMITTED_CODE);
      return { ok: true, job };
    }
  };
}

module.exports = {
  createCodePasteStrategy
};
