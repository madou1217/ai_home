'use strict';

function clientReady(authorizationUrl, jobUrl) {
  return Boolean(authorizationUrl || jobUrl);
}

function parsePastedCode(rawInput, redirectUri, deps) {
  return deps.parseAuthorizationCodeInput(rawInput, redirectUri);
}

/**
 * createPromptResponder creates a reusable prompt responder for interactive CLI menus.
 * It tests job logs against a pattern/predicate and writes the response into the PTY process.
 */
function createPromptResponder({
  shouldRespond,
  pattern,
  response = '\r',
  stateFlag,
  awaitingState,
  selectedState,
  unavailableMessage = '检测到终端交互提示，但当前 PTY 不支持自动输入。',
  selectedMessage
}) {
  return function respondToPrompt({ job, deps }) {
    if (!job || job.status !== 'running') return false;
    if (stateFlag && job[stateFlag]) return false;

    const logs = deps && typeof deps.stripAnsi === 'function'
      ? deps.stripAnsi(job.logs || '')
      : String(job.logs || '');

    const matched = typeof shouldRespond === 'function'
      ? shouldRespond(logs, job)
      : (pattern && pattern.test(logs));

    if (!matched) return false;

    if (stateFlag) job[stateFlag] = true;
    if (awaitingState && deps && deps.states && deps.states[awaitingState]) {
      deps.setAuthProgressState(job, deps.states[awaitingState]);
    }

    const ptyProcess = job._ptyProcess;
    if (!ptyProcess || typeof ptyProcess.write !== 'function') {
      if (unavailableMessage && deps && typeof deps.appendJobLog === 'function') {
        deps.appendJobLog(job, unavailableMessage);
      }
      return true;
    }

    if (selectedMessage && deps && typeof deps.appendJobLog === 'function') {
      deps.appendJobLog(job, selectedMessage);
    }

    ptyProcess.write(response);

    if (selectedState && deps && deps.states && deps.states[selectedState]) {
      deps.setAuthProgressState(job, deps.states[selectedState]);
    }
    return true;
  };
}

const DEFAULT_STRATEGY = {
  prepareLogin() {},

  buildLoginArgs({ baseArgs }) {
    return Array.isArray(baseArgs) ? baseArgs.slice() : [];
  },

  updateProgress({ job, hints, deps }) {
    if (clientReady(hints.authorizationUrl, job.authorizationUrl)) {
      deps.setAuthProgressState(job, deps.states.AUTH_URL_READY);
    }
  },

  async submitCallback({ job, rawInput, deps }) {
    if (!job.redirectUri || !deps.isLoopbackCallbackUrl(job.redirectUri)) {
      return { ok: false, code: 'oauth_redirect_not_ready', job };
    }
    if (typeof deps.fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }

    const pasted = deps.parseBrowserCallbackInput(rawInput, job.redirectUri);
    if (!pasted) return { ok: false, code: 'invalid_callback_url', job };

    const state = String(pasted.searchParams.get('state') || '');
    if (job.oauthState && state !== job.oauthState) {
      return { ok: false, code: 'invalid_callback_state', job };
    }

    const target = new URL(job.redirectUri);
    target.search = pasted.search;
    target.hash = '';
    try {
      const response = await deps.fetchImpl(target.toString(), { method: 'GET' });
      if (response && response.ok === false) {
        return { ok: false, code: 'callback_forward_failed', statusCode: response.status, job };
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      return { ok: true, job };
    } catch (error) {
      job.error = String((error && error.message) || error || 'callback_forward_failed');
      job.updatedAt = Date.now();
      return { ok: false, code: 'callback_forward_failed', job };
    }
  }
};

module.exports = {
  clientReady,
  parsePastedCode,
  createPromptResponder,
  DEFAULT_STRATEGY
};
