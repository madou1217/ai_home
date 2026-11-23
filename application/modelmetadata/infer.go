package modelmetadata

import (
	"regexp"
	"strings"
)

// InferModalities 按模型名家族给出保守的兜底能力（对应 Node 的 buildFallbackModalities）。
//
// 这不是“目录事实”，而是消费方（模型目录 capability 过滤、vision guard）需要的一个
// **总是有答案**的判定：把能看图的模型判成纯文本只是少一次过滤/多剥一张图，而反过来
// 会让请求带着图片打到看不见图片的上游，整条被 400 拒绝。
//
// 两个家族彼此独立：视觉家族只影响输入，图像生成家族只影响输出（输入那侧由
// WithImageGeneration 统一补）。都不命中时返回 false，让调用方按纯文本降级。
func InferModalities(modelID string) (Modalities, bool) {
	input := []string{"text"}
	output := []string{"text"}
	if MatchesImageGenerationName(modelID) {
		output = append(output, "image")
	}
	if matchesVisionFamily(modelID) {
		input = append(input, "image")
	}
	if len(input) == 1 && len(output) == 1 {
		return Modalities{}, false
	}
	modalities, err := NewModalities(input, output)
	if err != nil {
		return Modalities{}, false
	}
	return modalities, true
}

// WithImageGeneration 给图像生成模型补上 image 输入与输出。
//
// 与 Node 的 computeModelModalities 末段一致：目录命中也要补——目录里
// `gemini-3.1-flash-image` 这类模型的记录可能只声明输出，而它们实际上也接受图片输入，
// 少补会让 vision guard 把用户贴的图剥掉。
func WithImageGeneration(modalities Modalities, modelID string) Modalities {
	if !MatchesImageGenerationName(modelID) {
		return modalities
	}
	input := modalities.Input()
	output := modalities.Output()
	if !containsModality(input, "image") {
		input = append(input, "image")
	}
	if !containsModality(output, "image") {
		output = append(output, "image")
	}
	augmented, err := NewModalities(input, output)
	if err != nil {
		return modalities
	}
	return augmented
}

// containsModality 判断模态列表是否已包含指定模态（大小写不敏感）。
func containsModality(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}

// visionFamilyPatterns 是未收录模型的保守家族兜底。
//
// 与 Node 的 VISION_INPUT_MODEL_PATTERNS 相比，OpenAI 一条从「枚举具体版本」改成
// 「按主版本号」：枚举会随时间腐坏——Node 写的是 `gpt-(4o|4[.-]1|5)`，而目录里已经有
// gpt-6-astra，枚举表会把能看图的 gpt-6 判成看不见图片。
//
// 放宽边界逐条对当前快照验证过：
//   - `^gpt-[4-9]` 覆盖 gpt-4.x / 5.x / 6.x（快照里全部含 image 输入），刻意排除
//     `gpt-3.5-turbo` 与 `gpt-oss-*`（快照里都是纯文本）；
//   - `^o[1-9]` 覆盖 o 系列推理模型，已知例外 `o3-mini` 在快照里能解析到，走不到兜底。
var visionFamilyPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^claude-`),
	regexp.MustCompile(`^gemini-`),
	regexp.MustCompile(`^gpt-[4-9]`),
	regexp.MustCompile(`^o[1-9]($|[.-])`),
}

// matchesVisionFamily 判断模型名是否属于已知的「能看见图片」家族。
//
// 同时匹配原样与版本分隔符归一化后的形态，因此 `gpt-5.5` 与 `gpt-5-5` 命中同一条规则。
func matchesVisionFamily(modelID string) bool {
	for _, key := range visionFamilyLookupKeys(modelID) {
		for _, pattern := range visionFamilyPatterns {
			if pattern.MatchString(key) {
				return true
			}
		}
	}
	return false
}

// visionFamilyLookupKeys 返回家族匹配用的模型 ID 变体。
func visionFamilyLookupKeys(modelID string) []string {
	trimmed := strings.TrimSpace(modelID)
	if trimmed == "" {
		return nil
	}
	normalized := NormalizeVersionSeparators(trimmed)
	if normalized == trimmed {
		return []string{trimmed}
	}
	return []string{trimmed, normalized}
}
