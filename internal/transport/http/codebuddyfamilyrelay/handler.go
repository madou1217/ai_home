package codebuddyfamilyrelay

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	// Path 与客户端 chat completions 入口一致（本通道挂在同一路径上）。
	Path = "/v1/chat/completions"
	// MaxRequestBodyBytes 与 Node 宿主默认上限一致（附件历史会放大请求体）。
	MaxRequestBodyBytes int64 = 32 * 1024 * 1024
	// DegradationHeader 把「本次改写丢了什么信息」告诉客户端（与 Node 侧同名同语义）。
	DegradationHeader = relaycore.DegradationHeader
)

// 家族通道复用 relaycore 的公开类型，保持包内 API 稳定（既有测试与调用方不必改）。
type (
	// AccountSource 按模型产出候选账号。
	AccountSource = relaycore.AccountSource
	// AccountCursor 按调度顺序逐个产出账号。
	AccountCursor = relaycore.AccountCursor
	// CredentialResolver 延迟读取并刷新目标账号凭据。
	CredentialResolver = relaycore.CredentialResolver
	// HTTPClient 是发起单个上游请求所需的最小端口。
	HTTPClient = relaycore.HTTPClient
)

// ErrInvalidDependencies 表示 Handler 缺少任一必需端口。
var ErrInvalidDependencies = relaycore.ErrInvalidDependencies

// Dependencies 集中声明家族透传的账号、凭据、传输与运行态端口。
//
// 编排逻辑整体在 relaycore.Handler；本结构保留家族特有的可注入项（补位文案、端点覆盖），
// 并把它们转成 relaycore 的 Provider 选项。
type Dependencies struct {
	// Accounts 按调度顺序提供账号；为空表示只服务钉选调用方。
	Accounts AccountSource
	// Fallback 承接透传服务不了的请求，通常是 Canonical 推理入口。
	Fallback http.Handler
	// Credentials 读取目标账号凭据。
	Credentials CredentialResolver
	// Client 发起上游请求。
	Client HTTPClient
	// Attempts 记录运行态（成功与失败都要记，否则 Go 承接的请求在仪表盘上会消失）。
	Attempts inferencegateway.AttemptRecorder
	// Clock 提供时间（可注入，便于测试）。
	Clock func() time.Time
	// DefaultSystemPrompt 覆盖补位文案；为空时用 DefaultSystemPrompt。
	DefaultSystemPrompt string
	// Endpoint 覆盖上游 URL 解析（默认 InferenceEndpoint：站点根 + /v2/chat/completions）。
	//
	// 注入点是给测试与运维用的：测试指向本地假上游；运维若要改址，只改这一处即可，
	// 不必碰常量表。
	Endpoint func(provider string) (string, bool)
	// ExtraProviders 是本入口上除家族之外的其它透传 Provider（如 cline）。
	//
	// 同一客户端入口可以挂多个透传 Provider：它们各自服务自己那批账号。链按账号
	// 所属 Provider 分派差异面，账号来源由调用方合并（见 relaycore.AccountSourceChain）。
	ExtraProviders []relaycore.Provider
}

// Handler 是家族透传通道。
//
// 它不再自己编排：账号选择、请求改写、上游透传、响应回写、尝试记账、换号判定全部由
// relaycore.Handler 承载（对所有同协议透传通道一致）。家族与「朴素 OpenAI 端点」的
// 差异全部在 provider.go 里，本结构只负责把家族的可注入项接到 relaycore 上。
type Handler struct {
	inner *relaycore.Handler
}

// NewHandler 创建默认失败关闭的家族透传通道。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	provider := NewProvider(ProviderOptions{
		// 通道级 Provider 不绑定具体支：四支的差异由 Resolve 按账号决定。
		ProviderID:          FamilyProviders[0],
		DefaultSystemPrompt: dependencies.DefaultSystemPrompt,
		Endpoint:            dependencies.Endpoint,
	})
	// 同一入口上可能还挂着别的透传 Provider（如 cline）：链按账号所属 Provider 分派。
	members := append([]relaycore.Provider{provider}, dependencies.ExtraProviders...)
	inner, err := relaycore.NewHandler(relaycore.Dependencies{
		Provider:    relaycore.NewProviderChain(members...),
		Path:        Path,
		Accounts:    dependencies.Accounts,
		Fallback:    dependencies.Fallback,
		Credentials: dependencies.Credentials,
		Client:      dependencies.Client,
		Attempts:    dependencies.Attempts,
		Clock:       dependencies.Clock,
		// 家族四支共用同一份上游约束，请求体上限与 Node 宿主默认一致。
		MaxRequestBodyBytes: MaxRequestBodyBytes,
		UnavailableMessage:  "家族透传当前不可用",
	})
	if err != nil {
		return nil, err
	}
	return &Handler{inner: inner}, nil
}

// ServeHTTP 把请求交给 relaycore 编排骨架。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.inner == nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_unavailable",
			"家族透传当前不可用",
		)
		return
	}
	handler.inner.ServeHTTP(response, request)
}

// relayContractSatisfied 静默判断请求能否走透传（不写响应）。
//
// 保留本函数是为了让既有测试与包内调用方的 API 不变；判定逻辑与 relaycore 一致。
func relayContractSatisfied(request *http.Request) bool {
	if request == nil || request.URL == nil || request.URL.Path != Path {
		return false
	}
	if request.Method != http.MethodPost {
		return false
	}
	if request.Body == nil || request.ContentLength <= 0 || request.ContentLength > MaxRequestBodyBytes {
		return false
	}
	mediaType := strings.TrimSpace(request.Header.Get("Content-Type"))
	return mediaType == "" || strings.HasPrefix(mediaType, "application/json")
}

// writeRelayError 写网关自有错误（OpenAI 错误体形态，与客户端协议一致）。
func writeRelayError(response http.ResponseWriter, status int, code string, message string) {
	relaycore.WriteRelayError(response, status, code, message)
}

// 包内别名：编排已迁到 relaycore，这些名字保留给既有测试与包内调用方。
//
// errNoRelayAccount 与 singleAccountCursor 是 relaycore 内部的等价物在家族包的可见名，
// 供 handler 测试直接构造替身；语义与 relaycore 完全一致。
var errNoRelayAccount = errors.New("没有可用于家族透传的账号")

// singleAccountCursor 只产出一个账号，之后即耗尽。
type singleAccountCursor struct {
	accountRef accountcore.AccountRef
	consumed   bool
}

func (cursor *singleAccountCursor) Next(_ context.Context) (accountcore.AccountRef, bool, error) {
	if cursor == nil || cursor.consumed {
		return "", false, nil
	}
	cursor.consumed = true
	return cursor.accountRef, true, nil
}
