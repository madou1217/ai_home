// Package effortalign 在派发到上游之前，把客户端的推理强度档位压进目标模型的档位阶梯。
//
// 动机：客户端协议与上游模型各有自己的档位语言。Claude Code 的 Messages 客户端最高只发
// max，Codex 的 Responses 客户端还认识 xhigh/ultra，而目标模型可能只有 low/high/max
// （kimi k3）或 low/medium（Codex Lite）。原样透传的后果由各家上游适配器就地处理——
// 每处各夹一次、方向还可能相反（Claude 把 xhigh 压成 max，Kimi 原样透传），最终没人说得清
// 「用户要的强度到底落实成了什么」。
//
// 本包只做协议中立的 Canonical 变换：读请求里的 reasoning 意图 + 客户端协议，按目标
// 模型的档位阶梯对齐后写回。规则本身在 core/inference（AlignReasoningEffort），
// Go 与 Node 两侧同构。
package effortalign

import (
	"errors"

	"github.com/madou1217/ai_home/core/inference"
)

// ErrInvalidDependencies 表示对齐器缺少阶梯读取端口。
var ErrInvalidDependencies = errors.New("effort 对齐器依赖无效")

// LadderReader 返回模型声明的推理强度档位（升序）。
type LadderReader interface {
	LookupReasoningEfforts(providerID string, modelID string) ([]inference.ReasoningEffort, bool)
}

// Aligner 把请求的推理强度对齐到目标模型的阶梯。
type Aligner struct {
	ladders LadderReader
}

// New 创建对齐器；ladders 为 nil 时创建的是「什么都不做」的对齐器（便于组合根按开关接线）。
func New(ladders LadderReader) *Aligner {
	return &Aligner{ladders: ladders}
}

// Apply 返回对齐后的请求。
//
// 三种情况原样返回（不改写请求，也不丢强度意图）：
//   - 没有配置阶梯读取端口，或请求没有强度意图；
//   - 目录里查不到目标模型的档位（不猜：查不到就不动，交给上游适配器按原规则处理）；
//   - 对齐结果与请求相同。
//
// 请求档位无法定序、或目标阶梯为空时，**去掉整个 reasoning 意图**：让上游按自己的默认
// 强度工作，比塞一个不存在的档位去撞 400 更好。
func (aligner *Aligner) Apply(
	request inference.Request,
	providerID inference.ProviderID,
	effectiveModel string,
) inference.Request {
	if aligner == nil || aligner.ladders == nil {
		return request
	}
	reasoning, hasReasoning := request.Reasoning()
	requested := reasoning.Effort()
	if !hasReasoning || requested == "" {
		return request
	}
	ladder, found := aligner.ladders.LookupReasoningEfforts(string(providerID), effectiveModel)
	if !found {
		return request
	}
	aligned, ok := inference.AlignReasoningEffort(
		requested,
		clientLadder(request.ClientProtocol()),
		ladder,
	)
	if !ok {
		// 目标没有档位：去掉强度意图（保留 budget/adaptive 的其它语义由 WithEffort 之外的路径承担），
		// 无法定序同理。
		return request.ReplaceReasoning(nil)
	}
	if aligned == requested {
		return request
	}
	updated, err := reasoning.WithEffort(aligned)
	if err != nil {
		return request
	}
	// 按轮强度（Anthropic 中途 system 消息）与请求级强度必须一致，否则同一轮会出现
	// 「首轮 high、后续轮 max」的漂移。
	return request.ReplaceReasoning(&updated).AlignTurnEfforts(aligned)
}

// clientLadder 返回客户端协议能表达的档位。
//
// 返回 nil 表示「不做整体位移，按目标阶梯就近对齐」——用于服务端自己合成的请求
// （例如内部工具轮次）与 Gemini 这类没有档位词汇的入口。
func clientLadder(protocol inference.ClientProtocolID) []inference.ReasoningEffort {
	switch protocol {
	case inference.ClientProtocolAnthropicMessages:
		// Anthropic Messages 的 output_config.effort 只接受这五档（见
		// internal/adapters/clientprotocol/anthropicmessages 的 decodeEffort）。
		return []inference.ReasoningEffort{
			inference.ReasoningEffortLow,
			inference.ReasoningEffortMedium,
			inference.ReasoningEffortHigh,
			inference.ReasoningEffortXHigh,
			inference.ReasoningEffortMax,
		}
	case inference.ClientProtocolOpenAIResponses, inference.ClientProtocolOpenAIChatCompletions:
		// OpenAI 系客户端认 Canonical 全阶梯（含 none/minimal/xhigh/ultra）。
		return nil
	default:
		return nil
	}
}
