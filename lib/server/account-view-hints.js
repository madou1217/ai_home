'use strict';

// **账号视图提示注册表**（Table-Driven Mapping）。
//
// 账号视图（`webui-account-live.js`）绝大多数逻辑是 provider 无关的；少数 provider 有自己的
// 视图特例（agy 的 OAuth 元数据与额度视图、codex 的桌面端标记与 workspace 字段、kimi 的手机号
// 作为显示名）。这些特例**按 provider 注册成数据/函数**，视图层只调本模块的具名入口，
// 不再写 `if (provider === '…')`。
//
// 每个入口都提供「默认实现 + provider 覆盖」两态，调用方不需要判 provider。

const { readAgyAuthMetadata } = require('../account/agy-auth-metadata');
const { buildAgyEffectiveUsageView } = require('./agy-account-usage-view');
const { resolveCodexWorkspaceFields } = require('../account/codex-auth-metadata');
const { resolveKiroLoginType } = require('../account/kiro-account-label');
const { refreshZcodeAccountIdentity } = require('../account/zcode-profile');

function text(value) {
  return String(value == null ? '' : value).trim();
}

// 显示名的**通用槽位**（顺序即优先级，调用方按此顺序交给 pickOauthDisplayName）：
//   1) 元数据里的邮箱  2) OAuth 元数据里的邮箱  3) 运行时账号的显示名
// 之后是视图层自己的通用尾巴（fastPresence/cached/runtime email/state），不在这里。
function defaultDisplayNameHead(ctx) {
  return [
    ctx.metadataEmail,
    ctx.authMetadataEmail,
    ctx.runtimeAccountDisplayName
  ];
}

const VIEW_HINTS = Object.freeze({
  // agy：凭据是 Google OAuth，额度要按 agy 的口径换算；未持 refresh_token 时不可调度。
  agy: {
    readAuthMetadata: ({ credentialRecord, accountRef }) => readAgyAuthMetadata({ credentialRecord, accountRef }),
    buildUsageView: (ctx) => buildAgyEffectiveUsageView({
      usageSnapshot: ctx.usageSnapshot,
      runtimeState: ctx.runtimeState,
      account: ctx.account
    }),
    authMetadataEmail: (authMetadata) => authMetadata && authMetadata.email,
    resolveSchedulableOverride: ({ configured, runtimeAccount, source }) => (
      configured && !runtimeAccount && !Boolean(source && source.hasRefreshToken)
        ? { status: 'blocked_by_policy', reason: 'agy_access_token_required' }
        : null
    )
  },
  // codex：桌面端（ChatGPT App）注册的账号在列表里要标 isMobile；auth.json 回退身份不得
  // 覆盖已持久化的身份；OAuth 账号要带 workspace_id / workspaceError。
  codex: {
    // 桌面端账号 ref 的读法由调用方注入（它住在视图层，注入避免循环依赖）。
    resolveRoleFlags: ({ aiHomeDir, accountRef, readDesktopAccountRef }) => ({
      isMobile: typeof readDesktopAccountRef === 'function'
        && readDesktopAccountRef(aiHomeDir) === String(accountRef)
    }),
    shouldDeferAuthJsonIdentity: ({ usageSnapshot, hasPersistedIdentity }) => Boolean(
      usageSnapshot
      && text(usageSnapshot.fallbackSource) === 'auth_json'
      && hasPersistedIdentity
    ),
    displayNameHead: (ctx) => [
      ctx.deferredIdentity ? null : ctx.metadataEmail,
      ...defaultDisplayNameHead(ctx).slice(1)
    ],
    decorateRecord: ({ record, credentialRecord }) => {
      const nativeAuth = credentialRecord && credentialRecord.nativeAuth;
      const workspace = resolveCodexWorkspaceFields(nativeAuth && nativeAuth.auth);
      if (workspace.workspaceId) record.workspaceId = workspace.workspaceId;
      if (workspace.workspaceError) record.workspaceError = workspace.workspaceError;
    }
  },
  // kimi：显示名优先用手机号（WebUI 上比邮箱更容易认人）。
  kimi: {
    displayNameHead: (ctx) => [ctx.phone, ...defaultDisplayNameHead(ctx)]
  },
  // kiro：登录方式（Google / GitHub / Builder ID / IdC / Desktop）是账号元数据，
  // 只作为标签下发，绝不参与 displayName 或标题。
  kiro: {
    loginType: ({ credentialRecord }) => resolveKiroLoginType(credentialRecord && credentialRecord.nativeAuth)
  },
  // zcode：bigmodel 的 user_info 常缺手机号，账号页 hydration 时用客户信息接口异步补全。
  // 这是**身份补全**，不是用量探测；失败静默，结果 CAS 写回凭据后下一次构建即可用。
  zcode: {
    refreshIdentity: (ctx) => refreshZcodeAccountIdentity({
      fs: ctx.fs,
      aiHomeDir: ctx.aiHomeDir,
      accountRef: ctx.accountRef,
      record: ctx.credentialRecord,
      request: ctx.request,
      nowMs: ctx.nowMs,
      timeoutMs: ctx.timeoutMs
    })
  }
});

function getAccountViewHints(providerRaw) {
  const provider = text(providerRaw).toLowerCase();
  return VIEW_HINTS[provider] || null;
}

function readViewAuthMetadata(provider, ctx) {
  const hints = getAccountViewHints(provider);
  return hints && typeof hints.readAuthMetadata === 'function' ? hints.readAuthMetadata(ctx) : null;
}

// 账号类型/登录方式（目前 kiro）：只做元数据标签，不参与展示名。
function readViewLoginType(provider, ctx) {
  const hints = getAccountViewHints(provider);
  return hints && typeof hints.loginType === 'function'
    ? text(hints.loginType(ctx))
    : '';
}

// 身份补全（异步、best-effort）：只有声明了 refreshIdentity 的 provider 会真的发请求。
function refreshViewIdentity(provider, ctx) {
  const hints = getAccountViewHints(provider);
  return hints && typeof hints.refreshIdentity === 'function'
    ? Promise.resolve(hints.refreshIdentity(ctx))
    : Promise.resolve({ skipped: true, reason: 'unsupported' });
}

function buildViewUsageView(provider, ctx) {
  const hints = getAccountViewHints(provider);
  return hints && typeof hints.buildUsageView === 'function' ? hints.buildUsageView(ctx) : null;
}

function resolveRoleFlagsExtras(provider, ctx, { aiHomeDir, accountRef, readDesktopAccountRef }) {
  const hints = getAccountViewHints(provider);
  const extras = hints && typeof hints.resolveRoleFlags === 'function'
    ? hints.resolveRoleFlags({ ctx, aiHomeDir, accountRef, readDesktopAccountRef })
    : null;
  return { isMobile: Boolean(extras && extras.isMobile) };
}

function shouldDeferAuthJsonIdentity(provider, ctx) {
  const hints = getAccountViewHints(provider);
  return Boolean(hints
    && typeof hints.shouldDeferAuthJsonIdentity === 'function'
    && hints.shouldDeferAuthJsonIdentity(ctx));
}

function buildDisplayNameCandidates(provider, ctx) {
  const hints = getAccountViewHints(provider);
  const head = hints && typeof hints.displayNameHead === 'function'
    ? hints.displayNameHead(ctx)
    : defaultDisplayNameHead(ctx);
  return head;
}

// OAuth 元数据里的邮箱槽位（默认没有）。
function resolveAuthMetadataEmail(provider, authMetadata) {
  const hints = getAccountViewHints(provider);
  return hints && typeof hints.authMetadataEmail === 'function'
    ? hints.authMetadataEmail(authMetadata)
    : null;
}

function hasViewRefreshToken(provider, source) {
  const hints = getAccountViewHints(provider);
  return Boolean(hints && source && source.hasRefreshToken);
}

function resolveSchedulableOverride(provider, ctx) {
  const hints = getAccountViewHints(provider);
  return hints && typeof hints.resolveSchedulableOverride === 'function'
    ? hints.resolveSchedulableOverride(ctx)
    : null;
}

function decorateAccountRecord(provider, ctx) {
  const hints = getAccountViewHints(provider);
  if (hints && typeof hints.decorateRecord === 'function') hints.decorateRecord(ctx);
}

module.exports = {
  buildDisplayNameCandidates,
  buildViewUsageView,
  decorateAccountRecord,
  getAccountViewHints,
  hasViewRefreshToken,
  readViewAuthMetadata,
  readViewLoginType,
  refreshViewIdentity,
  resolveAuthMetadataEmail,
  resolveRoleFlagsExtras,
  resolveSchedulableOverride,
  shouldDeferAuthJsonIdentity
};
