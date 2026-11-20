package modelmetadata

import (
	"regexp"
	"strings"
)

// 图像模型事实只在本文件定义一次。
//
// 此前 transport 的目录收窄、imagestudio 的原生发现、translation 的候选过滤各自维护
// 一份正则与字符串判断，口径靠人肉同步；这里把两类事实收敛为共享契约：
//   - ProviderOwnsImageModel：某 Provider 的原生目录是否把该模型算作生图模型；
//   - InfersImageOutput：在缺少模态元数据时，模型 id 是否足以表明它输出图像。
//
// Node 来源：lib/server/image-generation-model-specs.js（imageModelBelongsToProvider）。
var (
	grokImageModelPattern   = regexp.MustCompile(`(?i)^grok-(?:imagine-)?image(?:[-._].+)?$`)
	geminiImageModelPattern = regexp.MustCompile(`(?i)^(?:google/)?gemini[-_/].*image(?:[-._].*)?$`)
	nanoBananaModelPattern  = regexp.MustCompile(`(?i)nano-?banana`)
)

// ProviderOwnsImageModel 判断原生发现模型是否归属当前 OAuth Provider 的生图能力。
//
// 只登记有实测证据的厂商形态：codex 只暴露专用 Images 模型的 gpt-image-2，
// grok 走 grok-imagine-image 系列，agy/gemini 走 Gemini 原生 image 与 nano-banana。
func ProviderOwnsImageModel(providerID, modelID string) bool {
	provider := strings.ToLower(strings.TrimSpace(providerID))
	model := strings.ToLower(strings.TrimSpace(modelID))
	if model == "" {
		return false
	}
	switch provider {
	case "codex":
		return model == "gpt-image-2"
	case "grok":
		return grokImageModelPattern.MatchString(model)
	case "agy", "gemini":
		return geminiImageModelPattern.MatchString(model) || nanoBananaModelPattern.MatchString(model)
	default:
		return false
	}
}

// InfersImageOutput 仅凭模型 id 推断它是否输出图像。
//
// 它是模态元数据不可用时的兜底启发式，不是权威判定：调用方应先查模态端口，
// 只有查不到时才能回落到这里。
func InfersImageOutput(modelID string) bool {
	lower := strings.ToLower(strings.TrimSpace(modelID))
	if lower == "" {
		return false
	}
	return strings.Contains(lower, "gpt-image") ||
		strings.Contains(lower, "dall-e") ||
		strings.Contains(lower, "grok-imagine") ||
		strings.HasSuffix(lower, "-image") ||
		strings.Contains(lower, "-image-")
}

// imageGenerationNamePattern 是「产出图片」的模型名形态，逐字对应 Node 的
// IMAGE_MODEL_PATTERN（lib/server/code-assist-image-generation.js，isImageGenerationModel）：
// `-image` 家族、nano-banana 别名、flash-image。它刻意不匹配「能看图但只输出文本」的模型。
//
// 本判定刻意不做版本分隔符归一化：Node 侧同样只用小写原名匹配，归一化只服务于
// 视觉家族那张表；两边必须保持这个差别，否则同一模型会在两端得到不同的 image_out 判定。
var imageGenerationNamePattern = regexp.MustCompile(`(?:^|[-_/])image(?:$|[-_])|nano-?banana|flash-image`)

// MatchesImageGenerationName 判断模型 id 是否属于图像生成家族。
//
// 与 InfersImageOutput 的分工：InfersImageOutput 是"按当前目录的模型命名习惯推断输出模态"
// 的兜底；本函数是 Node 图像生成家族判定的逐字对应，用于 CLI 侧拒绝与模态推断的
// image_out 归一，两者规则集不同，不能互相替代。
func MatchesImageGenerationName(modelID string) bool {
	return imageGenerationNamePattern.MatchString(strings.ToLower(strings.TrimSpace(modelID)))
}
