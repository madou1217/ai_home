'use strict';

// `provider/updateAccountConfig` 的**载荷构造唯一实现处**（app-server 通路）。
//
// 协议形状逐字来自真机抓包（2026-10-28，桌面端发给 app-server 的那份）：
//   basedOnZCodeBuiltinRevision = `zcode-builtin:<builtin.revision>:<sha256(path.resolve(active))>`
//     —— 哈希的是**配置文件路径**而不是内容（bundle 里
//        `#n = createHash("sha256").update(path.resolve(this.#t)).digest("hex")`，
//        `#t = activeFilePath`，即 CLI 的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
//        ——**内置**配置的 active 路径，不是个人配置）；
//     真机 2026-10-31：早先这里哈希的是个人配置路径，指纹与 CLI 对不上，overlay 被注册表
//     静默丢弃，turn 报 `Provider Registry 中不存在 Model: account:zai-start-plan/…`；
//     换成 sha256(ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) 后同一 turn 正常进入模型调用。
//   revision = `account:[<basedOn>,<provider 列表>]`，列表项是 `{providerId, config}`；
//   providers = { <id>: { access:{type,entitled}, builtinModelIds? } }（**全部** provider 都要在，
//        非目标项 entitled:false，否则注册表把 overlay 当不完整）；
//   states = { <id>: { availability, entitled, current, unavailableReason? } }
//        （`connectionKey` 在 schema 里是 optional，省略即可）。
//
// 哈希对**我们自己的**路径自洽即可：服务端校验的是「overlay 的 basedOn 是否等于当前加载的
// 内置 release」，而当前加载的内置 release 由我们传给 CLI 的两个配置变量决定。

const nodeCrypto = require('node:crypto');
const nodePath = require('node:path');

const DEFAULT_ACCESS_TYPE = 'zhipu-account';

function sha256Hex(value) {
  return nodeCrypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * 构造一次账号 provider overlay。
 *
 * @param {object} input
 * @param {object} input.builtinConfig      解析后的内置 provider 配置
 * @param {string} input.activeBuiltinConfigPath CLI 实际加载的内置配置绝对路径（决定 basedOn 的哈希）
 * @param {string} input.providerId         本次要声明的账号 provider
 * @param {string[]} [input.modelIds]       该 provider 的模型清单（缺省用内置规则里的）
 * @returns {{revision: string, basedOnZCodeBuiltinRevision: string, providers: object, states: object}|null}
 */
function buildZcodeAccountOverlay(input = {}) {
  const builtinConfig = input.builtinConfig;
  const providerId = String(input.providerId || '').trim();
  const activeBuiltinConfigPath = String(input.activeBuiltinConfigPath || '').trim();
  if (!builtinConfig || !providerId || !activeBuiltinConfigPath) return null;
  const rules = (((builtinConfig.config || {}).providerConfigRules || {}).providerRules) || [];
  if (rules.length === 0) return null;
  const providers = {};
  const states = {};
  for (const rule of rules) {
    const id = String((rule && rule.providerId) || '').trim();
    if (!id) continue;
    const ruleConfig = (rule && rule.config) || {};
    const isTarget = id === providerId;
    // access 只能是 `{type, entitled}`：内置规则里的 `mode`/`accountType` 等键会被
    // app-server 的 strict schema 判为 Unrecognized key（真机 2026-10-28 实测报错
    // `Unrecognized key(s) in object: 'account:…', 'access'`），必须只挑这两个。
    const access = { type: String((ruleConfig.access || {}).type || DEFAULT_ACCESS_TYPE), entitled: isTarget };
    const entry = { access };
    const modelIds = Array.isArray(input.modelIds) && input.modelIds.length > 0
      ? input.modelIds.map((item) => String(item))
      : (Array.isArray(ruleConfig.builtinModelIds) ? ruleConfig.builtinModelIds.map((item) => String(item)) : []);
    if (isTarget && modelIds.length > 0) entry.builtinModelIds = modelIds;
    providers[id] = entry;
    states[id] = isTarget
      ? { availability: 'available', entitled: true, current: true }
      : { availability: 'unavailable', entitled: false, current: false, unavailableReason: 'not-entitled' };
  }
  if (!providers[providerId]) return null;
  const basedOn = `zcode-builtin:${builtinConfig.revision}:${sha256Hex(nodePath.resolve(activeBuiltinConfigPath))}`;
  const list = Object.entries(providers).map(([id, config]) => ({ providerId: id, config }));
  return {
    revision: `account:[${JSON.stringify(basedOn)},${JSON.stringify(list)}]`,
    basedOnZCodeBuiltinRevision: basedOn,
    providers,
    states
  };
}

module.exports = {
  DEFAULT_ACCESS_TYPE,
  sha256Hex,
  buildZcodeAccountOverlay
};
