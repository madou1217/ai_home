// Package opencode 构造 OpenCode 的受管宿主配置（~/.config/opencode/opencode.jsonc）。
//
// 语义对齐 Node 的 lib/account/host-gateway-profile.js buildOpenCodeGatewayContent：
//   - model 指到 aih/<model>，model 只从探测到的模型里挑（家族优先 + 版本号最大）。
//   - provider.aih 写 npm/name/options{baseURL,apiKey}/models。
//   - 已存在的 provider.aih 若 name 不是 AI Home Gateway，说明名字被人占用，失败关闭。
//
// 与 Node 的唯一差别是 JSONC 的写法：按路径原地改写，用户的键、注释、缩进、尾随逗号
// 全都不动；Node 用 jsonc-parser 达到同样效果，这里不引第三方依赖。
//
// 本包只做内容构造，不碰文件与档位状态；调用方把 BuildGatewayContent 接到
// aihdefault.ActivateProfile，或直接取内容写自己的托管文件。
package opencode

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	// SchemaURL 是缺省写入的 $schema；文件里已有该键时保留用户的值。
	SchemaURL = "https://opencode.ai/config.json"
	// GatewayProviderID 是网关在 opencode 里的 provider 名，也是 model 前缀。
	GatewayProviderID = "aih"
	// GatewayProviderName 是 aih provider 的显示名，同时是归属判定标记。
	GatewayProviderName = "AI Home Gateway"
	// GatewayProviderNPM 是 opencode 拉取兼容层用的包名。
	GatewayProviderNPM = "@ai-sdk/openai-compatible"
	// DefaultAPIKey 是本地网关不校验鉴权时的占位值：opencode 要求该字段非空。
	DefaultAPIKey = "dummy"

	defaultHost = "127.0.0.1"
	defaultPort = 9527
)

// 与 Node throw new Error(...) 的 message 保持一致，便于上层按串映射提示。
var (
	ErrInvalidConfig          = errors.New("invalid_opencode_config")
	ErrInvalidConfigAfterEdit = errors.New("invalid_opencode_config_after_edit")
	ErrProviderConflict       = errors.New("opencode_gateway_provider_conflict")
	ErrModelsUnavailable      = errors.New("opencode_gateway_models_unavailable")
)

// ServerConfig 是构造网关地址与鉴权所需的服务器配置子集。
type ServerConfig struct {
	Host      string
	Port      int
	APIKey    string
	ClientKey string
}

// Gateway 是一次落点要写入的网关参数。
//
// Models 是运行时探测到的模型；为空时失败关闭——没有候选就选不出 model，
// 猜一个写死型号等于把用户钉在过期模型上。
type Gateway struct {
	Server    ServerConfig
	Models    []string
	SchemaURL string
}

// ContentBuilder 是匿名函数别名，可直接赋给 aihdefault.BuildContent。
type ContentBuilder = func(current string, existed bool) (string, error)

// BaseURL 返回 AIH Server 的 OpenAI 兼容基址（对齐 Node buildAihServerBaseUrl）。
func BaseURL(server ServerConfig) string {
	host := strings.TrimSpace(server.Host)
	if host == "" || host == "0.0.0.0" {
		host = defaultHost
	}
	// IPv6 字面量要方括号；已带括号的不重复包。
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	port := server.Port
	if port <= 0 || port > 65535 {
		port = defaultPort
	}
	return fmt.Sprintf("http://%s:%d/v1", host, port)
}

// BuildGatewayContent 把 BuildGatewayConfig 适配成 BuildContent。
// existed 不参与内容计算：缺文件时 current 是空串。
func BuildGatewayContent(gateway Gateway) ContentBuilder {
	return func(current string, _ bool) (string, error) {
		return BuildGatewayConfig(current, gateway)
	}
}

// BuildGatewayConfig 在现有 JSONC 文本上原地改写，保留用户键与注释。
func BuildGatewayConfig(rawConfig string, gateway Gateway) (string, error) {
	gatewaySpec, err := newSpec(gateway)
	if err != nil {
		return "", err
	}
	text := []byte(rawConfig)
	if len(strings.TrimSpace(rawConfig)) == 0 {
		text = []byte("{}")
	}
	root, err := parseJSONC(text)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if err := checkDocument(text, root); err != nil {
		return "", err
	}
	writes := []struct {
		path          []string
		value         any
		onlyIfMissing bool
	}{
		{path: []string{"$schema"}, value: gatewaySpec.schema, onlyIfMissing: true},
		{path: []string{"model"}, value: gatewaySpec.modelRef},
		{path: []string{"provider", GatewayProviderID}, value: gatewaySpec.providerValue()},
	}
	for _, write := range writes {
		current, parseErr := parseJSONC(text)
		if parseErr != nil {
			return "", fmt.Errorf("%w: %v", ErrInvalidConfig, parseErr)
		}
		if write.onlyIfMissing && hasRootKey(current, write.path[0]) {
			continue
		}
		text, err = setPath(text, write.path, write.value)
		if err != nil {
			return "", fmt.Errorf("%w: %v", ErrInvalidConfigAfterEdit, err)
		}
	}
	if _, parseErr := parseJSONC(text); parseErr != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidConfigAfterEdit, parseErr)
	}
	return ensureTrailingNewline(string(text)), nil
}

// BuildGatewayJSON 输出重排后的标准 JSON：注释与原有排版不保留，用于本来就没有
// 注释、或调用方明确要规范化的场景。
func BuildGatewayJSON(rawConfig string, gateway Gateway) (string, error) {
	gatewaySpec, err := newSpec(gateway)
	if err != nil {
		return "", err
	}
	text := []byte(rawConfig)
	if len(strings.TrimSpace(rawConfig)) == 0 {
		text = []byte("{}")
	}
	root, err := parseJSONC(text)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if err := checkDocument(text, root); err != nil {
		return "", err
	}
	decoded, err := decodeObject(text, root)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	return ensureTrailingNewline(encodeJSON(mergeDocument(decoded, gatewaySpec), "")), nil
}

// DefaultModel 从探测到的模型里挑默认型号（规则同 Node 的 opencode-gateway-default-model）：
// 家族优先级 sonnet > opus > haiku，同家族取版本号最大的。8 位日期快照只作最后平局，
// 否则 claude-sonnet-4-20250514 会压过 claude-sonnet-4-6。没有 claude 模型时取首项。
func DefaultModel(models []string) string {
	normalized := normalizeModels(models)
	if len(normalized) == 0 {
		return ""
	}
	claude := make([]string, 0, len(normalized))
	for _, id := range normalized {
		if strings.HasPrefix(id, "claude-") {
			claude = append(claude, id)
		}
	}
	if len(claude) == 0 {
		return normalized[0]
	}
	for _, family := range []string{"sonnet", "opus", "haiku"} {
		members := make([]string, 0, len(claude))
		for _, id := range claude {
			if strings.Contains(id, "-"+family) {
				members = append(members, id)
			}
		}
		if len(members) > 0 {
			return newestModel(members)
		}
	}
	return newestModel(claude)
}

// ---------------------------------------------------------------------------
// 文档校验
// ---------------------------------------------------------------------------

func checkDocument(text []byte, root node) error {
	if root.kind != '{' {
		return fmt.Errorf("%w: root must be an object", ErrInvalidConfig)
	}
	provider, found := root.lookup("provider")
	if !found {
		return nil
	}
	if provider.value.kind != '{' {
		return fmt.Errorf("%w: provider must be an object", ErrInvalidConfig)
	}
	aih, found := provider.value.lookup(GatewayProviderID)
	if !found {
		return nil
	}
	if aih.value.kind != '{' {
		return fmt.Errorf("%w: provider.aih is not an object", ErrProviderConflict)
	}
	name, found := aih.value.lookup("name")
	if !found {
		return fmt.Errorf("%w: provider.aih has no name", ErrProviderConflict)
	}
	decoded, err := decodeScalar(text, name.value)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if value, ok := decoded.(string); !ok || value != GatewayProviderName {
		return fmt.Errorf("%w: provider.aih name %v", ErrProviderConflict, decoded)
	}
	return nil
}

func hasRootKey(root node, key string) bool {
	_, found := root.lookup(key)
	return found
}

// ---------------------------------------------------------------------------
// 网关参数
// ---------------------------------------------------------------------------

type spec struct {
	schema   string
	baseURL  string
	apiKey   string
	models   []string
	modelRef string
}

func newSpec(gateway Gateway) (spec, error) {
	models := normalizeModels(gateway.Models)
	if len(models) == 0 {
		return spec{}, ErrModelsUnavailable
	}
	schema := strings.TrimSpace(gateway.SchemaURL)
	if schema == "" {
		schema = SchemaURL
	}
	apiKey := strings.TrimSpace(gateway.Server.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(gateway.Server.ClientKey)
	}
	if apiKey == "" {
		apiKey = DefaultAPIKey
	}
	return spec{
		schema:   schema,
		baseURL:  BaseURL(gateway.Server),
		apiKey:   apiKey,
		models:   models,
		modelRef: GatewayProviderID + "/" + DefaultModel(models),
	}, nil
}

func (s spec) providerValue() any {
	options := newOrderedObject()
	options.set("baseURL", s.baseURL)
	options.set("apiKey", s.apiKey)
	models := newOrderedObject()
	for _, id := range s.models {
		entry := newOrderedObject()
		entry.set("name", id+" (AIH)")
		models.set(id, entry)
	}
	provider := newOrderedObject()
	provider.set("npm", GatewayProviderNPM)
	provider.set("name", GatewayProviderName)
	provider.set("options", options)
	provider.set("models", models)
	return provider
}

// normalizeModels 去空白、去重、排序：输出必须与探测顺序无关，否则同一份目录
// 每次落点都会改文件。
func normalizeModels(models []string) []string {
	seen := make(map[string]struct{}, len(models))
	out := make([]string, 0, len(models))
	for _, raw := range models {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

var dateSnapshotPattern = regexp.MustCompile("^[0-9]{8}$")

var digitGroups = regexp.MustCompile("[0-9]+")

func newestModel(names []string) string {
	sorted := append([]string(nil), names...)
	sort.SliceStable(sorted, func(i, j int) bool {
		left, right := versionScore(sorted[i]), versionScore(sorted[j])
		for index := 0; index < 3; index++ {
			if left[index] != right[index] {
				return left[index] > right[index]
			}
		}
		return sorted[i] > sorted[j]
	})
	return sorted[0]
}

func versionScore(name string) [3]int {
	groups := digitGroups.FindAllString(name, -1)
	parts := make([]string, 0, len(groups))
	date := ""
	for _, group := range groups {
		if dateSnapshotPattern.MatchString(group) {
			if date == "" {
				date = group
			}
			continue
		}
		parts = append(parts, group)
	}
	score := [3]int{}
	for index := 0; index < 2 && index < len(parts); index++ {
		value, err := strconv.Atoi(parts[index])
		if err != nil {
			continue
		}
		score[index] = value
	}
	if date != "" {
		if value, err := strconv.Atoi(date); err == nil {
			score[2] = value
		}
	}
	return score
}

// ---------------------------------------------------------------------------
// 有序 JSON 值：map 的键序在 Go 里是随机的，配置文件必须稳定
// ---------------------------------------------------------------------------

type orderedObject struct {
	keys   []string
	values map[string]any
}

func newOrderedObject() *orderedObject {
	return &orderedObject{values: map[string]any{}}
}

func (object *orderedObject) set(key string, value any) {
	if _, exists := object.values[key]; !exists {
		object.keys = append(object.keys, key)
	}
	object.values[key] = value
}

func (object *orderedObject) get(key string) (any, bool) {
	value, found := object.values[key]
	return value, found
}

func decodeObject(text []byte, value node) (*orderedObject, error) {
	decoded, err := decodeNode(text, value)
	if err != nil {
		return nil, err
	}
	object, ok := decoded.(*orderedObject)
	if !ok {
		return nil, errors.New("root must be an object")
	}
	return object, nil
}

func decodeNode(text []byte, value node) (any, error) {
	switch value.kind {
	case '{':
		object := newOrderedObject()
		for _, item := range value.members {
			decoded, err := decodeNode(text, item.value)
			if err != nil {
				return nil, err
			}
			object.set(item.key, decoded)
		}
		return object, nil
	case '[':
		items := make([]any, 0, len(value.elems))
		for _, element := range value.elems {
			decoded, err := decodeNode(text, element)
			if err != nil {
				return nil, err
			}
			items = append(items, decoded)
		}
		return items, nil
	default:
		return decodeScalar(text, value)
	}
}

func decodeScalar(text []byte, value node) (any, error) {
	var decoded any
	if err := json.Unmarshal(text[value.start:value.end], &decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

func mergeDocument(root *orderedObject, s spec) *orderedObject {
	out := newOrderedObject()
	if schema, found := root.get("$schema"); found {
		out.set("$schema", schema)
	} else {
		out.set("$schema", s.schema)
	}
	for _, key := range root.keys {
		switch key {
		case "$schema", "model", "provider":
			continue
		}
		out.set(key, root.values[key])
	}
	out.set("model", s.modelRef)
	provider := newOrderedObject()
	if existing, found := root.get("provider"); found {
		if object, ok := existing.(*orderedObject); ok {
			for _, key := range object.keys {
				if key == GatewayProviderID {
					continue
				}
				provider.set(key, object.values[key])
			}
		}
	}
	provider.set(GatewayProviderID, s.providerValue())
	out.set("provider", provider)
	return out
}

func encodeJSON(value any, indent string) string {
	switch typed := value.(type) {
	case *orderedObject:
		if len(typed.keys) == 0 {
			return "{}"
		}
		inner := indent + "  "
		var builder strings.Builder
		builder.WriteString("{")
		for index, key := range typed.keys {
			if index > 0 {
				builder.WriteString(",")
			}
			builder.WriteString("\n")
			builder.WriteString(inner)
			builder.WriteString(quote(key))
			builder.WriteString(": ")
			builder.WriteString(encodeJSON(typed.values[key], inner))
		}
		builder.WriteString("\n")
		builder.WriteString(indent)
		builder.WriteString("}")
		return builder.String()
	case []any:
		if len(typed) == 0 {
			return "[]"
		}
		inner := indent + "  "
		var builder strings.Builder
		builder.WriteString("[")
		for index, item := range typed {
			if index > 0 {
				builder.WriteString(",")
			}
			builder.WriteString("\n")
			builder.WriteString(inner)
			builder.WriteString(encodeJSON(item, inner))
		}
		builder.WriteString("\n")
		builder.WriteString(indent)
		builder.WriteString("]")
		return builder.String()
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return "null"
		}
		return string(encoded)
	}
}

func quote(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func ensureTrailingNewline(content string) string {
	if strings.HasSuffix(content, "\n") {
		return content
	}
	return content + "\n"
}
