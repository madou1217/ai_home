'use strict';

// model.catalog：插件声明「别名 → 已存在的目标模型」。
//
// 发布代次时（准备之后、提交之前）每个 model.catalog 贡献项被调用一次，返回 { aliases: [{ alias, target, description? }] }。
// 别名随代次快照固定，整个代次内列表与路由看到的是同一份。宿主保证：
//   - 别名只是名字：请求仍按目标模型走目录、授权与选号，别名不能扩大目标的能力或访问范围；
//   - 真实模型 ID 与用户自己定义的别名优先，插件别名不能覆盖它们（同名时插件别名被忽略）；
//   - 同一代次里两个插件声明同一个别名 → 候选被拒；返回格式不对 → 候选被拒。

const { PluginError } = require('../sdk/errors');

const CAPABILITY = 'model.catalog';
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const MAX_ALIASES_PER_PLUGIN = 256;

function catalogFailure(item, code, message) {
  const error = new PluginError(code, `插件 ${item.instanceId} 的 ${item.id}：${message}`);
  error.diagnostics = [{ code, instanceId: item.instanceId, detail: message }];
  return error;
}

/** 准备阶段调用：收集并校验候选代次声明的别名。 */
async function collectCatalogAliases(invoke, snapshot) {
  const chain = snapshot.byCapability.get(CAPABILITY) || [];
  const owners = new Map();
  const aliases = [];
  for (const item of chain) {
    let result;
    try {
      result = (await invoke(item.id, { kind: 'aliases' })).value;
    } catch (error) {
      throw catalogFailure(item, error.code || 'plugin_catalog_failed', error.message);
    }
    if (result === null || result === undefined) continue;
    if (typeof result !== 'object' || !Array.isArray(result.aliases)) throw catalogFailure(item, 'plugin_catalog_invalid', '返回值必须是 { aliases: [...] }');
    if (result.aliases.length > MAX_ALIASES_PER_PLUGIN) throw catalogFailure(item, 'plugin_catalog_invalid', `别名不能超过 ${MAX_ALIASES_PER_PLUGIN} 个`);
    for (const entry of result.aliases) {
      const alias = String(entry && entry.alias || '').trim();
      const target = String(entry && entry.target || '').trim();
      if (!ALIAS_PATTERN.test(alias) || !target || alias === target) {
        throw catalogFailure(item, 'plugin_catalog_invalid', `别名条目无效：${JSON.stringify(entry)}`);
      }
      const owner = owners.get(alias.toLowerCase());
      if (owner) throw catalogFailure(item, 'plugin_catalog_conflict', `别名 ${alias} 已由 ${owner} 声明`);
      owners.set(alias.toLowerCase(), item.instanceId);
      aliases.push(Object.freeze({
        alias,
        target,
        instanceId: item.instanceId,
        description: String(entry.description || '').slice(0, 200)
      }));
    }
  }
  return Object.freeze(aliases);
}

/**
 * 把代次快照里的插件别名并进用户别名表（模型别名存储的记录格式）。
 * 用户别名优先：同名（大小写不敏感）的插件别名被丢弃；options.isRealModel 判定为真实模型 ID 的插件别名也被丢弃。
 */
function mergePluginAliases(userAliases, snapshot, options = {}) {
  const base = Array.isArray(userAliases) ? userAliases : [];
  const plugin = snapshot && Array.isArray(snapshot.catalogAliases) ? snapshot.catalogAliases : [];
  if (!plugin.length) return base;
  const taken = new Set(base.map((item) => String(item && item.alias || '').trim().toLowerCase()));
  // 与真实模型同名的插件别名一律丢弃：否则指向该模型的别名（包括用户自己的）会被判成「指向另一个别名」而失效。
  const isRealModel = typeof options.isRealModel === 'function' ? options.isRealModel : () => false;
  const extra = plugin
    .filter((item) => !taken.has(item.alias.toLowerCase()) && !isRealModel(item.alias))
    .map((item) => ({
      id: `plugin:${item.instanceId}:${item.alias}`,
      alias: item.alias,
      target: item.target,
      provider: '',
      targetProvider: '',
      priority: 0,
      enabled: true,
      description: item.description || `插件 ${item.instanceId}`,
      source: 'plugin'
    }));
  return extra.length ? base.concat(extra) : base;
}

module.exports = { CAPABILITY, collectCatalogAliases, mergePluginAliases };
