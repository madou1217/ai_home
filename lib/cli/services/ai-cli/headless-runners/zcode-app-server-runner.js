'use strict';

// zcode 的 **headless runner**（`aih zcode <id> -p …` 的第二条通路）。
//
// 为什么需要它：standalone CLI 的账号 provider 枚举写死 `individual-coding-plan`，
// Start Plan 账号在 standalone 下要么报 "Select a model before sending a message"，
// 要么把请求发到 coding-plan 通道被上游以 `1113 Insufficient balance` 拒掉
// （2026-10-28 账号 11 真机）。app-server 模式下宿主可以声明账号 provider，
// 于是官方客户端照常发请求并完成整轮（详见 zcode-app-server-run.js 的文件头）。
//
// 这个模块只做三件事，且不认任何「别的 provider」：
//   1) 从启动环境补齐 app-server 需要的两个 provider 配置文件变量；
//   2) 按**内置 provider 配置 + 账号自身凭据**推导 providerId / modelId（候选链，可观察）；
//   3) 调用驱动并把答案写进 stdout 通道。
//
// providerId 的候选顺序（数据驱动，不写 provider 名清单）：
//   a. 账号凭据里已存在的 `account-provider:<id>:identity` 键 → 直接用它（桌面端自己写的）；
//   b. 内置配置里与账号区域同 group 且 providerName 命中账号套餐名的规则；
//   c. 同 group 的 start-plan 规则 → 再退到 individual-coding-plan 规则。
// modelId：CLI 个人配置里**已启用的模型**优先（账号实际可用集）→ defaultModelSelection
// → 该规则的第一个 `builtinModelIds`。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');

const { runZcodeAppServerPrompt } = require('../zcode-app-server-run');
const { buildZcodeAccountOverlay } = require('../zcode-builtin-release');
const {
  ZCODE_EMPTY_PERSONAL_PROVIDER_CONFIG,
  resolveZcodeBundledCli
} = require('../../../../runtime/zcode-cli-launcher');
const { readAccountCredentialRecord } = require('../../../../server/account-credential-store');
const { resolveZcodeHarnessStorePath } = require('../../../../server/zcode-harness-store');
const { decryptZcodeCredentialValue } = require('../../../../account/zcode-credential');

const PROVIDER_CONFIG_ENV = Object.freeze({
  BUILTIN: 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
  PERSONAL: 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'
});

// standalone CLI 在这些信号上等于「这条路服务不了这个账号」，值得切到 app-server。
// 它们是**上游/CLI 的文案事实**，不是我们的判断：命中即换路，不猜。
const ROUTE_UNUSABLE_SIGNATURES = Object.freeze([
  'Select a model before sending a message',
  'Provider Registry',
  'Insufficient balance or no resource package',
  'exceed quota limit'
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readPromptFromArgs(args) {
  const tokens = Array.isArray(args) ? args : [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] == null ? '' : tokens[index]);
    if (token === '-p' || token === '--prompt') {
      return normalizeText(tokens[index + 1]);
    }
    const inline = token.match(/^--prompt=(.*)$/);
    if (inline) return normalizeText(inline[1]);
  }
  return '';
}

function readAccountCredentials(fsImpl, aiHomeDir, accountRef) {
  if (!aiHomeDir || !accountRef) return {};
  try {
    const record = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
    return (record && record.nativeAuth && record.nativeAuth.credentials) || {};
  } catch (_error) {
    return {};
  }
}

/** 账号凭据里已声明的 account provider 列表（键名即事实：
 * `account-provider:<providerId>:identity` 与 `:auth-source` 都携带 providerId）。
 * 2026-11-04 账号 1 真机：官方 CLI 的 standalone 模型解析要求 identity 键，只有
 * auth-source 键的账号在 native `-p` 上报 "Select a model"；app-server 推导若也
 * 认不出声明键，会回落到 start-plan 规则、把 coding-plan 账号的请求发到
 * start-plan 端点（上游 1005 exceed quota limit，而账号实际额度 90%）。 */
function readDeclaredProviderIds(fsImpl, aiHomeDir, accountRef) {
  const credentials = readAccountCredentials(fsImpl, aiHomeDir, accountRef);
  const ids = [];
  for (const key of Object.keys(credentials)) {
    const match = key.match(/^account-provider:(.+):(?:identity|auth-source)$/);
    if (match && match[1] && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/** 从内置配置里挑出已声明 provider 对应的规则；同一账号声明了多个时 start-plan 优先
 * （账号 11：桌面端实际用的是 start-plan，即便 individual-coding-plan 键先出现）。 */
function pickDeclaredProviderRule(builtinConfig, declaredProviderIds) {
  const rules = (((builtinConfig || {}).config || {}).providerConfigRules || {}).providerRules || [];
  const usable = (Array.isArray(declaredProviderIds) ? declaredProviderIds : [])
    .map((providerId) => rules.find((rule) => normalizeText(rule && rule.providerId) === normalizeText(providerId)))
    .filter(Boolean);
  return usable.find((rule) => /start-plan$/.test(normalizeText(rule && rule.providerId))) || usable[0] || null;
}

/** 账号凭据的区域（决定内置配置里用哪个 family 的规则）。 */
function readAccountRegion(fsImpl, aiHomeDir, accountRef) {
  const credentials = readAccountCredentials(fsImpl, aiHomeDir, accountRef);
  const active = normalizeText(decryptZcodeCredentialValue(credentials['oauth:active_provider'] || ''));
  if (active) return active;
  const key = Object.keys(credentials).find((name) => /^oauth:[a-z]+:access_token$/.test(name));
  return key ? key.split(':')[1] : '';
}

function readAccountPlanLabel(fsImpl, aiHomeDir, accountRef) {
  if (!aiHomeDir || !accountRef) return '';
  try {
    const record = readAccountCredentialRecord(fsImpl, aiHomeDir, accountRef);
    return normalizeText(record && (record.planType || record.planName));
  } catch (_error) {
    return '';
  }
}

/**
 * 从内置 provider 配置里挑出「这个账号该用哪个 provider」。
 * 纯数据推导：区域定 group、套餐名定 providerName 关键词、都没有就按约定顺序退。
 */
function resolveProviderRule(builtinConfig, input = {}) {
  const rules = (((builtinConfig || {}).config || {}).providerConfigRules || {}).providerRules || [];
  const region = normalizeText(input.region) || 'zai';
  const planLabel = normalizeText(input.planLabel).toLowerCase();
  const inFamily = rules.filter((rule) => {
    const group = normalizeText(rule && rule.config && rule.config.group);
    return !group || group.startsWith(region);
  });
  const usable = inFamily.length > 0 ? inFamily : rules;
  if (planLabel) {
    const byPlan = usable.find((rule) => {
      const name = normalizeText(rule && rule.config && rule.config.providerName).toLowerCase();
      return name && planLabel.includes(name);
    });
    if (byPlan) return byPlan;
  }
  return usable.find((rule) => /start-plan$/.test(normalizeText(rule && rule.providerId)))
    || usable.find((rule) => /individual-coding-plan$/.test(normalizeText(rule && rule.providerId)))
    || null;
}

function readBuiltinConfig(fsImpl, configPath) {
  const target = normalizeText(configPath);
  if (!target) return null;
  try {
    return JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readRuleModels(builtinConfig, providerId) {
  const rules = (((builtinConfig || {}).config || {}).providerConfigRules || {}).providerRules || [];
  const rule = rules.find((item) => normalizeText(item && item.providerId) === normalizeText(providerId));
  return ((rule && rule.config) || {}).builtinModelIds || [];
}

/**
 * 从 CLI 自己写的个人 provider 配置（`<dataRoot>/.zcode/v2/provider_config.json`）
 * 里挑这个 provider 的模型。优先级：
 *   1. **已启用的模型**（`providerModelRules` 里 `config.enabled === true` 的第一条）
 *      —— 登录时由 CLI 刷新写回，是「这个账号实际可用」的模型集；
 *   2. `defaultModelSelection`（providerId 命中才认）；
 *   3. 都没有返回空串，调用方退到内置规则的 `builtinModelIds[0]`。
 * 2026-11-04 账号 1 真机：defaultModelSelection 指向旗舰 GLM-5.3，请求被上游拒
 * （turn failed: model_request_failed），而该账号唯一启用的模型是 GLM-5.3-Flash。
 */
function readPersonalModelId(fsImpl, personalConfigPath, providerId) {
  if (!personalConfigPath) return '';
  let config = null;
  try {
    config = JSON.parse(fsImpl.readFileSync(personalConfigPath, 'utf8'));
  } catch (_error) {
    return '';
  }
  const modelConfigRules = (((config || {}).config || {}).modelConfigRules) || {};
  const enabled = (Array.isArray(modelConfigRules.providerModelRules) ? modelConfigRules.providerModelRules : [])
    .filter((rule) => normalizeText(rule && rule.providerId) === normalizeText(providerId)
      && rule && rule.config && rule.config.enabled === true)
    .map((rule) => normalizeText(rule && rule.modelId))
    .find(Boolean) || '';
  if (enabled) return enabled;
  const selection = modelConfigRules.defaultModelSelection || {};
  if (normalizeText(selection.providerId) === normalizeText(providerId)) {
    return normalizeText(selection.modelId);
  }
  return '';
}

// app-server 需要**成对**的 provider 配置文件变量（内置 + 个人），缺任一个 CLI 直接退出；
// 个人配置缺失时落一份空形态（与 CLI 自己写出来的逐字节一致，见 zcode-cli-launcher）。
function ensureProviderConfigEnv(env, input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const out = { ...env };
  const dataBaseDir = normalizeText(out.ZCODE_DATA_BASE_DIR)
    || normalizeText(input.dataBaseDir)
    || nodeOs.homedir();
  if (!normalizeText(out[PROVIDER_CONFIG_ENV.BUILTIN]) && normalizeText(input.builtinConfigPath)) {
    out[PROVIDER_CONFIG_ENV.BUILTIN] = input.builtinConfigPath;
  }
  const personal = normalizeText(out[PROVIDER_CONFIG_ENV.PERSONAL])
    || pathImpl.join(dataBaseDir, '.zcode', 'v2', 'provider_config.json');
  try {
    if (!fsImpl.existsSync(personal)) {
      fsImpl.mkdirSync(pathImpl.dirname(personal), { recursive: true });
      fsImpl.writeFileSync(personal, ZCODE_EMPTY_PERSONAL_PROVIDER_CONFIG, 'utf8');
    }
  } catch (_error) {
    // 写不了就让 CLI 自己报「无法定位内置配置」——不吞掉这个事实。
  }
  out[PROVIDER_CONFIG_ENV.PERSONAL] = personal;
  out.ZCODE_DATA_BASE_DIR = dataBaseDir;
  return out;
}

/**
 * 跑一次 zcode headless 问答（app-server 通道）。
 *
 * @param {object} input
 * @param {object} input.launch   启动规格（command/args），用于拿 bundle 路径与 prompt
 * @param {object} input.env      已装配的启动环境
 * @param {string[]} [input.args] 原始 argv（默认取 launch.args）
 * @param {object} [input.deps]   { fs, path, aiHomeDir, hostHomeDir, spawnImpl, timeoutMs, onData, onErrorData }
 * @returns {Promise<{exitCode: number}>}
 */
async function runZcodeHeadlessViaAppServer(input = {}) {
  const deps = input.deps || {};
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const env = input.env && typeof input.env === 'object' ? input.env : process.env;
  const args = Array.isArray(input.args) ? input.args : (input.launch && input.launch.args) || [];
  const prompt = readPromptFromArgs(args);
  const emit = typeof deps.onData === 'function' ? deps.onData : () => {};
  const emitError = typeof deps.onErrorData === 'function' ? deps.onErrorData : () => {};
  const fail = (detail) => {
    emitError(`zcode app-server headless 失败：${detail}\n`);
    return { exitCode: 1 };
  };
  if (!prompt) return fail('缺少 -p/--prompt 提示词');

  const hostHomeDir = normalizeText(deps.hostHomeDir) || nodeOs.homedir();
  const hostAiHomeDir = hostHomeDir ? pathImpl.join(hostHomeDir, '.ai_home') : '';
  const bundled = resolveZcodeBundledCli({ fs: fsImpl, path: pathImpl, hostHomeDir });
  if (!bundled || !bundled.cliPath) return fail('找不到 ZCode CLI bundle（请确认 ZCode Desktop 已安装）');
  const aiHomeDir = normalizeText(deps.aiHomeDir);
  const accountRef = normalizeText(env.AIH_PROVIDER_ACCOUNT_REF) || normalizeText(deps.accountRef);

  const builtinConfig = readBuiltinConfig(fsImpl, bundled.configPath);
  if (!builtinConfig) return fail('读不到内置 provider 配置（ZCode Desktop 安装可能不完整）');
  // providerId 推导优先级（2026-11-04 修订）：
  //   1. **账号凭据里已声明的键**（identity / auth-source，多个时 start-plan 优先 ——
  //      账号 11 两组键都有，桌面端用的正是 `account:zai-start-plan`）；
  //   2. 套餐名命中的内置规则（账号真实套餐才是可用路由）；
  //   3. 家族回落（start-plan → individual-coding-plan，无声明键的账号沿用旧行为）。
  // 声明键必须同时存在于内置配置里才算数（键名来自凭据，规则来自 Desktop 安装包）。
  const declaredRule = pickDeclaredProviderRule(
    builtinConfig,
    readDeclaredProviderIds(fsImpl, aiHomeDir, accountRef)
  );
  const planRule = resolveProviderRule(builtinConfig, {
    region: readAccountRegion(fsImpl, aiHomeDir, accountRef),
    planLabel: readAccountPlanLabel(fsImpl, aiHomeDir, accountRef)
  });
  const providerRule = declaredRule || planRule;
  const providerId = normalizeText(providerRule && providerRule.providerId);
  const ruleModels = (((providerRule && providerRule.config) || {}).builtinModelIds || []);

  const envForCli = ensureProviderConfigEnv(env, { fs: fsImpl, path: pathImpl, builtinConfigPath: bundled.configPath });
  // 模型挑选：CLI 自己写的「已启用模型」优先（登录时刷新写回的账号实际可用集），
  // 其次 defaultModelSelection（providerId 命中才认），最后才退内置规则的第一个。
  const modelId = normalizeText(
    readPersonalModelId(fsImpl, envForCli[PROVIDER_CONFIG_ENV.PERSONAL], providerId)
    || ruleModels[0]
    || readRuleModels(builtinConfig, providerId)[0]
  );
  if (!providerId || !modelId) return fail('内置配置里没有可用的 provider/模型（无法声明账号 provider）');
  // 账号 provider overlay：**完整载荷**（全部 provider + revision 指纹），形状来自真机抓包。
  // basedOn 指纹必须哈希 CLI **实际加载的内置配置**路径（不是个人配置）：
  // 指纹对不上时 overlay 会被注册表静默丢弃（表现为 `Provider Registry 中不存在 Model`）。
  const accountConfig = buildZcodeAccountOverlay({
    builtinConfig,
    activeBuiltinConfigPath: envForCli[PROVIDER_CONFIG_ENV.BUILTIN],
    providerId,
    modelIds: ruleModels
  });
  const result = await runZcodeAppServerPrompt({
    env: envForCli,
    cliPath: bundled.cliPath,
    prompt,
    providerId,
    modelId,
    accountConfig,
    // 凭据形态按套餐分叉（start-plan=jwt 直通，coding-plan=PAT）：driver 据此选
    // apiKey，见 zcode-app-server-run.js 的 planMode 分支。
    planMode: normalizeText(providerRule && providerRule.config && providerRule.config.access
      && providerRule.config.access.mode),
    // revision 必须来自内置配置：缺它 `provider/updateAccountConfig` 直接被 schema 拒
    // （Invalid params — basedOnZCodeBuiltinRevision: Too small），账号 provider overlay 落不了地。
    builtinConfigPath: bundled.configPath,
    workspacePath: normalizeText(deps.workspacePath) || process.cwd(),
    cliDbPath: normalizeText(deps.cliDbPath) || pathImpl.join(hostHomeDir, '.zcode', 'cli', 'db', 'db.sqlite'),
    // 与桌面通道/relay 共用同一份画像缓存：学一次，两条通道都受益。
    // **缓存是宿主级资产**（server/桌面钩子都写在宿主 ai_home/run）：CLI 在账号投影里
    // 跑时它的 aiHomeDir 指向投影 `.ai_home`，那里永远没有 store（2026-11-04 真机：
    // 投影 store 缺失 → 画像钩子空载 → CLI 自报 (0.17.1, 自己的 system) 这对从未被
    // 上游放行过 → turn 稳定 model_request_failed）。所以优先宿主 ai_home，缺失才退。
    profileHookPath: require.resolve('../../../../runtime/zcode-outbound-profile.js'),
    harnessStorePath: resolveZcodeHarnessStorePath({ aiHomeDir: hostAiHomeDir })
      || (aiHomeDir ? resolveZcodeHarnessStorePath({ aiHomeDir }) : ''),
    timeoutMs: Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : undefined,
    deps: { fs: fsImpl, path: pathImpl, aiHomeDir, accountRef, hostHomeDir, spawnImpl: deps.spawnImpl }
  });
  if (!result.ok) return fail(result.error || 'app-server 运行失败');
  emit(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
  return { exitCode: 0 };
}

// provider 无关的 runner 契约：native 路径失败后由派发层问它「值不值得换路」。
const zcodeHeadlessRunner = Object.freeze({
  id: 'zcode-app-server',
  // auto 模式的**优先判定**：**当前恒为 false**（native 先行，完整凭据的账号零开销）。
  //
  // native 失败时由 headless-spawn 的**自动换路**兜底（shouldFallbackFromNative）：
  // 输出命中 ROUTE_UNUSABLE_SIGNATURES（"Select a model…" / "Provider Registry…" /
  // 余额类文案）就用 app-server 通路重跑一次。答案读取走会话库
  // （lib/sessions/zcode-session-store.js，真机 ping → pong），app-server 通路
  // 端到端可用后换路是体验修复而不是退化。
  shouldPrefer: () => false,
  shouldFallbackFromNative: (output) => {
    const text = String(output || '');
    return ROUTE_UNUSABLE_SIGNATURES.some((signature) => text.includes(signature));
  },
  run: runZcodeHeadlessViaAppServer
});

module.exports = {
  PROVIDER_CONFIG_ENV,
  ROUTE_UNUSABLE_SIGNATURES,
  pickDeclaredProviderRule,
  readDeclaredProviderIds,
  readPersonalModelId,
  resolveProviderRule,
  runZcodeHeadlessViaAppServer,
  zcodeHeadlessRunner
};
