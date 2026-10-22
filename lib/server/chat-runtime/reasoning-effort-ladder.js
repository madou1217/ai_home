'use strict';

/**
 * 推理强度阶梯对齐（rank alignment）——与 Go 侧 core/inference/reasoning_effort_ladder.go 同构。
 *
 * 发送方（harness / 客户端）与目标模型各有自己的档位语言：Claude Code 最高发 max，
 * Kimi 的目录只有 low/high/max，Codex 的 Lite 档只有 low/medium。原样透传的后果是
 * 不认识的档位被上游 400，或者被各家编码器就地夹到某个值——每条路径各夹一次，
 * 最终没人说得清「用户要的强度到底落实成了什么」。
 *
 * 唯一规则：两侧各自按强度升序排列，**顶端对齐**后逐级向下配对；目标阶梯先耗尽时，
 * 更弱的请求全部收敛到目标最低档（倒排、不轮空、不越级）。
 *
 *   目标 A: 1,2,3        发送方 B: 5,4,3,2,1
 *     5→3  4→2  3→1  2→1  1→1
 *   目标 A: 1,2,3        发送方 B: 2,1
 *     2→3  1→2            （A 的最低档不会被选中）
 *
 * 映射只由两侧阶梯的**位置**决定，与档位名是否恰好同名无关。
 */

// Canonical 全序：从弱到强。none/minimal 是「更弱」的合法意图，必须留在阶梯里，
// 否则目标只有 low 时它们会被当成「没有强度要求」而整条丢掉。
const CANONICAL_EFFORT_ORDER = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
]);

const CANONICAL_RANK = new Map(CANONICAL_EFFORT_ORDER.map((effort, index) => [effort, index]));

/**
 * 把任意档位列表规范化成升序阶梯（按 Canonical 全序去重、丢弃未知值）。
 * 顺序取自 Canonical 全序而非入参顺序，否则映射结果会随目录书写顺序漂移。
 */
function normalizeEffortLadder(values) {
  const allowed = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const effort = normalizeEffort(value);
    if (effort) allowed.add(effort);
  }
  return CANONICAL_EFFORT_ORDER.filter((effort) => allowed.has(effort));
}

/**
 * 把发送方档位压进目标模型的档位阶梯。
 *
 * clientLadder 传空表示发送方档位未知：此时按目标阶梯自身对齐（受支持的档位原样通过、
 * 其余就近向上收敛），不做整体位移——发送方档位未知时做位移等于凭空假设它还有更高档位，
 * 会把一个合法且受支持的请求降档。
 *
 * @returns {{ effort: string, ok: boolean, reason: string }}
 *   ok=false 的三种语义：`no_intent`（请求没要强度）、`no_model_tiers`（目标没有档位，
 *   调用方应去掉整个 reasoning 意图）、`unknown_effort`（档位不在 Canonical 枚举里，不猜）。
 */
function alignReasoningEffort(effort, clientLadder, modelLadder) {
  const requested = normalizeEffort(effort);
  if (!requested) return { effort: '', ok: false, reason: 'no_intent' };
  if (!CANONICAL_RANK.has(requested)) return { effort: '', ok: false, reason: 'unknown_effort' };
  const model = normalizeEffortLadder(modelLadder);
  if (model.length === 0) return { effort: '', ok: false, reason: 'no_model_tiers' };
  const declared = normalizeEffortLadder(clientLadder);
  const client = declared.length > 0 ? declared : model;
  const position = positionOf(client, requested);
  if (position === null) return { effort: '', ok: false, reason: 'unknown_effort' };
  // 顶端对齐：发送方最高档与目标最高档配成一对，其余按位置差整体平移，越界即夹到端点。
  const offset = client.length - model.length;
  const target = Math.min(Math.max(position - offset, 0), model.length - 1);
  return { effort: model[target], ok: true, reason: '' };
}

/**
 * 档位在阶梯上的升序位置。不在阶梯上时按 Canonical 全序取「第一个不小于它的档位」——
 * 也就是向上收敛到最近的可用档，与各编码器原来的就地收敛方向一致。
 */
function positionOf(ladder, effort) {
  const canonical = CANONICAL_RANK.get(effort);
  if (canonical === undefined) return null;
  for (let index = 0; index < ladder.length; index += 1) {
    if (CANONICAL_RANK.get(ladder[index]) >= canonical) return index;
  }
  return ladder.length - 1;
}

function normalizeEffort(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

module.exports = {
  CANONICAL_EFFORT_ORDER,
  alignReasoningEffort,
  normalizeEffortLadder
};
