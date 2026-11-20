package images

// 本文件是图片 size/quality 能力的唯一声明表。
//
// 分层（与 capability.go 顶部的能力分层一致）：
//   - 抽象层（本文件）拥有**客户端词汇**：入口只接受 imagegeneration 解析器认可的
//     通用 size（WxH / auto）与 quality（low/medium/high，auto 表示不指定），并用
//     同一张表判定取值是否被某个 Provider 接受。
//   - Provider 层拥有**映射**：表的每一行声明该 Provider 接受哪些客户端取值，以及
//     转成上游原生的哪个值——agy 把 OpenAI 尺寸映射为 Gemini 的 aspectRatio，codex
//     把尺寸/质量原样透传，passthrough 的尺寸由上游裁决（不设白名单）。
//   - Provider 的 Generate 只消费表里的映射（见 buildGeminiImageConfig），不再各自
//     维护尺寸/质量分支；能力投影（capability.go 的 imageSizeList）也复用同一份事实。
//
// 因此新增 Provider 或新增一个取值时只改这张表：校验（CheckCapabilities）、能力
// 投影与生成代码读到的永远是同一份声明，不会出现「能力广告了但校验不认」的漂移。

// sizeMapping 是一条「客户端取值 → Provider 原生值」的尺寸映射。
type sizeMapping struct {
	// Client 是客户端发送的显式尺寸（形如 1024x1024）。
	Client string
	// Native 是上游原生的尺寸表示（Gemini 为宽高比；原样透传时等于 Client）。
	Native string
}

// qualityMapping 是一条「客户端取值 → Provider 原生值」的质量映射。
type qualityMapping struct {
	// Client 是客户端发送的质量档位（low/medium/high）。
	Client string
	// Native 是上游原生的质量值（当前各 Provider 均为原样透传）。
	Native string
}

// sizeQualityMapping 是一个 Provider 对客户端 size/quality 词汇的声明。
//
// 切片为 nil 表示该维度不设白名单：取值合法性由上游裁决（passthrough 的尺寸）。
// 非 nil 时是**有序**白名单，顺序即错误信息中展示的顺序。
type sizeQualityMapping struct {
	Sizes     []sizeMapping
	Qualities []qualityMapping
}

// commonImageSizes 是客户端共用的显式尺寸词汇。
//
// OpenAI 标准尺寸在前，Open Design 的宽高比预设随后：两者都只是客户端词汇，
// 真正的上游像素由各 Provider 的映射决定（agy 只取宽高比，不做缩放）。
var commonImageSizes = []string{
	"1024x1024",
	"1536x1024",
	"1024x1536",
	"1792x1024",
	"1024x1792",
	"1408x1056",
	"1056x1408",
}

// openAIImageSizes 是 OpenAI gpt-image 系列实际接受的显式尺寸。
//
// 把 agy 的宽高比预设（1792x1024 等）一起递给 OpenAI 只会换来上游 400：
// 「网关接受但上游不认」正是尺寸映射不闭环的典型缺口，必须在声明表就分开。
var openAIImageSizes = []string{
	"1024x1024",
	"1536x1024",
	"1024x1536",
}

// commonImageQualities 是客户端共用的质量词汇；auto 由入口按「未指定」处理，
// 不进入白名单。
var commonImageQualities = []string{"low", "medium", "high"}

// sizeQualityByProvider 是唯一的 size/quality 声明表。
//
// 键是策略的规范 Provider 键（strategy.Provider()），不是请求里的路由参数：
// 同一个账号 Provider 可能因凭据形态落到不同策略（如 codex 的 api-key 账号走
// passthrough），映射必须跟随真正执行请求的策略。
var sizeQualityByProvider = map[string]sizeQualityMapping{
	"agy": {
		// Gemini 只接受宽高比，不接受像素尺寸；只做映射，不做缩放。
		Sizes: []sizeMapping{
			{Client: "1024x1024", Native: "1:1"},
			{Client: "1536x1024", Native: "3:2"},
			{Client: "1024x1536", Native: "2:3"},
			{Client: "1792x1024", Native: "16:9"},
			{Client: "1024x1792", Native: "9:16"},
			{Client: "1408x1056", Native: "4:3"},
			{Client: "1056x1408", Native: "3:4"},
		},
		// agy 不接受质量控制，由 Capabilities.Quality=false 在校验中直接拒绝。
	},
	"codex": {
		// Codex Images API 只接受 OpenAI 自己的尺寸集合（原样传给上游）。
		Sizes:     identitySizeMappings(openAIImageSizes),
		Qualities: identityQualityMappings(commonImageQualities),
	},
	"passthrough": {
		// 尺寸的权威是上游：OpenAI 兼容端点（或另一台 AIH）支持的取值比网关更大，
		// dall-e-3 等模型还有自己的尺寸集合，网关这一跳不设白名单。
		// 质量仍沿用 OpenAI 通用词汇（与入口严格解析一致）。
		Qualities: identityQualityMappings(commonImageQualities),
	},
}

// sizeQualityMappingForProvider 返回规范 Provider 键对应的声明。
func sizeQualityMappingForProvider(provider string) (sizeQualityMapping, bool) {
	mapping, found := sizeQualityByProvider[normalizeProvider(provider)]
	return mapping, found
}

// sizeQualityMappingForStrategy 按真正执行请求的策略取声明。
//
// 用 strategy.Provider() 而不是调用方传入的路由 Provider：映射属于策略实现，
// 不随账号挂在哪个 Provider 名下而改变。
func sizeQualityMappingForStrategy(strategy Strategy) (sizeQualityMapping, bool) {
	if strategy == nil {
		return sizeQualityMapping{}, false
	}
	return sizeQualityMappingForProvider(strategy.Provider())
}

// nativeSize 返回客户端尺寸对应的 Provider 原生值。
func (mapping sizeQualityMapping) nativeSize(client string) (string, bool) {
	for _, entry := range mapping.Sizes {
		if entry.Client == client {
			return entry.Native, true
		}
	}
	return "", false
}

// supportsSize 判断客户端尺寸是否被接受；nil 白名单表示交给上游裁决。
func (mapping sizeQualityMapping) supportsSize(client string) bool {
	if mapping.Sizes == nil {
		return true
	}
	_, found := mapping.nativeSize(client)
	return found
}

// sizeValues 返回白名单取值（按声明顺序）；nil 表示不设白名单。
func (mapping sizeQualityMapping) sizeValues() []string {
	if mapping.Sizes == nil {
		return nil
	}
	values := make([]string, 0, len(mapping.Sizes))
	for _, entry := range mapping.Sizes {
		values = append(values, entry.Client)
	}
	return values
}

// nativeQuality 返回客户端质量档位对应的 Provider 原生值。
func (mapping sizeQualityMapping) nativeQuality(client string) (string, bool) {
	for _, entry := range mapping.Qualities {
		if entry.Client == client {
			return entry.Native, true
		}
	}
	return "", false
}

// supportsQuality 判断客户端质量档位是否被接受；nil 白名单表示交给上游裁决。
func (mapping sizeQualityMapping) supportsQuality(client string) bool {
	if mapping.Qualities == nil {
		return true
	}
	_, found := mapping.nativeQuality(client)
	return found
}

// qualityValues 返回白名单取值（按声明顺序）；nil 表示不设白名单。
func (mapping sizeQualityMapping) qualityValues() []string {
	if mapping.Qualities == nil {
		return nil
	}
	values := make([]string, 0, len(mapping.Qualities))
	for _, entry := range mapping.Qualities {
		values = append(values, entry.Client)
	}
	return values
}

// nativeSizeForProvider 是策略侧读取尺寸映射的唯一入口。
func nativeSizeForProvider(provider string, client string) (string, bool) {
	mapping, found := sizeQualityMappingForProvider(provider)
	if !found {
		return "", false
	}
	return mapping.nativeSize(client)
}

// qualityValuesForProvider 返回 Provider 的质量白名单；nil 表示不设白名单。
//
// NativeQualityOptions 与能力投影复用它，避免「校验用一套、广告用另一套」。
func qualityValuesForProvider(provider string) []string {
	mapping, found := sizeQualityMappingForProvider(provider)
	if !found {
		return nil
	}
	return mapping.qualityValues()
}

// identitySizeMappings 生成原样透传的尺寸白名单。
func identitySizeMappings(sizes []string) []sizeMapping {
	mappings := make([]sizeMapping, 0, len(sizes))
	for _, size := range sizes {
		mappings = append(mappings, sizeMapping{Client: size, Native: size})
	}
	return mappings
}

// identityQualityMappings 生成原样透传的质量白名单。
func identityQualityMappings(qualities []string) []qualityMapping {
	mappings := make([]qualityMapping, 0, len(qualities))
	for _, quality := range qualities {
		mappings = append(mappings, qualityMapping{Client: quality, Native: quality})
	}
	return mappings
}
