'use strict';

// 把「某个模型支持哪些推理强度档位」转达给外部 harness 的共享真相源。
//
// 背景（2026-10-22 用户反馈）：aih 注入 opencode / pi 的模型条目只写了名字，没有档位声明，
// 于是 harness 只能用它自己的默认上限 —— 用户看到的现象是「最大只能选 high」，
// 而我们网关上明明支持到 xhigh / max（甚至 ultra）。
//
// 档位来自 models.dev 快照（`capabilities.reasoningOptions`），与网关侧
// `lib/server/chat-runtime/reasoning-effort-ladder.js` 的对齐规则同源：
// harness 选中的档位会被网关按目标模型阶梯再对齐一次，所以这里**只需如实转达**模型支持的集合，
// 不做二次裁剪——裁剪会把「模型支持 xhigh」变成「只到 high」，正是要修的病。
//
// 本模块只做「查档位 + 转形状」，不认识具体 harness：
// 各 harness 的字段形状由各自的 adapter 函数给出（见下方 OPENCODE / PI 两个投影）。

// 档位查询与网关 /v1/models 的发布走同一份实现（model-effort-index），
// 避免「注入给 harness 的档位」与「网关发布的档位」两处各写一套而漂移。
const {
  CANONICAL_EFFORT_ORDER,
  resolveModelEfforts
} = require('../../../../server/model-effort-index');

/**
 * opencode 的模型条目形状：`reasoning_options: [{ type: 'effort', values: [...] }]`。
 *
 * 实测来源：opencode v2.1.2 自己的 models.dev 目录缓存（`opencode.db` 的 `kv` 表，
 * 键 `models-dev:catalog`）里，Zen provider 的模型条目就是长这个形状。
 * 没有该档位的模型返回 null —— 不写该字段，让 opencode 用它自己的默认。
 */
function opencodeReasoningOptions(efforts) {
  const values = Array.isArray(efforts) ? efforts.filter(Boolean) : [];
  if (values.length === 0) return null;
  return [{ type: 'effort', values: [...values] }];
}

/**
 * pi 的模型条目形状：`thinkingLevelMap: { <档位>: <上游档位名> | null }`。
 *
 * pi 的键集合是固定的七档（off/minimal/low/medium/high/xhigh/max，见
 * @earendil-works/pi-coding-agent 的 model-config schema）。值为 null 表示该档位不可用，
 * 因此这里只给**模型支持的**档位填值（原样同名映射），其余显式写 null ——
 * 省略键与写 null 在 pi 那边都表示「不支持」，显式写出来便于排查。
 */
const PI_THINKING_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
]);

function piThinkingLevelMap(efforts) {
  const values = Array.isArray(efforts) ? efforts.filter(Boolean) : [];
  if (values.length === 0) return null;
  const supported = new Set(values);
  // `none` 在 pi 的词汇里是 `off`：同一语义两个名字，做一次映射而不是漏掉。
  if (supported.has('none')) supported.add('off');
  const map = {};
  for (const level of PI_THINKING_LEVELS) {
    map[level] = supported.has(level) ? level : null;
  }
  return map;
}

module.exports = {
  CANONICAL_EFFORT_ORDER,
  PI_THINKING_LEVELS,
  opencodeReasoningOptions,
  piThinkingLevelMap,
  resolveModelEfforts
};
