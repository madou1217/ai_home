// provider CLI 自动升级状态面的纯展示映射。
//
// 后端回的是闭环内部的枚举（reason/state 全是 snake_case 英文），面板要的是一句人话。
// 映射放在这里而不是 .tsx 里，是为了能脱离 React 单测 —— 这些分支的取舍（什么算
// 「要人管」、被拉黑的版本算不算「有新版」）是有业务含义的，不该埋在渲染函数里。

import type {
  ProviderCliUpgradeRecord,
  ProviderCliUpgradeSchedulerState,
  ProviderCliUpgradeStatusResponse
} from '@/types';

export type ProviderCliUpgradeTone = 'success' | 'warning' | 'error' | 'active' | 'neutral';

export interface ProviderCliUpgradeRowPresentation {
  provider: string;
  statusLabel: string;
  statusTone: ProviderCliUpgradeTone;
  versionText: string;
  reasonText: string;
  channelLabel: string;
  lastCheckText: string;
  /** 需要人介入才会变好的状态：熔断、回滚、装/验失败。 */
  attention: boolean;
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  standalone_release: '官方版本化安装',
  npm_global: 'npm 全局',
  vendor_selfupdate: '厂商自更新',
  homebrew: 'Homebrew',
  unknown: '未识别'
});

// 闭环每一轮对每个 provider 只会落一个 reason，这里要求全覆盖：漏掉的会原样显示英文，
// 那正是「面板在骗人」的开始，所以宁可列长一点。
const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  up_to_date: '已是最新版',
  upgrade_available: '有新版可用',
  apply_disabled: '仅检查，未安装',
  awaiting_quiescence: '等待空闲确认',
  deferred_busy: '该 CLI 正在使用，本轮推迟',
  verified_pass: '升级完成并通过验证',
  verified_inconclusive: '升级完成，验证未能确证',
  verify_failed: '升级后验证失败',
  rolled_back: '已回滚到上一个可用版本',
  rollback_install_failed: '回滚安装失败',
  rollback_verify_failed: '回滚后仍验证失败',
  rollback_post_install_failed: '回滚后 hook 未能恢复',
  rollback_plan_unavailable: '没有可用的回滚方案',
  baseline_unhealthy: '当前版本本身验证不通过',
  provider_broken: '已熔断，暂停自动升级',
  global_disabled: '自动升级已全局关闭',
  version_blocked: '目标版本已被拉黑',
  user_pinned: '已被手动钉版本',
  channel_not_pinnable: '当前安装渠道不支持钉版本',
  channel_detect_failed: '安装渠道识别失败',
  check_failed: '检查失败',
  latest_version_unknown: '查不到远端版本',
  latest_version_unparsable: '远端版本号无法解析',
  latest_is_prerelease: '远端最新版是预发布版',
  installed_version_unknown: '本地版本探测失败',
  version_compare_failed: '版本比较失败',
  known_good_not_rollbackable: '没有可回退的已验证版本',
  soaking: '新版本静置观察中',
  soak_pending_unknown_publish_time: '查不到发布时间，暂不跟进',
  soak_unknown: '发布时间长期查不到',
  missing_package_name: '该 CLI 没有 npm 包',
  npm_plan_unavailable: '生成 npm 安装方案失败',
  standalone_plan_unavailable: '生成官方安装方案失败',
  invalid_version: '版本号非法',
  apply_failed_lock_busy: '安装被占用（文件锁）',
  apply_failed_network: '安装失败：网络不可达',
  apply_failed_not_found: '安装失败：版本不存在',
  apply_failed_hard_failure: '安装失败'
});

const ATTENTION_STATES = Object.freeze(['broken', 'rolled_back', 'baseline_unhealthy']);

export function getUpgradeChannelLabel(channel?: string) {
  const normalized = String(channel || '').trim();
  if (!normalized) return '未检测';
  return CHANNEL_LABELS[normalized] || normalized;
}

export function getUpgradeReasonLabel(reason?: string) {
  const normalized = String(reason || '').trim();
  if (!normalized) return '';
  // 认不出来的一律原样显示：面板宁可露出内部枚举，也不该把未知状态粉饰成已知的那几种。
  return REASON_LABELS[normalized] || normalized;
}

export function formatUpgradeTimestamp(at?: number, now: number = Date.now()) {
  const value = Number(at) || 0;
  if (value <= 0) return '从未';
  const diff = Math.max(0, now - value);
  const minute = 60 * 1000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  const hour = 60 * minute;
  if (diff < 24 * hour) return `${Math.floor(diff / hour)} 小时前`;
  return `${Math.floor(diff / (24 * hour))} 天前`;
}

export function formatUpgradeInterval(intervalMs?: number) {
  const value = Number(intervalMs) || 0;
  if (value <= 0) return '';
  const hours = value / (60 * 60 * 1000);
  if (hours >= 1) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
  return `${Math.max(1, Math.round(value / (60 * 1000)))} 分钟`;
}

/** 顶部那句话必须先说清「会不会动我的机器」——这是本功能最容易被误解的地方。 */
export function getUpgradeModeSummary(
  scheduler: ProviderCliUpgradeSchedulerState | null,
  global?: { enabled: boolean; disabledReason: string }
) {
  if (global && global.enabled === false) {
    const reason = getUpgradeReasonLabel(global.disabledReason);
    return { label: '已全局停用', tone: 'error' as ProviderCliUpgradeTone, detail: reason || '需要人工恢复' };
  }
  if (!scheduler) {
    return { label: '状态不可用', tone: 'neutral' as ProviderCliUpgradeTone, detail: '调度器未运行' };
  }
  if (!scheduler.enabled) {
    return { label: '已关闭', tone: 'neutral' as ProviderCliUpgradeTone, detail: '不检查也不安装' };
  }
  const every = formatUpgradeInterval(scheduler.intervalMs);
  const cadence = every ? `每 ${every}检查一次` : '按周期检查';
  if (!scheduler.applyEnabled) {
    return { label: '仅检查', tone: 'active' as ProviderCliUpgradeTone, detail: `${cadence}，不会安装任何版本` };
  }
  return { label: '自动升级', tone: 'success' as ProviderCliUpgradeTone, detail: `${cadence}，空闲时自动升级` };
}

export function formatUpgradeVersions(record: ProviderCliUpgradeRecord) {
  const installed = String(record.installedVersion || '').trim();
  const latest = String(record.latestVersion || '').trim();
  if (!installed && !latest) return '未知';
  if (!installed) return `远端 ${latest}`;
  if (!latest || latest === installed) return installed;
  return `${installed} → ${latest}`;
}

// 判定顺序即优先级：坏消息永远盖过好消息，「还没查过」不能被显示成「已是最新」。
export function getProviderCliUpgradeRow(
  record: ProviderCliUpgradeRecord,
  scheduler: ProviderCliUpgradeSchedulerState | null,
  now: number = Date.now()
): ProviderCliUpgradeRowPresentation {
  const reason = record.lastTickReason || record.lastDeferReason || '';
  const base = {
    provider: record.provider,
    versionText: formatUpgradeVersions(record),
    reasonText: getUpgradeReasonLabel(reason),
    channelLabel: getUpgradeChannelLabel(record.channel),
    lastCheckText: formatUpgradeTimestamp(record.lastCheckAt, now)
  };

  if (record.enabled === false) {
    return {
      ...base,
      statusLabel: '已熔断',
      statusTone: 'error',
      reasonText: getUpgradeReasonLabel(record.disabledReason) || base.reasonText,
      attention: true
    };
  }
  if (ATTENTION_STATES.includes(String(record.state || ''))) {
    const labels: Record<string, string> = {
      broken: '异常',
      rolled_back: '已回滚',
      baseline_unhealthy: '当前版本异常'
    };
    return {
      ...base,
      statusLabel: labels[String(record.state)] || '异常',
      statusTone: record.state === 'rolled_back' ? 'warning' : 'error',
      attention: true
    };
  }
  if (!Number(record.lastCheckAt)) {
    return { ...base, statusLabel: '待首轮检查', statusTone: 'neutral', attention: false };
  }
  if (record.lastCheckError) {
    return {
      ...base,
      statusLabel: '检查失败',
      statusTone: 'warning',
      reasonText: String(record.lastCheckError),
      attention: false
    };
  }
  if (reason === 'deferred_busy') {
    return { ...base, statusLabel: '已推迟（忙）', statusTone: 'active', attention: false };
  }
  if (record.updateAvailable) {
    return {
      ...base,
      statusLabel: scheduler && scheduler.applyEnabled ? '待升级' : '有新版',
      statusTone: 'warning',
      attention: false
    };
  }
  return { ...base, statusLabel: '已是最新', statusTone: 'success', attention: false };
}

export function getProviderCliUpgradeRows(
  status: ProviderCliUpgradeStatusResponse | null,
  now: number = Date.now()
): ProviderCliUpgradeRowPresentation[] {
  if (!status || !Array.isArray(status.providers)) return [];
  return status.providers.map((record) => getProviderCliUpgradeRow(record, status.scheduler, now));
}
