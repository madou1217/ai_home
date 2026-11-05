// Package qoderrelay 实现 qoder / qodercn 的推理透传通道（HTTP SSE）。
//
// 与其它透传 Provider 的差别是「线协议完全由客户端 wasm 决定」：
//   - body 先由 BuildBody 构造客户端 JSON，再交给 wasm 的 prepareInferRequest 改写成
//     自定义编码串，最后 zstd(level 1) 压缩并带 Content-Encoding: zstd 发出；
//   - URL 与 20 个签名头也由 wasm 产出，静态端点表达不了；
//   - 上游 SSE 是信封 {body:"<OpenAI chunk>"}，需要拆包后再交给客户端。
//
// 因此本 Provider 需要 relaycore.ResponseTransformer 扩展点，且请求级状态（签名后的
// URL/头/压缩体）保存在 Resolve 新建的实例上——每次尝试一个实例，不跨请求共享。
package qoderrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
	"github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	// QoderProviderID 与 QoderCNProviderID 是本通道服务的两个 Provider。
	QoderProviderID   = "qoder"
	QoderCNProviderID = "qodercn"
	// modelSource 与 Node 的 signQoderRequest 入参同值。
	modelSource = "system"
	// aggregateLimit 是非流式聚合的上限（模型目录之外的单次回答不应超过它）。
	aggregateLimit = 8 << 20
)

var (
	// ErrModelCatalogUnavailable 表示进程内还没有该账号的目录缓存：fail-closed 交还
	// Canonical/Node，等下一轮模型刷新填充后再接管。
	ErrModelCatalogUnavailable = errors.New("qoder 模型目录缓存不可用")
	// ErrUnsupportedCredential 表示凭据不是 qoder 原生登录态。
	ErrUnsupportedCredential = errors.New("qoder relay 凭据形态不支持")
)

// inferenceBases 是**推理**端点默认值（与 Node 布局表的 endpoints.inference 同源）。
//
// 注意与账号面 openapi.qoder.sh 区分：推理走 api3.qoder.sh / gateway.qoder.com.cn，
// 用错主机上游会直接 500（2026-11-05 实测）。
var inferenceBases = map[string]string{
	QoderProviderID:   "https://api3.qoder.sh",
	QoderCNProviderID: "https://gateway.qoder.com.cn",
}

// clientDirs 是各区域的客户端家目录（端点缓存放在 <home>/<dir>/.cache）。
var clientDirs = map[string]string{
	QoderProviderID:   ".qoder",
	QoderCNProviderID: ".qoder-cn",
}

// readUMID 读取客户端缓存的真实设备令牌。
//
// wasm 只给 36 字符占位 + "5"，抓包里是 88 字符 token；不覆盖时上游直接 500
// （2026-11-05 实测）。缺失时返回空，让请求按 wasm 占位发出（会失败，但不伪造）。
func readUMID(providerID string) (machineToken, machineType string) {
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		if userHome, err := os.UserHomeDir(); err == nil {
			home = strings.TrimSpace(userHome)
		}
	}
	if home == "" {
		return "", ""
	}
	data, err := os.ReadFile(filepath.Join(home, clientDirs[providerID], "umid-cache.json"))
	if err != nil {
		return "", ""
	}
	var cache map[string]any
	if json.Unmarshal(data, &cache) != nil {
		return "", ""
	}
	info, ok := cache["info"].(map[string]any)
	if !ok {
		return "", ""
	}
	token, _ := info["machineToken"].(string)
	machine, _ := info["machineType"].(string)
	return strings.TrimSpace(token), strings.TrimSpace(machine)
}

// resolveInferenceEndpoint 复刻 Node resolveQoderHttpEndpoint：客户端端点缓存优先，
// 缺失时用布局默认值。
func resolveInferenceEndpoint(providerID string) string {
	fallback := inferenceBases[providerID]
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		if userHome, err := os.UserHomeDir(); err == nil {
			home = strings.TrimSpace(userHome)
		}
	}
	if home == "" {
		return fallback
	}
	path := filepath.Join(home, clientDirs[providerID], ".cache", "qoder-client-endpoint-cache.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	var cache map[string]any
	if json.Unmarshal(data, &cache) != nil {
		return fallback
	}
	entries, ok := cache["entries"].(map[string]any)
	if !ok {
		return fallback
	}
	prod, ok := entries["prod"].(map[string]any)
	if !ok {
		return fallback
	}
	process, ok := prod["endpointSets"].(map[string]any)
	if !ok {
		return fallback
	}
	inference, ok := process["inference"].(map[string]any)
	if !ok {
		return fallback
	}
	selected, _ := inference["selected"].(string)
	selected = strings.TrimSpace(selected)
	if !strings.HasPrefix(selected, "https://") {
		return fallback
	}
	return strings.TrimRight(selected, "/")
}

// Signer 是签名运行时需要的能力；抽成接口让单测不依赖本机 CLI/wasm。
type Signer interface {
	NewContext(ctx context.Context, machineID, version, userInfoJSON string) (uint32, error)
	PrepareInferRequest(
		ctx context.Context,
		contextID uint32,
		endpoint, bodyJSON, modelKey, modelSource string,
	) (qodercred.PreparedRequest, error)
	FreeContext(contextID uint32)
}

// EntriesLoader 在进程内目录缓存缺失时按凭据现算条目。
//
// 目录缓存的写入方是模型发现（DiscoverModels → Entries）；进程刚启动、或刷新遇到
// SQLITE_BUSY 时缓存可能是空的。此时 relay 不能直接判客户端请求无效。
type EntriesLoader func(providerID string, credential accountapp.Credential) ([]modelcatalog.Entry, error)

// loadEntries 由组合根注入；nil 表示只读缓存（测试默认）。
var loadEntries EntriesLoader

// SetEntriesLoader 注入按需加载器（组合根调用一次）。
func SetEntriesLoader(loader EntriesLoader) { loadEntries = loader }

var (
	signerMu    sync.Mutex
	signerCache = map[string]Signer{}
	// 下面三个在测试里替换，避免单测依赖本机 CLI / wasm / 目录缓存。
	newSigner = func(providerID string) (Signer, error) {
		return qodercred.NewSigningRuntime(providerID, qodercred.Options{})
	}
	cachedEntries = modelcatalog.CachedEntries
	decryptNative = qodercred.DecryptNativeRaw
	cliVersion    = qodercred.CLIVersion
)

// signerFor 复用进程内签名运行时：wasm 编译只发生一次，上下文按请求新建。
func signerFor(providerID string) (Signer, error) {
	signerMu.Lock()
	defer signerMu.Unlock()
	if signer, ok := signerCache[providerID]; ok {
		return signer, nil
	}
	signer, err := newSigner(providerID)
	if err != nil {
		return nil, err
	}
	signerCache[providerID] = signer
	return signer, nil
}

// Provider 是 qoder 在 relaycore 上的实现（每次 Resolve 一个请求级实例）。
type Provider struct {
	relaycore.BaseProvider
	providerID string
	credential accountapp.Credential
	// 以下是 RewriteRequest 产出、Endpoint/DecorateUpstream 消费的请求级状态。
	url          string
	headers      map[string]string
	compressed   []byte
	requestModel string
}

var _ relaycore.Provider = (*Provider)(nil)
var _ relaycore.ResponseTransformer = (*Provider)(nil)

// NewProvider 构造通道根实例；实际请求由 Resolve 派生。
func NewProvider() *Provider {
	return &Provider{BaseProvider: relaycore.NewBaseProvider(QoderProviderID, "")}
}

// Resolve 认领 qoder / qodercn，并绑定本次请求的凭据。
func (provider *Provider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	providerID := strings.ToLower(strings.TrimSpace(input.ProviderID))
	if _, ok := inferenceBases[providerID]; !ok {
		return nil, false
	}
	// Resolve 也被能力判定（servesProvider）调用，那里没有凭据；凭据缺失要等到
	// RewriteRequest 才拒绝，否则能力判定会误判成「本通道不服务 qoder」。
	return &Provider{
		BaseProvider: relaycore.NewBaseProvider(providerID, ""),
		providerID:   providerID,
		credential:   input.Credential,
	}, true
}

// AccessToken 返回空串：qoder 的鉴权头由 wasm 签名产出，不走 Bearer 令牌。
func (*Provider) AccessToken(accountapp.Credential) (string, error) {
	return "", nil
}

// RewriteRequest 构造并签名推理请求，把 zstd 压缩体交给 Handler 发送。
func (provider *Provider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	native, ok := provider.credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return relaycore.RewriteResult{}, ErrUnsupportedCredential
	}
	var payload map[string]any
	if err := json.Unmarshal(native.Payload(), &payload); err != nil || payload == nil {
		return relaycore.RewriteResult{}, ErrUnsupportedCredential
	}
	entries, ok := cachedEntries(provider.providerID, payload)
	if (!ok || len(entries) == 0) && loadEntries != nil {
		// 冷启动/目录刷新失败（例如 SQLITE_BUSY）时缓存为空：按凭据现算一次，
		// 不能把「目录还没准备好」当成客户端的 invalid_relay_request。
		if loaded, err := loadEntries(provider.providerID, provider.credential); err == nil && len(loaded) > 0 {
			entries, ok = loaded, true
		}
	}
	if !ok || len(entries) == 0 {
		return relaycore.RewriteResult{}, ErrModelCatalogUnavailable
	}
	requestedModel := readModel(body)
	entry, ok := resolveEntry(entries, requestedModel, provider.providerID)
	if !ok {
		return relaycore.RewriteResult{}, ErrModelNotInCatalog
	}
	version := cliVersion(provider.providerID, qodercred.Options{})
	if version == "" {
		return relaycore.RewriteResult{}, ErrUnsupportedCredential
	}
	plaintext, ok := decryptNative(provider.providerID, payload, qodercred.Options{})
	if !ok {
		return relaycore.RewriteResult{}, ErrUnsupportedCredential
	}
	machineID := strings.TrimSpace(textValue(payload["machineId"]))
	if machineID == "" {
		return relaycore.RewriteResult{}, ErrUnsupportedCredential
	}
	build, err := BuildBody(body, entry, requestedModel, provider.providerID, version, time.Now().UnixMilli())
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	signer, err := signerFor(provider.providerID)
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	ctx := context.Background()
	contextID, err := signer.NewContext(ctx, machineID, version, plaintext)
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	defer signer.FreeContext(contextID)
	prepared, err := signer.PrepareInferRequest(
		ctx, contextID, resolveInferenceEndpoint(provider.providerID), string(build.Body), build.ModelKey, modelSource,
	)
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	if token, machineType := readUMID(provider.providerID); token != "" && machineType != "" {
		prepared.Headers["Cosy-MachineToken"] = token
		prepared.Headers["Cosy-MachineType"] = machineType
	}
	compressed, err := compressBody(prepared.Body)
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	provider.url = prepared.URL
	provider.headers = prepared.Headers
	provider.compressed = compressed
	provider.requestModel = requestedModel
	return relaycore.RewriteResult{Body: compressed}, nil
}

// Endpoint 返回 wasm 签出的完整 URL。
func (provider *Provider) Endpoint() (string, bool) {
	if provider.url == "" {
		return "", false
	}
	return provider.url, true
}

// DecorateUpstream 写签名头与 zstd 编码头。
func (provider *Provider) DecorateUpstream(request *http.Request, _ string) {
	if request == nil {
		return
	}
	for name, value := range provider.headers {
		if strings.EqualFold(name, "host") || strings.EqualFold(name, "content-length") {
			continue
		}
		request.Header.Set(name, value)
	}
	request.Header.Set("Content-Encoding", "zstd")
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "text/event-stream")
	}
	if request.Header.Get("Content-Type") == "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.ContentLength = int64(len(provider.compressed))
}

// TransformResponse 拆掉 qoder 的 SSE 信封并交付给客户端。
func (provider *Provider) TransformResponse(
	response http.ResponseWriter,
	upstream *http.Response,
	streaming bool,
) (bool, error) {
	if upstream == nil {
		return false, nil
	}
	// 非 2xx 的错误正文不是 SSE（真实 4xx/5xx 是 JSON 错误体）：交给 Handler 原样转发，
	// 否则拆包会把整段正文丢掉，客户端只看到状态码 + 空 body。
	if upstream.StatusCode < http.StatusOK || upstream.StatusCode >= http.StatusMultipleChoices {
		return false, nil
	}
	if streaming {
		response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		response.Header().Del("Content-Length")
		response.WriteHeader(upstream.StatusCode)
		return true, TransformSSE(context.Background(), upstream.Body, response, provider.requestModel)
	}
	var buffer bytes.Buffer
	if err := TransformSSE(
		context.Background(),
		io.LimitReader(upstream.Body, aggregateLimit),
		&buffer,
		provider.requestModel,
	); err != nil {
		return true, err
	}
	aggregated := relaycore.AggregateSSE(buffer.Bytes(), relaycore.AggregateOptions{Clock: time.Now})
	if len(aggregated.Payload) == 0 {
		return true, errors.New("qoder 上游响应为空")
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(upstream.StatusCode)
	_, _ = response.Write(aggregated.Payload)
	return true, nil
}

// UpstreamStatusCode 实现 relaycore 的上游错误契约。
func (err *StreamError) UpstreamStatusCode() int { return err.StatusCode }

// UpstreamErrorCode 实现 relaycore 的上游错误契约。
func (err *StreamError) UpstreamErrorCode() string { return err.Code }

// compressBody 用 zstd level 1 压缩（与官方客户端一致）。
func compressBody(body string) ([]byte, error) {
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedFastest))
	if err != nil {
		return nil, err
	}
	defer encoder.Close()
	return encoder.EncodeAll([]byte(body), nil), nil
}

// resolveEntry 按 Node resolveQoderCatalogModel 的口径选目录条目：
// 空/auto/default/provider 名 → Auto；其余必须命中 key 或 display_name。
func resolveEntry(entries []modelcatalog.Entry, requestedModel, providerID string) (modelcatalog.Entry, bool) {
	name := strings.TrimSpace(requestedModel)
	if index := strings.Index(name, "/"); index >= 0 {
		name = strings.TrimSpace(name[index+1:])
	}
	lower := strings.ToLower(name)
	if lower == "" || lower == "auto" || lower == "default" || lower == strings.ToLower(providerID) {
		for _, entry := range entries {
			if strings.EqualFold(entry.Key, "auto") {
				return entry, true
			}
		}
		return modelcatalog.Entry{}, false
	}
	for _, entry := range entries {
		if strings.EqualFold(entry.Key, name) || strings.EqualFold(entry.DisplayName, name) {
			return entry, true
		}
	}
	return modelcatalog.Entry{}, false
}

func readModel(body []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		return ""
	}
	var model string
	_ = json.Unmarshal(fields["model"], &model)
	return model
}

func textValue(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	return ""
}
