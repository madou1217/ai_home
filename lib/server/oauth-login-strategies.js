'use strict';

// Browser-OAuth login differs per CLI provider: Codex exchanges the code itself,
// Antigravity and Claude paste the code back into a running CLI, and the rest
// forward a callback URL to a local loopback server. Instead of scattering
// `if (provider === 'x')` branches across the job manager, every provider
// implements this small contract and the manager dispatches polymorphically.
//
// Contract — each strategy MAY override any of:
//   prepareLogin(ctx)   -> void           : seed the sandbox / mutate spawn env before the CLI starts
//   updateProgress(ctx) -> void           : advance auth-progress state from freshly parsed log hints
//   submitCallback(ctx) -> Result|Promise : turn the user's pasted code/URL into a completed login
//
// Every collaborator (helpers, constants, fs, fetch) is injected through `ctx`,
// so this module never imports the job manager. That keeps the strategies pure,
// unit-testable in isolation, and free of dependency cycles.
//
// Result shape (submitCallback): { ok: boolean, code?: string, job, statusCode?: number }

// --- shared building blocks ---------------------------------------------------

function clientReady(authorizationUrl, jobUrl) {
  return Boolean(authorizationUrl || jobUrl);
}

// Pull { code, state, error } out of whatever the user pasted: a full callback
// URL, a bare "?code=...&state=...", a "code#state" pair, or a lone code.
function parsePastedCode(rawInput, redirectUri, deps) {
  return deps.parseAuthorizationCodeInput(rawInput, redirectUri);
}

// --- default strategy: forward the callback URL to a loopback server ----------
// Used by providers whose CLI hosts its own localhost redirect (e.g. gemini).

const DEFAULT_STRATEGY = {
  prepareLogin() {},

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

// --- codex strategy: the manager generated the URL and exchanges the code -----

// --- native-OAuth strategy: aih builds the authorization URL, runs its own
//     loopback server, and exchanges the code itself. On the same machine the
//     browser hits the loopback and it auto-completes; remote sessions paste the
//     callback URL, which aih forwards to that server. Used by Codex and Claude —
//     only the OAuth endpoints (buildAuthorizationUrl) and the token-exchange +
//     credential writer (injected as deps[exchangeDep]) differ between them.
function createNativeOauthStrategy(nativeOauth, extra = {}) {
  return {
    nativeOauth,
    prepareLogin: extra.prepareLogin || (() => {}),
    updateProgress: DEFAULT_STRATEGY.updateProgress,

    async submitCallback({ job, rawInput, deps }) {
      if (!job._manualCallbackOauth) {
        return { ok: false, code: 'callback_not_supported', job };
      }
      deps.appendJobLog(job, '收到浏览器 OAuth 回调提交。');
      const pasted = deps.parseBrowserCallbackInput(rawInput, job.redirectUri);
      if (!pasted) {
        deps.appendJobLog(job, '回调地址解析失败。');
        return { ok: false, code: 'invalid_callback_url', job };
      }
      if (!deps.isSameCallbackEndpoint(pasted, job.redirectUri)) {
        deps.appendJobLog(job, '回调地址 endpoint 与当前授权任务不一致。');
        return { ok: false, code: 'invalid_callback_redirect', job };
      }
      const state = String(pasted.searchParams.get('state') || '');
      if (job.oauthState && state !== job.oauthState) {
        deps.appendJobLog(job, '回调 state 校验失败。');
        return { ok: false, code: 'invalid_callback_state', job };
      }
      deps.appendJobLog(job, '回调 state 校验通过。');
      const errorParam = deps.normalizeString(
        pasted.searchParams.get('error') || pasted.searchParams.get('error_description')
      );
      if (errorParam) {
        job.error = errorParam;
        deps.appendJobLog(job, `OAuth provider 返回错误：${deps.compactLogText(errorParam)}`);
        deps.finalizeJob(job, 'failed', errorParam, 1);
        return { ok: false, code: 'oauth_provider_error', job };
      }
      if (!deps.normalizeString(pasted.searchParams.get('code'))) {
        deps.appendJobLog(job, '回调缺少 code 参数。');
      }
      return deps[nativeOauth.exchangeDep](job, pasted.searchParams.get('code'), job.redirectUri);
    }
  };
}

const CODEX_STRATEGY = createNativeOauthStrategy(
  {
    logLabel: 'Codex',
    loopbackRedirectUri: 'http://localhost:1455/auth/callback',
    exchangeDep: 'exchangeManualCallbackCodexCode',
    buildAuthorizationUrl: ({ redirectUri, codeChallenge, state, deps }) =>
      deps.buildCodexAuthorizationUrl({ redirectUri, codeChallenge, state })
  },
  {
    // Codex device-code login (oauth-device) still spawns the CLI and needs its
    // sqlite home pointed at the sandbox; browser login never reaches prepareLogin.
    prepareLogin({ profileDir, envOverrides, deps }) {
      if (!deps.resolveCodexSqliteHome) return;
      const sqliteHome = deps.resolveCodexSqliteHome({ path: deps.path, profileDir });
      if (sqliteHome) envOverrides.CODEX_SQLITE_HOME = sqliteHome;
    }
  }
);

const CLAUDE_STRATEGY = createNativeOauthStrategy({
  logLabel: 'Claude',
  // Claude accepts any localhost loopback redirect; a fixed high port keeps the
  // server stable and distinct from codex's 1455.
  loopbackRedirectUri: 'http://localhost:54545/callback',
  exchangeDep: 'exchangeClaudeOauthCode',
  buildAuthorizationUrl: ({ redirectUri, codeChallenge, state, deps }) =>
    deps.buildClaudeAuthorizationUrl({ redirectUri, codeChallenge, state })
});

// --- code-paste strategy: write an authorization code back into a live CLI ----
// Antigravity keeps its CLI running and reads the authorization code from stdin.

function createCodePasteStrategy(config) {
  return {
    prepareLogin: config.prepareLogin || (() => {}),

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

const AGY_STRATEGY = createCodePasteStrategy({
  // Antigravity's CLI prints "paste the authorization code" once it is ready.
  detectAwaitingCode: (job, deps) => {
    const logs = deps.stripAnsi(job.logs || '');
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
const STRATEGIES = Object.freeze({
  codex: CODEX_STRATEGY,
  claude: CLAUDE_STRATEGY,
  agy: AGY_STRATEGY
});

function resolveLoginStrategy(provider) {
  return STRATEGIES[String(provider || '').trim().toLowerCase()] || DEFAULT_STRATEGY;
}

module.exports = {
  resolveLoginStrategy,
  DEFAULT_STRATEGY,
  CODEX_STRATEGY,
  CLAUDE_STRATEGY,
  AGY_STRATEGY
};
