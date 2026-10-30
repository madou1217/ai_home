'use strict';

// Harness 活性探测注册表：**按 harness（CLI/Agent 本体）而不是 provider 账号**判定
// 「这个终端是不是正在跑回合」。
//
// 为什么粒度是 harness：
//   * 同一个 harness 可以用不同 provider 的账号：codex 走 relay 时，账号是别人的，
//     但「codex 正在推理」这个事实属于 codex 本身；
//   * 同一个 provider 账号也可以被不同 harness 使用（pi / dsh 通过网关用任意账号）；
//   * 回合的开始/结束信号由 harness 的原生会话生命周期给出（官方 hook、会话清单、
//     消息流），与账号池、上游协议无关。
//
// 因此本模块只回答「harness 怎么观测」，账号归属由持久会话注册表（aih 启动的
// pane → accountRef）或网关 attempt（relay 流量）负责，两者在 account-activity
// 聚合层汇合。
//
// 扩展方式（新增 harness 不改入口）：
//   在 probes/ 下新增一个模块，导出描述符即可，本注册表用目录扫描自动装载：
//
//     module.exports = {
//       id: 'some-harness',
//       label: 'Some Harness',
//       priority: 20,                 // 越大越先执行；同优先级按 id 稳定排序
//       claims: (harnessId) => harnessId === 'some-harness',
//       probe: (context) => signal | null
//     };
//
// 信号（signal）语义：
//   turn:        true  = 正在跑回合；false = 已结束/空闲；null = 本探测源看不到
//   authority:   'turn'     = 有权威（可以点亮也可以熄灯）
//                'positive' = 只能证明「在跑」（看到输出），不能证明「闲着」
//                'none'     = 不参与判定（例如由官方 hook 事件独立驱动的 provider）
//   decisive:    true + turn=false = 明确的会话结束事件，可以直接熄灯
//   lastActivityAt: 该信号的观测时刻（毫秒）；多个信号冲突时时间较新者优先
//   source:      稳定来源标识，用于日志/验收（不是给人看的 UI 文案）
//
// 组合规则在 account-session-activity 里：decisive 结束 > 有活动 > 权威空闲 > 不动。

const fs = require('fs');
const path = require('path');

const PROBES_DIR = path.join(__dirname, 'probes');
const HARNESS_FALLBACK = '*';

function normalizeId(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function normalizeProbe(raw, origin) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`harness_activity_probe_invalid:${origin}`);
  }
  const id = normalizeId(raw.id);
  if (!id) throw new Error(`harness_activity_probe_invalid:id:${origin}`);
  if (typeof raw.probe !== 'function') {
    throw new Error(`harness_activity_probe_invalid:probe:${origin}`);
  }
  const claims = typeof raw.claims === 'function'
    ? raw.claims
    : Array.isArray(raw.harnesses) && raw.harnesses.length > 0
      ? (harnessId) => raw.harnesses.map(normalizeId).includes(harnessId)
      : () => raw.fallback === true;
  return Object.freeze({
    id,
    label: String(raw.label || id),
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
    claims,
    probe: raw.probe
  });
}

const probes = [];

/** 注册一个探测策略（目录扫描时调用；测试/插件也可直接调用）。 */
function registerHarnessActivityProbe(descriptor, origin = 'runtime') {
  const probe = normalizeProbe(descriptor, origin);
  const existing = probes.findIndex((item) => item.id === probe.id);
  if (existing >= 0) probes.splice(existing, 1, probe);
  else probes.push(probe);
  probes.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  return probe;
}

function loadBuiltinProbes(dir = PROBES_DIR) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const loaded = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name === 'index.js') continue;
    const origin = entry.name;
    let raw = null;
    try {
      raw = require(path.join(dir, entry.name));
    } catch (error) {
      // 单个探测器坏了不能拖垮整张注册表：其余 harness 保持可用。
      console.error(`[harness-activity] failed to load probe ${origin}: ${error && error.message}`);
      continue;
    }
    try {
      loaded.push(registerHarnessActivityProbe(raw, origin));
    } catch (error) {
      console.error(`[harness-activity] invalid probe ${origin}: ${error && error.message}`);
    }
  }
  return loaded;
}

loadBuiltinProbes();

/**
 * 某个 harness 可用的探测策略（按 priority 降序）。
 * 没有专属探测器的 harness 也能拿到通用 pane 探测（claims '*'）。
 */
function listHarnessActivityProbes(harnessId) {
  const id = normalizeId(harnessId);
  return probes.filter((probe) => {
    try {
      return Boolean(probe.claims(id));
    } catch (_error) {
      return false;
    }
  });
}

function listRegisteredProbeIds() {
  return probes.map((probe) => probe.id);
}

module.exports = {
  HARNESS_FALLBACK,
  listHarnessActivityProbes,
  listRegisteredProbeIds,
  loadBuiltinProbes,
  registerHarnessActivityProbe,
  normalizeHarnessActivityId: normalizeId
};
