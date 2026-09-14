'use strict';

// 把「升到/回到某个确切版本」翻译成可执行的 install plan。
//
// 升级与回滚共用同一个入口：回滚不是另一套机制，只是把目标版本换成 knownGood。
// 两条路径共用代码，回滚路径才不会因为长期不被触发而悄悄腐烂。
//
// 渠道差异（实测）：
//   standalone_release —— 官方 install.sh 第 5 行 `RELEASE="${CODEX_RELEASE:-latest}"`，
//     所以钉版本靠**环境变量**而不是命令行参数。走 env 而非拼字符串进 shell 命令，
//     没有注入面，且 POSIX/Windows 两端写法一致。
//   npm_global —— 钉版本靠 `pkg@version` 这个 spec 本身。
//
// 本模块只产出 plan，不执行；执行仍交给既有的 runInstallPlanAsync。

const { CHANNELS } = require('./upgrade-channel');
const {
  buildNpmPlan,
  buildPosixScriptPlan,
  buildPowerShellScriptPlan
} = require('../app-installers/official-install');

const CODEX_INSTALL_HOSTS = Object.freeze(['chatgpt.com', 'openai.com']);
const CODEX_INSTALL_SH = 'https://chatgpt.com/codex/install.sh';
const CODEX_INSTALL_PS1 = 'https://chatgpt.com/codex/install.ps1';

function normalizeVersionSpec(value) {
  const version = String(value == null ? '' : value).trim();
  // 版本号会进 env 与 npm spec，只放行语义化版本的安全字符集，其余一律拒绝。
  return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : '';
}

// 官方 install.sh 的 add_to_path 会在 BIN_DIR 不在 PATH 上时，**改写用户的 shell profile**
// （在 `# >>> Codex installer >>>` 标记之间插 export PATH）。实测隔离安装时它真的写了
// ~/.zprofile。后台自动升级绝不能悄悄改用户的 shell 配置，所以这里显式把 BIN_DIR 放进
// 子进程 PATH，让 add_to_path 走 early-return 分支。
function buildInstallDirEnv(options = {}) {
  const installDir = String(options.installDir || '').trim();
  if (!installDir) return {};
  const currentPath = String((options.env && options.env.PATH) || process.env.PATH || '');
  const separator = String(options.platform || process.platform) === 'win32' ? ';' : ':';
  const alreadyOnPath = currentPath.split(separator).some((entry) => entry === installDir);
  return {
    CODEX_INSTALL_DIR: installDir,
    ...(alreadyOnPath ? {} : { PATH: `${installDir}${separator}${currentPath}` })
  };
}

function buildStandalonePinnedPlan(version, options = {}) {
  const platform = String(options.platform || process.platform);
  const spec = {
    id: `codex_standalone_pin_${version}`,
    label: `安装 Codex ${version}（官方 standalone 渠道）`,
    url: platform === 'win32' ? CODEX_INSTALL_PS1 : CODEX_INSTALL_SH,
    hosts: CODEX_INSTALL_HOSTS,
    options
  };
  const plan = platform === 'win32'
    ? buildPowerShellScriptPlan(spec)
    : buildPosixScriptPlan(spec);
  if (!plan) return null;
  return {
    ...plan,
    // install.sh / install.ps1 都只认 CODEX_RELEASE 这个环境变量。
    env: { ...(plan.env || {}), CODEX_RELEASE: version, ...buildInstallDirEnv(options) },
    // 实测：install.sh 的 update_visible_command 会把 <BIN_DIR>/codex 替换成指向 current 的
    // 符号链接，而那个位置正是 aih 自己的 CLI hook 垫片。任何 standalone 升级之后都必须
    // 重新装回 hook，否则每次自动升级都会静默拆掉 aih 对 codex 的接管。
    postInstall: ['reinstall_codex_cli_hook']
  };
}

/**
 * 产出把某 provider 装到确切版本的 plan 数组。
 *
 * @param {{channel: string, packageName?: string, version: string,
 *   platform?: string}} input
 * @returns {{ok: boolean, plans: object[], reason: string}}
 */
function buildPinnedPlans(input = {}) {
  const version = normalizeVersionSpec(input.version);
  if (!version) return { ok: false, plans: [], reason: 'invalid_version' };

  const channel = String(input.channel || '').trim();
  if (channel === CHANNELS.STANDALONE_RELEASE) {
    const plan = buildStandalonePinnedPlan(version, input);
    return plan
      ? { ok: true, plans: [plan], reason: '' }
      : { ok: false, plans: [], reason: 'standalone_plan_unavailable' };
  }

  if (channel === CHANNELS.NPM_GLOBAL) {
    const packageName = String(input.packageName || '').trim();
    if (!packageName) return { ok: false, plans: [], reason: 'missing_package_name' };
    const plan = buildNpmPlan(`${packageName}@${version}`, input);
    return plan
      ? { ok: true, plans: [{ ...plan, id: `npm_global_pin_${version}` }], reason: '' }
      : { ok: false, plans: [], reason: 'npm_plan_unavailable' };
  }

  // 其余渠道无法钉版本 → 无法回滚 → 一律不产出 plan，由 policy 端拒绝自动升级。
  return { ok: false, plans: [], reason: 'channel_not_pinnable' };
}

module.exports = {
  CODEX_INSTALL_SH,
  CODEX_INSTALL_PS1,
  normalizeVersionSpec,
  buildPinnedPlans
};
