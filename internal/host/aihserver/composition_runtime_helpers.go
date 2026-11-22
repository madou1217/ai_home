package aihserver

import (
	"context"
	"fmt"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatapi"
	"io"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

func newWebUIChatHandler(dependencies webuichatapi.Dependencies) (http.Handler, error) {
	dependencies.PathPrefix = webuichatapi.ManagementCollectionPath
	return webuichatapi.NewHandler(dependencies)
}

// newModelRefreshObserver 记录账号模型异步刷新失败的低敏事实。
//
// 单账号刷新失败会保留旧目录并按退避静默重试，路由目录因此可能长期冻结：上游新增
// 模型后该账号仍然不可路由，而请求在选号阶段就失败、不会触发按账号的纠错刷新。这条
// 日志是唯一能看见「哪个账号、因为什么刷新不上去」的线索，必须显式落盘。
//
// 协调器对失败账号按不超过 1 分钟的退避重试，最多 modelRefreshMaxAttempts 次后放弃；
// 未节流时单个坏账号仍会写出大量日志，这里按账号节流，首次失败立即可见，成功后清除
// 节流使下次失败重新可见。放弃是终态，单独记录并清掉节流，避免「静默放弃」。
func newModelRefreshObserver(logger *log.Logger) accountapp.ModelRefreshObserver {
	if logger == nil {
		return nil
	}
	var mu sync.Mutex
	lastLogged := make(map[accountcore.AccountRef]time.Time)
	return func(result accountapp.ModelRefreshResult) {
		if result.Err == nil {
			mu.Lock()
			delete(lastLogged, result.AccountRef)
			mu.Unlock()
			return
		}
		now := time.Now()
		mu.Lock()
		if result.Exhausted || result.NonRetryable {
			delete(lastLogged, result.AccountRef)
		} else {
			previous, seen := lastLogged[result.AccountRef]
			if seen && now.Sub(previous) < modelRefreshFailureLogInterval {
				mu.Unlock()
				return
			}
			lastLogged[result.AccountRef] = now
		}
		mu.Unlock()
		if result.NonRetryable {
			logger.Printf(
				"账号模型刷新停止本轮重试: provider=%s account=%s attempts=%d err=%v（认证被拒绝，后续凭据更新或外部重扫可再探测）",
				result.ProviderID, result.AccountRef, result.Attempts, result.Err,
			)
			return
		}
		if result.Exhausted {
			logger.Printf(
				"账号模型刷新放弃: provider=%s account=%s attempts=%d err=%v（等待下次周期重扫）",
				result.ProviderID,
				result.AccountRef,
				result.Attempts,
				result.Err,
			)
			return
		}
		logger.Printf(
			"账号模型刷新失败: provider=%s account=%s err=%v",
			result.ProviderID,
			result.AccountRef,
			result.Err,
		)
	}
}

// newClaudeUpstreamDecodeErrorObserver 只记录上游事件类型、字段形状和状态机位置。
func newClaudeUpstreamDecodeErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("%v", err)
	}
}

// newMessagesDecodeErrorObserver 只记录 Decoder 已脱敏的错误类别和字段路径。
func newMessagesDecodeErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("Anthropic Messages decode rejected: %v", err)
	}
}

// persistErrorObserver 把账号模型 cooldown 的持久化失败写进 ErrorLog。
//
// 写失败不会让请求失败（cooldown 在本进程内已生效），所以这条日志是唯一能看见
// 「重启后会丢掉冷却」的线索，必须显式落盘而不是静默吞掉。
func persistErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("账号模型冷却持久化失败: %v", err)
	}
}

// newRelayDisconnectObserver 记录 Claude relay 流中途断开（上游或客户端一侧）。
//
// 上游中途断开时访问日志仍是 200，客户端却报 "Connection lost mid-response"；
// 这条日志是区分代理/网络链路断开与客户端断开的唯一线索。
func newRelayDisconnectObserver(logger *log.Logger) func(claudenativerelay.StreamDisconnect) {
	if logger == nil {
		return nil
	}
	return func(event claudenativerelay.StreamDisconnect) {
		logger.Printf(
			"Claude relay stream disconnected mid-response: side=%s model=%s account=%s elapsed=%s error=%q",
			event.Side,
			event.Model,
			event.AccountRef,
			event.Elapsed.Round(time.Millisecond),
			event.Error,
		)
	}
}

// newCodexRejectionObserver 记录上游拒绝请求参数的低敏诊断（不含请求体与凭据）。
//
// 客户端只收到"上游拒绝当前请求参数"，这条日志是定位编码与上游合同差异的唯一线索。
func newCodexRejectionObserver(logger *log.Logger) func(codexresponses.UpstreamRejection) {
	if logger == nil {
		return nil
	}
	return func(rejection codexresponses.UpstreamRejection) {
		logger.Printf(
			"Codex upstream rejected request: model=%s status=%d type=%q code=%q param=%q message=%q",
			rejection.Model,
			rejection.StatusCode,
			rejection.Type,
			rejection.Code,
			rejection.Param,
			rejection.Message,
		)
	}
}

// newResponsesDecodeErrorObserver 只记录 Decoder 已脱敏的错误类别和字段路径。
//
// 被拒收的请求会由 Node 宿主接手，这条日志是 Go 协议覆盖缺口的唯一清单。
func newResponsesDecodeErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("OpenAI Responses decode rejected: %v", err)
	}
}

// modelRefreshProviderConcurrency 按已装配的模型发现策略声明刷新队列。
//
// 队列必须与发现策略同源：只写在发现注册表里、没有队列的 Provider 永远不会被
// 周期重扫（静默失效：账号在池里、模型目录一直为空）。
//
// Canonical 三支各一条队列；家族四支的刷新形态是同一个 HTTP 目录端点
// （internal/adapters/codebuddyfamily/modelcatalog），同样各占一条、并发 1。
// 漏登记的代价是静默的：账号不会被扫描/首次恢复刷新，模型目录永远为空。
func modelRefreshProviderConcurrency(providerIDs []string) map[string]int {
	concurrency := make(map[string]int, len(providerIDs)+3)
	// 透传通道服务的 Provider 即使暂时没有发现策略也要有队列（目录可能由别名/投影补）。
	for _, providerID := range relayProviderIDs() {
		concurrency[providerID] = modelRefreshConcurrency
	}
	for _, providerID := range providerIDs {
		concurrency[providerID] = modelRefreshConcurrency
	}
	return concurrency
}

func descriptorMapSlice(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return typed
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if entry, ok := item.(map[string]any); ok {
				out = append(out, entry)
			}
		}
		return out
	default:
		return nil
	}
}

func descriptorStringSlice(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, fmt.Sprint(item))
		}
		return out
	default:
		return nil
	}
}

// newModelDiscovery 创建生产模型目录源（见 model_providers.go 注册表），
// 或使用测试显式注入的策略。
func newModelDiscovery(
	catalog *providers.Catalog,
	injected []accountapp.ProviderModelDiscoverer,
	codexVersions clientversion.Source,
	agyModelWires agycodeassist.ModelWireWriter,
	modalityRegistrar modelmetadata.ModelDescriptorRegistrar,
	aiHomeDir string,
) (*accountapp.ModelDiscovery, error) {
	strategies := injected
	if len(strategies) == 0 {
		client := &http.Client{
			Timeout:       modelCatalogHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
		built, err := buildModelProviderSources(modelProviderContext{
			client:            client,
			codexVersions:     codexVersions,
			agyModelWires:     agyModelWires,
			modalityRegistrar: modalityRegistrar,
			aiHomeDir:         aiHomeDir,
		})
		if err != nil {
			return nil, err
		}
		strategies = built
	}
	discovery, err := accountapp.NewModelDiscovery(catalog, strategies)
	if err != nil {
		return nil, fmt.Errorf("创建账号模型发现注册表失败: %w", err)
	}
	return discovery, nil
}

// rejectOAuthRedirect 防止 Token 或 Profile 请求被重定向到未审计主机。
func rejectOAuthRedirect(
	_ *http.Request,
	_ []*http.Request,
) error {
	return http.ErrUseLastResponse
}

type cancelCloserFunc context.CancelFunc

func (fn cancelCloserFunc) Close() error {
	if fn != nil {
		fn()
	}
	return nil
}

func startChatRuntimePrewarm(ctx context.Context, svc *chatruntime.Service) io.Closer {
	if svc == nil {
		return nil
	}
	prewarmCtx, cancel := context.WithCancel(ctx)
	go svc.PrewarmRecentComposerCatalogs(prewarmCtx, 8)
	return cancelCloserFunc(cancel)
}

type deferredHTTPHandler struct {
	target atomic.Pointer[http.Handler]
}

func (d *deferredHTTPHandler) set(handler http.Handler) {
	if d == nil || handler == nil {
		return
	}
	d.target.Store(&handler)
}

func (d *deferredHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if d != nil {
		if ptr := d.target.Load(); ptr != nil && *ptr != nil {
			(*ptr).ServeHTTP(w, r)
			return
		}
	}
	http.Error(w, "service warming up", http.StatusServiceUnavailable)
}

func startServerWarmups(
	ctx context.Context,
	rootHandler http.Handler,
	deps webuiRouteDependencies,
	managementKey func() string,
) io.Closer {
	warmupCtx, cancel := context.WithCancel(ctx)
	StartWebUIWarmup(warmupCtx, rootHandler, managementKey)
	StartTranslationWarmup(warmupCtx, deps, rootHandler)
	return cancelCloserFunc(cancel)
}
