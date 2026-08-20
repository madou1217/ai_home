'use strict';

const {
  ACCOUNT_APP_MARKER_ENV,
  PROVIDER_ACCOUNT_REF_ENV,
  normalizeProviderAccountRef
} = require('./provider-session-context');

// buildAccountAppProcessTitle 把仅存在于环境变量中的 Toolkit 启动意图
// 投影为非敏感进程标题，使 POSIX ps 可以稳定识别长期存活的 aih 父进程。
function buildAccountAppProcessTitle(argv, env = {}) {
  if (String(env[ACCOUNT_APP_MARKER_ENV] || '').trim() !== '1') return '';
  const values = Array.isArray(argv) ? argv : [];
  const provider = String(values[2] || '').trim().toLowerCase();
  const cliAccountId = String(values[3] || '').trim();
  if (!/^[a-z0-9_-]+$/.test(provider) || !/^\d+$/.test(cliAccountId)) return '';

  const accountRef = normalizeProviderAccountRef(env[PROVIDER_ACCOUNT_REF_ENV]);
  return [
    'aih',
    provider,
    cliAccountId,
    `${ACCOUNT_APP_MARKER_ENV}=1`,
    accountRef ? `${PROVIDER_ACCOUNT_REF_ENV}=${accountRef}` : ''
  ].filter(Boolean).join(' ');
}

function markAccountAppProcess(processObj = process) {
  // Windows 的 cmd /k 命令行会持续保留 set marker；避免制造嵌套 marker 根。
  if (String(processObj && processObj.platform || '').toLowerCase() === 'win32') return '';
  const title = buildAccountAppProcessTitle(processObj && processObj.argv, processObj && processObj.env);
  if (!title) return '';
  try {
    processObj.title = title;
    return title;
  } catch (_error) {
    return '';
  }
}

module.exports = {
  buildAccountAppProcessTitle,
  markAccountAppProcess
};
