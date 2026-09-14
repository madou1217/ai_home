'use strict';

// 取某个 npm 版本的发布时间。这是 soak 闸门（新版本静置 48h 再跟进）唯一的输入。
//
// 它不是可选项：upgrade-policy 里拿不到 publishedAt 的两个分支**都是 SKIP**
// （soak_pending_unknown_publish_time → soak_unknown）。也就是说这个查询一旦长期失败，
// 整套自动升级就变成一块永远绿着的仪表盘 —— 从不出错，也从不升级任何东西。
// 所以这里的失败必须是**显式**的：返回 {ok:false, error}，让调用方把它记进账本，
// 而不是悄悄回落成 0。
//
// 为什么要把整张 time 表拉下来（@openai/codex 实测 4437 个键 / 253KB）：
// npm 的字段路径 `time.0.154.0` 在版本号含点时无法表达，实测取回空值；
// 而 registry 的精简 packument 根本不带 time。一个 provider 每 6h 一次 250KB，
// 用这个代价换「soak 闸门真的有数据」是划算的。

const { spawn } = require('node:child_process');

const { requiresCmdShell } = require('../../runtime/windows-cmd-launch');

const NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 15_000;

function normalizePackageName(value) {
  const packageName = String(value || '').trim();
  return /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i.test(packageName) ? packageName : '';
}

function normalizeVersionSpec(value) {
  const version = String(value || '').trim();
  return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : '';
}

function runNpmView(packageName, options) {
  const spawnImpl = options.spawn || spawn;
  const processObj = options.processObj || process;
  const isWindows = String(processObj.platform || process.platform) === 'win32';
  const command = isWindows ? 'npm.cmd' : 'npm';
  // 用户的 .npmrc 可能把 registry 指到私服或带上交互式配置，查发布时间不该受它影响。
  const args = [
    'view', packageName, 'time', '--json',
    `--userconfig=${isWindows ? 'NUL' : '/dev/null'}`,
    `--registry=${NPM_REGISTRY}`
  ];
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 60_000);

  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(command, args, {
        windowsHide: true,
        // 不开 shell 时 Windows 上 spawn('npm.cmd') 直接 EINVAL，soak 闸门永远拿不到
        // publishedAt —— 正是本文件头注释警告的那块「永远绿着的仪表盘」。
        shell: requiresCmdShell(command, processObj.platform || process.platform),
        env: options.env || processObj.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: String((error && error.message) || error) });
      return;
    }
    if (!child || typeof child.once !== 'function') {
      finish({ ok: false, stdout: '', stderr: 'npm_process_unavailable' });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.once('error', (error) => finish({ ok: false, stdout, stderr: String((error && error.message) || error) }));
    child.once('close', (code) => finish({ ok: code === 0, stdout, stderr }));
    timer = setTimeout(() => {
      try { child.kill?.(); } catch (_error) { /* 杀不掉就让它自己去 */ }
      finish({ ok: false, stdout, stderr: 'npm_view_timeout' });
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * @returns {Promise<{ok: boolean, publishedAt: number, error: string}>}
 *   publishedAt 是毫秒时间戳；ok 为 false 时恒为 0。
 */
async function fetchNpmPublishTime(packageName, version, options = {}) {
  const normalizedPackage = normalizePackageName(packageName);
  if (!normalizedPackage) return { ok: false, publishedAt: 0, error: 'unsupported_package' };
  const normalizedVersion = normalizeVersionSpec(version);
  if (!normalizedVersion) return { ok: false, publishedAt: 0, error: 'unsupported_version' };

  const result = await runNpmView(normalizedPackage, options);
  if (!result.ok) {
    return { ok: false, publishedAt: 0, error: String(result.stderr || '').trim().slice(0, 200) || 'npm_view_failed' };
  }

  let table;
  try {
    table = JSON.parse(result.stdout);
  } catch (_error) {
    return { ok: false, publishedAt: 0, error: 'npm_view_unparsable' };
  }
  if (!table || typeof table !== 'object') return { ok: false, publishedAt: 0, error: 'npm_view_unparsable' };

  const raw = table[normalizedVersion];
  if (!raw) {
    // registry 认得这个包但没有这个版本的时间戳（被 unpublish、或 time 表残缺）。
    // 这和「查询失败」是两回事，但对 soak 闸门是同一个结果：没有数据。
    return { ok: false, publishedAt: 0, error: 'publish_time_missing' };
  }
  const publishedAt = Date.parse(String(raw));
  if (!Number.isFinite(publishedAt)) return { ok: false, publishedAt: 0, error: 'publish_time_unparsable' };
  return { ok: true, publishedAt, error: '' };
}

module.exports = {
  NPM_REGISTRY,
  DEFAULT_TIMEOUT_MS,
  fetchNpmPublishTime
};
