'use strict';

// zcode 的凭据落盘 —— **两条登录路径共用的唯一实现**。
//
// 从 lib/server/web-account-auth.js 抽出来的（那个文件 1868 行、主体是 1740 行的
// createAuthJobManager，zcode/agy/kiro 的登录逻辑全塞在里面）。抽出的理由不是行数，
// 是**冲突**：并行会话反复覆盖那个主文件，每次都要重放这段代码。zcode 专属逻辑
// 独立成模块后，改 zcode 登录不再需要碰主文件。
//
// 两条路径：
//   * cli-flow（服务端中介 CLI 流程）→ writeZcodeOauthCredentials
//   * custom-scheme（zcode:// 手填回调）→ exchangeZcodeOauthCode
//
// 两者产出的 credentials.json 必须**逐字节一致**，读取路径才零适配；因此区域键前缀
// 的拼装、加密、PAT 换取、项目定位键、artifact 校验都在这里做一次，不在调用方重复。
//
// 所有外部依赖显式注入（不 require 主文件、不读闭包），因此这个模块可以被独立加载与
// 单测，也不会因为主文件被回滚而失效。

const path = require('node:path');
const { ZCODE_CREDENTIAL_KEYS, encryptZcodeCredentialValue } = require('../account/zcode-credential');
const { createBusinessTokenResolver } = require('./business-token-resolver');
const { resolveZcodeRegion } = require('./zcode-region');
const { resolveZcodeProjectKeyLocation } = require('./zcode-project-key-location');
const { normalizeString, compactLogText } = require('./web-account-auth-utils');

// token 交换端点（cli-flow 与 custom-scheme 共用）。
const ZCODE_OAUTH_TOKEN_URL = 'https://zcode.z.ai/api/v1/oauth/token';
// 业务 token（PAT）换取入口：登录时用它把 access_token 换成长期凭据再落盘。
const ZCODE_BUSINESS_LOGIN_URL = 'https://api.z.ai/api/auth/z/login';

/**
 * 创建 zcode 凭据写入器。
 *
 * @param {object} deps 显式依赖（全部由 createAuthJobManager 注入）
 * @param {object} deps.fs
 * @param {Function} deps.fetchImpl            标准 fetch；缺失时降级为「不换 PAT」
 * @param {Function} deps.appendJobLog         (job, text) => void
 * @param {Function} deps.finalizeJob          (job, status, error, code) => Promise|void
 * @param {Function} [deps.verifyOauthJobCompleted] (job, credentials) => {ok, email, displayName}
 * @param {Function} deps.hasOauthCompletionArtifacts (job, fs) => boolean
 */
function createZcodeCredentialWriter(deps = {}) {
  const fs = deps.fs;
  const fetchImpl = deps.fetchImpl;
  const appendJobLog = deps.appendJobLog;
  const finalizeJob = deps.finalizeJob;
  const verifyOauthJobCompleted = deps.verifyOauthJobCompleted;
  const hasOauthCompletionArtifacts = deps.hasOauthCompletionArtifacts;

  /** 把凭据写到 job.configDir 下的 v2/credentials.json（两条路径唯一的写盘点）。 */
  function writeCredentialsFile(job, credentials) {
    const credentialsPath = path.join(job.configDir, 'v2', 'credentials.json');
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
    return credentialsPath;
  }

  /** 落盘后的公共收尾：artifact 校验 → 账号状态识别 → 收尾。 */
  async function finishCredentials(job, credentials, options = {}) {
    if (!hasOauthCompletionArtifacts(job, fs)) {
      job.error = 'oauth_artifact_verification_failed';
      job.updatedAt = Date.now();
      appendJobLog(job, '写入后未通过本地 OAuth artifact 校验。');
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'oauth_artifact_verification_failed', job };
    }
    if (typeof verifyOauthJobCompleted === 'function') {
      appendJobLog(job, '开始执行账号状态识别校验。');
      const verified = await Promise.resolve(verifyOauthJobCompleted(job, credentials));
      if (!verified || verified.ok === false) {
        const reason = String(verified && (verified.message || verified.code) || 'oauth_completion_verification_failed');
        job.error = reason;
        job.updatedAt = Date.now();
        appendJobLog(job, `账号状态识别失败：${compactLogText(reason)}`);
        finalizeJob(job, 'failed', reason, 1);
        return { ok: false, code: 'oauth_completion_verification_failed', job };
      }
      if (verified.email) job.email = String(verified.email || '').trim();
      if (verified.displayName) job.displayName = String(verified.displayName || '').trim();
      appendJobLog(job, '账号状态识别通过。');
    }
    job.browserCallbackForwardedAt = Date.now();
    job.updatedAt = Date.now();
    appendJobLog(job, options.doneLog || 'ZCode OAuth 授权完成。');
    await finalizeJob(job, 'succeeded', '', 0);
    return { ok: true, job };
  }

  /** 由 tokenSet 解析出的 user 写入账号标识（两条路径同口径）。 */
  function applyUserIdentity(job, user) {
    if (!user) return;
    job.email = normalizeString(user.email || user.user_id || user.userId || '');
    job.displayName = normalizeString(user.name || user.email || '');
    if (job.email) appendJobLog(job, `已解析账号标识：${job.email}`);
  }

  // Z.ai 的 token 交换走桌面版同款业务包装响应：{ code, msg, data }。
  // data.token 是 zcode JWT（zcodejwttoken），data.zai.access_token 才是
  // provider access token；两者缺一即视为交换失败。写盘格式与 ZCode 原生运行时
  // 的 saveZaiLoginCredentials 完全一致（值经 encryptZcodeCredentialValue
  // 加密），这样 CLI / aih 的读取路径无需任何适配。
  // cli-flow（服务端中介）与 custom-scheme（zcode:// 手填回调）都走这里，
  // 保证产出的 credentials.json 逐字节一致，读取路径零适配。
  // 区域决定键前缀（zai / bigmodel）与 active_provider。
  async function writeZcodeOauthCredentials(job, result) {
    if (!job) return { ok: false, code: 'job_not_found', job };
    const tokenSet = result && result.tokenSet ? result.tokenSet : {};
    const rawAccessToken = normalizeString(tokenSet.accessToken);
    const zcodeJwtToken = normalizeString(tokenSet.zcodeJwtToken);
    const refreshToken = normalizeString(tokenSet.refreshToken);
    // **登录时就把 access_token 换成业务 token(PAT) 再落盘** —— 与桌面端一致。
    // 桌面端 exchangeToken 的返回值是
    //   { accessToken: await businessTokenResolver.resolve(data.zai.access_token), ... }
    // 即存的**不是**原始 access_token（它只有 4 小时寿命），而是换取后的长期凭据。
    // 真机对照：桌面端手工登录两天仍正常；aih 存原始 token 则 4 小时后被桌面端判
    // 「login JWT expired」并清空凭据、要求重新登录。这是本函数此前漏做的一步。
    let accessToken = rawAccessToken;
    let accessTokenKind = 'raw';
    if (rawAccessToken && typeof fetchImpl === 'function') {
      try {
        const resolver = createBusinessTokenResolver({
          loginUrl: ZCODE_BUSINESS_LOGIN_URL,
          // fetchImpl 是标准 fetch(url, init)；resolver 的 timeoutMs 由它自己的信号控制。
          request: (url, init) => fetchImpl(url, init)
        });
        const pat = await resolver.resolve(rawAccessToken);
        if (pat) { accessToken = pat; accessTokenKind = 'business_token'; }
      } catch (error) {
        // 换取失败不阻断登录：仍写入原始 token（至少额度面可用），
        // 但如实记日志，便于排查「为什么几小时后要重新登录」。
        appendJobLog(job, `业务 token 换取失败（将写入原始 access_token，寿命约 4 小时）：${compactLogText((error && error.code) || (error && error.message))}`);
      }
    }
    appendJobLog(job, `凭据形态：${accessTokenKind === 'business_token' ? '业务 token（长期）' : '原始 access_token（约 4 小时）'}`);
    const user = result && result.user && typeof result.user === 'object' ? result.user : null;
    // 缺 data.token 或 provider access_token 一律视为失败：半截凭据写盘后
    // 只会在后续请求里以更难定位的方式暴露。
    if (!zcodeJwtToken || !accessToken) {
      job.error = 'token_exchange_missing_tokens';
      job.updatedAt = Date.now();
      appendJobLog(job, '授权成功但响应缺少 data.token 或 provider access_token。');
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_missing_tokens', job };
    }
    try {
      const region = resolveZcodeRegion(
        (result && result.region && result.region.provider)
        || (job._sessionFlow && job._sessionFlow.region && job._sessionFlow.region.provider)
        || job.zcodeRegion
      );
      const credentials = {
        [ZCODE_CREDENTIAL_KEYS.ACTIVE_PROVIDER]: encryptZcodeCredentialValue(region.provider),
        [region.accessTokenKey]: encryptZcodeCredentialValue(accessToken),
        [ZCODE_CREDENTIAL_KEYS.ZCODE_JWT_TOKEN]: encryptZcodeCredentialValue(zcodeJwtToken)
      };
      if (refreshToken) credentials[region.refreshTokenKey] = encryptZcodeCredentialValue(refreshToken);
      if (user) credentials[region.userInfoKey] = encryptZcodeCredentialValue(JSON.stringify(user));
      // 项目定位键（`project-key-location:v1:…`）：记下用哪个 org/project/apiKey 签 PAT，
      // 免得每次推理重新发现一遍。桌面端手工登录后 credentials.json 里就有这个键，
      // aih 此前漏写。**它是附加产物**：拿不到就不写，登录照常成功（见下方日志）。
      const projectKeyLocation = await resolveZcodeProjectKeyLocation({
        origin: region.apiOrigin,
        family: region.provider,
        accountId: normalizeString(user && (user.id || user.user_id || user.userId)),
        // 用**原始** access_token 打 biz 面（此时 accessToken 可能已换成 PAT，
        // 而 PAT 不是 biz API 认的凭据）。
        loginToken: rawAccessToken,
        authScheme: region.bizAuthScheme,
        request: typeof fetchImpl === 'function' ? (url, init) => fetchImpl(url, init) : null,
        observe: (event) => appendJobLog(job, `项目定位键未写入：${compactLogText(event && event.code)}`)
      });
      if (projectKeyLocation) {
        credentials[projectKeyLocation.key] = encryptZcodeCredentialValue(projectKeyLocation.value);
      }
      const credentialsPath = writeCredentialsFile(job, credentials);
      appendJobLog(job, `授权区域：${region.label}（provider=${region.provider}）`);
      if (projectKeyLocation) appendJobLog(job, '已写入项目定位键（project-key-location）。');
      appendJobLog(job, `credentials.json 已写入：${credentialsPath}`);
      applyUserIdentity(job, user);
      return await finishCredentials(job, credentials);
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `凭据写入异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  /**
   * custom-scheme 路径：拿浏览器回调里的 code 向 Z.ai token endpoint 换 token。
   * 换到的 tokenSet 直接交给 writeZcodeOauthCredentials —— 与 cli-flow 同一个写盘点，
   * 因此两条路径产出的 credentials.json 结构不会分叉。
   */
  async function exchangeZcodeOauthCode(job, code, redirectUri) {
    if (!job || !job._manualCallbackOauth) {
      return { ok: false, code: 'callback_not_supported', job };
    }
    const authCode = normalizeString(code);
    if (!authCode) return { ok: false, code: 'invalid_callback_url', job };
    const tokenRedirectUri = normalizeString(redirectUri);
    if (!tokenRedirectUri) return { ok: false, code: 'invalid_callback_redirect', job };
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }
    appendJobLog(job, '开始向 Z.ai token endpoint 换取 OAuth token。');

    try {
      const response = await fetchImpl(ZCODE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'zai',
          code: authCode,
          redirect_uri: tokenRedirectUri,
          state: job.oauthState
        })
      });
      const rawText = await response.text().catch(() => '');
      appendJobLog(job, `Z.ai token endpoint 返回 HTTP ${response.status || 0}。`);
      if (!response.ok) {
        job.error = rawText || `token_exchange_failed_${response.status}`;
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 失败：${compactLogText(job.error) || 'empty_response'}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', statusCode: response.status, job };
      }
      const payload = rawText ? JSON.parse(rawText) : {};
      if (payload && payload.code !== undefined && payload.code !== 0) {
        job.error = normalizeString(payload.msg) || 'token_exchange_rejected';
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 被拒绝：${compactLogText(job.error)}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', job };
      }
      const data = payload && typeof payload.data === 'object' && payload.data ? payload.data : payload;
      // bigmodel 变体与 zai 变体结构相同，仅子键名不同；兼容地取。
      const providerTokens = data.zai && typeof data.zai === 'object'
        ? data.zai
        : (data.bigmodel && typeof data.bigmodel === 'object' ? data.bigmodel : {});
      const jwtToken = normalizeString(data.token);
      const accessToken = normalizeString(providerTokens.access_token);
      const refreshToken = normalizeString(providerTokens.refresh_token);
      const user = data.user && typeof data.user === 'object' ? data.user : null;
      appendJobLog(
        job,
        `token 响应字段：jwt=${Boolean(jwtToken)} access=${Boolean(accessToken)} refresh=${Boolean(refreshToken)} user=${Boolean(user)}`
      );
      if (!jwtToken || !accessToken) {
        job.error = 'token_exchange_missing_tokens';
        job.updatedAt = Date.now();
        appendJobLog(job, 'token exchange 成功但响应缺少 data.token 或 data.zai.access_token。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_missing_tokens', job };
      }
      // 交给与 cli-flow 同一个写入器：区域键前缀、加密、PAT 换取、项目定位键、
      // artifact 校验全部复用，两条路径不会各自演化。
      return await writeZcodeOauthCredentials(job, {
        tokenSet: { accessToken, zcodeJwtToken: jwtToken, refreshToken },
        user,
        region: { provider: 'zai' }
      });
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `token exchange 异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  return { writeZcodeOauthCredentials, exchangeZcodeOauthCode };
}

module.exports = {
  ZCODE_OAUTH_TOKEN_URL,
  ZCODE_BUSINESS_LOGIN_URL,
  createZcodeCredentialWriter
};
