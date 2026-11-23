package modelmetadata

import (
	"errors"

	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidReasoningLadder 表示运行时推理档位快照含空、未知或重复档位。
	ErrInvalidReasoningLadder = errors.New("模型推理档位无效")
)

// ReasoningLadderRegistrar 接收 Provider 级运行时推理档位快照。
//
// 上游模型目录是“这个端点接受哪些 effort”的权威事实。把它登记进来后，新发布的模型
// 不必等待内置 models.dev 快照升级，就能在 /v1/models 的 supported_reasoning_levels
// 里拿到档位；Provider 一旦声明过档位，models.dev 就彻底退出该 Provider 的档位解析。
type ReasoningLadderRegistrar interface {
	// MergeReasoningLadders 按模型合并一个 Provider 的档位声明。
	//
	// 同一 Provider 可能由多个账号共同服务，而每个账号只能看到自己的目录：合并
	// （而不是整表替换）才不会让“后刷新的小目录”抹掉其它账号已声明的模型档位。
	// 空映射表示没有新事实，保留上一代 last-known-good。
	MergeReasoningLadders(providerID string, ladders map[string][]inference.ReasoningEffort) error
}

// NormalizeReasoningLadder 返回按 Canonical 全序升序、去重后的档位副本。
//
// 未知档位被丢弃（例如上游提前声明了尚未注册的档位）；一个有效档位都不剩时返回
// 未命中，调用方不应为这个模型发布空阶梯 —— 空阶梯与“没有档位概念”不可区分。
func NormalizeReasoningLadder(
	values []inference.ReasoningEffort,
) ([]inference.ReasoningEffort, bool) {
	allowed := make(map[inference.ReasoningEffort]struct{}, len(values))
	for _, value := range values {
		if value.IsValid() {
			allowed[value] = struct{}{}
		}
	}
	if len(allowed) == 0 {
		return nil, false
	}
	ladder := make([]inference.ReasoningEffort, 0, len(allowed))
	for _, canonical := range inference.CanonicalEffortOrder() {
		if _, found := allowed[canonical]; found {
			ladder = append(ladder, canonical)
		}
	}
	if len(ladder) == 0 {
		return nil, false
	}
	return ladder, true
}
