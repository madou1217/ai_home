package inference

// 推理强度阶梯对齐（rank alignment）。
//
// 发送方（harness / 客户端）与目标模型各有自己的档位语言：Claude Code 最高发 max，
// Kimi 的目录只有 low/high/max，Codex 的 Lite 档只有 low/medium。原样透传的后果是
// 不认识的档位被上游 400，或者被各家编码器就地夹到某个值——每条路径各夹一次，
// 最终没人说得清「用户要的强度到底落实成了什么」。
//
// 唯一规则：两侧各自按强度升序排列，**顶端对齐**后逐级向下配对；目标阶梯先耗尽时，
// 更弱的请求全部收敛到目标最低档（倒排、不轮空、不越级）。
//
//	目标 A: 1,2,3        发送方 B: 5,4,3,2,1
//	  5→3  4→2  3→1  2→1  1→1
//	目标 A: 1,2,3        发送方 B: 2,1
//	  2→3  1→2            （A 的最低档不会被选中）
//
// 三个性质是这条规则存在的理由：
//   - 单调：更强的请求永远不会被映射成更弱的档位；
//   - 不轮空：发送方档位不少于目标时，目标每一档都会被某个请求命中；
//   - 稳定：对齐结果再对齐不变。
//
// 映射只由两侧阶梯的**位置**决定，与档位名是否恰好同名无关：发送方的 "1" 落在目标
// 第二档时就是第二档，不因为目标也有个叫 "1" 的档位而留在原地。
type effortLadder struct {
	rank   map[ReasoningEffort]int
	sorted []ReasoningEffort
}

// canonicalEffortLadder 是 Canonical 全部强度的升序定义。
//
// none 与 minimal 留在阶梯里：它们是「更弱」的合法意图，目标只有 low 时必须能收敛到
// low，而不是被当成「没有强度要求」而整条丢掉。
var canonicalEffortLadder = newEffortLadder(
	ReasoningEffortNone,
	ReasoningEffortMinimal,
	ReasoningEffortLow,
	ReasoningEffortMedium,
	ReasoningEffortHigh,
	ReasoningEffortXHigh,
	ReasoningEffortMax,
	ReasoningEffortUltra,
)

// CanonicalEffortOrder 返回 Canonical 推理强度的升序全序副本。
//
// 生成器（internal/tools/modelsdevmodalities）必须按同一顺序写快照，而它不能 import
// 本包，因此在那里显式重复了一份；两处一致性由本包的单测守住。
func CanonicalEffortOrder() []ReasoningEffort {
	return append([]ReasoningEffort(nil), canonicalEffortLadder.sorted...)
}

func newEffortLadder(values ...ReasoningEffort) effortLadder {
	rank := make(map[ReasoningEffort]int, len(values))
	sorted := make([]ReasoningEffort, 0, len(values))
	for _, value := range values {
		if _, exists := rank[value]; exists || !value.IsValid() {
			continue
		}
		rank[value] = len(sorted)
		sorted = append(sorted, value)
	}
	return effortLadder{rank: rank, sorted: sorted}
}

// ladderOf 把任意档位列表规范化成升序阶梯。
//
// 顺序取自 Canonical 全序而不是入参顺序：不同调用方给出同一集合、不同顺序时必须得到
// 同一张阶梯，否则映射结果会随目录书写顺序漂移。未知档位被丢弃（目录里混入未来档位
// 时丢掉它，比让整条请求失败更符合网关定位）。
func ladderOf(values []ReasoningEffort) effortLadder {
	allowed := make(map[ReasoningEffort]struct{}, len(values))
	for _, value := range values {
		if value.IsValid() {
			allowed[value] = struct{}{}
		}
	}
	kept := make([]ReasoningEffort, 0, len(allowed))
	for _, value := range canonicalEffortLadder.sorted {
		if _, ok := allowed[value]; ok {
			kept = append(kept, value)
		}
	}
	return newEffortLadder(kept...)
}

// AlignReasoningEffort 把发送方档位压进目标模型的档位阶梯。
//
// clientLadder 是**发送方**能表达的档位（例如 Anthropic Messages 客户端只有
// low/medium/high/xhigh/max）。传空表示发送方档位未知，此时按目标阶梯自身对齐——
// 也就是「支持的档位原样通过、其余按位置就近收敛」，不做整体位移。这个默认是刻意的：
// 发送方档位未知时做位移等于凭空假设它还有更高档位，会把一个合法且受支持的请求降档。
//
// 返回 ok=false 有三种情况，语义不同，调用方要分开处理：
//   - 请求没有强度意图（effort 为空）→ 保持「不设强度」；
//   - 目标模型没有可用档位（阶梯为空）→ 应当去掉整个 reasoning 意图；
//   - 请求档位不在 Canonical 枚举里 → 无法定序，按失败处理（绝不猜）。
func AlignReasoningEffort(
	effort ReasoningEffort,
	clientLadder []ReasoningEffort,
	modelLadder []ReasoningEffort,
) (ReasoningEffort, bool) {
	if effort == "" {
		return "", false
	}
	if _, known := canonicalEffortLadder.rank[effort]; !known {
		return "", false
	}
	model := ladderOf(modelLadder)
	if len(model.sorted) == 0 {
		return "", false
	}
	client := ladderOf(clientLadder)
	if len(client.sorted) == 0 {
		client = model
	}
	position, known := client.positionOf(effort)
	if !known {
		return "", false
	}
	// 顶端对齐：发送方最高档与目标最高档配成一对，其余按位置差整体平移，越界即夹到端点。
	offset := len(client.sorted) - len(model.sorted)
	target := position - offset
	if target < 0 {
		target = 0
	}
	if target >= len(model.sorted) {
		target = len(model.sorted) - 1
	}
	return model.sorted[target], true
}

// positionOf 返回档位在本阶梯上的升序位置。
//
// 档位不在阶梯上时（发送方声明了阶梯却发出阶梯外的值，例如 Claude Code 发 xhigh 而
// 阶梯只列到 max）按 Canonical 全序取「第一个不小于它的档位」：这正是「向上收敛到最近
// 的可用档」，与各编码器原来的就地收敛方向一致。
func (ladder effortLadder) positionOf(effort ReasoningEffort) (int, bool) {
	if position, exists := ladder.rank[effort]; exists {
		return position, true
	}
	canonical, known := canonicalEffortLadder.rank[effort]
	if !known {
		return 0, false
	}
	for position, value := range ladder.sorted {
		if canonicalEffortLadder.rank[value] >= canonical {
			return position, true
		}
	}
	return len(ladder.sorted) - 1, true
}

// WithEffort 返回替换了强度档位的 reasoning 配置副本（模式与预算保持不变）。
//
// 对齐发生在编码之前，这里不做任何"收敛"判断：传什么就是什么，合法性由各构造函数校验。
func (config ReasoningConfig) WithEffort(effort ReasoningEffort) (ReasoningConfig, error) {
	switch config.mode {
	case ReasoningModeEffort:
		return NewEffortReasoning(effort, config.summary)
	case ReasoningModeBudget:
		return NewBudgetReasoningWithEffort(config.budgetTokens, config.summary, effort)
	case ReasoningModeAdaptive:
		return NewAdaptiveReasoningWithEffort(config.summary, effort)
	default:
		return ReasoningConfig{}, ErrInvalidReasoning
	}
}

// AlignTurnEfforts 把请求里所有携带按轮强度的 system 消息统一改写成 effort。
//
// 按轮强度是 Claude Code 在对话中途发的能力控制；它必须与请求级强度落在同一档，
// 否则同一轮会先 high 后 max。没有按轮强度的请求原样返回。
func (request Request) AlignTurnEfforts(effort ReasoningEffort) Request {
	if effort == "" || len(request.messages) == 0 {
		return request
	}
	changed := false
	messages := make([]Message, len(request.messages))
	for index, message := range request.messages {
		if message.TurnEffort() == "" || message.TurnEffort() == effort {
			messages[index] = message
			continue
		}
		aligned, err := message.WithTurnEffort(effort)
		if err != nil {
			messages[index] = message
			continue
		}
		messages[index] = aligned
		changed = true
	}
	if !changed {
		return request
	}
	next := request
	next.messages = messages
	next.capabilities = deriveRequiredCapabilities(next)
	return next
}

// ReplaceReasoning 返回替换了 reasoning 意图的请求副本（nil 表示去掉推理意图）。
//
// 与 ReplaceImageContents 同样的取舍：直接复制 Request 再重算派生能力位，不经
// NewRequest 重建，避免把只有输入侧才有的字段静默丢掉。
func (request Request) ReplaceReasoning(reasoning *ReasoningConfig) Request {
	next := request
	if reasoning == nil {
		next.reasoning = nil
	} else {
		cloned := *reasoning
		next.reasoning = &cloned
	}
	next.capabilities = deriveRequiredCapabilities(next)
	return next
}
