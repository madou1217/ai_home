package modelmetadata

import (
	"errors"

	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidReasoningLadder 表示运行时推理档位快照含空、未知或重复档位。
	ErrInvalidReasoningLadder = errors.New("模型推理档位无效")
)

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
