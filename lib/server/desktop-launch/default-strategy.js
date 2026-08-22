'use strict';

/**
 * Desktop 启动策略的中性默认实现。
 *
 * 账号应用启动器（account-app-launcher）只依赖这份抽象，永远不按 provider 名
 * 分支。任何 provider 私有的启动细节——单实例身份、env 覆写、启动形态、托管
 * 登录准备——都由该 provider 自己的策略模块实现（Open/Closed + DIP）。
 *
 * @typedef {Object} DesktopLaunchContext
 * @property {string} provider
 * @property {object|null} account            解析后的账号记录
 * @property {string} accountRef
 * @property {string} profileDir              账号沙箱目录
 * @property {string} userDataDir             Electron --user-data-dir
 * @property {string} applicationName         resolveInstanceName 的结果（env 装饰阶段可复用）
 * @property {string} platformKey             'macos' | 'windows' | 'linux'
 * @property {object} fs
 * @property {object} path                    目标平台的 path 实现
 * @property {string} aiHomeDir
 * @property {() => object} getBaseEnv        宿主 env 快照（未沙箱化）
 * @property {object} deps                    启动器透传的可注入依赖，策略自取所需
 *
 * @typedef {Object} DesktopSessionResult
 * @property {boolean} ready                  false 时中止启动并回传 error/reason
 * @property {string} [error]
 * @property {string} [reason]
 * @property {boolean} [requiresRestart]      true 时需重启该账号已有实例后再启动
 *
 * @typedef {Object} DesktopSpawnPlan
 * @property {string} file
 * @property {string[]} args
 *
 * @typedef {Object} DesktopLaunchStrategy
 * @property {string} name
 * @property {boolean} reuseRunningInstance   已有实例时是否直接复用（默认 true）
 * @property {string} restartFailedError      需要重启却失败时的错误码
 * @property {(ctx: DesktopLaunchContext) => string} resolveInstanceName
 * @property {(commandLine: string) => string} parseInstanceName
 * @property {(env: object, ctx: DesktopLaunchContext) => void} decorateLaunchEnv
 * @property {(env: object, resolved: object, ctx: DesktopLaunchContext) => void} decorateResolvedLaunchEnv
 * @property {(resolved: object, ctx: DesktopLaunchContext) => DesktopSpawnPlan} resolveSpawnPlan
 * @property {(ctx: DesktopLaunchContext) => DesktopSessionResult} prepareLaunchSession
 */

const DEFAULT_RESTART_FAILED_ERROR = 'desktop_restart_failed';

// resolveElectronSpawnPlan 是 Electron 桌面端的通用启动形态：直接执行主程序并
// 绑定账号专属 user-data 目录。需要 launcher/bundle 间接启动的 provider 覆写它。
function resolveElectronSpawnPlan(resolved, ctx) {
  return {
    file: resolved.executablePath,
    args: [`--user-data-dir=${ctx.userDataDir}`]
  };
}

/**
 * createDesktopLaunchStrategy 用中性默认补齐未实现的钩子，
 * provider 策略只需声明与自己相关的那几个。
 *
 * @param {Partial<DesktopLaunchStrategy>} overrides
 * @returns {DesktopLaunchStrategy}
 */
function createDesktopLaunchStrategy(overrides = {}) {
  return Object.freeze({
    name: String(overrides.name || 'default'),
    reuseRunningInstance: overrides.reuseRunningInstance !== false,
    restartFailedError: String(overrides.restartFailedError || DEFAULT_RESTART_FAILED_ERROR),
    // 默认身份只有 --user-data-dir，不额外派生应用名。
    resolveInstanceName: typeof overrides.resolveInstanceName === 'function'
      ? overrides.resolveInstanceName
      : () => '',
    parseInstanceName: typeof overrides.parseInstanceName === 'function'
      ? overrides.parseInstanceName
      : () => '',
    // 默认不叠加任何 provider 私有变量，沙箱 env 原样使用。
    decorateLaunchEnv: typeof overrides.decorateLaunchEnv === 'function'
      ? overrides.decorateLaunchEnv
      : () => {},
    // 仅当 provider 的子进程命令依赖已解析的 Desktop bundle 路径时使用。
    decorateResolvedLaunchEnv: typeof overrides.decorateResolvedLaunchEnv === 'function'
      ? overrides.decorateResolvedLaunchEnv
      : () => {},
    resolveSpawnPlan: typeof overrides.resolveSpawnPlan === 'function'
      ? overrides.resolveSpawnPlan
      : resolveElectronSpawnPlan,
    // 默认无托管登录准备，直接放行。
    prepareLaunchSession: typeof overrides.prepareLaunchSession === 'function'
      ? overrides.prepareLaunchSession
      : () => ({ ready: true })
  });
}

const defaultDesktopLaunchStrategy = createDesktopLaunchStrategy({ name: 'default' });

module.exports = {
  DEFAULT_RESTART_FAILED_ERROR,
  createDesktopLaunchStrategy,
  defaultDesktopLaunchStrategy,
  resolveElectronSpawnPlan
};
