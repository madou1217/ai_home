'use strict';

// Node <-> Go 账号桥的真实联调夹具：构建（或复用）真实 aih-server 二进制，并用 Node 自己的
// 注册/凭据 API 写出一组覆盖各认证形态的 Node 账号。缺少 Go 工具链时返回 null，由调用方显式 skip。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveGoServerBinary } = require('../../lib/cli/services/server/go-core-supervisor');

const REPOSITORY_ROOT = path.join(__dirname, '..', '..');
let cachedBinary;

function ensureGoServerBinary() {
  if (cachedBinary !== undefined) return cachedBinary;
  const binary = resolveGoServerBinary({ repositoryRoot: REPOSITORY_ROOT });
  const probe = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    cachedBinary = fs.existsSync(binary) ? binary : null;
    return cachedBinary;
  }
  const build = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts', 'build-go-server.js')], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8'
  });
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr || build.stdout}`);
  cachedBinary = binary;
  return cachedBinary;
}

function jwt(claims) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

function codexAuth({ userId, workspace, explicit, email, suffix, lastRefresh }) {
  const auth = {
    'https://api.openai.com/auth': {
      chatgpt_user_id: userId,
      chatgpt_plan_type: 'team',
      ...(workspace ? { chatgpt_account_id: workspace } : {})
    }
  };
  const tokens = {
    id_token: jwt({ sub: userId, email, ...auth }),
    access_token: jwt({ exp: 4102444800, ...auth, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
    refresh_token: `rt-${suffix}`
  };
  if (explicit !== undefined) tokens.account_id = explicit;
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: lastRefresh || '2026-09-20T08:00:00.000Z' };
}

function sha16(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * 写出一组覆盖全部迁移分支的 Node 账号，返回各账号的 Node accountRef。
 * 使用 Node 的真实注册与凭据存储，因此 app-state.db 与生产形态一致。
 */
function seedNodeAccounts(aiHomeDir) {
  const { registerAccountIdentity } = require('../../lib/account/account-registration');
  const { writeAccountNativeAuth, writeAccountCredentials } = require('../../lib/server/account-credential-store');
  const { createAccountStateIndex } = require('../../lib/account/state-index');
  const { writeDefaultAccountRef } = require('../../lib/account/default-account-store');

  const register = (provider, cliAccountId, identitySeed) => registerAccountIdentity(fs, aiHomeDir, {
    provider, cliAccountId, identitySeed
  }).accountRef;

  const refs = {};
  refs.codexTeam = register('codex', '1', 'oauth:codex:user-team');
  writeAccountNativeAuth(fs, aiHomeDir, refs.codexTeam, {
    auth: codexAuth({ userId: 'user-team', workspace: 'ws-team', email: 'team@example.com', suffix: 'team' })
  });

  refs.codexExplicit = register('codex', '2', 'oauth:codex:user-personal');
  writeAccountNativeAuth(fs, aiHomeDir, refs.codexExplicit, {
    auth: codexAuth({ userId: 'user-personal', explicit: 'ws-explicit', email: 'me@example.com', suffix: 'personal' })
  });

  refs.codexConflict = register('codex', '3', 'oauth:codex:user-conflict');
  writeAccountNativeAuth(fs, aiHomeDir, refs.codexConflict, {
    auth: codexAuth({ userId: 'user-conflict', workspace: 'ws-a', explicit: 'ws-b', email: 'c@example.com', suffix: 'conflict' })
  });

  refs.codexKey = register('codex', '4', `api_key:codex:https://relay.example.com/v1:${sha16('sk-relay')}`);
  writeAccountCredentials(fs, aiHomeDir, refs.codexKey, {
    OPENAI_API_KEY: 'sk-relay',
    OPENAI_BASE_URL: 'https://relay.example.com/v1/',
    OPENAI_WIRE_API: 'responses'
  });

  // Node 把「空 baseUrl」与「官方地址」视为两个账号；Go 规范化后是同一身份 -> 归并。
  refs.codexOfficialEmpty = register('codex', '5', `api_key:codex::${sha16('sk-official')}`);
  writeAccountCredentials(fs, aiHomeDir, refs.codexOfficialEmpty, { OPENAI_API_KEY: 'sk-official' });
  refs.codexOfficialExplicit = register('codex', '6', `api_key:codex:https://api.openai.com/v1:${sha16('sk-official')}`);
  writeAccountCredentials(fs, aiHomeDir, refs.codexOfficialExplicit, {
    OPENAI_API_KEY: 'sk-official',
    OPENAI_BASE_URL: 'https://api.openai.com/v1'
  });

  refs.claudeOauth = register('claude', '1', 'oauth:claude:uuid:11111111-1111-4111-8111-111111111111');
  writeAccountNativeAuth(fs, aiHomeDir, refs.claudeOauth, {
    credentials: {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat-access',
        refreshToken: 'sk-ant-ort-refresh',
        expiresAt: 4102444800000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        account: { uuid: '11111111-1111-4111-8111-111111111111', emailAddress: 'claude@example.com' }
      }
    }
  });

  refs.claudeKey = register('claude', '2', `api_key:claude::${sha16('sk-ant-api')}`);
  writeAccountCredentials(fs, aiHomeDir, refs.claudeKey, { ANTHROPIC_API_KEY: 'sk-ant-api' });

  refs.claudeToken = register('claude', '3', `auth_token:claude:https://gateway.example.com/anthropic:${sha16('tok-gw')}`);
  writeAccountCredentials(fs, aiHomeDir, refs.claudeToken, {
    ANTHROPIC_AUTH_TOKEN: 'tok-gw',
    ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic',
    AIH_CLAUDE_CREDENTIAL_TYPE: 'auth-token'
  });

  refs.agy = register('agy', '1', 'oauth:agy:agy@example.com');
  writeAccountNativeAuth(fs, aiHomeDir, refs.agy, {
    email: 'agy@example.com',
    oauthToken: {
      auth_method: 'consumer',
      token: {
        access_token: 'ya29.agy-access',
        refresh_token: '1//agy-refresh',
        expires_at_ms: 4102444800000,
        refreshed_at_ms: 1790000000000,
        token_type: 'Bearer'
      }
    }
  });

  refs.opencodeKey = register('opencode', '1', `api_key:opencode::${sha16('oc-key')}`);
  writeAccountCredentials(fs, aiHomeDir, refs.opencodeKey, { OPENCODE_API_KEY: 'oc-key' });

  const stateIndex = createAccountStateIndex({ fs, aiHomeDir });
  stateIndex.upsertAccountState(refs.claudeKey, 'claude', { status: 'down' });
  if (typeof stateIndex.close === 'function') stateIndex.close();

  writeDefaultAccountRef(fs, aiHomeDir, 'codex', refs.codexTeam);
  writeDefaultAccountRef(fs, aiHomeDir, 'claude', refs.claudeOauth);
  return refs;
}

module.exports = {
  codexAuth,
  ensureGoServerBinary,
  jwt,
  seedNodeAccounts
};
