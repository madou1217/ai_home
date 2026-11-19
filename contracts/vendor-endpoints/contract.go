package vendorendpoints

// 本包是「厂商端点事实」的唯一数据源（contracts/vendor-endpoints/endpoints.json）。
//
// 为什么要有它：同一个厂商往往同时提供 Anthropic 与 OpenAI 两套兼容端点，
// 但账号只登记其中一个。协议转换（Anthropic↔OpenAI）是当前已知的多处故障源
// （DeepSeek 的 Anthropic 兼容层会把工具调用吐成 DSML 文本、千问的 Anthropic
// 兼容 base 干脆没有 /models），因此「账号 URL → 厂商 → 另一门协议的基址与模型
// 目录端点」必须是可查表的数据，而不是散落在各适配器里的字符串分支。
//
// 新增一家厂商 = 往 JSON 里加一条；Go 与 Node（lib/account/dual-format-endpoints.js）
// 读同一份文件，避免两侧事实漂移。

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"sync"
)

//go:embed endpoints.json
var manifest []byte

// 协议标识与端点路径里的语言保持一致（claude = anthropic，gpt/codex = openai）。
const (
	ProtocolAnthropic = "anthropic"
	ProtocolOpenAI    = "openai"
)

// ProtocolEndpoint 是厂商在某门协议下的兼容基址（已含版本段）。
type ProtocolEndpoint struct {
	BaseURL string `json:"base_url"`
}

// CatalogEndpoint 是该厂商可用的模型目录端点。
//
// Auth 声明目录端点认哪种认证头（"bearer" / "x-api-key"）；空串表示沿用账号
// 协议的原生头。第三方厂商的目录几乎都挂在 OpenAI 兼容端点上、只认 Bearer，
// 与 Claude 账号的 x-api-key 不同，因此必须显式声明。
type CatalogEndpoint struct {
	URL                 string `json:"url"`
	Auth                string `json:"auth"`
	ExcludeModelIDRegex string `json:"exclude_model_id_regex"`
}

// Vendor 是一家厂商的端点与目录事实。
type Vendor struct {
	ID        string                       `json:"id"`
	Label     string                       `json:"label"`
	Protocols map[string]ProtocolEndpoint  `json:"protocols"`
	Catalog   map[string][]CatalogEndpoint `json:"catalog"`
	// Evidence 记录这条事实的来源（实测日期或文档），便于日后复核。
	Evidence string `json:"evidence"`
}

// Resolution 是「这个账号 URL 属于哪家厂商的哪门协议」的结果。
type Resolution struct {
	Vendor   Vendor
	Protocol string
}

type contractDocument struct {
	SchemaVersion int      `json:"schema_version"`
	Vendors       []Vendor `json:"vendors"`
}

var index = buildIndex()

// buildIndex 把每家厂商每门协议的规范基址映射到解析结果。
//
// Anthropic 兼容基址可能带 `/v1` 后缀（Anthropic SDK 形态），两种写法指向同一
// 端点，因此一并登记。
func buildIndex() map[string]Resolution {
	var document contractDocument
	if err := json.Unmarshal(manifest, &document); err != nil {
		panic(err)
	}
	result := make(map[string]Resolution, len(document.Vendors)*3)
	for _, vendor := range document.Vendors {
		for protocol, endpoint := range vendor.Protocols {
			canonical, ok := canonicalBaseURL(endpoint.BaseURL)
			if !ok {
				continue
			}
			resolution := Resolution{Vendor: vendor, Protocol: protocol}
			result[canonical] = resolution
			if protocol == ProtocolAnthropic {
				result[canonical+"/v1"] = resolution
			}
		}
	}
	return result
}

// Resolve 按账号基址解析厂商与协议；未知地址返回 false，调用方保持通用行为。
func Resolve(rawBaseURL string) (Resolution, bool) {
	canonical, ok := canonicalBaseURL(rawBaseURL)
	if !ok {
		return Resolution{}, false
	}
	resolution, found := index[canonical]
	return resolution, found
}

// CatalogEndpoints 返回账号当前协议下的目录端点（可能为空：该厂商没有目录接口）。
func (resolution Resolution) CatalogEndpoints() []CatalogEndpoint {
	entries := resolution.Vendor.Catalog[resolution.Protocol]
	if len(entries) == 0 {
		return nil
	}
	return append([]CatalogEndpoint(nil), entries...)
}

// ProtocolBaseURL 返回该厂商在指定协议下的兼容基址；没有则返回空串。
func (resolution Resolution) ProtocolBaseURL(protocol string) string {
	endpoint, found := resolution.Vendor.Protocols[protocol]
	if !found {
		return ""
	}
	return strings.TrimSpace(endpoint.BaseURL)
}

// SupportsProtocol 判断厂商是否提供该协议的端点。
func (resolution Resolution) SupportsProtocol(protocol string) bool {
	return resolution.ProtocolBaseURL(protocol) != ""
}

// Vendors 返回全部厂商事实的副本（只读消费）。
func Vendors() []Vendor {
	var document contractDocument
	if err := json.Unmarshal(manifest, &document); err != nil {
		return nil
	}
	return append([]Vendor(nil), document.Vendors...)
}

// ExcludesModel 判断模型 ID 是否被目录条目的排除规则挡掉。
//
// 千问/百炼的 Anthropic 兼容端点只服务文本生成类模型，而 OpenAI 兼容目录会
// 同时列出 audio/image/video 模型；不过滤会让账号出现永远无法路由的模型。
func (entry CatalogEndpoint) ExcludesModel(modelID string) bool {
	pattern := strings.TrimSpace(entry.ExcludeModelIDRegex)
	if pattern == "" {
		return false
	}
	return compiledExclude(pattern).MatchString(modelID)
}

var excludePatterns sync.Map // map[string]*regexp.Regexp

func compiledExclude(pattern string) *regexp.Regexp {
	if cached, found := excludePatterns.Load(pattern); found {
		return cached.(*regexp.Regexp)
	}
	compiled, err := regexp.Compile(pattern)
	if err != nil {
		compiled = regexp.MustCompile(`$^`)
	}
	actual, _ := excludePatterns.LoadOrStore(pattern, compiled)
	return actual.(*regexp.Regexp)
}

// canonicalBaseURL 把基址规范成 scheme://host/path（小写 host、去尾斜杠）。
func canonicalBaseURL(rawBaseURL string) (string, bool) {
	value := strings.TrimSpace(rawBaseURL)
	if value == "" {
		return "", false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", false
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	return scheme + "://" + strings.ToLower(parsed.Host) + path, true
}
