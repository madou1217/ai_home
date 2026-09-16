// Package modelsdev 提供由 @opencode-ai/models SDK 离线快照生成的进程内只读模态索引。
package modelsdev

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

var (
	// ErrInvalidSnapshot 表示嵌入快照损坏或不满足应用层值对象合同。
	ErrInvalidSnapshot = errors.New("models.dev 嵌入模态快照无效")
	// embeddedSnapshot 由 Go 生成器从 @opencode-ai/models SDK 快照派生（npm run models:generate）。
	//go:embed modalities.json
	embeddedSnapshot []byte
)

// snapshotRecord 是生成快照的 JSON 传输形状。
type snapshotRecord struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// Index 保存启动时构建后不再修改的 O(1) 模态查找表。
type Index struct {
	models map[string]modelmetadata.Modalities
}

// 编译期确认索引满足 HTTP 模型目录所依赖的应用层端口。
var _ modelmetadata.Reader = (*Index)(nil)

// New 解码并完整校验嵌入快照；损坏时失败关闭，避免发布虚假能力。
func New() (*Index, error) {
	var records map[string]snapshotRecord
	if err := json.Unmarshal(embeddedSnapshot, &records); err != nil || len(records) == 0 {
		return nil, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	models := make(map[string]modelmetadata.Modalities, len(records))
	for modelID, record := range records {
		if strings.TrimSpace(modelID) == "" || modelID != strings.TrimSpace(modelID) {
			return nil, ErrInvalidSnapshot
		}
		modalities, err := modelmetadata.NewModalities(record.Input, record.Output)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrInvalidSnapshot, modelID)
		}
		models[modelID] = modalities
	}
	return &Index{models: models}, nil
}

// LookupModalities 按 AIH Provider 和真实模型 ID 返回不可变值对象。
//
// 解析顺序与 Node 的 models-dev-metadata 一致，分三层：
//  1. 该 Provider 的候选命名空间按序精确命中（聚合 Provider 在这里才能查到自己的模型）；
//  2. 基座模型回退：按模型名前缀推断厂商命名空间；
//  3. 逐步裁掉尾段再试——provider 自定义的能力/档位后缀（…-thinking、…-high）在固定
//     目录里不存在，落到基座模型的模态即可。
//
// 任何一层都不命中时返回未命中，由调用方决定降级策略（模型目录降级为纯文本，
// vision guard 走家族兜底）。
func (index *Index) LookupModalities(
	providerID string,
	modelID string,
) (modelmetadata.Modalities, bool) {
	if index == nil || index.models == nil {
		return modelmetadata.Modalities{}, false
	}
	id := strings.TrimSpace(modelID)
	if id == "" {
		return modelmetadata.Modalities{}, false
	}
	stripped := stripKnownModelPrefix(id)
	for _, namespace := range providerNamespacesFor(providerID, id, stripped) {
		if modalities, found := index.models[namespace+"/"+stripped]; found {
			return modalities, true
		}
	}
	for _, key := range baseModelCandidates(id, stripped) {
		if modalities, found := index.models[key]; found {
			return modalities, true
		}
	}
	return modelmetadata.Modalities{}, false
}

// LookupOrInferModalities 在快照未命中时按保守家族兜底推断。
//
// 与 Node 的 getModelModalities 同构：快照是权威，但消费方（模型目录的 capability
// 过滤、vision guard）需要的是一个**总是有答案**的判定，而不是「查不到」。因此未命中时
// 按模型名家族推断，且默认纯文本——只有已知的视觉家族才推断为能看图。
//
// 兜底方向刻意保守：把能看图的模型判成纯文本只是少一次过滤/多剥一张图，而反过来会让
// 请求带着图片打到看不见图片的上游，整条被 400 拒绝。
//
// 唯一的例外是图像生成模型：它们按定义既产出图片也（多数）接受图片，Node 在
// computeModelModalities 里对**所有**路径（快照命中与家族兜底）都补上 image，
// 这里必须同样补，否则 `?capability=image_out` 会漏掉这批模型。
//
// 未命中任何已知家族时返回未命中（Node 那侧返回纯文本）。两者可观测等价：模型目录把它
// 降级为纯文本，vision guard 按纯文本剥离图片。
func (index *Index) LookupOrInferModalities(
	providerID string,
	modelID string,
) (modelmetadata.Modalities, bool) {
	if index == nil || index.models == nil {
		return modelmetadata.Modalities{}, false
	}
	modalities, found := index.LookupModalities(providerID, modelID)
	if !found {
		inferred, ok := inferModalities(modelID)
		if !ok {
			return modelmetadata.Modalities{}, false
		}
		modalities = inferred
	}
	return withImageGeneration(modalities, modelID), true
}

// inferModalities 按模型名家族给出保守兜底能力（对应 Node 的 buildFallbackModalities）。
//
// 两个家族彼此独立：视觉家族只影响输入，图像生成家族只影响输出（输入那侧由
// withImageGeneration 统一补）。都不命中时返回 false，让调用方按纯文本降级。
func inferModalities(modelID string) (modelmetadata.Modalities, bool) {
	input := []string{"text"}
	output := []string{"text"}
	if matchesImageGenerationFamily(modelID) {
		output = append(output, "image")
	}
	if matchesVisionFamily(modelID) {
		input = append(input, "image")
	}
	if len(input) == 1 && len(output) == 1 {
		return modelmetadata.Modalities{}, false
	}
	modalities, err := modelmetadata.NewModalities(input, output)
	if err != nil {
		return modelmetadata.Modalities{}, false
	}
	return modalities, true
}

// withImageGeneration 给图像生成模型补上 image 输入与输出。
//
// 与 Node 的 computeModelModalities 末段一致：快照命中也要补——目录里
// `gemini-3.1-flash-image` 这类模型的记录可能只声明输出，而它们实际上也接受图片输入，
// 少补会让 vision guard 把用户贴的图剥掉。
func withImageGeneration(
	modalities modelmetadata.Modalities,
	modelID string,
) modelmetadata.Modalities {
	if !matchesImageGenerationFamily(modelID) {
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
	augmented, err := modelmetadata.NewModalities(input, output)
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

// imageGenerationPattern 是「产出图片」的模型名形态，逐字对应 Node 的 IMAGE_MODEL_PATTERN
// （lib/server/code-assist-image-generation.js）：`-image` 家族、nano-banana 别名、
// flash-image。它刻意不匹配「能看图但只输出文本」的模型。
var imageGenerationPattern = regexp.MustCompile(
	`(?:^|[-_/])image(?:$|[-_])|nano-?banana|flash-image`,
)

// matchesImageGenerationFamily 判断模型名是否属于图像生成家族。
//
// 与视觉家族判定不同，这里**不做**版本分隔符归一化：Node 的 isImageGenerationModel 直接
// 用小写原名匹配，而归一化只服务于视觉家族那张表。两边必须保持这个差别，否则同一模型会在
// 两端得到不同的 image_out 判定。
func matchesImageGenerationFamily(modelID string) bool {
	normalized := strings.ToLower(strings.TrimSpace(modelID))
	if normalized == "" {
		return false
	}
	return imageGenerationPattern.MatchString(normalized)
}

// visionFamilyLookupKeys 返回家族匹配用的模型 ID 变体。
func visionFamilyLookupKeys(modelID string) []string {
	trimmed := strings.TrimSpace(modelID)
	if trimmed == "" {
		return nil
	}
	normalized := normalizeVersionSeparators(trimmed)
	if normalized == trimmed {
		return []string{trimmed}
	}
	return []string{trimmed, normalized}
}

// normalizeVersionSeparators 把「数字.数字」里的点换成横线，与 Node 的
// normalizeModelVersionSeparators 一致。
//
// 手写扫描而不是正则：Go 的 RE2 不支持 Node 版本里用到的 `(?=...)` 前瞻。
func normalizeVersionSeparators(modelID string) string {
	runes := []rune(modelID)
	changed := false
	for index := 1; index < len(runes)-1; index++ {
		if runes[index] != '.' {
			continue
		}
		if unicode.IsDigit(runes[index-1]) && unicode.IsDigit(runes[index+1]) {
			runes[index] = '-'
			changed = true
		}
	}
	if !changed {
		return modelID
	}
	return string(runes)
}

// providerNamespacesFor 返回该 Provider 与模型组合的候选 models.dev 命名空间（按序）。
//
// 只登记「查得到才有意义」的候选：聚合 Provider 的模型 ID 来自多个厂商，因此候选是
// 一组命名空间而不是一个；没有稳定候选的 Provider 返回空，交给基座回退按模型 ID 推断。
func providerNamespacesFor(
	providerID string,
	modelID string,
	strippedModelID string,
) []string {
	// 模型 ID 自带聚合前缀时，前缀本身就是最精确的候选。
	if strings.HasPrefix(modelID, "opencode-go/") {
		return []string{"opencode-go"}
	}
	if strings.HasPrefix(modelID, "opencode/") {
		return []string{"opencode"}
	}
	switch strings.ToLower(strings.TrimSpace(providerID)) {
	case "codex":
		return []string{"openai", "github-copilot"}
	case "claude":
		return []string{"anthropic"}
	case "gemini":
		return []string{"google", "google-vertex"}
	case "opencode":
		return []string{"opencode-go", "opencode"}
	case "agy":
		// Antigravity 承载多家模型，候选按模型名前缀选择。
		switch {
		case hasPrefixFold(strippedModelID, "claude-"):
			return []string{"anthropic", "github-copilot", "google-vertex"}
		case hasPrefixFold(strippedModelID, "gemini-"),
			hasPrefixFold(strippedModelID, "gemma-"):
			return []string{"google", "github-copilot", "google-vertex"}
		case isOpenAIFamily(strippedModelID):
			return []string{"openai", "github-copilot"}
		case hasPrefixFold(strippedModelID, "grok-"):
			return []string{"xai"}
		default:
			return []string{"github-copilot"}
		}
	case "kimi":
		// OAuth 走 kimi-for-coding；api-key 走 moonshotai-cn / moonshotai。
		return []string{"kimi-for-coding", "moonshotai-cn", "moonshotai"}
	case "zcode":
		// GLM 模型挂在 Z.AI / 智谱 Coding Plan。
		return []string{"zai-coding-plan", "zhipuai-coding-plan", "zai", "zhipuai"}
	default:
		return nil
	}
}

// baseModelCandidates 返回基座模型候选键（厂商前缀推断 + 逐步裁尾）。
func baseModelCandidates(modelID string, strippedModelID string) []string {
	candidates := make([]string, 0, 16)
	if strings.Contains(modelID, "/") {
		candidates = append(candidates, modelID)
	}
	// 与 Node 一致：这些判断彼此独立，不做 else 短路。
	if isOpenAIFamily(strippedModelID) {
		candidates = append(candidates, "openai/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "claude-") {
		candidates = append(candidates, "anthropic/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "gemini-") || hasPrefixFold(strippedModelID, "gemma-") {
		candidates = append(candidates, "google/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "grok-") {
		candidates = append(candidates, "xai/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "kimi-") {
		candidates = append(candidates, "moonshotai/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "glm-") {
		candidates = append(candidates, "zhipuai/"+strippedModelID, "zhipu/"+strippedModelID)
	}
	// 能力/档位后缀变体：逐步裁掉尾段，落到基座模型的元数据。
	trimmed := strippedModelID
	for strings.Contains(trimmed, "-") {
		trimmed = trimmed[:strings.LastIndex(trimmed, "-")]
		if trimmed == "" {
			break
		}
		for _, prefix := range baseModelNamespaces {
			candidates = append(candidates, prefix+"/"+trimmed)
		}
		if strings.Contains(trimmed, "/") {
			candidates = append(candidates, trimmed)
		}
	}
	return candidates
}

// baseModelNamespaces 是基座回退会尝试的命名空间。
var baseModelNamespaces = []string{
	"openai",
	"anthropic",
	"google",
	"xai",
	"moonshotai",
	"zhipuai",
	"zhipu",
}

// stripKnownModelPrefix 去掉模型 ID 自带的聚合前缀。
func stripKnownModelPrefix(modelID string) string {
	switch {
	case strings.HasPrefix(modelID, "opencode-go/"):
		return modelID[len("opencode-go/"):]
	case strings.HasPrefix(modelID, "opencode/"):
		return modelID[len("opencode/"):]
	default:
		return modelID
	}
}

// isOpenAIFamily 判断模型名是否属于 OpenAI 命名空间下的家族。
func isOpenAIFamily(modelID string) bool {
	lowered := strings.ToLower(modelID)
	if strings.HasPrefix(lowered, "gpt-") ||
		strings.HasPrefix(lowered, "chatgpt-") ||
		strings.HasPrefix(lowered, "text-embedding-") {
		return true
	}
	// o1 / o3 / o4 这类推理模型：o 紧跟一位数字。
	if len(lowered) >= 2 && lowered[0] == 'o' && lowered[1] >= '0' && lowered[1] <= '9' {
		return true
	}
	return false
}

// hasPrefixFold 判断是否以指定前缀开头（大小写不敏感）。
func hasPrefixFold(value string, prefix string) bool {
	return len(value) >= len(prefix) && strings.EqualFold(value[:len(prefix)], prefix)
}

//go:generate npm run --prefix ../../../.. models:generate
