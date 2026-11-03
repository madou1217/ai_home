'use strict';

/**
 * 单次会话的模型改写规则（`--model-alias`）。
 *
 * 与「持久别名」（lib/server/model-alias-store.js，写进 app-state.db、WebUI 可编辑）
 * 刻意分开：这里是**一次启动有效**的临时规则，不落库、退出即失效，语义也更窄——
 * 只改模型名，不换 provider、不动选号。
 *
 * 规则形如 `source=target`：
 *   modelA=modelB   本次会话请求 modelA 时，实际用 modelB
 *   *=modelB        本次会话请求任何模型，都实际用 modelB（`--model` 省略时的形态）
 *
 * target 还可以显式指定 Provider / 账号（模型名被多家共持时必需，例如 glm-5 同时挂在
 * zcode 与 kiro 名下）：
 *   kiro.glm-5       钉 kiro 这个 Provider
 *   kiro.1.glm-5     钉 kiro 的 1 号账号（CLI 账号编号）
 *   kiro.acct_….glm-5 钉一个持久 accountRef
 * 只有第一段恰为已注册 Provider 时才拆命名空间——模型名自己带点（gemini-2.5-pro）不受影响。
 * 拆分结果里的 target 恒为**裸模型名**，Provider / 账号交给路由钉选（session-model-alias-routing）。
 *
 * 传输：relay 把规则塞进 `x-aih-model-alias` 头，网关在**别名解析之前**先按它改
 * 请求里的 model，之后一切照旧（钉选、选号、冷却都不受影响）。放在别名之前是有意的：
 * 别名是用户长期配置，临时规则是本次会话的显式指令，后者优先。
 */

const HEADER_NAME = 'x-aih-model-alias';
const WILDCARD = '*';

// Provider 命名空间判定用注册表（isKnownProvider），不维护第二份名单。
const { isKnownProvider } = require('../provider-catalog');

// 第二条送达通道：**网关 base URL 的路径前缀**。
//
// 自定义头只有 aih 自己拼请求头的 provider 才有（claude 的 ANTHROPIC_CUSTOM_HEADERS、
// codex 的 model_providers.*.http_headers）。gemini / codebuddy 家族 / opencode / qoder /
// zcode 这些原生 CLI 没有可追加头的 env 通道，但它们都能改 base URL——而 aih 本来就
// 决定它们连哪个 base URL。于是把规则编进 URL 路径：
//
//   http://127.0.0.1:9527/-/ma/<base64url("modelA=modelB")>/v1beta
//
// 网关在路由匹配之前剥掉这一段（lib/server/v1-router），规则因此能到达选号之前。
// 用 base64url 而不是明文：模型名里可能有 / 和 :（会破坏路径分段），编码后只剩
// [A-Za-z0-9_-]，任何客户端拼路径都不会二次转义。
const PATH_PREFIX = '/-/ma/';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 目标可以显式钉 provider / 账号：`kiro.glm-5`、`kiro.1.glm-5`。
//
// 模型 id 自己就带点（gemini-2.5-pro / gpt-5.1），所以**不能**见到点就拆：只有第一段
// 恰好是已注册 Provider 时才当作命名空间。第二段是纯数字才是「账号位」（CLI 的账号编号）。
// 其余形态一律按原样当模型名 —— 猜错会把好好的模型改名成不认识的东西。
function splitProviderTarget(value) {
  const raw = text(value);
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  const provider = parts[0].trim().toLowerCase();
  if (!provider || !isKnownProvider(provider)) return null;
  const rest = parts.slice(1);
  if (!rest.length) return null;
  // 账号位：CLI 编号（`kiro.1.glm-5`），也接受持久 accountRef（`kiro.acct_….glm-5`）。
  const account = /^\d+$/.test(rest[0]) || /^acct_[A-Za-z0-9]+$/.test(rest[0]) ? rest.shift() : '';
  const target = rest.join('.').trim();
  if (!target) return null;
  return { provider, account, target };
}

/**
 * 解析 `source=target`。source 省略（只给一个模型名）时视为通配。
 * target 可以是裸模型名，也可以是 `provider.model` / `provider.账号.model`。
 * @returns {{source: string, target: string, provider?: string, account?: string}|null}
 *          非法输入返回 null
 */
function parseSessionModelAliasSpec(spec) {
  const raw = text(spec);
  if (!raw) return null;
  const index = raw.indexOf('=');
  const source = index < 0 ? WILDCARD : (text(raw.slice(0, index)) || WILDCARD);
  const rawTarget = text(index < 0 ? raw : raw.slice(index + 1));
  if (!rawTarget) return null;
  const scoped = splitProviderTarget(rawTarget);
  if (scoped) {
    return {
      source,
      target: scoped.target,
      provider: scoped.provider,
      ...(scoped.account ? { account: scoped.account } : {})
    };
  }
  return { source, target: rawTarget };
}

/** 规则 → 头值（`modelA=modelB` / `*=kiro.1.glm-5`）。 */
function encodeSessionModelAlias(rule) {
  if (!rule || !text(rule.target)) return '';
  const provider = text(rule.provider).toLowerCase();
  const account = text(rule.account);
  const target = provider
    ? `${provider}.${account ? `${account}.` : ''}${text(rule.target)}`
    : text(rule.target);
  return `${text(rule.source) || WILDCARD}=${target}`;
}

/** 规则 → 路径前缀里的不透明片段（base64url；空规则返回空串）。 */
function encodeSessionModelAliasToken(rule) {
  const value = encodeSessionModelAlias(rule);
  if (!value) return '';
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** 路径片段 → 规则；解不开或非法返回 null（不抛，坏 URL 不能把网关打挂）。 */
function decodeSessionModelAliasToken(token) {
  const raw = text(token);
  if (!raw) return null;
  // base64url 解码对垃圾输入是「尽力而为」而不是报错（`!!!x` 也能解出字节），
  // 所以用**往返一致**判合法：重新编码必须回到原串，否则这条 token 不是我们写的。
  //
  // catch 是兜底而非死代码：本函数的契约是「解不开就返回 null，绝不抛」（见上）。
  // 当前确实进不来——text() 已把非字符串挡成 ''，Buffer.from(字符串, 'base64url')
  // 对非法字符静默丢弃、不抛（Node 22 实测）。留着是为了让这条契约由代码兑现，而不是
  // 依赖「Node 的解码行为永远不变」这个外部假设：将来若放宽 text() 的类型收口、或调用
  // 方绕过它，最坏也只是规则不生效，不会把坏 URL 变成网关的 500。下面那行 ignore 只
  // 是为了让覆盖率报告不把这处兜底算成缺口，别据此把它删掉。
  let decoded = '';
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) return null;
    decoded = bytes.toString('utf8');
  // 兜底分支按当前代码永远进不去（见上），忽略 3 行 = catch 头 + 体 + 收尾括号。
  /* node:coverage ignore next 3 */
  } catch (_error) {
    return null;
  }
  return parseSessionModelAliasSpec(decoded);
}

/**
 * 拆出路径前缀：`/-/ma/<token>/v1beta/models/x:generateContent`
 *   → { rule, pathname: '/v1beta/models/x:generateContent' }
 * 没有前缀时原样返回（rule=null）。token 非法同样原样返回——让后面的路由
 * 自然 404，而不是把一个被改写的路径交给上游。
 */
function splitSessionModelAliasPath(pathname) {
  const value = String(pathname || '');
  if (!value.startsWith(PATH_PREFIX)) return { rule: null, pathname: value, token: '' };
  const rest = value.slice(PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  const token = slash < 0 ? rest : rest.slice(0, slash);
  const rule = decodeSessionModelAliasToken(token);
  if (!rule) return { rule: null, pathname: value, token: '' };
  const tail = slash < 0 ? '/' : rest.slice(slash);
  return { rule, pathname: tail, token };
}

/** 规则 → 挂在 base URL 上的路径前缀（无规则时返回空串）。 */
function buildSessionModelAliasPathPrefix(rule) {
  const token = encodeSessionModelAliasToken(rule);
  return token ? `${PATH_PREFIX}${token}` : '';
}

/** 从头里取规则；头可以出现多次，取第一条合法值。 */
function readSessionModelAliasHeader(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  // Node 会把收到的头名归一成小写，但 relay 自拼的头（claude 的 ANTHROPIC_CUSTOM_HEADERS）
  // 可能是任意大小写，所以按小写逐键比对，不做两次精确查找。
  let raw = null;
  for (const key of Object.keys(source)) {
    if (String(key).toLowerCase() === HEADER_NAME) {
      raw = source[key];
      break;
    }
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  return parseSessionModelAliasSpec(value);
}

/**
 * 判断规则是否命中本次请求的模型。
 * 通配命中任何模型；具名规则只命中完全相同的模型名（大小写不敏感，模型名不区分大小写）。
 */
function sessionModelAliasMatches(rule, requestedModel) {
  if (!rule || !text(rule.target)) return false;
  const source = text(rule.source) || WILDCARD;
  if (source === WILDCARD) return true;
  const requested = text(requestedModel);
  if (!requested) return false;
  return source.toLowerCase() === requested.toLowerCase();
}

/**
 * 把规则应用到请求体。返回新对象，不改入参。
 * 未命中或请求里没有 model 字段时原样返回（changed=false）。
 */
function applySessionModelAlias(input = {}) {
  const requestJson = input.requestJson && typeof input.requestJson === 'object' && !Array.isArray(input.requestJson)
    ? input.requestJson
    : null;
  if (!requestJson) return { changed: false, requestJson: input.requestJson, rule: null, requestedModel: '' };
  const requestedModel = typeof requestJson.model === 'string' ? requestJson.model : '';
  const rule = input.rule || readSessionModelAliasHeader(input.headers);
  if (!requestedModel || !sessionModelAliasMatches(rule, requestedModel)) {
    return { changed: false, requestJson, rule: rule || null, requestedModel };
  }
  return {
    changed: true,
    requestJson: { ...requestJson, model: rule.target },
    rule,
    requestedModel
  };
}

module.exports = {
  HEADER_NAME,
  PATH_PREFIX,
  WILDCARD,
  parseSessionModelAliasSpec,
  encodeSessionModelAlias,
  encodeSessionModelAliasToken,
  decodeSessionModelAliasToken,
  splitSessionModelAliasPath,
  buildSessionModelAliasPathPrefix,
  readSessionModelAliasHeader,
  sessionModelAliasMatches,
  applySessionModelAlias
};
