'use strict';

// 解除熔断：熔断是 runner 的终局状态，代码不会自愈重试，只能人工清除。
// 「人工」不等于盲目：清除前用与升级同一套验证器验证当前会被启动的那份 CLI，
// 通过才解除，并把它记为新的回退锚点（knownGood）；不通过就保持熔断并给出原因。
// 只看验证结论，不做任何安装动作。

const { CHANNEL_CAPABILITIES } = require('./upgrade-channel');
const { appendHistory, readProviderRecord, writeProviderRecord } = require('./upgrade-ledger');
const { VERDICTS } = require('./upgrade-verifier');

const BROKEN_STATE = 'broken';
const HEALTHY_STATE = 'healthy';

/**
 * @returns {Promise<{ok: boolean, ledger: object, reason: string, detail?: string, version?: string}>}
 */
async function clearBrokenProvider(provider, ledger, deps, now = Date.now()) {
  const record = readProviderRecord(ledger, provider);
  // 熔断在账本里落三处：state=broken、enabled=false、把当时验证失败的目标版本拉黑。
  // 只看 state 会漏掉「状态已改回但 enabled 仍为 false」的半解除账本（自动升级照样停着）。
  if (record.state !== BROKEN_STATE && record.enabled !== false) return { ok: false, ledger, reason: 'not_broken' };

  let version = '';
  try {
    version = String(await deps.probeInstalledVersion(provider) || '').trim();
  } catch (error) {
    return { ok: false, ledger, reason: 'installed_version_unknown', detail: String(error && error.message || error) };
  }
  if (!version) return { ok: false, ledger, reason: 'installed_version_unknown' };

  let verdict;
  try {
    verdict = await deps.verify(provider, version);
  } catch (error) {
    verdict = { verdict: VERDICTS.INCONCLUSIVE, detail: String(error && error.message || error) };
  }
  // 只有明确通过才解除：inconclusive 意味着没能确证当前版本可用，贸然解除等于没有安全网。
  if (!verdict || verdict.verdict !== VERDICTS.PASS) {
    return {
      ok: false,
      ledger,
      reason: verdict && verdict.verdict === VERDICTS.FAIL ? 'verify_failed' : 'verify_inconclusive',
      detail: String(verdict && verdict.detail || ''),
      version
    };
  }

  const capabilities = CHANNEL_CAPABILITIES[record.channel] || {};
  // 当前版本刚验证通过，说明它当初被拉黑是误判（例如版本比较缺陷），从黑名单移除；
  // 其他拉黑版本不在本次验证范围内，保持不动。
  const blockedVersions = (Array.isArray(record.blockedVersions) ? record.blockedVersions : [])
    .filter((blocked) => blocked !== version);
  const next = writeProviderRecord(ledger, provider, {
    state: HEALTHY_STATE,
    enabled: true,
    disabledReason: '',
    blockedVersions,
    installedVersion: version,
    knownGoodVersion: version,
    knownGoodRollbackable: Boolean(capabilities.pinnable),
    baselineHealthy: true,
    targetVersion: '',
    lastApplyError: '',
    consecutiveFailures: 0,
    consecutiveDefers: 0,
    consecutiveQuiescentTicks: 0,
    lastDeferReason: '',
    history: appendHistory(record, {
      at: now,
      from: record.installedVersion,
      to: version,
      outcome: 'cleared',
      detail: `manual_clear:${String(verdict.detail || 'verified')}`
    })
  });
  return { ok: true, ledger: next, reason: 'cleared', detail: String(verdict.detail || ''), version };
}

module.exports = { clearBrokenProvider };
