package images

// 本文件是「图片能力」的宏观合同：抽象层定义能力的形状与语义，各 Provider 实现只声明
// 自己的取值。调用方（HTTP 入口、WebUI 目录、诊断）只读这里的类型，不再散落
// `if provider == ...` 判断。
//
// 分层：
//   - Capabilities（见 core.go）是**微观声明**：某个策略在某个模型上原生能做什么；
//   - Capability 是本文件的**宏观投影**：在原生能力之上叠加网关自身能力（格式转码、
//     编码解码），得到「客户端实际可以用什么」，并通过 JSON 对外透传。

import (
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// Format 是图片编码格式的规范标识（与 MIME 的 image/<format> 对应）。
type Format string

const (
	FormatPNG  Format = "png"
	FormatJPEG Format = "jpeg"
	FormatWebP Format = "webp"
	FormatGIF  Format = "gif"
)

// decodableFormats 是网关能够解码的格式：只有能解码的源格式才谈得上转码。
var decodableFormats = []Format{FormatPNG, FormatJPEG, FormatWebP, FormatGIF}

// encodableFormats 是网关能够产出的格式，与「请求 output_format 的合法值」一致。
var encodableFormats = []Format{FormatPNG, FormatJPEG, FormatWebP}

// Capability 是客户端可见的图片能力合同。
//
// 字段刻意平铺且带 JSON 标签：WebUI、管理诊断与外部接入读同一份事实，不需要各自
// 维护 provider 清单。
type Capability struct {
	// TextToImage 表示文生图（请求不带参考图）。
	TextToImage bool `json:"textToImage"`
	// ImageToImage 表示图生图（以参考图出图，含编辑）。
	ImageToImage bool `json:"imageToImage"`
	// Mask 表示支持蒙版编辑。
	Mask bool `json:"mask"`
	// MaxInputImages 是单次请求可带的参考图上限（至少 1）。
	MaxInputImages int `json:"maxInputImages"`
	// MaxOutputImages 是单次请求可生成的数量上限；0 表示上游未声明上限。
	MaxOutputImages int `json:"maxOutputImages"`
	// InputFormats 是入口可接受的参考图格式：网关会把它们转换成上游声明的格式。
	InputFormats []string `json:"inputFormats"`
	// NativeInputFormats 是上游原生接受的参考图格式（差异在这里被吸收）。
	NativeInputFormats []string `json:"nativeInputFormats"`
	// InputEncodings 是参考图的传入方式：b64（多部分/JSON 内嵌）与 url。
	InputEncodings []string `json:"inputEncodings"`
	// NativeOutputFormats 是上游原生可产出的格式。
	NativeOutputFormats []string `json:"nativeOutputFormats"`
	// OutputFormats 是网关可交付给客户端的格式：原生格式 ∪ 可转码格式。
	OutputFormats []string `json:"outputFormats"`
	// OutputCompression 表示支持有损格式的质量参数。
	OutputCompression bool `json:"outputCompression"`
	// Background 表示支持背景控制（如 transparent）。
	Background bool `json:"background"`
	// Sizes 是显式尺寸白名单；为空表示只接受 auto。
	Sizes []string `json:"sizes,omitempty"`
	// Qualities 是质量档位白名单。
	Qualities []string `json:"qualities,omitempty"`
}

// EffectiveCapability 把策略的原生声明投影成客户端合同。
//
// 关键规则：只要上游能产出至少一种可解码格式，网关就能把它转成任何一种可编码格式，
// 因此 OutputFormats 会在原生格式之外补上转码目标——这正是「不支持就转码，而不是
// 拒绝」的抽象位置，Provider 实现不需要各自处理。
func EffectiveCapability(strategy Strategy, modelID string) Capability {
	native := strategy.Capabilities(modelID)
	return effectiveCapabilityFrom(native, modelID, strategy.Provider())
}

func effectiveCapabilityFrom(native Capabilities, modelID string, provider string) Capability {
	capability := Capability{
		TextToImage:    native.Generation,
		ImageToImage:   native.Edit,
		Mask:           native.Mask,
		MaxInputImages: native.MaxInputImages,
		MaxOutputImages: func() int {
			if native.Multiple {
				return 0
			}
			return 1
		}(),
		InputFormats:       formatStrings(decodableFormats),
		NativeInputFormats: formatStrings(AcceptedInputFormats(native)),
		InputEncodings:     []string{"b64", "url"},
		OutputCompression:  native.OutputCompression,
		Background:         native.Background,
	}
	if capability.MaxInputImages < 1 {
		capability.MaxInputImages = 1
	}

	nativeFormats := nativeOutputFormats(native)
	capability.NativeOutputFormats = formatStrings(nativeFormats)
	if len(nativeFormats) > 0 {
		capability.OutputFormats = formatStrings(unionFormats(nativeFormats, encodableFormats))
	}

	if spec, found := resolveModelSpec(provider, modelID); found {
		capability.Qualities = append([]string(nil), spec.QualityOptions...)
		// 模型级声明比 Provider 级更精确：图片模型的参考图上限常常按模型不同
		// （gemini-3.1-flash-image 支持 14 张），有效能力必须采用模型自己的值。
		if spec.HasMaxInputImages && spec.MaxInputImages > 0 {
			capability.MaxInputImages = spec.MaxInputImages
		}
		if spec.SupportsSize {
			capability.Sizes = imageSizeList()
		}
	}
	return capability
}

// nativeOutputFormats 返回上游原生格式；未声明具体格式时以默认格式为准。
func nativeOutputFormats(native Capabilities) []Format {
	if len(native.OutputFormats) > 0 {
		formats := make([]Format, 0, len(native.OutputFormats))
		for _, format := range native.OutputFormats {
			formats = append(formats, normalizeFormat(format))
		}
		return formats
	}
	if def := normalizeFormat(native.DefaultOutputFormat); def != "" {
		return []Format{def}
	}
	return nil
}

func normalizeFormat(value string) Format {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "png":
		return FormatPNG
	case "jpeg", "jpg":
		return FormatJPEG
	case "webp":
		return FormatWebP
	default:
		return ""
	}
}

func unionFormats(left []Format, right []Format) []Format {
	seen := make(map[Format]struct{}, len(left)+len(right))
	out := make([]Format, 0, len(left)+len(right))
	for _, format := range append(append([]Format(nil), left...), right...) {
		if format == "" {
			continue
		}
		if _, exists := seen[format]; exists {
			continue
		}
		seen[format] = struct{}{}
		out = append(out, format)
	}
	return out
}

func formatStrings(formats []Format) []string {
	out := make([]string, 0, len(formats))
	for _, format := range formats {
		if format == "" {
			continue
		}
		out = append(out, string(format))
	}
	return out
}

// supportsOutputFormat 判断客户端请求的格式是否可交付（原生或可转码）。
func (capability Capability) supportsOutputFormat(format string) bool {
	target := string(normalizeFormat(format))
	if target == "" {
		return false
	}
	for _, available := range capability.OutputFormats {
		if available == target {
			return true
		}
	}
	return false
}

// nativeSupportsOutputFormat 判断上游是否原生产出该格式（决定是否需要转码）。
func nativeSupportsOutputFormat(native Capabilities, format string) bool {
	target := normalizeFormat(format)
	if target == "" {
		return false
	}
	for _, available := range nativeOutputFormats(native) {
		if available == target {
			return true
		}
	}
	return false
}

// imageSizeList 返回网关能映射到上游的显式尺寸白名单（见 imageSizeAspectRatios）。
func imageSizeList() []string {
	sizes := make([]string, 0, len(imageSizeAspectRatios))
	for size := range imageSizeAspectRatios {
		sizes = append(sizes, size)
	}
	sort.Strings(sizes)
	return sizes
}

// ImageModels 供能力查询接口使用：列出该策略声明的模型与有效能力。
func ImageModels(strategy Strategy) []ModelCapability {
	models := NativeImageModels(strategy.Provider())
	out := make([]ModelCapability, 0, len(models))
	for _, model := range models {
		out = append(out, ModelCapability{
			Provider:   strategy.Provider(),
			Model:      model,
			Capability: EffectiveCapability(strategy, model),
		})
	}
	return out
}

// ModelCapability 是向客户端透传的一行能力事实。
type ModelCapability struct {
	Provider   string     `json:"provider"`
	Model      string     `json:"model"`
	Capability Capability `json:"capability"`
}

// OutputMode 描述一次请求属于哪种图片语义，供诊断与能力投影复用。
func OutputMode(request imagegeneration.Request) string {
	if request.Mode == imagegeneration.ModeEdit {
		return "image_to_image"
	}
	return "text_to_image"
}
