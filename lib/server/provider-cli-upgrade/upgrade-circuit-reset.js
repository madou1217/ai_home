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
  if (record.state !== BROKEN_STATE) return { ok: false, ledger, reason: 'not_broken' };

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
  const next = writeProviderRecord(ledger, provider, {
    state: HEALTHY_STATE,
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
