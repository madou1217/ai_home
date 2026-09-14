'use strict';

// 「刚装上的这个版本到底好不好用」的判定。
//
// 通用兜底判据必须比 `--version` 强：这次事故里 codex 0.154 的失败是 app-server 启动时
// 拒绝加载配置，而 `codex --version` 照常通过。所以兜底判据瞄准的是另一件事——
// **同一性断言**：重新解析一次「aih 会启动哪个二进制」，它必须既是我们刚写的那个位置，
// 版本也必须正是目标版本。
//
// 同一性断言是防影子二进制的唯一一环。本机实测 opencode 有三份非 npm 安装外加一个 npm 包；
// 在那种局面下「装成功了」和「装的那份会被启动」是两件事，少了这道断言就会出现最恶劣的
// 形态：升级成功、回滚成功、跑的还是坏的那份，监控全绿而故障照旧。
//
// 三态而非二态：只有拿到**正向失败信号**才回滚。探针自己出错、超时、拿不到版本号，
// 一律 inconclusive —— 放行但不推进 knownGood，绝不据此回滚。

const VERDICTS = Object.freeze({ PASS: 'pass', FAIL: 'fail', INCONCLUSIVE: 'inconclusive' });

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

function sameVersion(left, right) {
  return normalize(left) === normalize(right);
}

/**
 * 通用兜底判据。
 *
 * deps:
 *   resolveCliPath(provider) -> string   重新解析 aih 会启动哪个二进制
 *   probeVersion(path)       -> string   探测该二进制自报的版本
 *   realpath(path)           -> string   可选，用于同一性比较
 */
async function verifyByIdentity(provider, expectedVersion, deps = {}) {
  let resolvedPath = '';
  try {
    resolvedPath = normalize(await deps.resolveCliPath(provider));
  } catch (error) {
    return { verdict: VERDICTS.INCONCLUSIVE, detail: `resolve_failed:${error && error.message}` };
  }
  if (!resolvedPath) {
    // 装完却解析不到任何可执行文件，这是正向的坏消息，不是「没测出来」。
    return { verdict: VERDICTS.FAIL, detail: 'cli_not_resolved_after_install' };
  }

  const expectedOwner = normalize(deps.expectedOwnerPath);
  if (expectedOwner) {
    const realpath = typeof deps.realpath === 'function' ? deps.realpath : (value) => value;
    let actualOwner = '';
    try {
      actualOwner = normalize(realpath(resolvedPath));
    } catch (_error) {
      actualOwner = resolvedPath;
    }
    if (actualOwner !== expectedOwner) {
      // 装的那份不是会被启动的那份 —— 影子二进制。
      return {
        verdict: VERDICTS.FAIL,
        detail: `owner_mismatch:${actualOwner}!=${expectedOwner}`
      };
    }
  }

  let reported = '';
  try {
    reported = normalize(await deps.probeVersion(resolvedPath));
  } catch (error) {
    return { verdict: VERDICTS.INCONCLUSIVE, detail: `probe_failed:${error && error.message}` };
  }
  if (!reported) return { verdict: VERDICTS.INCONCLUSIVE, detail: 'version_unreported' };

  return sameVersion(reported, expectedVersion)
    ? { verdict: VERDICTS.PASS, detail: `version_matched:${reported}` }
    : { verdict: VERDICTS.FAIL, detail: `version_mismatch:${reported}!=${normalize(expectedVersion)}` };
}

/**
 * 组合判据：先过通用兜底，再让该 provider 的强判据有机会否决。
 * 强判据只能把 pass 改判为 fail/inconclusive，不能把 fail 洗成 pass ——
 * 同一性断言失败时再做任何功能探测都没有意义。
 */
function createUpgradeVerifier(options = {}) {
  const strongVerifiers = options.strongVerifiers || {};

  return async function verify(provider, expectedVersion) {
    const baseline = await verifyByIdentity(provider, expectedVersion, options);
    if (baseline.verdict !== VERDICTS.PASS) return baseline;

    const strong = strongVerifiers[provider];
    if (typeof strong !== 'function') return baseline;
    try {
      const result = await strong({ provider, expectedVersion, ...options });
      if (!result || !result.verdict) return baseline;
      return result;
    } catch (error) {
      // 强判据自身出错不得连累结论：降级为 inconclusive，放行但不推进 knownGood。
      return { verdict: VERDICTS.INCONCLUSIVE, detail: `strong_verifier_error:${error && error.message}` };
    }
  };
}

module.exports = { VERDICTS, verifyByIdentity, createUpgradeVerifier };
