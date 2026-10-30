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
// modelId 取该规则的第一个 `builtinModelIds`（与桌面端 `modelSelection` 同源）。

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

/** 账号凭据里是否已经带了某个 account provider（桌面端登录时自己写的键）。 */
function readDeclaredProviderId(fsImpl, aiHomeDir, accountRef) {
  const credentials = readAccountCredentials(fsImpl, aiHomeDir, accountRef);
  const key = Object.keys(credentials).find((name) => /^account-provider:.*:identity$/.test(name));
  return key ? key.replace(/^account-provider:/, '').replace(/:identity$/, '') : '';
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
  const bundled = resolveZcodeBundledCli({ fs: fsImpl, path: pathImpl, hostHomeDir });
  if (!bundled || !bundled.cliPath) return fail('找不到 ZCode CLI bundle（请确认 ZCode Desktop 已安装）');
  const aiHomeDir = normalizeText(deps.aiHomeDir);
  const accountRef = normalizeText(env.AIH_PROVIDER_ACCOUNT_REF) || normalizeText(deps.accountRef);

  const builtinConfig = readBuiltinConfig(fsImpl, bundled.configPath);
  if (!builtinConfig) return fail('读不到内置 provider 配置（ZCode Desktop 安装可能不完整）');
  const declaredProviderId = readDeclaredProviderId(fsImpl, aiHomeDir, accountRef);
  // providerId 推导优先级：**套餐名命中的内置规则优先**（账号真实套餐才是可用路由：
  // 账号 11 的凭据里被 CLI 写成 `individual-coding-plan`，但它实际是 Start Plan，
  // 桌面端用的正是 `account:zai-start-plan`），其次才是凭据里已声明的键。
  const planRule = resolveProviderRule(builtinConfig, {
    region: readAccountRegion(fsImpl, aiHomeDir, accountRef),
    planLabel: readAccountPlanLabel(fsImpl, aiHomeDir, accountRef)
  });
  const providerId = normalizeText(planRule && planRule.providerId) || declaredProviderId;
  const ruleModels = (((planRule && planRule.config) || {}).builtinModelIds || []);
  const modelId = normalizeText(ruleModels[0] || readRuleModels(builtinConfig, providerId)[0]);
  if (!providerId || !modelId) return fail('内置配置里没有可用的 provider/模型（无法声明账号 provider）');

  const envForCli = ensureProviderConfigEnv(env, { fs: fsImpl, path: pathImpl, builtinConfigPath: bundled.configPath });
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
    // revision 必须来自内置配置：缺它 `provider/updateAccountConfig` 直接被 schema 拒
    // （Invalid params — basedOnZCodeBuiltinRevision: Too small），账号 provider overlay 落不了地。
    builtinConfigPath: bundled.configPath,
    workspacePath: normalizeText(deps.workspacePath) || process.cwd(),
    cliDbPath: normalizeText(deps.cliDbPath) || pathImpl.join(hostHomeDir, '.zcode', 'cli', 'db', 'db.sqlite'),
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
  // auto 模式的**优先判定**：**当前恒为 false**（保持现状不退化）。
  //
  // 事实（2026-10-28 真机）：app-server 的**轮次**已经能建立（`provider/updateAccountConfig`
  // 接受、`session/send` 回 `accepted:true`），但**助手文本走 v4 wire 的
  // `v4/conversation/frame`**，而该通道需要一个走 WebSocket 的 **hello 帧**
  // （bundle 的 app-server capabilities 里 `websocketRpc: true`）—— 只走 stdio JSON-RPC
  // 时服务端只推 2 帧（初始 snapshot + 首个 delta）就停，会话库也不落答案
  // （原型 /tmp/zapp8.cjs 同样只收到 2 帧）。因此**在 hello/流控补齐之前**，auto 不能
  // 把 Start Plan 账号从 native 切到 app-server：那会把「上游报余额不足（有原因）」
  // 变成「静默超时（无原因）」，是体验退化。
  //
  // 补齐后把这里改成按推导出的 providerId 判断（`/start-plan$/` 即优先 app-server），
  // 判定逻辑见下方注释保留的实现意图；在此之前，app-server 通路只能显式开启：
  //   `aih zcode <id> -p '…' --aih-headless-runner app-server`
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
  resolveProviderRule,
  runZcodeHeadlessViaAppServer,
  zcodeHeadlessRunner
};
