'use strict';

/**
 * Gemini launch isolation (OAuth only).
 *
 * Gemini keys its whole base directory off `GEMINI_CLI_HOME` (falling back to
 * `~/.gemini`): per-account `oauth_creds.json` / `google_accounts.json` /
 * `projects.json` live there, while the shared session pieces (`history`, `tmp`,
 * `settings.json`, `installation_id`) are symlinked back to the real `~/.gemini`
 * by the existing session-store step. So isolation = per-account `GEMINI_CLI_HOME`
 * pointing at `<sandbox>/.gemini`; no HOME/XDG override is needed (Gemini reads
 * `GEMINI_CLI_HOME`, not HOME, for its base dir).
 *
 * Verified: with `GEMINI_CLI_HOME=<account>/.gemini` and the real HOME, Gemini
 * loads the per-account OAuth credentials without a re-login prompt.
 *
 * @typedef {import('./home-redirect-strategy').SandboxLaunchContext} SandboxLaunchContext
 * @typedef {import('./home-redirect-strategy').SandboxEnvPatch} SandboxEnvPatch
 */

/**
 * @param {SandboxLaunchContext} ctx
 * @returns {SandboxEnvPatch}
 */
function buildEnvPatch(ctx) {
  const { sandboxDir, path } = ctx;
  const geminiDir = path.join(sandboxDir, '.gemini');
  return {
    set: {
      GEMINI_CLI_HOME: geminiDir,
      // Preserve the historical system-settings pointer (same path the fake-HOME
      // setup resolved to). settings.json itself is a symlink to the shared
      // ~/.gemini/settings.json, so settings stay共用.
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(geminiDir, 'settings.json')
    },
    unset: []
  };
}

/**
 * ACP 认证方法（`gemini --acp` 的 initialize 列出 oauth-personal / gemini-api-key / vertex-ai /
 * gateway，2026-10-31 实测）。ACP 模式不按环境变量自动选认证，必须显式 authenticate，
 * 否则走设置里的默认（OAuth）——Vertex/API Key 账号的请求会绕过配置的接入点直打 Google。
 * 账号形态由账号库 env 决定：Vertex 字段 → vertex-ai；只有 API Key → gemini-api-key；
 * 都没有（OAuth 投影）→ 不显式认证，沿用 CLI 自身的 OAuth 凭据。
 */
function resolveAcpAuthMethod(ctx = {}) {
  const env = ctx.accountEnv && typeof ctx.accountEnv === 'object' ? ctx.accountEnv : {};
  const has = (key) => Boolean(String(env[key] || '').trim());
  if (has('VERTEX_AI_PROJECT_ID') || has('VERTEX_AI_LOCATION')
    || String(env.GOOGLE_GENAI_USE_VERTEXAI || '').trim().toLowerCase() === 'true') return 'vertex-ai';
  if (has('GEMINI_API_KEY') || has('GOOGLE_API_KEY')) return 'gemini-api-key';
  return '';
}

const geminiStrategy = Object.freeze({
  name: 'gemini-shared-sessions',
  buildEnvPatch,
  resolveAcpAuthMethod
});

module.exports = { geminiStrategy, resolveAcpAuthMethod };
