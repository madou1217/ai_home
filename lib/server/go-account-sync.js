'use strict';

// Node(app-state.db) <-> Go(aih.db) 账号双向同步（Mediator + 周期对账）。
//
// 两个进程各自持有账号库是部署边界；本模块让二者在运行期收敛为同一个账号世界：
//   1. Go -> Node 凭据回写：Go 在推理链路刷新了 OAuth token（refresh_token 会轮换），
//      只在 Go 的代际严格更新时经 CAS 写回 Node，避免 Node 再用已被消费的旧 refresh_token。
//   2. Node -> Go 推送：Node 是账号写入口（WebUI/CLI 登录、导入、删除），新增/变更的账号经
//      Go 管理 API 导入（Go 的路由索引因此即时可见，直接写 aih.db 则要重启才生效）。
//   3. 启停状态与 Provider 默认账号以 Node 为准同步到 Go。
//   4. 删除：只删除本同步建立过映射、且 Node 源账号已消失的 Go 账号；从不删除 Go 独有账号。
//   5. 收养：Go 独有的 Codex/Claude 账号经 sub2api 导出回收进 Node（其余 Provider 仅上报）。
// 顺序即上面编号：先回写再推送，保证推送的永远不是过期凭据。

const crypto = require('node:crypto');

const { readNodeAccounts } = require('../account/go-bridge/node-account-reader');
const { readGoAccounts } = require('../account/go-bridge/go-account-store-reader');
const { translateNodeAccount } = require('../account/go-bridge/go-import-translator');
const { compareAndSwapAccountNativeAuth } = require('./account-credential-store');
const { readJsonValue, writeJsonValue } = require('./app-state-store');

const SYNC_STATE_KEY = 'go-account-sync:state';
const DEFAULT_INTERVAL_MS = 15000;
const ADOPTABLE_PROVIDERS = new Set(['codex', 'claude']);

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// 推送指纹只覆盖账号内容：sub2api 文档的 exported_at 每轮都不同，不能让它触发重复推送。
function planFingerprint(plan) {
  const body = plan.request.body && typeof plan.request.body === 'object' ? { ...plan.request.body } : plan.request.body;
  if (body && typeof body === 'object') delete body.exported_at;
  return fingerprint({ path: plan.request.path, body });
}

function isoToMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// links: nodeRef -> {goRef, print}。一个 Go 账号可被多个 Node 账号映射（Node 视为不同、
// Go 规范化后同一身份）；Go 账号由同步「拥有」当且仅当至少有一条 link 指向它。
function emptyState() {
  return { links: {} };
}

// Go 凭据比 Node 更新时返回写回后的 Node nativeAuth，否则返回 null。
function newerGoNativeAuth(record, goAccount) {
  const go = goAccount.credential || {};
  const native = record.nativeAuth || {};
  if (record.provider === 'codex' && native.auth && native.auth.tokens && go.access_token) {
    const goMs = Number(go.refreshed_at_ms) || 0;
    const nodeMs = isoToMs(native.auth.last_refresh);
    const tokens = native.auth.tokens;
    const differs = tokens.access_token !== go.access_token || tokens.refresh_token !== go.refresh_token || tokens.id_token !== go.id_token;
    if (!differs || goMs <= nodeMs) return null;
    return {
      ...native,
      auth: {
        ...native.auth,
        tokens: { ...tokens, access_token: go.access_token, refresh_token: go.refresh_token, id_token: go.id_token },
        last_refresh: new Date(goMs).toISOString()
      }
    };
  }
  if (record.provider === 'claude' && native.credentials && go.access_token && go.refresh_token) {
    const key = native.credentials.claudeAiOauth ? 'claudeAiOauth' : 'claude_ai_oauth';
    const oauth = native.credentials[key] || {};
    const nodeExpiresAt = Number(oauth.expiresAt || oauth.expires_at) || 0;
    const goExpiresAt = Number(go.expires_at_ms) || 0;
    const differs = (oauth.accessToken || oauth.access_token) !== go.access_token
      || (oauth.refreshToken || oauth.refresh_token) !== go.refresh_token;
    if (!differs || goExpiresAt <= nodeExpiresAt) return null;
    const next = { ...oauth, accessToken: go.access_token, refreshToken: go.refresh_token, expiresAt: goExpiresAt };
    if ('access_token' in oauth) next.access_token = go.access_token;
    if ('refresh_token' in oauth) next.refresh_token = go.refresh_token;
    if ('expires_at' in oauth) next.expires_at = goExpiresAt;
    return { ...native, credentials: { ...native.credentials, [key]: next } };
  }
  if (record.provider === 'agy' && native.oauthToken && native.oauthToken.token && go.access_token) {
    const token = native.oauthToken.token;
    const goMs = Number(go.refreshed_at_ms) || Number(go.expires_at_ms) || 0;
    const nodeMs = Number(token.refreshed_at_ms) || Number(token.expires_at_ms) || 0;
    const differs = token.access_token !== go.access_token || token.refresh_token !== go.refresh_token;
    if (!differs || goMs <= nodeMs) return null;
    return {
      ...native,
      oauthToken: {
        ...native.oauthToken,
        token: {
          ...token,
          access_token: go.access_token,
          refresh_token: go.refresh_token,
          expires_at_ms: Number(go.expires_at_ms) || token.expires_at_ms,
          refreshed_at_ms: Number(go.refreshed_at_ms) || token.refreshed_at_ms
        }
      }
    };
  }
  if (go.native_auth_json && typeof go.native_auth_json === 'object') {
    if (fingerprint(go.native_auth_json) === fingerprint(native)) return null;
    if (goAccount.credentialUpdatedAtMs <= record.nativeAuthUpdatedAt) return null;
    return go.native_auth_json;
  }
  return null;
}

function createGoAccountSync(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const aiHomeDir = deps.aiHomeDir;
  const getClient = typeof deps.getClient === 'function' ? deps.getClient : () => null;
  const log = deps.log || console;
  const intervalMs = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : DEFAULT_INTERVAL_MS;
  const readNode = deps.readNodeAccounts || ((dir) => readNodeAccounts(dir, { fs }));
  const readGo = deps.readGoAccounts || ((dir) => readGoAccounts(dir, { fs }));
  const importStandard = deps.importStandardAccountRecords
    || require('../account/standard-transfer').importStandardAccountRecords;
  const parseStandard = deps.parseStandardAccountRecordsFromJson
    || require('../account/standard-transfer').parseStandardAccountRecordsFromJson;
  let timer = null;
  let running = null;
  let lastResult = null;

  function loadState() {
    const stored = readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY);
    if (!stored || typeof stored !== 'object' || !stored.links || typeof stored.links !== 'object') return emptyState();
    return { links: { ...stored.links } };
  }

  function saveState(state) {
    writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, state);
  }

  async function pushAccount(client, plan, result) {
    const response = await client.send(plan.request);
    let goRef = response.ok && response.data && response.data.account_ref ? String(response.data.account_ref) : '';
    if (!goRef && response.status === 409 && response.errorCode === 'account_conflict' && plan.predictedGoRef) {
      const existing = await client.getAccount(plan.predictedGoRef);
      if (existing.ok) goRef = plan.predictedGoRef;
    }
    if (!goRef) {
      result.errors.push({ account_ref: plan.nodeRef, step: 'push', error: response.errorCode || `http_${response.status}` });
      return '';
    }
    result.pushed += 1;
    return goRef;
  }

  async function reconcileOnce() {
    const client = getClient();
    if (!client) return { skipped: 'go_core_not_ready' };
    const result = { pulled: 0, pushed: 0, enabledChanged: 0, defaultsChanged: 0, deleted: 0, adopted: 0, unsupported: 0, goOnly: [], errors: [] };
    const state = loadState();

    // 1. Go -> Node：只回写 Go 代际严格更新的凭据（CAS，失败即下一轮重试）。
    let source = readNode(aiHomeDir);
    let go = readGo(aiHomeDir);
    const goByRef = new Map(go.accounts.map((account) => [account.accountRef, account]));
    for (const record of source.accounts) {
      const link = state.links[record.accountRef];
      const goAccount = link && goByRef.get(link.goRef);
      if (!goAccount) continue;
      const next = newerGoNativeAuth(record, goAccount);
      if (next && compareAndSwapAccountNativeAuth(fs, aiHomeDir, record.accountRef, record, next)) result.pulled += 1;
    }
    if (result.pulled > 0) source = readNode(aiHomeDir);

    // 2. Node -> Go：内容指纹变化或 Go 缺失时才推送，稳态下零请求。
    const primaryByGoRef = new Map();
    const nodeRefs = new Set();
    for (const record of source.accounts) {
      nodeRefs.add(record.accountRef);
      const plan = translateNodeAccount(record);
      if (plan.kind !== 'import') { result.unsupported += 1; continue; }
      const print = planFingerprint(plan);
      const link = state.links[record.accountRef];
      let goRef = link && link.goRef;
      if (!goRef || !goByRef.has(goRef) || link.print !== print) {
        goRef = await pushAccount(client, plan, result);
        if (!goRef) continue;
        state.links[record.accountRef] = { goRef, print };
      }
      if (!primaryByGoRef.has(goRef)) primaryByGoRef.set(goRef, record);
    }

    // 3. 启停与默认账号以 Node 为准（同一 Go 身份以首个 Node 账号为主）。
    go = readGo(aiHomeDir);
    const goNow = new Map(go.accounts.map((account) => [account.accountRef, account]));
    for (const [goRef, record] of primaryByGoRef) {
      const goAccount = goNow.get(goRef);
      const enabled = record.status !== 'down';
      if (!goAccount || goAccount.enabled === enabled) continue;
      const response = await client.setEnabled(goRef, enabled);
      if (response.ok) result.enabledChanged += 1;
      else result.errors.push({ account_ref: goRef, step: 'enabled', error: response.errorCode });
    }
    for (const [provider, nodeRef] of Object.entries(source.defaults)) {
      const link = state.links[nodeRef];
      const target = link && goNow.get(link.goRef);
      if (!target || !target.enabled || go.defaults[provider] === link.goRef) continue;
      const response = await client.setProviderDefault(provider, link.goRef);
      if (response.ok) result.defaultsChanged += 1;
      else result.errors.push({ provider, step: 'default', error: response.errorCode });
    }

    // 4. 删除：Node 源账号已消失的 link 视为孤儿。Go 账号仍被其它 link 指向则只摘 link；
    //    否则删除 Go 账号，且只有删除成功（或 Go 已无此账号）才摘 link——删除失败时保留 link
    //    下一轮重试，绝不能让孤儿在下一轮被第 5 步当作「Go 独有账号」收养回 Node（复活已删账号）。
    const liveGoRefs = new Set();
    for (const [nodeRef, link] of Object.entries(state.links)) if (nodeRefs.has(nodeRef)) liveGoRefs.add(link.goRef);
    for (const [nodeRef, link] of Object.entries(state.links)) {
      if (nodeRefs.has(nodeRef)) continue;
      if (liveGoRefs.has(link.goRef) || !goNow.has(link.goRef)) { delete state.links[nodeRef]; continue; }
      const response = await client.deleteAccount(link.goRef);
      if (response.ok || response.status === 404) {
        delete state.links[nodeRef];
        goNow.delete(link.goRef);
        result.deleted += 1;
      } else {
        result.errors.push({ account_ref: link.goRef, step: 'delete', error: response.errorCode });
      }
    }
    const linkedGoRefs = new Set(Object.values(state.links).map((link) => link.goRef));

    // 5. 收养：Go 独有账号（例如经 Go CLI 导入）回收进 Node；下一轮推送会建立 link。
    for (const account of goNow.values()) {
      if (linkedGoRefs.has(account.accountRef)) continue;
      if (!ADOPTABLE_PROVIDERS.has(account.provider)) { result.goOnly.push(account.accountRef); continue; }
      const exported = await client.exportSub2api(account.accountRef);
      if (!exported.ok || !exported.data) {
        result.errors.push({ account_ref: account.accountRef, step: 'adopt_export', error: exported.errorCode });
        continue;
      }
      const summary = importStandard({ fs, aiHomeDir, records: parseStandard(exported.data), source: 'go_account_sync' });
      if (summary && (summary.imported > 0 || summary.duplicates > 0)) result.adopted += 1;
      else result.errors.push({ account_ref: account.accountRef, step: 'adopt_import', error: 'node_import_rejected' });
    }

    saveState(state);
    return result;
  }

  async function reconcile() {
    if (running) return running;
    running = reconcileOnce()
      .then((result) => { lastResult = { at: new Date().toISOString(), ...result }; return lastResult; })
      .catch((error) => {
        lastResult = { at: new Date().toISOString(), failed: true, error: String(error && error.message || error) };
        log.error(`\x1b[31m[aih:go-sync]\x1b[0m reconcile failed: ${lastResult.error}`);
        return lastResult;
      })
      .finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { reconcile(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    reconcile();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (running) await running;
  }

  return { reconcile, start, stop, status: () => lastResult };
}

module.exports = {
  SYNC_STATE_KEY,
  createGoAccountSync,
  newerGoNativeAuth
};
