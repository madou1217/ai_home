// Package modelcatalog 通过 qoder 的模型目录接口发现账号可见模型。
//
// 协议事实（与 Node lib/account/qoder-model-catalog.js 同口径，2026-10-21 真机取证）：
//   - GET {base}/api/v2/model/list?Encode=1，base 为 openapi.qoder.sh（国内站
//     openapi.qoder.com.cn）；
//   - 请求必须由客户端 wasm 签名：newContext(machineId, cliVersion, 登录态明文)
//     + prepareRequest(endpoint, path, "GET", "auth") 产出完整 URL 与 18 个签名头；
//   - 响应通常是明文 JSON（content-type application/json），被编码时才用
//     decrypt_server_response；
//   - 目录按 scene 分组（默认 assistant），条目里的 is_reasoning/is_vl/
//     max_input_tokens 只能从服务端目录读，不能按模型名猜。
//
// 本包只输出模型展示名（与 Node 的 discover().models 一致，也是 aih 账号页与
// account_models 里的既有形态）。
package modelcatalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
)

const (
	// modelsPath 与 Node QODER_MODEL_LIST 同值；Encode=1 让服务端按客户端编码返回。
	modelsPath = "/api/v2/model/list?Encode=1"
	// defaultScene 与 Node QODER_MODEL_CATALOG.defaultScene 同值。
	defaultScene = "assistant"
	// defaultMaxInputTokens 是目录没给 max_input_tokens 时的客户端兜底。
	defaultMaxInputTokens = 200000
	maxResponseBytes      = 2 << 20
	requestTimeout        = 15 * time.Second
)

// accountBases 与 Node QODER_ACCOUNT_BASES 同源。
var accountBases = map[string]string{
	"qoder":   "https://openapi.qoder.sh",
	"qodercn": "https://openapi.qoder.com.cn",
}

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Signer 是签名运行时需要的能力；抽成接口是为了让单测不依赖本机 CLI。
type Signer interface {
	NewContext(ctx context.Context, machineID, version, userInfoJSON string) (uint32, error)
	PrepareRequest(ctx context.Context, contextID uint32, endpoint, path, method, mode string) (qodercred.PreparedRequest, error)
	DecryptServerResponse(ctx context.Context, cipherText string) (string, error)
	FreeContext(contextID uint32)
	Close(ctx context.Context)
}

// newSigner 是生产实现；测试里替换成假实现。
var newSigner = func(provider string) (Signer, error) {
	return qodercred.NewSigningRuntime(provider, qodercred.Options{})
}

// decryptNative 是 opaque 凭据解密入口；测试里替换成固定明文。
var decryptNative = qodercred.DecryptNativeRaw

// resolveVersion 读取客户端版本；测试里替换成固定值。
var resolveVersion = qodercred.CLIVersion

// Entry 是目录条目的完整事实（推理请求的 model_config 只能从这里派生）。
type Entry struct {
	Key            string
	DisplayName    string
	Format         string
	Source         string
	IsVl           bool
	IsReasoning    bool
	IsDefault      bool
	MaxInputTokens int
	ThinkingConfig map[string]any
}

// Source 是 qoder / qodercn 的模型发现策略。
type Source struct {
	client     HTTPClient
	providerID string
	baseURL    string
}

var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

var (
	// ErrInvalidDependencies 表示缺少 HTTP 传输或 Provider 未登记。
	ErrInvalidDependencies = errors.New("qoder 模型目录源依赖无效")
	// ErrUnsupportedCredential 表示凭据不是 qoder 原生登录态。
	ErrUnsupportedCredential = errors.New("qoder 模型目录源凭据形态不支持")
	// ErrEmptyCatalog 表示上游返回了空目录。
	ErrEmptyCatalog = errors.New("qoder 模型目录为空")
)

// New 创建指定区域 Provider 的目录源。
func New(client HTTPClient, providerID string) (*Source, error) {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	baseURL := accountBases[normalized]
	if client == nil || baseURL == "" {
		return nil, ErrInvalidDependencies
	}
	return &Source{client: client, providerID: normalized, baseURL: baseURL}, nil
}

// ProviderID 返回构造时登记的 Provider。
func (source *Source) ProviderID() string { return source.providerID }

// DiscoverModels 读取账号当前可见的模型展示名。
func (source *Source) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	entries, err := source.Entries(ctx, credential)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		key := strings.ToLower(entry.DisplayName)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		names = append(names, entry.DisplayName)
	}
	if len(names) == 0 {
		return nil, ErrEmptyCatalog
	}
	return names, nil
}

// Entries 读取账号可见的完整目录条目（推理请求要用 is_reasoning / max_input_tokens 等）。
func (source *Source) Entries(
	ctx context.Context,
	credential accountapp.Credential,
) ([]Entry, error) {
	if source == nil || source.client == nil || ctx == nil || credential == nil {
		return nil, ErrInvalidDependencies
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != source.providerID {
		return nil, ErrUnsupportedCredential
	}
	var payload map[string]any
	if err := json.Unmarshal(native.Payload(), &payload); err != nil || payload == nil {
		return nil, ErrUnsupportedCredential
	}
	plaintext, ok := decryptNative(source.providerID, payload, qodercred.Options{})
	if !ok {
		return nil, ErrUnsupportedCredential
	}
	machineID := text(payload["machineId"])
	version := resolveVersion(source.providerID, qodercred.Options{})
	if machineID == "" || version == "" {
		return nil, ErrUnsupportedCredential
	}
	signer, err := newSigner(source.providerID)
	if err != nil {
		return nil, err
	}
	defer signer.Close(context.Background())
	contextID, err := signer.NewContext(ctx, machineID, version, plaintext)
	if err != nil {
		return nil, err
	}
	defer signer.FreeContext(contextID)
	prepared, err := signer.PrepareRequest(ctx, contextID, source.baseURL, modelsPath, http.MethodGet, "auth")
	if err != nil {
		return nil, err
	}
	body, err := source.fetch(ctx, prepared)
	if err != nil {
		return nil, err
	}
	catalog, err := decodeCatalog(body, func(cipherText string) (string, error) {
		return signer.DecryptServerResponse(ctx, cipherText)
	})
	if err != nil {
		return nil, err
	}
	entries := normalizeEntries(catalog, defaultScene)
	if len(entries) == 0 {
		return nil, ErrEmptyCatalog
	}
	storeCachedEntries(cacheKey(source.providerID, payload), entries)
	return entries, nil
}

// entriesCache 让推理 relay 能在请求热路径上同步拿到目录条目。
//
// 目录发现是异步 HTTP，而 relay 的 RewriteRequest 是同步的；进程内缓存由周期刷新
// 填充，冷启动时 relay 直接 fail-closed 交还 Node，等下一轮刷新后自然接管。
var (
	entriesCacheMu sync.RWMutex
	entriesCache   = map[string][]Entry{}
)

// CachedEntries 返回最近一次成功发现缓存下来的条目。
func CachedEntries(providerID string, native map[string]any) ([]Entry, bool) {
	entriesCacheMu.RLock()
	defer entriesCacheMu.RUnlock()
	entries, ok := entriesCache[cacheKey(providerID, native)]
	return entries, ok
}

func storeCachedEntries(key string, entries []Entry) {
	entriesCacheMu.Lock()
	defer entriesCacheMu.Unlock()
	if len(entriesCache) > 64 {
		entriesCache = map[string][]Entry{}
	}
	entriesCache[key] = entries
}

func cacheKey(providerID string, native map[string]any) string {
	digest := sha256.Sum256([]byte(providerID + "\x00" + text(native["credentials"]) + "\x00" + text(native["machineId"])))
	return hex.EncodeToString(digest[:])
}

// fetch 用签名后的 URL 与请求头发一次 GET。
func (source *Source) fetch(ctx context.Context, prepared qodercred.PreparedRequest) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, prepared.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrEmptyCatalog, err)
	}
	for name, value := range prepared.Headers {
		// Host 由 net/http 自己写；wasm 产出的 Host 头与 URL 一致，重复设置会被拒。
		if strings.EqualFold(name, "host") {
			continue
		}
		request.Header.Set(name, value)
	}
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json")
	}
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	if response == nil || response.Body == nil {
		return nil, ErrEmptyCatalog
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return nil, fmt.Errorf("%w: HTTP %d", ErrEmptyCatalog, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) == 0 || len(body) > maxResponseBytes {
		return nil, ErrEmptyCatalog
	}
	return body, nil
}

// decodeCatalog 先按明文 JSON 解析，失败再尝试 wasm 解密（与 Node 顺序一致）。
func decodeCatalog(data []byte, decrypt func(string) (string, error)) (map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err == nil && payload != nil {
		return payload, nil
	}
	plaintext, err := decrypt(string(data))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(plaintext), &payload); err != nil || payload == nil {
		return nil, ErrEmptyCatalog
	}
	return payload, nil
}

// catalogEntry 是目录条目里发现阶段真正需要的字段。
type catalogEntry struct {
	Key         string
	DisplayName string
}

// normalizeEntries 复刻 Node normalizeCatalogEntry 的字段与过滤规则。
func normalizeEntries(payload map[string]any, scene string) []Entry {
	raw := payload[scene]
	if raw == nil {
		raw = payload[defaultScene]
	}
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	entries := make([]Entry, 0, len(items))
	for _, item := range items {
		entry, ok := normalizeEntry(item)
		if !ok {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

// normalizeNames 复刻 Node normalizeCatalogEntry 的过滤与展示名规则。
func normalizeNames(payload map[string]any, scene string) []string {
	raw := payload[scene]
	if raw == nil {
		raw = payload[defaultScene]
	}
	entries, ok := raw.([]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, item := range entries {
		entry, ok := normalizeEntry(item)
		if !ok {
			continue
		}
		// 展示名重复时保留第一条（与 Node buildCatalogIndex 的 first-wins 一致）。
		key := strings.ToLower(entry.DisplayName)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		names = append(names, entry.DisplayName)
	}
	return names
}

// normalizeEntry 按 Node normalizeCatalogEntry 的默认值与顺序归一化。
func normalizeEntry(raw any) (Entry, bool) {
	object, ok := raw.(map[string]any)
	if !ok {
		return Entry{}, false
	}
	key := text(object["key"])
	if key == "" {
		return Entry{}, false
	}
	entry := Entry{
		Key:         key,
		DisplayName: text(object["display_name"]),
		Format:      text(object["format"]),
		Source:      text(object["source"]),
		// 客户端默认值：缺省 false（Node 侧是 ?? false），不是 true。
		IsVl:           object["is_vl"] == true,
		IsReasoning:    object["is_reasoning"] == true,
		IsDefault:      object["is_default"] == true,
		MaxInputTokens: positiveInt(object["max_input_tokens"]),
	}
	if entry.DisplayName == "" {
		entry.DisplayName = key
	}
	if entry.Format == "" {
		entry.Format = "openai"
	}
	if entry.Source == "" {
		entry.Source = "system"
	}
	if entry.MaxInputTokens == 0 {
		entry.MaxInputTokens = defaultMaxInputTokens
	}
	if thinking, ok := object["thinking_config"].(map[string]any); ok {
		entry.ThinkingConfig = thinking
	}
	return entry, true
}

func positiveInt(value any) int {
	switch typed := value.(type) {
	case float64:
		if typed > 0 {
			return int(typed)
		}
	case int:
		if typed > 0 {
			return typed
		}
	case json.Number:
		if parsed, err := typed.Int64(); err == nil && parsed > 0 {
			return int(parsed)
		}
	}
	return 0
}

func text(value any) string {
	if typed, ok := value.(string); ok {
		return strings.TrimSpace(typed)
	}
	return ""
}
