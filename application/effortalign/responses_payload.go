package effortalign

// Responses 协议请求体的强度对齐。
//
// Codex CLI 的 WebSocket response.create 帧与 HTTP /v1/responses 原生快路径
// 是同一份 JSON 形状（顶层 model + reasoning.effort），两条路径都必须对齐：
// 客户端配置 model_reasoning_effort = "none" 时，若目标模型只支持 low..max
// （例如 gpt-6.1-sol），原样透传会被上游 400 unsupported_value。
// 放在本包而不是各自 Handler 里，是为了避免两条入口各写一份对齐逻辑。

import (
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// AlignResponsesPayload 把请求体里的 reasoning.effort 压进目标模型的档位阶梯。
//
// 只改写 JSON 结构；无法解析、缺少 reasoning/effort、查不到阶梯时原样返回。
func AlignResponsesPayload(
	payload []byte,
	providerID inference.ProviderID,
	model string,
	ladders LadderReader,
) []byte {
	if ladders == nil {
		return payload
	}
	targetModel := strings.TrimSpace(model)
	if targetModel == "" {
		return payload
	}
	ladder, found := ladders.LookupReasoningEfforts(string(providerID), targetModel)
	if !found || len(ladder) == 0 {
		return payload
	}
	var frame map[string]json.RawMessage
	if json.Unmarshal(payload, &frame) != nil {
		return payload
	}
	rawReasoning, found := frame["reasoning"]
	if !found {
		return payload
	}
	var reasoning map[string]json.RawMessage
	if json.Unmarshal(rawReasoning, &reasoning) != nil {
		return payload
	}
	rawEffort, found := reasoning["effort"]
	if !found {
		return payload
	}
	var effort string
	if json.Unmarshal(rawEffort, &effort) != nil {
		return payload
	}
	requested := inference.ReasoningEffort(strings.TrimSpace(effort))
	if requested == "" {
		return payload
	}
	aligned, ok := inference.AlignReasoningEffort(requested, nil, ladder)
	if !ok || aligned == requested {
		return payload
	}
	encodedEffort, err := json.Marshal(string(aligned))
	if err != nil {
		return payload
	}
	reasoning["effort"] = encodedEffort
	encodedReasoning, err := json.Marshal(reasoning)
	if err != nil {
		return payload
	}
	frame["reasoning"] = encodedReasoning
	encodedFrame, err := json.Marshal(frame)
	if err != nil {
		return payload
	}
	return encodedFrame
}
