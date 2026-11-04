'use strict';

// 本会话「当前模型」的解析，以及换号时把模型安全地带到目标账号。
//
// 背景（2026-11-04）：CodeBuddy 家族 CLI 支持会话内 `/model` 切模型。CLI 在**非
// session 作用域**下会把新模型写回共享的 `settings.json`（二进制 set_model 分支：
// `settingsManager.set("model", id)` + `cliSettingsProvider.set("model", id)`）。aih
// 原先让启动参数 `--model` 永远优先，于是 `/model` 之后：
//   1. 标题、(账号,模型) 冷却键仍是启动时的旧模型；
//   2. 换号时把旧 `--model` 原样传给新账号，用户刚切的模型被静默回退。
//
// 另外 codebuddy ↔ codebuddycn 的模型目录不同（如 `gpt-6.1-sol` 只在国际站、
// `step-5-preview` 只在国内站）。目标站点没有当前模型时，旧 `--model` 会让新会话
// 在第一次请求才报 “service info not found”，换号看起来像成功、实际不能用。
//
// 这里把两件事收口成纯函数：
//   - 以 settings.json 的**变化**（而不是和启动参数比大小）识别运行中切过模型；
//   - 家族换号（同站/跨站）时按目标账号目录选模型：保留原模型 → 该站上次用过的模型 →
//     目标站默认。

const { modelIdsMatch, isPublicCatalogModelId } = require('../../../server/model-id');
const { isCodebuddyFamilyProvider } = require('../../../runtime/codebuddy-family-layouts');

// 「目标站默认」的候选：这些是 CodeBuddy 的 Auto/默认档位。目录里有就优先，
// 避免把站内第一条（目录顺序是字典序，不代表推荐顺序）硬塞给用户。
const DEFAULT_MODEL_HINTS = Object.freeze([
  'default-model',
  'primary-model',
  'balanced-model',
  'fast-model'
]);

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeCatalog(values) {
  if (!Array.isArray(values)) return null;
  // custom-local:* 是宿主本机自定义模型（可能正指向 aih 网关），不属于站点账号目录，
  // 不能当跨站替代项（与模型发现的归一规则一致）。
  return values
    .map((value) => text(value))
    .filter((value) => value && !value.startsWith('custom-local:'));
}

/**
 * 从持久化模型缓存里取某账号的目录；残缺目录按「未知」处理（不能据此否定模型）。
 * 返回 null 表示未知，调用方必须 fail-open。
 */
function selectAccountCatalog(cache, accountRef) {
  const ref = text(accountRef);
  if (!ref || !cache || typeof cache !== 'object') return null;
  if (cache.incompleteByAccount && cache.incompleteByAccount[ref]) return null;
  const models = cache.byAccount && cache.byAccount[ref];
  return Array.isArray(models) && models.length > 0 ? models : null;
}

/**
 * 运行中模型切换的状态机。
 *
 * `baseline` 是「我们上次看到的 settings.json 值」，`live` 是检测到的运行中切换。
 * 只在 configured 真的**变化**时更新 live：这样启动参数 `--model` 不会因为 settings
 * 里的旧值而被误判成「用户切过模型」，而 `/model` 写回后又能稳定压过启动参数。
 * 切换回旧值也算一次变化（baseline 已经前移），不会漏判。
 */
function createFamilyModelTracker() {
  let baseline = '';
  let live = '';
  return {
    reset(configuredModel, liveModel = '') {
      baseline = text(configuredModel);
      live = text(liveModel);
    },
    observe(configuredModel) {
      const configured = text(configuredModel);
      if (configured && configured !== baseline) {
        baseline = configured;
        live = configured;
      }
      return live;
    },
    current() {
      return live;
    }
  };
}

/**
 * 当前模型优先级：运行中切换 > 启动参数 > harness 自报 > 配置文件。
 *
 * 非家族 provider 由调用方直接按原有顺序取，不进这里。
 */
function pickActiveModel(input = {}) {
  return text(input.live) || text(input.explicit) || text(input.reported) || text(input.configured);
}

/**
 * 改写 `--model` / `-m` 的值；没有时插到 `--` 之前（`--` 之后是原生透传区，
 * 不能把 aih 的模型旗标塞进去）。
 *
 * 返回新数组，不改入参。空 model 表示「不改写」，原样返回副本。
 */
function setModelFlagValue(args, model) {
  const value = text(model);
  const source = Array.isArray(args) ? args : [];
  if (!value) return source.slice();

  const out = [];
  let replaced = false;
  let boundary = -1;
  for (let index = 0; index < source.length; index += 1) {
    const token = String(source[index] == null ? '' : source[index]);
    if (boundary >= 0) {
      out.push(token);
      continue;
    }
    if (token === '--') {
      boundary = out.length;
      out.push(token);
      continue;
    }
    if (token === '--model' || token === '-m') {
      out.push(token, value);
      const next = source[index + 1];
      // 原来的值一起吃掉；如果下一项本身是旗标，说明原参数缺少值，不能误吞。
      if (next != null && !String(next).startsWith('-')) index += 1;
      replaced = true;
      continue;
    }
    if (token.startsWith('--model=') || token.startsWith('-m=')) {
      out.push(`${token.slice(0, token.indexOf('=') + 1)}${value}`);
      replaced = true;
      continue;
    }
    out.push(token);
  }

  if (!replaced) {
    out.splice(boundary >= 0 ? boundary : out.length, 0, '--model', value);
  }
  return out;
}

function pickTargetDefaultModel(catalog) {
  for (const hint of DEFAULT_MODEL_HINTS) {
    const match = catalog.find((model) => modelIdsMatch(model, hint));
    if (match) return match;
  }
  return catalog.find((model) => isPublicCatalogModelId(model)) || '';
}

/**
 * 家族换号时，目标账号应该用哪个模型。
 *
 * @param {object} input
 * @param {string} input.currentModel 当前会话模型（已经过运行中切换修正）
 * @param {string[]|null} input.targetCatalog 目标账号的模型目录；null/空 = 未知
 * @param {string} [input.siteModel] 该站上次用过的模型（本进程内记忆，不落库）
 * @returns {{model: string, changed: boolean, reason: string}}
 *   reason: catalog_unknown / supported / site_memory / target_default / no_alternative / no_model
 */
function decideFamilySwitchModel(input = {}) {
  const current = text(input.currentModel);
  const siteModel = text(input.siteModel);
  const catalog = normalizeCatalog(input.targetCatalog);
  // 空目录 = 还不知道这个账号能服务什么（模型发现未完成），不是「明确了没有模型」。
  if (!catalog || catalog.length === 0) return { model: current, changed: false, reason: 'catalog_unknown' };
  if (!current) return { model: '', changed: false, reason: 'no_model' };

  const supports = (model) => Boolean(model)
    && catalog.some((candidate) => modelIdsMatch(candidate, model));

  if (supports(current)) return { model: current, changed: false, reason: 'supported' };
  if (supports(siteModel)) return { model: siteModel, changed: true, reason: 'site_memory' };

  const fallback = pickTargetDefaultModel(catalog);
  if (fallback) return { model: fallback, changed: true, reason: 'target_default' };
  return { model: current, changed: false, reason: 'no_alternative' };
}

/**
 * 读本进程自己的 `--model/-m`，**不截断**（标题层会截到 48 字符，不能拿来当逻辑事实）。
 * `--` 之后是原生透传区，不参与 aih 的模型判断。
 */
function readModelFlagValue(args) {
  const source = Array.isArray(args) ? args : [];
  for (let index = 0; index < source.length; index += 1) {
    const token = String(source[index] == null ? '' : source[index]);
    if (token === '--') break;
    if (token === '--model' || token === '-m') {
      const next = source[index + 1];
      return next == null || String(next).startsWith('-') ? '' : text(next);
    }
    if (token.startsWith('--model=')) return text(token.slice('--model='.length));
    if (token.startsWith('-m=')) return text(token.slice('-m='.length));
  }
  return '';
}

/**
 * 换号时对续接参数做的模型改写。纯函数，运行时只需把 targetCatalog / siteModel 喂进来。
 *
 * 规则：
 *   - 任何换号：启动参数里的旧 `--model` 不能覆盖运行中 `/model` 的新值；
 *   - 家族换号（同站/跨站）：按目标账号目录适配（保留 → 站点记忆 → 目标默认），并始终
 *     显式带给目标进程（共享 settings.json 是全局的，运行中切换可能还没落盘）；
 *   - 非家族 provider：只修正参数里的旧值，不猜替代模型；
 *   - 会话带 `--model-alias` 时**完全不碰模型**：那句 `A=B` 的 source 是语义锚点，
 *     改掉 source 会让规则失配（跨站路由由网关按别名处理）。
 *
 * @returns {{args: string[], model: string, notice: string, family: boolean}}
 */
function planSwitchModel(input = {}) {
  const fromModel = text(input.currentModel);
  const fromProvider = text(input.fromProvider).toLowerCase();
  const nextProvider = text(input.nextProvider).toLowerCase();
  const hasModelAlias = input.hasModelAlias === true;
  let args = Array.isArray(input.forwardArgs) ? input.forwardArgs.slice() : [];
  let model = fromModel;
  let notice = '';

  if (fromModel && !hasModelAlias) {
    const argsModel = readModelFlagValue(args);
    if (argsModel && argsModel !== fromModel) args = setModelFlagValue(args, fromModel);
  }

  const family = isCodebuddyFamilyProvider(fromProvider) && isCodebuddyFamilyProvider(nextProvider);
  if (fromModel && family && !hasModelAlias) {
    const decision = decideFamilySwitchModel({
      currentModel: fromModel,
      targetCatalog: input.targetCatalog,
      siteModel: input.siteModel
    });
    if (decision.model) {
      // 家族换号一律显式携带模型：共享 settings.json 是全局的，而运行中
      // session 级 `/model` 可能还没落盘；不显式带就会回退成配置里的旧值。
      args = setModelFlagValue(args, decision.model);
      model = decision.model;
      if (decision.changed) {
        notice = `目标账号不支持模型 ${fromModel}，本次会话改用 ${decision.model}`
          + '（进入会话后可 /model 重新选择）';
      }
    }
  }

  return { args, model, notice, family };
}

module.exports = {
  DEFAULT_MODEL_HINTS,
  createFamilyModelTracker,
  decideFamilySwitchModel,
  pickActiveModel,
  planSwitchModel,
  readModelFlagValue,
  selectAccountCatalog,
  setModelFlagValue
};
