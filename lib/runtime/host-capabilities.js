'use strict';

// 宿主机能力门面（Facade + Adapter）—— 回答三个问题，供上层（认证来源链 / 添加账号 UI）使用：
//   ① 这是桌面环境吗？             isDesktopHost()
//   ② 某个应用在这台机器上装了吗？  appAvailable(provider, 'desktop'|'cli')
//   ③ 装不了的话能装吗？            canInstall(provider, 'desktop'|'cli')
//
// 为什么要有这一层：这三件事各自已有实现，但它们分散在 server 侧，于是每个消费方都要自己去读
// 检测器、安装器注册表与平台判定（「添加账号」链路就是因为没走这一层，才写成让用户手动去拷文件）。
// 这里只做**组合与归一**，不新增任何探测逻辑：
//   * 应用已装 → lib/server/account-app-launcher.js 的 createAppEntryDetector（遍历 provider 定义、
//     解析桌面可执行文件与 CLI 二进制、30s 缓存）
//   * 可否安装 → lib/server/app-installers 的安装器注册表（每个 provider 自己的安装计划）
//   * 桌面环境 → 平台 + GUI 会话信号（纯函数，无 IO）
//
// 依赖方向是显式的：runtime 定义端口，server 侧模块经注入（或默认惰性 require）提供适配器。

const APP_KINDS = Object.freeze(['desktop', 'cli']);

/** 桌面环境判定（纯函数）：macOS / Windows 恒真；Linux 看有没有图形会话。 */
function isDesktopHost(input = {}) {
  const platform = String(input.platform || '').trim().toLowerCase();
  const env = input.env && typeof input.env === 'object' ? input.env : {};
  if (platform === 'darwin' || platform === 'win32') return true;
  if (platform === 'linux') return Boolean(String(env.DISPLAY || '').trim() || String(env.WAYLAND_DISPLAY || '').trim());
  return false;
}

function normalizeKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  return APP_KINDS.includes(value) ? value : 'desktop';
}

function createHostCapabilities(deps = {}) {
  const processObj = deps.processObj || process;
  const env = deps.env && typeof deps.env === 'object' ? deps.env : (processObj.env || {});
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  // 安装计划判定可能触发版本探测 → 按 provider|kind|平台 记忆一次。
  const installPlanCache = new Map();

  // 惰性解析默认适配器：测试可注入替身，避免真实进程扫描与文件系统探测。
  const resolveDetector = () => {
    if (deps.appEntryDetector) return deps.appEntryDetector;
    if (!deps.appEntryDetector) {
      const { createAppEntryDetector } = require('../server/account-app-launcher');
      deps.appEntryDetector = createAppEntryDetector({ fs: deps.fs, hostHomeDir });
    }
    return deps.appEntryDetector;
  };
  const resolveInstaller = (provider) => {
    if (typeof deps.getAppInstaller === 'function') return deps.getAppInstaller(provider);
    return require('../server/app-installers').getAppInstaller(provider);
  };
  const resolveDefinition = (provider) => {
    if (typeof deps.getProviderDefinition === 'function') return deps.getProviderDefinition(provider);
    return require('../provider-catalog').getProviderDefinition(provider);
  };
  const resolvePlatformKey = () => {
    if (typeof deps.normalizePlatform === 'function') return deps.normalizePlatform(processObj.platform);
    return require('../server/account-app-launcher').normalizePlatform(processObj.platform);
  };

  function describeHost() {
    const platform = String(processObj.platform || '').trim().toLowerCase();
    return {
      platform,
      platformKey: resolvePlatformKey(),
      desktop: isDesktopHost({ platform, env })
    };
  }

  /** 该 provider 的这一类应用入口在当前宿主机上是否**真的可用**（已安装且可解析）。 */
  function appAvailable(provider, kind = 'desktop') {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!normalizedProvider) return false;
    const entries = resolveDetector().detect() || {};
    const entry = entries[normalizedProvider];
    return Boolean(entry && entry[normalizeKind(kind)] === true);
  }

  /** 当前平台是否具备安装计划（权威判定：问安装器自己「这个平台有方案吗」）。 */
  function canInstall(provider, kind = 'desktop') {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!normalizedProvider) return false;
    const installer = resolveInstaller(normalizedProvider);
    if (!installer) return false;
    const normalizedKind = normalizeKind(kind);
    const cacheKey = `${normalizedProvider}|${normalizedKind}|${resolvePlatformKey()}`;
    if (installPlanCache.has(cacheKey)) return installPlanCache.get(cacheKey);
    let installable = false;
    try {
      if (normalizedKind === 'desktop') {
        // 安装器把「本平台有没有方案」表达为 resolveDesktopInstallPlans 的返回值
        // （平台不匹配时是空数组），因此直接问它，而不是自己读 desktop.<platform> 的内部形状。
        const plans = typeof installer.resolveDesktopInstallPlans === 'function'
          ? installer.resolveDesktopInstallPlans({ platform: processObj.platform, hostHomeDir, env })
          : [];
        installable = Array.isArray(plans) && plans.filter(Boolean).length > 0;
      } else {
        // CLI 的同类判定在 lib/server/app-install-job-manager.js 的 isCliInstallSupported 里，
        // 两处必须同结论（test/host-capabilities.test.js 有交叉守卫）。
        const definition = resolveDefinition(normalizedProvider);
        const standalone = Boolean(installer.managedApp && installer.managedApp.type === 'cli');
        const declaredCli = Boolean(definition && definition.clients && definition.clients.cli);
        installable = Boolean((declaredCli || standalone) && typeof installer.installCli === 'function');
      }
    } catch (_error) {
      // 安装器内部探测失败 → 保守回答「不可安装」，绝不乐观放行。
      installable = false;
    }
    installPlanCache.set(cacheKey, installable);
    return installable;
  }

  /** 给 UI 的完整描述：可用 / 可安装 / 不可用的原因。 */
  function describeProvider(provider) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const host = describeHost();
    const describeKind = (kind) => {
      const available = appAvailable(normalizedProvider, kind);
      const installable = !available && canInstall(normalizedProvider, kind);
      return {
        available,
        installable,
        reason: available ? '' : (installable ? 'not_installed_installable' : 'not_available')
      };
    };
    return {
      provider: normalizedProvider,
      host,
      desktop: describeKind('desktop'),
      cli: describeKind('cli')
    };
  }

  function invalidate() {
    if (deps.appEntryDetector && typeof deps.appEntryDetector.invalidate === 'function') {
      deps.appEntryDetector.invalidate();
    }
  }

  return { describeHost, isDesktopHost: () => describeHost().desktop, appAvailable, canInstall, describeProvider, invalidate };
}

module.exports = {
  APP_KINDS,
  createHostCapabilities,
  isDesktopHost,
  normalizeKind
};
