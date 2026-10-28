'use strict';

/**
 * 补全用的两个「更贵一点」的候选来源，都**只在对应位置**才加载：
 * - 会话 id（`aih <cli> resume|fork <TAB>`）：读该 provider 自己的会话库（约 140ms）。
 * - server config 的选项（`aih server config set --<TAB>`）：读 `SERVER_CONFIG_FIELDS`
 *   这张唯一描述符表（约 50ms），因此 `aih server config set` 能补的选项永远和
 *   `aih server config list` / `--help` 同源，不会各写一份。
 *
 * 两者都 fail-soft：读不到就返回空列表（补全不该因为底层读失败而报错）。
 */

const SESSION_CANDIDATE_LIMIT = 10;
const ACCOUNT_SCOPED_SESSION_PROVIDERS = new Set(['cline', 'qoder', 'qodercn', 'kiro']);

/** `aih <cli> resume|fork <TAB>` 的候选：该 provider 的会话 id（带标题与时间）。 */
function listProviderSessions(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const limit = Math.max(1, Number(options.limit) || SESSION_CANDIDATE_LIMIT);
  if (!id) return [];
  try {
    const { readProjectsFromHostByProviders } = require('../../sessions/session-reader');
    const { resolveAiHomeDir } = require('../../runtime/aih-home');
    const { resolveHostHomeDir } = require('../../runtime/host-home');
    // aiHomeDir/hostHomeDir 必须显式给出：账号投影型 provider（cline/kiro/qoder/grok）
    // 的读取器要靠它们定位「每个账号的存储」与宿主共享目录。
    const env = options.env || process.env;
    const readerOptions = {
      aiHomeDir: options.aiHomeDir || resolveAiHomeDir({ env }),
      hostHomeDir: options.hostHomeDir || resolveHostHomeDir({ env }),
      ...(options.readerOptions || {})
    };
    const projects = readProjectsFromHostByProviders([id], readerOptions) || [];
    const sessions = [];
    for (const project of projects) {
      for (const session of (project && project.sessions) || []) {
        const sessionId = String((session && session.id) || '').trim();
        if (!sessionId) continue;
        sessions.push({
          id: sessionId,
          title: String((session && (session.title || session.summary)) || '').trim(),
          updatedAt: String((session && (session.updatedAt || session.lastActiveAt || session.createdAt)) || '').trim()
        });
      }
    }
    sessions.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
      || right.updatedAt.localeCompare(left.updatedAt));
    return sessions.slice(0, limit);
  } catch (_error) {
    return [];
  }
}

/** `aih server config …` 的选项：来自唯一描述符表，说明取该字段的第一句。 */
function listServerConfigFlags(options = {}) {
  try {
    const { SERVER_CONFIG_FIELDS } = require('../../server/server-config-schema');
    const flags = [];
    const seen = new Set();
    for (const field of SERVER_CONFIG_FIELDS || []) {
      const summary = String((field && field.summary) || '').split('。')[0];
      for (const raw of String((field && field.flag) || '').split('|')) {
        const name = raw.trim().split(/\s+/)[0];
        if (!name || seen.has(name)) continue;
        seen.add(name);
        flags.push({ value: name, description: summary });
      }
    }
    return flags;
  } catch (_error) {
    return [];
  }
}

module.exports = {
  ACCOUNT_SCOPED_SESSION_PROVIDERS,
  SESSION_CANDIDATE_LIMIT,
  listProviderSessions,
  listServerConfigFlags
};
