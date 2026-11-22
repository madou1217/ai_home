package serverconfig

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
)

// Field 是 config:server 的唯一定义：WebUI 配置接口、CLI 解析与 help 都从这里派生。
//
// LegacyReason 非空表示该字段已没有运行时读方，仅为兼容旧配置保留：
// 读取/写入仍可用，但不再出现在 CLI help 与补全里。
type Field struct {
	Key       string
	Group     string
	Type      string
	Default   any
	Min       float64
	Max       float64
	Choices   []string
	Env       []string
	Applies   string
	Secret    bool
	HotReload bool
	// CLI 展示/解析元数据；仍放在同一张表，避免 CLI 维护第二份键名映射。
	Flag         string
	NegativeFlag string
	GenerateFlag string
	LegacyReason string
	ClearValue   any
	Summary      string
	// Normalize 是该字段的归一化策略；nil 表示按 Type 走默认策略。
	Normalize func(any) any
}

const (
	TypeIP       = "ip"
	TypePort     = "port"
	TypeBool     = "bool"
	TypeURL      = "url"
	TypeHosts    = "hosts"
	TypeSecret   = "secret"
	TypeInt      = "int"
	TypeEnum     = "enum"
	TypeCSV      = "csv"
	TypeDuration = "duration"
	TypeObject   = "object"
)

// Fields 的顺序就是 config 列表与 help 的展示顺序（按 Group 分组）。
var Fields = []Field{
	{Key: "host", Group: "监听与网络", Type: TypeIP, Default: DefaultHost, Env: []string{"AIH_SERVER_HOST"}, Applies: "serve-arg",
		Summary: "监听地址；Go Server 只接受 loopback（127.0.0.1）。"},
	{Key: "port", Group: "监听与网络", Type: TypePort, Default: float64(DefaultPort), Min: 1, Max: 65535, Env: []string{"AIH_SERVER_PORT"}, Applies: "serve-arg",
		Summary: "监听端口；网关、WebUI 与中转共用。"},
	{Key: "openNetwork", Group: "监听与网络", Type: TypeBool, Default: false, Applies: "serve-arg",
		LegacyReason: "Go Server 只允许 loopback；对外由反向代理/Cloudflare 承担。",
		Summary:      "历史字段：是否对外监听。"},
	{Key: "proxyUrl", Group: "监听与网络", Type: TypeURL, Default: "", Env: []string{"AIH_SERVER_PROXY_URL"}, Applies: "serve-arg", HotReload: true, ClearValue: "",
		Summary: "上游请求走的 HTTP(S) 代理；空 = 直连。"},
	{Key: "noProxy", Group: "监听与网络", Type: TypeHosts, Default: "", Env: []string{"AIH_SERVER_NO_PROXY", "NO_PROXY"}, Applies: "serve-arg",
		Summary: "不走代理的主机列表（逗号分隔，支持通配与域名后缀）。"},

	{Key: "apiKey", Group: "鉴权", Type: TypeSecret, Default: "", Env: []string{"AIH_SERVER_API_KEY"}, Applies: "serve-arg", Secret: true,
		Summary: "客户端（codex/claude 等）调用 /v1 与 /v1beta 的 Bearer key。"},
	{Key: "managementKey", Group: "鉴权", Type: TypeSecret, Default: "", Env: []string{"AIH_SERVER_MANAGEMENT_KEY"}, Applies: "serve-arg", Secret: true,
		Summary: "管理面（WebUI、管理 API、远程重启）所需的 key。"},

	{Key: "modelsProbeAccounts", Group: "模型探测", Type: TypeInt, Default: float64(2), Min: 1, Max: 8, Applies: "serve-arg",
		LegacyReason: "模型目录已改为 Go 批量刷新，不再按账号并发探测。",
		Summary:      "历史字段：模型目录探测并发账号数。"},
	{Key: "modelCacheSync", Group: "模型探测", Type: TypeEnum, Default: "go-batch", Choices: []string{"scheduler", "go-batch"}, Applies: "runtime",
		LegacyReason: "scheduler 调度器已退役，缓存固定 go-batch。",
		Summary:      "历史字段：WebUI 模型缓存刷新方式。"},

	{Key: "windowActivation", Group: "窗口激活", Type: TypeBool, Default: false, Applies: "serve-arg",
		Summary: "窗口激活的全局闸门；还需在账号页逐账号打开。"},
	{Key: "windowActivationDefaultIntervalMs", Group: "窗口激活", Type: TypeDuration, Default: float64(3600000), Min: 60000, Applies: "serve-arg", Normalize: windowInterval(3600000, 60000),
		Summary: "观察不到窗口时的兜底探测间隔（≥ 1 分钟）。"},
	{Key: "windowActivationMinIntervalMs", Group: "窗口激活", Type: TypeDuration, Default: float64(3600000), Min: 60000, Applies: "serve-arg", Normalize: windowInterval(3600000, 60000),
		Summary: "探测间隔下限；逐账号设置不得小于它。"},

	{Key: "goCoreEnabled", Group: "路由", Type: TypeBool, Default: false, Flag: "--go-core", Env: []string{"AIH_GO_CORE_ENABLED"}, Applies: "runtime",
		LegacyReason: "Node 已退场，Go 是唯一入口，该开关恒为 true。",
		Summary:      "历史字段：是否由 Go Core 承接数据面。"},
	{Key: "goCoreRoutes", Group: "路由", Type: TypeCSV, Default: []string{}, Env: []string{"AIH_GO_CORE_ROUTES"}, Applies: "runtime", ClearValue: []string{},
		LegacyReason: "route-ownership 投影已随 Node 退场。",
		Summary:      "历史字段：由 Go 承接的路由条目。"},
	{Key: "upstreamErrorRuleProviders", Group: "路由", Type: TypeCSV, Default: []string{}, Env: []string{"AIH_SERVER_UPSTREAM_ERROR_RULES"}, Applies: "runtime", ClearValue: []string{}, Flag: "--upstream-error-rules",
		LegacyReason: "规则求值已统一由进程环境 AIH_SERVER_UPSTREAM_ERROR_RULES 声明。",
		Summary:      "历史字段：由 Go 执行的账号自定义错误规则 Provider。"},

	{Key: "relayUdp", Group: "中转", Type: TypeEnum, Default: "default", Choices: []string{"default", "on", "off"}, Env: []string{"AIH_RELAY_SETTINGS"}, Applies: "process-env",
		LegacyReason: "中转设置改由进程环境 AIH_RELAY_SETTINGS 提供。",
		Summary:      "历史字段：中转 UDP 开关。"},
	{Key: "relayUdpAdvertiseHost", Group: "中转", Type: TypeIP, Default: "", Env: []string{"AIH_RELAY_SETTINGS"}, Applies: "process-env", ClearValue: "",
		LegacyReason: "中转设置改由进程环境 AIH_RELAY_SETTINGS 提供。",
		Summary:      "历史字段：播报给客户端的 UDP 入口主机。"},
	{Key: "relayUdpAdvertisePort", Group: "中转", Type: TypePort, Default: float64(0), Min: 0, Max: 65535, Env: []string{"AIH_RELAY_SETTINGS"}, Applies: "process-env", ClearValue: float64(0), Normalize: clampPort(0, 65535),
		LegacyReason: "中转设置改由进程环境 AIH_RELAY_SETTINGS 提供。",
		Summary:      "历史字段：播报给客户端的 UDP 端口。"},
	{Key: "relayPortMode", Group: "中转", Type: TypeEnum, Default: "default", Choices: []string{"default", "server", "dedicated"}, Env: []string{"AIH_RELAY_SETTINGS"}, Applies: "process-env",
		LegacyReason: "中转设置改由进程环境 AIH_RELAY_SETTINGS 提供。",
		Summary:      "历史字段：中转端口布局。"},
	{Key: "relayListenHost", Group: "中转", Type: TypeIP, Default: "", Env: []string{"AIH_RELAY_SETTINGS"}, Applies: "process-env", ClearValue: "",
		LegacyReason: "中转设置改由进程环境 AIH_RELAY_SETTINGS 提供。",
		Summary:      "历史字段：中转入口绑定的网卡。"},

	{Key: "egressEvidenceTtlMs", Group: "调度", Type: TypeDuration, Default: float64(0), Min: 60000, Max: 31536000000, Applies: "runtime", ClearValue: float64(0),
		Summary: "出口节点实测结论的有效期；0 = 默认 7 天。"},
	{Key: "maxAttempts", Group: "调度", Type: TypeInt, Default: float64(0), Min: 0, Max: 32, Applies: "serve-arg", ClearValue: float64(0),
		Summary: "单次请求最多尝试几个账号；0 = 默认 3。"},
	{Key: "largePasteChars", Group: "WebUI", Type: TypeInt, Default: float64(0), Min: 50, Max: 100000, Applies: "runtime", ClearValue: float64(0),
		Summary: "WebUI 粘贴多少字以上转文本附件；0 = 默认 200。"},
	{Key: "upstream429Retry", Group: "调度", Type: TypeObject, Default: nil, Applies: "runtime", HotReload: true, ClearValue: map[string]any{"backoffSeconds": corepolicy.DefaultBackoffSeconds()},
		Summary: "上游真实 429 的有界退避重试配置。"},
	{Key: "upstreamFailurePolicy", Group: "调度", Type: TypeObject, Default: nil, Applies: "runtime", HotReload: true, ClearValue: map[string]any{},
		Normalize: normalizeUpstreamFailurePolicy,
		Summary:   "上游失败语义的全局覆盖（阈值/窗口/冷却与状态码语义）。"},
	{Key: "concurrency", Group: "调度", Type: TypeObject, Default: nil, Applies: "runtime", HotReload: true, ClearValue: map[string]any{},
		Normalize: normalizeConcurrency,
		Summary:   "并发/速率上限（系统、Provider、账号；本轮只存储与预览）。"},
}

func init() {
	for position := range Fields {
		field := &Fields[position]
		if field.Flag == "" {
			field.Flag = camelFlag(field.Key)
		}
		switch field.Key {
		case "openNetwork":
			field.NegativeFlag = "--local-only"
		case "windowActivation", "goCoreEnabled":
			field.NegativeFlag = "--no-" + strings.TrimPrefix(field.Flag, "--")
		}
		if field.Key == "apiKey" || field.Key == "managementKey" {
			field.GenerateFlag = "--generate-" + strings.TrimPrefix(field.Flag, "--")
		}
	}
}

func camelFlag(key string) string {
	var builder strings.Builder
	builder.WriteString("--")
	for index, symbol := range key {
		if symbol >= 'A' && symbol <= 'Z' {
			if index > 0 {
				builder.WriteByte('-')
			}
			builder.WriteRune(symbol - 'A' + 'a')
			continue
		}
		builder.WriteRune(symbol)
	}
	return builder.String()
}

var fieldByKey = func() map[string]*Field {
	index := make(map[string]*Field, len(Fields))
	for position := range Fields {
		index[Fields[position].Key] = &Fields[position]
	}
	return index
}()

// FieldByKey 返回字段描述；未知 key 返回 nil。
func FieldByKey(key string) *Field { return fieldByKey[key] }

// Keys 返回全部可持久化键，顺序与 Fields 一致。
func Keys() []string {
	keys := make([]string, 0, len(Fields))
	for _, field := range Fields {
		keys = append(keys, field.Key)
	}
	return keys
}

// ActiveFields 返回仍在使用的字段（help/补全只列这些）。
func ActiveFields() []Field {
	active := make([]Field, 0, len(Fields))
	for _, field := range Fields {
		if field.LegacyReason == "" {
			active = append(active, field)
		}
	}
	return active
}

// Sanitize 按字段策略把任意 JSON 对象归一成合法配置；未知键丢弃。
func Sanitize(input map[string]any) map[string]any {
	values := make(map[string]any, len(Fields))
	for position := range Fields {
		field := &Fields[position]
		raw, found := input[field.Key]
		switch {
		case !found || raw == nil:
			if field.Type == TypeObject && field.Normalize == nil {
				values[field.Key] = corepolicy.SanitizeGlobalRaw(nil)
			} else {
				values[field.Key] = field.Default
			}
		case field.Normalize != nil:
			values[field.Key] = field.Normalize(raw)
		default:
			values[field.Key] = normalizeByType(*field, raw)
		}
	}
	host := strings.TrimSpace(jsString(values["host"]))
	openNetwork := values["openNetwork"] == true || host == "0.0.0.0"
	if host == "" || host == "0.0.0.0" {
		host = DefaultHost
	}
	if openNetwork {
		host = "0.0.0.0"
	}
	values["host"] = host
	values["openNetwork"] = openNetwork
	// 兜底间隔不得小于逐账号下限（旧 WebUI 的跨字段规则）。
	minInterval := numberOr(values["windowActivationMinIntervalMs"], 3600000)
	defaultInterval := numberOr(values["windowActivationDefaultIntervalMs"], 3600000)
	if defaultInterval < minInterval {
		values["windowActivationDefaultIntervalMs"] = minInterval
	}
	return values
}

// normalizeUpstreamFailurePolicy 接受对象或 JSON 字符串；无法解析时回到 nil
// （内置契约），真正的合法性由 internal/runtime/upstreamfailurepolicy 校验。
func normalizeUpstreamFailurePolicy(raw any) any {
	switch value := raw.(type) {
	case nil:
		return nil
	case map[string]any:
		if value == nil {
			return nil
		}
		return value
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return nil
		}
		var object map[string]any
		if err := json.Unmarshal([]byte(trimmed), &object); err != nil {
			return nil
		}
		return object
	default:
		return nil
	}
}

// normalizeConcurrency 接受对象或 JSON 字符串；合法性由 core/concurrency 校验。
func normalizeConcurrency(raw any) any {
	switch value := raw.(type) {
	case nil:
		return nil
	case map[string]any:
		if value == nil {
			return nil
		}
		return value
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return nil
		}
		var object map[string]any
		if err := json.Unmarshal([]byte(trimmed), &object); err != nil {
			return nil
		}
		return object
	default:
		return nil
	}
}

func normalizeByType(field Field, raw any) any {
	switch field.Type {
	case TypeBool:
		return raw == true
	case TypePort:
		return float64(NormalizePort(raw))
	case TypeInt:
		return normalizeInt(field, raw)
	case TypeDuration:
		return normalizeDuration(field, raw)
	case TypeEnum:
		value := strings.ToLower(strings.TrimSpace(jsString(raw)))
		for _, choice := range field.Choices {
			if value == choice {
				return value
			}
		}
		return field.Default
	case TypeCSV:
		return normalizeList(raw, field.Key == "upstreamErrorRuleProviders")
	case TypeObject:
		return corepolicy.SanitizeGlobalRaw(raw)
	default:
		return strings.TrimSpace(jsString(raw))
	}
}

// windowInterval 复刻旧 WebUI：0/缺失回落默认值，再抬到下限。
func windowInterval(fallback, minimum float64) func(any) any {
	return func(raw any) any {
		number := math.Round(numberOr(raw, 0))
		if number == 0 {
			number = fallback
		}
		if number < minimum {
			number = minimum
		}
		return number
	}
}

func clampPort(minimum, maximum float64) func(any) any {
	return func(raw any) any {
		number := math.Round(numberOr(raw, 0))
		if number < minimum {
			return minimum
		}
		if number > maximum {
			return maximum
		}
		return number
	}
}

func normalizeInt(field Field, raw any) any {
	number := math.Round(numberOr(raw, 0))
	if field.Key == "modelsProbeAccounts" && number == 0 {
		return field.Default
	}
	if field.Key == "largePasteChars" {
		if number <= 0 {
			return float64(0)
		}
		if number < field.Min {
			return field.Min
		}
		if number > field.Max {
			return field.Max
		}
		return number
	}
	if number == 0 {
		return float64(0)
	}
	if number < field.Min {
		return field.Min
	}
	if number > field.Max {
		return field.Max
	}
	return number
}

func normalizeDuration(field Field, raw any) any {
	number := math.Round(numberOr(raw, 0))
	if field.Key == "egressEvidenceTtlMs" {
		if number < field.Min {
			return float64(0)
		}
		if number > field.Max {
			return field.Max
		}
		return number
	}
	if number < field.Min {
		return field.Min
	}
	if number > field.Max {
		return field.Max
	}
	return number
}

func normalizeList(raw any, lowercase bool) []string {
	items := make([]string, 0)
	var list []any
	switch typed := raw.(type) {
	case []any:
		list = typed
	case []string:
		list = make([]any, 0, len(typed))
		for _, item := range typed {
			list = append(list, item)
		}
	case string:
		// CLI 的 --go-core-routes a,b / --upstream-error-rules a,b 传逗号分隔字符串。
		for _, item := range strings.Split(typed, ",") {
			list = append(list, item)
		}
	}
	seen := map[string]bool{}
	for _, item := range list {
		value := strings.TrimSpace(jsString(item))
		if lowercase {
			value = strings.ToLower(value)
		}
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		items = append(items, value)
	}
	return items
}

func jsString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func numberOr(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case float32:
		return float64(typed)
	case string:
		// CLI 传的是字符串；按 JS Number 语义解析，非法值才回退。
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil {
			return parsed
		}
		return fallback
	default:
		return fallback
	}
}
