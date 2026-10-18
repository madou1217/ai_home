'use strict';

// kiro 的模型发现策略（描述符 `models.strategies` 的实现）。
//
// **纯 HTTP 优先**（不碰本地 CLI）：先用内嵌 device-registration / refresh_token 自刷新
// （见 lib/account/kiro-grant-store.js），再按账号的 profileArn 走 **V3 控制面
// ListAvailableModels** 拉**按套餐**的真实清单（FREE 8 / PRO+ 21；见 kiro-model-catalog.js）。
// profileArn 解析顺序 = 凭据 → ListAvailableProfiles → Builder-ID 固定 ARN；企业多 profile
// 无法自动选时回落 V2（旧端点的 3 个）。解析到的（非固定）profileArn 顺手落库，减少重复探测。

const { readAccountCredentialRecord } = require('../server/account-credential-store');
const { compareAndSwapAccountNativeAuth } = require('../server/account-credential-store');
const { ensureFreshKiroGrant } = require('./kiro-grant-store');
const { fetchKiroAvailableModels } = require('./kiro-model-catalog');
const { resolveKiroModelProfileArn, readKiroProfileArn } = require('./kiro-profile');

function createKiroHttpModelDiscovery(options = {}) {
  const readRecord = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const ensureFresh = options.ensureFreshKiroGrant || ensureFreshKiroGrant;
  const fetchModels = options.fetchKiroAvailableModels || fetchKiroAvailableModels;
  const resolveProfileArn = options.resolveKiroModelProfileArn || resolveKiroModelProfileArn;
  const casWrite = options.compareAndSwapAccountNativeAuth || compareAndSwapAccountNativeAuth;

  async function discover(account, timeoutMs) {
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef) return { error: 'kiro_models_missing_account_ref' };
    const record = readRecord(options.fs, options.aiHomeDir, accountRef);
    if (!record || record.provider !== 'kiro') return { error: 'credential_record_missing' };
    const request = (url, init) => (options.fetchWithTimeout
      ? options.fetchWithTimeout(url, init, Math.max(1000, Number(timeoutMs) || 10000))
      : fetch(url, init));
    try {
      const fresh = await ensureFresh(record, {
        fs: options.fs,
        aiHomeDir: options.aiHomeDir,
        accountRef,
        request,
        timeoutMs
      });
      if (fresh.error) return { error: fresh.error };
      const current = fresh.record;
      // profileArn 解析失败/企业歧义不致命：不带它 → fetchModels 自动走 V2 兜底。
      const resolved = await resolveProfileArn(current.nativeAuth, { request, timeoutMs }).catch(() => null);
      const profileArn = resolved && resolved.profileArn ? resolved.profileArn : '';
      if (profileArn && resolved.source === 'listed' && !readKiroProfileArn(current.nativeAuth)) {
        // IdC 列出来的 profileArn 落库（Builder-ID 固定值可免费重算，不落库，避免影响其它链路）。
        try {
          casWrite(options.fs, options.aiHomeDir, accountRef, current,
            { ...current.nativeAuth, profileArn });
        } catch (_error) { /* best-effort：落库失败也用这次解析结果继续 */ }
      }
      const catalog = await fetchModels(current.nativeAuth.auth, { request, timeoutMs, profileArn });
      return { models: catalog.models, defaultModel: catalog.defaultModel };
    } catch (error) {
      return { error: error && error.code || 'kiro_models_discovery_failed' };
    }
  }

  return { discover };
}

module.exports = { createKiroHttpModelDiscovery };
