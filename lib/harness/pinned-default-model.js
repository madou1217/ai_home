'use strict';

// 外部 harness（Pi / DSH / dsh-tui）在「钉选了账号、但没指定模型」时的默认模型。
//
// 适配器拿到的目录是网关 `/v1/models` 的**并集**，第一条常常是池级别的入口（如
// `auto`）——钉选到某个账号后它路由不到，用户一启动就看到 `503 no_available_account`。
// 因此这里按「用户给该账号配的默认模型 → 该账号目录的第一条」解析出一个该账号确实
// 能路由的模型，与 WebUI 的 CLI 选择器同源同序（defaultByAccountRef →
// selectableByAccountRef[0]），命令行与界面点出来的默认模型因此一致。
//
// 目录来自服务端已持久化的模型快照（app-state 的 cache:webui-models-snapshot.json），
// 与跨 Provider Claude harness 的模型可见性用的是同一份事实。读不到、为空或形状不
// 认识时返回空串，由适配器维持原有回落：启动绝不因为目录缺失而失败。

const { readPersistedWebUiModelsCache } = require('../server/webui-model-cache');
const {
  findDefaultAccountModelSetting,
  readModelCatalogSettings
} = require('../server/model-catalog-settings-store');

function readStringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

/**
 * @returns {string} 该账号可路由的默认模型；无法判定时返回空串。
 */
function resolvePinnedHarnessDefaultModel(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  if (!accountRef) return '';
  const readModelsCache = typeof input.readModelsCache === 'function'
    ? input.readModelsCache
    : readPersistedWebUiModelsCache;
  let models = [];
  try {
    const cache = readModelsCache({ fs: input.fs, aiHomeDir: input.aiHomeDir });
    const byAccount = cache && typeof cache === 'object' ? cache.byAccount : null;
    models = readStringList(byAccount && byAccount[accountRef]);
  } catch (_error) {
    models = [];
  }
  if (models.length === 0) return '';
  const readSettings = typeof input.readSettings === 'function'
    ? input.readSettings
    : readModelCatalogSettings;
  let configured = '';
  try {
    const settings = readSettings(input.fs, input.aiHomeDir);
    const record = findDefaultAccountModelSetting(settings, { accountRef });
    configured = String(record && record.id || '').trim();
  } catch (_error) {
    configured = '';
  }
  // 配的默认模型不在该账号目录里时不用它——那正是要避免的「启动即 503」。
  if (configured && models.includes(configured)) return configured;
  return models[0];
}

module.exports = {
  resolvePinnedHarnessDefaultModel
};
