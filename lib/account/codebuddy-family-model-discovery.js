'use strict';

// CodeBuddy / WorkBuddy 家族的**模型目录 HTTP 通道（不依赖本机客户端）**。
//
// 背景（2026-10-15 事故的另一半）：家族的模型发现原先只有「解析桌面发行版 App 内嵌运行时
// 的 `--help`」一条路（见 lib/server/workbuddy-model-discovery.js）。那条路要求本机装了对应
// 发行版 App —— 没装 App 的机器（服务器 / CI / 只装了独立 CLI 的机器）模型目录永远空，
// 账号在账号页与路由里都表现为「没有可用的模型」，而原因只写在描述符的 clientFreeReason 里。
//
// 实测（2026-10-15，本机真实账号）：CLI 自己拿到的「当前支持」清单来自云端 `/v3/config`，
// 与 `--help` 的 `Currently supported:` 是同源同一份：
//
//   GET {site}/v3/config
//     Authorization: Bearer <共享 .info 里的 accessToken>
//     User-Agent: <真实客户端 UA>、Origin/Referer: {site}、X-Requested-With: XMLHttpRequest
//   200 → {"code":0,"msg":"OK","requestId":"…","data":{
//            "agents":[{"name":"cli","commands":[…],"models":["default-model",…]}, …],
//            "models":[{"id":"default-model","name":"Auto","supportsImages":true,…}, …]}}
//
// 三条要点：
//   1. **`data.agents[name=cli].models` 就是「当前支持」清单**（四支实测：workbuddy 19 条、
//      workbuddycn 18 条；同账号重复请求结果稳定），所以取它而不是 `data.models`
//      ——后者是站点全集，含当前账号/套餐不可用的条目。
//   2. `data.models[].id` 只作回退：agent 清单缺席（云端结构调整）时至少不空手。
//   3. **无凭据拿不到清单**：不带 Authorization 时同一端点返回 200 但 `agents[].models`/`models`
//      为空。因此这条通道仍是账号级的——只是不再需要本机装 App/CLI。
//
// 与 CLI 通道的关系：HTTP 在前、CLI 兜底（描述符的 models.strategies 按 clientDependent 排序）。
// 两条通道产出的清单形状一致（裸模型 id 数组，剔除 `custom-local:*`），调用方无感。

const { readAccountCredentialRecord } = require('../server/account-credential-store');
const {
  CODEBUDDY_FAMILY_USER_AGENT,
  resolveCodebuddyFamilyInferenceBaseUrl
} = require('./codebuddy-family-inference');

// 云端「当前支持」配置端点（与会话/推理端点同站不同路径，刻意分开声明）。
const CODEBUDDY_FAMILY_CONFIG_PATH = '/v3/config';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(provider) {
  return text(provider).toLowerCase();
}

/**
 * 归一化一份模型 id 清单：去空白、去空项、去重，并剔除 `custom-local:*`
 * （宿主本机自定义模型，可能正指向 aih 网关本身，不属于账号 —— 与 CLI 解析同一规则）。
 */
function normalizeModelList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const models = [];
  for (const value of values) {
    const id = text(value);
    if (!id || id.startsWith('custom-local:') || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

/**
 * 从 `/v3/config` 响应体里取「当前支持」的模型清单。
 *
 * 返回 `null` 表示**拿不到清单**（结构不认 / 空清单）—— 与「清单为空」是两件事：
 * 前者要让策略链继续走 CLI 兜底，后者才是账号真的没有可用模型。
 */
function parseCodebuddyFamilyConfigModels(payload) {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const data = root && root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : null;
  if (!data) return null;
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const cliAgent = agents.find((agent) => agent && typeof agent === 'object' && text(agent.name) === 'cli');
  const fromAgent = normalizeModelList(cliAgent && cliAgent.models);
  if (fromAgent.length > 0) return fromAgent;
  const fromCatalog = normalizeModelList(
    (Array.isArray(data.models) ? data.models : []).map((entry) => (entry && typeof entry === 'object' ? entry.id : entry))
  );
  return fromCatalog.length > 0 ? fromCatalog : null;
}

/** 从家族原生凭据里取共享 access token（与 Go 侧 accessTokenFromPayload 同字段口径）。 */
function readCodebuddyFamilyAccessToken(nativeAuth) {
  const credentials = nativeAuth && typeof nativeAuth === 'object' ? nativeAuth.credentials : null;
  const auth = credentials && typeof credentials === 'object' ? credentials.auth : null;
  if (!auth || typeof auth !== 'object') return '';
  return text(auth.accessToken) || text(auth.access_token);
}

/**
 * 拉取某账号的「当前支持」模型清单。
 *
 * @returns {Promise<{models?: string[], error?: string}>}
 */
async function fetchCodebuddyFamilyConfigModels(provider, accessToken, options = {}) {
  const base = resolveCodebuddyFamilyInferenceBaseUrl(provider, null);
  const token = text(accessToken);
  if (!base) return { error: 'codebuddy_family_model_catalog_unknown_provider' };
  if (!token) return { error: 'codebuddy_family_model_catalog_missing_token' };
  const request = options.request || ((url, init) => fetch(url, init));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await request(base + CODEBUDDY_FAMILY_CONFIG_PATH, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/plain, */*',
        'user-agent': CODEBUDDY_FAMILY_USER_AGENT,
        origin: base,
        referer: `${base}/`,
        'x-requested-with': 'XMLHttpRequest'
      },
      ...(controller ? { signal: controller.signal } : {})
    }, timeoutMs);
    if (!response || typeof response.json !== 'function') return { error: 'codebuddy_family_model_catalog_invalid_response' };
    if (!response.ok) return { error: `codebuddy_family_model_catalog_http_${response.status}` };
    const models = parseCodebuddyFamilyConfigModels(await response.json());
    if (!models || models.length === 0) return { error: 'codebuddy_family_model_catalog_empty' };
    return { models };
  } catch (error) {
    return { error: error && error.code || 'codebuddy_family_model_catalog_failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 描述符 `models.strategies` 的 HTTP 策略实现（`transport: 'http'`、`clientDependent: false`）。
 *
 * 账号对象可能来自「只参与模型发现的账号」（lib/server/model-discovery-accounts.js），
 * 那种对象只有 provider/accountRef —— 所以凭据**自己从凭据库读**，不依赖调用方注入 accessToken。
 */
function createCodebuddyFamilyHttpModelDiscovery(options = {}) {
  const readRecord = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const fetchModels = options.fetchCodebuddyFamilyConfigModels || fetchCodebuddyFamilyConfigModels;
  return {
    async discover(account, timeoutMs) {
      const provider = normalizeProvider(account && account.provider);
      const accountRef = text(account && account.accountRef);
      if (!accountRef) return { error: 'codebuddy_family_model_catalog_missing_account_ref' };
      let record = null;
      try {
        record = readRecord(options.fs, options.aiHomeDir, accountRef);
      } catch (_error) {
        return { error: 'credential_record_unreadable' };
      }
      if (!record || normalizeProvider(record.provider) !== provider) return { error: 'credential_record_missing' };
      const token = readCodebuddyFamilyAccessToken(record.nativeAuth);
      if (!token) return { error: 'codebuddy_family_model_catalog_credential_unsupported' };
      const result = await fetchModels(provider, token, {
        request: options.egressFetchWithTimeout || options.fetchWithTimeout || options.request,
        timeoutMs
      });
      if (result && result.models && result.models.length > 0) return { models: result.models };
      return { error: (result && result.error) || 'codebuddy_family_model_catalog_empty' };
    }
  };
}

module.exports = {
  CODEBUDDY_FAMILY_CONFIG_PATH,
  parseCodebuddyFamilyConfigModels,
  readCodebuddyFamilyAccessToken,
  fetchCodebuddyFamilyConfigModels,
  createCodebuddyFamilyHttpModelDiscovery
};
